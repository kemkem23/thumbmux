import { describe, expect, test } from "bun:test";
import { charCellWidth, stringCells, prefixForCells } from "./cells";

describe("charCellWidth", () => {
  test("ASCII is 1 cell", () => {
    expect(charCellWidth("a".codePointAt(0)!)).toBe(1);
    expect(charCellWidth("$".codePointAt(0)!)).toBe(1);
  });
  test("Thai base consonants are 1 cell, vowel/tone marks are 0", () => {
    expect(charCellWidth("ส".codePointAt(0)!)).toBe(1);
    expect(charCellWidth("ั".codePointAt(0)!)).toBe(0); // MAI HAN-AKAT (above)
    expect(charCellWidth("ี".codePointAt(0)!)).toBe(0); // SARA II (above)
    expect(charCellWidth("ุ".codePointAt(0)!)).toBe(0); // SARA U (below)
    expect(charCellWidth("่".codePointAt(0)!)).toBe(0); // MAI EK (tone)
    expect(charCellWidth("า".codePointAt(0)!)).toBe(1); // SARA AA (spacing)
  });
  test("CJK and emoji are 2 cells", () => {
    expect(charCellWidth("你".codePointAt(0)!)).toBe(2);
    expect(charCellWidth("日".codePointAt(0)!)).toBe(2);
    expect(charCellWidth("한".codePointAt(0)!)).toBe(2);
    expect(charCellWidth(0x1f525)).toBe(2); // 🔥
  });
  /**
   * BMP dingbat/emoji that Unicode marks EAW=W — measured 2 in live tmux.
   * These used to fall through the gap between Hangul Jamo and CJK radicals
   * and return 1, which walked every box-table border that contained them.
   */
  test("EAW=W dingbats/emoji that predate U+1F000 are 2 cells", () => {
    expect(charCellWidth(0x2705)).toBe(2); // ✅
    expect(charCellWidth(0x274c)).toBe(2); // ❌
    expect(charCellWidth(0x2b50)).toBe(2); // ⭐
    expect(charCellWidth(0x2757)).toBe(2); // ❗
    expect(charCellWidth(0x231a)).toBe(2); // ⌚
    expect(charCellWidth(0x26a1)).toBe(2); // ⚡
    expect(charCellWidth(0x2728)).toBe(2); // ✨
  });
  /**
   * ⚠ looks as emoji-ish as ❌ but EAW=N and tmux advances one cell.
   * Widening it would break tables the other way — pin the narrow count.
   */
  test("⚠ stays 1 cell (EAW=N, tmux-measured)", () => {
    expect(charCellWidth(0x26a0)).toBe(1); // ⚠
    expect(charCellWidth(0x2713)).toBe(1); // ✓
    expect(charCellWidth(0x2714)).toBe(1); // ✔
    expect(charCellWidth(0x2764)).toBe(1); // ❤ alone (no FE0F)
  });
  test("zero-width joiners and variation selectors are 0", () => {
    expect(charCellWidth(0x200d)).toBe(0);
    expect(charCellWidth(0xfe0f)).toBe(0);
  });
});

describe("stringCells", () => {
  test("mixed Thai counts spacing chars only", () => {
    // ส(1) วั(1+0) ส(1) ดี(1+0) = 4 cells
    expect(stringCells("สวัสดี")).toBe(4);
  });
  test("CJK doubles", () => {
    expect(stringCells("a你b")).toBe(4);
  });
  test("FE0F promotes a narrow base to 2 cells (tmux: ❤=1, ❤️=2)", () => {
    expect(stringCells("❤")).toBe(1);
    expect(stringCells("❤️")).toBe(2); // U+2764 U+FE0F
    expect(stringCells("⚠")).toBe(1);
    expect(stringCells("⚠️")).toBe(2);
  });
  test("mixed status-row matches tmux column count", () => {
    // ✅❌⭐❗⌚ = 5×2, ⚠ = 1, 漢 = 2, 🙂 = 2 → 15
    expect(stringCells("✅❌⭐❗⌚⚠漢🙂")).toBe(5 * 2 + 1 + 2 + 2);
  });
});

describe("prefixForCells", () => {
  test("plain ASCII slices at the column", () => {
    expect(prefixForCells("hello", 3)).toEqual({ prefix: "hel", cells: 3 });
  });
  test("Thai combining marks are absorbed into the prefix", () => {
    // cursor at cell 2 sits after วั (the vowel rides the ว)
    expect(prefixForCells("สวัสดี", 2)).toEqual({ prefix: "สวั", cells: 2 });
    expect(prefixForCells("สวัสดี", 4)).toEqual({ prefix: "สวัสดี", cells: 4 });
  });
  test("a wide char never straddles the boundary", () => {
    // cursor at cell 2 of "a你b": 你 spans cells 1-2 → consumed
    expect(prefixForCells("a你b", 3)).toEqual({ prefix: "a你", cells: 3 });
    // cursor at cell 2 → the wide char fits exactly
    expect(prefixForCells("你b", 2)).toEqual({ prefix: "你", cells: 2 });
    // cursor at cell 1 → the wide char does NOT fit; prefix stops before it
    expect(prefixForCells("你b", 1)).toEqual({ prefix: "", cells: 0 });
  });
  test("surrogate-pair emoji stay whole", () => {
    expect(prefixForCells("🔥x", 2)).toEqual({ prefix: "🔥", cells: 2 });
  });
  test("line shorter than the column reports consumed cells for padding", () => {
    expect(prefixForCells("ab", 10)).toEqual({ prefix: "ab", cells: 2 });
  });
  test("zero or negative cells → empty", () => {
    expect(prefixForCells("abc", 0)).toEqual({ prefix: "", cells: 0 });
  });
});
