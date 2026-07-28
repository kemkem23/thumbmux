export const DEFAULT_WHEEL_PIXEL_SCALE = 0.6;
export const MAX_WHEEL_LINES_PER_FRAME = 12;

export type WheelDeltaInput = {
  deltaY: number;
  deltaMode: number;
};

export type StableCaptureMerge = {
  lines: string[];
  appendedLineCount: number;
  preservedPrefix: boolean;
};

/**
 * Largest k where previousLines' last k rows equal nextLines' first k rows.
 *
 * Fast path: descending candidate scan (shipped v0.3.5 algorithm). Real captures
 * almost always mismatch on the first row of a wrong candidate, so this path is
 * ~10x faster than a pure KMP rewrite on the common case that runs every merge.
 * A comparison budget bounds the quadratic worst case (repeated identical rows
 * that only diverge on the last row); when exhausted we fall back to a linear
 * KMP prefix-function over interned line ids, computed on the full inputs.
 */
export function findLineOverlap(previousLines: string[], nextLines: string[]): number {
  const max = Math.min(previousLines.length, nextLines.length);
  // Budget: fast path is cheap on real captures; fallback only bounds worst case.
  let budget = 2 * (previousLines.length + nextLines.length) + 64;
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (--budget < 0) {
        return findLineOverlapLinear(previousLines, nextLines);
      }
      if (previousLines[previousStart + i] !== nextLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

/** Linear-time KMP prefix-function overlap over interned line ids. Module-private. */
function findLineOverlapLinear(previousLines: string[], nextLines: string[]): number {
  if (previousLines.length === 0 || nextLines.length === 0) return 0;

  const m = nextLines.length;
  const idByLine = new Map<string, number>();
  const pattern = new Int32Array(m);
  let nextId = 0;
  for (let i = 0; i < m; i++) {
    const line = nextLines[i];
    let id = idByLine.get(line);
    if (id === undefined) {
      id = nextId++;
      idByLine.set(line, id);
    }
    pattern[i] = id;
  }

  // Prefix function (KMP failure function) of the pattern.
  const pi = new Int32Array(m);
  for (let i = 1, len = 0; i < m; ) {
    if (pattern[i] === pattern[len]) {
      pi[i++] = ++len;
    } else if (len > 0) {
      len = pi[len - 1];
    } else {
      pi[i++] = 0;
    }
  }

  // Run the automaton over previousLines. Unknown lines map to -1 (never equals a pattern id).
  let state = 0;
  for (let i = 0; i < previousLines.length; i++) {
    // Full-length match already reached: fall through pi before consuming the next row
    // so a match landing on the final row is still reported as m.
    if (state === m) {
      state = pi[m - 1];
    }
    const id = idByLine.get(previousLines[i]) ?? -1;
    while (state > 0 && pattern[state] !== id) {
      state = pi[state - 1];
    }
    if (pattern[state] === id) {
      state++;
    }
  }
  return state;
}

export function mergeCapturedLinesForStableScroll(
  previousLines: string[],
  nextLines: string[],
): StableCaptureMerge {
  if (previousLines.length === 0) {
    return { lines: nextLines, appendedLineCount: nextLines.length, preservedPrefix: false };
  }

  const overlap = findLineOverlap(previousLines, nextLines);
  const minimumStableOverlap = Math.min(8, previousLines.length, nextLines.length);
  if (overlap >= minimumStableOverlap) {
    const appended = nextLines.slice(overlap);
    return {
      lines: appended.length > 0 ? [...previousLines, ...appended] : previousLines,
      appendedLineCount: appended.length,
      preservedPrefix: true,
    };
  }

  return {
    lines: nextLines,
    appendedLineCount: nextLines.length - previousLines.length,
    preservedPrefix: false,
  };
}

/**
 * Number of rows by which a scrolled reader's bottom offset should move when
 * a live capture grows or shrinks. Terminal captures commonly rewrite the
 * prompt plus one adjacent tail row while appending output; a stable common
 * prefix through that two-row tail is sufficient to preserve the reader's
 * anchor. Larger rewrites are treated as replacements and are not adjusted.
 */
export function readerAnchorLineDelta(
  previousLines: string[],
  nextLines: string[],
  maxTailRewrite = 2,
): number {
  const lineDelta = nextLines.length - previousLines.length;
  const minLength = Math.min(previousLines.length, nextLines.length);
  if (lineDelta === 0 || minLength === 0) return 0;

  let commonPrefix = 0;
  while (
    commonPrefix < minLength
    && previousLines[commonPrefix] === nextLines[commonPrefix]
  ) commonPrefix++;

  const toleratedTail = Math.max(0, Math.floor(maxTailRewrite));
  const requiredPrefix = Math.max(1, minLength - toleratedTail);
  return commonPrefix >= requiredPrefix ? lineDelta : 0;
}

export function wheelDeltaToLines(
  event: WheelDeltaInput,
  lineHeightPx: number,
  rows: number,
  pixelScale = DEFAULT_WHEEL_PIXEL_SCALE,
): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
  if (event.deltaMode === 1) return event.deltaY;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, rows);
  return (event.deltaY / Math.max(1, lineHeightPx)) * pixelScale;
}

export function consumeWholeWheelLines(remainder: number): { wholeLines: number; remainder: number } {
  const wholeLines = remainder > 0 ? Math.floor(remainder) : Math.ceil(remainder);
  if (wholeLines === 0) return { wholeLines: 0, remainder };

  const clamped = Math.max(-MAX_WHEEL_LINES_PER_FRAME, Math.min(MAX_WHEEL_LINES_PER_FRAME, wholeLines));
  return {
    wholeLines: clamped,
    remainder: remainder - clamped,
  };
}
