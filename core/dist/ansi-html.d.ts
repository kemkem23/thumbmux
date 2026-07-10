/**
 * Minimal SGR (ANSI color) → HTML renderer for the mobile terminal engine.
 *
 * tmux `capture-pane -e` output is plain text lines with inline SGR codes —
 * no cursor movement — so a color-state machine over `ESC[...m` is enough.
 * SGR state legally carries across lines, so callers thread the state:
 *
 *   const st = createSgrState();
 *   for (const line of lines) html.push(lineToHtml(line, st, palette));
 *
 * Used by MobileTermView: lines render once into DOM and scrolling is a pure
 * GPU transform, so this parser is OFF the scroll hot path by design.
 */
export type SgrState = {
    fg: string | null;
    bg: string | null;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: boolean;
    inverse: boolean;
    strike: boolean;
};
export type AnsiPalette = {
    /** indexes 0-15; 16-255 computed */
    base: string[];
    defaultFg: string;
    defaultBg: string;
};
export declare function createSgrState(): SgrState;
export declare function cloneSgrState(s: SgrState): SgrState;
export declare function sgrStateKey(s: SgrState): string;
/**
 * Render one line to HTML, mutating `st` to the state AFTER the line.
 * Default-state runs are emitted bare (no span) to keep the DOM light.
 */
export type LineLinkRange = {
    start: number;
    end: number;
    href: string;
};
export declare function lineToHtml(line: string, st: SgrState, palette: AnsiPalette, links?: LineLinkRange[]): string;
