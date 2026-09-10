import type { HistoryArchiveLike } from "./ws-mux";
export type HistoryPage = {
    lines: string[];
    startLine: number | null;
    hasMore: boolean;
};
export type FileHistoryArchiveOptions = {
    /**
     * Storage directory. An explicit root is persistent across archive
     * instances. The default is private and unique to this user/process run.
     */
    root?: string;
    /** Maximum archived lines retained for each session. */
    maxLines?: number;
};
/**
 * Classify consecutive live terminal captures that most likely changed in
 * place instead of scrolling. A stable prefix with at most two rewritten tail
 * rows is treated as a prompt/status repaint so callers do not manufacture
 * phantom history from a coincidental suffix-to-prefix match.
 */
export declare function looksLikeTailRepaint(previous: readonly string[], next: readonly string[]): boolean;
/**
 * Return the largest exact overlap between the suffix of one terminal capture
 * and the prefix of the next. The overlap is a reconciliation signal, not
 * proof of scrolling; callers should apply repaint and reliability checks
 * before archiving rows that appear to have departed.
 */
export declare function stableOverlap(previous: readonly string[], next: readonly string[]): number;
/**
 * A bounded per-session archive. Session names are never used as filenames:
 * each pair of data/meta files uses a SHA-256 key, so traversal input remains
 * inside the configured storage root.
 */
export declare class FileHistoryArchive implements HistoryArchiveLike {
    private readonly root;
    private readonly maxLines;
    private readonly storageReady;
    private readonly states;
    constructor(options?: FileHistoryArchiveOptions);
    ingestSnapshot(session: string, content: string, opts: {
        previousContent: string | null;
        fullHistory: boolean;
        liveLineLimit: number;
        replace?: boolean;
    }): {
        liveContent: string;
    };
    readBefore(session: string, beforeLine: number | null, limit?: number): HistoryPage;
    readAfter(session: string, afterLine: number | null, limit?: number): HistoryPage;
    renameSession(oldSession: string, newSession: string): void;
    dropSession(session: string): void;
    private stateFor;
    private load;
    private parseEntry;
    private validMeta;
    private validEntries;
    private evict;
    private persist;
    private paths;
    private writeAtomically;
    private moveIfPresent;
    private removeFiles;
    private secureRoot;
    private secureFile;
}
