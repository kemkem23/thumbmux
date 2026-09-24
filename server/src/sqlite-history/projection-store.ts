import { Database } from 'bun:sqlite';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_MIGRATION, PROJECTION_SCHEMA, PROJECTION_SCHEMA_VERSION } from './schema';
import { ProjectionRam, paneId, upsert, type SqlRow } from './ram-store';
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
  private closed=false;
  private degraded=false;
  private stopped=false;
  private timer:ReturnType<typeof setInterval>;
  private retry:{id:string;digest:string;panes:SqlRow[];tables:Map<string,SqlRow[]>;bytes:number;since:number}|null=null;
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
    this.timer=setInterval(()=>{
      if(this.dirtySince!==null && Date.now()-this.dirtySince>=100) {try {this.flush();}catch{/* fault already emitted */}}
      if(this.pendingAge()>1000) this.fault('flush-overdue','pending age exceeded 1s');
    },10);
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
    const last=this.disk.query('SELECT committed_at FROM na_commit ORDER BY committed_at DESC LIMIT 1').get() as SqlRow|null;
    this.lastCommitAt=last?Number(last.committed_at):null;
  }
  private pendingAge():number {
    const times=[...(this.dirtySince===null?[]:[this.dirtySince]),...[...this.queues.values()].map(q=>q[0]?.at).filter((v):v is number=>v!==undefined)];
    return times.length?Math.max(0,Date.now()-Math.min(...times)):0;
  }
  private fault(kind:string,reason:string):void {
    this.degraded=true;
    const fault={kind,reason,at:Date.now(),pendingBytes:this.dirtyBytes+this.queuedBytes};
    // Delivery must work even when disk is full or SQLite itself is unavailable.
    try {this.options.onFault?.(fault);}catch{console.error('[newarch] fault sink failed');}
    console.error('[newarch]',JSON.stringify(fault));
  }
  private enqueue(key:PaneKey,input:unknown,operation:(frozen:any)=>ProjectionReceipt):Promise<ProjectionReceipt> {
    try {
      this.owner(); if(this.stopped) throw new Error('ingest-stopped');
      const frozen=structuredClone(input), bytes=Buffer.byteLength(JSON.stringify(frozen))+512;
      if(this.dirtyBytes+this.queuedBytes+bytes>PENDING_MAX || this.ram.bytes()+bytes>CACHE_MAX) {
        this.stopped=true;this.fault('ingest-capacity','refusing incoming event; no rows dropped from accepted queue');
        throw new Error('ingest-capacity');
      }
      const id=paneId(key);this.queuedBytes+=bytes;
      const result=new Promise<ProjectionReceipt>((resolve,reject)=>{
        const q=this.queues.get(id)??[];q.push({bytes,at:Date.now(),run:()=>operation(frozen),resolve,reject});this.queues.set(id,q);
      });
      // A chain of callers awaiting append must not starve the flush timer.
      if(!this.pumping) {this.pumping=true;setImmediate(()=>this.pump());}
      return result;
    } catch(error) {return Promise.reject(error);}
  }
  private pump():void {
    let processed=0;
    while(this.queues.size && processed<128) {
      for(const [id,q] of this.queues) {
        const job=q.shift()!;if(!q.length)this.queues.delete(id);
        this.queuedBytes-=job.bytes;
        try {
          this.owner();
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
    if(this.queues.size) setTimeout(()=>this.pump(),0);else this.pumping=false;
    if(this.dirtyBytes>=FLUSH_BYTES) {try{this.flush();}catch{/* keep pending; timer retries */}}
  }
  appendScroll(event:ScrollEvent):Promise<ProjectionReceipt> {return this.enqueue(event.paneKey,event,e=>this.ram.append(e));}
  replaceScreen(frame:ProjectionFrame):Promise<ProjectionReceipt> {return this.enqueue(frame.paneKey,frame,f=>{this.ram.screen(f);return this.ram.bump(f.paneKey);});}
  calibrate(change:ProjectionCalibration):Promise<ProjectionReceipt> {return this.enqueue(change.capture.paneKey,change,c=>this.ram.calibrate(c));}
  token(key:PaneKey):ProjectionToken {this.owner();return this.ram.token(key);}
  screen(key:PaneKey,kind:'normal'|'alternate'='normal'):SqlRow|null {
    this.owner();return this.ram.db.query('SELECT * FROM na_screen WHERE pane_key=? AND screen_kind=?').get(paneId(key),kind) as SqlRow|null;
  }
  readPage(token:ProjectionToken,anchor:number|null,limit:number) {this.owner();return readProjectionPage(this.ram,this.disk,token,anchor,limit);}
  flush():void {
    this.owner();if(!this.dirtyBytes && !this.retry)return;
    try {
      if(!this.retry) {
        const panes=this.ram.db.query('SELECT * FROM na_pane WHERE revision>durable_revision').all() as SqlRow[];
        const tables=new Map<string,SqlRow[]>();
        for(const table of ['na_capture','na_line','na_screen','na_issue']) {
          tables.set(table,panes.flatMap(p=>this.ram.db.query(`SELECT * FROM ${table} WHERE pane_key=? AND revision>?`)
            .all(p.pane_key,p.durable_revision) as SqlRow[]));
        }
        const digest=createHash('sha256').update(JSON.stringify([panes,[...tables]])).digest('hex');
        this.retry={id:randomUUID(),digest,panes,tables,bytes:this.dirtyBytes,since:this.dirtySince!};
      }
      const batch=this.retry;
      this.disk.transaction(()=>{
        this.owner();
        const existing=this.disk.query('SELECT digest FROM na_commit WHERE commit_id=?').get(batch.id) as SqlRow|null;
        if(existing) {if(existing.digest!==batch.digest)throw new Error('commit-id-conflict');return;}
        for(const p of batch.panes) upsert(this.disk,'na_pane',{...p,durable_revision:p.revision});
        for(const [table,rows] of batch.tables)for(const row of rows)upsert(this.disk,table,row);
        this.disk.query('INSERT INTO na_commit VALUES (?,?,?,?,?)').run(batch.id,Math.max(...batch.panes.map(p=>Number(p.revision))),Date.now(),JSON.stringify(batch.panes.map(p=>({paneKey:p.pane_key,revision:p.revision,nextLineId:p.next_line_id}))),batch.digest);
        this.options.checkpoint?.('before-disk-commit',batch.id);
      }).immediate();
      this.options.checkpoint?.('after-disk-commit',batch.id);
      this.options.checkpoint?.('before-watermark',batch.id);
      this.ram.db.transaction(()=>{
        for(const p of batch.panes)this.ram.db.query('UPDATE na_pane SET durable_revision=? WHERE pane_key=?').run(p.revision,p.pane_key);
        this.ram.evict();
      })();
      this.lastCommitAt=Date.now();this.lastFlushAgeMs=this.lastCommitAt-batch.since;
      this.dirtyBytes-=batch.bytes;this.dirtySince=this.dirtyBytes?batch.since:null;
      this.retry=null;this.degraded=false;
    }catch(error){this.fault('flush-failed',String(error));throw error;}
  }
  health():ProjectionHealth {
    this.owner();if(this.pendingAge()>1000 && !this.degraded)this.fault('flush-overdue','pending age exceeded 1s');
    const panes=(this.ram.db.query('SELECT server_identity,pane_id,birth_generation FROM na_pane').all() as SqlRow[])
      .map(p=>this.ram.token({serverIdentity:String(p.server_identity),paneId:String(p.pane_id),birthGeneration:Number(p.birth_generation)}));
    return {status:this.stopped?'stopped':this.degraded?'degraded':'healthy',pendingBytes:this.dirtyBytes+this.queuedBytes,
      pendingAgeMs:this.pendingAge(),ramBytes:this.ram.bytes(),rssBytes:process.memoryUsage().rss,lastFlushAgeMs:this.lastFlushAgeMs,lastCommitAt:this.lastCommitAt,panes};
  }
  async close():Promise<void> {
    if(this.closed)return;
    this.stopped=true;
    while(this.pumping)await new Promise(resolve=>setTimeout(resolve,1));
    this.flush();clearInterval(this.timer);this.closed=true;this.ram.db.close();this.disk.close();
  }
}
export function createProjectionStore(options:ProjectionOptions):ProjectionStore {return new ProjectionStore(options);}
export { PROJECTION_MIGRATION };
