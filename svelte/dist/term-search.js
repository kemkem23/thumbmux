export function searchKeyIntent(event, scope) {
    if (event.isComposing)
        return null;
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
            if (event.key === 'n')
                return 'next';
            if (event.key === 'N')
                return 'previous';
        }
    }
    return null;
}
export function moveActiveIndex(activeIndex, matchCount, direction) {
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
export function nextGeneration(previous) {
    if (!Number.isSafeInteger(previous) || previous < 0) {
        return 1;
    }
    if (previous >= Number.MAX_SAFE_INTEGER) {
        return previous;
    }
    return previous + 1;
}
/** Max rendered-HTML strings retained per search generation (~four screens). */
export const SPARSE_OVERLAY_CACHE_LIMIT = 512;
export function readSparseOverlay(cache, line, generation) {
    const entry = cache.get(line);
    if (!entry || entry.generation !== generation)
        return undefined;
    return entry.html;
}
export function writeSparseOverlay(cache, line, generation, html) {
    // Re-write refreshes recency (Map insertion order) without growing size.
    if (cache.has(line)) {
        cache.delete(line);
    }
    else {
        while (cache.size >= SPARSE_OVERLAY_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined)
                break;
            cache.delete(oldest);
        }
    }
    cache.set(line, { generation, html });
}
/**
 * bottomOffsetPx that centres `line` in the viewport, in TermView's
 * bottom-anchored scroll model (scrollTop = maxOffset - bottomOffsetPx).
 */
export function searchJumpBottomOffset(geometry) {
    const { line, total, lineH, viewH } = geometry;
    if (!Number.isFinite(total) ||
        !Number.isFinite(lineH) ||
        !Number.isFinite(viewH) ||
        total <= 0 ||
        lineH <= 0 ||
        viewH <= 0) {
        return 0;
    }
    const clampedLine = Number.isFinite(line)
        ? Math.max(0, Math.min(line, total - 1))
        : 0;
    const maxOffset = Math.max(0, total * lineH - Math.max(1, viewH));
    if (maxOffset <= 0)
        return 0;
    const targetScrollTop = Math.max(0, Math.min(clampedLine * lineH - (viewH / 2 - lineH / 2), maxOffset));
    return Math.max(0, Math.min(maxOffset - targetScrollTop, maxOffset));
}
/** True when the overlay holds state that a cleared query must tear down. */
export function hasSearchOverlayState(state) {
    return (state.matchCount > 0 ||
        state.rangeCount > 0 ||
        state.activeIndex >= 0 ||
        state.hasError);
}
/** Search re-parse and re-paint must wait until the gesture ends. */
export function shouldDeferSearchWork(gate) {
    return gate.busy || gate.selectionActive;
}
export function createDeferredSearchRerunState() {
    return { pending: false, identity: null };
}
/**
 * Record a deferred search rerun. The first non-null identity wins — it was
 * captured before a history prepend shifted line indexes and is expressed in
 * absolute row ids.
 */
export function rememberDeferredSearchRerun(state, identity) {
    return {
        pending: true,
        identity: state.identity !== null ? state.identity : identity,
    };
}
/** Clear deferred rerun state after a flush (or query clear / destroy). */
export function clearDeferredSearchRerun() {
    return { pending: false, identity: null };
}
export function createArchiveContinuationState(queryGeneration = 0) {
    return {
        queryGeneration,
        pendingRequestToken: null,
        nextRequestToken: 0,
    };
}
export function beginArchiveContinuation(state, query) {
    const updatedState = {
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
export function settleArchiveContinuation(state, requestToken, settlement) {
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
