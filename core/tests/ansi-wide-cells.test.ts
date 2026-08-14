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
const w1 = (s: string) => `<span class="mtv-w1">${s}</span>`;
const w1fit = (s: string) => `<span class="mtv-w1 mtv-fit">${s}</span>`;
const wx = (s: string, n: number) => `<span class="mtv-wx" style="--mtv-cells:${n}">${s}</span>`;

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
    // ⚠ is EAW=N / tmux=1 — not dual-width, but it is a one-cell non-ASCII pin.
    expect(lineToHtml("⚠", createSgrState(), pal)).toBe(w1fit("⚠"));
    expect(lineToHtml("⚠", createSgrState(), pal)).not.toContain("mtv-w2");
  });

  test("FE0F-promoted base is one dual-width unit", () => {
    // ❤ alone narrow (mtv-w1 + fit); ❤️ (❤ + FE0F) is 2 cells → mtv-w2.
    expect(lineToHtml("❤", createSgrState(), pal)).toBe(w1fit("❤"));
    expect(lineToHtml("❤️", createSgrState(), pal)).toBe(w2("❤️"));
  });

  test("status table row: wide dingbats + narrow ⚠ + CJK", () => {
    const line = "│ ✅ ❌ ⭐ ⚠ 漢 │";
    const html = lineToHtml(line, createSgrState(), pal);
    expect(html).toBe(
      `│ ${w2("✅")} ${w2("❌")} ${w2("⭐")} ${w1fit("⚠")} ${w2("漢")} │`,
    );
  });

  test("SGR color wraps around dual-width cells without breaking the class", () => {
    expect(lineToHtml("\x1b[31m漢x\x1b[0m", createSgrState(), pal)).toBe(
      `<span style="color:#f00">${w2("漢")}x</span>`,
    );
  });

  test("Thai remains single-width (no mtv-w2); combining marks stay with their base", () => {
    // "สวัสดี" = 4 one-cell clusters. Marks ride the preceding base in one
    // span so the shaper can attach them — splitting was what made TlwgMono
    // unusable. ASCII-only lines still have no wrapper (test above).
    const html = lineToHtml("สวัสดี", createSgrState(), pal);
    expect(html).toBe(`${w1("ส")}${w1("วั")}${w1("ส")}${w1("ดี")}`);
    expect(html).not.toContain("mtv-w2");
  });

  test("one-cell non-ASCII clusters pin as mtv-w1; ASCII and box-drawing stay bare", () => {
    expect(lineToHtml("ก", createSgrState(), pal)).toBe(w1("ก"));
    expect(lineToHtml("aกb", createSgrState(), pal)).toBe(`a${w1("ก")}b`);
    expect(lineToHtml("─│╭", createSgrState(), pal)).toBe("─│╭");
    expect(lineToHtml("⚠", createSgrState(), pal)).toBe(w1fit("⚠"));
    expect(lineToHtml("❤", createSgrState(), pal)).toBe(w1fit("❤"));
    expect(lineToHtml("Ελ", createSgrState(), pal)).toBe(`${w1("Ε")}${w1("λ")}`);
  });

  test("one-cell letters inherit size; one-cell symbols carry mtv-fit", () => {
    // Letters must not get the emoji scale-to-fit class — that clamp is
    // 0.552em on a 0.6em cell and was shrinking every Thai glyph to 55%.
    expect(lineToHtml("ก", createSgrState(), pal)).toBe(w1("ก"));
    expect(lineToHtml("ก", createSgrState(), pal)).not.toContain("mtv-fit");
    expect(lineToHtml("⚠", createSgrState(), pal)).toContain("mtv-fit");
    expect(lineToHtml("❤", createSgrState(), pal)).toContain("mtv-fit");
  });

  test("Devanagari keeps Mc with its base (shaped cluster, width = cells)", () => {
    // Intl.Segmenter: हि (2) | न्दी (3). The virama stays with the following
    // consonant so the conjunct shapes; a hand-rolled "base+marks" split
    // painted a visible virama.
    expect(lineToHtml("हिन्दी", createSgrState(), pal)).toBe(
      `${w2("हि")}${wx("न्दी", 3)}`,
    );
    expect(lineToHtml("क्ष", createSgrState(), pal)).toBe(w2("क्ष"));
  });

  test("mixed box-drawing table row keeps ASCII bare and CJK dual-width", () => {
    // Simulates a table cell with CJK content between box borders.
    const line = "│ 漢字 pad │";
    const html = lineToHtml(line, createSgrState(), pal);
    expect(html).toBe(`│ ${w2("漢")}${w2("字")} pad │`);
  });
});
