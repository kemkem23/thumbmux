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
