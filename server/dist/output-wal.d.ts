declare const KIND_TO_CODE: {
    readonly lifecycle: 1;
    readonly output: 2;
    readonly resize: 3;
    readonly checkpoint: 4;
};
export type OutputWalKind = keyof typeof KIND_TO_CODE;
export type OutputWalRecord = {
    /** Byte position of this record's header in the WAL. */
    offset: number;
    /** Byte position immediately after this record. Safe as a replay cursor. */
    nextOffset: number;
    sequence: bigint;
    at: number;
    kind: OutputWalKind;
    payload: Uint8Array;
};
export type OutputWalProblem = {
    kind: "torn" | "corrupt";
    offset: number;
    message: string;
};
export type OutputWalScan = {
    validBytes: number;
    records: number;
    lastSequence: bigint;
    lastAt: number;
    problem: OutputWalProblem | null;
};
export type OutputWalRepair = {
    repaired: boolean;
    validBytes: number;
    quarantinedPath: string | null;
};
/** Stable identity and verified prefix position for incremental tail readers. */
export type OutputWalTailCursor = Readonly<{
    offset: number;
    lastSequence: bigint;
    lastAt: number;
    device: string;
    inode: string;
}>;
export type OutputWalTailRead = Readonly<{
    records: readonly OutputWalRecord[];
    cursor: OutputWalTailCursor;
    /** A concurrent writer had not completed its final frame yet; retry later. */
    incompleteTail: boolean;
    /** More complete records may remain after the configured batch bound. */
    hasMore: boolean;
}>;
export type OutputWalTailOptions = Readonly<{
    maxPayloadBytes?: number;
    maxRecords?: number;
    maxFrameBytes?: number;
}>;
export type OutputWalWriterOptions = {
    path: string;
    clock?: () => number;
    maxPayloadBytes?: number;
    /** Tests can disable the automatic repair of an EOF-torn final record. */
    repairTornTail?: boolean;
};
/** Scan without loading the whole WAL into memory. */
export declare function scanOutputWal(path: string, options?: {
    maxPayloadBytes?: number;
}): OutputWalScan;
/**
 * Establish an inode-bound cursor at byte zero without scanning the backlog.
 * Each later `readOutputWalTail()` call still validates checksums, sequence,
 * timestamps, replacement, and truncation as it advances. This is the cursor
 * to use when recovery itself must make bounded progress.
 */
export declare function createOutputWalStartCursor(path: string): OutputWalTailCursor;
/**
 * Verify the complete current WAL once and return a trusted append cursor.
 * Long-running consumers persist this alongside their own atomic checkpoint,
 * then use `readOutputWalTail` so each refresh is O(new bytes), not O(all time).
 */
export declare function createOutputWalTailCursor(path: string, options?: {
    maxPayloadBytes?: number;
}): OutputWalTailCursor;
/**
 * Read and validate only records appended after a trusted cursor. A short EOF
 * frame is normal while the sole writer is between bytes; it is never repaired
 * by a reader and will be retried. Complete corruption, replacement, sequence
 * discontinuity and truncation all fail closed.
 */
export declare function readOutputWalTail(path: string, cursor: OutputWalTailCursor, options?: OutputWalTailOptions): OutputWalTailRead;
/** Iterate valid records from a known record boundary. */
export declare function readOutputWal(path: string, options?: {
    fromOffset?: number;
    maxPayloadBytes?: number;
}): Generator<OutputWalRecord>;
export declare class OutputWalWriter {
    private readonly path;
    private readonly clock;
    private readonly maxPayloadBytes;
    private fd;
    private sequence;
    private lastAt;
    readonly repair: OutputWalRepair;
    constructor(options: OutputWalWriterOptions);
    get filePath(): string;
    append(kind: OutputWalKind, payload: Uint8Array, at?: number): OutputWalRecord;
    appendOutput(payload: Uint8Array, at?: number): OutputWalRecord;
    appendJson(kind: Exclude<OutputWalKind, "output">, value: unknown, at?: number): OutputWalRecord;
    flush(): void;
    close(): void;
}
export declare function parseOutputWalJson<T = unknown>(record: OutputWalRecord): T;
export {};
