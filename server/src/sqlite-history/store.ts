import type { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseReplayJournal } from '@thumbmux/core';
import { SCHEMA, GUARDS, SCHEMA_VERSION } from './schema';
import { safe, sha, rowsDigest, validateObservation } from './codec';
import type { CaptureBatch, CaptureReceipt, CaptureTicket, HistoryContext, HistoryFault, HistoryHealth, HistoryPageV1, HistoryRow, ShadowBatchSnapshot, SqliteHistoryOptions } from './types';

type Session = { session_id: string; lifecycle_key: string; name: string; group_label: string; active: number;
  writer_fence: number; revision: number; first_line: number; next_line: number; live_start: number;
  last_probe_at: number | null; last_commit_at: number | null; continuity: HistoryContext['continuity'] };
type Capture = { seq: number; request_id: string; previous_seq: number; at: number; geometry_json: string; screen_json: string;
  row_start: number; row_end: number; first_line: number; live_start: number; next_line: number; expected_rows: number;
  rows_sha256: string; evidence_json: string; unresolved_capture: Uint8Array | null };

/** Internal implementation. SQL handle is never exposed by the public facade. */
export class HistoryStore {
  private closed = false;
  private fence = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private faults = new Map<string, HistoryFault>();
  private startedAt = Date.now();
  private listeners = new Set<() => Promise<void>>();
  constructor(readonly db: Database, private options: SqliteHistoryOptions) {
    db.exec('PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const mode = db.query('PRAGMA journal_mode=WAL').get() as { journal_mode: string };
    if (mode.journal_mode !== 'wal' || this.pragma('synchronous') !== 2 || this.pragma('foreign_keys') !== 1
      || this.pragma('busy_timeout') !== 250) throw new Error('pragma-verification');
    // BEGIN IMMEDIATE serializes schema/ownership acquisition. application_id is a
    // persistent monotonic writer epoch (not user_version); every write rechecks it.
    // A second opener takes ownership and fences the old handle, including new-session admission.
    db.transaction(() => {
      const version = this.pragma('user_version');
      if (version > SCHEMA_VERSION) throw new Error('future-schema');
      if (version === 0) {
        if(db.query("SELECT name FROM sqlite_master WHERE type='table'").all().length)throw new Error('foreign-database');
        db.exec(SCHEMA); db.exec(GUARDS); db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`); }
      const epoch = this.pragma('application_id');
      if (epoch < 0 || epoch >= 2147483647) throw new Error('writer-fence-exhausted');
      this.fence = epoch + 1;
      db.exec(`PRAGMA application_id=${this.fence}`);
      db.query('UPDATE history_session SET writer_fence=?').run(this.fence);
    }).immediate();
  }
  get file():string {return this.options.file;}
  pragma(name: string): number { return Object.values(this.db.query(`PRAGMA ${name}`).get() as object)[0] as number; }
  checkOwner(): void {
    if (this.closed) throw new Error('store-closed');
    if (this.pragma('application_id') !== this.fence) throw new Error('stale-fence');
  }
  session(sid: string): Session {
    const s = this.db.query('SELECT * FROM history_session WHERE session_id=?').get(sid) as Session | null;
    if (!s) throw new Error('unknown-session');
    for (const n of [s.revision,s.writer_fence,s.first_line,s.next_line,s.live_start]) safe(n);
    return s;
  }
  context(s: Session): HistoryContext {
    return { sessionId:s.session_id, revision:s.revision, firstLine:s.first_line, liveStart:s.live_start, nextLine:s.next_line, continuity:s.continuity };
  }
  report(sid: string, detector: string, expected: unknown, observed: unknown, missing: number | null = null): HistoryFault {
    const fault: HistoryFault = {issue_id:randomUUID(),sessionId:sid,detector,expected,observed,timestamp:Date.now(),missing_count:missing};
    this.faults.set(sid, fault);
    // Fault delivery is independent of SQLite. A full/busy/broken DB cannot silence it.
    try { this.options.onFault?.(fault); } catch (error) { console.error('[thumbmux/sqlite] fault-sink-failed', String(error)); }
    console.error('[thumbmux/sqlite]', JSON.stringify(fault));
    return fault;
  }
  issue(fault: HistoryFault, seq: number | null = null): void {
    this.db.query(`INSERT INTO history_issue VALUES (?,?,?,?,?,?,?,?,NULL)`).run(
      fault.issue_id,fault.sessionId,seq,fault.detector,fault.timestamp,null,fault.missing_count,JSON.stringify(fault));
  }
  persistFault(sid: string, detector: string, expected: unknown, observed: unknown): HistoryFault {
    const fault = this.report(sid,detector,expected,observed);
    try { this.db.transaction(() => { this.checkOwner(); this.issue(fault); }).immediate(); } catch { /* host fault already delivered */ }
    return fault;
  }
  async write<T>(sid: string, operation: () => T): Promise<T> {
    const work = this.chain.then(async () => {
      for (let attempt=0;;attempt++) {
        try { return this.db.transaction(() => { this.checkOwner(); return operation(); }).immediate(); }
        catch(error) {
          if ((error as {code?:string}).code === 'SQLITE_BUSY' && attempt < 2) {
            await new Promise(r => setTimeout(r, 10*(attempt+1))); continue;
          }
          this.report(sid,'write-failed','committed transaction',String(error)); throw error;
        }
      }
    });
    this.chain = work.catch(() => {});
    return work;
  }
  async register(input: {name:string; lifecycleKey:string; group?:string; firstLine?:number}): Promise<string> {
    return this.write('', () => {
      if (!input.name || !input.lifecycleKey) throw new Error('invalid-session-identity');
      const old = this.db.query('SELECT * FROM history_session WHERE lifecycle_key=?').get(input.lifecycleKey) as Session | null;
      if (old) { if (!old.active) throw new Error('retired-lifecycle'); return old.session_id; }
      const sid=randomUUID(), floor=safe(input.firstLine ?? 0);
      this.db.query(`INSERT INTO history_session(session_id,lifecycle_key,name,group_label,active,writer_fence,first_line,next_line,live_start)
        VALUES (?,?,?,?,1,?,?,?,?)`).run(sid,input.lifecycleKey,input.name,input.group??'_ungrouped',this.fence,floor,floor,floor);
      return sid;
    });
  }
  ticket(sid: string, requestId: string = randomUUID()): CaptureTicket {
    this.checkOwner(); const s=this.session(sid);
    if (!s.active) throw new Error('session-closed');
    return {sessionId:sid,lifecycleKey:s.lifecycle_key,fence:this.fence,revision:s.revision,requestId};
  }
  capture(sid: string, seq: number): Capture {
    const c=this.db.query('SELECT * FROM history_capture WHERE session_id=? AND seq=?').get(sid,seq) as Capture | null;
    if (!c) throw new Error('missing-receipt'); return c;
  }
  receipt(sid: string, c: Capture): CaptureReceipt {
    return {context:{sessionId:sid,revision:c.seq,firstLine:c.first_line,liveStart:c.live_start,nextLine:c.next_line,
      continuity:'unknown'},requestId:c.request_id,screen:JSON.parse(c.screen_json),geometry:JSON.parse(c.geometry_json),rowsSha256:c.rows_sha256};
  }
  rows(sid: string, start: number, end: number): HistoryRow[] {
    return this.db.query('SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no').all(sid,start,end) as HistoryRow[];
  }
  shadowSnapshot(sid:string,requestId:string):ShadowBatchSnapshot {
    return this.db.transaction(()=>{
      const c=this.db.query('SELECT * FROM history_capture WHERE session_id=? AND request_id=?').get(sid,requestId) as Capture|null;
      if(!c)throw new Error('shadow-sqlite-receipt-missing');
      const frames=this.db.query('SELECT record_json FROM history_frame WHERE session_id=? AND capture_seq=? ORDER BY frame_seq').all(sid,c.seq) as {record_json:string}[];
      return {requestId:c.request_id,revision:c.seq,rows:this.rows(sid,c.row_start,c.row_end),
        frames:frames.map((frame,ordinal)=>({ordinal,bytes:frame.record_json})),
        unresolved:c.unresolved_capture?[{ordinal:0,sha256:sha(c.unresolved_capture)}]:[]};
    })();
  }
  tail(sid: string, count=40): HistoryRow[] {
    const s=this.session(sid); return this.rows(sid,Math.max(s.first_line,s.next_line-count),s.next_line);
  }
  async commit(batch: CaptureBatch, checkpoint?: () => void): Promise<CaptureReceipt> {
    validateObservation(batch.observation); safe(batch.liveLineLimit);
    const frozen = structuredClone(batch);
    // Hash the caller input, excluding the retry's observation revision; request identity is stable.
    const requestDigest=sha(JSON.stringify({...frozen,ticket:{...frozen.ticket,revision:0,fence:0}}));
    const sid=frozen.ticket.sessionId;
    return this.write(sid, () => {
      const s=this.session(sid), t=frozen.ticket;
      if (t.fence !== this.fence || t.lifecycleKey !== s.lifecycle_key || !s.active) throw new Error('stale-fence-or-incarnation');
      const previous=this.db.query('SELECT * FROM history_capture WHERE session_id=? AND request_id=?').get(sid,t.requestId) as Capture | null;
      if (previous) {
        if (JSON.parse(previous.evidence_json).requestDigest !== requestDigest) throw new Error('retry-conflict');
        checkpoint?.(); return this.receipt(sid,previous);
      }
      if (s.revision !== t.revision) throw new Error('stale-revision');
      const seq=safe(s.revision+1), start=s.next_line, end=safe(start+frozen.appended.length);
      const rows:HistoryRow[]=frozen.appended.map((r,i)=>({...r,line_no:start+i}));
      if (rows.some(r => !['terminal','gap'].includes(r.kind) || typeof r.text !== 'string' || !r.text.isWellFormed())) throw new Error('invalid-row');
      const screen=frozen.observation.screen;
      const b=frozen.observation.geometry.kind==='legacy-window' ? end : Math.max(s.first_line,end-Math.max(0,frozen.liveLineLimit-screen.length));
      const digest=rowsDigest(rows);
      const evidence={...frozen.evidence,requestDigest};
      this.db.query(`INSERT INTO history_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sid,seq,t.requestId,s.revision,frozen.observation.at,JSON.stringify(frozen.observation.geometry),JSON.stringify(screen),
        start,end,s.first_line,b,end,rows.length,digest,JSON.stringify(evidence),frozen.unresolved??null);
      const insert=this.db.query('INSERT INTO history_line VALUES (?,?,?,?,?,?)');
      rows.forEach((r,i)=>insert.run(sid,r.line_no,r.kind,r.text,seq,i));
      // Check the stored bytes, not just the input buffer. The trigger cannot compute SHA-256.
      if (rowsDigest(this.rows(sid,start,end)) !== digest) throw new Error('batch-hash');
      if (frozen.frame) this.insertFrame(sid,frozen.frame,seq);
      else if(frozen.recordFrames) {
        const first=this.db.query('SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq LIMIT 1').get(sid) as {record_json:string}|null;
        const channel=first?JSON.parse(first.record_json).session:s.name;
        const frame:import('../frame-journal').FrameJournalRecordV1['frame']={channel,type:'output',data:this.rows(sid,b,end).map(r=>r.text).concat(screen).join('\n')};
        if(Object.hasOwn(frozen.observation.geometry,'cursor'))frame.cursor=frozen.observation.geometry.cursor;
        const record={v:1 as const,session:channel,at:frozen.observation.at,frame};
        const size=Buffer.byteLength(JSON.stringify(record))+1;
        const sessionBytes=this.db.query('SELECT coalesce(sum(length(CAST(record_json AS BLOB))+1),0) AS bytes FROM history_frame WHERE session_id=?').get(sid) as {bytes:number};
        const rootBytes=this.db.query('SELECT coalesce(sum(length(CAST(record_json AS BLOB))+1),0) AS bytes FROM history_frame').get() as {bytes:number};
        if(sessionBytes.bytes+size>(frozen.recordingSessionBytes??64*1024*1024) || rootBytes.bytes+size>(frozen.recordingRootBytes??256*1024*1024)) {
          this.issue(this.report(sid,'recording-limit','v1 bytes within session/root admission cap',{session:sessionBytes.bytes+size,root:rootBytes.bytes+size}),seq);
        } else this.insertFrame(sid,record,seq);
      }
      const f=this.report(sid,'source-unknown','source evidence covering the observation interval',evidence.classification);
      this.issue(f,seq);
      this.db.query(`UPDATE history_session SET revision=?,live_start=?,last_probe_at=?,last_commit_at=?,continuity='unknown'
        WHERE session_id=?`).run(seq,b,Date.now(),Date.now(),sid);
      checkpoint?.();
      return this.receipt(sid,this.capture(sid,seq));
    });
  }
  insertFrame(sid:string, input: import('../frame-journal').FrameJournalRecordV1, captureSeq:number|null): void {
    const s=this.session(sid);
    const last=this.db.query('SELECT frame_seq,at FROM history_frame WHERE session_id=? ORDER BY frame_seq DESC LIMIT 1').get(sid) as {frame_seq:number;at:number}|null;
    if (!Number.isFinite(input.at)) throw new Error('invalid-frame-time');
    const record={...structuredClone(input),at:Math.max(last?.at??-Infinity,input.at)};
    const first=this.db.query('SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq LIMIT 1').get(sid) as {record_json:string}|null;
    const channel=first?JSON.parse(first.record_json).session:s.name;
    if (record.session !== channel || record.frame.channel !== channel) throw new Error('frame-session');
    const full=this.db.query("SELECT frame_seq FROM history_frame WHERE session_id=? AND kind='output' ORDER BY frame_seq DESC LIMIT 1").get(sid) as {frame_seq:number}|null;
    const preceding=full && record.frame.type==='delta' ? this.db.query('SELECT record_json FROM history_frame WHERE session_id=? AND frame_seq>=? ORDER BY frame_seq').all(sid,full.frame_seq) as {record_json:string}[] : [];
    if (record.frame.type==='delta' && preceding.length>64) throw new Error('frame-cadence');
    const line=JSON.stringify(record);
    // Reuse core's strict v1, channel, cursor, delta, reset and size validation.
    parseReplayJournal([...preceding.map(r=>r.record_json),line].join('\n')+'\n');
    this.db.query('INSERT INTO history_frame VALUES (?,?,?,?,?,?)').run(sid,safe((last?.frame_seq??0)+1),record.at,record.frame.type,line,captureSeq);
  }
  async rename(sid:string,name:string,group?:string):Promise<void> {
    await this.write(sid,()=>{ if(!name) throw new Error('invalid-name'); this.db.query('UPDATE history_session SET name=?,group_label=? WHERE session_id=?').run(name,group??this.session(sid).group_label,sid); });
  }
  async closeSession(sid:string):Promise<void> { await this.write(sid,()=>{ this.db.query('UPDATE history_session SET active=0 WHERE session_id=?').run(sid); }); }
  snapshot(sid:string):CaptureReceipt & {live:HistoryRow[]} {
    return this.db.transaction(()=>{
      const s=this.session(sid), c=this.capture(sid,s.revision);
      const live=this.rows(sid,s.live_start,s.next_line);
      this.checkRange(sid,live,s.live_start,s.next_line);
      return {...this.receipt(sid,c),live};
    })();
  }
  checkRange(sid:string,rows:HistoryRow[],start:number,end:number):void {
    if (rows.length!==end-start || rows.some((r,i)=>r.line_no!==start+i)) {
      this.persistFault(sid,'storage-hole',{start,end,count:end-start},{count:rows.length,ids:rows.slice(0,5).map(r=>r.line_no)});
      throw new Error('history-unavailable:storage-hole');
    }
  }
  page(sid:string,direction:'before'|'after',anchor:number|null,limit:number,context?:HistoryContext):HistoryPageV1 {
    safe(limit); if(!limit || limit>2000) throw new Error('invalid-page-limit'); if(anchor!==null) safe(anchor);
    try { return this.db.transaction(()=>{
      const s=this.session(sid);
      const ctx=context??this.context(s);
      if(ctx.sessionId!==sid || ctx.revision>s.revision) throw new Error('context-mismatch');
      if(!ctx.revision && (ctx.firstLine!==s.first_line || ctx.liveStart!==s.first_line || ctx.nextLine!==s.first_line || ctx.continuity!=='unknown'))throw new Error('context-mismatch');
      if(ctx.revision) {
        const c=this.capture(sid,ctx.revision);
        if(c.first_line!==ctx.firstLine || c.live_start!==ctx.liveStart || c.next_line!==ctx.nextLine) throw new Error('context-mismatch');
      }
      const end=direction==='before'?Math.max(s.first_line,Math.min(anchor??ctx.liveStart,ctx.liveStart,ctx.nextLine)):
        Math.min(ctx.liveStart,Math.max(s.first_line,anchor===null?s.first_line:safe(anchor+1))+limit);
      const start=direction==='before'?Math.max(s.first_line,end-limit):Math.min(end,Math.max(s.first_line,anchor===null?s.first_line:safe(anchor+1)));
      const rows=direction==='before' ? (this.db.query('SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no DESC LIMIT ?').all(sid,s.first_line,end,limit) as HistoryRow[]).reverse() : this.rows(sid,start,end);
      this.checkRange(sid,rows,start,end);
      return {context:ctx,rows,startLine:start,endLine:end,hasMore:direction==='before'?start>s.first_line:end<ctx.liveStart};
    })(); } catch(error) { this.persistFault(sid,'read-unavailable','consistent revision/range',String(error)); throw error; }
  }
  audit(sid:string,afterSeq=0):{captures:number;rows:number} {
    let captures=0,rows=0;
    try { return this.db.transaction(()=>{
      const s=this.session(sid);
      if(s.revision){const last=this.capture(sid,s.revision);
        if(last.first_line!==s.first_line || last.live_start!==s.live_start || last.next_line!==s.next_line)throw new Error('receipt-boundary');}
      for(let seq=afterSeq+1;seq<=s.revision;seq++) {
        const c=this.capture(sid,seq), batch=this.rows(sid,c.row_start,c.row_end);
        this.checkRange(sid,batch,c.row_start,c.row_end);
        if(batch.length!==c.expected_rows || rowsDigest(batch)!==c.rows_sha256) throw new Error('batch-hash');
        captures++; rows+=batch.length;
      }
      return {captures,rows};
    })(); } catch(error) {this.persistFault(sid,'integrity-audit','receipt counts and byte digests',String(error));throw error;}
  }
  health(sid:string):HistoryHealth {
    const s=this.session(sid); return {sessionId:sid,startedAt:this.startedAt,lastProbeAt:s.last_probe_at,lastCommitAt:s.last_commit_at,
      continuity:s.continuity,revision:s.revision,fault:this.faults.get(sid)??null};
  }
  addDrain(drain:()=>Promise<void>):void {this.listeners.add(drain);}
  async close():Promise<void> {for(const drain of this.listeners) await drain();await this.chain;this.closed=true;this.db.close();}
}

export function prepareFile(file:string):string {
  const path=resolve(file), dir=dirname(path);
  if(!existsSync(dir)) mkdirSync(dir,{recursive:true,mode:0o700});
  const d=lstatSync(dir);
  if(!d.isDirectory() || (d.mode&0o077)!==0 || d.uid!==process.getuid?.()) throw new Error('history-directory-must-be-private');
  for(const p of [path,path+'-wal',path+'-shm']) {
    if(existsSync(p)) {const st=lstatSync(p);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()) throw new Error('unsafe-history-file');chmodSync(p,0o600);}
  }
  if(!existsSync(path)) {const fd=openSync(path,'wx',0o600);try{fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(dir,'r');try{fsyncSync(parent);}finally{closeSync(parent);}}
  return path;
}
