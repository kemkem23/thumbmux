/** Opt-in entry point, proposed tier S. No SQLite module, file or timer at evaluation. */
import type { SqliteHistoryOptions, HistoryBridgeOptions, HistoryShadowBridgeOptions, HistoryCoordinatorOptions, HistoryImportOptions, HistoryContext, HistoryCaptureBridge, HistoryCaptureCoordinator, ClosedHistoryImportOptions } from './sqlite-history/types';
export type { Continuity, HistoryContext, HistoryRow, HistoryGeometry, SourceObservation, CaptureObservation, HistoryFault, SqliteHistoryOptions, CaptureReceipt, HistoryPageV1, HistoryHealth, HistoryCaptureDriver, HistoryCoordinatorOptions, LegacyFormat, HistoryImportOptions, HistoryImportState, HistoryImportProgress, ClosedHistoryImportOptions, ClosedHistoryImportResult, MigrationUnresolvedEntry, MigrationVerification, LegacyProjection, LegacyProjectionAcknowledgement, LegacyProjectionWriter, HistoryBridgeOptions, HistoryBridgeLedgerEntry, DualWriteReceipt, HistoryCaptureBridge, HistoryCaptureCoordinator, ShadowFrameRecord, ShadowUnresolvedRecord, ShadowBatchSnapshot, ShadowSourceOracle, ShadowComparisonReport, HistoryShadowBridgeOptions, ShadowRuntimeState } from './sqlite-history/types';
export { compareShadowBatch, inspectShadowRuntime, inspectHistoryHealth, inspectHistoryMirror, inspectImportProgress, validateHistoryPage, verifyHistoryOracle } from './sqlite-history/detectors';
export { sealHistorySnapshot } from './sqlite-history/transfer';
export { assertMigrationReady, readSealedHistoryOracle } from './sqlite-history/rehearsal';
export type { ReaderVerification, ReaderEmptyReason, ReaderUnverifiableReason, ReaderPageResult, ReaderSnapshotResult } from './sqlite-history/reader';
export type { AuthoritativeMirrorStage, AuthoritativeMirrorStatus, AuthoritativeRollbackReceipt, HistoryAuthoritativeBridgeOptions } from './sqlite-history/authoritative';
export { runRestoreDrill } from './sqlite-history/rollout';
export type { BackupAuditEntry, BackupAuditReport, GroupReadinessEvidence, LegacyArtifactDigest, LegacyRetirementReceipt, RestoreDrillReceipt, RolloutGroupState, RolloutRoute } from './sqlite-history/rollout';
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
    createReaderCanary: () => import("./sqlite-history/reader").HistoryReaderCanary;
    createAuthoritativeBridge: (o: import("./sqlite-history/authoritative").HistoryAuthoritativeBridgeOptions) => import("./sqlite-history/authoritative").AuthoritativeHistoryBridge;
    createRolloutAllowlist: (o: {
        directory: string;
        declaredGroups: readonly string[];
        mirrorDirectory: string;
    }) => import("./sqlite-history/rollout").HistoryRolloutAllowlist;
    assessGroupReadiness: (group: string, mirrorDirectory: string) => Promise<import("./sqlite-history").GroupReadinessEvidence>;
    auditBackupCoverage: (mirrorDirectory: string) => import("./sqlite-history").BackupAuditReport;
    restoreDrill: (bundleDirectory: string, scratchDirectory: string) => Promise<import("./sqlite-history").RestoreDrillReceipt>;
    readerRequest: (canary: InstanceType<typeof import("./sqlite-history/reader").HistoryReaderCanary>, request: Request) => Promise<Response>;
    snapshot: (sid: string) => import("./sqlite-history").CaptureReceipt & {
        live: import("./sqlite-history").HistoryRow[];
    };
    readBefore: (sid: string, anchor: number | null, limit: number, context?: HistoryContext) => import("./sqlite-history").HistoryPageV1;
    readAfter: (sid: string, anchor: number | null, limit: number, context?: HistoryContext) => import("./sqlite-history").HistoryPageV1;
    audit: (sid: string, afterSeq?: number) => {
        captures: number;
        rows: number;
    };
    health: (sid: string) => import("./sqlite-history").HistoryHealth;
    importSnapshot: (input: HistoryImportOptions) => Promise<{
        state: import("./sqlite-history").HistoryImportState;
        records: number;
    }>;
    importProgress: (sourceId: string) => import("./sqlite-history").HistoryImportProgress;
    importClosedSession: (input: ClosedHistoryImportOptions) => Promise<import("./sqlite-history").ClosedHistoryImportResult>;
    inspectImportedSnapshot: (input: HistoryImportOptions) => import("./sqlite-history").MigrationVerification;
    verifyImportedSnapshot: (input: HistoryImportOptions) => import("./sqlite-history").MigrationVerification;
    exportBundle: (sid: string, directory: string) => {
        revision: number;
        directory: string;
    };
    restoreBundle: (directory: string) => Promise<string>;
    close: () => Promise<void>;
}>;
export type SqliteHistoryStore = Awaited<ReturnType<typeof createSqliteHistoryStore>>;
