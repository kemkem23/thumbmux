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

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
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

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
  const isLightBg = luminance(bg) > 0.55;
  const fg = isLightBg ? '#1f1812' : mix('#ffffff', bg, 0.08);
  const stage = mix(bg, '#000000', isLightBg ? 0.12 : 0.4);
  const hudSolid = isLightBg ? mix(bg, '#ffffff', 0.25) : mix(bg, '#000000', 0.55);
  const accentOk = Math.abs(luminance(base.agent) - luminance(bg)) > 0.25;
  const accent = accentOk ? base.agent : (isLightBg ? '#1A1A1A' : '#FFFFFF');
  const rgb = hexToRgb(hudSolid) ?? [20, 20, 20];
  return {
    ...base,
    agent: accent,
    tbg: bg,
    tstage: stage,
    tfg: fg,
    hud: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.94)`,
    hudFg: fg,
    hudLine: mix(bg, fg, 0.4),
    xterm: {
      background: bg, foreground: fg, cursor: fg, cursorAccent: bg,
      selectionBackground: stage, black: bg, white: fg, brightWhite: fg,
      ...(isLightBg ? DERIVED_LIGHT_ANSI : DERIVED_DARK_ANSI),
    },
  };
}

function paletteForSurface(surface: TerminalSurface): AnsiPalette {
  const colors = [...DEFAULT_ANSI_BASE];
  const theme = surface.xterm;

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
