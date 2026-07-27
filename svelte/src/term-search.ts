export type SearchDirection = 'next' | 'previous';
export type SearchKeyScope = 'input' | 'terminal';
export type SearchKeyIntent = 'open' | 'next' | 'previous' | 'close' | null;

export function searchKeyIntent(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>,
  scope: SearchKeyScope,
): SearchKeyIntent {
  if (event.isComposing) return null;

  if (event.key === 'Escape' || event.key === 'Esc') {
    return 'close';
  }

  const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey;

  if (scope === 'input') {
    if (event.key === 'Enter' && unmodified) {
      return event.shiftKey ? 'previous' : 'next';
    }
    return null;
  }

  if (scope === 'terminal') {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      return 'open';
    }

    if (unmodified) {
      if (event.key === 'n') return 'next';
      if (event.key === 'N') return 'previous';
    }
  }

  return null;
}

export function moveActiveIndex(
  activeIndex: number,
  matchCount: number,
  direction: SearchDirection,
): { activeIndex: number; wrapped: boolean } {
  if (matchCount <= 0) {
    return { activeIndex: -1, wrapped: false };
  }

  if (activeIndex < 0) {
    return {
      activeIndex: direction === 'next' ? 0 : matchCount - 1,
      wrapped: false,
    };
  }

  if (direction === 'next') {
    const next = activeIndex + 1;
    if (next >= matchCount) {
      return { activeIndex: 0, wrapped: true };
    }
    return { activeIndex: next, wrapped: false };
  }

  const previous = activeIndex - 1;
  if (previous < 0) {
    return { activeIndex: matchCount - 1, wrapped: true };
  }

  return { activeIndex: previous, wrapped: false };
}

export function nextGeneration(previous: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0) {
    return 1;
  }
  if (previous >= Number.MAX_SAFE_INTEGER) {
    return previous;
  }
  return previous + 1;
}

export type SparseOverlayCacheEntry = { generation: number; html: string };

/** Max rendered-HTML strings retained per search generation (~four screens). */
export const SPARSE_OVERLAY_CACHE_LIMIT = 512;

export function readSparseOverlay(
  cache: ReadonlyMap<number, SparseOverlayCacheEntry>,
  line: number,
  generation: number,
): string | undefined {
  const entry = cache.get(line);
  if (!entry || entry.generation !== generation) return undefined;
  return entry.html;
}

export function writeSparseOverlay(
  cache: Map<number, SparseOverlayCacheEntry>,
  line: number,
  generation: number,
  html: string,
): void {
  // Re-write refreshes recency (Map insertion order) without growing size.
  if (cache.has(line)) {
    cache.delete(line);
  } else {
    while (cache.size >= SPARSE_OVERLAY_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(line, { generation, html });
}

export type SearchJumpGeometry = {
  line: number; // rawLines index of the match
  total: number; // total rendered lines
  lineH: number; // px per row
  viewH: number; // visible viewport height in px
};

/**
 * bottomOffsetPx that centres `line` in the viewport, in TermView's
 * bottom-anchored scroll model (scrollTop = maxOffset - bottomOffsetPx).
 */
export function searchJumpBottomOffset(geometry: SearchJumpGeometry): number {
  const { line, total, lineH, viewH } = geometry;
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(lineH) ||
    !Number.isFinite(viewH) ||
    total <= 0 ||
    lineH <= 0 ||
    viewH <= 0
  ) {
    return 0;
  }

  const clampedLine = Number.isFinite(line)
    ? Math.max(0, Math.min(line, total - 1))
    : 0;
  const maxOffset = Math.max(0, total * lineH - Math.max(1, viewH));
  if (maxOffset <= 0) return 0;

  const targetScrollTop = Math.max(
    0,
    Math.min(clampedLine * lineH - (viewH / 2 - lineH / 2), maxOffset),
  );
  return Math.max(0, Math.min(maxOffset - targetScrollTop, maxOffset));
}

export type SearchOverlayState = {
  matchCount: number;
  rangeCount: number; // searchLineByIndex.size
  activeIndex: number;
  hasError: boolean;
};

/** True when the overlay holds state that a cleared query must tear down. */
export function hasSearchOverlayState(state: SearchOverlayState): boolean {
  return (
    state.matchCount > 0 ||
    state.rangeCount > 0 ||
    state.activeIndex >= 0 ||
    state.hasError
  );
}

export type PresentationGate = { busy: boolean; selectionActive: boolean };

/** Search re-parse and re-paint must wait until the gesture ends. */
export function shouldDeferSearchWork(gate: PresentationGate): boolean {
  return gate.busy || gate.selectionActive;
}

export type DeferredSearchRerunState<T> = {
  pending: boolean;
  identity: T | null;
};

export function createDeferredSearchRerunState<T = unknown>(): DeferredSearchRerunState<T> {
  return { pending: false, identity: null };
}

/**
 * Record a deferred search rerun. The first non-null identity wins — it was
 * captured before a history prepend shifted line indexes and is expressed in
 * absolute row ids.
 */
export function rememberDeferredSearchRerun<T>(
  state: DeferredSearchRerunState<T>,
  identity: T | null,
): DeferredSearchRerunState<T> {
  return {
    pending: true,
    identity: state.identity !== null ? state.identity : identity,
  };
}

/** Clear deferred rerun state after a flush (or query clear / destroy). */
export function clearDeferredSearchRerun<T = unknown>(): DeferredSearchRerunState<T> {
  return { pending: false, identity: null };
}

export type ArchiveContinuationQuery = {
  queryGeneration: number;
  archiveLoading: boolean;
  archiveExhausted: boolean;
};

export type ArchiveContinuationSettlement =
  | { kind: 'committed'; queryGeneration: number }
  | { kind: 'empty' | 'malformed' | 'timeout' | 'exhausted' | 'query-change' | 'destroy' };

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

export function createArchiveContinuationState(queryGeneration = 0): ArchiveContinuationState {
  return {
    queryGeneration,
    pendingRequestToken: null,
    nextRequestToken: 0,
  };
}

export function beginArchiveContinuation(
  state: ArchiveContinuationState,
  query: ArchiveContinuationQuery,
): ArchiveContinuationBeginTransition {
  const updatedState: ArchiveContinuationState = {
    ...state,
    queryGeneration: query.queryGeneration,
  };

  if (query.archiveLoading || query.archiveExhausted || updatedState.pendingRequestToken !== null) {
    return {
      state: updatedState,
      requestToken: null,
    };
  }

  const requestToken = nextGeneration(updatedState.nextRequestToken);
  return {
    state: {
      ...updatedState,
      pendingRequestToken: requestToken,
      nextRequestToken: requestToken,
    },
    requestToken,
  };
}

export function settleArchiveContinuation(
  state: ArchiveContinuationState,
  requestToken: number,
  settlement: ArchiveContinuationSettlement,
): ArchiveContinuationSettleTransition {
  if (state.pendingRequestToken !== requestToken) {
    return { state, shouldRerunSearch: false };
  }

  if (settlement.kind === 'committed') {
    return {
      state: { ...state, pendingRequestToken: null },
      shouldRerunSearch: settlement.queryGeneration === state.queryGeneration,
    };
  }

  return {
    state: { ...state, pendingRequestToken: null },
    shouldRerunSearch: false,
  };
}
