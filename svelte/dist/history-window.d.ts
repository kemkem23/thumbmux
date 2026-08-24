/**
 * Pure bounded archive-window model for TermView's future bidirectional pager.
 *
 * The model deliberately knows nothing about DOM, Svelte, ANSI rendering, or
 * WebSockets.  It owns only absolute line ranges, retained raw rows, budgets,
 * paging cursors, and the bookkeeping needed to keep one reader anchor fixed
 * while the resident range slides in either direction.
 */
export declare const HISTORY_WINDOW_MAX_ROWS = 10000;
export declare const HISTORY_WINDOW_MAX_BYTES: number;
export declare const HISTORY_WINDOW_ROW_OVERHEAD_BYTES = 64;
export type HistoryWindowDirection = 'before' | 'after';
export type HistoryWindowLimits = Readonly<{
    maxRows: number;
    maxBytes: number;
    /** Deterministic client-side storage estimate, matching TermView today. */
    rowOverheadBytes: number;
}>;
export type HistoryWindowRange = Readonly<{
    /** Inclusive absolute line number. */
    startLine: number;
    /** Exclusive absolute line number. */
    endLine: number;
}>;
export type HistoryWindowRangeStats = HistoryWindowRange & Readonly<{
    rowCount: number;
    estimatedBytes: number;
}>;
export type HistoryWindowState = Readonly<{
    /** Absolute line number represented by lines[0]. */
    startLine: number;
    lines: readonly string[];
    /** One deterministic estimate per entry in lines. */
    lineBytes: readonly number[];
    estimatedBytes: number;
    /** Older/newer rows exist outside the resident window and can be paged. */
    hasOlder: boolean;
    hasNewer: boolean;
    limits: HistoryWindowLimits;
}>;
export type CreateHistoryWindowOptions = Readonly<{
    startLine: number;
    lines: readonly string[];
    lineBytes?: readonly number[];
    hasOlder?: boolean;
    hasNewer?: boolean;
    limits?: Partial<HistoryWindowLimits>;
}>;
/**
 * The row the UI promises not to move, plus its current physical position.
 * `viewportOffsetPx` is carried through unchanged; `indexDelta` in the commit
 * result tells a renderer how many row strides its local scroll origin moved.
 */
export type HistoryWindowAnchor = Readonly<{
    line: number;
    viewportOffsetPx: number;
}>;
export type HistoryWindowAnchorCommit = Readonly<{
    line: number;
    viewportOffsetPx: number;
    previousIndex: number;
    nextIndex: number;
    /** Add indexDelta * rowHeight to local scrollTop to keep the same pixel Y. */
    indexDelta: number;
    preserved: true;
}>;
/** A page response correlated to the exclusive cursor that requested it. */
export type HistoryWindowPage = Readonly<{
    direction: HistoryWindowDirection;
    /** `beforeLine` for before, `afterLine` for after. */
    anchorLine: number;
    /** Absolute number of lines[0]; null is accepted only for an empty page. */
    startLine: number | null;
    lines: readonly string[];
    lineBytes?: readonly number[];
    /** Direction-relative server continuation flag. */
    hasMore: boolean;
}>;
export type ApplyHistoryWindowOptions = Readonly<{
    anchor: HistoryWindowAnchor;
    /**
     * Optional mounted viewport + overscan range.  The default protects only
     * the anchor row.  The range must be inside the pre-commit resident window
     * and must contain the anchor.
     */
    protectedRange?: HistoryWindowRange;
}>;
export type HistoryWindowApplySuccess = Readonly<{
    kind: 'committed' | 'boundary';
    state: HistoryWindowState;
    anchor: HistoryWindowAnchorCommit;
    /** Portion of the incoming page retained in state; null for an empty page. */
    acceptedPage: HistoryWindowRangeStats | null;
    /** Existing rows evicted from the side opposite the paging direction. */
    evictedOpposite: HistoryWindowRangeStats | null;
    /**
     * Incoming far-edge rows not retained when the protected range alone left
     * insufficient room. They remain server-addressable through hasOlder/newer.
     */
    discardedIncoming: HistoryWindowRangeStats | null;
}>;
export type HistoryWindowRejectReason = 'invalid-state' | 'invalid-anchor' | 'invalid-protected-range' | 'invalid-page' | 'stale-cursor' | 'non-contiguous-page' | 'empty-page-with-more' | 'budget-cannot-preserve-anchor';
export type HistoryWindowApplyRejected = Readonly<{
    kind: 'rejected';
    state: HistoryWindowState;
    reason: HistoryWindowRejectReason;
    message: string;
}>;
export type HistoryWindowApplyResult = HistoryWindowApplySuccess | HistoryWindowApplyRejected;
export type HistoryWindowRequestCursor = Readonly<{
    direction: 'before';
    beforeLine: number;
}> | Readonly<{
    direction: 'after';
    afterLine: number;
}>;
/** TermView-compatible deterministic estimate (UTF-16 payload + row slot). */
export declare function estimateHistoryWindowLineBytes(line: string, rowOverheadBytes?: number): number;
/** Construct a valid, already-bounded resident range without retaining inputs. */
export declare function createHistoryWindow(options: CreateHistoryWindowOptions): HistoryWindowState;
export declare function historyWindowEndLine(state: HistoryWindowState): number;
export declare function historyWindowRange(state: HistoryWindowState): HistoryWindowRange;
export declare function historyWindowContains(state: HistoryWindowState, line: number): boolean;
/** Return the next exclusive wire cursor, or null at that resident boundary. */
export declare function historyWindowRequestCursor(state: HistoryWindowState, direction: HistoryWindowDirection): HistoryWindowRequestCursor | null;
/**
 * Merge one adjacent page and enforce both budgets.
 *
 * `before` first evicts existing rows from the newer/end side; `after` first
 * evicts from the older/start side.  The protected range is never evicted.
 * If that range leaves too little room, only the incoming page's far edge is
 * discarded, keeping the accepted rows contiguous and re-fetchable later.
 */
export declare function applyHistoryWindowPage(state: HistoryWindowState, page: HistoryWindowPage, options: ApplyHistoryWindowOptions): HistoryWindowApplyResult;
