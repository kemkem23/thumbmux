import { describe, expect, test } from 'bun:test';
import {
  type ArchiveContinuationQuery,
  type ArchiveContinuationSettlement,
  beginArchiveContinuation,
  clearDeferredSearchRerun,
  createArchiveContinuationState,
  createDeferredSearchRerunState,
  hasSearchOverlayState,
  moveActiveIndex,
  nextGeneration,
  readSparseOverlay,
  rememberDeferredSearchRerun,
  searchJumpBottomOffset,
  searchKeyIntent,
  settleArchiveContinuation,
  shouldDeferSearchWork,
  SPARSE_OVERLAY_CACHE_LIMIT,
  writeSparseOverlay,
} from '../src/term-search';

type SearchKeyEvent = Parameters<typeof searchKeyIntent>[0];

function keyEvent(partial: Partial<SearchKeyEvent>): SearchKeyEvent {
  return {
    key: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...partial,
  };
}

function archiveQuery(opts: Partial<ArchiveContinuationQuery>): ArchiveContinuationQuery {
  return {
    queryGeneration: 0,
    archiveLoading: false,
    archiveExhausted: false,
    ...opts,
  };
}

describe('moveActiveIndex', () => {
  test('returns inactive and no wrap when there are no matches', () => {
    for (const direction of ['next', 'previous'] as const) {
      expect(moveActiveIndex(-1, 0, direction)).toEqual({ activeIndex: -1, wrapped: false });
      expect(moveActiveIndex(2, 0, direction)).toEqual({ activeIndex: -1, wrapped: false });
    }
  });

  test('moves from inactive to first or last depending on direction', () => {
    expect(moveActiveIndex(-1, 4, 'next')).toEqual({ activeIndex: 0, wrapped: false });
    expect(moveActiveIndex(-1, 4, 'previous')).toEqual({ activeIndex: 3, wrapped: false });
  });

  test('advances and retreats with wrapping diagnostics', () => {
    expect(moveActiveIndex(1, 3, 'next')).toEqual({ activeIndex: 2, wrapped: false });
    expect(moveActiveIndex(2, 3, 'next')).toEqual({ activeIndex: 0, wrapped: true });
    expect(moveActiveIndex(1, 3, 'previous')).toEqual({ activeIndex: 0, wrapped: false });
    expect(moveActiveIndex(0, 3, 'previous')).toEqual({ activeIndex: 2, wrapped: true });
  });
});

describe('searchKeyIntent', () => {
  test('ignores composed input', () => {
    expect(searchKeyIntent(keyEvent({ key: 'f', ctrlKey: true, isComposing: true }), 'terminal')).toBeNull();
  });

  test('keeps Ctrl+F and Cmd+F terminal-only', () => {
    expect(searchKeyIntent(keyEvent({ key: 'f', ctrlKey: true }), 'terminal')).toBe('open');
    expect(searchKeyIntent(keyEvent({ key: 'F', metaKey: true }), 'terminal')).toBe('open');
    expect(searchKeyIntent(keyEvent({ key: 'f', ctrlKey: true }), 'input')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'F', metaKey: true }), 'input')).toBeNull();
  });

  test('uses Enter and Shift+Enter only in input scope', () => {
    expect(searchKeyIntent(keyEvent({ key: 'Enter' }), 'input')).toBe('next');
    expect(searchKeyIntent(keyEvent({ key: 'Enter', shiftKey: true }), 'input')).toBe('previous');
    expect(searchKeyIntent(keyEvent({ key: 'Enter' }), 'terminal')).toBeNull();
  });

  test('maps Escape to close in both terminal and input scopes', () => {
    expect(searchKeyIntent(keyEvent({ key: 'Escape' }), 'terminal')).toBe('close');
    expect(searchKeyIntent(keyEvent({ key: 'Esc' }), 'input')).toBe('close');
  });

  test('uses plain terminal n/N, but not input text and not modified/composing typing', () => {
    expect(searchKeyIntent(keyEvent({ key: 'n' }), 'terminal')).toBe('next');
    expect(searchKeyIntent(keyEvent({ key: 'N' }), 'terminal')).toBe('previous');
    expect(searchKeyIntent(keyEvent({ key: 'n' }), 'input')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'N' }), 'input')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'n', ctrlKey: true }), 'terminal')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'n', metaKey: true }), 'terminal')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'N', altKey: true }), 'terminal')).toBeNull();
    expect(searchKeyIntent(keyEvent({ key: 'N', isComposing: true }), 'terminal')).toBeNull();
  });
});

describe('generation and sparse overlay cache', () => {
  test('increments generation deterministically for current and next values', () => {
    const base = 42;
    expect(nextGeneration(base)).toBe(43);
    expect(nextGeneration(-1)).toBe(1);
  });

  test('does not allocate on stale-generation miss and reads a current hit', () => {
    const cache = new Map<number, { generation: number; html: string }>();
    writeSparseOverlay(cache, 12, 1, '<hit>');

    expect(cache.size).toBe(1);
    expect(readSparseOverlay(cache, 12, 2)).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(readSparseOverlay(cache, 12, 1)).toBe('<hit>');
  });

  test('replaces a line entry with the same-line newer generation/value', () => {
    const cache = new Map<number, { generation: number; html: string }>();
    writeSparseOverlay(cache, 4, 1, '<old>');
    writeSparseOverlay(cache, 4, 2, '<new>');

    expect(cache.get(4)).toEqual({ generation: 2, html: '<new>' });
    expect(readSparseOverlay(cache, 4, 2)).toBe('<new>');
  });

  test('stores sparse rows, not full-buffer index coverage', () => {
    const cache = new Map<number, { generation: number; html: string }>();
    writeSparseOverlay(cache, 3, 7, '<row 3>');
    writeSparseOverlay(cache, 98, 7, '<row 98>');

    expect(cache.size).toBe(2);
    expect(readSparseOverlay(cache, 0, 7)).toBeUndefined();
    expect(readSparseOverlay(cache, 50, 7)).toBeUndefined();
    expect(readSparseOverlay(cache, 98, 7)).toBe('<row 98>');
  });
});

describe('archive continuation state machine', () => {
  test('creates default state and emits exactly one request when eligible', () => {
    const created = createArchiveContinuationState();
    const begin = beginArchiveContinuation(created, archiveQuery({ queryGeneration: 1 }));

    expect(created).toEqual({
      queryGeneration: 0,
      pendingRequestToken: null,
      nextRequestToken: 0,
    });
    expect(begin.requestToken).toBe(1);
    expect(begin.state).toEqual({
      queryGeneration: 1,
      pendingRequestToken: 1,
      nextRequestToken: 1,
    });
  });

  test('suppresses duplicate begin while a request is already in-flight', () => {
    const first = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({ queryGeneration: 2 }));
    const duplicate = beginArchiveContinuation(first.state, archiveQuery({ queryGeneration: 2 }));

    expect(first.requestToken).toBe(1);
    expect(duplicate.requestToken).toBeNull();
    expect(duplicate.state).toEqual(first.state);
  });

  test('suppresses begin while loading or exhausted', () => {
    const loading = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({
      queryGeneration: 3,
      archiveLoading: true,
    }));
    expect(loading.requestToken).toBeNull();
    expect(loading.state).toEqual({
      queryGeneration: 3,
      pendingRequestToken: null,
      nextRequestToken: 0,
    });

    const exhausted = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({
      queryGeneration: 4,
      archiveExhausted: true,
    }));
    expect(exhausted.requestToken).toBeNull();
    expect(exhausted.state).toEqual({
      queryGeneration: 4,
      pendingRequestToken: null,
      nextRequestToken: 0,
    });
  });

  test('reruns search only on same-token committed settle for current generation', () => {
    const begin = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({ queryGeneration: 9 }));
    const settled = settleArchiveContinuation(begin.state, begin.requestToken!, {
      kind: 'committed',
      queryGeneration: 9,
    });

    expect(begin.requestToken).toBe(1);
    expect(settled.shouldRerunSearch).toBe(true);
    expect(settled.state).toEqual({
      queryGeneration: 9,
      pendingRequestToken: null,
      nextRequestToken: 1,
    });
  });

  test('does not rerun on stale token or stale generation', () => {
    const baseline = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({ queryGeneration: 10 }));
    const staleToken = settleArchiveContinuation(baseline.state, 999, { kind: 'committed', queryGeneration: 10 });
    expect(staleToken.shouldRerunSearch).toBe(false);
    expect(staleToken.state).toEqual({
      queryGeneration: 10,
      pendingRequestToken: baseline.requestToken,
      nextRequestToken: 1,
    });

    const staleGeneration = settleArchiveContinuation(baseline.state, baseline.requestToken!, {
      kind: 'committed',
      queryGeneration: 9,
    });
    expect(staleGeneration.shouldRerunSearch).toBe(false);
    expect(staleGeneration.state).toEqual({
      queryGeneration: 10,
      pendingRequestToken: null,
      nextRequestToken: 1,
    });
  });

  test('does not rerun for non-searchable settlements', () => {
    const kinds: Exclude<ArchiveContinuationSettlement, { kind: 'committed'; queryGeneration: number }>[] = [
      { kind: 'empty' },
      { kind: 'malformed' },
      { kind: 'timeout' },
      { kind: 'exhausted' },
      { kind: 'query-change' },
      { kind: 'destroy' },
    ];

    for (const settlement of kinds) {
      const begin = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({ queryGeneration: 4 }));
      expect(begin.requestToken).toBe(1);

      const settled = settleArchiveContinuation(begin.state, begin.requestToken, settlement);
      expect(settled.shouldRerunSearch).toBe(false);
      expect(settled.state).toEqual({
        queryGeneration: 4,
        pendingRequestToken: null,
        nextRequestToken: 1,
      });
    }
  });

  test('aborts a prior query-generation request when query changes and allows a fresh emission', () => {
    const firstBegin = beginArchiveContinuation(createArchiveContinuationState(), archiveQuery({ queryGeneration: 1 }));
    const queryChangeBegin = beginArchiveContinuation(firstBegin.state, archiveQuery({
      queryGeneration: 2,
      archiveLoading: false,
      archiveExhausted: false,
    }));

    expect(queryChangeBegin.requestToken).toBeNull();
    expect(queryChangeBegin.state.queryGeneration).toBe(2);

    const staleSettle = settleArchiveContinuation(queryChangeBegin.state, firstBegin.requestToken!, {
      kind: 'committed',
      queryGeneration: 1,
    });
    expect(staleSettle.shouldRerunSearch).toBe(false);
    expect(staleSettle.state).toEqual({
      queryGeneration: 2,
      pendingRequestToken: null,
      nextRequestToken: 1,
    });

    const continuation = beginArchiveContinuation(staleSettle.state, archiveQuery({ queryGeneration: 2 }));
    expect(continuation.requestToken).toBe(2);
    expect(continuation.state).toEqual({
      queryGeneration: 2,
      pendingRequestToken: 2,
      nextRequestToken: 2,
    });
  });
});

describe('searchJumpBottomOffset', () => {
  function maxOffset(total: number, lineH: number, viewH: number): number {
    return Math.max(0, total * lineH - Math.max(1, viewH));
  }

  function assertMatchVisible(total: number, lineH: number, viewH: number, line: number) {
    const mo = maxOffset(total, lineH, viewH);
    const offset = searchJumpBottomOffset({ line, total, lineH, viewH });
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(mo);
    const scrollTop = mo - offset;
    const rowY = line * lineH - scrollTop;
    // Matched row's top edge must sit inside the viewport.
    expect(rowY).toBeGreaterThanOrEqual(0);
    expect(rowY).toBeLessThan(viewH);
  }

  test('centres match inside viewport for the verified simulation table', () => {
    const total = 1000;
    const lineH = 20;
    const viewH = 600;
    const mo = maxOffset(total, lineH, viewH);
    expect(mo).toBe(19400);

    // Pinned numeric regression anchors (scrollTop = maxOffset - offset).
    // line 100 → targetScrollTop 1710 → offset 17690
    // line 500 → targetScrollTop 9710 → offset 9690
    expect(searchJumpBottomOffset({ line: 100, total, lineH, viewH })).toBe(17690);
    expect(searchJumpBottomOffset({ line: 500, total, lineH, viewH })).toBe(9690);

    for (const line of [0, 100, 500, 999, total - 1]) {
      assertMatchVisible(total, lineH, viewH, line);
    }
  });

  test('returns 0 when content fits the viewport (maxOffset === 0)', () => {
    expect(searchJumpBottomOffset({ line: 3, total: 10, lineH: 20, viewH: 600 })).toBe(0);
  });

  test('returns 0 for a single-line buffer', () => {
    expect(searchJumpBottomOffset({ line: 0, total: 1, lineH: 20, viewH: 600 })).toBe(0);
  });

  test('clamps line into [0, total-1] and guards non-finite / non-positive geometry', () => {
    const total = 100;
    const lineH = 20;
    const viewH = 400;
    const mo = maxOffset(total, lineH, viewH);

    const low = searchJumpBottomOffset({ line: -50, total, lineH, viewH });
    const high = searchJumpBottomOffset({ line: 9999, total, lineH, viewH });
    expect(low).toBe(searchJumpBottomOffset({ line: 0, total, lineH, viewH }));
    expect(high).toBe(searchJumpBottomOffset({ line: total - 1, total, lineH, viewH }));
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(mo);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(mo);

    expect(searchJumpBottomOffset({ line: 5, total: 0, lineH, viewH })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total: -1, lineH, viewH })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH: 0, viewH })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH: -2, viewH })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH, viewH: 0 })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH, viewH: -10 })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH: Number.NaN, viewH })).toBe(0);
    expect(searchJumpBottomOffset({ line: 5, total, lineH, viewH: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe('hasSearchOverlayState', () => {
  test('all-empty is false', () => {
    expect(hasSearchOverlayState({
      matchCount: 0,
      rangeCount: 0,
      activeIndex: -1,
      hasError: false,
    })).toBe(false);
  });

  test('each single non-empty field is true', () => {
    expect(hasSearchOverlayState({
      matchCount: 1,
      rangeCount: 0,
      activeIndex: -1,
      hasError: false,
    })).toBe(true);
    expect(hasSearchOverlayState({
      matchCount: 0,
      rangeCount: 3,
      activeIndex: -1,
      hasError: false,
    })).toBe(true);
    expect(hasSearchOverlayState({
      matchCount: 0,
      rangeCount: 0,
      activeIndex: 0,
      hasError: false,
    })).toBe(true);
    expect(hasSearchOverlayState({
      matchCount: 0,
      rangeCount: 0,
      activeIndex: -1,
      hasError: true,
    })).toBe(true);
  });

  test('activeIndex === -1 with everything else empty is false', () => {
    expect(hasSearchOverlayState({
      matchCount: 0,
      rangeCount: 0,
      activeIndex: -1,
      hasError: false,
    })).toBe(false);
  });
});

describe('shouldDeferSearchWork', () => {
  test('defers when busy or selection is active', () => {
    expect(shouldDeferSearchWork({ busy: false, selectionActive: false })).toBe(false);
    expect(shouldDeferSearchWork({ busy: true, selectionActive: false })).toBe(true);
    expect(shouldDeferSearchWork({ busy: false, selectionActive: true })).toBe(true);
    expect(shouldDeferSearchWork({ busy: true, selectionActive: true })).toBe(true);
  });
});

describe('deferred search rerun identity', () => {
  test('first non-null identity wins across two deferrals and flush clears', () => {
    let state = createDeferredSearchRerunState<{ rowId: number }>();
    expect(state).toEqual({ pending: false, identity: null });

    state = rememberDeferredSearchRerun(state, { rowId: 10 });
    expect(state).toEqual({ pending: true, identity: { rowId: 10 } });

    state = rememberDeferredSearchRerun(state, { rowId: 99 });
    expect(state).toEqual({ pending: true, identity: { rowId: 10 } });

    state = clearDeferredSearchRerun();
    expect(state).toEqual({ pending: false, identity: null });
  });

  test('null first then non-null keeps the first non-null', () => {
    let state = createDeferredSearchRerunState<string>();
    state = rememberDeferredSearchRerun(state, null);
    expect(state).toEqual({ pending: true, identity: null });

    state = rememberDeferredSearchRerun(state, 'A');
    expect(state).toEqual({ pending: true, identity: 'A' });

    state = rememberDeferredSearchRerun(state, 'B');
    expect(state).toEqual({ pending: true, identity: 'A' });
  });
});

describe('sparse overlay cache eviction bound', () => {
  test(`writing LIMIT + 50 distinct lines leaves exactly LIMIT entries`, () => {
    const cache = new Map<number, { generation: number; html: string }>();
    const limit = SPARSE_OVERLAY_CACHE_LIMIT;
    for (let i = 0; i < limit + 50; i += 1) {
      writeSparseOverlay(cache, i, 1, `<row ${i}>`);
    }
    expect(cache.size).toBe(limit);
    // Oldest keys (0..49) are gone; newest (50 .. LIMIT+49) remain.
    for (let i = 0; i < 50; i += 1) {
      expect(readSparseOverlay(cache, i, 1)).toBeUndefined();
    }
    for (let i = 50; i < limit + 50; i += 1) {
      expect(readSparseOverlay(cache, i, 1)).toBe(`<row ${i}>`);
    }
  });

  test('re-writing an existing key keeps size stable and refreshes recency', () => {
    const cache = new Map<number, { generation: number; html: string }>();
    const limit = SPARSE_OVERLAY_CACHE_LIMIT;
    for (let i = 0; i < limit; i += 1) {
      writeSparseOverlay(cache, i, 1, `<row ${i}>`);
    }
    expect(cache.size).toBe(limit);

    writeSparseOverlay(cache, 0, 1, '<row 0 refreshed>');
    expect(cache.size).toBe(limit);
    expect(readSparseOverlay(cache, 0, 1)).toBe('<row 0 refreshed>');

    // Insert one more — key 0 (refreshed) survives; key 1 (oldest) is evicted.
    writeSparseOverlay(cache, limit, 1, `<row ${limit}>`);
    expect(cache.size).toBe(limit);
    expect(readSparseOverlay(cache, 0, 1)).toBe('<row 0 refreshed>');
    expect(readSparseOverlay(cache, 1, 1)).toBeUndefined();
    expect(readSparseOverlay(cache, limit, 1)).toBe(`<row ${limit}>`);
  });
});
