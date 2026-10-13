import type { AnsiPalette } from '@thumbmux/core';
import type { CanvasModelRow } from './model';
export type CanvasPaintOptions = Readonly<{
    fontFamily: string;
    rowGeometry?: readonly {
        top: number;
        height: number;
    }[];
    fontSize: number;
    lineHeight: number;
    cellWidth: number;
    strokeWidth: number;
    vectorFont: boolean;
    dpr: number;
    palette: AnsiPalette;
}>;
export declare function effectiveStrokeWidth(value: number): number;
export declare function paintCanvasRows(context: CanvasRenderingContext2D, rows: readonly CanvasModelRow[], options: CanvasPaintOptions): void;
