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
