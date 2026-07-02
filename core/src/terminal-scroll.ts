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

export function findLineOverlap(previousLines: string[], nextLines: string[]): number {
  const max = Math.min(previousLines.length, nextLines.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (previousLines[previousStart + i] !== nextLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
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
