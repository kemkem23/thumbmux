/**
 * Conservative Codex CLI tool/event detector.
 *
 * Codex paints semantic event headers with stable SGR signatures. This module
 * requires those signatures plus a conclusive block seal; matching visible
 * words or indentation alone is never sufficient. Phase one intentionally
 * recognises completed history only. Live, failed, malformed, and ambiguous
 * corridors remain byte-for-byte visible.
 */

import { isBlankToolSeparator, stripTerminalControls } from './terminal-controls';
import {
  stableToolFingerprint,
  type ToolBlockKind,
  type ToolBlockOutcome,
  type ToolCollapseBlock,
  type ToolLineRange,
} from './tool-projection';

export type CodexToolScreenMode = 'normal' | 'alternate' | 'unknown';

export type CodexToolDetectionOptions = Readonly<{
  /** Alternate/unknown full-screen modes always fail open. Default: normal. */
  screenMode?: CodexToolScreenMode;
  /** Inspect only this many newest physical rows. Default: 20,000. */
  maxScanLines?: number;
  /** A candidate longer than this remains raw. Default: 2,000. */
  maxBlockLines?: number;
  /** A candidate larger than this remains raw. Default: 8 Mi UTF-16 code units. */
  maxBlockChars?: number;
  /** Retain only this many newest proven blocks. Default: 512. */
  maxBlocks?: number;
  /**
   * Absolute identity of rawLines[0]. Supply the retained archive offset so a
   * block id survives prepend/eviction. Default: 0.
   */
  identityLineOffset?: number;
  /**
   * Treat physical row zero as a known hard boundary. Default false because a
   * retained tmux history segment can start inside a wrapped logical row.
   */
  leadingEdgeSealed?: boolean;
}>;

export type CodexToolDetection = Readonly<{
  provider: 'codex';
  blocks: readonly ToolCollapseBlock[];
  scanRange: ToolLineRange;
  /** False means screen mode made detection intentionally fail open. */
  enabled: boolean;
}>;

const DEFAULT_MAX_SCAN_LINES = 20_000;
const DEFAULT_MAX_BLOCK_LINES = 2_000;
const DEFAULT_MAX_BLOCK_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_BLOCKS = 512;
const MAX_ROW_CHARS = 65_536;
const MAX_LIMIT = 100_000;
const MAX_BLOCK_CHARS = 16 * 1024 * 1024;

const SUCCESS_BULLET = /^(?:\x1b\[0m)?\x1b\[(?:0;)?1m\x1b\[38;5;2m(?:\x1b\[49m)?•\x1b\[0m /u;
const FAILURE_BULLET = /^(?:\x1b\[0m)?\x1b\[(?:0;)?1m\x1b\[38;5;1m(?:\x1b\[49m)?•\x1b\[0m /u;
const DIM_EVENT_PREFIX = /^\x1b\[(?:0;)?2m• \x1b\[0;1m/u;

const RUN_GROUP = new RegExp(
  '^(?:\\x1b\\[0m)?\\x1b\\[(?:0;)?1m\\x1b\\[38;5;2m'
    + '(?:\\x1b\\[49m)?•\\x1b\\[0m \\x1b\\[(?:0;)?1m'
    + 'Ran ([1-9]\\d*) command(s?)\\x1b\\[0;2m · ctrl \\+ t to view transcript'
    + '\\x1b\\[0m$',
  'u',
);

const RUN_SUCCESS = new RegExp(
  '^(?:\\x1b\\[0m)?\\x1b\\[(?:0;)?1m\\x1b\\[38;5;2m'
    + '(?:\\x1b\\[49m)?•\\x1b\\[0m \\x1b\\[(?:0;)?1mRan\\x1b\\[0m '
    + '((?=\\x1b\\[38;(?:2|5);).+)$',
  'u',
);

const WAITED = new RegExp(
  '^\\x1b\\[(?:0;)?1m• Waited for background terminal'
    + '(?:\\x1b\\[0;2m(?: · (.*?))?(?:\\x1b\\[0m)?|\\x1b\\[0m)$',
  'u',
);

const BACKGROUND_INTERACTION = new RegExp(
  '^\\x1b\\[(?:0;)?2m↳ \\x1b\\[0;1mInteracted with background terminal'
    + '\\x1b\\[0;2m(?: · (.*?))?(?:\\x1b\\[0m)?$',
  'u',
);

const AGENT_EVENT = /^\x1b\[(?:0;)?2m• \x1b\[0;1m(Waiting for agents|Finished waiting|Viewed Image)\x1b\[0m$/u;
const AGENT_INTERACTION = /^\x1b\[(?:0;)?2m• \x1b\[0;1mInteracted with \x1b\[0m\x1b\[38;5;6m(`[^`\n]+`)\x1b\[39m$/u;
const AGENT_LIFECYCLE = /^\x1b\[(?:0;)?2m• \x1b\[0;1m(Started|Completed) \x1b\[0m\x1b\[38;5;6m(`[^`\n]+`)\x1b\[39m$/u;
const EDITED = /^\x1b\[(?:0;)?2m• \x1b\[0;1mEdited\x1b\[0m (.+) \(\x1b\[38;5;2m\+(\d+)\x1b\[39m \x1b\[38;5;1m-(\d+)\x1b\[39m\)$/u;
const DIM_ROW = /^\x1b\[(?:0;)?2m.*\x1b\[0m$/u;
const TREE_DETAIL = /^\x1b\[(?:0;)?2m  └ .+\x1b\[0m$/u;
const TREE_DETAIL_RESET_MARKER = /^\x1b\[(?:0;)?2m  └ \x1b\[0m.+$/u;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function range(startLine: number, endLine: number): ToolLineRange {
  return Object.freeze({ startLine, endLine });
}

/** Strictly validate terminal controls; unfamiliar or unterminated ESC fails open. */
function hasOnlyCompleteTerminalControls(raw: string): boolean {
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '\x1b') {
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === '[') {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code === 0x1b) return false;
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= raw.length) return false;
      index = end + 1;
      continue;
    }
    if (next === ']') {
      let end = index + 2;
      let terminated = false;
      while (end < raw.length) {
        if (raw[end] === '\x07') {
          index = end + 1;
          terminated = true;
          break;
        }
        if (raw[end] === '\x1b' && raw[end + 1] === '\\') {
          index = end + 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) return false;
      continue;
    }
    if (
      next === '(' || next === ')' || next === '*' || next === '+'
      || next === '-' || next === '.' || next === '/' || next === '#'
      || next === '%'
    ) {
      if (index + 2 >= raw.length || raw[index + 2] === '\x1b') return false;
      index += 3;
      continue;
    }
    // Known two-byte terminal controls. Everything else is ambiguous.
    if (next === '7' || next === '8' || next === 'D' || next === 'E'
      || next === 'H' || next === 'M' || next === 'c' || next === '='
    ) {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

function visible(raw: string): string {
  return stripTerminalControls(raw).replace(/\u00a0/g, ' ').trimEnd();
}

type DimPaintEvidence = Readonly<{
  firstSemanticCellDim: boolean;
  firstSemanticCellForeground: boolean;
  firstSemanticCellForegroundKey: string | null;
  semanticForegroundKeys: readonly (string | null)[];
  allSemanticCellsUndim: boolean;
  hasSemanticCell: boolean;
  endDim: boolean;
  endForeground: boolean;
  endForegroundKey: string | null;
}>;

type PaintState = { dim: boolean; foreground: string | null };

function applySgrPaint(parameters: string, initial: PaintState): PaintState {
  const values = (parameters === '' ? ['0'] : parameters.replaceAll(':', ';').split(';'))
    .map((part) => Number.parseInt(part.split(':', 1)[0] ?? '', 10));
  let dim = initial.dim;
  let foreground = initial.foreground;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];
    if (code === 38 || code === 48 || code === 58) {
      const colorMode = values[index + 1];
      if (colorMode === 2) {
        if (code === 38) {
          foreground = values.slice(index, index + 5).join(';');
        }
        index += 4;
      }
      else if (colorMode === 5) {
        if (code === 38) {
          foreground = values.slice(index, index + 3).join(';');
        }
        index += 2;
      }
      else if (code === 38) foreground = '38;unknown';
      continue;
    }
    if (code === 0) {
      dim = false;
      foreground = null;
    }
    else if (code === 2) dim = true;
    else if (code === 22) dim = false;
    else if ((code !== undefined && code >= 30 && code <= 37)
      || (code !== undefined && code >= 90 && code <= 97)) foreground = String(code);
    else if (code === 39) foreground = null;
  }
  return { dim, foreground };
}

/** Follow only SGR faint state across one physical tmux row. */
function dimPaintEvidence(raw: string, inherited: PaintState): DimPaintEvidence {
  let state = { ...inherited };
  let firstSemanticCellDim = false;
  let firstSemanticCellForeground = false;
  let firstSemanticCellForegroundKey: string | null = null;
  let hasSemanticCell = false;
  let allSemanticCellsUndim = true;
  const semanticForegroundKeys = new Set<string | null>();
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '\x1b') {
      const codePoint = raw.codePointAt(index);
      const char = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
      if (!hasSemanticCell && char !== '' && !/\s/u.test(char)) {
        hasSemanticCell = true;
        firstSemanticCellDim = state.dim;
        firstSemanticCellForeground = state.foreground !== null;
        firstSemanticCellForegroundKey = state.foreground;
      }
      if (char !== '' && !/\s/u.test(char)) {
        semanticForegroundKeys.add(state.foreground);
        if (state.dim) allSemanticCellsUndim = false;
      }
      index += char.length || 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === '[') {
      let end = index + 2;
      while (end < raw.length) {
        const code = raw.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= raw.length) break;
      if (raw[end] === 'm') state = applySgrPaint(raw.slice(index + 2, end), state);
      index = end + 1;
      continue;
    }
    if (next === ']') {
      let end = index + 2;
      while (end < raw.length) {
        if (raw[end] === '\x07') {
          end += 1;
          break;
        }
        if (raw[end] === '\x1b' && raw[end + 1] === '\\') {
          end += 2;
          break;
        }
        end += 1;
      }
      index = end;
      continue;
    }
    if (
      next === '(' || next === ')' || next === '*' || next === '+'
      || next === '-' || next === '.' || next === '/' || next === '#'
      || next === '%'
    ) index += 3;
    else index += 2;
  }
  return {
    firstSemanticCellDim,
    firstSemanticCellForeground,
    firstSemanticCellForegroundKey,
    semanticForegroundKeys: Object.freeze([...semanticForegroundKeys]),
    allSemanticCellsUndim,
    hasSemanticCell,
    endDim: state.dim,
    endForeground: state.foreground !== null,
    endForegroundKey: state.foreground,
  };
}

/** Accept only rows whose first semantic cell is painted as Codex detail. */
function dimDetailRows(header: string): (raw: string) => boolean {
  const headerPaint = dimPaintEvidence(header, { dim: false, foreground: null });
  let inherited = { dim: headerPaint.endDim, foreground: headerPaint.endForegroundKey };
  return (raw: string) => {
    const evidence = dimPaintEvidence(raw, inherited);
    inherited = { dim: evidence.endDim, foreground: evidence.endForegroundKey };
    return evidence.hasSemanticCell && evidence.firstSemanticCellDim;
  };
}

type ShellQuoteState = { single: boolean; double: boolean };

function updateShellQuotes(raw: string, quotes: ShellQuoteState): void {
  const text = stripTerminalControls(raw);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quotes.single) {
      if (char === "'") quotes.single = false;
    } else if (quotes.double) {
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        quotes.double = false;
      }
    } else {
      if (char === '\\') {
        i += 1;
      } else if (char === "'") {
        quotes.single = true;
      } else if (char === '"') {
        quotes.double = true;
      }
    }
  }
}

function commandDetailRows(header: string): {
  accepts: (raw: string, bodyOffset: number) => boolean;
  isContinuationDetail: (raw: string) => boolean;
} {
  const headerPaint = dimPaintEvidence(header, { dim: false, foreground: null });
  let inherited = { dim: headerPaint.endDim, foreground: headerPaint.endForegroundKey };
  const quotes: ShellQuoteState = { single: false, double: false };
  updateShellQuotes(header, quotes);

  return {
    accepts: (raw: string, _bodyOffset: number) => {
      const evidence = dimPaintEvidence(raw, inherited);
      inherited = { dim: evidence.endDim, foreground: evidence.endForegroundKey };
      const currentlyInQuotes = quotes.single || quotes.double;
      updateShellQuotes(raw, quotes);

      if (evidence.hasSemanticCell && evidence.firstSemanticCellDim) {
        return true;
      }

      // Soft-wrapped rows inside an unclosed command quote (e.g. bash multiline prompt)
      // where terminal wrap or capture pane omitted the leading faint SGR.
      if (
        currentlyInQuotes
        && evidence.hasSemanticCell
        && hasOnlyCompleteTerminalControls(raw)
      ) {
        return true;
      }

      return false;
    },
    isContinuationDetail: (raw: string) => {
      const evidence = dimPaintEvidence(raw, { dim: false, foreground: null });
      return evidence.hasSemanticCell && evidence.firstSemanticCellDim;
    },
  };
}

function foregroundPalette(raw: string): ReadonlySet<string> {
  const colors = new Set<string>();
  let state: PaintState = { dim: false, foreground: null };
  const sgr = /\x1b\[([0-9:;]*)m/gu;
  for (const match of raw.matchAll(sgr)) {
    state = applySgrPaint(match[1] ?? '', state);
    if (state.foreground !== null && state.foreground !== '38;unknown') {
      colors.add(state.foreground);
    }
  }
  return colors;
}

function ranDetailRows(header: string, commandFragment: string): {
  accepts: (raw: string) => boolean;
  sawDimDetail: () => boolean;
} {
  const headerPaint = dimPaintEvidence(header, { dim: false, foreground: null });
  let inherited = { dim: headerPaint.endDim, foreground: headerPaint.endForegroundKey };
  const commandColors = foregroundPalette(commandFragment);
  // A logical newline resets the command foreground. Therefore a following
  // RGB-painted row is continuation evidence only while the header actually
  // leaves one of its command colors active across the physical boundary.
  // This prevents unrelated coloured assistant prose from bridging a complete
  // `Ran ... \x1b[39m` header to a later faint row.
  let commandContinuationOpen = headerPaint.endForegroundKey !== null
    && commandColors.has(headerPaint.endForegroundKey);
  let sawDimDetail = false;
  return {
    accepts: (raw: string) => {
      const evidence = dimPaintEvidence(raw, inherited);
      inherited = { dim: evidence.endDim, foreground: evidence.endForegroundKey };
      if (!evidence.hasSemanticCell) return false;
      if (evidence.firstSemanticCellDim) {
        sawDimDetail = true;
        commandContinuationOpen = false;
        return true;
      }
      // A soft-wrapped command header remains RGB-painted (either inherited
      // across the row boundary or explicitly repainted by capture-pane -e).
      // Every semantic cell must stay in the command header's own palette;
      // arbitrary ANSI-coloured prose is not sufficient evidence.
      const usesOnlyCommandColors = evidence.firstSemanticCellForeground
        && evidence.firstSemanticCellForegroundKey !== null
        && evidence.semanticForegroundKeys.every((color) => (
          color !== null && commandColors.has(color)
        ));
      if (commandContinuationOpen && evidence.allSemanticCellsUndim && usesOnlyCommandColors) {
        commandContinuationOpen = evidence.endForegroundKey !== null
          && commandColors.has(evidence.endForegroundKey);
        return true;
      }
      commandContinuationOpen = false;
      return false;
    },
    sawDimDetail: () => sawDimDetail,
  };
}

/** A seal row paints no semantic cell and contains only safe separator chrome. */
function isSealRow(raw: string): boolean {
  return isBlankToolSeparator(raw);
}

function leadingBoundaryIsKnown(
  rawLines: readonly string[],
  line: number,
  scanStart: number,
  leadingEdgeSealed: boolean,
  previousCompletedEndLine: number | undefined,
): boolean {
  if (line === previousCompletedEndLine) return true;
  if (line === 0) return scanStart === 0 && leadingEdgeSealed;
  if (line <= scanStart) return false;
  return isSealRow(rawLines[line - 1] ?? '');
}

function exactFailureHeader(raw: string): boolean {
  return FAILURE_BULLET.test(raw) && /\x1b\[(?:0;)?1mRan\x1b\[0m /u.test(raw);
}

function isProtectedSemanticRow(
  raw: string,
  allowDimBoundaryPrefix = false,
): boolean {
  if (raw.length > MAX_ROW_CHARS || !hasOnlyCompleteTerminalControls(raw)) return true;
  const line = visible(raw).trim();
  if (line === '') return false;
  if (/^[›»](?:\s|$)/u.test(line)) return true;
  // The status tail is frequently soft-wrapped, so `esc to interrupt` may be
  // painted on the following physical row. The activity marker itself is the
  // protective evidence; requiring the tail on this row can hide a live
  // Working/Thinking corridor inside the preceding completed tool candidate.
  if (/^(?:◦|•|·)\s+(?:Working|Thinking|Reading|Waiting)\b/iu.test(line)) {
    return true;
  }
  if (/^\d+\s+background terminals?\b/iu.test(line)) return true;
  if (/\besc to interrupt\b/iu.test(line)) return true;
  if (/^(?:■|⚠|Warning\b|Error\b|FAILED\b|Approval\b|Approve\b|Allow\b|Deny\b|Do you want\b)/iu.test(line)) {
    // A command/prompt captured under a completed Waited/interaction event can
    // soft-wrap at column zero onto words that resemble a top-level boundary.
    // Override that lexical resemblance only for an explicitly faint body row
    // after another accepted detail row. Unpainted/coloured error and approval
    // UI, first-row ambiguity, live statuses, prompts, and event bullets all
    // remain protected by the guards above/below.
    if (!(allowDimBoundaryPrefix && DIM_ROW.test(raw))) return true;
  }
  if (/^─+\s*Worked for\b/u.test(line) || /^─{8,}$/u.test(line)) return true;
  if (exactFailureHeader(raw)) return true;
  // A top-level bullet is prose, status, or another event boundary—not output
  // owned by the preceding tool. Exact outer candidates are parsed before this
  // guard, so conservative protection here cannot suppress their own match.
  if (/^(?:◦|•|·)\s+/u.test(line)) return true;
  // Any other exact Codex event header is a hard protective boundary inside a
  // candidate. The outer scanner may classify it independently after a seal.
  return DIM_EVENT_PREFIX.test(raw) || SUCCESS_BULLET.test(raw);
}

type SealedBody = Readonly<{
  sourceEnd: number;
  proofEnd: number;
  bodyLines: readonly string[];
}>;

function sealedBody(
  rawLines: readonly string[],
  startLine: number,
  maxBlockLines: number,
  maxBlockChars: number,
  acceptsRow: (raw: string, bodyOffset: number) => boolean,
  allowDimBoundaryContinuation = false,
  isContinuationDetail?: (raw: string) => boolean,
): SealedBody | null {
  const maximumEnd = Math.min(rawLines.length, startLine + maxBlockLines + 1);
  const bodyLines: string[] = [];
  let candidateChars = rawLines[startLine]?.length ?? 0;
  if (candidateChars > maxBlockChars) return null;
  for (let line = startLine + 1; line < maximumEnd; line += 1) {
    const raw = rawLines[line] ?? '';
    if (isSealRow(raw)) {
      if (isContinuationDetail) {
        let nextLine = line + 1;
        while (nextLine < maximumEnd && isSealRow(rawLines[nextLine] ?? '')) {
          nextLine += 1;
        }

        if (nextLine < maximumEnd) {
          const nextRaw = rawLines[nextLine] ?? '';
          const nextIsProtected = isProtectedSemanticRow(
            nextRaw,
            allowDimBoundaryContinuation && bodyLines.length > 0,
          );
          const nextIsDetail = !nextIsProtected && isContinuationDetail(nextRaw);

          if (nextIsDetail) {
            for (let b = line; b < nextLine; b += 1) {
              const blankRaw = rawLines[b] ?? '';
              candidateChars += blankRaw.length;
              if (candidateChars > maxBlockChars) return null;
              bodyLines.push(blankRaw);
            }
            line = nextLine - 1;
            continue;
          }
        }
      }

      const sourceEnd = line;
      if (sourceEnd <= startLine || sourceEnd - startLine > maxBlockLines) return null;
      return { sourceEnd, proofEnd: line + 1, bodyLines };
    }
    candidateChars += raw.length;
    if (candidateChars > maxBlockChars) return null;
    if (isProtectedSemanticRow(
      raw,
      allowDimBoundaryContinuation && bodyLines.length > 0,
    ) || !acceptsRow(raw, bodyLines.length)) return null;
    bodyLines.push(raw);
  }
  return null;
}

function completedBlock(
  kind: ToolBlockKind,
  outcome: ToolBlockOutcome,
  sourceStart: number,
  sourceEnd: number,
  proofEnd: number,
  collapseRanges: readonly ToolLineRange[],
  protectedRanges: readonly ToolLineRange[],
  label: string,
  semanticParts: readonly string[],
): ToolCollapseBlock {
  const fingerprint = stableToolFingerprint('codex', kind, outcome, semanticParts);
  return Object.freeze({
    id: fingerprint,
    provider: 'codex',
    kind,
    outcome,
    sourceRange: range(sourceStart, sourceEnd),
    proofRange: range(sourceStart, proofEnd),
    collapseRanges: Object.freeze([...collapseRanges]),
    protectedRanges: Object.freeze([...protectedRanges]),
    fingerprint,
    label,
  });
}

function wholeBlock(
  kind: ToolBlockKind,
  outcome: ToolBlockOutcome,
  startLine: number,
  body: SealedBody,
  label: string,
  semanticParts: readonly string[],
): ToolCollapseBlock {
  return completedBlock(
    kind,
    outcome,
    startLine,
    body.sourceEnd,
    body.proofEnd,
    [range(startLine, body.sourceEnd)],
    [],
    label,
    semanticParts,
  );
}

function oneLineSealed(rawLines: readonly string[], startLine: number): SealedBody | null {
  const seal = rawLines[startLine + 1];
  return seal !== undefined && isSealRow(seal)
    ? { sourceEnd: startLine + 1, proofEnd: startLine + 2, bodyLines: [] }
    : null;
}

function waitingPair(
  rawLines: readonly string[],
  startLine: number,
  maxBlockLines: number,
  maxBlockChars: number,
): ToolCollapseBlock | null {
  if (!isSealRow(rawLines[startLine + 1] ?? '\x1b')) return null;
  const finishedLine = startLine + 2;
  if (AGENT_EVENT.exec(rawLines[finishedLine] ?? '')?.[1] !== 'Finished waiting') return null;
  const maximumEnd = Math.min(rawLines.length, startLine + maxBlockLines + 1);
  const semanticParts = ['Waiting for agents', 'Finished waiting'];
  let candidateChars = (rawLines[startLine]?.length ?? 0)
    + (rawLines[finishedLine]?.length ?? 0);
  if (candidateChars > maxBlockChars) return null;
  for (let line = finishedLine + 1; line < maximumEnd; line += 1) {
    const raw = rawLines[line] ?? '';
    if (isSealRow(raw)) {
      if (line - startLine > maxBlockLines) return null;
      return completedBlock(
        'agent-wait',
        'completed',
        startLine,
        line,
        line + 1,
        [range(startLine, line)],
        [],
        'Codex agent wait',
        semanticParts,
      );
    }
    candidateChars += raw.length;
    if (candidateChars > maxBlockChars) return null;
    if (
      !hasOnlyCompleteTerminalControls(raw)
      || isProtectedSemanticRow(raw)
      || !(TREE_DETAIL_RESET_MARKER.test(raw) || DIM_ROW.test(raw))
    ) return null;
    semanticParts.push(visible(raw));
  }
  return null;
}

function parseAt(
  rawLines: readonly string[],
  startLine: number,
  maxBlockLines: number,
  maxBlockChars: number,
): ToolCollapseBlock | null {
  const raw = rawLines[startLine] ?? '';
  if (
    raw.length > MAX_ROW_CHARS
    || raw.length > maxBlockChars
    || !hasOnlyCompleteTerminalControls(raw)
  ) return null;

  const group = RUN_GROUP.exec(raw);
  if (group) {
    const count = Number(group[1]);
    const plural = group[2] ?? '';
    if ((count === 1 && plural !== '') || (count !== 1 && plural !== 's')) return null;
    const sourceEnd = startLine + 1;
    return completedBlock(
      'run-group',
      'succeeded',
      startLine,
      sourceEnd,
      sourceEnd,
      [range(startLine, sourceEnd)],
      [],
      'Codex commands',
      [`Ran ${count} command${plural}`],
    );
  }

  const ran = RUN_SUCCESS.exec(raw);
  if (ran) {
    const detail = ranDetailRows(raw, ran[1] ?? '');
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      detail.accepts,
    );
    if (!body || body.bodyLines.length === 0 || !detail.sawDimDetail()) return null;
    return wholeBlock(
      'run',
      'succeeded',
      startLine,
      body,
      'Codex command',
      [ran[1] ?? '', ...body.bodyLines],
    );
  }

  const waited = WAITED.exec(raw);
  if (waited) {
    const detail = commandDetailRows(raw);
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      detail.accepts,
      true,
      detail.isContinuationDetail,
    );
    if (!body) return null;
    return wholeBlock(
      'background-wait',
      'completed',
      startLine,
      body,
      'Codex background wait',
      [waited[1] ?? '', ...body.bodyLines],
    );
  }

  const backgroundInteraction = BACKGROUND_INTERACTION.exec(raw);
  if (backgroundInteraction) {
    const detail = commandDetailRows(raw);
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      detail.accepts,
      true,
      detail.isContinuationDetail,
    );
    if (!body) return null;
    return wholeBlock(
      'background-interaction',
      'completed',
      startLine,
      body,
      'Codex background interaction',
      [backgroundInteraction[1] ?? '', ...body.bodyLines],
    );
  }

  const agentEvent = AGENT_EVENT.exec(raw)?.[1];
  if (agentEvent === 'Waiting for agents') {
    return waitingPair(rawLines, startLine, maxBlockLines, maxBlockChars);
  }
  if (agentEvent === 'Finished waiting') {
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      (line, offset) => offset === 0
        ? TREE_DETAIL_RESET_MARKER.test(line)
        : DIM_ROW.test(line),
    );
    if (!body) return null;
    return wholeBlock(
      'agent-wait',
      'completed',
      startLine,
      body,
      'Codex agent wait',
      ['Finished waiting', ...body.bodyLines],
    );
  }
  if (agentEvent === 'Viewed Image') {
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      (line, offset) => offset === 0 ? TREE_DETAIL.test(line) : DIM_ROW.test(line),
    );
    if (!body || body.bodyLines.length === 0) return null;
    return wholeBlock(
      'view-image',
      'completed',
      startLine,
      body,
      'Codex image',
      body.bodyLines,
    );
  }

  const interacted = AGENT_INTERACTION.exec(raw);
  if (interacted) {
    const body = oneLineSealed(rawLines, startLine);
    if (!body) return null;
    return wholeBlock(
      'agent-interaction',
      'completed',
      startLine,
      body,
      'Codex agent interaction',
      [interacted[1] ?? ''],
    );
  }

  const lifecycle = AGENT_LIFECYCLE.exec(raw);
  if (lifecycle) {
    const body = oneLineSealed(rawLines, startLine);
    if (!body) return null;
    const event = lifecycle[1] === 'Started' ? 'agent-start' : 'agent-complete';
    return wholeBlock(
      event,
      'completed',
      startLine,
      body,
      event === 'agent-start' ? 'Codex agent started' : 'Codex agent completed',
      [lifecycle[2] ?? ''],
    );
  }

  const edited = EDITED.exec(raw);
  if (edited) {
    const body = sealedBody(
      rawLines,
      startLine,
      maxBlockLines,
      maxBlockChars,
      dimDetailRows(raw),
    );
    if (!body || body.bodyLines.length === 0) return null;
    return completedBlock(
      'edit',
      'completed',
      startLine,
      body.sourceEnd,
      body.proofEnd,
      [range(startLine + 1, body.sourceEnd)],
      [range(startLine, startLine + 1)],
      'Codex edit details',
      [edited[1] ?? '', edited[2] ?? '', edited[3] ?? '', ...body.bodyLines],
    );
  }

  return null;
}

/** Detect only sealed, completed Codex tool/event blocks. */
export function detectCodexToolBlocks(
  rawLines: readonly string[],
  options: CodexToolDetectionOptions = {},
): CodexToolDetection {
  const maxScanLines = boundedInteger(options.maxScanLines, DEFAULT_MAX_SCAN_LINES, MAX_LIMIT);
  const maxBlockLines = boundedInteger(options.maxBlockLines, DEFAULT_MAX_BLOCK_LINES, MAX_LIMIT);
  const maxBlockChars = boundedInteger(
    options.maxBlockChars,
    DEFAULT_MAX_BLOCK_CHARS,
    MAX_BLOCK_CHARS,
  );
  const maxBlocks = boundedInteger(options.maxBlocks, DEFAULT_MAX_BLOCKS, MAX_LIMIT);
  const identityLineOffset = Number.isSafeInteger(options.identityLineOffset)
    ? Math.trunc(options.identityLineOffset ?? 0)
    : 0;
  const scanStart = Math.max(0, rawLines.length - maxScanLines);
  const scanRange = range(scanStart, rawLines.length);
  if ((options.screenMode ?? 'normal') !== 'normal') {
    return { provider: 'codex', blocks: [], scanRange, enabled: false };
  }
  if (maxScanLines === 0 || maxBlockLines === 0 || maxBlockChars === 0 || maxBlocks === 0) {
    return { provider: 'codex', blocks: [], scanRange, enabled: true };
  }

  const blocks: ToolCollapseBlock[] = [];
  let previousCompletedEndLine: number | undefined;
  for (let line = scanStart; line < rawLines.length; line += 1) {
    if (!leadingBoundaryIsKnown(
      rawLines,
      line,
      scanStart,
      options.leadingEdgeSealed === true,
      previousCompletedEndLine,
    )) continue;
    const block = parseAt(rawLines, line, maxBlockLines, maxBlockChars);
    if (!block) continue;
    const absoluteStart = identityLineOffset + block.sourceRange.startLine;
    if (!Number.isSafeInteger(absoluteStart)) continue;
    blocks.push(Object.freeze({
      ...block,
      id: `${block.fingerprint}:row-${absoluteStart}`,
    }));
    previousCompletedEndLine = block.sourceRange.endLine;
    line = Math.max(line, block.sourceRange.endLine - 1);
  }

  return {
    provider: 'codex',
    blocks: blocks.slice(-maxBlocks),
    scanRange,
    enabled: true,
  };
}
