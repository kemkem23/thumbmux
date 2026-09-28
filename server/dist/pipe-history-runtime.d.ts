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
import { PipeHistoryCollector, type PipeFrameEvent } from './pipe-history-collector';
import { PipeVtPool, type PipeVtAssets, type PipeVtRow } from './pipe-vt-worker';
import { HistoryCalibrator } from './history-calibrator';
import { HistoryWatchdog } from './history-watchdog';
import type { HistoryCell, HistoryRow } from './history-row-matcher';
import { createProjectionStore as createProjectionStoreValue } from './sqlite-history/projection-store';
import { pipeVtAssets as pipeVtAssetsValue, verifyPipeVtAssets as verifyPipeVtAssetsValue } from './pipe-vt-worker';
import { type PaneKey, type PhysicalRow, type ProjectionHealth, type ProjectionIssue, type ProjectionToken, type ProjectionWriterPort } from './sqlite-history/types';
/** Fail-closed handshake for hosts loading this optional runtime entrypoint. */
export declare const PIPE_HISTORY_RUNTIME_CAPABILITY: Readonly<{
    wire: "newarch-frame-v1";
    projectionSchema: 4;
    metadataRevision: true;
    archiveReadVersions: readonly [2, 3];
}>;
/** The xterm 256 table pyte uses for `38;5;N` (pyte/graphics.py FG_BG_256). */
export declare const XTERM_256: readonly string[];
/**
 * pyte colour -> capture namespace. pyte turns every `38;5;N` and `38;2;r;g;b`
 * into a hex string, so an index is recoverable only for the 16 base colours;
 * palette colours 16-255 compare as rgb on both sides (see canonicalCaptureColor).
 */
export declare function canonicalParserColor(value: string): string;
/** Capture colour -> the same namespace: palette 16-255 become their rgb value. */
export declare function canonicalCaptureColor(value: string): string;
/** Capture style bits the parser can also observe: bold, italic, underline, blink, reverse, strike. */
export declare const OBSERVED_STYLE_MASK: number;
/** pyte attrs (bold 1, italics 2, underscore 4, strike 8, reverse 16, blink 32) -> capture bits. */
export declare function parserStyle(attrs: number): number;
export declare const BLANK_CELL: HistoryCell;
export declare function parserRowCells(row: PipeVtRow, cols?: number): HistoryCell[];
/** Decoder cells (tmux-capture-normalize) -> canonical cells. */
export declare function canonicalCaptureCells(row: readonly Readonly<HistoryCell>[], cols: number): HistoryCell[];
/** Text of a physical row: a pure function of its cells (store `check-not-exact` compares it). */
export declare function rowText(cells: readonly HistoryCell[]): string;
export declare function toPhysicalRow(cells: readonly HistoryCell[]): PhysicalRow;
/** Self-contained ANSI line (legacy viewers read one line at a time); trailing default blanks trimmed. */
export declare function cellsToAnsi(cells: readonly HistoryCell[]): string;
/** Metadata the host reads from tmux for a pane (list-panes / display-message). */
export interface PaneTmuxMeta {
    cols: number;
    rows: number;
    alternate: boolean;
    cursor: {
        x: number;
        y: number;
        visible: boolean;
    };
    historySize: number;
    historyLimit: number;
    panePid: number;
    mouseSgr: boolean;
    mouseAny: boolean;
}
/** One capture-pane -p -e -N body bracketed by metadata read in the same tmux client. */
export interface RawPaneCapture {
    captureId: string;
    requestedAt: number;
    completedAt: number;
    before: PaneTmuxMeta;
    after: PaneTmuxMeta;
    /** Physical rows: `tail` history rows (or fewer) then the screen rows. */
    body: string;
    tail: number;
}
export type RuntimeStore = ProjectionWriterPort & {
    token(key: PaneKey): ProjectionToken;
    /** One pane's slice of health(); a store without it is read through health(). */
    paneHealth?(key: PaneKey): {
        status: 'healthy' | 'degraded';
        issues: ProjectionIssue[];
    } | null;
};
export interface RuntimeFault {
    paneKey: PaneKey;
    session: string;
    kind: string;
    at: number;
    message?: string;
    missingCount: number | null;
    receiveSeqFrom?: number;
    receiveSeqTo?: number;
}
export interface PaneUpdate {
    source: 'pipe' | 'tmux-calibrated' | 'issue';
    revision: number;
}
/**
 * History rows a calibrated screen shows again: tmux pulled them back from
 * history when the pane grew. `rows` rows ending before line id `endLine`.
 */
export interface PulledBack {
    rows: number;
    endLine: number;
}
export interface PaneView {
    paneKey: PaneKey;
    session: string;
    cells: readonly (readonly HistoryCell[])[];
    cursor: {
        x: number;
        y: number;
        visible: boolean;
    } | null;
    kind: 'normal' | 'alternate';
    cols: number;
    rows: number;
    displaySource: 'pipe' | 'tmux-calibrated' | 'none';
    token: ProjectionToken | null;
    sourceEpoch: number;
    geometryGeneration: number;
    mouseSgr: boolean;
    mouseAny: boolean;
    degraded: boolean;
    issues: ProjectionIssue[];
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
    eventId: string;
    kind: string;
    reason: string;
    boundaryLineId: number | null;
    detectedAt: number;
}
export interface PaneStats {
    received: number;
    published: number;
    latencyMs: number[];
    captures: number;
    captureFaults: number;
    captureConflicts: number;
    screenCalibrations: number;
    storeCommits: number;
    skippedCommits: number;
    notReady: number;
    captureIntervalMaxMs: number;
    captureAt: number[];
    faults: Record<string, number>;
}
export interface PipeHistoryPaneOptions {
    paneKey: PaneKey;
    session: string;
    meta: PaneTmuxMeta;
    sourceEpoch?: number;
    scrollOnClear?: boolean;
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
/** Minimum spacing of full-screen writes to the store per pane (leading edge immediate). */
export declare const FRAME_WRITE_MS = 16;
/** A screen refused for pressure (or a paused store) is offered again after this long, never at once. */
export declare const FRAME_PRESSURE_RETRY_MS = 50;
/**
 * A frame is written (and published) as soon as it arrives while the frame
 * path — store write plus viewer publish, timed on the main thread — uses less
 * than this share of wall time; above it every pane falls back to one write per
 * FRAME_WRITE_MS. The fixed spacing alone was most of receive→publish at one
 * busy pane (P trace: 14.8 of 21.7 ms at p95), while 21 busy panes still need it.
 * The share never lowers the publish rate below the fixed-spacing rule.
 */
export declare const FRAME_BUDGET_SHARE = 0.3;
/** Exponentially decayed main-thread cost of the frame path (time constant FRAME_BUDGET_WINDOW_MS). */
export declare class FrameBudget {
    private readonly clock;
    private load;
    private at;
    constructor(clock?: () => number);
    private decay;
    spend(ms: number): void;
    /** Share of the main thread the frame path used recently (steady rate → share). */
    share(): number;
    busy(): boolean;
}
/**
 * Drop the oldest entries of a statistics ring: beyond `limit` (amortized, a
 * quarter at a time) and, every 1024 entries, those stamped before `floor`.
 * `times[i]` is the stamp of `values[i]` (the same array for timestamp rings).
 */
export declare function trimStatsRing(values: unknown[], times: number[], limit: number, floor: number): void;
interface ParserScreen {
    cols: number;
    rows: number;
    cells: HistoryCell[][];
}
/** Apply one delta (shift first, then dirty rows) without mutating `screen`. */
export declare function applyFrameDelta(screen: ParserScreen | undefined, cells: PipeFrameEvent['cells']): {
    screen: ParserScreen;
    complete: boolean;
};
interface RingRow extends HistoryRow {
    ansi?: string;
}
export declare class PipeHistoryPane {
    private readonly runtime;
    private readonly options;
    readonly paneKey: PaneKey;
    readonly session: string;
    readonly collector: PipeHistoryCollector;
    readonly calibrator: HistoryCalibrator | null;
    readonly watchdog: HistoryWatchdog;
    private screens;
    private parserKind;
    private parserCursor;
    private displayed;
    /** History rows tmux shows on screen again, by tmux's own counters (see resizePullback). */
    private pulled;
    /** Pull-back state as of the newest capture's metadata; the capture it came with may be published. */
    private capturedPull;
    private historySizeUnknown;
    private ring;
    /** Bumped whenever a ring row's content is replaced (a live window text built before is stale). */
    ringRepairs: number;
    private scrollSeq;
    private scrollSeqEpoch;
    private received;
    private receiveTimes;
    private receiveHead;
    /** Stamps (runtime.now) of stats.latencyMs, index for index; reset when the host replaces the array. */
    private latencyAt;
    private latencyRef;
    private listeners;
    private meta;
    private decoder;
    private closed;
    private lastCaptureAt;
    private lastStoreCommitAt;
    private skippedCommit;
    /** Line ids some committed calibration already checked or content-matched. */
    private certified;
    private pendingPublish;
    private pendingFrame;
    private frameTimer;
    private frameWriting;
    private lastFrameWriteAt;
    /** Earliest re-offer of a screen the store refused (see FRAME_PRESSURE_RETRY_MS). */
    private frameBackoffUntil;
    private pendingIssues;
    /** Storage-fault marker shown while the store cannot write (see StorageOverlay). */
    private overlay;
    /** Pending seed→pipe gap marker (see armSeedGap). */
    private seedGap;
    readonly stats: PaneStats;
    constructor(runtime: PipeHistoryRuntime, options: PipeHistoryPaneOptions);
    start(): Promise<void>;
    /** Raw pipe bytes; false means wait for drained() before reading more. */
    ingest(bytes: Uint8Array): boolean;
    drained(): Promise<void>;
    receiveCounter(): number;
    /**
     * Attach mid-stream only: give a fresh parser the screen tmux shows now,
     * once, BEFORE the first pipe byte. Without it the parser starts blank and
     * every pipe frame would redraw a mostly empty screen over the real one.
     * This is not calibration: calibration captures are never fed to the
     * parser; a seed after any pipe byte is refused. Output between this
     * capture and the pipe start is not journaled (the host marks it).
     */
    seed(raw: string, meta: PaneTmuxMeta): void;
    /**
     * The same seed for a pipe the host restarts in a new source epoch (after a
     * storage pause): the caller has already called beginSourceEpoch, so the
     * reset parser receives tmux's current screen before the first pipe byte.
     */
    reseed(raw: string, meta: PaneTmuxMeta): void;
    /**
     * Output between the seed capture and the pipe start is never journaled.
     * On a normal screen the seed's rows above the cursor are complete and
     * scroll first; the first pipe byte lands on the cursor row. So the unknown
     * run sits exactly `cursor.y` rows after the pane's next line id at seed
     * time: the marker is placed there, just before that row is offered, not at
     * the seed's first row (where it would sit before rows that were kept).
     */
    private armSeedGap;
    private recordSeedGap;
    private onScroll;
    private remember;
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
    private onFrame;
    private scheduleFrameWrite;
    private writeFrame;
    private publishPipe;
    /** Close the latency entry of every received chunk up to `receiveSeq`: the viewer now sees it. */
    private settleReceipts;
    /** Close entries older than RECEIVE_MAX_AGE_NS: their age so far is recorded, never dropped silently. */
    private expireReceipts;
    private compactReceipts;
    private sampleLatency;
    /** Received chunks whose latency entry is still open (not yet on a published screen). */
    pendingReceipts(): number;
    private onCollectorFault;
    /** Every fault goes to the host sink; a pane-level marker goes to the journal. */
    private onRuntimeFault;
    recordIssue(kind: string, reason: string, missingCount: number | null, recoverable?: boolean): void;
    private bump;
    /**
     * Metadata the host read from tmux. The pane follows geometry changes,
     * rotates its source epoch when tmux restarted the pane process (the
     * terminal was re-initialised under the parser), and marks an external
     * clear-history. Only observable events are handled: `send-keys -R` leaves
     * no trace in this metadata (D35 debt).
     */
    observe(meta: PaneTmuxMeta): void;
    currentMeta(): PaneTmuxMeta;
    private tokenOrNull;
    private read;
    private metadata;
    private capture;
    private commitCalibration;
    private countCapture;
    private publishCapture;
    /** Runtime tick: flush a pipe frame held while the calibrator was latched. */
    tick(): void;
    setViewers(count: number): void;
    subscribe(listener: (update: PaneUpdate) => void): () => void;
    private notify;
    health(health?: ProjectionHealth): {
        degraded: boolean;
        issues: ProjectionIssue[];
    };
    /**
     * FIX1 §3.2 (7): show (or clear) the storage-fault gap marker. It is part of
     * every view and page until cleared, independent of the store, and its
     * revision is the pane revision it was raised at, so a later durable marker
     * always moves metadataRevision forward.
     */
    setStorageOverlay(marker: StorageOverlay | null): void;
    storageOverlay(): ProjectionIssue | null;
    /**
     * While storage is paused the pipe is stopped, so the screen would freeze on
     * the last journaled frame. The host shows what tmux shows instead: decoded
     * like a calibration capture, published, never stored and never certified.
     */
    showUnstored(raw: RawPaneCapture): void;
    view(health?: ProjectionHealth): PaneView;
    /** Accepted history rows still in RAM, oldest first, with their cached ANSI text. */
    recentRows(): readonly RingRow[];
    /** Forward page read (L1 contract) at one token; retried while the revision moves. */
    readRange(start: number, end: number): {
        lines: string[];
        startLine: number;
        issues: ProjectionIssue[];
        token: ProjectionToken;
    } | null;
    /**
     * FIX1 §3.2 Q→H: the consumer fence a pipe stop waits for after FIFO EOF.
     * Every admitted chunk acknowledged by the parser, the newest screen handed
     * to the store, then the store's durable barrier at that revision. A parser
     * ACK is never reported as a DB commit: `durableRevision` is what the store
     * confirmed on disk, and anything short of that inside `timeoutMs` is an
     * unknown tail with the fence that did not close.
     */
    drainReceipt(timeoutMs?: number): Promise<{
        lastAdmittedSequence: number | null;
        lastAckedSequence: number | null;
        ramRevision: number | null;
        durableRevision: number | null;
        issues: string[];
        unknownTail: boolean;
    }>;
    close(): Promise<void>;
}
export declare class PipeHistoryRuntime {
    readonly options: PipeHistoryRuntimeOptions;
    readonly parserPool: PipeVtPool | undefined;
    readonly store: RuntimeStore;
    readonly now: () => number;
    readonly nowNs: () => bigint;
    /** Main-thread cost of every pane's frame path (see FRAME_BUDGET_SHARE). */
    readonly frameBudget: FrameBudget;
    private readonly panesByKey;
    private timer;
    private heartbeat;
    private armedAt;
    private closed;
    constructor(options: PipeHistoryRuntimeOptions);
    addPane(options: PipeHistoryPaneOptions): Promise<PipeHistoryPane>;
    pane(key: PaneKey): PipeHistoryPane | undefined;
    panes(): PipeHistoryPane[];
    removePane(key: PaneKey): Promise<void>;
    emit(fault: RuntimeFault): void;
    /** One timer for every calibrator deadline (the host's deadline queue). */
    arm(): void;
    private runDue;
    close(): Promise<void>;
}
export declare const keyOf: (key: PaneKey) => string;
export declare function createPipeHistoryRuntime(options: PipeHistoryRuntimeOptions): PipeHistoryRuntime;
/** Pooled percentile over raw samples (never an average of per-pane percentiles). */
export declare function pooledPercentile(samples: readonly number[], p: number): number | null;
export interface ProjectedPaneSnapshot {
    content: string;
    cursor: {
        row: number;
        col: number;
    } | null;
    screen: {
        alt: boolean;
        mouseSgr: boolean;
        mouseAny: boolean;
    };
    boundary: {
        generation: string;
        liveStartLine: number;
        walSequence: string;
        walOffset: number;
    };
    newarch: {
        v: 'newarch-frame-v1';
        paneKey: PaneKey;
        sourceEpoch: number;
        geometryGeneration: number;
        routeGeneration: number;
        metadataRevision: number;
        cols: number;
        rows: number;
        revision: number;
        durableRevision: number;
        nextLineId: number;
        liveStartLine: number;
        displaySource: 'pipe' | 'tmux-calibrated';
        degraded: boolean;
        markers: Array<{
            lineId: number | null;
            kind: string;
            missingCount: number | null;
        }>;
    };
}
export interface ProjectedHistoryPage {
    lines: string[];
    startLine: number | null;
    hasMore: boolean;
    /** Loss / unverified-reset markers whose boundary falls inside this page. */
    markers: Array<{
        lineId: number | null;
        kind: string;
        reason: string;
        missingCount: number | null;
    }>;
}
/**
 * Rows tmux pulled back from history onto the screen between two metadata
 * reads: `history_size` before minus after, clamped to [0, rows added]. Only
 * tmux's own counters count; content equality is never evidence (a program
 * may print the same row twice). null when either history_size is unreadable.
 */
export declare function resizePullback(before: Pick<PaneTmuxMeta, 'rows' | 'historySize' | 'alternate'>, after: Pick<PaneTmuxMeta, 'rows' | 'historySize' | 'alternate'>): number;
/**
 * How many of the newest history rows the displayed screen shows again. The
 * number comes from the pane's tmux-counter bookkeeping (resizePullback), and
 * only a tmux-calibrated normal screen can hold such rows.
 */
export declare function screenOverlap(view: Pick<PaneView, 'displaySource' | 'kind' | 'pulledBack'>): number;
/**
 * The live window a viewer receives: history rows from `liveStartLine` (held
 * in the pane's RAM ring) followed by the displayed screen. The start only
 * moves forward, and only in whole windows, so between moves every update is
 * an append and the mux sends a small delta. Older rows are served as pages
 * whose line numbers are projection line ids (one token per page).
 */
export declare class ProjectionLiveWindow {
    private readonly windowRows;
    private starts;
    /** Per pane: the joined history part of the last live window, extended while only rows are appended. */
    private texts;
    constructor(windowRows?: number);
    snapshot(pane: PipeHistoryPane, routeGeneration: number): ProjectedPaneSnapshot | null;
    /**
     * `rows` joined by newlines, equal to a fresh join. While the window start,
     * the hidden pull-back range and every row already joined stay the same,
     * only the rows appended since are encoded and joined (a publish at 100
     * rows/s re-joined up to 2,000 rows each time).
     */
    private historyText;
    /** Rows before `beforeLine` (default: the live window start), newest `limit` of them. */
    readBefore(pane: PipeHistoryPane, beforeLine: number | null, limit?: number): ProjectedHistoryPage;
    /** Rows after `afterLine` (exclusive), up to the live window start. */
    readAfter(pane: PipeHistoryPane, afterLine: number | null, limit?: number): ProjectedHistoryPage;
    private page;
    forget(pane: PaneKey): void;
}
/** The projection store (L1/I2) this runtime writes to. */
export declare const createProjectionStore: typeof createProjectionStoreValue;
/** VT worker assets beside this module (dist or source) and their pinned-hash check. */
export declare const pipeVtAssets: typeof pipeVtAssetsValue;
export declare const verifyPipeVtAssets: typeof verifyPipeVtAssetsValue;
export {};
