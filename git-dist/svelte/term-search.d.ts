export type SearchDirection = 'next' | 'previous';
export type SearchKeyScope = 'input' | 'terminal';
export type SearchKeyIntent = 'open' | 'next' | 'previous' | 'close' | null;
export declare function searchKeyIntent(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>, scope: SearchKeyScope): SearchKeyIntent;
export declare function moveActiveIndex(activeIndex: number, matchCount: number, direction: SearchDirection): {
    activeIndex: number;
    wrapped: boolean;
};
export declare function nextGeneration(previous: number): number;
export type SparseOverlayCacheEntry = {
    generation: number;
    html: string;
};
/** Max rendered-HTML strings retained per search generation (~four screens). */
export declare const SPARSE_OVERLAY_CACHE_LIMIT = 512;
export declare function readSparseOverlay(cache: ReadonlyMap<number, SparseOverlayCacheEntry>, line: number, generation: number): string | undefined;
export declare function writeSparseOverlay(cache: Map<number, SparseOverlayCacheEntry>, line: number, generation: number, html: string): void;
export type SearchJumpGeometry = {
    line: number;
    total: number;
    lineH: number;
    viewH: number;
};
/**
 * bottomOffsetPx that centres `line` in the viewport, in TermView's
 * bottom-anchored scroll model (scrollTop = maxOffset - bottomOffsetPx).
 */
export declare function searchJumpBottomOffset(geometry: SearchJumpGeometry): number;
export type SearchOverlayState = {
    matchCount: number;
    rangeCount: number;
    activeIndex: number;
    hasError: boolean;
};
/** True when the overlay holds state that a cleared query must tear down. */
export declare function hasSearchOverlayState(state: SearchOverlayState): boolean;
export type PresentationGate = {
    busy: boolean;
    selectionActive: boolean;
};
/** Search re-parse and re-paint must wait until the gesture ends. */
export declare function shouldDeferSearchWork(gate: PresentationGate): boolean;
export type DeferredSearchRerunState<T> = {
    pending: boolean;
    identity: T | null;
};
export declare function createDeferredSearchRerunState<T = unknown>(): DeferredSearchRerunState<T>;
/**
 * Record a deferred search rerun. The first non-null identity wins — it was
 * captured before a history prepend shifted line indexes and is expressed in
 * absolute row ids.
 */
export declare function rememberDeferredSearchRerun<T>(state: DeferredSearchRerunState<T>, identity: T | null): DeferredSearchRerunState<T>;
/** Clear deferred rerun state after a flush (or query clear / destroy). */
export declare function clearDeferredSearchRerun<T = unknown>(): DeferredSearchRerunState<T>;
export type ArchiveContinuationQuery = {
    queryGeneration: number;
    archiveLoading: boolean;
    archiveExhausted: boolean;
};
export type ArchiveContinuationSettlement = {
    kind: 'committed';
    queryGeneration: number;
} | {
    kind: 'empty' | 'malformed' | 'timeout' | 'exhausted' | 'query-change' | 'destroy';
};
export type ArchiveContinuationState = {
    /** The current query generation the search session is interested in. */
    readonly queryGeneration: number;
    /** Token in-flight for one outstanding archive-prepend request, or null when idle. */
    readonly pendingRequestToken: number | null;
    /** Monotonic token allocator for future requests. */
    readonly nextRequestToken: number;
};
export type ArchiveContinuationBeginTransition = {
    /** Next pure state after evaluating whether a request should be emitted. */
    state: ArchiveContinuationState;
    /** New request token if a request should be emitted; null means no request yet. */
    requestToken: number | null;
};
export type ArchiveContinuationSettleTransition = {
    /** Next pure state after receiving a response for a request token. */
    state: ArchiveContinuationState;
    /** Whether the committed result should trigger a rerun of search. */
    shouldRerunSearch: boolean;
};
export declare function createArchiveContinuationState(queryGeneration?: number): ArchiveContinuationState;
export declare function beginArchiveContinuation(state: ArchiveContinuationState, query: ArchiveContinuationQuery): ArchiveContinuationBeginTransition;
export declare function settleArchiveContinuation(state: ArchiveContinuationState, requestToken: number, settlement: ArchiveContinuationSettlement): ArchiveContinuationSettleTransition;
