/**
 * Terminal cell accounting for non-ASCII text — mirrors how tmux/wcwidth
 * count columns so cursor cells can be mapped back onto rendered text:
 *   - combining marks (Thai/Lao vowels & tone marks, diacritics), zero-width
 *     joiners and variation selectors occupy 0 cells on their own
 *   - East Asian Wide/Fullwidth (CJK, Hangul, emoji, EAW=W dingbats) occupy 2
 *   - U+FE0F (emoji presentation VS) *promotes* a preceding 1-cell base to 2
 *     when counting a string (measured against live tmux on this host: ❤=1,
 *     ❤️=2, and even A+FE0F advances two columns)
 *   - everything else occupies 1 cell
 *
 * Wide ranges for the BMP emoji/symbol gap (0x231A…0x2B55) are the W/F
 * entries from Unicode EastAsianWidth.txt that sit outside the original CJK
 * blocks — ⚠ (U+26A0) is deliberately *not* included (EAW=N, tmux=1).
 */
/** Cells one code point occupies in a terminal (0, 1 or 2). */
export declare function charCellWidth(cp: number): 0 | 1 | 2;
/**
 * Total terminal cells a string occupies, including FE0F promotion:
 * a 1-cell base followed by U+FE0F becomes 2 cells (tmux-measured).
 */
export declare function stringCells(text: string): number;
/**
 * The prefix of `text` occupying (up to) `cells` terminal cells — i.e. the
 * characters that sit LEFT of a cursor parked at cell column `cells`.
 * Trailing zero-width marks (including FE0F after a promoted base) are
 * absorbed into the prefix. Returns the consumed cell count too, so callers
 * can pad when the line is shorter than the cursor column.
 */
export declare function prefixForCells(text: string, cells: number): {
    prefix: string;
    cells: number;
};
