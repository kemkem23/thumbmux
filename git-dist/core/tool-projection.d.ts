/**
 * Provider-neutral projection for collapsing proven terminal tool ranges.
 *
 * Detection and presentation intentionally stay separate. A detector must
 * prove the semantic source range and declare exactly which rows may collapse;
 * this projector validates that proof before changing a single visual row.
 * Invalid or overlapping evidence always fails open.
 */
export type ToolProvider = 'claude' | 'codex' | 'grok';
export type ToolBlockKind = 'run' | 'run-group' | 'background-wait' | 'background-interaction' | 'agent-wait' | 'agent-interaction' | 'agent-start' | 'agent-complete' | 'view-image' | 'edit';
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
    reason: 'invalid-identity' | 'invalid-source-range' | 'invalid-proof-range' | 'proof-does-not-cover-source' | 'invalid-collapse-range' | 'invalid-protected-range' | 'range-outside-source' | 'range-overlap' | 'source-not-fully-classified' | 'duplicate-id' | 'block-overlap';
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
/**
 * Carry occurrence ids across a repaint/reflow by matching semantic
 * fingerprints. Exact ids win (the prepend/evict path); when only physical row
 * counts changed, duplicate fingerprints are paired monotonically by source.
 * Exact matches divide independent corridors so no inferred pair can cross a
 * known occurrence identity.
 */
export declare function reconcileToolBlockIds(previousBlocks: readonly ToolCollapseBlock[], nextBlocks: readonly ToolCollapseBlock[]): readonly ToolCollapseBlock[];
/** Build an ANSI-independent, wrap-insensitive identity for detector output. */
export declare function stableToolFingerprint(provider: ToolProvider, kind: ToolBlockKind, outcome: ToolBlockOutcome, semanticParts: readonly string[]): string;
/** Validate all blocks together. Every participant in an overlap is rejected. */
export declare function validateToolCollapseBlocks(rawLines: readonly string[], blocks: readonly ToolCollapseBlock[]): ToolProjectionValidation;
/** Collapse only detector-declared ranges while preserving complete mappings. */
export declare function projectToolLines(rawLines: readonly string[], options: ToolProjectionOptions): ToolProjection;
