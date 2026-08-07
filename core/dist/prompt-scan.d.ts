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
/** A complete set of agent-specific prompt scanning heuristics. */
export type PromptMatcherSet = Readonly<{
    /** Return the submitted prompt payload, or null when the line is not a prompt. */
    promptPayload: (line: string) => string | null;
    /** Inspect the original ANSI-bearing line and reject non-submitted prompt chrome. */
    isFaintPayload: (rawLine: string) => boolean;
    /** Match a normalized, trimmed status line that can sit below a composer. */
    isStatusLine: (trimmedLine: string) => boolean;
    /** Match an ANSI-free response line that ends a multi-line prompt block. */
    isPromptTerminator: (line: string) => boolean;
}>;
export type ExtractRecentPromptsOptions = {
    targetCount?: number;
    initialScanLines?: number;
    maxScanLines?: number;
    matchers?: PromptMatcherSet;
};
export type ExtractRecentPromptsFromPaneOptions = {
    matchers?: PromptMatcherSet;
};
export declare function stripAnsi(text: string): string;
export declare function isFaintPayload(rawLine: string): boolean;
export declare function isCodexStatusLine(trimmed: string): boolean;
export declare function isClaudeStatusLine(trimmed: string): boolean;
/**
 * Built-in heuristics tuned for Claude Code, Codex, and Grok pane output.
 * Consumers scanning another agent (for example aider, cline, or a plain shell)
 * should pass their own complete matcher set instead of relying on these defaults.
 */
export declare const DEFAULT_PROMPT_MATCHERS: PromptMatcherSet;
export declare function extractRecentPrompts(lines: string[], options?: ExtractRecentPromptsOptions): string[];
/** Pane content (one string, \n-joined) → last N submitted prompts. The
 * server-side entry point: the caller already bounded how much pane it read,
 * so there is no progressive deepening here. */
export declare function extractRecentPromptsFromPane(content: string, targetCount?: number, options?: ExtractRecentPromptsFromPaneOptions): string[];
