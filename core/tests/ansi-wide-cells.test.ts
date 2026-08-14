/**
 * Dual-width cell emission (CJK / fullwidth / emoji → .mtv-w2).
 *
 * The render path pins each charCellWidth===2 code point into a two-cell box
 * so host font advances (~1.6× for CJK) cannot drift the column grid. This
 * file is the unit-level red/green gate: ASCII output must stay byte-identical
 * to the pre-wide-cell renderer; every wide glyph must carry the class.
 */
import { describe, expect, test } from "bun:test";
import { createSgrState, lineToHtml, type AnsiPalette } from "../src/ansi-html";

const pal: AnsiPalette = {
  base: [
    "#000", "#f00", "#0f0", "#ff0", "#00f", "#f0f", "#0ff", "#fff",
    "#111", "#f11", "#1f1", "#ff1", "#11f", "#f1f", "#1ff", "#eee",
  ],
  defaultFg: "#e6e6e6",
  defaultBg: "#101014",
};

const w2 = (s: string) => `<span class="mtv-w2">${s}</span>`;

describe("dual-width cell spans (mtv-w2)", () => {
  test("ASCII-only lines are byte-identical to plain escape (no wrappers)", () => {
    const samples = [
      "hello",
      "hello <world> & co",
      "box ─ │ ╭ ╰ ├ ┤ ┬ ┴ ┼",
      "a".repeat(200),
      "\x1b[31mred\x1b[0m plain",
      "\x1b[1;32mbold green",
      "",
    ];
    for (const sample of samples) {
      const html = lineToHtml(sample, createSgrState(), pal);
      // No dual-width class on pure ASCII (empty line is nbsp).
      expect(html).not.toContain("mtv-w2");
      if (sample === "") {
        expect(html).toBe("\u00a0");
        continue;
      }
      if (!sample.includes("\x1b")) {
        // Plain path: exact escape of the source, nothing else.
        const escaped = sample
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        expect(html).toBe(escaped);
      }
    }
  });

  test("CJK and Hangul each occupy one mtv-w2 span", () => {
    expect(lineToHtml("漢", createSgrState(), pal)).toBe(w2("漢"));
    expect(lineToHtml("a漢b", createSgrState(), pal)).toBe(`a${w2("漢")}b`);
    expect(lineToHtml("日本語", createSgrState(), pal)).toBe(
      `${w2("日")}${w2("本")}${w2("語")}`,
    );
    expect(lineToHtml("한글", createSgrState(), pal)).toBe(
      `${w2("한")}${w2("글")}`,
    );
  });

  test("fullwidth forms and emoji are dual-width", () => {
    expect(lineToHtml("Ａ", createSgrState(), pal)).toBe(w2("Ａ")); // U+FF21
    expect(lineToHtml("a🔥b", createSgrState(), pal)).toBe(`a${w2("🔥")}b`);
  });

  test("BMP EAW=W dingbats pin as dual-width; ⚠ stays bare", () => {
    expect(lineToHtml("✅", createSgrState(), pal)).toBe(w2("✅"));
    expect(lineToHtml("❌", createSgrState(), pal)).toBe(w2("❌"));
    expect(lineToHtml("⭐", createSgrState(), pal)).toBe(w2("⭐"));
    expect(lineToHtml("❗", createSgrState(), pal)).toBe(w2("❗"));
    expect(lineToHtml("⌚", createSgrState(), pal)).toBe(w2("⌚"));
    // ⚠ is EAW=N / tmux=1 — no wrapper
    expect(lineToHtml("⚠", createSgrState(), pal)).toBe("⚠");
    expect(lineToHtml("⚠", createSgrState(), pal)).not.toContain("mtv-w2");
  });

  test("FE0F-promoted base is one dual-width unit", () => {
    // ❤ alone narrow; ❤️ (❤ + FE0F) is 2 cells in our tmux → one mtv-w2 span.
    expect(lineToHtml("❤", createSgrState(), pal)).toBe("❤");
    expect(lineToHtml("❤️", createSgrState(), pal)).toBe(w2("❤️"));
  });

  test("status table row: wide dingbats + narrow ⚠ + CJK", () => {
    const line = "│ ✅ ❌ ⭐ ⚠ 漢 │";
    const html = lineToHtml(line, createSgrState(), pal);
    expect(html).toBe(
      `│ ${w2("✅")} ${w2("❌")} ${w2("⭐")} ⚠ ${w2("漢")} │`,
    );
  });

  test("SGR color wraps around dual-width cells without breaking the class", () => {
    expect(lineToHtml("\x1b[31m漢x\x1b[0m", createSgrState(), pal)).toBe(
      `<span style="color:#f00">${w2("漢")}x</span>`,
    );
  });

  test("Thai remains single-width (no mtv-w2); combining marks stay bare", () => {
    // "สวัสดี" = bases + marks; cells.ts counts 4, none are wide.
    const html = lineToHtml("สวัสดี", createSgrState(), pal);
    expect(html).toBe("สวัสดี");
    expect(html).not.toContain("mtv-w2");
  });

  test("mixed box-drawing table row keeps ASCII bare and CJK dual-width", () => {
    // Simulates a table cell with CJK content between box borders.
    const line = "│ 漢字 pad │";
    const html = lineToHtml(line, createSgrState(), pal);
    expect(html).toBe(`│ ${w2("漢")}${w2("字")} pad │`);
  });
});
