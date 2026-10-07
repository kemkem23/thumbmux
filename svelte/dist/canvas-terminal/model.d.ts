export type CanvasCell = Readonly<{
    text: string;
    col: number;
    width: number;
    continuation: false;
}>;
export type CanvasContinuationCell = Readonly<{
    text: '';
    col: number;
    width: 0;
    continuation: true;
}>;
export type CanvasTerminalCell = CanvasCell | CanvasContinuationCell;
export type CanvasModelRow = Readonly<{
    id: number;
    raw: string;
    text: string;
    cells: readonly CanvasTerminalCell[];
}>;
export type ModelPoint = Readonly<{
    row: number;
    col: number;
}>;
export type ModelSelection = Readonly<{
    anchor: ModelPoint;
    focus: ModelPoint;
}>;
/** Code-point accounting mirrors stringCells, including VS16 promotion.
 * Keep graphemes together for shaping, but sum their terminal advances. */
export declare function lineToCanvasCells(raw: string): CanvasTerminalCell[];
export declare function createCanvasModelRows(rawLines: readonly string[], firstId?: number): CanvasModelRow[];
/** Byte source for copy. Continuation cells never contribute text. */
export declare function selectedModelText(rows: readonly CanvasModelRow[], selection: ModelSelection): string;
export declare function modelPointFromPixel(x: number, y: number, cellWidth: number, lineHeight: number, rowOffset?: number): ModelPoint;
