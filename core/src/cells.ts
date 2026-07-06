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

const ZERO_WIDTH = /^[​-‍︀-️]$/;
const COMBINING = /\p{M}/u;

/** [start, end] inclusive code-point ranges rendered double-width. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2e80, 0x303e],   // CJK radicals … CJK punctuation
  [0x3041, 0x33ff],   // kana, CJK symbols
  [0x3400, 0x4dbf],   // CJK ext A
  [0x4e00, 0x9fff],   // CJK unified
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo ext A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compat
  [0xfe10, 0xfe19],   // vertical forms
  [0xfe30, 0xfe6f],   // CJK compat forms
  [0xff00, 0xff60],   // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], // mahjong … extended pictographs (emoji)
  [0x20000, 0x3fffd], // CJK ext B+
];

/** Cells one code point occupies in a terminal (0, 1 or 2). */
export function charCellWidth(cp: number): 0 | 1 | 2 {
  const ch = String.fromCodePoint(cp);
  if (ZERO_WIDTH.test(ch) || COMBINING.test(ch)) return 0;
  for (const [a, b] of WIDE_RANGES) {
    if (cp >= a && cp <= b) return 2;
    if (cp < a) break; // ranges are sorted
  }
  return 1;
}

/** Total terminal cells a string occupies. */
export function stringCells(text: string): number {
  let cells = 0;
  for (const ch of text) cells += charCellWidth(ch.codePointAt(0)!);
  return cells;
}

/**
 * The prefix of `text` occupying (up to) `cells` terminal cells — i.e. the
 * characters that sit LEFT of a cursor parked at cell column `cells`.
 * Trailing zero-width marks are absorbed into the prefix (they attach to the
 * glyph before the cursor). Returns the consumed cell count too, so callers
 * can pad when the line is shorter than the cursor column.
 */
export function prefixForCells(text: string, cells: number): { prefix: string; cells: number } {
  if (cells <= 0) return { prefix: "", cells: 0 };
  let consumed = 0;
  let end = 0; // index in UTF-16 units
  for (const ch of text) {
    const w = charCellWidth(ch.codePointAt(0)!);
    if (w > 0 && consumed + w > cells) break;
    consumed += w;
    end += ch.length;
    if (consumed === cells) {
      // absorb combining marks that belong to the glyph we just consumed
      for (const next of text.slice(end)) {
        if (charCellWidth(next.codePointAt(0)!) !== 0) break;
        end += next.length;
      }
      break;
    }
  }
  return { prefix: text.slice(0, end), cells: consumed };
}
