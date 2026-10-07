import type { AppendFinalized, CancelToken, CheckpointCommit, DurableInputReceipt, DurableReceipt, FinalizedRow, GapEpisode, HistoryEngine, HistoryPage, InputEvent, PaneKey, PageCursor, RamReceipt, ReadOpenAck, ReadRequest, ReadView, RecoveryChunk, RepairChunk, RepairReceipt, Result, StreamIdentity, VtCheckpoint } from './stream-contract';
export { streamCanonical, streamDigest } from './stream-contract';
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
