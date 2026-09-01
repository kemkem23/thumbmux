/**
 * Provider-neutral projection for collapsing proven terminal tool ranges.
 *
 * Detection and presentation intentionally stay separate. A detector must
 * prove the semantic source range and declare exactly which rows may collapse;
 * this projector validates that proof before changing a single visual row.
 * Invalid or overlapping evidence always fails open.
 */

import { stripTerminalControls } from './terminal-controls';

export type ToolProvider = 'claude' | 'codex' | 'grok';

export type ToolBlockKind =
  | 'run'
  | 'run-group'
  | 'background-wait'
  | 'background-interaction'
  | 'agent-wait'
  | 'agent-interaction'
  | 'agent-start'
  | 'agent-complete'
  | 'view-image'
  | 'edit';

export type ToolBlockOutcome = 'completed' | 'succeeded';

/** Half-open physical-line range in the unmodified source. */
export type ToolLineRange = Readonly<{
  startLine: number;
  endLine: number;
}>;

/**
 * A detector-owned proof that one semantic tool block is safe to project.
 *
 * `sourceRange` is the complete semantic block. `proofRange` may additionally
 * include a trailing seal row. The disjoint collapse/protected ranges must
 * cover every row of sourceRange exactly once; this prevents a projector from
 * guessing what an omitted corridor meant.
 */
export type ToolCollapseBlock = Readonly<{
  /**
   * Detector-owned occurrence identity. It must stay stable when retained rows
   * are prepended/evicted and must be unique among simultaneously projected
   * blocks. `fingerprint` may repeat; `id` may not.
   */
  id: string;
  provider: ToolProvider;
  kind: ToolBlockKind;
  outcome: ToolBlockOutcome;
  sourceRange: ToolLineRange;
  proofRange: ToolLineRange;
  collapseRanges: readonly ToolLineRange[];
  protectedRanges: readonly ToolLineRange[];
  /** ANSI-independent content identity, stable across terminal repaint. */
  fingerprint: string;
  /** Short visible description suitable for a placeholder. */
  label: string;
}>;

export type ToolProjectionRejection = Readonly<{
  block: ToolCollapseBlock;
  reason:
    | 'invalid-identity'
    | 'invalid-source-range'
    | 'invalid-proof-range'
    | 'proof-does-not-cover-source'
    | 'invalid-collapse-range'
    | 'invalid-protected-range'
    | 'range-outside-source'
    | 'range-overlap'
    | 'source-not-fully-classified'
    | 'duplicate-id'
    | 'block-overlap';
}>;

export type ToolProjectionValidation = Readonly<{
  acceptedBlocks: readonly ToolCollapseBlock[];
  rejectedBlocks: readonly ToolProjectionRejection[];
}>;

export type ToolProjectionRow = Readonly<{
  visualRow: number;
  kind: 'raw' | 'tool-placeholder';
  line: string;
  rawStart: number;
  rawEndExclusive: number;
  rawRange: ToolLineRange;
  block: ToolCollapseBlock | null;
  fingerprint: string | null;
  /** Stable across source-row shifts; never contains raw coordinates. */
  placeholderKey: string | null;
}>;

export type ToolProjection = Readonly<{
  /** Exact source object supplied by the caller. */
  rawLines: readonly string[];
  /** Exact `rawLines` object when disabled or when no block is accepted. */
  lines: readonly string[];
  rows: readonly ToolProjectionRow[];
  visualToRawRange: readonly ToolLineRange[];
  visualToRaw: readonly ToolLineRange[];
  rawToVisualRow: readonly number[];
  rawToVisual: readonly number[];
  projectedBlocks: readonly ToolCollapseBlock[];
  rejectedBlocks: readonly ToolProjectionRejection[];
  hiddenLineCount: number;
}>;

export type ToolPlaceholderContext = Readonly<{
  block: ToolCollapseBlock;
  collapseRange: ToolLineRange;
  collapseIndex: number;
  lineCount: number;
  placeholderKey: string;
}>;

export type ToolProjectionOptions = Readonly<{
  blocks: readonly ToolCollapseBlock[];
  /** Set false for an exact identity projection. Default: true. */
  enabled?: boolean;
  placeholder?: (context: ToolPlaceholderContext) => string;
}>;

type PreviousOccurrence = Readonly<{
  block: ToolCollapseBlock;
  startLine: number;
  order: number;
}>;

type NextOccurrence = Readonly<{
  nextIndex: number;
  startLine: number;
  order: number;
}>;

type SourcePair = Readonly<{
  previous: ToolCollapseBlock;
  nextIndex: number;
}>;

// TermView retains at most 512 blocks. Keep the exact min-cost matrix bounded
// at that production envelope; larger public-API inputs use the monotonic
// linear fallback below instead of allocating an unbounded O(n*m) table.
const MAX_RECONCILE_DP_CELLS = 512 * 512;

/**
 * Select one increasing subset of `larger` for every item in `smaller`.
 * The bounded path minimizes total absolute source distance exactly. On equal
 * cost it skips the later candidate, making ties prefer the earlier source.
 */
function selectMonotonicIndices(
  larger: readonly number[],
  smaller: readonly number[],
): readonly number[] {
  if (smaller.length === 0) return [];
  if (larger.length === smaller.length) return larger.map((_, index) => index);

  if (larger.length * smaller.length <= MAX_RECONCILE_DP_CELLS) {
    const columns = smaller.length + 1;
    const decisions = new Uint8Array((larger.length + 1) * columns);
    let previousCosts = new Float64Array(columns);
    let currentCosts = new Float64Array(columns);
    previousCosts.fill(Number.POSITIVE_INFINITY);
    previousCosts[0] = 0;

    for (let largerIndex = 1; largerIndex <= larger.length; largerIndex += 1) {
      currentCosts.fill(Number.POSITIVE_INFINITY);
      currentCosts[0] = 0;
      const reachable = Math.min(largerIndex, smaller.length);
      for (let smallerIndex = 1; smallerIndex <= reachable; smallerIndex += 1) {
        const skipCost = previousCosts[smallerIndex] ?? Number.POSITIVE_INFINITY;
        const matchCost = (previousCosts[smallerIndex - 1] ?? Number.POSITIVE_INFINITY)
          + Math.abs(
            (larger[largerIndex - 1] ?? 0) - (smaller[smallerIndex - 1] ?? 0),
          );
        if (matchCost < skipCost) {
          currentCosts[smallerIndex] = matchCost;
          decisions[largerIndex * columns + smallerIndex] = 1;
        }
        else currentCosts[smallerIndex] = skipCost;
      }
      [previousCosts, currentCosts] = [currentCosts, previousCosts];
    }

    const selected = Array<number>(smaller.length);
    let largerIndex = larger.length;
    let smallerIndex = smaller.length;
    while (smallerIndex > 0 && largerIndex > 0) {
      if (decisions[largerIndex * columns + smallerIndex] === 1) {
        selected[smallerIndex - 1] = largerIndex - 1;
        smallerIndex -= 1;
      }
      largerIndex -= 1;
    }
    return selected;
  }

  // Bounded-memory fallback for inputs beyond the UI retention envelope.
  // Greedily advance to the nearest candidate while reserving enough later
  // occurrences for the remaining matches. Order can therefore never cross.
  const selected: number[] = [];
  let cursor = 0;
  for (let smallerIndex = 0; smallerIndex < smaller.length; smallerIndex += 1) {
    const maximum = larger.length - (smaller.length - smallerIndex);
    const target = smaller[smallerIndex] ?? 0;
    while (cursor < maximum) {
      const currentDistance = Math.abs((larger[cursor] ?? 0) - target);
      const nextDistance = Math.abs((larger[cursor + 1] ?? 0) - target);
      if (nextDistance >= currentDistance) break;
      cursor += 1;
    }
    selected.push(cursor);
    cursor += 1;
  }
  return selected;
}

/** Pair one anchor-bounded corridor without ever crossing source order. */
function monotonicSourcePairs(
  previous: readonly PreviousOccurrence[],
  next: readonly NextOccurrence[],
): readonly SourcePair[] {
  if (previous.length === 0 || next.length === 0) return [];
  if (previous.length >= next.length) {
    const selectedPrevious = selectMonotonicIndices(
      previous.map(({ startLine }) => startLine),
      next.map(({ startLine }) => startLine),
    );
    return next.flatMap((nextOccurrence, index) => {
      const previousOccurrence = previous[selectedPrevious[index] ?? -1];
      return previousOccurrence
        ? [{ previous: previousOccurrence.block, nextIndex: nextOccurrence.nextIndex }]
        : [];
    });
  }

  const selectedNext = selectMonotonicIndices(
    next.map(({ startLine }) => startLine),
    previous.map(({ startLine }) => startLine),
  );
  return previous.flatMap((previousOccurrence, index) => {
    const nextOccurrence = next[selectedNext[index] ?? -1];
    return nextOccurrence
      ? [{ previous: previousOccurrence.block, nextIndex: nextOccurrence.nextIndex }]
      : [];
  });
}

function sortedPreviousOccurrences(
  blocks: readonly ToolCollapseBlock[],
): readonly PreviousOccurrence[] {
  return blocks.map((block, order) => ({
    block,
    order,
    startLine: block.sourceRange.startLine,
  })).filter(({ startLine }) => Number.isSafeInteger(startLine))
    .sort((left, right) => left.startLine - right.startLine || left.order - right.order);
}

function sortedNextOccurrences(
  indexes: readonly number[],
  nextBlocks: readonly ToolCollapseBlock[],
): readonly NextOccurrence[] {
  return indexes.map((nextIndex, order) => ({
    nextIndex,
    order,
    startLine: nextBlocks[nextIndex]?.sourceRange.startLine ?? Number.NaN,
  })).filter(({ startLine }) => Number.isSafeInteger(startLine))
    .sort((left, right) => left.startLine - right.startLine || left.order - right.order);
}

function detectorPhysicalRow(block: ToolCollapseBlock): number | null {
  const prefix = `${block.fingerprint}:row-`;
  if (!block.id.startsWith(prefix)) return null;
  const row = Number(block.id.slice(prefix.length));
  return Number.isSafeInteger(row) ? row : null;
}

// Reconciled blocks carry an older occurrence id, so parsing that public id on
// the next frame would manufacture a false origin change. Keep the detector's
// original physical origin beside the immutable object without widening the
// public contract. Weak keys make the temporal metadata lifecycle-bounded.
const detectorOriginByBlock = new WeakMap<ToolCollapseBlock, number | null>();

function detectorOrigin(block: ToolCollapseBlock): number | null {
  if (detectorOriginByBlock.has(block)) return detectorOriginByBlock.get(block) ?? null;
  const absoluteRow = detectorPhysicalRow(block);
  const origin = absoluteRow === null
    ? null
    : absoluteRow - block.sourceRange.startLine;
  const safeOrigin = origin !== null && Number.isSafeInteger(origin) ? origin : null;
  detectorOriginByBlock.set(block, safeOrigin);
  return safeOrigin;
}

function occurrenceLookupId(block: ToolCollapseBlock): string {
  const origin = detectorOrigin(block);
  const absoluteRow = origin === null ? null : origin + block.sourceRange.startLine;
  return absoluteRow !== null && Number.isSafeInteger(absoluteRow)
    ? `${block.fingerprint}:row-${absoluteRow}`
    : block.id;
}

function commonDetectorOrigin(
  occurrences: readonly (PreviousOccurrence | NextOccurrence)[],
  blockAt: (occurrence: PreviousOccurrence | NextOccurrence) => ToolCollapseBlock | undefined,
): number | null {
  let common: number | null = null;
  for (const occurrence of occurrences) {
    const block = blockAt(occurrence);
    if (!block) return null;
    const origin = detectorOrigin(block);
    if (origin === null) return null;
    if (common === null) common = origin;
    else if (common !== origin) return null;
  }
  return common;
}

/**
 * Carry occurrence ids across a repaint/reflow by matching semantic
 * fingerprints. Exact ids win (the prepend/evict path); when only physical row
 * counts changed, duplicate fingerprints are paired monotonically by source.
 * Exact matches divide independent corridors so no inferred pair can cross a
 * known occurrence identity.
 */
export function reconcileToolBlockIds(
  previousBlocks: readonly ToolCollapseBlock[],
  nextBlocks: readonly ToolCollapseBlock[],
): readonly ToolCollapseBlock[] {
  if (previousBlocks.length === 0 || nextBlocks.length === 0) return nextBlocks;

  const previousById = new Map(previousBlocks.map((block) => [
    occurrenceLookupId(block),
    block,
  ]));
  const exactCandidateByNext = new Map<number, ToolCollapseBlock>();
  const forceFreshNext = new Set<number>();
  const assigned = Array<string | null>(nextBlocks.length).fill(null);
  nextBlocks.forEach((block, index) => {
    const exact = previousById.get(occurrenceLookupId(block));
    if (exact?.fingerprint === block.fingerprint) exactCandidateByNext.set(index, exact);
  });

  const previousByFingerprint = new Map<string, ToolCollapseBlock[]>();
  for (const block of previousBlocks) {
    const group = previousByFingerprint.get(block.fingerprint);
    if (group) group.push(block);
    else previousByFingerprint.set(block.fingerprint, [block]);
  }
  const nextByFingerprint = new Map<string, number[]>();
  nextBlocks.forEach((block, index) => {
    const group = nextByFingerprint.get(block.fingerprint);
    if (group) group.push(index);
    else nextByFingerprint.set(block.fingerprint, [index]);
  });

  for (const [fingerprint, nextIndexes] of nextByFingerprint) {
    const previous = sortedPreviousOccurrences(previousByFingerprint.get(fingerprint) ?? []);
    const next = sortedNextOccurrences(nextIndexes, nextBlocks);
    if (previous.length === 0 || next.length === 0) continue;

    const previousPosition = new Map(previous.map((occurrence, index) => [
      occurrence.block,
      index,
    ]));
    const nextPosition = new Map(next.map((occurrence, index) => [
      occurrence.nextIndex,
      index,
    ]));
    const previousOrigin = commonDetectorOrigin(previous, (occurrence) => (
      'block' in occurrence ? occurrence.block : undefined
    ));
    const nextOrigin = commonDetectorOrigin(next, (occurrence) => (
      'nextIndex' in occurrence ? nextBlocks[occurrence.nextIndex] : undefined
    ));
    const detectorOriginChanged = previousOrigin !== null
      && nextOrigin !== null
      && previousOrigin !== nextOrigin;
    const anchors = nextIndexes.flatMap((nextIndex) => {
      const exact = exactCandidateByNext.get(nextIndex);
      const previousIndex = exact ? previousPosition.get(exact) : undefined;
      const nextIndexInOrder = nextPosition.get(nextIndex);
      const nextBlock = nextBlocks[nextIndex];
      const detectorRowCandidate = exact !== undefined
        && nextBlock !== undefined
        && detectorPhysicalRow(exact) !== null
        && detectorPhysicalRow(nextBlock) !== null;
      const unchangedDetectorOccurrence = detectorRowCandidate
        && previousOrigin !== null
        && nextOrigin !== null
        && previousOrigin === nextOrigin
        && previousIndex !== undefined
        && nextIndexInOrder !== undefined
        && previousIndex === nextIndexInOrder;
      if (detectorRowCandidate && !detectorOriginChanged && !unchangedDetectorOccurrence) {
        return [];
      }
      return previousIndex !== undefined
        && nextIndexInOrder !== undefined
        ? [{ previousIndex, nextIndex: nextIndexInOrder }]
        : [];
    }).sort((left, right) => left.previousIndex - right.previousIndex);

    // When the detector origin is unchanged, exact-looking row ids are only
    // physical collisions. Equal cardinality gives a complete monotonic source
    // pairing and is stronger than those ambiguous ids.
    if (previous.length === next.length && anchors.length === 0) {
      for (const pair of monotonicSourcePairs(previous, next)) {
        assigned[pair.nextIndex] = pair.previous.id;
      }
      continue;
    }

    // Crossing or duplicate exact-looking candidates are physical-row
    // collisions, not trustworthy anchors. Drop the preference and solve the
    // group globally rather than allowing any inferred identity to cross.
    const anchorsAreMonotonic = !anchors.some((anchor, index) => index > 0 && (
      anchor.previousIndex <= (anchors[index - 1]?.previousIndex ?? -1)
      || anchor.nextIndex <= (anchors[index - 1]?.nextIndex ?? -1)
    ));
    const acceptedAnchors = anchorsAreMonotonic ? anchors : [];
    const acceptedAnchorNext = new Set(acceptedAnchors.map((anchor) => (
      next[anchor.nextIndex]?.nextIndex
    )).filter((nextIndex): nextIndex is number => nextIndex !== undefined));
    const rejectedExactNext: number[] = [];
    for (const nextIndex of nextIndexes) {
      if (exactCandidateByNext.has(nextIndex) && !acceptedAnchorNext.has(nextIndex)) {
        rejectedExactNext.push(nextIndex);
      }
    }
    for (const anchor of acceptedAnchors) {
      const previousOccurrence = previous[anchor.previousIndex];
      const nextOccurrence = next[anchor.nextIndex];
      if (previousOccurrence && nextOccurrence) {
        assigned[nextOccurrence.nextIndex] = previousOccurrence.block.id;
      }
    }

    let previousCursor = 0;
    let nextCursor = 0;
    const corridorEnds = [
      ...acceptedAnchors,
      { previousIndex: previous.length, nextIndex: next.length },
    ];
    for (const end of corridorEnds) {
      const previousCorridor = previous.slice(previousCursor, end.previousIndex);
      const nextCorridor = next.slice(nextCursor, end.nextIndex);
      for (const pair of monotonicSourcePairs(previousCorridor, nextCorridor)) {
        if (assigned[pair.nextIndex] === null) assigned[pair.nextIndex] = pair.previous.id;
      }
      previousCursor = end.previousIndex + 1;
      nextCursor = end.nextIndex + 1;
    }
    // An exact-looking physical collision is harmless when the monotonic
    // source matcher assigned that next occurrence a real predecessor. Only a
    // still-unmatched collision needs a fresh id to avoid stealing a DOM key.
    for (const nextIndex of rejectedExactNext) {
      if (assigned[nextIndex] === null) forceFreshNext.add(nextIndex);
    }
  }

  const reservedAssignedIds = new Map<string, number>();
  assigned.forEach((id, index) => {
    if (id !== null && !forceFreshNext.has(index)) reservedAssignedIds.set(id, index);
  });
  const seen = new Set<string>();
  return nextBlocks.map((block, index) => {
    const physicalOrigin = detectorOrigin(block);
    let id = assigned[index] ?? block.id;
    // A new/unmatched occurrence can itself carry a provisional physical-row
    // id reserved for an older reconciled occurrence. Preserve the carried id
    // and deterministically disambiguate the new occurrence instead.
    if (forceFreshNext.has(index)
      || (assigned[index] === null && reservedAssignedIds.get(id) !== undefined)
      || seen.has(id)
    ) {
      const base = `${block.id}:provisional-${block.sourceRange.startLine}-${index}`;
      id = base;
      let suffix = 1;
      while (seen.has(id) || reservedAssignedIds.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    seen.add(id);
    const reconciled = id === block.id ? block : Object.freeze({ ...block, id });
    detectorOriginByBlock.set(reconciled, physicalOrigin);
    return reconciled;
  });
}

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Build an ANSI-independent, wrap-insensitive identity for detector output. */
export function stableToolFingerprint(
  provider: ToolProvider,
  kind: ToolBlockKind,
  outcome: ToolBlockOutcome,
  semanticParts: readonly string[],
): string {
  // Physical tmux rows do not carry reliable soft-wrap provenance: a long URL
  // may be split without a space at one width and remain contiguous at another.
  // Whitespace therefore cannot participate in the content identity. This is
  // a repaint key, not a user-visible digest; occurrence identity lives in id.
  const normalizedContent = semanticParts.map((part) => stripTerminalControls(part))
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, '');
  const normalized = [provider, kind, outcome, normalizedContent].join('\u0000');
  const first = fnv1a32(normalized, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a32(normalized, 0x9e3779b9).toString(16).padStart(8, '0');
  return `tool-v1-${first}${second}`;
}

function range(startLine: number, endLine: number): ToolLineRange {
  return Object.freeze({ startLine, endLine });
}

function validRange(candidate: ToolLineRange, lineCount: number): boolean {
  return Number.isSafeInteger(candidate.startLine)
    && Number.isSafeInteger(candidate.endLine)
    && candidate.startLine >= 0
    && candidate.startLine < candidate.endLine
    && candidate.endLine <= lineCount;
}

function contains(outer: ToolLineRange, inner: ToolLineRange): boolean {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function overlaps(left: ToolLineRange, right: ToolLineRange): boolean {
  return left.startLine < right.endLine && right.startLine < left.endLine;
}

function orderedWithoutOverlap(ranges: readonly ToolLineRange[]): boolean {
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current || previous.endLine > current.startLine) return false;
  }
  return true;
}

function classifyOne(
  block: ToolCollapseBlock,
  lineCount: number,
): ToolProjectionRejection['reason'] | null {
  if (block.id.trim() === '' || block.fingerprint.trim() === '' || block.label.trim() === '') {
    return 'invalid-identity';
  }
  if (!validRange(block.sourceRange, lineCount)) return 'invalid-source-range';
  if (!validRange(block.proofRange, lineCount)) return 'invalid-proof-range';
  if (!contains(block.proofRange, block.sourceRange)) return 'proof-does-not-cover-source';
  if (block.collapseRanges.length === 0) return 'invalid-collapse-range';
  if (block.collapseRanges.some((candidate) => !validRange(candidate, lineCount))) {
    return 'invalid-collapse-range';
  }
  if (block.protectedRanges.some((candidate) => !validRange(candidate, lineCount))) {
    return 'invalid-protected-range';
  }
  const allRanges = [...block.collapseRanges, ...block.protectedRanges];
  if (allRanges.some((candidate) => !contains(block.sourceRange, candidate))) {
    return 'range-outside-source';
  }
  if (
    !orderedWithoutOverlap(block.collapseRanges)
    || !orderedWithoutOverlap(block.protectedRanges)
  ) return 'range-overlap';

  const ordered = [...allRanges].sort((left, right) => left.startLine - right.startLine);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current || overlaps(previous, current)) return 'range-overlap';
  }
  let cursor = block.sourceRange.startLine;
  for (const candidate of ordered) {
    if (candidate.startLine !== cursor) return 'source-not-fully-classified';
    cursor = candidate.endLine;
  }
  return cursor === block.sourceRange.endLine ? null : 'source-not-fully-classified';
}

/** Validate all blocks together. Every participant in an overlap is rejected. */
export function validateToolCollapseBlocks(
  rawLines: readonly string[],
  blocks: readonly ToolCollapseBlock[],
): ToolProjectionValidation {
  const rejectedByIndex = new Map<number, ToolProjectionRejection['reason']>();
  blocks.forEach((block, index) => {
    const reason = classifyOne(block, rawLines.length);
    if (reason) rejectedByIndex.set(index, reason);
  });

  const individuallyInvalid = new Set(rejectedByIndex.keys());

  const idOwners = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    if (individuallyInvalid.has(index)) return;
    const owners = idOwners.get(block.id);
    if (owners) owners.push(index);
    else idOwners.set(block.id, [index]);
  });
  for (const owners of idOwners.values()) {
    if (owners.length < 2) continue;
    for (const index of owners) rejectedByIndex.set(index, 'duplicate-id');
  }

  // Interval sweep: every overlapping interval is marked while avoiding the
  // quadratic all-pairs scan that can freeze a large retained projection.
  const orderedBlocks = blocks.flatMap((block, index) => (
    individuallyInvalid.has(index)
      ? []
      : [{ block, index }]
  )).sort((left, right) => (
    left.block.sourceRange.startLine - right.block.sourceRange.startLine
    || right.block.sourceRange.endLine - left.block.sourceRange.endLine
  ));
  let furthest: { block: ToolCollapseBlock; index: number } | null = null;
  for (const current of orderedBlocks) {
    if (furthest && overlaps(furthest.block.sourceRange, current.block.sourceRange)) {
      rejectedByIndex.set(furthest.index, 'block-overlap');
      rejectedByIndex.set(current.index, 'block-overlap');
    }
    if (!furthest || current.block.sourceRange.endLine > furthest.block.sourceRange.endLine) {
      furthest = current;
    }
  }

  const acceptedBlocks = blocks
    .filter((_, index) => !rejectedByIndex.has(index))
    .slice()
    .sort((left, right) => left.sourceRange.startLine - right.sourceRange.startLine);
  const rejectedBlocks = blocks.flatMap((block, index) => {
    const reason = rejectedByIndex.get(index);
    return reason ? [{ block, reason } as const] : [];
  });
  return { acceptedBlocks, rejectedBlocks };
}

function defaultPlaceholder(context: ToolPlaceholderContext): string {
  return `${context.block.label} ซ่อนอยู่ · ${context.lineCount} แถว`;
}

function rawProjectionRows(rawLines: readonly string[]): ToolProjectionRow[] {
  return rawLines.map((line, rawRow) => ({
    visualRow: rawRow,
    kind: 'raw',
    line,
    rawStart: rawRow,
    rawEndExclusive: rawRow + 1,
    rawRange: range(rawRow, rawRow + 1),
    block: null,
    fingerprint: null,
    placeholderKey: null,
  }));
}

/** Collapse only detector-declared ranges while preserving complete mappings. */
export function projectToolLines(
  rawLines: readonly string[],
  options: ToolProjectionOptions,
): ToolProjection {
  if (options.enabled === false) {
    const rows = rawProjectionRows(rawLines);
    const visualToRawRange = rows.map((row) => row.rawRange);
    const rawToVisualRow = rows.map((row) => row.visualRow);
    return {
      rawLines,
      lines: rawLines,
      rows,
      visualToRawRange,
      visualToRaw: visualToRawRange,
      rawToVisualRow,
      rawToVisual: rawToVisualRow,
      projectedBlocks: [],
      rejectedBlocks: [],
      hiddenLineCount: 0,
    };
  }

  const validation = validateToolCollapseBlocks(rawLines, options.blocks);
  if (validation.acceptedBlocks.length === 0) {
    const rows = rawProjectionRows(rawLines);
    const visualToRawRange = rows.map((row) => row.rawRange);
    const rawToVisualRow = rows.map((row) => row.visualRow);
    return {
      rawLines,
      lines: rawLines,
      rows,
      visualToRawRange,
      visualToRaw: visualToRawRange,
      rawToVisualRow,
      rawToVisual: rawToVisualRow,
      projectedBlocks: [],
      rejectedBlocks: validation.rejectedBlocks,
      hiddenLineCount: 0,
    };
  }

  type CollapseEntry = Readonly<{
    block: ToolCollapseBlock;
    collapseRange: ToolLineRange;
    collapseIndex: number;
  }>;
  const collapseAt = new Map<number, CollapseEntry>();
  for (const block of validation.acceptedBlocks) {
    block.collapseRanges.forEach((collapseRange, collapseIndex) => {
      collapseAt.set(collapseRange.startLine, {
        block,
        collapseRange,
        collapseIndex,
      });
    });
  }

  const rows: ToolProjectionRow[] = [];
  const rawToVisualRow = Array<number>(rawLines.length);
  let hiddenLineCount = 0;
  for (let rawRow = 0; rawRow < rawLines.length;) {
    const entry = collapseAt.get(rawRow);
    if (!entry) {
      const visualRow = rows.length;
      const rawRange = range(rawRow, rawRow + 1);
      rows.push({
        visualRow,
        kind: 'raw',
        line: rawLines[rawRow] ?? '',
        rawStart: rawRow,
        rawEndExclusive: rawRow + 1,
        rawRange,
        block: null,
        fingerprint: null,
        placeholderKey: null,
      });
      rawToVisualRow[rawRow] = visualRow;
      rawRow += 1;
      continue;
    }

    const visualRow = rows.length;
    const lineCount = entry.collapseRange.endLine - entry.collapseRange.startLine;
    const placeholderKey = `tool-placeholder:${entry.block.provider}:`
      + `${entry.block.id}:part-${entry.collapseIndex}`;
    const context: ToolPlaceholderContext = {
      block: entry.block,
      collapseRange: entry.collapseRange,
      collapseIndex: entry.collapseIndex,
      lineCount,
      placeholderKey,
    };
    rows.push({
      visualRow,
      kind: 'tool-placeholder',
      line: (options.placeholder ?? defaultPlaceholder)(context),
      rawStart: entry.collapseRange.startLine,
      rawEndExclusive: entry.collapseRange.endLine,
      rawRange: entry.collapseRange,
      block: entry.block,
      fingerprint: entry.block.fingerprint,
      placeholderKey,
    });
    for (
      let hiddenRow = entry.collapseRange.startLine;
      hiddenRow < entry.collapseRange.endLine;
      hiddenRow += 1
    ) rawToVisualRow[hiddenRow] = visualRow;
    hiddenLineCount += lineCount;
    rawRow = entry.collapseRange.endLine;
  }

  const lines = rows.map((row) => row.line);
  const visualToRawRange = rows.map((row) => row.rawRange);
  return {
    rawLines,
    lines,
    rows,
    visualToRawRange,
    visualToRaw: visualToRawRange,
    rawToVisualRow,
    rawToVisual: rawToVisualRow,
    projectedBlocks: validation.acceptedBlocks,
    rejectedBlocks: validation.rejectedBlocks,
    hiddenLineCount,
  };
}
