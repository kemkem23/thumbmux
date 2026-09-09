/** Claude Code thinking-animation grammar and measured paint signature. */
export declare function isClaudeActivityStatusLine(line: string): boolean;
type TerminalPaintSnapshot = Readonly<{
    visible: string;
    foregrounds: readonly (number | null)[];
    endForeground: number | null;
    endInverse: boolean;
    endConcealed: boolean;
}>;
/** Visible UTF-16 stream plus the indexed foreground active on every unit. */
export declare function terminalPaintSnapshot(raw: string, initialForeground?: number | null, initialInverse?: boolean, initialConcealed?: boolean): TerminalPaintSnapshot | null;
/**
 * Require one measured Claude paint layout on semantic cells. Current Claude
 * uses marker/animated verb 174 plus activity metadata 246. Older captures use
 * a 246 marker followed by default-colour verb/metadata. tmux may split/reset
 * SGR spans at any cell boundary, so validation follows resulting foreground
 * state instead of matching one byte-for-byte escape layout.
 */
export declare function isStyledClaudeActivityStatusLine(raw: string, initialForeground?: number | null, initialInverse?: boolean, initialConcealed?: boolean): boolean;
export {};
