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
  type NewarchV2FixedGeometry,
  type NewarchV2Incident,
  type NewarchV2IncidentReason,
  type NewarchV2PaneDescriptor,
  type NewarchV2PaneSelection,
  type NewarchV2ReadState,
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
  /** Opaque flag-on cursor for the older edge. Copied, never aliased to the caller. */
  flagOnCursorBefore?: Readonly<{ version: 1; token: string }>;
  /** Opaque flag-on cursor for the newer edge. */
  flagOnCursorAfter?: Readonly<{ version: 1; token: string }>;
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
  flagOnCursor?: { readonly version: number; readonly token: string } | null;
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
  | Readonly<{ direction: 'before'; beforeLine: number; flagOnCursor?: Readonly<{ version: 1; token: string }> }>
  | Readonly<{ direction: 'after'; afterLine: number; flagOnCursor?: Readonly<{ version: 1; token: string }> }>;

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
    if (!state.hasOlder) return null;
    return state.flagOnCursorBefore
      ? { direction, beforeLine: state.startLine, flagOnCursor: state.flagOnCursorBefore }
      : { direction, beforeLine: state.startLine };
  }
  if (!state.hasNewer) return null;
  return state.flagOnCursorAfter
    ? { direction, afterLine: historyWindowEndLine(state) - 1, flagOnCursor: state.flagOnCursorAfter }
    : { direction, afterLine: historyWindowEndLine(state) - 1 };
}

type StoredFlagCursor = Readonly<{ version: 1; token: string }>;

function copyFlagCursor(value: HistoryWindowPage['flagOnCursor']): StoredFlagCursor | null | 'bad' {
  if (value == null) return null;
  if (value.version !== 1 || typeof value.token !== 'string' || value.token.length === 0) return 'bad';
  return { version: 1, token: value.token };
}

function attachFlagCursor(
  next: HistoryWindowState,
  state: HistoryWindowState,
  direction: HistoryWindowDirection,
  cursor: StoredFlagCursor | null,
): HistoryWindowState {
  const before = direction === 'before' && cursor ? cursor : state.flagOnCursorBefore;
  const after = direction === 'after' && cursor ? cursor : state.flagOnCursorAfter;
  if (!before && !after) return next;
  return {
    ...next,
    ...(before ? { flagOnCursorBefore: before } : {}),
    ...(after ? { flagOnCursorAfter: after } : {}),
  };
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
  const flagCursor = copyFlagCursor(page.flagOnCursor);
  if (flagCursor === 'bad') {
    return rejected(state, 'invalid-page', 'flag-on cursor is not readable');
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
      state: attachFlagCursor(next, state, page.direction, flagCursor),
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
      state: attachFlagCursor(next, state, page.direction, flagCursor),
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
    state: attachFlagCursor(next, state, page.direction, flagCursor),
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

export const NEWARCH_V2_NOTE_CAP = 64;

const V2_INCIDENT_REASON: Record<NewarchV2IncidentReason, string> = {
  'geometry-violation': 'ขนาดจอถูกเปลี่ยนระหว่างเก็บ',
  'unverified-restart': 'เครื่องดับแล้วพิสูจน์ความต่อเนื่องไม่ได้',
  'unrecorded-birth': 'มี pane ที่ไม่ได้บันทึกตั้งแต่เกิด',
  'birth-failed': 'เปิดเซสชันไม่สำเร็จ',
  'pipe-eof': 'ท่อเก็บขาด',
  'collector-epoch-changed': 'ตัวเก็บเปลี่ยนรุ่น',
  'storage-outage': 'พื้นที่เก็บใช้ไม่ได้',
  'budget-exhausted': 'พื้นที่เก็บเต็ม',
  'audit-mismatch': 'ภาพจอไม่ตรงกับที่บันทึก',
  'decoder-anomaly': 'ถอดรหัสจอไม่สมบูรณ์',
  'identity-change': 'ตัวตนของ pane เปลี่ยน',
};

function v2WallClock(openedAtWallMs: number): string {
  const at = new Date(openedAtWallMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Visible sentence for one incident. Frontier null is before the first row. */
export function newarchV2IncidentLabel(incident: NewarchV2Incident): string {
  const reason = V2_INCIDENT_REASON[incident.reason];
  const row = incident.frontier
    ? `แถวสุดท้าย ${incident.frontier.segmentId}:${incident.frontier.rowOrdinal}`
    : 'ก่อนแถวแรก';
  const stopped = incident.collecting ? '' : ' — หยุดเก็บแล้ว';
  return `${reason} — ${v2WallClock(incident.openedAtWallMs)} — ${row}${stopped}`;
}

/** Exact history has no label. A blocked store is never described as the end. */
export function newarchV2StateLabel(state: NewarchV2ReadState): string | null {
  switch (state.kind) {
    case 'exact':
      return null;
    case 'incident':
      return newarchV2IncidentLabel(state.incident);
    case 'storage-unavailable':
      return 'ที่เก็บประวัติใช้ไม่ได้ตอนนี้ — ยังไม่ใช่จุดสิ้นสุด';
    case 'remote-unavailable':
      if (state.reason === 'offline') return 'ดึงประวัติจากคลังสำรองไม่ได้ตอนนี้ (ออฟไลน์) — ยังไม่ใช่จุดสิ้นสุด';
      if (state.reason === 'missing') return 'ไม่พบประวัติช่วงนี้ในคลังสำรอง — ยังไม่ใช่จุดสิ้นสุด';
      return 'ประวัติช่วงนี้ในคลังสำรองเสียหาย อ่านไม่ได้ — ยังไม่ใช่จุดสิ้นสุด';
  }
}

export type NewarchV2StatusNote = Readonly<{ key: string; text: string }>;

/** Labels stay outside row text. The list is capped so a storm cannot grow without bound. */
export function newarchV2StatusNotes(input: {
  readonly entries: readonly ({ readonly kind: 'incident'; readonly incident: NewarchV2Incident } | { readonly kind: 'row' })[];
  readonly states: readonly NewarchV2ReadState[];
}): NewarchV2StatusNote[] {
  const notes: NewarchV2StatusNote[] = [];
  const push = (key: string, text: string | null) => {
    if (!text || notes.some(note => note.key === key) || notes.length >= NEWARCH_V2_NOTE_CAP) return;
    notes.push({ key, text });
  };
  for (const entry of input.entries) {
    if (entry.kind !== 'incident') continue;
    push(`incident|${entry.incident.incidentId}`, newarchV2IncidentLabel(entry.incident));
  }
  for (const state of input.states) {
    const text = newarchV2StateLabel(state);
    const key = state.kind === 'incident'
      ? `state|${state.incident.incidentId}`
      : state.kind === 'remote-unavailable'
        ? `state|remote-unavailable|${state.reason}|${state.bundleId}`
        : state.kind === 'storage-unavailable'
          ? `state|storage-unavailable|${state.pendingIncidentId ?? ''}`
          : 'state|exact';
    push(key, text);
  }
  return notes;
}

/** Terminal rows only. Status sentences are not part of copy or search. */
export function newarchV2RowCopy(rows: readonly string[]): string {
  return rows.join('\n');
}

export interface NewarchV2GeometryIntent {
  readonly source: 'viewport' | 'font' | 'fit-width' | 'rotation' | 'keyboard-inset' | 'apply-geometry';
  readonly columns: number;
  readonly rows: number;
}

/** Every viewer intent gets the birth geometry back. Nothing here is a resize write. */
export function answerNewarchV2Geometry(
  geometry: NewarchV2FixedGeometry,
  _intent: NewarchV2GeometryIntent,
): { readonly status: 'fixed'; readonly geometry: NewarchV2FixedGeometry; readonly resize: null } {
  return { status: 'fixed', geometry, resize: null };
}

/** One pane is selected. Two or more stay a list, including a display-name collision. */
export function selectNewarchV2Panes(
  panes: readonly NewarchV2PaneDescriptor[],
  next: string | null,
): NewarchV2PaneSelection {
  if (panes.length === 0 && next === null) return { kind: 'missing' };
  if (panes.length === 1 && next === null) return { kind: 'selected', pane: panes[0]! };
  return { kind: 'ambiguous', panes: [...panes], next };
}

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
export function presentNewarchV2(
  terminal: { readonly columns: number; readonly rows: number },
  viewport: NewarchV2Viewport,
): NewarchV2Presentation {
  const columns = terminal.columns;
  const rows = terminal.rows;
  const naturalWidth = columns * viewport.cellWidthPx;
  const naturalHeight = rows * viewport.cellHeightPx;
  const scale = viewport.fitWidth && naturalWidth > 0 ? viewport.widthPx / naturalWidth : 1;
  const contentWidthPx = naturalWidth * scale;
  const contentHeightPx = naturalHeight * scale;
  const maxScrollXPx = viewport.fitWidth ? 0 : Math.max(0, naturalWidth - viewport.widthPx);
  const scrollXPx = viewport.fitWidth ? 0 : Math.min(Math.max(0, viewport.scrollXPx), maxScrollXPx);
  const inset = Math.max(0, viewport.keyboardInsetPx);
  return {
    columns,
    rows,
    scale,
    contentWidthPx,
    contentHeightPx,
    visibleHeightPx: Math.max(0, viewport.heightPx - inset),
    maxScrollXPx,
    scrollXPx,
    horizontalScroll: maxScrollXPx > 0,
    resize: null,
  };
}

// --- NEWARCH fit-font (plan §6): font that fits birth columns, never a resize ---

/** Horizontal padding TermView puts around the line: 6px each side. */
export const FONT_FIT_GUTTER_PX = 12;

/** Granularity of the fit search, in CSS pixels. */
export const FONT_FIT_STEP_PX = 0.05;

/** Upper bound on cell measurements after the first guess. */
export const FONT_FIT_MAX_PROBES = 8;

/**
 * Cell-to-font ratio used **only** when the measure returns nothing usable
 * (canvas not ready, font not loaded). It is a stand-in until the caller
 * re-measures — never the answer on a real screen, because installed fonts
 * give different cells.
 */
export const FONT_FIT_FALLBACK_CELL_RATIO = 0.6;

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
  bounds: { readonly min: number; readonly max: number };
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

/** Clamp without rounding; non-finite falls back to the stock 13px. */
function clampExact(value: number, bounds: { readonly min: number; readonly max: number }): number {
  const fallback = Number.isFinite(value) ? value : 13;
  if (fallback < bounds.min) return bounds.min;
  if (fallback > bounds.max) return bounds.max;
  return fallback;
}

/** Floor to two decimals, tolerating float noise just under a hundredth. */
function floor2(value: number): number {
  return Math.floor(value * 100 + 1e-6) / 100;
}

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
export function fitNewarchFontPx(input: NewarchFontFitInput): NewarchFontFitResult {
  const { columns, containerWidthPx, bounds } = input;
  const gutter = typeof input.gutterPx === 'number' && Number.isFinite(input.gutterPx)
    ? input.gutterPx
    : FONT_FIT_GUTTER_PX;
  const ceiling = floor2(clampExact(input.ceilingPx, bounds));
  const usable = containerWidthPx - gutter;

  const cellAt = (px: number): number => {
    const measured = input.measureCellPx(px);
    return Number.isFinite(measured) && measured > 0
      ? measured
      : px * FONT_FIT_FALLBACK_CELL_RATIO;
  };
  // 1e-6 absorbs float noise such as 70 × 9 × 0.6 = 378.00000000000006.
  const fitsAt = (px: number): boolean => columns * cellAt(px) <= usable + 1e-6;

  if (!Number.isFinite(columns) || columns <= 0 || !Number.isFinite(usable) || usable <= 0) {
    return { fontPx: ceiling, fits: false };
  }
  if (input.mode === 'manual') {
    return { fontPx: ceiling, fits: fitsAt(ceiling) };
  }
  if (fitsAt(ceiling)) {
    return { fontPx: ceiling, fits: true };
  }

  const floor = bounds.min;
  const snap = (px: number): number => {
    const grid = Math.floor(px / FONT_FIT_STEP_PX + 1e-6) * FONT_FIT_STEP_PX;
    return Math.min(ceiling, Math.max(floor, floor2(grid)));
  };

  let candidate = snap(ceiling * usable / (columns * cellAt(ceiling)));
  let best: number | null = null;
  for (let probe = 0; probe < FONT_FIT_MAX_PROBES; probe++) {
    if (fitsAt(candidate)) {
      if (best === null || candidate > best) best = candidate;
      const up = snap(candidate + FONT_FIT_STEP_PX);
      // Converged: the next step overflows (it is known not to fit at the ceiling).
      if (up <= candidate || !fitsAt(up)) break;
      candidate = up;
    } else {
      if (candidate <= floor) break;
      candidate = snap(candidate - FONT_FIT_STEP_PX);
    }
  }

  if (best !== null) return { fontPx: best, fits: true };
  return { fontPx: floor, fits: fitsAt(floor) };
}

/** Map a viewport point through scroll and fit-width scale onto the fixed grid. */
export function hitNewarchV2Cell(
  presentation: NewarchV2Presentation,
  point: { readonly clientX: number; readonly clientY: number; readonly originX: number; readonly originY: number },
  cell: { readonly widthPx: number; readonly heightPx: number },
): { readonly col: number; readonly row: number } | null {
  if (!(presentation.scale > 0) || !(cell.widthPx > 0) || !(cell.heightPx > 0)) return null;
  const localX = (point.clientX - point.originX + presentation.scrollXPx) / presentation.scale;
  const localY = (point.clientY - point.originY) / presentation.scale;
  if (!Number.isFinite(localX) || !Number.isFinite(localY) || localX < 0 || localY < 0) return null;
  const col = Math.floor(localX / cell.widthPx);
  const row = Math.floor(localY / cell.heightPx);
  if (col < 0 || col >= presentation.columns || row < 0 || row >= presentation.rows) return null;
  return { col, row };
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
