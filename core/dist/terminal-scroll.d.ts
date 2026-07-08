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
export declare function wheelDeltaToLines(event: WheelDeltaInput, lineHeightPx: number, rows: number, pixelScale?: number): number;
export declare function consumeWholeWheelLines(remainder: number): {
    wholeLines: number;
    remainder: number;
};
