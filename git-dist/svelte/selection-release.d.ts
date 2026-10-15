/**
 * Release a native text selection that has taken a terminal hostage.
 *
 * ## The defect
 *
 * `TermView` deliberately yields to a live DOM selection, because the
 * virtualiser recycles the very text nodes a selection is anchored to: moving
 * or repainting the window while the user holds a selection would tear it. So
 * while `selectionActive` is true, six paths stand down at once —
 * `applyScroll()` returns before the transform, `onWheel`/`onTouchStart`/
 * `onTouchMove` bail, `scrollToBottom()` returns false, and the content gate
 * stops committing new pane output. Six dead things is why a user reads it as
 * "the page froze" rather than "scrolling is disabled", and nothing on screen
 * says the selection is why.
 *
 * ## The release
 *
 * `TermView` never trusts its cached flag on entry: `onWheel`, `onTouchStart`
 * and `scrollToBottom()` each call `updateSelectionActive()`, which re-reads
 * `window.getSelection()` live. Its own handlers are bubble-phase (the
 * element's `onwheel`, and Svelte's delegated root listener for `touchstart`).
 * So a document-level CAPTURE listener runs first, and a selection collapsed
 * here is already gone when TermView re-reads it — inside the same event. The
 * gesture then scrolls normally, and `removeAllRanges()` fires
 * `selectionchange` natively, so the deferred content/prepend work re-arms on
 * its own.
 *
 * Net effect: you can no longer scroll while *keeping* a selection. You cannot
 * do that without this either — the terminal just stops responding instead of
 * telling you. This trades an invisible freeze for a visible "the highlight
 * went away when I scrolled", which is how a phone terminal behaves everywhere
 * else.
 *
 * This module is framework-free on purpose: it only touches `document`, so a
 * host can install it from a layout, a plain script, or a non-Svelte shell.
 *
 * ## Deliberate limits
 *
 * - **Scoped to terminal selections.** If the selection is not anchored inside
 *   a `[data-testid="mtv"]` viewport, it is never touched — a host's chat,
 *   editor and every other page keep their selections.
 * - **Touch only collapses away from the highlight.** iOS selection handles
 *   live at the ends of the range's client rects; collapsing under a finger
 *   that came to grab one would be worse than the bug. A touch inside the
 *   (inflated) rects is left alone, so handle-dragging still extends a
 *   selection.
 * - **Gestures only — never a click.** A mouse click is not handled on
 *   purpose. A floating control that wants to *consume* the selection (the
 *   stock selection-first copy action) works precisely because a host's global
 *   `user-select: none` makes mousedown on it preserve the selection;
 *   collapsing on pointerdown would silently turn "copy my selection" into
 *   "copy the whole screen". Known consequence: on desktop, clicking the
 *   scroll-to-bottom control with a live selection is still swallowed once —
 *   one wheel notch, or a click inside the terminal, releases it. On touch,
 *   tapping it is a `touchstart` and is covered.
 * - **Touch releases for scroll intents only.** On a phone there is no click
 *   without a `touchstart`, so the paragraph above does not protect the copy
 *   action there: reaching it costs two taps (the FAB, then the slot), and a
 *   blanket touch release collapsed the selection on the first one. The button
 *   then copied the whole screen — the exact defect this exists to fix,
 *   wearing the fix's own clothes. So a touch only releases when it is asking
 *   to scroll: inside the pane (a drag), or on a control whose entire job is
 *   to scroll. A tap on any other control — the FAB, its slots, the HUD, the
 *   composer — leaves the selection alone. A host that grows a third scroll
 *   control must name it in `scrollControlSelectors`, or that one control is
 *   inert under a selection until the next gesture in the pane. That is a
 *   visible, recoverable annoyance; the inverse default is a copy button that
 *   quietly returns the wrong text.
 *
 * `preventDefault()` is never called from here: `touchstart` is registered
 * passive, and the whole job is `removeAllRanges()`.
 */
/** The test id on the TermView viewport element. */
export declare const TERMINAL_VIEWPORT_SELECTOR = "[data-testid=\"mtv\"]";
/**
 * TermView's own in-pane search overlay lives *inside* the viewport element
 * but is excluded from its `selectionActive` flag, so a selection there
 * freezes nothing and is not this module's to clear.
 */
export declare const TERMINAL_SEARCH_SELECTOR = ".mtv-search";
/**
 * Controls that exist to scroll the pane, and therefore count as a scroll
 * intent when tapped. Both call `SessionView.scrollToTerminalBottom()` →
 * `TermView.scrollToBottom()`, which returns false under a live selection — so
 * without the release they are simply dead.
 */
export declare const STOCK_SCROLL_CONTROL_SELECTORS: readonly string[];
/**
 * Slack around the highlight that still counts as "on the selection". iOS
 * draws its drag handles beyond the range rects, and a finger is not a pixel.
 */
export declare const SELECTION_HANDLE_MARGIN_PX = 24;
export type SelectionReleaseOptions = {
    /**
     * Extra controls whose only job is to scroll the pane. Merged with
     * `STOCK_SCROLL_CONTROL_SELECTORS`; a host adds its own here rather than
     * replacing the stock pair, which stays correct for the shipped shell.
     */
    scrollControlSelectors?: readonly string[];
    /** Slack around the highlight, in CSS pixels. Default 24. */
    handleMarginPx?: number;
};
/**
 * A selection this module is allowed to release: non-empty, anchored inside a
 * terminal viewport, and not inside a field or the terminal's search overlay.
 * Mirrors TermView's own anchor-or-focus test rather than requiring both, so it
 * matches whatever the engine considers blocking.
 */
export declare function releasableTerminalSelection(): {
    selection: Selection;
    range: Range;
} | null;
/**
 * Is the point within `marginPx` of any rect the range paints?
 *
 * No rects means the range is not painted anywhere comparable (collapsed to
 * zero area, or scrolled out of the rendered corridor). That reads as "not
 * under the finger" — the alternative is a permanently unscrollable pane.
 */
export declare function pointIsOnSelection(x: number, y: number, range: Range, marginPx?: number): boolean;
/**
 * Is this touch asking to scroll the pane? Only two things are: a finger
 * landing in the pane itself, and a tap on a control whose action is a scroll.
 * Anything else is a tap on some other control, and taking the selection away
 * from it would break whatever that control was going to do with it.
 */
export declare function isScrollIntent(target: EventTarget | null, scrollControlSelector?: string): boolean;
/**
 * Install the release listeners on `document`, capture-phase and passive.
 *
 * @returns a disposer that removes them (once the last holder has disposed).
 */
export declare function installTerminalSelectionRelease(options?: SelectionReleaseOptions): () => void;
