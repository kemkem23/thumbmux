import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryStore } from './store';
import { safe, sha } from './codec';
import type { HistoryImportOptions, HistoryImportProgress, HistoryImportState, HistoryRow, HistoryGeometry } from './types';
import { parseReplayJournal } from '@thumbmux/core';
import type { FrameJournalRecordV1 } from '../frame-journal';

type SealedFile={path:string;bytes:number;sha256:string};
type Seal={version:1;files:SealedFile[]};
function syncDir(dir:string):void {const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function durableFile(path:string,data:string|Uint8Array):void {
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
}
function names(dir:string):string[] {
  return readdirSync(dir).sort().map(name=>{
    if(name!==basename(name) || !lstatSync(join(dir,name)).isFile() || lstatSync(join(dir,name)).isSymbolicLink())throw new Error('unsafe-snapshot-entry');
    return name;
  });
}
/** Caller must already own a coherent, stopped/synthetic source; this is NOT an active-session bridge. */
export function sealHistorySnapshot(source:string,destination:string):void {
  mkdirSync(destination,{mode:0o700});
  const files:SealedFile[]=[];
  for(const name of names(source)) {
    if(name==='seal.json')throw new Error('reserved-seal-name');
    const bytes=readFileSync(join(source,name));durableFile(join(destination,name),bytes);
    chmodSync(join(destination,name),0o400);files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
  }
  if(!files.length)throw new Error('empty-snapshot');
  durableFile(join(destination,'seal.pending'),JSON.stringify({version:1,files}));
  renameSync(join(destination,'seal.pending'),join(destination,'seal.json'));syncDir(destination);syncDir(dirname(destination));
}
export function readSeal(directory:string):{seal:Seal;files:Map<string,Buffer>;digest:string;bytes:number} {
  const raw=readFileSync(join(directory,'seal.json'));
  const seal=JSON.parse(raw.toString()) as Seal;
  if(seal.version!==1 || !Array.isArray(seal.files) || !seal.files.length)throw new Error('unsealed-source');
  const files=new Map<string,Buffer>();let bytes=0;
  for(const entry of seal.files) {
    if(typeof entry.path!=='string'||entry.path!==basename(entry.path)||entry.path==='seal.json'||files.has(entry.path))throw new Error('invalid-inventory');
    const st=lstatSync(join(directory,entry.path));if(!st.isFile()||st.isSymbolicLink())throw new Error('unsafe-snapshot-entry');
    const data=readFileSync(join(directory,entry.path));
    if(data.length!==entry.bytes || sha(data)!==entry.sha256)throw new Error('snapshot-digest');
    files.set(entry.path,data);bytes+=data.length;
  }
  if(names(directory).filter(n=>n!=='seal.json').length!==files.size)throw new Error('orphan-snapshot-file');
  return {seal,files,digest:sha(raw),bytes};
}
function decode(data:Buffer):string {return new TextDecoder('utf-8',{fatal:true}).decode(data);}
type Parsed={rows:HistoryRow[];frames:FrameJournalRecordV1[];screen:string[];legacy?:{liveStart:number;nextLine:number};error:string|null;consumedBytes:number;offsets:number[]};
function parseSource(input:HistoryImportOptions,files:Map<string,Buffer>):Parsed {
  const result:Parsed={rows:[],frames:[],screen:[],error:null,consumedBytes:0,offsets:[]};
  const required=(name:string):Buffer=>{const data=files.get(name);if(!data)throw new Error(`missing-${name}`);return data;};
  const add=(line_no:number,text:string)=>{
    safe(line_no);if(typeof text!=='string'||!text.isWellFormed())throw new Error('invalid-text');
    const last=result.rows.at(-1);if(last&&line_no!==last.line_no+1)throw new Error('source-coordinate-hole-or-conflict');
    result.rows.push({line_no,kind:'terminal',text});
  };
  try {
    if(input.format==='file-jsonl') {
      const candidates=[...files.keys()].filter(n=>/^history-[a-f0-9]+\.jsonl$/.test(n));
      const dataName=files.has('history.jsonl')?'history.jsonl':candidates.length===1?candidates[0]:'history.jsonl';
      const meta=JSON.parse(decode(required(dataName==='history.jsonl'?'meta.json':dataName.slice(0,-1))));
      if(!Array.isArray(meta.live)||meta.live.some((s:unknown)=>typeof s!=='string'))throw new Error('invalid-meta-live');
      safe(meta.liveStart);safe(meta.nextLine);if(meta.nextLine<meta.liveStart)throw new Error('invalid-meta-boundary');
      result.screen=meta.live;result.legacy={liveStart:meta.liveStart,nextLine:meta.nextLine};
      const bytes=required(dataName);let from=0;
      for(let i=0;i<bytes.length;i++)if(bytes[i]===10){
        const r=JSON.parse(decode(bytes.subarray(from,i)));add(r.line,r.text);from=i+1;result.consumedBytes=from;result.offsets.push(from);
      }
      if(from!==bytes.length)throw new Error('partial-jsonl-tail');
      if(result.rows.length && result.rows.at(-1)!.line_no+1!==meta.liveStart)throw new Error('metadata-seam');
    } else if(input.format==='durable-log') {
      const chunks=[...files.keys()].filter(n=>/^\d+\.log$/.test(n)).sort((a,b)=>Number(a.slice(0,-4))-Number(b.slice(0,-4)));
      if(!chunks.length)throw new Error('no-log-chunks');
      for(const name of chunks){
        const bytes=files.get(name)!;const start=Number(name.slice(0,-4));let from=0,index=0;
        for(let i=0;i<bytes.length;i++)if(bytes[i]===10){
          const line=start+index++,text=decode(bytes.subarray(from,i));
          const existing=result.rows.find(r=>r.line_no===line);
          if(existing){throw new Error(existing.text!==text?'conflicting-chunks':'overlap-needs-physical-record-mapping');}
          else add(line,text);
          result.consumedBytes+=i+1-from;from=i+1;result.offsets.push(result.consumedBytes);
        }
        if(from!==bytes.length)throw new Error('partial-log-tail');
      }
      result.consumedBytes=chunks.reduce((n,name)=>n+files.get(name)!.length,0);
    } else if(input.format==='host-chunks') {
      const manifest=JSON.parse(decode(required('manifest.json')));
      if(manifest.version!==1||!Array.isArray(manifest.chunks))throw new Error('invalid-manifest');
      const listed=new Set<string>();
      for(const chunk of manifest.chunks){
        if(typeof chunk.file!=='string'||chunk.file!==basename(chunk.file)||listed.has(chunk.file))throw new Error('invalid-chunk-file');
        listed.add(chunk.file);const bytes=required(chunk.file),rows=JSON.parse(decode(bytes));
        if(!Array.isArray(rows)||rows.length!==chunk.lineCount)throw new Error('chunk-count');
        rows.forEach((text,i)=>{add(chunk.startLine+i,text);result.offsets.push(result.consumedBytes);});result.consumedBytes+=bytes.length;result.offsets[result.offsets.length-1]=result.consumedBytes;
      }
      if([...files.keys()].some(n=>n.endsWith('.json')&&n!=='manifest.json'&&!listed.has(n)))throw new Error('orphan-chunk');
      if(result.rows.length!==manifest.totalLines)throw new Error('manifest-count');
    } else {
      const journals=[...files.keys()].filter(n=>n.endsWith('.ndjson'));
      const bytes=required(files.has('journal.ndjson')?'journal.ndjson':journals.length===1?journals[0]:'journal.ndjson');let from=0;
      for(let i=0;i<bytes.length;i++)if(bytes[i]===10){result.frames.push(JSON.parse(decode(bytes.subarray(from,i))));from=i+1;result.consumedBytes=from;result.offsets.push(from);}
      if(from!==bytes.length)throw new Error('partial-ndjson-tail');
    }
    if(!result.rows.length&&!result.frames.length&&!result.screen.length)throw new Error('no-readable-records');
  }catch(error){result.error=String(error);}
  return result;
}

export function readImportProgress(store:HistoryStore,sourceId:string):HistoryImportProgress {
  const row=store.db.query('SELECT * FROM history_import WHERE source_id=?').get(sourceId) as {
    source_id:string;session_id:string|null;state:HistoryImportState;snapshot_bytes:number;byte_cursor:number;record_cursor:number;evidence_json:string
  }|null;
  if(!row)throw new Error('unknown-import');
  const evidence=JSON.parse(row.evidence_json) as {totalRecords?:number;checkpointAt?:number};
  return {sourceId:row.source_id,sessionId:row.session_id,state:row.state,snapshotBytes:row.snapshot_bytes,
    byteCursor:row.byte_cursor,totalRecords:safe(evidence.totalRecords??row.record_cursor),recordCursor:row.record_cursor,
    checkpointAt:safe(evidence.checkpointAt??0)};
}

export async function importHistorySnapshot(store:HistoryStore,input:HistoryImportOptions):Promise<{state:HistoryImportState;records:number}> {
  const sealed=readSeal(input.snapshotDirectory);
  const sid=input.sessionId??null;
  const parsed=parseSource(input,sealed.files);
  const total=parsed.rows.length+parsed.frames.length;
  const evidenceJson=(error:string|null)=>JSON.stringify({seal:sealed.seal,error,oracleRequired:true,totalRecords:total,checkpointAt:Date.now()});
  const notify=()=>{try{input.onProgress?.(readImportProgress(store,input.sourceId));}catch(error){store.report(sid??'','import-progress-delivery-failed','progress callback accepted',String(error));}};
  await store.write(sid??'',()=>{
    const old=store.db.query('SELECT * FROM history_import WHERE source_id=?').get(input.sourceId) as {snapshot_sha256:string;session_id:string|null;format:string}|null;
    if(old){if(old.snapshot_sha256!==sealed.digest||old.session_id!==sid||old.format!==input.format)throw new Error('import-identity-conflict');return;}
    if(sid) {
      const s=store.session(sid);
      if(s.revision!==0 || (parsed.rows.length&&s.next_line!==parsed.rows[0].line_no))throw new Error('import-requires-empty-mapped-session-at-source-floor');
    }
    store.db.query('INSERT INTO history_import VALUES (?,?,?,?,?,?,0,0,0,NULL,?,?)').run(input.sourceId,sid,input.snapshotDirectory,input.format,
      sealed.digest,sealed.bytes,'pending',evidenceJson(parsed.error));
  });
  notify();
  const current=()=>store.db.query('SELECT * FROM history_import WHERE source_id=?').get(input.sourceId) as {record_cursor:number;state:string};
  if(!sid){await store.write('',()=>{store.db.query("UPDATE history_import SET state='quarantined',evidence_json=? WHERE source_id=?").run(evidenceJson('unmapped-session'),input.sourceId);});notify();return {state:'quarantined',records:0};}
  let cursor=current().record_cursor;
  try {
    // Import batches are bounded by both rows and encoded bytes; yield between commits.
    while(cursor<total || (!total&&parsed.screen.length&&current().state==='pending')) {
      const from=cursor;let to=from,bytes=0;
      while(to<total && to-from<500){const size=Buffer.byteLength(JSON.stringify(parsed.rows[to]??parsed.frames[to]));if(size>1048576)throw new Error('oversized-import-record');if(bytes+size>1048576)break;bytes+=size;to++;}
      if(input.format==='frame-ndjson') {
        await store.write(sid,()=>{
          for(let i=from;i<to;i++)store.insertFrame(sid,parsed.frames[i],null);
          store.db.query("UPDATE history_import SET record_cursor=?,imported_records=?,byte_cursor=?,state='copying',evidence_json=? WHERE source_id=?").run(to,to,parsed.offsets[to-1]??0,evidenceJson(null),input.sourceId);
        });
      } else {
        const rows=parsed.rows.slice(from,to),screen=to===total?parsed.screen:[];
        const geometry:HistoryGeometry={kind:'legacy-window',rows:screen.length,cols:0,generation:0,alternate:false};
        await store.commit({ticket:store.ticket(sid,`import:${input.sourceId}:${from}`),observation:{raw:screen,screen,geometry,at:0,source:{}},
          appended:rows.map(({kind,text})=>({kind,text})),liveLineLimit:0,evidence:{classification:'import',depth:'import',source:{},rawSha256:sealed.digest,
            importSpan:{source_id:input.sourceId,physicalRecordStart:from,count:rows.length},legacy:parsed.legacy}},()=>{
          store.db.query("UPDATE history_import SET record_cursor=?,imported_records=?,byte_cursor=?,state='copying',evidence_json=? WHERE source_id=?").run(to,to,parsed.offsets[to-1]??0,evidenceJson(null),input.sourceId);
        });
      }
      cursor=to;notify();await new Promise<void>(resolve=>setTimeout(resolve,0));if(!total)break;
    }
  }catch(error){parsed.error=String(error);}
  const state:HistoryImportState=parsed.error?'quarantined':'verified';
  await store.write(sid,()=>{store.db.query('UPDATE history_import SET state=?,byte_cursor=?,imported_sha256=?,evidence_json=? WHERE source_id=?').run(
    state,state==='verified'?sealed.bytes:Math.min(sealed.bytes,parsed.offsets[cursor-1]??0),sha(JSON.stringify({rows:parsed.rows.slice(0,cursor),frames:parsed.frames.slice(0,cursor)})),
    evidenceJson(parsed.error),input.sourceId);});
  notify();
  if(parsed.error)store.persistFault(sid,'import-quarantined','all sealed physical records mapped',parsed.error);
  return {state,records:cursor};
}

/** Consistent recovery bundle plus old-reader projections. Seal only after every file is fsynced.
 * A failure leaves an unsealed directory and never advances any mirror watermark. */
export function exportHistoryBundle(store:HistoryStore,sid:string,destination:string):{revision:number;directory:string} {
  try {
    mkdirSync(destination,{mode:0o700});
    const recovery=store.db.transaction(()=>{
      store.audit(sid);const session=store.session(sid);
      const captures=store.db.query('SELECT * FROM history_capture WHERE session_id=? ORDER BY seq').all(sid).map((c:any)=>({...c,unresolved_capture:c.unresolved_capture?Buffer.from(c.unresolved_capture).toString('base64'):null}));
      return {version:1,session,captures,lines:store.db.query('SELECT * FROM history_line WHERE session_id=? ORDER BY line_no').all(sid),
        frames:store.db.query('SELECT * FROM history_frame WHERE session_id=? ORDER BY frame_seq').all(sid),
        issues:store.db.query('SELECT * FROM history_issue WHERE session_id=? ORDER BY detected_at,issue_id').all(sid),
        imports:store.db.query('SELECT * FROM history_import WHERE session_id=?').all(sid)};
    })();
    const rows=recovery.lines as HistoryRow[],captures=recovery.captures as any[],last=captures.at(-1);
    const files=new Map<string,string>();
    files.set('recovery.json',JSON.stringify(recovery));
    files.set('history.jsonl',rows.map(r=>JSON.stringify({line:r.line_no,text:r.text})).join('\n')+(rows.length?'\n':''));
    // Legacy projection archives all immutable rows and keeps the saved pane/window separately.
    files.set('meta.json',JSON.stringify({liveStart:recovery.session.next_line,nextLine:recovery.session.next_line+(last?JSON.parse(last.screen_json).length:0),live:last?JSON.parse(last.screen_json):[]}));
    files.set('journal.ndjson',(recovery.frames as {record_json:string}[]).map(r=>r.record_json).join('\n')+(recovery.frames.length?'\n':''));
    for(let i=0;i<rows.length;i+=500)files.set(`${String(rows[i].line_no).padStart(12,'0')}.log`,rows.slice(i,i+500).map(r=>r.text+'\n').join(''));
    // Include the sealed source bytes so restore never depends on an external source path.
    for(const imp of recovery.imports as any[]){const source=readSeal(imp.source_path);files.set(`source-${sha(imp.source_id)}.json`,JSON.stringify({sourceId:imp.source_id,seal:source.seal,sealBytes:readFileSync(join(imp.source_path,'seal.json')).toString('base64'),files:[...source.files].map(([path,bytes])=>({path,base64:bytes.toString('base64')}))}));}
    const seal:Seal={version:1,files:[]};
    for(const [path,data]of files){durableFile(join(destination,path),data);seal.files.push({path,bytes:Buffer.byteLength(data),sha256:sha(data)});}
    durableFile(join(destination,'seal.pending'),JSON.stringify(seal));renameSync(join(destination,'seal.pending'),join(destination,'seal.json'));syncDir(destination);syncDir(dirname(destination));
    return {revision:recovery.session.revision,directory:destination};
  }catch(error){store.persistFault(sid,'export-failed','sealed bundle at committed revision',String(error));throw error;}
}

export async function restoreHistoryBundle(store:HistoryStore,directory:string):Promise<string> {
  const sealed=readSeal(directory),data=sealed.files.get('recovery.json');if(!data)throw new Error('missing-recovery');
  const r=JSON.parse(decode(data));if(r.version!==1)throw new Error('future-recovery');
  const s=r.session,sid=s.session_id;
  const importedSources=new Map<string,string>();
  for(const imp of r.imports){
    const encoded=sealed.files.get(`source-${sha(imp.source_id)}.json`);
    if(!encoded)throw new Error('missing-recovery-source');
    const source=JSON.parse(decode(encoded));
    if(source.sourceId!==imp.source_id)throw new Error('recovery-source-identity');
    const destination=join(dirname(store.file),`restored-source-${randomUUID()}`);mkdirSync(destination,{mode:0o700});
    for(const entry of source.files){
      if(entry.path!==basename(entry.path)||entry.path==='seal.json')throw new Error('unsafe-recovery-path');
      durableFile(join(destination,entry.path),Buffer.from(entry.base64,'base64'));
    }
    durableFile(join(destination,'seal.json'),Buffer.from(source.sealBytes,'base64'));syncDir(destination);syncDir(dirname(destination));
    if(readSeal(destination).digest!==imp.snapshot_sha256)throw new Error('recovery-source-digest');
    importedSources.set(imp.source_id,destination);
  }
  await store.write(sid,()=>{
    const currentFence=store.pragma('application_id');
    store.db.query(`INSERT INTO history_session(session_id,lifecycle_key,name,group_label,active,writer_fence,first_line,next_line,live_start)
      VALUES (?,?,?,?,0,?,?,?,?)`).run(sid,s.lifecycle_key,s.name,s.group_label,currentFence,s.first_line,s.first_line,s.first_line);
    for(const c of r.captures){
      store.db.query('INSERT INTO history_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(sid,c.seq,c.request_id,c.previous_seq,c.at,c.geometry_json,c.screen_json,
        c.row_start,c.row_end,c.first_line,c.live_start,c.next_line,c.expected_rows,c.rows_sha256,c.evidence_json,c.unresolved_capture?Buffer.from(c.unresolved_capture,'base64'):null);
      for(const row of r.lines.filter((l:any)=>l.capture_seq===c.seq))store.db.query('INSERT INTO history_line VALUES (?,?,?,?,?,?)').run(sid,row.line_no,row.kind,row.text,row.capture_seq,row.capture_row);
      store.db.query('UPDATE history_session SET revision=?,live_start=? WHERE session_id=?').run(c.seq,c.live_start,sid);
    }
    for(const f of r.frames)store.db.query('INSERT INTO history_frame VALUES (?,?,?,?,?,?)').run(sid,f.frame_seq,f.at,f.kind,f.record_json,f.capture_seq);
    for(const i of r.issues)store.db.query('INSERT INTO history_issue VALUES (?,?,?,?,?,?,?,?,?)').run(i.issue_id,sid,i.capture_seq,i.kind,i.detected_at,i.boundary_line,i.missing_count,i.evidence_json,i.resolved_at);
    for(const imp of r.imports)store.db.query('INSERT INTO history_import VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      imp.source_id,sid,importedSources.get(imp.source_id)!,imp.format,imp.snapshot_sha256,imp.snapshot_bytes,imp.byte_cursor,imp.record_cursor,
      imp.imported_records,imp.imported_sha256,imp.state,imp.evidence_json);
    if(store.session(sid).next_line!==s.next_line || store.session(sid).revision!==s.revision)throw new Error('recovery-boundary');
    if(r.frames.length)parseReplayJournal(r.frames.map((f:any)=>f.record_json).join('\n')+'\n');
    store.audit(sid);
  });
  return sid;
}
