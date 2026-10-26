import type { HistoryStore } from './store.js';
import type { CaptureReceipt, HistoryContext, HistoryPageV1, HistoryRow } from './types.js';
export type ReaderUnverifiableReason = 
/** The range starts below the oldest capture receipt (retention/import floor). */
'range-below-verified-floor'
/** Receipts exist on both sides but do not tile the range. */
 | 'covering-receipt-gap'
/** The range runs past the newest receipt of the pinned revision. */
 | 'range-above-verified-receipt';
export type ReaderEmptyReason = 'at-floor' | 'at-live-start';
export type ReaderVerification = {
    status: 'verified';
    coveringCaptures: number[];
    verifiedRows: number;
    digests: number;
} | {
    status: 'empty';
    reason: ReaderEmptyReason;
    coveringCaptures: [];
} | {
    status: 'unverifiable';
    reason: ReaderUnverifiableReason;
    coveringCaptures: number[];
    detail: Record<string, number>;
};
export interface ReaderPageResult {
    page: HistoryPageV1;
    verification: ReaderVerification;
}
export interface ReaderSnapshotResult {
    receipt: CaptureReceipt;
    live: HistoryRow[];
    verification: ReaderVerification;
}
/**
 * Read-only facade. It holds a `HistoryStore` but exposes no writer, no ticket
 * and no SQL handle, so a canary wired to this object cannot mutate history.
 */
export declare class HistoryReaderCanary {
    private store;
    constructor(store: HistoryStore);
    /** Locate the receipt whose batch contains `line`, walking back at most one step. */
    private coverAt;
    private coverFrom;
    /**
     * Compare `rows` (already served for `[start,end)`) with the committed
     * receipts covering that range. Runs inside the caller's read transaction.
     */
    private verify;
    page(sid: string, direction: 'before' | 'after', anchor: number | null, limit: number, context?: HistoryContext): ReaderPageResult;
    snapshot(sid: string): ReaderSnapshotResult;
}
/**
 * The canary REST surface, as a pure `Request` -> `Response` function. It owns
 * no port and no server: a canary host mounts it, the wave-4 browser proof
 * mounts it on an ephemeral 127.0.0.1 listener, and nothing mounts it by
 * default. Failures answer with a status and a named error, never 200-with-[].
 */
export declare function historyReaderRequest(reader: HistoryReaderCanary, request: Request): Promise<Response>;
