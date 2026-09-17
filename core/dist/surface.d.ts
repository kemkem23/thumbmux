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
export declare const DEFAULT_ANSI_COLORS: readonly string[];
/**
 * Expand / validate a CSS hex color. Accepts `#rgb`, `#rrggbb`, optional `#`,
 * and returns lowercased `#rrggbb`. Invalid input → null (caller falls back).
 */
export declare function normalizeHexColor(raw: string): string | null;
export declare function hexToRgb(hex: string): [number, number, number] | null;
export declare function rgbToHex(r: number, g: number, b: number): string;
export declare function mix(hexA: string, hexB: string, ratioB: number): string;
/**
 * Relative luminance (WCAG). Channel values are gamma-encoded sRGB and must be
 * linearized before the 0.2126/0.7152/0.0722 weights — applying the weights to
 * gamma-encoded channels under-estimates contrast on saturated mid-tones.
 */
export declare function luminance(hex: string): number;
export declare function contrastRatio(hexA: string, hexB: string): number;
export declare function deriveSurface(bg: string, base: TerminalSurface): TerminalSurface;
/**
 * Derive a complete, unbranded terminal surface from one background color.
 * Unlike deriveSurface(), this includes the 16-color palette consumed by
 * TermView, SessionGrid, and RecordingPlayer.
 */
export declare function defaultSurface(bg: string): TerminalSurfaceWithPalette;
