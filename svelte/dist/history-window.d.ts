/**
 * Pure bounded archive-window model for TermView's future bidirectional pager.
 *
 * The model deliberately knows nothing about DOM, Svelte, ANSI rendering, or
 * WebSockets.  It owns only absolute line ranges, retained raw rows, budgets,
 * paging cursors, and the bookkeeping needed to keep one reader anchor fixed
 * while the resident range slides in either direction.
 */
import { type NewarchHistoryContinuation, type NewarchHistoryExtension, type NewarchHistoryState, type NewarchRowId, type NewarchV2Continuation, type NewarchV2FixedGeometry, type NewarchV2HistoryCursor, type NewarchV2HistoryReply, type NewarchV2Incident, type NewarchV2PaneDescriptor, type NewarchV2PaneSelection, type NewarchV2ReadState } from '@thumbmux/core';
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
    /** Opaque flag-on cursor for the older edge. Copied, never aliased to the caller. */
    flagOnCursorBefore?: Readonly<{
        version: 1;
        token: string;
    }>;
    /** Opaque flag-on cursor for the newer edge. */
    flagOnCursorAfter?: Readonly<{
        version: 1;
        token: string;
    }>;
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
    /**
     * Flag-on continuation for this direction. `blocked` (pending, gap,
     * remote-required, ...) keeps the edge pageable: it is never EOF, even when
     * the page carries no rows. Absent = legacy page, `hasMore` alone decides.
     */
    continuation?: HistoryWindowContinuation;
    /** Version 1 is readable. Any other shape is an unreadable cursor and refuses the page. */
    flagOnCursor?: {
        readonly version: number;
        readonly token: string;
    } | null;
}>;
export type HistoryWindowContinuation = NewarchHistoryContinuation['kind'];
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
    /** `blocked`: an empty page whose edge stays open (not EOF). */
    kind: 'committed' | 'boundary' | 'blocked';
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
    flagOnCursor?: Readonly<{
        version: 1;
        token: string;
    }>;
}> | Readonly<{
    direction: 'after';
    afterLine: number;
    flagOnCursor?: Readonly<{
        version: 1;
        token: string;
    }>;
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
export type HistoryStatusKind = Exclude<NewarchHistoryState['kind'], 'exact'>;
export type HistoryStatusNote = Readonly<{
    /** Stable identity from what the state names, never from row text. */
    key: string;
    kind: HistoryStatusKind;
    /** Thai sentence for a reader. */
    text: string;
    /** Diagnostic detail (reason, range, bundle); not shown as row text. */
    detail: string;
    /** Present for states that a later read may clear. */
    retryAfterMs: number | null;
    /**
     * Repair stop only. These sit beside the sentence: the sentence itself
     * stays free of the incident id, the wall time, and the row coordinate.
     * `leftRowId === null` means the stop happened before the first row.
     */
    openedAtWallMs?: number;
    incidentId?: string;
    leftRowId?: NewarchRowId | null;
}>;
/** Reader-facing words for one state; `exact` has nothing to say. */
export declare function historyStateLabel(state: NewarchHistoryState): string | null;
/** `seg:ordinal` for a real row, `none` before the first row, absent on a v1 note. */
export declare function historyIncidentLeftRowLabel(note: HistoryStatusNote): string | undefined;
/**
 * What the reader sees beside a repair stop: local wall time and the last row
 * kept. Undefined on a v1 note. Never carries the raw ms or the incident id.
 */
export declare function historyIncidentStopLabel(note: HistoryStatusNote): string | undefined;
/** One note per distinct state, including the states that block an edge. */
export declare function historyStatusNotes(extension: NewarchHistoryExtension): HistoryStatusNote[];
export declare function historyContinuationFor(extension: NewarchHistoryExtension, direction: HistoryWindowDirection): HistoryWindowContinuation;
export declare const NEWARCH_V2_NOTE_CAP = 64;
/** Visible sentence for one incident. Frontier null is before the first row. */
export declare function newarchV2IncidentLabel(incident: NewarchV2Incident): string;
/** Exact history has no label. A blocked store is never described as the end. */
export declare function newarchV2StateLabel(state: NewarchV2ReadState): string | null;
export type NewarchV2StatusNote = Readonly<{
    key: string;
    text: string;
}>;
/** Labels stay outside row text. The list is capped so a storm cannot grow without bound. */
export declare function newarchV2StatusNotes(input: {
    readonly entries: readonly ({
        readonly kind: 'incident';
        readonly incident: NewarchV2Incident;
    } | {
        readonly kind: 'row';
    })[];
    readonly states: readonly NewarchV2ReadState[];
}): NewarchV2StatusNote[];
/** Visible sentence for a pane that no longer collects. Active panes have none. */
export declare function newarchV2PaneStateLabel(pane: NewarchV2PaneDescriptor): string | null;
/** Local line the newest v2 row ends at when the window has no live seam. */
export declare const NEWARCH_V2_PAGER_BASE_LINE = 1000000000;
export type NewarchV2PagerPage = Readonly<{
    startLine: number;
    /** One stable row key per line, `segmentId:rowOrdinal`. */
    keys: readonly string[];
    /** Server cursor at this page's older edge; null = none known at this boundary. */
    before: NewarchV2Continuation | null;
    /** Server cursor at this page's newer edge; null = none known at this boundary. */
    after: NewarchV2Continuation | null;
}>;
export type NewarchV2PagerState = Readonly<{
    pane: NewarchV2PaneDescriptor;
    baseLine: number;
    /** Highest timeline revision a reply carried; an older reply is stale. */
    revision: number;
    /** Ascending, contiguous local line ranges. */
    pages: readonly NewarchV2PagerPage[];
    notes: readonly NewarchV2StatusNote[];
}>;
export type NewarchV2PagerAsk = Readonly<{
    kind: 'ask';
    direction: HistoryWindowDirection;
    cursor: NewarchV2HistoryCursor | null;
    edgeLine: number;
    overlap: number;
}> | Readonly<{
    kind: 'end';
}>
/** The edge has no known cursor (window outside the pager's pages). */
 | Readonly<{
    kind: 'unknown';
}>;
export type NewarchV2PagerApply = Readonly<{
    kind: 'page';
    state: NewarchV2PagerState;
    direction: HistoryWindowDirection;
    /** Local line of lines[0]; null for a page without new rows. */
    startLine: number | null;
    lines: readonly string[];
    /** The edge stays pageable: `more` or `blocked`. */
    hasMore: boolean;
    /** Storage/remote fault at this edge: never EOF. */
    blocked: boolean;
}>
/** Pane or timeline changed under the cursor: drop every cursor and restart. */
 | Readonly<{
    kind: 'reset';
    reason: 'wrong-pane' | 'stale-cursor';
}> | Readonly<{
    kind: 'retry';
    retryAfterMs: number | null;
    state: NewarchV2PagerState;
}> | Readonly<{
    kind: 'refused';
    reason: string;
}>;
export declare function createNewarchV2Pager(pane: NewarchV2PaneDescriptor, baseLine?: number): NewarchV2PagerState;
/**
 * The request for one edge of the resident window. `edgeLine` is the window's
 * first line (before) or its exclusive end (after). When the edge falls inside
 * a page, the pager asks from that page's nearest known boundary and reports
 * how many already-resident rows the reply must repeat (`overlap`).
 */
export declare function newarchV2PagerAsk(state: NewarchV2PagerState, direction: HistoryWindowDirection, edgeLine: number | null): NewarchV2PagerAsk;
/**
 * Apply one reply to the ask that produced it. Rows already resident (the
 * overlap) must come back identical, and no other row may repeat: a page
 * that would lose, duplicate, or reorder a row is refused, never drawn.
 */
export declare function applyNewarchV2PagerReply(state: NewarchV2PagerState, ask: Extract<NewarchV2PagerAsk, {
    kind: 'ask';
}>, reply: NewarchV2HistoryReply): NewarchV2PagerApply;
/**
 * Keep exactly the resident rows: pages outside the window are dropped and a
 * page cut by eviction keeps only its resident keys. A cut edge loses its
 * cursor (that position is no longer a page boundary), so a row that left the
 * window can come back once and is never mistaken for a duplicate.
 */
export declare function newarchV2PagerRetain(state: NewarchV2PagerState, range: HistoryWindowRange): NewarchV2PagerState;
/** Terminal rows only. Status sentences are not part of copy or search. */
export declare function newarchV2RowCopy(rows: readonly string[]): string;
export interface NewarchV2GeometryIntent {
    readonly source: 'viewport' | 'font' | 'fit-width' | 'rotation' | 'keyboard-inset' | 'apply-geometry';
    readonly columns: number;
    readonly rows: number;
}
/** Every viewer intent gets the birth geometry back. Nothing here is a resize write. */
export declare function answerNewarchV2Geometry(geometry: NewarchV2FixedGeometry, _intent: NewarchV2GeometryIntent): {
    readonly status: 'fixed';
    readonly geometry: NewarchV2FixedGeometry;
    readonly resize: null;
};
/** One pane is selected. Two or more stay a list, including a display-name collision. */
export declare function selectNewarchV2Panes(panes: readonly NewarchV2PaneDescriptor[], next: string | null): NewarchV2PaneSelection;
export interface NewarchV2Viewport {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly cellWidthPx: number;
    readonly cellHeightPx: number;
    readonly keyboardInsetPx: number;
    readonly fitWidth: boolean;
    readonly scrollXPx: number;
}
export interface NewarchV2Presentation {
    readonly columns: number;
    readonly rows: number;
    readonly scale: number;
    readonly contentWidthPx: number;
    readonly contentHeightPx: number;
    readonly visibleHeightPx: number;
    readonly maxScrollXPx: number;
    readonly scrollXPx: number;
    readonly horizontalScroll: boolean;
    readonly resize: null;
}
/**
 * Viewport, font, fit-width, rotation, and keyboard inset change only this
 * picture. Terminal columns and rows stay on the birth geometry.
 */
export declare function presentNewarchV2(terminal: {
    readonly columns: number;
    readonly rows: number;
}, viewport: NewarchV2Viewport): NewarchV2Presentation;
/** Horizontal padding TermView puts around the line: 6px each side. */
export declare const FONT_FIT_GUTTER_PX = 12;
/** Granularity of the fit search, in CSS pixels. */
export declare const FONT_FIT_STEP_PX = 0.05;
/** Upper bound on cell measurements after the first guess. */
export declare const FONT_FIT_MAX_PROBES = 8;
/**
 * Cell-to-font ratio used **only** when the measure returns nothing usable
 * (canvas not ready, font not loaded). It is a stand-in until the caller
 * re-measures — never the answer on a real screen, because installed fonts
 * give different cells.
 */
export declare const FONT_FIT_FALLBACK_CELL_RATIO = 0.6;
export type NewarchFontFitInput = {
    /** Birth columns of the fixed-geometry pane. */
    columns: number;
    /** Width of the terminal box in CSS pixels, gutter included. */
    containerWidthPx: number;
    /** Padding subtracted from the box. Defaults to `FONT_FIT_GUTTER_PX`. */
    gutterPx?: number;
    /** The user's size — the result never exceeds it. */
    ceilingPx: number;
    /** Lower and upper limits in CSS pixels (the shell's `fontPxMin` / `fontPxMax`). */
    bounds: {
        readonly min: number;
        readonly max: number;
    };
    /** Width of one cell at a given font size, as measured by the renderer. */
    measureCellPx: (fontPx: number) => number;
    /** Defaults to `auto`. */
    mode?: 'auto' | 'manual';
};
export type NewarchFontFitResult = {
    /** Size to render, at most two decimals. */
    fontPx: number;
    /** Whether `columns` cells fit the usable width at that size (no sideways scroll). */
    fits: boolean;
};
/**
 * Font size that makes a fixed-geometry pane's columns fit its box.
 *
 * Pure: it returns a size and whether it fits — never a resize. tmux keeps the
 * geometry the pane was born with; only the browser's font changes.
 *
 * - `manual`, or no usable geometry/width yet (columns ≤ 0, box not laid out):
 *   the ceiling as-is. An unlaid box does not collapse the font to the floor.
 * - Wide box: the ceiling exactly — the desktop never grows past the user size.
 * - Narrow box: the largest size on the 0.05px grid whose `columns × cell`
 *   fits, starting from the proportional guess and probing at most
 *   `FONT_FIT_MAX_PROBES` times. Never below `bounds.min`; if the floor still
 *   overflows, `fits` is false and the caller scrolls sideways.
 */
export declare function fitNewarchFontPx(input: NewarchFontFitInput): NewarchFontFitResult;
/** Map a viewport point through scroll and fit-width scale onto the fixed grid. */
export declare function hitNewarchV2Cell(presentation: NewarchV2Presentation, point: {
    readonly clientX: number;
    readonly clientY: number;
    readonly originX: number;
    readonly originY: number;
}, cell: {
    readonly widthPx: number;
    readonly heightPx: number;
}): {
    readonly col: number;
    readonly row: number;
} | null;
/**
 * Parse the optional `flagOn` envelope of a history page. Returns null for
 * anything unreadable or for capabilities this display does not know; the
 * caller must then refuse the page (not draw rows without their states).
 */
export declare function parseNewarchHistoryExtension(value: unknown): NewarchHistoryExtension | null;
