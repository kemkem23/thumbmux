/** Opt-in stream-first history store. Owns a dedicated DB, never a legacy DB.
 * WAL/FULL transactions are the durable acknowledgement boundary. No database
 * or timer is created until the explicit constructor is called.
 */
import { Database } from 'bun:sqlite';
import type { SpoolRecord, SpoolAck, RowsAndGapsCommit, RowsAndGapsReceipt, FlagOnRecoveryChunk, RawPosition, OperationFence, PinRequest, SegmentPin, SealedExport, RemoteIndexReceipt, ReclaimReceipt, CommittedStreamRow } from './stream-contract.js';
import type { AppendFinalized, CancelToken, CheckpointCommit, DurableInputReceipt, DurableReceipt, FinalizedRow, GapEpisode, HistoryEngine, HistoryPage, InputEvent, PaneKey, PageCursor, RamReceipt, ReadOpenAck, ReadRequest, ReadView, RecoveryChunk, RepairChunk, RepairReceipt, Result, StreamIdentity, VtCheckpoint } from './stream-contract.js';
import type { FlagOnHistoryR2, HistoryAuthorityR2, CatalogAuthorityR2, CoalescedInputR2, SourceChainSliceR2, StagedRowsR2, StagedReceiptR2, AttachReceiptSetR2, AttachDecisionR2, SegmentContinuityR2, OrderedControlR2, ReplayWatermarkR2, ReplayDecisionR2, TimelineHeadR2, LogicalSealR2, RemoteIndexR2, ArchiveInventoryR2, SegmentRowId } from './stream-contract.js';
export { streamCanonical, streamDigest } from './stream-contract.js';
export interface StreamHistoryOptions {
    /** I streaming path: stage bounded prefixes on disk before final VT commit. */
    stagePrefixesOnDisk?: boolean;
    path: string;
    codecVersions: readonly string[];
    /** Fault injection only: throw/exit here to probe real transaction boundaries. */
    boundary?: (at: 'input-before-write' | 'input-before-commit' | 'input-after-commit' | 'checkpoint-before-write' | 'checkpoint-before-commit' | 'checkpoint-after-commit' | 'repair-before-write' | 'repair-before-commit' | 'repair-after-commit') => void;
}
export declare class StreamHistoryEngine implements HistoryEngine {
    private readonly options;
    private readonly db;
    private readonly pending;
    private readonly pins;
    private closed;
    private readonly readers;
    private ownPending;
    constructor(options: StreamHistoryOptions);
    private live;
    private state;
    private putState;
    private match;
    private dropPending;
    private transaction;
    journalInput(event: InputEvent): Promise<Result<DurableInputReceipt>>;
    private validateRows;
    appendFinalized(request: AppendFinalized): Promise<Result<RamReceipt>>;
    private writeRows;
    private flushRows;
    commitCheckpoint(request: CheckpointCommit): Promise<Result<DurableReceipt>>;
    private reconcilePending;
    /** Crash recovery in staging mode: rows staged above the durable fence were
     * never readable (reads wait for revision==durable) nor published. Drop them
     * and their event receipts so the journal re-derives them under one fence;
     * a replayed frame need not be byte-identical to the interrupted attempt. */
    discardStaged(pane: PaneKey): Result<{
        discardedRows: number;
    }>;
    /** Persist admitted rows and gap together before acknowledging the fence. */
    beginGap(episode: GapEpisode): Result<null>;
    commitRepair(chunk: RepairChunk): Promise<Result<RepairReceipt>>;
    private readRow;
    private readSlot;
    private reader;
    private closeReader;
    grantReadView(request: ReadRequest): Promise<Result<ReadView>>;
    private releasePin;
    openReadView(view: ReadView): Promise<Result<ReadOpenAck>>;
    readPage(ack: ReadOpenAck, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>>;
    releaseReadView(view: ReadView, _reason: string): Promise<void>;
    private recoveryTimers;
    recover(pane: PaneKey, checkpointId: string | null, cancel: CancelToken): AsyncIterable<Result<RecoveryChunk>>;
    stats(): {
        recoveryTimers: number;
        pendingBytes: number;
        ownedPendingBytes: number;
        overlayBytes: number;
        activeReads: number;
        pins: number;
        diskCacheConfigBytes: number;
    };
    /** Close never upgrades undurable RAM to durable without a full VT checkpoint.
     * Caller must drain Capture first; returned pending bytes make omission visible.
     */
    close(): {
        undurableBytes: number;
    };
}
export declare function createHistoryEngine(options: StreamHistoryOptions): StreamHistoryEngine;
/** Read-only sh_* archive reader for the rollback bridge. It opens no writer,
 * VT, cadence, timer or pipe, never runs the schema and never sees RAM-only
 * pending rows: only what H made durable can be published as history. The
 * disk cache it holds is charged to the same isolate pool as H's readers.
 */
export declare class StreamArchiveRowReader {
    readonly path: string;
    private readonly db;
    private closed;
    constructor(path: string);
    private live;
    /** Durable fence only (sh_pane as committed). */
    durable(pane: PaneKey): {
        identity: StreamIdentity;
        head: number;
        revision: number;
        durable: number;
        checkpoint: VtCheckpoint | null;
        gap: GapEpisode | null;
        journalAfterCheckpoint: boolean;
    } | null;
    /** One verified durable row, rejected if it changed after the frozen revision. */
    row(pane: PaneKey, line: number, frozenRevision: number): FinalizedRow;
    close(): void;
}
/** Flag-on v1 persistence. One synchronous FULL transaction is the ACK boundary.
 * No worker, queue or timer; construction is explicit (flag-off remains inert).
 * The catalog authority is injected by I/A: an object supplied by a caller is
 * never itself proof that the remote index is durable. No verifier => no unlink.
 */
declare const V2_STORE: unique symbol;
/** HS2 r1 (review M1): the v2 factory's storage-profile fence. It runs on the
 * owner connection under the writer lock, after read-only inspection and
 * BEFORE the constructor's first write to the root. */
declare const V2_PROFILE_FENCE: unique symbol;
export interface FlagOnHistoryOptions {
    [V2_STORE]?: true;
    [V2_PROFILE_FENCE]?: (db: Database) => void;
    root: string;
    mode: 'create' | 'recover';
    codecVersions: readonly string[];
    catalogAuthority?: CatalogAuthorityR2;
    /** S must return pinned durable records, not the caller's claim. */
    readSourceRecords?: (slice: SourceChainSliceR2) => Result<readonly SpoolRecord[]>;
    validateRemoteIndex?: (receipt: RemoteIndexReceipt, sealed: SealedExport) => boolean;
    boundary?: (phase: string) => void;
}
export declare class FlagOnHistoryStore implements FlagOnHistoryR2 {
    private readonly options;
    private readonly db;
    private readonly writerLock;
    readonly root: string;
    readonly storeUUID: string;
    private closed;
    private readonly replayReleases;
    constructor(options: FlagOnHistoryOptions);
    close(): void;
    private live;
    /** Internal factory hook; the backing store is never exposed to consumers. */
    openV2(key: symbol, request: Parameters<V2HistoryFactory['openForCapture']>[0], hooks: V2HistoryOptions): V2OpenedWithAuthority;
    private tx;
    /** A/I installs owner generation explicitly; no inference from incoming ACKs. */
    setGeneration(pane: PaneKey, expected: number | null, next: number): void;
    private fence;
    private segment;
    private event;
    private checkEvent;
    private putEvent;
    private acknowledged;
    appendInput(record: SpoolRecord): Promise<Result<SpoolAck>>;
    private appendRecord;
    commitRowsAndGaps(r: RowsAndGapsCommit): Promise<Result<RowsAndGapsReceipt>>;
    private commitRows;
    /** Supplemental persistence hook: K's FlagOnHistoryPort has no checkpoint
     * writer. I supplies the exact raw ACK; legacy numeric inputFence is not
     * interpreted as a flag-on raw coordinate. */
    persistCheckpoint(r: OperationFence & {
        checkpoint: VtCheckpoint;
        inputAck: SpoolAck;
    }): Result<null>;
    recover(pane: PaneKey, after: RawPosition | null, cancel: CancelToken): AsyncIterable<Result<FlagOnRecoveryChunk>>;
    pinSegment(r: PinRequest): Promise<Result<SegmentPin>>;
    releasePin(pin: SegmentPin): Promise<Result<null>>;
    private unpinned;
    sealExport(r: OperationFence & {
        segmentId: string;
    }): Promise<Result<SealedExport>>;
    reclaimVerified(r: OperationFence & {
        sealed: SealedExport;
        remote: RemoteIndexReceipt;
    }): Promise<Result<ReclaimReceipt>>;
    private writeIndex;
    private replayIndex;
    private read;
    private value;
    private load;
    private save;
    private migrateIndex;
    private visibleRow;
    private indexRows;
    private projection;
    private cursor;
    private position;
    private head;
    private generation;
    private bounded;
    private entries;
    private page;
    private tail;
    private unreclaimed;
    readonly authority: HistoryAuthorityR2;
    private readDecisions;
    private controlCursor;
    /** Scan start: the watermark itself, or the last entry a previous page returned. */
    private controlAt;
    /** Read controls already stored under kind `control`. Does not apply them. */
    private readControls;
    private logical;
    sealSegment(r: OperationFence & {
        segmentId: string;
    }): Promise<Result<LogicalSealR2>>;
    private rotate;
    rotateSegment(r: OperationFence & {
        segmentId: string;
        boundary: RawPosition;
    }): Promise<Result<SegmentContinuityR2>>;
    listSealed(cursor: string | null, limit: number): Result<{
        seals: readonly LogicalSealR2[];
        next: string | null;
    }>;
    materializeExport(r: OperationFence & {
        sealCommitId: string;
    }): Promise<Result<SealedExport>>;
    stageRows(r: StagedRowsR2): Promise<Result<StagedReceiptR2>>;
    sealAttachSet(r: OperationFence & {
        manifest: AttachReceiptSetR2;
    }): Promise<Result<AttachReceiptSetR2>>;
    private attachDecision;
    private publish;
    private reconcile;
    publishAttach(d: AttachDecisionR2): Promise<Result<TimelineHeadR2>>;
    discardAttach(d: AttachDecisionR2): Promise<Result<null>>;
    appendVerifiedInput(input: CoalescedInputR2): Promise<Result<SpoolAck>>;
    journalControl(r: OperationFence & {
        event: OrderedControlR2;
    }): Promise<Result<{
        commitId: string;
        event: OrderedControlR2;
    }>>;
    commitReplayCheckpoint(r: OperationFence & {
        checkpoint: VtCheckpoint;
        watermark: ReplayWatermarkR2;
    }): Promise<Result<ReplayWatermarkR2>>;
    commitReplayDecision(r: OperationFence & {
        decision: ReplayDecisionR2;
    }): Promise<Result<{
        commitId: string;
    }>>;
    reclaimR2(r: OperationFence & {
        sealed: SealedExport;
        remote: RemoteIndexR2;
        inventory: ArchiveInventoryR2;
    }): Promise<Result<ReclaimReceipt>>;
    private physical;
}
import type { V2HistoryFactory, V2HistoryWriter, V2HistoryReader, V2WriterCapability, V2RemoteLocator, V2HistoryAuthority, V2IssuedInputAuthority } from './stream-contract.js';
/** H-PERF: what one V2 commit did, for tests and the profile run only. An
 * observer: nothing in H reads it back or picks a path by it. */
export type V2WorkEvent = 
/** The live checkpoint was read, inflated, checksummed, parsed and canonical-checked (in get()). */
{
    readonly kind: 'checkpoint-decode';
}
/** A full canonical traversal over `rows` rows of command data. */
 | {
    readonly kind: 'row-encode';
    readonly rows: number;
}
/** Exclusive ms of the commit's spans; the caller's outer clock minus their sum is SQL+other. */
 | {
    readonly kind: 'commit-profile';
    readonly canonicalMs: number;
    readonly decodeMs: number;
    readonly packMs: number;
    readonly commitMs: number;
}
/** page() v2: entries canonical-measured for one page call (arrays count their length). */
 | {
    readonly kind: 'page-encode';
    readonly entries: number;
};
export type V2OpenedWithAuthority = {
    capability: V2WriterCapability;
    writer: V2HistoryWriter;
    reader: V2HistoryReader;
    authority: V2HistoryAuthority;
};
export type V2FactoryWithAuthority = Omit<V2HistoryFactory, 'openForCapture'> & {
    openForCapture(request: Parameters<V2HistoryFactory['openForCapture']>[0]): Promise<Result<V2OpenedWithAuthority>>;
};
export interface V2HistoryOptions {
    /** Tests kill/throw at real transaction boundaries. Never an alternate writer. */
    boundary?: (phase: string) => void;
    /** S's issued-input authority (record ACK or source-prefix receipt), read
     * back synchronously inside H's write transaction; never a caller boolean. */
    inputReceipt?: V2IssuedInputAuthority['inputReceipt'];
    /** O provides verified readback evidence; C owns this validator and the writer. */
    remoteReadback?: (locator: V2RemoteLocator, exported: SealedExport) => boolean;
    /** O's bounded restore cache. Null/missing stays blocked, never becomes EOF. */
    remoteRow?: (locator: V2RemoteLocator, row: SegmentRowId) => Result<CommittedStreamRow | null>;
    /** H-PERF observer: work counters and the profile spans of each commit. */
    observe?: (event: V2WorkEvent) => void;
}
export declare function createV2HistoryFactory(hooks?: V2HistoryOptions): V2FactoryWithAuthority;
