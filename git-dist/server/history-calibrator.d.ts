import { type CapturedRow, type HistoryCell, type HistoryRow, type RowMatch } from './history-row-matcher.js';
export interface PaneKey {
    serverIdentity: string;
    paneId: string;
    birthGeneration: number;
}
export interface CalibrationFrame {
    cells: readonly (readonly HistoryCell[])[];
    cursor: {
        x: number;
        y: number;
        visible: boolean;
    } | null;
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
    sourceEpoch: number;
    geometryGeneration: number;
    cols: number;
    rows: number;
    kind: 'normal' | 'alternate';
    cursor: CalibrationFrame['cursor'];
}
export interface CalibrationCapture {
    paneKey: PaneKey;
    captureId: string;
    requestedAt: number;
    completedAt: number;
    before: CaptureMetadata;
    after: CaptureMetadata;
    frame: CalibrationFrame;
    history: readonly CapturedRow[];
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
export type CaptureEvidence = {
    kind: 'quiescent';
    sourceEpoch: number;
    geometryGeneration: number;
    receiveSeqBefore: number;
    receiveSeqAfter: number;
    uncertainRows?: readonly number[];
} | {
    kind: 'unfenced';
    reason: string;
};
export interface CalibrationSnapshot {
    revision: number;
    sourceEpoch: number;
    geometryGeneration: number;
    recentHistory: readonly HistoryRow[];
    parserFrame: CalibrationFrame;
    /** Line id of the newest recent row at read time (null: none). When given,
     * the pre-capture fence never reads `recentHistory`, so a port that copies
     * its ring lazily copies it once per capture, not per read. */
    recentLastLineId?: number | null;
}
export interface CalibrationCommit {
    revision: number;
    durableRevision: number;
    nextLineId: number;
}
export interface CalibrationPorts {
    now(): number;
    /** Same clock domain as now(); returns an idempotent cancellation callback. */
    timeout?(callback: () => void, delayMs: number): () => void;
    capture(paneKey: PaneKey, tailLimit: number, signal?: AbortSignal): Promise<CalibrationCapture>;
    schedule(deadline: number): void;
    read(): CalibrationSnapshot;
    calibrate(input: {
        capture: CalibrationCapture;
        checks: RowMatch['checks'];
        contentMatches: RowMatch['contentMatches'];
        repairs: RowMatch['repairs'];
        expectedRevision: number;
        captureEvidence: CaptureEvidence;
        /** Present only with `certifiedStyleMask`: captured rows (history index /
         * screen row) holding style bits outside the mask. Their cells are kept
         * and drawn in full fidelity; the claim about those bits is uncertain. */
        uncertifiedStyle?: {
            mask: number;
            historyRows: readonly number[];
            screenRows: readonly number[];
        };
    }): Promise<CalibrationCommit | null>;
    /** Called only with a frame the store committed in `commit`. */
    publish(commit: CalibrationCommit, frame: CalibrationFrame): void;
    fault(issue: {
        kind: string;
        at: number;
        missingCount: null;
    }): void;
}
/** Frames equal in every field; with `styleMask`, style bits outside it are
 * not compared (a comparator restriction only, never applied to drawn cells). */
export declare function equalCalibrationFrames(a: CalibrationFrame, b: CalibrationFrame, styleMask?: number): boolean;
export type CalibrationEvent = 'birth' | 'reconnect' | 'resize' | 'clear' | 'alt' | 'fault';
/** Capture cadence (I4-FIX1-PLAN §5.4). A pane with a viewer calibrates the
 * displayed screen: 200ms while output flows, 1s when idle. A pane without a
 * viewer keeps every row through the pipe and only needs history evidence:
 * one capture per 5s. Lifecycle events are 50ms either way. */
export declare const CAPTURE_CADENCE: {
    readonly eventMs: 50;
    readonly activeMs: 200;
    readonly idleMs: 1000;
    readonly unviewedMs: 5000;
    readonly deadlineMs: 1000;
};
export interface CalibratorOptions {
    historyLimit?: number;
    incremental?: boolean;
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
export declare class HistoryCalibrator {
    readonly paneKey: PaneKey;
    private ports;
    private options;
    private matcher;
    mode: 'PIPE' | 'CAPTURE';
    private deadline;
    private lastCaptureAt;
    private lastHistoryAt;
    private outputAt;
    private forceFull;
    private eventGeneration;
    private scrolls;
    private inFlight;
    private latchAt;
    private degraded;
    private nextPipePublish;
    private pendingPipe;
    private viewers;
    private closed;
    /** Aborts the capture in flight (deadline or close). */
    private abortInFlight;
    constructor(paneKey: PaneKey, ports: CalibrationPorts, options?: CalibratorOptions);
    get dueAt(): number;
    get acceptsPipeFrame(): boolean;
    get capturing(): boolean;
    private get viewed();
    private checkViewers;
    /** Host viewer count for this pane. A pane gaining its first viewer is
     * captured now (history included), so its screen is fresh within one
     * capture deadline instead of waiting out the unviewed period. */
    setViewers(count: number): void;
    /** Stops this pane: aborts the capture in flight (its signal fires now),
     * never commits or publishes a result that lands later, and schedules
     * nothing again. Idempotent. */
    close(): void;
    output(publishPipe?: () => void): void;
    scroll(count?: number): void;
    event(_kind: CalibrationEvent): void;
    private request;
    private enterCapture;
    runDue(): Promise<void>;
}
