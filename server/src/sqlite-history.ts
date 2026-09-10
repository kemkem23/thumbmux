/** Opt-in entry point, proposed tier S. No SQLite module, file or timer at evaluation. */
import type { SqliteHistoryOptions, HistoryBridgeOptions, HistoryShadowBridgeOptions, HistoryCoordinatorOptions, HistoryImportOptions, HistoryContext, HistoryCaptureBridge, HistoryCaptureCoordinator, ClosedHistoryImportOptions } from './sqlite-history/types';
import type * as rollout from './sqlite-history/rollout';
export type { Continuity, HistoryContext, HistoryRow, HistoryGeometry, SourceObservation, CaptureObservation, HistoryFault, SqliteHistoryOptions, CaptureReceipt, HistoryPageV1, HistoryHealth, HistoryCaptureDriver, HistoryCoordinatorOptions, LegacyFormat, HistoryImportOptions, HistoryImportState, HistoryImportProgress, ClosedHistoryImportOptions, ClosedHistoryImportResult, MigrationUnresolvedEntry, MigrationVerification, LegacyProjection, LegacyProjectionAcknowledgement, LegacyProjectionWriter, HistoryBridgeOptions, HistoryBridgeLedgerEntry, DualWriteReceipt, HistoryCaptureBridge, HistoryCaptureCoordinator, ShadowFrameRecord, ShadowUnresolvedRecord, ShadowBatchSnapshot, ShadowSourceOracle, ShadowComparisonReport, HistoryShadowBridgeOptions, ShadowRuntimeState } from './sqlite-history/types';
export { compareShadowBatch, inspectShadowRuntime, inspectHistoryHealth, inspectHistoryMirror, inspectImportProgress, validateHistoryPage, verifyHistoryOracle } from './sqlite-history/detectors';
export { sealHistorySnapshot } from './sqlite-history/transfer';
export { assertMigrationReady, readSealedHistoryOracle } from './sqlite-history/rehearsal';
export type { ReaderVerification, ReaderEmptyReason, ReaderUnverifiableReason, ReaderPageResult, ReaderSnapshotResult } from './sqlite-history/reader';
export type { AuthoritativeMirrorStage, AuthoritativeMirrorStatus, AuthoritativeRollbackReceipt, HistoryAuthoritativeBridgeOptions } from './sqlite-history/authoritative';
// Wave 6: expansion tooling + write-path router, still opt-in and unwired to production.
export { expandGroup, runRestoreDrill } from './sqlite-history/rollout';
export type { BackupAuditEntry, BackupAuditReport, ExpansionReceipt, GroupReadinessEvidence, HistoryWriter, LegacyArtifactDigest, LegacyRetirementReceipt, RestoreDrillReceipt, RolloutGroupState, RolloutRoute } from './sqlite-history/rollout';

export async function createSqliteHistoryStore(options:SqliteHistoryOptions) {
  const [{Database},{HistoryStore,prepareFile},{HistoryCoordinator},{OptInHistoryBridge},transfer,rehearsal,reader,authoritative,rollout]=await Promise.all([
    import('bun:sqlite'),import('./sqlite-history/store'),import('./sqlite-history/coordinator'),import('./sqlite-history/bridge'),import('./sqlite-history/transfer'),import('./sqlite-history/rehearsal'),import('./sqlite-history/reader'),import('./sqlite-history/authoritative'),import('./sqlite-history/rollout')]);
  const file=prepareFile(options.file);
  const db=new Database(file,{strict:true,safeIntegers:false});
  let store:InstanceType<typeof HistoryStore>;
  try {store=new HistoryStore(db,options);prepareFile(file);}catch(error){db.close();throw error;}
  return {
    registerSession:store.register.bind(store),renameSession:store.rename.bind(store),closeSession:store.closeSession.bind(store),
    createCaptureCoordinator:(o:HistoryCoordinatorOptions):HistoryCaptureCoordinator=>new HistoryCoordinator(store,o),
    createCaptureBridge:(o:HistoryBridgeOptions):HistoryCaptureBridge=>new OptInHistoryBridge(store,o),
    // Writer-only shadow facade. SQLite readers remain unwired and opt-in.
    createShadowBridge:(o:HistoryShadowBridgeOptions):HistoryCaptureBridge=>new OptInHistoryBridge(store,o),
    // Wave 4 reader canary. Read-only, opt-in, and not wired to viewer/REST.
    createReaderCanary:()=>new reader.HistoryReaderCanary(store),
    // Wave 5 authoritative writer. Opt-in; no production session is wired to it.
    createAuthoritativeBridge:(o:import('./sqlite-history/authoritative').HistoryAuthoritativeBridgeOptions)=>new authoritative.AuthoritativeHistoryBridge(store,o),
    // Wave 6. Opt-in expansion tooling and write-path router; no production group is enabled here.
    createRolloutAllowlist:(o:{directory:string;declaredGroups:readonly string[];mirrorDirectory:string})=>new rollout.HistoryRolloutAllowlist(store,o),
    createRolloutRouter:(o:{allowlist:InstanceType<typeof rollout.HistoryRolloutAllowlist>;sqlite:rollout.HistoryWriter;legacy:rollout.HistoryWriter})=>new rollout.HistoryRolloutRouter(store,o.allowlist,{sqlite:o.sqlite,legacy:o.legacy}),
    assessGroupReadiness:(group:string,mirrorDirectory:string)=>rollout.assessGroupReadiness(store,group,mirrorDirectory),
    expandGroup:(allowlist:InstanceType<typeof rollout.HistoryRolloutAllowlist>,group:string,o:{mirrorDirectory:string;scratchDirectory:string})=>rollout.expandGroup(store,allowlist,group,o),
    auditBackupCoverage:(mirrorDirectory:string)=>rollout.auditBackupCoverage(store,mirrorDirectory),
    restoreDrill:(bundleDirectory:string,scratchDirectory:string)=>rollout.runRestoreDrill(bundleDirectory,scratchDirectory),
    readerRequest:(canary:InstanceType<typeof reader.HistoryReaderCanary>,request:Request)=>reader.historyReaderRequest(canary,request),
    snapshot:store.snapshot.bind(store),
    readBefore:(sid:string,anchor:number|null,limit:number,context?:HistoryContext)=>store.page(sid,'before',anchor,limit,context),
    readAfter:(sid:string,anchor:number|null,limit:number,context?:HistoryContext)=>store.page(sid,'after',anchor,limit,context),
    audit:store.audit.bind(store),health:store.health.bind(store),
    importSnapshot:(input:HistoryImportOptions)=>transfer.importHistorySnapshot(store,input),
    importProgress:(sourceId:string)=>transfer.readImportProgress(store,sourceId),
    importClosedSession:(input:ClosedHistoryImportOptions)=>rehearsal.importClosedHistorySession(store,input),
    inspectImportedSnapshot:(input:HistoryImportOptions)=>rehearsal.inspectImportedSnapshot(store,input),
    verifyImportedSnapshot:(input:HistoryImportOptions)=>rehearsal.verifyImportedSnapshot(store,input),
    exportBundle:(sid:string,directory:string)=>transfer.exportHistoryBundle(store,sid,directory),
    restoreBundle:(directory:string)=>transfer.restoreHistoryBundle(store,directory),
    close:store.close.bind(store),
  };
}
export type SqliteHistoryStore = Awaited<ReturnType<typeof createSqliteHistoryStore>>;
