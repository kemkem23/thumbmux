import { type Socket } from "node:net";
/**
 * Host side of the NEWARCH L2-P VT worker (`pipe-vt-worker.py`).
 *
 * The host never decodes pipe bytes: each chunk is framed as-is with its
 * receive sequence and the Python worker feeds one incremental pyte stream,
 * so UTF-8 and escape sequences may split anywhere. The worker answers with
 * `U` updates carrying scrolled rows (always before the frame of the same
 * update, and before pyte drops them) and the dirty rows of the screen.
 *
 * Host->worker input goes through a private FIFO written with non-blocking
 * writeSync, not the child's stdin: measured on Bun 1.3.11, 100 small
 * stdin writes/s cost ~20% of a core in the host, the FIFO ~2.6%.
 */
export { PIPE_VT_LICENSE_FILE, PIPE_VT_VENDOR_FILE, PIPE_VT_VENDOR_SHA256, PIPE_VT_WORKER_FILE } from "./pipe-vt-assets";
/**
 * [fg, bg, attrs bitmask, cells]. `cells` is a string when every cell is a
 * single BMP code unit of width 1 (one UTF-16 unit per cell), otherwise one
 * grapheme per cell with "" as the stub cell of a wide glyph. The compact
 * form keeps plain rows to a few strings instead of one string per cell.
 */
export type PipeVtRun = [fg: string, bg: string, attrs: number, cells: string | string[]];
export type PipeVtRow = PipeVtRun[];
/** One entry per terminal cell, whichever form the run uses. */
export declare function pipeVtRunCells(run: PipeVtRun): string[];
export declare const PIPE_VT_ATTR: {
    readonly bold: 1;
    readonly italics: 2;
    readonly underscore: 4;
    readonly strikethrough: 8;
    readonly reverse: 16;
    readonly blink: 32;
};
export type PipeVtScroll = {
    /** Event that finalized this row, distinct from its original write seq. */
    packetEpoch?: number;
    packetSeq?: number | null;
    scrollOrdinal?: number | null;
    row: PipeVtRow;
    /** Row continues into the next physical row (soft wrap). */
    wrap: boolean;
    /** Last cell is blank padding left by a wide glyph that wrapped. */
    pad: boolean;
    gen: number;
    seq: number | null;
    epoch: number;
};
export type PipeVtCursor = {
    x: number;
    y: number;
    visible: boolean;
};
export type PipeVtFrame = {
    kind: "normal" | "alternate";
    cols: number;
    rows: number;
    full: boolean;
    /** Rows the screen scrolled up by before `dirty` applies (0 when full). */
    shift: number;
    dirty: Record<string, PipeVtRow>;
    wraps: Record<string, boolean>;
    pads: number[];
    cursor: PipeVtCursor;
};
export type PipeVtUpdate = {
    epoch: number;
    scrollOnClear: boolean | null;
    seqFrom: number | null;
    seqTo: number | null;
    gen: number;
    scrolls: PipeVtScroll[];
    frame: PipeVtFrame;
    parseNs: number;
    encodeNs: number;
    /** Worker stage durations (absent from workers older than P2 diagnostics). */
    stages?: PipeVtWorkerStages;
    /** json.dumps + UTF-8 of this update's own body, in the worker. */
    serializeNs?: number;
};
/**
 * Worker-side durations for the D frames acknowledged by one update, each on
 * the worker's monotonic clock. `waitNs` is how long the oldest D frame sat
 * complete in the worker before dispatch (fairness / budget wait), `holdNs`
 * that frame's completion -> emit start (wait + parse of every frame + the
 * coalescing window). Kernel socket/FIFO buffering before the worker read is
 * outside every worker stage and lands in the host's transport residual.
 */
export type PipeVtWorkerStages = {
    inFrames: number;
    inBytes: number;
    waitNs: number;
    maxWaitNs: number;
    holdNs: number;
    /**
     * Bounds on how late the read that completed the oldest frame came after
     * its bytes became readable: lower = sibling channels served earlier in the
     * same poll turn, upper = the loop-busy window since the previous poll (a
     * blocked poll counts only its own wait). Both sit inside `transportMs`.
     */
    readLagNs: number;
    readLagMaxNs: number;
};
/**
 * One update's path, host clock (ms) for host spans, worker durations as
 * reported. Spans nest, so the stages do not sum across different updates:
 *   feed(seqFrom) ─ worker hold ─ encode ─ serialize ─ arrival ─ mainQueue ─ decode ─ consumer
 * `transportMs` = feedToArrival - (hold + encode + serialize): host write
 * buffering, kernel socket/FIFO (including `readLag*` — the shared loop busy
 * with sibling panes), worker output buffering and event-loop delivery. It is a residual of nested durations, never a clock difference.
 * The old driver's "parse" (ingest -> onFrame) is feedToArrival + mainQueue +
 * decode + (part of) consumer, not parser CPU time; parser CPU is `worker.parseNs`.
 */
export type PipeVtStageTrace = {
    seqFrom: number | null;
    seqTo: number | null;
    epoch: number;
    /** Fed D frames whose seq this update acknowledged (0 for partial emits). */
    matchedFeeds: number;
    /** I2: join with driver pane/session + epoch + these inclusive feed bounds. */
    matchedSeqFrom: number | null;
    matchedSeqTo: number | null;
    clockDomain: "host-performance-ms";
    host: {
        firstFeedAt: number | null;
        arrivedAt: number;
        decodeStartedAt: number;
        decodedAt: number;
        consumedAt: number;
    };
    consumerSucceeded: boolean;
    /** Cumulative missing observations; never treat these as zero latency. */
    traceDropped: number;
    traceEpochCensored: number;
    bodyBytes: number;
    /** Host feed of the oldest / newest matched seq -> arrival of the completing chunk. */
    feedToArrivalMs: number | null;
    lastFeedToArrivalMs: number | null;
    /** Arrival -> start of this update's decode: waits behind earlier consumers. */
    mainQueueMs: number;
    decodeMs: number;
    /** onUpdate call until its receipt settled. */
    consumerMs: number;
    /** Oldest matched feed -> consumer settled (the host-visible end to end). */
    feedToConsumedMs: number | null;
    transportMs: number | null;
    worker: PipeVtWorkerStages & {
        parseNs: number;
        encodeNs: number;
        serializeNs: number;
    } | null;
};
export type PipeVtReady = {
    vendorSha256: string;
    cols: number;
    rows: number;
    pid: number;
};
export type PipeVtFault = {
    kind: "worker-exit" | "worker-error" | "protocol" | "vendor-hash" | "spawn" | "clear-policy-unknown" | "shutdown-timeout";
    at: number;
    message: string;
};
export type PipeVtDrainReceipt = {
    workerEof: boolean;
    outputDrained: boolean;
    issues: string[];
    unknownTail: boolean;
};
export type PipeVtAssets = {
    worker: string;
    vendor: string;
    license: string;
};
export declare function pipeVtAssets(directory?: string): PipeVtAssets;
/** Refuse to start on a vendor archive other than the pinned one. */
export declare function verifyPipeVtAssets(assets: PipeVtAssets): string;
export type PipeVtWorkerOptions = {
    pool?: PipeVtPool;
    sourceEpoch?: number;
    onHistoryClear?: (event: {
        seq: number;
        epoch: number;
    }) => unknown;
    cols: number;
    rows: number;
    onUpdate: (update: PipeVtUpdate) => unknown;
    onFault: (fault: PipeVtFault) => void;
    assets?: PipeVtAssets;
    python?: string;
    now?: () => number;
    /**
     * Diagnostics only: called after each update's consumer settled. Without it
     * no feed timestamps are kept. Never throws into the pipe path.
     */
    onStageTrace?: (trace: PipeVtStageTrace) => void;
    /** Monotonic ms clock for stage traces (default performance.now). */
    traceNow?: () => number;
};
/** Feed timestamps kept for tracing; older ones are dropped and counted. */
export declare const PIPE_VT_TRACE_PENDING_MAX = 8192;
/** Data frames share this budget; control frames (Z/F/X/C/Q) never compete for it. */
export declare const PIPE_VT_DATA_QUEUE_BYTES: number;
/** Extra room reserved for control frames only, on top of the data budget. */
export declare const PIPE_VT_CONTROL_RESERVE_BYTES: number;
type SharedLease = {
    socket: Socket;
    pid: number;
    done: Promise<void>;
    release(): Promise<void>;
    kill(signal: NodeJS.Signals): void;
};
/** One interpreter, independent bounded duplex channels and parser state per pane.
 * A dead generation is never reused. Every attached socket sees EOF on process
 * death, so every collector emits its own loss marker and restarts its epoch.
 */
export declare class PipeVtPool {
    private readonly options;
    private current;
    private generations;
    private closed;
    constructor(options?: {
        assets?: PipeVtAssets;
        python?: string;
    });
    private launch;
    acquire(): Promise<SharedLease>;
    close(): Promise<void>;
}
export declare class PipeVtWorker {
    private readonly options;
    private lease;
    private socket;
    /** Set only after Q was parsed and every final update was written before B. */
    private quitAck;
    private leaseDone;
    private child;
    private pending;
    private closing;
    private exited;
    private readyResolve;
    private readyReject;
    private exitWaiters;
    private inputDir;
    private inputFd;
    private queue;
    private queuedBytes;
    private outputTail;
    private outputPendingBytes;
    private outputPaused;
    /** Set after a bounded close gave up on the consumer: later output is dropped. */
    private abandoned;
    private closePromise;
    private flushTimer;
    /** Traced feeds not yet acknowledged: parallel seq / host-time columns. */
    private traceSeqs;
    private traceTimes;
    private traceEpochs;
    private traceEpochCensored;
    private traceHead;
    private traceDropped;
    readonly ready: Promise<PipeVtReady>;
    pid: number | null;
    constructor(options: PipeVtWorkerOptions);
    private notifyFault;
    private startShared;
    start(): Promise<PipeVtReady>;
    private receiveOutput;
    /** A channel failure never kills sibling parsers; kill() is the process fault hook. */
    private terminateChannel;
    private releaseOutput;
    inputBacklogBytes(): number;
    /** Unprocessed worker output bytes (test observability). */
    outputBacklogBytes(): number;
    /** Traced feeds awaiting acknowledgement, and feeds dropped from tracing. */
    traceBacklog(): {
        pending: number;
        dropped: number;
        retained: number;
        epochCensored: number;
    };
    private traceClock;
    private traceFeed;
    /** Keep both columns within twice the pending window. */
    private compactTrace;
    /** Only the same epoch can acknowledge a feed; superseded feeds are censored. */
    private traceAck;
    private emitTrace;
    private onStdout;
    private write;
    /** Write queued frames; a full FIFO (EAGAIN) retries shortly, never drops. */
    private flush;
    private releaseInput;
    /** Forward raw pipe bytes untouched; `seq` is the receive sequence. */
    canAccept(bytes: number): boolean;
    feed(seq: number, bytes: Uint8Array, epoch?: number): boolean;
    setScrollOnClear(enabled: boolean): boolean;
    /** Ordered parser reset: unlike RIS, drops alt, decoder, DCS and saved modes. */
    reset(epoch: number): boolean;
    resize(cols: number, rows: number, geometryGeneration: number): boolean;
    /** Stream-first resize is ordered in the SAME namespace as byte packets.
     * Legacy resize remains available; its output is not a v1 event proof. */
    resizePacket(seq: number, epoch: number, cols: number, rows: number, generation: number): boolean;
    requestFull(seq: number): boolean;
    /**
     * Drain queued input, flush the last update, then wait for exit and for
     * every already-read update to be consumed. Both waits are bounded: a
     * consumer receipt that never settles ends in a `shutdown-timeout` fault
     * and the remaining output is dropped, so close always returns.
     */
    close(timeoutMs?: number): Promise<PipeVtDrainReceipt>;
    private settleOutput;
    /** Test/fault hook: kill the worker without the orderly quit frame. */
    kill(signal?: NodeJS.Signals): void;
}
/** Stateless J requests share the existing multiplex worker. I owns socket
 * routing and cancellation; C owns the candidate state and synchronous install.
 * The transport must reserve request/reply bytes and retire a cancelled RPC
 * before resolving. It must never route speculative U/H to live consumers. */
export type CaptureVtRowPage = {
    readonly scrolls: readonly import('./stream-contract').RowContent[];
    readonly startOrdinal: number;
    readonly nextOrdinal: number;
    readonly chargedBytes: number;
} & ({
    readonly complete: false;
} | {
    readonly complete: true;
    readonly state: import('./stream-contract').VtState;
    readonly frame: import('./stream-contract').FrameDelta;
});
export type CaptureVtStreamStep = {
    readonly startOrdinal: number;
    readonly nextOrdinal: number;
    readonly chargedBytes: number;
    readonly scrolls: readonly import('./stream-contract').RowContent[];
    /** Only the last step has a candidate. Install AFTER the consumer has
     * accepted all pages; dropping the iterator never mutates the live VT. */
    readonly candidate?: importCaptureVtTransaction;
};
export interface CaptureVtRpc {
    transaction(request: {
        state: import('./stream-contract').VtState | null;
        identity: import('./stream-contract').StreamIdentity;
        geometry: import('./stream-contract').Geometry;
        scrollOnClear: boolean;
        screenRevision: number;
        event?: import('./stream-contract').InputEvent;
        rowStream?: {
            readonly startOrdinal: number;
            readonly maxBytes: number;
        };
    }): Promise<import('./stream-contract').Result<{
        readonly pressure: true;
    } | CaptureVtRowPage | {
        state: import('./stream-contract').VtState;
        frame: import('./stream-contract').FrameDelta;
        scrolls: readonly import('./stream-contract').RowContent[];
    }>>;
}
/** Concrete transactional checkpoint adapter. No process per pane, timer or
 * socket is created here; I supplies the shared J transport once. */
export declare class CheckpointCaptureVt implements importCaptureVt {
    private readonly rpc;
    private readonly scrollOnClear;
    private state;
    private frame;
    private generation;
    private constructor();
    static create(rpc: CaptureVtRpc, identity: import('./stream-contract').StreamIdentity, geometry: import('./stream-contract').Geometry, scrollOnClear: boolean): Promise<import('./stream-contract').Result<CheckpointCaptureVt>>;
    /** C-local streaming API; the frozen K interfaces are unchanged. The
     * consumer drains/spools each step before requesting the next. Cursor replay
     * uses the SAME captured state/event, never the live state or a new packet ID.
     * Partial output is provisional, not a checkpoint or an append ACK. */
    prepareStream(event: import('./stream-contract').InputEvent, maxBytes?: number): AsyncGenerator<import('./stream-contract').Result<CaptureVtStreamStep>, void, void>;
    screen(): import("./stream-contract").FrameDelta;
    snapshot(): Promise<import('./stream-contract').Result<import('./stream-contract').VtState>>;
    prepare(event: import('./stream-contract').InputEvent): Promise<import("./stream-contract").Result<importCaptureVtTransaction>>;
    restore(state: import('./stream-contract').VtState, identity?: import('./stream-contract').StreamIdentity): Promise<import("./stream-contract").Result<importCaptureVtTransaction>>;
    private stage;
}
import type { CaptureVt as importCaptureVt, CaptureVtTransaction as importCaptureVtTransaction } from './capture-engine';
