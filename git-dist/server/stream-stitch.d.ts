import { type CaptureWindow, type PipeWindow, type RowOrigin, type StitchPort, type StitchProofs, type StitchResult, type StitchRow, type StitchWindow, type CapturePacket } from './stream-contract.js';
/** Stitch v1 (DESIGN-FINAL §4). Text is never identity: a candidate alignment
 * is only a proposal, and a row may be published only behind a seam proof.
 * Several alignments mean NO alignment; the result is a labelled gap, never
 * the first/longest/best-scoring match. Pure: no I/O, no clock other than the
 * injected one, bounded by the policy's candidate and time budgets. */
export declare const STITCH_VERSION: 1;
/** Canonical bytes of one physical row. Nothing is trimmed, normalized or
 * stripped: spaces, combining marks and styles are all part of identity. */
export declare function stitchRowCanonical(row: StitchRow, withWrap?: boolean): string;
/** SHA-256 key over the full canonical row, wrap status included. */
export declare function stitchRowKey(row: StitchRow, hash?: (text: string) => string): string;
export declare function isBlankRow(row: StitchRow): boolean;
export interface SeamCandidate {
    /** Rows of the right window [0, end) overlap the left window's suffix. */
    readonly end: number;
    readonly overlap: number;
}
export type CandidateSearch = {
    readonly kind: 'done';
    readonly candidates: readonly SeamCandidate[];
} | {
    readonly kind: 'limit';
    readonly count: number;
} | {
    readonly kind: 'deadline';
    readonly count: number;
};
export type AnchorVerdict = 'ok' | 'short-anchor' | 'content-only' | 'unknown-state';
/** Baseline origin of every cell of capture row `rowIndex`. The decoder seeds
 * its screen from these so that a pipe row that merely scrolls a captured
 * cell into history is recognised as the SAME row, not appended twice. */
export declare function baselineCellOrigins(snapshotId: string, rowIndex: number, cells: number): RowOrigin[];
/** Field-level knowledge of parser state that capture-pane cannot reveal
 * (§3.3). Unknown fields only become known through an explicit program
 * command; restoring a cursor saved while unknown makes the cursor unknown
 * again. A single LF never resets the terminal. */
export declare const KNOWN_STATE_FIELDS: readonly ["sgr", "cursor", "savedCursor", "margins", "charset", "pendingUtf8", "pendingEscape", "wrap"];
export type KnownStateField = typeof KNOWN_STATE_FIELDS[number];
export declare class KnownStateTracker {
    private readonly unknown;
    private escape;
    private utf8Left;
    constructor(stateKnown: Readonly<Record<string, boolean>>);
    unknownFields(): KnownStateField[];
    /** Fields among `dependencies` that are still unknown; nonempty ⇒ withhold. */
    uncertainFor(dependencies: readonly KnownStateField[]): KnownStateField[];
    /** Feeds raw pipe bytes. Partial UTF-8/escape state at the start of the
     * stream stays unknown until a byte that cannot continue it arrives. */
    feed(bytes: readonly number[]): void;
    private byte;
    private escapeByte;
    private save;
    private restore;
}
/** Rows of one `capture-pane -p -e -C -N -S - -E -` payload. History rows
 * (index < historySize) are finalized; screen rows are not. Capture never
 * proves wrap identity (no -J), so wrapStatus is unknown on every row.
 * Rows the decoder cannot certify carry uncertainFields, never invented cells. */
export declare function captureStitchRows(packet: CapturePacket, raw: string): StitchRow[];
export interface StitchOptions {
    /** Injected for collision fixtures only; default SHA-256. */
    readonly hash?: (text: string) => string;
    /** Monotonic milliseconds; default performance.now(). */
    readonly now?: () => number;
    /** New segment for accepted rows. Default is derived from the episode. */
    readonly segmentIdFor?: (episodeId: string, snapshotId: string) => string;
}
export declare class StreamStitcher implements StitchPort {
    private readonly options;
    constructor(options?: StitchOptions);
    stitch(T: StitchWindow, C: CaptureWindow, P: PipeWindow, proofs: StitchProofs): Promise<StitchResult>;
    private run;
    /** Candidates first, then the minimum content rules, then the proof gate.
     * More than one alignment is ambiguity, whatever their lengths. */
    private seam;
}
