import { describe, expect, test } from "bun:test";

import {
  cloneSgrState,
  createSgrState,
  lineToHtml,
  sgrStateKey,
  type AnsiPalette,
} from "../src/ansi-html";
import { stripAnsi } from "../src/prompt-scan";

const palette: AnsiPalette = {
  base: [
    "#000000", "#cc3333", "#33aa55", "#cccc33",
    "#3366cc", "#bb44bb", "#33bbbb", "#dddddd",
    "#555555", "#ff5555", "#55dd77", "#ffff55",
    "#5588ff", "#ff66ff", "#66ffff", "#ffffff",
  ],
  defaultFg: "#eeeeee",
  defaultBg: "#101010",
};
const boldStyle = ["font-weight", "700"].join(":");

function heavySgrLine(i: number): string {
  const fg = 16 + (i % 216);
  const r = (i * 17) % 256;
  const g = (i * 31) % 256;
  const b = (i * 47) % 256;
  const weight = i % 2 === 0 ? "1" : "22";
  const slant = i % 3 === 0 ? "3" : "23";
  return `\x1b[${weight};${slant};38;5;${fg};48;2;${r};${g};${b}mrow-${i}<tag>&value\x1b[0m`;
}

function renderLines(lines: string[], state = createSgrState()): string[] {
  return lines.map((line) => lineToHtml(line, state, palette));
}

describe("ANSI HTML renderer stress coverage", () => {
  test("renders a 10,000-line heavy SGR buffer incrementally byte-identical to a cold render", () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => heavySgrLine(idx));
    const cold = renderLines(lines).join("\n");
    const state = createSgrState();
    const incremental: string[] = [];

    for (let start = 0; start < lines.length; start += 137) {
      const appended = lines.slice(start, start + 137);
      for (const line of appended) incremental.push(lineToHtml(line, state, palette));
    }

    expect(incremental.join("\n")).toBe(cold);
  });

  test("rebuilding only appended lines from a saved state matches the cold suffix", () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => heavySgrLine(idx));
    const cold = renderLines(lines);
    const state = createSgrState();

    for (const line of lines.slice(0, 7_500)) lineToHtml(line, state, palette);
    const saved = cloneSgrState(state);
    const appended = lines.slice(7_500).map((line) => lineToHtml(line, saved, palette));

    expect(appended).toEqual(cold.slice(7_500));
  });

  test("handles a single line with 5,000 SGR transitions", () => {
    const parts: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      parts.push(`\x1b[${i % 2 === 0 ? "1" : "22"};38;5;${i % 256}m${i % 10}`);
    }
    parts.push("\x1b[0m");

    const html = lineToHtml(parts.join(""), createSgrState(), palette);

    expect(html).not.toContain("\x1b");
    expect(html.length).toBeGreaterThan(5_000);
    expect(html).toContain("9</span>");
  });

  test("removes complete unsupported CSI and OSC escape sequences without leaking ESC", () => {
    const html = lineToHtml("a\x1b[?25lb\x1b]2;title\x07c\x1b[?25hd", createSgrState(), palette);

    expect(html).toBe("abcd");
    expect(html).not.toContain("\x1b");
  });

  test("ignores unknown SGR parameters without throwing", () => {
    const html = lineToHtml("\x1b[999mplain <safe>\x1b[0m", createSgrState(), palette);

    expect(html).toBe("plain &lt;safe&gt;");
    expect(html).not.toContain("\x1b");
  });

  test("preserves cross-line color state across a 1,000-line chain", () => {
    const state = createSgrState();
    const rendered = [
      lineToHtml("\x1b[38;5;196mstart", state, palette),
      ...Array.from({ length: 998 }, (_, idx) => lineToHtml(`carry-${idx}`, state, palette)),
      lineToHtml("finish\x1b[0m", state, palette),
    ];

    expect(rendered[0]).toContain("color:#ff0000");
    expect(rendered[500]).toContain("color:#ff0000");
    expect(rendered[999]).toContain("finish");
    expect(sgrStateKey(state)).toBe(sgrStateKey(createSgrState()));
    expect(lineToHtml("plain", state, palette)).toBe("plain");
  });

  test("keeps bold and italic active across appended lines until reset", () => {
    const state = createSgrState();
    const first = lineToHtml("\x1b[1;3;38;5;45mstyled", state, palette);
    const second = lineToHtml("still styled", state, palette);
    const third = lineToHtml("\x1b[23mnot italic", state, palette);

    expect(first).toContain(boldStyle);
    expect(first).toContain("font-style:italic");
    expect(second).toContain(boldStyle);
    expect(second).toContain("font-style:italic");
    expect(third).toContain(boldStyle);
    expect(third).not.toContain("font-style:italic");
  });

  test("clips high truecolor values and keeps the output valid HTML text", () => {
    const html = lineToHtml("\x1b[38;2;300;0;17m<&>\x1b[0m", createSgrState(), palette);

    expect(html).toContain("color:#ff0011");
    expect(html).toContain("&lt;&amp;&gt;");
    expect(html).not.toContain("\x1b");
  });

  test("keeps renderer state through empty lines in a colored run", () => {
    const state = createSgrState();

    lineToHtml("\x1b[32mgreen", state, palette);
    expect(lineToHtml("", state, palette)).toBe("\u00a0");
    expect(lineToHtml("after empty", state, palette)).toContain("color:#33aa55");
  });

  test("renders inverse color across a long appended segment", () => {
    const state = createSgrState();
    const lines = ["\x1b[7;38;5;21mstart", ...Array.from({ length: 300 }, (_, idx) => `line-${idx}`)];
    const rendered = lines.map((line) => lineToHtml(line, state, palette));

    expect(rendered[0]).toContain("background-color");
    expect(rendered[300]).toContain("background-color");
  });

  test("resets heavy SGR buffers back to bare default output", () => {
    const state = createSgrState();
    for (let i = 0; i < 1_000; i++) lineToHtml(heavySgrLine(i), state, palette);

    expect(lineToHtml("plain tail", state, palette)).toBe("plain tail");
  });

  test("never emits raw ESC for complete malformed color selectors", () => {
    const html = lineToHtml("x\x1b[38;5my\x1b[48;2;1;2mz", createSgrState(), palette);

    expect(html).toContain("x");
    expect(html).toContain("y");
    expect(html).toContain("z");
    expect(html).not.toContain("\x1b");
  });

  test("strips truncated or signed malformed escape sequences without leaking raw ESC bytes", () => {
    const cases = [
      "before \x1b[31",                             // truncated at end of capture
      "mid \x1b[31truncated-with-text after",        // truncated mid-line (final byte consumed)
      "bad \x1b[38;2;300;-20;17m signed params",     // malformed signed SGR params
      "stray \x1b esc byte",                         // bare ESC
      "\x1b[38;2;300;-20;17m\x1b[31",                // both, adjacent
    ];
    for (const line of cases) {
      const st = createSgrState();
      const html = lineToHtml(line, st, palette);
      expect(html.includes("\x1b")).toBe(false);
      expect(stripAnsi(line).includes("\x1b")).toBe(false);
    }
    // sanity: legit content around the garbage survives
    const st = createSgrState();
    expect(lineToHtml("keep \x1b[38;2;300;-20;17m this", st, palette)).toContain("keep");
    expect(stripAnsi("keep \x1b[31")).toBe("keep ");
  });
});
