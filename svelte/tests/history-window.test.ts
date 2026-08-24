import { describe, expect, test } from 'bun:test';
import {
  HISTORY_WINDOW_MAX_BYTES,
  HISTORY_WINDOW_MAX_ROWS,
  HISTORY_WINDOW_ROW_OVERHEAD_BYTES,
  applyHistoryWindowPage,
  createHistoryWindow,
  estimateHistoryWindowLineBytes,
  historyWindowEndLine,
  historyWindowRange,
  historyWindowRequestCursor,
  type HistoryWindowAnchor,
  type HistoryWindowState,
} from '../src/history-window';

function rows(startLine: number, count: number, payload = ''): string[] {
  return Array.from(
    { length: count },
    (_, offset) => `line-${startLine + offset}${payload}`,
  );
}

function lineNumber(line: string): number {
  const match = /^line-(\d+)/.exec(line);
  if (!match) throw new Error(`not a generated line: ${line}`);
  return Number(match[1]);
}

function anchor(line: number, viewportOffsetPx = 73.25): HistoryWindowAnchor {
  return { line, viewportOffsetPx };
}

function committed(result: ReturnType<typeof applyHistoryWindowPage>) {
  if (result.kind !== 'committed') {
    throw new Error(`expected committed result, got ${result.kind}${result.kind === 'rejected' ? `: ${result.message}` : ''}`);
  }
  return result;
}

function assertBounded(state: HistoryWindowState): void {
  expect(state.lines.length).toBeLessThanOrEqual(state.limits.maxRows);
  expect(state.estimatedBytes).toBeLessThanOrEqual(state.limits.maxBytes);
  expect(state.lineBytes).toHaveLength(state.lines.length);
  expect(state.lineBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(state.estimatedBytes);
  expect(state.lines.map(lineNumber)).toEqual(
    Array.from({ length: state.lines.length }, (_, index) => state.startLine + index),
  );
}

describe('history window defaults and cursors', () => {
  test('uses the TermView 10k / 8 MiB deterministic budgets', () => {
    expect(HISTORY_WINDOW_MAX_ROWS).toBe(10_000);
    expect(HISTORY_WINDOW_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(HISTORY_WINDOW_ROW_OVERHEAD_BYTES).toBe(64);
    expect(estimateHistoryWindowLineBytes('abc')).toBe(70);

    const source = rows(100, 3);
    const state = createHistoryWindow({
      startLine: 100,
      lines: source,
      hasOlder: true,
      hasNewer: true,
    });
    source[0] = 'caller-mutated';

    expect(state.lines[0]).toBe('line-100');
    expect(state.limits).toEqual({
      maxRows: 10_000,
      maxBytes: 8 * 1024 * 1024,
      rowOverheadBytes: 64,
    });
    expect(historyWindowRange(state)).toEqual({ startLine: 100, endLine: 103 });
    expect(historyWindowRequestCursor(state, 'before')).toEqual({
      direction: 'before',
      beforeLine: 100,
    });
    expect(historyWindowRequestCursor(state, 'after')).toEqual({
      direction: 'after',
      afterLine: 102,
    });
  });

  test('returns no wire cursor at an exhausted directional boundary', () => {
    const state = createHistoryWindow({ startLine: 0, lines: rows(0, 5) });
    expect(historyWindowRequestCursor(state, 'before')).toBeNull();
    expect(historyWindowRequestCursor(state, 'after')).toBeNull();
  });

  test('rejects an unbounded seed instead of silently losing its absolute edge', () => {
    expect(() => createHistoryWindow({
      startLine: 0,
      lines: rows(0, 4),
      limits: { maxRows: 3 },
    })).toThrow(/retained rows/i);

    expect(() => createHistoryWindow({
      startLine: 0,
      lines: ['x'.repeat(100)],
      limits: { maxBytes: 100 },
    })).toThrow(/estimated bytes/i);
  });
});

describe('bounded bidirectional sliding', () => {
  test('prepend evicts the newer opposite side and preserves absolute anchor metadata', () => {
    const state = createHistoryWindow({
      startLine: 10_000,
      lines: rows(10_000, 10_000),
      hasOlder: true,
    });
    const reader = anchor(10_050, 19.5);
    const result = committed(applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 10_000,
      startLine: 8_000,
      lines: rows(8_000, 2_000),
      hasMore: true,
    }, {
      anchor: reader,
      protectedRange: { startLine: 10_000, endLine: 10_120 },
    }));

    expect(historyWindowRange(result.state)).toEqual({ startLine: 8_000, endLine: 18_000 });
    expect(result.evictedOpposite).toMatchObject({
      startLine: 18_000,
      endLine: 20_000,
      rowCount: 2_000,
    });
    expect(result.discardedIncoming).toBeNull();
    expect(result.acceptedPage).toMatchObject({
      startLine: 8_000,
      endLine: 10_000,
      rowCount: 2_000,
    });
    expect(result.anchor).toEqual({
      line: reader.line,
      viewportOffsetPx: reader.viewportOffsetPx,
      previousIndex: 50,
      nextIndex: 2_050,
      indexDelta: 2_000,
      preserved: true,
    });
    expect(result.state.hasOlder).toBe(true);
    expect(result.state.hasNewer).toBe(true);
    assertBounded(result.state);
  });

  test('requestHistoryAfter restores the evicted newer span and evicts the older side', () => {
    const tail = createHistoryWindow({
      startLine: 10_000,
      lines: rows(10_000, 10_000),
      hasOlder: true,
    });
    const older = committed(applyHistoryWindowPage(tail, {
      direction: 'before',
      anchorLine: 10_000,
      startLine: 8_000,
      lines: rows(8_000, 2_000),
      hasMore: true,
    }, { anchor: anchor(10_020) })).state;

    expect(historyWindowRequestCursor(older, 'after')).toEqual({
      direction: 'after',
      afterLine: 17_999,
    });

    const reader = anchor(17_900, 111);
    const restored = committed(applyHistoryWindowPage(older, {
      direction: 'after',
      anchorLine: 17_999,
      startLine: 18_000,
      lines: rows(18_000, 2_000),
      hasMore: false,
    }, {
      anchor: reader,
      protectedRange: { startLine: 17_850, endLine: 18_000 },
    }));

    expect(historyWindowRange(restored.state)).toEqual({ startLine: 10_000, endLine: 20_000 });
    expect(restored.evictedOpposite).toMatchObject({
      startLine: 8_000,
      endLine: 10_000,
      rowCount: 2_000,
    });
    expect(restored.discardedIncoming).toBeNull();
    expect(restored.anchor).toEqual({
      line: reader.line,
      viewportOffsetPx: reader.viewportOffsetPx,
      previousIndex: 9_900,
      nextIndex: 7_900,
      indexDelta: -2_000,
      preserved: true,
    });
    expect(restored.state.hasOlder).toBe(true);
    expect(restored.state.hasNewer).toBe(false);
    expect(restored.state.lines).toEqual(tail.lines);
    assertBounded(restored.state);
  });

  test('traverses every one of 25k absolute rows backward and forward with a 10k resident cap', () => {
    const total = 25_000;
    const seen = new Uint8Array(total);
    let state = createHistoryWindow({
      startLine: 15_000,
      lines: rows(15_000, 10_000),
      hasOlder: true,
    });
    const remember = () => {
      for (const line of state.lines) seen[lineNumber(line)] = 1;
    };
    remember();

    while (state.startLine > 0) {
      const count = Math.min(2_000, state.startLine);
      const startLine = state.startLine - count;
      const cursor = historyWindowRequestCursor(state, 'before');
      expect(cursor).toEqual({ direction: 'before', beforeLine: state.startLine });
      const reader = anchor(state.startLine + 10, 42);
      const result = committed(applyHistoryWindowPage(state, {
        direction: 'before',
        anchorLine: state.startLine,
        startLine,
        lines: rows(startLine, count),
        hasMore: startLine > 0,
      }, { anchor: reader }));
      expect(result.anchor.viewportOffsetPx).toBe(42);
      expect(result.anchor.preserved).toBe(true);
      state = result.state;
      assertBounded(state);
      remember();
    }

    expect(Array.from(seen).every((value) => value === 1)).toBe(true);
    expect(state.startLine).toBe(0);
    expect(state.hasOlder).toBe(false);
    expect(state.hasNewer).toBe(true);

    while (historyWindowEndLine(state) < total) {
      const startLine = historyWindowEndLine(state);
      const count = Math.min(2_000, total - startLine);
      const cursor = historyWindowRequestCursor(state, 'after');
      expect(cursor).toEqual({ direction: 'after', afterLine: startLine - 1 });
      const reader = anchor(historyWindowEndLine(state) - 11, 58.75);
      const result = committed(applyHistoryWindowPage(state, {
        direction: 'after',
        anchorLine: startLine - 1,
        startLine,
        lines: rows(startLine, count),
        hasMore: startLine + count < total,
      }, { anchor: reader }));
      expect(result.anchor.viewportOffsetPx).toBe(58.75);
      state = result.state;
      assertBounded(state);
      remember();
    }

    expect(historyWindowRange(state)).toEqual({ startLine: 15_000, endLine: 25_000 });
    expect(state.hasNewer).toBe(false);
    expect(Array.from(seen).every((value) => value === 1)).toBe(true);
  });

  test('enforces the byte budget before the row budget and evicts the opposite side', () => {
    const customBytes = [100, 100, 100, 100];
    const state = createHistoryWindow({
      startLine: 4,
      lines: rows(4, 4),
      lineBytes: customBytes,
      hasOlder: true,
      limits: { maxRows: 10_000, maxBytes: 500 },
    });
    const result = committed(applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 4,
      startLine: 2,
      lines: rows(2, 2),
      lineBytes: [100, 100],
      hasMore: true,
    }, { anchor: anchor(4) }));

    expect(result.state.lines.map(lineNumber)).toEqual([2, 3, 4, 5, 6]);
    expect(result.state.estimatedBytes).toBe(500);
    expect(result.evictedOpposite).toEqual({
      startLine: 7,
      endLine: 8,
      rowCount: 1,
      estimatedBytes: 100,
    });
    expect(result.state.lines.length).toBeLessThan(10_000);
    assertBounded(result.state);
  });

  test('keeps protection hard and discards only the incoming far edge when necessary', () => {
    const state = createHistoryWindow({
      startLine: 100,
      lines: rows(100, 5),
      lineBytes: [100, 100, 100, 100, 100],
      hasOlder: true,
      limits: { maxRows: 5, maxBytes: 500 },
    });
    const result = committed(applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 100,
      startLine: 95,
      lines: rows(95, 5),
      lineBytes: [100, 100, 100, 100, 100],
      hasMore: false,
    }, {
      anchor: anchor(102),
      // Four protected old rows leave room for only one incoming row.
      protectedRange: { startLine: 100, endLine: 104 },
    }));

    expect(result.state.lines.map(lineNumber)).toEqual([99, 100, 101, 102, 103]);
    expect(result.evictedOpposite).toEqual({
      startLine: 104,
      endLine: 105,
      rowCount: 1,
      estimatedBytes: 100,
    });
    expect(result.discardedIncoming).toEqual({
      startLine: 95,
      endLine: 99,
      rowCount: 4,
      estimatedBytes: 400,
    });
    // The discarded prefix is still fetchable even though the server page
    // itself said it had reached the archive floor.
    expect(result.state.hasOlder).toBe(true);
    expect(result.anchor.line).toBe(102);
    assertBounded(result.state);
  });
});

describe('boundary and malformed-page handling', () => {
  test('an empty directional page marks only that boundary exhausted', () => {
    const state = createHistoryWindow({
      startLine: 50,
      lines: rows(50, 10),
      hasOlder: true,
      hasNewer: true,
    });
    const reader = anchor(55, 8);
    const result = applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 50,
      startLine: null,
      lines: [],
      hasMore: false,
    }, { anchor: reader });

    expect(result.kind).toBe('boundary');
    if (result.kind !== 'boundary') return;
    expect(result.state.hasOlder).toBe(false);
    expect(result.state.hasNewer).toBe(true);
    expect(result.anchor).toEqual({
      line: 55,
      viewportOffsetPx: 8,
      previousIndex: 5,
      nextIndex: 5,
      indexDelta: 0,
      preserved: true,
    });
    expect(result.state.lines).not.toBe(state.lines);
    expect(result.state.lines).toEqual(state.lines);
  });

  test('rejects stale, overlapping, gapped, and empty-with-more replies without mutation', () => {
    const state = createHistoryWindow({
      startLine: 100,
      lines: rows(100, 10),
      hasOlder: true,
      hasNewer: true,
    });
    const reader = anchor(104);
    const cases = [
      {
        reason: 'stale-cursor',
        page: { direction: 'before' as const, anchorLine: 99, startLine: 90, lines: rows(90, 10), hasMore: true },
      },
      {
        reason: 'non-contiguous-page',
        page: { direction: 'before' as const, anchorLine: 100, startLine: 89, lines: rows(89, 10), hasMore: true },
      },
      {
        reason: 'non-contiguous-page',
        page: { direction: 'after' as const, anchorLine: 109, startLine: 111, lines: rows(111, 2), hasMore: true },
      },
      {
        reason: 'empty-page-with-more',
        page: { direction: 'after' as const, anchorLine: 109, startLine: null, lines: [], hasMore: true },
      },
    ];

    for (const item of cases) {
      const result = applyHistoryWindowPage(state, item.page, { anchor: reader });
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') continue;
      expect(result.reason).toBe(item.reason);
      expect(result.state).toBe(state);
      expect(state.lines.map(lineNumber)).toEqual(Array.from({ length: 10 }, (_, index) => 100 + index));
    }
  });

  test('rejects a page that cannot fit one row without dropping the protected anchor', () => {
    const state = createHistoryWindow({
      startLine: 10,
      lines: ['line-10'],
      lineBytes: [100],
      hasOlder: true,
      limits: { maxRows: 1, maxBytes: 100 },
    });
    const result = applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 10,
      startLine: 9,
      lines: ['line-9'],
      lineBytes: [100],
      hasMore: false,
    }, { anchor: anchor(10) });

    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'budget-cannot-preserve-anchor',
      state,
    });
    expect(historyWindowRange(state)).toEqual({ startLine: 10, endLine: 11 });
  });
});
