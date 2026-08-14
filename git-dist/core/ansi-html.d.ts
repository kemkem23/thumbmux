/**
 * Minimal SGR (ANSI color) → HTML renderer for the mobile terminal engine.
 *
 * tmux `capture-pane -e` output is plain text lines with inline SGR codes —
 * no cursor movement — so a color-state machine over `ESC[...m` is enough.
 * SGR and OSC 8 state legally carry across lines, so callers thread state:
 *
 *   const st = createSgrState();
 *   for (const line of lines) html.push(lineToHtml(line, st, palette));
 *
 * Used by MobileTermView: lines render once into DOM and scrolling is a pure
 * GPU transform, so this parser is OFF the scroll hot path by design.
 *
 * Dual-width cells (CJK / fullwidth / emoji): `charCellWidth === 2` code
 * points are wrapped in `<span class="mtv-w2">`. TermView sizes that class to
 * exactly two measured ASCII cells so the rendered grid matches tmux columns
 * regardless of the host's `--font-mono` advance for those glyphs. ASCII-only
 * lines stay byte-identical to the pre-wide-cell renderer.
 */
export type UnderlineStyle = 'single' | 'double' | 'curly' | 'dotted' | 'dashed';
export type SgrState = {
    fg: string | null;
    bg: string | null;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    /** Retained for existing callers; it mirrors `underlineStyle !== null`. */
    underline: boolean;
    /**
     * Optional for back-compat with v0.3.5 object literals (8 fields only).
     * Missing values are treated as `null` at read sites — createSgrState still
     * always materialises all three modern fields.
     */
    underlineStyle?: UnderlineStyle | null;
    underlineColor?: string | null;
    inverse: boolean;
    strike: boolean;
    /** A validated active OSC 8 href, carried until an OSC 8 close. */
    osc8Href?: string | null;
};
export type AnsiPalette = {
    /** indexes 0-15; 16-255 computed */
    base: string[];
    defaultFg: string;
    defaultBg: string;
};
export type LineLinkRange = {
    start: number;
    end: number;
    href: string;
};
export type LineOverlayRange = {
    start: number;
    end: number;
    kind: 'search-match' | 'search-active';
};
export declare function createSgrState(): SgrState;
export declare function cloneSgrState(s: SgrState): SgrState;
export declare function sgrStateKey(s: SgrState): string;
/**
 * Render one line to HTML, mutating `st` to the state AFTER the line.
 * Default-state runs are emitted bare (no span) to keep the DOM light.
 */
export declare function lineToHtml(line: string, st: SgrState, palette: AnsiPalette, links?: LineLinkRange[], overlays?: LineOverlayRange[]): string;
