import type { HistoryStore } from './store';
import type { CaptureBatch, CaptureReceipt, HistoryCoordinatorOptions, HistoryRow } from './types';
/** Stages a real crash test may kill at. The kill itself is a real SIGKILL;
 * this callback only places it between two durable filesystem states. */
export type AuthoritativeMirrorStage = 'sqlite-committed' | 'mirror-temp' | 'mirror-seq' | 'mirror-watermark';
export interface HistoryAuthoritativeBridgeOptions extends HistoryCoordinatorOptions {
    mirrorDirectory: string;
    now?: () => number;
    stage?: (stage: AuthoritativeMirrorStage) => void;
}
export interface AuthoritativeMirrorStatus {
    sessionId: string;
    targetRevision: number;
    exportedRevision: number;
    lagSince: number | null;
}
export interface AuthoritativeRollbackReceipt {
    sessionId: string;
    c2Revision: number;
    directory: string;
    rows: number;
    frames: number;
    rowsSha256: string;
}
type MirrorSeqRecord = {
    version: 1;
    sessionId: string;
    seq: number;
    requestId: string;
    rowStart: number;
    rowEnd: number;
    firstLine: number;
    liveStart: number;
    nextLine: number;
    rowsSha256: string;
    rows: HistoryRow[];
    screen: string[];
    geometryJson: string;
};
/** SQLite-first writer. The coordinator commits into the store (the primary
 * receipt), then the mirror follows the committed seq. */
export declare class AuthoritativeHistoryBridge {
    private store;
    private options;
    private coordinator;
    private lagSince;
    private barrier;
    constructor(store: HistoryStore, options: HistoryAuthoritativeBridgeOptions);
    private now;
    private sessionDirectory;
    private readWatermark;
    /** Serialize one committed seq from the store, re-checking the committed digest. */
    private committedRecord;
    /** Export one committed seq. Re-running is idempotent: an existing file must
     * be byte-identical to what the store says or the mirror is in conflict. */
    private exportSeq;
    /** Advance the watermark to the highest contiguous exported seq. Never past
     * the committed revision, and only after the seq files are durable. */
    private advanceWatermark;
    /** SQLite COMMIT first: the returned receipt is authoritative even when the
     * mirror export fails. A mirror failure is a fault plus a lagging watermark. */
    commitBatch(batch: CaptureBatch): Promise<CaptureReceipt>;
    start(): void;
    probe(sessionId: string): Promise<CaptureReceipt>;
    /** Replay the mirror from the durable watermark to the committed revision. */
    resumeMirror(sessionId: string): AuthoritativeMirrorStatus;
    mirrorStatus(sessionId: string): AuthoritativeMirrorStatus;
    /** Hold the barrier, replay the mirror to C2, export the full legacy
     * projection (every row after any earlier C0 included) and verify it against
     * independent oracle parsers before returning a receipt. */
    rollbackToLegacy(sessionId: string, destination: string): Promise<AuthoritativeRollbackReceipt>;
    stopAndDrain(): Promise<void>;
}
/** Independent re-read of an exported rollback bundle. The JSONL and LOG
 * projections are parsed by the oracle reader (not the exporter), compared
 * byte for byte against the committed rows, and the full-kind record in
 * `recovery.json` must match exactly — a count-only check cannot pass. */
export declare function verifyRollbackBundle(store: HistoryStore, sessionId: string, directory: string): {
    rows: number;
    frames: number;
    rowsSha256: string;
};
/** Read the durable mirror back for audit: every seq file must match its own
 * digest, the watermark must be contiguous, and nothing may run past it. */
export declare function readMirror(directory: string, sessionId: string): {
    exportedRevision: number;
    records: MirrorSeqRecord[];
};
export {};
