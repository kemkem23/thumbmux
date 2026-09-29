import { certifiedRows, equalCells, IncrementalHistoryMatcher, type CapturedRow, type HistoryCell, type HistoryRow, type RowMatch } from './history-row-matcher';

export interface PaneKey { serverIdentity: string; paneId: string; birthGeneration: number }
export interface CalibrationFrame {
  cells: readonly (readonly HistoryCell[])[];
  cursor: { x: number; y: number; visible: boolean } | null;
  kind: 'normal' | 'alternate';
  geometryGeneration: number;
  /** Parser frames: bytes received from the pipe when the frame was built.
   * Capture frames carry no byte position (tmux 3.4 has no byte fence); the
   * calibrator never reads this field from a capture. */
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
  /** Decoder row isolation (tmux-capture-normalize): rows whose cell boundary
   * tmux does not serialize exactly. Indexes into `history` / `frame.cells`.
   * History rows listed here are never checked or content-matched; screen
   * rows are still drawn and are reported in the screen evidence. */
  uncertainHistoryRows?: readonly number[];
  uncertainScreenRows?: readonly number[];
}
/** FIX1-PLAN §1.2 evidence for drawing a capture over displayedScreen. There
 * is no byte fence: the claim is only that metadata was stable around the
 * capture and the parser received no pipe byte between the pre-capture read
 * and the post-capture read (a quiescent window). parserFrame is never fed.
 * Field-for-field the store's port (lot I2 `sqlite-history/types.ts`
 * `CaptureEvidence` at FIX2 4ea4fb585): the store draws the screen only for
 * kind 'quiescent' and re-checks receiveSeqBefore === receiveSeqAfter itself;
 * 'unfenced' commits history evidence only. uncertainRows (§7.4 D18) = the
 * capture's decoder-uncertain screen rows: drawn, kept apart, not certified. */
export type CaptureEvidence =
  | { kind: 'quiescent'; sourceEpoch: number; geometryGeneration: number; receiveSeqBefore: number; receiveSeqAfter: number; uncertainRows?: readonly number[] }
  | { kind: 'unfenced'; reason: string };
export interface CalibrationSnapshot {
  revision: number; sourceEpoch: number; geometryGeneration: number;
  recentHistory: readonly HistoryRow[]; parserFrame: CalibrationFrame;
  /** Line id of the newest recent row at read time (null: none). When given,
   * the pre-capture fence never reads `recentHistory`, so a port that copies
   * its ring lazily copies it once per capture, not per read. */
  recentLastLineId?: number | null;
}
export interface CalibrationCommit { revision: number; durableRevision: number; nextLineId: number }
export interface CalibrationPorts {
  now(): number;
  /** Same clock domain as now(); returns an idempotent cancellation callback. */
  timeout?(callback: () => void, delayMs: number): () => void;
  capture(paneKey: PaneKey, tailLimit: number, signal?: AbortSignal): Promise<CalibrationCapture>;
  schedule(deadline: number): void;
  read(): CalibrationSnapshot;
  // null is a CAS conflict; every screen/check/content-match/repair is in this
  // one transaction. Only kind 'quiescent' may replace displayedScreen;
  // 'unfenced' = history only.
  calibrate(input: {
    capture: CalibrationCapture; checks: RowMatch['checks']; contentMatches: RowMatch['contentMatches'];
    repairs: RowMatch['repairs']; expectedRevision: number; captureEvidence: CaptureEvidence;
    /** Present only with `certifiedStyleMask`: captured rows (history index /
     * screen row) holding style bits outside the mask. Their cells are kept
     * and drawn in full fidelity; the claim about those bits is uncertain. */
    uncertifiedStyle?: { mask: number; historyRows: readonly number[]; screenRows: readonly number[] };
  }): Promise<CalibrationCommit | null>;
  /** Called only with a frame the store committed in `commit`. */
  publish(commit: CalibrationCommit, frame: CalibrationFrame): void;
  fault(issue: { kind: string; at: number; missingCount: null }): void;
}
/** Frames equal in every field; with `styleMask`, style bits outside it are
 * not compared (a comparator restriction only, never applied to drawn cells). */
export function equalCalibrationFrames(a: CalibrationFrame, b: CalibrationFrame, styleMask = -1): boolean {
  return a.kind === b.kind && a.geometryGeneration === b.geometryGeneration
    && JSON.stringify(a.cursor) === JSON.stringify(b.cursor)
    && a.cells.length === b.cells.length
    && a.cells.every((row, y) => row.length === b.cells[y]!.length && row.every((cell, x) => equalCells(cell, b.cells[y]![x]!, styleMask)));
}
function uncertifiedRows(rows: readonly CapturedRow[], mask: number): number[] {
  const out: number[] = [];
  rows.forEach((row, y) => { if (row.cells.some(cell => (cell.style & ~mask) !== 0)) out.push(y); });
  return out;
}
function samePane(a: PaneKey, b: PaneKey): boolean {
  return a.serverIdentity === b.serverIdentity && a.paneId === b.paneId && a.birthGeneration === b.birthGeneration;
}
// Rows tmux may hold beyond the fenced parser tail: pipe backlog at the fence
// plus rows scrolled while capture ran (the latter is added per capture).
const TAIL_GAP_SLACK = 256;
/** `recent` cut at the newest row of the pre-capture snapshot. An empty
 * snapshot, or a fence evicted from the ring, leaves nothing provable. */
function fencedHistory(recent: readonly HistoryRow[], before: CalibrationSnapshot): readonly HistoryRow[] {
  const last = before.recentLastLineId !== undefined ? before.recentLastLineId ?? undefined : before.recentHistory.at(-1)?.lineId;
  if (last === undefined) return [];
  for (let i = recent.length - 1; i >= 0; i--) if (recent[i]!.lineId === last) return i === recent.length - 1 ? recent : recent.slice(0, i + 1);
  return [];
}
export type CalibrationEvent = 'birth' | 'reconnect' | 'resize' | 'clear' | 'alt' | 'fault';
/** Capture cadence (I4-FIX1-PLAN §5.4). A pane with a viewer calibrates the
 * displayed screen: 200ms while output flows, 1s when idle. A pane without a
 * viewer keeps every row through the pipe and only needs history evidence:
 * one capture per 5s. Lifecycle events are 50ms either way. */
export const CAPTURE_CADENCE = { eventMs: 50, activeMs: 200, idleMs: 1000, unviewedMs: 5000, deadlineMs: 1000 } as const;
export interface CalibratorOptions {
  historyLimit?: number; incremental?: boolean;
  /** Initial viewer count; undefined = not reported, treated as viewed. */
  viewers?: number;
  /** Style bits the parser can observe. Captured cells keep every bit; only
   * the parser comparison (history identity, screen divergence) is limited
   * to this mask. Undefined = compare every bit. */
  certifiedStyleMask?: number;
}

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
  private viewers: number | undefined;
  private closed = false;
  /** Aborts the capture in flight (deadline or close). */
  private abortInFlight: (() => void) | undefined;
  constructor(readonly paneKey: PaneKey, private ports: CalibrationPorts,
    private options: CalibratorOptions = {}) {
    if (options.historyLimit !== undefined && (!Number.isInteger(options.historyLimit) || options.historyLimit < 0 || options.historyLimit > 4500)) throw new Error('invalid history limit');
    if (options.certifiedStyleMask !== undefined && !Number.isSafeInteger(options.certifiedStyleMask)) throw new Error('invalid style mask');
    if (options.viewers !== undefined) this.checkViewers(options.viewers);
    this.viewers = options.viewers;
    this.request(this.ports.now());
  }
  get dueAt(): number { return this.closed ? Infinity : Math.min(this.deadline, this.nextPipePublish); }
  get acceptsPipeFrame(): boolean { return this.mode === 'PIPE'; }
  get capturing(): boolean { return this.inFlight; }
  private get viewed(): boolean { return this.viewers === undefined || this.viewers > 0; }
  private checkViewers(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid viewer count');
  }
  /** Host viewer count for this pane. A pane gaining its first viewer is
   * captured now (history included), so its screen is fresh within one
   * capture deadline instead of waiting out the unviewed period. */
  setViewers(count: number): void {
    this.checkViewers(count);
    if (this.closed) return;
    const was = this.viewed;
    this.viewers = count;
    if (!was && this.viewed) {
      this.lastHistoryAt = -Infinity;
      this.request(Math.max(this.ports.now(), this.lastCaptureAt + CAPTURE_CADENCE.eventMs));
    }
  }
  /** Stops this pane: aborts the capture in flight (its signal fires now),
   * never commits or publishes a result that lands later, and schedules
   * nothing again. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deadline = Infinity; this.nextPipePublish = Infinity; this.pendingPipe = undefined;
    this.abortInFlight?.();
  }
  output(publishPipe?: () => void): void {
    if (this.closed) return;
    const now = this.ports.now();
    this.outputAt = now;
    if (publishPipe && this.mode === 'PIPE') {
      this.pendingPipe = publishPipe;
      this.nextPipePublish = Math.min(this.nextPipePublish, now + 16);
      this.ports.schedule(this.dueAt);
    }
    this.request(Math.max(now, this.lastCaptureAt + (this.viewed ? CAPTURE_CADENCE.activeMs : CAPTURE_CADENCE.unviewedMs)));
  }
  scroll(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid scroll count');
    this.scrolls = Math.min(4500, this.scrolls + count);
    this.output();
  }
  event(_kind: CalibrationEvent): void {
    if (this.closed) return;
    this.eventGeneration++; this.forceFull = true; this.matcher.reset();
    // A generation change immediately prevents stale parser frames being shown.
    this.enterCapture();
    this.request(Math.max(this.ports.now(), this.lastCaptureAt + CAPTURE_CADENCE.eventMs));
  }
  private request(at: number): void {
    if (this.closed) return;
    if (at < this.deadline) { this.deadline = at; this.ports.schedule(this.dueAt); }
  }
  private enterCapture(): void {
    this.mode = 'CAPTURE'; this.latchAt ??= this.ports.now();
    this.pendingPipe = undefined; this.nextPipePublish = Infinity;
  }
  async runDue(): Promise<void> {
    if (this.closed) return;
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
    // A committed quiescent capture that differs from the parser screen: the
    // next pipe byte redraws the parser's cells, so recapture in 50ms.
    let diverged = false;
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
          // Deadline and close() both abort the capture port (the host kills
          // and reaps its subprocess on this signal) and release this pane
          // at once: a capture port that ignores the signal cannot hold it.
          const expire = (reason: string) => { controller.abort(); reject(new Error(reason)); };
          this.abortInFlight = () => expire('calibrator closed');
          if (this.ports.timeout) cancelTimeout = this.ports.timeout(() => expire('capture deadline exceeded'), CAPTURE_CADENCE.deadlineMs);
          else { const timer = setTimeout(() => expire('capture deadline exceeded'), CAPTURE_CADENCE.deadlineMs); cancelTimeout = () => clearTimeout(timer); }
        }),
      ]).finally(() => { cancelTimeout?.(); this.abortInFlight = undefined; });
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
      // Only a matched history capture reads the ring: once, after the capture.
      const recent = matched ? fencedHistory(read.recentHistory, fence) : [];
      // The parser comparison sees certified bits only; `capture` keeps all.
      const mask = this.options.certifiedStyleMask;
      const certified = mask === undefined ? capture.history : certifiedRows(capture.history, mask);
      const match: RowMatch = !matched ? { checks: [], contentMatches: [], repairs: [], reason: 'partial-tail' } : this.matcher.match(recent, certified, {
        sourceEpoch: read.sourceEpoch, geometryGeneration: read.geometryGeneration,
        completeRetainedTail: capture.completeRetainedTail,
        maxTailGap: read.recentHistory.length - recent.length + TAIL_GAP_SLACK,
        uncertainCapturedRows: capture.uncertainHistoryRows?.length ? new Set(capture.uncertainHistoryRows) : undefined,
      });
      // FIX1-PLAN §1.2: no byte fence. The capture may replace displayedScreen
      // only when the parser received nothing while it ran; otherwise the pipe
      // frame is newer and this transaction carries history evidence only.
      const receiveSeqBefore = fence.parserFrame.receiveSeq, receiveSeq = read.parserFrame.receiveSeq;
      const captureEvidence: CaptureEvidence = receiveSeqBefore !== receiveSeq ? { kind: 'unfenced', reason: 'received-during-capture' } : {
        kind: 'quiescent', sourceEpoch: meta.sourceEpoch, geometryGeneration: meta.geometryGeneration,
        receiveSeqBefore, receiveSeqAfter: receiveSeq, uncertainRows: capture.uncertainScreenRows ?? [],
      };
      const uncertifiedStyle = mask === undefined ? undefined : {
        mask, historyRows: uncertifiedRows(capture.history, mask),
        screenRows: uncertifiedRows(capture.frame.cells.map(cells => ({ cells, softWrap: false })), mask),
      };
      if (this.closed) return;
      const committed = await this.ports.calibrate({ capture, checks: match.checks, contentMatches: match.contentMatches, repairs: match.repairs, expectedRevision: read.revision, captureEvidence, ...(uncertifiedStyle ? { uncertifiedStyle } : {}) });
      if (this.closed) return;
      if (!committed) { this.forceFull = true; this.mode = 'PIPE'; this.latchAt = undefined; return; }
      // Only the transaction revision is published. A concurrent lifecycle event
      // suppresses this result and requests another capture, never an old frame.
      if (startedGeneration !== this.eventGeneration) { this.enterCapture(); return; }
      const latest = this.ports.read();
      // A screen-only capture carries no history evidence; remembering its
      // empty match would erase the seed of the incremental chain.
      if (matched) this.matcher.remember(recent, certified, match);
      // The pipe always owns the next frame: a committed capture ends any
      // lifecycle latch, and a mismatch is corrected by the next capture
      // instead of freezing pipe publishes (FIX1-PLAN §1.2, never blank).
      this.mode = 'PIPE'; this.latchAt = undefined; this.degraded = false;
      // Publish only the frame the store committed, and only if nothing newer
      // arrived since: a later byte or revision already supersedes it.
      if (captureEvidence.kind === 'quiescent' && latest.revision === committed.revision && latest.parserFrame.receiveSeq === receiveSeq) {
        this.pendingPipe = undefined; this.nextPipePublish = Infinity;
        this.ports.publish(committed, capture.frame);
        // A parser frame without rows makes no screen claim to compare.
        diverged = latest.parserFrame.cells.length === capture.frame.cells.length && !equalCalibrationFrames(latest.parserFrame, capture.frame, mask);
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
      if (!this.closed) this.ports.fault({ kind: 'capture-fault', at: this.ports.now(), missingCount: null });
    } finally {
      this.inFlight = false; this.lastCaptureAt = anchor;
      if (this.closed) return;
      const at = this.ports.now();
      if (this.latchAt !== undefined && at - this.latchAt > 1000 && !this.degraded) {
        this.degraded = true;
        this.ports.fault({ kind: 'capture-latch-degraded', at, missingCount: null });
      }
      // A divergence is recaptured fast only where someone sees the screen.
      const interval = !successful || this.mode === 'CAPTURE' || (diverged && this.viewed) ? CAPTURE_CADENCE.eventMs
        : !this.viewed ? CAPTURE_CADENCE.unviewedMs
        : at - this.outputAt <= CAPTURE_CADENCE.activeMs ? CAPTURE_CADENCE.activeMs : CAPTURE_CADENCE.idleMs;
      // An event timer may have fired while capture was in flight. Re-arm
      // explicitly, and retain the 50ms minimum between capture starts.
      this.deadline = Math.max(now + 50, Math.min(this.deadline, Math.max(at, anchor + interval)));
      this.ports.schedule(this.dueAt);
    }
  }
}
