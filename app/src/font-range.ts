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
export function resolveFontBounds(min?: number, max?: number): FontBounds {
  let lo = typeof min === 'number' && Number.isFinite(min)
    ? Math.trunc(min)
    : DEFAULT_FONT_PX_MIN;
  let hi = typeof max === 'number' && Number.isFinite(max)
    ? Math.trunc(max)
    : DEFAULT_FONT_PX_MAX;
  if (lo < 1) lo = 1;
  if (hi < 1) hi = 1;
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
export function clampFontPx(value: number, bounds: FontBounds): number {
  const fallback = Number.isFinite(value) ? Math.round(value) : DEFAULT_FONT_PX;
  if (fallback < bounds.min) return bounds.min;
  if (fallback > bounds.max) return bounds.max;
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
export function stepFontPx(from: number, dir: 1 | -1): number {
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
export function clampFontPxExact(value: number, bounds: FontBounds): number {
  const fallback = Number.isFinite(value) ? value : DEFAULT_FONT_PX;
  if (fallback < bounds.min) return bounds.min;
  if (fallback > bounds.max) return bounds.max;
  return fallback;
}

/**
 * `auto` shrinks the font so a fixed-geometry pane's columns fit the box;
 * `manual` shows the user's size as-is and lets the line scroll sideways.
 */
export type FontFitMode = 'auto' | 'manual';

/**
 * Read a stored `fontFit` preference. Only the literal `'manual'` opts out —
 * a missing, mistyped, or foreign value is `auto`, the default for NEWARCH
 * panes.
 */
export function resolveFontFitMode(value: unknown): FontFitMode {
  return value === 'manual' ? 'manual' : 'auto';
}

/** Horizontal padding TermView puts around the line: 6px each side. */
export const FONT_FIT_GUTTER_PX = 12;

/** Granularity of the fit search, in CSS pixels. */
export const FONT_FIT_STEP_PX = 0.05;

/** Upper bound on cell measurements after the first guess. */
export const FONT_FIT_MAX_PROBES = 8;

/**
 * Cell-to-font ratio used **only** when the measure returns nothing usable
 * (canvas not ready, font not loaded). It is a stand-in until the caller
 * re-measures — never the answer on a real screen, because installed fonts
 * give different cells.
 */
export const FONT_FIT_FALLBACK_CELL_RATIO = 0.6;

export type FontFitInput = {
  /** Birth columns of the fixed-geometry pane. */
  columns: number;
  /** Width of the terminal box in CSS pixels, gutter included. */
  containerWidthPx: number;
  /** Padding subtracted from the box. Defaults to `FONT_FIT_GUTTER_PX`. */
  gutterPx?: number;
  /** The user's size — the result never exceeds it. */
  ceilingPx: number;
  /** Lower and upper limits (see `resolveFontBounds`). */
  bounds: FontBounds;
  /** Width of one cell at a given font size, as measured by the renderer. */
  measureCellPx: (fontPx: number) => number;
  /** Defaults to `auto`. */
  mode?: FontFitMode;
};

export type FontFitResult = {
  /** Size to render, at most two decimals. */
  fontPx: number;
  /** Whether `columns` cells fit the usable width at that size (no sideways scroll). */
  fits: boolean;
};

/** Floor to two decimals, tolerating float noise just under a hundredth. */
function floor2(value: number): number {
  return Math.floor(value * 100 + 1e-6) / 100;
}

/**
 * Font size that makes a fixed-geometry pane's columns fit its box.
 *
 * Pure: it returns a size and whether it fits — never a resize. tmux keeps the
 * geometry the pane was born with; only the browser's font changes.
 *
 * - `manual`, or no usable geometry/width yet (columns ≤ 0, box not laid out):
 *   the ceiling as-is. An unlaid box does not collapse the font to the floor.
 * - Wide box: the ceiling exactly — the desktop never grows past the user size.
 * - Narrow box: the largest size on the 0.05px grid whose `columns × cell`
 *   fits, starting from the proportional guess and probing at most
 *   `FONT_FIT_MAX_PROBES` times. Never below `bounds.min`; if the floor still
 *   overflows, `fits` is false and the caller scrolls sideways.
 */
export function fitFontPxToColumns(input: FontFitInput): FontFitResult {
  const { columns, containerWidthPx, bounds } = input;
  const gutter = typeof input.gutterPx === 'number' && Number.isFinite(input.gutterPx)
    ? input.gutterPx
    : FONT_FIT_GUTTER_PX;
  const ceiling = floor2(clampFontPxExact(input.ceilingPx, bounds));
  const usable = containerWidthPx - gutter;

  const cellAt = (px: number): number => {
    const measured = input.measureCellPx(px);
    return Number.isFinite(measured) && measured > 0
      ? measured
      : px * FONT_FIT_FALLBACK_CELL_RATIO;
  };
  // 1e-6 absorbs float noise such as 70 × 9 × 0.6 = 378.00000000000006.
  const fitsAt = (px: number): boolean => columns * cellAt(px) <= usable + 1e-6;

  if (!Number.isFinite(columns) || columns <= 0 || !Number.isFinite(usable) || usable <= 0) {
    return { fontPx: ceiling, fits: false };
  }
  if (input.mode === 'manual') {
    return { fontPx: ceiling, fits: fitsAt(ceiling) };
  }
  if (fitsAt(ceiling)) {
    return { fontPx: ceiling, fits: true };
  }

  const floor = bounds.min;
  const snap = (px: number): number => {
    const grid = Math.floor(px / FONT_FIT_STEP_PX + 1e-6) * FONT_FIT_STEP_PX;
    return Math.min(ceiling, Math.max(floor, floor2(grid)));
  };

  let candidate = snap(ceiling * usable / (columns * cellAt(ceiling)));
  let best: number | null = null;
  for (let probe = 0; probe < FONT_FIT_MAX_PROBES; probe++) {
    if (fitsAt(candidate)) {
      if (best === null || candidate > best) best = candidate;
      const up = snap(candidate + FONT_FIT_STEP_PX);
      // Converged: the next step overflows (it is known not to fit at the ceiling).
      if (up <= candidate || !fitsAt(up)) break;
      candidate = up;
    } else {
      if (candidate <= floor) break;
      candidate = snap(candidate - FONT_FIT_STEP_PX);
    }
  }

  if (best !== null) return { fontPx: best, fits: true };
  return { fontPx: floor, fits: fitsAt(floor) };
}
