/**
 * Pure bounded archive-window model for TermView's future bidirectional pager.
 *
 * The model deliberately knows nothing about DOM, Svelte, ANSI rendering, or
 * WebSockets.  It owns only absolute line ranges, retained raw rows, budgets,
 * paging cursors, and the bookkeeping needed to keep one reader anchor fixed
 * while the resident range slides in either direction.
 */
import { NEWARCH_FLAGON_CAPABILITIES, NEWARCH_REPAIR_CAPABILITIES, NEWARCH_V2_WIRE_LIMITS, newarchV2SamePane, } from '@thumbmux/core';
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
        if (!state.hasOlder)
            return null;
        return state.flagOnCursorBefore
            ? { direction, beforeLine: state.startLine, flagOnCursor: state.flagOnCursorBefore }
            : { direction, beforeLine: state.startLine };
    }
    if (!state.hasNewer)
        return null;
    return state.flagOnCursorAfter
        ? { direction, afterLine: historyWindowEndLine(state) - 1, flagOnCursor: state.flagOnCursorAfter }
        : { direction, afterLine: historyWindowEndLine(state) - 1 };
}
function copyFlagCursor(value) {
    if (value == null)
        return null;
    if (value.version !== 1 || typeof value.token !== 'string' || value.token.length === 0)
        return 'bad';
    return { version: 1, token: value.token };
}
function attachFlagCursor(next, state, direction, cursor) {
    const before = direction === 'before' && cursor ? cursor : state.flagOnCursorBefore;
    const after = direction === 'after' && cursor ? cursor : state.flagOnCursorAfter;
    if (!before && !after)
        return next;
    return {
        ...next,
        ...(before ? { flagOnCursorBefore: before } : {}),
        ...(after ? { flagOnCursorAfter: after } : {}),
    };
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
    if (page.continuation !== undefined
        && ((page.continuation !== 'end' && page.continuation !== 'more' && page.continuation !== 'blocked')
            || (page.continuation === 'end') === page.hasMore)) {
        return rejected(state, 'invalid-page', 'flag-on continuation disagrees with hasMore');
    }
    const flagCursor = copyFlagCursor(page.flagOnCursor);
    if (flagCursor === 'bad') {
        return rejected(state, 'invalid-page', 'flag-on cursor is not readable');
    }
    if (page.lines.length === 0 && page.continuation === 'blocked') {
        // Pending/gap/remote: nothing to merge, and the edge must stay pageable.
        const next = {
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
        const next = {
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
        state: attachFlagCursor(next, state, page.direction, flagCursor),
        anchor: anchorCommit(state, next, anchor),
        acceptedPage,
        evictedOpposite,
        discardedIncoming,
    };
}
function gapCountText(gap) {
    if (gap.countKind === 'unknown')
        return 'จำนวนไม่ทราบ';
    if (gap.countKind === 'estimate')
        return `ประมาณ ${gap.missingCount} แถว`;
    return `${gap.missingCount} แถว`;
}
/** Reader-facing words for one state; `exact` has nothing to say. */
export function historyStateLabel(state) {
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
            if (state.reason === 'offline')
                return 'ดึงประวัติจากคลังสำรองไม่ได้ตอนนี้ (ออฟไลน์) — ลองใหม่ภายหลัง';
            if (state.reason === 'missing')
                return 'ไม่พบประวัติช่วงนี้ในคลังสำรอง';
            return 'ประวัติช่วงนี้ในคลังสำรองเสียหาย อ่านไม่ได้';
        case 'degraded':
            return 'จอช่วงนี้ยังยืนยันไม่ครบ — แสดงเฉพาะส่วนที่ตรวจแล้ว';
        case 'pressure':
            if (!state.collecting)
                return 'หยุดเก็บประวัติ — พื้นที่ไม่พอ';
            if (state.level === 'emergency')
                return 'พื้นที่เก็บประวัติวิกฤต — อาจหยุดเก็บเร็วๆ นี้';
            if (state.level === 'critical')
                return 'พื้นที่เก็บประวัติใกล้เต็ม';
            return 'พื้นที่เก็บประวัติเริ่มเต็ม — กำลังย้ายไปคลังสำรอง';
    }
}
function rangeText(range) {
    return `${range.segmentId}[${range.start},${range.end})`;
}
function stateKey(state) {
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
function stateDetail(state) {
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
function retryAfter(state) {
    return state.kind === 'pending' || state.kind === 'remote-unavailable' ? state.retryAfterMs : null;
}
const REPAIR_CAPABILITIES = new Set(NEWARCH_REPAIR_CAPABILITIES);
const INCIDENT_REASONS = new Set([
    'storage-outage', 'collector-stalled', 'collector-exit', 'io',
]);
/** `seg:ordinal` for a real row, `none` before the first row, absent on a v1 note. */
export function historyIncidentLeftRowLabel(note) {
    if (!Object.prototype.hasOwnProperty.call(note, 'leftRowId'))
        return undefined;
    if (note.leftRowId == null)
        return 'none';
    return `${note.leftRowId.segmentId}:${note.leftRowId.rowOrdinal}`;
}
/**
 * What the reader sees beside a repair stop: local wall time and the last row
 * kept. Undefined on a v1 note. Never carries the raw ms or the incident id.
 */
export function historyIncidentStopLabel(note) {
    const row = historyIncidentLeftRowLabel(note);
    if (row === undefined || note.openedAtWallMs === undefined)
        return undefined;
    const at = new Date(note.openedAtWallMs);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    return `หยุดเมื่อ ${when} · ${row === 'none' ? 'ก่อนแถวแรก' : `แถวสุดท้าย ${row}`}`;
}
function copyRowId(value) {
    const pane = value.pane;
    return {
        pane: {
            serverIdentity: String(pane.serverIdentity),
            paneId: String(pane.paneId),
            birthGeneration: pane.birthGeneration,
        },
        segmentId: String(value.segmentId),
        rowOrdinal: value.rowOrdinal,
    };
}
/** Incident carried on a pressure state. Absent when this stop never claimed one. */
function pressureIncidentFields(state) {
    if (state.kind !== 'pressure')
        return null;
    const repair = state.repair;
    if (!isObj(repair) || typeof repair.incidentId !== 'string' || typeof repair.openedAtWallMs !== 'number')
        return null;
    const left = repair.leftRowId;
    if (left !== null && !isObj(left))
        return null;
    return {
        incidentId: repair.incidentId,
        openedAtWallMs: repair.openedAtWallMs,
        leftRowId: left === null ? null : copyRowId(left),
    };
}
/** One note per distinct state, including the states that block an edge. */
export function historyStatusNotes(extension) {
    const notes = new Map();
    const add = (state) => {
        if (state.kind === 'exact')
            return;
        const key = stateKey(state);
        if (notes.has(key))
            return;
        const incident = pressureIncidentFields(state);
        notes.set(key, {
            key,
            kind: state.kind,
            text: historyStateLabel(state),
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
    for (const state of extension.states)
        add(state);
    if (extension.before.kind === 'blocked')
        add(extension.before.state);
    if (extension.after.kind === 'blocked')
        add(extension.after.state);
    return [...notes.values()];
}
export function historyContinuationFor(extension, direction) {
    return (direction === 'before' ? extension.before : extension.after).kind;
}
const KNOWN_CAPABILITIES = new Set(NEWARCH_FLAGON_CAPABILITIES);
const GAP_REASONS = new Set([
    'pipe-eof', 'collector-exit', 'ambiguous-overlap', 'unproven-overlap', 'unknown-vt-state',
    'interrupted-capture', 'storage-outage', 'corruption', 'identity-change', 'geometry-change',
    'ownership-lost', 'visible-divergence',
]);
function isObj(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isText(value) {
    return typeof value === 'string' && value.length > 0;
}
function validPane(value) {
    return isObj(value) && typeof value.serverIdentity === 'string' && typeof value.paneId === 'string'
        && isCount(value.birthGeneration);
}
function validRowRange(value) {
    return isObj(value) && validPane(value.pane) && typeof value.segmentId === 'string'
        && isCount(value.start) && isCount(value.end) && value.start <= value.end;
}
function validCursor(value) {
    return isObj(value) && value.version === 1 && isText(value.token);
}
function validGap(value) {
    if (!isObj(value) || value.version !== 1 || !isText(value.episodeId) || !validPane(value.pane))
        return false;
    if (value.parentEpisodeId !== null && !isText(value.parentEpisodeId))
        return false;
    if (value.rightSegmentId !== null && typeof value.rightSegmentId !== 'string')
        return false;
    const left = value.leftRowId;
    if (left !== null && !(isObj(left) && validPane(left.pane) && typeof left.segmentId === 'string' && isCount(left.rowOrdinal)))
        return false;
    if (typeof value.reason !== 'string' || !GAP_REASONS.has(value.reason))
        return false;
    // unknown is null, never 0; exact/estimate carry a real count.
    if (value.countKind === 'unknown') {
        if (value.missingCount !== null)
            return false;
    }
    else if (value.countKind === 'exact' || value.countKind === 'estimate') {
        if (!isCount(value.missingCount))
            return false;
    }
    else
        return false;
    return isCount(value.withheldRows) && isCount(value.lowerBound)
        && typeof value.openedAt === 'number' && Number.isFinite(value.openedAt)
        && (value.closedAt === null || (typeof value.closedAt === 'number' && Number.isFinite(value.closedAt)))
        && typeof value.clockEpoch === 'string'
        && (value.quality === 'degraded' || value.quality === 'resolved');
}
function validRepairCaps(value) {
    if (!isObj(value) || value.revision !== 2 || !Array.isArray(value.supported) || !Array.isArray(value.required))
        return false;
    const supported = value.supported;
    const required = value.required;
    if (![...supported, ...required].every(cap => typeof cap === 'string' && REPAIR_CAPABILITIES.has(cap)))
        return false;
    return required.every(cap => supported.includes(cap));
}
function validIncident(value, collecting) {
    if (!isObj(value) || value.revision !== 2 || !isText(value.incidentId) || !validPane(value.pane))
        return false;
    if (!('leftRowId' in value))
        return false;
    const left = value.leftRowId;
    if (left !== null && !(isObj(left) && validPane(left.pane) && isText(left.segmentId) && isCount(left.rowOrdinal)))
        return false;
    if (!isCount(value.openedAtWallMs) || !isCount(value.openedAtMonoMs) || !isText(value.clockEpoch))
        return false;
    if (value.collecting !== collecting)
        return false;
    if (typeof value.reason !== 'string' || !INCIDENT_REASONS.has(value.reason))
        return false;
    if (value.quality !== 'degraded' && value.quality !== 'resolved')
        return false;
    if (!('resolvedAtWallMs' in value))
        return false;
    return value.resolvedAtWallMs === null || isCount(value.resolvedAtWallMs);
}
function validState(value, repairClaimed) {
    if (!isObj(value))
        return false;
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
            if (!(value.level === 'archive' || value.level === 'critical' || value.level === 'emergency'))
                return false;
            if (typeof value.collecting !== 'boolean')
                return false;
            if (typeof value.sinceMonoMs !== 'number' || !Number.isFinite(value.sinceMonoMs) || value.sinceMonoMs < 0)
                return false;
            // A v1 page that never claimed repair still parses. A repair claim
            // without an incident id, wall time, and last row is not a stop label.
            if (!repairClaimed)
                return value.repair === undefined;
            return validIncident(value.repair, value.collecting);
        }
        default: return false;
    }
}
function validContinuation(value, repairClaimed) {
    if (!isObj(value))
        return false;
    if (value.kind === 'end')
        return true;
    if (value.kind === 'more')
        return validCursor(value.cursor);
    if (value.kind === 'blocked') {
        return validCursor(value.cursor) && validState(value.state, repairClaimed) && value.state.kind !== 'exact';
    }
    return false;
}
export const NEWARCH_V2_NOTE_CAP = 64;
const V2_INCIDENT_REASON = {
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
function v2WallClock(openedAtWallMs) {
    const at = new Date(openedAtWallMs);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(at.getDate())}/${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
/** Visible sentence for one incident. Frontier null is before the first row. */
export function newarchV2IncidentLabel(incident) {
    const reason = V2_INCIDENT_REASON[incident.reason];
    const row = incident.frontier
        ? `แถวสุดท้าย ${incident.frontier.segmentId}:${incident.frontier.rowOrdinal}`
        : 'ก่อนแถวแรก';
    const stopped = incident.collecting ? '' : ' — หยุดเก็บแล้ว';
    return `${reason} — ${v2WallClock(incident.openedAtWallMs)} — ${row}${stopped}`;
}
/** Exact history has no label. A blocked store is never described as the end. */
export function newarchV2StateLabel(state) {
    switch (state.kind) {
        case 'exact':
            return null;
        case 'incident':
            return newarchV2IncidentLabel(state.incident);
        case 'storage-unavailable':
            return state.pendingIncidentId
                ? 'ที่เก็บประวัติใช้ไม่ได้ตอนนี้ — มีเหตุรอบันทึก — ยังไม่ใช่จุดสิ้นสุด'
                : 'ที่เก็บประวัติใช้ไม่ได้ตอนนี้ — ยังไม่ใช่จุดสิ้นสุด';
        case 'remote-unavailable':
            if (state.reason === 'offline')
                return 'ดึงประวัติจากคลังสำรองไม่ได้ตอนนี้ (ออฟไลน์) — ยังไม่ใช่จุดสิ้นสุด';
            if (state.reason === 'missing')
                return 'ไม่พบประวัติช่วงนี้ในคลังสำรอง — ยังไม่ใช่จุดสิ้นสุด';
            return 'ประวัติช่วงนี้ในคลังสำรองเสียหาย อ่านไม่ได้ — ยังไม่ใช่จุดสิ้นสุด';
    }
}
/** Labels stay outside row text. The list is capped so a storm cannot grow without bound. */
export function newarchV2StatusNotes(input) {
    const notes = [];
    const push = (key, text) => {
        if (!text || notes.some(note => note.key === key) || notes.length >= NEWARCH_V2_NOTE_CAP)
            return;
        notes.push({ key, text });
    };
    for (const entry of input.entries) {
        if (entry.kind !== 'incident')
            continue;
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
/** Visible sentence for a pane that no longer collects. Active panes have none. */
export function newarchV2PaneStateLabel(pane) {
    switch (pane.state) {
        case 'stopped': return 'pane นี้หยุดเก็บแล้ว — ไม่มีแถวใหม่เข้าประวัติ';
        case 'closed': return 'pane นี้ปิดแล้ว — ประวัติที่เห็นคือทั้งหมดที่บันทึกไว้';
        case 'unrecorded': return 'pane นี้ไม่ได้บันทึกประวัติ';
        default: return null;
    }
}
// --- D3: v2 cursor pager over the existing bounded line window ---
//
// The resident window (above) stays line-addressed and bounded. A v2 pane has
// no line numbers on the wire, so the pager numbers rows locally, keeps the
// server's own cursor at every page boundary, and never turns a cursor into a
// line. Bookkeeping is bounded: pages wholly outside the resident window are
// dropped (`newarchV2PagerRetain`).
/** Local line the newest v2 row ends at when the window has no live seam. */
export const NEWARCH_V2_PAGER_BASE_LINE = 1_000_000_000;
export function createNewarchV2Pager(pane, baseLine = NEWARCH_V2_PAGER_BASE_LINE) {
    if (!validAbsoluteLine(baseLine))
        throw new RangeError('v2 pager base line must be a non-negative safe integer');
    // The pane-state sentence is drawn from the live descriptor, not kept here.
    return { pane, baseLine, revision: 0, pages: [], notes: [] };
}
function v2PagerKey(row) {
    return `${row.id.segmentId}:${row.id.rowOrdinal}`;
}
function v2PagerEnd(page) {
    return page.startLine + page.keys.length;
}
function v2CursorOf(continuation) {
    if (continuation === null)
        return null;
    if (continuation.kind === 'end')
        return { kind: 'end' };
    return { kind: 'ask', direction: 'before', cursor: continuation.cursor, edgeLine: 0, overlap: 0 };
}
/**
 * The request for one edge of the resident window. `edgeLine` is the window's
 * first line (before) or its exclusive end (after). When the edge falls inside
 * a page, the pager asks from that page's nearest known boundary and reports
 * how many already-resident rows the reply must repeat (`overlap`).
 */
export function newarchV2PagerAsk(state, direction, edgeLine) {
    const pages = state.pages;
    if (pages.length === 0) {
        return direction === 'before'
            ? { kind: 'ask', direction, cursor: null, edgeLine: state.baseLine, overlap: 0 }
            : { kind: 'end' };
    }
    const edge = edgeLine ?? (direction === 'before' ? pages[0].startLine : v2PagerEnd(pages.at(-1)));
    const limit = NEWARCH_V2_WIRE_LIMITS.pageEntries;
    const finish = (found, overlap) => {
        if (found === null || overlap >= limit)
            return { kind: 'unknown' };
        if (found.kind !== 'ask')
            return overlap === 0 ? found : { kind: 'unknown' };
        return { kind: 'ask', direction, cursor: found.cursor, edgeLine: edge, overlap };
    };
    // A page edge cut by eviction has no cursor (null): resume from the
    // neighbouring page's edge and let the reply repeat the rows in between.
    if (direction === 'before') {
        const index = pages.findIndex(page => page.startLine <= edge && edge < v2PagerEnd(page));
        if (index < 0)
            return { kind: 'unknown' };
        const page = pages[index];
        if (page.startLine === edge && page.before !== null)
            return finish(v2CursorOf(page.before), 0);
        const next = pages[index + 1];
        return finish(next ? v2CursorOf(next.before) : null, v2PagerEnd(page) - edge);
    }
    const index = pages.findIndex(page => page.startLine < edge && edge <= v2PagerEnd(page));
    if (index < 0)
        return { kind: 'unknown' };
    const page = pages[index];
    if (v2PagerEnd(page) === edge && page.after !== null)
        return finish(v2CursorOf(page.after), 0);
    const previous = pages[index - 1];
    return finish(previous ? v2CursorOf(previous.after) : null, edge - page.startLine);
}
function v2PagerKeysAt(state, from, to) {
    const keys = [];
    for (let line = from; line < to; line++) {
        const page = state.pages.find(candidate => candidate.startLine <= line && line < v2PagerEnd(candidate));
        const key = page?.keys[line - page.startLine];
        if (key === undefined)
            return null;
        keys.push(key);
    }
    return keys;
}
function v2SgrText(row) {
    let out = '';
    let current = '';
    let last = row.cells.length;
    // Trailing unstyled blanks are padding, not text a reader copies.
    while (last > 0 && row.cells[last - 1].text === ' ' && row.cells[last - 1].style.length === 0)
        last--;
    for (let index = 0; index < last; index++) {
        const cell = row.cells[index];
        if (cell.width === 0 && cell.text === '')
            continue;
        const style = cell.style.join(';');
        if (style !== current) {
            out += style ? `\u001b[0;${style}m` : '\u001b[0m';
            current = style;
        }
        out += cell.text;
    }
    return current ? `${out}\u001b[0m` : out;
}
function v2MergeNotes(held, fresh) {
    const notes = [...held];
    for (const note of fresh) {
        if (notes.length >= NEWARCH_V2_NOTE_CAP)
            break;
        // One incident arrives both as an entry and as a state: one sentence.
        if (!notes.some(existing => existing.key === note.key || existing.text === note.text))
            notes.push(note);
    }
    return notes;
}
/**
 * Apply one reply to the ask that produced it. Rows already resident (the
 * overlap) must come back identical, and no other row may repeat: a page
 * that would lose, duplicate, or reorder a row is refused, never drawn.
 */
export function applyNewarchV2PagerReply(state, ask, reply) {
    if (!newarchV2SamePane(reply.pane, state.pane.pane))
        return { kind: 'reset', reason: 'wrong-pane' };
    if (reply.status === 'error') {
        switch (reply.code) {
            case 'wrong-pane': return { kind: 'reset', reason: 'wrong-pane' };
            case 'stale-cursor': return { kind: 'reset', reason: 'stale-cursor' };
            case 'owner-unavailable': return {
                kind: 'retry', retryAfterMs: reply.retryAfterMs,
                state: { ...state, notes: v2MergeNotes(state.notes, [{ key: 'owner-unavailable', text: 'เจ้าของประวัติยังไม่พร้อม — ยังไม่ใช่จุดสิ้นสุด' }]) },
            };
            default: return { kind: 'refused', reason: reply.code };
        }
    }
    if (reply.revision < state.revision)
        return { kind: 'reset', reason: 'stale-cursor' };
    const rows = reply.entries.filter((entry) => entry.kind === 'row');
    const keys = rows.map(v2PagerKey);
    if (new Set(keys).size !== keys.length)
        return { kind: 'refused', reason: 'duplicate-row' };
    const { direction, edgeLine, overlap } = ask;
    if (rows.length < overlap)
        return { kind: 'refused', reason: 'overlap-short' };
    const expected = direction === 'before'
        ? v2PagerKeysAt(state, edgeLine, edgeLine + overlap)
        : v2PagerKeysAt(state, edgeLine - overlap, edgeLine);
    const repeated = direction === 'before' ? keys.slice(keys.length - overlap) : keys.slice(0, overlap);
    if (expected === null || expected.join('\n') !== repeated.join('\n'))
        return { kind: 'refused', reason: 'overlap-mismatch' };
    const freshRows = direction === 'before' ? rows.slice(0, rows.length - overlap) : rows.slice(overlap);
    const freshKeys = direction === 'before' ? keys.slice(0, keys.length - overlap) : keys.slice(overlap);
    const resident = new Set(state.pages.flatMap(page => page.keys));
    if (freshKeys.some(key => resident.has(key)))
        return { kind: 'refused', reason: 'duplicate-row' };
    const continuation = direction === 'before' ? reply.before : reply.after;
    const notes = v2MergeNotes(state.notes, newarchV2StatusNotes({ entries: reply.entries, states: reply.states }));
    let pages = [...state.pages];
    let startLine = null;
    if (freshRows.length > 0) {
        startLine = direction === 'before' ? edgeLine - freshRows.length : edgeLine;
        if (startLine < 0 || !Number.isSafeInteger(startLine + freshRows.length))
            return { kind: 'refused', reason: 'line-range' };
        const page = {
            startLine,
            keys: freshKeys,
            // A cursor is kept only where it sits exactly on this record's edge.
            before: direction === 'before' || overlap === 0 ? reply.before : null,
            after: direction === 'after' || overlap === 0 ? reply.after : null,
        };
        if (direction === 'before')
            pages.unshift(page);
        else
            pages.push(page);
    }
    else if (pages.length > 0 && overlap === 0) {
        // An incident-only or blocked page still moves this edge's cursor.
        if (direction === 'before')
            pages[0] = { ...pages[0], before: continuation };
        else
            pages[pages.length - 1] = { ...pages.at(-1), after: continuation };
    }
    return {
        kind: 'page',
        state: { ...state, revision: Math.max(state.revision, reply.revision), pages, notes },
        direction,
        startLine,
        lines: freshRows.map(v2SgrText),
        hasMore: continuation.kind !== 'end',
        blocked: continuation.kind === 'blocked',
    };
}
/**
 * Keep exactly the resident rows: pages outside the window are dropped and a
 * page cut by eviction keeps only its resident keys. A cut edge loses its
 * cursor (that position is no longer a page boundary), so a row that left the
 * window can come back once and is never mistaken for a duplicate.
 */
export function newarchV2PagerRetain(state, range) {
    let changed = false;
    const pages = [];
    for (const page of state.pages) {
        const end = v2PagerEnd(page);
        const from = Math.max(page.startLine, range.startLine);
        const to = Math.min(end, range.endLine);
        if (to <= from) {
            changed = true;
            continue;
        }
        if (from === page.startLine && to === end) {
            pages.push(page);
            continue;
        }
        changed = true;
        pages.push({
            startLine: from,
            keys: page.keys.slice(from - page.startLine, to - page.startLine),
            before: from === page.startLine ? page.before : null,
            after: to === end ? page.after : null,
        });
    }
    return changed ? { ...state, pages } : state;
}
/** Terminal rows only. Status sentences are not part of copy or search. */
export function newarchV2RowCopy(rows) {
    return rows.join('\n');
}
/** Every viewer intent gets the birth geometry back. Nothing here is a resize write. */
export function answerNewarchV2Geometry(geometry, _intent) {
    return { status: 'fixed', geometry, resize: null };
}
/** One pane is selected. Two or more stay a list, including a display-name collision. */
export function selectNewarchV2Panes(panes, next) {
    if (panes.length === 0 && next === null)
        return { kind: 'missing' };
    if (panes.length === 1 && next === null)
        return { kind: 'selected', pane: panes[0] };
    return { kind: 'ambiguous', panes: [...panes], next };
}
/**
 * Viewport, font, fit-width, rotation, and keyboard inset change only this
 * picture. Terminal columns and rows stay on the birth geometry.
 */
export function presentNewarchV2(terminal, viewport) {
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
/** Clamp without rounding; non-finite falls back to the stock 13px. */
function clampExact(value, bounds) {
    const fallback = Number.isFinite(value) ? value : 13;
    if (fallback < bounds.min)
        return bounds.min;
    if (fallback > bounds.max)
        return bounds.max;
    return fallback;
}
/** Floor to two decimals, tolerating float noise just under a hundredth. */
function floor2(value) {
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
export function fitNewarchFontPx(input) {
    const { columns, containerWidthPx, bounds } = input;
    const gutter = typeof input.gutterPx === 'number' && Number.isFinite(input.gutterPx)
        ? input.gutterPx
        : FONT_FIT_GUTTER_PX;
    const ceiling = floor2(clampExact(input.ceilingPx, bounds));
    const usable = containerWidthPx - gutter;
    const cellAt = (px) => {
        const measured = input.measureCellPx(px);
        return Number.isFinite(measured) && measured > 0
            ? measured
            : px * FONT_FIT_FALLBACK_CELL_RATIO;
    };
    // 1e-6 absorbs float noise such as 70 × 9 × 0.6 = 378.00000000000006.
    const fitsAt = (px) => columns * cellAt(px) <= usable + 1e-6;
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
    const snap = (px) => {
        const grid = Math.floor(px / FONT_FIT_STEP_PX + 1e-6) * FONT_FIT_STEP_PX;
        return Math.min(ceiling, Math.max(floor, floor2(grid)));
    };
    let candidate = snap(ceiling * usable / (columns * cellAt(ceiling)));
    let best = null;
    for (let probe = 0; probe < FONT_FIT_MAX_PROBES; probe++) {
        if (fitsAt(candidate)) {
            if (best === null || candidate > best)
                best = candidate;
            const up = snap(candidate + FONT_FIT_STEP_PX);
            // Converged: the next step overflows (it is known not to fit at the ceiling).
            if (up <= candidate || !fitsAt(up))
                break;
            candidate = up;
        }
        else {
            if (candidate <= floor)
                break;
            // Re-aim from the cell measured at this size: a cell that is not
            // proportional to the font can leave the first guess many steps high,
            // and stepping down 0.05px would run out of probes and fall to the floor.
            const aimed = snap(candidate * usable / (columns * cellAt(candidate)));
            candidate = aimed < candidate ? aimed : snap(candidate - FONT_FIT_STEP_PX);
        }
    }
    if (best !== null)
        return { fontPx: best, fits: true };
    return { fontPx: floor, fits: fitsAt(floor) };
}
/** Map a viewport point through scroll and fit-width scale onto the fixed grid. */
export function hitNewarchV2Cell(presentation, point, cell) {
    if (!(presentation.scale > 0) || !(cell.widthPx > 0) || !(cell.heightPx > 0))
        return null;
    const localX = (point.clientX - point.originX + presentation.scrollXPx) / presentation.scale;
    const localY = (point.clientY - point.originY) / presentation.scale;
    if (!Number.isFinite(localX) || !Number.isFinite(localY) || localX < 0 || localY < 0)
        return null;
    const col = Math.floor(localX / cell.widthPx);
    const row = Math.floor(localY / cell.heightPx);
    if (col < 0 || col >= presentation.columns || row < 0 || row >= presentation.rows)
        return null;
    return { col, row };
}
/**
 * Parse the optional `flagOn` envelope of a history page. Returns null for
 * anything unreadable or for capabilities this display does not know; the
 * caller must then refuse the page (not draw rows without their states).
 */
export function parseNewarchHistoryExtension(value) {
    if (!isObj(value) || value.version !== 1)
        return null;
    const caps = value.capabilities;
    if (!isObj(caps) || caps.extensionVersion !== 1
        || !Array.isArray(caps.supported) || !Array.isArray(caps.required))
        return null;
    const supported = caps.supported;
    const required = caps.required;
    if (![...supported, ...required].every(cap => typeof cap === 'string' && KNOWN_CAPABILITIES.has(cap)))
        return null;
    if (!supported.includes('history-states-v1') || !required.every(cap => supported.includes(cap)))
        return null;
    const repairClaimed = value.repair !== undefined;
    if (repairClaimed && !validRepairCaps(value.repair))
        return null;
    if (!Array.isArray(value.states) || !value.states.every(state => validState(state, repairClaimed)))
        return null;
    if (!validContinuation(value.before, repairClaimed) || !validContinuation(value.after, repairClaimed))
        return null;
    return value;
}
