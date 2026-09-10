/**
 * Reconcile a fresh capture against what a durable archive already holds.
 *
 * The boundary this uses is the one tmux guarantees: `capture-pane` returns
 * scrollback followed by the visible screen, and only the visible screen can be
 * repainted in place. Rows above it have scrolled into tmux history and can no
 * longer change, so they are safe to store. Nothing here encodes how many rows
 * an agent's composer redraws — that number is a property of the agent, and
 * every version of this logic that tried to guess it lost real history.
 */
export type AnchorMatch = {
    index: number;
} | "missing" | "ambiguous";
/** Locate `needle` in `hay`. Two matches are as useless as none. */
export declare function locateAnchor(hay: readonly string[], needle: readonly string[]): AnchorMatch;
export type StitchInput = {
    /** Newest archived lines, used to find where we already are in this capture. */
    archivedTail: readonly string[];
    /** A whole `capture-pane` result: scrollback then the visible screen. */
    captured: readonly string[];
    /** Height of the visible screen — the only region tmux can repaint. */
    paneRows: number;
    /** What the mux serves as live. Reported, never used to limit storage. */
    liveLineLimit: number;
};
export type StitchResult = {
    /** Lines to append, in order. */
    appended: string[];
    /** True when the archive tail was found — the history is provably continuous. */
    anchored: boolean;
    /** True when the anchor was ambiguous: write nothing, try again next capture. */
    deferred: boolean;
    /** True when the capture holds nothing above the visible screen yet. */
    tooShort: boolean;
};
export declare function stitchCapture(input: StitchInput): StitchResult;
