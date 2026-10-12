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
  historyContinuationFor,
  historyIncidentStopLabel,
  historyStateLabel,
  historyStatusNotes,
  answerNewarchV2Geometry,
  hitNewarchV2Cell,
  newarchV2IncidentLabel,
  newarchV2RowCopy,
  newarchV2StateLabel,
  newarchV2StatusNotes,
  presentNewarchV2,
  fitNewarchFontPx,
  FONT_FIT_GUTTER_PX,
  selectNewarchV2Panes,
  parseNewarchHistoryExtension,
  type HistoryWindowAnchor,
  type HistoryWindowRejectReason,
  type HistoryWindowState,
} from '../src/history-window';
import type {
  NewarchHistoryExtension,
  NewarchHistoryState,
  NewarchV2FixedGeometry,
  NewarchV2Incident,
  NewarchV2PaneDescriptor,
} from '@thumbmux/core';

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
    // Annotated so a typo in a reason string fails here rather than turning
    // the assertion below into a comparison of two arbitrary strings.
    const cases: Array<{
      reason: HistoryWindowRejectReason;
      page: Parameters<typeof applyHistoryWindowPage>[1];
    }> = [
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

// ── NEWARCH flag-on lot D: typed history states are never EOF or row text ──
// Literal fixtures written by hand (not produced by the code under test).

const FLAG_PANE = { serverIdentity: 'srv-d', paneId: '%7', birthGeneration: 3 };
const FLAG_CAPS = { extensionVersion: 1, supported: ['history-states-v1', 'catalog-v3'], required: ['history-states-v1'] };
const FLAG_CURSOR = { version: 1, token: 'opaque-h-cursor' };
function flagGap(countKind: 'unknown' | 'estimate' | 'exact', missingCount: number | null) {
  return {
    version: 1, episodeId: `ep-${countKind}`, parentEpisodeId: null, pane: FLAG_PANE,
    leftRowId: { pane: FLAG_PANE, segmentId: 'seg-1', rowOrdinal: 41 }, rightSegmentId: 'seg-2',
    reason: 'pipe-eof', countKind, missingCount, withheldRows: 2, lowerBound: 0,
    openedAt: 10, closedAt: null, clockEpoch: 'clock-d', quality: 'degraded',
  };
}
const FLAG_RANGE = { pane: FLAG_PANE, segmentId: 'seg-0', start: 0, end: 512 };
function flagExtension(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    capabilities: FLAG_CAPS,
    states: [
      { kind: 'exact' },
      { kind: 'gap', gap: flagGap('unknown', null) },
      { kind: 'remote-required', range: FLAG_RANGE, bundleId: 'bundle-0' },
      { kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5 },
    ],
    before: { kind: 'blocked', cursor: FLAG_CURSOR, state: { kind: 'pending', operationId: 'op-1', retryAfterMs: 250 } },
    after: { kind: 'end' },
    ...overrides,
  };
}

describe('NEWARCH D flag-on continuation in the window model', () => {
  test('RD-01: an empty blocked (pending) page keeps the edge pageable instead of EOF', () => {
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    const blocked = applyHistoryWindowPage(state, {
      direction: 'before', anchorLine: 100, startLine: null, lines: [], hasMore: true, continuation: 'blocked',
    }, { anchor: anchor(101) });
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'rejected') throw new Error(blocked.message);
    expect(blocked.state.hasOlder).toBe(true);
    expect(blocked.state.lines).toEqual(rows(100, 3));
    expect(historyWindowRequestCursor(blocked.state, 'before')).toEqual({ direction: 'before', beforeLine: 100 });

    // Control: the same empty page with a real end continuation is EOF.
    const ended = applyHistoryWindowPage(state, {
      direction: 'before', anchorLine: 100, startLine: null, lines: [], hasMore: false, continuation: 'end',
    }, { anchor: anchor(101) });
    expect(ended.kind).toBe('boundary');
    expect(ended.state.hasOlder).toBe(false);
  });

  test('RD-01: a blocked after-edge stays open and a blocked page with rows keeps more', () => {
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: false, hasNewer: true });
    const blocked = applyHistoryWindowPage(state, {
      direction: 'after', anchorLine: 102, startLine: null, lines: [], hasMore: true, continuation: 'blocked',
    }, { anchor: anchor(101) });
    expect(blocked.kind).toBe('blocked');
    expect(blocked.state.hasNewer).toBe(true);
    const withRows = committed(applyHistoryWindowPage(state, {
      direction: 'after', anchorLine: 102, startLine: 103, lines: rows(103, 2), hasMore: true, continuation: 'blocked',
    }, { anchor: anchor(101) }));
    expect(withRows.state.hasNewer).toBe(true);
    expect(withRows.state.lines).toEqual(rows(100, 5));
  });

  test('a continuation that disagrees with hasMore is refused, never trusted either way', () => {
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    for (const [continuation, hasMore] of [['end', true], ['blocked', false], ['more', false]] as const) {
      const result = applyHistoryWindowPage(state, {
        direction: 'before', anchorLine: 100, startLine: null, lines: [], hasMore, continuation,
      }, { anchor: anchor(101) });
      expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid-page', state });
    }
  });
});

describe('NEWARCH D flag-on state labels and wire validation', () => {
  test('unknown counts read as words, never 0; estimates say ประมาณ', () => {
    const unknown = historyStateLabel({ kind: 'gap', gap: flagGap('unknown', null) } as NewarchHistoryState)!;
    expect(unknown).toBe('ช่วงนี้เก็บประวัติไม่ครบ — จำนวนไม่ทราบ');
    expect(unknown).not.toMatch(/\d/);
    expect(historyStateLabel({ kind: 'gap', gap: flagGap('estimate', 37) } as NewarchHistoryState))
      .toBe('ช่วงนี้เก็บประวัติไม่ครบ — ประมาณ 37 แถว');
    expect(historyStateLabel({ kind: 'gap', gap: flagGap('exact', 4) } as NewarchHistoryState))
      .toBe('ช่วงนี้เก็บประวัติไม่ครบ — 4 แถว');
    expect(historyStateLabel({ kind: 'exact' })).toBeNull();
    expect(historyStateLabel({ kind: 'remote-required', range: FLAG_RANGE, bundleId: 'b' }))
      .toBe('ประวัติช่วงนี้อยู่ในคลังสำรอง ต้องดึงคืนก่อนอ่าน');
    expect(historyStateLabel({ kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 1 }))
      .toBe('หยุดเก็บประวัติ — พื้นที่ไม่พอ');
    expect(historyStateLabel({ kind: 'pending', operationId: 'op', retryAfterMs: 1 })).toContain('ยังไม่ใช่จุดสิ้นสุด');
  });

  test('every non-exact state, including blocking ones, yields exactly one note', () => {
    const extension = parseNewarchHistoryExtension(flagExtension());
    expect(extension).not.toBeNull();
    const notes = historyStatusNotes(extension!);
    expect(notes.map(note => note.kind)).toEqual(['gap', 'remote-required', 'pressure', 'pending']);
    expect(notes.find(note => note.kind === 'pending')!.retryAfterMs).toBe(250);
    expect(historyContinuationFor(extension!, 'before')).toBe('blocked');
    expect(historyContinuationFor(extension!, 'after')).toBe('end');
    // Duplicated state names one note, not two.
    const doubled = parseNewarchHistoryExtension(flagExtension({
      states: [{ kind: 'gap', gap: flagGap('unknown', null) }, { kind: 'gap', gap: flagGap('unknown', null) }],
    }))!;
    expect(historyStatusNotes(doubled)).toHaveLength(2);
    expect(historyStatusNotes(doubled).filter(note => note.kind === 'gap')).toHaveLength(1);
  });

  test('labels stay outside resident rows (copy/search see only terminal output)', () => {
    const extension = parseNewarchHistoryExtension(flagExtension())!;
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    const applied = applyHistoryWindowPage(state, {
      direction: 'before', anchorLine: 100, startLine: 98, lines: rows(98, 2), hasMore: true, continuation: 'blocked',
    }, { anchor: anchor(101) });
    if (applied.kind === 'rejected') throw new Error(applied.message);
    const labels = historyStatusNotes(extension).map(note => note.text);
    expect(applied.state.lines).toEqual(rows(98, 5));
    for (const line of applied.state.lines) for (const label of labels) expect(line).not.toContain(label);
  });

  test('unreadable envelopes are refused (null), so the page is never drawn as EOF', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['unknown count as 0', { states: [{ kind: 'gap', gap: { ...flagGap('unknown', null), missingCount: 0 } }] }],
      ['estimate without count', { states: [{ kind: 'gap', gap: flagGap('estimate', null) }] }],
      ['blocked by exact', { before: { kind: 'blocked', cursor: FLAG_CURSOR, state: { kind: 'exact' } } }],
      ['blocked without cursor', { before: { kind: 'blocked', state: { kind: 'pending', operationId: 'o', retryAfterMs: 1 } } }],
      ['unknown capability', { capabilities: { ...FLAG_CAPS, supported: [...FLAG_CAPS.supported, 'telepathy-v9'] } }],
      ['required not supported', { capabilities: { ...FLAG_CAPS, required: ['stitch-v1'] } }],
      ['no history-states', { capabilities: { extensionVersion: 1, supported: ['catalog-v3'], required: [] } }],
      ['unknown state kind', { states: [{ kind: 'eof' }] }],
      ['bad remote reason', { states: [{ kind: 'remote-unavailable', range: FLAG_RANGE, bundleId: 'b', retryAfterMs: 1, reason: 'gone' }] }],
      ['version 2', { version: 2 }],
    ];
    for (const [name, overrides] of bad) {
      expect([name, parseNewarchHistoryExtension(flagExtension(overrides))]).toEqual([name, null]);
    }
    expect(parseNewarchHistoryExtension(null)).toBeNull();
    expect(parseNewarchHistoryExtension(flagExtension()) as NewarchHistoryExtension | null).not.toBeNull();
  });
});

// ── NEWARCH D-fix R13/R18: repair incident + opaque cursor across remote ──
// Literal fixtures. The code under test must not be the source of expected values.

const REPAIR_CAPS = {
  revision: 2,
  supported: ['incident-r2', 'timeline-replay-r2'],
  required: ['incident-r2'],
};
const INCIDENT_WALL_MS = 1_700_000_000_123;
const INCIDENT_ID = 'incident-storage-7';
const INCIDENT_ROW = { pane: FLAG_PANE, segmentId: 'seg-9', rowOrdinal: 41 };
function pressureIncident(overrides: Record<string, unknown> = {}) {
  return {
    revision: 2,
    incidentId: INCIDENT_ID,
    pane: FLAG_PANE,
    leftRowId: INCIDENT_ROW,
    openedAtWallMs: INCIDENT_WALL_MS,
    openedAtMonoMs: 80,
    clockEpoch: 'clock-d',
    collecting: false,
    reason: 'storage-outage',
    quality: 'degraded',
    resolvedAtWallMs: null,
    ...overrides,
  };
}
function repairEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return flagExtension({
    repair: REPAIR_CAPS,
    states: [{
      kind: 'pressure',
      level: 'emergency',
      collecting: false,
      sinceMonoMs: 5,
      repair: pressureIncident(),
    }],
    before: {
      kind: 'blocked',
      cursor: { version: 1, token: 'opaque-remote-T' },
      state: { kind: 'remote-required', range: FLAG_RANGE, bundleId: 'bundle-0' },
    },
    ...overrides,
  });
}

describe('NEWARCH D-fix R18 pressure incident from the backend', () => {
  test('a repair envelope without a real incident is refused, never drawn as a v1 pressure', () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ['pressure has no incident', { states: [{ kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5 }] }],
      ['leftRowId is 0', { states: [{ kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5, repair: pressureIncident({ leftRowId: 0 }) }] }],
      ['wall time missing', { states: [{ kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5, repair: pressureIncident({ openedAtWallMs: undefined }) }] }],
      ['collecting disagrees', { states: [{ kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5, repair: pressureIncident({ collecting: true }) }] }],
      ['unknown repair capability', { repair: { revision: 2, supported: ['telepathy-r2'], required: [] } }],
      ['repair revision 1', { repair: { ...REPAIR_CAPS, revision: 1 } }],
    ];
    for (const [name, overrides] of refused) {
      expect([name, parseNewarchHistoryExtension(repairEnvelope(overrides))]).toEqual([name, null]);
    }
    // A v1 page that never claimed repair still parses. Boot keeps old records.
    expect(parseNewarchHistoryExtension(flagExtension())).not.toBeNull();
  });

  test('the note keeps backend wall time and leftRowId beside the sentence, never inside row text', () => {
    const extension = parseNewarchHistoryExtension(repairEnvelope());
    expect(extension).not.toBeNull();
    const note = historyStatusNotes(extension!).find(item => item.kind === 'pressure') as {
      text: string;
      openedAtWallMs?: number;
      incidentId?: string;
      leftRowId?: { segmentId: string; rowOrdinal: number } | null;
    };
    expect(note.text).toBe('หยุดเก็บประวัติ — พื้นที่ไม่พอ');
    expect(note.text).not.toContain(String(INCIDENT_WALL_MS));
    expect(note.text).not.toContain(INCIDENT_ID);
    expect(note.openedAtWallMs).toBe(INCIDENT_WALL_MS);
    expect(note.openedAtWallMs).not.toBe(5);
    expect(note.incidentId).toBe(INCIDENT_ID);
    expect(note.leftRowId).toEqual(INCIDENT_ROW);

    const beforeFirstRow = parseNewarchHistoryExtension(repairEnvelope({
      states: [{
        kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5,
        repair: pressureIncident({ leftRowId: null }),
      }],
    }));
    const nullNote = historyStatusNotes(beforeFirstRow!).find(item => item.kind === 'pressure') as {
      leftRowId?: { rowOrdinal: number } | null;
    };
    expect(nullNote.leftRowId).toBeNull();

    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    const applied = applyHistoryWindowPage(state, {
      direction: 'before', anchorLine: 100, startLine: 98, lines: rows(98, 2),
      hasMore: true, continuation: 'blocked',
    }, { anchor: anchor(101) });
    if (applied.kind === 'rejected') throw new Error(applied.message);
    const banned = [note.text, INCIDENT_ID, String(INCIDENT_WALL_MS), 'seg-9'];
    for (const line of applied.state.lines) {
      for (const piece of banned) expect(line).not.toContain(piece);
    }
  });
});

describe('NEWARCH D-fix R18 stop label the reader can see', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = new Date(INCIDENT_WALL_MS);
  const clock = `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
  const day = `${pad(local.getDate())}/${pad(local.getMonth() + 1)}`;

  test('a repair stop shows its local time and last row, without the raw ms or the incident id', () => {
    const extension = parseNewarchHistoryExtension(repairEnvelope());
    const note = historyStatusNotes(extension!).find(item => item.kind === 'pressure')!;
    const label = historyIncidentStopLabel(note);
    expect(label).toBe(`หยุดเมื่อ ${day} ${clock} · แถวสุดท้าย seg-9:41`);
    expect(label).not.toContain(String(INCIDENT_WALL_MS));
    expect(label).not.toContain(INCIDENT_ID);
  });

  test('a stop before the first row says so, and a v1 pressure has no stop label', () => {
    const beforeFirstRow = parseNewarchHistoryExtension(repairEnvelope({
      states: [{
        kind: 'pressure', level: 'emergency', collecting: false, sinceMonoMs: 5,
        repair: pressureIncident({ leftRowId: null }),
      }],
    }));
    const note = historyStatusNotes(beforeFirstRow!).find(item => item.kind === 'pressure')!;
    expect(historyIncidentStopLabel(note)).toBe(`หยุดเมื่อ ${day} ${clock} · ก่อนแถวแรก`);

    const v1Extension = parseNewarchHistoryExtension(flagExtension());
    expect(v1Extension).not.toBeNull();
    const v1 = historyStatusNotes(v1Extension!).find(item => item.kind === 'pressure');
    expect(v1).toBeDefined();
    expect(historyIncidentStopLabel(v1!)).toBeUndefined();
  });
});

describe('NEWARCH D-fix R13 cursor across a local/remote seam', () => {
  test('the opaque cursor is copied unchanged and an empty remote page does not reseed', () => {
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    const handed = { version: 1 as const, token: 'opaque-remote-T' };
    const local = applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 100,
      startLine: 98,
      lines: rows(98, 2),
      hasMore: true,
      continuation: 'more',
      flagOnCursor: handed,
    } as Parameters<typeof applyHistoryWindowPage>[1], { anchor: anchor(101) });
    if (local.kind === 'rejected') throw new Error(local.message);
    handed.token = 'mutated-by-caller';
    const stored = (local.state as { flagOnCursorBefore?: { version: number; token: string } | null }).flagOnCursorBefore;
    expect(stored).toEqual({ version: 1, token: 'opaque-remote-T' });
    expect(local.state.startLine).toBe(98);
    expect(local.anchor.line).toBe(101);

    const remote = applyHistoryWindowPage(local.state, {
      direction: 'before',
      anchorLine: 98,
      startLine: null,
      lines: [],
      hasMore: true,
      continuation: 'blocked',
      flagOnCursor: { version: 1, token: 'opaque-remote-T' },
    } as Parameters<typeof applyHistoryWindowPage>[1], { anchor: anchor(101) });
    if (remote.kind === 'rejected') throw new Error(remote.message);
    expect(remote.kind).toBe('blocked');
    expect(remote.state.startLine).toBe(98);
    expect(remote.state.lines).toEqual(rows(98, 5));
    expect(remote.state.hasOlder).toBe(true);
    expect(remote.anchor.line).toBe(101);
    expect((remote.state as { flagOnCursorBefore?: { token: string } }).flagOnCursorBefore?.token).toBe('opaque-remote-T');
    expect(historyWindowRequestCursor(remote.state, 'before')).toEqual({
      direction: 'before',
      beforeLine: 98,
      flagOnCursor: { version: 1, token: 'opaque-remote-T' },
    });
  });

  test('a blocked page with a cursor D cannot read is refused, not stored as a new timeline', () => {
    const state = createHistoryWindow({ startLine: 100, lines: rows(100, 3), hasOlder: true });
    const bad = applyHistoryWindowPage(state, {
      direction: 'before',
      anchorLine: 100,
      startLine: null,
      lines: [],
      hasMore: true,
      continuation: 'blocked',
      flagOnCursor: { version: 2, token: 'not-this-revision' },
    } as Parameters<typeof applyHistoryWindowPage>[1], { anchor: anchor(101) });
    expect(bad.kind).toBe('rejected');
    if (bad.kind === 'rejected') {
      expect(bad.reason).toBe('invalid-page');
      expect(bad.state.startLine).toBe(100);
      expect(bad.state.lines).toEqual(rows(100, 3));
    }
  });
});

const V2_GEOMETRY = {
  policy: 'fixed-at-birth' as const,
  columns: 100,
  rows: 40,
  configVersion: 'q22-default-1',
  panesPerWindow: 1 as const,
};
const V2_CELL = { widthPx: 8, heightPx: 16 };

function v2Incident(id: string, frontier: NewarchV2Incident['frontier'], collecting: boolean): NewarchV2Incident {
  return {
    schema: 'newarch-v2', incidentId: id,
    pane: { serverIdentity: 'srv', paneId: 'pane-a', birthGeneration: 1 },
    reason: 'pipe-eof', frontier,
    affected: { after: frontier, through: frontier },
    openedAtWallMs: Date.UTC(2026, 9, 4, 1, 2, 3), openedAtMonoMs: 10, clockEpoch: 'epoch-1',
    collecting, missing: { countKind: 'unknown', missingCount: null },
    ruleVersion: 'explicit-gap@1', configVersion: 'q22-default-1', geometry: V2_GEOMETRY,
    revision: 1, sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null,
    action: collecting ? 'annotate' : 'gap-and-stop', evidence: null,
  };
}

function v2Pane(paneId: string): NewarchV2PaneDescriptor {
  return {
    schema: 'newarch-v2',
    session: { serverIdentity: 'srv', sessionId: 'sess-1' },
    pane: { serverIdentity: 'srv', paneId, birthGeneration: 1 },
    windowId: `win-${paneId}`, owner: 'capture-engine', birthOperationId: `birth-${paneId}`,
    geometry: V2_GEOMETRY, state: 'active',
  };
}

describe('NEWARCH v2 fixed picture, labels, and pane choice', () => {
  test('320 and 390 px reach column 100 by scrolling, with no resize', () => {
    for (const widthPx of [320, 390]) {
      const picture = presentNewarchV2(
        { columns: 100, rows: 40 },
        { widthPx, heightPx: 700, cellWidthPx: 8, cellHeightPx: 16, keyboardInsetPx: 0, fitWidth: false, scrollXPx: 10_000 },
      );
      expect(picture.columns).toBe(100);
      expect(picture.rows).toBe(40);
      expect(picture.resize).toBeNull();
      expect(picture.scale).toBe(1);
      expect(picture.horizontalScroll).toBe(true);
      const hit = hitNewarchV2Cell(picture, { clientX: widthPx - 1, clientY: 8, originX: 0, originY: 0 }, V2_CELL);
      expect(hit).toEqual({ col: 99, row: 0 });
    }
  });

  test('fit-width, a wide desktop, rotation, and a keyboard inset keep the 100x40 grid', () => {
    const fit = presentNewarchV2(
      { columns: 100, rows: 40 },
      { widthPx: 320, heightPx: 700, cellWidthPx: 8, cellHeightPx: 16, keyboardInsetPx: 280, fitWidth: true, scrollXPx: 400 },
    );
    expect(fit.scale).toBeCloseTo(320 / 800);
    expect(fit.scrollXPx).toBe(0);
    expect(fit.horizontalScroll).toBe(false);
    expect(fit.rows).toBe(40);
    expect(fit.visibleHeightPx).toBe(420);
    expect(fit.resize).toBeNull();
    expect(hitNewarchV2Cell(fit, { clientX: 319, clientY: 0, originX: 0, originY: 0 }, V2_CELL)?.col).toBe(99);

    const desktop = presentNewarchV2(
      { columns: 100, rows: 40 },
      { widthPx: 1280, heightPx: 800, cellWidthPx: 8, cellHeightPx: 16, keyboardInsetPx: 0, fitWidth: false, scrollXPx: 50 },
    );
    expect(desktop.horizontalScroll).toBe(false);
    expect(desktop.scrollXPx).toBe(0);
    expect(desktop.columns).toBe(100);

    const portrait = presentNewarchV2(
      { columns: 100, rows: 40 },
      { widthPx: 390, heightPx: 844, cellWidthPx: 8, cellHeightPx: 16, keyboardInsetPx: 0, fitWidth: false, scrollXPx: 0 },
    );
    const landscape = presentNewarchV2(
      { columns: 100, rows: 40 },
      { widthPx: 844, heightPx: 390, cellWidthPx: 8, cellHeightPx: 16, keyboardInsetPx: 0, fitWidth: false, scrollXPx: 0 },
    );
    expect(portrait.columns).toBe(landscape.columns);
    expect(portrait.rows).toBe(landscape.rows);
    expect(portrait.resize).toBeNull();
  });

  test('a stopped incident before the first row is a sentence outside the copied rows', () => {
    const incident = v2Incident('before-first', null, false);
    const text = newarchV2IncidentLabel(incident);
    expect(text).toContain('ก่อนแถวแรก');
    expect(text).toContain('หยุดเก็บแล้ว');
    expect(text).toContain('ท่อเก็บขาด');
    const notes = newarchV2StatusNotes({
      entries: [{ kind: 'incident', incident }],
      states: [{ kind: 'incident', incident }],
    });
    expect(notes.some(note => note.text.includes('หยุดเก็บแล้ว'))).toBe(true);
    const copy = newarchV2RowCopy(['hello']);
    expect(copy).toBe('hello');
    expect(copy.includes('หยุดเก็บแล้ว')).toBe(false);
    expect(newarchV2StateLabel({
      kind: 'remote-unavailable', bundleId: 'bundle-1', reason: 'corrupt', retryAfterMs: 1000,
    })).toContain('ยังไม่ใช่จุดสิ้นสุด');
  });

  test('status notes stay inside a fixed cap', () => {
    const notes = newarchV2StatusNotes({
      entries: Array.from({ length: 80 }, (_, index) => ({
        kind: 'incident' as const,
        incident: v2Incident(`inc-${index}`, null, false),
      })),
      states: [],
    });
    expect(notes).toHaveLength(64);
  });

  test('two panes stay a list and every geometry intent writes nothing', () => {
    const selection = selectNewarchV2Panes([v2Pane('a'), v2Pane('b')], null);
    expect(selection.kind).toBe('ambiguous');
    if (selection.kind === 'ambiguous') expect(selection.panes.map(pane => pane.pane.paneId)).toEqual(['a', 'b']);
    const geometry: NewarchV2FixedGeometry = V2_GEOMETRY;
    for (const intent of [
      { source: 'viewport' as const, columns: 40, rows: 20 },
      { source: 'apply-geometry' as const, columns: 120, rows: 50 },
      { source: 'font' as const, columns: 90, rows: 30 },
    ]) {
      const answer = answerNewarchV2Geometry(geometry, intent);
      expect(answer.resize).toBeNull();
      expect(answer.geometry).toEqual(V2_GEOMETRY);
    }
  });
});

// Moved from app/tests/font-range.test.ts: TermView (this package) owns the
// formula because the app package depends on svelte, not the other way round.
/**
 * NEWARCH fit-font (plan §2 / §6). The width sweep measured a cell of
 * 0.6 × font on Chromium with hinting none; the formula never hard-codes that
 * ratio, it is only the fake measure these cases hand in.
 */
describe('fitNewarchFontPx', () => {
  const band = { min: 4, max: 40 };
  const sweepCell = (px: number) => px * 0.6;
  /** 390px phone box = 378px of usable line after the 6+6 gutter. */
  const PHONE = 390;
  const fit = (columns: number, containerWidthPx: number, extra: Record<string, unknown> = {}) =>
    fitNewarchFontPx({
      columns,
      containerWidthPx,
      ceilingPx: 13,
      bounds: band,
      measureCellPx: sweepCell,
      ...extra,
    });

  test('the gutter is 12px — the 6px padding on each side of the line', () => {
    expect(FONT_FIT_GUTTER_PX).toBe(12);
  });

  // REVIEW-grok debt: a cell that is not proportional to the font (hinting
  // adds a fixed 0.6px) makes the first guess 0.45px too big. Stepping 0.05px
  // ran out of probes and fell to the 4px floor while 7.05px fits.
  test('a non-proportional cell still finds the largest fitting size, not the floor', () => {
    const hinted = (px: number) => px * 0.6 + 0.6;
    const out = fit(78, PHONE, { measureCellPx: hinted });
    expect(out).toEqual({ fontPx: 7.05, fits: true });
    expect(78 * hinted(7.1)).toBeGreaterThan(378);
  });

  test('a wide box keeps the ceiling exactly — never grows past the user size', () => {
    const out = fit(76, 1280);
    expect(out).toEqual({ fontPx: 13, fits: true });
  });

  test('70 columns at 378px land on 9px (sweep table: fills exactly)', () => {
    const out = fit(70, PHONE);
    expect(out.fontPx).toBe(9);
    expect(out.fits).toBe(true);
  });

  test('76 columns at 378px land between 8.2 and 8.4 — not the integer 8', () => {
    const out = fit(76, PHONE);
    expect(out.fits).toBe(true);
    expect(out.fontPx).toBeGreaterThanOrEqual(8.2);
    expect(out.fontPx).toBeLessThanOrEqual(8.4);
    expect(out.fontPx).not.toBe(8);
    // It really fits, and the next 0.05px step would not.
    expect(76 * sweepCell(out.fontPx)).toBeLessThanOrEqual(378);
    expect(76 * sweepCell(out.fontPx + 0.05)).toBeGreaterThan(378);
  });

  test('78 columns at 378px land just above 8px', () => {
    const out = fit(78, PHONE);
    expect(out.fits).toBe(true);
    expect(out.fontPx).toBeGreaterThanOrEqual(8);
    expect(out.fontPx).toBeLessThan(8.1);
    expect(78 * sweepCell(out.fontPx)).toBeLessThanOrEqual(378);
  });

  test('every width from 378 to 390 gives ~9 / ~8 / ~8 for 70 / 76 / 78', () => {
    for (let w = 378; w <= 390; w++) {
      const usable = w - 12;
      for (const [cols, lo, hi] of [[70, 8.6, 9], [76, 7.9, 8.4], [78, 7.7, 8.1]] as const) {
        const out = fit(cols, w);
        expect(out.fits).toBe(true);
        expect(out.fontPx).toBeGreaterThanOrEqual(lo);
        expect(out.fontPx).toBeLessThanOrEqual(hi);
        expect(cols * sweepCell(out.fontPx)).toBeLessThanOrEqual(usable + 1e-9);
      }
    }
  });

  test('the gutter is subtracted: 378px of box is only 366px of line', () => {
    const withGutter = fit(70, 378);
    expect(70 * sweepCell(withGutter.fontPx)).toBeLessThanOrEqual(366 + 1e-9);
    expect(withGutter.fontPx).toBeLessThan(9);
    const noGutter = fit(70, 378, { gutterPx: 0 });
    expect(noGutter.fontPx).toBe(9);
  });

  test('never drops below the lower bound; when the floor still overflows it says so', () => {
    const out = fit(200, PHONE);
    expect(out.fontPx).toBe(4);
    expect(out.fits).toBe(false);
  });

  test('a host floor above 4 is the floor', () => {
    const out = fit(200, PHONE, { bounds: { min: 6, max: 40 } });
    expect(out).toEqual({ fontPx: 6, fits: false });
  });

  test('the ceiling is clamped into bounds before anything else', () => {
    expect(fit(10, 1280, { ceilingPx: 99 })).toEqual({ fontPx: 40, fits: true });
  });

  test('result carries at most two decimals', () => {
    for (const w of [380, 383, 387, 389]) {
      const out = fit(76, w);
      expect(Math.round(out.fontPx * 100) / 100).toBe(out.fontPx);
    }
  });

  test('a measure that is not proportional still converges within the probe budget', () => {
    // Cell width snaps to a 0.25px grid — what a hinted renderer does.
    const hinted = (px: number) => Math.round(px * 0.6 * 4) / 4;
    const out = fit(76, PHONE, { measureCellPx: hinted });
    expect(out.fits).toBe(true);
    expect(76 * hinted(out.fontPx)).toBeLessThanOrEqual(378);
    expect(out.fontPx).toBeGreaterThan(7.5);
  });

  test('manual mode shows the ceiling and reports whether it overflows', () => {
    expect(fit(76, PHONE, { mode: 'manual' })).toEqual({ fontPx: 13, fits: false });
    expect(fit(76, 1280, { mode: 'manual' })).toEqual({ fontPx: 13, fits: true });
  });

  test('no geometry or an unlaid box (width 0) does not shrink', () => {
    expect(fit(0, PHONE)).toEqual({ fontPx: 13, fits: false });
    expect(fit(Number.NaN, PHONE)).toEqual({ fontPx: 13, fits: false });
    expect(fit(76, 0)).toEqual({ fontPx: 13, fits: false });
  });

  test('a measure that returns nothing usable falls back to 0.6 × font', () => {
    const out = fit(70, PHONE, { measureCellPx: () => Number.NaN });
    expect(out).toEqual({ fontPx: 9, fits: true });
  });

  test('the result is font and fit only — it never carries a resize', () => {
    const out = fit(76, PHONE) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['fits', 'fontPx']);
  });
});
