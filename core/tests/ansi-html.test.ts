import { describe, expect, test } from "bun:test";
import {
  createSgrState,
  lineToHtml,
  sgrStateKey,
  type AnsiPalette,
  type SgrState,
} from "../src/ansi-html";

const pal: AnsiPalette = {
  base: ["#000", "#f00", "#0f0", "#ff0", "#00f", "#f0f", "#0ff", "#fff",
         "#111", "#f11", "#1f1", "#ff1", "#11f", "#f1f", "#1ff", "#eee"],
  defaultFg: "#e6e6e6",
  defaultBg: "#101014",
};

/** v0.3.5 public shape — must remain a valid SgrState object literal. */
function legacySgrState(overrides: Partial<SgrState> = {}): SgrState {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
    ...overrides,
  };
}

describe("ansi-html", () => {
  test("legacy 8-field SgrState object literal still typechecks and renders identically", () => {
    // Exactly the v0.3.5 public fields — no underlineStyle / underlineColor / osc8Href.
    // If those three are required again, this assignment fails to typecheck on upgrade.
    const legacy: SgrState = {
      fg: null,
      bg: null,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
    };

    expect(lineToHtml("hello", legacy, pal)).toBe(
      lineToHtml("hello", createSgrState(), pal),
    );
    expect(lineToHtml("hello", legacy, pal)).toBe("hello");

    expect(lineToHtml("\x1b[31mred\x1b[0m plain", legacySgrState(), pal)).toBe(
      lineToHtml("\x1b[31mred\x1b[0m plain", createSgrState(), pal),
    );
    // Attribute-only: underline true without modern fields → single underline decoration.
    expect(lineToHtml("under", legacySgrState({ underline: true }), pal)).toBe(
      '<span style="color:#e6e6e6;text-decoration:underline">under</span>',
    );

    expect(sgrStateKey(legacy)).toBe(sgrStateKey(createSgrState()));
    // createSgrState still materialises the full runtime shape for fresh states.
    const fresh = createSgrState();
    expect("underlineStyle" in fresh).toBe(true);
    expect("underlineColor" in fresh).toBe(true);
    expect("osc8Href" in fresh).toBe(true);
    expect(fresh.underlineStyle).toBeNull();
    expect(fresh.underlineColor).toBeNull();
    expect(fresh.osc8Href).toBeNull();
  });

  test("plain text is HTML-escaped and unwrapped", () => {
    const st = createSgrState();
    expect(lineToHtml("hello <world> & co", st, pal)).toBe("hello &lt;world&gt; &amp; co");
  });

  test("SGR colors map to the palette and reset closes the span", () => {
    const st = createSgrState();
    expect(lineToHtml("\x1b[31mred\x1b[0m plain", st, pal))
      .toBe('<span style="color:#f00">red</span> plain');
  });

  test("bold promotes to the bright palette entry", () => {
    const st = createSgrState();
    expect(lineToHtml("\x1b[1;32mgo", st, pal)).toContain("color:#1f1");
    // an empty line renders as a single space (keeps the row box occupied)
    expect(lineToHtml("", st, pal)).toBe("\u00a0");
  });

  test("SGR state carries across lines until reset (the incremental contract)", () => {
    const st = createSgrState();
    lineToHtml("\x1b[1;32mbold green no reset", st, pal);
    expect(lineToHtml("still carried", st, pal))
      .toBe('<span style="color:#1f1;font-weight:700">still carried</span>');
    lineToHtml("\x1b[0m", st, pal);
    expect(lineToHtml("back to plain", st, pal)).toBe("back to plain");
  });

  test("link ranges become safe anchors", () => {
    const st = createSgrState();
    const html = lineToHtml("see https://x.dev ok", st, pal, [{ start: 4, end: 17, href: "https://x.dev" }]);
    expect(html).toContain('<a href="https://x.dev"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.startsWith("see ")).toBe(true);
    expect(html.endsWith(" ok")).toBe(true);
  });

  test("256-color and truecolor sequences render inline styles, never throw", () => {
    const st = createSgrState();
    expect(lineToHtml("\x1b[38;5;215mx\x1b[0m", st, pal)).toContain("<span");
    expect(lineToHtml("\x1b[38;2;10;20;30my\x1b[0m", st, pal)).toContain("<span");
    expect(lineToHtml("\x1b[999mgarbage\x1b[0m ok", st, pal)).toContain("ok");
  });

  test("palette values are sanitized before style injection (A1-02)", () => {
    // Host-supplied palette entry that breaks out of style="..." into markup.
    const maliciousPalette: AnsiPalette = {
      base: [
        'red"><img src=x onerror=alert(1)><span style="color:red',
        "#f00", "#0f0", "#ff0", "#00f", "#f0f", "#0ff", "#fff",
        "#111", "#f11", "#1f1", "#ff1", "#11f", "#f1f", "#1ff", "#eee",
      ],
      defaultFg: "#e6e6e6",
      defaultBg: "#101014",
    };
    const st = createSgrState();
    const html = lineToHtml("\x1b[30mX\x1b[0m", st, maliciousPalette);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('red">');
    // Unsafe palette index falls back to sanitized defaultFg.
    expect(html).toContain("color:#e6e6e6");
    expect(html).toContain(">X</span>");

    // Malicious defaultFg itself must not execute either (bold forces a span
    // that pulls color from defaultFg when no explicit fg is set).
    const badDefaults: AnsiPalette = {
      base: [...maliciousPalette.base],
      defaultFg: 'x" onmouseover="alert(1)',
      defaultBg: "#101014",
    };
    const html2 = lineToHtml("\x1b[1mbold", createSgrState(), badDefaults);
    expect(html2).not.toContain("onmouseover");
    expect(html2).toContain("color:#e6e6e6");
    expect(html2).toContain("font-weight:700");
  });
});
