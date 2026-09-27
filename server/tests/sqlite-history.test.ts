import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, batch, ids, observation, evidence } from './sqlite-history/helpers';
import { HistoryStore } from '../src/sqlite-history/store';
import { HistoryCoordinator } from '../src/sqlite-history/coordinator';
import { inspectHistoryHealth, validateHistoryPage, verifyHistoryOracle } from '../src/sqlite-history/detectors';
import { importHistorySnapshot, sealHistorySnapshot, exportHistoryBundle, restoreHistoryBundle } from '../src/sqlite-history/transfer';

test('six tables, WAL/FULL, private modes, future schema refused; default barrel unchanged',async()=>{
  const f=fixture();try{
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(6);
    expect(f.store.pragma('synchronous')).toBe(2);expect(f.store.pragma('foreign_keys')).toBe(1);
    expect(f.db.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'wal'});
    expect(statSync(f.file).mode&0o777).toBe(0o600);
    expect(readFileSync(join(import.meta.dir,'../src/index.ts'),'utf8')).not.toContain('sqlite-history');
    f.db.exec('PRAGMA user_version=2');const db=new Database(f.file);
    expect(()=>new HistoryStore(db,{file:f.file})).toThrow('future-schema');db.close();
  }finally{await f.cleanup();}
});

test('append/receipt triggers reject holes, replacements and prefix deletion; exact retry only',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'}),b=batch(f.store,sid,['','OK','OK','ไทย\x1b[0m'],['screen'], 'request');
  const receipt=await f.store.commit(b);expect((await f.store.commit(b)).context).toEqual(receipt.context);
  b.appended[0].text='mutant';await expect(f.store.commit(b)).rejects.toThrow('retry-conflict');
  expect(()=>f.db.query('UPDATE history_line SET text=? WHERE session_id=?').run('bad',sid)).toThrow('immutable-line');
  expect(()=>f.db.query('DELETE FROM history_line WHERE session_id=?').run(sid)).toThrow('retention-disabled');
  expect(()=>f.db.query('UPDATE history_session SET first_line=1 WHERE session_id=?').run(sid)).toThrow('retention-disabled');
  expect(()=>f.db.query('UPDATE history_session SET revision=revision+1 WHERE session_id=?').run(sid)).toThrow('receipt-mismatch');
  expect(()=>f.db.query('INSERT INTO history_line VALUES (?,?,?,?,?,?)').run(sid,12,'terminal','bad',2,0)).toThrow('append-order');
  expect(f.store.audit(sid)).toEqual({captures:1,rows:4});
  f.db.query('UPDATE history_session SET next_line=next_line+1 WHERE session_id=?').run(sid);
  expect(()=>f.store.audit(sid)).toThrow('receipt-boundary');evidence(f.alarms.find(f=>f.detector==='write-failed'));
 }finally{await f.cleanup();}
});

test('storage-hole detector cries on 4596 deleted rows; byte audit cries with equal count',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});await f.store.commit(batch(f.store,sid,ids(6000)));
  f.db.exec('DROP TRIGGER line_delete');f.db.query('DELETE FROM history_line WHERE session_id=? AND line_no>=500 AND line_no<5096').run(sid);
  expect(()=>f.store.page(sid,'after',null,2000)).toThrow('storage-hole');
  expect(()=>f.store.audit(sid)).toThrow();evidence(f.alarms.find(f=>f.detector==='storage-hole'));
  const other=await f.store.register({name:'other',lifecycleKey:'two'});await f.store.commit(batch(f.store,other,ids(20)));
  f.db.exec('DROP TRIGGER line_immutable');f.db.query('UPDATE history_line SET text=? WHERE session_id=? AND line_no=5').run('same count corrupted bytes',other);
  expect(()=>f.store.audit(other)).toThrow('batch-hash');evidence(f.alarms.find(f=>f.detector==='integrity-audit'&&f.sessionId===other));
 }finally{await f.cleanup();}
});

test('source oracle kills pre-allocation loss/renumber and duplicate occurrence while SQL audit can pass',async()=>{
 const f=fixture();try{
  const original=ids(6000),sid=await f.store.register({name:'s',lifecycleKey:'one'});
  const mutant=[...original.slice(0,500),...original.slice(5096)];await f.store.commit(batch(f.store,sid,mutant));
  expect(f.store.audit(sid).rows).toBe(1404);
  const oracle=original.map((text,line_no)=>({line_no,kind:'terminal' as const,text})),actual=f.store.rows(sid,0,1404);
  expect(()=>verifyHistoryOracle(oracle,actual)).toThrow('source-oracle-mismatch');
  const duplicate=structuredClone(oracle);duplicate[10].text=duplicate[9].text;
  expect(()=>verifyHistoryOracle(oracle,duplicate)).toThrow('source-oracle-mismatch');
  verifyHistoryOracle(oracle,structuredClone(oracle));expect(()=>verifyHistoryOracle([],[])).toThrow('oracle-empty');
  evidence(f.store.report(sid,'source-oracle-mismatch',{count:6000},{count:1404},4596));
 }finally{await f.cleanup();}
});

test('reopen 1000 to 250+40 keeps all 1000 IDs across archive/live; repaint does not append',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'}),raw=ids(1000);let current=observation(raw);
  const driver={geometryGeneration:()=>1,capture:async()=>current};
  const large=new HistoryCoordinator(f.store,{driver,sessions:()=>[sid],liveLineLimit:1000});await large.probe(sid);await large.stopAndDrain();
  current=observation(raw.slice(-290));const small=new HistoryCoordinator(f.store,{driver,sessions:()=>[sid],liveLineLimit:290});await small.probe(sid);
  const snap=f.store.snapshot(sid),page=f.store.page(sid,'before',null,2000);
  expect([...page.rows,...snap.live].map(r=>r.text).concat(snap.screen)).toEqual(raw);
  expect(page.rows).toHaveLength(710);expect(snap.live).toHaveLength(250);
  current=observation([...raw.slice(-290,-40),...Array(40).fill('repaint')]);await small.probe(sid);
  expect(f.store.snapshot(sid).context.nextLine).toBe(960);
 }finally{await f.cleanup();}
});

test('ring overflow / identical repeated snapshots / missing empty / ambiguous all remain unknown and preserve raw',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});let o=observation(Array(100).fill('separator'),10);o.source.ringFull=true;
  const co=new HistoryCoordinator(f.store,{driver:{geometryGeneration:()=>1,capture:async()=>o},sessions:()=>[sid]});
  const ledger=Array.from({length:100},(_,id)=>({id,text:'separator'}));const before=ledger.slice(-100).map(r=>r.text);
  ledger.push(...Array.from({length:100},(_,i)=>({id:100+i,text:'separator'})));
  expect(ledger.slice(-100).map(r=>r.text)).toEqual(before);expect(ledger.length).toBe(200);
  const first=await co.probe(sid);expect(first.context.continuity).toBe('unknown');
  await co.probe(sid);const c=f.store.capture(sid,2);expect(JSON.parse(c.evidence_json).classification).toBe('ambiguous');expect(c.unresolved_capture).not.toBeNull();
  o=observation([],10);await co.probe(sid);expect(JSON.parse(f.store.capture(sid,3).evidence_json).classification).toBe('empty');
  o=observation(ids(90,10000),10);await co.probe(sid);expect(JSON.parse(f.store.capture(sid,4).evidence_json).classification).toBe('missing');
  expect(f.store.capture(sid,4).unresolved_capture).not.toBeNull();
  expect(f.store.health(sid).continuity).toBe('unknown');evidence(f.alarms.find(f=>f.detector==='source-unknown'));
 }finally{await f.cleanup();}
});

test('deadline isolates a hung session; independent watchdog emits receipts before 60s including callback loss',async()=>{
 const f=fixture();try{
  const hung=await f.store.register({name:'hung',lifecycleKey:'one'}),good=await f.store.register({name:'good',lifecycleKey:'two'});
  const co=new HistoryCoordinator(f.store,{sessions:()=>[hung,good],deadlineMs:30,driver:{geometryGeneration:()=>1,
    capture:async sid=>sid===hung?new Promise(()=>{}):observation(ids(50),10)}});
  const t=Date.now(),hungTask=co.probe(hung);await co.probe(good);await expect(hungTask).rejects.toThrow('capture-deadline');
  expect(f.store.health(good).revision).toBe(1);expect(Date.now()-t).toBeLessThan(1000);evidence(f.alarms.find(f=>f.detector==='capture-failed'));
  const status=f.store.health(hung),receipts=inspectHistoryHealth({...status,fault:null},status.startedAt+45000);
  expect(receipts.some(r=>r.detector==='probe-stale')).toBe(true);receipts.forEach(evidence);
  expect(inspectHistoryHealth({...status,continuity:'failed'},Date.now()).some(r=>r.detector==='collector-failed')).toBe(true);
 }finally{await f.cleanup();}
});

test('COMMIT is visible to an independent reader before send; failed send resumes and rollback never ACKs',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'}),reader=new Database(f.file,{readonly:true});let sent=0;
  const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)},publish:receipt=>{
    const visible=reader.query('SELECT revision,next_line FROM history_session WHERE session_id=?').get(sid) as any;
    expect(visible.revision).toBe(receipt.context.revision);expect(visible.next_line).toBe(40);sent++;throw new Error('WS disconnected');
  }});
  await expect(co.probe(sid)).rejects.toThrow('WS disconnected');expect(sent).toBe(1);expect(f.store.snapshot(sid).context.revision).toBe(1);
  evidence(f.alarms.find(f=>f.detector==='delivery-failed'));reader.close();
  const before=f.store.snapshot(sid);const b=batch(f.store,sid,['new']);
  await expect(f.store.commit(b,()=>{throw new Error('IO failure before commit');})).rejects.toThrow();
  expect(f.store.snapshot(sid)).toEqual(before);expect(f.store.rows(sid,40,41)).toEqual([]);
  await f.store.commit(b);expect(f.store.snapshot(sid).context.revision).toBe(2);
 }finally{await f.cleanup();}
});

test('real SQLITE_BUSY and SQLITE_FULL leave no partial receipt; same ID retries once',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'}),lock=new Database(f.file);
  lock.exec('BEGIN IMMEDIATE');const b=batch(f.store,sid,['a'],'screen'.split(' '),'busy');
  await expect(f.store.commit(b)).rejects.toThrow();expect(f.store.session(sid).revision).toBe(0);
  lock.exec('ROLLBACK');lock.close();await f.store.commit(b);await f.store.commit(b);expect(f.store.session(sid).revision).toBe(1);
  const pages=f.store.pragma('page_count');f.db.exec(`PRAGMA max_page_count=${pages}`);
  await expect(f.store.commit(batch(f.store,sid,['x'.repeat(2*1024*1024)]))).rejects.toThrow();
  expect(f.store.session(sid).revision).toBe(1);expect(f.store.session(sid).next_line).toBe(1);
  expect(f.alarms.filter(f=>f.detector==='write-failed').length).toBeGreaterThanOrEqual(2);f.alarms.filter(f=>f.detector==='write-failed').forEach(evidence);
 }finally{await f.cleanup();}
},5000);

test('ownership takeover fences stale work, rename collisions preserve both histories and reincarnation',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});await f.store.commit(batch(f.store,sid,['old']));
  const stale=batch(f.store,sid,['stale']);const other=new HistoryStore(new Database(f.file),{file:f.file});
  await expect(f.store.commit(stale)).rejects.toThrow('stale-fence');await expect(f.store.register({name:'new',lifecycleKey:'stale-new'})).rejects.toThrow('stale-fence');
  const s2=await other.register({name:'other',lifecycleKey:'two'});await expect(other.rename(sid,'other')).rejects.toThrow();
  expect(other.session(sid).name).toBe('s');expect(other.session(s2).name).toBe('other');
  await other.closeSession(sid);const s3=await other.register({name:'s',lifecycleKey:'three'});expect(s3).not.toBe(sid);expect(other.rows(sid,0,1)[0].text).toBe('old');
  await other.close();evidence(f.alarms.find(f=>f.detector==='write-failed'));
 }finally{await f.cleanup();}
});

test('geometry change during await is unresolved; stale revision cannot commit',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});let generation=1;
  const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],driver:{geometryGeneration:()=>generation,capture:async()=>{generation=2;return observation(ids(50),10,1);}}});
  await co.probe(sid);expect(f.store.session(sid).next_line).toBe(0);expect(JSON.parse(f.store.capture(sid,1).evidence_json).classification).toBe('geometry');
  const stale=batch(f.store,sid,['stale']);await f.store.commit(batch(f.store,sid,['fresh']));await expect(f.store.commit(stale)).rejects.toThrow('stale-revision');
 }finally{await f.cleanup();}
});

test('both paging directions retain old revision boundaries; viewer rejects mixed snapshot contexts',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});await f.store.commit(batch(f.store,sid,ids(100)));
  const ctx=f.store.snapshot(sid).context;await f.store.commit(batch(f.store,sid,ids(20,100)));
  const old=f.store.page(sid,'before',null,2000,ctx);expect(old.rows).toHaveLength(100);validateHistoryPage(ctx,old);
  const forward=f.store.page(sid,'after',49,30,ctx);expect(forward.rows.map(r=>r.line_no)).toEqual(Array.from({length:30},(_,i)=>i+50));
  expect(()=>validateHistoryPage(f.store.snapshot(sid).context,old)).toThrow('viewer-context-mismatch');
  const mutant=structuredClone(old);mutant.rows[10].line_no++;expect(()=>validateHistoryPage(ctx,mutant)).toThrow('viewer-range-mismatch');
  expect(()=>f.store.page(sid,'before',null,500,{...ctx,liveStart:99})).toThrow('context-mismatch');evidence(f.alarms.find(f=>f.detector==='read-unavailable'));
 }finally{await f.cleanup();}
});

function source(f:ReturnType<typeof fixture>,name:string,files:Record<string,string|Buffer>):string {
 const raw=join(f.dir,name);mkdirSync(raw);for(const [path,data]of Object.entries(files))writeFileSync(join(raw,path),data);
 const sealed=join(f.dir,name+'-sealed');sealHistorySnapshot(raw,sealed);return sealed;
}
test('all four legacy formats preserve bytes/coordinates and import retries do not duplicate',async()=>{
 const f=fixture();try{
  const lines=['','OK','OK','ไทย漢字\x1b[31m'];
  const fixtures:Array<{format:any;files:Record<string,string>;floor:number}>=[
    {format:'file-jsonl',floor:71,files:{'history.jsonl':lines.map((text,i)=>JSON.stringify({line:71+i,text})+'\n').join(''),'meta.json':JSON.stringify({liveStart:75,nextLine:77,live:['pane','']})}},
    {format:'durable-log',floor:71,files:{'000000000071.log':lines.map(s=>s+'\n').join(''),'meta.json':'{"liveStart":0}','index.jsonl':''}},
    {format:'host-chunks',floor:71,files:{'chunk.json':JSON.stringify(lines),'manifest.json':JSON.stringify({version:1,totalLines:4,chunks:[{file:'chunk.json',startLine:71,lineCount:4}]})}},
    {format:'frame-ndjson',floor:0,files:{'journal.ndjson':JSON.stringify({v:1,session:'frame-ndjson',at:1,frame:{channel:'frame-ndjson',type:'output',data:lines.join('\n'),cursor:null,reset:'resync'}})+'\n'}}
  ];
  for(const fixture of fixtures){
    const sid=await f.store.register({name:fixture.format,lifecycleKey:fixture.format,firstLine:fixture.floor});
    const directory=source(f,fixture.format,fixture.files),original=readFileSync(join(directory,'seal.json'));
    const opts={sourceId:fixture.format,sessionId:sid,snapshotDirectory:directory,format:fixture.format};
    expect((await importHistorySnapshot(f.store,opts)).state).toBe('verified');await importHistorySnapshot(f.store,opts);
    expect(readFileSync(join(directory,'seal.json'))).toEqual(original);
    if(fixture.format!=='frame-ndjson')expect(f.store.rows(sid,71,75).map(r=>r.text)).toEqual(lines);
    else expect(f.db.query('SELECT * FROM history_frame WHERE session_id=?').all(sid)).toHaveLength(1);
  }
 }finally{await f.cleanup();}
});

test('partial UTF8/JSONL/NDJSON, missing metadata, orphan and conflicting chunks are quarantined',async()=>{
 const f=fixture();try{
  const cases:Array<[any,Record<string,string|Buffer>]>= [
   ['file-jsonl',{'history.jsonl':'{"line":0,"text":"OK"}\n{"line":','meta.json':'{"liveStart":1,"nextLine":1,"live":[]}'}],
   ['file-jsonl',{'history.jsonl':'{"line":0,"text":"OK"}\n'}],
   ['frame-ndjson',{'journal.ndjson':'{"v":'}],
   ['durable-log',{'000000000000.log':Buffer.from([0xe0,0xb8,0x0a])}],
   ['durable-log',{'000000000000.log':'a\nb\n','000000000001.log':'conflict\n'}],
   ['host-chunks',{'manifest.json':'{"version":1,"totalLines":1,"chunks":[{"file":"a.json","startLine":0,"lineCount":1}]}','a.json':'["a"]','orphan.json':'["lost"]'}]
  ];
  for(let i=0;i<cases.length;i++){
   const [format,files]=cases[i],sid=await f.store.register({name:`bad${i}`,lifecycleKey:`bad${i}`}),directory=source(f,`bad${i}`,files);
   const originals=Object.keys(files).map(n=>readFileSync(join(directory,n)));
   const opts={sourceId:`bad${i}`,sessionId:sid,snapshotDirectory:directory,format};
   expect((await importHistorySnapshot(f.store,opts)).state).toBe('quarantined');const before=f.store.session(sid).next_line;
   expect((await importHistorySnapshot(f.store,opts)).state).toBe('quarantined');expect(f.store.session(sid).next_line).toBe(before);
   Object.keys(files).forEach((n,j)=>expect(readFileSync(join(directory,n))).toEqual(originals[j]));
  }
  evidence(f.alarms.find(f=>f.detector==='import-quarantined'));
 }finally{await f.cleanup();}
});

test('bundle restore includes post-C0 rows, pane, issues, frame metadata; export fault cannot seal',async()=>{
 const f=fixture(),restored=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});const b=batch(f.store,sid,['before'],'pane'.split(' '));
  b.frame={v:1,session:'s',at:10,frame:{channel:'s',type:'output',data:'before\npane',cursor:null,reset:'resync'}};
  await f.store.commit(b);await f.store.commit(batch(f.store,sid,['after-C0'],['saved pane','']));
  const dest=join(f.dir,'export');const watermark=exportHistoryBundle(f.store,sid,dest);expect(watermark.revision).toBe(2);
  const rsid=await restoreHistoryBundle(restored.store,dest);expect(restored.store.rows(rsid,0,2).map(r=>r.text)).toEqual(['before','after-C0']);
  expect(restored.store.snapshot(rsid).screen).toEqual(['saved pane','']);
  expect(restored.db.query('SELECT record_json FROM history_frame').get()).toEqual(f.db.query('SELECT record_json FROM history_frame').get());
  expect(restored.db.query('SELECT * FROM history_issue').all()).toHaveLength(2);
  const blocked=join(f.dir,'blocked');mkdirSync(blocked);expect(()=>exportHistoryBundle(f.store,sid,blocked)).toThrow();
 }finally{await f.cleanup();await restored.cleanup();}
});

test('SIGKILL at five commit boundaries recovers either entire old or entire new revision',async()=>{
 for(const point of ['before-transaction','after-row','before-boundary','before-commit','after-commit']){
  const f=fixture();try{
   const sid=await f.store.register({name:'s',lifecycleKey:'one'});await f.store.commit(batch(f.store,sid,['old'],['old screen']));
   const proc=Bun.spawn([process.execPath,join(import.meta.dir,'sqlite-history/crash-worker.ts'),f.file,sid,point],{stdout:'pipe',stderr:'pipe'});
   const [code,err]=await Promise.all([proc.exited,new Response(proc.stderr).text()]);
   console.log('CHILD_EXIT',JSON.stringify({point,code,signal:proc.signalCode,err}));expect(proc.signalCode).toBe('SIGKILL');
   const snap=f.store.snapshot(sid);expect(snap.context.revision).toBe(point==='after-commit'?2:1);
   expect(f.store.rows(sid,0,snap.context.nextLine).map(r=>r.text)).toEqual(point==='after-commit'?['old','after crash boundary','ไทย']:['old']);
   expect(snap.screen).toEqual(point==='after-commit'?['new screen']:['old screen']);expect(f.store.audit(sid).captures).toBe(snap.context.revision);
   console.log('CRASH_PROOF',JSON.stringify({point,exit:code,revision:snap.context.revision,nextLine:snap.context.nextLine}));
  }finally{await f.cleanup();}
 }
},10000);

test('watchdog mirror/commit alarms and viewer truncation detectors cry with real test sink receipts',async()=>{
 const {inspectHistoryMirror}=await import('../src/sqlite-history/detectors');
 const {randomUUID}=await import('node:crypto');
 const fault=inspectHistoryMirror('fixture',7,6,1000,46000);expect(fault?.detector).toBe('mirror-stale');evidence(fault!);
 expect(inspectHistoryMirror('fixture',7,7,1000,46000)).toBeNull();
 const health={sessionId:'fixture',startedAt:1000,lastProbeAt:45000,lastCommitAt:1000,continuity:'verified' as const,revision:1,fault:null};
 const alarms=inspectHistoryHealth(health,46000);expect(alarms.map(a=>a.detector)).toEqual(['commit-stale']);alarms.forEach(evidence);
 expect(inspectHistoryHealth({...health,lastCommitAt:45000},46000)).toEqual([]);
 const context={sessionId:'fixture',revision:1,firstLine:0,liveStart:3,nextLine:3,continuity:'unknown' as const};
 const page={context,rows:[{line_no:0,kind:'terminal' as const,text:'one'}],startLine:0,endLine:3,hasMore:false};
 expect(()=>validateHistoryPage(context,page)).toThrow('viewer-range-mismatch');
 evidence({issue_id:randomUUID(),sessionId:'fixture',detector:'viewer-range-mismatch',expected:3,observed:1,timestamp:Date.now(),missing_count:2});
});

test('frame validator rejects corrupt delta/channel and preserves equal timestamps and cursor absent/null',async()=>{
 const {createMuxDeltaFrame,parseReplayJournal}=await import('@thumbmux/core');
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'}),lines=Array.from({length:100},(_,i)=>`long-line-${i}-${'x'.repeat(50)}`);
  const full={v:1 as const,session:'s',at:10,frame:{channel:'s',type:'output' as const,data:lines.join('\n')}};
  await f.store.write(sid,()=>f.store.insertFrame(sid,full,null));
  const next=[...lines];next[99]='changed';const delta=createMuxDeltaFrame('s',lines,next,null)!;
  await f.store.write(sid,()=>f.store.insertFrame(sid,{v:1,session:'s',at:9,frame:delta},null));
  const records=f.db.query('SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq').all(sid) as any[];
  expect(JSON.parse(records[0].record_json).frame).not.toHaveProperty('cursor');expect(JSON.parse(records[1].record_json).frame.cursor).toBeNull();
  expect(JSON.parse(records[1].record_json).at).toBe(10);expect(parseReplayJournal(records.map(r=>r.record_json).join('\n')+'\n').seek(10).lines).toEqual(next);
  await expect(f.store.write(sid,()=>f.store.insertFrame(sid,{...full,session:'wrong'},null))).rejects.toThrow('frame-session');
  const corrupt={...delta,prefixHash:'invalid'};
  await expect(f.store.write(sid,()=>f.store.insertFrame(sid,{v:1,session:'s',at:11,frame:corrupt},null))).rejects.toThrow();
  expect(f.db.query('SELECT * FROM history_frame WHERE session_id=?').all(sid)).toHaveLength(2);
 }finally{await f.cleanup();}
});

test('opt-in recording stores committed live revision as v1 full and preserves rename channel',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],recordFrames:true,liveLineLimit:30,
    driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)}});
  await co.probe(sid);await f.store.rename(sid,'renamed');await co.probe(sid);
  const frames=f.db.query('SELECT * FROM history_frame WHERE session_id=? ORDER BY frame_seq').all(sid) as any[];
  expect(frames).toHaveLength(2);expect(frames.map(f=>f.capture_seq)).toEqual([1,2]);
  expect(JSON.parse(frames[1].record_json).frame.data).toBe(ids(50).slice(-30).join('\n'));
  expect(JSON.parse(frames[1].record_json).session).toBe('s');
  expect(JSON.parse(frames[1].record_json).frame.cursor).toBeNull();
 }finally{await f.cleanup();}
});

test('multi-batch import checkpoints bytes and records atomically, and recovery retains original sealed sources',async()=>{
 const f=fixture(),r=fixture();try{
  const lines=ids(1100),raw=lines.map((text,line)=>JSON.stringify({line,text})+'\n').join('');
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});
  const dir=source(f,'many',{'history-abc.jsonl':raw,'history-abc.json':JSON.stringify({liveStart:1100,nextLine:1101,live:['screen']})});
  const options={sourceId:'many',sessionId:sid,snapshotDirectory:dir,format:'file-jsonl' as const};
  // Simulate an interruption after the first committed batch; the next call resumes its receipt.
  const commit=f.store.commit.bind(f.store);let calls=0;
  f.store.commit=async(...args)=>{if(++calls===2)throw new Error('interrupted import');return commit(...args);};
  expect((await importHistorySnapshot(f.store,options)).state).toBe('quarantined');
  const checkpoint=f.db.query('SELECT record_cursor,byte_cursor FROM history_import WHERE source_id=?').get('many') as any;
  expect(checkpoint.record_cursor).toBe(500);expect(checkpoint.byte_cursor).toBe(Buffer.byteLength(raw.split('\n').slice(0,500).join('\n')+'\n'));
  f.store.commit=commit;expect((await importHistorySnapshot(f.store,options)).state).toBe('verified');
  expect(f.store.rows(sid,0,1100).map(r=>r.text)).toEqual(lines);
  const dest=join(f.dir,'bundle-import');exportHistoryBundle(f.store,sid,dest);await restoreHistoryBundle(r.store,dest);
  const restored=r.db.query('SELECT * FROM history_import WHERE source_id=?').get('many') as any;
  expect(restored.record_cursor).toBe(1100);expect(readFileSync(join(restored.source_path,'history-abc.jsonl'),'utf8')).toBe(raw);
 }finally{await f.cleanup();await r.cleanup();}
});

test('recording limit cries while line history still commits',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],recordFrames:true,recordingSessionBytes:128,
    driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)}});
  await co.probe(sid);expect(f.store.session(sid).next_line).toBe(40);expect(f.db.query('SELECT * FROM history_frame').all()).toHaveLength(0);
  evidence(f.alarms.find(f=>f.detector==='recording-limit'));
 }finally{await f.cleanup();}
});

test('public factory remains explicitly opt-in and opens no collector until requested',async()=>{
 const {createSqliteHistoryStore}=await import('../src/sqlite-history');
 const f=fixture();try{
  const history=await createSqliteHistoryStore({file:join(f.dir,'opt-in.db')});
  const sid=await history.registerSession({name:'opt',lifecycleKey:'opt'});let captures=0;
  const co=history.createCaptureCoordinator({sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:async()=>{captures++;return observation(ids(50),10);}}});
  await new Promise(r=>setTimeout(r,20));expect(captures).toBe(0);expect(history.health(sid).revision).toBe(0);
  await co.probe(sid);expect(captures).toBe(1);expect(history.snapshot(sid).context.nextLine).toBe(40);
  await history.close();
 }finally{await f.cleanup();}
});

test('alternate screen/reset and invalid geometry never promote repaint to immutable lines',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});const o=observation(ids(50),10);o.geometry.alternate=true;
  const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:async()=>o}});
  await co.probe(sid);expect(f.store.session(sid).next_line).toBe(0);expect(f.store.capture(sid,1).unresolved_capture).not.toBeNull();
  const bad=batch(f.store,sid,['a']);bad.observation.screen=['wrong'];await expect(f.store.commit(bad)).rejects.toThrow('screen-seam');
  bad.observation.at=NaN;await expect(f.store.commit(bad)).rejects.toThrow('invalid-time');
 }finally{await f.cleanup();}
});

test('stopAndDrain finishes an admitted capture before closing admission',async()=>{
 const f=fixture();try{
  const sid=await f.store.register({name:'s',lifecycleKey:'one'});let resolve!: (o:ReturnType<typeof observation>)=>void;
  const co=new HistoryCoordinator(f.store,{sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:()=>new Promise(r=>{resolve=r;})}});
  const probe=co.probe(sid),drain=co.stopAndDrain();resolve(observation(ids(50),10));await Promise.all([probe,drain]);
  expect(f.store.session(sid).next_line).toBe(40);await expect(co.probe(sid)).rejects.toThrow('coordinator-stopped');
 }finally{await f.cleanup();}
});

// NEWARCH-L1: v2 tests are additive; all v1 assertions above stay intact.
import { mkdtempSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createProjectionStore } from '../src/sqlite-history/projection-store';
import { openProjectionArchive } from '../src/sqlite-history/projection-reader';
import { PROJECTION_SCHEMA, PROJECTION_SCHEMA_VERSION } from '../src/sqlite-history/schema';
import { PROJECTION_OVERSIZE } from '../src/sqlite-history/types';
import type { PaneKey, PhysicalRow, ProjectionCapture, ProjectionCell } from '../src/sqlite-history/types';
const naKey:PaneKey={serverIdentity:'fixture-server',paneId:'%1',birthGeneration:1};
const naCell=(grapheme:string):ProjectionCell=>({grapheme,width:1,continuation:false,fg:null,bg:null,style:0});
const naRow=(text:string):PhysicalRow=>({text,cells:[...text].map(naCell)});
const naEvent=(text:string,receiveSeq:number,paneKey=naKey)=>({paneKey,sourceEpoch:1,geometryGeneration:1,physicalRow:naRow(text),softWrap:false,receiveSeq});
const naFrame=()=>({paneKey:naKey,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,cols:2,rows:1,kind:'normal' as const,cells:[[naCell('A'),naCell(' ')]],cursor:{row:0,col:0,visible:true}});

test('newarch v4: metadata-only schema, new-file refusal and deny-open path spy',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-path-'));let opens=0;
 try {
  const store=createProjectionStore({historyRoot:dir,mode:'create',beforeOpen:()=>opens++});
  await store.appendScroll(naEvent('one',1));store.flush();await store.close();
  const db=new Database(join(dir,'newarch-v3/history.sqlite3'),{readonly:true});
  expect(db.query('PRAGMA user_version').get()).toEqual({user_version:4});
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'na_%'").all()).toHaveLength(6);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='na_screen'").get()).toBeNull();
  expect(db.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'wal'});db.close();
  expect(()=>createProjectionStore({historyRoot:dir,mode:'create',beforeOpen:()=>opens++})).toThrow('new-file-required');
  for(const name of ['brain.db','brain.db-wal','brain.db-shm','brain.db-journal']) {
   const fake=join(dir,name);writeFileSync(fake,'forbidden fixture');
   expect(()=>createProjectionStore({historyRoot:dir,file:fake,mode:'recover',beforeOpen:()=>{opens++;throw Error('deny-open');}})).toThrow('forbidden-database-path');
  }
  symlinkSync(join(dir,'newarch-v3'),join(dir,'alias'));
  expect(()=>createProjectionStore({historyRoot:dir,file:join(dir,'alias/new.sqlite'),mode:'create',beforeOpen:()=>opens++})).toThrow('unsafe-database-path');
  linkSync(join(dir,'newarch-v3/history.sqlite3'),join(dir,'hard.sqlite'));
  expect(()=>createProjectionStore({historyRoot:dir,file:join(dir,'hard.sqlite'),mode:'recover',beforeOpen:()=>opens++})).toThrow('unsafe-database-path');
  const v1=join(dir,'old.sqlite');const old=new Database(v1);old.exec('PRAGMA user_version=1');old.close();
  expect(()=>createProjectionStore({historyRoot:dir,file:v1,mode:'recover',beforeOpen:()=>opens++})).toThrow('not-projection-v4');
  expect(opens).toBe(1);
  console.log('NA_PATH_PROOF',JSON.stringify({schema:4,migration:'004-newarch-compact-rows',forbiddenSqliteOpens:0,fixtureHash:createHash('sha256').update(JSON.stringify(naEvent('one',1))).digest('hex')}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('newarch v3: atomic CAS, exact checked receipt, repair, alternate screen and stale pages',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-cas-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('wrong',1));await s.appendScroll(naEvent('',2));
  await s.replaceScreen(naFrame());const old=s.token(naKey);
  const capture:ProjectionCapture={...naFrame(),receiveSeq:2,captureId:'cap-1',requestedAt:1,completedAt:2,firstHistoryRow:0,
    history:[naRow('right'),naRow('')],observedFields:['grapheme','style','cursor'],ambiguousRows:0,result:'exact'};
  // The strict CAS belongs to screen evidence (FIX2 M2); history-only is covered by the FIX2 M2 case.
  const quietCas={kind:'quiescent' as const,sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:2,receiveSeqAfter:2};
  await expect(s.calibrate({capture,captureEvidence:quietCas,expectedRevision:old.revision-1,checks:[],repairs:[]})).rejects.toThrow('stale-revision');
  await expect(s.calibrate({capture,expectedRevision:old.revision,checks:[{lineId:0,captureRow:0}],repairs:[]})).rejects.toThrow('check-not-exact');
  expect(s.token(naKey)).toEqual(old);
  const receipt=await s.calibrate({capture,captureEvidence:{kind:'quiescent',sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:2,receiveSeqAfter:2},expectedRevision:old.revision,checks:[{lineId:1,captureRow:1}],repairs:[{lineId:0,captureRow:0,physicalRow:naRow('right')}]});
  expect(receipt.durableRevision).toBe(0);expect(receipt.nextLineId).toBe(2);
  expect(()=>s.readPage(old,null,2)).toThrow('page-retry');
  let rows=s.readPage(s.token(naKey),null,2).lines;
  expect(rows.map(r=>r.text)).toEqual(['right','']);expect(rows.every(r=>r.checkState==='checked'&&r.checkedCaptureId==='cap-1')).toBe(true);
  expect(s.screen(naKey)?.display_source).toBe('tmux-calibrated');
  await s.replaceScreen({...naFrame(),kind:'alternate'});expect(s.token(naKey).nextLineId).toBe(2);
  expect(s.screen(naKey,'normal')?.last_capture_id).toBe('cap-1');
  expect(s.screen(naKey,'alternate')?.display_source).toBe('pipe');
  s.flush();expect(s.token(naKey).durableRevision).toBe(s.token(naKey).revision);
  await s.close();const recovered=createProjectionStore({historyRoot:dir,mode:'recover'});
  try{rows=recovered.readPage(recovered.token(naKey),null,2).lines;expect(rows.map(r=>r.checkedCaptureId)).toEqual(['cap-1','cap-1']);expect(rows.map(r=>r.text)).toEqual(['right','']);}finally{await recovered.close();}
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('newarch v3: 100ms flush, byte threshold, idempotent post-commit retry, epoch isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-flush-'));let fail=false;const ids:string[]=[];
 const s=createProjectionStore({historyRoot:dir,mode:'create',checkpoint:(phase,id)=>{if(phase==='after-disk-commit'){ids.push(id);if(fail){fail=false;throw Error('watermark fault');}}}});
 try {
  await s.appendScroll(naEvent('timer',1));expect(s.token(naKey).durableRevision).toBe(0);
  const start=Date.now();while(s.token(naKey).durableRevision===0 && Date.now()-start<500)await Bun.sleep(5);
  expect(s.token(naKey).durableRevision).toBe(1);expect(s.health().lastFlushAgeMs).toBeLessThanOrEqual(150);
  const large='x'.repeat(270000);await s.appendScroll({...naEvent('',2),physicalRow:{text:large,cells:[]}});
  const thresholdStart=Date.now();while(s.token(naKey).durableRevision<2&&Date.now()-thresholdStart<500)await Bun.sleep(5);
  expect(s.token(naKey).durableRevision).toBe(2);
  await s.appendScroll(naEvent('retry',3));fail=true;
  expect(()=>s.flush()).toThrow('watermark fault');expect(s.token(naKey).durableRevision).toBe(2);expect(s.health().status).toBe('degraded');
  const retryId=ids.at(-1);s.flush();expect(ids.filter(id=>id===retryId).length).toBe(2);expect(s.token(naKey).durableRevision).toBe(s.token(naKey).revision);
  await s.appendScroll({...naEvent('new epoch',4),sourceEpoch:2});s.flush();
  const page=s.readPage(s.token(naKey),null,10);expect(page.lines.map(r=>r.sourceEpoch)).toEqual([1,1,1,2]);
  const db=new Database(s.file,{readonly:true});expect(db.query('SELECT count(*) AS n FROM na_line').get()).toEqual({n:4});
  expect(db.query("SELECT count(*) AS n FROM na_issue WHERE kind='gap' AND missing_count IS NULL").get()).toEqual({n:1});db.close();
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('newarch v3: 21 pane queues, 20000-row burst, disk/RAM page seam and oracle mutation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-burst-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const keys=Array.from({length:21},(_,i)=>({...naKey,paneId:`%${i}`}));
  const jobs=keys.map((key,i)=>s.appendScroll(naEvent(`pane:${i}`,1,key)));await Promise.all(jobs);
  expect(s.health().panes).toHaveLength(21);
  for(let i=1;i<20000;i++)await s.appendScroll(naEvent(i%3===0?'':i%3===1?'repeat':`ไทย漢:${i}`,i+1,keys[0]));
  s.flush();const token=s.token(keys[0]);let anchor:number|null=null;const rows:string[]=[];
  do{const page=s.readPage(token,anchor,2000);rows.push(...page.lines.map(r=>r.text));anchor=page.hasMore?page.nextAnchor:null;}while(anchor!==null);
  const oracle=Array.from({length:20000},(_,i)=>i===0?'pane:0':i%3===0?'':i%3===1?'repeat':`ไทย漢:${i}`);
  expect(rows).toEqual(oracle);
  for(let i=1;i<21;i++)expect(s.readPage(s.token(keys[i]),null,2).lines.map(r=>r.text)).toEqual([`pane:${i}`]);
  // Line 710 is sealed into a block (unchecked rows seal 4608 behind the pane);
  // line 19990 is a per-line tail row, also resident in RAM, so the disk-only archive reader sees its loss.
  const db=new Database(s.file);
  expect(db.query('SELECT count(*) AS n FROM na_block WHERE first_line_id<=710 AND first_line_id+line_count>710').get()).toEqual({n:1});
  db.exec('DELETE FROM na_line WHERE line_id=19990');
  db.exec('DELETE FROM na_block WHERE first_line_id<=710 AND first_line_id+line_count>710');db.close();
  expect(()=>s.readPage(token,0,2000)).toThrow('page-seam-hole');
  const archive=openProjectionArchive(s.file);
  try {expect(()=>archive.readPage(archive.token(keys[0]),19000,1000)).toThrow('page-seam-hole');}finally{archive.close();}
  console.log('NA_BURST',JSON.stringify({panes:21,rows:20000,missing:Math.max(0,oracle.length-rows.length),extra:Math.max(0,rows.length-oracle.length),wrong:rows.filter((r,i)=>r!==oracle[i]).length,deletedLine710Detected:true,health:s.health()}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},30000);


import { encodeCells, decodeCells, EVICT_LINES_SQL } from '../src/sqlite-history/ram-store';
test('newarch: compact cells preserve every field while restart requires a fresh screen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-cell-runs-'));
 const cells:ProjectionCell[]=[{grapheme:'漢',width:2,continuation:false,fg:'#123456',bg:4,style:7},
   {grapheme:'',width:0,continuation:true,fg:'#123456',bg:4,style:7},naCell('ก้'),naCell(' '),naCell(' ')];
 expect(decodeCells(encodeCells(cells))).toEqual(cells);
 expect(decodeCells(JSON.stringify(cells.map(c=>[c,1])))).toEqual(cells);
 const s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll({...naEvent('row',1),physicalRow:{text:'row',cells}});
  const frame={...naFrame(),cols:cells.length,cells:[cells]};await s.replaceScreen(frame);s.flush();
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))).toEqual([cells]);
  const disk=new Database(s.file,{readonly:true});
  expect(disk.query("SELECT name FROM sqlite_master WHERE name='na_screen'").get()).toBeNull();
  expect(disk.query("SELECT name FROM pragma_table_info('na_capture') WHERE name IN ('screen_cells_json','history_cells_json','cells_json','payload_json')").all()).toEqual([]);
  disk.close();
  await s.close();const r=createProjectionStore({historyRoot:dir,mode:'recover'});
  try{expect(r.screen(naKey)).toBeNull();expect(r.readPage(r.token(naKey),null,2).lines[0].cells).toEqual(cells);}finally{await r.close();}
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});


test('newarch: queued old writer is fenced before RAM acknowledgement and disk commit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-fence-'));
 const old=createProjectionStore({historyRoot:dir,mode:'create'});
 let current:ReturnType<typeof createProjectionStore>|undefined;
 try {
  await old.appendScroll(naEvent('durable',1));old.flush();
  const pending=old.appendScroll(naEvent('old queued',2));
  current=createProjectionStore({historyRoot:dir,mode:'recover'});
  await expect(pending).rejects.toThrow('stale-writer');
  expect(()=>old.flush()).toThrow('stale-writer');
  await expect(old.close()).rejects.toThrow('stale-writer');
  await current.appendScroll(naEvent('new writer',2));current.flush();
  expect(current.readPage(current.token(naKey),null,10).lines.map(r=>r.text)).toEqual(['durable','new writer']);
 }finally{await old.close();await current?.close();rmSync(dir,{recursive:true,force:true});}
});


test('newarch: eviction query plan seeks the line-id range, never the whole durable revision range',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-evict-plan-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const db=(s as any).ram.db as Database;
  const plan=(sql:string)=>db.query('EXPLAIN QUERY PLAN '+sql).all('pane',1000,6000) as Array<{detail:string}>;
  const actual=plan(EVICT_LINES_SQL);
  console.log('NA_EVICT_PLAN',JSON.stringify({actual}));
  expect(actual.some(r=>r.detail.includes('PRIMARY KEY')&&r.detail.includes('line_id<?'))).toBe(true);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});


test('newarch: admission freezes cell content before caller mutates the original event',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-freeze-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const event=naEvent('AB',1),expected=structuredClone(event.physicalRow),key={...event.paneKey};
  const pending=s.appendScroll(event);
  event.physicalRow.text='changed';event.physicalRow.cells[0].grapheme='X';event.paneKey={...key,paneId:'%other'};
  await pending;s.flush();
  const line=s.readPage(s.token(key),null,1).lines[0];expect(line.text).toBe(expected.text);expect(line.cells).toEqual(expected.cells);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});


test('newarch: screen generation transitions preserve accepted scroll ordering',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-order-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('seed',0));
  const old=s.appendScroll(naEvent('accepted before resize',1));
  const resized=s.replaceScreen({...naFrame(),geometryGeneration:2});
  const latest=s.replaceScreen({...naFrame(),geometryGeneration:2,receiveSeq:3,cells:[[naCell('Z'),naCell(' ')]]});
  await Promise.all([old,resized,latest]);s.flush();
  expect(s.readPage(s.token(naKey),null,10).lines.map(l=>l.text)).toContain('accepted before resize');
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[0][0].grapheme).toBe('Z');
  await s.appendScroll({...naEvent('after resize',4),geometryGeneration:2});
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('newarch: capacity rejection cannot advance generation past accepted history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-reject-order-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const old=s.appendScroll(naEvent('accepted',1));
  const rejected=s.appendScroll({...naEvent('',2),sourceEpoch:2,geometryGeneration:2,physicalRow:{text:'x'.repeat(17*1024*1024),cells:[]}});
  await expect(rejected).rejects.toThrow('ingest-oversize');await old;s.flush();
  expect(s.readPage(s.token(naKey),null,10).lines.map(l=>l.text)).toEqual(['accepted']);
  expect(s.health().rejectedRows).toBe(1);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2: issue and monotonic epoch CAS survive reopen with unknown loss and archived rows',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-epoch-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('old',1));
  const issue={paneKey:naKey,sourceEpoch:1,geometryGeneration:1,expectedRevision:s.token(naKey).revision,
   kind:'reader-lost',reason:'unknown bytes after disconnect',missingCount:null,boundaryLineId:1,recoverable:false};
  await s.recordIssue(issue);
  await expect(s.transitionEpoch({...issue,nextEpoch:2})).rejects.toThrow('stale-revision');
  const transition={...issue,expectedRevision:s.token(naKey).revision,nextEpoch:2};
  await expect(s.transitionEpoch({...transition,nextEpoch:1})).rejects.toThrow('nonmonotonic-epoch');
  await s.transitionEpoch(transition);
  await expect(s.appendScroll(naEvent('stale',2))).rejects.toThrow('stale-generation');
  await s.appendScroll({...naEvent('new',0),sourceEpoch:2});
  s.flush();expect(s.health().panes[0].status).toBe('degraded');
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  const page=s.readPage(s.token(naKey),null,10);
  expect(page.lines.map(r=>[r.text,r.sourceEpoch])).toEqual([['old',1],['new',2]]);
  expect(page.issues).toHaveLength(2);expect(page.issues.every(i=>i.missingCount===null && i.boundaryLineId===1)).toBe(true);
  expect(s.health().panes[0]).toMatchObject({sourceEpoch:2,status:'degraded'});
  expect(s.health().panes[0].issues).toEqual(page.issues);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 A-B2/C-F19: quiescent capture calibrates the displayed screen in the same transaction; unfenced or moving captures never do',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-fence-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('history',1));await s.replaceScreen(naFrame());
  const capture:ProjectionCapture={...naFrame(),cells:[[naCell('Z'),naCell(' ')]],captureId:'unfenced',requestedAt:1,completedAt:2,
   firstHistoryRow:0,history:[naRow('history')],observedFields:['grapheme'],ambiguousRows:0,result:'exact-history'};
  await s.calibrate({capture,expectedRevision:s.token(naKey).revision,captureEvidence:{kind:'unfenced',reason:'bytes arrived during capture'},checks:[{lineId:0,captureRow:0}],repairs:[]});
  expect(s.screen(naKey)?.display_source).toBe('pipe');
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[0][0].grapheme).toBe('A');
  expect(s.readPage(s.token(naKey),null,10).lines[0].checkState).toBe('checked');
  // Bytes arrived while capturing: the whole calibration rolls back.
  const token=s.token(naKey);
  const moving={kind:'quiescent' as const,sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:1,receiveSeqAfter:2};
  await expect(s.calibrate({capture:{...capture,captureId:'moving'},expectedRevision:token.revision,captureEvidence:moving,checks:[],repairs:[]})).rejects.toThrow('capture-not-quiescent');
  expect(s.token(naKey)).toEqual(token);
  // A pipe frame after the caller's read is newer than the capture: CAS refuses it.
  const read=s.token(naKey);await s.replaceScreen({...naFrame(),cells:[[naCell('P'),naCell(' ')]]});
  const quiet={kind:'quiescent' as const,sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:3,receiveSeqAfter:3};
  await expect(s.calibrate({capture:{...capture,captureId:'late'},expectedRevision:read.revision,captureEvidence:quiet,checks:[],repairs:[]})).rejects.toThrow('stale-revision');
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[0][0].grapheme).toBe('P');
  // No receiveSeq equality with the parser is required (tmux has no byte fence).
  const receipt=await s.calibrate({capture:{...capture,captureId:'good',receiveSeq:0},expectedRevision:s.token(naKey).revision,captureEvidence:quiet,checks:[],repairs:[]});
  const shown=s.screen(naKey)!;
  expect(shown).toMatchObject({display_source:'tmux-calibrated',last_capture_id:'good',revision:receipt.revision});
  expect(JSON.parse(String(shown.cells_json))[0][0].grapheme).toBe('Z');
  // Display state is intentionally volatile: restart waits for a fresh frame.
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  expect(s.screen(naKey)).toBeNull();
  // The next pipe frame renders over the calibrated screen at once.
  await s.replaceScreen({...naFrame(),cells:[[naCell('N'),naCell(' ')]]});
  expect(s.screen(naKey)).toMatchObject({display_source:'pipe',last_capture_id:null});
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX2 B1: null evidence checks history without touching the screen; uncertain emoji rows are drawn but kept uncertified',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-fix2-b1-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('history',1));await s.replaceScreen({...naFrame(),rows:2,cells:[[naCell('A'),naCell(' ')],[naCell('B'),naCell(' ')]]});
  const capture:ProjectionCapture={...naFrame(),rows:2,cells:[[naCell('Z'),naCell(' ')],[naCell('Y'),naCell(' ')]],captureId:'null-evidence',requestedAt:1,completedAt:2,
   firstHistoryRow:0,history:[naRow('history')],observedFields:['grapheme'],ambiguousRows:0,result:'exact-history'};
  // I3 sends null when bytes moved during the capture: history only, no error.
  const before=s.token(naKey);
  const receipt=await s.calibrate({capture,expectedRevision:before.revision,captureEvidence:null,checks:[{lineId:0,captureRow:0}],repairs:[]});
  expect(receipt.revision).toBe(before.revision+1);
  expect(s.screen(naKey)).toMatchObject({display_source:'pipe',last_capture_id:null,uncertain_rows_json:'[]'});
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[1][0].grapheme).toBe('B');
  expect(s.readPage(s.token(naKey),null,10).lines[0]).toMatchObject({checkState:'checked',checkedCaptureId:'null-evidence'});
  // Quiescent with an uncertain emoji row: the whole capture is drawn, the row index is kept apart.
  const quiet={kind:'quiescent' as const,sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:4,receiveSeqAfter:4};
  const bad=s.token(naKey);
  await expect(s.calibrate({capture:{...capture,captureId:'bad-row'},expectedRevision:bad.revision,captureEvidence:{...quiet,uncertainRows:[2]},checks:[],repairs:[]})).rejects.toThrow('invalid-uncertain-rows');
  expect(s.token(naKey)).toEqual(bad);
  await s.calibrate({capture:{...capture,captureId:'emoji'},expectedRevision:bad.revision,captureEvidence:{...quiet,uncertainRows:[1,1]},checks:[],repairs:[]});
  expect(s.screen(naKey)).toMatchObject({display_source:'tmux-calibrated',last_capture_id:'emoji',uncertain_rows_json:'[1]'});
  expect(JSON.parse(String(s.screen(naKey)!.cells_json)).map((r:any)=>r[0].grapheme)).toEqual(['Z','Y']);
  // Evidence without the optional field is the plain quiescent shape: nothing uncertain.
  await s.calibrate({capture:{...capture,captureId:'plain'},expectedRevision:s.token(naKey).revision,captureEvidence:quiet,checks:[],repairs:[]});
  expect(s.screen(naKey)).toMatchObject({last_capture_id:'plain',uncertain_rows_json:'[]'});
  await s.calibrate({capture:{...capture,captureId:'emoji2'},expectedRevision:s.token(naKey).revision,captureEvidence:{...quiet,uncertainRows:[0]},checks:[],repairs:[]});
  // The receipt is durable but the screen is not; a fresh pipe frame restores readiness.
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  expect(s.screen(naKey)).toBeNull();
  await s.replaceScreen({...naFrame(),rows:2,cells:[[naCell('N'),naCell(' ')],[naCell('M'),naCell(' ')]]});
  expect(s.screen(naKey)).toMatchObject({display_source:'pipe',last_capture_id:null,uncertain_rows_json:'[]'});
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX2 M2: a history-only calibration is not refused for queued rows or a moved revision; screen evidence still is',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-fix2-m2-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('stable',1));
  const read=s.token(naKey);
  const capture:ProjectionCapture={...naFrame(),captureId:'busy',requestedAt:1,completedAt:2,firstHistoryRow:0,
   history:[naRow('stable')],observedFields:['grapheme'],ambiguousRows:0,result:'exact-history'};
  // Output keeps flowing: rows applied since the read and rows still queued behind it.
  await s.appendScroll(naEvent('moved',2));
  const queued=Array.from({length:50},(_,n)=>s.appendScroll(naEvent('q'+n,3+n)));
  const quiet={kind:'quiescent' as const,sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:2,receiveSeqAfter:2};
  await expect(s.calibrate({capture,expectedRevision:read.revision,captureEvidence:quiet,checks:[],repairs:[]})).rejects.toThrow('stale-revision');
  for(const evidence of [null,undefined,{kind:'unfenced' as const,reason:'bytes arrived'}]) {
   const receipt=await s.calibrate({capture:{...capture,captureId:'busy-'+String(evidence?.kind??evidence)},expectedRevision:read.revision,captureEvidence:evidence,checks:[{lineId:0,captureRow:0}],repairs:[]});
   expect(receipt.revision).toBeGreaterThan(read.revision);
  }
  await Promise.all(queued);
  const lines=s.readPage(s.token(naKey),null,100).lines;
  expect(lines.length).toBe(52);
  expect(lines[0]).toMatchObject({checkState:'checked',checkedCaptureId:'busy-unfenced'});
  expect(s.screen(naKey)).toBeNull(); // history only: no screen was written
  // Rows are still compared byte for byte: a stale mapping is refused atomically, never applied.
  const t=s.token(naKey);
  await expect(s.calibrate({capture:{...capture,captureId:'wrong'},expectedRevision:read.revision,captureEvidence:null,checks:[{lineId:1,captureRow:0}],repairs:[]})).rejects.toThrow('check-not-exact');
  expect(s.token(naKey)).toEqual(t);
  // A revision the pane never had is still the one CAS error.
  await expect(s.calibrate({capture,expectedRevision:t.revision+1,captureEvidence:null,checks:[],repairs:[]})).rejects.toThrow('stale-revision');
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX2 M1: an oversized event is ingest-oversize, never capacity-pressure, and counts once however often it is re-offered',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-fix2-m1-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 const originalError=console.error;console.error=()=>{};
 try {
  await s.appendScroll(naEvent('kept',1));
  const huge={...naEvent('',2),physicalRow:{text:'x'.repeat(17*1024*1024),cells:[]}};
  for(let i=0;i<5;i++) {
   const error=await s.appendScroll(huge).then(()=>null,e=>e);
   expect(String(error)).toContain(PROJECTION_OVERSIZE);expect(String(error)).not.toContain('capacity');
  }
  expect(s.health().rejectedRows).toBe(1);
  s.flush();
  // A different oversized event is a second loss; re-offering it adds nothing.
  const other={...naEvent('',3),physicalRow:{text:'y'.repeat(17*1024*1024),cells:[]}};
  for(let i=0;i<3;i++)await expect(s.appendScroll(other)).rejects.toThrow(PROJECTION_OVERSIZE);
  expect(s.health().rejectedRows).toBe(2);
  // An oversized frame re-offered is refused each time, never counted as a row.
  const bigFrame={...naFrame(),cells:[[{...naCell('z'),grapheme:'z'.repeat(17*1024*1024)},naCell(' ')]]};
  for(let i=0;i<3;i++)await expect(s.replaceScreen(bigFrame)).rejects.toThrow(PROJECTION_OVERSIZE);
  expect(s.health().rejectedRows).toBe(2);
  await s.appendScroll(naEvent('after',4));s.flush();
  const disk=new Database(s.file,{readonly:true});
  try {
   expect(disk.query("SELECT coalesce(sum(missing_count),0) AS n FROM na_issue WHERE kind=?").get(PROJECTION_OVERSIZE)).toEqual({n:2});
   expect(disk.query("SELECT count(*) AS n FROM na_issue WHERE kind='ingest-capacity' OR kind LIKE '%pressure%'").get()).toEqual({n:0});
  }finally{disk.close();}
  expect(s.readPage(s.token(naKey),null,10).lines.map(l=>l.text)).toEqual(['kept','after']);
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  expect(s.health().rejectedRows).toBe(2);
 }finally{console.error=originalError;await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 §2: repeated rows without unique anchors are content-matched, never downgrade a checked row, and survive reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-content-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  for(const [i,t] of ['$ ','unique','$ ','$ '].entries())await s.appendScroll(naEvent(t,i+1));
  const capture:ProjectionCapture={...naFrame(),captureId:'c1',requestedAt:1,completedAt:2,firstHistoryRow:0,
   history:['$ ','unique','$ ','$ '].map(naRow),observedFields:['grapheme'],ambiguousRows:0,result:'exact-history'};
  await s.calibrate({capture,expectedRevision:s.token(naKey).revision,checks:[{lineId:1,captureRow:1}],contentMatches:[{lineId:0,captureRow:0},{lineId:2,captureRow:2}],repairs:[]});
  let lines=s.readPage(s.token(naKey),null,10).lines;
  expect(lines.map(l=>[l.checkState,l.checkReason])).toEqual([['content-matched','content-capture'],['checked','exact-capture'],['content-matched','content-capture'],['unchecked','awaiting-capture']]);
  // Content never lies: a content match with different text is refused atomically.
  const before=s.token(naKey);
  await expect(s.calibrate({capture:{...capture,captureId:'c2',history:['x','unique','$ ','$ '].map(naRow)},expectedRevision:before.revision,checks:[],contentMatches:[{lineId:0,captureRow:0}],repairs:[]})).rejects.toThrow('check-not-exact');
  expect(s.token(naKey)).toEqual(before);
  // A later content match keeps the identity proven by anchors.
  await s.calibrate({capture:{...capture,captureId:'c3'},expectedRevision:before.revision,checks:[],contentMatches:[{lineId:1,captureRow:1},{lineId:3,captureRow:3}],repairs:[]});
  s.flush();await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  lines=s.readPage(s.token(naKey),null,10).lines;
  expect(lines.map(l=>[l.checkState,l.checkedCaptureId])).toEqual([['content-matched','c1'],['checked','c1'],['content-matched','c1'],['content-matched','c3']]);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I4 FIX1: a current-version file missing receipt metadata is refused on recover',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i4-outdated-')),file=join(dir,'newarch-v3/history.sqlite3');
 try {
  mkdirSync(join(dir,'newarch-v3'),{recursive:true});
  const db=new Database(file);
  db.exec(PROJECTION_SCHEMA.replace('screen_hash BLOB NOT NULL, history_hash BLOB NOT NULL,','capture_digest TEXT NOT NULL,'));
  db.exec(`PRAGMA user_version=${PROJECTION_SCHEMA_VERSION}`);db.close();
  expect(()=>createProjectionStore({historyRoot:dir,mode:'recover'})).toThrow('projection-schema-outdated');
  // The current factory's own file passes the same check.
  const fresh=mkdtempSync(join(tmpdir(),'na-i2-current-'));
  try {const s=createProjectionStore({historyRoot:fresh,mode:'create'});await s.close();const r=createProjectionStore({historyRoot:fresh,mode:'recover'});await r.close();}
  finally{rmSync(fresh,{recursive:true,force:true});}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('I4 FIX1: closed v2 archive is read without attaching it or restoring its screen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i4-v2-archive-')),file=join(dir,'archive-v2.sqlite3');
 const key={serverIdentity:'archive-server',paneId:'%7',birthGeneration:4},id=JSON.stringify([key.serverIdentity,key.paneId,key.birthGeneration]);
 try {
  const db=new Database(file);
  db.exec(`PRAGMA user_version=2;
   CREATE TABLE na_pane(pane_key TEXT PRIMARY KEY,session_uuid TEXT,server_identity TEXT,pane_id TEXT,birth_generation INTEGER,source_epoch INTEGER,geometry_generation INTEGER,cols INTEGER,rows INTEGER,screen_kind TEXT,next_line_id INTEGER,revision INTEGER,durable_revision INTEGER,health TEXT,receive_seq INTEGER);
   CREATE TABLE na_line(pane_key TEXT,source_epoch INTEGER,line_id INTEGER,revision INTEGER,geometry_generation INTEGER,text TEXT,cells_json TEXT,soft_wrap INTEGER,check_state TEXT,check_reason TEXT,checked_capture_id TEXT,checked_row INTEGER);
   CREATE TABLE na_issue(issue_id TEXT,pane_key TEXT,source_epoch INTEGER,revision INTEGER,boundary_line_id INTEGER,kind TEXT,reason TEXT,missing_count INTEGER,detected_at REAL,resolved_at REAL);
   CREATE TABLE na_screen(pane_key TEXT,cells_json TEXT);`);
  db.query('INSERT INTO na_pane VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'legacy-session',key.serverIdentity,key.paneId,key.birthGeneration,2,3,80,24,'normal',1,7,7,'healthy',9);
  db.query('INSERT INTO na_line VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,2,0,7,3,'legacy-row',encodeCells([naCell('L')]),0,'unchecked','legacy-v2',null,null);
  db.query('INSERT INTO na_screen VALUES (?,?)').run(id,JSON.stringify([[naCell('X')]]));db.close();
  const archive=openProjectionArchive(file);
  try {
   expect(archive.schemaVersion).toBe(2);const token=archive.token(key);
   expect(archive.readPage(token,null,10).lines[0]).toMatchObject({text:'legacy-row',checkReason:'legacy-v2'});
   expect(()=>createProjectionStore({historyRoot:dir,file,mode:'recover'})).toThrow('not-projection-v4');
  }finally{archive.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 A-B1: a same-generation frame is published at once, ahead of queued scrolls, with the committed history seam',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-seam-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const events:string[]=[];
  const rows=Array.from({length:500},(_,i)=>s.appendScroll(naEvent(`row ${i}`,i+1)));
  const a=Promise.all(rows).then(()=>events.push('scroll'));
  const started=performance.now();
  const b=s.replaceScreen({...naFrame(),cells:[[naCell('F'),naCell(' ')]]}).then(r=>{events.push('frame');return {r,ms:performance.now()-started};});
  // Written to RAM synchronously: visible before any queued row was applied.
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[0][0].grapheme).toBe('F');
  expect(s.token(naKey).nextLineId).toBe(0);
  const [{r,ms}]=await Promise.all([b,a]);
  expect(events).toEqual(['frame','scroll']);
  expect(r).toMatchObject({nextLineId:0});expect(ms).toBeLessThan(16);
  expect(s.token(naKey).nextLineId).toBe(500);
  // Queued rows never overwrite the newer screen, and every row is kept in order.
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))[0][0].grapheme).toBe('F');
  expect(s.readPage(s.token(naKey),null,600).lines.map(l=>l.text)).toEqual(Array.from({length:500},(_,i)=>`row ${i}`));
  console.log('I2_FIX1_FASTPATH',JSON.stringify({queuedRows:500,frameResolveMs:ms,frameNextLineId:(r as {nextLineId:number}).nextLineId}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 C-F12: issue and transition CAS is checked at admission, not after queued output of the same pane',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-cas-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('seed',1));
  // A caller that read before a published frame is stale by definition.
  const early=s.token(naKey);await s.replaceScreen(naFrame());
  const issue={paneKey:naKey,sourceEpoch:1,geometryGeneration:1,expectedRevision:early.revision,kind:'reader-lost',reason:'fixture',missingCount:null,boundaryLineId:early.nextLineId,recoverable:true};
  await expect(s.recordIssue(issue)).rejects.toThrow('stale-revision');
  // Output keeps arriving: rows are queued ahead of the issue and the transition.
  const rows=Array.from({length:50},(_,i)=>s.appendScroll(naEvent(`busy ${i}`,i+2)));
  const read=s.token(naKey);
  const recorded=s.recordIssue({...issue,expectedRevision:read.revision});
  const transition=s.transitionEpoch({...issue,expectedRevision:read.revision,nextEpoch:2});
  await Promise.all(rows);
  const [r1,r2]=await Promise.all([recorded,transition]);
  expect(r2.revision).toBeGreaterThan(r1.revision);
  expect(s.token(naKey)).toMatchObject({sourceEpoch:2,nextLineId:51});
  const page=s.readPage(s.token(naKey),null,100);
  expect(page.lines.map(l=>l.text)).toEqual(['seed',...Array.from({length:50},(_,i)=>`busy ${i}`)]);
  expect(page.issues.map(i=>i.boundaryLineId)).toEqual([1,1]);
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 C-F11: transitionEpoch returns the RAM receipt while the disk is locked; durable() follows without blocking',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-async-epoch-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 const lock=new Database(s.file);
 try {
  await s.appendScroll(naEvent('before',1));s.flush();
  lock.exec('BEGIN IMMEDIATE');   // a real writer holds the disk: every commit waits busy_timeout then fails
  const started=performance.now();
  const receipt=await s.transitionEpoch({paneKey:naKey,sourceEpoch:1,nextEpoch:2,geometryGeneration:1,expectedRevision:s.token(naKey).revision,
   boundaryLineId:1,kind:'reader-restart',reason:'fixture',missingCount:null,recoverable:true});
  const ms=performance.now()-started;
  expect(ms).toBeLessThan(50);expect(receipt.durableRevision).toBeLessThan(receipt.revision);
  expect(s.token(naKey).sourceEpoch).toBe(2);
  let durable=false;const pending=s.durable(naKey,receipt.revision).then(r=>{durable=true;return r;});
  await Bun.sleep(400);expect(durable).toBe(false);
  lock.exec('COMMIT');
  const done=await pending;expect(done.durableRevision).toBeGreaterThanOrEqual(receipt.revision);
  console.log('I2_FIX1_ASYNC_EPOCH',JSON.stringify({transitionMs:ms,durableAfterUnlock:true}));
 }finally{try{lock.exec('ROLLBACK');}catch{}lock.close();await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('I2 FIX1 C-F13: RAM pressure clears after real eviction; freelist pages are not counted as live',async()=>{
 // A 6 MiB cache with real ~1 KB rows (1000 characters: the v4 codec stores text plus a few bytes); no stubbed byte counter. The 5000 lines kept after eviction fit, a 6300-line burst does not.
 const dir=mkdtempSync(join(tmpdir(),'na-i2-freelist-')),s=createProjectionStore({historyRoot:dir,mode:'create',cacheBytes:6*1024*1024}),ram=(s as any).ram;
 clearInterval((s as any).timer);
 try {
  let n=0,refusal:any=null;
  // A pane-share refusal is flushed away (the pane may hold ~4.8 MiB); only RAM pressure ends the fill.
  while(!refusal && n<20000){const r:any=await s.appendScroll(naEvent(`row ${n} `.padEnd(1000,'x'),n+1));if(r.accepted!==false)n++;else if(r.scope==='pane')s.flush();else refusal=r;}
  const full=ram.bytes();
  expect(refusal).toMatchObject({accepted:false,reason:'capacity-pressure',scope:'store'});
  expect(s.health()).toMatchObject({status:'stopped',pressure:'recoverable',rejectedRows:0});
  s.flush();   // acknowledge evicts all but the last 5000 lines of the pane
  const pages=(ram.db.query('PRAGMA page_count').get() as any).page_count,free=(ram.db.query('PRAGMA freelist_count').get() as any).freelist_count;
  const after=ram.bytes();
  const drained=await Promise.race([s.drained(naKey).then(()=>'drained'),Bun.sleep(2000).then(()=>'stuck')]);
  console.log('I2_FIX1_FREELIST',JSON.stringify({rowsBeforePressure:n,full,after,pages,free,drained}));
  expect(free).toBeGreaterThan(0);expect(after).toBeLessThan(full);expect(s.health().ramBytes).toBe(after);
  expect(drained).toBe('drained');
  expect(await s.appendScroll(naEvent(`row ${n} `.padEnd(1000,'x'),n+1))).toMatchObject({nextLineId:n+1});
  s.flush();expect(s.health().status).not.toBe('stopped');
  expect(s.readPage(s.token(naKey),null,10).lines[0].text).toBe('row 0 '.padEnd(1000,'x'));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},60000);

test('I2: first epoch and pre-output fault persist without a fabricated initial frame',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-i2-birth-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const receipt=await s.transitionEpoch({paneKey:naKey,sourceEpoch:0,nextEpoch:1,geometryGeneration:1,expectedRevision:0,
   boundaryLineId:0,kind:'reader-start',reason:'no prior byte boundary',missingCount:null,recoverable:false});
  expect((await s.durable(naKey,receipt.revision)).durableRevision).toBe(receipt.revision);expect(s.screen(naKey)).toBeNull();
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  expect(s.token(naKey)).toMatchObject({sourceEpoch:1,nextLineId:0});
  expect(s.readPage(s.token(naKey),null,1).issues[0]).toMatchObject({boundaryLineId:0,missingCount:null,sourceEpoch:1});
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

// A realistic ~1.2 KiB encoded row crosses SQLite's 4 KiB index-page overflow
// threshold, unlike repeated-cell fixtures. Keep the same data for 10/12 panes.
const fix2Row=():PhysicalRow=>({text:'P01 000123 color3 ไทย漢字😀 '+ 'x'.repeat(80),
 cells:Array.from({length:120},(_,i)=>({...naCell(i<34?String.fromCharCode(65+i%26):'x'),fg:i<34?i%7:null}))});
for(const paneCount of [10,12])test(`I4 FIX2 F1: ${paneCount} panes retain 5000 realistic rows and keep admitting`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-fix2-cap-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const physicalRow=fix2Row();let accepted=0;
  const keys=Array.from({length:paneCount},(_,i)=>({...naKey,paneId:`%${i}`}));
  for(let n=0;n<5100;n+=100) {
   for(const key of keys)for(let i=n;i<n+100;i++) {
    const result=await s.appendScroll({...naEvent('',i+1,key),physicalRow});
    expect(result).not.toHaveProperty('accepted',false);accepted++;
   }
   s.flush();
  }
  expect(s.health().status).not.toBe('stopped');
  expect(s.health().ramBytes/(paneCount*5000)).toBeLessThan(2000);
  for(const key of keys) {
   expect(s.token(key).nextLineId).toBe(5100);
   expect(s.readPage(s.token(key),0,1).lines[0].text).toBe(physicalRow.text);
  }
  console.log('FIX2_CAP',JSON.stringify({paneCount,accepted,ramBytes:s.health().ramBytes}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},120000);

test('I4 FIX2 F1: idle durable cache pressure wakes drained without another flush and preserves disk history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-fix2-idle-')),s=createProjectionStore({historyRoot:dir,mode:'create',cacheBytes:1024*1024});
 try {
  let accepted=0,pressure=0;const row=fix2Row();
  for(let i=0;i<2400;i++) {
   const event={...naEvent('',i+1),physicalRow:row};
   let result=await s.appendScroll(event);
   if('accepted' in result) {
    pressure++;
    expect(await Promise.race([s.drained(naKey).then(()=>true),Bun.sleep(2000).then(()=>false)])).toBe(true);
    result=await s.appendScroll(event);
   }
   expect(result).not.toHaveProperty('accepted',false);accepted++;
   // Make rows durable frequently: retained rows, not pending IO, fill RAM.
   if(i%40===39)s.flush();
  }
  s.flush();expect(pressure).toBeGreaterThan(0);expect(accepted).toBe(2400);
  expect(s.readPage(s.token(naKey),0,20).lines.map(l=>l.text)).toEqual(Array(20).fill(row.text));
  const capture:ProjectionCapture={...naFrame(),captureId:'after-eviction',requestedAt:1,completedAt:2,firstHistoryRow:0,history:[row],observedFields:[],ambiguousRows:0,result:'exact'};
  await s.calibrate({capture,expectedRevision:s.token(naKey).revision,checks:[{lineId:0,captureRow:0}],repairs:[]});
  expect(s.readPage(s.token(naKey),0,1).lines[0].checkState).toBe('checked');
  console.log('FIX2_IDLE_RECOVERY',JSON.stringify({accepted,pressure,ramBytes:s.health().ramBytes}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},30000);

test('I4 FIX2 F2: 800-row calibration freezes RLE, bounds each commit to 256, and certifies every row',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-fix2-cal-')),s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  const row=fix2Row();
  for(let i=0;i<800;i++)await s.appendScroll({...naEvent('',i+1),physicalRow:row});
  s.flush();const revision=s.token(naKey).revision;
  const capture:ProjectionCapture={...naFrame(),captureId:'bounded',requestedAt:1,completedAt:2,firstHistoryRow:0,
   history:Array.from({length:800},()=>structuredClone(row)),observedFields:[],ambiguousRows:0,result:'exact'};
  const promise=s.calibrate({capture,expectedRevision:revision,checks:Array.from({length:800},(_,i)=>({lineId:i,captureRow:i})),repairs:[]});
  const queued=(s as any).queuedBytes;
  expect(queued).toBeLessThan(2*1024*1024);
  capture.history[0].cells[0].grapheme='MUTATED';
  const receipt=await promise;expect(receipt.revision-revision).toBe(4);
  const ram=(s as any).ram;
  const counts=ram.db.query('SELECT compared_rows,history_count FROM na_capture').all();
  expect(counts.length).toBe(4);
  expect(counts.every((r:any)=>r.compared_rows<=256 && r.history_count<=256)).toBe(true);
  const lines=s.readPage(s.token(naKey),0,800).lines;
  expect(lines.filter(l=>l.checkState==='checked').length).toBe(800);
  expect(lines[0].cells).toEqual(row.cells);
  console.log('FIX2_CALIBRATION',JSON.stringify({queued,commits:counts}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},30000);


test('I4 FIX2 F1: refused frame reserves its actual size when an idle durable cache reopens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-fix2-frame-')),s=createProjectionStore({historyRoot:dir,mode:'create',cacheBytes:1024*1024});
 try {
  const row=fix2Row();let seq=0;
  while(s.health().ramBytes<950000 && seq<1000) {
   expect(await s.appendScroll({...naEvent('',++seq),physicalRow:row})).not.toHaveProperty('accepted',false);
   if(seq%20===0)s.flush();
  }
  s.flush();expect(s.health().ramBytes).toBeGreaterThanOrEqual(950000);
  expect(s.health().ramBytes+512).toBeLessThan(1024*1024);
  const frame={...naFrame(),cols:120,rows:40,receiveSeq:seq+1,
   cells:Array.from({length:40},()=>Array.from({length:120},(_,i)=>naCell(String.fromCharCode(65+i%26))))};
  expect(await s.replaceScreen(frame)).toMatchObject({accepted:false,reason:'capacity-pressure',scope:'store'});
  expect(await Promise.race([s.drained(naKey).then(()=>true),Bun.sleep(2000).then(()=>false)])).toBe(true);
  expect(await s.replaceScreen(frame)).not.toHaveProperty('accepted',false);
  expect(JSON.parse(String(s.screen(naKey)!.cells_json))).toEqual(frame.cells);
  expect(s.readPage(s.token(naKey),0,1).lines[0].text).toBe(row.text);
  console.log('FIX2_FRAME_RECOVERY',JSON.stringify({historyRows:seq,ramBytes:s.health().ramBytes}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},30000);

// ── NEWARCH-SWITCHON S2: v4 compact rows, sealed blocks, v3 read-only ──
import { readFileSync as readFileS2, readdirSync as readdirS2, statSync as statS2 } from 'node:fs';
import { decodeRow, encodeRow } from '../src/sqlite-history/codec';
import { PROJECTION_V3_SCHEMA } from '../src/sqlite-history/schema';
import { cellsToAnsi } from '../src/pipe-history-runtime';
// Runtime-shaped cells (pipe-history-runtime parserRowCells): canonical colours, style bits, wide + continuation.
const s2Cell=(grapheme:string,width=1,fg:string|number|null='default',bg:string|number|null='default',style=0):ProjectionCell=>({grapheme,width,continuation:false,fg,bg,style});
const s2Cont=(fg:string|number|null='default',bg:string|number|null='default',style=0):ProjectionCell=>({grapheme:'',width:0,continuation:true,fg,bg,style});
const s2Row=(parts:ProjectionCell[],cols=40):PhysicalRow=>{
 const cells=[...parts];while(cells.length<cols)cells.push(s2Cell(' '));
 return {text:cells.filter(c=>!c.continuation).map(c=>c.grapheme).join(''),cells};
};
const s2Text=(text:string,fg:string|number|null='default',bg:string|number|null='default',style=0)=>[...text].map(g=>s2Cell(g,1,fg,bg,style));
const s2Wide=(g:string,fg:string|number|null='default')=>[s2Cell(g,2,fg),s2Cont(fg)];
// hidden=128 (SGR 8), dim=2, blink=16, bold=1, italic=4, underline=8, inverse=64, strike=256.
const S2_CORPUS:PhysicalRow[]=[
 s2Row([...s2Text('pass: '),...s2Text('secret',  'default','default',128),...s2Text(' shown')]),
 s2Row([...s2Text('dim','index:7','default',2),...s2Text(' blink','index:1','default',16),...s2Text(' all','rgb:1,2,3','rgb:250,251,252',1|2|4|8|16|64|128|256)]),
 s2Row([...s2Text('256:'),...s2Text('x','rgb:95,135,175'),...s2Text('y','index:15','index:8'),...s2Text('z','rgb:0,0,0','rgb:255,255,255')]),
 s2Row([...s2Text('ไทย '),s2Cell('กิ่'),s2Cell('ง'),s2Cell(' '),s2Cell('น้ำ')]),
 s2Row([...s2Wide('漢'),...s2Wide('字','index:3'),...s2Wide('😀'),...s2Wide('👩‍💻'),...s2Wide('🇹🇭'),...s2Text(' é')]),
 s2Row([...s2Text('trailing styled blanks'),...s2Text('   ','default','index:4')]),
 s2Row([...s2Text('   lead  mid   |(2,1,0)| 7a ')]),
 s2Row([]),
 s2Row([...s2Text('x'.repeat(38)),...s2Wide('界')]),
 s2Row([...s2Text('P01 000123 '),...s2Text('color3','index:4'),...s2Text(' ไทย'),...s2Wide('漢'),...s2Wide('字'),...s2Wide('😀'),...s2Text(' xxx')],120),
 {text:'fixture shape',cells:[...'fixture shape'].map(naCell)},
 {text:'odd colour',cells:[...'odd colour'].map(g=>s2Cell(g,1,'index:07'))},
 {text:'text not cells',cells:[s2Cell('?')]},
];

test('S2: every corpus row round-trips through the codec; runtime-shaped rows are compact',()=>{
 for(const row of S2_CORPUS) {
  const stored=encodeRow(row.text,row.cells);
  expect(decodeRow(stored.text,stored.cells)).toEqual(row);
  expect(JSON.stringify(decodeRow(stored.text,stored.cells))).toBe(JSON.stringify(row));
 }
 const compact=S2_CORPUS.slice(0,10).map(r=>encodeRow(r.text,r.cells));
 expect(compact.every(r=>r.cells[0]!=='[')).toBe(true);
 // The blanks at the end of a row are not stored; their styles are.
 expect(compact[7]).toEqual({text:'',cells:'40||'});
 expect(compact[5]!.text.endsWith('blanks')).toBe(true);
 const legacyBytes=S2_CORPUS.slice(0,10).reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.cells)),0);
 const storedBytes=compact.reduce((n,r)=>n+Buffer.byteLength(r.text)+Buffer.byteLength(r.cells),0);
 console.log('S2_CODEC',JSON.stringify({rows:10,storedBytes,perCellJsonBytes:legacyBytes,oracleRow:compact[9]}));
});

test('S2: corpus is lossless in RAM, in sealed blocks, after a patch of a sealed line, after recover and through the archive reader',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-s2-corpus-'));let s=createProjectionStore({historyRoot:dir,mode:'create'});
 const rows=Array.from({length:600},(_,i)=>S2_CORPUS[i%S2_CORPUS.length]!);
 try {
  for(const [i,row] of rows.entries())await s.appendScroll({...naEvent('',i+1),physicalRow:structuredClone(row)});
  const read=(store:{readPage:typeof s.readPage;token:typeof s.token})=>{const t=store.token(naKey);return [...store.readPage(t,0,600).lines];};
  expect(read(s).map(l=>({text:l.text,cells:l.cells}))).toEqual(rows);
  // Certify every row like the runtime does (one capture per <=64 rows), then flush: whole settled blocks seal.
  for(let at=0;at<600;at+=64) {
   const slice=rows.slice(at,at+64);
   await s.calibrate({capture:{...naFrame(),captureId:`s2-${at}`,requestedAt:1,completedAt:2,firstHistoryRow:0,history:slice.map(r=>structuredClone(r)),observedFields:['grapheme','width','continuation','fg','bg','style','cursor-position','cursor-visible'],ambiguousRows:0,result:'exact'},
    expectedRevision:s.token(naKey).revision,checks:slice.map((_,k)=>({lineId:at+k,captureRow:k})),repairs:[]});
  }
  s.flush();
  const disk=new Database(s.file,{readonly:true});
  const blocks=disk.query('SELECT first_line_id,line_count FROM na_block ORDER BY first_line_id').all();
  const tail=disk.query('SELECT min(line_id) AS lo,count(*) AS n FROM na_line').get();
  const observed=disk.query('SELECT DISTINCT typeof(observed_fields) AS t,observed_fields AS v FROM na_capture').all();
  disk.close();
  expect(blocks).toEqual([{first_line_id:0,line_count:256},{first_line_id:256,line_count:256}]);
  expect(tail).toEqual({lo:512,n:88});
  expect(observed).toEqual([{t:'integer',v:255}]);
  const check=(lines:any[])=>{
   expect(lines.map(l=>({text:l.text,cells:l.cells}))).toEqual(rows);
   expect(lines.every(l=>l.checkState==='checked' && l.checkReason==='exact-capture' && l.checkedCaptureId===`s2-${Math.floor(l.lineId/64)*64}`)).toBe(true);
  };
  check(read(s));
  // A repair of a line inside a sealed block rewrites that block, never a second copy.
  const repaired=s2Row([...s2Text('repaired','index:2','default',128)]);
  const capture={...naFrame(),captureId:'s2-repair',requestedAt:3,completedAt:4,firstHistoryRow:0,history:[repaired],observedFields:['style'],ambiguousRows:0,result:'exact'};
  await s.calibrate({capture,expectedRevision:s.token(naKey).revision,checks:[],repairs:[{lineId:3,captureRow:0,physicalRow:repaired}]});
  s.flush();rows[3]=repaired;
  const disk2=new Database(s.file,{readonly:true});
  expect(disk2.query('SELECT count(*) AS n FROM na_line WHERE line_id=3').get()).toEqual({n:0});
  expect(disk2.query("SELECT typeof(observed_fields) AS t FROM na_capture WHERE capture_id='s2-repair'").get()).toEqual({t:'integer'});
  disk2.close();
  const after=read(s);
  expect(after.map(l=>({text:l.text,cells:l.cells}))).toEqual(rows);
  expect(after[3]).toMatchObject({checkState:'checked',checkedCaptureId:'s2-repair',checkedRow:0});
  await s.close();s=createProjectionStore({historyRoot:dir,mode:'recover'});
  const recovered=read(s);
  expect(recovered.map(l=>({text:l.text,cells:l.cells}))).toEqual(rows);
  expect(recovered[3]).toMatchObject({checkedCaptureId:'s2-repair'});
  await s.close();
  const archive=openProjectionArchive(join(dir,'newarch-v3/history.sqlite3'));
  try {
   expect(archive.schemaVersion).toBe(4);
   const lines=archive.readPage(archive.token(naKey),0,600).lines;
   expect(lines.map(l=>({text:l.text,cells:l.cells}))).toEqual(rows);
  }finally{archive.close();}
  console.log('S2_CORPUS_STORE',JSON.stringify({rows:600,blocks,tail,repairedSealedLine:3}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
},60000);

test('S2: a v3 file is read-only through the archive reader and the v4 writer refuses it without touching it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-s2-v3-')),file=join(dir,'newarch-v3/history.sqlite3');
 const id=JSON.stringify([naKey.serverIdentity,naKey.paneId,naKey.birthGeneration]);
 try {
  mkdirSync(join(dir,'newarch-v3'),{recursive:true});
  const db=new Database(file);
  db.exec('PRAGMA journal_mode=DELETE;');db.exec(PROJECTION_V3_SCHEMA);db.exec('PRAGMA user_version=3');
  db.query("INSERT INTO na_pane (pane_key,session_uuid,server_identity,pane_id,birth_generation,source_epoch,geometry_generation,cols,rows,screen_kind,next_line_id,revision,durable_revision) VALUES (?,?,?,?,?,?,?,?,?,'normal',?,?,?)")
   .run(id,'v3-session',naKey.serverIdentity,naKey.paneId,naKey.birthGeneration,1,1,40,2,S2_CORPUS.length,S2_CORPUS.length,S2_CORPUS.length);
  for(const [i,row] of S2_CORPUS.entries())db.query("INSERT INTO na_line VALUES (?,1,?,?,1,?,?,0,'unchecked','awaiting-capture',NULL,NULL)").run(id,i,i+1,row.text,encodeCells(row.cells));
  db.close();
  const sha=()=>createHash('sha256').update(readFileS2(file)).digest('hex'),before=sha();
  expect(()=>createProjectionStore({historyRoot:dir,mode:'recover'})).toThrow('not-projection-v4');
  expect(()=>createProjectionStore({historyRoot:dir,file,mode:'recover'})).toThrow('not-projection-v4');
  const archive=openProjectionArchive(file);
  try {
   expect(archive.schemaVersion).toBe(3);
   const lines=archive.readPage(archive.token(naKey),null,100).lines;
   expect(lines.map(l=>({text:l.text,cells:l.cells}))).toEqual(S2_CORPUS);
   expect(lines.every(l=>l.checkState==='unchecked' && l.checkReason==='awaiting-capture')).toBe(true);
  }finally{archive.close();}
  expect(sha()).toBe(before);
  expect(readdirS2(join(dir,'newarch-v3'))).toEqual(['history.sqlite3']);
  console.log('S2_V3_READONLY',JSON.stringify({rows:S2_CORPUS.length,writerRefused:'not-projection-v4',sha256Unchanged:before}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('S2: a v4 file carries version 4 in its header, so every v3-era reader refuses it; its lines have no v3 columns',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-s2-v4-header-'));const s=createProjectionStore({historyRoot:dir,mode:'create'});
 try {
  await s.appendScroll(naEvent('v4 row',1));s.flush();await s.close();
  const file=join(dir,'newarch-v3/history.sqlite3'),head=readFileS2(file).subarray(0,100);
  // The v3 writer (admitPath) and archive reader gate on this header field: 3 and {2,3}.
  expect(head.readUInt32BE(60)).toBe(4);expect(PROJECTION_SCHEMA_VERSION).toBe(4);
  const db=new Database(file,{readonly:true});
  try {
   expect(()=>db.query('SELECT cells_json FROM na_line').all()).toThrow(/no such column/);
   expect(()=>db.query('SELECT pane_key FROM na_line').all()).toThrow(/no such column/);
  }finally{db.close();}
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

// R = UTF-8 bytes of cellsToAnsi(row) for every row the store returns (the V
// canary's definition, VR:147). D = every file of the database directory.
const s2Oracle=(seq:number):PhysicalRow=>s2Row([...s2Text(`P01 ${String(seq).padStart(6,'0')} `),...s2Text(`color${seq%10}`,`index:${1+seq%7}`),
 ...s2Text(' ไทย'),...s2Wide('漢'),...s2Wide('字'),...s2Wide('😀'),...s2Text(' '+'x'.repeat(seq%13))],120);
async function s2DiskRatio(rows:number,dir:string) {
 const s=createProjectionStore({historyRoot:dir,mode:'create'});
 let R=0;
 try {
  for(let at=0;at<rows;at+=64) {
   const slice=Array.from({length:Math.min(64,rows-at)},(_,k)=>s2Oracle(at+k+1));
   for(const [k,row] of slice.entries())await s.appendScroll({...naEvent('',at+k+1),physicalRow:row});
   await s.calibrate({capture:{...naFrame(),captureId:`nonce-${at}/1`,requestedAt:at,completedAt:at+1,firstHistoryRow:0,history:slice,observedFields:['grapheme','width','continuation','fg','bg','style','cursor-position','cursor-visible'],ambiguousRows:0,result:'unfenced'},
    expectedRevision:s.token(naKey).revision,checks:slice.map((_,k)=>({lineId:at+k,captureRow:k})),repairs:[]});
  }
  s.flush();
  for(let at=0;at<rows;at+=2000)for(const l of s.readPage(s.token(naKey),at,Math.min(2000,rows-at)).lines)R+=Buffer.byteLength(cellsToAnsi(l.cells as any));
 }finally{await s.close();}
 const folder=join(dir,'newarch-v3'),D=readdirS2(folder).reduce((n,f)=>n+statS2(join(folder,f)).size,0);
 return {rows,D,R,ratio:D/R};
}
test('S2: D <= 1.5 x R for 6000 certified runtime-shaped rows of one pane',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-s2-ratio-'));
 try {
  const result=await s2DiskRatio(6000,dir);
  console.log('S2_DISK_RATIO',JSON.stringify(result));
  expect(result.ratio).toBeLessThanOrEqual(1.5);
 }finally{rmSync(dir,{recursive:true,force:true});}
},60000);
