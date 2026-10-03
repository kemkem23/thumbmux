import { createHash } from 'node:crypto';
import {
  FLAGON_BUDGET, semanticCellToCell, streamCanonical, streamDigest,
  type AcceptedRowMap, type CaptureWindow, type Cell, type Gap, type GapR2, type PaneKey, type PipeWindow,
  type RawRange, type RowOrigin, type SeamProof, type SegmentRowId, type StitchDecision,
  type StitchPort, type StitchProofs, type StitchResult, type StitchRow, type StitchWindow,
  type WithheldRange, type CapturePacket,
} from './stream-contract';
import { decodeTmuxCaptureEvidence, type TmuxObservedCell } from './tmux-capture-normalize';

/** Stitch v1 (DESIGN-FINAL §4). Text is never identity: a candidate alignment
 * is only a proposal, and a row may be published only behind a seam proof.
 * Several alignments mean NO alignment; the result is a labelled gap, never
 * the first/longest/best-scoring match. Pure: no I/O, no clock other than the
 * injected one, bounded by the policy's candidate and time budgets. */
export const STITCH_VERSION = 1 as const;

// ---------------------------------------------------------------- cell keys

/** Canonical bytes of one physical row. Nothing is trimmed, normalized or
 * stripped: spaces, combining marks and styles are all part of identity. */
export function stitchRowCanonical(row: StitchRow, withWrap = true): string {
  return streamCanonical({
    columns: row.geometry.columns,
    cells: row.cells.map(cellCanonical),
    screenKind: row.buffer,
    ...(withWrap ? { wrapStatus: row.wrapStatus } : {}),
  });
}
function cellCanonical(cell: Cell): unknown[] {
  const points = Array.from(cell.text, ch => ch.codePointAt(0)!);
  return [points.slice(0, 1), cell.width, points.slice(1), [...cell.style]];
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** SHA-256 key over the full canonical row, wrap status included. */
export function stitchRowKey(row: StitchRow, hash: (text: string) => string = sha256): string {
  return hash(stitchRowCanonical(row));
}
export function isBlankRow(row: StitchRow): boolean {
  return row.cells.every(cell => (cell.text === '' || cell.text === ' ') && cell.style.every(n => n === 0 || n === -1));
}

/** Interns rows to small integers. Equal hashes are confirmed on canonical
 * bytes, so a colliding hash never makes two different rows equal. */
class RowInterner {
  private readonly buckets = new Map<string, string[]>();
  collisions = 0;
  constructor(private readonly hash: (text: string) => string) {}
  id(row: StitchRow): number {
    const canonical = stitchRowCanonical(row, false);
    const key = this.hash(canonical);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, bucket = []);
    let index = bucket.indexOf(canonical);
    if (index < 0) { if (bucket.length > 0) this.collisions += 1; index = bucket.push(canonical) - 1; }
    // Combine bucket key and position into a process-local integer id.
    return this.ordinal(key, index);
  }
  private readonly ordinals = new Map<string, number>();
  private ordinal(key: string, index: number): number {
    const name = `${key}#${index}`;
    let value = this.ordinals.get(name);
    if (value === undefined) this.ordinals.set(name, value = this.ordinals.size);
    return value;
  }
}

// ---------------------------------------------------------------- candidates

export interface SeamCandidate {
  /** Rows of the right window [0, end) overlap the left window's suffix. */
  readonly end: number;
  readonly overlap: number;
}
export type CandidateSearch =
  | { readonly kind: 'done'; readonly candidates: readonly SeamCandidate[] }
  | { readonly kind: 'limit'; readonly count: number }
  | { readonly kind: 'deadline'; readonly count: number };

interface Side { readonly rows: readonly StitchRow[]; readonly ids: readonly number[] }
const wrapAgrees = (a: StitchRow, b: StitchRow) =>
  a.wrapStatus === 'unknown' || b.wrapStatus === 'unknown' || a.wrapStatus === b.wrapStatus;
const sameRow = (l: Side, i: number, r: Side, j: number) =>
  l.ids[i] === r.ids[j] && wrapAgrees(l.rows[i]!, r.rows[j]!);

/** EVERY alignment where the left suffix equals a contiguous run of the right
 * window, i.e. every end e>=1 such that left[n-k..n) == right[e-k..e) with
 * k=min(n,e). An overlap of blank rows only carries no content and is not a
 * candidate. Alignments differing only by repeated rows stay distinct. */
function searchCandidates(left: Side, right: Side, maxCandidates: number, expired: () => boolean): CandidateSearch {
  const n = left.rows.length;
  const candidates: SeamCandidate[] = [];
  for (let e = 1; e <= right.rows.length; e += 1) {
    if ((e & 63) === 1 && expired()) return { kind: 'deadline', count: candidates.length };
    const k = Math.min(n, e);
    let ok = true; let nonblank = false;
    for (let i = 1; i <= k; i += 1) {
      if (!sameRow(left, n - i, right, e - i)) { ok = false; break; }
      if (!isBlankRow(right.rows[e - i]!)) nonblank = true;
    }
    if (!ok || !nonblank) continue;
    candidates.push({ end: e, overlap: k });
    if (candidates.length > maxCandidates) return { kind: 'limit', count: candidates.length };
  }
  return { kind: 'done', candidates };
}

function occurrences(side: Side, block: readonly number[], blockRows: readonly StitchRow[]): number {
  let count = 0;
  for (let s = 0; s + block.length <= side.ids.length; s += 1) {
    let ok = true;
    for (let i = 0; i < block.length; i += 1) {
      if (side.ids[s + i] !== block[i] || !wrapAgrees(side.rows[s + i]!, blockRows[i]!)) { ok = false; break; }
    }
    if (ok) count += 1;
  }
  return count;
}

export type AnchorVerdict = 'ok' | 'short-anchor' | 'content-only' | 'unknown-state';
/** Minimum content rules (§4.2.2). Passing them still proves nothing alone. */
function anchorVerdict(left: Side, right: Side, c: SeamCandidate, policy: StitchProofs['policy']): AnchorVerdict {
  const rows = right.rows.slice(c.end - c.overlap, c.end);
  // Screen rows that can still change never count towards the anchor.
  if (rows.filter(row => row.finalized).length < policy.minAnchorRows) return 'short-anchor';
  const block = right.ids.slice(c.end - c.overlap, c.end);
  if (new Set(block).size < policy.minDistinctKeys) return 'content-only';
  if (rows.filter(row => !isBlankRow(row)).length < policy.minNonblankRows) return 'content-only';
  if (occurrences(left, block, rows) !== 1 || occurrences(right, block, rows) !== 1) return 'content-only';
  if (rows.some(row => row.uncertainFields.length > 0)) return 'unknown-state';
  const leftRows = left.rows.slice(left.rows.length - c.overlap);
  if (leftRows.some(row => row.uncertainFields.length > 0)) return 'unknown-state';
  return 'ok';
}

// ---------------------------------------------------------------- seam proofs

const HEX64 = /^[0-9a-f]{64}$/;
const samePane = (a: PaneKey, b: PaneKey) =>
  a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
const sameEpoch = (a: RawRange['epoch'], b: RawRange['epoch']) =>
  samePane(a.pane, b.pane) && a.attachId === b.attachId && a.collectorIncarnation === b.collectorIncarnation;
const fileOk = (f: { path: string; bytes: number; sha256: string }) =>
  f.path.length > 0 && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && HEX64.test(f.sha256);

function lastDurable(T: StitchWindow): SegmentRowId | null {
  const last = T.rows.at(-1);
  return last && last.origin.kind === 'durable' ? last.origin.rowId : null;
}

/** T→C: a continuous recorded mapping in the capture's own epoch that covers
 * the last durable row and reaches the capture start. A mapping in another
 * epoch is never accepted: content dedup across epochs is forbidden. */
function tailProofValid(proof: SeamProof, T: StitchWindow, C: CaptureWindow): boolean {
  if (proof.kind !== 'recorded-mapping') return false;
  const capture = C.packet.rawRange;
  const last = lastDurable(T);
  if (!last || !proof.checkpointId || !fileOk(proof.mapping)) return false;
  if (!sameEpoch(proof.range.epoch, capture.epoch) || !samePane(proof.range.epoch.pane, C.pane)) return false;
  if (!(proof.range.start <= proof.range.end && proof.range.end >= capture.start)) return false;
  return proof.coverage.some(entry => entry.kind === 'rows' && entry.range.segmentId === last.segmentId
    && samePane(entry.range.pane, last.pane) && entry.range.start <= last.rowOrdinal && last.rowOrdinal < entry.range.end);
}

type PipeSeam =
  | { readonly kind: 'certified' }
  | { readonly kind: 'birth' }
  | { readonly kind: 'mapping' }
  | { readonly kind: 'none' };
/** C→P. A certified same-turn boundary (also stamped on the packet) means a
 * zero-byte overlap; birth means byte 0 of a new pane. Anything else needs a
 * mapping AND a unique content candidate, or the pipe prefix is withheld. */
function pipeSeam(proofs: StitchProofs, C: CaptureWindow, P: PipeWindow): PipeSeam {
  const packetBoundary = C.packet.boundary;
  for (const proof of proofs.captureToPipe) {
    if (proof.kind === 'independent-boundary') {
      const b = proof.boundary;
      if (!samePane(b.pane, P.pane) || !sameEpoch(b.epoch, P.rawRange.epoch)) continue;
      if (b.kind === 'birth') {
        if (packetBoundary.kind !== 'birth' || P.rawRange.start !== 0 || b.firstByteOffset !== 0 || !fileOk(b.transcript)) continue;
        return { kind: 'birth' };
      }
      if (packetBoundary.kind !== 'certified-same-turn' || packetBoundary.certificateId !== b.certificateId || !b.certificateId) continue;
      if (b.geometry.columns !== C.packet.geometry.columns || b.geometry.rows !== C.packet.geometry.rows) continue;
      if (!sameEpoch(b.rawStart.epoch, P.rawRange.epoch) || b.rawStart.byteOffset !== P.rawRange.start) continue;
      if (![b.binarySha256, b.hookConfigSha256].every(d => HEX64.test(d)) || !fileOk(b.transcript) || !fileOk(b.eventCoverage)) continue;
      return { kind: 'certified' };
    }
    const capture = C.packet.rawRange;
    if (proof.checkpointId && fileOk(proof.mapping) && sameEpoch(proof.range.epoch, P.rawRange.epoch)
      && proof.range.start <= capture.start && proof.range.end >= capture.end) return { kind: 'mapping' };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------- origin tags

/** Baseline origin of every cell of capture row `rowIndex`. The decoder seeds
 * its screen from these so that a pipe row that merely scrolls a captured
 * cell into history is recognised as the SAME row, not appended twice. */
export function baselineCellOrigins(snapshotId: string, rowIndex: number, cells: number): RowOrigin[] {
  return Array.from({ length: cells }, () => ({ kind: 'capture', snapshotId, rowIndex }) as const);
}
type CellProvenance =
  | { readonly kind: 'pipe-only' }
  | { readonly kind: 'baseline-only'; readonly rowIndex: number }
  | { readonly kind: 'mixed'; readonly rowIndexes: readonly number[] }
  | { readonly kind: 'foreign' };
function provenance(row: StitchRow, snapshotId: string): CellProvenance {
  const indexes = new Set<number>();
  let pipe = false;
  for (const origin of row.cellOrigins) {
    if (origin.kind === 'pipe') pipe = true;
    else if (origin.kind === 'capture' && origin.snapshotId === snapshotId) indexes.add(origin.rowIndex);
    else return { kind: 'foreign' };
  }
  if (indexes.size === 0) return { kind: 'pipe-only' };
  if (!pipe && indexes.size === 1) return { kind: 'baseline-only', rowIndex: [...indexes][0]! };
  return { kind: 'mixed', rowIndexes: [...indexes] };
}

// ---------------------------------------------------------------- known state

/** Field-level knowledge of parser state that capture-pane cannot reveal
 * (§3.3). Unknown fields only become known through an explicit program
 * command; restoring a cursor saved while unknown makes the cursor unknown
 * again. A single LF never resets the terminal. */
export const KNOWN_STATE_FIELDS = ['sgr', 'cursor', 'savedCursor', 'margins', 'charset', 'pendingUtf8', 'pendingEscape', 'wrap'] as const;
export type KnownStateField = typeof KNOWN_STATE_FIELDS[number];
export class KnownStateTracker {
  private readonly unknown = new Set<KnownStateField>();
  private escape: number[] | null = null;
  private utf8Left = 0;
  constructor(stateKnown: Readonly<Record<string, boolean>>) {
    for (const field of KNOWN_STATE_FIELDS) if (stateKnown[field] !== true) this.unknown.add(field);
  }
  unknownFields(): KnownStateField[] { return KNOWN_STATE_FIELDS.filter(f => this.unknown.has(f)); }
  /** Fields among `dependencies` that are still unknown; nonempty ⇒ withhold. */
  uncertainFor(dependencies: readonly KnownStateField[]): KnownStateField[] {
    return dependencies.filter(f => this.unknown.has(f));
  }
  /** Feeds raw pipe bytes. Partial UTF-8/escape state at the start of the
   * stream stays unknown until a byte that cannot continue it arrives. */
  feed(bytes: readonly number[]): void {
    for (const byte of bytes) this.byte(byte);
  }
  private byte(b: number): void {
    if (this.escape) { this.escapeByte(b); return; }
    if (this.unknown.has('pendingEscape') && (b === 0x1b || b === 0x0a || b === 0x0d)) this.unknown.delete('pendingEscape');
    if (this.unknown.has('pendingUtf8') && (b < 0x80 || b >= 0xc0)) this.unknown.delete('pendingUtf8');
    if (this.utf8Left > 0 && (b & 0xc0) === 0x80) { this.utf8Left -= 1; return; }
    this.utf8Left = 0;
    if (b >= 0xc0) { this.utf8Left = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1; return; }
    if (b === 0x1b) this.escape = [];
    else if (b === 0x0e || b === 0x0f) this.unknown.delete('charset');
  }
  private escapeByte(b: number): void {
    const seq = this.escape!;
    seq.push(b);
    if (seq.length === 1) {
      if (b === 0x5b || b === 0x28 || b === 0x29) return; // CSI or charset designation
      this.escape = null;
      if (b === 0x63) { this.unknown.clear(); return; } // RIS: full reset
      if (b === 0x37) this.save();
      else if (b === 0x38) this.restore();
      return;
    }
    if (seq[0] === 0x28 || seq[0] === 0x29) { this.escape = null; this.unknown.delete('charset'); return; }
    if (b < 0x40 || b > 0x7e) { if (seq.length > 64) this.escape = null; return; }
    this.escape = null;
    const params = String.fromCharCode(...seq.slice(1, -1));
    if (/[?<=>]/.test(params)) return;
    if (b === 0x6d && (params === '' || params === '0')) this.unknown.delete('sgr');
    else if (b === 0x48 || b === 0x66) this.unknown.delete('cursor');
    else if (b === 0x72) { this.unknown.delete('margins'); this.unknown.delete('cursor'); }
    else if (b === 0x73 && params === '') this.save();
    else if (b === 0x75 && params === '') this.restore();
  }
  private save(): void {
    if (this.unknown.has('cursor')) this.unknown.add('savedCursor'); else this.unknown.delete('savedCursor');
  }
  private restore(): void {
    if (this.unknown.has('savedCursor')) this.unknown.add('cursor'); else this.unknown.delete('cursor');
  }
}

// ---------------------------------------------------------------- capture rows

const colorCode = (color: string): number => {
  if (color === 'default') return -1;
  if (color.startsWith('index:')) return Number(color.slice(6));
  const [r, g, b] = color.slice(4).split(',').map(Number);
  return 256 + ((r! << 16) | (g! << 8) | b!);
};
/** Decoder bits stay on TmuxObservedCell. Durable Cell.style is canonical SGR. */
const observedCell = (cell: TmuxObservedCell): Cell => semanticCellToCell({
  text: cell.grapheme, width: cell.width,
  style: { attrs: cell.style, fg: colorCode(cell.fg), bg: colorCode(cell.bg) },
});

/** Rows of one `capture-pane -p -e -C -N -S - -E -` payload. History rows
 * (index < historySize) are finalized; screen rows are not. Capture never
 * proves wrap identity (no -J), so wrapStatus is unknown on every row.
 * Rows the decoder cannot certify carry uncertainFields, never invented cells. */
export function captureStitchRows(packet: CapturePacket, raw: string): StitchRow[] {
  const decoded = decodeTmuxCaptureEvidence(raw, packet.geometry.columns);
  const buffer = packet.activeBuffer === 'alternate' ? 'alternate' : 'normal';
  return decoded.rows.map((evidence, rowIndex) => {
    const cells = (evidence.cells ?? []).filter(cell => !cell.continuation).map(observedCell);
    const origin = { kind: 'capture', snapshotId: packet.snapshotId, rowIndex } as const;
    return {
      origin, cells, geometry: packet.geometry, buffer, wrapStatus: 'unknown', wrapPad: 0,
      finalized: rowIndex < packet.historySize && packet.mainHistory === 'available',
      uncertainFields: evidence.certain ? [] : [evidence.reason],
      cellOrigins: baselineCellOrigins(packet.snapshotId, rowIndex, cells.length),
    } satisfies StitchRow;
  });
}

// ---------------------------------------------------------------- stitch

export interface StitchOptions {
  /** Injected for collision fixtures only; default SHA-256. */
  readonly hash?: (text: string) => string;
  /** Monotonic milliseconds; default performance.now(). */
  readonly now?: () => number;
  /** New segment for accepted rows. Default is derived from the episode. */
  readonly segmentIdFor?: (episodeId: string, snapshotId: string) => string;
}
type Failure = { readonly status: 'ambiguous'; readonly reason: 'multiple-alignments' | 'candidate-limit'; readonly count: number }
  | { readonly status: 'unproven'; readonly reason: 'content-only' | 'unknown-state' | 'geometry' | 'deadline' | 'short-anchor' };
type SeamOutcome = { readonly status: 'ok'; readonly end: number } | Failure;

const policyMatches = (p: StitchProofs['policy']) => p.version === 1 && p.minAnchorRows === FLAGON_BUDGET.minAnchorRows
  && p.minDistinctKeys === FLAGON_BUDGET.minDistinctKeys && p.minNonblankRows === FLAGON_BUDGET.minNonblankRows
  && p.maxCandidates === FLAGON_BUDGET.maxCandidates && p.deadlineMs === FLAGON_BUDGET.stitchDeadlineMs;

class StitchError extends Error {
  constructor(readonly code: 'integrity' | 'identity' | 'io', message: string) { super(message); }
}

export class StreamStitcher implements StitchPort {
  constructor(private readonly options: StitchOptions = {}) {}

  async stitch(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): Promise<StitchResult> {
    try { return this.run(T, C, P, proofs); } catch (error) {
      if (error instanceof StitchError) return { status: 'error', code: error.code, message: error.message };
      throw error;
    }
  }

  private run(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): StitchResult {
    validate(T, C, P, proofs);
    const now = this.options.now ?? (() => performance.now());
    const deadline = now() + proofs.policy.deadlineMs;
    const expired = () => now() > deadline;
    const interner = new RowInterner(this.options.hash ?? sha256);
    const side = (rows: readonly StitchRow[]): Side => ({ rows, ids: rows.map(row => interner.id(row)) });
    const packet = C.packet;
    const tail = T.rows.slice(-FLAGON_BUDGET.tailSearchRows);
    const pipe = pipeSeam(proofs, C, P);

    // Seam 1: T → C.
    let tailSeam: SeamOutcome;
    if (pipe.kind === 'birth') {
      if (T.rows.length > 0 || C.rows.length > 0) throw new StitchError('identity', 'birth boundary with prior rows');
      tailSeam = { status: 'ok', end: 0 };
    } else if (T.rows.length === 0) {
      // Nothing durable to protect; rows before the retained history are unknown.
      tailSeam = { status: 'unproven', reason: 'content-only' };
    } else if (packet.activeBuffer !== 'normal' || packet.mainHistory !== 'available') {
      tailSeam = { status: 'unproven', reason: 'unknown-state' };
    } else if (tail.at(-1)!.geometry.columns !== packet.geometry.columns) {
      tailSeam = { status: 'unproven', reason: 'geometry' };
    } else {
      tailSeam = this.seam(side(tail), side(C.rows), proofs, expired,
        () => proofs.tailToCapture.some(proof => tailProofValid(proof, T, C)));
    }
    const tailEmptyStart = T.rows.length === 0 && pipe.kind !== 'birth';

    // Seam 2: C → P, only meaningful for a canonical capture.
    const captureCanonical = tailSeam.status === 'ok' || tailEmptyStart;
    const historyEnd = C.rows.findIndex(row => !row.finalized);
    const finalizedCapture = historyEnd < 0 ? C.rows : C.rows.slice(0, historyEnd);
    let pipeSkip = 0;
    let pipeSeamOutcome: SeamOutcome | null = null;
    if (pipe.kind === 'mapping' && captureCanonical) {
      const outcome = this.seam(side(finalizedCapture), side(P.rows), proofs, expired, () => true);
      pipeSeamOutcome = outcome;
      if (outcome.status === 'ok') pipeSkip = outcome.end;
    } else if (pipe.kind === 'none' || pipe.kind === 'mapping') {
      pipeSeamOutcome = { status: 'unproven', reason: 'content-only' };
    }
    const pipeTrusted = pipe.kind === 'certified' || pipe.kind === 'birth' || pipeSeamOutcome?.status === 'ok';

    const failure = [tailSeam, pipeSeamOutcome].find((s): s is Failure => !!s && s.status === 'ambiguous')
      ?? [tailSeam, pipeSeamOutcome].find((s): s is Failure => !!s && s.status === 'unproven');

    // Assemble: T kept whole → C finalized rows beyond T → P suffix.
    const segmentId = (this.options.segmentIdFor ?? defaultSegmentId)(proofs.episodeId, packet.snapshotId);
    const asm = new Assembly(P.pane, segmentId, packet, proofs.episodeId, lastDurable(T));
    if (tailEmptyStart) asm.leadingGap();
    const captureStart = tailSeam.status === 'ok' ? tailSeam.end : 0;
    const acceptedCapture = new Set<number>();
    C.rows.forEach((row, index) => {
      if (!captureCanonical) { asm.withhold('capture', index, gapReason(tailSeam)); return; }
      if (index < captureStart || !row.finalized) return;
      asm.accept(row.origin); acceptedCapture.add(index);
    });
    const finalizedIndexes = new Set(finalizedCapture.map((_, index) => index));
    const seenBaseline = new Set<number>();
    P.rows.forEach((row, index) => {
      if (!row.finalized) return;
      if (index < pipeSkip) return; // proven overlap with accepted capture rows
      const origin = provenance(row, packet.snapshotId);
      if (origin.kind === 'foreign') throw new StitchError('integrity', `pipe row ${index} names another snapshot`);
      const unknown = row.uncertainFields.length > 0;
      if (origin.kind === 'baseline-only') {
        if (finalizedIndexes.has(origin.rowIndex)) {
          if (!captureCanonical) { asm.withhold('pipe', index, gapReason(tailSeam)); return; }
          if (!acceptedCapture.has(origin.rowIndex) && origin.rowIndex >= captureStart) {
            throw new StitchError('integrity', `pipe row ${index} repeats an unaccepted capture row`);
          }
          return; // the same captured row, already in the timeline
        }
        if (seenBaseline.has(origin.rowIndex)) return;
        seenBaseline.add(origin.rowIndex);
      }
      if (origin.kind === 'mixed' && origin.rowIndexes.some(i => finalizedIndexes.has(i))) {
        throw new StitchError('integrity', `pipe row ${index} edits finalized capture history`);
      }
      const carriesBaseline = origin.kind !== 'pipe-only';
      if (carriesBaseline && !captureCanonical) { asm.withhold('pipe', index, gapReason(tailSeam)); return; }
      if (!pipeTrusted && !afterCapture(row, packet)) { asm.withhold('pipe', index, 'unproven-overlap'); return; }
      if (unknown) { asm.withhold('pipe', index, 'unknown-vt-state'); return; }
      asm.accept(row.origin);
    });

    if (failure) asm.ensurePositioned(gapReason(failure));
    const decision = asm.finish();
    if (tailEmptyStart && !failure) return { ...decision, status: 'unproven', reason: 'content-only' };
    if (!failure) {
      if (decision.withheldRanges.some(r => r.reason === 'unknown-state')) return { ...decision, status: 'unproven', reason: 'unknown-state' };
      return { ...decision, status: 'matched', proofs };
    }
    if (failure.status === 'ambiguous') return { ...decision, status: 'ambiguous', reason: failure.reason, candidateCount: failure.count };
    return { ...decision, status: 'unproven', reason: failure.reason };
  }

  /** Candidates first, then the minimum content rules, then the proof gate.
   * More than one alignment is ambiguity, whatever their lengths. */
  private seam(left: Side, right: Side, proofs: StitchProofs, expired: () => boolean, proven: () => boolean): SeamOutcome {
    const search = searchCandidates(left, right, proofs.policy.maxCandidates, expired);
    if (search.kind === 'deadline') return { status: 'unproven', reason: 'deadline' };
    if (search.kind === 'limit') return { status: 'ambiguous', reason: 'candidate-limit', count: search.count };
    const { candidates } = search;
    if (candidates.length === 0) return { status: 'unproven', reason: 'content-only' };
    if (candidates.length > 1) {
      const longest = candidates.reduce((best, item) => item.overlap > best.overlap ? item : best);
      return { status: 'ok', end: longest.end };
    }
    const only = candidates[0]!;
    const verdict = anchorVerdict(left, right, only, proofs.policy);
    if (verdict !== 'ok') return { status: 'unproven', reason: verdict };
    // MUTANT M5: a unique reprint is accepted without a seam proof.
    if (!proven()) return { status: 'ok', end: only.end };
    return { status: 'ok', end: only.end };
  }
}

/** A pipe row whose every byte arrived after the capture finished cannot be
 * inside that capture, so it is a verified suffix even without a boundary. */
function afterCapture(row: StitchRow, packet: CapturePacket): boolean {
  const end = packet.rawRange.end;
  const after = (o: RowOrigin) => o.kind === 'pipe' && o.range.start >= end;
  return after(row.origin) && row.cellOrigins.every(after);
}
function gapReason(seam: SeamOutcome): Gap['reason'] {
  if (seam.status === 'ambiguous') return 'ambiguous-overlap';
  if (seam.status === 'unproven' && seam.reason === 'geometry') return 'geometry-change';
  if (seam.status === 'unproven' && seam.reason === 'unknown-state') return 'unknown-vt-state';
  return 'unproven-overlap';
}
const defaultSegmentId = (episodeId: string, snapshotId: string) =>
  `stitch-v1-${streamDigest('stitch-segment', { episodeId, snapshotId }).slice(0, 32)}`;

const withheldReason = (reason: Gap['reason']): WithheldRange['reason'] =>
  reason === 'ambiguous-overlap' ? 'ambiguous' : reason === 'unknown-vt-state' ? 'unknown-state' : 'unproven';

/** Accumulates accepted rows and withheld runs in timeline order. Each run of
 * withheld rows (whatever their source) is covered by exactly one gap that
 * sits after the last accepted row; the count is unknown, never 0. */
class Assembly {
  private readonly accepted: AcceptedRowMap[] = [];
  private readonly withheld: WithheldRange[] = [];
  private readonly gaps: GapR2[] = [];
  private sequence = 0;
  private run: { reason: Gap['reason']; rows: number } | null = null;
  private left: SegmentRowId | null;
  constructor(private readonly pane: PaneKey, private readonly segmentId: string,
    private readonly packet: CapturePacket, private readonly episodeId: string, tail: SegmentRowId | null) {
    this.left = tail;
  }
  leadingGap(): void { this.gaps.push(this.gap('unproven-overlap', 0, null)); }
  /** A non-match with nothing withheld still needs a gap at the last durable row.
   * Quiet T with empty C/P used to return unproven and invite another capture. */
  ensurePositioned(reason: Gap['reason']): void {
    this.close();
    if (this.gaps.length === 0) this.gaps.push(this.gap(reason, 0, this.left));
  }
  accept(source: RowOrigin): void {
    this.close();
    const target = { pane: this.pane, segmentId: this.segmentId, rowOrdinal: this.accepted.length };
    this.accepted.push({ source, target });
    this.left = target;
  }
  withhold(source: WithheldRange['source'], index: number, reason: Gap['reason']): void {
    const kind = withheldReason(reason);
    const last = this.withheld.at(-1);
    if (this.run && last && last.source === source && last.end === index && last.reason === kind) {
      this.withheld[this.withheld.length - 1] = { ...last, end: index + 1 };
    } else this.withheld.push({ source, start: index, end: index + 1, reason: kind });
    if (!this.run) this.run = { reason, rows: 0 };
    this.run.rows += 1;
  }
  private close(): void {
    if (!this.run) return;
    this.gaps.push(this.gap(this.run.reason, this.run.rows, this.left));
    this.run = null;
  }
  private gap(reason: Gap['reason'], withheldRows: number, left: SegmentRowId | null): GapR2 {
    const sequence = this.sequence++;
    const leftMark = left ? `${left.segmentId}:${left.rowOrdinal}` : 'none';
    return {
      version: 1, episodeId: this.episodeId, parentEpisodeId: null, pane: this.pane,
      leftRowId: left, rightSegmentId: this.segmentId, reason,
      countKind: 'unknown', missingCount: null, withheldRows, lowerBound: 0,
      openedAt: this.packet.startedAtMonoMs, closedAt: null, clockEpoch: this.packet.clockEpoch, quality: 'degraded',
      repair: {
        revision: 2, gapId: `c-${this.episodeId}-${sequence}-${reason}-${leftMark}`,
        sequence, update: 0, state: 'open',
      },
    };
  }
  finish(): StitchDecision {
    this.close();
    const decisionId = `stitch-${streamDigest('stitch-decision', {
      accepted: this.accepted.map(a => [a.source, a.target.rowOrdinal]), withheld: this.withheld,
      gaps: this.gaps.map(g => [g.reason, g.withheldRows, g.leftRowId]), segment: this.segmentId,
    }).slice(0, 32)}`;
    return { decisionId, acceptedRowMap: this.accepted, withheldRanges: this.withheld, gaps: this.gaps };
  }
}

function validate(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): void {
  if (!policyMatches(proofs.policy)) throw new StitchError('integrity', 'stitch policy is not v1');
  const packet = C.packet;
  if (packet.version !== 1 || packet.captureCount !== 1 || packet.complete !== true) throw new StitchError('integrity', 'capture packet is not a complete v1 packet');
  if (proofs.episodeId !== packet.episodeId) throw new StitchError('identity', 'episode mismatch');
  for (const pane of [C.pane, P.pane, packet.pane, P.rawRange.epoch.pane, packet.rawRange.epoch.pane]) {
    if (!samePane(T.pane, pane)) throw new StitchError('identity', 'pane identity differs between windows');
  }
  if (!sameEpoch(P.rawRange.epoch, packet.rawRange.epoch)) throw new StitchError('identity', 'pipe and capture epochs differ');
  T.rows.forEach((row, i) => {
    if (row.origin.kind !== 'durable' || !samePane(row.origin.rowId.pane, T.pane)) throw new StitchError('integrity', `tail row ${i} is not durable`);
  });
  C.rows.forEach((row, i) => {
    if (row.origin.kind !== 'capture' || row.origin.snapshotId !== packet.snapshotId || row.origin.rowIndex !== i) {
      throw new StitchError('integrity', `capture row ${i} origin mismatch`);
    }
  });
  P.rows.forEach((row, i) => {
    const o = row.origin;
    if (o.kind !== 'pipe' || !sameEpoch(o.range.epoch, P.rawRange.epoch) || o.range.start < P.rawRange.start || o.range.end > P.rawRange.end || o.range.start > o.range.end) {
      throw new StitchError('integrity', `pipe row ${i} origin outside the pipe window`);
    }
  });
}
