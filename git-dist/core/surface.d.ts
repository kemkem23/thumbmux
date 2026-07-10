/**
 * Surface derivation — turn ONE user-picked background color into a complete,
 * readable terminal surface (text, stage edge, HUD chrome, accent, ANSI
 * palette) via relative-luminance math. Framework-free; the host app supplies
 * its own branded base surfaces and persistence.
 */
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
export declare function hexToRgb(hex: string): [number, number, number] | null;
export declare function rgbToHex(r: number, g: number, b: number): string;
export declare function mix(hexA: string, hexB: string, ratioB: number): string;
export declare function luminance(hex: string): number;
export declare function deriveSurface(bg: string, base: TerminalSurface): TerminalSurface;
