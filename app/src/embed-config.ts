/**
 * EmbedView geometry from a URL query string.
 *
 * An embed is an `<iframe>` in someone else's page: the host that opens it
 * knows the device, and the page inside knows the viewport. Both answers have
 * to be reconcilable in one place, or every embedding host re-derives "how
 * many rows fit" and they drift.
 *
 * Two knobs, in this precedence:
 *
 *   `?font=`   an explicit size, honoured only inside EMBED_FONT_PX_MIN..MAX.
 *              Out of range or unparseable falls back to the device default —
 *              a phone reads at a larger size than a laptop, and an embed that
 *              silently rendered 13px on a phone was the original complaint.
 *   `?lines=`  an explicit row count, honoured whenever it is a positive
 *              integer. Absent, rows are fitted to the viewport height that is
 *              left after the embedding chrome.
 *
 * Deliberately NOT clamped the same way on both knobs: the font band exists
 * because a font outside it is unreadable or unusable in an iframe, while an
 * explicit `lines` is the caller stating a contract with its own layout — the
 * fit bounds apply to the *computed* fallback, not to a number someone asked
 * for. Changing either side of that asymmetry changes what existing embed URLs
 * render, so it is pinned here rather than left to each host.
 *
 * Framework-free: strings and numbers in, numbers out. No DOM read happens
 * here — the caller passes the viewport it measured, which is also what makes
 * this testable without a browser.
 */

/** Smallest `?font=` an embed will honour. Below this the pane is unreadable. */
export const EMBED_FONT_PX_MIN = 8;

/** Largest `?font=` an embed will honour. Above this an iframe fits nothing. */
export const EMBED_FONT_PX_MAX = 20;

/** Font size when nothing is asked for and the viewport is phone-width. */
export const EMBED_FONT_PX_MOBILE = 15;

/** Font size when nothing is asked for on a wider viewport. */
export const EMBED_FONT_PX_DESKTOP = 13;

/** Viewport width (inclusive) at or below which the mobile default applies. */
export const EMBED_MOBILE_MAX_WIDTH_PX = 768;

/** Height reserved for the embedding page's header and composer chrome. */
export const EMBED_CHROME_HEIGHT_PX = 160;

/** Floor for the height the rows are fitted into, however small the iframe is. */
export const EMBED_MIN_FIT_HEIGHT_PX = 220;

/** Row-box height as a multiple of the font size. */
export const EMBED_LINE_HEIGHT_RATIO = 1.4;

/** Fewest rows a fitted embed will ask for. */
export const EMBED_MIN_ROWS = 14;

/** Most rows a fitted embed will ask for. */
export const EMBED_MAX_ROWS = 60;

export type EmbedGeometryInput = {
  /** The query string, with or without a leading `?`. Also accepts a full URL. */
  search?: string | null;
  /** Viewport width in CSS pixels (`window.innerWidth`). */
  viewportWidth: number;
  /** Viewport height in CSS pixels (`window.innerHeight`). */
  viewportHeight: number;
};

export type EmbedGeometry = {
  /** Font size to hand EmbedView. */
  fontPx: number;
  /** Minimum row count to hand EmbedView. */
  minRows: number;
  /** True when `?font=` supplied the size rather than the device default. */
  fontFromQuery: boolean;
  /** True when `?lines=` supplied the row count rather than the viewport fit. */
  rowsFromQuery: boolean;
};

function readParams(search: string | null | undefined): URLSearchParams {
  if (!search) return new URLSearchParams();
  const trimmed = search.trim();
  if (trimmed.length === 0) return new URLSearchParams();
  // A caller with a whole href in hand should not have to slice it first.
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed;
  return new URLSearchParams(query);
}

/**
 * `parseInt`, not `Number`: the original contract accepts "15px" and "15abc"
 * as 15, and an embed URL written by hand is exactly where that shows up.
 * Returns null for anything with no leading integer.
 */
function parseLeadingInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/** Device default when `?font=` is absent or out of band. */
export function defaultEmbedFontPx(viewportWidth: number): number {
  return viewportWidth <= EMBED_MOBILE_MAX_WIDTH_PX
    ? EMBED_FONT_PX_MOBILE
    : EMBED_FONT_PX_DESKTOP;
}

/**
 * Rows that fit `viewportHeight` at `fontPx`, after the embedding chrome, held
 * inside EMBED_MIN_ROWS..EMBED_MAX_ROWS.
 */
export function fitEmbedRows(viewportHeight: number, fontPx: number): number {
  const available = Math.max(EMBED_MIN_FIT_HEIGHT_PX, viewportHeight - EMBED_CHROME_HEIGHT_PX);
  const rows = Math.floor(available / (fontPx * EMBED_LINE_HEIGHT_RATIO));
  return Math.max(EMBED_MIN_ROWS, Math.min(EMBED_MAX_ROWS, rows));
}

/** Resolve `?font=` / `?lines=` and the viewport into EmbedView's two props. */
export function resolveEmbedGeometry(input: EmbedGeometryInput): EmbedGeometry {
  const params = readParams(input.search);

  const requestedFont = parseLeadingInt(params.get('font'));
  const fontFromQuery =
    requestedFont !== null
    && requestedFont >= EMBED_FONT_PX_MIN
    && requestedFont <= EMBED_FONT_PX_MAX;
  const fontPx = fontFromQuery ? requestedFont! : defaultEmbedFontPx(input.viewportWidth);

  const requestedLines = parseLeadingInt(params.get('lines'));
  const rowsFromQuery = requestedLines !== null && requestedLines > 0;
  const minRows = rowsFromQuery ? requestedLines! : fitEmbedRows(input.viewportHeight, fontPx);

  return { fontPx, minRows, fontFromQuery, rowsFromQuery };
}
