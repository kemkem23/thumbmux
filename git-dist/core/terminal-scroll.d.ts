export declare const DEFAULT_WHEEL_PIXEL_SCALE = 0.6;
export declare const MAX_WHEEL_LINES_PER_FRAME = 12;
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
export declare function findLineOverlap(previousLines: string[], nextLines: string[]): number;
export declare function mergeCapturedLinesForStableScroll(previousLines: string[], nextLines: string[]): StableCaptureMerge;
/**
 * Number of rows by which a scrolled reader's bottom offset should move when
 * a live capture grows or shrinks. Terminal captures commonly rewrite the
 * prompt plus one adjacent tail row while appending output; a stable common
 * prefix through that two-row tail is sufficient to preserve the reader's
 * anchor. Larger rewrites are treated as replacements and are not adjusted.
 */
export declare function readerAnchorLineDelta(previousLines: string[], nextLines: string[], maxTailRewrite?: number): number;
export declare function wheelDeltaToLines(event: WheelDeltaInput, lineHeightPx: number, rows: number, pixelScale?: number): number;
export declare function consumeWholeWheelLines(remainder: number): {
    wholeLines: number;
    remainder: number;
};
