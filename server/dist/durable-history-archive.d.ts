import type { HistoryPage } from "./history-archive";
import type { HistoryArchiveLike } from "./ws-mux";
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
    /**
     * Lines a size cap deleted during this append. `0` whenever no cap is set,
     * which is every consumer that has not opted in. Reported rather than done
     * silently: this is the one operation in the archive that destroys history,
     * so a host that wants to log or alert on it can.
     *
     * **Optional in the type, always present at runtime.** Making it required
     * would narrow a tier-S declaration: anyone who constructs an
     * `ArchiveAppendResult` — an alternative `HistoryArchiveLike`, a test double —
     * would have to supply a field they have never heard of, and their code stops
     * compiling on a minor. The immutable-baseline gate refuses that, correctly.
     * Every return path in this file sets it, so `?? 0` is defensive, not a real
     * branch.
     */
    prunedLines?: number;
};
export type DurableHistoryArchiveOptions = {
    /** Storage root. Every session lives under `<root>/<group>/<session>/`. */
    root: string;
    /** Host label for a session — kemcortex passes the topic. Opaque here. */
    group?: (session: string) => string;
    chunkLines?: number;
    chunkBytes?: number;
    /**
     * Approximate ceiling on how many lines one session keeps. Unset = unbounded,
     * which is what every 0.16.x consumer already has.
     *
     * "Approximate" is load-bearing: pruning drops whole chunk FILES from the
     * oldest end, because rewriting a partial chunk would cost O(size) and break
     * the append-only property that makes torn-write recovery a truncation. So a
     * session holds at least this many lines and up to one chunk more — it never
     * drops below the cap while it has the lines to meet it.
     */
    maxLinesPerSession?: number;
    /** Same, measured in bytes on disk. Whichever cap is reached first prunes. */
    maxBytesPerSession?: number;
};
export declare class DurableHistoryArchive implements HistoryArchiveLike {
    private readonly root;
    private readonly groupOf;
    private readonly chunkLines;
    private readonly chunkBytes;
    private readonly maxLines;
    private readonly maxBytes;
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
    /**
     * Delete whole chunk files from the oldest end until the session is within
     * its caps. Returns how many lines went.
     *
     * Two rules the tests pin, both deliberate:
     *
     * 1. **Never drop below the cap.** A chunk is removed only when what remains
     *    after removing it still meets the cap, so the archive overshoots by less
     *    than one chunk rather than undershooting by up to one. A cap is a ceiling
     *    on cost, not a target to hit exactly, and holding slightly more history
     *    than asked is the harmless direction to be wrong in.
     * 2. **Never renumber.** Line numbers stay absolute; the archive simply starts
     *    later. Renumbering would invalidate every `startLine` a viewer is holding
     *    and every line number written into a gap marker.
     *
     * The newest chunk is never dropped, so a cap smaller than one chunk degrades
     * to "keep one chunk" instead of emptying the session.
     */
    private enforceCaps;
    private rewriteIndex;
    private appendIndex;
    private writeMeta;
    private readRange;
    private tailLines;
}
