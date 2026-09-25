import { cellKey, IncrementalHistoryMatcher, type CapturedRow, type HistoryCell, type HistoryRow, type RowMatch } from './history-row-matcher';

export interface PaneKey { serverIdentity: string; paneId: string; birthGeneration: number }
export interface CalibrationFrame {
  cells: readonly (readonly HistoryCell[])[];
  cursor: { x: number; y: number; visible: boolean } | null;
  kind: 'normal' | 'alternate';
  geometryGeneration: number;
  receiveSeq: number;
}
export interface CaptureMetadata {
  /** Authoritative retained-history epoch, in the same namespace as sourceEpoch.
   * Read from the history owner before/after capture, never copied from parser
   * state. Every destructive reset (including external clear-history) rotates
   * it before any replacement rows can be certified. Unobserved = no evidence. */
  historyEpoch: number;
  sourceEpoch: number; geometryGeneration: number;
  cols: number; rows: number; kind: 'normal' | 'alternate';
  cursor: CalibrationFrame['cursor'];
}
export interface CalibrationCapture {
  paneKey: PaneKey; captureId: string; requestedAt: number; completedAt: number;
  before: CaptureMetadata; after: CaptureMetadata;
  frame: CalibrationFrame; history: readonly CapturedRow[];
  completeRetainedTail: boolean;
  observedFields: readonly string[];
}
export interface CalibrationSnapshot {
  revision: number; sourceEpoch: number; geometryGeneration: number;
  recentHistory: readonly HistoryRow[]; parserFrame: CalibrationFrame;
}
export interface CalibrationCommit { revision: number; durableRevision: number; nextLineId: number }
export interface CalibrationPorts {
  now(): number;
  /** Same clock domain as now(); returns an idempotent cancellation callback. */
  timeout?(callback: () => void, delayMs: number): () => void;
  capture(paneKey: PaneKey, tailLimit: number, signal?: AbortSignal): Promise<CalibrationCapture>;
  schedule(deadline: number): void;
  read(): CalibrationSnapshot;
  // null is a CAS conflict; every screen/check/repair is in this one transaction.
  calibrate(input: { capture: CalibrationCapture; checks: RowMatch['checks']; repairs: RowMatch['repairs']; expectedRevision: number }): Promise<CalibrationCommit | null>;
  publish(commit: CalibrationCommit, frame: CalibrationFrame): void;
  fault(issue: { kind: string; at: number; missingCount: null }): void;
}
export function equalCalibrationFrames(a: CalibrationFrame, b: CalibrationFrame): boolean {
  return a.kind === b.kind && a.geometryGeneration === b.geometryGeneration
    && JSON.stringify(a.cursor) === JSON.stringify(b.cursor)
    && a.cells.length === b.cells.length
    && a.cells.every((row, y) => row.length === b.cells[y]!.length && row.every((cell, x) => cellKey(cell) === cellKey(b.cells[y]![x]!)));
}
function samePane(a: PaneKey, b: PaneKey): boolean {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
// Rows tmux may hold beyond the fenced parser tail: pipe backlog at the fence
// plus rows scrolled while capture ran (the latter is added per capture).
const TAIL_GAP_SLACK = 256;
/** `recent` cut at the newest row of the pre-capture snapshot. An empty
 * snapshot, or a fence evicted from the ring, leaves nothing provable. */
function fencedHistory(recent: readonly HistoryRow[], before: readonly HistoryRow[]): readonly HistoryRow[] {
  const last = before.at(-1)?.lineId;
  if (last === undefined) return [];
  for (let i = recent.length - 1; i >= 0; i--) if (recent[i]!.lineId === last) return i === recent.length - 1 ? recent : recent.slice(0, i + 1);
  return [];
}
export type CalibrationEvent = 'birth' | 'reconnect' | 'resize' | 'clear' | 'alt' | 'fault';

/** One instance per pane. The host owns the deadline queue and invokes runDue.
 * Full-tail is the safe default. Incremental mode is opt-in and never issues
 * checks only through a committed anchor chain; no history_size delta is trusted. */
export class HistoryCalibrator {
  private matcher = new IncrementalHistoryMatcher();
  mode: 'PIPE' | 'CAPTURE' = 'PIPE';
  private deadline = Infinity;
  private lastCaptureAt = -Infinity;
  private lastHistoryAt = -Infinity;
  private outputAt = -Infinity;
  private forceFull = true;
  private eventGeneration = 0;
  private scrolls = 0;
  private inFlight = false;
  private latchAt: number | undefined;
  private degraded = false;
  private nextPipePublish = Infinity;
  private pendingPipe: (() => void) | undefined;
  constructor(readonly paneKey: PaneKey, private ports: CalibrationPorts,
    private options: { historyLimit?: number; incremental?: boolean } = {}) {
    if (options.historyLimit !== undefined && (!Number.isInteger(options.historyLimit) || options.historyLimit < 0 || options.historyLimit > 4500)) throw new Error('invalid history limit');
    this.request(this.ports.now());
  }
  get dueAt(): number { return Math.min(this.deadline, this.nextPipePublish); }
  get acceptsPipeFrame(): boolean { return this.mode === 'PIPE'; }
  output(publishPipe?: () => void): void {
    const now = this.ports.now();
    this.outputAt = now;
    if (publishPipe && this.mode === 'PIPE') {
      this.pendingPipe = publishPipe;
      this.nextPipePublish = Math.min(this.nextPipePublish, now + 16);
      this.ports.schedule(this.dueAt);
    }
    this.request(Math.max(now, this.lastCaptureAt + 200));
  }
  scroll(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid scroll count');
    this.scrolls = Math.min(4500, this.scrolls + count);
    this.output();
  }
  event(_kind: CalibrationEvent): void {
    this.eventGeneration++; this.forceFull = true; this.matcher.reset();
    // A generation change immediately prevents stale parser frames being shown.
    this.enterCapture();
    this.request(Math.max(this.ports.now(), this.lastCaptureAt + 50));
  }
  private request(at: number): void {
    if (at < this.deadline) { this.deadline = at; this.ports.schedule(this.dueAt); }
  }
  private enterCapture(): void {
    this.mode = 'CAPTURE'; this.latchAt ??= this.ports.now();
    this.pendingPipe = undefined; this.nextPipePublish = Infinity;
  }
  async runDue(): Promise<void> {
    const now = this.ports.now();
    if (this.latchAt !== undefined && now - this.latchAt >= 1000) {
      if (!this.degraded) this.ports.fault({ kind: 'capture-latch-degraded', at: now, missingCount: null });
      this.degraded = true; this.mode = 'PIPE'; this.latchAt = undefined;
    }
    if (now >= this.nextPipePublish) {
      const publish = this.pendingPipe;
      this.nextPipePublish = Infinity; this.pendingPipe = undefined;
      if (this.mode === 'PIPE') publish?.();
    }
    if (this.inFlight) return;
    if (now < this.deadline) { this.ports.schedule(this.dueAt); return; }
    // Period anchor: the planned deadline when this start is less than one
    // active period late, so host lateness is not added to every cycle
    // (PLAN §4: every 200ms while active). The 50ms spacing uses `now`.
    const planned = this.deadline;
    const anchor = now - planned < 200 ? planned : now;
    // Output during this capture is spaced from THIS start, not the previous
    // one; otherwise every history capture was followed by a screen-only
    // capture 50ms later while in PIPE mode (PLAN §4 allows that only in CAPTURE).
    this.inFlight = true; this.deadline = Infinity; this.lastCaptureAt = anchor;
    const startedGeneration = this.eventGeneration;
    const historyDue = this.forceFull || anchor - this.lastHistoryAt >= 200;
    const requestedScrolls = this.scrolls;
    const limit = this.options.historyLimit ?? 4500;
    const tailLimit = !historyDue ? 0 : this.forceFull || !this.options.incremental ? limit : Math.min(limit, requestedScrolls + 128);
    let successful = false;
    try {
      // The fence is (pane identity, source/history epoch, geometry, last ID).
      // Content equality cannot prove identity across a history reset. The
      // capture owner must independently attest its epoch; appended rows are
      // left to the next capture. CAS still uses the post-capture revision.
      const fence = this.ports.read();
      const controller = new AbortController();
      let cancelTimeout: (() => void) | undefined;
      const capture = await Promise.race([
        this.ports.capture(this.paneKey, tailLimit, controller.signal),
        new Promise<never>((_, reject) => {
          const expire = () => { controller.abort(); reject(new Error('capture deadline exceeded')); };
          if (this.ports.timeout) cancelTimeout = this.ports.timeout(expire, 1000);
          else { const timer = setTimeout(expire, 1000); cancelTimeout = () => clearTimeout(timer); }
        }),
      ]).finally(() => { cancelTimeout?.(); });
      // The capture subprocess must finish BEFORE selecting a CAS revision.
      const read = this.ports.read();
      const meta = capture.after;
      const stable = samePane(capture.paneKey, this.paneKey)
        && JSON.stringify(capture.before) === JSON.stringify(meta)
        && Number.isSafeInteger(meta.historyEpoch) && meta.historyEpoch >= 0
        && meta.historyEpoch === fence.sourceEpoch
        && meta.sourceEpoch === read.sourceEpoch && meta.geometryGeneration === read.geometryGeneration
        && capture.frame.geometryGeneration === meta.geometryGeneration && capture.frame.kind === meta.kind
        && JSON.stringify(capture.frame.cursor) === JSON.stringify(meta.cursor)
        && capture.frame.cursor !== null
        && capture.frame.cells.length === meta.rows && capture.frame.cells.every(row => row.length === meta.cols)
        && fence.sourceEpoch === read.sourceEpoch && fence.geometryGeneration === read.geometryGeneration
        && startedGeneration === this.eventGeneration;
      if (!stable) { this.matcher.reset(); this.forceFull = true; this.mode = 'PIPE'; this.latchAt = undefined; return; }
      const matched = historyDue && meta.kind === 'normal';
      const recent = matched ? fencedHistory(read.recentHistory, fence.recentHistory) : read.recentHistory;
      const match: RowMatch = !matched ? { checks: [], repairs: [], reason: 'partial-tail' } : this.matcher.match(recent, capture.history, {
        sourceEpoch: read.sourceEpoch, geometryGeneration: read.geometryGeneration,
        completeRetainedTail: capture.completeRetainedTail,
        maxTailGap: read.recentHistory.length - recent.length + TAIL_GAP_SLACK,
      });
      const committed = await this.ports.calibrate({ capture, checks: match.checks, repairs: match.repairs, expectedRevision: read.revision });
      if (!committed) { this.forceFull = true; this.mode = 'PIPE'; this.latchAt = undefined; return; }
      // Only the transaction revision is published. A concurrent lifecycle event
      // suppresses this result and requests another capture, never an old frame.
      if (startedGeneration !== this.eventGeneration) { this.enterCapture(); return; }
      const latest = this.ports.read();
      // A screen-only capture carries no history evidence; remembering its
      // empty match would erase the seed of the incremental chain.
      if (matched) this.matcher.remember(recent, capture.history, match);
      const comparable = latest.revision === committed.revision
        && read.parserFrame.receiveSeq === capture.frame.receiveSeq
        && latest.parserFrame.receiveSeq === capture.frame.receiveSeq;
      if (!comparable || equalCalibrationFrames(latest.parserFrame, capture.frame)) {
        this.mode = 'PIPE'; this.latchAt = undefined; this.degraded = false;
      } else this.enterCapture();
      // A committed capture supersedes any pipe publish queued before it.
      if (comparable) {
        this.pendingPipe = undefined; this.nextPipePublish = Infinity;
        this.ports.publish(committed, capture.frame);
      }
      successful = true;
      this.forceFull = historyDue && match.reason !== 'matched' && match.reason !== 'generation';
      if (historyDue) { this.lastHistoryAt = anchor; this.scrolls = Math.max(0, this.scrolls - requestedScrolls); }
    } catch (error) {
      // A failed or timed-out capture observed nothing, so the incremental
      // seed is still exact and the next tail still covers every unconsumed
      // scroll. Forcing a full capture here turned one slow capture into a
      // cascade: 4500-row captures are slower still and time out again.
      this.mode = 'PIPE'; this.latchAt = undefined;
      this.ports.fault({ kind: 'capture-fault', at: this.ports.now(), missingCount: null });
    } finally {
      this.inFlight = false; this.lastCaptureAt = anchor;
      const at = this.ports.now();
      if (this.latchAt !== undefined && at - this.latchAt > 1000 && !this.degraded) {
        this.degraded = true;
        this.ports.fault({ kind: 'capture-latch-degraded', at, missingCount: null });
      }
      const interval = !successful || this.mode === 'CAPTURE' ? 50 : at - this.outputAt <= 200 ? 200 : 1000;
      // An event timer may have fired while capture was in flight. Re-arm
      // explicitly, and retain the 50ms minimum between capture starts.
      this.deadline = Math.max(now + 50, Math.min(this.deadline, Math.max(at, anchor + interval)));
      this.ports.schedule(this.dueAt);
    }
  }
}
