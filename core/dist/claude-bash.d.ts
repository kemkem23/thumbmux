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
export type ClaudeBashSummaries = ReadonlyMap<string, string> | Readonly<Record<string, string>>;
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
/** Detect high-confidence top-level Claude Code Bash blocks in physical rows. */
export declare function detectClaudeBashBlocks(rawLines: readonly string[], options?: ClaudeBashDetectionOptions): ClaudeBashDetection;
/**
 * Merge adjacent detected calls into semantic Bash groups without touching raw
 * terminal data. Direct adjacency and ANSI/NBSP-normalized blank-only gaps join;
 * semantic rows and caller-supplied retention barriers always split.
 */
export declare function groupClaudeBashBlocks(rawLines: readonly string[], detectedBlocks: readonly ClaudeBashBlock[], options?: ClaudeBashGroupingOptions): readonly ClaudeBashGroup[];
/**
 * Collapse semantic Bash groups into one visual row while retaining every raw
 * source line and a total raw↔visual mapping. This additive entry point keeps
 * the legacy per-block projection contract unchanged.
 */
export declare function projectClaudeBashGroupedLines(rawLines: readonly string[], options: ClaudeBashGroupedProjectionOptions): ClaudeBashGroupedProjection;
/**
 * Collapse detected Bash ranges into one visual row while retaining every raw
 * source line and a total raw↔visual mapping. Summary arrival only changes the
 * placeholder text; it cannot change row count or source ranges.
 */
export declare function projectClaudeBashLines(rawLines: readonly string[], options: ClaudeBashProjectionOptions): ClaudeBashProjection;
