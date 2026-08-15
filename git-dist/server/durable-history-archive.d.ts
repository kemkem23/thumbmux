import type { HistoryPage } from "./history-archive.js";
import type { HistoryArchiveLike } from "./ws-mux.js";
/**
 * A line this system wrote ABOUT the history, not one the terminal produced. It
 * can never appear in a capture, so an anchor containing one can never match —
 * and a failed anchor writes another marker. That loop is not hypothetical.
 */
export declare function isHistoryMarker(line: string): boolean;
export declare function historyGapMarker(at: Date): string;
/** The newest contiguous run of real terminal lines in an archived tail. */
export declare function anchorFromTail(tail: readonly string[], want: number): string[];
export type ArchiveAppendResult = {
    appended: number;
    /** Absolute archive line where the mux's live window begins. */
    liveStartLine: number;
    totalLines: number;
    gap: boolean;
    deferred: boolean;
    /**
     * The anchor was not in this capture, and the caller said a deeper one is
     * available. Nothing was written: "I looked too shallow" and "tmux dropped
     * it" are different answers, and only the second deserves a marker.
     */
    needsDeeper: boolean;
};
export type DurableHistoryArchiveOptions = {
    /** Storage root. Every session lives under `<root>/<group>/<session>/`. */
    root: string;
    /** Host label for a session — kemcortex passes the topic. Opaque here. */
    group?: (session: string) => string;
    chunkLines?: number;
    chunkBytes?: number;
};
export declare class DurableHistoryArchive implements HistoryArchiveLike {
    private readonly root;
    private readonly groupOf;
    private readonly chunkLines;
    private readonly chunkBytes;
    private readonly states;
    constructor(options: DurableHistoryArchiveOptions);
    /**
     * Legacy entry point. Without a pane height the only boundary we can trust is
     * the live window, which is far deeper than any pane is tall — so this stores
     * strictly less than `appendAnchored`, never more.
     */
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
    /** Absolute archive line where the mux's live window begins. */
    liveStartLine(session: string): number | null;
    appendAnchored(session: string, captured: readonly string[], opts: {
        paneRows: number;
        liveLineLimit: number;
        deeperAvailable?: boolean;
    }): ArchiveAppendResult;
    /** Directory holding this session's history, for hosts that expose a path. */
    sessionDir(session: string): string;
    private stateFor;
    /**
     * Rebuild everything from the `.log` files. The index and meta are caches, so
     * a missing or stale one costs a directory scan rather than the history — the
     * property the old JSON manifest did not have, where one lost file made half
     * a million lines unreadable.
     */
    private scan;
    private append;
    private appendIndex;
    private writeMeta;
    private readRange;
    private tailLines;
}
