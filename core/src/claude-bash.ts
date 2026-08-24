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

export type ClaudeBashMode = 'off' | 'hide' | 'haiku';
export type ClaudeBashBlockStatus = 'completed' | 'active';
export type ClaudeBashScreenMode = 'normal' | 'alternate' | 'unknown';

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

const DEFAULT_MAX_SCAN_LINES = 20_000;
const DEFAULT_MAX_BLOCK_LINES = 2_000;
const DEFAULT_MAX_BLOCKS = 512;
const DEFAULT_MAX_COMMAND_CHARS = 4_096;
const DEFAULT_MAX_OUTPUT_CHARS = 8_192;
const DEFAULT_MAX_SUMMARY_CHARS = 240;

// A terminal physical row should be bounded by pane width. Refuse a wildly
// oversized candidate rather than spending unbounded work trying to classify it.
const MAX_CANDIDATE_ROW_CHARS = 65_536;

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
  // Claude's permission UI has existed both as a box and as plain rows. A
  // styled active Bash header directly above either form is an approval, not
  // proof that the command ran; keep the whole surface raw.
  if (
    /^\s*(?:I want to run:|Do you want to (?:allow|proceed)|Would you like to (?:allow|proceed)|This command requires approval)/i.test(line)
    || /^❯\s*\d+[.)]\s*(?:Yes|No|Allow|Deny)\b/i.test(line)
  ) return 'approval';
  if (/^(?:●|⏺|❯|✻)(?:\s|$)/.test(line)) return 'top-level';
  if (/^[─━-]{8,}\s*$/.test(line)) return 'composer-rule';
  if (/^[╭┌┏](?:[─━-]|\s)/.test(line)) return 'dialog';
  return null;
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
  }>,
): ParsedCandidate {
  const hardEnd = Math.min(rawLines.length, startLine + limits.maxBlockLines);
  let delimiterLine = -1;
  let boundaryLine = -1;
  let pendingBlankStart = -1;

  for (let i = startLine + 1; i < hardEnd; i += 1) {
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

  const hitLineLimit = hardEnd < rawLines.length && boundaryLine < 0;
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
    });
    if (!parsed.block) {
      i += 1;
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

function placeholderLine(
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

    const placeholder = placeholderLine(
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
