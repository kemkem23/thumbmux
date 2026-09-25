import { Database } from 'bun:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_MIGRATION, PROJECTION_SCHEMA, PROJECTION_SCHEMA_VERSION } from './schema';
import { ProjectionRam, paneId, upsert, decodeFrameCells, encodeCells, encodeFrameCells, validateFrame, validateRow, type SqlRow } from './ram-store';
import { readProjectionPage } from './projection-reader';
import type { PaneKey, ProjectionCalibration, ProjectionFault, ProjectionFrame, ProjectionHealth, ProjectionReceipt, ProjectionToken, ProjectionWriterPort, ScrollEvent } from './types';

const PENDING_MAX=16*1024*1024, CACHE_MAX=256*1024*1024, FLUSH_BYTES=256*1024;
const ADMIT_MAX=PENDING_MAX-64*1024, CAPACITY_EPISODE_MS=10000;
export interface ProjectionOptions {
  historyRoot: string; file?: string; mode: 'create'|'recover';
  onFault?: (fault: ProjectionFault)=>void;
  /** Fault/crash probes, never a replacement persistence backend. */
  checkpoint?: (phase:'before-disk-commit'|'after-disk-commit'|'before-watermark',commitId:string)=>void;
  beforeOpen?: (file:string)=>void;
}
function admitPath(options: ProjectionOptions): string {
  const root=resolve(options.historyRoot), file=resolve(options.file??join(root,'newarch-v2/history.sqlite3'));
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
      if(n!==100 || head.subarray(0,16).toString()!=='SQLite format 3\0' || head.readUInt32BE(60)!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v2');
    } finally { closeSync(fd); }
  } else {
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    const fd=openSync(file,'wx',0o600);closeSync(fd);
  }
  return file;
}

type Batch={id:string;digest:string;panes:SqlRow[];tables:Map<string,SqlRow[]>;bytes:number;since:number;byPane:Map<string,number>};
function commitBatch(disk:Database, fence:number, batch:Batch, before?:()=>void) {
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
  const totalMs=performance.now()-started;return {totalMs,writeMs,commitMs:totalMs-writeMs};
}
// Same module in source and compiled distributions: no extra worker asset/factory.
if(!isMainThread && workerData?.projectionDiskWriter===true) {
  const signal=new Int32Array(workerData.signal);
  const errors=new Uint8Array(workerData.signal,8);
  const disk=new Database(workerData.file,{strict:true});
  disk.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192;');
  const onMessage=(batch:Batch|'close')=>{
    if(batch==='close') {
      try {disk.close();}catch(error){console.error('[newarch] disk worker close failed',String(error));}
      // Bun keeps a worker alive while a parentPort 'message' listener is attached;
      // parentPort.close() alone does not release it, so the thread never exits.
      parentPort!.off('message',onMessage);parentPort!.close();return;
    }
    try {
      const timing=commitBatch(disk,workerData.fence,batch);
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
type Job=Waiter&{liveFrame:boolean;screenKey?:string;sourceEpoch:number;geometryGeneration:number;bytes:number;at:number;run:()=>ProjectionReceipt;waiters?:Waiter[]};
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
  constructor(private readonly options:ProjectionOptions) {
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
        } else if(version!==PROJECTION_SCHEMA_VERSION) throw new Error('not-projection-v2');
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
        if(!this.inFlight && (this.retry || this.dirtyBytes>=FLUSH_BYTES || (this.dirtySince!==null && Date.now()-this.dirtySince>=5)))this.flushAsync();
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
          (EXISTS(SELECT 1 FROM na_line l WHERE l.pane_key=c.pane_key AND l.line_id>=? AND l.checked_capture_id=c.capture_id)
          OR EXISTS(SELECT 1 FROM na_screen s WHERE s.pane_key=c.pane_key AND s.last_capture_id=c.capture_id))`).all(id,floor) as SqlRow[];
        for(const c of captures) upsert(this.ram.db,'na_capture',c);
        for(const line of this.disk.query('SELECT * FROM na_line WHERE pane_key=? AND line_id>=?').all(id,floor) as SqlRow[]) upsert(this.ram.db,'na_line',line);
        for(const screen of this.disk.query('SELECT * FROM na_screen WHERE pane_key=?').all(id) as SqlRow[]) upsert(this.ram.db,'na_screen',screen);
      }
    })();
    if(this.ram.bytes()>CACHE_MAX) throw new Error('recovery-cache-limit');
    this.rejectedRows=Number((this.disk.query("SELECT coalesce(sum(missing_count),0) AS n FROM na_issue WHERE kind='ingest-capacity'").get() as SqlRow).n);
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
        const tag=String(p.pane_key)+':'+kind, capacity=kind==='ingest-capacity';
        // Capacity refusals that keep recurring are one episode with one issue id,
        // even when the pane briefly recovers between them.
        let previous=this.faults.get(tag);
        if(previous && capacity && now-previous.seen>CAPACITY_EPISODE_MS)previous=undefined;
        const count=(previous?.count??0)+(capacity?lostRows:0);
        if(previous && kind!=='ingest-capacity' && now-previous.last<1000)continue;
        if(!this.dirtyFaults.has(tag) && this.pendingBytes()+1024>PENDING_MAX)continue;
        if(!previous || now-previous.last>=1000)emit=true;
        const id=previous?.id??randomUUID();
        this.ram.db.query('UPDATE na_pane SET health=?,revision=revision+1 WHERE pane_key=?').run('degraded',p.pane_key);
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
    const fault={kind,reason,at:now,pendingBytes:this.pendingBytes()};
    try {this.options.onFault?.(fault);}catch{console.error('[newarch] fault sink failed');}
    console.error('[newarch]',JSON.stringify(fault));
  }
  /**
   * 'store' = the shared cap is full; 'pane' = only this pane is over its share.
   * The share divides the cap among panes holding bytes now plus this pane, and
   * keeps one share free for a pane that has not arrived yet: an idle store lends
   * a burst half the cap, twenty-one busy panes each get 1/22.
   * Screen frames skip the share: each pane/kind keeps only its latest frame, so
   * their reservation is bounded by the frame size itself, never by pane count.
   */
  private capacity(key:PaneKey,bytes:number,frame=false):'ok'|'pane'|'store' {
    if(this.pendingBytes()+bytes>ADMIT_MAX)return 'store';
    if(frame)return 'ok';
    const id=paneId(key),mine=this.pendingByPane.get(id)??0;
    const competing=this.pendingByPane.size+(mine>0?0:1);
    return mine+bytes<=Math.floor(ADMIT_MAX/(competing+1))?'ok':'pane';
  }
  private rejectCapacity(key:PaneKey,value:{sourceEpoch:number;geometryGeneration:number},isScroll:boolean,scope:'pane'|'store'):never {
    // One pane over its share degrades that pane; only a full store stops the store.
    if(scope==='store')this.stopped=true;
    this.degraded=true;if(isScroll)this.rejectedRows++;
    const id=paneId(key),pending=this.capacityLosses.get(id);
    if(pending){if(isScroll)pending.count++;}
    else {
      // First rejection publishes health immediately; subsequent rows only add
      // a counter. Never copy, serialize or run SQL for each rejected row.
      if(!this.ram.db.query('SELECT 1 FROM na_pane WHERE pane_key=?').get(id)) {
        const first=this.queues.get(id)?.[0]??value;this.ram.ensure(key,first.sourceEpoch,first.geometryGeneration);
      }
      this.capacityLosses.set(id,{key:{...key},count:isScroll?1:0});
      this.fault('ingest-capacity','incoming history event rejected; accepted rows retained',key,0);
    }
    throw new Error('ingest-capacity');
  }
  private drainLosses():void {
    for(const [id,loss] of this.capacityLosses) {
      const tag=id+':ingest-capacity';
      if(!this.dirtyFaults.has(tag) && this.pendingBytes()+1024>PENDING_MAX)continue;
      this.fault('ingest-capacity','incoming history event rejected; accepted rows retained',loss.key,loss.count);
      this.capacityLosses.delete(id);
    }
  }
  private reserve(id:string,bytes:number,dirty=false):void {
    const next=(this.pendingByPane.get(id)??0)+bytes;
    if(next===0)this.pendingByPane.delete(id);else this.pendingByPane.set(id,next);
    if(dirty)this.dirtyByPane.set(id,(this.dirtyByPane.get(id)??0)+bytes);
  }
  private enqueue(key:PaneKey,input:unknown,operation:(frozen:any)=>ProjectionReceipt,isScroll=true,liveFrame=false,preparedBytes?:number):Promise<ProjectionReceipt> {
    try {
      if(this.closed)throw new Error('store-closed');
      if(this.closing)throw new Error('store-closing');
      const value=(isScroll || liveFrame?input:(input as ProjectionCalibration).capture) as ScrollEvent;
      const id=paneId(key);
      let scope=this.capacity(key,512,liveFrame);if(scope!=='ok')this.rejectCapacity(key,value,isScroll,scope);
      const bytes=preparedBytes??Buffer.byteLength(JSON.stringify(input))+512;
      scope=this.ram.bytes()+bytes>CACHE_MAX?'store':this.capacity(key,bytes,liveFrame);
      if(scope!=='ok')this.rejectCapacity(key,value,isScroll,scope);
      const frozen=preparedBytes===undefined?structuredClone(input):input;
      this.reserve(id,bytes);this.queuedBytes+=bytes;
      const screenKey=liveFrame?id+':'+(input as ProjectionFrame).kind:undefined;
      const result=new Promise<ProjectionReceipt>((resolve,reject)=>{
        const q=this.queues.get(id)??[];q.push({liveFrame,screenKey,sourceEpoch:value.sourceEpoch,geometryGeneration:value.geometryGeneration,bytes,at:Date.now(),run:()=>operation(frozen),resolve,reject});this.queues.set(id,q);
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
    let processed=0;const started=performance.now();
    while(this.queues.size && processed<128 && (processed===0 || performance.now()-started<4)) {
      // Rotate after each row, including when the time slice ends mid-round.
      const [id,q]=this.queues.entries().next().value!;
      this.queues.delete(id);const job=q.shift()!;if(q.length)this.queues.set(id,q);
      this.queuedBytes-=job.bytes;
      try {
        const receipt=this.ram.db.transaction(()=>{
          const receipt=job.run();
          if(!job.liveFrame && this.ram.bytes()>CACHE_MAX)throw new Error('ram-cache-limit');
          return receipt;
        })();
        // A frame replaces the pane's previous unflushed frame of the same kind:
        // release that one, exactly as the fast path reserves only the delta.
        const replaced=job.screenKey?this.screenBytes.get(job.screenKey)??0:0;
        if(job.screenKey){this.screenBytes.set(job.screenKey,job.bytes);this.reserve(id,-replaced);}
        this.dirtyByPane.set(id,(this.dirtyByPane.get(id)??0)+job.bytes-replaced);
        this.dirtyBytes+=job.bytes-replaced;this.dirtySince??=job.at;settle(job,true,receipt);
      }catch(error){this.reserve(id,-job.bytes);settle(job,false,error);}
      processed++;
    }
    if(this.queues.size)setTimeout(()=>{this.pumpTurnAt=performance.now();this.pump();},0);else this.pumping=false;

  }
  appendScroll(event:ScrollEvent):Promise<ProjectionReceipt> {
    try {
      // Freeze the physical cells once, in the same lossless representation held
      // by RAM/disk. Queues retain strings, not hundreds of cloned cell objects.
      if(this.closed)throw new Error('store-closed');
      if(this.closing)throw new Error('store-closing');
      let scope=this.capacity(event.paneKey,512);if(scope!=='ok')this.rejectCapacity(event.paneKey,event,true,scope);
      const text=event.physicalRow.text;
      scope=this.capacity(event.paneKey,text.length+512);if(scope!=='ok')this.rejectCapacity(event.paneKey,event,true,scope);
      const cells=event.physicalRow.cells;
      validateRow({text,cells});
      const frozen={paneKey:{...event.paneKey},sourceEpoch:event.sourceEpoch,geometryGeneration:event.geometryGeneration,
        receiveSeq:event.receiveSeq,softWrap:event.softWrap,physicalRow:{text,cells:[]},encodedCells:encodeCells(cells)};
      const bytes=Buffer.byteLength(text)+Buffer.byteLength(frozen.encodedCells)+Buffer.byteLength(paneId(frozen.paneKey))+512;
      return this.enqueue(frozen.paneKey,frozen,e=>this.ram.append(e,e.encodedCells),true,false,bytes);
    }catch(error){return Promise.reject(error);}
  }
  replaceScreen(frame:ProjectionFrame):Promise<ProjectionReceipt> {
    // Same-generation frames bypass scroll pressure. A generation transition
    // stays behind previously accepted jobs so it cannot invalidate their rows.
    try {
      this.owner();if(this.closing)throw new Error('store-closing');
      const queued=this.queues.get(paneId(frame.paneKey));
      if(queued?.some(job=>job.liveFrame || job.sourceEpoch!==frame.sourceEpoch || job.geometryGeneration!==frame.geometryGeneration)) {
        const tail=queued.at(-1)!;
        if(tail.screenKey===paneId(frame.paneKey)+':'+frame.kind && tail.sourceEpoch===frame.sourceEpoch && tail.geometryGeneration===frame.geometryGeneration)return this.coalesce(tail,frame);
        return this.enqueue(frame.paneKey,frame,f=>{this.ram.screen(f);return this.ram.bump(f.paneKey);},false,true);
      }
      const pane=paneId(frame.paneKey),id=pane+':'+frame.kind;
      const previous=this.screenBytes.get(id)??0;
      let scope=this.capacity(frame.paneKey,512-previous,true);if(scope!=='ok')this.rejectCapacity(frame.paneKey,frame,false,scope);
      validateFrame(frame);
      const encoded=encodeFrameCells(frame.cells);
      const bytes=Buffer.byteLength(encoded)+Buffer.byteLength(pane)+512,delta=bytes-previous;
      scope=this.ram.bytes()+Math.max(0,delta)>CACHE_MAX?'store':this.capacity(frame.paneKey,delta,true);
      if(scope!=='ok')this.rejectCapacity(frame.paneKey,frame,false,scope);
      const receipt=this.ram.db.transaction(()=>{this.ram.screen(frame,null,null,[],encoded);return this.ram.bump(frame.paneKey);})();
      this.reserve(pane,delta,true);this.dirtyBytes+=delta;this.screenBytes.set(id,bytes);this.dirtySince??=Date.now();
      return Promise.resolve(receipt);
    }catch(error){return Promise.reject(error);}
  }
  /** The queue's last job is a frame of the same pane/kind/generation: the newer frame takes its place and reservation. */
  private coalesce(tail:Job,frame:ProjectionFrame):Promise<ProjectionReceipt> {
    // Validate before touching the tail: a bad frame is refused alone, the queued frame keeps its job.
    validateFrame(frame);
    const id=paneId(frame.paneKey),bytes=Buffer.byteLength(JSON.stringify(frame))+512,delta=bytes-tail.bytes;
    const scope=this.ram.bytes()+Math.max(0,delta)>CACHE_MAX?'store':this.capacity(frame.paneKey,delta,true);
    if(scope!=='ok')this.rejectCapacity(frame.paneKey,frame,false,scope);
    const frozen=structuredClone(frame);
    tail.run=()=>{this.ram.screen(frozen);return this.ram.bump(frozen.paneKey);};
    this.reserve(id,delta);this.queuedBytes+=delta;tail.bytes=bytes;
    return new Promise<ProjectionReceipt>((resolve,reject)=>{(tail.waiters??=[]).push({resolve,reject});});
  }
  calibrate(change:ProjectionCalibration):Promise<ProjectionReceipt> {return this.enqueue(change.capture.paneKey,change,c=>this.ram.calibrate(c),false);}
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
    for(const table of ['na_capture','na_line','na_screen','na_issue']) {
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
    if(this.pendingBytes()<PENDING_MAX/2) {
      this.stopped=false;
      // Only clear a fault once its latest revision reached disk. Recovery itself
      // is another dirty pane revision, so the persisted health follows reality.
      for(const p of batch.panes) {
        if(p.health==='degraded' && this.pendingBytes()+512<=PENDING_MAX && !this.capacityLosses.has(String(p.pane_key)) && ![...this.faults.values()].some(f=>f.pane===p.pane_key && f.revision>Number(p.revision))) {
          this.ram.db.query("UPDATE na_pane SET health='healthy',revision=revision+1 WHERE pane_key=?").run(p.pane_key);
          // Keep capacity episodes open so a refusal right after recovery reuses the issue.
          for(const [tag,f] of this.faults)if(f.pane===p.pane_key && !tag.endsWith(':ingest-capacity'))this.faults.delete(tag);
          this.dirtyBytes+=512;this.dirtySince??=Date.now();
        }
      }
      this.degraded=!!this.ram.db.query("SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    }
    const now=Date.now();
    for(const [tag,f] of this.faults)if(tag.endsWith(':ingest-capacity') && now-f.seen>CAPACITY_EPISODE_MS && !this.capacityLosses.has(f.pane))this.faults.delete(tag);
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
    }catch(error){this.fault('flush-failed',String(error));throw error;}
  }
  health():ProjectionHealth {
    this.owner();if(this.pendingAge()>1000 && !this.degraded)this.fault('flush-overdue','pending age exceeded 1s');
    const panes=(this.ram.db.query('SELECT server_identity,pane_id,birth_generation FROM na_pane').all() as SqlRow[])
      .map(p=>this.ram.token({serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)}));
    return {status:this.stopped?'stopped':this.degraded?'degraded':'healthy',pendingBytes:this.pendingBytes(),rejectedRows:this.rejectedRows,
      pendingAgeMs:this.pendingAge(),ramBytes:this.ram.bytes(),rssBytes:process.memoryUsage().rss,lastFlushAgeMs:this.lastFlushAgeMs,lastCommitAt:this.lastCommitAt,panes};
  }
  async close():Promise<void> {
    if(this.closed)return;
    this.closing=true;clearInterval(this.timer);
    try {
      while(this.pumping)await new Promise(resolve=>setTimeout(resolve,1));
      this.flush();
    } finally {
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
      await worker.terminate().catch(()=>{});
    }
  }
}
export function createProjectionStore(options:ProjectionOptions):ProjectionStore {return new ProjectionStore(options);}
export { PROJECTION_MIGRATION };
