/** Local L2-C ports; the integration lane adapts these to the L1 writer. */
export interface HistoryCell {
    grapheme: string;
    width: 0 | 1 | 2;
    continuation: boolean;
    fg: string;
    bg: string;
    style: number;
}
export interface HistoryRow {
    lineId: number;
    sourceEpoch: number;
    geometryGeneration: number;
    cells: readonly HistoryCell[];
    softWrap: boolean;
}
export interface CapturedRow {
    cells: readonly HistoryCell[];
    softWrap: boolean;
}
export declare function cellKey(cell: HistoryCell): string;
/** Cell equality; style bits outside `styleMask` are not compared. */
export declare function equalCells(a: HistoryCell, b: HistoryCell, styleMask?: number): boolean;
/** Rows projected to the style bits a comparator may certify. For matching
 * only: the projection is never stored as, or drawn instead of, the capture. */
export declare function certifiedRows(rows: readonly CapturedRow[], styleMask: number): CapturedRow[];
export declare function rowKey(row: CapturedRow): string;
export interface RowMatch {
    /** Rows inside a triple that is unique and aligned in both the parser ring
     * and the capture. Only these carry an identity claim (D16 identityFalse). */
    checks: Array<{
        lineId: number;
        capturedRow: number;
    }>;
    /** Rows whose cells equal the aligned capture row but that no unique triple
     * covers (blank runs, repeated prompts). Content is proven, hidden identity
     * is not: FIX1-PLAN §2 `content-matched`, measured by contentFalse only. */
    contentMatches: Array<{
        lineId: number;
        capturedRow: number;
    }>;
    repairs: Array<{
        lineId: number;
        capturedRow: number;
        row: CapturedRow;
    }>;
    reason: 'matched' | 'ambiguous' | 'partial-tail' | 'generation' | 'no-anchor';
}
export type MatchScope = {
    sourceEpoch: number;
    geometryGeneration: number;
    completeRetainedTail: boolean;
    maxTailGap?: number;
    /** Captured rows whose cell boundaries tmux does not serialize exactly
     * (decoder row isolation). They never equal anything, so they are neither
     * checked, content-matched, nor part of an anchor. */
    uncertainCapturedRows?: ReadonlySet<number>;
};
/** Hash buckets are only an accelerator: exact cell comparison assigns IDs.
 * Nothing is cached across calls, so mutable caller rows cannot retain stale keys. */
export declare function equalHistoryRows(a: CapturedRow, b: CapturedRow): boolean;
/** Only full retained captures certify uniqueness. A reduced tail is never a
 * substitute for evidence about the unseen ring, even if receiveSeq advanced. */
export declare function matchHistoryRows(recent: readonly HistoryRow[], captured: readonly CapturedRow[], scope: MatchScope): RowMatch;
/** A committed full capture seeds this chain. Partial captures must overlap a
 * previously checked, still exact, unique triple. Never infer across a gap.
 * The host must reset on every clear/resize/epoch transition and only remember
 * successful transactions. Receipts certify observed content, not hidden IDs. */
export declare class IncrementalHistoryMatcher {
    private checked;
    private generation;
    reset(): void;
    match(recent: readonly HistoryRow[], captured: readonly CapturedRow[], scope: MatchScope): RowMatch;
    remember(recent: readonly HistoryRow[], captured: readonly CapturedRow[], match: RowMatch): void;
}
