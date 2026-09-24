import { Database } from 'bun:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_MIGRATION, PROJECTION_SCHEMA, PROJECTION_SCHEMA_VERSION } from './schema';
import { ProjectionRam, paneId, upsert, decodeFrameCells, encodeCells, validateRow, type SqlRow } from './ram-store';
import { readProjectionPage } from './projection-reader';
import type { PaneKey, ProjectionCalibration, ProjectionFault, ProjectionFrame, ProjectionHealth, ProjectionReceipt, ProjectionToken, ProjectionWriterPort, ScrollEvent } from './types';

const PENDING_MAX=16*1024*1024, CACHE_MAX=256*1024*1024, FLUSH_BYTES=256*1024;
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

type Batch={id:string;digest:string;panes:SqlRow[];tables:Map<string,SqlRow[]>;bytes:number;since:number};
function commitBatch(disk:Database, fence:number, batch:Batch, before?:()=>void):void {
  disk.transaction(()=>{
    if(Number(Object.values(disk.query('PRAGMA application_id').get()!)[0])!==fence) throw new Error('stale-writer');
    const existing=disk.query('SELECT digest FROM na_commit WHERE commit_id=?').get(batch.id) as SqlRow|null;
    if(existing) {if(existing.digest!==batch.digest)throw new Error('commit-id-conflict');return;}
    for(const p of batch.panes) upsert(disk,'na_pane',{...p,durable_revision:p.revision});
    for(const [table,rows] of batch.tables)for(const row of rows)upsert(disk,table,row);
    disk.query('INSERT INTO na_commit VALUES (?,?,?,?,?)').run(batch.id,Math.max(...batch.panes.map(p=>Number(p.revision))),Date.now(),JSON.stringify(batch.panes.map(p=>({paneKey:p.pane_key,revision:p.revision,nextLineId:p.next_line_id}))),batch.digest);
    before?.();
  }).immediate();
}
// Same module in source and compiled distributions: no extra worker asset/factory.
if(!isMainThread && workerData?.projectionDiskWriter===true) {
  const signal=new Int32Array(workerData.signal);
  const errors=new Uint8Array(workerData.signal,8);
  const disk=new Database(workerData.file,{strict:true});
  disk.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192;');
  parentPort!.on('message',(batch:Batch)=>{
    try {commitBatch(disk,workerData.fence,batch);Atomics.store(signal,0,1);}
    catch(error) {
      const bytes=new TextEncoder().encode(String(error)).subarray(0,errors.length);
      errors.set(bytes);Atomics.store(signal,1,bytes.length);Atomics.store(signal,0,2);
    }
    Atomics.notify(signal,0);
  });
}

type Job={bytes:number;at:number;run:()=>ProjectionReceipt;resolve:(r:ProjectionReceipt)=>void;reject:(e:unknown)=>void};

/** One RAM writer, one disk writer, round-robin pane queues, independent of viewers. */
export class ProjectionStore implements ProjectionWriterPort {
  private readonly ram=new ProjectionRam();
  private readonly disk:Database;
  readonly file:string;
  private fence=0;
  private queues=new Map<string,Job[]>();
  private queuedBytes=0;
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
  private closing=false;
  private rejectedRows=0;
  private screenBytes=new Map<string,number>();
  private dirtyFaults=new Set<string>();
  private faultEmitted=new Map<string,number>();
  private faults=new Map<string,{id:string;pane:string;last:number;count:number}>();
  private lastCommitAt:number|null=null;
  private lastFlushAgeMs=0;
  constructor(private readonly options:ProjectionOptions) {
    this.file=admitPath(options);
    options.beforeOpen?.(this.file);
    this.disk=new Database(this.file,{strict:true});
    try {
      this.disk.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; PRAGMA cache_size=-8192;');
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
        if(!this.inFlight && (this.retry || this.dirtyBytes>=FLUSH_BYTES || (this.dirtySince!==null && Date.now()-this.dirtySince>=50)))this.flushAsync();
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
        const tag=String(p.pane_key)+':'+kind, previous=this.faults.get(tag);
        const count=(previous?.count??0)+(kind==='ingest-capacity'?lostRows:0);
        if(previous && kind!=='ingest-capacity' && now-previous.last<1000)continue;
        if(!previous || now-previous.last>=1000)emit=true;
        const id=previous?.id??randomUUID();
        this.ram.db.query('UPDATE na_pane SET health=?,revision=revision+1 WHERE pane_key=?').run('degraded',p.pane_key);
        this.ram.db.query(`INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)
          ON CONFLICT(issue_id) DO UPDATE SET revision=excluded.revision,missing_count=excluded.missing_count,reason=excluded.reason`)
          .run(id,p.pane_key,p.source_epoch,Number(p.revision)+1,p.next_line_id,kind,reason,kind==='ingest-capacity'?count:null,now);
        this.faults.set(tag,{id,pane:String(p.pane_key),last:emit?now:previous!.last,count});
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
  private enqueue(key:PaneKey,input:unknown,operation:(frozen:any)=>ProjectionReceipt,isScroll=true):Promise<ProjectionReceipt> {
    try {
      if(this.closed)throw new Error('store-closed');
      if(this.closing)throw new Error('store-closing');
      const frozen=structuredClone(input), bytes=Buffer.byteLength(JSON.stringify(frozen))+512;
      if(this.pendingBytes()+bytes>PENDING_MAX-64*1024 || this.ram.bytes()+bytes>CACHE_MAX) {
        this.stopped=true;if(isScroll)this.rejectedRows++;
        const value=(isScroll?input:(input as ProjectionCalibration).capture) as ScrollEvent;this.ram.ensure(key,value.sourceEpoch,value.geometryGeneration);
        this.fault('ingest-capacity','incoming history event rejected; accepted rows retained',key,isScroll?1:0);
        throw new Error('ingest-capacity');
      }
      const id=paneId(key);this.queuedBytes+=bytes;
      const result=new Promise<ProjectionReceipt>((resolve,reject)=>{
        const q=this.queues.get(id)??[];q.push({bytes,at:Date.now(),run:()=>operation(frozen),resolve,reject});this.queues.set(id,q);
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
      for(const q of this.queues.values())for(const job of q)job.reject(error);
      this.queues.clear();this.queuedBytes=0;this.pumping=false;return;
    }
    let processed=0;
    while(this.queues.size && processed<128) {
      for(const [id,q] of this.queues) {
        const job=q.shift()!;if(!q.length)this.queues.delete(id);
        this.queuedBytes-=job.bytes;
        try {
          const receipt=this.ram.db.transaction(()=>{
            const receipt=job.run();
            if(this.ram.bytes()>CACHE_MAX) throw new Error('ram-cache-limit');
            return receipt;
          })();
          this.dirtyBytes+=job.bytes;this.dirtySince??=job.at;job.resolve(receipt);
        }catch(error){job.reject(error);}
        processed++;
      }
    }
    if(this.queues.size)setTimeout(()=>{this.pumpTurnAt=performance.now();this.pump();},0);else this.pumping=false;

  }
  appendScroll(event:ScrollEvent):Promise<ProjectionReceipt> {
    try {
      // Freeze the physical cells once, in the same lossless representation held
      // by RAM/disk. Queues retain strings, not hundreds of cloned cell objects.
      const text=event.physicalRow.text,cells=event.physicalRow.cells;
      validateRow({text,cells});
      const frozen={paneKey:{...event.paneKey},sourceEpoch:event.sourceEpoch,geometryGeneration:event.geometryGeneration,
        receiveSeq:event.receiveSeq,softWrap:event.softWrap,physicalRow:{text,cells:[]},encodedCells:encodeCells(cells)};
      return this.enqueue(frozen.paneKey,frozen,e=>this.ram.append(e,e.encodedCells));
    }catch(error){return Promise.reject(error);}
  }
  replaceScreen(frame:ProjectionFrame):Promise<ProjectionReceipt> {
    // A live frame replaces the previous frame immediately, even under scroll pressure.
    try {
      this.owner();if(this.closing)throw new Error('store-closing');
      const receipt=this.ram.db.transaction(()=>{this.ram.screen(frame);return this.ram.bump(frame.paneKey);})();
      const id=paneId(frame.paneKey)+':'+frame.kind;
      const encoded=this.ram.db.query('SELECT cells_json FROM na_screen WHERE pane_key=? AND screen_kind=?').get(paneId(frame.paneKey),frame.kind) as SqlRow;
      const bytes=Buffer.byteLength(String(encoded.cells_json))+512;
      this.dirtyBytes+=bytes-(this.screenBytes.get(id)??0);this.screenBytes.set(id,bytes);this.dirtySince??=Date.now();
      return Promise.resolve(receipt);
    }catch(error){return Promise.reject(error);}
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
    if(!this.dirtyBytes && this.dirtySince===null)return null;
    const panes=this.ram.db.query('SELECT * FROM na_pane WHERE revision>durable_revision').all() as SqlRow[];
    const tables=new Map<string,SqlRow[]>();
    for(const table of ['na_capture','na_line','na_screen','na_issue']) {
      const rows:SqlRow[]=[];
      for(const p of panes)rows.push(...this.ram.db.query(`SELECT * FROM ${table} WHERE pane_key=? AND revision>?`).all(p.pane_key,p.durable_revision) as SqlRow[]);
      tables.set(table,rows);
    }
    const digest=createHash('sha256').update(JSON.stringify([panes,[...tables]])).digest('hex');
    this.retry={id:randomUUID(),digest,panes,tables,bytes:this.dirtyBytes,since:this.dirtySince??Date.now()};
    this.dirtyBytes=0;this.dirtySince=null;this.screenBytes.clear();this.dirtyFaults.clear();
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
    this.retry=null;
    if(this.pendingBytes()<PENDING_MAX/2) {
      this.stopped=false;
      // Only clear a fault once its latest revision reached disk. Recovery itself
      // is another dirty pane revision, so the persisted health follows reality.
      for(const p of batch.panes) {
        const current=this.ram.db.query('SELECT * FROM na_pane WHERE pane_key=?').get(p.pane_key) as SqlRow;
        if(p.health==='degraded' && current.revision===p.revision) {
          this.ram.db.query("UPDATE na_pane SET health='healthy',revision=revision+1 WHERE pane_key=?").run(p.pane_key);
          for(const [tag,f] of this.faults)if(f.pane===p.pane_key)this.faults.delete(tag);
          this.dirtyBytes+=512;this.dirtySince??=Date.now();
        }
      }
      this.degraded=!!this.ram.db.query("SELECT 1 FROM na_pane WHERE health!='healthy' LIMIT 1").get();
    }
  }
  private finishWorker():void {
    const state=Atomics.load(this.signal,0);
    if(!state)return;
    this.inFlight=false;
    if(state===2)throw new Error(new TextDecoder().decode(new Uint8Array(this.signal.buffer,8,Atomics.load(this.signal,1))));
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
        commitBatch(this.disk,this.fence,current,()=>this.options.checkpoint?.('before-disk-commit',current.id));
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
      if(this.worker)await this.worker.terminate();
      this.ram.db.close();this.disk.close();
    }
  }
}
export function createProjectionStore(options:ProjectionOptions):ProjectionStore {return new ProjectionStore(options);}
export { PROJECTION_MIGRATION };
