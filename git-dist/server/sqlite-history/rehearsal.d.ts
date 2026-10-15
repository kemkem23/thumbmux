import type { HistoryStore } from './store.js';
import type { ClosedHistoryImportOptions, ClosedHistoryImportResult, HistoryImportOptions, HistoryRow, LegacyFormat, MigrationVerification } from './types.js';
import type { FrameJournalRecordV1 } from '../frame-journal.js';
type Oracle = {
    rows: HistoryRow[];
    frames: FrameJournalRecordV1[];
    screen: string[];
};
/** This parser is deliberately separate from the importer parser. It reads every
 * sealed physical record again and never allocates replacement line numbers. */
export declare function readSealedHistoryOracle(directory: string, format: LegacyFormat): Oracle;
export declare function inspectImportedSnapshot(store: HistoryStore, input: HistoryImportOptions): MigrationVerification;
export declare function assertMigrationReady(report: MigrationVerification): void;
export declare function verifyImportedSnapshot(store: HistoryStore, input: HistoryImportOptions): MigrationVerification;
export declare function importClosedHistorySession(store: HistoryStore, input: ClosedHistoryImportOptions): Promise<ClosedHistoryImportResult>;
export {};
