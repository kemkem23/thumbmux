import type { HistoryStore } from './store.js';
import type { CaptureBatch, CaptureReceipt, HistoryCoordinatorOptions } from './types.js';
export type CaptureBatchCommitter = (batch: CaptureBatch) => Promise<CaptureReceipt>;
/** No work starts until start()/probe(). Neither subscribers nor a global ticking flag gate captures. */
export declare class HistoryCoordinator {
    private store;
    private options;
    private commitBatch;
    private running;
    private pending;
    private timer;
    private stopped;
    constructor(store: HistoryStore, options: HistoryCoordinatorOptions, commitBatch?: CaptureBatchCommitter);
    start(): void;
    probe(sid: string): Promise<CaptureReceipt>;
    private collect;
    private publish;
    stopAndDrain(): Promise<void>;
}
