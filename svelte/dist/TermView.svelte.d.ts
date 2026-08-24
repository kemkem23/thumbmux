import { type AnsiPalette, type ClaudeBashMode, type ClaudeBashSummaries, type ClaudeBashSummaryRequest } from '@thumbmux/core';
type LinesChangeMeta = {
    source: 'live' | 'prepend' | 'replace';
};
type $$ComponentProps = {
    session: string;
    palette: AnsiPalette;
    fontPx?: number;
    minCols?: number;
    minRows?: number;
    maxRows?: number;
    /** Visual-only inset: the host shrank this many px (composer docked below).
     * Geometry math adds it back so the tmux pane is NEVER resized by a
     * transient overlay — only the scroll pin follows the shorter viewport. */
    bottomInsetPx?: number;
    claimGeometry?: boolean;
    /** Forward wheel, clean click, and touch-drag gestures as SGR mouse input
     * for alt-screen TUIs. Ignored for pointer routing when `screen` is set —
     * then `screen.mouseSgr` wins. */
    altScreenMouse?: boolean;
    /** Explicit host override of pane screen mode (tmux #{alternate_on} /
     * #{mouse_sgr_flag} / #{mouse_any_flag}). When the prop is omitted
     * (`undefined`), live `meta.screen` from the mux subscription is used.
     * An explicit `null` or object always wins over the wire. Structural
     * inline type so this file compiles alone. */
    screen?: {
        alt: boolean;
        mouseSgr: boolean;
        mouseAny: boolean;
    } | null;
    onKeys?: (data: string) => void;
    /** Fired on a CLEAN tap (short, low-movement, not a link, no selection) —
     * call your composer's openDock() here, synchronously, so iOS raises the
     * keyboard (gesture call stack). */
    onTap?: () => void;
    /** Opt-in: cancel the touchend that fired `onTap` so the synthesized
     * mousedown/click cannot blur the focused input (default false). */
    cancelSyntheticClickOnTap?: boolean;
    /** Bounded bidirectional archive paging is the default. `ceiling` keeps
     * the pre-0.17 backward-only retention path as an instant rollback. */
    historyPaging?: 'ceiling' | 'sliding';
    onLinesChange?: (lines: string[], meta: LinesChangeMeta) => void;
    onGeometryChange?: (geometry: {
        cols: number;
        rows: number;
    }) => void;
    onScrollStateChange?: (state: {
        bottomOffset: number;
        scrolledUp: boolean;
    }) => void;
    claudeBashMode?: ClaudeBashMode;
    claudeBashSummaries?: ClaudeBashSummaries;
    onClaudeBashSummaryRequest?: (requests: readonly ClaudeBashSummaryRequest[]) => ClaudeBashSummaries | void | Promise<ClaudeBashSummaries | void>;
};
declare const TermView: import("svelte").Component<$$ComponentProps, {
    copyAll: () => Promise<boolean>;
    copySelection: () => Promise<boolean>;
    isScrolledUp: () => boolean;
    scrollToBottom: () => boolean;
    refreshGeometry: () => void;
}, "">;
type TermView = ReturnType<typeof TermView>;
export default TermView;
