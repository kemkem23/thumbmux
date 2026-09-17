import type { HistoryStore } from './store.js';
import type { DualWriteReceipt, HistoryBridgeLedgerEntry, HistoryBridgeOptions, HistoryCaptureBridge, HistoryShadowBridgeOptions, LegacyProjection } from './types.js';
export declare function legacyProjectionDigest(value: LegacyProjection): string;
/** Opt-in dual writer. The durable spool is admitted before either backend and the
 * legacy projection is acknowledged before SQLite while legacy remains authoritative. */
export declare class OptInHistoryBridge implements HistoryCaptureBridge {
    private store;
    private options;
    private spool;
    private coordinator;
    constructor(store: HistoryStore, options: HistoryBridgeOptions | HistoryShadowBridgeOptions);
    private shadow;
    private needsResume;
    private commit;
    start(): void;
    probe(sessionId: string): Promise<DualWriteReceipt>;
    resumePending(): Promise<HistoryBridgeLedgerEntry[]>;
    ledger(): HistoryBridgeLedgerEntry[];
    stopAndDrain(): Promise<void>;
}
