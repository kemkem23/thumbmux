/**
 * True only for a terminal row that paints no semantic cell and contains no
 * control other than complete SGR paint. Detector seals and projection
 * coalescing share this single conservative definition.
 */
export declare function isBlankToolSeparator(raw: string): boolean;
/**
 * Strip the same CSI, OSC, charset, and two-byte ESC controls consumed by the
 * ANSI renderer. Keeping this parser framework-independent lets cursor,
 * search, copy, prompt scanning, and link geometry share one visible stream.
 */
export declare function stripTerminalControls(raw: string): string;
