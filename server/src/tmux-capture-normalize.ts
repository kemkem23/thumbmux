import { charCellWidth, stringCells } from '@thumbmux/core';

const ESC = 0x1b;
const BEL = 0x07;
const SO = 0x0e;
const SI = 0x0f;
const VS16 = 0xfe0f;

function escapeEnd(text: string, start: number): number {
  const introducer = text.charCodeAt(start + 1);
  if (introducer === 0x5b) {
    // CSI: consume through the first final byte (0x40..0x7e).
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return text.length;
  }
  if (introducer === 0x5d) {
    // OSC: BEL or ST terminates the payload.
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === BEL) return index + 1;
      if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    return text.length;
  }
  return Math.min(text.length, start + 2);
}

/**
 * tmux 3.4 serializes a narrow base promoted by VS16 as the grapheme followed
 * by one ASCII continuation cell. For example, a pane containing `A❤️B` is
 * returned by `capture-pane` as `A❤️ B`; an intentional space becomes two.
 * CJK and intrinsically-wide emoji do not receive that extra byte.
 *
 * Thumbmux already renders the promoted unit as a two-cell `.mtv-w2` box, so
 * retaining tmux's continuation byte makes the following glyph and cursor one
 * cell too far right. Remove exactly one such byte while preserving ANSI/OSC
 * sequences and every intentional additional space.
 */
export function normalizeTmuxCaptureCells(text: string): string {
  let normalized = '';
  let index = 0;
  let previousVisibleWidth: 0 | 1 | 2 = 0;
  let promotedPaddingPending = false;

  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const unitLength = codePoint > 0xffff ? 2 : 1;

    if (codePoint === ESC) {
      const end = escapeEnd(text, index);
      normalized += text.slice(index, end);
      index = end;
      continue;
    }
    if (codePoint === 0x0a) {
      normalized += '\n';
      index += 1;
      previousVisibleWidth = 0;
      promotedPaddingPending = false;
      continue;
    }
    if (codePoint === SO || codePoint === SI) {
      // Shift Out/In changes the active terminal character set but occupies
      // no cell. tmux normally consumes it before capture-pane serialization;
      // preserve the byte without losing a still-pending continuation cell if
      // an alternate capture mode or tmux version does surface it.
      normalized += text.slice(index, index + unitLength);
      index += unitLength;
      continue;
    }

    const width = codePoint >= 0x20 && codePoint < 0x7f ? 1 : charCellWidth(codePoint);
    if (promotedPaddingPending && codePoint === 0x20) {
      promotedPaddingPending = false;
      index += 1;
      continue;
    }
    if (promotedPaddingPending && width > 0) promotedPaddingPending = false;

    normalized += text.slice(index, index + unitLength);
    index += unitLength;
    if (codePoint === VS16 && previousVisibleWidth === 1) {
      previousVisibleWidth = 2;
      promotedPaddingPending = true;
    } else if (width > 0) {
      previousVisibleWidth = width;
    }
  }

  return normalized;
}

/** Exact observed cell projection of a capture-pane -e -N row stream.
 * This decodes a snapshot, not a VT emulator. Unsupported escapes fail closed.
 * OSC8 and hidden parser state are deliberately not certified by this decoder. */
export interface TmuxObservedCell {
  grapheme: string;
  width: 0 | 1 | 2;
  continuation: boolean;
  fg: string;
  bg: string;
  style: number;
}
export const TMUX_OBSERVED_FIELDS = ['grapheme', 'width', 'continuation', 'fg', 'bg', 'style', 'cursor-position', 'cursor-visible'] as const;
/** `TmuxObservedCell.style` bits: SGR n (1..9) sets bit n-1, SGR 21 sets
 * DOUBLE_UNDERLINE. The decoder keeps every bit it reads (dim, rapid blink,
 * hidden included); a consumer that compares against a parser limited to a
 * subset must mask its comparison, never these cells. */
export const TMUX_STYLE_BITS = {
  BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, BLINK: 16, RAPID_BLINK: 32, REVERSE: 64, HIDDEN: 128, STRIKE: 256, DOUBLE_UNDERLINE: 512,
} as const;
// Segmenter instances are stateless between segment() calls. Constructing one
// per capture cost ~10us, which dominated one-row decodes.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const SGR_AT = /\x1b\[([0-9;:]*)m/y;
interface SgrState { fg: string; bg: string; style: number }
function applySgr(state: SgrState, body: string): void {
  // tmux uses colon subparameters for underline variants and overline.
  // These decorations are outside this projection; consume them without
  // mistaking their parameters for bold, blink, or foreground colours.
  if (body.includes(':')) body = body.replace(/(38|48|58):2::?(\d+):(\d+):(\d+)/g, '$1;2;$2;$3;$4')
    .replace(/(38|48|58):5:(\d+)/g, '$1;5;$2')
    .replace(/\b(4|5):[0-9]+/g, (_, kind) => kind === '4' ? '4' : '53');
  if (!/^[0-9;]*$/.test(body)) throw new Error('unsupported capture SGR');
  const codes = body === '' ? [0] : body.split(';').map(x => x === '' ? 0 : Number(x));
  for (let i = 0; i < codes.length; i++) {
    const n = codes[i]!;
    if (n === 0) { state.fg = state.bg = 'default'; state.style = 0; }
    else if (n >= 1 && n <= 9) state.style |= 1 << (n - 1);
    else if (n === 21) state.style = (state.style & ~8) | 512;
    else if (n === 22) state.style &= ~3;
    else if (n === 23) state.style &= ~4;
    else if (n === 24) state.style &= ~(8 | 512);
    else if (n === 25) state.style &= ~(16 | 32);
    else if (n === 27) state.style &= ~64;
    else if (n === 28) state.style &= ~128;
    else if (n === 29) state.style &= ~256;
    else if (n === 39) state.fg = 'default';
    else if (n === 49) state.bg = 'default';
    else if (n >= 30 && n <= 37) state.fg = `index:${n - 30}`;
    else if (n >= 40 && n <= 47) state.bg = `index:${n - 40}`;
    else if (n >= 90 && n <= 97) state.fg = `index:${n - 90 + 8}`;
    else if (n >= 100 && n <= 107) state.bg = `index:${n - 100 + 8}`;
    else if (n === 53 || n === 55 || n === 59) { /* unobserved decoration */ }
    else if (n === 38 || n === 48 || n === 58) {
      const mode = codes[++i];
      const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
      if (!count) throw new Error('unsupported capture color');
      const values = codes.slice(i + 1, i + count + 1);
      if (values.length !== count || values.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('invalid capture color');
      i += count;
      const color = mode === 5 ? `index:${values[0]}` : `rgb:${values.join(',')}`;
      if (n === 38) state.fg = color; else if (n === 48) state.bg = color;
    } else throw new Error(`unobserved capture SGR ${n}`);
  }
}
const printableAscii = (code: number) => code >= 0x20 && code < 0x7f;
// Pieces and widths are a pure function of the cluster text. Cache them so
// repeated glyphs skip the per-cluster regexes and code-point width tables.
const CLUSTER_PIECES = new Map<string, ReadonlyArray<readonly [string, 0 | 1 | 2]>>();
function clusterPieces(cluster: string): ReadonlyArray<readonly [string, 0 | 1 | 2]> {
  const cached = CLUSTER_PIECES.get(cluster);
  if (cached) return cached;
  // tmux merges emoji ZWJ/flag/skin-tone clusters, but Thai spacing
  // vowels remain separate cells even inside a Unicode grapheme.
  const pieces = /[\u0e00-\u0e7f]/u.test(cluster)
    ? cluster.match(/[^\p{Mark}][\p{Mark}]*/gu) ?? [cluster] : [cluster];
  const result = pieces.map(segment => {
    if (/[\x00-\x1f\x7f]/.test(segment)) throw new Error('control byte in capture cells');
    let width: 0 | 1 | 2 = segment.length === 1 && printableAscii(segment.charCodeAt(0))
      ? 1 : Math.min(2, stringCells(segment)) as 0 | 1 | 2;
    if (segment.includes('\ufe0f') && width === 1) width = 2;
    return [segment, width] as const;
  });
  if (CLUSTER_PIECES.size >= 4096) CLUSTER_PIECES.clear();
  CLUSTER_PIECES.set(cluster, result);
  return result;
}
function pushClusters(cells: TmuxObservedCell[], text: string, state: SgrState): void {
  for (const { segment: cluster } of SEGMENTER.segment(text)) {
    for (const [segment, width] of clusterPieces(cluster)) {
      if (width === 0) {
        const previous = cells.findLast(c => !c.continuation);
        if (!previous) throw new Error('orphan combining capture cell');
        previous.grapheme += segment;
        continue;
      }
      cells.push({ grapheme: segment, width, continuation: false, fg: state.fg, bg: state.bg, style: state.style });
      if (width === 2) cells.push({ grapheme: '', width: 0, continuation: true, fg: state.fg, bg: state.bg, style: state.style });
    }
  }
}
/** Segment one escape-free run. A printable ASCII code unit whose neighbours
 * are both printable ASCII (or the run edge) is always its own grapheme
 * cluster: no UAX #29 rule joins two such units, and ASCII is never Extend,
 * ZWJ, Prepend or Regional_Indicator. Every other unit, plus one ASCII unit on
 * each side of it, is segmented by Intl.Segmenter exactly as before. Those
 * island edges are guaranteed boundaries, so no cluster crosses them. */
function pushText(cells: TmuxObservedCell[], text: string, state: SgrState): void {
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (printableAscii(code) && (at + 1 >= text.length || printableAscii(text.charCodeAt(at + 1)))) {
      cells.push({ grapheme: text[at]!, width: 1, continuation: false, fg: state.fg, bg: state.bg, style: state.style });
      at++; continue;
    }
    let end = at + 1;
    while (end < text.length && !(printableAscii(text.charCodeAt(end - 1)) && printableAscii(text.charCodeAt(end))
      && (end + 1 >= text.length || printableAscii(text.charCodeAt(end + 1))))) end++;
    // `end` stops before an ASCII unit whose left and right neighbours are ASCII.
    pushClusters(cells, text.slice(at, end), state);
    at = end;
  }
}
function decodeLine(line: string, cols: number, state: SgrState, clip = false): TmuxObservedCell[] {
  const cells: TmuxObservedCell[] = [];
  let at = 0;
  while (at < line.length) {
    if (line.charCodeAt(at) === ESC) {
      if (line.startsWith('\x1b]8;', at)) { at = escapeEnd(line, at); continue; }
      SGR_AT.lastIndex = at;
      const match = SGR_AT.exec(line);
      if (!match) throw new Error('unsupported capture escape');
      applySgr(state, match[1]!); at += match[0].length; continue;
    }
    const next = line.indexOf('\x1b', at);
    const text = line.slice(at, next < 0 ? line.length : next);
    pushText(cells, text, state);
    at += text.length;
  }
  if (cells.length > cols) {
    if (!clip) throw new Error('capture row exceeds geometry');
    cells.length = cols;
    // A wide cell cut at the right edge loses its continuation: draw a blank.
    const last = cells[cols - 1]!;
    if (last.width === 2) cells[cols - 1] = { grapheme: ' ', width: 1, continuation: false, fg: last.fg, bg: last.bg, style: last.style };
  }
  while (cells.length < cols) cells.push({ grapheme: ' ', width: 1, continuation: false, fg: 'default', bg: 'default', style: 0 });
  return cells;
}
function checkedCols(cols: number): void {
  if (!Number.isSafeInteger(cols) || cols < 1) throw new Error('invalid capture width');
}
// tmux can merge a spacing heart into the preceding skin-tone cell. Its
// serialized text loses that cell boundary; do not certify a guessed width.
// tmux 3.4 also splits/merges cells unlike Unicode for: a third regional
// indicator, skin tones joined by ZWJ (either side), and ZWJ flag sequences
// (capture pads the VS16 cell with a space before the ZWJ).
const AMBIGUOUS_EMOJI = /[\u{1f3fb}-\u{1f3ff}](?:\u2764|\u200d)|\u200d\p{Extended_Pictographic}\ufe0f?[\u{1f3fb}-\u{1f3ff}]|[\u{1f1e6}-\u{1f1ff}]{3}|[\u{1f3f3}\u{1f3f4}]\ufe0f? ?\u200d/u;
/** Best-effort cells for a row whose tmux cell boundary is ambiguous: Unicode
 * (wcwidth) widths, clipped to the pane width. Never certified as exact. */
function decodeUncertainLine(line: string, cols: number, state: SgrState): TmuxObservedCell[] {
  return decodeLine(line, cols, state, true);
}
/** Screen decode with row isolation (FIX1-PLAN §7.4 / A-M3): an emoji whose
 * tmux cell boundary cannot be recovered makes only its own row uncertain.
 * The row is still drawn with Unicode widths; `uncertainRows` tells the
 * calibrator never to certify it. Any other decode fault still throws. */
export function decodeTmuxCaptureScreen(raw: string, cols: number): { rows: TmuxObservedCell[][]; uncertainRows: number[] } {
  checkedCols(cols);
  const rawLines = raw.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const uncertain = rawLines.map(line => AMBIGUOUS_EMOJI.test(line));
  if (!uncertain.some(Boolean)) return { rows: decodeTmuxCaptureRows(raw, cols), uncertainRows: [] };
  const lines = normalizeTmuxCaptureCells(raw).split('\n');
  if (lines.at(-1) === '') lines.pop();
  // An escape spanning a line break would misalign flags and rows.
  if (lines.length !== rawLines.length || !rawLines.every(escapesCloseInLine)) throw new Error('ambiguous tmux emoji cell boundary');
  const state: SgrState = { fg: 'default', bg: 'default', style: 0 };
  const uncertainRows: number[] = [];
  const rows = lines.map((line, y) => {
    if (!uncertain[y]) return decodeLine(line, cols, state);
    uncertainRows.push(y);
    return decodeUncertainLine(line, cols, state);
  });
  return { rows, uncertainRows };
}
/** Strict decode: throws on any ambiguous emoji boundary. Oracle use only;
 * the capture path uses decodeTmuxCaptureScreen / TmuxCaptureDecoder. */
export function decodeTmuxCaptureRows(raw: string, cols: number): TmuxObservedCell[][] {
  checkedCols(cols);
  if (AMBIGUOUS_EMOJI.test(raw)) throw new Error('ambiguous tmux emoji cell boundary');
  const lines = normalizeTmuxCaptureCells(raw).split('\n');
  // capture-pane terminates its serialized last physical row with one LF.
  if (lines.at(-1) === '') lines.pop();
  const state: SgrState = { fg: 'default', bg: 'default', style: 0 };
  return lines.map(line => decodeLine(line, cols, state));
}

/** True when every escape in `line` terminates inside it. Normalizing such a
 * line alone equals normalizing it inside the whole capture: the padding state
 * resets at LF and no escape consumes the LF. */
function escapesCloseInLine(line: string): boolean {
  for (let at = line.indexOf('\x1b'); at >= 0; at = line.indexOf('\x1b', at + 1)) {
    const introducer = line.charCodeAt(at + 1);
    if (introducer === 0x5b || introducer === 0x5d) {
      const end = escapeEnd(line, at);
      const last = line.charCodeAt(end - 1);
      if (introducer === 0x5b ? !(last >= 0x40 && last <= 0x7e) || end - 1 < at + 2
        : !(last === BEL || (last === 0x5c && line.charCodeAt(end - 2) === ESC && end - 2 > at))) return false;
    } else if (at + 1 >= line.length) return false;
  }
  return true;
}

// Cached rows hold interned cells. A fresh object per cell cost ~2.4 GB for
// 44 panes x 9000 cached rows and stalled the 3 GB test cage; shared frozen
// cells leave one pointer per column. The table only bounds sharing: clearing
// it never changes a decoded value.
const CELL_INTERN_LIMIT = 65536;
// Two levels: SGR state, then (width, continuation) slot keyed by grapheme.
// Runs of cells share one state, so the last bucket is reused without
// building any key per cell (a six-part key per cell was ~24% of benchmark CPU).
type InternBucket = Map<string, Readonly<TmuxObservedCell>>[];
const internedCells = new Map<string, InternBucket>();
let internedCount = 0;
let lastFg = '', lastBg = '', lastStyle = -1;
let lastBucket: InternBucket | undefined;
function internCell(cell: TmuxObservedCell): Readonly<TmuxObservedCell> {
  if (!lastBucket || cell.fg !== lastFg || cell.bg !== lastBg || cell.style !== lastStyle) {
    const style = `${cell.fg}\u0000${cell.bg}\u0000${cell.style}`;
    lastBucket = internedCells.get(style);
    if (!lastBucket) { lastBucket = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()]; internedCells.set(style, lastBucket); }
    lastFg = cell.fg; lastBg = cell.bg; lastStyle = cell.style;
  }
  const slot = lastBucket[cell.width * 2 + (cell.continuation ? 1 : 0)]!;
  let shared = slot.get(cell.grapheme);
  if (!shared) {
    if (internedCount >= CELL_INTERN_LIMIT) {
      // Bounding only: drop every bucket, keep this state's (now empty) one.
      internedCells.clear(); internedCount = 0;
      for (const map of lastBucket) map.clear();
      internedCells.set(`${cell.fg}\u0000${cell.bg}\u0000${cell.style}`, lastBucket);
    }
    shared = Object.freeze(cell);
    slot.set(cell.grapheme, shared); internedCount++;
  }
  return shared;
}

/**
 * Bytes a cache is counted at (NEWARCH2 M3): one pointer slot per array
 * element, fixed headers per array / object / string / Map entry, and two
 * bytes per string code unit (the UTF-16 upper bound). Shared cells are
 * interned and counted nowhere per row. This is an explicit model for
 * comparing retention, not a heap measurement.
 */
export const CACHE_BYTE_MODEL = Object.freeze({ slot: 8, arrayHeader: 16, object: 48, stringHeader: 16, char: 2, mapEntry: 32, setEntry: 16 });
export interface DecoderCacheStats {
  entries: number; cellSlots: number; keyChars: number; bytes: number;
  generation: number; hits: number; misses: number;
}

/** Exact per-line memo for one pane's repeated overlap. The key is the raw
 * physical row plus the SGR state carried into it, so a hit returns exactly
 * what decodeTmuxCaptureRows would. Returned rows are shared between calls and
 * typed read-only; freezing them doubled cold decode time, so callers must not
 * mutate them (the matcher clones what it keeps). Their cells are interned and
 * frozen, so one cell object can appear in many rows. */
export class TmuxCaptureDecoder {
  private cache = new Map<string, { cells: readonly Readonly<TmuxObservedCell>[]; fg: string; bg: string; style: number; used: number }>();
  private generation = 0;
  hits = 0; misses = 0;
  /** Row indexes of the last decode() that are isolated as uncertain. */
  uncertainRows: number[] = [];
  /** Retention follows the captures in use (I4-FIX1 F11, CANARY-FIX M): after
   * each decode the memo keeps the rows the last two decodes returned, so a
   * steady tail keeps the overlap it hits and a run of full 4500-row captures
   * stays warm. A row older than both is dropped: tmux returns it again only
   * in a later full capture, which re-decodes it once. `minEntries` is the
   * floor of rows kept regardless (oldest dropped first), `maxEntries` the
   * cap. The old floor of 1024 kept rows no capture returned any more; each
   * pinned its cells plus the runtime's canonical and frame side tables
   * (~4 KB/row): 30 MiB at 12 min of the 21-pane soak, growing all 30 min.
   * `mapCell` (NEWARCH2 M3) maps every cell once, when its row is decoded, into
   * the caller's namespace: the memo then holds the rows the caller uses, and
   * the caller keeps no second array per row beside it. */
  constructor(readonly cols: number, private readonly maxEntries = 9000, private readonly minEntries = 1,
    private readonly mapCell?: (cell: Readonly<TmuxObservedCell>) => Readonly<TmuxObservedCell>) {
    checkedCols(cols);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('invalid decoder cache size');
    if (!Number.isSafeInteger(minEntries) || minEntries < 1) throw new Error('invalid decoder cache size');
  }
  get size(): number { return this.cache.size; }
  /** True when every row decode() returns is already mapped by `mapCell`. */
  get mapsCells(): boolean { return this.mapCell !== undefined; }
  /** What the memo holds now, in the bytes of CACHE_BYTE_MODEL (a model, not a heap reading). */
  stats(): DecoderCacheStats {
    let cellSlots = 0, keyChars = 0;
    for (const [key, entry] of this.cache) { cellSlots += entry.cells.length; keyChars += key.length; }
    const m = CACHE_BYTE_MODEL, entries = this.cache.size;
    return {
      entries, cellSlots, keyChars, generation: this.generation, hits: this.hits, misses: this.misses,
      bytes: entries * (m.mapEntry + m.object + m.arrayHeader + m.stringHeader) + cellSlots * m.slot + keyChars * m.char,
    };
  }
  private trim(): void {
    const keep = this.minEntries;
    if (this.cache.size <= keep) return;
    // Insertion order is age order: drop the oldest rows neither of the last two decodes used.
    const stale = this.generation - 1;
    let excess = this.cache.size - keep;
    for (const [key, entry] of this.cache) {
      if (excess <= 0) break;
      if (entry.used < stale) { this.cache.delete(key); excess--; }
    }
  }
  decode(raw: string): (readonly Readonly<TmuxObservedCell>[])[] {
    this.uncertainRows = [];
    this.generation++;
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    try { return this.decodeLines(raw, lines); } finally { this.trim(); }
  }
  private decodeLines(raw: string, lines: string[]): (readonly Readonly<TmuxObservedCell>[])[] {
    if (!lines.every(escapesCloseInLine)) {
      const screen = decodeTmuxCaptureScreen(raw, this.cols);
      this.uncertainRows = screen.uncertainRows;
      const map = this.mapCell;
      return map ? screen.rows.map(row => row.map(map)) : screen.rows;
    }
    const state: SgrState = { fg: 'default', bg: 'default', style: 0 };
    const rows: (readonly Readonly<TmuxObservedCell>[])[] = [];
    for (const line of lines) {
      if (AMBIGUOUS_EMOJI.test(line)) {
        // Row isolation: drawn best-effort, never cached, never certified.
        this.uncertainRows.push(rows.length);
        const cells = decodeUncertainLine(normalizeTmuxCaptureCells(line), this.cols, state);
        rows.push(this.mapCell ? cells.map(this.mapCell) : cells);
        continue;
      }
      const key = `${state.fg}\u0000${state.bg}\u0000${state.style}\u0000${line}`;
      let entry = this.cache.get(key);
      if (entry) {
        this.hits++;
        entry.used = this.generation;
        // No recency refresh: a delete+set per hit churned ~94k Map entries per
        // 21-pane full capture (heap 446 -> 175 MB without it). History rows
        // age in insertion order, so FIFO evicts rows that left tmux first; an
        // early eviction of a repeated row only costs one re-decode.
      } else {
        this.misses++;
        const map = this.mapCell;
        const cells = decodeLine(normalizeTmuxCaptureCells(line), this.cols, state).map(map ? cell => map(internCell(cell)) : internCell);
        entry = { cells, fg: state.fg, bg: state.bg, style: state.style, used: this.generation };
        this.cache.set(key, entry);
        if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      state.fg = entry.fg; state.bg = entry.bg; state.style = entry.style;
      rows.push(entry.cells);
    }
    return rows;
  }
}

export interface TmuxCaptureRowEvidence {
  cells: readonly TmuxObservedCell[] | null;
  /** True only for rows decoded exactly as tmux serialized them. */
  certain: boolean;
  reason: 'observed' | 'ambiguous-cell-boundary' | 'unsupported-row' | 'unknown-style-state';
}
/** Diagnostic projection. Unknown cells are never padded into invented blanks.
 * An ambiguous emoji row keeps best-effort Unicode-width cells with
 * certain=false (row isolation): the screen stays drawable and `complete`,
 * only that row is uncertain. Fail closed after an unparsed escape until an
 * explicit reset establishes the next row's style state again. */
export function decodeTmuxCaptureEvidence(raw: string, cols: number): {
  rows: TmuxCaptureRowEvidence[]; complete: boolean; uncertainRows: number[];
} {
  checkedCols(cols);
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const state: SgrState = { fg: 'default', bg: 'default', style: 0 };
  let known = true;
  const rows: TmuxCaptureRowEvidence[] = [];
  for (const line of lines) {
    if (!known && (line.startsWith('\x1b[0m') || line.startsWith('\x1b[m'))) known = true;
    if (!known) { rows.push({ cells: null, certain: false, reason: 'unknown-style-state' }); continue; }
    try {
      if (!escapesCloseInLine(line)) throw new Error('open escape');
      const normalized = normalizeTmuxCaptureCells(line);
      rows.push(AMBIGUOUS_EMOJI.test(line)
        ? { cells: decodeUncertainLine(normalized, cols, state), certain: false, reason: 'ambiguous-cell-boundary' }
        : { cells: decodeLine(normalized, cols, state), certain: true, reason: 'observed' });
    } catch {
      known = false;
      rows.push({ cells: null, certain: false, reason: 'unsupported-row' });
    }
  }
  return { rows, complete: rows.every(row => row.cells !== null),
    uncertainRows: rows.flatMap((row, y) => row.cells !== null && !row.certain ? [y] : []) };
}
