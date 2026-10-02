/** LOT C PARTIAL: opt-in coordinator, not a ready runtime. No concrete
 * CaptureVt checkpoint adapter or source-gap repair provider is shipped here.
 * See docs/tasks/newarch-stream-c/REPORT.md before integrating. */
import { createHash } from 'node:crypto';
import {
  STREAM_BUDGET as B, STREAM_CONTRACT_VERSION,
  type AppendFinalized, type CancelToken, type CaptureEngine, type DurableInputReceipt,
  type DurableReceipt, type FinalizedRow, type FrameDelta, type GapEpisode,
  type HistoryEngine, type InputEvent, type LiveFrame, type PaneKey,
  type RepairChunk, type RepairReceipt, type Result, type RowContent,
  type StreamFailure, type StreamIdentity, type StreamObserver, type VtCheckpoint, type VtState,
} from './stream-contract';

const ok = <T>(value: T): Result<T> => ({ status: 'ok', value });
const busy = (): StreamFailure => ({ status: 'busy', reason: 'pressure', retryAfterMs: 10 });
const error = (code: Extract<StreamFailure, { status: 'error' }>['code'], message: string): StreamFailure => ({ status: 'error', code, message });
const counter = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const paneKey = (p: PaneKey): string => JSON.stringify([p.serverIdentity, p.paneId, p.birthGeneration]);
const samePane = (a: PaneKey, b: PaneKey): boolean => paneKey(a) === paneKey(b);
const sameIdentity = (a: StreamIdentity, b: StreamIdentity): boolean => samePane(a.pane, b.pane)
  && a.sourceEpoch === b.sourceEpoch && a.geometryGeneration === b.geometryGeneration;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(v: unknown): void {
    if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  }
  freeze(copy); return copy;
}
/** Proposed C codec. H must use the same codec or supply its canonical digest
 * through CapturePorts.digest. No claim of inter-lot codec agreement yet. */
export function captureDigest(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)]));
    throw new Error('non-canonical capture payload');
  }
  return createHash('sha256').update(JSON.stringify([STREAM_CONTRACT_VERSION, canonical(value)])).digest('hex');
}

/** Logical allocation accounting, not heap/PSS. Reservations have one owner. */
export class CaptureAdmission {
  private held = 0;
  constructor(readonly cap: number = B.pendingBytes) { if (!counter(cap)) throw new Error('invalid cap'); }
  get heldBytes(): number { return this.held; }
  reserve(bytes: number): (() => void) | null {
    if (!counter(bytes)) throw new Error('invalid reservation');
    if (bytes > this.cap - this.held) return null;
    this.held += bytes; let released = false;
    return () => { if (!released) { released = true; this.held -= bytes; } };
  }
}

/** Only durable prefixes may be evicted. Preflight is atomic for the batch. */
export class CaptureTail {
  private entries: readonly FinalizedRow[] = [];
  private bytes = 0;
  private durableRevision = 0;
  get rows(): readonly FinalizedRow[] { return Object.freeze([...this.entries]); }
  get heldBytes(): number { return this.bytes; }
  durable(revision: number): void {
    if (!counter(revision) || revision < this.durableRevision) throw new Error('invalid durable watermark');
    this.durableRevision = revision;
  }
  private plan(rows: readonly FinalizedRow[]): { rows: readonly FinalizedRow[]; bytes: number } | null {
    let bytes = this.bytes;
    const result = [...this.entries];
    for (const row of rows) {
      const n = size(row) * 2 + 256 + row.cells.length * 64;
      if (n > B.tailBytesPerPane) return null;
      while (result.length && (result.length >= B.tailRowsPerPane || bytes + n > B.tailBytesPerPane)) {
        const first = result[0]!;
        if (first.revision > this.durableRevision) return null;
        bytes -= size(first) * 2 + 256 + first.cells.length * 64; result.shift();
      }
      result.push(row); bytes += n;
    }
    return { rows: result, bytes };
  }
  canAppend(rows: readonly FinalizedRow[]): boolean { return this.plan(rows) !== null; }
  append(rows: readonly FinalizedRow[]): boolean {
    const plan = this.plan(rows); if (!plan) return false;
    this.entries = immutable(plan.rows); this.bytes = plan.bytes; return true;
  }
}

/** Both arguments must be full observed screens, never deltas. Equality is
 * only visible evidence; it does not prove pre-receive byte continuity. */
export function exactVisibleVerdict(a: FrameDelta, b: FrameDelta, before: number, after: number): 'equal' | 'different' | 'unfenced' {
  if (!counter(before) || before !== after || !sameIdentity(a.identity, b.identity)
    || a.geometry.columns !== b.geometry.columns || a.geometry.rows !== b.geometry.rows
    || [...a.changedRows, ...b.changedRows].some(r => r.content.uncertainFields.length)) return 'unfenced';
  const left = [...a.changedRows].sort((x, y) => x.y - y.y);
  const right = [...b.changedRows].sort((x, y) => x.y - y.y);
  const equal = a.buffer === b.buffer && a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y
    && a.cursor.visible === b.cursor.visible && left.length === right.length && left.every((row, i) => {
      const other = right[i]!;
      return row.y === other.y && row.content.softWrap === other.content.softWrap
        && row.content.wrapPad === other.content.wrapPad && row.content.cells.length === other.content.cells.length
        && row.content.cells.every((cell, x) => {
          const c = other.content.cells[x]!;
          return cell.text === c.text && cell.width === c.width && cell.style.length === c.style.length
            && cell.style.every((value, j) => value === c.style[j]);
        });
    });
  return equal ? 'equal' : 'different';
}
export function uniqueCaptureSeam(before: readonly string[], captured: readonly string[]): number {
  if (!before.length || captured.length > B.repairHorizonRows) throw new Error('repair bounds');
  let found = -1;
  for (let i = 0; i + before.length <= captured.length; i++) {
    if (before.every((value, j) => value === captured[i + j])) {
      if (found !== -1) throw new Error('ambiguous repair anchor');
      found = i + before.length;
    }
  }
  if (found === -1) throw new Error('expired repair anchor');
  return found;
}

/** VT implementations stage on an isolated candidate. busy/error must leave
 * the live parser untouched. install is synchronous and must not throw.
 * A screen reseed is NOT an implementation of restore or checkpoint. */
export interface CaptureVt {
  prepare(event: InputEvent): Promise<Result<CaptureVtTransaction>>;
  restore(state: VtState): Promise<Result<CaptureVtTransaction>>;
  snapshot(): Promise<Result<VtState>>;
  screen(): FrameDelta;
}
export interface CaptureVtTransaction {
  readonly frame: FrameDelta;
  /** Only finalized NORMAL rows, even when the packet ends in alternate mode. */
  readonly scrolls: readonly RowContent[];
  install(): void;
  discard(): void;
}
export interface CapturePorts {
  readonly identity: StreamIdentity;
  readonly history: HistoryEngine;
  readonly vt: CaptureVt;
  readonly initial: LiveFrame;
  readonly observer?: StreamObserver;
  readonly admission: CaptureAdmission; // shared across every pane in the host
  readonly scratch: CaptureAdmission; // separate global 32 MiB ledger
  readonly now: () => number;
  readonly digest?: (value: unknown) => string;
  /** tail is literally zero: implementations cannot quietly request history. */
  visible(identity: StreamIdentity, tail: 0, signal: AbortSignal): Promise<Result<FrameDelta>>;
  /** Source owner supplies bounded, uniquely anchored repair chunks. No
   * periodic call exists. Live seam and durable checkpoint must agree before
   * complete=true. This adapter is not supplied by the legacy collector. */
  repairChunks(episode: GapEpisode, signal: AbortSignal): AsyncIterable<Result<RepairChunk>>;
  syncRepair(chunk: RepairChunk, receipt: RepairReceipt): Promise<LiveFrame>;
  verifyRepair(episode: GapEpisode, signal: AbortSignal): Promise<boolean>;
}

type Pending = { event: InputEvent; receipt: DurableInputReceipt; release: () => void };
/** One pane per engine; host owns lifecycle, cadence and the global ledgers.
 * Deliberately opt-in: it never changes the legacy runtime or starts timers.
 */
export class StreamCaptureEngine implements CaptureEngine {
  private identity: StreamIdentity;
  private frame: LiveFrame;
  private tail = new CaptureTail();
  private listeners = new Set<(frame: LiveFrame) => void>();
  private locked = false;
  private visibleLocked = false;
  private pending: Pending | null = null;
  private lastInput: DurableInputReceipt | null = null;
  private lastCheckpoint: VtCheckpoint | null = null;
  private durable: DurableReceipt | null = null;
  private episode: GapEpisode | null = null;
  private checkpointAt: number;
  private checkpointHead: number;
  private serial = 0;
  private restoring = false;
  constructor(private readonly ports: CapturePorts) {
    if (!sameIdentity(ports.identity, ports.initial.identity) || !counter(ports.initial.head)
      || !counter(ports.initial.revision) || !counter(ports.initial.durableRevision)
      || ports.initial.durableRevision > ports.initial.revision) throw new Error('invalid initial capture fence');
    this.identity = immutable(ports.identity); this.frame = immutable(ports.initial);
    this.checkpointAt = ports.now(); this.checkpointHead = this.frame.head;
  }
  private activeGap(): GapEpisode | null { return this.episode; }
  private digest(value: unknown): string { return (this.ports.digest ?? captureDigest)(value); }
  private matches(pane: PaneKey): boolean { return samePane(this.identity.pane, pane); }
  private record(metric: Parameters<StreamObserver['record']>[0]): void {
    try { this.ports.observer?.record(metric); } catch { /* observer cannot change admission */ }
  }
  private publish(frame: LiveFrame): void {
    this.frame = immutable(frame);
    for (const listener of this.listeners) { try { listener(this.frame); } catch { /* isolate subscribers */ } }
  }
  /** Called by I on EOF/exit/ACK timeout/checksum/identity/source detector.
   * No missing count is invented. A late gap cannot renumber admitted IDs. */
  fault(reason: GapEpisode['reason']): GapEpisode {
    if (this.episode) return this.episode;
    this.episode = immutable({ episodeId: `${paneKey(this.identity.pane)}:${++this.serial}`,
      pane: this.identity.pane, epochBefore: this.identity.sourceEpoch, epochAfter: null,
      lastDurableInput: this.lastInput?.through ?? null, lastAdmittedRow: this.frame.head ? this.frame.head - 1 : null,
      firstObservedAtMonoMs: this.ports.now(), reason, status: reason === 'late-gap' ? 'unresolved' : 'suspected', missingCount: null });
    this.record({ kind: 'gap', episode: this.episode }); return this.episode;
  }
  get checkpointDue(): 'periodic' | 'row-limit' | null {
    if (this.frame.head - this.checkpointHead >= B.checkpointRows) return 'row-limit';
    return this.ports.now() - this.checkpointAt >= B.checkpointMs ? 'periodic' : null;
  }
  private validate(event: InputEvent): StreamFailure | null {
    if (!samePane(event.identity.pane, this.identity.pane)) return { status: 'stale', reason: 'identity' };
    if (event.identity.sourceEpoch !== this.identity.sourceEpoch || event.position.sourceEpoch !== event.identity.sourceEpoch)
      return { status: 'stale', reason: 'epoch' };
    if (!counter(event.position.packetSeq) || !event.position.packetSeq || !counter(event.identity.geometryGeneration)
      || !Number.isFinite(event.receivedAtMonoMs) || event.receivedAtMonoMs < 0) return error('integrity', 'invalid input counters');
    const resize = event.payload.kind === 'resize';
    const retry = event.position.packetSeq <= (this.lastInput?.through.packetSeq ?? 0);
    if (!retry && event.identity.geometryGeneration !== this.identity.geometryGeneration + (resize ? 1 : 0))
      return { status: 'stale', reason: 'geometry' };
    if (resize && (!counter(event.payload.geometry.columns) || !counter(event.payload.geometry.rows)
      || event.payload.geometry.columns < 1 || event.payload.geometry.rows < 1
      || event.payload.geometry.columns > B.maxColumns || event.payload.geometry.rows > B.maxRows)) return error('unsupported', 'geometry budget');
    if (event.payload.kind === 'bytes' && (!event.payload.bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)))
      return error('integrity', 'invalid byte');
    const { digest: _, ...payload } = event;
    if (event.digest !== this.digest(payload)) return error('integrity', 'input checksum');
    return null;
  }
  async acceptInput(input: InputEvent): Promise<Result<DurableInputReceipt>> {
    if (this.locked || this.restoring) return busy();
    return this.acceptOrdered(input);
  }
  private async acceptOrdered(input: InputEvent): Promise<Result<DurableInputReceipt>> {
    if (this.locked) return busy();
    // Bound before clone/hash; C never keeps a lifetime input log in RAM.
    if (input.payload.kind === 'bytes' && input.payload.bytes.length > B.rawBytesPerPane / 16) return busy();
    if (size(input) * 2 + (input.payload.kind === 'bytes' ? input.payload.bytes.length * 16 : 0) > B.rawBytesPerPane) return busy();
    this.locked = true;
    let release: (() => void) | null = null;
    try {
      const invalid = this.validate(input);
      if (invalid) return invalid;
      if (this.episode) return this.episode.reason === 'late-gap' ? { status: 'stale', reason: 'late-gap' } : error('unresolved-gap', this.episode.episodeId);
      const event = immutable(input);
      if (this.pending) {
        if (event.position.packetSeq !== this.pending.event.position.packetSeq) return busy();
        if (event.digest !== this.pending.event.digest) return error('integrity', 'pending event collision');
        const receipt = this.pending.receipt;
        await this.flushPending(); return ok(receipt);
      }
      const after = this.lastInput?.through.packetSeq ?? 0;
      // Durable history owns old retry receipts. Do not retain an unbounded map.
      if (event.position.packetSeq <= after) return await this.ports.history.journalInput(event);
      if (event.position.packetSeq !== after + 1) { this.fault('sequence'); return error('unresolved-gap', 'input sequence gap'); }
      release = this.ports.admission.reserve(B.rawBytesPerPane);
      if (!release) return busy();
      const receipt = await this.ports.history.journalInput(event);
      if (receipt.status !== 'ok') return receipt;
      if (!samePane(receipt.value.pane, event.identity.pane) || receipt.value.through.packetSeq !== event.position.packetSeq
        || receipt.value.through.sourceEpoch !== event.position.sourceEpoch || receipt.value.digest !== event.digest) {
        this.fault('checksum'); return error('integrity', 'journal receipt fence');
      }
      this.lastInput = immutable(receipt.value);
      this.pending = { event, receipt: this.lastInput, release }; release = null;
      // Once journaled, the input is accepted even if row publication is busy.
      // The bounded pending slot survives until append succeeds; next input
      // gets backpressure. This avoids replaying bytes into the live parser.
      const flushed = await this.flushPending();
      if (flushed.status === 'error' || flushed.status === 'stale') this.fault('worker-exit');
      return ok(this.lastInput);
    } catch (cause) { this.fault('reader-error'); return error('io', String(cause)); }
    finally { release?.(); this.locked = false; }
  }
  private async flushPending(): Promise<Result<void>> {
    const p = this.pending; if (!p) return ok(undefined);
    if (this.episode) return error('unresolved-gap', this.episode.episodeId);
    const release = this.ports.scratch.reserve(B.vtBytesPerPane);
    if (!release) return busy();
    let tx: CaptureVtTransaction | null = null;
    try {
      const prepared = await this.ports.vt.prepare(p.event);
      if (prepared.status !== 'ok') return prepared;
      tx = prepared.value;
      const prepareGap = this.activeGap();
      if (prepareGap) return error('unresolved-gap', prepareGap.episodeId);
      if (!sameIdentity(tx.frame.identity, p.event.identity) || tx.scrolls.some(row => row.uncertainFields.length))
        return error('integrity', 'VT identity or uncertain scroll');
      if (!counter(this.frame.head + tx.scrolls.length) || !counter(this.frame.revision + 1)) return error('integrity', 'counter exhausted');
      const rows: FinalizedRow[] = tx.scrolls.map((row, scrollOrdinal) => ({ ...row,
        id: { pane: this.identity.pane, lineId: this.frame.head + scrollOrdinal }, revision: this.frame.revision + 1,
        source: { pane: this.identity.pane, ...p.event.position, scrollOrdinal },
        geometryGeneration: p.event.identity.geometryGeneration, geometry: tx!.frame.geometry }));
      if (!this.tail.canAppend(rows)) return busy();
      const body = { identity: p.event.identity, eventId: { pane: this.identity.pane, ...p.event.position, scrollOrdinal: 0 },
        expectedRevision: this.frame.revision, rows, frameDelta: tx.frame, receivedAtMonoMs: p.event.receivedAtMonoMs };
      const request: AppendFinalized = immutable({ ...body, digest: this.digest(body) });
      const receipt = await this.ports.history.appendFinalized(request);
      if (receipt.status !== 'ok') return receipt;
      if (receipt.value.head !== this.frame.head + rows.length || receipt.value.revision !== this.frame.revision + 1
        || receipt.value.digest !== request.digest || this.digest(receipt.value.eventId) !== this.digest(request.eventId)) {
        this.fault('checksum'); return error('integrity', 'append receipt fence');
      }
      const commitGap = this.activeGap();
      if (commitGap) {
        // A commit may have landed during source failure. Do not publish its
        // suffix or claim the pre-commit append fence still covers it.
        const late: GapEpisode = immutable({ ...commitGap, reason: 'late-gap', status: 'unresolved' });
        this.episode = late;
        this.record({ kind: 'gap', episode: late });
        return { status: 'stale', reason: 'late-gap' };
      }
      tx.install(); tx = null;
      this.tail.append(rows); this.identity = immutable(p.event.identity);
      this.publish({ ...request.frameDelta, revision: receipt.value.revision,
        durableRevision: this.frame.durableRevision, head: receipt.value.head });
      this.record({ kind: 'publish', eventId: request.eventId, receivedAtMonoMs: p.event.receivedAtMonoMs,
        ramPublishedAtMonoMs: this.ports.now(), durableAtMonoMs: null });
      this.lastCheckpointInput = p.receipt;
      this.pending = null; p.release(); return ok(undefined);
    } finally { tx?.discard(); release(); }
  }
  subscribe(pane: PaneKey, listener: (frame: LiveFrame) => void): () => void {
    if (!this.matches(pane)) throw new Error('capture subscription identity');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async checkpoint(pane: PaneKey, _reason: 'periodic' | 'row-limit' | 'handoff'): Promise<Result<VtCheckpoint>> {
    if (!this.matches(pane)) return { status: 'stale', reason: 'identity' };
    if (this.locked) return busy();
    this.locked = true;
    const release = this.ports.scratch.reserve(B.vtBytesPerPane);
    if (!release) { this.locked = false; return busy(); }
    try {
      if (this.episode) return error('unresolved-gap', this.episode.episodeId);
      // Checkpoint the admitted prefix first even if a later input is waiting
      // for tail capacity. Its fence MUST NOT be that pending input's receipt.
      const fence = this.pending ? this.lastCheckpointInput : this.lastInput;
      if (!fence) return error('unsupported', 'no admitted durable input fence');
      const state = await this.ports.vt.snapshot(); if (state.status !== 'ok') return state;
      if (size(state.value) * 2 > B.vtBytesPerPane) return busy();
      const stateDigest = this.digest(state.value);
      const body = { kind: 'vt-recovery' as const, previousCheckpointId: this.lastCheckpoint?.checkpointId ?? null,
        identity: this.identity, inputFence: fence, revision: this.frame.revision, head: this.frame.head, state: state.value, stateDigest };
      const checkpoint = immutable({ ...body, checkpointId: this.digest(body) });
      const commit = { checkpoint, expectedRevision: this.frame.revision, commitId: checkpoint.checkpointId };
      const result = await this.ports.history.commitCheckpoint({ ...commit, digest: this.digest(commit) });
      if (result.status !== 'ok') return result;
      if (!samePane(result.value.pane, pane) || result.value.durableRevision !== this.frame.revision
        || result.value.checkpointId !== checkpoint.checkpointId) return error('integrity', 'checkpoint receipt fence');
      this.lastCheckpoint = checkpoint; this.durable = immutable(result.value);
      this.tail.durable(result.value.durableRevision);
      this.checkpointAt = this.ports.now(); this.checkpointHead = this.frame.head;
      this.publish({ ...this.frame, durableRevision: result.value.durableRevision });
      return ok(checkpoint);
    } catch (cause) { this.fault('worker-exit'); return error('io', String(cause)); }
    finally { release(); this.locked = false; }
  }
  private lastCheckpointInput: DurableInputReceipt | null = null;
  async restore(checkpoint: VtCheckpoint, input: AsyncIterable<InputEvent>): Promise<Result<LiveFrame>> {
    if (this.locked || this.pending || this.restoring || this.episode) return busy();
    if (!sameIdentity(checkpoint.identity, this.identity)) return { status: 'stale', reason: 'identity' };
    if (checkpoint.stateDigest !== this.digest(checkpoint.state)) return error('integrity', 'VT checkpoint checksum');
    // Restoring over a newer live stream would reuse IDs or hide a late gap.
    if (this.frame.head > checkpoint.head || this.frame.revision > checkpoint.revision) return { status: 'stale', reason: 'late-gap' };
    if (size(checkpoint.state) * 2 > B.vtBytesPerPane) return busy();
    const release = this.ports.scratch.reserve(B.vtBytesPerPane); if (!release) return busy();
    this.locked = true;
    try {
      const result = await this.ports.vt.restore(immutable(checkpoint.state));
      if (result.status !== 'ok') return result;
      const tx = result.value;
      if (!sameIdentity(tx.frame.identity, checkpoint.identity) || tx.scrolls.length) { tx.discard(); return error('integrity', 'restore must not invent scrolls'); }
      tx.install();
      this.lastInput = immutable(checkpoint.inputFence); this.lastCheckpointInput = this.lastInput;
      this.lastCheckpoint = immutable(checkpoint);
      this.publish({ ...tx.frame, revision: checkpoint.revision, head: checkpoint.head, durableRevision: checkpoint.revision });
    } catch (cause) { this.fault('worker-exit'); return error('io', String(cause)); }
    finally { release(); this.locked = false; }
    this.restoring = true;
    try {
      for await (const event of input) {
        const result = await this.acceptOrdered(event); if (result.status !== 'ok') return result;
        if (this.pending) return busy();
      }
      return ok(this.frame);
    } catch (cause) { this.fault('reader-error'); return error('io', String(cause)); }
    finally { this.restoring = false; }
  }
  async checkVisible(identity: StreamIdentity): Promise<Result<{ readonly verdict: 'equal' | 'different' | 'unfenced' }>> {
    if (!sameIdentity(identity, this.identity)) return { status: 'stale', reason: 'identity' };
    if (this.visibleLocked) return busy();
    const release = this.ports.scratch.reserve(B.decodeBytes); if (!release) return busy();
    this.visibleLocked = true;
    const eligible = this.ports.now(), before = this.lastInput?.through.packetSeq ?? 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), B.visibleDeadlineMs);
    let outcome: 'ok' | 'unfenced' | 'error' = 'error';
    try {
      const snapshot = immutable(this.ports.vt.screen());
      const capture = await this.ports.visible(identity, 0, controller.signal);
      if (controller.signal.aborted || this.ports.now() - eligible > B.visibleDeadlineMs) return error('deadline', 'visible deadline');
      if (capture.status !== 'ok') return capture;
      const after = this.lastInput?.through.packetSeq ?? 0;
      const complete = (frame: FrameDelta) => frame.changedRows.length === frame.geometry.rows
        && new Set(frame.changedRows.map(r => r.y)).size === frame.geometry.rows
        && frame.changedRows.every(r => counter(r.y) && r.y < frame.geometry.rows && r.content.cells.length === frame.geometry.columns);
      const verdict = this.pending || this.locked || !complete(snapshot) || !complete(capture.value)
        ? 'unfenced' : exactVisibleVerdict(snapshot, capture.value, before, after);
      outcome = verdict === 'unfenced' ? 'unfenced' : 'ok';
      if (verdict === 'different') this.fault('visible-divergence');
      return ok({ verdict });
    } catch (cause) { return error('io', String(cause)); }
    finally {
      clearTimeout(timer); controller.abort(); release(); this.visibleLocked = false;
      this.record({ kind: 'request', requestId: `visible:${++this.serial}`, pane: this.identity.pane, operation: 'visible',
        eligibleAtMonoMs: eligible, deadlineMonoMs: eligible + B.visibleDeadlineMs, completedAtMonoMs: this.ports.now(), outcome });
    }
  }
  async *repair(episode: GapEpisode, cancel: CancelToken): AsyncIterable<Result<RepairReceipt>> {
    if (this.locked) { yield busy(); return; }
    if (!this.episode || episode.episodeId !== this.episode.episodeId || !samePane(episode.pane, this.identity.pane)) {
      yield error('unresolved-gap', 'episode not active'); return;
    }
    if (this.episode.reason === 'late-gap') { yield { status: 'stale', reason: 'late-gap' }; return; }
    this.locked = true;
    const controller = new AbortController();
    const deadline = episode.firstObservedAtMonoMs + B.recoveryMs;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - this.ports.now()));
    try {
      for await (const result of this.ports.repairChunks(this.episode, controller.signal)) {
        if (cancel.isCancelled()) { yield { status: 'cancelled', reason: 'repair cancelled' }; return; }
        if (controller.signal.aborted || this.ports.now() > deadline) { yield error('deadline', 'repair exceeded 10000ms'); return; }
        if (result.status !== 'ok') { yield result; return; }
        const chunk = result.value;
        if (chunk.rows.length > B.decodeRows || size(chunk) > B.decodeBytes || chunk.episode.episodeId !== episode.episodeId) {
          yield error('integrity', 'repair chunk bounds/fence'); return;
        }
        const release = this.ports.scratch.reserve(B.decodeBytes);
        if (!release) { yield busy(); return; }
        let receipt: Result<RepairReceipt>;
        try {
          receipt = await this.ports.history.commitRepair(chunk);
          if (receipt.status === 'ok') {
            // Sync immediately, including a prefix whose later chunk fails.
            try {
              const synced = await this.ports.syncRepair(chunk, receipt.value);
              if (!sameIdentity(synced.identity, this.identity) || synced.revision !== receipt.value.committedRevision
                || synced.durableRevision !== receipt.value.durable.durableRevision || synced.head < this.frame.head)
                throw new Error('repair sync fence');
              this.publish(synced);
            } catch (cause) {
              yield receipt; yield error('unresolved-gap', `committed prefix requires sync: ${String(cause)}`); return;
            }
            if (receipt.value.complete) {
              if (!chunk.final || cancel.isCancelled() || controller.signal.aborted
                || !(await this.ports.verifyRepair(episode, controller.signal))) {
                yield error('unresolved-gap', 'durable repair lacks exact live seam proof'); return;
              }
              this.episode = immutable({ ...this.episode!, status: 'repaired', missingCount: 0 });
              this.record({ kind: 'gap', episode: this.episode }); this.episode = null;
            }
          }
        } finally { release(); }
        yield receipt;
        if (receipt.status !== 'ok' || receipt.value.complete) return;
      }
      yield error('unresolved-gap', 'repair ended without completion');
    } catch (cause) { yield error('io', String(cause)); }
    finally { clearTimeout(timer); controller.abort(); this.locked = false; }
  }
  async drain(pane: PaneKey, deadlineMonoMs: number): Promise<Result<DurableReceipt>> {
    if (!this.matches(pane)) return { status: 'stale', reason: 'identity' };
    if (this.ports.now() >= deadlineMonoMs) return error('deadline', 'drain deadline');
    if (this.locked) return busy();
    if (this.pending) {
      this.locked = true;
      try { const flushed = await this.flushPending(); if (flushed.status !== 'ok') return flushed; }
      finally { this.locked = false; }
    }
    const result = await this.checkpoint(pane, 'handoff');
    if (result.status !== 'ok') return result;
    return this.ports.now() > deadlineMonoMs ? error('deadline', 'drain deadline') : ok(this.durable!);
  }
}
