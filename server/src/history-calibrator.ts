import { cellKey, matchHistoryRows, type CapturedRow, type HistoryCell, type HistoryRow, type RowMatch } from './history-row-matcher';

export interface PaneKey { serverIdentity: string; paneId: string; birthGeneration: number }
export interface CalibrationFrame {
  cells: readonly (readonly HistoryCell[])[];
  cursor: { x: number; y: number; visible: boolean } | null;
  kind: 'normal' | 'alternate';
  geometryGeneration: number;
  receiveSeq: number;
}
export interface CaptureMetadata {
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
  capture(paneKey: PaneKey, tailLimit: number): Promise<CalibrationCapture>;
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
export type CalibrationEvent = 'birth' | 'reconnect' | 'resize' | 'clear' | 'alt' | 'fault';

/** One instance per pane. The host owns the deadline queue and invokes runDue.
 * Full-tail is the safe default. Incremental mode is opt-in and never issues
 * checks on an incomplete retained ring; no history_size delta is trusted. */
export class HistoryCalibrator {
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
    this.eventGeneration++; this.forceFull = true;
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
    if (this.inFlight) return;
    if (now >= this.nextPipePublish) {
      const publish = this.pendingPipe;
      this.nextPipePublish = Infinity; this.pendingPipe = undefined;
      if (this.mode === 'PIPE') publish?.();
    }
    if (now < this.deadline) { this.ports.schedule(this.dueAt); return; }
    this.inFlight = true; this.deadline = Infinity;
    const startedGeneration = this.eventGeneration;
    const historyDue = this.forceFull || now - this.lastHistoryAt >= 200;
    const requestedScrolls = this.scrolls;
    const limit = this.options.historyLimit ?? 4500;
    const tailLimit = !historyDue ? 0 : this.forceFull || !this.options.incremental ? limit : Math.min(limit, requestedScrolls + 3);
    const read = this.ports.read();
    let successful = false;
    try {
      const capture = await this.ports.capture(this.paneKey, tailLimit);
      const meta = capture.after;
      const stable = samePane(capture.paneKey, this.paneKey)
        && JSON.stringify(capture.before) === JSON.stringify(meta)
        && meta.sourceEpoch === read.sourceEpoch && meta.geometryGeneration === read.geometryGeneration
        && capture.frame.geometryGeneration === meta.geometryGeneration && capture.frame.kind === meta.kind
        && JSON.stringify(capture.frame.cursor) === JSON.stringify(meta.cursor)
        && capture.frame.cursor !== null
        && capture.frame.cells.length === meta.rows && capture.frame.cells.every(row => row.length === meta.cols)
        && startedGeneration === this.eventGeneration;
      if (!stable) { this.forceFull = true; this.enterCapture(); return; }
      const match = matchHistoryRows(read.recentHistory, capture.history, {
        sourceEpoch: read.sourceEpoch, geometryGeneration: read.geometryGeneration,
        completeRetainedTail: historyDue && capture.completeRetainedTail && meta.kind === 'normal',
      });
      const committed = await this.ports.calibrate({ capture, checks: match.checks, repairs: match.repairs, expectedRevision: read.revision });
      if (!committed) { this.forceFull = true; this.enterCapture(); return; }
      // Only the transaction revision is published. A concurrent lifecycle event
      // suppresses this result and requests another capture, never an old frame.
      if (startedGeneration !== this.eventGeneration) { this.enterCapture(); return; }
      const latest = this.ports.read();
      if (latest.revision !== committed.revision) { this.enterCapture(); return; }
      if (equalCalibrationFrames(latest.parserFrame, capture.frame)) {
        this.mode = 'PIPE'; this.latchAt = undefined; this.degraded = false;
      } else this.enterCapture();
      this.ports.publish(committed, capture.frame);
      successful = true;
      this.forceFull = false;
      if (historyDue) { this.lastHistoryAt = now; this.scrolls = Math.max(0, this.scrolls - requestedScrolls); }
    } catch (error) {
      this.forceFull = true; this.enterCapture();
      this.ports.fault({ kind: 'capture-fault', at: this.ports.now(), missingCount: null });
    } finally {
      this.inFlight = false; this.lastCaptureAt = now;
      const at = this.ports.now();
      if (this.latchAt !== undefined && at - this.latchAt > 1000 && !this.degraded) {
        this.degraded = true;
        this.ports.fault({ kind: 'capture-latch-degraded', at, missingCount: null });
      }
      const interval = !successful || this.mode === 'CAPTURE' ? 50 : at - this.outputAt <= 200 ? 200 : 1000;
      this.request(Math.max(at, now + interval));
    }
  }
}
