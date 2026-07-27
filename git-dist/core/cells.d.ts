/**
 * Terminal cell accounting for non-ASCII text — mirrors how tmux/wcwidth
 * count columns so cursor cells can be mapped back onto rendered text:
 *   - combining marks (Thai/Lao vowels & tone marks, diacritics), zero-width
 *     joiners and variation selectors occupy 0 cells
 *   - East Asian Wide/Fullwidth (CJK, Hangul, most emoji) occupy 2 cells
 *   - everything else occupies 1 cell
 * An approximation of the real wcwidth tables, but it covers what terminals
 * around here actually show; the consumer measures the resulting PREFIX
 * STRING with the live font, so pixel placement follows the DOM's own glyph
 * advances rather than any cell-width assumption.
 */
/** Cells one code point occupies in a terminal (0, 1 or 2). */
export declare function charCellWidth(cp: number): 0 | 1 | 2;
/** Total terminal cells a string occupies. */
export declare function stringCells(text: string): number;
/**
 * The prefix of `text` occupying (up to) `cells` terminal cells — i.e. the
 * characters that sit LEFT of a cursor parked at cell column `cells`.
 * Trailing zero-width marks are absorbed into the prefix (they attach to the
 * glyph before the cursor). Returns the consumed cell count too, so callers
 * can pad when the line is shorter than the cursor column.
 */
export declare function prefixForCells(text: string, cells: number): {
    prefix: string;
    cells: number;
};
