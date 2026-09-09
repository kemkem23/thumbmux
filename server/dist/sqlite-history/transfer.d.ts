import type { HistoryStore } from './store';
import type { HistoryImportOptions, HistoryImportProgress, HistoryImportState } from './types';
type SealedFile = {
    path: string;
    bytes: number;
    sha256: string;
};
type Seal = {
    version: 1;
    files: SealedFile[];
};
/** Caller must already own a coherent, stopped/synthetic source; this is NOT an active-session bridge. */
export declare function sealHistorySnapshot(source: string, destination: string): void;
export declare function readSeal(directory: string): {
    seal: Seal;
    files: Map<string, Buffer>;
    digest: string;
    bytes: number;
};
export declare function readImportProgress(store: HistoryStore, sourceId: string): HistoryImportProgress;
export declare function importHistorySnapshot(store: HistoryStore, input: HistoryImportOptions): Promise<{
    state: HistoryImportState;
    records: number;
}>;
/** Consistent recovery bundle plus old-reader projections. Seal only after every file is fsynced.
 * A failure leaves an unsealed directory and never advances any mirror watermark. */
export declare function exportHistoryBundle(store: HistoryStore, sid: string, destination: string): {
    revision: number;
    directory: string;
};
export declare function restoreHistoryBundle(store: HistoryStore, directory: string): Promise<string>;
export {};
