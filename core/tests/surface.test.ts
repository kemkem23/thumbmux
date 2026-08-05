import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  deriveSurface,
  luminance,
  mix,
  hexToRgb,
  normalizeHexColor,
  type TerminalSurface,
} from "../src/surface";
import { defaultSurface } from "../src/index";

const base: TerminalSurface = {
  agent: "#FFB36B", tbg: "#B05606", tstage: "#7e3d03", tfg: "#FFF4E8",
  hud: "x", hudFg: "x", hudLine: "x", badge: "#B05606", badgeFg: "#fff", xterm: {},
};

describe("surface math", () => {
  test("defaultSurface returns a ready-to-render 16-color palette", () => {
    const surface = defaultSurface("#101014");

    expect(surface.palette.defaultBg).toBe(surface.tbg);
    expect(surface.palette.defaultFg).toBe(surface.tfg);
    expect(surface.palette.base).toEqual([
      surface.tbg,
      "#ff7a7a",
      "#7dffa0",
      "#ffef9e",
      "#c8b4ff",
      "#ff9ad5",
      "#9be9ff",
      surface.tfg,
      "#b9b2aa",
      "#ff7a7a",
      "#7dffa0",
      "#ffef9e",
      "#c8b4ff",
      "#ff9ad5",
      "#9be9ff",
      surface.tfg,
    ]);

    const light = defaultSurface("#ffffff");
    expect(light.palette.defaultBg).toBe("#ffffff");
    expect(light.palette.defaultFg).toBe(light.tfg);
    expect(light.palette.base[1]).toBe("#b3261e");
    expect(light.palette.base[8]).toBe("#6e675f");

    const another = defaultSurface("#101014");
    expect(another.palette).not.toBe(surface.palette);
    expect(another.palette.base).not.toBe(surface.palette.base);
  });

  test("luminance orders black < mid < white", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    // WCAG mid-grey is ~0.216 (gamma-correct); the old linear formula gave ~0.5.
    expect(luminance("#808080")).toBeGreaterThan(0.2);
    expect(luminance("#808080")).toBeLessThan(0.8);
  });

  test("hexToRgb rejects junk, mix interpolates, shorthand expands", () => {
    expect(hexToRgb("nope")).toBeNull();
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("fff")).toEqual([255, 255, 255]);
    expect(normalizeHexColor("#fff")).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("defaultSurface normalizes shorthand and falls back on malformed themes", () => {
    const shorthand = defaultSurface("#fff");
    expect(shorthand.tbg).toBe("#ffffff");
    expect(shorthand.palette.defaultBg).toBe("#ffffff");
    expect(contrastRatio(shorthand.tfg, shorthand.tbg)).toBeGreaterThanOrEqual(4.5);

    const invalid = defaultSurface("totally-not-a-hex");
    expect(invalid.tbg).toBe("#101014");
    expect(invalid.palette.defaultBg).toBe("#101014");

    const hashless = defaultSurface("ffffff");
    expect(hashless.tbg).toBe("#ffffff");
  });

  test("derived surfaces stay readable on tricky accepted inputs", () => {
    // #00c400 previously emitted ~2:1 main text (A1-01).
    const green = defaultSurface("#00c400");
    expect(contrastRatio(green.tfg, green.tbg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(green.agent, green.tbg)).toBeGreaterThanOrEqual(3);
  });

  test("light background derives dark ink + light-ANSI variants", () => {
    const s = deriveSurface("#ffffff", base);
    expect(s.tbg).toBe("#ffffff");
    expect(luminance(s.tfg)).toBeLessThan(0.3);           // readable ink
    expect(luminance(s.xterm.red!)).toBeLessThan(0.45);   // dark ANSI on light bg
  });

  test("dark background derives light ink + bright-ANSI variants", () => {
    const s = deriveSurface("#0e0e10", base);
    expect(luminance(s.tfg)).toBeGreaterThan(0.6);
    // WCAG luminance of #ff7a7a is ~0.37 (was ~0.55 under the linear formula).
    expect(luminance(s.xterm.red!)).toBeGreaterThan(0.3);
    expect(contrastRatio(s.tfg, s.tbg)).toBeGreaterThanOrEqual(4.5);
  });

  test("accent falls back when it would blend into the background", () => {
    const clash = deriveSurface("#FFB36B", base); // bg ≈ accent
    expect(clash.agent).not.toBe(base.agent);
  });
});
