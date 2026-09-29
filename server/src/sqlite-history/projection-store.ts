import { Database } from 'bun:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_LEGACY_FILES, PROJECTION_MIGRATION, PROJECTION_SCHEMA, PROJECTION_SCHEMA_MARKERS, PROJECTION_SCHEMA_VERSION, PROJECTION_STORE_FILE } from './schema';
import { closePrepared, prepared, ProjectionRam, paneId, upsert, decodeCells, decodeFrameCells, encodeCells, encodeFrameCells, validateFrame, validateRow, type SqlRow } from './ram-store';
import { BLOCK_COLUMNS, LegacyUnderlay, lowestLine, readDiskLines, readProjectionPage, projectionIssue, type LegacyFloor } from './projection-reader';
import { decodeBlock, decodeCaptureArchive, decodeCaptureReceipts, encodeBlock, encodeCaptureArchive, encodeCaptureReceipts, encodeRow } from './codec';
import { PROJECTION_OVERSIZE } from './types';
import type { PaneKey, ProjectionAdmission, ProjectionCalibration, ProjectionCloseReceipt, ProjectionIssueInput, ProjectionEpochTransition, ProjectionFault, ProjectionFrame, ProjectionHealth, ProjectionIssue, ProjectionReceipt, ProjectionRefusal, ProjectionStorageState, ProjectionStorageStatus, ProjectionToken, ProjectionWriterPort, ScrollEvent } from './types';

const PENDING_MAX=16*1024*1024, CACHE_MAX=256*1024*1024, FLUSH_BYTES=1024*1024, DURABLE_BATCH_MS=20;
const ADMIT_MAX=PENDING_MAX-64*1024, CAPACITY_EPISODE_MS=10000;
// D12 (FIX1 §3): every pane in the live roster owns a guaranteed quota; the
// rest of the cap is a borrow pool. A pane that sent nothing for ROSTER_MS
// leaves the roster, so dead or quiet panes do not pin a share forever.
const GUARANTEE_MAX=768*1024, ROSTER_MS=30000;
// Disk layout (v4). Lines are sealed in aligned blocks of SEAL_LINES
// ([k*SEAL_LINES,(k+1)*SEAL_LINES)) into one deflated na_block row once every
// line of the block is settled (certified by a capture, marked
// evicted-before-check, or SEAL_UNCHECKED_LAG lines behind the pane, past RAM's
// 4500-line check window), or once the whole block is SEAL_LAG lines behind the
// pane head. Blocks seal independently, so one uncertified block never holds
// the rest back. A later change to a sealed line (a certification arriving
// after SEAL_LAG) rewrites its block, so a line is never stored twice.
// 2 KiB pages keep a typical line in its page (WITHOUT ROWID local limit
// ~488 B) while halving each WAL frame and the fixed per-table pages.
const SEAL_LINES=256, SEAL_LAG=128, SEAL_UNCHECKED_LAG=4608, SEAL_RETRY_MS=200, DISK_PAGE_SIZE=2048, WAL_LIMIT=16*1024, CHECKPOINT_COMMITS=5;
export interface ProjectionOptions {
  historyRoot: string; file?: string; mode: 'create'|'recover';
  /**
   * Files of earlier schemas, read-only, layered under panes this file
   * continues (LegacyUnderlay). Default: the PROJECTION_LEGACY_FILES that exist
   * under historyRoot when `file` is the default, none otherwise.
   */
  legacyArchives?: readonly string[];
  /** RAM working-set cap; defaults to 256 MiB. Tests lower it to reach the cap with real rows. */
  cacheBytes?: number;
  onFault?: (fault: ProjectionFault)=>void;
  /** Immediate, typed disk-fault/retry receipt for the host's durable journal. */
  onStorageState?: (state: ProjectionStorageState)=>void;
  /** Fault/crash probes, never a replacement persistence backend. */
  checkpoint?: (phase:'before-disk-commit'|'after-disk-commit'|'before-watermark',commitId:string)=>void;
  beforeOpen?: (file:string)=>void;
}
const STORAGE_RETRY_MS=[1000,2000,5000] as const;
function isStorageFull(error:unknown):boolean {
  const value=error as NodeJS.ErrnoException;
  return value?.code==='ENOSPC' || value?.code==='SQLITE_FULL'
    || /(?:SQLITE_FULL|database or disk is full|\bENOSPC\b|no space left on device)/i.test(String(error));
}
function admitPath(options: ProjectionOptions): string {
  const root=resolve(options.historyRoot), file=resolve(options.file??join(root,PROJECTION_STORE_FILE));
  if(file===root || !file.startsWith(root+sep) || file.split(sep).some(p=>/^brain\.db(?:$|[-.])/i.test(p))) throw new Error('forbidden-database-path');
  // Check every existing component before creating anything or calling SQLite.
  for(const candidate of [file,file+'-wal',file+'-shm',file+'-journal']) {
    let current:string=sep;
    for(const part of candidate.split(sep).filter(Boolean)) {
      current=join(current,part);
      let stat; try { stat=lstatSync(current); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') continue; throw error; }
      if(stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink!==1))) throw new Error('unsafe-database-path');
    }
  }
  if(options.mode==='create' && [file,file+'-wal',file+'-shm',file+'-journal'].some(existsSync)) throw new Error('new-file-required');
  if(options.mode==='recover') {
    // Validate the header before SQLite opens an existing file. Never migrate v1.
    const fd=openSync(file,'r');
    try {
      const head=Buffer.alloc(100); const n=readSync(fd,head,0,100,0);
      if(n!==100 || head.subarray(0,16).toString()!=='SQLite format 3\0' || head.readUInt32BE(60)!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v5');
    } finally { closeSync(fd); }
  } else {
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    const fd=openSync(file,'wx',0o600);closeSync(fd);
  }
  return file;
}

type Batch={id:string;digest:string;panes:SqlRow[];tables:Map<string,SqlRow[]>;bytes:number;since:number;byPane:Map<string,number>};
const blockLine=(row:SqlRow)=>BLOCK_COLUMNS.map(column=>row[column]);
const CAPTURE_COLUMNS=['capture_id','revision','source_epoch','requested_at','completed_at','geometry_generation','first_history_row','history_count','screen_hash','history_hash','observed_fields','compared_rows','corrected_cells','ambiguous_rows','result'] as const;
const captureValues=(row:SqlRow)=>CAPTURE_COLUMNS.map(column=>row[column]);
const captureRow=(paneNo:number,values:unknown[]):SqlRow=>{
  if(values.length!==CAPTURE_COLUMNS.length)throw new Error('capture-archive-corrupt');
  const row:SqlRow={pane_no:paneNo};
  CAPTURE_COLUMNS.forEach((column,index)=>{row[column]=values[index] as SqlRow[string];});
  return row;
};
function captureReceipt(disk:Database,paneNo:number,captureId:string):SqlRow {
  const live=prepared(disk,'SELECT * FROM na_capture WHERE pane_no=? AND capture_id=?').get(paneNo,captureId) as SqlRow|null;
  if(live)return live;
  for(const block of prepared(disk,'SELECT catalog,data,capture_count FROM na_capture_archive WHERE pane_no=? ORDER BY archive_no DESC').all(paneNo) as SqlRow[]) {
    const catalog=decodeCaptureArchive(block.catalog as unknown as Uint8Array);
    if(catalog.length!==Number(block.capture_count))throw new Error('capture-archive-corrupt');
    const ordinal=catalog.findIndex(item=>Array.isArray(item)&&item[0]===captureId);
    if(ordinal<0)continue;
    const data=decodeCaptureReceipts(block.data as unknown as Uint8Array);
    if(data.length!==catalog.length)throw new Error('capture-archive-corrupt');
    const row=captureRow(paneNo,data[ordinal]!);
    if(row.capture_id!==captureId || row.revision!==catalog[ordinal]![1] || row.source_epoch!==catalog[ordinal]![2]
      || row.geometry_generation!==catalog[ordinal]![3])throw new Error('capture-archive-catalog');
    return row;
  }
  throw new Error('capture-receipt-missing');
}
/** Per-line upsert, unless a sealed block holds the line: then the block is patched. */
function writeLines(disk:Database,rows:SqlRow[]):void {
  const patches=new Map<string,SqlRow[]>();
  for(const row of rows) {
    const block=prepared(disk,'SELECT block_no,first_line_id,line_count FROM na_block WHERE pane_no=? AND first_line_id<=? ORDER BY first_line_id DESC LIMIT 1').get(row.pane_no,row.line_id) as SqlRow|null;
    if(!block || Number(row.line_id)>=Number(block.first_line_id)+Number(block.line_count)){upsert(disk,'na_line',row);continue;}
    const list=patches.get(String(block.block_no))??[];list.push(row);patches.set(String(block.block_no),list);
  }
  for(const [blockNo,list] of patches) {
    const block=prepared(disk,'SELECT * FROM na_block WHERE block_no=?').get(Number(blockNo)) as SqlRow;
    const lines=decodeBlock(block.data as unknown as Uint8Array),first=Number(block.first_line_id);
    let top=Number(block.max_revision);
    for(const row of list) {
      const i=Number(row.line_id)-first;if(i<0 || i>=lines.length)throw new Error('block-missing');
      lines[i]=blockLine(row);top=Math.max(top,Number(row.revision));
    }
    prepared(disk,'UPDATE na_block SET data=?,max_revision=? WHERE block_no=?').run(encodeBlock(lines),top,Number(blockNo));
  }
}
const sealAttempts=new WeakMap<Database,Map<SqlRow[string],number>>();
/** Seal every complete aligned block of settled per-line rows (see SEAL_LINES). */
function sealBlocks(disk:Database,panes:SqlRow[],force:boolean):void {
  let attempts=sealAttempts.get(disk);if(!attempts){attempts=new Map();sealAttempts.set(disk,attempts);}
  const now=performance.now();
  for(const p of panes) {
    const next=Number(p.next_line_id);
    if(!force && now-(attempts.get(p.pane_no)??-Infinity)<SEAL_RETRY_MS)continue;
    attempts.set(p.pane_no,now);
    // Per aligned block: rows present and rows not yet settled.
    const groups=prepared(disk,`SELECT line_id/${SEAL_LINES} AS b,count(*) AS n,
      sum(check_state=0 AND check_reason<>1 AND line_id>=?) AS open FROM na_line WHERE pane_no=? GROUP BY b`).all(next-SEAL_UNCHECKED_LAG,p.pane_no) as SqlRow[];
    for(const g of groups) {
      const from=Number(g.b)*SEAL_LINES;
      if(Number(g.n)!==SEAL_LINES || from+SEAL_LINES>next || (Number(g.open)!==0 && from+SEAL_LINES>next-SEAL_LAG))continue;
      const rows=prepared(disk,'SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id').all(p.pane_no,from,from+SEAL_LINES) as SqlRow[];
      prepared(disk,'INSERT INTO na_block (pane_no,first_line_id,line_count,max_revision,data) VALUES (?,?,?,?,?)')
        .run(p.pane_no,from,SEAL_LINES,Math.max(...rows.map(r=>Number(r.revision))),encodeBlock(rows.map(blockLine)));
      prepared(disk,'DELETE FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<?').run(p.pane_no,from,from+SEAL_LINES);
    }
  }
}
/** Archive receipts only after every live FK has moved into a sealed block. */
function archiveCaptures(disk:Database,panes:SqlRow[],force:boolean):void {
  for(const pane of panes)for(;;) {
    const rows=prepared(disk,`SELECT c.* FROM na_capture c WHERE c.pane_no=?
      AND NOT EXISTS(SELECT 1 FROM na_line l WHERE l.pane_no=c.pane_no AND l.checked_capture_id=c.capture_id)
      AND c.capture_id NOT IN(SELECT recent.capture_id FROM na_capture recent WHERE recent.pane_no=c.pane_no ORDER BY recent.revision DESC,recent.capture_id DESC LIMIT 8)
      ORDER BY c.revision,c.capture_id LIMIT 256`).all(pane.pane_no) as SqlRow[];
    if(!rows.length || (!force && rows.length<128))break;
    const catalog=rows.map(row=>[row.capture_id,row.revision,row.source_epoch,row.geometry_generation]);
    prepared(disk,'INSERT INTO na_capture_archive (pane_no,first_revision,last_revision,capture_count,catalog,data) VALUES (?,?,?,?,?,?)')
      .run(pane.pane_no,rows[0]!.revision,rows.at(-1)!.revision,rows.length,encodeCaptureArchive(catalog),encodeCaptureReceipts(rows.map(captureValues)));
    const remove=prepared(disk,'DELETE FROM na_capture WHERE pane_no=? AND capture_id=?');
    for(const row of rows)remove.run(pane.pane_no,row.capture_id);
    if(rows.length<256)break;
  }
}
function commitBatch(disk:Database, fence:number, batch:Batch, before?:()=>void, checkpoint=false, forceSeal=false) {
  const started=performance.now();let writeMs=0;
  disk.transaction(()=>{
    if(Number(Object.values(prepared(disk,'PRAGMA application_id').get()!)[0])!==fence) throw new Error('stale-writer');
    const existing=prepared(disk,'SELECT digest FROM na_commit WHERE commit_id=?').get(batch.id) as SqlRow|null;
    if(existing) {if(existing.digest!==batch.digest)throw new Error('commit-id-conflict');writeMs=performance.now()-started;return;}
    for(const p of batch.panes) upsert(disk,'na_pane',{...p,durable_revision:p.revision});
    for(const [table,rows] of batch.tables) {if(table==='na_line')writeLines(disk,rows);else for(const row of rows)upsert(disk,table,row);}
    // Only the latest commit is kept: a retry always re-offers the latest batch,
    // and na_pane already holds every watermark. commit_seq counts all commits.
    prepared(disk,'INSERT INTO na_commit VALUES (?,coalesce((SELECT max(commit_seq) FROM na_commit),0)+1,?,?,?,?)').run(batch.id,Math.max(...batch.panes.map(p=>Number(p.revision))),Date.now(),JSON.stringify(batch.panes.map(p=>({paneKey:p.pane_key,revision:p.revision,nextLineId:p.next_line_id}))),batch.digest);
    prepared(disk,'DELETE FROM na_commit WHERE commit_id<>?').run(batch.id);
    sealBlocks(disk,batch.panes,forceSeal);
    archiveCaptures(disk,batch.panes,forceSeal);
    before?.();writeMs=performance.now()-started;
  }).immediate();
  // Bound physical WAL growth without forcing a truncate into the ingest
  // latency tail. Explicit durability barriers below still truncate the WAL;
  // the background path only advances the checkpoint non-blockingly.
  if(checkpoint)disk.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const totalMs=performance.now()-started;return {totalMs,writeMs,commitMs:totalMs-writeMs};
}
// Same module in source and compiled distributions: no extra worker asset/factory.
if(!isMainThread && workerData?.projectionDiskWriter===true) {
  const signal=new Int32Array(workerData.signal);
  const errors=new Uint8Array(workerData.signal,8);
  const disk=new Database(workerData.file,{strict:true});
  disk.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=${WAL_LIMIT};`);
  let commits=0;
  const onMessage=(batch:Batch|'close')=>{
    if(batch==='close') {
      try {closePrepared(disk);}catch(error){console.error('[newarch] disk worker close failed',String(error));}
      // Bun keeps a worker alive while a parentPort 'message' listener is attached;
      // parentPort.close() alone does not release it, so the thread never exits.
      parentPort!.off('message',onMessage);parentPort!.close();return;
    }
    try {
      const timing=commitBatch(disk,workerData.fence,batch,undefined,++commits%CHECKPOINT_COMMITS===0);
      Atomics.store(signal,2,Math.round(timing.totalMs*1000));Atomics.store(signal,3,Math.round(timing.writeMs*1000));
      Atomics.store(signal,0,1);
    }
    catch(error) {
      const bytes=new TextEncoder().encode(String(error)).subarray(0,errors.length);
      errors.set(bytes);Atomics.store(signal,1,bytes.length);Atomics.store(signal,0,2);
    }
    Atomics.notify(signal,0);parentPort!.postMessage(batch.id);
  };
  parentPort!.on('message',onMessage);
}

type Waiter={resolve:(r:ProjectionReceipt)=>void;reject:(e:unknown)=>void};
type Job=Waiter&{liveFrame:boolean;barrier?:boolean;screenKey?:string;sourceEpoch:number;geometryGeneration:number;bytes:number;at:number;run:()=>ProjectionReceipt;waiters?:Waiter[]};
const settle=(job:Job,ok:boolean,value:any)=>{for(const w of [job,...(job.waiters??[])])ok?w.resolve(value):w.reject(value);};

/** One RAM writer, one disk writer, round-robin pane queues, independent of viewers. */
export class ProjectionStore implements ProjectionWriterPort {
  private readonly ram=new ProjectionRam();
  private readonly disk:Database;
  readonly file:string;
  private readonly legacy:LegacyUnderlay;
  private fence=0;
  private queues=new Map<string,Job[]>();
  private queuedBytes=0;
  // Reservations follow a pane through queue, RAM and the unacknowledged batch.
  // Only panes holding bytes have a key, so its size is the number of panes
  // competing for the cap right now, not every pane the store has ever seen.
  private pendingByPane=new Map<string,number>();
  private dirtyByPane=new Map<string,number>();
  private capacityLosses=new Map<string,{key:PaneKey;count:number}>();
  private dirtyBytes=0;
  private dirtySince:number|null=null;
  private pumping=false;
  private pumpTurnAt=performance.now();
  private closed=false;
  private degraded=false;
  private stopped=false;
  private pressureBytes=0;
  private timer:ReturnType<typeof setInterval>;
  private retry:Batch|null=null;
  private storageStatus:ProjectionStorageStatus='healthy';
  private storageEventId:string|null=null;
  private storageReason:string|null=null;
  private storageAttempt=0;
  private storageRetryAt:number|null=null;
  private storageResult:'failed'|'succeeded'|null=null;
  private storageBatchId:string|null=null;
  private closeReceipt:ProjectionCloseReceipt|null=null;
  private worker:Worker|null=null;
  private readonly signal=new Int32Array(new SharedArrayBuffer(4104));
  private inFlight=false;
  private diskTiming={totalMs:0,writeMs:0,commitMs:0};
  private closing=false;
  private rejectedRows=0;
  private screenBytes=new Map<string,number>();
  private dirtyFaults=new Set<string>();
  private faultEmitted=new Map<string,number>();
  private faults=new Map<string,{id:string;pane:string;last:number;seen:number;detected:number;count:number;revision:number}>();
  private lastCommitAt:number|null=null;
  private lastFlushAgeMs=0;
  private readonly cacheMax:number;
  private roster=new Map<string,number>();
  private rosterSize=0;
  private rosterAt=0;
  private pressureRefusals=0;
  private ramBatches=0;
  private ramBatchOperations=0;
  private ramBytesCache=-1;
  private refusedBytes=new Map<string,number>();
  private lastOversize=new Map<string,string>();
  private drainWaiters:Array<{id:string;key:PaneKey;resolve:()=>void;reject:(e:unknown)=>void}>=[];
  private durableWaiters:Array<{key:PaneKey;revision:number;resolve:(r:ProjectionReceipt)=>void;reject:(e:unknown)=>void}>=[];
  constructor(private readonly options:ProjectionOptions) {
    this.cacheMax=options.cacheBytes??CACHE_MAX;
    this.file=admitPath(options);
    options.beforeOpen?.(this.file);
    this.disk=new Database(this.file,{strict:true});
    try {
      // page_size only applies to a new file, so it must precede journal_mode.
      this.disk.exec(`PRAGMA page_size=${DISK_PAGE_SIZE}; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=${WAL_LIMIT};`);
      this.disk.transaction(()=>{
        const version=Number(Object.values(prepared(this.disk,'PRAGMA user_version').get()!)[0]);
        if(options.mode==='create') {
          if(version!==0 || prepared(this.disk,"SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('new-file-required');
          this.disk.exec(PROJECTION_SCHEMA);this.disk.exec(`PRAGMA user_version=${PROJECTION_SCHEMA_VERSION}`);
        } else if(version!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v5');
        else {
          const sql=(prepared(this.disk,"SELECT group_concat(sql,' ') AS s FROM sqlite_master WHERE name IN ('na_line','na_capture','na_block','na_capture_archive')").get() as SqlRow).s;
          if(PROJECTION_SCHEMA_MARKERS.some(m=>!String(sql).includes(m))) throw new Error('projection-schema-outdated');
        }
        const epoch=Number(Object.values(prepared(this.disk,'PRAGMA application_id').get()!)[0]);
        if(epoch<0 || epoch>=2147483647) throw new Error('writer-fence-exhausted');
        this.fence=epoch+1;this.disk.exec(`PRAGMA application_id=${this.fence}`);
      }).immediate();
      // Persist the schema header even when a crash happens before the first projection flush.
      this.disk.exec('PRAGMA wal_checkpoint(FULL)');
      const fd=openSync(dirname(this.file),'r');try {fsyncSync(fd);}finally {closeSync(fd);}
      this.recover();
    } catch(error) { closePrepared(this.disk);closePrepared(this.ram.db);throw error; }
    const root=resolve(options.historyRoot);
    this.legacy=new LegacyUnderlay((options.legacyArchives??(options.file===undefined?PROJECTION_LEGACY_FILES.map(f=>join(root,f)).filter(f=>existsSync(f)):[]))
      .map(f=>resolve(root,f)).filter(f=>f!==this.file));
    for(const reason of this.legacy.errors)this.reportLegacy(reason);
    this.ram.firstLineId=key=>this.legacy.find(key)?.token.nextLineId??0;
    try {this.ensureWorker();}catch(error){this.legacy.close();closePrepared(this.ram.db);closePrepared(this.disk);throw error;}
    this.timer=setInterval(()=>{
      try {
        if(this.stopped)this.relievePressure();
        if(this.inFlight && Atomics.load(this.signal,0)!==0)this.finishWorker();
        const retryDue=!this.retry || this.storageRetryAt===null || Date.now()>=this.storageRetryAt;
        if(!this.inFlight && retryDue && (this.retry || this.dirtyBytes>=FLUSH_BYTES || (this.dirtySince!==null && Date.now()-this.dirtySince>=DURABLE_BATCH_MS)))this.flushAsync();
      } catch(error) {this.handleFlushFailure(error);}
      if(this.storageStatus==='healthy' && this.pendingAge()>1000)this.fault('flush-overdue','pending age exceeded 1s');
    },5);
    this.timer.unref();
  }
  private reportLegacy(reason:string):void {
    try {this.options.onFault?.({kind:'legacy-archive-unavailable',reason,at:Date.now(),pendingBytes:0});}
    catch {console.error('[newarch] fault sink failed');}
  }
  /** Legacy rows under this pane, if its numbering continues a legacy file. */
  private underlay(key:PaneKey):LegacyFloor|null {
    if(!this.legacy.size)return null;
    const seen=this.legacy.errors.length;
    const floor=this.legacy.floor(key,()=>{
      const no=this.ram.paneNo(key);
      const found=[lowestLine(this.disk,no),lowestLine(this.ram.db,no)].filter((v):v is number=>v!==null);
      return found.length?Math.min(...found):this.ram.token(key).nextLineId;
    });
    for(const reason of this.legacy.errors.slice(seen))this.reportLegacy(reason);
    return floor;
  }
  /** Legacy files layered under this store: how many opened and why the others did not. */
  legacyArchives():{opened:number;errors:string[]} {return {opened:this.legacy.size,errors:[...this.legacy.errors]};}
  private owner():void {
    if(this.closed) throw new Error('store-closed');
    if(Number(Object.values(prepared(this.disk,'PRAGMA application_id').get()!)[0])!==this.fence) throw new Error('stale-writer');
  }
  private recover():void {
    this.ram.db.transaction(()=>{
      for(const row of prepared(this.disk,'SELECT * FROM na_pane').all() as SqlRow[]) {
        if(row.revision!==row.durable_revision) throw new Error('durable-watermark-corrupt');
        upsert(this.ram.db,'na_pane',row);
        const floor=Math.max(0,Number(row.next_line_id)-5000);
        const lines=readDiskLines(this.disk,Number(row.pane_no),floor,Number(row.next_line_id));
        for(const id of new Set(lines.map(l=>l.checked_capture_id).filter(id=>id!==null)))
          upsert(this.ram.db,'na_capture',captureReceipt(this.disk,Number(row.pane_no),String(id)));
        for(const line of lines) upsert(this.ram.db,'na_line',line);
      }
    })();
    this.relievePressure();
    if(this.ram.bytes()>this.cacheMax) throw new Error('recovery-cache-limit');
    this.rejectedRows=Number((prepared(this.disk,"SELECT coalesce(sum(missing_count),0) AS n FROM na_issue WHERE kind IN (?,'ingest-capacity')").get(PROJECTION_OVERSIZE) as SqlRow).n);
    this.degraded=!!prepared(this.ram.db,"SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    const last=prepared(this.disk,'SELECT committed_at FROM na_commit ORDER BY committed_at DESC LIMIT 1').get() as SqlRow|null;
    this.lastCommitAt=last?Number(last.committed_at):null;
  }
  private pendingAge():number {
    const times=[...(this.retry?[this.retry.since]:[]),...(this.dirtySince===null?[]:[this.dirtySince]),...[...this.queues.values()].map(q=>q[0]?.at).filter((v):v is number=>v!==undefined)];
    return times.length?Math.max(0,Date.now()-Math.min(...times)):0;
  }
  private pendingBytes():number {return this.dirtyBytes+this.queuedBytes+(this.retry?.bytes??0);}
  private storageSnapshot(status=this.storageStatus,result=this.storageResult):ProjectionStorageState {
    const panes=(prepared(this.ram.db,'SELECT * FROM na_pane').all() as SqlRow[]).map(p=>({
      paneKey:{serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)},
      sourceEpoch:Number(p.source_epoch),revision:Number(p.revision),durableRevision:Number(p.durable_revision),nextLineId:Number(p.next_line_id)
    }));
    return {status,eventId:this.storageEventId,at:Date.now(),reason:this.storageReason,pendingBytes:this.pendingBytes(),
      unknownTail:status!=='healthy',retry:{batchId:this.retry?.id??this.storageBatchId,attempt:this.storageAttempt,nextAt:this.storageRetryAt,result},panes};
  }
  private emitStorage(status=this.storageStatus,result=this.storageResult):void {
    try {this.options.onStorageState?.(this.storageSnapshot(status,result));}
    catch {console.error('[newarch] storage-state sink failed');}
  }
  private handleFlushFailure(error:unknown):void {
    if(isStorageFull(error)) {
      this.storageEventId??=randomUUID();this.storageStatus='storage-paused';this.storageReason=String(error);
      this.storageBatchId=this.retry?.id??this.storageBatchId;
      this.storageAttempt++;this.storageResult='failed';
      this.storageRetryAt=Date.now()+STORAGE_RETRY_MS[Math.min(this.storageAttempt-1,STORAGE_RETRY_MS.length-1)]!;
      this.stopped=true;this.emitStorage();
    }
    this.fault('flush-failed',String(error));
  }
  private fault(kind:string,reason:string,key?:PaneKey,lostRows=1):void {
    this.degraded=true;
    const now=Date.now();
    const panes=key?[this.ram.pane(key)]:prepared(this.ram.db,'SELECT * FROM na_pane').all() as SqlRow[];
    let emit=false;
    this.ram.db.transaction(()=>{
      for(const p of panes) {
        const tag=String(p.pane_key)+':'+kind, capacity=kind===PROJECTION_OVERSIZE;
        // Capacity refusals that keep recurring are one episode with one issue id,
        // even when the pane briefly recovers between them.
        let previous=this.faults.get(tag);
        if(previous && capacity && now-previous.seen>CAPACITY_EPISODE_MS)previous=undefined;
        const count=(previous?.count??0)+(capacity?lostRows:0);
        if(previous && kind!==PROJECTION_OVERSIZE && now-previous.last<1000)continue;
        if(!this.dirtyFaults.has(tag) && this.pendingBytes()+1024>PENDING_MAX)continue;
        if(!previous || now-previous.last>=1000)emit=true;
        const id=previous?.id??randomUUID();
        prepared(this.ram.db,'UPDATE na_pane SET health=?,revision=revision+1 WHERE pane_key=?').run(p.health==='unverified'?'unverified':'degraded',p.pane_key);
        prepared(this.ram.db,`INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)
          ON CONFLICT(issue_id) DO UPDATE SET revision=excluded.revision,missing_count=excluded.missing_count,reason=excluded.reason`)
          .run(id,p.pane_key,p.source_epoch,Number(p.revision)+1,p.next_line_id,kind,reason,capacity?count:null,previous?.detected??now);
        this.faults.set(tag,{id,pane:String(p.pane_key),last:emit?now:previous!.last,seen:now,detected:previous?.detected??now,count,revision:Number(p.revision)+1});
        // Updates coalesce under one issue id; account metadata once per pending episode.
        if(!this.dirtyFaults.has(tag)){this.dirtyBytes+=1024;this.dirtyFaults.add(tag);}
        this.dirtySince??=now;
      }
    })();
    if(!emit && panes.length)return;
    if(now-(this.faultEmitted.get(kind)??0)<1000)return;
    this.faultEmitted.set(kind,now);
    const fault={kind,reason,at:now,pendingBytes:this.pendingBytes(),panes:panes.map(p=>({
      paneKey:{serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)},
      sourceEpoch:Number(p.source_epoch),boundaryLineId:Number(p.next_line_id),missingCount:kind===PROJECTION_OVERSIZE?lostRows:null}))};
    try {this.options.onFault?.(fault);}catch{console.error('[newarch] fault sink failed');}
    console.error('[newarch]',JSON.stringify(fault));
  }
  /**
   * Admission reads RAM size once per pump turn, not twice per row: it only
   * grows when the pump applies jobs and shrinks on eviction, and both drop
   * the cache. Pending bytes still bound what was admitted but not applied.
   */
  private liveRam():number {
    if(this.ramBytesCache<0)this.ramBytesCache=this.ram.bytes();
    return this.ramBytesCache;
  }
  /** Live roster size, refreshed at most every 250 ms (never a per-row scan). */
  private rosterCount(id:string,now:number):number {
    const seen=this.roster.get(id);this.roster.set(id,now);
    if(seen===undefined || now-seen>ROSTER_MS)this.rosterSize++;
    if(now-this.rosterAt>=250) {
      this.rosterAt=now;
      for(const [pane,at] of this.roster)if(now-at>ROSTER_MS)this.roster.delete(pane);
      this.rosterSize=this.roster.size;
    }
    return Math.max(1,this.rosterSize);
  }
  /**
   * D12 quota. The cap is split in two fixed halves. The guaranteed half is
   * divided among R live panes plus one spare slot for a pane that has not
   * arrived yet: guarantee=min(768 KiB, half/(R+1)). The other half is the
   * borrow pool: one borrower may take half of it, k borrowers pool/k each,
   * and all borrowing together never exceeds it. Borrowing therefore can never
   * eat the guaranteed half, so a late pane is admitted its guarantee while
   * another pane borrows. 'store' = the shared cap itself is full.
   */
  private quota(roster:number):{guarantee:number;pool:number} {
    const half=Math.floor(ADMIT_MAX/2);
    return {guarantee:Math.min(GUARANTEE_MAX,Math.floor(half/(roster+1))),pool:ADMIT_MAX-half};
  }
  /** Largest history event an idle store admits; anything bigger can never be stored. */
  private maxEvent():number {const q=this.quota(1);return q.guarantee+Math.floor(q.pool/2);}
  private capacity(key:PaneKey,bytes:number,frame=false):'ok'|'pane'|'store' {
    if(this.pendingBytes()+bytes>ADMIT_MAX)return 'store';
    if(frame)return 'ok';
    const id=paneId(key),mine=this.pendingByPane.get(id)??0;
    const {guarantee,pool}=this.quota(this.rosterCount(id,Date.now()));
    if(mine+bytes<=guarantee)return 'ok';
    let borrowed=0,borrowers=1;
    for(const [pane,used] of this.pendingByPane)if(pane!==id && used>guarantee){borrowed+=used-guarantee;borrowers++;}
    const mineBorrow=mine+bytes-guarantee;
    return mineBorrow<=Math.floor(pool/Math.max(2,borrowers)) && borrowed+mineBorrow<=pool?'ok':'pane';
  }
  /**
   * FIX1 §3 backpressure: the event is neither stored nor dropped. The caller
   * keeps it, stops reading its source and awaits drained(). No issue row, no
   * lost-row counter, no parser fault: pressure is not loss.
   */
  private pressure(key:PaneKey,bytes:number,scope:'pane'|'store',isScroll:boolean):ProjectionRefusal {
    if(scope==='store'){this.stopped=true;this.pressureBytes=Math.max(this.pressureBytes,bytes);}
    this.pressureRefusals++;
    // Only a refused history row pauses the pane; a refused frame is superseded by the next one.
    if(isScroll)this.refusedBytes.set(paneId(key),bytes);
    this.kickFlush();
    return {accepted:false,reason:'capacity-pressure',scope};
  }
  /**
   * An event bigger than an idle store admits: waiting cannot help, so it is a
   * recorded loss under its own name (M1), never the transient 'capacity-pressure'.
   * `identity` names the event; the same event offered again is refused again
   * but counted once, so a caller that retries cannot grow the loss counters.
   */
  private rejectOversize(key:PaneKey,value:{sourceEpoch:number;geometryGeneration:number},isScroll:boolean,identity:string|null=null):never {
    const id=paneId(key);
    if(identity===null || this.lastOversize.get(id)!==identity) {
      if(identity!==null)this.lastOversize.set(id,identity);
      this.degraded=true;if(isScroll)this.rejectedRows++;
      const pending=this.capacityLosses.get(id);
      if(pending){if(isScroll)pending.count++;}
      else {
        if(!prepared(this.ram.db,'SELECT 1 FROM na_pane WHERE pane_key=?').get(id)) {
          const first=this.queues.get(id)?.[0]??value;this.ram.ensure(key,first.sourceEpoch,first.geometryGeneration);
        }
        this.capacityLosses.set(id,{key:{...key},count:isScroll?1:0});
        this.fault(PROJECTION_OVERSIZE,'incoming event larger than an idle store admits; accepted rows retained',key,0);
      }
    }
    throw new Error(PROJECTION_OVERSIZE);
  }
  /** Resolves when the pane may offer the event it was refused, sized as refused. */
  drained(key:PaneKey):Promise<void> {
    try {
      this.owner();if(this.closing)throw new Error('store-closing');
      const id=paneId(key);
      if(this.admissible(id,key))return Promise.resolve();
      this.kickFlush();
      return new Promise((resolve,reject)=>this.drainWaiters.push({id,key,resolve,reject}));
    }catch(error){return Promise.reject(error);}
  }
  private admissible(id:string,key:PaneKey):boolean {
    const bytes=this.refusedBytes.get(id)??512;
    return !this.stopped && this.liveRam()+bytes<=this.cacheMax && this.capacity(key,bytes)==='ok';
  }
  private settleDrains():void {
    if(!this.drainWaiters.length)return;
    const waiting=this.drainWaiters;this.drainWaiters=[];
    for(const w of waiting) {
      if(this.admissible(w.id,w.key))w.resolve();else this.drainWaiters.push(w);
    }
  }
  /** Durable receipt without blocking the caller (FIX1 §4.3): the disk worker commits, acknowledge() resolves. */
  durable(key:PaneKey,revision:number):Promise<ProjectionReceipt> {
    try {
      this.owner();
      const t=this.ram.token(key);
      if(!Number.isSafeInteger(revision) || revision<0 || revision>t.revision)throw new Error('invalid-revision');
      if(t.durableRevision>=revision)return Promise.resolve({revision:t.revision,durableRevision:t.durableRevision,nextLineId:t.nextLineId});
      const result=new Promise<ProjectionReceipt>((resolve,reject)=>this.durableWaiters.push({key:{...key},revision,resolve,reject}));
      this.kickFlush();return result;
    }catch(error){return Promise.reject(error);}
  }
  private settleDurable(final=false):void {
    if(!this.durableWaiters.length)return;
    const waiting=this.durableWaiters;this.durableWaiters=[];
    for(const w of waiting) {
      const t=this.ram.token(w.key);
      if(t.durableRevision>=w.revision)w.resolve({revision:t.revision,durableRevision:t.durableRevision,nextLineId:t.nextLineId});
      else if(final)w.reject(new Error('store-closed'));
      else this.durableWaiters.push(w);
    }
  }
  /** Reclaim only acknowledged history; no flush is needed to reopen an idle full cache. */
  private relievePressure():void {
    const reserve=Math.max(512,this.pressureBytes,...this.refusedBytes.values());
    if(this.liveRam()+reserve>this.cacheMax) {
      const panes=(prepared(this.ram.db,'SELECT * FROM na_pane').all() as SqlRow[]).map(p=>({...p,revision:p.durable_revision}));
      // Eviction is a cache operation: archived rows remain readable from disk.
      // Halving bounds the number of scans, even with many quiet panes.
      for(let keep=2500;this.liveRam()+reserve>this.cacheMax;keep=Math.floor(keep/2)) {
        this.ram.db.transaction(()=>this.ram.evict(panes,keep))();this.ramBytesCache=-1;
        if(keep===0)break;
      }
    }
    if(this.storageStatus==='healthy' && this.liveRam()+reserve<=this.cacheMax && this.pendingBytes()<PENDING_MAX/2){this.stopped=false;this.pressureBytes=0;}
    this.settleDrains();
  }
  private kickFlush():void {
    if(this.inFlight || this.closed || this.closing)return;
    if(this.retry && this.storageRetryAt!==null && Date.now()<this.storageRetryAt)return;
    try {this.flushAsync();}catch(error){this.handleFlushFailure(error);}
  }
  private drainLosses():void {
    for(const [id,loss] of this.capacityLosses) {
      const tag=id+':'+PROJECTION_OVERSIZE;
      if(!this.dirtyFaults.has(tag) && this.pendingBytes()+1024>PENDING_MAX)continue;
      this.fault(PROJECTION_OVERSIZE,'incoming history event rejected; accepted rows retained',loss.key,loss.count);
      this.capacityLosses.delete(id);
    }
  }
  private reserve(id:string,bytes:number,dirty=false):void {
    const next=(this.pendingByPane.get(id)??0)+bytes;
    if(next===0)this.pendingByPane.delete(id);else this.pendingByPane.set(id,next);
    if(dirty)this.dirtyByPane.set(id,(this.dirtyByPane.get(id)??0)+bytes);
  }
  /**
   * History rows and screen frames are admitted under D12 pressure; issues,
   * transitions and calibrations are small ordered barriers checked against
   * the shared cap only. A barrier refused by a full store is an error the
   * caller retries ('capacity-pressure'), never a parser fault.
   */
  private enqueue(key:PaneKey,input:unknown,operation:(frozen:any)=>ProjectionReceipt,kind:'scroll'|'frame'|'barrier',preparedBytes?:number):Promise<ProjectionAdmission> {
    try {
      if(this.closed)throw new Error('store-closed');
      if(this.closing)throw new Error('store-closing');
      const value=((input as ProjectionCalibration).capture??input) as Pick<ScrollEvent,'sourceEpoch'|'geometryGeneration'>;
      const id=paneId(key),isScroll=kind==='scroll',storeOnly=kind!=='scroll';
      const bytes=preparedBytes??Buffer.byteLength(JSON.stringify(input))+512;
      if(bytes>this.maxEvent())this.rejectOversize(key,value,isScroll);
      const scope=this.liveRam()+bytes>this.cacheMax?'store':this.capacity(key,bytes,storeOnly);
      if(scope!=='ok') {
        if(kind==='barrier'){this.pressure(key,bytes,scope,false);throw new Error('capacity-pressure');}
        return Promise.resolve(this.pressure(key,bytes,scope,isScroll));
      }
      if(isScroll)this.refusedBytes.delete(id);
      const frozen=preparedBytes===undefined?structuredClone(input):input;
      this.reserve(id,bytes);this.queuedBytes+=bytes;
      const screenKey=kind==='frame'?id+':'+(input as ProjectionFrame).kind:undefined;
      const result=new Promise<ProjectionReceipt>((resolve,reject)=>{
        const q=this.queues.get(id)??[];q.push({liveFrame:kind==='frame',barrier:kind==='barrier',screenKey,sourceEpoch:value.sourceEpoch,geometryGeneration:value.geometryGeneration,bytes,at:Date.now(),run:()=>operation(frozen),resolve,reject});this.queues.set(id,q);
      });
      if(!this.pumping) {
        this.pumping=true;
        if(performance.now()-this.pumpTurnAt>=2)setTimeout(()=>{this.pumpTurnAt=performance.now();this.pump();},0);
        else queueMicrotask(()=>this.pump());
      }
      return result;
    } catch(error) {return Promise.reject(error);}
  }
  private pump():void {
    // Admission is only a reservation. Check the fence before applying the
    // queued batch; commitBatch independently checks again inside the disk TX.
    try {this.owner();}catch(error) {
      for(const [id,q] of this.queues)for(const job of q){this.reserve(id,-job.bytes);settle(job,false,error);}
      this.queues.clear();this.queuedBytes=0;this.pumping=false;return;
    }
    let processed=0;const started=performance.now(),work:Array<{id:string;job:Job}>=[];
    while(this.queues.size && processed<128 && (processed===0 || performance.now()-started<4)) {
      // Rotate after each row, including when the time slice ends mid-round.
      const [id,q]=this.queues.entries().next().value!;
      // A calibration barrier owns its transaction: at most 256 mapped rows,
      // without preceding scroll jobs enlarging that commit.
      if(q[0]!.barrier && work.length)break;
      this.queues.delete(id);const job=q.shift()!;if(q.length)this.queues.set(id,q);
      this.queuedBytes-=job.bytes;
      work.push({id,job});processed++;
      if(job.barrier)break;
    }
    const results:Array<{id:string;job:Job;receipt?:ProjectionReceipt;error?:unknown}>=[];
    try {
      // One outer RAM transaction amortizes SQLite transaction overhead across
      // all panes ready in this pump turn. Each job keeps a nested savepoint so
      // one malformed event cannot leave a partial mutation behind.
      this.ram.db.transaction(()=>{
        for(const {id,job} of work)try {
          const receipt=this.ram.db.transaction(()=>job.run())();
          results.push({id,job,receipt});
        }catch(error){results.push({id,job,error});}
      })();
      this.ramBatches++;this.ramBatchOperations+=work.length;
      for(const {id,job,receipt,error} of results)if(error===undefined) {
        // A frame replaces the pane's previous unflushed frame of the same kind:
        // release that one, exactly as the fast path reserves only the delta.
        const replaced=job.screenKey?this.screenBytes.get(job.screenKey)??0:0;
        if(job.screenKey){this.screenBytes.set(job.screenKey,job.bytes);this.reserve(id,-replaced);}
        this.dirtyByPane.set(id,(this.dirtyByPane.get(id)??0)+job.bytes-replaced);
        this.dirtyBytes+=job.bytes-replaced;this.dirtySince??=job.at;settle(job,true,receipt!);
      } else {this.reserve(id,-job.bytes);settle(job,false,error);}
    }catch(error) {
      for(const {id,job} of work){this.reserve(id,-job.bytes);settle(job,false,error);}
    }
    this.ramBytesCache=-1;
    if(this.queues.size)setTimeout(()=>{this.pumpTurnAt=performance.now();this.pump();},0);else this.pumping=false;
  }
  appendScroll(event:ScrollEvent):Promise<ProjectionAdmission> {
    try {
      // Freeze the physical cells once, in the same lossless representation held
      // by RAM/disk. Queues retain strings, not hundreds of cloned cell objects.
      if(this.closed)throw new Error('store-closed');
      if(this.closing)throw new Error('store-closing');
      if(this.storageStatus!=='healthy')return Promise.resolve(this.pressure(event.paneKey,512,'store',true));
      const id=paneId(event.paneKey),text=event.physicalRow.text,estimate=text.length+512;
      // Decide from the text size before touching cells: a refused row is never copied.
      if(estimate>this.maxEvent())this.rejectOversize(event.paneKey,event,true,`${event.sourceEpoch}:${event.receiveSeq}:${text.length}:${text.slice(0,32)}:${text.slice(-32)}`);
      // A pane with a refused row stays paused until that row fits again, so no
      // later row can overtake it (the caller re-offers the refused row first).
      const paused=this.refusedBytes.get(id);
      if(paused!==undefined && !this.admissible(id,event.paneKey))return Promise.resolve(this.pressure(event.paneKey,Math.max(paused,estimate),'pane',true));
      const scope=this.liveRam()+estimate>this.cacheMax?'store':this.capacity(event.paneKey,estimate);
      if(scope!=='ok')return Promise.resolve(this.pressure(event.paneKey,estimate,scope,true));
      const cells=event.physicalRow.cells;
      validateRow({text,cells});
      const stored=encodeRow(text,cells);
      const frozen={paneKey:{...event.paneKey},sourceEpoch:event.sourceEpoch,geometryGeneration:event.geometryGeneration,
        receiveSeq:event.receiveSeq,softWrap:event.softWrap,physicalRow:{text,cells:[]},stored};
      const bytes=Buffer.byteLength(stored.text)+Buffer.byteLength(stored.cells)+Buffer.byteLength(id)+512;
      return this.enqueue(frozen.paneKey,frozen,e=>this.ram.append(e,e.stored),'scroll',bytes);
    }catch(error){return Promise.reject(error);}
  }
  /**
   * FIX1 §4 screen fast path. A frame of the generation every queued job of its
   * pane already has is written to RAM now and resolves at once; it never waits
   * behind queued history rows. Its receipt carries the nextLineId of history
   * already in RAM, so a viewer joins screen and history on one revision and
   * sees the queued rows follow. Only a generation change or an ordered barrier
   * (issue/transition/calibration) still queues, so it cannot invalidate rows
   * accepted before it.
   */
  replaceScreen(frame:ProjectionFrame):Promise<ProjectionAdmission> {
    try {
      this.owner();if(this.closing)throw new Error('store-closing');
      if(this.storageStatus!=='healthy')return Promise.resolve(this.pressure(frame.paneKey,512,'store',false));
      const pane=paneId(frame.paneKey),id=pane+':'+frame.kind;
      const same=(job:Job)=>job.sourceEpoch===frame.sourceEpoch && job.geometryGeneration===frame.geometryGeneration && !job.barrier;
      const queued=this.queues.get(pane)??[];
      let fence=-1;queued.forEach((job,i)=>{if(!same(job))fence=i;});
      if(fence>=0) {
        // Coalesce only with frames behind the last barrier/transition (F15).
        const prior=queued.findIndex((job,i)=>i>fence && job.screenKey===id);
        if(prior>=0) {
          const job=queued[prior];
          const result=this.coalesce(job,frame);
          queued.splice(prior,1);queued.push(job);return result;
        }
        validateFrame(frame);
        const encoded=encodeFrameCells(frame.cells), frozen={...structuredClone({...frame,cells:[]}),encodedCells:encoded};
        return this.enqueue(frame.paneKey,frozen,f=>{this.ram.screen(f,null,null,[],f.encodedCells);return this.ram.bump(f.paneKey);},'frame',Buffer.byteLength(encoded)+Buffer.byteLength(pane)+512);
      }
      const previous=this.screenBytes.get(id)??0;
      validateFrame(frame);
      const encoded=encodeFrameCells(frame.cells);
      const bytes=Buffer.byteLength(encoded)+Buffer.byteLength(pane)+512,delta=bytes-previous;
      if(bytes>this.maxEvent())this.rejectOversize(frame.paneKey,frame,false,`frame:${frame.sourceEpoch}:${frame.receiveSeq}:${bytes}`);
      const scope=this.liveRam()+Math.max(0,delta)>this.cacheMax?'store':this.capacity(frame.paneKey,delta,true);
      if(scope!=='ok')return Promise.resolve(this.pressure(frame.paneKey,bytes,scope,false));
      const receipt=this.ram.db.transaction(()=>{this.ram.screen(frame,null,null,[],encoded);return this.ram.bump(frame.paneKey);})();
      if(delta>0)this.ramBytesCache=-1;
      this.reserve(pane,delta,true);this.dirtyBytes+=delta;this.screenBytes.set(id,bytes);this.dirtySince??=Date.now();
      // An older frame of this kind still queued (behind a barrier that has since
      // run) is superseded: it must never land over the newer screen.
      for(let i=queued.length-1;i>=0;i--)if(queued[i].screenKey===id) {
        const [old]=queued.splice(i,1);this.reserve(pane,-old.bytes);this.queuedBytes-=old.bytes;settle(old,true,receipt);
      }
      if(!queued.length)this.queues.delete(pane);
      return Promise.resolve(receipt);
    }catch(error){return Promise.reject(error);}
  }
  /** The newer frame takes the queued frame's place and reservation. */
  private coalesce(tail:Job,frame:ProjectionFrame):Promise<ProjectionAdmission> {
    // Validate before touching the tail: a bad frame is refused alone, the queued frame keeps its job.
    validateFrame(frame);
    const id=paneId(frame.paneKey),encoded=encodeFrameCells(frame.cells),bytes=Buffer.byteLength(encoded)+Buffer.byteLength(id)+512+128*((tail.waiters?.length??0)+1),delta=bytes-tail.bytes;
    if(bytes>this.maxEvent())this.rejectOversize(frame.paneKey,frame,false,`frame:${frame.sourceEpoch}:${frame.receiveSeq}:${bytes}`);
    const scope=this.liveRam()+Math.max(0,delta)>this.cacheMax?'store':this.capacity(frame.paneKey,delta,true);
    if(scope!=='ok')return Promise.resolve(this.pressure(frame.paneKey,bytes,scope,false));
    const frozen=structuredClone({...frame,cells:[]});
    tail.run=()=>{this.ram.screen(frozen,null,null,[],encoded);return this.ram.bump(frozen.paneKey);};
    this.reserve(id,delta);this.queuedBytes+=delta;tail.bytes=bytes;
    return new Promise<ProjectionReceipt>((resolve,reject)=>{(tail.waiters??=[]).push({resolve,reject});});
  }
  /**
   * F12: expectedRevision is the revision the caller read, compared when the
   * job is admitted. Rows and frames admitted before it for the same pane then
   * run first by queue order; they no longer make the CAS fail.
   */
  private admitCas(issue:ProjectionIssueInput):void {
    if(this.closed)throw new Error('store-closed');
    if(this.ram.revisionOf(issue.paneKey)!==issue.expectedRevision)throw new Error('stale-revision');
  }
  recordIssue(issue:ProjectionIssueInput):Promise<ProjectionReceipt> {
    try {this.admitCas(issue);}catch(error){this.externalFault(issue,error);return Promise.reject(error);}
    return (this.enqueue(issue.paneKey,issue,value=>{
      const receipt=this.ram.recordIssue(value,undefined,true);this.degraded=true;return receipt;
    },'barrier') as Promise<ProjectionReceipt>).catch(error=>{this.externalFault(issue,error);throw error;});
  }
  /**
   * F11: returns the RAM receipt as soon as the transition is applied in queue
   * order. The disk worker is asked to commit at once; durable(paneKey,
   * receipt.revision) resolves when it has. A disk failure never rejects the
   * transition: it is a flush fault, retried by the flush timer.
   */
  transitionEpoch(change:ProjectionEpochTransition):Promise<ProjectionReceipt> {
    try {this.admitCas(change);}catch(error){this.externalFault(change,error);return Promise.reject(error);}
    return (this.enqueue(change.paneKey,change,value=>{
      const receipt=this.ram.recordIssue(value,value.nextEpoch,true);this.degraded=true;return receipt;
    },'barrier') as Promise<ProjectionReceipt>).then(receipt=>{this.kickFlush();return receipt;},error=>{this.externalFault(change,error);throw error;});
  }
  private externalFault(issue:ProjectionIssueInput,error:unknown):void {
    // The independent host sink remains available when journal admission fails.
    try {this.options.onFault?.({kind:issue.kind,reason:issue.reason+'; journal rejected: '+String(error),at:Date.now(),pendingBytes:this.pendingBytes(),panes:[{paneKey:{...issue.paneKey},sourceEpoch:issue.sourceEpoch,boundaryLineId:issue.boundaryLineId,missingCount:issue.missingCount}]});}
    catch {console.error('[newarch] fault sink failed');}
  }
  /**
   * A calibration with screen evidence keeps its strict run-time CAS: any frame
   * or row admitted since the caller's read bumps the revision, which is exactly
   * the quiescence the displayed-screen overwrite needs (FIX1 §1.2), so a pane
   * with queued work fails fast instead of waiting to fail. A history-only
   * calibration (no quiescent evidence) is never refused for queued work or a
   * moved revision (M2): it runs in queue order and its rows are compared byte
   * for byte in the transaction. 'stale-revision' is the one CAS conflict error.
   */
  calibrate(change:ProjectionCalibration):Promise<ProjectionReceipt> {
    const historyOnly=change.captureEvidence?.kind!=='quiescent';
    try {
      if(this.closed)throw new Error('store-closed');
      const pane=paneId(change.capture.paneKey),revision=this.ram.revisionOf(change.capture.paneKey);
      if(historyOnly?change.expectedRevision>revision:this.queues.get(pane)?.length || revision!==change.expectedRevision)throw new Error('stale-revision');
    }catch(error){return Promise.reject(error);}
    try {
      // Freeze in the lossless on-disk representation. No full-cell JSON copy,
      // and no request can silently certify rows omitted by a size limit.
      const c=change.capture;
      validateFrame(c);
      const seenLines=new Set<number>(),seenRows=new Set<number>();
      for(const m of [...change.checks,...change.repairs,...(change.contentMatches??[])]) {
        if(!Number.isSafeInteger(m.lineId) || m.lineId<0 || !Number.isSafeInteger(m.captureRow)
          || m.captureRow<0 || !c.history[m.captureRow] || seenLines.has(m.lineId) || seenRows.has(m.captureRow))throw new Error('duplicate-or-invalid-mapping');
        seenLines.add(m.lineId);seenRows.add(m.captureRow);
      }
      const history=c.history.map(row=>{validateRow(row);return {text:row.text,encoded:encodeCells(row.cells)};});
      const encodedScreen=encodeFrameCells(c.cells);
      const metadata=structuredClone({...change,capture:{...c,cells:[],history:[]},checks:[],repairs:[],contentMatches:[]});
      const repairs=change.repairs.map(r=>{validateRow(r.physicalRow);return {...r,physicalRow:{text:r.physicalRow.text,encoded:encodeCells(r.physicalRow.cells)}};});
      const checks=change.checks.map(r=>({...r})),matches=(change.contentMatches??[]).map(r=>({...r}));
      const chunkSize=256, count=Math.max(1,Math.ceil(history.length/chunkSize)),batchId=randomUUID();
      const chunks=Array.from({length:count},(_,i)=>{
        const start=i*chunkSize,end=start+chunkSize;
        const mapped=<T extends {captureRow:number}>(rows:T[])=>rows.filter(r=>r.captureRow>=start && r.captureRow<end).map(r=>({...r,captureRow:r.captureRow-start}));
        const chunk={...metadata,expectedRevision:change.expectedRevision+i,
          captureEvidence:i===count-1?metadata.captureEvidence:null,
          capture:{...metadata.capture,encodedScreen,history:history.slice(start,end),
            captureId:count===1?c.captureId:`${c.captureId}:${batchId}:${i}`,firstHistoryRow:c.firstHistoryRow+start},
          checks:mapped(checks),contentMatches:mapped(matches),repairs:mapped(repairs)};
        // JSON now contains RLE strings, never expanded cell objects.
        return {chunk,bytes:Buffer.byteLength(JSON.stringify(chunk))+512};
      });
      const jobs=chunks.map(({chunk,bytes})=>this.enqueue(c.paneKey,chunk,f=>{
        const physical=(row:{text:string;encoded:string})=>({text:row.text,cells:decodeCells(row.encoded)});
        const thawed={...f,capture:{...f.capture,cells:decodeFrameCells(f.capture.encodedScreen),history:f.capture.history.map(physical)},
          repairs:f.repairs.map((r:any)=>({...r,physicalRow:physical(r.physicalRow)}))};
        // All chunks of a quiescent request retain CAS, even though only the
        // last chunk replaces the screen. Moving output must never be hidden.
        // Pressure may have evicted durable rows needed by this capture.
        // Reload only this bounded chunk, including its existing FK receipts.
        const no=this.ram.paneNo(f.capture.paneKey);
        const missing=[...f.checks,...f.repairs,...f.contentMatches].map(m=>m.lineId)
          .filter(lineId=>!prepared(this.ram.db,'SELECT 1 FROM na_line WHERE pane_no=? AND line_id=?').get(no,lineId));
        if(missing.length) {
          const wanted=new Set(missing);
          for(const row of readDiskLines(this.disk,no,Math.min(...missing),Math.max(...missing)+1)) {
            if(!wanted.has(Number(row.line_id)))continue;
            if(row.checked_capture_id!==null) {
              upsert(this.ram.db,'na_capture',captureReceipt(this.disk,no,String(row.checked_capture_id)));
            }
            upsert(this.ram.db,'na_line',row);
          }
        }
        return this.ram.calibrate(thawed,historyOnly);
      },'barrier',bytes) as Promise<ProjectionReceipt>);
      return Promise.allSettled(jobs).then(results=>{
        const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
        return (results[results.length-1] as PromiseFulfilledResult<ProjectionReceipt>).value;
      });
    }catch(error){return Promise.reject(error);}
  }
  token(key:PaneKey):ProjectionToken {this.owner();return this.ram.token(key);}
  screen(key:PaneKey,kind:'normal'|'alternate'='normal'):SqlRow|null {
    this.owner();const row=prepared(this.ram.db,'SELECT * FROM na_screen WHERE pane_key=? AND screen_kind=?').get(paneId(key),kind) as SqlRow|null;
    return row?{...row,cells_json:JSON.stringify(decodeFrameCells(String(row.cells_json)))}:null;
  }
  readPage(token:ProjectionToken,anchor:number|null,limit:number) {this.owner();return readProjectionPage(this.ram,this.disk,token,anchor,limit,this.underlay(token.paneKey));}
  private snapshot():Batch|null {
    if(this.retry)return this.retry;
    this.drainLosses();
    if(!this.dirtyBytes && this.dirtySince===null)return null;
    const panes=prepared(this.ram.db,'SELECT * FROM na_pane WHERE revision>durable_revision').all() as SqlRow[];
    const tables=new Map<string,SqlRow[]>();
    for(const table of ['na_capture','na_line','na_issue']) {
      const rows:SqlRow[]=[];
      // na_issue is keyed by pane_key; receipts and lines by pane_no.
      const column=table==='na_issue'?'pane_key':'pane_no';
      for(const p of panes)rows.push(...prepared(this.ram.db,`SELECT * FROM ${table} WHERE ${column}=? AND revision>?`).all(p[column],p.durable_revision) as SqlRow[]);
      tables.set(table,rows);
    }
    const digest=createHash('sha256').update(JSON.stringify([panes,[...tables]])).digest('hex');
    this.retry={id:randomUUID(),digest,panes,tables,bytes:this.dirtyBytes,since:this.dirtySince??Date.now(),byPane:this.dirtyByPane};
    this.dirtyBytes=0;this.dirtyByPane=new Map();this.dirtySince=null;this.screenBytes.clear();this.dirtyFaults.clear();
    return this.retry;
  }
  private acknowledge():void {
    const batch=this.retry!;
    this.options.checkpoint?.('after-disk-commit',batch.id);
    this.options.checkpoint?.('before-watermark',batch.id);
    this.ram.db.transaction(()=>{
      for(const p of batch.panes)prepared(this.ram.db,'UPDATE na_pane SET durable_revision=? WHERE pane_key=?').run(p.revision,p.pane_key);
      this.ram.evict(batch.panes);
    })();
    this.lastCommitAt=Date.now();this.lastFlushAgeMs=this.lastCommitAt-batch.since;
    for(const [id,bytes] of batch.byPane)this.reserve(id,-bytes);
    if(this.storageStatus!=='healthy')this.storageBatchId=batch.id;
    this.retry=null;
    if(this.storageStatus==='storage-paused') {
      this.storageStatus='recovering';this.storageRetryAt=null;this.storageResult='succeeded';this.emitStorage('recovering','succeeded');
    }
    this.drainLosses();
    // Pressure clears only once RAM has room for an event again, not merely when disk caught up.
    this.ramBytesCache=-1;
    this.relievePressure();
    if(!this.stopped && this.pendingBytes()<PENDING_MAX/2 && this.liveRam()+512<=this.cacheMax) {
      // Only clear a fault once its latest revision reached disk. Recovery itself
      // is another dirty pane revision, so the persisted health follows reality.
      for(const p of batch.panes) {
        if(p.health==='degraded' && this.ram.pane({serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)}).health==='degraded' && this.pendingBytes()+512<=PENDING_MAX && !this.capacityLosses.has(String(p.pane_key)) && ![...this.faults.values()].some(f=>f.pane===p.pane_key && f.revision>Number(p.revision))) {
          prepared(this.ram.db,"UPDATE na_pane SET health='healthy',revision=revision+1 WHERE pane_key=?").run(p.pane_key);
          // Keep capacity episodes open so a refusal right after recovery reuses the issue.
          for(const [tag,f] of this.faults)if(f.pane===p.pane_key && !tag.endsWith(':'+PROJECTION_OVERSIZE))this.faults.delete(tag);
          this.dirtyBytes+=512;this.dirtySince??=Date.now();
        }
      }
      this.degraded=!!prepared(this.ram.db,"SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    }
    const now=Date.now();
    for(const [tag,f] of this.faults)if(tag.endsWith(':'+PROJECTION_OVERSIZE) && now-f.seen>CAPACITY_EPISODE_MS && !this.capacityLosses.has(f.pane))this.faults.delete(tag);
    this.settleDurable();this.settleDrains();
    if(this.storageStatus==='recovering' && this.retry===null && this.dirtyBytes===0 && this.dirtySince===null) {
      this.storageStatus='healthy';this.stopped=false;this.storageReason=null;this.storageRetryAt=null;this.emitStorage('healthy','succeeded');
      this.storageEventId=null;this.storageAttempt=0;this.storageResult=null;this.storageBatchId=null;
      this.settleDrains();
    }
  }
  private finishWorker():void {
    const state=Atomics.load(this.signal,0);
    if(!state)return;
    this.inFlight=false;
    if(state===2)throw new Error(new TextDecoder().decode(new Uint8Array(this.signal.buffer,8,Atomics.load(this.signal,1))));
    const totalMs=Atomics.load(this.signal,2)/1000,writeMs=Atomics.load(this.signal,3)/1000;
    this.diskTiming={totalMs,writeMs,commitMs:totalMs-writeMs};
    this.acknowledge();
  }
  private ensureWorker():void {
    if(this.worker)return;
    this.worker=new Worker(new URL(import.meta.url),{workerData:{projectionDiskWriter:true,file:this.file,fence:this.fence,signal:this.signal.buffer}});
    const failed=(error:unknown)=>{
      if(this.closed)return;
      const bytes=new TextEncoder().encode(String(error)).subarray(0,4096);
      new Uint8Array(this.signal.buffer,8).set(bytes);Atomics.store(this.signal,1,bytes.length);Atomics.store(this.signal,0,2);Atomics.notify(this.signal,0);
    };
    this.worker.on('message',(id:string)=>{
      if(this.closed || !this.inFlight || this.retry?.id!==id)return;
      try {
        this.finishWorker();
        if(!this.closing && (this.dirtyBytes || this.dirtySince!==null))this.flushAsync();
      }catch(error){this.handleFlushFailure(error);}
    });
    this.worker.on('error',failed);
    this.worker.on('exit',code=>{this.worker=null;if(!this.closed)failed(new Error(`disk-worker-exited:${code}`));});
    this.worker.unref();
  }
  private flushAsync():void {
    this.owner();const batch=this.snapshot();if(!batch)return;
    this.ensureWorker();
    this.options.checkpoint?.('before-disk-commit',batch.id);
    Atomics.store(this.signal,0,0);this.inFlight=true;this.worker!.postMessage(batch);
  }
  /** Explicit durability barrier remains synchronous; the ingest pump never calls it. */
  flush():void {
    this.owner();
    try {
      if(this.inFlight) {
        if(Atomics.wait(this.signal,0,0,5000)==='timed-out')throw new Error('disk-worker-timeout');
        this.finishWorker();
      }
      let batch:Batch|null;
      while((batch=this.snapshot())) {
        const current=batch;
        this.diskTiming=commitBatch(this.disk,this.fence,current,()=>this.options.checkpoint?.('before-disk-commit',current.id),false,true);
        this.acknowledge();
      }
      // A prior asynchronous commit may have drained the final dirty batch.
      // The explicit barrier still performs derived compaction for every pane;
      // otherwise quiet panes keep one receipt row per capture indefinitely.
      this.disk.transaction(()=>{
        const panes=prepared(this.disk,'SELECT * FROM na_pane').all() as SqlRow[];
        sealBlocks(this.disk,panes,true);archiveCaptures(this.disk,panes,true);
      }).immediate();
      this.disk.exec('PRAGMA incremental_vacuum');
      this.disk.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }catch(error){this.handleFlushFailure(error);throw error;}
  }
  /**
   * One pane's status and issues, as `health()` reports them for that pane,
   * without the store-wide figures (RSS, RAM pages, pending bytes) or the
   * other panes' rows: a live snapshot reads this on every publish.
   */
  paneHealth(key:PaneKey):{status:'healthy'|'degraded';issues:ProjectionIssue[]}|null {
    this.owner();
    const id=paneId(key),p=prepared(this.ram.db,'SELECT health,revision FROM na_pane WHERE pane_key=?').get(id) as SqlRow|null;
    if(!p)return null;
    const issues=new Map<string,SqlRow>();
    for(const db of [this.disk,this.ram.db])for(const issue of prepared(db,'SELECT * FROM na_issue WHERE pane_key=?').all(id) as SqlRow[])
      if(Number(issue.revision)<=Number(p.revision))issues.set(String(issue.issue_id),issue);
    return {status:p.health==='healthy'?'healthy':'degraded',
      issues:[...issues.values()].sort((a,b)=>Number(a.revision)-Number(b.revision)).map(projectionIssue)};
  }
  health():ProjectionHealth {
    this.owner();if(this.storageStatus==='healthy' && this.pendingAge()>1000 && !this.degraded)this.fault('flush-overdue','pending age exceeded 1s');
    const rows=prepared(this.ram.db,'SELECT * FROM na_pane').all() as SqlRow[];
    const revisions=new Map(rows.map(p=>[String(p.pane_key),Number(p.revision)]));
    const byPane=new Map<string,Map<string,SqlRow>>();
    // Health is sampled on the ingest thread. Two bulk issue reads replace
    // four SQL lookups per pane; RAM still overlays the durable revision.
    for(const db of [this.disk,this.ram.db])for(const issue of prepared(db,'SELECT * FROM na_issue').all() as SqlRow[]) {
      const id=String(issue.pane_key);
      if(Number(issue.revision)>(revisions.get(id)??-1))continue;
      let issues=byPane.get(id);if(!issues){issues=new Map();byPane.set(id,issues);}
      issues.set(String(issue.issue_id),issue);
    }
    const panes=rows.map(p=>({
      paneKey:{serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)},
      sourceEpoch:Number(p.source_epoch),geometryGeneration:Number(p.geometry_generation),revision:Number(p.revision),
      durableRevision:Number(p.durable_revision),nextLineId:Number(p.next_line_id),
      status:p.health==='healthy'?'healthy' as const:'degraded' as const,
      recovery:p.health==='unverified'?'external' as const:'automatic' as const,
      issues:[...(byPane.get(String(p.pane_key))?.values()??[])].sort((a,b)=>Number(a.revision)-Number(b.revision)).map(projectionIssue)
    }));
    return {pressure:this.stopped || this.refusedBytes.size?'recoverable':'none',pressureRefusals:this.pressureRefusals,status:this.stopped?'stopped':this.degraded?'degraded':'healthy',pendingBytes:this.pendingBytes(),rejectedRows:this.rejectedRows,
      pendingAgeMs:this.pendingAge(),ramBytes:this.ram.bytes(),rssBytes:process.memoryUsage().rss,lastFlushAgeMs:this.lastFlushAgeMs,lastCommitAt:this.lastCommitAt,
      ramBatches:this.ramBatches,ramBatchOperations:this.ramBatchOperations,
      averageRamOperationsPerBatch:this.ramBatches?this.ramBatchOperations/this.ramBatches:0,storage:this.storageSnapshot(),panes};
  }
  async close():Promise<ProjectionCloseReceipt> {
    if(this.closed)return this.closeReceipt!;
    this.closing=true;clearInterval(this.timer);
    try {
      while(this.pumping)await new Promise(resolve=>setTimeout(resolve,1));
      try {this.flush();}
      catch(error) {
        if(!isStorageFull(error))throw error;
        this.storageStatus='closed-incomplete';this.storageReason=String(error);this.storageResult='failed';this.storageRetryAt=null;this.emitStorage();
      }
      const storage=this.storageSnapshot();
      this.closeReceipt={drained:storage.status==='healthy' && storage.pendingBytes===0,
        unknownTail:storage.status!=='healthy',pendingBytes:storage.pendingBytes,storage};
    } finally {
      if(this.closeReceipt===null) {
        const storage=this.storageSnapshot();
        this.closeReceipt={drained:false,unknownTail:storage.status!=='healthy',pendingBytes:storage.pendingBytes,storage};
      }
      try {this.settleDurable(true);}catch{for(const w of this.durableWaiters.splice(0))w.reject(new Error('store-closed'));}
      for(const w of this.drainWaiters.splice(0))w.reject(new Error('store-closed'));
      this.closed=true;
      try {await this.stopWorker();}
      finally {this.legacy.close();closePrepared(this.ram.db);closePrepared(this.disk);}
    }
    return this.closeReceipt!;
  }
  /** DB.close() runs in its owning thread; a stuck worker is terminated, never thrown at the caller. */
  private async stopWorker():Promise<void> {
    const worker=this.worker;if(!worker)return;
    const exited=await new Promise<boolean>(resolve=>{
      const timer=setTimeout(()=>resolve(false),5000);
      worker.once('exit',()=>{clearTimeout(timer);resolve(true);});
      worker.postMessage('close');
    });
    if(!exited) {
      console.error('[newarch] disk worker did not exit after close; terminating');
      try {this.options.onFault?.({kind:'shutdown-timeout',reason:'disk worker did not acknowledge close; emergency termination',at:Date.now(),pendingBytes:this.pendingBytes()});}catch{console.error('[newarch] fault sink failed');}
      await worker.terminate().catch(()=>{});
    }
  }
}
export function createProjectionStore(options:ProjectionOptions):ProjectionStore {return new ProjectionStore(options);}
export { PROJECTION_MIGRATION };
