export type ContentUpdateMeta = {
    source: 'full' | 'delta';
    replace: boolean;
};
export type ContentLinesChangeSource = 'live' | 'replace';
export type ContentUpdate = {
    data: string;
    cursor?: {
        row: number;
        col: number;
    } | null;
    meta: ContentUpdateMeta;
    /** Preserves the newest frame's cause when reset application stays sticky. */
    linesChangeSource?: ContentLinesChangeSource;
};
export type ContentUpdateGate = {
    pending: ContentUpdate | null;
};
export type ContentUpdateBlock = {
    busy: boolean;
    selectionActive: boolean;
};
export type ContentUpdateGateResult = {
    gate: ContentUpdateGate;
    delivery: ContentUpdate | null;
};
export declare function createContentUpdateGate(): ContentUpdateGate;
/**
 * Route a reconstructed content delivery around an active selection or
 * gesture. A blocked view retains only the newest whole capture, so a later
 * flush can never replay stale content, cursor data, or reset semantics.
 */
export declare function receiveContentUpdate(gate: ContentUpdateGate, delivery: ContentUpdate, block: ContentUpdateBlock): ContentUpdateGateResult;
/**
 * Cursor-only frames are newer than the cursor bundled with a pending
 * content snapshot. Mirror them into that snapshot so a later flush cannot
 * replay the older caret position over the live cursor.
 */
export declare function updatePendingContentCursor(gate: ContentUpdateGate, cursor: {
    row: number;
    col: number;
} | null): ContentUpdateGate;
/**
 * Replacement is an application instruction, while this source is the cause
 * of the newest content. Any newer ordinary delivery coalesced after a reset
 * must still replace the local window, but represents unseen live output to
 * host UI.
 */
export declare function contentLinesChangeSource(update: ContentUpdate): ContentLinesChangeSource;
/** Flushes one coalesced delivery only when selection and gestures are idle. */
export declare function flushContentUpdate(gate: ContentUpdateGate, block: ContentUpdateBlock): ContentUpdateGateResult;
