import { stripTerminalControls } from './terminal-controls';

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

const DEFAULT_TARGET_COUNT = 5;
const DEFAULT_INITIAL_SCAN_LINES = 240;
const DEFAULT_MAX_SCAN_LINES = 1200;

const PROMPT_MARKERS = new Set(["❯", "›"]);

export function stripAnsi(text: string): string {
  return stripTerminalControls(text);
}

// Faint/dim (SGR 2) state after applying one \x1b[...m parameter run. Extended
// colours (38/48/58 → "5;N" or "2;R;G;B") are consumed as arguments so a 256-
// colour index such as 38;5;2 is never misread as SGR 2 (faint). Never throws.
function sgrFaint(params: string, faint: boolean): boolean {
  if (params === "") return false; // \x1b[m is a full reset
  const codes = params.split(";");
  let i = 0;
  while (i < codes.length) {
    const code = Number(codes[i]);
    if (code === 38 || code === 48 || code === 58) {
      const mode = Number(codes[i + 1]);
      if (mode === 5) { i += 3; continue; } // 38;5;N
      if (mode === 2) { i += 5; continue; } // 38;2;R;G;B
      i += 1; // malformed extended colour — skip only the selector
      continue;
    }
    if (code === 0 || code === 22) faint = false;
    else if (code === 2) faint = true;
    i += 1;
  }
  return faint;
}

// True when a prompt line's payload (the text after the ❯/› marker) is rendered
// faint. cc/codex draw the composer's empty-state placeholder, ghost/autocomplete
// suggestion, and hint text faint (SGR 2); real submitted prompts echo normal or
// bright. That is the robust, CLI-version-independent discriminator between "what
// the user actually sent" and "what the composer is merely offering". Pure, never
// throws, and a no-op (returns false) on ANSI-free input.
export function isFaintPayload(rawLine: string): boolean {
  let faint = false;
  let markerSeen = false;
  let i = 0;
  const n = rawLine.length;
  while (i < n) {
    const ch = rawLine[i];
    if (ch === "\x1b") {
      const csi = /^\x1b\[([0-9;]*)m/.exec(rawLine.slice(i));
      if (csi) {
        faint = sgrFaint(csi[1] ?? "", faint);
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rawLine.slice(i));
      if (osc) { i += osc[0].length; continue; }
      // Private-mode / non-SGR CSI (e.g. ESC[?25l hide cursor). Skipping only
      // ESC+[ leaves "?25l" as fake marker/payload text and defeats faint
      // detection — the exact autocomplete false-positive this function exists
      // to reject. Consume a full CSI when present (same class stripAnsi uses).
      const otherCsi = /^\x1b\[[0-9;:?<=>\-]*[@-~]/.exec(rawLine.slice(i));
      if (otherCsi) { i += otherCsi[0].length; continue; }
      i += 2; // unknown escape — skip ESC + the following byte
      continue;
    }
    const isWs = ch === " " || ch === "\u00a0" || ch === "\t";
    if (!markerSeen) {
      if (!isWs) markerSeen = true; // first visible char is the ❯/› marker
      i += 1;
      continue;
    }
    if (isWs) { i += 1; continue; } // skip the gap between marker and payload
    return faint; // first payload char decides
  }
  return false; // no payload (empty composer) — the length filter handles it
}

// Grok right-aligns a "1:43 PM"-style clock on echoed prompt lines \u2014 visual
// metadata, not prompt text. Require \u22652 spaces before it so a prompt that
// genuinely ends with a time ("remind me at 1:43 PM") survives.
function stripTrailingClock(text: string): string {
  return text.replace(/\s{2,}\d{1,2}:\d{2}\s*[AP]M\s*$/, "").trimEnd();
}

export function isCodexStatusLine(trimmed: string): boolean {
  return /\bcontext\s+\d+%\s+used\b/i.test(trimmed) &&
    /\b(gpt|codex|weekly|5h|daily)\b/i.test(trimmed);
}

export function isClaudeStatusLine(trimmed: string): boolean {
  // No trailing \b on the model names. Claude writes its version glued to the
  // name — `opus5·max|ctx:63%`, `opus4.8·max` — and \b between `s` and `5` does
  // not exist, so requiring one made this blind to the status line every current
  // Claude pane ends with. That blindness is load-bearing: the composer-draft
  // guard decides by asking whether the chrome is below a block, so a status line
  // it cannot see is a draft it cannot reject.
  return /\b(new task\?|\/clear to save|bypass permissions|opus|sonnet|haiku)/i.test(trimmed) &&
    /\b(tokens|permissions|effort|5h|week|ctx:)/i.test(trimmed);
}

export function isGrokStatusLine(trimmed: string): boolean {
  // Grok Build TUI v1.0.x (measured 2026-08-21 on grok 0.2.102 / Grok 4.6):
  // the composer is a bare ❯ at column 0, then a chrome line such as
  //   Grok 4.6 (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript
  //   Grok 4.6 (high) · always-approve · 209K / 500K (42%) · 23 queued · /queue · ctrl+o transcript
  // Token and queue fields change every few seconds, so this line must never be
  // admitted as a submitted prompt or glued onto a typed-but-unsent draft.
  // The June 2026 boxed footer (`╰──── Grok Build · always-approve ─╯`) starts
  // with box drawing and is already a prompt terminator; this matcher is for
  // the v1.0.x chrome that has no box and no ❯ of its own.
  const grokBrand = /^(?:Grok(?:[\s-]|$)|SuperGrok\b)/i.test(trimmed);
  const hasTranscript = /\bctrl\+o\s+transcript\b/i.test(trimmed);
  const hasApprove = /\balways-approve\b/i.test(trimmed);
  const hasQueue = /\b\/queue\b/.test(trimmed) || /\b\d+\s+queued\b/i.test(trimmed);
  const hasTokens = /\b\d+(?:\.\d+)?[kKmM]?\s*\/\s*\d+(?:\.\d+)?[kKmM]?\b/.test(trimmed);
  const chromeBits = [hasTranscript, hasApprove, hasQueue, hasTokens].filter(Boolean).length;
  if (grokBrand && chromeBits >= 1) return true;
  // A wrap can drop the "Grok 4.6" prefix onto the previous row. The remaining
  // chrome still carries two unique tokens that a submitted prompt body does not.
  return chromeBits >= 2;
}

/**
 * Built-in heuristics tuned for Claude Code, Codex, and Grok pane output.
 * Consumers scanning another agent (for example aider, cline, or a plain shell)
 * should pass their own complete matcher set instead of relying on these defaults.
 */
export const DEFAULT_PROMPT_MATCHERS: PromptMatcherSet = Object.freeze({
  promptPayload(line: string): string | null {
    const normalized = line.replace(/\u00a0/g, " ").trimStart();
    const marker = normalized[0];
    if (!marker || !PROMPT_MARKERS.has(marker)) return null;

    // CC/codex echo prompts sit at indent 0-2; grok echoes its sent prompts as
    // "     \u276f <text>            1:43 PM" at indent ~5. Composer lines inside the
    // grok box start with "\u2502" so they never reach this check.
    const leading = line.length - line.trimStart().length;
    if (leading > 6) return null;

    // Empty composer (`❯` with no payload) is not a submitted prompt. Returning
    // "" here used to start a block that then swallowed the next chrome line
    // (Grok 4.6 status) as a continuation, so recent-prompts filled with
    // `Grok 4.6 (high) · always-approve · 86K / 500K (17%)`.
    const payload = stripTrailingClock(normalized.slice(1).trim());
    return payload || null;
  },
  isFaintPayload,
  isStatusLine(trimmedLine: string): boolean {
    return isCodexStatusLine(trimmedLine) || isClaudeStatusLine(trimmedLine) || isGrokStatusLine(trimmedLine);
  },
  isPromptTerminator(line: string): boolean {
    const trimmed = line.replace(/\u00a0/g, " ").trim();
    if (!trimmed) return false;
    // ◆ (grok thought), ❙ (grok scroll bar), ┃ (grok stream bar), ⠀-⣿ (grok
    // braille spinner) join the cc/codex marker set so a grok response never
    // glues onto its echoed prompt block.
    if (/^[●•◦✻⎿■⚠╭╰│─◆❙┃⠀-⣿]/.test(trimmed)) return true;
    if (/^(?:Tip:|OpenAI Codex\b)/i.test(trimmed)) return true;
    if (/^(?:Turn completed in\s|Shift\+Tab:mode|Enter:send)/.test(trimmed)) return true;
    return false;
  },
});

function cleanPromptLine(line: string): string {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/^\s{0,2}/, "")
    .trimEnd();
}

function extractMarkdownSection(lines: string[], title: string): string | null {
  const heading = new RegExp(`^#{2,6}\\s+${title}\\s*$`, "i");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return null;

  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,6}\s+\S/.test(line.trim())) break;
    section.push(line);
  }

  const text = section.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizePromptBlock(lines: string[]): string {
  const cleanLines = lines
    .map(cleanPromptLine)
    .filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1));

  const userReport = extractMarkdownSection(cleanLines, "User report");
  const source = userReport ?? cleanLines.join(" ");
  // Honest capture limit: a tmux pane cannot tell a wrap-break from an
  // intentional newline, so continuation rows are joined with a space. The
  // returned string is otherwise the submitted payload — never a 500-unit
  // preview with a synthetic ellipsis that later looks resendable.
  return source.replace(/\s+/g, " ").trim();
}

function collectPrompts(lines: string[], start: number, matchers: PromptMatcherSet): string[] {
  const prompts: string[] = [];
  let i = start;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = stripAnsi(raw).trimEnd();
    const firstLine = matchers.promptPayload(line);
    if (firstLine === null) {
      i++;
      continue;
    }

    // The composer's placeholder / ghost / autocomplete text carries the same
    // ❯/› marker as a real echo but is rendered faint — never a submitted prompt.
    if (matchers.isFaintPayload(raw)) {
      i++;
      continue;
    }

    const block = [firstLine];
    i++;

    while (i < lines.length) {
      const continuationLine = stripAnsi(lines[i] ?? "").trimEnd();
      const trimmedContinuation = continuationLine.replace(/\u00a0/g, " ").trim();
      if (
        matchers.promptPayload(continuationLine) !== null ||
        matchers.isPromptTerminator(continuationLine) ||
        (trimmedContinuation !== "" && matchers.isStatusLine(trimmedContinuation))
      ) break;
      block.push(continuationLine);
      i++;
    }

    // The composer sits directly above the agent's status/model chrome; a real
    // submitted prompt always has response output between it and that line. So a
    // block terminated by the status line is the composer itself — its current
    // placeholder, or a stale empty-composer snapshot frozen in scrollback (which
    // can render plain, escaping the faint check above). Never a submitted prompt.
    // The walk stops at whatever terminated the block, and for a composer that is
    // the rule or box border drawn around it \u2014 a box-drawing character is itself a
    // response terminator. Reading `lines[i]` therefore asks the border whether it
    // is chrome, which it never is, and a draft the user typed but never sent is
    // admitted. Step past rows that are nothing but box drawing or blank to reach
    // the line that actually decides.
    //
    // Only a row made entirely of box drawing is skipped, so a response body that
    // begins with a bar (grok's \u2503/\u2502 stream rails) still terminates the block: those
    // rows carry text after the bar.
    let decisive = i;
    while (decisive < lines.length) {
      const row = stripAnsi(lines[decisive] ?? "").replace(/\u00a0/g, " ").trim();
      if (row !== "" && !/^[\u2500-\u257f\s]+$/.test(row)) break;
      decisive++;
    }
    const terminator = decisive < lines.length
      ? stripAnsi(lines[decisive] ?? "").replace(/\u00a0/g, " ").trim()
      : "";
    if (terminator && matchers.isStatusLine(terminator)) {
      continue;
    }

    const prompt = normalizePromptBlock(block);
    if (prompt && prompt.length >= 3 && !prompt.startsWith("/")) {
      prompts.push(prompt);
    }
  }

  return prompts;
}

export function extractRecentPrompts(
  lines: string[],
  options: ExtractRecentPromptsOptions = {},
): string[] {
  if (lines.length === 0) return [];

  const targetCount = options.targetCount ?? DEFAULT_TARGET_COUNT;
  // targetCount 0 (or negative) means "return none" — not "return everything".
  // Array#slice(-0) === slice(0) would otherwise hand back the full scan.
  if (targetCount <= 0) return [];

  const initialScanLines = Math.max(0, options.initialScanLines ?? DEFAULT_INITIAL_SCAN_LINES);
  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  const matchers = options.matchers ?? DEFAULT_PROMPT_MATCHERS;
  const boundedMaxScanLines = Math.min(lines.length, maxScanLines);
  let scanLines = Math.min(lines.length, initialScanLines, boundedMaxScanLines);
  let prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines), matchers);
  // Stop on unique count, not raw collect count: two echoes of the same prompt
  // must not freeze the progressive window short of an older distinct entry.
  let unique = dedupeKeepLatest(prompts);

  while (unique.length < targetCount && scanLines < boundedMaxScanLines) {
    // initialScanLines: 0 used to leave scanLines at 0 forever (0*2 === 0) and
    // hang the event loop. Always make forward progress when deepening.
    scanLines = Math.min(boundedMaxScanLines, scanLines <= 0 ? 1 : scanLines * 2);
    prompts = collectPrompts(lines, Math.max(0, lines.length - scanLines), matchers);
    unique = dedupeKeepLatest(prompts);
  }

  return unique.slice(-targetCount);
}

/** Pane content (one string, \n-joined) → last N submitted prompts. The
 * server-side entry point: the caller already bounded how much pane it read,
 * so there is no progressive deepening here. */
export function extractRecentPromptsFromPane(
  content: string,
  targetCount = 5,
  options: ExtractRecentPromptsFromPaneOptions = {},
): string[] {
  if (targetCount <= 0) return [];
  const lines = content.split("\n");
  if (lines.length === 0) return [];
  const matchers = options.matchers ?? DEFAULT_PROMPT_MATCHERS;
  return dedupeKeepLatest(collectPrompts(lines, 0, matchers)).slice(-targetCount);
}

function dedupeKeepLatest(prompts: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let j = prompts.length - 1; j >= 0; j--) {
    const p = prompts[j];
    if (p !== undefined && !seen.has(p)) {
      seen.add(p);
      deduped.unshift(p);
    }
  }
  return deduped;
}
