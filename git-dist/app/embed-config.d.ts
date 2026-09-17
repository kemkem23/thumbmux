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
export declare const EMBED_FONT_PX_MIN = 8;
/** Largest `?font=` an embed will honour. Above this an iframe fits nothing. */
export declare const EMBED_FONT_PX_MAX = 20;
/** Font size when nothing is asked for and the viewport is phone-width. */
export declare const EMBED_FONT_PX_MOBILE = 15;
/** Font size when nothing is asked for on a wider viewport. */
export declare const EMBED_FONT_PX_DESKTOP = 13;
/** Viewport width (inclusive) at or below which the mobile default applies. */
export declare const EMBED_MOBILE_MAX_WIDTH_PX = 768;
/** Height reserved for the embedding page's header and composer chrome. */
export declare const EMBED_CHROME_HEIGHT_PX = 160;
/** Floor for the height the rows are fitted into, however small the iframe is. */
export declare const EMBED_MIN_FIT_HEIGHT_PX = 220;
/** Row-box height as a multiple of the font size. */
export declare const EMBED_LINE_HEIGHT_RATIO = 1.4;
/** Fewest rows a fitted embed will ask for. */
export declare const EMBED_MIN_ROWS = 14;
/** Most rows a fitted embed will ask for. */
export declare const EMBED_MAX_ROWS = 60;
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
/** Device default when `?font=` is absent or out of band. */
export declare function defaultEmbedFontPx(viewportWidth: number): number;
/**
 * Rows that fit `viewportHeight` at `fontPx`, after the embedding chrome, held
 * inside EMBED_MIN_ROWS..EMBED_MAX_ROWS.
 */
export declare function fitEmbedRows(viewportHeight: number, fontPx: number): number;
/** Resolve `?font=` / `?lines=` and the viewport into EmbedView's two props. */
export declare function resolveEmbedGeometry(input: EmbedGeometryInput): EmbedGeometry;
