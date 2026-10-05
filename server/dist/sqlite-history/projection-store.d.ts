import { Database } from 'bun:sqlite';
import { PROJECTION_MIGRATION } from './schema';
import { type FrameCodecStats, type SqlRow } from './ram-store';
import type { PaneKey, ProjectionAdmission, ProjectionCalibration, ProjectionCloseReceipt, ProjectionIssueInput, ProjectionEpochTransition, ProjectionFault, ProjectionFrame, ProjectionHealth, ProjectionIssue, ProjectionReceipt, ProjectionStorageState, ProjectionToken, ProjectionWriterPort, ScrollEvent } from './types';
export interface ProjectionOptions {
    historyRoot: string;
    file?: string;
    mode: 'create' | 'recover';
    /**
     * Files of earlier schemas, read-only, layered under panes this file
     * continues (LegacyUnderlay). Default: the PROJECTION_LEGACY_FILES that exist
     * under historyRoot when `file` is the default, none otherwise.
     */
    legacyArchives?: readonly string[];
    /** RAM working-set cap; defaults to 256 MiB. Tests lower it to reach the cap with real rows. */
    cacheBytes?: number;
    onFault?: (fault: ProjectionFault) => void;
    /** Immediate, typed disk-fault/retry receipt for the host's durable journal. */
    onStorageState?: (state: ProjectionStorageState) => void;
    /** Fault/crash probes, never a replacement persistence backend. */
    checkpoint?: (phase: 'before-disk-commit' | 'after-disk-commit' | 'before-watermark', commitId: string) => void;
    beforeOpen?: (file: string) => void;
}
type Batch = {
    id: string;
    digest: string;
    panes: SqlRow[];
    tables: Map<string, SqlRow[]>;
    bytes: number;
    since: number;
    byPane: Map<string, number>;
};
/**
 * Archive work counters of one SQLite handle (D2). The disk worker reports its
 * own through the shared signal; ProjectionStore.archiveStats() adds both.
 */
export interface ArchiveStats {
    /** Commits that went through the archive scheduler. */
    commits: number;
    /** Eligibility scans (the anti-join) actually run, and their time. */
    scans: number;
    scanMs: number;
    /** Cheap live-receipt counts that decided whether a scan could pay off. */
    countChecks: number;
    /** Archive chunks written and receipts moved into them. */
    chunks: number;
    archived: number;
    /** Receipt lookups: catalogs inflated and archive data blobs fetched. */
    catalogReads: number;
    dataReads: number;
}
declare function archiveStatsOf(disk: Database): ArchiveStats;
/**
 * Every receipt `ids` names, live or archived. Archives are walked newest
 * first by catalog only; a data blob is fetched solely for an archive whose
 * catalog holds a wanted id, and each archive is inflated once for all ids.
 */
declare function captureReceipts(disk: Database, paneNo: number, ids: Iterable<string>): Map<string, SqlRow>;
export declare const ARCHIVE_SCAN_SQL = "SELECT c.* FROM na_capture c WHERE c.pane_no=?\n      AND c.capture_id NOT IN(SELECT l.checked_capture_id FROM na_line l WHERE l.pane_no=? AND l.checked_capture_id IS NOT NULL)\n      AND c.capture_id NOT IN(SELECT recent.capture_id FROM na_capture recent WHERE recent.pane_no=? ORDER BY recent.revision DESC,recent.capture_id DESC LIMIT 8)\n      ORDER BY c.revision,c.capture_id LIMIT 256";
type ArchiveEntry = {
    scannedAt: number;
    released: boolean;
    touched: boolean;
};
declare function archiveQueue(disk: Database): Map<number, ArchiveEntry>;
/** When the idle worker should drain next: the earliest due pane, null if none can become due without a commit. */
declare function archiveNextDue(disk: Database): number | null;
/** D3: when a pane the store has seen reaches the quiet age, null if none is waiting for it. */
declare function quietNextDue(disk: Database): number | null;
/** Whether a drain now would find due work. */
declare function archiveBacklog(disk: Database): boolean;
/** One bounded archive transaction outside any ingest commit, under the same writer fence. */
declare function drainArchives(disk: Database, fence: number): void;
declare function commitBatch(disk: Database, fence: number, batch: Batch, before?: () => void, checkpoint?: boolean, forceSeal?: boolean): {
    totalMs: number;
    writeMs: number;
    commitMs: number;
    archiveMs: number;
};
/** One RAM writer, one disk writer, round-robin pane queues, independent of viewers. */
export declare class ProjectionStore implements ProjectionWriterPort {
    private readonly options;
    private readonly ram;
    private readonly disk;
    readonly file: string;
    private readonly legacy;
    private fence;
    private queues;
    private queuedBytes;
    private pendingByPane;
    private dirtyByPane;
    private capacityLosses;
    private dirtyBytes;
    private dirtySince;
    private pumping;
    private pumpTurnAt;
    private closed;
    private degraded;
    private stopped;
    private pressureBytes;
    private timer;
    private retry;
    private storageStatus;
    private storageEventId;
    private storageReason;
    private storageAttempt;
    private storageRetryAt;
    private storageResult;
    private storageBatchId;
    private closeReceipt;
    private worker;
    private readonly signal;
    private inFlight;
    private diskTiming;
    private workerArchive;
    /** Synchronous RAM transactions of the screen fast path (fc:2 write), on the ingest thread. */
    private frameWrites;
    private closing;
    private rejectedRows;
    private screenBytes;
    private dirtyFaults;
    private faultEmitted;
    private faults;
    private lastCommitAt;
    private lastFlushAgeMs;
    private readonly cacheMax;
    private roster;
    private rosterSize;
    private rosterAt;
    private pressureRefusals;
    private ramBatches;
    private ramBatchOperations;
    private ramBytesCache;
    private refusedBytes;
    private lastOversize;
    private drainWaiters;
    private durableWaiters;
    constructor(options: ProjectionOptions);
    private reportLegacy;
    /** Legacy rows under this pane, if its numbering continues a legacy file. */
    private underlay;
    /** Legacy files layered under this store: how many opened and why the others did not. */
    legacyArchives(): {
        opened: number;
        errors: string[];
    };
    private owner;
    private recover;
    private pendingAge;
    private pendingBytes;
    private storageSnapshot;
    private emitStorage;
    private handleFlushFailure;
    private fault;
    /**
     * Admission reads RAM size once per pump turn, not twice per row: it only
     * grows when the pump applies jobs and shrinks on eviction, and both drop
     * the cache. Pending bytes still bound what was admitted but not applied.
     */
    private liveRam;
    /** Live roster size, refreshed at most every 250 ms (never a per-row scan). */
    private rosterCount;
    /**
     * D12 quota. The cap is split in two fixed halves. The guaranteed half is
     * divided among R live panes plus one spare slot for a pane that has not
     * arrived yet: guarantee=min(768 KiB, half/(R+1)). The other half is the
     * borrow pool: one borrower may take half of it, k borrowers pool/k each,
     * and all borrowing together never exceeds it. Borrowing therefore can never
     * eat the guaranteed half, so a late pane is admitted its guarantee while
     * another pane borrows. 'store' = the shared cap itself is full.
     */
    private quota;
    /** Largest history event an idle store admits; anything bigger can never be stored. */
    private maxEvent;
    private capacity;
    /**
     * FIX1 §3 backpressure: the event is neither stored nor dropped. The caller
     * keeps it, stops reading its source and awaits drained(). No issue row, no
     * lost-row counter, no parser fault: pressure is not loss.
     */
    private pressure;
    /**
     * An event bigger than an idle store admits: waiting cannot help, so it is a
     * recorded loss under its own name (M1), never the transient 'capacity-pressure'.
     * `identity` names the event; the same event offered again is refused again
     * but counted once, so a caller that retries cannot grow the loss counters.
     */
    private rejectOversize;
    /** Resolves when the pane may offer the event it was refused, sized as refused. */
    drained(key: PaneKey): Promise<void>;
    private admissible;
    private settleDrains;
    /** Durable receipt without blocking the caller (FIX1 §4.3): the disk worker commits, acknowledge() resolves. */
    durable(key: PaneKey, revision: number): Promise<ProjectionReceipt>;
    private settleDurable;
    /** Reclaim only acknowledged history; no flush is needed to reopen an idle full cache. */
    private relievePressure;
    private kickFlush;
    private drainLosses;
    private reserve;
    /**
     * History rows and screen frames are admitted under D12 pressure; issues,
     * transitions and calibrations are small ordered barriers checked against
     * the shared cap only. A barrier refused by a full store is an error the
     * caller retries ('capacity-pressure'), never a parser fault.
     */
    private enqueue;
    private pump;
    appendScroll(event: ScrollEvent): Promise<ProjectionAdmission>;
    /**
     * FIX1 §4 screen fast path. A frame of the generation every queued job of its
     * pane already has is written to RAM now and resolves at once; it never waits
     * behind queued history rows. Its receipt carries the nextLineId of history
     * already in RAM, so a viewer joins screen and history on one revision and
     * sees the queued rows follow. Only a generation change or an ordered barrier
     * (issue/transition/calibration) still queues, so it cannot invalidate rows
     * accepted before it.
     */
    replaceScreen(frame: ProjectionFrame): Promise<ProjectionAdmission>;
    /** The newer frame takes the queued frame's place and reservation. */
    private coalesce;
    /**
     * F12: expectedRevision is the revision the caller read, compared when the
     * job is admitted. Rows and frames admitted before it for the same pane then
     * run first by queue order; they no longer make the CAS fail.
     */
    private admitCas;
    recordIssue(issue: ProjectionIssueInput): Promise<ProjectionReceipt>;
    /**
     * F11: returns the RAM receipt as soon as the transition is applied in queue
     * order. The disk worker is asked to commit at once; durable(paneKey,
     * receipt.revision) resolves when it has. A disk failure never rejects the
     * transition: it is a flush fault, retried by the flush timer.
     */
    transitionEpoch(change: ProjectionEpochTransition): Promise<ProjectionReceipt>;
    private externalFault;
    /**
     * A calibration with screen evidence keeps its strict run-time CAS: any frame
     * or row admitted since the caller's read bumps the revision, which is exactly
     * the quiescence the displayed-screen overwrite needs (FIX1 §1.2), so a pane
     * with queued work fails fast instead of waiting to fail. A history-only
     * calibration (no quiescent evidence) is never refused for queued work or a
     * moved revision (M2): it runs in queue order and its rows are compared byte
     * for byte in the transaction. 'stale-revision' is the one CAS conflict error.
     */
    calibrate(change: ProjectionCalibration): Promise<ProjectionReceipt>;
    token(key: PaneKey): ProjectionToken;
    screen(key: PaneKey, kind?: 'normal' | 'alternate'): SqlRow | null;
    readPage(token: ProjectionToken, anchor: number | null, limit: number): import("./types").ProjectionPage;
    private snapshot;
    private acknowledge;
    private finishWorker;
    private ensureWorker;
    private flushAsync;
    /** Explicit durability barrier remains synchronous; the ingest pump never calls it. */
    flush(): void;
    /**
     * One pane's status and issues, as `health()` reports them for that pane,
     * without the store-wide figures (RSS, RAM pages, pending bytes) or the
     * other panes' rows: a live snapshot reads this on every publish.
     */
    paneHealth(key: PaneKey): {
        status: 'healthy' | 'degraded';
        issues: ProjectionIssue[];
    } | null;
    /**
     * Archive scheduling and receipt lookup counters (D2): the disk worker's
     * commits plus this thread's barrier flushes and boot/calibration lookups.
     */
    archiveStats(): ArchiveStats;
    /** fc:2 frame path: codec counters (process-wide) and this store's fast-path RAM writes. */
    frameStats(): {
        codec: FrameCodecStats;
        writes: {
            count: number;
            totalMs: number;
            maxMs: number;
        };
    };
    health(): ProjectionHealth;
    close(): Promise<ProjectionCloseReceipt>;
    /** DB.close() runs in its owning thread; a stuck worker is terminated, never thrown at the caller. */
    private stopWorker;
}
export declare function createProjectionStore(options: ProjectionOptions): ProjectionStore;
export { PROJECTION_MIGRATION };
/** Test seam: the archive scheduler's internals and clock. Not a runtime API. */
export declare const projectionArchiveInternals: {
    commitBatch: typeof commitBatch;
    drainArchives: typeof drainArchives;
    captureReceipts: typeof captureReceipts;
    archiveStatsOf: typeof archiveStatsOf;
    archiveQueue: typeof archiveQueue;
    archiveBacklog: typeof archiveBacklog;
    archiveNextDue: typeof archiveNextDue;
    quietNextDue: typeof quietNextDue;
    ARCHIVE_SCAN_SQL: string;
    limits: {
        ARCHIVE_MIN: number;
        ARCHIVE_MAX: number;
        ARCHIVE_KEEP: number;
        ARCHIVE_RETRY_MS: number;
        ARCHIVE_SCANS_PER_COMMIT: number;
        ARCHIVE_CHUNKS_PER_COMMIT: number;
        ARCHIVE_IDLE_MS: number;
        SEAL_LINES: number;
        SEAL_QUIET_MS: number;
    };
    setClock(clock: (() => number) | null): void;
};
