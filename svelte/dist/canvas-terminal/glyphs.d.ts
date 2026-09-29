export type StrokePoint = readonly [number, number];
export type StrokeGlyph = Readonly<{
    advance: 1 | 2;
    strokes: readonly (readonly StrokePoint[])[];
    weights?: readonly number[];
}>;
export declare const SINGLE_LINE_LICENSE = "Hershey distribution notice; box geometry CC0-1.0";
export declare const SINGLE_LINE_SOURCE = "Hershey Roman Simplex centerline data (see LICENSE.md)";
export declare function singleLineGlyph(text: string): StrokeGlyph | null;
/** Canonical geometry signature ignores path order/direction, includes weight. */
export declare function glyphShapeKey(glyph: StrokeGlyph): string;
export declare const GLYPH_INVENTORY: Readonly<{
    ascii: {
        requested: number;
        singleLine: number;
        uniqueShapes: number;
        fallback: number;
    };
    boxDrawing: {
        requested: number;
        singleLine: number;
        uniqueShapes: number;
        fallback: number;
    };
    thai: {
        requested: number;
        singleLine: number;
        uniqueShapes: number;
        fallback: number;
    };
    cjkSample: {
        sample: string;
        requested: number;
        singleLine: number;
        uniqueShapes: number;
        fallback: number;
    };
}>;
export declare function glyphCoverage(text: string): 'single-line' | 'outline-fallback';
