/**
 * Surface derivation — turn ONE user-picked background color into a complete,
 * readable terminal surface (text, stage edge, HUD chrome, accent, ANSI
 * palette) via relative-luminance math. Framework-free; the host app supplies
 * its own branded base surfaces and persistence.
 */

import type { AnsiPalette } from './ansi-html';

export type TerminalSurface = {
  /** accent for borders/LED/buttons */
  agent: string;
  /** terminal/page surface */
  tbg: string;
  /** stage edge behind terminal */
  tstage: string;
  /** main text on surface */
  tfg: string;
  hud: string;
  hudFg: string;
  hudLine: string;
  /** solid color for card bar/badge (readable on both home themes) */
  badge: string;
  badgeFg: string;
  /** xterm theme override (merged over the viewer's defaults) */
  xterm: Record<string, string>;
};

/** A complete surface that can be passed straight to the Svelte viewers. */
export type TerminalSurfaceWithPalette = TerminalSurface & {
  palette: AnsiPalette;
};

const DEFAULT_BASE_SURFACE: TerminalSurface = {
  agent: '#7dffa0',
  tbg: '#101014',
  tstage: '#0a0a0d',
  tfg: '#e6e6e6',
  hud: 'rgba(16,16,20,.95)',
  hudFg: '#e6e6e6',
  hudLine: '#34343a',
  badge: '#1a1a1a',
  badgeFg: '#e6e6e6',
  xterm: {},
};

/**
 * The 16 basic ANSI slots, and the one decision a terminal viewer cannot avoid.
 *
 * A program does not send a colour for these — it sends a NUMBER, and slot 4 is
 * named `blue`. Whoever renders it chooses what blue looks like, which makes
 * this list a claim about what the program meant, not a matter of taste.
 *
 * It used to read `'#c8b4ff'` at slot 4: lavender. Slot 5, `magenta`, was pink.
 * A pane that asked for blue got purple, and nothing anywhere said so. That is
 * the same defect this package's own consumers were caught making one level up
 * — repainting output whose colours were already chosen — except here it was
 * the package doing it to them.
 *
 * So the hues now match the names. The values are the ones VS Code's integrated
 * terminal ships, chosen for a second reason beyond being correct: it is the
 * terminal most CLI authors are looking at while they pick their colours, which
 * makes it the closest available answer to "what did the author see".
 *
 * Slots 0, 7, 8 and 15 are overwritten from the surface in `paletteForSurface`
 * (background, foreground, dim, bright foreground) — the values here are the
 * fallbacks for a caller that supplies none.
 */
const ANSI_NORMAL = {
  red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd',
} as const;
const ANSI_BRIGHT = {
  red: '#f14c4c', green: '#23d18b', yellow: '#f5f543',
  blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db',
} as const;

const DEFAULT_ANSI_BASE = [
  '#101014', ANSI_NORMAL.red, ANSI_NORMAL.green, ANSI_NORMAL.yellow,
  ANSI_NORMAL.blue, ANSI_NORMAL.magenta, ANSI_NORMAL.cyan, '#e5e5e5',
  '#666666', ANSI_BRIGHT.red, ANSI_BRIGHT.green, ANSI_BRIGHT.yellow,
  ANSI_BRIGHT.blue, ANSI_BRIGHT.magenta, ANSI_BRIGHT.cyan, '#ffffff',
];

/**
 * The default palette as a plain 16-entry list, for hosts that assemble their
 * own `AnsiPalette` for a surface this module does not build (a thumbnail, an
 * embedded preview, a grid card). Exported because it was not: six separate
 * files in this package's own primary consumer had each hand-copied a
 * sixteen-colour array, they had drifted apart, and none of them matched what
 * the package rendered — which is what a private constant costs.
 *
 * Prefer `defaultSurface(bg).palette` when you have a background colour; it
 * fills slots 0/7/15 from that surface so the terminal's own background and
 * foreground stay consistent with the chrome around it.
 */
export const DEFAULT_ANSI_COLORS: readonly string[] = Object.freeze([...DEFAULT_ANSI_BASE]);

const ANSI_COLOR_NAMES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

/** Minimum WCAG-style contrast for main text vs background. */
const MIN_TEXT_CONTRAST = 4.5;
/** Minimum contrast for accent (borders/LED) vs background. */
const MIN_ACCENT_CONTRAST = 3;

/**
 * Expand / validate a CSS hex color. Accepts `#rgb`, `#rrggbb`, optional `#`,
 * and returns lowercased `#rrggbb`. Invalid input → null (caller falls back).
 */
export function normalizeHexColor(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m || !m[1]) return null;
  if (m[1].length === 3) {
    return `#${m[1].split('').map((d) => `${d}${d}`).join('')}`.toLowerCase();
  }
  return `#${m[1].toLowerCase()}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const n = parseInt(normalized.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(hexA: string, hexB: string, ratioB: number): string {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return hexA;
  return rgbToHex(
    a[0] + (b[0] - a[0]) * ratioB,
    a[1] + (b[1] - a[1]) * ratioB,
    a[2] + (b[2] - a[2]) * ratioB,
  );
}

/**
 * Relative luminance (WCAG). Channel values are gamma-encoded sRGB and must be
 * linearized before the 0.2126/0.7152/0.0722 weights — applying the weights to
 * gamma-encoded channels under-estimates contrast on saturated mid-tones.
 */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const linearize = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb.map(linearize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = luminance(hexA);
  const l2 = luminance(hexB);
  const high = Math.max(l1, l2);
  const low = Math.min(l1, l2);
  return (high + 0.05) / (low + 0.05);
}

function readableFallback(hexBg: string): string {
  return contrastRatio('#ffffff', hexBg) >= contrastRatio('#000000', hexBg)
    ? '#ffffff'
    : '#000000';
}

/** If `hex` fails min contrast against `bg`, swap to black or white. */
function enforceContrast(hex: string, bg: string, minContrast: number): string {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return readableFallback(bg);
  if (contrastRatio(normalized, bg) >= minContrast) return normalized;
  return readableFallback(bg);
}

/**
 * Built from the same two tiers, not hand-written beside them. It used to be a
 * second literal list, and the two disagreed in a way nothing could see: this
 * one wins for every surface `deriveSurface` produces — which includes
 * `defaultSurface` — so the values in `DEFAULT_ANSI_BASE` at slots 1-6 and 9-14
 * were never what the package actually rendered.
 *
 * It also named no `bright*` entries at all. `paletteForSurface` falls back to
 * the normal colour when a bright one is missing, so **every bright slot
 * collapsed onto its normal twin**: a pane asking for bright blue got blue, and
 * the distinction the program was drawing disappeared. The old test for this
 * asserted `base[9] === base[1]`, freezing the collapse in place as if intended.
 */
const DERIVED_DARK_ANSI = {
  ...ANSI_NORMAL,
  brightRed: ANSI_BRIGHT.red, brightGreen: ANSI_BRIGHT.green,
  brightYellow: ANSI_BRIGHT.yellow, brightBlue: ANSI_BRIGHT.blue,
  brightMagenta: ANSI_BRIGHT.magenta, brightCyan: ANSI_BRIGHT.cyan,
  brightBlack: '#8a8a92',
};
const DERIVED_LIGHT_ANSI = {
  red: '#b3261e', green: '#1d7a3e', yellow: '#8a6d00', blue: '#4a35b8',
  magenta: '#a81560', cyan: '#0c6580', brightBlack: '#6e675f',
  brightRed: '#b3261e', brightGreen: '#1d7a3e', brightYellow: '#8a6d00',
  brightBlue: '#4a35b8', brightMagenta: '#a81560', brightCyan: '#0c6580',
};

export function deriveSurface(bg: string, base: TerminalSurface): TerminalSurface {
  // Invalid / shorthand-invalid inputs fall back to the unbranded dark surface
  // rather than emitting CSS-illegal or unreadable (1:1) colors.
  const normalizedBg = normalizeHexColor(bg) ?? DEFAULT_BASE_SURFACE.tbg;
  const isLightBg = luminance(normalizedBg) > 0.55;
  const candidateFg = isLightBg ? '#1f1812' : mix('#ffffff', normalizedBg, 0.08);
  const fg = enforceContrast(candidateFg, normalizedBg, MIN_TEXT_CONTRAST);
  const stage = mix(normalizedBg, '#000000', isLightBg ? 0.12 : 0.4);
  const hudSolid = isLightBg ? mix(normalizedBg, '#ffffff', 0.25) : mix(normalizedBg, '#000000', 0.55);
  const agentCandidate = normalizeHexColor(base.agent) ?? DEFAULT_BASE_SURFACE.agent;
  const accent = enforceContrast(agentCandidate, normalizedBg, MIN_ACCENT_CONTRAST);
  const rgb = hexToRgb(hudSolid) ?? [20, 20, 20];
  return {
    ...base,
    agent: accent,
    tbg: normalizedBg,
    tstage: stage,
    tfg: fg,
    hud: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.94)`,
    hudFg: fg,
    hudLine: mix(normalizedBg, fg, 0.4),
    xterm: {
      background: normalizedBg, foreground: fg, cursor: fg, cursorAccent: normalizedBg,
      selectionBackground: stage, black: normalizedBg, white: fg, brightWhite: fg,
      ...(isLightBg ? DERIVED_LIGHT_ANSI : DERIVED_DARK_ANSI),
    },
  };
}

function paletteForSurface(surface: TerminalSurface): AnsiPalette {
  const colors = [...DEFAULT_ANSI_BASE];
  const theme = surface.xterm;

  // Do NOT contrast-gate palette ANSI entries against the background: index 0 is
  // the background itself (1:1 by design), and replacing yellow/red with black/
  // white would destroy the color meaning. Readability of SGR colors is a
  // separate concern; A1-01 gates main text + accent only.
  colors[0] = theme.black ?? surface.tbg;
  colors[7] = theme.white ?? surface.tfg;
  colors[8] = theme.brightBlack ?? colors[8]!;
  colors[15] = theme.brightWhite ?? surface.tfg;

  for (let index = 0; index < ANSI_COLOR_NAMES.length; index++) {
    const name = ANSI_COLOR_NAMES[index]!;
    const normal = theme[name] ?? colors[index + 1]!;
    const brightName = `bright${name[0]!.toUpperCase()}${name.slice(1)}`;
    colors[index + 1] = normal;
    colors[index + 9] = theme[brightName] ?? normal;
  }

  return {
    base: colors,
    defaultFg: surface.tfg,
    defaultBg: surface.tbg,
  };
}

/**
 * Derive a complete, unbranded terminal surface from one background color.
 * Unlike deriveSurface(), this includes the 16-color palette consumed by
 * TermView, SessionGrid, and RecordingPlayer.
 */
export function defaultSurface(bg: string): TerminalSurfaceWithPalette {
  const surface = deriveSurface(bg, DEFAULT_BASE_SURFACE);
  return { ...surface, palette: paletteForSurface(surface) };
}
