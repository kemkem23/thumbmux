import { type AnsiPalette } from '@thumbmux/core';
type $$ComponentProps = {
    session: string;
    palette: AnsiPalette;
    fontPx?: number;
    minCols?: number;
    minRows?: number;
    /** Visual-only inset: the host shrank this many px (composer docked below).
     * Geometry math adds it back so the tmux pane is NEVER resized by a
     * transient overlay — only the scroll pin follows the shorter viewport. */
    bottomInsetPx?: number;
    /** Fired on a CLEAN tap (short, low-movement, not a link, no selection) —
     * call your composer's openDock() here, synchronously, so iOS raises the
     * keyboard (gesture call stack). */
    onTap?: () => void;
    onLinesChange?: (lines: string[]) => void;
    onGeometryChange?: (geometry: {
        cols: number;
        rows: number;
    }) => void;
    onScrollStateChange?: (state: {
        bottomOffset: number;
        scrolledUp: boolean;
    }) => void;
};
declare const TermView: import("svelte").Component<$$ComponentProps, {
    copyAll: () => Promise<boolean>;
    copySelection: () => Promise<boolean>;
    isScrolledUp: () => boolean;
    scrollToBottom: () => void;
    refreshGeometry: () => void;
}, "">;
type TermView = ReturnType<typeof TermView>;
export default TermView;
