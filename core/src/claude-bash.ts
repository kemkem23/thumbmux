/**
 * Claude Code Bash presentation model.
 *
 * Claude paints tool calls as physical terminal rows. A completed top-level
 * Bash call has a coloured `●`/`⏺` marker, a bold `Bash(` label, and a
 * `  ⎿ ` command/result delimiter. While the command is active Claude paints
 * the marker cell as a styled grey blank instead. This module recognises only
 * those high-confidence shapes and deliberately leaves ambiguous text alone.
 *
 * Detection never joins or mutates source rows. Projection keeps the complete
 * raw input beside visual-row metadata so a stateful ANSI renderer can parse
 * every hidden row before selecting the rows it displays (SGR and OSC state may
 * legally carry across a collapsed block).
 */

import { stripAnsi } from './prompt-scan';
import { stringCells } from './cells';

export type ClaudeBashMode = 'off' | 'hide' | 'haiku';
export type ClaudeBashBlockStatus = 'completed' | 'active';
export type ClaudeBashScreenMode = 'normal' | 'alternate' | 'unknown';
export type ClaudeBashSummaryState = 'none' | 'suppressed' | 'pending' | 'resolved';

/** Half-open physical-line range in the unmodified source (`startLine..endLine`). */
export type ClaudeBashLineRange = Readonly<{
  startLine: number;
  endLine: number;
}>;

export type ClaudeBashBlock = Readonly<{
  /** Host-facing stable identifier; identical to `fingerprint`. */
  id: string;
  /** Number of physical source rows represented by this block. */
  lineCount: number;
  /** Direct aliases used by virtual-row consumers. */
  rawStart: number;
  rawEndExclusive: number;
  status: ClaudeBashBlockStatus;
  sourceRange: ClaudeBashLineRange;
  /** Header/continuation rows; ends immediately before the first result marker. */
  commandRange: ClaudeBashLineRange;
  /** Starts at the first `⎿` row. Empty for an active call with no result yet. */
  outputRange: ClaudeBashLineRange;
  /** ANSI-free, physical-row-preserving preview. */
  command: string;
  /** ANSI-free, physical-row-preserving preview. */
  output: string;
  commandTruncated: boolean;
  outputTruncated: boolean;
  /**
   * Stable across ANSI repaint. Completed IDs include output so two runs of
   * the same command with different results cannot share the wrong summary;
   * active IDs use the command only so streaming does not churn their row.
   */
  fingerprint: string;
}>;

/**
 * One uninterrupted run of top-level Bash calls. Claude commonly inserts
 * blank physical rows between calls in the same tool burst; those rows belong
 * to the presentation group, but any semantic row or retention discontinuity
 * ends it. An active final call keeps the whole group active until Claude
 * paints a conclusive non-Bash boundary.
 */
export type ClaudeBashGroup = Readonly<{
  /** Content identity of the ordered member blocks; identical to `fingerprint`. */
  id: string;
  fingerprint: string;
  /** Physical rows hidden by the single group placeholder, including blank gaps. */
  lineCount: number;
  rawStart: number;
  rawEndExclusive: number;
  status: ClaudeBashBlockStatus;
  sourceRange: ClaudeBashLineRange;
  blockCount: number;
  blocks: readonly ClaudeBashBlock[];
  /** Bounded, ordered previews merged for the host summarizer. */
  command: string;
  output: string;
  commandTruncated: boolean;
  outputTruncated: boolean;
}>;

export type ClaudeBashDetection = Readonly<{
  blocks: readonly ClaudeBashBlock[];
  scanRange: ClaudeBashLineRange;
  /** False means the detector intentionally failed open for this screen mode. */
  enabled: boolean;
}>;

export type ClaudeBashDetectionOptions = Readonly<{
  /** Alternate and unknown full-screen modes always fail open. Default: normal. */
  screenMode?: ClaudeBashScreenMode;
  /** Only this many newest physical rows are inspected. Default: 20,000. */
  maxScanLines?: number;
  /** A candidate longer than this stays raw. Default: 2,000. */
  maxBlockLines?: number;
  /** Retain at most this many newest detected blocks. Default: 512. */
  maxBlocks?: number;
  /** Maximum returned command preview size (UTF-16 units). Default: 4,096. */
  maxCommandChars?: number;
  /** Maximum returned output preview size (UTF-16 units). Default: 8,192. */
  maxOutputChars?: number;
}>;

export type ClaudeBashGroupingOptions = Readonly<{
  /**
   * Raw row indexes with a discontinuity immediately before that row. Groups
   * never cross one even when the retained rows on both sides look blank or
   * directly adjacent.
   */
  barrierLines?: readonly number[];
  /** Maximum merged command preview size (UTF-16 units). Default: 3,000. */
  maxCommandChars?: number;
  /** Maximum merged output preview size (UTF-16 units). Default: 6,000. */
  maxOutputChars?: number;
}>;

export type ClaudeBashSummaries =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export type ClaudeBashSummaryRequest = Readonly<{
  id: string;
  fingerprint: string;
  lineCount: number;
  command: string;
  output: string;
  commandTruncated: boolean;
  outputTruncated: boolean;
}>;

export type ClaudeBashProjectionRow = Readonly<{
  visualRow: number;
  kind: 'raw' | 'bash-placeholder';
  /** Raw terminal row, or a single-line placeholder for a collapsed range. */
  line: string;
  rawStart: number;
  rawEndExclusive: number;
  rawRange: ClaudeBashLineRange;
  block: ClaudeBashBlock | null;
  fingerprint: string | null;
  status: ClaudeBashBlockStatus | null;
}>;

export type ClaudeBashProjection = Readonly<{
  mode: ClaudeBashMode;
  /** Exact source object supplied by the caller; never filtered or rewritten. */
  rawLines: readonly string[];
  /** One string per visual row. `off` is the exact same object as `rawLines`. */
  lines: readonly string[];
  rows: readonly ClaudeBashProjectionRow[];
  /** Convenience mirror of `rows[*].rawRange`. */
  visualToRawRange: readonly ClaudeBashLineRange[];
  /** Short alias for virtual-row consumers. */
  visualToRaw: readonly ClaudeBashLineRange[];
  /** Every source row maps to exactly one visual row. */
  rawToVisualRow: readonly number[];
  /** Short alias for virtual-row consumers. */
  rawToVisual: readonly number[];
  detectedBlocks: readonly ClaudeBashBlock[];
  /** Missing completed summaries only; active calls never enter this queue. */
  summaryRequests: readonly ClaudeBashSummaryRequest[];
}>;

export type ClaudeBashProjectionOptions = Readonly<{
  mode: ClaudeBashMode;
  detection?: ClaudeBashDetection;
  detectionOptions?: ClaudeBashDetectionOptions;
  summaries?: ClaudeBashSummaries;
  /** Maximum visible summary text (UTF-16 units). Default: 240. */
  maxSummaryChars?: number;
}>;

/** Summary work emitted only by the additive grouped projection API. */
export type ClaudeBashGroupedSummaryRequest = Readonly<{
  id: string;
  fingerprint: string;
  lineCount: number;
  command: string;
  output: string;
  commandTruncated: boolean;
  outputTruncated: boolean;
  blockCount: number;
}>;

/** A grouped projection row. The legacy row type remains byte-for-byte stable. */
export type ClaudeBashGroupedProjectionRow = Readonly<{
  visualRow: number;
  kind: 'raw' | 'bash-placeholder';
  /** Raw terminal row, or a single-line placeholder for a collapsed group. */
  line: string;
  rawStart: number;
  rawEndExclusive: number;
  rawRange: ClaudeBashLineRange;
  /** Present on grouped placeholders; null on ordinary raw rows. */
  group: ClaudeBashGroup | null;
  /** Single-member compatibility view; null when a group has multiple blocks. */
  block: ClaudeBashBlock | null;
  fingerprint: string | null;
  status: ClaudeBashBlockStatus | null;
  summaryState: ClaudeBashSummaryState;
}>;

export type ClaudeBashGroupedProjection = Readonly<{
  mode: ClaudeBashMode;
  /** Exact source object supplied by the caller; never filtered or rewritten. */
  rawLines: readonly string[];
  /** One string per grouped visual row. `off` is the same object as `rawLines`. */
  lines: readonly string[];
  rows: readonly ClaudeBashGroupedProjectionRow[];
  visualToRawRange: readonly ClaudeBashLineRange[];
  visualToRaw: readonly ClaudeBashLineRange[];
  rawToVisualRow: readonly number[];
  rawToVisual: readonly number[];
  detectedBlocks: readonly ClaudeBashBlock[];
  detectedGroups: readonly ClaudeBashGroup[];
  summaryRequests: readonly ClaudeBashGroupedSummaryRequest[];
}>;

export type ClaudeBashGroupedProjectionOptions = Readonly<{
  mode: ClaudeBashMode;
  detection?: ClaudeBashDetection;
  detectionOptions?: ClaudeBashDetectionOptions;
  groupingOptions?: ClaudeBashGroupingOptions;
  summaries?: ClaudeBashSummaries;
  /**
   * Only missing group IDs in this set become pending summary work. When the
   * option is omitted, every completed missing group remains eligible.
   */
  summaryEligibleIds?: ReadonlySet<string>;
  /** Maximum visible summary text (UTF-16 units). Default: 240. */
  maxSummaryChars?: number;
}>;

const DEFAULT_MAX_SCAN_LINES = 20_000;
const DEFAULT_MAX_BLOCK_LINES = 2_000;
const DEFAULT_MAX_BLOCKS = 512;
const DEFAULT_MAX_COMMAND_CHARS = 4_096;
const DEFAULT_MAX_OUTPUT_CHARS = 8_192;
// Ten cold-start groups must fit the host's 96k request boundary in one model
// batch. 10 × (3k command + 6k output) = 90k, leaving the client watchdog to
// cover one bounded backend request rather than a hidden sequential split.
const DEFAULT_MAX_GROUP_COMMAND_CHARS = 3_000;
const DEFAULT_MAX_GROUP_OUTPUT_CHARS = 6_000;
const DEFAULT_MAX_SUMMARY_CHARS = 240;

// A terminal physical row should be bounded by pane width. Refuse a wildly
// oversized candidate rather than spending unbounded work trying to classify it.
const MAX_CANDIDATE_ROW_CHARS = 65_536;

// The current composer calibrates only the live pane width. Retained history
// can have been painted at another geometry, and a discontinuous archive
// segment can contain no composer at all. A wide row immediately before
// marker-shaped text is therefore plausibly an old soft-wrap even when it does
// not equal today's width. The 64-cell floor covers the calibrated 80/126/240
// layouts without turning ordinary command output into a guessed old pane.
const MIN_PLAUSIBLE_SOFT_WRAP_CELLS = 64;

const SGR = '\\x1b\\[[0-9;:]*m';
const STYLED_BLANK_PREFIX = new RegExp(`^(?:${SGR})+ (?:${SGR})+ $`);
const BOLD_BASH = /\x1b\[(?:1(?:;[0-9;:]*)?|[0-9;:]*;1(?:;[0-9;:]*)?)mBash/;
const GREY_OR_DIM_SGR = /\x1b\[(?:38(?:;|:)[0-9;:]+|3[0-7]|9[0-7]|2)m/;

type HeaderMatch = Readonly<{
  status: ClaudeBashBlockStatus;
  firstCommandText: string;
}>;

type ParsedCandidate = Readonly<{
  block: ClaudeBashBlock | null;
  /** Skip a rejected header-shaped continuation so it cannot become a block. */
  resumeLine?: number;
}>;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function visibleLine(raw: string): string {
  return stripAnsi(raw).replace(/\u00a0/g, ' ').trimEnd();
}

function completedHeader(raw: string): HeaderMatch | null {
  if (raw.length > MAX_CANDIDATE_ROW_CHARS) return null;
  const match = /^(?:●|⏺) Bash\((.*)$/.exec(visibleLine(raw));
  return match ? { status: 'completed', firstCommandText: match[1] ?? '' } : null;
}

/**
 * A plain `  Bash(` is not enough: it occurs in prose and nested-agent output.
 * Require Claude's exact semantic styling — a coloured/dim blank marker cell
 * followed by a reset and an explicitly bold Bash label.
 */
function activeHeader(raw: string): HeaderMatch | null {
  if (raw.length > MAX_CANDIDATE_ROW_CHARS) return null;
  const plain = visibleLine(raw);
  const match = /^ {2}Bash\((.*)$/.exec(plain);
  if (!match) return null;

  const boldBash = BOLD_BASH.exec(raw);
  if (!boldBash || boldBash.index < 0) return null;
  const markerPrefix = raw.slice(0, boldBash.index);
  if (!STYLED_BLANK_PREFIX.test(markerPrefix)) return null;
  if (!GREY_OR_DIM_SGR.test(markerPrefix)) return null;
  return { status: 'active', firstCommandText: match[1] ?? '' };
}

function headerAt(raw: string): HeaderMatch | null {
  return completedHeader(raw) ?? activeHeader(raw);
}

function isResultDelimiter(line: string): boolean {
  return /^ {2}⎿(?: {1,2}|$)/.test(line);
}

type BoundaryKind = 'top-level' | 'composer-rule' | 'dialog' | 'approval';

function boundaryKind(line: string): BoundaryKind | null {
  // Approval copy can sit inside either rounded or square Claude chrome. Strip
  // only one leading border and its rule decoration; ordinary command output
  // remains untouched. Recognition here is deliberately semantic because an
  // approval surface must never disappear together with completed output.
  const dialogContent = line
    .replace(/^\s*[│┃║╭┌┏](?:[─━-]*\s*)?/, '')
    .trimStart();
  // Claude's permission UI has existed both as a box and as plain rows. A
  // styled active Bash header directly above either form is an approval, not
  // proof that the command ran; keep the whole surface raw.
  if (
    /^(?:I want to run:|Do you want to (?:allow|proceed)|Would you like to (?:allow|proceed)|This command requires approval)/i.test(dialogContent)
    || /^❯\s*\d+[.)]\s*(?:Yes|No|Allow|Deny)\b/i.test(dialogContent)
  ) return 'approval';
  if (/^(?:●|⏺|❯|✻)(?:\s|$)/.test(line)) return 'top-level';
  if (/^[─━-]{8,}\s*$/.test(line)) return 'composer-rule';
  if (/^[╭┌┏](?:[─━-]|\s)/.test(line)) return 'dialog';
  return null;
}

/** Claude 2.1.x paints both composer rules as one un-reset 244-grey row.
 * Requiring the paired `rule / ❯ / rule` shape keeps this a calibrated UI
 * signature instead of guessing from a generic box-drawing line. */
function claudeComposerRuleCells(raw: string): number | null {
  const style = /^\x1b\[38(?:;5;244|:5:244)m/.exec(raw);
  if (!style) return null;
  if (raw.slice(style[0].length).includes('\x1b')) return null;
  const line = visibleLine(raw);
  if (!/^[─━-]{8,}$/.test(line)) return null;
  return stringCells(line);
}

function confirmedClaudeComposerRuleAt(rawLines: readonly string[], index: number): number | null {
  const cells = claudeComposerRuleCells(rawLines[index] ?? '');
  if (cells === null) return null;
  for (const otherIndex of [index + 2, index - 2]) {
    if (otherIndex < 0 || otherIndex >= rawLines.length) continue;
    const otherCells = claudeComposerRuleCells(rawLines[otherIndex] ?? '');
    const middle = visibleLine(rawLines[(index + otherIndex) / 2] ?? '');
    if (otherCells === cells && /^❯(?:\s|$)/.test(middle)) return cells;
  }
  return null;
}

/** Resume at the newest composer after a rejected ambiguous corridor. A shell
 * can emit more than one exact Claude-looking `Bash(...)` header, so advancing
 * by only one row would let a later spoof become an independently hidden
 * block. If this retained segment has no composer, quarantine through the
 * bounded candidate scan instead. */
function resumeAfterAmbiguousCorridor(
  rawLines: readonly string[],
  ambiguousLine: number,
  scanEnd: number,
): number {
  for (
    let index = Math.min(rawLines.length, scanEnd) - 1;
    index > ambiguousLine;
    index -= 1
  ) {
    if (confirmedClaudeComposerRuleAt(rawLines, index) !== null) return index;
  }
  return scanEnd;
}

/** Find the current physical pane width from Claude's paired composer chrome.
 * Live calibration put all ten observed pairs 4–7 rows from the capture tail.
 * Keep 64 rows of headroom, but never scan an old archive-sized corridor: a
 * composer from before resize must not masquerade as today's pane width. */
function inferredPaneColumns(rawLines: readonly string[]): number | null {
  const start = Math.max(0, rawLines.length - 64);
  for (let index = rawLines.length - 1; index >= start; index -= 1) {
    const cells = confirmedClaudeComposerRuleAt(rawLines, index);
    if (cells !== null) return cells;
  }
  return null;
}

/** Claude Code 2.1.x top-level marker wrapper calibrated from 1,507 raw rows
 * across five live panes (100% matched). This is used only after a physical
 * soft-wrap makes a column-zero marker ambiguous. Unknown versions/themes
 * fail open instead of letting arbitrary shell colour turn into a boundary. */
function isCalibratedClaudeTopLevel(raw: string): boolean {
  return /^(?:\x1b\[0m)?\x1b\[38(?:;5;|:5:)(?:114|231|246|211|220)m(?:\x1b\[49m)?(?:●|✻)\x1b\[39m(?:\s|$)/
    .test(raw);
}

function trimOneClosingParen(rows: string[]): void {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if ((rows[i] ?? '') === '') continue;
    rows[i] = (rows[i] ?? '').replace(/\)\s*$/, '');
    return;
  }
}

function commandText(
  rawLines: readonly string[],
  startLine: number,
  endLine: number,
  firstCommandText: string,
): string {
  const rows = [firstCommandText.trimEnd()];
  for (let i = startLine + 1; i < endLine; i += 1) {
    const row = visibleLine(rawLines[i] ?? '');
    // Claude normally indents wrapped command rows by six cells. Explicit
    // command newlines can appear at column zero, so leave those untouched.
    rows.push(row.startsWith('      ') ? row.slice(6) : row);
  }
  trimOneClosingParen(rows);
  return rows.join('\n').trim();
}

function removeResultPrefix(line: string): string {
  return line.replace(/^ {2}⎿(?: {1,2})?/, '');
}

function outputText(
  rawLines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const rows: string[] = [];
  for (let i = startLine; i < endLine; i += 1) {
    const row = visibleLine(rawLines[i] ?? '');
    if (isResultDelimiter(row)) rows.push(removeResultPrefix(row));
    else rows.push(row.startsWith('     ') ? row.slice(5) : row);
  }
  return rows.join('\n').trim();
}

function truncateUtf16(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  let end = maxChars;
  const final = text.charCodeAt(end - 1);
  if (final >= 0xd800 && final <= 0xdbff && end < text.length) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function blockFingerprint(
  command: string,
  output: string,
  status: ClaudeBashBlockStatus,
): string {
  const normalizedCommand = command.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedOutput = output.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = status === 'completed'
    ? `${normalizedCommand}\u0000${normalizedOutput}`
    : normalizedCommand;
  const first = fnv1a32(normalized, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a32(normalized, 0x9e3779b9).toString(16).padStart(8, '0');
  return `claude-bash-v1-${first}${second}`;
}

function groupFingerprint(
  blocks: readonly ClaudeBashBlock[],
  status: ClaudeBashBlockStatus,
): string {
  const normalized = `${status}\u0000${blocks.map((block) => block.fingerprint).join('\u0000')}`;
  const first = fnv1a32(normalized, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a32(normalized, 0x9e3779b9).toString(16).padStart(8, '0');
  return `claude-bash-group-v1-${first}${second}`;
}

function range(startLine: number, endLine: number): ClaudeBashLineRange {
  return Object.freeze({ startLine, endLine });
}

function parseCandidate(
  rawLines: readonly string[],
  startLine: number,
  header: HeaderMatch,
  limits: Readonly<{
    maxBlockLines: number;
    maxCommandChars: number;
    maxOutputChars: number;
    paneColumns: number | null;
  }>,
): ParsedCandidate {
  // A block whose source range is exactly maxBlockLines rows is allowed. Read
  // one extra physical row so a boundary at that half-open end can prove the
  // candidate without becoming part of it. The old `< start + maxBlockLines`
  // loop rejected that exact-limit case one row too early.
  const maximumCandidateEnd = startLine + limits.maxBlockLines;
  const scanEnd = Math.min(rawLines.length, maximumCandidateEnd + 1);
  let delimiterLine = -1;
  let boundaryLine = -1;
  let pendingBlankStart = -1;
  let softWrappedWeakBoundary = false;

  for (let i = startLine + 1; i < scanEnd; i += 1) {
    const raw = rawLines[i] ?? '';
    if (raw.length > MAX_CANDIDATE_ROW_CHARS) return { block: null };
    const line = visibleLine(raw);

    if (delimiterLine < 0 && isResultDelimiter(line)) {
      delimiterLine = i;
      pendingBlankStart = -1;
      continue;
    }

    const nextHeader = headerAt(raw);
    const boundary = nextHeader ? 'top-level' : boundaryKind(line);
    if (boundary) {
      // An approval box before a result is not an executed Bash block. Preserve
      // the complete dialog and candidate verbatim.
      if ((boundary === 'dialog' || boundary === 'approval') && delimiterLine < 0) {
        return { block: null };
      }
      if (delimiterLine >= 0) {
        // Permission semantics always win, even after a full-width result made
        // the opening border look like a possible tmux continuation.
        if (boundary === 'approval') return { block: null };

        const calibratedTopLevel = boundary === 'top-level'
          && isCalibratedClaudeTopLevel(raw);
        const previousCells = stringCells(visibleLine(rawLines[i - 1] ?? ''));
        const previousFillsCurrentPane = limits.paneColumns !== null
          && previousCells === limits.paneColumns;
        const previousCouldFillAnotherPane = previousCells >= MIN_PLAUSIBLE_SOFT_WRAP_CELLS
          && !previousFillsCurrentPane;
        const rejectedAmbiguousBoundary: ParsedCandidate = nextHeader
          ? { block: null, resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd) }
          : { block: null };

        // Rounded chrome is Claude's dialog family. Unknown copy must be kept
        // just as carefully as today's recognised approval wording. Square
        // `┌` remains eligible for the calibrated soft-wrapped table path.
        if (boundary === 'dialog' && /^╭/.test(line)) {
          return {
            block: null,
            resumeLine: resumeAfterAmbiguousCorridor(rawLines, i, scanEnd),
          };
        }

        // A paired composer is positive UI only when it follows an ordinary
        // short/separator row. Immediately after a possible full-width result,
        // the exact same bytes can be shell output (for example a captured
        // Claude pane). Preserve the whole candidate instead of cutting it.
        if (boundary === 'composer-rule' && confirmedClaudeComposerRuleAt(rawLines, i) !== null) {
          if (
            previousFillsCurrentPane
            || (previousCouldFillAnotherPane && !softWrappedWeakBoundary)
          ) {
            return rejectedAmbiguousBoundary;
          }
          boundaryLine = pendingBlankStart >= 0 ? pendingBlankStart : i;
          break;
        }

        // A retained segment may have no composer or may predate a resize. We
        // cannot prove that a long preceding row was a hard newline, so every
        // boundary shape after it fails open. This also covers capture paths
        // which trim trailing spaces from a physically full row.
        if (previousCouldFillAnotherPane && !softWrappedWeakBoundary) {
          return rejectedAmbiguousBoundary;
        }

        // Even Claude's calibrated marker wrapper can be emitted verbatim by a
        // shell command. When it lands directly after a proven full row there
        // is no byte-level discriminator, so keep both possible meanings raw.
        if (previousFillsCurrentPane && calibratedTopLevel) {
          return rejectedAmbiguousBoundary;
        }

        // tmux capture-pane preserves soft wraps as physical rows. A marker,
        // header, box, or rule at column zero can therefore be shell output.
        // If the preceding row filled the pane, treat every uncalibrated shape
        // as continuation. This must run for top-level markers too: limiting it
        // to boxes/rules left `● shell bullet` and fake `● Bash(...)` output
        // outside a partially hidden block.
        if (
          previousFillsCurrentPane
          && !calibratedTopLevel
        ) {
          pendingBlankStart = -1;
          softWrappedWeakBoundary = true;
          continue;
        }

        if (softWrappedWeakBoundary && boundary === 'top-level' && !calibratedTopLevel) {
          // A generic SGR such as shell-red is not Claude identity. Once the
          // candidate crossed an ambiguous continuation, preserve everything
          // rather than cutting at that coloured output bullet.
          return { block: null };
        }

        if (boundary === 'dialog' || boundary === 'composer-rule') {
          // An uncalibrated post-result box/rule could be either command output
          // or UI. Preserve the complete candidate instead of hiding half a
          // table or half a dialog.
          return { block: null };
        }
      }
      boundaryLine = pendingBlankStart >= 0 ? pendingBlankStart : i;
      break;
    }

    if (delimiterLine >= 0) {
      if (line.trim() === '') {
        if (pendingBlankStart < 0) pendingBlankStart = i;
      } else {
        pendingBlankStart = -1;
      }
    }
  }

  const hitLineLimit = maximumCandidateEnd < rawLines.length && boundaryLine < 0;
  if (hitLineLimit) return { block: null };

  let endLine = boundaryLine;
  if (header.status === 'completed') {
    // Completed blocks need both structural halves and a strong following
    // boundary. A capture cut at either edge remains untouched.
    if (delimiterLine < 0 || endLine < 0) return { block: null };
  } else if (endLine < 0) {
    // Exact ANSI-styled active calls may safely collapse through the current
    // capture edge. They are never offered to the summarizer.
    endLine = rawLines.length;
  }

  if (endLine <= startLine) return { block: null };
  const commandEndLine = delimiterLine >= 0 ? delimiterLine : endLine;
  const outputStartLine = delimiterLine >= 0 ? delimiterLine : endLine;
  const fullCommand = commandText(
    rawLines,
    startLine,
    commandEndLine,
    header.firstCommandText,
  );
  if (!fullCommand) return { block: null };
  const fullOutput = delimiterLine >= 0
    ? outputText(rawLines, outputStartLine, endLine)
    : '';
  const boundedCommand = truncateUtf16(fullCommand, limits.maxCommandChars);
  const boundedOutput = truncateUtf16(fullOutput, limits.maxOutputChars);
  // Claude can scroll a finished call out of the live viewport before its
  // grey active marker is repainted green. A result delimiter plus a later
  // top-level boundary is stronger completion evidence than that stale colour.
  // Without both signals the exact styled call remains active and is never
  // offered to a summarizer.
  const status: ClaudeBashBlockStatus = header.status === 'active'
    && delimiterLine >= 0
    && boundaryLine >= 0
    ? 'completed'
    : header.status;
  const fingerprint = blockFingerprint(fullCommand, fullOutput, status);
  const lineCount = endLine - startLine;

  return {
    block: Object.freeze({
      id: fingerprint,
      lineCount,
      rawStart: startLine,
      rawEndExclusive: endLine,
      status,
      sourceRange: range(startLine, endLine),
      commandRange: range(startLine, commandEndLine),
      outputRange: range(outputStartLine, endLine),
      command: boundedCommand.text,
      output: boundedOutput.text,
      commandTruncated: boundedCommand.truncated,
      outputTruncated: boundedOutput.truncated,
      fingerprint,
    }),
  };
}

/** Detect high-confidence top-level Claude Code Bash blocks in physical rows. */
export function detectClaudeBashBlocks(
  rawLines: readonly string[],
  options: ClaudeBashDetectionOptions = {},
): ClaudeBashDetection {
  const maxScanLines = boundedInteger(options.maxScanLines, DEFAULT_MAX_SCAN_LINES, 1_000_000);
  const scanStart = Math.max(0, rawLines.length - maxScanLines);
  const scanRange = range(scanStart, rawLines.length);
  const screenMode = options.screenMode ?? 'normal';
  if (screenMode !== 'normal' || maxScanLines === 0) {
    return Object.freeze({ blocks: Object.freeze([]), scanRange, enabled: false });
  }

  const maxBlockLines = boundedInteger(options.maxBlockLines, DEFAULT_MAX_BLOCK_LINES, 100_000);
  const maxBlocks = boundedInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS, 100_000);
  const maxCommandChars = boundedInteger(options.maxCommandChars, DEFAULT_MAX_COMMAND_CHARS, 1_000_000);
  const maxOutputChars = boundedInteger(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 2_000_000);
  if (maxBlockLines < 2 || maxBlocks === 0) {
    return Object.freeze({ blocks: Object.freeze([]), scanRange, enabled: true });
  }

  const blocks: ClaudeBashBlock[] = [];
  const paneColumns = inferredPaneColumns(rawLines);
  let i = scanStart;
  while (i < rawLines.length) {
    const header = headerAt(rawLines[i] ?? '');
    if (!header) {
      i += 1;
      continue;
    }

    const parsed = parseCandidate(rawLines, i, header, {
      maxBlockLines,
      maxCommandChars,
      maxOutputChars,
      paneColumns,
    });
    if (!parsed.block) {
      i = Math.max(i + 1, parsed.resumeLine ?? 0);
      continue;
    }

    if (blocks.length === maxBlocks) blocks.shift();
    blocks.push(parsed.block);
    // Ranges do not overlap. Continue at the first raw row after this block so
    // a boundary that is itself another Bash header is considered next.
    i = parsed.block.sourceRange.endLine;
  }

  return Object.freeze({
    blocks: Object.freeze(blocks),
    scanRange,
    enabled: true,
  });
}

function isBlankPresentationRow(raw: string): boolean {
  return visibleLine(raw).trim() === '';
}

function crossesBarrier(
  start: number,
  end: number,
  barrierLines: ReadonlySet<number>,
): boolean {
  for (const barrier of barrierLines) {
    if (barrier >= start && barrier <= end) return true;
  }
  return false;
}

function mergedGroupPreview(
  blocks: readonly ClaudeBashBlock[],
  field: 'command' | 'output',
  maxChars: number,
): { text: string; truncated: boolean } {
  const memberWasTruncated = blocks.some((block) => (
    field === 'command' ? block.commandTruncated : block.outputTruncated
  ));
  if (blocks.length <= 1) {
    const bounded = truncateUtf16(blocks[0]?.[field] ?? '', maxChars);
    return { text: bounded.text, truncated: bounded.truncated || memberWasTruncated };
  }

  const labels = blocks.map((_, index) => `[Bash ${index + 1}/${blocks.length}]`);
  const fixedChars = labels.reduce((sum, label) => sum + label.length + 1, 0)
    + (blocks.length - 1) * 2;
  if (fixedChars >= maxChars) {
    const bounded = truncateUtf16(labels.join('\n\n'), maxChars);
    return { text: bounded.text, truncated: true };
  }

  // Reserve an equal share for every member before giving unused space from a
  // short member to those after it. A single huge first output can therefore
  // never erase the filename or intent carried by the last Bash call.
  let remainingChars = maxChars - fixedChars;
  let remainingMembers = blocks.length;
  let truncated = memberWasTruncated;
  const pieces = blocks.map((block, index) => {
    const share = Math.floor(remainingChars / remainingMembers);
    const bounded = truncateUtf16(block[field], share);
    remainingChars -= bounded.text.length;
    remainingMembers -= 1;
    truncated ||= bounded.truncated;
    return `${labels[index]}\n${bounded.text}`;
  });
  return { text: pieces.join('\n\n'), truncated };
}

/**
 * Merge adjacent detected calls into semantic Bash groups without touching raw
 * terminal data. Direct adjacency and ANSI/NBSP-normalized blank-only gaps join;
 * semantic rows and caller-supplied retention barriers always split.
 */
export function groupClaudeBashBlocks(
  rawLines: readonly string[],
  detectedBlocks: readonly ClaudeBashBlock[],
  options: ClaudeBashGroupingOptions = {},
): readonly ClaudeBashGroup[] {
  const maxCommandChars = boundedInteger(
    options.maxCommandChars,
    DEFAULT_MAX_GROUP_COMMAND_CHARS,
    1_000_000,
  );
  const maxOutputChars = boundedInteger(
    options.maxOutputChars,
    DEFAULT_MAX_GROUP_OUTPUT_CHARS,
    2_000_000,
  );
  const barrierLines = new Set(
    (options.barrierLines ?? []).filter((line) => (
      Number.isSafeInteger(line) && line >= 0 && line <= rawLines.length
    )),
  );
  const sortedBlocks = [...detectedBlocks]
    .filter((block) => (
      block.rawStart >= 0
      && block.rawEndExclusive <= rawLines.length
      && block.rawStart < block.rawEndExclusive
    ))
    .sort((a, b) => a.rawStart - b.rawStart);
  const blocks: ClaudeBashBlock[] = [];
  let acceptedEnd = 0;
  for (const block of sortedBlocks) {
    if (blocks.length > 0 && block.rawStart < acceptedEnd) continue;
    blocks.push(block);
    acceptedEnd = block.rawEndExclusive;
  }

  const members: ClaudeBashBlock[][] = [];
  for (const block of blocks) {
    const current = members.at(-1);
    const previous = current?.at(-1);
    const blankOnlyGap = previous
      ? rawLines
        .slice(previous.rawEndExclusive, block.rawStart)
        .every(isBlankPresentationRow)
      : false;
    if (
      current
      && previous
      && blankOnlyGap
      && !crossesBarrier(previous.rawEndExclusive, block.rawStart, barrierLines)
    ) {
      current.push(block);
    } else {
      members.push([block]);
    }
  }

  return Object.freeze(members.map((groupBlocks) => {
    const first = groupBlocks[0]!;
    const last = groupBlocks.at(-1)!;
    const status: ClaudeBashBlockStatus = groupBlocks.some((block) => block.status === 'active')
      ? 'active'
      : 'completed';
    let rawStart = first.rawStart;
    // Claude normally leaves separator blanks before a top-level Bash call.
    // Keeping those rows raw puts the compact divider at the bottom of the
    // apparent gap even though the rule is centred inside its own third-row.
    // Absorb a proven blank-only prefix so the compact row itself becomes the
    // complete gap between semantic rows. Capture padding and retention seams
    // remain raw because there is no continuous semantic row on their left.
    let leadingStart = rawStart;
    while (
      leadingStart > 0
      && !barrierLines.has(leadingStart)
      && isBlankPresentationRow(rawLines[leadingStart - 1] ?? '')
    ) leadingStart -= 1;
    if (leadingStart > 0 && !barrierLines.has(leadingStart)) {
      rawStart = leadingStart;
    }
    let rawEndExclusive = last.rawEndExclusive;
    // parseCandidate deliberately leaves separator blanks before the following
    // semantic boundary raw. Once the whole burst is grouped, absorb those
    // blanks too so a compact row does not leave empty full-height terminal rows.
    let trailingEnd = rawEndExclusive;
    while (
      trailingEnd < rawLines.length
      && !barrierLines.has(trailingEnd)
      && isBlankPresentationRow(rawLines[trailingEnd] ?? '')
    ) trailingEnd += 1;
    // Do not swallow unknown blank capture padding. A real following semantic
    // row proves these blanks are the separator already used by the detector.
    if (trailingEnd < rawLines.length && !barrierLines.has(trailingEnd)) {
      rawEndExclusive = trailingEnd;
    }

    const command = mergedGroupPreview(groupBlocks, 'command', maxCommandChars);
    const output = mergedGroupPreview(groupBlocks, 'output', maxOutputChars);
    // A one-member group is semantically the same work item as the legacy
    // per-block projection. Preserve its v0.16 fingerprint so hosts can reuse
    // existing summary caches and do not spend model quota re-distilling it.
    const fingerprint = groupBlocks.length === 1
      ? first.fingerprint
      : groupFingerprint(groupBlocks, status);
    return Object.freeze({
      id: fingerprint,
      fingerprint,
      lineCount: rawEndExclusive - rawStart,
      rawStart,
      rawEndExclusive,
      status,
      sourceRange: range(rawStart, rawEndExclusive),
      blockCount: groupBlocks.length,
      blocks: Object.freeze([...groupBlocks]),
      command: command.text,
      output: output.text,
      commandTruncated: command.truncated,
      outputTruncated: output.truncated,
    });
  }));
}

function summaryFor(summaries: ClaudeBashSummaries | undefined, fingerprint: string): string | null {
  if (!summaries) return null;
  const maybeMap = summaries as ReadonlyMap<string, string>;
  if (typeof maybeMap.get === 'function') return maybeMap.get(fingerprint) ?? null;
  const record = summaries as Readonly<Record<string, string>>;
  if (!Object.prototype.hasOwnProperty.call(record, fingerprint)) return null;
  return record[fingerprint] ?? null;
}

function cleanPlaceholderText(text: string, maxChars: number): string {
  const plain = stripAnsi(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateUtf16(plain, maxChars).text;
}

function groupedPlaceholderLine(
  group: ClaudeBashGroup,
  mode: Exclude<ClaudeBashMode, 'off'>,
  summaries: ClaudeBashSummaries | undefined,
  maxSummaryChars: number,
  summaryEligible: boolean,
): { line: string; needsSummary: boolean; summaryState: ClaudeBashSummaryState } {
  if (group.status === 'active') {
    return { line: 'Bash กำลังรัน…', needsSummary: false, summaryState: 'none' };
  }
  if (mode === 'hide') {
    const rows = group.sourceRange.endLine - group.sourceRange.startLine;
    return { line: `Bash ซ่อนอยู่ · ${rows} แถว`, needsSummary: false, summaryState: 'none' };
  }

  const summary = summaryFor(summaries, group.fingerprint);
  const clean = summary === null ? '' : cleanPlaceholderText(summary, maxSummaryChars);
  if (clean) return { line: `Bash · ${clean}`, needsSummary: false, summaryState: 'resolved' };
  if (!summaryEligible) {
    return { line: 'hidden bash', needsSummary: false, summaryState: 'suppressed' };
  }
  return { line: 'Bash กำลังสรุป…', needsSummary: true, summaryState: 'pending' };
}

function groupedIdentityProjection(
  rawLines: readonly string[],
  mode: ClaudeBashMode,
  detectedBlocks: readonly ClaudeBashBlock[] = Object.freeze([]),
): ClaudeBashGroupedProjection {
  const rows: ClaudeBashGroupedProjectionRow[] = rawLines.map((line, visualRow) => Object.freeze({
    visualRow,
    kind: 'raw' as const,
    line,
    rawRange: range(visualRow, visualRow + 1),
    rawStart: visualRow,
    rawEndExclusive: visualRow + 1,
    group: null,
    block: null,
    fingerprint: null,
    status: null,
    summaryState: 'none',
  }));
  const visualToRawRange = rows.map((row) => row.rawRange);
  const rawToVisualRow = rawLines.map((_, index) => index);
  return Object.freeze({
    mode,
    rawLines,
    lines: rawLines,
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks,
    detectedGroups: Object.freeze([]),
    summaryRequests: Object.freeze([]),
  });
}

/**
 * Collapse semantic Bash groups into one visual row while retaining every raw
 * source line and a total raw↔visual mapping. This additive entry point keeps
 * the legacy per-block projection contract unchanged.
 */
export function projectClaudeBashGroupedLines(
  rawLines: readonly string[],
  options: ClaudeBashGroupedProjectionOptions,
): ClaudeBashGroupedProjection {
  if (options.mode === 'off') return groupedIdentityProjection(rawLines, 'off');

  const detection = options.detection ?? detectClaudeBashBlocks(rawLines, options.detectionOptions);
  if (!detection.enabled || detection.blocks.length === 0) {
    return groupedIdentityProjection(rawLines, options.mode, detection.blocks);
  }

  const maxSummaryChars = boundedInteger(
    options.maxSummaryChars,
    DEFAULT_MAX_SUMMARY_CHARS,
    4_096,
  );
  const groups = groupClaudeBashBlocks(rawLines, detection.blocks, options.groupingOptions);

  const rows: ClaudeBashGroupedProjectionRow[] = [];
  const rawToVisualRow = new Array<number>(rawLines.length);
  const summaryRequests: ClaudeBashGroupedSummaryRequest[] = [];
  const requested = new Set<string>();
  let rawLine = 0;

  const pushRaw = (index: number) => {
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: 'raw',
      line: rawLines[index] ?? '',
      rawRange: range(index, index + 1),
      rawStart: index,
      rawEndExclusive: index + 1,
      group: null,
      block: null,
      fingerprint: null,
      status: null,
      summaryState: 'none',
    }));
    rawToVisualRow[index] = visualRow;
  };

  for (const group of groups) {
    const { startLine, endLine } = group.sourceRange;
    // Ignore an externally supplied overlapping/retrograde detection result.
    if (startLine < rawLine) continue;
    while (rawLine < startLine) {
      pushRaw(rawLine);
      rawLine += 1;
    }

    const placeholder = groupedPlaceholderLine(
      group,
      options.mode,
      options.summaries,
      maxSummaryChars,
      options.summaryEligibleIds?.has(group.fingerprint) ?? true,
    );
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: 'bash-placeholder',
      line: placeholder.line,
      rawRange: group.sourceRange,
      rawStart: startLine,
      rawEndExclusive: endLine,
      group,
      block: group.blockCount === 1 ? group.blocks[0] ?? null : null,
      fingerprint: group.fingerprint,
      status: group.status,
      summaryState: placeholder.summaryState,
    }));
    for (let index = startLine; index < endLine; index += 1) {
      rawToVisualRow[index] = visualRow;
    }
    rawLine = endLine;

    if (placeholder.needsSummary && !requested.has(group.fingerprint)) {
      requested.add(group.fingerprint);
      summaryRequests.push(Object.freeze({
        id: group.id,
        fingerprint: group.fingerprint,
        lineCount: group.lineCount,
        command: group.command,
        output: group.output,
        commandTruncated: group.commandTruncated,
        outputTruncated: group.outputTruncated,
        blockCount: group.blockCount,
      }));
    }
  }

  while (rawLine < rawLines.length) {
    pushRaw(rawLine);
    rawLine += 1;
  }

  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return Object.freeze({
    mode: options.mode,
    rawLines,
    lines: Object.freeze(lines),
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks: detection.blocks,
    detectedGroups: groups,
    summaryRequests: Object.freeze(summaryRequests),
  });
}

function legacyPlaceholderLine(
  block: ClaudeBashBlock,
  mode: Exclude<ClaudeBashMode, 'off'>,
  summaries: ClaudeBashSummaries | undefined,
  maxSummaryChars: number,
): { line: string; needsSummary: boolean } {
  if (block.status === 'active') {
    return { line: 'Bash กำลังรัน…', needsSummary: false };
  }
  if (mode === 'hide') {
    const rows = block.sourceRange.endLine - block.sourceRange.startLine;
    return { line: `Bash ซ่อนอยู่ · ${rows} แถว`, needsSummary: false };
  }

  const summary = summaryFor(summaries, block.fingerprint);
  const clean = summary === null ? '' : cleanPlaceholderText(summary, maxSummaryChars);
  if (!clean) return { line: 'Bash กำลังสรุป…', needsSummary: true };
  return { line: `Bash · ${clean}`, needsSummary: false };
}

function identityProjection(
  rawLines: readonly string[],
  mode: ClaudeBashMode,
  detectedBlocks: readonly ClaudeBashBlock[] = Object.freeze([]),
): ClaudeBashProjection {
  const rows: ClaudeBashProjectionRow[] = rawLines.map((line, visualRow) => Object.freeze({
    visualRow,
    kind: 'raw' as const,
    line,
    rawRange: range(visualRow, visualRow + 1),
    rawStart: visualRow,
    rawEndExclusive: visualRow + 1,
    block: null,
    fingerprint: null,
    status: null,
  }));
  const visualToRawRange = rows.map((row) => row.rawRange);
  const rawToVisualRow = rawLines.map((_, index) => index);
  return Object.freeze({
    mode,
    rawLines,
    lines: rawLines,
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks,
    summaryRequests: Object.freeze([]),
  });
}

/**
 * Collapse detected Bash ranges into one visual row while retaining every raw
 * source line and a total raw↔visual mapping. Summary arrival only changes the
 * placeholder text; it cannot change row count or source ranges.
 */
export function projectClaudeBashLines(
  rawLines: readonly string[],
  options: ClaudeBashProjectionOptions,
): ClaudeBashProjection {
  if (options.mode === 'off') return identityProjection(rawLines, 'off');

  const detection = options.detection ?? detectClaudeBashBlocks(rawLines, options.detectionOptions);
  if (!detection.enabled || detection.blocks.length === 0) {
    return identityProjection(rawLines, options.mode, detection.blocks);
  }

  const maxSummaryChars = boundedInteger(
    options.maxSummaryChars,
    DEFAULT_MAX_SUMMARY_CHARS,
    4_096,
  );
  const candidates = [...detection.blocks]
    .filter((block) => (
      block.sourceRange.startLine >= 0 &&
      block.sourceRange.endLine <= rawLines.length &&
      block.sourceRange.startLine < block.sourceRange.endLine
    ))
    .sort((a, b) => a.sourceRange.startLine - b.sourceRange.startLine);

  const rows: ClaudeBashProjectionRow[] = [];
  const rawToVisualRow = new Array<number>(rawLines.length);
  const summaryRequests: ClaudeBashSummaryRequest[] = [];
  const requested = new Set<string>();
  let rawLine = 0;

  const pushRaw = (index: number) => {
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: 'raw',
      line: rawLines[index] ?? '',
      rawRange: range(index, index + 1),
      rawStart: index,
      rawEndExclusive: index + 1,
      block: null,
      fingerprint: null,
      status: null,
    }));
    rawToVisualRow[index] = visualRow;
  };

  for (const block of candidates) {
    const { startLine, endLine } = block.sourceRange;
    // Ignore an externally supplied overlapping/retrograde detection result.
    if (startLine < rawLine) continue;
    while (rawLine < startLine) {
      pushRaw(rawLine);
      rawLine += 1;
    }

    const placeholder = legacyPlaceholderLine(
      block,
      options.mode,
      options.summaries,
      maxSummaryChars,
    );
    const visualRow = rows.length;
    rows.push(Object.freeze({
      visualRow,
      kind: 'bash-placeholder',
      line: placeholder.line,
      rawRange: block.sourceRange,
      rawStart: startLine,
      rawEndExclusive: endLine,
      block,
      fingerprint: block.fingerprint,
      status: block.status,
    }));
    for (let index = startLine; index < endLine; index += 1) {
      rawToVisualRow[index] = visualRow;
    }
    rawLine = endLine;

    if (placeholder.needsSummary && !requested.has(block.fingerprint)) {
      requested.add(block.fingerprint);
      summaryRequests.push(Object.freeze({
        id: block.id,
        fingerprint: block.fingerprint,
        lineCount: block.lineCount,
        command: block.command,
        output: block.output,
        commandTruncated: block.commandTruncated,
        outputTruncated: block.outputTruncated,
      }));
    }
  }

  while (rawLine < rawLines.length) {
    pushRaw(rawLine);
    rawLine += 1;
  }

  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return Object.freeze({
    mode: options.mode,
    rawLines,
    lines: Object.freeze(lines),
    rows: Object.freeze(rows),
    visualToRawRange: Object.freeze(visualToRawRange),
    visualToRaw: Object.freeze(visualToRawRange),
    rawToVisualRow: Object.freeze(rawToVisualRow),
    rawToVisual: Object.freeze(rawToVisualRow),
    detectedBlocks: detection.blocks,
    summaryRequests: Object.freeze(summaryRequests),
  });
}
