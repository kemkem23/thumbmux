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
import { DEFAULT_ANSI_COLORS } from "../src/surface";

const base: TerminalSurface = {
  agent: "#FFB36B", tbg: "#B05606", tstage: "#7e3d03", tfg: "#FFF4E8",
  hud: "x", hudFg: "x", hudLine: "x", badge: "#B05606", badgeFg: "#fff", xterm: {},
};

describe("surface math", () => {
  test("defaultSurface returns a ready-to-render 16-color palette", () => {
    const surface = defaultSurface("#101014");

    expect(surface.palette.defaultBg).toBe(surface.tbg);
    expect(surface.palette.defaultFg).toBe(surface.tfg);
    // Structure, not a colour list: the hue and readability rules below own the
    // values. Pinning them is what let the palette ship with blue rendered as
    // lavender for months — and this very assertion used to spell out
    // `base[9] === base[1]`, recording the bright/normal collapse as intent.
    expect(surface.palette.base).toHaveLength(16);
    expect(surface.palette.base[0]).toBe(surface.tbg);
    expect(surface.palette.base[7]).toBe(surface.tfg);
    expect(surface.palette.base[15]).toBe(surface.tfg);
    // A program asking for bright green means something different from one
    // asking for green, and the viewer has to keep the two apart.
    for (let slot = 1; slot <= 6; slot++) {
      expect(surface.palette.base[slot + 8]).not.toBe(surface.palette.base[slot]);
    }

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
    // This line used to assert `luminance(red) > 0.3`, a brightness proxy for a
    // readability question — and the wrong measure either way, since the module
    // states plainly that ANSI slots are NOT contrast-gated: standard red IS a
    // dark red, and forcing it past a text threshold would mean abandoning the
    // palette rather than rendering it. Readability of the default surface is
    // asserted at the UI threshold further down; what belongs HERE is the
    // second half of this test's own name, which nothing was checking: that a
    // derived surface supplies the bright tier at all. It did not — every
    // bright slot fell back to its normal twin.
    expect(s.xterm.brightRed).toBeDefined();
    expect(s.xterm.brightRed).not.toBe(s.xterm.red);
    expect(luminance(s.xterm.brightRed!)).toBeGreaterThan(luminance(s.xterm.red!));
    expect(contrastRatio(s.tfg, s.tbg)).toBeGreaterThanOrEqual(4.5);
  });

  test("accent falls back when it would blend into the background", () => {
    const clash = deriveSurface("#FFB36B", base); // bg ≈ accent
    expect(clash.agent).not.toBe(base.agent);
  });
});

/**
 * The 16 basic ANSI slots are the one place a viewer must decide what a
 * program meant. A program sends the NUMBER 4; the name of slot 4 is `blue`.
 *
 * These assert the RULE rather than the values, deliberately. A test that
 * pins the current hex codes goes green against any palette someone swaps in
 * later, including one that turns blue into lavender again — which is exactly
 * what shipped here for months, unremarked, because nothing checked the claim
 * the slot names were making.
 */
const SLOT = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 } as const;

/** Channels that must dominate for a colour to deserve the name, and by how
 * much. The margin is what separates blue from purple: `#c8b4ff` (the old
 * value) is 200 red against 255 blue — blue wins, but only just, and the eye
 * reads it as violet. */
const HUE_RULES: Record<keyof typeof SLOT, { over: Array<'r' | 'g' | 'b'>; under: Array<'r' | 'g' | 'b'> }> = {
  red: { over: ['r'], under: ['g', 'b'] },
  green: { over: ['g'], under: ['r', 'b'] },
  yellow: { over: ['r', 'g'], under: ['b'] },
  blue: { over: ['b'], under: ['r', 'g'] },
  magenta: { over: ['r', 'b'], under: ['g'] },
  cyan: { over: ['g', 'b'], under: ['r'] },
};
const DOMINANCE = 1.5;

function channels(hex: string): Record<'r' | 'g' | 'b', number> {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
}

describe("the default ANSI palette says what it means", () => {
  test("every named slot is actually that hue, normal and bright alike", () => {
    const palette = defaultSurface("#101014").palette;
    for (const [name, index] of Object.entries(SLOT) as Array<[keyof typeof SLOT, number]>) {
      const rule = HUE_RULES[name];
      for (const slot of [index, index + 8]) {
        const c = channels(palette.base[slot]!);
        const weakestNamed = Math.min(...rule.over.map((k) => c[k]));
        const strongestOther = Math.max(...rule.under.map((k) => c[k]));
        expect(
          weakestNamed,
          `slot ${slot} is called ${name} (${palette.base[slot]}) but ` +
            `${rule.under.join('/')}=${strongestOther} is not clearly below ${rule.over.join('/')}=${weakestNamed}`,
        ).toBeGreaterThanOrEqual(strongestOther * DOMINANCE);
      }
    }
  });

  test("every colour a pane can ask for is readable on the default background", () => {
    // The other half of the requirement, and it pulls the opposite way. The
    // 1980s xterm defaults are hue-perfect and unusable: `#0000ee` for blue is
    // 2.0 against a dark background. Faithful and invisible is not a rendering.
    const surface = defaultSurface("#101014");
    for (let slot = 1; slot <= 14; slot++) {
      if (slot === 7 || slot === 8) continue; // foreground / dim, set from the surface
      const colour = surface.palette.base[slot]!;
      expect(
        contrastRatio(colour, surface.tbg),
        `slot ${slot} (${colour}) is too dark to read on ${surface.tbg}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test("a host-picked background gets the same guarantee", () => {
    // deriveSurface has its own ANSI table, and it had the same lavender-blue.
    // A host that chooses its own background must not thereby lose hue fidelity.
    for (const bg of ["#0f1623", "#000000", "#1e1610", "#24272B"]) {
      const derived = deriveSurface(bg, base);
      const blue = channels(derived.xterm.blue!);
      expect(blue.b, `blue on ${bg} is ${derived.xterm.blue}`).toBeGreaterThanOrEqual(blue.r * DOMINANCE);
      const magenta = channels(derived.xterm.magenta!);
      expect(magenta.r, `magenta on ${bg}`).toBeGreaterThanOrEqual(magenta.g * DOMINANCE);
    }
  });

  test("DEFAULT_ANSI_COLORS is exported and matches what the package renders", () => {
    // It was private, so six files in the primary consumer hand-copied their
    // own and drifted. Exported, it has to keep agreeing with the real palette.
    const surface = defaultSurface("#101014");
    for (let slot = 1; slot <= 14; slot++) {
      if (slot === 7 || slot === 8) continue;
      expect(DEFAULT_ANSI_COLORS[slot]).toBe(surface.palette.base[slot]!);
    }
    expect(DEFAULT_ANSI_COLORS).toHaveLength(16);
  });
});
