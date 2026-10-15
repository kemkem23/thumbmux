/**
 * SessionView terminal font range — stock bounds, clamp, and graduated step.
 *
 * Through 0.15.2 the A+/A− actions and prefs load used bare literals 11–18 with
 * no prop and no documentation. A host that widened its own control still saw
 * 13px on the phone surface because any stored value outside that band was
 * silently dropped. This module is the single place for the stock behaviour
 * and the pure helpers the shell uses to honour host-supplied bounds.
 */
/** Initial size when no preference has been stored. */
export const DEFAULT_FONT_PX = 13;
/** Inclusive lower bound when the host does not set `fontPxMin`. */
export const DEFAULT_FONT_PX_MIN = 4;
/** Inclusive upper bound when the host does not set `fontPxMax`. */
export const DEFAULT_FONT_PX_MAX = 40;
/**
 * Resolve host-supplied bounds into a usable pair.
 *
 * - Missing or non-finite → stock defaults (4–40).
 * - Truncated to integers; floored at 1 (below that TermView cannot measure a cell).
 * - If min > max after resolution, the two are swapped so clamp never inverts.
 */
export function resolveFontBounds(min, max) {
    let lo = typeof min === 'number' && Number.isFinite(min)
        ? Math.trunc(min)
        : DEFAULT_FONT_PX_MIN;
    let hi = typeof max === 'number' && Number.isFinite(max)
        ? Math.trunc(max)
        : DEFAULT_FONT_PX_MAX;
    if (lo < 1)
        lo = 1;
    if (hi < 1)
        hi = 1;
    if (lo > hi) {
        const swap = lo;
        lo = hi;
        hi = swap;
    }
    return { min: lo, max: hi };
}
/**
 * Clamp a numeric size into bounds. Non-finite input falls back to the stock
 * default (then still clamped, so a host whose max is below 13 is respected).
 */
export function clampFontPx(value, bounds) {
    const fallback = Number.isFinite(value) ? Math.round(value) : DEFAULT_FONT_PX;
    if (fallback < bounds.min)
        return bounds.min;
    if (fallback > bounds.max)
        return bounds.max;
    return fallback;
}
/**
 * Graduated step for A+/A−. Same ladder as kemcortex's terminal-font store:
 * 1px below 20, 2px through 32, 4px above. Stepping down reads the band the
 * value lands in, so the sequence going up is identical coming back down.
 *
 * Does **not** clamp — the caller (setFont) clamps after the step so the
 * bounds stay the single gate.
 */
export function stepFontPx(from, dir) {
    const size = dir === 1 ? from : from - 1;
    const inc = size >= 32 ? 4 : size >= 20 ? 2 : 1;
    return from + dir * inc;
}
/**
 * Clamp a **computed** size into bounds without rounding it to a whole pixel.
 *
 * `clampFontPx` rounds because it gates A+/A− and stored preferences, which
 * stay whole numbers. A size that the fit formula derived from a measured cell
 * must keep its fraction: on a 378px line, 76 columns fit at ~8.29px, and
 * rounding that to 8 leaves room for 78 (sweep table, NEWARCH fit-font plan
 * §2). Non-finite input falls back to the stock default, then clamps.
 */
export function clampFontPxExact(value, bounds) {
    const fallback = Number.isFinite(value) ? value : DEFAULT_FONT_PX;
    if (fallback < bounds.min)
        return bounds.min;
    if (fallback > bounds.max)
        return bounds.max;
    return fallback;
}
/**
 * Read a stored `fontFit` preference. Only the literal `'manual'` opts out —
 * a missing, mistyped, or foreign value is `auto`, the default for NEWARCH
 * panes.
 */
export function resolveFontFitMode(value) {
    return value === 'manual' ? 'manual' : 'auto';
}
// The fit formula itself lives with TermView in @thumbmux/svelte
// (`fitNewarchFontPx` in history-window.ts): the app package depends on svelte,
// so a copy here could only drift from the one the screen actually uses.
