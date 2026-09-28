/** Schema version stamped in `PRAGMA user_version`. */
export declare const RECALL_SCHEMA_VERSION = 1;
/** Most recent distinct prompts kept per lifecycle. */
export declare const DEFAULT_KEEP_PROMPTS = 100;
/** Shorter submissions are noise (a bare "y", a stray keystroke) and are dropped. */
export declare const DEFAULT_MIN_PROMPT_LENGTH = 3;
/** Milliseconds a statement waits on a locked database before failing. */
export declare const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** What the host knows about a name that this store does not. */
export type RecallSessionIdentity = {
    /** Stable id for this occupant of the name. A new spawn is a new id. */
    lifecycleId: string;
};
export type RecallHandlerOptions = {
    /** SQLite file. Created (with its parent) on first write. */
    file: string;
    /**
     * Resolve a tmux name to the lifecycle that currently owns it, or null when
     * the name is unknown, ended, or ambiguous. Failing closed is the point.
     */
    resolveSession: (session: string) => Promise<RecallSessionIdentity | null> | RecallSessionIdentity | null;
    /** Prompts retained per lifecycle. Default 100. */
    keepPromptsPerSession?: number;
    /** Minimum trimmed length for a prompt to be stored. Default 3. */
    minPromptLength?: number;
    /** Busy timeout in ms. Default 5000. */
    busyTimeoutMs?: number;
    /** Clock, for tests and for hosts that stamp their own time source. */
    now?: () => string;
};
export type RecallNote = {
    session: string;
    lifecycleId: string;
    note: string;
    /** ISO timestamp of the last write, or null when the note was never set. */
    noteUpdatedAt: string | null;
};
export type RecallPrompts = {
    session: string;
    lifecycleId: string;
    /** Oldest → newest, the order a live pane scan produces. */
    prompts: string[];
};
export type RecallIngestBatch = {
    session: string;
    /** Oldest → newest. Re-seen text bumps recency instead of duplicating. */
    prompts: string[];
    /**
     * The lifecycle the caller resolved before it started capturing. When given
     * and the name has moved on since, the batch is discarded.
     */
    expectedLifecycleId?: string;
};
export type RecallHandler = {
    /**
     * Route a request whose path ends in `/note` or `/prompts`, with the session
     * name as the preceding segment — i.e. exactly the shape a host already
     * mounts at `/api/sessions/:name/note` and `/api/sessions/:name/prompts`.
     * The prefix in front of that is not inspected, so a host is free to mount
     * this anywhere.
     */
    handle(request: Request): Promise<Response>;
    readNote(session: string, expectedLifecycleId?: string): Promise<RecallNote | null>;
    writeNote(session: string, note: string, expectedLifecycleId?: string): Promise<RecallNote | null>;
    readPrompts(session: string, options?: {
        limit?: number;
        expectedLifecycleId?: string;
    }): Promise<RecallPrompts | null>;
    /** Returns rows written, or 0 when the batch was empty or the name had moved on. */
    ingest(batch: RecallIngestBatch): Promise<number>;
    close(): void;
};
/** Thrown when the file on disk was written by a schema this build cannot read. */
export declare class RecallSchemaVersionError extends Error {
    readonly found: number;
    readonly supported: number;
    constructor(found: number, supported: number);
}
export declare function createRecallHandler(opts: RecallHandlerOptions): RecallHandler;
