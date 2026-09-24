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
import {
  createCanvasModelRows,
  lineToCanvasCells,
  selectedModelText,
} from "../../svelte/src/canvas-terminal/model";

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

describe("Canvas terminal canonical cell model", () => {
  test("attaches every zero-width Thai mark to its base cell", () => {
    const cells = lineToCanvasCells("กิ กุ กี้ กุ้ กุ์ กิ้ น้ำ");
    const bases = cells.filter((cell) => !cell.continuation);
    expect(bases.map((cell) => cell.text).join("")).toBe("กิ กุ กี้ กุ้ กุ์ กิ้ น้ำ");
    expect(bases.some((cell) => cell.text.includes("ิ"))).toBe(true);
  });

  test("copy is model-backed and never emits a wide continuation blank", () => {
    const rows = createCanvasModelRows(["A漢B", "กิX"]);
    expect(rows[0]!.cells.some((cell) => cell.continuation)).toBe(true);
    expect(selectedModelText(rows, {
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 3 },
    })).toBe("A漢B\nกิX");
  });
});

import { stringCells } from '../src/cells';
import { canvasLinkHits, canvasHtmlLinkHits } from '../../svelte/src/canvas-terminal/links';
import { singleLineGlyph, glyphShapeKey, GLYPH_INVENTORY } from '../../svelte/src/canvas-terminal/glyphs';
import { paintCanvasRows } from '../../svelte/src/canvas-terminal/paint';

describe('Canvas FIX1 regressions', () => {
  test('grapheme advances sum code points, VS16 promotes, leading marks survive', () => {
    for (const [prefix, expected] of [['น้ำ', 2], ['कि', 2], ['👨‍👩‍👧‍👦', 8], ['❤️', 2], ['A️', 2], ['ิก', 1]] as const) {
      const text = `${prefix} https://example.com`;
      const cells = lineToCanvasCells(text);
      const bases = cells.filter(c => !c.continuation);
      expect(bases.map(c => c.text).join('')).toBe(text);
      expect(bases.find(c => c.text === 'h')!.col).toBe(expected + 1);
      expect(cells.length).toBe(stringCells(text));
      expect(bases.reduce((sum, c) => sum + c.width, 0)).toBe(stringCells(text));
      const linked = `\x1b]8;;https://real.example\x07${text}\x1b]8;;\x07`;
      expect(canvasLinkHits([linked], 200)[0]!.endCol).toBe(stringCells(text));
    }
    expect(lineToCanvasCells('ิก')[0]!.text).toBe('ิก');
    expect(lineToCanvasCells('ิ')[0]!.text).toBe('ิ');
  });

  test('OSC8 targets, decoys and scheme rules match lineToHtml; one hit per link', () => {
    const osc = (href: string, text: string, close = '\x07') => `\x1b]8;;${href}${close}${text}\x1b]8;;${close}`;
    for (const href of ['https://real.example/secret', 'HTTP://REAL.example/X', 'mailto:a@b.example']) {
      for (const label of ['กดที่นี่', 'https://decoy.example/x']) {
        const raw = osc(href, label);
        const hits = canvasLinkHits([raw], 200);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toEqual({ row: 0, startCol: 0, endCol: stringCells(label), href });
        expect(lineToHtml(raw, createSgrState(), pal)).toContain(`href="${href}"`);
      }
    }
    for (const href of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', ' https://x.example']) {
      expect(canvasLinkHits([osc(href, 'กดที่นี่')], 200)).toEqual([]);
    }
    expect(canvasLinkHits(['https://example.com/x'], 200)).toHaveLength(1);
    expect(canvasLinkHits([osc('https://x.example/?a=1&b=2', 'X', '\x1b\\')], 200)[0]!.href).toBe('https://x.example/?a=1&b=2');
    const rows = ['\x1b]8;;https://carry.example\x07one', '\x1b[31mtwo\x1b[0mthree\x1b]8;;\x07'];
    const state = createSgrState();
    const html = rows.map(row => lineToHtml(row, state, pal));
    expect(canvasHtmlLinkHits(html)).toEqual([
      { row: 0, startCol: 0, endCol: 3, href: 'https://carry.example' },
      { row: 1, startCol: 0, endCol: 8, href: 'https://carry.example' },
    ]);
    // A viewport can start inside an OSC8 carried from an earlier raw row.
    expect(canvasHtmlLinkHits(html.slice(1))[0]!.href).toBe('https://carry.example');
    expect(canvasLinkHits(['\x1b]8;;https://x.example\x07a\x1b]8;bad\x07b'], 200)[0]!.endCol).toBe(1);
  });

  test('real glyph geometry is distinct, with only documented Hershey I/l sharing', () => {
    for (const [start, length, allowed] of [[32, 95, ['Il']], [0x2500, 128, []]] as const) {
      const groups = new Map<string, string>();
      for (let cp = start; cp < start + length; cp++) {
        const char = String.fromCodePoint(cp);
        const glyph = singleLineGlyph(char)!;
        expect(glyph).not.toBeNull();
        if (char !== ' ') expect(glyph.strokes.length).toBeGreaterThan(0);
        for (const stroke of glyph.strokes) {
          expect(stroke.length).toBeGreaterThanOrEqual(2);
          for (const [x, y] of stroke) {
            expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
            expect(x >= 0 && x <= 1 && y >= 0 && y <= 1).toBe(true);
          }
        }
        const key = glyphShapeKey(glyph);
        groups.set(key, (groups.get(key) ?? '') + char);
      }
      expect([...groups.values()].filter(group => group.length > 1)).toEqual([...allowed]);
      expect(start === 32 ? GLYPH_INVENTORY.ascii.uniqueShapes : GLYPH_INVENTORY.boxDrawing.uniqueShapes).toBe(groups.size);
    }
    const corner = singleLineGlyph('┌')!;
    expect(corner.strokes.flat().every(([x, y]) => x >= .5 && y >= .5)).toBe(true);
    expect(corner.strokes.flat()).toContainEqual([1, .5]);
    expect(corner.strokes.flat()).toContainEqual([.5, 1]);
    expect(singleLineGlyph('┄')!.strokes).toHaveLength(3);
    expect(singleLineGlyph('━')!.weights!.every(w => w === 2)).toBe(true);
    expect(new Set(['A', '0', '!'].map(c => glyphShapeKey(singleLineGlyph(c)!))).size).toBe(3);
    expect(singleLineGlyph('Aิ')).toBeNull();
    expect(singleLineGlyph('ก')).toBeNull();
    expect(singleLineGlyph('漢')).toBeNull();
  });

  test('painting uses compact row geometry and changed content at identical coordinates', () => {
    const calls: unknown[][] = [];
    const context = {
      canvas: { width: 400, height: 300 },
      setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      fillText: (...args: unknown[]) => calls.push(args),
    } as unknown as CanvasRenderingContext2D;
    const options = { fontFamily: 'monospace', fontSize: 13, lineHeight: 21, cellWidth: 8, strokeWidth: 1, vectorFont: false, dpr: 1, palette: pal,
      rowGeometry: [{ top: 0, height: 7 }, { top: 7, height: 21 }] };
    paintCanvasRows(context, createCanvasModelRows(['', 'A']), options);
    expect(calls.at(-1)).toEqual(['A', 0, 7 + 21 * .82]);
    paintCanvasRows(context, createCanvasModelRows(['', 'B']), options);
    expect(calls.at(-1)).toEqual(['B', 0, 7 + 21 * .82]);
    expect(context.font).toBe('13px monospace');
  });
});
