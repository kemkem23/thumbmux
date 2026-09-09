/**
 * Pure bounded archive-window model for TermView's future bidirectional pager.
 *
 * The model deliberately knows nothing about DOM, Svelte, ANSI rendering, or
 * WebSockets.  It owns only absolute line ranges, retained raw rows, budgets,
 * paging cursors, and the bookkeeping needed to keep one reader anchor fixed
 * while the resident range slides in either direction.
 */
export const HISTORY_WINDOW_MAX_ROWS = 10_000;
export const HISTORY_WINDOW_MAX_BYTES = 8 * 1024 * 1024;
export const HISTORY_WINDOW_ROW_OVERHEAD_BYTES = 64;
function finiteInteger(value) {
    return Number.isFinite(value) && Number.isSafeInteger(value);
}
function validAbsoluteLine(value) {
    return finiteInteger(value) && value >= 0;
}
function positiveInteger(value) {
    return finiteInteger(value) && value > 0;
}
function nonNegativeInteger(value) {
    return finiteInteger(value) && value >= 0;
}
function addSafe(left, right) {
    const result = left + right;
    return Number.isSafeInteger(result) ? result : null;
}
function resolvedLimits(partial) {
    const limits = {
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
export function estimateHistoryWindowLineBytes(line, rowOverheadBytes = HISTORY_WINDOW_ROW_OVERHEAD_BYTES) {
    if (!nonNegativeInteger(rowOverheadBytes)) {
        throw new RangeError('rowOverheadBytes must be a non-negative safe integer');
    }
    const estimated = rowOverheadBytes + 2 * line.length;
    if (!Number.isSafeInteger(estimated)) {
        throw new RangeError('history line byte estimate exceeds Number.MAX_SAFE_INTEGER');
    }
    return estimated;
}
function resolveLineBytes(lines, supplied, rowOverheadBytes) {
    if (!lines.every((line) => typeof line === 'string'))
        return null;
    if (supplied !== undefined && supplied.length !== lines.length)
        return null;
    const result = new Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
        const bytes = supplied?.[index]
            ?? estimateHistoryWindowLineBytes(lines[index], rowOverheadBytes);
        if (!nonNegativeInteger(bytes))
            return null;
        result[index] = bytes;
    }
    return result;
}
function sumBytes(values, start = 0, end = values.length) {
    let total = 0;
    for (let index = start; index < end; index += 1) {
        total += values[index];
        if (!Number.isSafeInteger(total))
            return null;
    }
    return total;
}
function stateError(state) {
    if (!validAbsoluteLine(state.startLine))
        return 'startLine must be a non-negative safe integer';
    if (state.lines.length === 0)
        return 'resident history window must contain at least one row';
    if (state.lineBytes.length !== state.lines.length)
        return 'lineBytes must align with lines';
    if (!state.lines.every((line) => typeof line === 'string'))
        return 'every resident row must be a string';
    if (!state.lineBytes.every(nonNegativeInteger))
        return 'lineBytes must be non-negative safe integers';
    const endLine = addSafe(state.startLine, state.lines.length);
    if (endLine === null)
        return 'resident absolute range exceeds Number.MAX_SAFE_INTEGER';
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
    if (state.lines.length > state.limits.maxRows)
        return 'resident row budget exceeded';
    if (state.estimatedBytes > state.limits.maxBytes)
        return 'resident byte budget exceeded';
    return null;
}
/** Construct a valid, already-bounded resident range without retaining inputs. */
export function createHistoryWindow(options) {
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
    if (lineBytes === null)
        throw new RangeError('history window lineBytes are invalid');
    const estimatedBytes = sumBytes(lineBytes);
    if (estimatedBytes === null)
        throw new RangeError('history window byte estimate overflowed');
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
export function historyWindowEndLine(state) {
    return state.startLine + state.lines.length;
}
export function historyWindowRange(state) {
    return { startLine: state.startLine, endLine: historyWindowEndLine(state) };
}
export function historyWindowContains(state, line) {
    return validAbsoluteLine(line)
        && line >= state.startLine
        && line < historyWindowEndLine(state);
}
/** Return the next exclusive wire cursor, or null at that resident boundary. */
export function historyWindowRequestCursor(state, direction) {
    if (direction === 'before') {
        return state.hasOlder ? { direction, beforeLine: state.startLine } : null;
    }
    return state.hasNewer
        ? { direction, afterLine: historyWindowEndLine(state) - 1 }
        : null;
}
function rejected(state, reason, message) {
    return { kind: 'rejected', state, reason, message };
}
function rangeStats(absoluteStart, bytes, fromIndex, toIndex) {
    if (toIndex <= fromIndex)
        return null;
    const estimatedBytes = sumBytes(bytes, fromIndex, toIndex);
    if (estimatedBytes === null)
        return null;
    return {
        startLine: absoluteStart + fromIndex,
        endLine: absoluteStart + toIndex,
        rowCount: toIndex - fromIndex,
        estimatedBytes,
    };
}
function anchorCommit(state, next, anchor) {
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
function validRange(range) {
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
export function applyHistoryWindowPage(state, page, options) {
    const invalidState = stateError(state);
    if (invalidState)
        return rejected(state, 'invalid-state', invalidState);
    const anchor = options.anchor;
    if (!validAbsoluteLine(anchor.line)
        || !Number.isFinite(anchor.viewportOffsetPx)
        || !historyWindowContains(state, anchor.line)) {
        return rejected(state, 'invalid-anchor', 'anchor must be a resident absolute line with a finite pixel offset');
    }
    const oldEnd = historyWindowEndLine(state);
    const protectedRange = options.protectedRange ?? {
        startLine: anchor.line,
        endLine: anchor.line + 1,
    };
    if (!validRange(protectedRange)
        || protectedRange.startLine < state.startLine
        || protectedRange.endLine > oldEnd
        || anchor.line < protectedRange.startLine
        || anchor.line >= protectedRange.endLine) {
        return rejected(state, 'invalid-protected-range', 'protectedRange must be inside the resident window and contain the anchor');
    }
    const expectedAnchor = page.direction === 'before' ? state.startLine : oldEnd - 1;
    if (!validAbsoluteLine(page.anchorLine) || page.anchorLine !== expectedAnchor) {
        return rejected(state, 'stale-cursor', `page cursor ${String(page.anchorLine)} does not match current ${page.direction} cursor ${expectedAnchor}`);
    }
    if (typeof page.hasMore !== 'boolean'
        || (page.startLine !== null && !validAbsoluteLine(page.startLine))
        || !page.lines.every((line) => typeof line === 'string')) {
        return rejected(state, 'invalid-page', 'history page fields are malformed');
    }
    const pageBytes = resolveLineBytes(page.lines, page.lineBytes, state.limits.rowOverheadBytes);
    if (pageBytes === null) {
        return rejected(state, 'invalid-page', 'history page lineBytes do not align with its lines');
    }
    if (page.lines.length === 0) {
        if (page.hasMore) {
            return rejected(state, 'empty-page-with-more', 'an empty page cannot make directional progress while hasMore is true');
        }
        const next = {
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
    if ((page.direction === 'before' && pageEnd !== state.startLine)
        || (page.direction === 'after' && page.startLine !== oldEnd)) {
        return rejected(state, 'non-contiguous-page', `page [${page.startLine}, ${pageEnd}) is not adjacent to resident [${state.startLine}, ${oldEnd})`);
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
    const overBudget = () => (keepEnd - keepStart > state.limits.maxRows
        || retainedBytes > state.limits.maxBytes);
    if (page.direction === 'before') {
        // Opposite side first: evict the newest resident suffix, never protection.
        while (overBudget() && keepEnd > protectedEndIndex) {
            keepEnd -= 1;
            retainedBytes -= combinedBytes[keepEnd];
        }
        // If protection consumed the available space, discard only the oldest
        // incoming prefix. It remains reachable with beforeLine=new startLine.
        while (overBudget() && keepStart < pageCount && keepStart < protectedStartIndex) {
            retainedBytes -= combinedBytes[keepStart];
            keepStart += 1;
        }
    }
    else {
        // Opposite side first: evict the oldest resident prefix, never protection.
        while (overBudget() && keepStart < protectedStartIndex) {
            retainedBytes -= combinedBytes[keepStart];
            keepStart += 1;
        }
        // Then discard only the newest incoming suffix if necessary.
        while (overBudget() && keepEnd > oldCount && keepEnd > protectedEndIndex) {
            keepEnd -= 1;
            retainedBytes -= combinedBytes[keepEnd];
        }
    }
    if (overBudget()) {
        return rejected(state, 'budget-cannot-preserve-anchor', 'row/byte budgets cannot retain the protected range and any adjacent page row');
    }
    const acceptedFrom = page.direction === 'before'
        ? keepStart
        : Math.max(oldCount, keepStart);
    const acceptedTo = page.direction === 'before'
        ? Math.min(pageCount, keepEnd)
        : keepEnd;
    const acceptedPage = rangeStats(combinedStart, combinedBytes, acceptedFrom, acceptedTo);
    if (acceptedPage === null) {
        return rejected(state, 'budget-cannot-preserve-anchor', 'row/byte budgets left no room for an incoming page row');
    }
    const evictedOpposite = page.direction === 'before'
        ? rangeStats(combinedStart, combinedBytes, Math.max(keepEnd, pageCount), pageCount + oldCount)
        : rangeStats(combinedStart, combinedBytes, 0, Math.min(keepStart, oldCount));
    const discardedIncoming = page.direction === 'before'
        ? rangeStats(combinedStart, combinedBytes, 0, Math.min(keepStart, pageCount))
        : rangeStats(combinedStart, combinedBytes, Math.max(keepEnd, oldCount), oldCount + pageCount);
    const nextStart = combinedStart + keepStart;
    const nextLines = combinedLines.slice(keepStart, keepEnd);
    const nextLineBytes = combinedBytes.slice(keepStart, keepEnd);
    const next = {
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
    if (nextError)
        return rejected(state, 'invalid-state', `commit produced invalid state: ${nextError}`);
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
