import { describe, expect, test } from "bun:test";
import { deriveSurface, luminance, mix, hexToRgb, type TerminalSurface } from "../src/surface";

const base: TerminalSurface = {
  agent: "#FFB36B", tbg: "#B05606", tstage: "#7e3d03", tfg: "#FFF4E8",
  hud: "x", hudFg: "x", hudLine: "x", badge: "#B05606", badgeFg: "#fff", xterm: {},
};

describe("surface math", () => {
  test("luminance orders black < mid < white", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance("#808080")).toBeGreaterThan(0.2);
    expect(luminance("#808080")).toBeLessThan(0.8);
  });

  test("hexToRgb rejects junk, mix interpolates", () => {
    expect(hexToRgb("nope")).toBeNull();
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
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
    expect(luminance(s.xterm.red!)).toBeGreaterThan(0.4);
  });

  test("accent falls back when it would blend into the background", () => {
    const clash = deriveSurface("#FFB36B", base); // bg ≈ accent
    expect(clash.agent).not.toBe(base.agent);
  });
});
