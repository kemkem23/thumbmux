/** Opt-in stream coordinator. Concrete VT adapter: CheckpointCaptureVt.
 * I supplies shared worker J transport and sealed source tap/spool adapters.
 * Runtime acceptance is not established; see lot C REPORT.md. */
import { streamDigest, type CancelToken, type CaptureEngine, type DurableInputReceipt, type DurableReceipt, type FinalizedRow, type FrameDelta, type GapEpisode, type HistoryEngine, type InputEvent, type LiveFrame, type PaneKey, type RepairChunk, type RepairReceipt, type Result, type RowContent, type StreamIdentity, type StreamObserver, type VtCheckpoint, type VtState } from './stream-contract';
/** Compatibility export; callers must name the operation kind explicitly. */
export declare const captureDigest: typeof streamDigest;
/** Logical allocation accounting, not heap/PSS. Reservations have one owner. */
export declare class CaptureAdmission {
    readonly cap: number;
    private held;
    constructor(cap?: number);
    get heldBytes(): number;
    reserve(bytes: number): (() => void) | null;
}
/** A deadline stops awaiting immediately, but does not pretend a worker stopped.
 * The owner must kill/retire the operation and ACK only after its resources and
 * side effects are fenced. Until ACK (or actual settlement), charge and gate stay
 * quarantined. Rejected/missing ACK cannot manufacture free capacity.
 */
export declare class CaptureTaskScope {
    readonly signal: AbortSignal;
    private readonly cancel?;
    private pending;
    private release;
    private retired;
    private closed;
    private readonly aborted;
    private readonly onAbort;
    constructor(signal: AbortSignal, cancel?: (() => Promise<void>) | undefined);
    wait<T>(operation: Promise<T>): Promise<T>;
    finish(release: () => void): void;
    private flush;
}
/** Only durable prefixes may be evicted. Preflight is atomic for the batch. */
export declare class CaptureTail {
    private entries;
    private bytes;
    private durableRevision;
    get rows(): readonly FinalizedRow[];
    get heldBytes(): number;
    durable(revision: number): void;
    private plan;
    reconcile(rows: readonly FinalizedRow[]): boolean;
    canAppend(rows: readonly FinalizedRow[]): boolean;
    append(rows: readonly FinalizedRow[]): boolean;
}
/** Both arguments must be full observed screens, never deltas. Equality is
 * only visible evidence; it does not prove pre-receive byte continuity. */
export declare function exactVisibleVerdict(a: FrameDelta, b: FrameDelta, before: number, after: number): 'equal' | 'different' | 'unfenced';
export declare function uniqueCaptureSeam(before: readonly string[], captured: readonly string[]): number;
/** VT implementations stage on an isolated candidate. busy/error must leave
 * the live parser untouched. install is synchronous and must not throw.
 * A screen reseed is NOT an implementation of restore or checkpoint. */
export interface CaptureVt {
    prepareStream?(event: InputEvent, maxBytes?: number): AsyncGenerator<Result<import('./pipe-vt-worker').CaptureVtStreamStep>, void, void>;
    prepare(event: InputEvent): Promise<Result<CaptureVtTransaction>>;
    restore(state: VtState, identity?: StreamIdentity): Promise<Result<CaptureVtTransaction>>;
    snapshot(): Promise<Result<VtState>>;
    screen(): FrameDelta;
}
export interface CaptureVtTransaction {
    readonly frame: FrameDelta;
    /** Only finalized NORMAL rows, even when the packet ends in alternate mode. */
    readonly scrolls: readonly RowContent[];
    /** Snapshot of the isolated candidate, before live installation. */
    snapshot?(): Promise<Result<VtState>>;
    install(): void;
    discard(): void;
}
export interface CapturePorts {
    readonly identity: StreamIdentity;
    readonly history: HistoryEngine;
    readonly vt: CaptureVt;
    readonly initial: LiveFrame;
    readonly observer?: StreamObserver;
    readonly admission: CaptureAdmission;
    readonly scratch: CaptureAdmission;
    readonly now: () => number;
    readonly digest?: (kind: string, value: unknown) => string;
    /** tail is literally zero: implementations cannot quietly request history. */
    /** Hard retirement of all resources for this signal, including iterator reads,
     * H commit, RPC and close. Resolve only once no late mutation is possible.
     * I supplies worker/request termination; missing/rejected ACK quarantines C.
     */
    cancelOperation?(signal: AbortSignal): Promise<void>;
    visible(identity: StreamIdentity, tail: 0, signal: AbortSignal): Promise<Result<FrameDelta>>;
    /** Source owner supplies bounded, uniquely anchored repair chunks. No
     * periodic call exists. Live seam and durable checkpoint must agree before
     * complete=true. This adapter is not supplied by the legacy collector. */
    repairChunks(episode: GapEpisode, signal: AbortSignal): AsyncIterable<Result<RepairChunk>>;
    syncRepair(chunk: RepairChunk, receipt: RepairReceipt, signal?: AbortSignal): Promise<LiveFrame>;
    verifyRepair(episode: GapEpisode, signal: AbortSignal): Promise<boolean>;
    /** H's durable checkpoint after I seals the replay/spool and live seam. */
    repairedCheckpoint(episode: GapEpisode, signal: AbortSignal): Promise<Result<VtCheckpoint>>;
}
/** One pane per engine; host owns lifecycle, cadence and the global ledgers.
 * Deliberately opt-in: it never changes the legacy runtime or starts timers.
 */
export declare class StreamCaptureEngine implements CaptureEngine {
    private readonly ports;
    private identity;
    private frame;
    private tail;
    private listeners;
    private locked;
    private visibleLocked;
    private pending;
    private lastInput;
    private lastCheckpoint;
    private durable;
    private episode;
    private checkpointAt;
    private checkpointHead;
    private serial;
    private restoring;
    constructor(ports: CapturePorts);
    private activeGap;
    private digest;
    private matches;
    private record;
    private publish;
    /** Called by I on EOF/exit/ACK timeout/checksum/identity/source detector.
     * No missing count is invented. A late gap cannot renumber admitted IDs. */
    fault(reason: GapEpisode['reason']): GapEpisode;
    get checkpointDue(): 'periodic' | 'row-limit' | null;
    private validate;
    /** I calls this on a source-owned read/spool BEFORE assigning journal packet
     * IDs. At most 512 bytes are copied; caller retains the unread suffix on disk
     * or in its already charged buffer. consumed advances only on durable ACK.
     * Do not feed an already journaled InputEvent here or renumber its identity.
     * On restart I resumes after the durable source byte offset in its tap.
     */
    acceptSourceBytes(bytes: Uint8Array, packetSeq: number, receivedAtMonoMs: number): Promise<Result<{
        readonly consumed: number;
        readonly receipt: DurableInputReceipt;
    }>>;
    acceptInput(input: InputEvent): Promise<Result<DurableInputReceipt>>;
    private acceptOrdered;
    private flushPending;
    /** Two bounded passes over one immutable source checkpoint. The first proves
     * the final state before any append. The second replays provisional pages to
     * H without retaining a packet-sized scroll array. H owns disk staging.
     * A busy prefix is retried from the original revision/ordinal; H returns its
     * original receipt. Only the final checkpoint permits installation/publish. */
    private flushStreaming;
    subscribe(pane: PaneKey, listener: (frame: LiveFrame) => void): () => void;
    checkpoint(pane: PaneKey, _reason: 'periodic' | 'row-limit' | 'handoff'): Promise<Result<VtCheckpoint>>;
    private lastCheckpointInput;
    restore(checkpoint: VtCheckpoint, input: AsyncIterable<InputEvent>): Promise<Result<LiveFrame>>;
    checkVisible(identity: StreamIdentity): Promise<Result<{
        readonly verdict: 'equal' | 'different' | 'unfenced';
    }>>;
    repair(episode: GapEpisode, cancel: CancelToken): AsyncIterable<Result<RepairReceipt>>;
    drain(pane: PaneKey, deadlineMonoMs: number): Promise<Result<DurableReceipt>>;
}
/** I must obtain this fence upstream of the lossy pipe (durable source tap).
 * A host receive counter is explicitly not a valid implementation. */
export interface SourceTapFence {
    readonly identity: StreamIdentity;
    readonly sourcePacket: number;
    readonly byteStart: number;
    readonly byteEnd: number;
}
export declare class CaptureSourceContinuity {
    private readonly fault;
    private previous;
    constructor(fault: (reason: GapEpisode['reason']) => void);
    observe(fence: SourceTapFence): Result<void>;
    /** Only call after durable replay and seam verification, never on pipe reopen. */
    repaired(fence: SourceTapFence): void;
}
/** Immutable, sealed retained snapshot or bootstrap spool. I owns tmux/tap
 * lifecycle and disk spool I/O; C never requests periodic full history.
 * read() returns at most 256 rows / 1 MiB and may be called twice. */
export interface CaptureRecoveryView {
    readonly identity: StreamIdentity;
    readonly rowCount: number;
    readonly geometry: import('./stream-contract').Geometry;
    /** I journals one recovery control event before opening this view. Its
     * position is unique to this episode, never borrowed from prior input. */
    readonly recoveryPosition: import('./stream-contract').InputPosition;
    read(start: number, count: number, signal: AbortSignal): Promise<Result<readonly RowContent[]>>;
    verify(signal: AbortSignal): Promise<boolean>;
    close(): Promise<void>;
}
export interface CaptureRecoverySource {
    /** Retire reads/open/close for this signal, then acknowledge. */
    cancelOperation?(signal: AbortSignal): Promise<void>;
    open(episode: GapEpisode, horizonRows: number, signal: AbortSignal): Promise<Result<CaptureRecoveryView>>;
}
/** Plans repairs using BOTH exact ordered anchors. Repeated or expired anchors
 * are unresolved. Only bounded decode chunks and the anchor window are held.
 * A retry reopens the same sealed view; H owns chunk idempotency. */
export declare class TargetedCaptureRepair {
    private readonly source;
    private readonly identity;
    private readonly scratch;
    private readonly digest;
    constructor(source: CaptureRecoverySource, identity: StreamIdentity, scratch: CaptureAdmission, digest?: typeof streamDigest);
    chunks(episode: GapEpisode, before: readonly RowContent[], after: readonly RowContent[], revision: number, signal: AbortSignal): AsyncIterable<Result<RepairChunk>>;
    private atHorizon;
}
/** One-time bootstrap from a sealed retained-history spool while the source
 * tap continues journaling input. I owns seam/fence acquisition; no lifetime
 * history is accumulated in this coordinator. A failed later chunk preserves
 * the already committed prefix and must resume the SAME view/episode. */
export declare function bootstrapCapture(view: CaptureRecoveryView, episode: GapEpisode, history: HistoryEngine, scratch: CaptureAdmission, revision: number, sync: (chunk: RepairChunk, receipt: RepairReceipt) => Promise<void>, signal: AbortSignal, cancelOperation?: () => Promise<void>): AsyncIterable<Result<RepairReceipt>>;
/** Host-driven cadence: I calls tick at <=50 ms, never creates a second
 * capture timer. Event deadline is not postponed by repeated output events. */
export declare class CaptureCadence {
    private readonly engine;
    private readonly identity;
    private readonly now;
    private nextVisible;
    private eventAt;
    private viewers;
    private active;
    private visibleRunning;
    private checkpointRunning;
    constructor(engine: StreamCaptureEngine, identity: () => StreamIdentity, now: () => number);
    activity(viewers: number, active: boolean): void;
    event(): void;
    tick(): Promise<void>;
}
