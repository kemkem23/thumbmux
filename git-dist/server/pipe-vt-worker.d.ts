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
export { PIPE_VT_LICENSE_FILE, PIPE_VT_VENDOR_FILE, PIPE_VT_VENDOR_SHA256, PIPE_VT_WORKER_FILE } from "./pipe-vt-assets.js";
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
};
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
