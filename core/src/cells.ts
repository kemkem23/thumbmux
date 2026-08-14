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

const ZERO_WIDTH = /^[​-‍︀-️]$/;
const COMBINING = /\p{M}/u;

/** U+FE0F emoji-style variation selector — zero-width alone, promotes base. */
const VS16 = 0xfe0f;

/** [start, end] inclusive code-point ranges rendered double-width. Sorted. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],   // Hangul Jamo
  // --- BMP symbols/emoji with EAW=W (tmux-verified sample; ⚠ is NOT here) ---
  [0x231a, 0x231b],   // ⌚⌛
  [0x2329, 0x232a],   // 〈〉
  [0x23e9, 0x23ec],   // ⏩⏪⏫⏬
  [0x23f0, 0x23f0],   // ⏰
  [0x23f3, 0x23f3],   // ⏳
  [0x25fd, 0x25fe],   // ◽◾
  [0x2614, 0x2615],   // ☔☕
  [0x2648, 0x2653],   // ♈…♓
  [0x267f, 0x267f],   // ♿
  [0x2693, 0x2693],   // ⚓
  [0x26a1, 0x26a1],   // ⚡
  [0x26aa, 0x26ab],   // ⚪⚫
  [0x26bd, 0x26be],   // ⚽⚾
  [0x26c4, 0x26c5],   // ⛄⛅
  [0x26ce, 0x26ce],   // ⛎
  [0x26d4, 0x26d4],   // ⛔
  [0x26ea, 0x26ea],   // ⛪
  [0x26f2, 0x26f3],   // ⛲⛳
  [0x26f5, 0x26f5],   // ⛵
  [0x26fa, 0x26fa],   // ⛺
  [0x26fd, 0x26fd],   // ⛽
  [0x2705, 0x2705],   // ✅
  [0x270a, 0x270b],   // ✊✋
  [0x2728, 0x2728],   // ✨
  [0x274c, 0x274c],   // ❌
  [0x274e, 0x274e],   // ❎
  [0x2753, 0x2755],   // ❓❔❕
  [0x2757, 0x2757],   // ❗
  [0x2795, 0x2797],   // ➕➖➗
  [0x27b0, 0x27b0],   // ➰
  [0x27bf, 0x27bf],   // ➿
  [0x2b1b, 0x2b1c],   // ⬛⬜
  [0x2b50, 0x2b50],   // ⭐
  [0x2b55, 0x2b55],   // ⭕
  // --- classic CJK / fullwidth blocks ---
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

/**
 * Total terminal cells a string occupies, including FE0F promotion:
 * a 1-cell base followed by U+FE0F becomes 2 cells (tmux-measured).
 */
export function stringCells(text: string): number {
  let cells = 0;
  let prevWidth: 0 | 1 | 2 = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = charCellWidth(cp);
    if (w === 0 && cp === VS16 && prevWidth === 1) {
      // Promote the previous base from 1 → 2.
      cells += 1;
      prevWidth = 2;
      continue;
    }
    cells += w;
    if (w > 0) prevWidth = w;
  }
  return cells;
}

/**
 * The prefix of `text` occupying (up to) `cells` terminal cells — i.e. the
 * characters that sit LEFT of a cursor parked at cell column `cells`.
 * Trailing zero-width marks (including FE0F after a promoted base) are
 * absorbed into the prefix. Returns the consumed cell count too, so callers
 * can pad when the line is shorter than the cursor column.
 */
export function prefixForCells(text: string, cells: number): { prefix: string; cells: number } {
  if (cells <= 0) return { prefix: "", cells: 0 };
  let consumed = 0;
  let end = 0; // index in UTF-16 units
  let prevWidth: 0 | 1 | 2 = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = charCellWidth(cp);

    if (w === 0 && cp === VS16 && prevWidth === 1) {
      // Promoting needs one more cell. If it does not fit, stop *before* the VS.
      if (consumed + 1 > cells) break;
      consumed += 1;
      prevWidth = 2;
      end += ch.length;
      // absorb further zero-width
      for (const next of text.slice(end)) {
        if (charCellWidth(next.codePointAt(0)!) !== 0) break;
        end += next.length;
      }
      if (consumed === cells) break;
      continue;
    }

    if (w > 0 && consumed + w > cells) break;
    consumed += w;
    end += ch.length;
    if (w > 0) prevWidth = w;
    if (consumed === cells) {
      // absorb combining marks / VS that belong to the glyph we just consumed
      for (const next of text.slice(end)) {
        const ncp = next.codePointAt(0)!;
        const nw = charCellWidth(ncp);
        if (nw !== 0) break;
        // FE0F that would promote a 1-cell base needs an extra cell — stop.
        if (ncp === VS16 && prevWidth === 1) break;
        end += next.length;
      }
      break;
    }
  }
  return { prefix: text.slice(0, end), cells: consumed };
}


