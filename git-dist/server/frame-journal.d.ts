import { type MuxDeltaFrame, type MuxFullOutputFrame } from "../core/index.js";
/** Exact persisted NDJSON record shape (journal version 1). */
export interface FrameJournalRecordV1 {
    readonly v: 1;
    readonly session: string;
    readonly at: number;
    readonly frame: MuxFullOutputFrame | MuxDeltaFrame;
}
/** Error callback payload for isolated, session-scoped failures. */
export interface FrameJournalErrorReport {
    /** Session name this error belongs to. */
    readonly session: string;
    /** Resolved output file path for the session. */
    readonly path: string;
    /**
     * Error type for integration routing.
     * - `"recover"` — journal recovery/parse failure (or refuse-to-repair torn tail).
     * - `"write"` — append / first-write probe failure.
     * - `"limit"` — per-session `maxBytes` or aggregate `maxRootBytes` hard cap hit.
     * - `"drop"` — capture refused because `maxPendingWrites` backpressure is saturated.
     */
    readonly phase: "recover" | "write" | "limit" | "drop";
    /** Optional journal timestamp associated with the failing write or dropped capture. */
    readonly at?: number;
    /** Optional physical NDJSON line number when parsing recovered journals. */
    readonly line?: number;
    /** Original error object (or thrown value). */
    readonly cause: unknown;
}
/** Injectable asynchronous storage seam; the default uses Node/Bun filesystem APIs. */
export interface FrameJournalStorage {
    /** Create a directory, including any missing parents. */
    ensureDirectory(path: string): Promise<void>;
    /** Read a UTF-8 journal, rejecting with a normal ENOENT-shaped error when absent. */
    readText(path: string): Promise<string>;
    /** Append one complete UTF-8 NDJSON record. */
    appendText(path: string, source: string): Promise<void>;
    /** Truncate a journal back to a known-good byte offset (crash-tail repair). */
    truncate?(path: string, byteLength: number): Promise<void>;
    /**
     * List entry names directly under a directory (not recursive).
     * Used to establish durable aggregate root accounting on startup.
     */
    listNames?(dir: string): Promise<string[]>;
    /**
     * Return the on-disk byte length of a file.
     * Reject with an ENOENT-shaped error when the path is absent.
     */
    byteLength?(path: string): Promise<number>;
    /**
     * Delete a journal file. ENOENT is treated as success by the journal.
     * Required for `deleteSessionJournal`.
     */
    remove?(path: string): Promise<void>;
}
/** Optional constructor/input configuration for the journal. */
export interface FrameJournalOptions {
    /** Root directory that contains all session journal files. */
    readonly rootDir?: string;
    /** Deterministic clock source for capture timestamps (defaults to `Date.now`). */
    readonly clock?: () => number;
    /** Positive delta-run bound before forcing a full-frame checkpoint. */
    readonly checkpointCadence?: number;
    /**
     * Hard per-session journal size cap in UTF-8 bytes of the durable file.
     * Defaults to 64 MiB. Use `Infinity` to disable the cap.
     * Checked synchronously at capture admission (reserve-then-settle) and
     * rechecked against durable file length before each append.
     */
    readonly maxBytes?: number;
    /**
     * Hard aggregate cap on all `*.ndjson` journal files under `rootDir`.
     * Defaults to 256 MiB. Use `Infinity` to disable the cap.
     * Prevents unbounded disk growth across many closed/ephemeral sessions.
     * Checked at admission and rechecked after durable root accounting is known.
     */
    readonly maxRootBytes?: number;
    /**
     * Maximum number of admitted-but-not-yet-persisted captures per session.
     * Defaults to 128. Use `Infinity` to disable the cap.
     * When saturated, further `capture()` calls return `false` and report `phase: "drop"`.
     */
    readonly maxPendingWrites?: number;
    /** Hook for errors that should not escape capture hot paths. */
    readonly onError?: (report: FrameJournalErrorReport) => void;
    /** Optional deterministic storage adapter for hosts and focused tests. */
    readonly storage?: FrameJournalStorage;
}
/** Recover result for a started or recovered session handle. */
export interface RecoveredSessionState {
    /** Session channel this state owns. */
    readonly session: string;
    /** Safe session journal file path under the configured root. */
    readonly path: string;
    /** Canonical last persisted lines (`data.split("\n")`) if present. */
    readonly base: readonly string[];
    /** Number of records parsed during recovery; zero for fresh sessions. */
    readonly recordCount: number;
    /** Timestamp from the newest parsed record, or `null` for an empty journal. */
    readonly lastAt: number | null;
    /** Number of accepted delta records since the last persisted full checkpoint. */
    readonly deltasSinceCheckpoint: number;
}
/** Default hard per-session journal size cap (64 MiB). */
export declare const DEFAULT_MAX_BYTES: number;
/**
 * Default hard aggregate root cap across all session journals (256 MiB).
 * Conservative: ~4 full per-session caps. Integrators who configure nothing
 * get bounded disk use; raise or set `Infinity` explicitly if needed.
 */
export declare const DEFAULT_MAX_ROOT_BYTES: number;
/** Host-neutral, per-session NDJSON output-frame journal for frame capture/replay. */
export declare class FrameJournal {
    /** @see DEFAULT_MAX_BYTES */
    static readonly DEFAULT_MAX_BYTES: number;
    /** @see DEFAULT_MAX_ROOT_BYTES */
    static readonly DEFAULT_MAX_ROOT_BYTES: number;
    private readonly rootDir;
    private readonly clock;
    private readonly checkpointCadence;
    private readonly maxBytes;
    private readonly maxRootBytes;
    private readonly maxPendingWrites;
    private readonly onError;
    private readonly storage;
    private readonly rootReady;
    private readonly sessions;
    private stopped;
    /**
     * Durable aggregate byte total of complete journal content under rootDir.
     * Authoritative after `rootReady` resolves.
     */
    private rootBytes;
    private rootBytesKnown;
    /** Bytes reserved by admitted-but-not-yet-persisted captures across sessions. */
    private rootReservedBytes;
    /**
     * Sessions whose durable journal is mid-delete. Captures are rejected for the
     * whole await of `storage.remove` so a same-name re-create cannot land a frame
     * that the pending remove then wipes (A3-1).
     */
    private readonly deletingSessions;
    /**
     * Last durable `at` retained across `closeSession` so the documented reopen
     * path cannot write a decreasing timestamp when the wall clock steps back
     * (A3-10). Cleared by `deleteSessionJournal` / `stop`.
     */
    private readonly closedLastAt;
    constructor(options?: FrameJournalOptions);
    /**
     * Start a session without reading disk state. Use this when no prior journal is
     * expected or after a clean startup path.
     */
    startSession(session: string): RecoveredSessionState;
    /**
     * Recover a session from an existing NDJSON journal.
     * Rejects on the first invalid complete line and reports only through the
     * injected error hook. A crash-torn trailing partial line is repaired via
     * `storage.truncate` when available; without truncate the session fails closed.
     */
    recoverSession(session: string): Promise<RecoveredSessionState>;
    /** Return the absolute, safe path derived from a cryptographic hash. */
    getSessionPath(session: string): string;
    /**
     * Number of sessions currently tracked in memory.
     * Drops to zero after `closeSession` / `stop` release their handles.
     */
    get sessionCount(): number;
    /**
     * Durable aggregate byte total of journal files under the root (known after
     * the constructor's root scan completes; also updated on successful writes
     * and deletions). Useful for host dashboards and tests.
     */
    get rootByteCount(): number;
    /**
     * Queue one canonical full snapshot write.
     * The call is synchronous and does not await disk I/O.
     * Returns `false` when the journal is stopped, the session is not accepting,
     * a size cap is exhausted, or write backpressure is saturated.
     */
    capture(session: string, frame: MuxFullOutputFrame, at?: number): boolean;
    /**
     * Flush queued writes for one session and resolve when drained.
     * Never throws for captured write failures; use hook reports for diagnostics.
     */
    flushSession(session: string): Promise<void>;
    /** Flush every active session queue and wait for completion. */
    flushAll(): Promise<void>;
    /** Stop one recording after all captures already admitted to it are durable or reported. */
    stopSession(session: string): Promise<void>;
    /**
     * Stop a session and release its in-memory state (including the canonical base
     * snapshot) so long-lived hosts do not leak per-session memory.
     * A later `capture()` for the same name starts a fresh in-memory session that
     * appends to the same file beginning with a full frame.
     * Does **not** delete the durable journal file (root quota still accounts for it).
     * Use `deleteSessionJournal` to reclaim disk.
     */
    closeSession(session: string): Promise<void>;
    /**
     * Stop accepting captures for a session, flush pending writes, delete the
     * durable journal file under `rootDir`, release root accounting, and drop
     * in-memory state. Safe to call when the file is already absent (returns
     * `false`). Requires `storage.remove`.
     */
    deleteSessionJournal(session: string): Promise<boolean>;
    /** Flush all pending writes, stop accepting new writes, and release session state. */
    stop(): Promise<void>;
    private getOrCreateState;
    private snapshotState;
    private makeSessionPath;
    private reportError;
    /** Sticky per-session maxBytes refusal — further captures stay rejected. */
    private refuseSessionLimit;
    /**
     * Non-sticky aggregate root refusal. Report once per session handle, but keep
     * `accepting` true so a later `deleteSessionJournal` of another session can
     * free headroom and allow this session to record again.
     */
    private reportRootLimit;
    private adjustRootBytes;
    /**
     * Scan rootDir for `*.ndjson` files and establish durable aggregate accounting.
     * When list/size primitives are unavailable, start at 0 and track only writes
     * performed by this process (still bounded going forward).
     */
    private scanRootBytes;
    private measureFileBytes;
    /**
     * Establish `state.bytes` / `state.bytesKnown` from disk on the first write
     * of a session that never recovered (e.g. `startSession` or bare `capture`).
     * Repairs a crash-torn trailing line via truncate, or fails closed.
     */
    private ensureBytesKnown;
    private persistCapture;
}
