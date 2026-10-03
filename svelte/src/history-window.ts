/**
 * Pure bounded archive-window model for TermView's future bidirectional pager.
 *
 * The model deliberately knows nothing about DOM, Svelte, ANSI rendering, or
 * WebSockets.  It owns only absolute line ranges, retained raw rows, budgets,
 * paging cursors, and the bookkeeping needed to keep one reader anchor fixed
 * while the resident range slides in either direction.
 */

import {
  NEWARCH_FLAGON_CAPABILITIES,
  NEWARCH_REPAIR_CAPABILITIES,
  type NewarchGap,
  type NewarchHistoryContinuation,
  type NewarchHistoryExtension,
  type NewarchHistoryState,
  type NewarchRowId,
} from '@thumbmux/core';

export const HISTORY_WINDOW_MAX_ROWS = 10_000;
export const HISTORY_WINDOW_MAX_BYTES = 8 * 1024 * 1024;
export const HISTORY_WINDOW_ROW_OVERHEAD_BYTES = 64;

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
  /**
   * Flag-on continuation for this direction. `blocked` (pending, gap,
   * remote-required, ...) keeps the edge pageable: it is never EOF, even when
   * the page carries no rows. Absent = legacy page, `hasMore` alone decides.
   */
  continuation?: HistoryWindowContinuation;
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

export type HistoryWindowRejectReason =
  | 'invalid-state'
  | 'invalid-anchor'
  | 'invalid-protected-range'
  | 'invalid-page'
  | 'stale-cursor'
  | 'non-contiguous-page'
  | 'empty-page-with-more'
  | 'budget-cannot-preserve-anchor';

export type HistoryWindowApplyRejected = Readonly<{
  kind: 'rejected';
  state: HistoryWindowState;
  reason: HistoryWindowRejectReason;
  message: string;
}>;

export type HistoryWindowApplyResult =
  | HistoryWindowApplySuccess
  | HistoryWindowApplyRejected;

export type HistoryWindowRequestCursor =
  | Readonly<{ direction: 'before'; beforeLine: number }>
  | Readonly<{ direction: 'after'; afterLine: number }>;

function finiteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isSafeInteger(value);
}

function validAbsoluteLine(value: number): boolean {
  return finiteInteger(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return finiteInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return finiteInteger(value) && value >= 0;
}

function addSafe(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function resolvedLimits(partial?: Partial<HistoryWindowLimits>): HistoryWindowLimits {
  const limits: HistoryWindowLimits = {
    maxRows: partial?.maxRows ?? HISTORY_WINDOW_MAX_ROWS,
    maxBytes: partial?.maxBytes ?? HISTORY_WINDOW_MAX_BYTES,
    rowOverheadBytes: partial?.rowOverheadBytes ?? HISTORY_WINDOW_ROW_OVERHEAD_BYTES,
  };
  if (!positiveInteger(limits.maxRows)) {
    throw new RangeError('history window maxRows must be a positive safe integer');
  }
  if (!positiveInteger(limits.maxBytes)) {
    throw new RangeError('history window maxBytes must be a positive safe integer');
  }
  if (!nonNegativeInteger(limits.rowOverheadBytes)) {
    throw new RangeError('history window rowOverheadBytes must be a non-negative safe integer');
  }
  return limits;
}

/** TermView-compatible deterministic estimate (UTF-16 payload + row slot). */
export function estimateHistoryWindowLineBytes(
  line: string,
  rowOverheadBytes = HISTORY_WINDOW_ROW_OVERHEAD_BYTES,
): number {
  if (!nonNegativeInteger(rowOverheadBytes)) {
    throw new RangeError('rowOverheadBytes must be a non-negative safe integer');
  }
  const estimated = rowOverheadBytes + 2 * line.length;
  if (!Number.isSafeInteger(estimated)) {
    throw new RangeError('history line byte estimate exceeds Number.MAX_SAFE_INTEGER');
  }
  return estimated;
}

function resolveLineBytes(
  lines: readonly string[],
  supplied: readonly number[] | undefined,
  rowOverheadBytes: number,
): number[] | null {
  if (!lines.every((line) => typeof line === 'string')) return null;
  if (supplied !== undefined && supplied.length !== lines.length) return null;
  const result = new Array<number>(lines.length);
  for (let index = 0; index < lines.length; index += 1) {
    const bytes = supplied?.[index]
      ?? estimateHistoryWindowLineBytes(lines[index]!, rowOverheadBytes);
    if (!nonNegativeInteger(bytes)) return null;
    result[index] = bytes;
  }
  return result;
}

function sumBytes(values: readonly number[], start = 0, end = values.length): number | null {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += values[index]!;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function stateError(state: HistoryWindowState): string | null {
  if (!validAbsoluteLine(state.startLine)) return 'startLine must be a non-negative safe integer';
  if (state.lines.length === 0) return 'resident history window must contain at least one row';
  if (state.lineBytes.length !== state.lines.length) return 'lineBytes must align with lines';
  if (!state.lines.every((line) => typeof line === 'string')) return 'every resident row must be a string';
  if (!state.lineBytes.every(nonNegativeInteger)) return 'lineBytes must be non-negative safe integers';
  const endLine = addSafe(state.startLine, state.lines.length);
  if (endLine === null) return 'resident absolute range exceeds Number.MAX_SAFE_INTEGER';
  const actualBytes = sumBytes(state.lineBytes);
  if (actualBytes === null || actualBytes !== state.estimatedBytes) {
    return 'estimatedBytes must equal the sum of lineBytes';
  }
  if (!positiveInteger(state.limits.maxRows) || !positiveInteger(state.limits.maxBytes)) {
    return 'resident limits must be positive safe integers';
  }
  if (!nonNegativeInteger(state.limits.rowOverheadBytes)) {
    return 'rowOverheadBytes must be a non-negative safe integer';
  }
  if (state.lines.length > state.limits.maxRows) return 'resident row budget exceeded';
  if (state.estimatedBytes > state.limits.maxBytes) return 'resident byte budget exceeded';
  return null;
}

/** Construct a valid, already-bounded resident range without retaining inputs. */
export function createHistoryWindow(options: CreateHistoryWindowOptions): HistoryWindowState {
  const limits = resolvedLimits(options.limits);
  if (!validAbsoluteLine(options.startLine)) {
    throw new RangeError('history window startLine must be a non-negative safe integer');
  }
  if (options.lines.length === 0) {
    throw new RangeError('history window requires at least one resident row');
  }
  if (addSafe(options.startLine, options.lines.length) === null) {
    throw new RangeError('history window absolute range exceeds Number.MAX_SAFE_INTEGER');
  }
  const lines = Array.from(options.lines);
  const lineBytes = resolveLineBytes(lines, options.lineBytes, limits.rowOverheadBytes);
  if (lineBytes === null) throw new RangeError('history window lineBytes are invalid');
  const estimatedBytes = sumBytes(lineBytes);
  if (estimatedBytes === null) throw new RangeError('history window byte estimate overflowed');
  if (lines.length > limits.maxRows) {
    throw new RangeError(`history window exceeds ${limits.maxRows} retained rows`);
  }
  if (estimatedBytes > limits.maxBytes) {
    throw new RangeError(`history window exceeds ${limits.maxBytes} estimated bytes`);
  }
  return {
    startLine: options.startLine,
    lines,
    lineBytes,
    estimatedBytes,
    hasOlder: options.hasOlder ?? options.startLine > 0,
    hasNewer: options.hasNewer ?? false,
    limits,
  };
}

export function historyWindowEndLine(state: HistoryWindowState): number {
  return state.startLine + state.lines.length;
}

export function historyWindowRange(state: HistoryWindowState): HistoryWindowRange {
  return { startLine: state.startLine, endLine: historyWindowEndLine(state) };
}

export function historyWindowContains(state: HistoryWindowState, line: number): boolean {
  return validAbsoluteLine(line)
    && line >= state.startLine
    && line < historyWindowEndLine(state);
}

/** Return the next exclusive wire cursor, or null at that resident boundary. */
export function historyWindowRequestCursor(
  state: HistoryWindowState,
  direction: HistoryWindowDirection,
): HistoryWindowRequestCursor | null {
  if (direction === 'before') {
    return state.hasOlder ? { direction, beforeLine: state.startLine } : null;
  }
  return state.hasNewer
    ? { direction, afterLine: historyWindowEndLine(state) - 1 }
    : null;
}

function rejected(
  state: HistoryWindowState,
  reason: HistoryWindowRejectReason,
  message: string,
): HistoryWindowApplyRejected {
  return { kind: 'rejected', state, reason, message };
}

function rangeStats(
  absoluteStart: number,
  bytes: readonly number[],
  fromIndex: number,
  toIndex: number,
): HistoryWindowRangeStats | null {
  if (toIndex <= fromIndex) return null;
  const estimatedBytes = sumBytes(bytes, fromIndex, toIndex);
  if (estimatedBytes === null) return null;
  return {
    startLine: absoluteStart + fromIndex,
    endLine: absoluteStart + toIndex,
    rowCount: toIndex - fromIndex,
    estimatedBytes,
  };
}

function anchorCommit(
  state: HistoryWindowState,
  next: HistoryWindowState,
  anchor: HistoryWindowAnchor,
): HistoryWindowAnchorCommit {
  const previousIndex = anchor.line - state.startLine;
  const nextIndex = anchor.line - next.startLine;
  return {
    line: anchor.line,
    viewportOffsetPx: anchor.viewportOffsetPx,
    previousIndex,
    nextIndex,
    indexDelta: nextIndex - previousIndex,
    preserved: true,
  };
}

function validRange(range: HistoryWindowRange): boolean {
  return validAbsoluteLine(range.startLine)
    && validAbsoluteLine(range.endLine)
    && range.endLine > range.startLine;
}

/**
 * Merge one adjacent page and enforce both budgets.
 *
 * `before` first evicts existing rows from the newer/end side; `after` first
 * evicts from the older/start side.  The protected range is never evicted.
 * If that range leaves too little room, only the incoming page's far edge is
 * discarded, keeping the accepted rows contiguous and re-fetchable later.
 */
export function applyHistoryWindowPage(
  state: HistoryWindowState,
  page: HistoryWindowPage,
  options: ApplyHistoryWindowOptions,
): HistoryWindowApplyResult {
  const invalidState = stateError(state);
  if (invalidState) return rejected(state, 'invalid-state', invalidState);

  const anchor = options.anchor;
  if (
    !validAbsoluteLine(anchor.line)
    || !Number.isFinite(anchor.viewportOffsetPx)
    || !historyWindowContains(state, anchor.line)
  ) {
    return rejected(state, 'invalid-anchor', 'anchor must be a resident absolute line with a finite pixel offset');
  }

  const oldEnd = historyWindowEndLine(state);
  const protectedRange = options.protectedRange ?? {
    startLine: anchor.line,
    endLine: anchor.line + 1,
  };
  if (
    !validRange(protectedRange)
    || protectedRange.startLine < state.startLine
    || protectedRange.endLine > oldEnd
    || anchor.line < protectedRange.startLine
    || anchor.line >= protectedRange.endLine
  ) {
    return rejected(
      state,
      'invalid-protected-range',
      'protectedRange must be inside the resident window and contain the anchor',
    );
  }

  const expectedAnchor = page.direction === 'before' ? state.startLine : oldEnd - 1;
  if (!validAbsoluteLine(page.anchorLine) || page.anchorLine !== expectedAnchor) {
    return rejected(
      state,
      'stale-cursor',
      `page cursor ${String(page.anchorLine)} does not match current ${page.direction} cursor ${expectedAnchor}`,
    );
  }
  if (
    typeof page.hasMore !== 'boolean'
    || (page.startLine !== null && !validAbsoluteLine(page.startLine))
    || !page.lines.every((line) => typeof line === 'string')
  ) {
    return rejected(state, 'invalid-page', 'history page fields are malformed');
  }
  const pageBytes = resolveLineBytes(
    page.lines,
    page.lineBytes,
    state.limits.rowOverheadBytes,
  );
  if (pageBytes === null) {
    return rejected(state, 'invalid-page', 'history page lineBytes do not align with its lines');
  }

  if (
    page.continuation !== undefined
    && (
      (page.continuation !== 'end' && page.continuation !== 'more' && page.continuation !== 'blocked')
      || (page.continuation === 'end') === page.hasMore
    )
  ) {
    return rejected(state, 'invalid-page', 'flag-on continuation disagrees with hasMore');
  }

  if (page.lines.length === 0 && page.continuation === 'blocked') {
    // Pending/gap/remote: nothing to merge, and the edge must stay pageable.
    const next: HistoryWindowState = {
      ...state,
      lines: Array.from(state.lines),
      lineBytes: Array.from(state.lineBytes),
      hasOlder: page.direction === 'before' ? true : state.hasOlder,
      hasNewer: page.direction === 'after' ? true : state.hasNewer,
    };
    return {
      kind: 'blocked',
      state: next,
      anchor: anchorCommit(state, next, anchor),
      acceptedPage: null,
      evictedOpposite: null,
      discardedIncoming: null,
    };
  }

  if (page.lines.length === 0) {
    if (page.hasMore) {
      return rejected(state, 'empty-page-with-more', 'an empty page cannot make directional progress while hasMore is true');
    }
    const next: HistoryWindowState = {
      ...state,
      lines: Array.from(state.lines),
      lineBytes: Array.from(state.lineBytes),
      hasOlder: page.direction === 'before' ? false : state.hasOlder,
      hasNewer: page.direction === 'after' ? false : state.hasNewer,
    };
    return {
      kind: 'boundary',
      state: next,
      anchor: anchorCommit(state, next, anchor),
      acceptedPage: null,
      evictedOpposite: null,
      discardedIncoming: null,
    };
  }

  if (page.startLine === null || addSafe(page.startLine, page.lines.length) === null) {
    return rejected(state, 'invalid-page', 'a non-empty page needs a safe absolute startLine');
  }
  const pageEnd = page.startLine + page.lines.length;
  if (
    (page.direction === 'before' && pageEnd !== state.startLine)
    || (page.direction === 'after' && page.startLine !== oldEnd)
  ) {
    return rejected(
      state,
      'non-contiguous-page',
      `page [${page.startLine}, ${pageEnd}) is not adjacent to resident [${state.startLine}, ${oldEnd})`,
    );
  }

  const pageCount = page.lines.length;
  const oldCount = state.lines.length;
  const combinedStart = page.direction === 'before' ? page.startLine : state.startLine;
  const combinedLines = page.direction === 'before'
    ? [...page.lines, ...state.lines]
    : [...state.lines, ...page.lines];
  const combinedBytes = page.direction === 'before'
    ? [...pageBytes, ...state.lineBytes]
    : [...state.lineBytes, ...pageBytes];
  let keepStart = 0;
  let keepEnd = combinedLines.length;
  let retainedBytes = sumBytes(combinedBytes);
  if (retainedBytes === null) {
    return rejected(state, 'invalid-page', 'combined history byte estimate overflowed');
  }

  const protectedStartIndex = protectedRange.startLine - combinedStart;
  const protectedEndIndex = protectedRange.endLine - combinedStart;
  const overBudget = () => (
    keepEnd - keepStart > state.limits.maxRows
    || retainedBytes! > state.limits.maxBytes
  );

  if (page.direction === 'before') {
    // Opposite side first: evict the newest resident suffix, never protection.
    while (overBudget() && keepEnd > protectedEndIndex) {
      keepEnd -= 1;
      retainedBytes -= combinedBytes[keepEnd]!;
    }
    // If protection consumed the available space, discard only the oldest
    // incoming prefix. It remains reachable with beforeLine=new startLine.
    while (overBudget() && keepStart < pageCount && keepStart < protectedStartIndex) {
      retainedBytes -= combinedBytes[keepStart]!;
      keepStart += 1;
    }
  } else {
    // Opposite side first: evict the oldest resident prefix, never protection.
    while (overBudget() && keepStart < protectedStartIndex) {
      retainedBytes -= combinedBytes[keepStart]!;
      keepStart += 1;
    }
    // Then discard only the newest incoming suffix if necessary.
    while (overBudget() && keepEnd > oldCount && keepEnd > protectedEndIndex) {
      keepEnd -= 1;
      retainedBytes -= combinedBytes[keepEnd]!;
    }
  }

  if (overBudget()) {
    return rejected(
      state,
      'budget-cannot-preserve-anchor',
      'row/byte budgets cannot retain the protected range and any adjacent page row',
    );
  }

  const acceptedFrom = page.direction === 'before'
    ? keepStart
    : Math.max(oldCount, keepStart);
  const acceptedTo = page.direction === 'before'
    ? Math.min(pageCount, keepEnd)
    : keepEnd;
  const acceptedPage = rangeStats(combinedStart, combinedBytes, acceptedFrom, acceptedTo);
  if (acceptedPage === null) {
    return rejected(
      state,
      'budget-cannot-preserve-anchor',
      'row/byte budgets left no room for an incoming page row',
    );
  }

  const evictedOpposite = page.direction === 'before'
    ? rangeStats(
        combinedStart,
        combinedBytes,
        Math.max(keepEnd, pageCount),
        pageCount + oldCount,
      )
    : rangeStats(
        combinedStart,
        combinedBytes,
        0,
        Math.min(keepStart, oldCount),
      );
  const discardedIncoming = page.direction === 'before'
    ? rangeStats(combinedStart, combinedBytes, 0, Math.min(keepStart, pageCount))
    : rangeStats(combinedStart, combinedBytes, Math.max(keepEnd, oldCount), oldCount + pageCount);

  const nextStart = combinedStart + keepStart;
  const nextLines = combinedLines.slice(keepStart, keepEnd);
  const nextLineBytes = combinedBytes.slice(keepStart, keepEnd);
  const next: HistoryWindowState = {
    startLine: nextStart,
    lines: nextLines,
    lineBytes: nextLineBytes,
    estimatedBytes: retainedBytes,
    hasOlder: page.direction === 'before'
      ? page.hasMore || discardedIncoming !== null
      : state.hasOlder || evictedOpposite !== null,
    hasNewer: page.direction === 'after'
      ? page.hasMore || discardedIncoming !== null
      : state.hasNewer || evictedOpposite !== null,
    limits: state.limits,
  };

  const nextError = stateError(next);
  if (nextError) return rejected(state, 'invalid-state', `commit produced invalid state: ${nextError}`);
  if (!historyWindowContains(next, anchor.line)) {
    return rejected(state, 'budget-cannot-preserve-anchor', 'commit would evict the reader anchor');
  }

  return {
    kind: 'committed',
    state: next,
    anchor: anchorCommit(state, next, anchor),
    acceptedPage,
    evictedOpposite,
    discardedIncoming,
  };
}

// ── NEWARCH flag-on history states (display lot D) ─────────────────────────
//
// Status is never terminal text. These notes live beside the resident rows,
// not inside `lines`, so copy/search over rows can never pick up a label, and
// an unknown count renders as words, never as 0.

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

function gapCountText(gap: NewarchGap): string {
  if (gap.countKind === 'unknown') return 'จำนวนไม่ทราบ';
  if (gap.countKind === 'estimate') return `ประมาณ ${gap.missingCount} แถว`;
  return `${gap.missingCount} แถว`;
}

/** Reader-facing words for one state; `exact` has nothing to say. */
export function historyStateLabel(state: NewarchHistoryState): string | null {
  switch (state.kind) {
    case 'exact':
      return null;
    case 'gap':
      return `ช่วงนี้เก็บประวัติไม่ครบ — ${gapCountText(state.gap)}`;
    case 'pending':
      return 'กำลังกู้ประวัติช่วงนี้ — ยังไม่ใช่จุดสิ้นสุด';
    case 'remote-required':
      return 'ประวัติช่วงนี้อยู่ในคลังสำรอง ต้องดึงคืนก่อนอ่าน';
    case 'remote-unavailable':
      if (state.reason === 'offline') return 'ดึงประวัติจากคลังสำรองไม่ได้ตอนนี้ (ออฟไลน์) — ลองใหม่ภายหลัง';
      if (state.reason === 'missing') return 'ไม่พบประวัติช่วงนี้ในคลังสำรอง';
      return 'ประวัติช่วงนี้ในคลังสำรองเสียหาย อ่านไม่ได้';
    case 'degraded':
      return 'จอช่วงนี้ยังยืนยันไม่ครบ — แสดงเฉพาะส่วนที่ตรวจแล้ว';
    case 'pressure':
      if (!state.collecting) return 'หยุดเก็บประวัติ — พื้นที่ไม่พอ';
      if (state.level === 'emergency') return 'พื้นที่เก็บประวัติวิกฤต — อาจหยุดเก็บเร็วๆ นี้';
      if (state.level === 'critical') return 'พื้นที่เก็บประวัติใกล้เต็ม';
      return 'พื้นที่เก็บประวัติเริ่มเต็ม — กำลังย้ายไปคลังสำรอง';
  }
}

function rangeText(range: { segmentId: string; start: number; end: number }): string {
  return `${range.segmentId}[${range.start},${range.end})`;
}

function stateKey(state: Exclude<NewarchHistoryState, { kind: 'exact' }>): string {
  switch (state.kind) {
    case 'gap': {
      const left = state.gap.leftRowId;
      return `gap|${state.gap.episodeId}|${state.gap.reason}|${left ? `${left.segmentId}:${left.rowOrdinal}` : 'start'}`;
    }
    case 'pending':
      return `pending|${state.operationId}`;
    case 'remote-required':
      return `remote-required|${state.bundleId}|${rangeText(state.range)}`;
    case 'remote-unavailable':
      return `remote-unavailable|${state.reason}|${state.bundleId}|${rangeText(state.range)}`;
    case 'degraded':
      return `degraded|${state.episodeId}`;
    case 'pressure': {
      const incident = pressureIncidentFields(state);
      const id = incident ? `|${incident.incidentId}` : '';
      return `pressure|${state.level}|${state.collecting ? 'collecting' : 'stopped'}${id}`;
    }
  }
}

function stateDetail(state: Exclude<NewarchHistoryState, { kind: 'exact' }>): string {
  switch (state.kind) {
    case 'gap':
      return `gap · ${state.gap.reason} · ${state.gap.countKind}`
        + ` · withheld ${state.gap.withheldRows} · ${state.gap.quality}`;
    case 'pending':
      return `pending · ${state.operationId}`;
    case 'remote-required':
      return `remote-required · ${state.bundleId} · ${rangeText(state.range)}`;
    case 'remote-unavailable':
      return `remote-unavailable · ${state.reason} · ${state.bundleId} · ${rangeText(state.range)}`;
    case 'degraded':
      return `degraded · ${state.uncertainFields.join(',') || 'unknown fields'}`;
    case 'pressure':
      return `pressure · ${state.level} · ${state.collecting ? 'collecting' : 'stopped'}`;
  }
}

function retryAfter(state: Exclude<NewarchHistoryState, { kind: 'exact' }>): number | null {
  return state.kind === 'pending' || state.kind === 'remote-unavailable' ? state.retryAfterMs : null;
}

const REPAIR_CAPABILITIES: ReadonlySet<string> = new Set(NEWARCH_REPAIR_CAPABILITIES);
const INCIDENT_REASONS: ReadonlySet<string> = new Set([
  'storage-outage', 'collector-stalled', 'collector-exit', 'io',
]);

/** `seg:ordinal` for a real row, `none` before the first row, absent on a v1 note. */
export function historyIncidentLeftRowLabel(note: HistoryStatusNote): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(note, 'leftRowId')) return undefined;
  if (note.leftRowId == null) return 'none';
  return `${note.leftRowId.segmentId}:${note.leftRowId.rowOrdinal}`;
}

/**
 * What the reader sees beside a repair stop: local wall time and the last row
 * kept. Undefined on a v1 note. Never carries the raw ms or the incident id.
 */
export function historyIncidentStopLabel(note: HistoryStatusNote): string | undefined {
  const row = historyIncidentLeftRowLabel(note);
  if (row === undefined || note.openedAtWallMs === undefined) return undefined;
  const at = new Date(note.openedAtWallMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return `หยุดเมื่อ ${when} · ${row === 'none' ? 'ก่อนแถวแรก' : `แถวสุดท้าย ${row}`}`;
}

function copyRowId(value: Obj): NewarchRowId {
  const pane = value.pane as Obj;
  return {
    pane: {
      serverIdentity: String(pane.serverIdentity),
      paneId: String(pane.paneId),
      birthGeneration: pane.birthGeneration as number,
    },
    segmentId: String(value.segmentId),
    rowOrdinal: value.rowOrdinal as number,
  };
}

/** Incident carried on a pressure state. Absent when this stop never claimed one. */
function pressureIncidentFields(state: NewarchHistoryState): {
  incidentId: string;
  openedAtWallMs: number;
  leftRowId: NewarchRowId | null;
} | null {
  if (state.kind !== 'pressure') return null;
  const repair = (state as { repair?: unknown }).repair;
  if (!isObj(repair) || typeof repair.incidentId !== 'string' || typeof repair.openedAtWallMs !== 'number') return null;
  const left = repair.leftRowId;
  if (left !== null && !isObj(left)) return null;
  return {
    incidentId: repair.incidentId,
    openedAtWallMs: repair.openedAtWallMs,
    leftRowId: left === null ? null : copyRowId(left),
  };
}

/** One note per distinct state, including the states that block an edge. */
export function historyStatusNotes(extension: NewarchHistoryExtension): HistoryStatusNote[] {
  const notes = new Map<string, HistoryStatusNote>();
  const add = (state: NewarchHistoryState) => {
    if (state.kind === 'exact') return;
    const key = stateKey(state);
    if (notes.has(key)) return;
    const incident = pressureIncidentFields(state);
    notes.set(key, {
      key,
      kind: state.kind,
      text: historyStateLabel(state)!,
      detail: stateDetail(state),
      retryAfterMs: retryAfter(state),
      ...(incident
        ? {
            openedAtWallMs: incident.openedAtWallMs,
            incidentId: incident.incidentId,
            leftRowId: incident.leftRowId,
          }
        : {}),
    });
  };
  for (const state of extension.states) add(state);
  if (extension.before.kind === 'blocked') add(extension.before.state);
  if (extension.after.kind === 'blocked') add(extension.after.state);
  return [...notes.values()];
}

export function historyContinuationFor(
  extension: NewarchHistoryExtension,
  direction: HistoryWindowDirection,
): HistoryWindowContinuation {
  return (direction === 'before' ? extension.before : extension.after).kind;
}

// ── wire validation: a page whose states cannot be read is refused, never
// treated as an empty (EOF) page.

type Obj = Record<string, unknown>;
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(NEWARCH_FLAGON_CAPABILITIES);
const GAP_REASONS: ReadonlySet<string> = new Set([
  'pipe-eof', 'collector-exit', 'ambiguous-overlap', 'unproven-overlap', 'unknown-vt-state',
  'interrupted-capture', 'storage-outage', 'corruption', 'identity-change', 'geometry-change',
  'ownership-lost', 'visible-divergence',
]);

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function validPane(value: unknown): boolean {
  return isObj(value) && typeof value.serverIdentity === 'string' && typeof value.paneId === 'string'
    && isCount(value.birthGeneration);
}
function validRowRange(value: unknown): boolean {
  return isObj(value) && validPane(value.pane) && typeof value.segmentId === 'string'
    && isCount(value.start) && isCount(value.end) && value.start <= value.end;
}
function validCursor(value: unknown): boolean {
  return isObj(value) && value.version === 1 && isText(value.token);
}
function validGap(value: unknown): boolean {
  if (!isObj(value) || value.version !== 1 || !isText(value.episodeId) || !validPane(value.pane)) return false;
  if (value.parentEpisodeId !== null && !isText(value.parentEpisodeId)) return false;
  if (value.rightSegmentId !== null && typeof value.rightSegmentId !== 'string') return false;
  const left = value.leftRowId;
  if (left !== null && !(isObj(left) && validPane(left.pane) && typeof left.segmentId === 'string' && isCount(left.rowOrdinal))) return false;
  if (typeof value.reason !== 'string' || !GAP_REASONS.has(value.reason)) return false;
  // unknown is null, never 0; exact/estimate carry a real count.
  if (value.countKind === 'unknown') { if (value.missingCount !== null) return false; }
  else if (value.countKind === 'exact' || value.countKind === 'estimate') { if (!isCount(value.missingCount)) return false; }
  else return false;
  return isCount(value.withheldRows) && isCount(value.lowerBound)
    && typeof value.openedAt === 'number' && Number.isFinite(value.openedAt)
    && (value.closedAt === null || (typeof value.closedAt === 'number' && Number.isFinite(value.closedAt)))
    && typeof value.clockEpoch === 'string'
    && (value.quality === 'degraded' || value.quality === 'resolved');
}
function validRepairCaps(value: unknown): boolean {
  if (!isObj(value) || value.revision !== 2 || !Array.isArray(value.supported) || !Array.isArray(value.required)) return false;
  const supported = value.supported as unknown[];
  const required = value.required as unknown[];
  if (![...supported, ...required].every(cap => typeof cap === 'string' && REPAIR_CAPABILITIES.has(cap))) return false;
  return required.every(cap => supported.includes(cap));
}
function validIncident(value: unknown, collecting: boolean): boolean {
  if (!isObj(value) || value.revision !== 2 || !isText(value.incidentId) || !validPane(value.pane)) return false;
  if (!('leftRowId' in value)) return false;
  const left = value.leftRowId;
  if (left !== null && !(isObj(left) && validPane(left.pane) && isText(left.segmentId) && isCount(left.rowOrdinal))) return false;
  if (!isCount(value.openedAtWallMs) || !isCount(value.openedAtMonoMs) || !isText(value.clockEpoch)) return false;
  if (value.collecting !== collecting) return false;
  if (typeof value.reason !== 'string' || !INCIDENT_REASONS.has(value.reason)) return false;
  if (value.quality !== 'degraded' && value.quality !== 'resolved') return false;
  if (!('resolvedAtWallMs' in value)) return false;
  return value.resolvedAtWallMs === null || isCount(value.resolvedAtWallMs);
}
function validState(value: unknown, repairClaimed: boolean): value is NewarchHistoryState {
  if (!isObj(value)) return false;
  switch (value.kind) {
    case 'exact': return true;
    case 'gap': return validGap(value.gap);
    case 'pending': return isText(value.operationId) && isCount(value.retryAfterMs);
    case 'remote-required': return validRowRange(value.range) && isText(value.bundleId);
    case 'remote-unavailable':
      return validRowRange(value.range) && isText(value.bundleId) && isCount(value.retryAfterMs)
        && (value.reason === 'offline' || value.reason === 'missing' || value.reason === 'corrupt');
    case 'degraded':
      return isText(value.episodeId) && Array.isArray(value.uncertainFields)
        && value.uncertainFields.every(field => typeof field === 'string');
    case 'pressure': {
      if (!(value.level === 'archive' || value.level === 'critical' || value.level === 'emergency')) return false;
      if (typeof value.collecting !== 'boolean') return false;
      if (typeof value.sinceMonoMs !== 'number' || !Number.isFinite(value.sinceMonoMs) || value.sinceMonoMs < 0) return false;
      // A v1 page that never claimed repair still parses. A repair claim
      // without an incident id, wall time, and last row is not a stop label.
      if (!repairClaimed) return value.repair === undefined;
      return validIncident(value.repair, value.collecting);
    }
    default: return false;
  }
}
function validContinuation(value: unknown, repairClaimed: boolean): boolean {
  if (!isObj(value)) return false;
  if (value.kind === 'end') return true;
  if (value.kind === 'more') return validCursor(value.cursor);
  if (value.kind === 'blocked') {
    return validCursor(value.cursor) && validState(value.state, repairClaimed) && (value.state as Obj).kind !== 'exact';
  }
  return false;
}

/**
 * Parse the optional `flagOn` envelope of a history page. Returns null for
 * anything unreadable or for capabilities this display does not know; the
 * caller must then refuse the page (not draw rows without their states).
 */
export function parseNewarchHistoryExtension(value: unknown): NewarchHistoryExtension | null {
  if (!isObj(value) || value.version !== 1) return null;
  const caps = value.capabilities;
  if (!isObj(caps) || caps.extensionVersion !== 1
    || !Array.isArray(caps.supported) || !Array.isArray(caps.required)) return null;
  const supported = caps.supported as unknown[];
  const required = caps.required as unknown[];
  if (![...supported, ...required].every(cap => typeof cap === 'string' && KNOWN_CAPABILITIES.has(cap))) return null;
  if (!supported.includes('history-states-v1') || !required.every(cap => supported.includes(cap))) return null;
  const repairClaimed = value.repair !== undefined;
  if (repairClaimed && !validRepairCaps(value.repair)) return null;
  if (!Array.isArray(value.states) || !value.states.every(state => validState(state, repairClaimed))) return null;
  if (!validContinuation(value.before, repairClaimed) || !validContinuation(value.after, repairClaimed)) return null;
  return value as unknown as NewarchHistoryExtension;
}
