import { Database } from 'bun:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_MIGRATION, PROJECTION_SCHEMA, PROJECTION_SCHEMA_MARKERS, PROJECTION_SCHEMA_VERSION } from './schema';
import { ProjectionRam, paneId, upsert, decodeFrameCells, encodeCells, encodeFrameCells, validateFrame, validateRow, type SqlRow } from './ram-store';
import { readProjectionPage, projectionIssue } from './projection-reader';
import { PROJECTION_OVERSIZE } from './types';
import type { PaneKey, ProjectionAdmission, ProjectionCalibration, ProjectionIssueInput, ProjectionEpochTransition, ProjectionFault, ProjectionFrame, ProjectionHealth, ProjectionReceipt, ProjectionRefusal, ProjectionToken, ProjectionWriterPort, ScrollEvent } from './types';

const PENDING_MAX=16*1024*1024, CACHE_MAX=256*1024*1024, FLUSH_BYTES=1024*1024, DURABLE_BATCH_MS=20;
const ADMIT_MAX=PENDING_MAX-64*1024, CAPACITY_EPISODE_MS=10000;
// D12 (FIX1 §3): every pane in the live roster owns a guaranteed quota; the
// rest of the cap is a borrow pool. A pane that sent nothing for ROSTER_MS
// leaves the roster, so dead or quiet panes do not pin a share forever.
const GUARANTEE_MAX=768*1024, ROSTER_MS=30000;
export interface ProjectionOptions {
  historyRoot: string; file?: string; mode: 'create'|'recover';
  /** RAM working-set cap; defaults to 256 MiB. Tests lower it to reach the cap with real rows. */
  cacheBytes?: number;
  onFault?: (fault: ProjectionFault)=>void;
  /** Fault/crash probes, never a replacement persistence backend. */
  checkpoint?: (phase:'before-disk-commit'|'after-disk-commit'|'before-watermark',commitId:string)=>void;
  beforeOpen?: (file:string)=>void;
}
function admitPath(options: ProjectionOptions): string {
  const root=resolve(options.historyRoot), file=resolve(options.file??join(root,'newarch-v3/history.sqlite3'));
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
      if(n!==100 || head.subarray(0,16).toString()!=='SQLite format 3\0' || head.readUInt32BE(60)!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v3');
    } finally { closeSync(fd); }
  } else {
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    const fd=openSync(file,'wx',0o600);closeSync(fd);
  }
  return file;
}

type Batch={id:string;digest:string;panes:SqlRow[];tables:Map<string,SqlRow[]>;bytes:number;since:number;byPane:Map<string,number>};
function commitBatch(disk:Database, fence:number, batch:Batch, before?:()=>void, checkpoint=false) {
  const started=performance.now();let writeMs=0;
  disk.transaction(()=>{
    if(Number(Object.values(disk.query('PRAGMA application_id').get()!)[0])!==fence) throw new Error('stale-writer');
    const existing=disk.query('SELECT digest FROM na_commit WHERE commit_id=?').get(batch.id) as SqlRow|null;
    if(existing) {if(existing.digest!==batch.digest)throw new Error('commit-id-conflict');writeMs=performance.now()-started;return;}
    for(const p of batch.panes) upsert(disk,'na_pane',{...p,durable_revision:p.revision});
    for(const [table,rows] of batch.tables)for(const row of rows)upsert(disk,table,row);
    disk.query('INSERT INTO na_commit VALUES (?,?,?,?,?)').run(batch.id,Math.max(...batch.panes.map(p=>Number(p.revision))),Date.now(),JSON.stringify(batch.panes.map(p=>({paneKey:p.pane_key,revision:p.revision,nextLineId:p.next_line_id}))),batch.digest);
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
  disk.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192;');
  let commits=0;
  const onMessage=(batch:Batch|'close')=>{
    if(batch==='close') {
      try {disk.close();}catch(error){console.error('[newarch] disk worker close failed',String(error));}
      // Bun keeps a worker alive while a parentPort 'message' listener is attached;
      // parentPort.close() alone does not release it, so the thread never exits.
      parentPort!.off('message',onMessage);parentPort!.close();return;
    }
    try {
      const timing=commitBatch(disk,workerData.fence,batch,undefined,++commits%20===0);
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
  private timer:ReturnType<typeof setInterval>;
  private retry:Batch|null=null;
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
      this.disk.exec('PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;');
      this.disk.transaction(()=>{
        const version=Number(Object.values(this.disk.query('PRAGMA user_version').get()!)[0]);
        if(options.mode==='create') {
          if(version!==0 || this.disk.query("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('new-file-required');
          this.disk.exec(PROJECTION_SCHEMA);this.disk.exec(`PRAGMA user_version=${PROJECTION_SCHEMA_VERSION}`);
        } else if(version!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v3');
        else {
          const sql=(this.disk.query("SELECT group_concat(sql,' ') AS s FROM sqlite_master WHERE name IN ('na_line','na_capture')").get() as SqlRow).s;
          if(PROJECTION_SCHEMA_MARKERS.some(m=>!String(sql).includes(m))) throw new Error('projection-schema-outdated');
        }
        const epoch=Number(Object.values(this.disk.query('PRAGMA application_id').get()!)[0]);
        if(epoch<0 || epoch>=2147483647) throw new Error('writer-fence-exhausted');
        this.fence=epoch+1;this.disk.exec(`PRAGMA application_id=${this.fence}`);
      }).immediate();
      // Persist the schema header even when a crash happens before the first projection flush.
      this.disk.exec('PRAGMA wal_checkpoint(FULL)');
      const fd=openSync(dirname(this.file),'r');try {fsyncSync(fd);}finally {closeSync(fd);}
      this.recover();
    } catch(error) { this.disk.close();this.ram.db.close();throw error; }
    try {this.ensureWorker();}catch(error){this.ram.db.close();this.disk.close();throw error;}
    this.timer=setInterval(()=>{
      try {
        if(this.inFlight && Atomics.load(this.signal,0)!==0)this.finishWorker();
        if(!this.inFlight && (this.retry || this.dirtyBytes>=FLUSH_BYTES || (this.dirtySince!==null && Date.now()-this.dirtySince>=DURABLE_BATCH_MS)))this.flushAsync();
      } catch(error) {this.fault('flush-failed',String(error));}
      if(this.pendingAge()>1000)this.fault('flush-overdue','pending age exceeded 1s');
    },5);
    this.timer.unref();
  }
  private owner():void {
    if(this.closed) throw new Error('store-closed');
    if(Number(Object.values(this.disk.query('PRAGMA application_id').get()!)[0])!==this.fence) throw new Error('stale-writer');
  }
  private recover():void {
    this.ram.db.transaction(()=>{
      for(const row of this.disk.query('SELECT * FROM na_pane').all() as SqlRow[]) {
        if(row.revision!==row.durable_revision) throw new Error('durable-watermark-corrupt');
        upsert(this.ram.db,'na_pane',row);
        const id=String(row.pane_key), floor=Math.max(0,Number(row.next_line_id)-5000);
        const captures=this.disk.query(`SELECT * FROM na_capture c WHERE c.pane_key=? AND
          EXISTS(SELECT 1 FROM na_line l WHERE l.pane_key=c.pane_key AND l.line_id>=? AND l.checked_capture_id=c.capture_id)`).all(id,floor) as SqlRow[];
        for(const c of captures) upsert(this.ram.db,'na_capture',c);
        for(const line of this.disk.query('SELECT * FROM na_line WHERE pane_key=? AND line_id>=?').all(id,floor) as SqlRow[]) upsert(this.ram.db,'na_line',line);
      }
    })();
    if(this.ram.bytes()>this.cacheMax) throw new Error('recovery-cache-limit');
    this.rejectedRows=Number((this.disk.query("SELECT coalesce(sum(missing_count),0) AS n FROM na_issue WHERE kind IN (?,'ingest-capacity')").get(PROJECTION_OVERSIZE) as SqlRow).n);
    this.degraded=!!this.ram.db.query("SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    const last=this.disk.query('SELECT committed_at FROM na_commit ORDER BY committed_at DESC LIMIT 1').get() as SqlRow|null;
    this.lastCommitAt=last?Number(last.committed_at):null;
  }
  private pendingAge():number {
    const times=[...(this.retry?[this.retry.since]:[]),...(this.dirtySince===null?[]:[this.dirtySince]),...[...this.queues.values()].map(q=>q[0]?.at).filter((v):v is number=>v!==undefined)];
    return times.length?Math.max(0,Date.now()-Math.min(...times)):0;
  }
  private pendingBytes():number {return this.dirtyBytes+this.queuedBytes+(this.retry?.bytes??0);}
  private fault(kind:string,reason:string,key?:PaneKey,lostRows=1):void {
    this.degraded=true;
    const now=Date.now();
    const panes=key?[this.ram.pane(key)]:this.ram.db.query('SELECT * FROM na_pane').all() as SqlRow[];
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
        this.ram.db.query('UPDATE na_pane SET health=?,revision=revision+1 WHERE pane_key=?').run(p.health==='unverified'?'unverified':'degraded',p.pane_key);
        this.ram.db.query(`INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)
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
    if(scope==='store')this.stopped=true;
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
        if(!this.ram.db.query('SELECT 1 FROM na_pane WHERE pane_key=?').get(id)) {
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
  private kickFlush():void {
    if(this.inFlight || this.closed || this.closing)return;
    try {this.flushAsync();}catch(error){this.fault('flush-failed',String(error));}
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
      this.queues.delete(id);const job=q.shift()!;if(q.length)this.queues.set(id,q);
      this.queuedBytes-=job.bytes;
      work.push({id,job});processed++;
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
      const frozen={paneKey:{...event.paneKey},sourceEpoch:event.sourceEpoch,geometryGeneration:event.geometryGeneration,
        receiveSeq:event.receiveSeq,softWrap:event.softWrap,physicalRow:{text,cells:[]},encodedCells:encodeCells(cells)};
      const bytes=Buffer.byteLength(text)+Buffer.byteLength(frozen.encodedCells)+Buffer.byteLength(id)+512;
      return this.enqueue(frozen.paneKey,frozen,e=>this.ram.append(e,e.encodedCells),'scroll',bytes);
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
    return this.enqueue(change.capture.paneKey,change,c=>this.ram.calibrate(c,historyOnly),'barrier') as Promise<ProjectionReceipt>;
  }
  token(key:PaneKey):ProjectionToken {this.owner();return this.ram.token(key);}
  screen(key:PaneKey,kind:'normal'|'alternate'='normal'):SqlRow|null {
    this.owner();const row=this.ram.db.query('SELECT * FROM na_screen WHERE pane_key=? AND screen_kind=?').get(paneId(key),kind) as SqlRow|null;
    return row?{...row,cells_json:JSON.stringify(decodeFrameCells(String(row.cells_json)))}:null;
  }
  readPage(token:ProjectionToken,anchor:number|null,limit:number) {this.owner();return readProjectionPage(this.ram,this.disk,token,anchor,limit);}
  private snapshot():Batch|null {
    if(this.retry)return this.retry;
    this.drainLosses();
    if(!this.dirtyBytes && this.dirtySince===null)return null;
    const panes=this.ram.db.query('SELECT * FROM na_pane WHERE revision>durable_revision').all() as SqlRow[];
    const tables=new Map<string,SqlRow[]>();
    for(const table of ['na_capture','na_line','na_issue']) {
      const rows:SqlRow[]=[];
      for(const p of panes)rows.push(...this.ram.db.query(`SELECT * FROM ${table} WHERE pane_key=? AND revision>?`).all(p.pane_key,p.durable_revision) as SqlRow[]);
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
      for(const p of batch.panes)this.ram.db.query('UPDATE na_pane SET durable_revision=? WHERE pane_key=?').run(p.revision,p.pane_key);
      this.ram.evict(batch.panes);
    })();
    this.lastCommitAt=Date.now();this.lastFlushAgeMs=this.lastCommitAt-batch.since;
    for(const [id,bytes] of batch.byPane)this.reserve(id,-bytes);
    this.retry=null;
    this.drainLosses();
    // Pressure clears only once RAM has room for an event again, not merely when disk caught up.
    this.ramBytesCache=-1;
    if(this.pendingBytes()<PENDING_MAX/2 && this.liveRam()+512<=this.cacheMax) {
      this.stopped=false;
      // Only clear a fault once its latest revision reached disk. Recovery itself
      // is another dirty pane revision, so the persisted health follows reality.
      for(const p of batch.panes) {
        if(p.health==='degraded' && this.ram.pane({serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)}).health==='degraded' && this.pendingBytes()+512<=PENDING_MAX && !this.capacityLosses.has(String(p.pane_key)) && ![...this.faults.values()].some(f=>f.pane===p.pane_key && f.revision>Number(p.revision))) {
          this.ram.db.query("UPDATE na_pane SET health='healthy',revision=revision+1 WHERE pane_key=?").run(p.pane_key);
          // Keep capacity episodes open so a refusal right after recovery reuses the issue.
          for(const [tag,f] of this.faults)if(f.pane===p.pane_key && !tag.endsWith(':'+PROJECTION_OVERSIZE))this.faults.delete(tag);
          this.dirtyBytes+=512;this.dirtySince??=Date.now();
        }
      }
      this.degraded=!!this.ram.db.query("SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    }
    const now=Date.now();
    for(const [tag,f] of this.faults)if(tag.endsWith(':'+PROJECTION_OVERSIZE) && now-f.seen>CAPACITY_EPISODE_MS && !this.capacityLosses.has(f.pane))this.faults.delete(tag);
    this.settleDurable();this.settleDrains();
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
      }catch(error){this.fault('flush-failed',String(error));}
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
        this.diskTiming=commitBatch(this.disk,this.fence,current,()=>this.options.checkpoint?.('before-disk-commit',current.id));
        this.acknowledge();
      }
      this.disk.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }catch(error){this.fault('flush-failed',String(error));throw error;}
  }
  health():ProjectionHealth {
    this.owner();if(this.pendingAge()>1000 && !this.degraded)this.fault('flush-overdue','pending age exceeded 1s');
    const rows=this.ram.db.query('SELECT * FROM na_pane').all() as SqlRow[];
    const revisions=new Map(rows.map(p=>[String(p.pane_key),Number(p.revision)]));
    const byPane=new Map<string,Map<string,SqlRow>>();
    // Health is sampled on the ingest thread. Two bulk issue reads replace
    // four SQL lookups per pane; RAM still overlays the durable revision.
    for(const db of [this.disk,this.ram.db])for(const issue of db.query('SELECT * FROM na_issue').all() as SqlRow[]) {
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
      averageRamOperationsPerBatch:this.ramBatches?this.ramBatchOperations/this.ramBatches:0,panes};
  }
  async close():Promise<void> {
    if(this.closed)return;
    this.closing=true;clearInterval(this.timer);
    try {
      while(this.pumping)await new Promise(resolve=>setTimeout(resolve,1));
      this.flush();
    } finally {
      try {this.settleDurable(true);}catch{for(const w of this.durableWaiters.splice(0))w.reject(new Error('store-closed'));}
      for(const w of this.drainWaiters.splice(0))w.reject(new Error('store-closed'));
      this.closed=true;
      try {await this.stopWorker();}
      finally {this.ram.db.close();this.disk.close();}
    }
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
