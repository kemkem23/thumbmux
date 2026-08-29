/**
 * Strip the same CSI, OSC, charset, and two-byte ESC controls consumed by the
 * ANSI renderer. Keeping this parser framework-independent lets cursor,
 * search, copy, prompt scanning, and link geometry share one visible stream.
 */
export declare function stripTerminalControls(raw: string): string;
