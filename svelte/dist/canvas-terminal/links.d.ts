import { type SgrState, type LineLinkRange, type AnsiPalette } from '@thumbmux/core';
export type CanvasLinkHit = Readonly<{
    row: number;
    startCol: number;
    endCol: number;
    href: string;
}>;
export declare function canvasHtmlLinkHits(htmlRows: readonly string[]): CanvasLinkHit[];
/** Convert collector coordinates only; lineToHtml owns OSC8 and isSafeHref. */
export declare function canvasLineHtml(raw: string, state: SgrState, palette: AnsiPalette, links?: readonly LineLinkRange[]): string;
/** Standalone fixture path uses the same parser as the production HTML cache. */
export declare function canvasLinkHits(lines: readonly string[], cols: number): CanvasLinkHit[];
