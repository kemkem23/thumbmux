import { type PipeVtPool, type PipeVtAssets, type PipeVtCursor, type PipeVtFault, type PipeVtRow } from "./pipe-vt-worker.js";
/**
 * NEWARCH L2-P collector: one pane's binary pipe bytes -> VT worker ->
 * `onScroll` / `onFrame` / `onFault`, independent of how many viewers exist.
 *
 * The port shapes below are the local copy of PLAN §7 (frozen by the plan,
 * owned by L1); this file does not import another lane's types.
 *
 * Ordering guarantees:
 * - bytes are never decoded here; each chunk gets a receiveSeq and goes to
 *   the worker verbatim;
 * - every scrolled row reaches `onScroll` before the tray ring evicts
 *   anything to make room for it, and before the frame of the same update;
 * - `receiveSeq` is our receive order, not a tmux offset or source fence.
 *
 * Consumer contract (review 2 m1, m4, M1):
 * - `onFrame` carries a DELTA (`shift` then `dirty`), not a full screen.
 *   Under capacity pressure the very same frame object is offered again,
 *   unchanged. A consumer must apply a frame atomically and only when it
 *   answers "accepted"; applying it and then refusing would apply `shift`
 *   twice on the re-offer.
 * - "The source is quiet" must be judged from the RECEIVE counter,
 *   `stats().receiveSeq` (bytes taken off the pipe), read before and after a
 *   capture. A frame's `receiveSeq` is the last PARSED seq; bytes received
 *   but still in the parser are invisible to it.
 * - Capacity pressure (`isCapacityPressure`) is transient: the event is
 *   offered again until accepted. Oversize (`isOversize`: `ingest-oversize`,
 *   legacy `ingest-capacity`) is permanent: the event is offered once,
 *   dropped, and declared by exactly one `consumer-oversize` fault.
 */
export type PaneKey = {
    serverIdentity: string;
    paneId: string;
    birthGeneration: number;
};
export type PipeScrollEvent = {
    paneKey: PaneKey;
    sourceEpoch: number;
    geometryGeneration: number;
    physicalRow: PipeVtRow;
    softWrap: boolean;
    /** Last cell is wrap padding before a wide glyph (not content). */
    wrapPad: boolean;
    receiveSeq: number;
};
export type PipeFrameEvent = {
    paneKey: PaneKey;
    sourceEpoch: number;
    cells: {
        full: boolean;
        cols: number;
        rows: number;
        /**
         * Apply first: move the previous screen up by this many rows (the
         * scrolled-out rows already went to onScroll), then patch `dirty`.
         */
        shift: number;
        dirty: Record<number, PipeVtRow>;
        softWrap: Record<number, boolean>;
        wrapPad: number[];
    };
    cursor: PipeVtCursor;
    kind: "normal" | "alternate";
    geometryGeneration: number;
    receiveSeq: number;
};
export type PipeFaultEvent = {
    kind: PipeVtFault["kind"] | "parser-backlog" | "worker-restarted" | "history-cleared" | "closed" | "consumer-rejected" | "source-reset" | "consumer-pressure" | "consumer-pressure-cleared" | "consumer-oversize";
    paneKey?: PaneKey;
    sourceEpoch?: number;
    /** null = unknown; a number only on `consumer-oversize` of a scroll (1). */
    missingCount?: number | null;
    at: number;
    message?: string;
    /** Bytes whose parsing could not be acknowledged; not a guessed row count. */
    unacknowledgedBytes?: number;
    receiveSeqFrom?: number;
    receiveSeqTo?: number;
    /** "unknown", or the exact count of a declared drop (`consumer-oversize`). */
    lostRows?: "unknown" | number;
    /** `consumer-oversize` only: which event the consumer can never admit. */
    droppedEvent?: "scroll" | "frame";
};
export interface PipeCollectorPorts {
    onScroll(event: PipeScrollEvent): unknown;
    onFrame(event: PipeFrameEvent): unknown;
    onFault(event: PipeFaultEvent): unknown;
}
export type PipeCollectorHealth = "starting" | "ok" | "degraded" | "broken" | "closed";
export type PipeLatencySummary = {
    samples: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
};
export type PipeCollectorDrainReceipt = {
    lastAdmittedSequence: number;
    lastAckedSequence: number;
    /** Filled by the runtime/store adapter, which owns these revision spaces. */
    ramRevision: number | null;
    durableRevision: number | null;
    issues: string[];
    unknownTail: boolean;
};
export type PipeHistoryCollectorOptions = {
    pool?: PipeVtPool;
    paneKey: PaneKey;
    sourceEpoch: number;
    /** Actual pane option; unknown clear policy raises a fault, never guessed. */
    scrollOnClear?: boolean;
    cols: number;
    rows: number;
    ports: PipeCollectorPorts;
    /** Tray ring of scrolled physical rows kept in memory (PLAN §3: 500). */
    ringRows?: number;
    /** Bytes sent to the parser but not yet answered (PLAN §3: 1 MiB/pane). */
    queueLimitBytes?: number;
    /** Test observability: called when the ring drops its oldest row. */
    onEvict?: (event: PipeScrollEvent) => void;
    assets?: PipeVtAssets;
    python?: string;
    nowNs?: () => bigint;
    now?: () => number;
    /** Keep per-seq latency samples (bounded) for measurement. */
    latencySampleLimit?: number;
    /** Bound for the worker's orderly close and output drain (default 5 s). */
    closeTimeoutMs?: number;
    /** First retry delay after a capacity-pressure receipt; doubles to 100 ms. */
    pressureRetryMs?: number;
};
/**
 * A consumer answer meaning "full for now, nothing was kept": the store's
 * `{ accepted: false, reason: "capacity-pressure" }` receipt, or an error with
 * that reason (or that word in its message) from a store that still throws.
 * It is backpressure, never a parser fault: the same event is offered again.
 */
export declare function isCapacityPressure(value: unknown): boolean;
/**
 * A consumer answer meaning "this one event can never fit, even in an idle
 * store" (review 2 M1): reason or error message `ingest-oversize` (I2 FIX2),
 * or the legacy `ingest-capacity` message of the FIX1 store. Waiting cannot
 * help, so the event is offered once, dropped, and declared with one
 * `consumer-oversize` marker; the pane keeps flowing and the parser stays.
 */
export declare function isOversize(value: unknown): boolean;
export declare function percentile(sorted: number[], p: number): number | null;
export declare class PipeHistoryCollector {
    private readonly options;
    readonly paneKey: PaneKey;
    private sourceEpoch;
    private upstreamEpoch;
    private geometryGeneration;
    private receiveSeq;
    private ackedSeq;
    private inflight;
    private inflightBytes;
    private readonly ring;
    private ringStart;
    private readonly ringRows;
    private readonly queueLimit;
    private worker;
    private recovering;
    private recoveryAttempts;
    private closing;
    private cols;
    private rows;
    private scrollOnClear;
    private readonly nowNs;
    private readonly now;
    private drainWaiters;
    private latencyMs;
    private readonly latencyLimit;
    private healthState;
    private scrollCount;
    private frameCount;
    private workerParseNs;
    private workerEncodeNs;
    private hostHandleNs;
    private policyUnverified;
    private acceptedBytes;
    private refusedBytes;
    /** Bytes received while a dead parser is being replaced; fed to the new one. */
    private held;
    private pressureEpisode;
    private pressureRetries;
    private oversizeDrops;
    private closePromise;
    constructor(options: PipeHistoryCollectorOptions);
    private makeWorker;
    start(): Promise<void>;
    get workerPid(): number | null;
    health(): PipeCollectorHealth;
    /**
     * Accept raw pipe bytes. Returns false while the parser backlog is over
     * its limit: the caller should await `drained()` before reading more.
     * One delivery may exceed the watermark by at most 64 KiB. A caller that
     * ignores drain, or sends an oversized delivery, gets an explicit loss issue.
     */
    ingest(bytes: Uint8Array, receivedAtNs?: bigint): boolean;
    /**
     * Resolves when the next delivery can be accepted. While a dead parser is
     * being replaced this waits for the replacement, so the reader leaves the
     * bytes in the FIFO instead of reading and discarding them.
     */
    drained(): Promise<void>;
    private readyForDelivery;
    /** Geometry changed: new generation; the worker reflows and re-sends. */
    resize(cols: number, rows: number): number;
    /** The current worker accepts control frames (not dead, closing or respawning). */
    private parserLive;
    /** Continuity broke (pipe gap, restart): later rows belong to a new epoch. */
    beginSourceEpoch(epoch: number): void;
    setScrollOnClear(enabled: boolean): void;
    currentSourceEpoch(): number;
    currentGeometryGeneration(): number;
    requestFullFrame(): boolean;
    /** Rows still held by the tray ring, oldest first. */
    ringSnapshot(): PipeScrollEvent[];
    stats(): {
        restartCount: number;
        receiveSeq: number;
        ackedSeq: number;
        inflightBytes: number;
        acceptedBytes: number;
        refusedBytes: number;
        pressureRetries: number;
        oversizeDrops: number;
        scrolls: number;
        frames: number;
        workerParseMs: number;
        workerEncodeMs: number;
        hostHandleMs: number;
        latency: PipeLatencySummary;
    };
    /** Raw receive->frame samples in ms, for pooled percentiles across panes. */
    latencySamples(): readonly number[];
    resetLatency(): void;
    close(): Promise<PipeCollectorDrainReceipt>;
    private shutdownReceipt;
    /** Fault injection for tests: the parser process dies abruptly. */
    killWorker(): void;
    /** Consumer faults cannot interrupt cleanup, waiter release or recovery. */
    private notifyFault;
    private fault;
    /**
     * Offer one event to a consumer port. Accepted synchronously -> undefined;
     * refused as oversize synchronously -> DROPPED (declared once via `drop`);
     * pending -> a Promise that settles (undefined or DROPPED) once decided.
     * Capacity pressure retries the same event (bounded backoff, forever until
     * close); oversize is never retried; any other refusal rejects and becomes
     * a parser-independent fault.
     */
    private deliver;
    /** One declared loss per event the consumer can never admit; never retried. */
    private declareOversize;
    private retryPressure;
    private endPressure;
    private remember;
    /**
     * Offer scrolled rows from `index` on as one pipelined batch: every row is
     * handed to onScroll in order without waiting for the previous receipt.
     * A row that meets synchronous capacity pressure ends the batch there (it
     * is retried alone), so no later row is offered before it is accepted.
     * Rows enter the tray ring only once accepted, still in order.
     */
    private offerScrolls;
    private onUpdate;
}
/**
 * Read a binary stream (FIFO reader stdout) into a collector without ever
 * decoding it, pausing while the parser backlog is over its limit.
 */
export declare function pumpBinaryStream(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, collector: Pick<PipeHistoryCollector, "ingest" | "drained">): Promise<number>;
