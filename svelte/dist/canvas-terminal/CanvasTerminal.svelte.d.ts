import type { AnsiPalette } from '@thumbmux/core';
type $$ComponentProps = {
    lines: readonly string[];
    htmlRows?: readonly string[];
    geometry?: readonly {
        top: number;
        height: number;
        id: number;
        visualRow: number;
        absoluteTop: number;
    }[];
    firstLineId?: number;
    cols: number;
    cellWidth: number;
    lineHeight: number;
    fontSize: number;
    fontFamily?: string;
    strokeWidth?: number;
    vectorFont?: boolean;
    palette: AnsiPalette;
};
declare const CanvasTerminal: import("svelte").Component<$$ComponentProps, {}, "">;
type CanvasTerminal = ReturnType<typeof CanvasTerminal>;
export default CanvasTerminal;
