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

const DEFAULT_ANSI_BASE = [
  '#101014', '#ff7a7a', '#7dffa0', '#ffef9e',
  '#c8b4ff', '#ff9ad5', '#9be9ff', '#e8e8e8',
  '#8a8a92', '#ff9d9d', '#a0ffbe', '#fff5bd',
  '#dcceff', '#ffbde4', '#c2f1ff', '#ffffff',
];

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

const DERIVED_DARK_ANSI = {
  red: '#ff7a7a', green: '#7dffa0', yellow: '#ffef9e', blue: '#c8b4ff',
  magenta: '#ff9ad5', cyan: '#9be9ff', brightBlack: '#b9b2aa',
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
