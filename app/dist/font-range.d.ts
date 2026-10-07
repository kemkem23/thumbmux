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
export declare const DEFAULT_FONT_PX = 13;
/** Inclusive lower bound when the host does not set `fontPxMin`. */
export declare const DEFAULT_FONT_PX_MIN = 4;
/** Inclusive upper bound when the host does not set `fontPxMax`. */
export declare const DEFAULT_FONT_PX_MAX = 40;
export type FontBounds = {
    /** Inclusive lower bound in CSS pixels. */
    min: number;
    /** Inclusive upper bound in CSS pixels. */
    max: number;
};
/**
 * Resolve host-supplied bounds into a usable pair.
 *
 * - Missing or non-finite → stock defaults (4–40).
 * - Truncated to integers; floored at 1 (below that TermView cannot measure a cell).
 * - If min > max after resolution, the two are swapped so clamp never inverts.
 */
export declare function resolveFontBounds(min?: number, max?: number): FontBounds;
/**
 * Clamp a numeric size into bounds. Non-finite input falls back to the stock
 * default (then still clamped, so a host whose max is below 13 is respected).
 */
export declare function clampFontPx(value: number, bounds: FontBounds): number;
/**
 * Graduated step for A+/A−. Same ladder as kemcortex's terminal-font store:
 * 1px below 20, 2px through 32, 4px above. Stepping down reads the band the
 * value lands in, so the sequence going up is identical coming back down.
 *
 * Does **not** clamp — the caller (setFont) clamps after the step so the
 * bounds stay the single gate.
 */
export declare function stepFontPx(from: number, dir: 1 | -1): number;
