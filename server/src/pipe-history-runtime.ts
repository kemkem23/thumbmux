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
 * namespace: colours `default` / `index:N` (0-15) / `rgb:r,g,b` and the style
 * bits the parser can observe. Everything the capture shows but the parser
 * cannot represent is masked on both sides, so equal cells mean equal content.
 */
import { PipeHistoryCollector, type PipeFaultEvent, type PipeFrameEvent, type PipeScrollEvent } from './pipe-history-collector';
import { pipeVtRunCells, type PipeVtAssets, type PipeVtRow } from './pipe-vt-worker';
import { HistoryCalibrator, type CalibrationCapture, type CalibrationFrame, type CaptureMetadata, type CaptureEvidence } from './history-calibrator';
import { HistoryWatchdog } from './history-watchdog';
import type { CapturedRow, HistoryCell, HistoryRow, RowMatch } from './history-row-matcher';
import { TmuxCaptureDecoder, TMUX_OBSERVED_FIELDS } from './tmux-capture-normalize';
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

const interned = new Map<string, HistoryCell>();
function internCell(grapheme: string, width: 0 | 1 | 2, continuation: boolean, fg: string, bg: string, style: number): HistoryCell {
  const key = `${grapheme}\u0000${width}${continuation ? 1 : 0}\u0000${fg}\u0000${bg}\u0000${style}`;
  let cell = interned.get(key);
  if (!cell) {
    // Bounding only: dropping the table never changes a value.
    if (interned.size >= 65536) interned.clear();
    // Field order equals the store's decoded cells, so JSON comparisons agree.
    cell = Object.freeze({ grapheme, width, continuation, fg, bg, style });
    interned.set(key, cell);
  }
  return cell;
}
export const BLANK_CELL: HistoryCell = internCell(' ', 1, false, 'default', 'default', 0);

/** One parser row (RLE runs) -> exactly `cols` canonical cells. */
export function parserRowCells(row: PipeVtRow, cols?: number): HistoryCell[] {
  const glyphs: string[] = [];
  const styles: Array<[string, string, number]> = [];
  for (const run of row) {
    const style: [string, string, number] = [canonicalParserColor(run[0]), canonicalParserColor(run[1]), parserStyle(run[2])];
    for (const glyph of pipeVtRunCells(run)) { glyphs.push(glyph); styles.push(style); }
  }
  const width = cols ?? glyphs.length;
  const cells = new Array<HistoryCell>(width);
  for (let x = 0; x < width; x++) {
    const glyph = glyphs[x];
    if (glyph === undefined) { cells[x] = BLANK_CELL; continue; }
    const [fg, bg, style] = styles[x]!;
    cells[x] = glyph === ''
      ? internCell('', 0, true, fg, bg, style)
      : internCell(glyph, glyphs[x + 1] === '' ? 2 : 1, false, fg, bg, style);
  }
  return cells;
}
/** Decoder cells (tmux-capture-normalize) -> canonical cells. */
export function canonicalCaptureCells(row: readonly Readonly<HistoryCell>[], cols: number): HistoryCell[] {
  const cells = new Array<HistoryCell>(cols);
  for (let x = 0; x < cols; x++) {
    const cell = row[x];
    cells[x] = cell ? internCell(cell.grapheme, cell.width, cell.continuation, canonicalCaptureColor(cell.fg),
      canonicalCaptureColor(cell.bg), cell.style & OBSERVED_STYLE_MASK) : BLANK_CELL;
  }
  return cells;
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
export type RuntimeStore = ProjectionWriterPort & { token(key: PaneKey): ProjectionToken };

export interface RuntimeFault {
  paneKey: PaneKey; session: string; kind: string; at: number; message?: string;
  missingCount: number | null; receiveSeqFrom?: number; receiveSeqTo?: number;
}
export interface PaneUpdate { source: 'pipe' | 'tmux-calibrated' | 'issue'; revision: number }
export interface PaneView {
  paneKey: PaneKey; session: string;
  cells: readonly (readonly HistoryCell[])[]; cursor: { x: number; y: number; visible: boolean } | null;
  kind: 'normal' | 'alternate'; cols: number; rows: number;
  displaySource: 'pipe' | 'tmux-calibrated' | 'none';
  token: ProjectionToken | null;
  sourceEpoch: number; geometryGeneration: number;
  mouseSgr: boolean; mouseAny: boolean;
  degraded: boolean; issues: ProjectionIssue[];
}
export interface PaneStats {
  received: number; published: number; latencyMs: number[];
  captures: number; captureFaults: number; captureConflicts: number; screenCalibrations: number;
  captureIntervalMaxMs: number; captureAt: number[];
  faults: Record<string, number>;
}
export interface PipeHistoryPaneOptions {
  paneKey: PaneKey; session: string; meta: PaneTmuxMeta;
  sourceEpoch?: number; scrollOnClear?: boolean;
  capture(tail: number, signal: AbortSignal): Promise<RawPaneCapture>;
  /** Calibrate against tmux (default true). */
  calibrate?: boolean;
  incremental?: boolean;
  historyLimit?: number;
}
export interface PipeHistoryRuntimeOptions {
  store: RuntimeStore;
  now?: () => number;
  nowNs?: () => bigint;
  assets?: PipeVtAssets;
  python?: string;
  /** Independent sink (outside the DB) for every fault; a disk-full store still reports. */
  onFault?: (fault: RuntimeFault) => void;
  /** Bounded latency samples kept per pane (default 200k). */
  latencySampleLimit?: number;
  /** Recent history rows kept in RAM per pane for calibration and the live window. */
  ringRows?: number;
}

const RING_ROWS = 4500;

// ─── screen assembly ──────────────────────────────────────────────────────

interface ParserScreen { cols: number; rows: number; cells: HistoryCell[][] }
const blankRow = (cols: number) => new Array<HistoryCell>(cols).fill(BLANK_CELL);
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

interface RingRow extends HistoryRow { ansi: string }
const clampCursor = (cursor: { x: number; y: number; visible: boolean }, cols: number, rows: number) => ({
  x: Math.max(0, Math.min(cols - 1, cursor.x)), y: Math.max(0, Math.min(rows - 1, cursor.y)), visible: cursor.visible,
});

export class PipeHistoryPane {
  readonly paneKey: PaneKey;
  readonly session: string;
  readonly collector: PipeHistoryCollector;
  readonly calibrator: HistoryCalibrator | null;
  readonly watchdog: HistoryWatchdog;
  private screens: { normal?: ParserScreen; alternate?: ParserScreen } = {};
  private parserKind: 'normal' | 'alternate' = 'normal';
  private parserCursor: { x: number; y: number; visible: boolean } = { x: 0, y: 0, visible: true };
  private displayed: { cells: HistoryCell[][]; cursor: { x: number; y: number; visible: boolean } | null; kind: 'normal' | 'alternate'; cols: number; rows: number; source: 'pipe' | 'tmux-calibrated' } | null = null;
  private ring: RingRow[] = [];
  private received = 0;
  private receiveTimes: Array<{ seq: number; at: bigint }> = [];
  private receiveHead = 0;
  private listeners = new Set<(update: PaneUpdate) => void>();
  private meta: PaneTmuxMeta;
  private decoder: TmuxCaptureDecoder | null = null;
  private closed = false;
  private lastCaptureAt: number | null = null;
  private pendingPublish: { frame: ProjectionFrame; receipt: ProjectionReceipt } | null = null;
  private pendingIssues: Array<{ kind: string; reason: string; missingCount: number | null; recoverable: boolean }> = [];
  readonly stats: PaneStats = {
    received: 0, published: 0, latencyMs: [], captures: 0, captureFaults: 0, captureConflicts: 0,
    screenCalibrations: 0, captureIntervalMaxMs: 0, captureAt: [], faults: {},
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
      assets: runtime.options.assets, python: runtime.options.python,
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
    }, { incremental: options.incremental ?? true, historyLimit: options.historyLimit });
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
    if (this.receiveTimes.length - this.receiveHead < 1_000_000) this.receiveTimes.push({ seq, at });
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
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const screen = lines.slice(Math.max(0, lines.length - meta.rows));
    const cursor = clampCursor(meta.cursor, meta.cols, meta.rows);
    let text = meta.alternate ? '\x1b[?1049h' : '';
    screen.forEach((line, y) => { text += `\x1b[${y + 1};1H\x1b[0m${line}`; });
    text += `\x1b[0m\x1b[${cursor.y + 1};${cursor.x + 1}H${cursor.visible ? '\x1b[?25h' : '\x1b[?25l'}`;
    this.ingest(new TextEncoder().encode(text));
  }

  // ── collector ports ──
  private onScroll(event: PipeScrollEvent): unknown {
    const cells = parserRowCells(event.physicalRow);
    const answer = this.runtime.store.appendScroll({
      paneKey: this.paneKey, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration,
      physicalRow: toPhysicalRow(cells), softWrap: event.softWrap, receiveSeq: event.receiveSeq,
    });
    // Observe the receipt without replacing it: the collector still reads the
    // store's own promise for pressure / oversize decisions.
    answer.then(receipt => {
      if (isProjectionRefusal(receipt)) return;
      this.remember({ lineId: receipt.nextLineId - 1, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration, cells, softWrap: false, ansi: cellsToAnsi(cells) });
      this.calibrator?.scroll(1);
    }, () => {});
    return answer;
  }

  private remember(row: RingRow): void {
    this.ring.push(row);
    const limit = this.runtime.options.ringRows ?? RING_ROWS;
    if (this.ring.length > limit + 512) this.ring.splice(0, this.ring.length - limit);
  }

  private onFrame(event: PipeFrameEvent): unknown {
    const previous = this.screens[event.kind];
    const { screen, complete } = applyFrameDelta(previous, event.cells);
    const cursor = clampCursor(event.cursor, screen.cols, screen.rows);
    const frame: ProjectionFrame = {
      paneKey: this.paneKey, sourceEpoch: event.sourceEpoch, geometryGeneration: event.geometryGeneration,
      receiveSeq: event.receiveSeq, cells: screen.cells, kind: event.kind, cols: screen.cols, rows: screen.rows,
      cursor: { row: cursor.y, col: cursor.x, visible: cursor.visible },
    };
    return this.runtime.store.replaceScreen(frame).then((receipt: ProjectionAdmission) => {
      if (isProjectionRefusal(receipt)) return receipt;
      // Accepted: only now does the delta become the parser screen (I1 m1).
      this.screens[event.kind] = screen;
      this.parserKind = event.kind;
      if (this.pendingIssues.length) {
        for (const issue of this.pendingIssues.splice(0)) this.recordIssue(issue.kind, issue.reason, issue.missingCount, issue.recoverable);
      }
      this.parserCursor = cursor;
      if (!complete) this.collector.requestFullFrame();
      this.calibrator?.output();
      if (!this.calibrator || this.calibrator.acceptsPipeFrame) this.publishPipe(frame, receipt);
      else this.pendingPublish = { frame, receipt };
      return receipt;
    });
  }

  private publishPipe(frame: ProjectionFrame, receipt: ProjectionReceipt): void {
    this.pendingPublish = null;
    this.displayed = {
      cells: frame.cells as HistoryCell[][], kind: frame.kind, cols: frame.cols, rows: frame.rows, source: 'pipe',
      cursor: frame.cursor ? { x: frame.cursor.col, y: frame.cursor.row, visible: frame.cursor.visible } : null,
    };
    const now = this.runtime.nowNs();
    while (this.receiveHead < this.receiveTimes.length && this.receiveTimes[this.receiveHead]!.seq <= frame.receiveSeq) {
      const entry = this.receiveTimes[this.receiveHead++]!;
      if (this.stats.latencyMs.length < (this.runtime.options.latencySampleLimit ?? 200_000)) {
        this.stats.latencyMs.push(Number(now - entry.at) / 1e6);
      }
    }
    if (this.receiveHead > 4096 && this.receiveHead * 2 > this.receiveTimes.length) {
      this.receiveTimes.splice(0, this.receiveHead);
      this.receiveHead = 0;
    }
    this.notify({ source: 'pipe', revision: receipt.revision });
  }

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
    const trimmed = previous.historySize >= previous.historyLimit * 0.9 && meta.historySize >= previous.historyLimit * 0.8;
    if (meta.historySize < previous.historySize && !trimmed) {
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
    return {
      revision: token?.revision ?? 0,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      recentHistory: this.ring, parserFrame,
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
    const cols = raw.after.cols;
    if (!this.decoder || this.decoder.cols !== cols) this.decoder = new TmuxCaptureDecoder(cols);
    const decoded = this.decoder.decode(raw.body);
    const uncertain = this.decoder.uncertainRows;
    const rows = decoded.map(row => canonicalCaptureCells(row as readonly HistoryCell[], cols));
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
    const projected = {
      paneKey: this.paneKey, sourceEpoch: meta.sourceEpoch, geometryGeneration: meta.geometryGeneration, receiveSeq: 0,
      cells: c.frame.cells as HistoryCell[][], kind: meta.kind, cols: meta.cols, rows: meta.rows,
      cursor: meta.cursor ? { row: meta.cursor.y, col: meta.cursor.x, visible: meta.cursor.visible } : null,
      captureId: c.captureId, requestedAt: c.requestedAt, completedAt: c.completedAt,
      firstHistoryRow: 0, history: c.history.map(row => toPhysicalRow(row.cells)),
      observedFields: [...c.observedFields], ambiguousRows: (c.uncertainHistoryRows?.length ?? 0) + (c.uncertainScreenRows?.length ?? 0),
      result: input.captureEvidence.kind,
    };
    try {
      const receipt = await this.runtime.store.calibrate({
        capture: projected, expectedRevision: input.expectedRevision, captureEvidence: input.captureEvidence,
        checks: input.checks.map(m => ({ lineId: m.lineId, captureRow: m.capturedRow })),
        contentMatches: input.contentMatches.map(m => ({ lineId: m.lineId, captureRow: m.capturedRow })),
        repairs: input.repairs.map(m => ({ lineId: m.lineId, captureRow: m.capturedRow, physicalRow: toPhysicalRow(m.row.cells) })),
      });
      this.countCapture();
      if (input.repairs.length) {
        const byId = new Map(input.repairs.map(r => [r.lineId, r.row.cells]));
        for (const row of this.ring) {
          const cells = byId.get(row.lineId);
          if (cells) { row.cells = cells; row.ansi = cellsToAnsi(cells as HistoryCell[]); }
        }
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
    if (this.stats.captureAt.length < 100_000) this.stats.captureAt.push(at);
  }

  private publishCapture(commit: { revision: number }, frame: CalibrationFrame): void {
    const cells = frame.cells as HistoryCell[][];
    this.displayed = {
      cells, cursor: frame.cursor, kind: frame.kind, cols: cells[0]?.length ?? this.meta.cols, rows: cells.length,
      source: 'tmux-calibrated',
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
    const state = (health ?? this.runtime.store.health()).panes.find(p => p.paneKey.serverIdentity === this.paneKey.serverIdentity
      && p.paneKey.paneId === this.paneKey.paneId && p.paneKey.birthGeneration === this.paneKey.birthGeneration);
    return { degraded: state?.status === 'degraded', issues: state?.issues ?? [] };
  }

  view(health?: ProjectionHealth): PaneView {
    const token = this.tokenOrNull();
    const shown = this.displayed;
    const { degraded, issues } = token ? this.health(health) : { degraded: false, issues: [] };
    return {
      paneKey: this.paneKey, session: this.session,
      cells: shown?.cells ?? [], cursor: shown?.cursor ?? null, kind: shown?.kind ?? 'normal',
      cols: shown?.cols ?? this.meta.cols, rows: shown?.rows ?? this.meta.rows,
      displaySource: shown?.source ?? 'none', token,
      sourceEpoch: token?.sourceEpoch ?? this.collector.currentSourceEpoch(),
      geometryGeneration: token?.geometryGeneration ?? this.collector.currentGeometryGeneration(),
      mouseSgr: this.meta.mouseSgr, mouseAny: this.meta.mouseAny, degraded, issues,
    };
  }

  /** Accepted history rows still in RAM, oldest first, with their cached ANSI text. */
  recentRows(): readonly RingRow[] { return this.ring; }

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
        return { lines, startLine: from, token, issues: issues.filter(i => i.boundaryLineId !== null && i.boundaryLineId >= from && i.boundaryLineId <= stop) };
      } catch (error) {
        if (!String((error as Error)?.message).includes('page-retry')) throw error;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    await this.collector.close();
  }
}

// ─── runtime ──────────────────────────────────────────────────────────────

export class PipeHistoryRuntime {
  readonly store: RuntimeStore;
  readonly now: () => number;
  readonly nowNs: () => bigint;
  private readonly panesByKey = new Map<string, PipeHistoryPane>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private armedAt = Infinity;
  private closed = false;

  constructor(readonly options: PipeHistoryRuntimeOptions) {
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
    await Promise.all([...this.panesByKey.values()].map(pane => pane.close()));
    this.panesByKey.clear();
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
    const lines: string[] = [];
    if (!alternate) {
      const offset = ring.length - (token.nextLineId - start);
      for (let i = Math.max(0, offset); i < ring.length; i++) lines.push(ring[i]!.ansi);
    }
    const screenLines = view.cells.map(row => cellsToAnsi(row));
    let trailing = 0;
    for (let i = screenLines.length - 1; i >= 0 && screenLines[i] === ''; i--) trailing++;
    lines.push(...screenLines);
    const cursor = view.cursor && view.cursor.visible
      ? { row: view.rows - 1 - trailing - view.cursor.y, col: Math.max(0, view.cursor.x) } : null;
    const markers = view.issues.slice(-16).map(issue => ({ lineId: issue.boundaryLineId, kind: issue.kind.slice(0, 64), missingCount: issue.missingCount }));
    return {
      content: lines.join('\n'), cursor,
      screen: { alt: alternate, mouseSgr: view.mouseSgr, mouseAny: view.mouseAny },
      boundary: {
        generation: `newarch:${fnv(pane.paneKey.serverIdentity)}:${pane.paneKey.paneId}:${pane.paneKey.birthGeneration}:r${routeGeneration}`,
        liveStartLine: start, walSequence: String(token.revision), walOffset: token.revision,
      },
      newarch: {
        v: 'newarch-frame-v1', paneKey: { ...pane.paneKey }, sourceEpoch: view.sourceEpoch,
        geometryGeneration: view.geometryGeneration, routeGeneration, cols: view.cols, rows: view.rows,
        revision: token.revision, durableRevision: token.durableRevision, nextLineId: token.nextLineId,
        liveStartLine: start, displaySource: view.displaySource, degraded: view.degraded, markers,
      },
    };
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
  forget(pane: PaneKey): void { this.starts.delete(keyOf(pane)); }
}
