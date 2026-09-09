/** Opt-in entry point, proposed tier S. No SQLite module, file or timer at evaluation. */
import type { SqliteHistoryOptions, HistoryCoordinatorOptions, HistoryImportOptions, HistoryContext, HistoryCaptureCoordinator } from './sqlite-history/types';
export type { Continuity, HistoryContext, HistoryRow, HistoryGeometry, SourceObservation, CaptureObservation, HistoryFault, SqliteHistoryOptions, CaptureReceipt, HistoryPageV1, HistoryHealth, HistoryCaptureDriver, HistoryCoordinatorOptions, LegacyFormat, HistoryImportOptions, HistoryCaptureCoordinator } from './sqlite-history/types';
export { inspectHistoryHealth, inspectHistoryMirror, validateHistoryPage, verifyHistoryOracle } from './sqlite-history/detectors';
export { sealHistorySnapshot } from './sqlite-history/transfer';

export async function createSqliteHistoryStore(options:SqliteHistoryOptions) {
  const [{Database},{HistoryStore,prepareFile},{HistoryCoordinator},transfer]=await Promise.all([
    import('bun:sqlite'),import('./sqlite-history/store'),import('./sqlite-history/coordinator'),import('./sqlite-history/transfer')]);
  const file=prepareFile(options.file);
  const db=new Database(file,{strict:true,safeIntegers:false});
  let store:InstanceType<typeof HistoryStore>;
  try {store=new HistoryStore(db,options);prepareFile(file);}catch(error){db.close();throw error;}
  return {
    registerSession:store.register.bind(store),renameSession:store.rename.bind(store),closeSession:store.closeSession.bind(store),
    createCaptureCoordinator:(o:HistoryCoordinatorOptions):HistoryCaptureCoordinator=>new HistoryCoordinator(store,o),
    snapshot:store.snapshot.bind(store),
    readBefore:(sid:string,anchor:number|null,limit:number,context?:HistoryContext)=>store.page(sid,'before',anchor,limit,context),
    readAfter:(sid:string,anchor:number|null,limit:number,context?:HistoryContext)=>store.page(sid,'after',anchor,limit,context),
    audit:store.audit.bind(store),health:store.health.bind(store),
    importSnapshot:(input:HistoryImportOptions)=>transfer.importHistorySnapshot(store,input),
    exportBundle:(sid:string,directory:string)=>transfer.exportHistoryBundle(store,sid,directory),
    restoreBundle:(directory:string)=>transfer.restoreHistoryBundle(store,directory),
    close:store.close.bind(store),
  };
}
export type SqliteHistoryStore = Awaited<ReturnType<typeof createSqliteHistoryStore>>;
