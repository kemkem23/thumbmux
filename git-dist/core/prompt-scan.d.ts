/**
 * Prompt scanning — pull the user's recently SUBMITTED prompts out of raw
 * pane text (with or without ANSI). Single source of truth: both the browser
 * UI and the server pipeline import from here (previously two hand-synced
 * copies: one in the web client, one in the server integration layer).
 *
 * Core problem: the agent composer draws its placeholder / ghost suggestion /
 * hint behind the same ❯/› marker a real echoed prompt uses. Two signals
 * separate them: (1) the composer renders non-submitted text FAINT (SGR 2)
 * while real prompts echo normal/bright; (2) the composer sits directly above
 * the status/model line, whereas a real prompt always has response output
 * between it and that line.
 */
export type ExtractRecentPromptsOptions = {
    targetCount?: number;
    initialScanLines?: number;
    maxScanLines?: number;
};
export declare function stripAnsi(text: string): string;
export declare function isFaintPayload(rawLine: string): boolean;
export declare function isCodexStatusLine(trimmed: string): boolean;
export declare function isClaudeStatusLine(trimmed: string): boolean;
export declare function extractRecentPrompts(lines: string[], options?: ExtractRecentPromptsOptions): string[];
/** Pane content (one string, \n-joined) → last N submitted prompts. The
 * server-side entry point: the caller already bounded how much pane it read,
 * so there is no progressive deepening here. */
export declare function extractRecentPromptsFromPane(content: string, targetCount?: number): string[];
