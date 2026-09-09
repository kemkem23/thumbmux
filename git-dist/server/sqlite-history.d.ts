/** Opt-in entry point, proposed tier S. No SQLite module, file or timer at evaluation. */
import type { SqliteHistoryOptions, HistoryBridgeOptions, HistoryShadowBridgeOptions, HistoryCoordinatorOptions, HistoryImportOptions, HistoryContext, HistoryCaptureBridge, HistoryCaptureCoordinator, ClosedHistoryImportOptions } from './sqlite-history/types.js';
export type { Continuity, HistoryContext, HistoryRow, HistoryGeometry, SourceObservation, CaptureObservation, HistoryFault, SqliteHistoryOptions, CaptureReceipt, HistoryPageV1, HistoryHealth, HistoryCaptureDriver, HistoryCoordinatorOptions, LegacyFormat, HistoryImportOptions, HistoryImportState, HistoryImportProgress, ClosedHistoryImportOptions, ClosedHistoryImportResult, MigrationUnresolvedEntry, MigrationVerification, LegacyProjection, LegacyProjectionAcknowledgement, LegacyProjectionWriter, HistoryBridgeOptions, HistoryBridgeLedgerEntry, DualWriteReceipt, HistoryCaptureBridge, HistoryCaptureCoordinator, ShadowFrameRecord, ShadowUnresolvedRecord, ShadowBatchSnapshot, ShadowSourceOracle, ShadowComparisonReport, HistoryShadowBridgeOptions, ShadowRuntimeState } from './sqlite-history/types.js';
export { compareShadowBatch, inspectShadowRuntime, inspectHistoryHealth, inspectHistoryMirror, inspectImportProgress, validateHistoryPage, verifyHistoryOracle } from './sqlite-history/detectors.js';
export { sealHistorySnapshot } from './sqlite-history/transfer.js';
export { assertMigrationReady, readSealedHistoryOracle } from './sqlite-history/rehearsal.js';
export type { ReaderVerification, ReaderEmptyReason, ReaderUnverifiableReason, ReaderPageResult, ReaderSnapshotResult } from './sqlite-history/reader.js';
export type { AuthoritativeMirrorStage, AuthoritativeMirrorStatus, AuthoritativeRollbackReceipt, HistoryAuthoritativeBridgeOptions } from './sqlite-history/authoritative.js';
export { runRestoreDrill } from './sqlite-history/rollout.js';
export type { BackupAuditEntry, BackupAuditReport, GroupReadinessEvidence, LegacyArtifactDigest, LegacyRetirementReceipt, RestoreDrillReceipt, RolloutGroupState, RolloutRoute } from './sqlite-history/rollout.js';
export declare function createSqliteHistoryStore(options: SqliteHistoryOptions): Promise<{
    registerSession: (input: {
        name: string;
        lifecycleKey: string;
        group?: string;
        firstLine?: number;
    }) => Promise<string>;
    renameSession: (sid: string, name: string, group?: string) => Promise<void>;
    closeSession: (sid: string) => Promise<void>;
    createCaptureCoordinator: (o: HistoryCoordinatorOptions) => HistoryCaptureCoordinator;
    createCaptureBridge: (o: HistoryBridgeOptions) => HistoryCaptureBridge;
    createShadowBridge: (o: HistoryShadowBridgeOptions) => HistoryCaptureBridge;
    createReaderCanary: () => import("./sqlite-history/reader.js").HistoryReaderCanary;
    createAuthoritativeBridge: (o: import("./sqlite-history/authoritative.js").HistoryAuthoritativeBridgeOptions) => import("./sqlite-history/authoritative.js").AuthoritativeHistoryBridge;
    createRolloutAllowlist: (o: {
        directory: string;
        declaredGroups: readonly string[];
        mirrorDirectory: string;
    }) => import("./sqlite-history/rollout.js").HistoryRolloutAllowlist;
    assessGroupReadiness: (group: string, mirrorDirectory: string) => Promise<import("./sqlite-history.js").GroupReadinessEvidence>;
    auditBackupCoverage: (mirrorDirectory: string) => import("./sqlite-history.js").BackupAuditReport;
    restoreDrill: (bundleDirectory: string, scratchDirectory: string) => Promise<import("./sqlite-history.js").RestoreDrillReceipt>;
    readerRequest: (canary: InstanceType<typeof import("./sqlite-history/reader.js").HistoryReaderCanary>, request: Request) => Promise<Response>;
    snapshot: (sid: string) => import("./sqlite-history.js").CaptureReceipt & {
        live: import("./sqlite-history.js").HistoryRow[];
    };
    readBefore: (sid: string, anchor: number | null, limit: number, context?: HistoryContext) => import("./sqlite-history.js").HistoryPageV1;
    readAfter: (sid: string, anchor: number | null, limit: number, context?: HistoryContext) => import("./sqlite-history.js").HistoryPageV1;
    audit: (sid: string, afterSeq?: number) => {
        captures: number;
        rows: number;
    };
    health: (sid: string) => import("./sqlite-history.js").HistoryHealth;
    importSnapshot: (input: HistoryImportOptions) => Promise<{
        state: import("./sqlite-history.js").HistoryImportState;
        records: number;
    }>;
    importProgress: (sourceId: string) => import("./sqlite-history.js").HistoryImportProgress;
    importClosedSession: (input: ClosedHistoryImportOptions) => Promise<import("./sqlite-history.js").ClosedHistoryImportResult>;
    inspectImportedSnapshot: (input: HistoryImportOptions) => import("./sqlite-history.js").MigrationVerification;
    verifyImportedSnapshot: (input: HistoryImportOptions) => import("./sqlite-history.js").MigrationVerification;
    exportBundle: (sid: string, directory: string) => {
        revision: number;
        directory: string;
    };
    restoreBundle: (directory: string) => Promise<string>;
    close: () => Promise<void>;
}>;
export type SqliteHistoryStore = Awaited<ReturnType<typeof createSqliteHistoryStore>>;
