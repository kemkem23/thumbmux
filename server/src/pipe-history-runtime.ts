/**
 * NEWARCH L2-I lot I4: the runtime adapter that joins the three lots.
 *
 *   pipe bytes -> PipeHistoryCollector (I1) -> onScroll/onFrame
 *     -> ProjectionStore.appendScroll/replaceScreen (I2) -> RAM receipt -> publish
 *   capture-pane (host) -> HistoryCalibrator (I3) -> ProjectionStore.calibrate
 *
 * Contracts honoured here (FIX1-PLAN + each lot's FIX2):
 * - I1 m1: a frame is a DELTA; the full screen is assembled here and becomes
 *   the parser screen only when the store accepted it. A refused frame is
 *   offered again unchanged and is recomputed from the same, untouched state.
 * - I1 m4 / I3 m4: "quiescent" is judged from the RECEIVE counter (bytes taken
 *   off the pipe), not from the last parsed seq.
 * - I2 B1: capture evidence is the store's `quiescent` shape; the store alone
 *   decides whether a capture replaces the displayed screen.
 * - I2 M2 / PLAN §3 read/CAS: `stale-revision` is a CAS conflict -> null;
 *   any other calibrate error is a capture fault.
 * - FIX1 §1.1: capture cells are never fed back to the parser; the displayed
 *   screen and the parser screen are kept apart.
 *
 * One cell codec (review 2 M5) maps both producers into the capture's
 * namespace: colours `default` / `index:N` (0-15) / `rgb:r,g,b`. Captured
 * display cells keep every tmux-observable style bit; certification alone is
 * limited to fields the parser can observe.
 */
import { PipeHistoryCollector, type PipeFaultEvent, type PipeFrameEvent, type PipeScrollEvent } from './pipe-history-collector';
import { PipeVtPool, pipeVtRunCells, type PipeVtAssets, type PipeVtRow } from './pipe-vt-worker';
import { HistoryCalibrator, type CalibrationCapture, type CalibrationFrame, type CaptureMetadata, type CaptureEvidence } from './history-calibrator';
import { HistoryWatchdog } from './history-watchdog';
import type { CapturedRow, HistoryCell, HistoryRow, RowMatch } from './history-row-matcher';
import { CACHE_BYTE_MODEL, TmuxCaptureDecoder, TMUX_OBSERVED_FIELDS, type DecoderCacheStats } from './tmux-capture-normalize';
import { createProjectionStore as createProjectionStoreValue } from './sqlite-history/projection-store';
import { pipeVtAssets as pipeVtAssetsValue, verifyPipeVtAssets as verifyPipeVtAssetsValue } from './pipe-vt-worker';
import {
  isProjectionRefusal,
  type PaneKey,
  type PhysicalRow,
  type ProjectionAdmission,
  type ProjectionFrame,
  type ProjectionHealth,
  type ProjectionIssue,
  type ProjectionPage,
  type ProjectionReceipt,
  type ProjectionToken,
  type ProjectionWriterPort,
} from './sqlite-history/types';
import { PROJECTION_SCHEMA_VERSION } from './sqlite-history/schema';

/** Fail-closed handshake for hosts loading this optional runtime entrypoint. */
export const PIPE_HISTORY_RUNTIME_CAPABILITY = Object.freeze({
  wire: 'newarch-frame-v1',
  projectionSchema: PROJECTION_SCHEMA_VERSION,
  metadataRevision: true,
  archiveReadVersions: Object.freeze([2, 3, 4, 5] as const),
});

// ─── cell codec ───────────────────────────────────────────────────────────

const BASE16 = [
  '000000', 'cd0000', '00cd00', 'cdcd00', '0000ee', 'cd00cd', '00cdcd', 'e5e5e5',
  '7f7f7f', 'ff0000', '00ff00', 'ffff00', '5c5cff', 'ff00ff', '00ffff', 'ffffff',
];
/** The xterm 256 table pyte uses for `38;5;N` (pyte/graphics.py FG_BG_256). */
export const XTERM_256: readonly string[] = (() => {
  const table = [...BASE16];
  const steps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  for (let i = 0; i < 216; i++) {
    table.push([steps[Math.floor(i / 36) % 6]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!]
      .map(v => v.toString(16).padStart(2, '0')).join(''));
  }
  for (let i = 0; i < 24; i++) { const v = (8 + i * 10).toString(16).padStart(2, '0'); table.push(v + v + v); }
  return table;
})();
const NAMED = ['black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'white'];
const rgbOf = (hex: string) => `rgb:${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)}`;

/**
 * pyte colour -> capture namespace. pyte turns every `38;5;N` and `38;2;r;g;b`
 * into a hex string, so an index is recoverable only for the 16 base colours;
 * palette colours 16-255 compare as rgb on both sides (see canonicalCaptureColor).
 */
export function canonicalParserColor(value: string): string {
  if (value === 'default') return 'default';
  const bright = value.startsWith('bright');
  const named = NAMED.indexOf(bright ? value.slice(6) : value);
  if (named >= 0) return `index:${named + (bright ? 8 : 0)}`;
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    const hex = value.toLowerCase();
    const base = BASE16.indexOf(hex);
    return base >= 0 ? `index:${base}` : rgbOf(hex);
  }
  return value;
}
/** Capture colour -> the same namespace: palette 16-255 become their rgb value. */
export function canonicalCaptureColor(value: string): string {
  const match = /^index:(\d+)$/.exec(value);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 255) return rgbOf(XTERM_256[Number(match[1])]!);
  return value;
}
/** Capture style bits the parser can also observe: bold, italic, underline, blink, reverse, strike. */
export const OBSERVED_STYLE_MASK = 1 | 4 | 8 | 16 | 64 | 256;
/** pyte attrs (bold 1, italics 2, underscore 4, strike 8, reverse 16, blink 32) -> capture bits. */
export function parserStyle(attrs: number): number {
  return (attrs & 1 ? 1 : 0) | (attrs & 2 ? 4 : 0) | (attrs & 4 ? 8 : 0) | (attrs & 8 ? 256 : 0)
    | (attrs & 16 ? 64 : 0) | (attrs & 32 ? 16 : 0);
}

/**
 * NEWARCH2 M3: row arrays each conversion path allocates, counted where they
 * are made. `*Shared` counts a row handed out without a new array. Process
 * totals, never reset; a reader takes differences.
 */
const allocations = {
  parserRowArrays: 0, blankRowsShared: 0, canonicalRowArrays: 0, canonicalRowsShared: 0, ringArrayCopies: 0,
};
export function pipeHistoryAllocations(): typeof allocations & { blankRowWidths: number } {
  return { ...allocations, blankRowWidths: blankRows.size };
}

// Two levels (attributes, then grapheme): a parser row looks its attribute
// table up once per run, not a composed key string per cell (P profile).
const interned = new Map<string, Map<string, HistoryCell>>();
let internedCells = 0;
function internTable(width: 0 | 1 | 2, continuation: boolean, fg: string, bg: string, style: number): Map<string, HistoryCell> {
  const key = `${width}${continuation ? 1 : 0}\u0000${fg}\u0000${bg}\u0000${style}`;
  let table = interned.get(key);
  if (!table) { table = new Map(); interned.set(key, table); }
  return table;
}
function internIn(table: Map<string, HistoryCell>, grapheme: string, width: 0 | 1 | 2, continuation: boolean, fg: string, bg: string, style: number): HistoryCell {
  let cell = table.get(grapheme);
  if (!cell) {
    // Bounding only: dropping the tables never changes a value.
    if (internedCells >= 65536) {
      interned.clear(); internedCells = 0;
      // BLANK_CELL stays the one default blank (never reached while it is created: the table is empty then).
      internTable(1, false, 'default', 'default', 0).set(' ', BLANK_CELL); internedCells++;
    }
    // Field order equals the store's decoded cells, so JSON comparisons agree.
    cell = Object.freeze({ grapheme, width, continuation, fg, bg, style });
    table.set(grapheme, cell);
    internedCells++;
  }
  return cell;
}
function internCell(grapheme: string, width: 0 | 1 | 2, continuation: boolean, fg: string, bg: string, style: number): HistoryCell {
  return internIn(internTable(width, continuation, fg, bg, style), grapheme, width, continuation, fg, bg, style);
}
export const BLANK_CELL: HistoryCell = internCell(' ', 1, false, 'default', 'default', 0);

/**
 * One frozen all-blank row per width, shared by every screen and ring row that
 * is blank (NEWARCH2 M3). No consumer writes into a row (applyFrameDelta builds
 * new arrays; the store encodes by row identity), and freezing makes that a
 * rule. The table is bounded only: dropping it never changes a value.
 */
const blankRows = new Map<number, HistoryCell[]>();
export function sharedBlankRow(cols: number): HistoryCell[] {
  let row = blankRows.get(cols);
  if (!row) {
    if (blankRows.size >= 64) blankRows.clear();
    row = Object.freeze(new Array<HistoryCell>(cols).fill(BLANK_CELL)) as HistoryCell[];
    blankRows.set(cols, row);
  }
  allocations.blankRowsShared++;
  return row;
}
const isBlankRun = (run: PipeVtRow[number]) => run[0] === 'default' && run[1] === 'default' && run[2] === 0
  && (typeof run[3] === 'string' ? /^ *$/.test(run[3]) : run[3].every(glyph => glyph === ' '));

/** One parser row (RLE runs) -> exactly `cols` canonical cells. */
interface RunStyle { fg: string; bg: string; style: number; narrow?: Map<string, HistoryCell>; wide?: Map<string, HistoryCell>; cont?: Map<string, HistoryCell> }
export function parserRowCells(row: PipeVtRow, cols?: number): HistoryCell[] {
  if (row.every(isBlankRun)) {
    let width = cols;
    if (width === undefined) { width = 0; for (const run of row) width += run[3].length; }
    return sharedBlankRow(width);
  }
  allocations.parserRowArrays++;
  const glyphs: string[] = [];
  const styles: RunStyle[] = [];
  for (const run of row) {
    const style: RunStyle = { fg: canonicalParserColor(run[0]), bg: canonicalParserColor(run[1]), style: parserStyle(run[2]) };
    for (const glyph of pipeVtRunCells(run)) { glyphs.push(glyph); styles.push(style); }
  }
  const width = cols ?? glyphs.length;
  const cells = new Array<HistoryCell>(width);
  for (let x = 0; x < width; x++) {
    const glyph = glyphs[x];
    if (glyph === undefined) { cells[x] = BLANK_CELL; continue; }
    const s = styles[x]!;
    if (glyph === '') cells[x] = internIn(s.cont ??= internTable(0, true, s.fg, s.bg, s.style), '', 0, true, s.fg, s.bg, s.style);
    else if (glyphs[x + 1] === '') cells[x] = internIn(s.wide ??= internTable(2, false, s.fg, s.bg, s.style), glyph, 2, false, s.fg, s.bg, s.style);
    else cells[x] = internIn(s.narrow ??= internTable(1, false, s.fg, s.bg, s.style), glyph, 1, false, s.fg, s.bg, s.style);
  }
  return cells;
}
// The capture decoder memoizes rows and interns cells (frozen, shared), so a
// row it returns again, or a cell it shares, maps to the same canonical value.
const canonicalRows = new WeakMap<object, HistoryCell[]>();
const canonicalCells = new WeakMap<object, HistoryCell>();
function canonicalCell(cell: Readonly<HistoryCell>): HistoryCell {
  let mapped = canonicalCells.get(cell);
  if (!mapped) {
    mapped = internCell(cell.grapheme, cell.width, cell.continuation, canonicalCaptureColor(cell.fg),
      canonicalCaptureColor(cell.bg), cell.style);
    if (Object.isFrozen(cell)) canonicalCells.set(cell, mapped);
  }
  return mapped;
}
/** Decoder cells (tmux-capture-normalize) -> canonical cells. */
export function canonicalCaptureCells(row: readonly Readonly<HistoryCell>[], cols: number): HistoryCell[] {
  const cached = canonicalRows.get(row);
  if (cached && cached.length === cols) return cached;
  allocations.canonicalRowArrays++;
  const cells = new Array<HistoryCell>(cols);
  for (let x = 0; x < cols; x++) {
    const cell = row[x];
    cells[x] = cell ? canonicalCell(cell) : BLANK_CELL;
  }
  if (Object.isFrozen(row) || Array.isArray(row)) canonicalRows.set(row, cells);
  return cells;
}
/**
 * A capture decoder whose memo holds canonical cells (NEWARCH2 M3). Before,
 * each decoded row had a second, canonical array beside it for as long as the
 * memo kept the row; now the memo row is the canonical row.
 */
export function canonicalCaptureDecoder(cols: number): TmuxCaptureDecoder {
  return new TmuxCaptureDecoder(cols, undefined, undefined, canonicalCell);
}
/** One capture body -> canonical rows of `decoder.cols` cells; rows of a mapping decoder are used as they are. */
export function decodeCanonicalCapture(decoder: TmuxCaptureDecoder, body: string): HistoryCell[][] {
  const cols = decoder.cols, shared = decoder.mapsCells;
  return decoder.decode(body).map(row => {
    if (shared && row.length === cols) { allocations.canonicalRowsShared++; return row as HistoryCell[]; }
    return canonicalCaptureCells(row as readonly HistoryCell[], cols);
  });
}
/** Text of a physical row: a pure function of its cells (store `check-not-exact` compares it). */
export function rowText(cells: readonly HistoryCell[]): string {
  let text = '';
  for (const cell of cells) if (!cell.continuation) text += cell.grapheme;
  return text;
}
export function toPhysicalRow(cells: readonly HistoryCell[]): PhysicalRow {
  return { text: rowText(cells), cells: cells as HistoryCell[] };
}

function colorSgr(value: string, background: boolean): string {
  if (value === 'default') return '';
  const index = /^index:(\d+)$/.exec(value);
  if (index) {
    const n = Number(index[1]);
    if (n < 8) return `;${(background ? 40 : 30) + n}`;
    if (n < 16) return `;${(background ? 100 : 90) + n - 8}`;
    return `;${background ? 48 : 38};5;${n}`;
  }
  const rgb = /^rgb:(\d+),(\d+),(\d+)$/.exec(value);
  return rgb ? `;${background ? 48 : 38};2;${rgb[1]};${rgb[2]};${rgb[3]}` : '';
}
const STYLE_SGR: Array<[number, number]> = [[1, 1], [2, 2], [4, 3], [8, 4], [16, 5], [32, 6], [64, 7], [128, 8], [256, 9]];
function cellSgr(cell: HistoryCell): string {
  let codes = '0';
  for (const [bit, code] of STYLE_SGR) if (cell.style & bit) codes += `;${code}`;
  return `\x1b[${codes}${colorSgr(cell.fg, false)}${colorSgr(cell.bg, true)}m`;
}
const isDefaultBlank = (cell: HistoryCell) => cell.grapheme === ' ' && cell.fg === 'default' && cell.bg === 'default' && cell.style === 0;
/** Self-contained ANSI line (legacy viewers read one line at a time); trailing default blanks trimmed. */
export function cellsToAnsi(cells: readonly HistoryCell[]): string {
  let end = cells.length;
  while (end > 0 && (isDefaultBlank(cells[end - 1]!) || (cells[end - 1]!.continuation && end === cells.length))) end--;
  let out = '';
  let current = 'default\u0000default\u00000';
  for (let x = 0; x < end; x++) {
    const cell = cells[x]!;
    if (cell.continuation) continue;
    const key = `${cell.fg}\u0000${cell.bg}\u0000${cell.style}`;
    if (key !== current) { out += cellSgr(cell); current = key; }
    out += cell.grapheme;
  }
  if (current !== 'default\u0000default\u00000') out += '\x1b[0m';
  return out;
}
/**
 * Screen rows keep their identity while unchanged (applyFrameDelta reuses them
 * and never mutates a row), so a live snapshot encodes only the rows that
 * changed instead of the whole screen on every publish.
 */
const ANSI_ROWS = new WeakMap<readonly HistoryCell[], string>();
function rowAnsi(cells: readonly HistoryCell[]): string {
  let ansi = ANSI_ROWS.get(cells);
  if (ansi === undefined) { ansi = cellsToAnsi(cells); ANSI_ROWS.set(cells, ansi); }
  return ansi;
}

// ─── ports ────────────────────────────────────────────────────────────────

/** Metadata the host reads from tmux for a pane (list-panes / display-message). */
export interface PaneTmuxMeta {
  cols: number; rows: number; alternate: boolean;
  cursor: { x: number; y: number; visible: boolean };
  historySize: number; historyLimit: number; panePid: number;
  mouseSgr: boolean; mouseAny: boolean;
}
/** One capture-pane -p -e -N body bracketed by metadata read in the same tmux client. */
export interface RawPaneCapture {
  captureId: string; requestedAt: number; completedAt: number;
  before: PaneTmuxMeta; after: PaneTmuxMeta;
  /** Physical rows: `tail` history rows (or fewer) then the screen rows. */
  body: string; tail: number;
}
export type RuntimeStore = ProjectionWriterPort & {
  token(key: PaneKey): ProjectionToken;
  /** One pane's slice of health(); a store without it is read through health(). */
  paneHealth?(key: PaneKey): { status: 'healthy' | 'degraded'; issues: ProjectionIssue[] } | null;
};

export interface RuntimeFault {
  paneKey: PaneKey; session: string; kind: string; at: number; message?: string;
  missingCount: number | null; receiveSeqFrom?: number; receiveSeqTo?: number;
}
export interface PaneUpdate { source: 'pipe' | 'tmux-calibrated' | 'issue'; revision: number }
/**
 * History rows a calibrated screen shows again: tmux pulled them back from
 * history when the pane grew. `rows` rows ending before line id `endLine`.
 */
export interface PulledBack { rows: number; endLine: number }
export interface PaneView {
  paneKey: PaneKey; session: string;
  cells: readonly (readonly HistoryCell[])[]; cursor: { x: number; y: number; visible: boolean } | null;
  kind: 'normal' | 'alternate'; cols: number; rows: number;
  displaySource: 'pipe' | 'tmux-calibrated' | 'none';
  token: ProjectionToken | null;
  sourceEpoch: number; geometryGeneration: number;
  mouseSgr: boolean; mouseAny: boolean;
  degraded: boolean; issues: ProjectionIssue[];
  /** Set only for a tmux-calibrated normal screen that holds pulled-back history rows. */
  pulledBack?: PulledBack | null;
}
/**
 * FIX1 §3.2 (7): the gap marker a host shows while the store cannot write
 * (disk full). It lives only here, outside every database, so frame and page
 * carry it even when no SQLite write can succeed; the host replaces it with
 * a durable store marker once storage is back.
 */
export interface StorageOverlay {
  eventId: string; kind: string; reason: string; boundaryLineId: number | null; detectedAt: number;
}
export interface PaneStats {
  received: number; published: number; latencyMs: number[];
  captures: number; captureFaults: number; captureConflicts: number; screenCalibrations: number;
  storeCommits: number; skippedCommits: number; notReady: number;
  captureIntervalMaxMs: number; captureAt: number[];
  faults: Record<string, number>;
}
export interface PaneMemoryStats {
  ring: { rows: number; rowArrays: number; sharedRows: number; cellSlots: number; ansiRows: number; ansiChars: number; floor: number | null; bytes: number };
  certified: { ids: number; bytes: number };
  decoder: DecoderCacheStats | null;
  bytes: number;
}
export interface PipeHistoryPaneOptions {
  paneKey: PaneKey; session: string; meta: PaneTmuxMeta;
  sourceEpoch?: number; scrollOnClear?: boolean;
  capture(tail: number, signal: AbortSignal): Promise<RawPaneCapture>;
  /** Calibrate against tmux (default true). */
  calibrate?: boolean;
  incremental?: boolean;
  historyLimit?: number;
  /**
   * Longest wait before rows a capture matched are committed as certified
   * (default 1000 ms; 64 pending rows commit at once). Captures that change
   * nothing observable are not journaled at all.
   */
  commitIntervalMs?: number;
}
export interface PipeHistoryRuntimeOptions {
  /** One shared interpreter per runtime by default; false is a diagnostic fallback. */
  sharedParser?: boolean;
  store: RuntimeStore;
  now?: () => number;
  nowNs?: () => bigint;
  assets?: PipeVtAssets;
  python?: string;
  /** Independent sink (outside the DB) for every fault; a disk-full store still reports. */
  onFault?: (fault: RuntimeFault) => void;
  /** Newest latency samples kept per pane, also dropped after 5 minutes (default 32,768; 0 keeps none). */
  latencySampleLimit?: number;
  /** Recent history rows kept in RAM per pane for calibration and the live window. */
  ringRows?: number;
}

const RING_ROWS = 4500;
/** Minimum spacing of full-screen writes to the store per pane (leading edge immediate). */
export const FRAME_WRITE_MS = 16;
/** A screen refused for pressure (or a paused store) is offered again after this long, never at once. */
export const FRAME_PRESSURE_RETRY_MS = 50;
/**
 * A frame is written (and published) as soon as it arrives while the frame
 * path — store write plus viewer publish, timed on the main thread — uses less
 * than this share of wall time; above it every pane falls back to one write per
 * FRAME_WRITE_MS. The fixed spacing alone was most of receive→publish at one
 * busy pane (P trace: 14.8 of 21.7 ms at p95), while 21 busy panes still need it.
 * The share never lowers the publish rate below the fixed-spacing rule.
 */
export const FRAME_BUDGET_SHARE = 0.3;
const FRAME_BUDGET_WINDOW_MS = 250;
/** Per-pane statistics are rings: a long-lived pane keeps the newest samples of the last minutes only. */
const STATS_MAX_SAMPLES = 32_768;
const STATS_MAX_AGE_MS = 5 * 60_000;
const RECEIVE_MAX_PENDING = 65_536;
/** A received chunk not published after this long is closed with its age as a (lower-bound) sample. */
const RECEIVE_MAX_AGE_NS = 120_000_000_000n;
/** Loss markers a live frame carries: every one inside the live window, capped to the newest. */
const FRAME_MARKERS_MAX = 256;

/** Exponentially decayed main-thread cost of the frame path (time constant FRAME_BUDGET_WINDOW_MS). */
export class FrameBudget {
  private load = 0;
  private at: number;
  constructor(private readonly clock: () => number = () => performance.now()) { this.at = clock(); }
  private decay(): void {
    const now = this.clock();
    if (now > this.at) { this.load *= Math.exp((this.at - now) / FRAME_BUDGET_WINDOW_MS); this.at = now; }
  }
  spend(ms: number): void { this.decay(); this.load += Math.max(0, ms); }
  /** Share of the main thread the frame path used recently (steady rate → share). */
  share(): number { this.decay(); return this.load / FRAME_BUDGET_WINDOW_MS; }
  busy(): boolean { return this.share() > FRAME_BUDGET_SHARE; }
}

/**
 * Drop the oldest entries of a statistics ring: beyond `limit` (amortized, a
 * quarter at a time) and, every 1024 entries, those stamped before `floor`.
 * `times[i]` is the stamp of `values[i]` (the same array for timestamp rings).
 */
export function trimStatsRing(values: unknown[], times: number[], limit: number, floor: number): void {
  let drop = values.length > limit + (limit >> 2) ? values.length - limit : 0;
  if ((values.length & 1023) === 0 || drop > 0) while (drop < times.length && times[drop]! < floor) drop++;
  if (drop > 0) { values.splice(0, drop); if (times !== values) times.splice(0, drop); }
}

// ─── screen assembly ──────────────────────────────────────────────────────

interface ParserScreen { cols: number; rows: number; cells: HistoryCell[][] }
const blankRow = (cols: number) => sharedBlankRow(cols);
function blankScreen(cols: number, rows: number): ParserScreen {
  return { cols, rows, cells: Array.from({ length: rows }, () => blankRow(cols)) };
}
/** Apply one delta (shift first, then dirty rows) without mutating `screen`. */
export function applyFrameDelta(screen: ParserScreen | undefined, cells: PipeFrameEvent['cells']): { screen: ParserScreen; complete: boolean } {
  const { cols, rows } = cells;
  const sameGeometry = screen !== undefined && screen.cols === cols && screen.rows === rows;
  let next: HistoryCell[][];
  if (cells.full || !sameGeometry) next = Array.from({ length: rows }, () => blankRow(cols));
  else {
    const shift = Math.max(0, Math.min(rows, cells.shift));
    next = [...screen!.cells.slice(shift), ...Array.from({ length: shift }, () => blankRow(cols))];
  }
  let complete = cells.full || sameGeometry;
  for (const [y, row] of Object.entries(cells.dirty)) {
    const index = Number(y);
    if (index >= 0 && index < rows) next[index] = parserRowCells(row, cols);
  }
  if (!cells.full && !sameGeometry) complete = Object.keys(cells.dirty).length >= rows;
  return { screen: { cols, rows, cells: next }, complete };
}

// ─── pane ─────────────────────────────────────────────────────────────────

/** Frozen row identity; only its derived ANSI cache is mutable. Repairs own a fresh cache. */
type RingRow = Readonly<HistoryRow> & { readonly ansiCache: { text?: string } };
function sameScreen(a: readonly (readonly HistoryCell[])[], b: readonly (readonly HistoryCell[])[],
  ca: { x: number; y: number; visible: boolean } | null, cb: { x: number; y: number; visible: boolean } | null): boolean {
  if (a.length !== b.length || JSON.stringify(ca) !== JSON.stringify(cb)) return false;
  for (let y = 0; y < a.length; y++) {
    const ra = a[y]!, rb = b[y]!;
    if (ra.length !== rb.length) return false;
    // Interned cells: equal cells are the same object.
    for (let x = 0; x < ra.length; x++) if (ra[x] !== rb[x]) return false;
  }
  return true;
}
const clampCursor = (cursor: { x: number; y: number; visible: boolean }, cols: number, rows: number) => ({
  x: Math.max(0, Math.min(cols - 1, cursor.x)), y: Math.max(0, Math.min(rows - 1, cursor.y)), visible: cursor.visible,
});

/** A store answer already settled as a refusal (read without awaiting it; Bun only). */
function refusedAlready(answer: Promise<ProjectionAdmission>): boolean {
  const peek = (globalThis as { Bun?: { peek?: ((p: unknown) => unknown) & { status?: (p: unknown) => string } } }).Bun?.peek;
  return peek?.status?.(answer) === 'fulfilled' && isProjectionRefusal(peek(answer));
}

/** tmux's screen (capture-pane -p -e -N) as bytes that paint it on a fresh parser. */
function seedBytes(raw: string, meta: PaneTmuxMeta): Uint8Array {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const screen = lines.slice(Math.max(0, lines.length - meta.rows));
  const cursor = clampCursor(meta.cursor, meta.cols, meta.rows);
  let text = meta.alternate ? '\x1b[?1049h' : '';
  screen.forEach((line, y) => { text += `\x1b[${y + 1};1H\x1b[0m${line}`; });
  text += `\x1b[0m\x1b[${cursor.y + 1};${cursor.x + 1}H${cursor.visible ? '\x1b[?25h' : '\x1b[?25l'}`;
  return new TextEncoder().encode(text);
}

export class PipeHistoryPane {
  readonly paneKey: PaneKey;
  readonly session: string;
  readonly collector: PipeHistoryCollector;
  readonly calibrator: HistoryCalibrator | null;
  readonly watchdog: HistoryWatchdog;
  private screens: { normal?: ParserScreen; alternate?: ParserScreen } = {};
  private parserKind: 'normal' | 'alternate' = 'normal';
  private parserCursor: { x: number; y: number; visible: boolean } = { x: 0, y: 0, visible: true };
  private displayed: { cells: HistoryCell[][]; cursor: { x: number; y: number; visible: boolean } | null; kind: 'normal' | 'alternate'; cols: number; rows: number; source: 'pipe' | 'tmux-calibrated'; pulledBack: PulledBack | null } | null = null;
  /** History rows tmux shows on screen again, by tmux's own counters (see resizePullback). */
  private pulled: PulledBack = { rows: 0, endLine: 0 };
  /** Pull-back state as of the newest capture's metadata; the capture it came with may be published. */
  private capturedPull: PulledBack | null = null;
  private historySizeUnknown = false;
  private ring: RingRow[] = [];
  /** Bumped whenever a ring row's content is replaced (a live window text built before is stale). */
  ringRepairs = 0;
  private scrollSeq = 0;
  private scrollSeqEpoch = -1;
  private received = 0;
  private receiveTimes: Array<{ seq: number; at: bigint }> = [];
  private receiveHead = 0;
  /** Stamps (runtime.now) of stats.latencyMs, index for index; reset when the host replaces the array. */
  private latencyAt: number[] = [];
  private latencyRef: number[] | null = null;
  private listeners = new Set<(update: PaneUpdate) => void>();
  private meta: PaneTmuxMeta;
  private decoder: TmuxCaptureDecoder | null = null;
  private closed = false;
  private lastCaptureAt: number | null = null;
  private lastStoreCommitAt = -Infinity;
  private skippedCommit = false;
  /** Line ids some committed calibration already checked or content-matched. */
  private certified = new Set<number>();
  private pendingPublish: { frame: ProjectionFrame; receipt: ProjectionReceipt } | null = null;
  private pendingFrame: ProjectionFrame | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private frameWriting = false;
  private lastFrameWriteAt = -Infinity;
  /** Earliest re-offer of a screen the store refused (see FRAME_PRESSURE_RETRY_MS). */
  private frameBackoffUntil = 0;
  private pendingIssues: Array<{ kind: string; reason: string; missingCount: number | null; recoverable: boolean }> = [];
  /** Storage-fault marker shown while the store cannot write (see StorageOverlay). */
  private overlay: ProjectionIssue | null = null;
  /** Pending seed→pipe gap marker (see armSeedGap). */
  private seedGap: { base: number; rows: number; seen: number } | null = null;
  readonly stats: PaneStats = {
    received: 0, published: 0, latencyMs: [], captures: 0, captureFaults: 0, captureConflicts: 0,
    screenCalibrations: 0, storeCommits: 0, skippedCommits: 0, notReady: 0, captureIntervalMaxMs: 0, captureAt: [], faults: {},
  };

  constructor(private readonly runtime: PipeHistoryRuntime, private readonly options: PipeHistoryPaneOptions) {
    this.paneKey = { ...options.paneKey };
    this.session = options.session;
    this.meta = options.meta;
    const now = runtime.now;
    this.watchdog = new HistoryWatchdog(now, fault => this.onRuntimeFault(fault.kind, 'watchdog', null));
    this.collector = new PipeHistoryCollector({
      paneKey: this.paneKey,
      sourceEpoch: options.sourceEpoch ?? 1,
      scrollOnClear: options.scrollOnClear,
      cols: options.meta.cols, rows: options.meta.rows,
      assets: runtime.options.assets, python: runtime.options.python, pool: runtime.parserPool,
      nowNs: runtime.nowNs, now,
      latencySampleLimit: 0,
      ports: {
        onScroll: event => this.onScroll(event),
        onFrame: event => this.onFrame(event),
        onFault: event => this.onCollectorFault(event),
      },
    });
    this.calibrator = options.calibrate === false ? null : new HistoryCalibrator(this.paneKey, {
      now,
      schedule: () => runtime.arm(),
      capture: (_key, tail, signal) => this.capture(tail ?? 0, signal ?? new AbortController().signal),
      read: () => this.read(),
      calibrate: input => this.commitCalibration(input),
      publish: (commit, frame) => this.publishCapture(commit, frame),
      fault: issue => this.onRuntimeFault(issue.kind, 'calibrator', null),
    }, {
      incremental: options.incremental ?? true,
      historyLimit: options.historyLimit,
      certifiedStyleMask: OBSERVED_STYLE_MASK,
    });
  }

  async start(): Promise<void> {
    await this.collector.start();
  }

  // ── bytes in ──
  /** Raw pipe bytes; false means wait for drained() before reading more. */
  ingest(bytes: Uint8Array): boolean {
    const at = this.runtime.nowNs();
    const seq = ++this.received;
    this.stats.received = seq;
    const head = this.receiveTimes[this.receiveHead];
    if (head && at - head.at > RECEIVE_MAX_AGE_NS) this.expireReceipts(at);
    if (this.receiveTimes.length - this.receiveHead < RECEIVE_MAX_PENDING) this.receiveTimes.push({ seq, at });
    else this.bump('receipt-ring-full');
    this.watchdog.receive(seq);
    return this.collector.ingest(bytes, at);
  }
  drained(): Promise<void> { return this.collector.drained(); }
  receiveCounter(): number { return this.received; }

  /**
   * Attach mid-stream only: give a fresh parser the screen tmux shows now,
   * once, BEFORE the first pipe byte. Without it the parser starts blank and
   * every pipe frame would redraw a mostly empty screen over the real one.
   * This is not calibration: calibration captures are never fed to the
   * parser; a seed after any pipe byte is refused. Output between this
   * capture and the pipe start is not journaled (the host marks it).
   */
  seed(raw: string, meta: PaneTmuxMeta): void {
    if (this.received > 0) throw new Error('seed after pipe bytes');
    this.armSeedGap(meta);
    this.ingest(seedBytes(raw, meta));
  }
  /**
   * The same seed for a pipe the host restarts in a new source epoch (after a
   * storage pause): the caller has already called beginSourceEpoch, so the
   * reset parser receives tmux's current screen before the first pipe byte.
   */
  reseed(raw: string, meta: PaneTmuxMeta): void {
    this.armSeedGap(meta);
    this.ingest(seedBytes(raw, meta));
  }

  /**
   * Output between the seed capture and the pipe start is never journaled.
   * On a normal screen the seed's rows above the cursor are complete and
   * scroll first; the first pipe byte lands on the cursor row. So the unknown
   * run sits exactly `cursor.y` rows after the pane's next line id at seed
   * time: the marker is placed there, just before that row is offered, not at
   * the seed's first row (where it would sit before rows that were kept).
   */
  private armSeedGap(meta: PaneTmuxMeta): void {
    const rows = meta.alternate ? 0 : clampCursor(meta.cursor, meta.cols, meta.rows).y;
    this.seedGap = rows > 0 ? { base: this.tokenOrNull()?.nextLineId ?? 0, rows, seen: 0 } : null;
  }
  private recordSeedGap(gap: { base: number; rows: number }, event: PipeScrollEvent): void {
    const reason = 'output between the seed capture and the pipe start is not journaled';
    this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: 'seed-gap', at: this.runtime.now(), message: reason, missingCount: null });
    const token = this.tokenOrNull();
    if (!token) return;
    this.runtime.store.recordIssue({
      paneKey: this.paneKey, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration,
      expectedRevision: token.revision, kind: 'seed-gap', reason, missingCount: null,
      boundaryLineId: gap.base + gap.rows, recoverable: true,
    }).then(receipt => this.notify({ source: 'issue', revision: receipt.revision }), () => { this.bump('seed-gap-unrecorded'); });
  }

  // ── collector ports ──
  private onScroll(event: PipeScrollEvent): unknown {
    const cells = parserRowCells(event.physicalRow);
    // The worker stamps a scrolled row with the seq of the chunk that last
    // wrote it; a never-written blank row gets the seq of the chunk that
    // scrolled it. Rows therefore leave in order but their seqs can go
    // backwards (a blank row at 75, then a row written at 53), while the store
    // requires a non-decreasing receiveSeq per epoch (`stale-receive-seq`,
    // which the collector treats as a broken parser). Offer the running max:
    // the row order is the worker's, the seq only never goes back.
    if (event.sourceEpoch !== this.scrollSeqEpoch) { this.scrollSeqEpoch = event.sourceEpoch; this.scrollSeq = 0; }
    const receiveSeq = Math.max(this.scrollSeq, event.receiveSeq);
    this.scrollSeq = receiveSeq;
    const gap = this.seedGap;
    if (gap && gap.seen >= gap.rows) { this.seedGap = null; this.recordSeedGap(gap, event); }
    const answer = this.runtime.store.appendScroll({
      paneKey: this.paneKey, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration,
      physicalRow: toPhysicalRow(cells), softWrap: event.softWrap, receiveSeq,
    });
    // A row refused for pressure is offered again: count each seeded row once.
    if (this.seedGap && !refusedAlready(answer)) this.seedGap.seen++;
    // Observe the receipt without replacing it: the collector still reads the
    // store's own promise for pressure / oversize decisions.
    answer.then(receipt => {
      if (isProjectionRefusal(receipt)) return;
      this.remember({ lineId: receipt.nextLineId - 1, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration, cells, softWrap: false });
      this.calibrator?.scroll(1);
    }, () => {});
    return answer;
  }

  private remember(row: HistoryRow): void {
    this.ring.push(Object.freeze({ ...row, ansiCache: {} }));
    const limit = this.runtime.options.ringRows ?? RING_ROWS;
    // Evict into a new array, never in place: a calibration snapshot taken
    // earlier (read()) is this array plus its length at that moment.
    if (this.ring.length > limit + 512) {
      this.ring = this.ring.slice(this.ring.length - limit);
      allocations.ringArrayCopies++;
      this.pruneCertified();
    }
  }

  /**
   * Certified ids live as long as their rows are in the ring (NEWARCH2 M3).
   * The matcher only ever checks rows of a ring snapshot, and a snapshot is
   * read after the last commit, so it never holds a row below today's floor:
   * an id under it can never be filtered again. Before, ids stayed until the
   * set passed 20,000 per pane.
   */
  private pruneCertified(): void {
    const floor = this.ring[0]?.lineId;
    if (floor === undefined) return;
    for (const id of this.certified) if (id < floor) this.certified.delete(id);
  }

  /**
   * The adapter is the frame consumer (I1 m1): it applies each delta to its
   * own parser screen atomically and answers "accepted" at once. The store
   * receives the newest full screen at most every FRAME_WRITE_MS per pane
   * (leading edge immediately): every frame is a full replacement of the
   * previous one, so an intermediate screen the store never saw loses
   * nothing, and one store transaction per parser update was the largest
   * main-thread cost at 21 panes. Viewers see a frame once its RAM receipt
   * exists (FIX1 §4: publish after RAM commit).
   */
  private onFrame(event: PipeFrameEvent): unknown {
    const previous = this.screens[event.kind];
    const { screen, complete } = applyFrameDelta(previous, event.cells);
    const cursor = clampCursor(event.cursor, screen.cols, screen.rows);
    this.screens[event.kind] = screen;
    this.parserKind = event.kind;
    this.parserCursor = cursor;
    if (!complete) this.collector.requestFullFrame();
    this.pendingFrame = {
      paneKey: this.paneKey, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration,
      receiveSeq: event.receiveSeq, cells: screen.cells, kind: event.kind, cols: screen.cols, rows: screen.rows,
      cursor: { row: cursor.y, col: cursor.x, visible: cursor.visible },
    };
    this.calibrator?.output();
    this.scheduleFrameWrite();
    return undefined;
  }

  private scheduleFrameWrite(): void {
    if (this.frameTimer || this.frameWriting || !this.pendingFrame || this.closed) return;
    const spacing = this.runtime.frameBudget.busy() ? FRAME_WRITE_MS : 0;
    const wait = Math.max(this.lastFrameWriteAt + spacing, this.frameBackoffUntil) - this.runtime.now();
    if (wait <= 0) { this.writeFrame(); return; }
    this.frameTimer = setTimeout(() => { this.frameTimer = null; this.writeFrame(); }, wait);
  }

  private writeFrame(): void {
    const frame = this.pendingFrame;
    if (!frame || this.closed) return;
    this.pendingFrame = null;
    this.frameWriting = true;
    this.lastFrameWriteAt = this.runtime.now();
    const budget = this.runtime.frameBudget;
    const started = performance.now();
    const written = this.runtime.store.replaceScreen(frame);
    budget.spend(performance.now() - started);
    written.then((receipt: ProjectionAdmission) => {
      if (isProjectionRefusal(receipt)) {
        // Pressure: keep the newest screen and offer it again shortly. The
        // refusal is already settled, so an immediate re-offer would spin a
        // promise chain that starves every timer while storage is paused.
        this.pendingFrame ??= frame;
        this.frameBackoffUntil = this.runtime.now() + FRAME_PRESSURE_RETRY_MS;
        this.bump('frame-pressure');
        return;
      }
      this.frameBackoffUntil = 0;
      if (this.pendingIssues.length) {
        for (const issue of this.pendingIssues.splice(0)) this.recordIssue(issue.kind, issue.reason, issue.missingCount, issue.recoverable);
      }
      if (!this.calibrator || this.calibrator.acceptsPipeFrame) {
        const published = performance.now();
        this.publishPipe(frame, receipt);
        budget.spend(performance.now() - published);
      } else this.pendingPublish = { frame, receipt };
    }, (error: unknown) => {
      // Oversize or a closing store: the store records its own issue; the
      // next parser frame supersedes this one.
      this.onRuntimeFault('frame-write-failed', String((error as Error)?.message ?? error), null);
    }).finally(() => {
      this.frameWriting = false;
      this.scheduleFrameWrite();
    });
  }

  private publishPipe(frame: ProjectionFrame, receipt: ProjectionReceipt): void {
    this.pendingPublish = null;
    // The parser never pulls history back onto its screen (pipe-vt-worker reflow).
    this.displayed = {
      cells: frame.cells as HistoryCell[][], kind: frame.kind, cols: frame.cols, rows: frame.rows, source: 'pipe',
      cursor: frame.cursor ? { x: frame.cursor.col, y: frame.cursor.row, visible: frame.cursor.visible } : null,
      pulledBack: null,
    };
    this.settleReceipts(frame.receiveSeq);
    this.notify({ source: 'pipe', revision: receipt.revision });
  }

  /** Close the latency entry of every received chunk up to `receiveSeq`: the viewer now sees it. */
  private settleReceipts(receiveSeq: number): void {
    const now = this.runtime.nowNs();
    while (this.receiveHead < this.receiveTimes.length && this.receiveTimes[this.receiveHead]!.seq <= receiveSeq) {
      const entry = this.receiveTimes[this.receiveHead++]!;
      this.sampleLatency(Number(now - entry.at) / 1e6);
    }
    this.compactReceipts();
  }

  /** Close entries older than RECEIVE_MAX_AGE_NS: their age so far is recorded, never dropped silently. */
  private expireReceipts(now: bigint): void {
    while (this.receiveHead < this.receiveTimes.length && now - this.receiveTimes[this.receiveHead]!.at > RECEIVE_MAX_AGE_NS) {
      const entry = this.receiveTimes[this.receiveHead++]!;
      this.sampleLatency(Number(now - entry.at) / 1e6);
      this.bump('receipt-expired');
    }
    this.compactReceipts();
  }

  private compactReceipts(): void {
    if (this.receiveHead > 4096 && this.receiveHead * 2 > this.receiveTimes.length) {
      this.receiveTimes.splice(0, this.receiveHead);
      this.receiveHead = 0;
    }
  }

  private sampleLatency(ms: number): void {
    const limit = this.runtime.options.latencySampleLimit ?? STATS_MAX_SAMPLES;
    if (limit <= 0) return;
    const samples = this.stats.latencyMs, at = this.runtime.now();
    // The host resets the array between measurement windows.
    if (samples !== this.latencyRef) { this.latencyRef = samples; this.latencyAt = samples.map(() => at); }
    samples.push(ms);
    this.latencyAt.push(at);
    trimStatsRing(samples, this.latencyAt, limit, at - STATS_MAX_AGE_MS);
  }

  /** Received chunks whose latency entry is still open (not yet on a published screen). */
  pendingReceipts(): number { return this.receiveTimes.length - this.receiveHead; }

  private onCollectorFault(event: PipeFaultEvent): void {
    const count = event.lostRows === 'unknown' ? null : typeof event.lostRows === 'number' ? event.lostRows : null;
    switch (event.kind) {
      case 'consumer-pressure':
      case 'consumer-pressure-cleared':
        this.bump(event.kind);
        return;
      case 'consumer-oversize':
        // The store already recorded its own ingest-oversize issue for this event.
        this.bump(event.kind);
        this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: event.kind, at: event.at, message: event.message, missingCount: count });
        return;
      case 'worker-restarted':
      case 'source-reset':
        // The next event of the new epoch makes the store insert its own gap
        // marker; recapture now so the screen follows tmux, not an empty parser.
        this.bump(event.kind);
        this.screens = {};
        // A reseed arms its own gap after this reset; a parser restart loses the seeded screen.
        if (event.kind === 'worker-restarted') this.seedGap = null;
        this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind: event.kind, at: event.at, message: event.message, missingCount: null, receiveSeqFrom: event.receiveSeqFrom, receiveSeqTo: event.receiveSeqTo });
        this.calibrator?.event('fault');
        return;
      case 'history-cleared':
        this.calibrator?.event('clear');
        break;
      default:
        break;
    }
    if (event.kind === 'worker-exit' || event.kind === 'spawn') this.watchdog.dead('worker-dead');
    this.onRuntimeFault(event.kind, event.message ?? 'collector fault', count, event.receiveSeqFrom, event.receiveSeqTo);
  }

  /** Every fault goes to the host sink; a pane-level marker goes to the journal. */
  private onRuntimeFault(kind: string, message: string, missingCount: number | null, receiveSeqFrom?: number, receiveSeqTo?: number): void {
    this.bump(kind);
    if (kind === 'capture-fault') this.stats.captureFaults++;
    this.runtime.emit({ paneKey: this.paneKey, session: this.session, kind, at: this.runtime.now(), message, missingCount, receiveSeqFrom, receiveSeqTo });
    // A capture that timed out is a scheduling fault, not a loss: no journal marker.
    if (kind === 'capture-fault') return;
    this.recordIssue(kind, message, missingCount);
  }

  recordIssue(kind: string, reason: string, missingCount: number | null, recoverable = true): void {
    const token = this.tokenOrNull();
    if (!token) {
      // The store knows a pane from its first event; hold the marker until then.
      if (this.pendingIssues.length < 64) this.pendingIssues.push({ kind, reason, missingCount, recoverable });
      return;
    }
    this.runtime.store.recordIssue({
      paneKey: this.paneKey, sourceEpoch: token.sourceEpoch, geometryGeneration: token.geometryGeneration,
      expectedRevision: token.revision, kind, reason, missingCount, boundaryLineId: token.nextLineId, recoverable,
    }).then(receipt => this.notify({ source: 'issue', revision: receipt.revision }), () => { /* store sent it to its own fault sink */ });
  }

  private bump(kind: string): void {
    this.stats.faults[kind] = (this.stats.faults[kind] ?? 0) + 1;
  }

  // ── host observation (history owner) ──
  /**
   * Metadata the host read from tmux. The pane follows geometry changes,
   * rotates its source epoch when tmux restarted the pane process (the
   * terminal was re-initialised under the parser), and marks an external
   * clear-history. Only observable events are handled: `send-keys -R` leaves
   * no trace in this metadata (D35 debt).
   */
  observe(meta: PaneTmuxMeta): void {
    if (this.closed) return;
    const previous = this.meta;
    this.meta = meta;
    if (meta.panePid !== previous.panePid && previous.panePid > 0) {
      this.collector.beginSourceEpoch(this.collector.currentSourceEpoch() + 1);
      this.recordIssue('respawn-observed', `pane process ${previous.panePid} -> ${meta.panePid}; parser reset, rows in flight unknown`, null);
    }
    if (meta.cols !== previous.cols || meta.rows !== previous.rows) {
      this.collector.resize(meta.cols, meta.rows);
      this.calibrator?.event('resize');
    }
    if (!historySizeReadable(meta)) {
      // No number from tmux: nothing is hidden (never a guess from text) and the viewer is told.
      this.pulled = { rows: 0, endLine: 0 };
      if (!this.historySizeUnknown) {
        this.historySizeUnknown = true;
        this.recordIssue('history-size-unknown', 'tmux history_size unreadable; rows tmux pulled back on resize cannot be told apart and may show twice', null);
      }
      return;
    }
    this.historySizeUnknown = false;
    if (!historySizeReadable(previous)) return;
    const pull = resizePullback(previous, meta);
    if (pull > 0) {
      if (this.pulled.rows === 0) this.pulled = { rows: 0, endLine: this.tokenOrNull()?.nextLineId ?? 0 };
      this.pulled = { rows: Math.min(meta.rows, this.pulled.rows + pull), endLine: this.pulled.endLine };
    } else if (meta.historySize > previous.historySize && this.pulled.rows > 0) {
      // tmux scrolls the pulled-back rows (the top of its screen) into history first.
      this.pulled = { rows: Math.max(0, this.pulled.rows - (meta.historySize - previous.historySize)), endLine: this.pulled.endLine };
    }
    if (this.pulled.rows > meta.rows) this.pulled = { rows: meta.rows, endLine: this.pulled.endLine };
    const trimmed = previous.historySize >= previous.historyLimit * 0.9 && meta.historySize >= previous.historyLimit * 0.8;
    if (meta.historySize + pull < previous.historySize && !trimmed) {
      this.recordIssue('history-cleared-external', `tmux history ${previous.historySize} -> ${meta.historySize} rows; older rows stay in the journal, tmux can no longer certify them`, null);
      this.calibrator?.event('clear');
    }
  }
  currentMeta(): PaneTmuxMeta { return this.meta; }

  // ── calibrator ports ──
  private tokenOrNull(): ProjectionToken | null {
    try { return this.runtime.store.token(this.paneKey); } catch { return null; }
  }
  private read() {
    const token = this.tokenOrNull();
    const screen = this.screens[this.parserKind];
    const parserFrame: CalibrationFrame = {
      cells: screen?.cells ?? [], cursor: screen ? this.parserCursor : null, kind: this.parserKind,
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      // I1 m4: the RECEIVE counter; bytes still inside the parser count as "not quiet".
      receiveSeq: this.received,
    };
    // The ring as of now without copying it: rows are only appended to this
    // array (eviction and repair replace it, rows are frozen), so its first
    // `length` rows stay exactly what they are now. The copy is made on first use; the calibrator reads
    // it only for a matched history capture (3 full copies per capture before,
    // O(4,500) each, on the frame thread).
    const ring = this.ring, length = ring.length;
    let copy: RingRow[] | null = null;
    return {
      revision: token?.revision ?? 0,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      recentLastLineId: length ? ring[length - 1]!.lineId : null,
      get recentHistory(): RingRow[] { return copy ??= ring.slice(0, length); },
      parserFrame,
    };
  }

  private metadata(meta: PaneTmuxMeta, epoch: { sourceEpoch: number; geometryGeneration: number }): CaptureMetadata {
    return {
      historyEpoch: epoch.sourceEpoch, sourceEpoch: epoch.sourceEpoch, geometryGeneration: epoch.geometryGeneration,
      cols: meta.cols, rows: meta.rows, kind: meta.alternate ? 'alternate' : 'normal',
      cursor: clampCursor(meta.cursor, meta.cols, meta.rows),
    };
  }

  private async capture(tail: number, signal: AbortSignal): Promise<CalibrationCapture> {
    const epochOf = () => { const r = this.read(); return { sourceEpoch: r.sourceEpoch, geometryGeneration: r.geometryGeneration }; };
    const before = epochOf();
    const raw = await this.options.capture(tail, signal);
    const after = epochOf();
    this.observe(raw.after);
    this.capturedPull = !raw.after.alternate && this.pulled.rows > 0 ? { ...this.pulled } : null;
    const cols = raw.after.cols;
    if (!this.decoder || this.decoder.cols !== cols) this.decoder = canonicalCaptureDecoder(cols);
    const rows = decodeCanonicalCapture(this.decoder, raw.body);
    const uncertain = this.decoder.uncertainRows;
    const screenRows = rows.slice(Math.max(0, rows.length - raw.after.rows));
    const history: CapturedRow[] = rows.slice(0, rows.length - screenRows.length).map(cells => ({ cells, softWrap: false }));
    const metaAfter = this.metadata(raw.after, after);
    return {
      paneKey: this.paneKey, captureId: raw.captureId, requestedAt: raw.requestedAt, completedAt: raw.completedAt,
      before: this.metadata(raw.before, before), after: metaAfter,
      frame: { cells: screenRows, cursor: metaAfter.cursor, kind: metaAfter.kind, geometryGeneration: after.geometryGeneration, receiveSeq: -1 },
      history,
      completeRetainedTail: tail > 0 && (history.length < tail || tail >= 4500),
      observedFields: [...TMUX_OBSERVED_FIELDS],
      uncertainHistoryRows: uncertain.filter(y => y < history.length),
      uncertainScreenRows: uncertain.filter(y => y >= history.length).map(y => y - history.length),
    };
  }

  private async commitCalibration(input: {
    capture: CalibrationCapture; checks: RowMatch['checks']; contentMatches: RowMatch['contentMatches'];
    repairs: RowMatch['repairs']; expectedRevision: number; captureEvidence: CaptureEvidence;
  }) {
    const c = input.capture;
    const meta = c.after;
    // FIX1 §3.2: while storage is paused nothing is journaled, a calibration
    // included; the host re-calibrates after recovery (not ready, recapture).
    if (this.overlay) { this.stats.notReady++; return null; }
    // The store knows a pane from its first event. A capture that lands before
    // it (the calibrator captures at birth) has nothing to commit against:
    // not ready, like a CAS conflict (recapture), never a capture fault.
    if (!this.tokenOrNull()) { this.stats.notReady++; return null; }
    // Commit budget (see PipeHistoryPaneOptions.commitIntervalMs). The store
    // journals every committed capture in full, so a transaction is written
    // only when it changes something a viewer or an audit can observe: a
    // repair, a quiescent screen that differs from the one displayed, or a
    // batch of rows not yet certified. Uncertified rows wait at most
    // `commitIntervalMs` or 64 rows, which the matcher's 128-row overlap
    // re-matches, so a skipped capture never costs a row its certification.
    const fresh = [...input.checks, ...input.contentMatches].filter(m => !this.certified.has(m.lineId));
    const screenChanged = input.captureEvidence.kind === 'quiescent'
      && (this.displayed?.source !== 'tmux-calibrated' || !sameScreen(this.displayed.cells, c.frame.cells as HistoryCell[][], this.displayed.cursor, c.frame.cursor));
    const due = this.runtime.now() - this.lastStoreCommitAt >= (this.options.commitIntervalMs ?? 1000);
    if (!input.repairs.length && !screenChanged && (fresh.length === 0 || (!due && fresh.length < 64))) {
      const token = this.tokenOrNull();
      if (token) {
        this.stats.skippedCommits++;
        this.countCapture();
        this.skippedCommit = true;
        return { revision: token.revision, durableRevision: token.durableRevision, nextLineId: token.nextLineId };
      }
    }
    this.skippedCommit = false;
    // A row a committed capture already certified is not journaled again;
    // only the captured rows this transaction maps are stored with it.
    const checks = input.checks.filter(m => !this.certified.has(m.lineId));
    const contentMatches = input.contentMatches.filter(m => !this.certified.has(m.lineId));
    const used = [...new Set([...checks, ...contentMatches, ...input.repairs].map(m => m.capturedRow))].sort((a, b) => a - b);
    const index = new Map(used.map((row, i) => [row, i]));
    const mapRow = (row: number) => index.get(row)!;
    const projected = {
      paneKey: this.paneKey, sourceEpoch: meta.sourceEpoch, geometryGeneration: meta.geometryGeneration, receiveSeq: 0,
      cells: c.frame.cells as HistoryCell[][], kind: meta.kind, cols: meta.cols, rows: meta.rows,
      cursor: meta.cursor ? { row: meta.cursor.y, col: meta.cursor.x, visible: meta.cursor.visible } : null,
      captureId: c.captureId, requestedAt: c.requestedAt, completedAt: c.completedAt,
      firstHistoryRow: used[0] ?? 0, history: used.map(row => toPhysicalRow(c.history[row]!.cells)),
      observedFields: [...c.observedFields], ambiguousRows: (c.uncertainHistoryRows?.length ?? 0) + (c.uncertainScreenRows?.length ?? 0),
      result: input.captureEvidence.kind,
    };
    try {
      const receipt = await this.runtime.store.calibrate({
        capture: projected, expectedRevision: input.expectedRevision, captureEvidence: input.captureEvidence,
        checks: checks.map(m => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow) })),
        contentMatches: contentMatches.map(m => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow) })),
        repairs: input.repairs.map(m => ({ lineId: m.lineId, captureRow: mapRow(m.capturedRow), physicalRow: toPhysicalRow(m.row.cells) })),
      });
      this.countCapture();
      this.lastStoreCommitAt = this.runtime.now();
      this.stats.storeCommits++;
      // A row evicted while the store committed is below the floor: not kept (see pruneCertified).
      const floor = this.ring[0]?.lineId ?? 0;
      for (const m of [...checks, ...contentMatches, ...input.repairs]) if (m.lineId >= floor) this.certified.add(m.lineId);
      if (input.repairs.length) {
        // Copy on write: a snapshot read() handed out earlier keeps its rows.
        const byId = new Map(input.repairs.map(r => [r.lineId, r.row.cells]));
        this.ring = this.ring.map(row => {
          const cells = byId.get(row.lineId);
          return cells ? Object.freeze({ ...row, cells, ansiCache: {} }) : row;
        });
        allocations.ringArrayCopies++;
        this.ringRepairs++;
      }
      return receipt;
    } catch (error) {
      // PLAN §3 read/CAS: the only CAS conflict is 'stale-revision' -> null.
      if (String((error as Error)?.message ?? error).includes('stale-revision')) {
        this.stats.captureConflicts++;
        return null;
      }
      throw error;
    }
  }

  private countCapture(): void {
    const at = this.runtime.now();
    if (this.lastCaptureAt !== null) this.stats.captureIntervalMaxMs = Math.max(this.stats.captureIntervalMaxMs, at - this.lastCaptureAt);
    this.lastCaptureAt = at;
    this.stats.captures++;
    this.stats.captureAt.push(at);
    trimStatsRing(this.stats.captureAt, this.stats.captureAt, STATS_MAX_SAMPLES, at - STATS_MAX_AGE_MS);
  }

  private publishCapture(commit: { revision: number }, frame: CalibrationFrame): void {
    const cells = frame.cells as HistoryCell[][];
    // The calibrator publishes only when nothing was received after the
    // capture's fence: the screen shown covers every received chunk.
    this.settleReceipts(this.received);
    // A skipped commit only confirmed what is already displayed.
    if (this.skippedCommit) { this.skippedCommit = false; return; }
    this.displayed = {
      cells, cursor: frame.cursor, kind: frame.kind, cols: cells[0]?.length ?? this.meta.cols, rows: cells.length,
      source: 'tmux-calibrated', pulledBack: frame.kind === 'normal' ? this.capturedPull : null,
    };
    this.pendingPublish = null;
    this.stats.screenCalibrations++;
    this.watchdog.capture(cells.map(rowText).join('\n'), { sourceEpoch: this.read().sourceEpoch, geometryGeneration: frame.geometryGeneration, kind: frame.kind });
    this.notify({ source: 'tmux-calibrated', revision: commit.revision });
  }

  /** Runtime tick: flush a pipe frame held while the calibrator was latched. */
  tick(): void {
    if (this.pendingPublish && this.calibrator?.acceptsPipeFrame) {
      const { frame, receipt } = this.pendingPublish;
      this.publishPipe(frame, receipt);
    }
    this.watchdog.tick();
  }

  // ── viewers ──
  setViewers(count: number): void { this.calibrator?.setViewers(count); }

  subscribe(listener: (update: PaneUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(update: PaneUpdate): void {
    this.stats.published++;
    for (const listener of [...this.listeners]) {
      try { listener(update); } catch (error) { console.error('[pipe-history-runtime] listener failed:', error); }
    }
  }

  health(health?: ProjectionHealth): { degraded: boolean; issues: ProjectionIssue[] } {
    if (!health && this.runtime.store.paneHealth) {
      const own = this.runtime.store.paneHealth(this.paneKey);
      return { degraded: own?.status === 'degraded', issues: own?.issues ?? [] };
    }
    const state = (health ?? this.runtime.store.health()).panes.find(p => p.paneKey.serverIdentity === this.paneKey.serverIdentity
      && p.paneKey.paneId === this.paneKey.paneId && p.paneKey.birthGeneration === this.paneKey.birthGeneration);
    return { degraded: state?.status === 'degraded', issues: state?.issues ?? [] };
  }

  /**
   * FIX1 §3.2 (7): show (or clear) the storage-fault gap marker. It is part of
   * every view and page until cleared, independent of the store, and its
   * revision is the pane revision it was raised at, so a later durable marker
   * always moves metadataRevision forward.
   */
  setStorageOverlay(marker: StorageOverlay | null): void {
    if (!marker) {
      if (!this.overlay) return;
      this.overlay = null;
    } else {
      const token = this.tokenOrNull();
      this.overlay = {
        issueId: `storage-overlay:${marker.eventId}`, sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
        revision: token?.revision ?? 0, boundaryLineId: marker.boundaryLineId, kind: marker.kind, reason: marker.reason,
        missingCount: null, detectedAt: marker.detectedAt, resolvedAt: null,
      };
    }
    this.notify({ source: 'issue', revision: this.tokenOrNull()?.revision ?? 0 });
  }
  storageOverlay(): ProjectionIssue | null { return this.overlay; }

  /**
   * While storage is paused the pipe is stopped, so the screen would freeze on
   * the last journaled frame. The host shows what tmux shows instead: decoded
   * like a calibration capture, published, never stored and never certified.
   */
  showUnstored(raw: RawPaneCapture): void {
    if (this.closed || !this.overlay) return;
    const cols = raw.after.cols;
    if (!this.decoder || this.decoder.cols !== cols) this.decoder = canonicalCaptureDecoder(cols);
    const rows = decodeCanonicalCapture(this.decoder, raw.body);
    const cells = rows.slice(Math.max(0, rows.length - raw.after.rows));
    const cursor = clampCursor(raw.after.cursor, cols, raw.after.rows);
    this.observe(raw.after);
    this.displayed = { cells, cursor, kind: raw.after.alternate ? 'alternate' : 'normal', cols, rows: cells.length, source: 'tmux-calibrated', pulledBack: null };
    this.notify({ source: 'tmux-calibrated', revision: this.tokenOrNull()?.revision ?? 0 });
  }

  view(health?: ProjectionHealth): PaneView {
    const token = this.tokenOrNull();
    const shown = this.displayed;
    const own = token ? this.health(health) : { degraded: false, issues: [] };
    const degraded = own.degraded || this.overlay !== null;
    const issues = this.overlay ? [...own.issues, this.overlay] : own.issues;
    return {
      paneKey: this.paneKey, session: this.session,
      cells: shown?.cells ?? [], cursor: shown?.cursor ?? null, kind: shown?.kind ?? 'normal',
      cols: shown?.cols ?? this.meta.cols, rows: shown?.rows ?? this.meta.rows,
      displaySource: shown?.source ?? 'none', token,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      mouseSgr: this.meta.mouseSgr, mouseAny: this.meta.mouseAny, degraded, issues,
      pulledBack: shown?.pulledBack ?? null,
    };
  }

  /** Accepted history rows still in RAM, oldest first (frozen; their ANSI text is cached by row). */
  recentRows(): readonly RingRow[] { return this.ring; }

  /**
   * What this pane holds in RAM, in CACHE_BYTE_MODEL bytes (NEWARCH2 M3). A row
   * array shared by several rows (blank rows, repaired rows) is counted once.
   * Diagnostic: walks the ring, never called on the frame path.
   */
  memoryStats(): PaneMemoryStats {
    const m = CACHE_BYTE_MODEL;
    const arrays = new Set<readonly HistoryCell[]>();
    let cellSlots = 0, sharedRows = 0, ansiChars = 0, ansiRows = 0;
    for (const row of this.ring) {
      const ansi = row.ansiCache.text;
      if (ansi !== undefined) { ansiRows++; ansiChars += ansi.length; }
      if (arrays.has(row.cells)) { sharedRows++; continue; }
      arrays.add(row.cells);
      cellSlots += row.cells.length;
    }
    const rows = this.ring.length;
    const ring = {
      rows, rowArrays: arrays.size, sharedRows, cellSlots, ansiRows, ansiChars, floor: this.ring[0]?.lineId ?? null,
      // One row plus its cache object and cache reference, even before encoding.
      bytes: m.arrayHeader + rows * (2 * m.slot + 2 * m.object) + arrays.size * m.arrayHeader + cellSlots * m.slot
        + ansiRows * m.stringHeader + ansiChars * m.char,
    };
    const certified = { ids: this.certified.size, bytes: this.certified.size * m.setEntry };
    const decoder = this.decoder ? this.decoder.stats() : null;
    return { ring, certified, decoder, bytes: ring.bytes + certified.bytes + (decoder?.bytes ?? 0) };
  }

  /** Forward page read (L1 contract) at one token; retried while the revision moves. */
  readRange(start: number, end: number): { lines: string[]; startLine: number; issues: ProjectionIssue[]; token: ProjectionToken } | null {
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = this.tokenOrNull();
      if (!token) return null;
      const stop = Math.min(end, token.nextLineId);
      const from = Math.max(0, Math.min(start, stop));
      const lines: string[] = [];
      let issues: ProjectionIssue[] = [];
      try {
        for (let at = from; at < stop;) {
          const page: ProjectionPage = this.runtime.store.readPage(token, at, Math.min(2000, stop - at));
          for (const line of page.lines) lines.push(cellsToAnsi(line.cells as HistoryCell[]));
          issues = page.issues;
          at = page.nextAnchor;
          if (page.lines.length === 0) break;
        }
        if (this.overlay) issues = [...issues, this.overlay];
        return { lines, startLine: from, token, issues: issues.filter(i => i.boundaryLineId !== null && i.boundaryLineId >= from && i.boundaryLineId <= stop) };
      } catch (error) {
        if (!String((error as Error)?.message).includes('page-retry')) throw error;
      }
    }
    return null;
  }

  /**
   * FIX1 §3.2 Q→H: the consumer fence a pipe stop waits for after FIFO EOF.
   * Every admitted chunk acknowledged by the parser, the newest screen handed
   * to the store, then the store's durable barrier at that revision. A parser
   * ACK is never reported as a DB commit: `durableRevision` is what the store
   * confirmed on disk, and anything short of that inside `timeoutMs` is an
   * unknown tail with the fence that did not close.
   */
  async drainReceipt(timeoutMs = 5_000): Promise<{
    lastAdmittedSequence: number | null; lastAckedSequence: number | null;
    ramRevision: number | null; durableRevision: number | null; issues: string[]; unknownTail: boolean;
  }> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const issues: string[] = [];
    const settled = () => {
      const stats = this.collector.stats();
      return stats.ackedSeq >= stats.receiveSeq && stats.inflightBytes === 0 && !this.frameWriting && !this.pendingFrame;
    };
    while (!settled() && Date.now() < deadline && !this.closed) {
      if (this.pendingFrame && !this.frameWriting && !this.frameTimer) this.writeFrame();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const stats = this.collector.stats();
    if (!settled()) issues.push(`consumer not settled within ${timeoutMs}ms: acked ${stats.ackedSeq} of ${stats.receiveSeq}, ${stats.inflightBytes} inflight bytes${this.pendingFrame || this.frameWriting ? ', newest screen not written' : ''}`);
    const token = this.tokenOrNull();
    let durableRevision: number | null = null;
    if (token) {
      const left = Math.max(0, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const receipt = await Promise.race([
          this.runtime.store.durable(this.paneKey, token.revision),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), left); }),
        ]);
        if (receipt) durableRevision = receipt.durableRevision;
        else issues.push(`store durable barrier at revision ${token.revision} did not settle within ${timeoutMs}ms`);
      } catch (error) {
        issues.push(`store durable barrier failed: ${String((error as Error)?.message ?? error)}`);
      } finally { if (timer) clearTimeout(timer); }
    } else if (stats.receiveSeq > 0) issues.push('store holds no token for this pane');
    return {
      lastAdmittedSequence: stats.receiveSeq, lastAckedSequence: stats.ackedSeq,
      ramRevision: token?.revision ?? null, durableRevision,
      issues, unknownTail: issues.length > 0,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.collector.close();
    // The newest parser screen still reaches the store before the pane stops.
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    if (this.pendingFrame && !this.frameWriting) this.writeFrame();
    for (let i = 0; i < 100 && this.frameWriting; i++) await new Promise(resolve => setTimeout(resolve, 5));
    this.closed = true;
    this.listeners.clear();
  }
}

// ─── runtime ──────────────────────────────────────────────────────────────

export class PipeHistoryRuntime {
  readonly parserPool: PipeVtPool | undefined;
  readonly store: RuntimeStore;
  readonly now: () => number;
  readonly nowNs: () => bigint;
  /** Main-thread cost of every pane's frame path (see FRAME_BUDGET_SHARE). */
  readonly frameBudget = new FrameBudget();
  private readonly panesByKey = new Map<string, PipeHistoryPane>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private armedAt = Infinity;
  private closed = false;

  constructor(readonly options: PipeHistoryRuntimeOptions) {
    this.parserPool = options.sharedParser === false ? undefined : new PipeVtPool({ assets: options.assets, python: options.python });
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    // Host heartbeat: from this timer, never from a frame callback.
    this.heartbeat = setInterval(() => {
      for (const pane of this.panesByKey.values()) { pane.watchdog.heartbeat(); pane.tick(); }
    }, 250);
    this.heartbeat.unref?.();
  }

  async addPane(options: PipeHistoryPaneOptions): Promise<PipeHistoryPane> {
    if (this.closed) throw new Error('runtime closed');
    const id = keyOf(options.paneKey);
    if (this.panesByKey.has(id)) throw new Error(`pane already owned: ${id}`);
    const pane = new PipeHistoryPane(this, options);
    this.panesByKey.set(id, pane);
    try { await pane.start(); }
    catch (error) { this.panesByKey.delete(id); await pane.close().catch(() => {}); throw error; }
    this.arm();
    return pane;
  }
  pane(key: PaneKey): PipeHistoryPane | undefined { return this.panesByKey.get(keyOf(key)); }
  panes(): PipeHistoryPane[] { return [...this.panesByKey.values()]; }
  async removePane(key: PaneKey): Promise<void> {
    const pane = this.panesByKey.get(keyOf(key));
    if (!pane) return;
    this.panesByKey.delete(keyOf(key));
    await pane.close();
  }

  emit(fault: RuntimeFault): void {
    try { this.options.onFault?.(fault); } catch (error) { console.error('[pipe-history-runtime] fault sink failed:', error); }
  }

  /** One timer for every calibrator deadline (the host's deadline queue). */
  arm(): void {
    if (this.closed) return;
    let due = Infinity;
    for (const pane of this.panesByKey.values()) if (pane.calibrator) due = Math.min(due, pane.calibrator.dueAt);
    if (due === Infinity || due >= this.armedAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.armedAt = due;
    this.timer = setTimeout(() => this.runDue(), Math.max(0, due - this.now()));
  }
  private runDue(): void {
    this.timer = null;
    this.armedAt = Infinity;
    if (this.closed) return;
    const now = this.now();
    for (const pane of this.panesByKey.values()) {
      if (pane.calibrator && pane.calibrator.dueAt <= now) void pane.calibrator.runDue();
    }
    this.arm();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    try { await Promise.all([...this.panesByKey.values()].map(pane => pane.close())); }
    finally { this.panesByKey.clear(); await this.parserPool?.close(); }
  }
}

export const keyOf = (key: PaneKey): string => JSON.stringify([key.serverIdentity, key.paneId, key.birthGeneration]);

export function createPipeHistoryRuntime(options: PipeHistoryRuntimeOptions): PipeHistoryRuntime {
  return new PipeHistoryRuntime(options);
}

/** Pooled percentile over raw samples (never an average of per-pane percentiles). */
export function pooledPercentile(samples: readonly number[], p: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

// ─── mux-facing projection (live window + history pages) ─────────────────

export interface ProjectedPaneSnapshot {
  content: string;
  cursor: { row: number; col: number } | null;
  screen: { alt: boolean; mouseSgr: boolean; mouseAny: boolean };
  boundary: { generation: string; liveStartLine: number; walSequence: string; walOffset: number };
  newarch: {
    v: 'newarch-frame-v1';
    paneKey: PaneKey; sourceEpoch: number; geometryGeneration: number; routeGeneration: number;
    metadataRevision: number;
    cols: number; rows: number; revision: number; durableRevision: number; nextLineId: number; liveStartLine: number;
    displaySource: 'pipe' | 'tmux-calibrated'; degraded: boolean;
    markers: Array<{ lineId: number | null; kind: string; missingCount: number | null }>;
  };
}
export interface ProjectedHistoryPage {
  lines: string[]; startLine: number | null; hasMore: boolean;
  /** Loss / unverified-reset markers whose boundary falls inside this page. */
  markers: Array<{ lineId: number | null; kind: string; reason: string; missingCount: number | null }>;
}

const historySizeReadable = (meta: PaneTmuxMeta) => Number.isSafeInteger(meta.historySize) && meta.historySize >= 0;

/**
 * Rows tmux pulled back from history onto the screen between two metadata
 * reads: `history_size` before minus after, clamped to [0, rows added]. Only
 * tmux's own counters count; content equality is never evidence (a program
 * may print the same row twice). null when either history_size is unreadable.
 */
export function resizePullback(before: Pick<PaneTmuxMeta, 'rows' | 'historySize' | 'alternate'>, after: Pick<PaneTmuxMeta, 'rows' | 'historySize' | 'alternate'>): number {
  if (!historySizeReadable(before as PaneTmuxMeta) || !historySizeReadable(after as PaneTmuxMeta)) return 0;
  // tmux does not pull history into the alternate screen.
  if (before.alternate || after.alternate) return 0;
  const added = after.rows - before.rows;
  if (added <= 0) return 0;
  return Math.max(0, Math.min(added, before.historySize - after.historySize));
}

/**
 * How many of the newest history rows the displayed screen shows again. The
 * number comes from the pane's tmux-counter bookkeeping (resizePullback), and
 * only a tmux-calibrated normal screen can hold such rows.
 */
export function screenOverlap(view: Pick<PaneView, 'displaySource' | 'kind' | 'pulledBack'>): number {
  if (view.displaySource !== 'tmux-calibrated' || view.kind !== 'normal' || !view.pulledBack) return 0;
  return Math.max(0, view.pulledBack.rows);
}

function fnv(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The live window a viewer receives: history rows from `liveStartLine` (held
 * in the pane's RAM ring) followed by the displayed screen. The start only
 * moves forward, and only in whole windows, so between moves every update is
 * an append and the mux sends a small delta. Older rows are served as pages
 * whose line numbers are projection line ids (one token per page).
 */
export class ProjectionLiveWindow {
  private starts = new Map<string, number>();
  /** Per pane: the joined history part of the last live window, extended while only rows are appended. */
  private texts = new Map<string, { firstId: number; lastId: number; count: number; repairs: number; hide: string; text: string }>();
  constructor(private readonly windowRows = 1000) {}

  snapshot(pane: PipeHistoryPane, routeGeneration: number): ProjectedPaneSnapshot | null {
    const view = pane.view();
    if (view.displaySource === 'none' || !view.token || view.cells.length === 0) return null;
    const token = view.token;
    const ring = pane.recentRows();
    const id = keyOf(pane.paneKey);
    const alternate = view.kind === 'alternate';
    // The ring can only serve a contiguous run that reaches the newest row.
    let firstContiguous = token.nextLineId;
    for (let i = ring.length - 1; i >= 0 && ring[i]!.lineId === firstContiguous - 1; i--) firstContiguous = ring[i]!.lineId;
    let start = this.starts.get(id) ?? Math.max(firstContiguous, token.nextLineId - this.windowRows);
    if (alternate) start = token.nextLineId;
    else {
      if (start < firstContiguous) start = firstContiguous;
      if (token.nextLineId - start > 2 * this.windowRows) start = token.nextLineId - this.windowRows;
      if (start > token.nextLineId) start = token.nextLineId;
    }
    this.starts.set(id, start);
    const rows: RingRow[] = [];
    // tmux pulls rows back from history into the screen when a pane grows
    // taller; the journal already holds them as history. Rows the screen
    // shows again are left out of the live window (never out of the journal
    // or its pages), so no row appears twice.
    const overlap = alternate ? 0 : screenOverlap(view);
    if (!alternate) {
      const hideEnd = view.pulledBack?.endLine ?? 0, hideStart = hideEnd - overlap;
      const offset = ring.length - (token.nextLineId - start);
      for (let i = Math.max(0, offset); i < ring.length; i++) {
        const row = ring[i]!;
        if (row.lineId >= hideStart && row.lineId < hideEnd) continue;
        rows.push(row);
      }
    }
    const history = this.historyText(id, rows, pane.ringRepairs, alternate ? '' : `${view.pulledBack?.endLine ?? 0}:${overlap}`);
    const screenLines = view.cells.map(rowAnsi);
    let trailing = 0;
    for (let i = screenLines.length - 1; i >= 0 && screenLines[i] === ''; i--) trailing++;
    const screenText = screenLines.join('\n');
    const cursor = view.cursor && view.cursor.visible
      ? { row: view.rows - 1 - trailing - view.cursor.y, col: Math.max(0, view.cursor.x) } : null;
    // Every marker inside the live window reaches the viewer (not only the
    // newest 16), plus the newest 16 wherever they fall (the header warning).
    const recentFrom = view.issues.length - 16;
    const markers = view.issues
      .filter((issue, i) => i >= recentFrom || (issue.boundaryLineId !== null && issue.boundaryLineId >= start))
      .slice(-FRAME_MARKERS_MAX)
      .map(issue => ({ lineId: issue.boundaryLineId, kind: issue.kind.slice(0, 64), missingCount: issue.missingCount }));
    const metadataRevision = view.issues.reduce((revision, issue) => Math.max(revision, issue.revision), 0);
    return {
      content: rows.length ? [history, screenText].join('\n') : screenText, cursor,
      screen: { alt: alternate, mouseSgr: view.mouseSgr, mouseAny: view.mouseAny },
      boundary: {
        generation: `newarch:${fnv(pane.paneKey.serverIdentity)}:${pane.paneKey.paneId}:${pane.paneKey.birthGeneration}:r${routeGeneration}`,
        liveStartLine: start, walSequence: String(token.revision), walOffset: token.revision,
      },
      newarch: {
        v: 'newarch-frame-v1', paneKey: { ...pane.paneKey }, sourceEpoch: view.sourceEpoch,
        geometryGeneration: view.geometryGeneration, routeGeneration, metadataRevision, cols: view.cols, rows: view.rows,
        revision: token.revision, durableRevision: token.durableRevision, nextLineId: token.nextLineId,
        liveStartLine: start, displaySource: view.displaySource, degraded: view.degraded, markers,
      },
    };
  }

  /**
   * `rows` joined by newlines, equal to a fresh join. While the window start,
   * the hidden pull-back range and every row already joined stay the same,
   * only the rows appended since are encoded and joined (a publish at 100
   * rows/s re-joined up to 2,000 rows each time).
   */
  private historyText(id: string, rows: readonly RingRow[], repairs: number, hide: string): string {
    if (!rows.length) { this.texts.delete(id); return ''; }
    const cached = this.texts.get(id);
    let text: string, from: number;
    if (cached && cached.repairs === repairs && cached.hide === hide && cached.firstId === rows[0]!.lineId
      && cached.count <= rows.length && rows[cached.count - 1]!.lineId === cached.lastId) {
      text = cached.text; from = cached.count;
    } else { text = ''; from = 0; }
    if (from < rows.length) {
      // One join, never repeated `+`: a string built by appending stays a rope
      // one level per row, and every later hash of the frame walks it.
      const parts: string[] = from ? [text] : [];
      for (let i = from; i < rows.length; i++) parts.push(rows[i]!.ansiCache.text ??= cellsToAnsi(rows[i]!.cells));
      text = parts.join('\n');
    }
    this.texts.set(id, { firstId: rows[0]!.lineId, lastId: rows[rows.length - 1]!.lineId, count: rows.length, repairs, hide, text });
    return text;
  }

  /** Rows before `beforeLine` (default: the live window start), newest `limit` of them. */
  readBefore(pane: PipeHistoryPane, beforeLine: number | null, limit = 500): ProjectedHistoryPage {
    const end = beforeLine ?? this.starts.get(keyOf(pane.paneKey)) ?? pane.view().token?.nextLineId ?? 0;
    const start = Math.max(0, end - Math.max(1, Math.min(2000, limit)));
    return this.page(pane, start, end);
  }
  /** Rows after `afterLine` (exclusive), up to the live window start. */
  readAfter(pane: PipeHistoryPane, afterLine: number | null, limit = 500): ProjectedHistoryPage {
    const live = this.starts.get(keyOf(pane.paneKey)) ?? pane.view().token?.nextLineId ?? 0;
    const start = afterLine === null ? 0 : afterLine + 1;
    return this.page(pane, start, Math.min(live, start + Math.max(1, Math.min(2000, limit))));
  }
  private page(pane: PipeHistoryPane, start: number, end: number): ProjectedHistoryPage {
    if (end <= start) return { lines: [], startLine: null, hasMore: false, markers: [] };
    const range = pane.readRange(start, end);
    if (!range || range.lines.length === 0) return { lines: [], startLine: null, hasMore: false, markers: [] };
    return {
      lines: range.lines, startLine: range.startLine, hasMore: range.startLine > 0,
      markers: range.issues.map(issue => ({ lineId: issue.boundaryLineId, kind: issue.kind, reason: issue.reason, missingCount: issue.missingCount })),
    };
  }
  forget(pane: PaneKey): void { this.starts.delete(keyOf(pane)); this.texts.delete(keyOf(pane)); }
}

// Opt-in v2 entry (package export "./pipe-history-runtime"): importing it opens
// no database and starts no timer. Const aliases, not re-exports: Bun 1.3.11
// can leave a dangling symbol for a barrel re-export (see index.ts).
/** The projection store (L1/I2) this runtime writes to. */
export const createProjectionStore = createProjectionStoreValue;
/** VT worker assets beside this module (dist or source) and their pinned-hash check. */
export const pipeVtAssets = pipeVtAssetsValue;
export const verifyPipeVtAssets = verifyPipeVtAssetsValue;

// Explicit stream entrypoint; constructing the legacy runtime remains unchanged.
export { StreamRuntime, StreamRuntimePane, StreamVtTransport } from './stream-runtime';
