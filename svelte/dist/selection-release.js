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
export const TERMINAL_VIEWPORT_SELECTOR = '[data-testid="mtv"]';
/**
 * TermView's own in-pane search overlay lives *inside* the viewport element
 * but is excluded from its `selectionActive` flag, so a selection there
 * freezes nothing and is not this module's to clear.
 */
export const TERMINAL_SEARCH_SELECTOR = '.mtv-search';
/**
 * Controls that exist to scroll the pane, and therefore count as a scroll
 * intent when tapped. Both call `SessionView.scrollToTerminalBottom()` →
 * `TermView.scrollToBottom()`, which returns false under a live selection — so
 * without the release they are simply dead.
 */
export const STOCK_SCROLL_CONTROL_SELECTORS = [
    '[data-testid="demo-scroll-bottom"]',
    '[data-testid="demo-new-content"]',
];
/** Fields own their own selection semantics; a selection there never freezes a pane. */
const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]';
/**
 * Slack around the highlight that still counts as "on the selection". iOS
 * draws its drag handles beyond the range rects, and a finger is not a pixel.
 */
export const SELECTION_HANDLE_MARGIN_PX = 24;
function resolveOptions(options) {
    const extra = options.scrollControlSelectors ?? [];
    const merged = [...STOCK_SCROLL_CONTROL_SELECTORS, ...extra]
        .map((selector) => selector.trim())
        .filter((selector) => selector.length > 0);
    const margin = options.handleMarginPx;
    return {
        scrollControls: [...new Set(merged)].join(', '),
        handleMarginPx: typeof margin === 'number' && Number.isFinite(margin) && margin >= 0
            ? margin
            : SELECTION_HANDLE_MARGIN_PX,
    };
}
function elementOf(node) {
    if (!node)
        return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}
function endpointsOf(selection) {
    const anchor = elementOf(selection.anchorNode);
    const focus = elementOf(selection.focusNode);
    return [anchor, focus].filter((el) => el !== null);
}
/**
 * A selection this module is allowed to release: non-empty, anchored inside a
 * terminal viewport, and not inside a field or the terminal's search overlay.
 * Mirrors TermView's own anchor-or-focus test rather than requiring both, so it
 * matches whatever the engine considers blocking.
 */
export function releasableTerminalSelection() {
    const selection = typeof window === 'undefined' ? null : window.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return null;
    const endpoints = endpointsOf(selection);
    if (endpoints.length === 0)
        return null;
    if (endpoints.some((el) => el.closest(EDITABLE_SELECTOR) || el.closest(TERMINAL_SEARCH_SELECTOR)))
        return null;
    if (!endpoints.some((el) => el.closest(TERMINAL_VIEWPORT_SELECTOR)))
        return null;
    return { selection, range: selection.getRangeAt(0) };
}
function release(selection) {
    try {
        selection.removeAllRanges();
    }
    catch {
        // A selection whose nodes were already detached can throw in WebKit; the
        // engine's own live re-read then reports it collapsed anyway.
    }
}
/**
 * Is the point within `marginPx` of any rect the range paints?
 *
 * No rects means the range is not painted anywhere comparable (collapsed to
 * zero area, or scrolled out of the rendered corridor). That reads as "not
 * under the finger" — the alternative is a permanently unscrollable pane.
 */
export function pointIsOnSelection(x, y, range, marginPx = SELECTION_HANDLE_MARGIN_PX) {
    for (const rect of range.getClientRects()) {
        if (x >= rect.left - marginPx && x <= rect.right + marginPx
            && y >= rect.top - marginPx && y <= rect.bottom + marginPx)
            return true;
    }
    return false;
}
/**
 * Is this touch asking to scroll the pane? Only two things are: a finger
 * landing in the pane itself, and a tap on a control whose action is a scroll.
 * Anything else is a tap on some other control, and taking the selection away
 * from it would break whatever that control was going to do with it.
 */
export function isScrollIntent(target, scrollControlSelector = STOCK_SCROLL_CONTROL_SELECTORS.join(', ')) {
    const element = elementOf(target);
    if (!element)
        return false;
    if (element.closest(TERMINAL_VIEWPORT_SELECTOR))
        return true;
    return scrollControlSelector.length > 0 && Boolean(element.closest(scrollControlSelector));
}
const installations = new Map();
/**
 * Install the release listeners on `document`, capture-phase and passive.
 *
 * @returns a disposer that removes them (once the last holder has disposed).
 */
export function installTerminalSelectionRelease(options = {}) {
    if (typeof document === 'undefined')
        return () => { };
    const resolved = resolveOptions(options);
    const key = `${resolved.handleMarginPx}|${resolved.scrollControls}`;
    const existing = installations.get(key);
    if (existing) {
        existing.count++;
        return disposerFor(key, existing);
    }
    /** A wheel is never a selection adjustment — the user is asking to scroll. */
    const onWheelCapture = () => {
        const active = releasableTerminalSelection();
        if (!active)
            return;
        release(active.selection);
    };
    const onTouchStartCapture = (event) => {
        // A second finger is a pinch/zoom, not a scroll — leave the selection alone.
        if (event.touches.length > 1)
            return;
        if (!isScrollIntent(event.target, resolved.scrollControls))
            return;
        const active = releasableTerminalSelection();
        if (!active)
            return;
        const touch = event.touches[0] ?? event.changedTouches[0];
        if (!touch)
            return;
        if (pointIsOnSelection(touch.clientX, touch.clientY, active.range, resolved.handleMarginPx)) {
            return;
        }
        release(active.selection);
    };
    const listenerOptions = { capture: true, passive: true };
    document.addEventListener('wheel', onWheelCapture, listenerOptions);
    document.addEventListener('touchstart', onTouchStartCapture, listenerOptions);
    const installation = {
        count: 1,
        remove: () => {
            document.removeEventListener('wheel', onWheelCapture, listenerOptions);
            document.removeEventListener('touchstart', onTouchStartCapture, listenerOptions);
        },
    };
    installations.set(key, installation);
    return disposerFor(key, installation);
}
function disposerFor(key, installation) {
    let disposed = false;
    return () => {
        if (disposed)
            return;
        disposed = true;
        installation.count--;
        if (installation.count > 0)
            return;
        installations.delete(key);
        installation.remove();
    };
}
