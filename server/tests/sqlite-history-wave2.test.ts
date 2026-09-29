import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ids, observation, evidence } from './sqlite-history/helpers';
import { OptInHistoryBridge, legacyProjectionDigest } from '../src/sqlite-history/bridge';
import { inspectImportProgress } from '../src/sqlite-history/detectors';
import { HistoryStore } from '../src/sqlite-history/store';
import { sealHistorySnapshot, readImportProgress } from '../src/sqlite-history/transfer';
import { importClosedHistorySession, inspectImportedSnapshot, verifyImportedSnapshot } from '../src/sqlite-history/rehearsal';
import type { LegacyProjection, LegacyProjectionWriter } from '../src/sqlite-history/types';

function sealed(f:ReturnType<typeof fixture>,name:string,files:Record<string,string|Buffer>):string {
  const raw=join(f.dir,`${name}-raw`);mkdirSync(raw,{mode:0o700});
  for(const [path,data] of Object.entries(files))writeFileSync(join(raw,path),data);
  const destination=join(f.dir,`${name}-sealed`);sealHistorySnapshot(raw,destination);return destination;
}

function legacyWriter(received:LegacyProjection[]):LegacyProjectionWriter {
  return {write:async value=>{received.push(structuredClone(value));return {requestId:value.requestId,digest:legacyProjectionDigest(value)};}};
}

test('opt-in bridge spools one capture and requires matching receipts from legacy and SQLite',async()=>{
  const f=fixture();try{
    const sid=await f.store.register({name:'bridge',lifecycleKey:'bridge'}),received:LegacyProjection[]=[];
    const bridge=new OptInHistoryBridge(f.store,{spoolDirectory:join(f.dir,'spool'),legacyProjection:legacyWriter(received),
      sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)}});
    const receipt=await bridge.probe(sid);
    expect(receipt.legacyCommitted).toBe(true);expect(receipt.sqliteCommitted).toBe(true);
    expect(received).toHaveLength(1);expect(received[0].rows).toHaveLength(40);
    expect(received[0].geometry).toEqual(receipt.sqlite.geometry);expect(received[0].source).toEqual({});
    expect(f.store.rows(sid,0,40).map(row=>row.text)).toEqual(received[0].rows.map(row=>row.text));
    expect(bridge.ledger()).toEqual([{requestId:receipt.requestId,sessionId:sid,digest:receipt.digest,
      legacyCommitted:true,sqliteCommitted:true,sqliteRevision:1}]);
    console.log('BRIDGE_PROOF',JSON.stringify({captures:1,legacyRows:received[0].rows.length,sqliteRows:f.store.rows(sid,0,40).length,
      ledgerComplete:bridge.ledger().filter(item=>item.legacyCommitted&&item.sqliteCommitted).length}));
    await bridge.stopAndDrain();
  }finally{await f.cleanup();}
});

test('bridge rejects a lying legacy acknowledgement before SQLite commit',async()=>{
  const f=fixture();try{
    const sid=await f.store.register({name:'bridge-bad',lifecycleKey:'bridge-bad'});let lying=true;
    const bridge=new OptInHistoryBridge(f.store,{spoolDirectory:join(f.dir,'spool'),
      legacyProjection:{write:async value=>({requestId:value.requestId,digest:lying?'0'.repeat(64):legacyProjectionDigest(value)})},sessions:()=>[sid],
      driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)}});
    await expect(bridge.probe(sid)).rejects.toThrow('legacy-projection-mismatch');
    expect(f.store.session(sid).revision).toBe(0);
    expect(bridge.ledger()[0]).toMatchObject({legacyCommitted:false,sqliteCommitted:false});
    lying=false;await bridge.resumePending();
  }finally{await f.cleanup();}
});

test('durable bridge spool resumes after SQLite failure without writing legacy twice',async()=>{
  const f=fixture();try{
    const sid=await f.store.register({name:'resume',lifecycleKey:'resume'}),received:LegacyProjection[]=[];
    const original=f.store.commit.bind(f.store);let fail=true;
    f.store.commit=async batch=>{if(fail){fail=false;throw new Error('synthetic sqlite outage');}return original(batch);};
    const options={spoolDirectory:join(f.dir,'spool'),legacyProjection:legacyWriter(received),sessions:()=>[sid],
      driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)}};
    const first=new OptInHistoryBridge(f.store,options);
    await expect(first.probe(sid)).rejects.toThrow('synthetic sqlite outage');expect(received).toHaveLength(1);
    expect(first.ledger()[0]).toMatchObject({legacyCommitted:true,sqliteCommitted:false});
    f.store.commit=original;
    const restarted=new OptInHistoryBridge(f.store,options);await restarted.resumePending();
    expect(received).toHaveLength(1);expect(f.store.session(sid).revision).toBe(1);
    expect(restarted.ledger()[0]).toMatchObject({legacyCommitted:true,sqliteCommitted:true,sqliteRevision:1});
  }finally{await f.cleanup();}
});

test('closed-session importer resumes persisted checkpoint after restart and rerun is idempotent',async()=>{
  const f=fixture();let current=f.store;try{
    const lines=ids(1100),raw=lines.map((text,line)=>JSON.stringify({line,text})+'\n').join('');
    const directory=sealed(f,'closed',{'history.jsonl':raw,'meta.json':JSON.stringify({liveStart:1100,nextLine:1102,live:['pane','']})});
    const progress:Array<{cursor:number;state:string}>=[];const input={sourceId:'closed-source',snapshotDirectory:directory,format:'file-jsonl' as const,
      name:'closed',lifecycleKey:'closed-lifecycle',onProgress:(value:any)=>progress.push({cursor:value.recordCursor,state:value.state})};
    const original=current.commit.bind(current);let calls=0;
    current.commit=async(...args)=>{if(++calls===2)throw new Error('synthetic restart');return original(...args);};
    expect((await importClosedHistorySession(current,input)).state).toBe('quarantined');
    expect(readImportProgress(current,'closed-source').recordCursor).toBe(500);
    const sid=(current.db.query('SELECT session_id FROM history_import WHERE source_id=?').get('closed-source') as any).session_id;
    await current.close();current=new HistoryStore(new Database(f.file,{strict:true}),{file:f.file,onFault:fault=>f.alarms.push(fault)});
    const completed=await importClosedHistorySession(current,input);
    expect(completed.sessionId).toBe(sid);expect(completed.state).toBe('verified');expect(completed.verification?.ready).toBe(true);
    expect(current.session(sid).active).toBe(0);expect(current.rows(sid,0,1100).map(row=>row.text)).toEqual(lines);
    const revision=current.session(sid).revision;
    await current.close();current=new HistoryStore(new Database(f.file,{strict:true}),{file:f.file,onFault:fault=>f.alarms.push(fault)});
    const repeated=await importClosedHistorySession(current,input);
    expect(repeated.sessionId).toBe(sid);expect(current.session(sid).revision).toBe(revision);expect(current.rows(sid,0,1100)).toHaveLength(1100);
    await expect(importClosedHistorySession(current,{...input,name:'wrong-name'})).rejects.toThrow('closed-import-identity-conflict');
    expect(progress.some(value=>value.cursor===500&&value.state==='copying')).toBe(true);
    expect(progress.some(value=>value.cursor===1100&&value.state==='verified')).toBe(true);
    console.log('IMPORT_PROOF',JSON.stringify({restartCheckpoint:500,finalRecords:repeated.records,rows:current.rows(sid,0,1100).length,
      manifestFiles:repeated.verification?.manifest.files,manifestBytes:repeated.verification?.manifest.bytes,
      unresolved:repeated.verification?.unresolved.length,revisionStable:current.session(sid).revision===revision}));
  }finally{
    if(current!==f.store)await current.close();
    rmSync(f.dir,{recursive:true,force:true});
  }
},10000);

test('sealed manifest and full row/frame/screen oracle make every injected mismatch loud',async()=>{
  const f=fixture();try{
    const rows=['','OK','OK','ไทย漢字\x1b[31m'];
    const directory=sealed(f,'oracle',{'history.jsonl':rows.map((text,line)=>JSON.stringify({line,text})+'\n').join(''),
      'meta.json':JSON.stringify({liveStart:4,nextLine:6,live:['screen','']})});
    const imported=await importClosedHistorySession(f.store,{sourceId:'oracle',snapshotDirectory:directory,format:'file-jsonl',name:'oracle',lifecycleKey:'oracle'});
    expect(imported.verification?.unresolved).toEqual([]);
    const sid=imported.sessionId,options={sourceId:'oracle',sessionId:sid,snapshotDirectory:directory,format:'file-jsonl' as const};
    f.db.exec('DROP TRIGGER line_immutable');f.db.query('UPDATE history_line SET text=? WHERE session_id=? AND line_no=2').run('mutant',sid);
    expect(inspectImportedSnapshot(f.store,options).unresolved.map(item=>item.kind)).toContain('row-diff');
    expect(()=>verifyImportedSnapshot(f.store,options)).toThrow('migration-unresolved:row-diff');
    evidence(f.alarms.find(fault=>fault.detector==='migration-rehearsal'));

    f.db.exec('DROP TRIGGER capture_immutable');f.db.query('UPDATE history_capture SET unresolved_capture=? WHERE session_id=?').run(Buffer.from('mutant'),sid);
    expect(inspectImportedSnapshot(f.store,options).unresolved.map(item=>item.kind)).toContain('unresolved-capture');
    f.db.query("UPDATE history_import SET state='copying' WHERE source_id=?").run('oracle');
    expect(inspectImportedSnapshot(f.store,options).unresolved.map(item=>item.kind)).toContain('import-state');

    const rogue=join(directory,'unlisted.bin');writeFileSync(rogue,'not in manifest');
    expect(()=>inspectImportedSnapshot(f.store,options)).toThrow('orphan-snapshot-file');rmSync(rogue);
    const sourceFile=join(directory,'meta.json');chmodSync(sourceFile,0o600);writeFileSync(sourceFile,'{}');
    expect(()=>inspectImportedSnapshot(f.store,options)).toThrow('snapshot-digest');
  }finally{await f.cleanup();}
});

test('frame oracle compares every physical frame, including cursor/reset shape',async()=>{
  const f=fixture();try{
    const frame={v:1 as const,session:'frames',at:1,frame:{channel:'frames',type:'output' as const,data:'a\nไทย',cursor:null,reset:'resync' as const}};
    const directory=sealed(f,'frames',{'journal.ndjson':JSON.stringify(frame)+'\n'});
    const result=await importClosedHistorySession(f.store,{sourceId:'frames',snapshotDirectory:directory,format:'frame-ndjson',name:'frames',lifecycleKey:'frames'});
    expect(result.verification?.frames).toMatchObject({expected:1,observed:1});
    f.db.exec('DROP TRIGGER frame_immutable');
    const changed=structuredClone(frame);delete (changed.frame as any).cursor;
    f.db.query('UPDATE history_frame SET record_json=? WHERE session_id=?').run(JSON.stringify(changed),result.sessionId);
    const report=inspectImportedSnapshot(f.store,{sourceId:'frames',sessionId:result.sessionId,snapshotDirectory:directory,format:'frame-ndjson'});
    expect(report.unresolved.map(item=>item.kind)).toContain('frame-diff');
  }finally{await f.cleanup();}
});

test('persisted importer checkpoint detector cries after 30 seconds and stays quiet on progress/terminal states',()=>{
  const progress={sourceId:'s',sessionId:'sid',state:'copying' as const,snapshotBytes:100,byteCursor:50,totalRecords:10,recordCursor:5,checkpointAt:1000};
  const fault=inspectImportProgress(progress,32001);expect(fault?.detector).toBe('import-progress-stale');evidence(fault!);
  expect(inspectImportProgress({...progress,checkpointAt:30000},32001)).toBeNull();
  expect(inspectImportProgress({...progress,state:'verified'},100000)).toBeNull();
});

test('default package barrel still has no sqlite import and the opt-in entry has no side effect before factory call',async()=>{
  expect(readFileSync(join(import.meta.dir,'../src/index.ts'),'utf8')).not.toContain('sqlite-history');
  const module=await import('../src/sqlite-history');expect(typeof module.createSqliteHistoryStore).toBe('function');
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createProjectionStore } from '../src/sqlite-history/projection-store';
import { encodeCells } from '../src/sqlite-history/ram-store';
import { isProjectionRefusal, type ScrollEvent } from '../src/sqlite-history/types';
// FIX1 §3 caller contract: a refused row still belongs to the caller, which
// waits for drained() and offers the same row again. Nothing is dropped.
async function storeRow(s:ReturnType<typeof createProjectionStore>,event:ScrollEvent,onPressure?:()=>void) {
 for(;;){const r=await s.appendScroll(event);if(!isProjectionRefusal(r))return r;onPressure?.();await s.drained(event.paneKey);}
}

test('newarch: real SIGKILL before disk commit, after commit, before RAM watermark, 20 trials each',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-crash-'));
 const key={serverIdentity:'crash-fixture',paneId:'%1',birthGeneration:1};
 const module=join(import.meta.dir,'../src/sqlite-history/projection-store.ts');
 const summary=[];
 try{
  for(const phase of ['before-disk-commit','after-disk-commit','before-watermark']) {
   let lost=0;
   for(let trial=0;trial<20;trial++) {
    const dir=join(root,`${phase}-${trial}`);mkdirSync(dir);
    const script=`import {createProjectionStore} from ${JSON.stringify(module)};
      let armed=false;
      const s=createProjectionStore({historyRoot:${JSON.stringify(dir)},mode:'create',checkpoint:(phase)=>{if(armed&&phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});
      const key=${JSON.stringify(key)};
      const event=(text,seq)=>({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:seq,softWrap:false,physicalRow:{text,cells:[]}});
      await s.appendScroll(event('durable-before',1));s.flush();
      await s.appendScroll(event('in-flight',2));armed=true;s.flush();throw Error('kill-not-reached');`;
    const child=Bun.spawnSync([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
    expect(child.signalCode).toBe('SIGKILL');
    const s=createProjectionStore({historyRoot:dir,mode:'recover'});
    try{
     const expected=phase==='before-disk-commit'?['durable-before']:['durable-before','in-flight'];
     const token=s.token(key);expect(token.revision).toBe(expected.length);expect(token.durableRevision).toBe(expected.length);
     const actual=s.readPage(token,null,10).lines.map(r=>r.text);lost+=expected.filter(r=>!actual.includes(r)).length;
     expect(actual).toEqual(expected);
     await s.appendScroll({paneKey:key,sourceEpoch:2,geometryGeneration:1,receiveSeq:0,softWrap:false,physicalRow:{text:'restarted',cells:[]}});
     s.flush();expect(s.token(key).nextLineId).toBe(expected.length+1);
    }finally{await s.close();}
   }
   summary.push({phase,trials:20,signal:'SIGKILL',durableRowsLost:lost});
  }
  console.log('NA_CRASH_PROOF',JSON.stringify(summary));
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);

test('newarch: actual SQLITE_FULL preserves pending rows and reports host fault before retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'na-full-')),faults:any[]=[];
 const s=createProjectionStore({historyRoot:dir,mode:'create',onFault:f=>faults.push(f)});
 const key={serverIdentity:'full-fixture',paneId:'%1',birthGeneration:1};
 try{
  const disk=(s as any).disk as Database;
  const pages=(disk.query('PRAGMA page_count').get() as any).page_count;
  disk.exec(`PRAGMA max_page_count=${pages}`);
  const event={paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'x'.repeat(300000),cells:[]}};
  await s.appendScroll(event);
  expect(()=>s.flush()).toThrow(/full/i);
  expect(faults.some(f=>/full/i.test(f.reason))).toBe(true);
  expect(s.health().status).toBe('stopped');expect(s.health().storage.status).toBe('storage-paused');expect(s.token(key).durableRevision).toBe(0);
  expect(s.readPage(s.token(key),null,1).lines[0].text).toBe(event.physicalRow.text);
  expect(s.health().pendingBytes).toBeGreaterThan(0);
  disk.exec('PRAGMA max_page_count=1073741823');
  const started=Date.now();while(s.health().storage.status!=='healthy'&&Date.now()-started<4000)await Bun.sleep(25);
  expect(s.health().storage.status).toBe('healthy');
  expect(s.token(key).durableRevision).toBe(s.token(key).revision);expect(s.health().pendingBytes).toBe(0);
  console.log('NA_DISK_FULL',JSON.stringify({sqliteFull:true,hostFaults:faults.length,rowsLost:1-s.readPage(s.token(key),null,1).lines.length,pendingAfterRetry:s.health().pendingBytes}));
 }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});


test('newarch: random external SIGKILL x40 crosses eviction, independent durable oracle',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-random-crash-'));
 const key={serverIdentity:'random-crash',paneId:'%1',birthGeneration:1};
 const module=join(import.meta.dir,'../src/sqlite-history/projection-store.ts');
 const oracle=join(root,'oracle.json');let lost=0,duplicates=0,wrong=0,maxRows=0;
 try {
  const initial=createProjectionStore({historyRoot:root,mode:'create'});
  for(let n=0;n<5100;n++)await initial.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n+1,softWrap:false,physicalRow:{text:String(n),cells:[]}});
  initial.flush();writeFileSync(oracle,JSON.stringify({next:initial.token(key).nextLineId}));await initial.close();
  for(let trial=0;trial<40;trial++) {
   const script=`import {createProjectionStore} from ${JSON.stringify(module)};
    import {openSync,writeSync,fsyncSync,closeSync,renameSync} from 'node:fs';
    const s=createProjectionStore({historyRoot:${JSON.stringify(root)},mode:'recover'}),key=${JSON.stringify(key)};
    console.log('ready');
    for(let n=s.token(key).nextLineId;;n++) {
      await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n+1,softWrap:false,physicalRow:{text:String(n),cells:[]}});
      if(n%31===0){if(${trial}%2===0)s.flush();const fd=openSync(${JSON.stringify(oracle+'.next')},'w');writeSync(fd,JSON.stringify({next:s.token(key).durableRevision}));fsyncSync(fd);closeSync(fd);renameSync(${JSON.stringify(oracle+'.next')},${JSON.stringify(oracle)});}
      if(n%8===0)await Bun.sleep(1);
    }`;
   const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
   const ready=child.stdout.getReader();const started=await ready.read();expect(new TextDecoder().decode(started.value)).toContain('ready');ready.releaseLock();
   await Bun.sleep(75+Math.floor(Math.random()*200));child.kill('SIGKILL');await child.exited;
   expect(child.signalCode).toBe('SIGKILL');
   const expected=JSON.parse(readFileSync(oracle,'utf8')).next;
   const s=createProjectionStore({historyRoot:root,mode:'recover'});
   try {
    const token=s.token(key);lost+=Math.max(0,expected-token.nextLineId);maxRows=Math.max(maxRows,token.nextLineId);
    expect(token.revision).toBe(token.durableRevision);
    let anchor:number|null=null,seen=0;const texts=new Set<string>();
    do {const page=s.readPage(token,anchor,2000);for(const row of page.lines){if(texts.has(row.text))duplicates++;texts.add(row.text);if(row.text!==String(seen))wrong++;seen++;}anchor=page.hasMore?page.nextAnchor:null;}while(anchor!==null);
    lost+=Math.max(0,token.nextLineId-seen);
   }finally{await s.close();}
  }
  console.log('NA_RANDOM_CRASH',JSON.stringify({trials:40,seedRows:5100,maxRows,lost,duplicates,wrong}));
  expect(maxRows).toBeGreaterThan(5100);expect(lost+duplicates+wrong).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);

test('I2 FIX1 A-B4: scroll pressure pauses one pane without loss, its live screen keeps updating, health recovers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-pressure-')),faults:any[]=[];
 const key={serverIdentity:'pressure',paneId:'%1',birthGeneration:1};
 const s=createProjectionStore({historyRoot:root,mode:'create',onFault:f=>faults.push(f)});
 const event=(text:string,receiveSeq:number)=>({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq,softWrap:false,physicalRow:{text,cells:[]}});
 try {
  // Queue pressure is deterministic; no producer waits for a prior receipt.
  const rows=Array.from({length:20},(_,i)=>event(`${i}:`.padEnd(1024*1024,'x'),i));
  const outcomes=await Promise.all(rows.map(r=>s.appendScroll(r)));
  const first=outcomes.findIndex(isProjectionRefusal);
  expect(first).toBeGreaterThan(0);
  // Once refused, the pane is paused: no later row overtakes the refused one.
  expect(outcomes.slice(first).every(isProjectionRefusal)).toBe(true);
  expect(outcomes[first]).toEqual({accepted:false,reason:'capacity-pressure',scope:'pane'});
  // Pressure is not loss and not a fault.
  expect((s as any).ram.pane(key).health).toBe('healthy');
  expect(s.health()).toMatchObject({rejectedRows:0,pressure:'recoverable'});
  const shown=await s.replaceScreen({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:20,cols:1,rows:1,kind:'normal',cells:[[{grapheme:'Z',width:1,continuation:false,fg:null,bg:null,style:0}]],cursor:null});
  expect(isProjectionRefusal(shown)).toBe(false);
  expect(JSON.parse(String(s.screen(key)!.cells_json))[0][0].grapheme).toBe('Z');
  let waits=0;
  for(const r of rows.slice(first))await storeRow(s,r,()=>waits++);
  await storeRow(s,event('recovered',21));s.flush();
  expect(s.health()).toMatchObject({status:'healthy',pressure:'none',rejectedRows:0});
  expect(s.readPage(s.token(key),null,30).lines.map(l=>l.text.split(':')[0])).toEqual([...Array.from({length:20},(_,i)=>String(i)),'recovered']);
  const disk=new Database(s.file,{readonly:true});
  try {expect(disk.query("SELECT count(*) AS n FROM na_issue WHERE kind='ingest-oversize'").get()).toEqual({n:0});}finally{disk.close();}
  console.log('NA_PRESSURE',JSON.stringify({firstRefused:first,reofferedAfterWait:waits,faults:faults.length,screen:'Z',health:s.health().status}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch: close releases timer and handles even when final flush throws',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-close-full-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'}),disk=(s as any).disk as Database;
 try {
  const pages=(disk.query('PRAGMA page_count').get() as any).page_count;disk.exec(`PRAGMA max_page_count=${pages}`);
  await s.appendScroll({paneKey:{serverIdentity:'close',paneId:'%1',birthGeneration:1},sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'x'.repeat(300000),cells:[]}});
  expect(await s.close()).toMatchObject({drained:false,unknownTail:true,storage:{status:'closed-incomplete'}});await s.close();
  expect(()=>s.health()).toThrow('store-closed');expect(()=>disk.query('SELECT 1').get()).toThrow();
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
});


test('newarch: faults are throttled and health recovers while newer screen revisions keep arriving',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-health-progress-')),faults:any[]=[];
 const key={serverIdentity:'health-progress',paneId:'%1',birthGeneration:1};
 const frame={paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,cols:1,rows:1,kind:'normal' as const,
   cells:[[{grapheme:' ',width:1,continuation:false,fg:null,bg:null,style:0}]],cursor:null};
 let active=false,frameUpdates=0;
 const s=createProjectionStore({historyRoot:root,mode:'create',onFault:f=>faults.push(f),checkpoint:phase=>{
   if(active&&phase==='after-disk-commit'){frameUpdates++;void s.replaceScreen(frame);}
 }});
 try {
  await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'kept',cells:[]}});
  for(let i=0;i<200;i++)(s as any).fault('flush-overdue','injected stalled flush');
  expect(faults).toHaveLength(1);expect(s.health().status).toBe('degraded');
  active=true;const until=Date.now()+1000;
  while(s.health().status!=='healthy'&&Date.now()<until)await Bun.sleep(5);
  expect(frameUpdates).toBeGreaterThan(0);expect(s.health().status).toBe('healthy');
  active=false;s.flush();
  const db=new Database(s.file,{readonly:true});
  try {
   expect(db.query('SELECT health FROM na_pane').get()).toEqual({health:'healthy'});
   const issues=(db.query("SELECT count(*) AS n FROM na_issue WHERE kind='flush-overdue'").get() as any).n;
   expect(issues).toBe(1);
   console.log('NA_HEALTH_PROGRESS',JSON.stringify({injectedFaults:200,notifications:faults.length,issues,frameUpdates,health:s.health().status}));
  }finally{db.close();}
 }finally{active=false;await s.close();rmSync(root,{recursive:true,force:true});}
});


test('newarch FIX2: one pane at 10x cannot consume twenty other admission shares',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-fair-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'}),internal=s as any;
 const keys=Array.from({length:21},(_,i)=>({serverIdentity:'fair',paneId:`%${i}`,birthGeneration:1}));
 const event=(i:number,n:number,text='x'.repeat(4096))=>({paneKey:keys[i],sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text,cells:[]}});
 try {
  await Promise.all(keys.map((_,i)=>s.appendScroll(event(i,0,'init'))));s.flush();
  let hotRefused=0,normalRefused=0,maxPending=0,faultCalls=0,poisonReads=0;
  const fault=internal.fault.bind(s);internal.fault=(...args:any[])=>{faultCalls++;return fault(...args);};
  const jobs:Promise<unknown>[]=[];
  // A blocked producer turn: ten hot rows before every row on each normal pane.
  for(let n=1;n<=100;n++) {
   for(let j=0;j<10;j++)jobs.push(s.appendScroll(event(0,n*10+j)).then(r=>{if(isProjectionRefusal(r))hotRefused++;}));
   for(let i=1;i<21;i++)jobs.push(s.appendScroll(event(i,n)).then(r=>{if(isProjectionRefusal(r))normalRefused++;},()=>{normalRefused++;}));
   maxPending=Math.max(maxPending,internal.pendingBytes());
  }
  const before=faultCalls;
  for(let n=0;n<2000;n++) {
   const rejected=event(0,2000+n,'x'.repeat(1024*1024));
   Object.defineProperty(rejected.physicalRow,'cells',{get(){poisonReads++;throw Error('copied-rejected-cells');}});
   // 1 MiB fits an idle store, so it is pressure on the hot pane, decided before any cell is read.
   jobs.push(s.appendScroll(rejected).then(r=>{if(!isProjectionRefusal(r))throw Error('over-share-admitted');hotRefused++;}));
  }
  expect(faultCalls-before).toBe(0);expect(poisonReads).toBe(0);
  await Promise.all(jobs);s.flush();
  const disk=new Database(s.file,{readonly:true});
  try {
   // Backpressure is not loss: no capacity issue rows at all.
   expect(disk.query("SELECT count(*) AS n FROM na_issue WHERE kind='ingest-oversize'").get()).toEqual({n:0});
   for(let i=1;i<21;i++)expect(s.token(keys[i]).nextLineId).toBe(101);
  }finally{disk.close();}
  expect(normalRefused).toBe(0);expect(hotRefused).toBeGreaterThan(0);
  expect(maxPending).toBeLessThanOrEqual(16*1024*1024);expect(s.health().pendingBytes).toBe(0);
  console.log('NA_FIX2_FAIR',JSON.stringify({normalRefused,hotRefused,maxPending,poisonReads,faultCalls}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch FIX2: screen fast path, queued frames, fault metadata and recovery share the hard cap',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-all-inputs-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'}),internal=s as any;
 const key={serverIdentity:'all-inputs',paneId:'%1',birthGeneration:1};
 const cell={grapheme:'x',width:1 as const,continuation:false,fg:null,bg:null,style:0};
 const frame={paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,cols:1,rows:1,kind:'normal' as const,cells:[[cell]],cursor:null};
 try {
  await s.replaceScreen(frame);
  const first=s.health().pendingBytes;
  await s.replaceScreen(frame);expect(s.health().pendingBytes).toBe(first);
  s.flush();expect(s.health().pendingBytes).toBe(0);
  const before=s.token(key).revision;
  await expect(s.replaceScreen({...frame,cells:[[{...cell,grapheme:'z'.repeat(16*1024*1024)}]]})).rejects.toThrow('ingest-oversize');
  expect(JSON.parse(String(s.screen(key)!.cells_json))[0][0].grapheme).toBe('x');
  expect(s.token(key).revision).toBeGreaterThan(before); // explicit fault, not the rejected screen
  s.flush();
  // Queue a generation transition behind an accepted scroll, then an oversized frame.
  const row=s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:2,softWrap:false,physicalRow:{text:'kept',cells:[]}});
  const transition=s.replaceScreen({...frame,sourceEpoch:2});
  const oversized=s.replaceScreen({...frame,sourceEpoch:2,cells:[[{...cell,grapheme:'z'.repeat(16*1024*1024)}]]});
  await expect(oversized).rejects.toThrow('ingest-oversize');await Promise.all([row,transition]);
  let maxPending=s.health().pendingBytes;
  // Fault kinds deliberately differ, so throttling cannot hide budget growth.
  const originalError=console.error;console.error=()=>{};
  try {for(let i=0;i<17000;i++) {
   internal.fault(`fixture-${i}`,'metadata cap',key);
   maxPending=Math.max(maxPending,internal.pendingBytes());
  }}finally{console.error=originalError;}
  expect(maxPending).toBeLessThanOrEqual(16*1024*1024);
  s.flush();expect(s.health().pendingBytes).toBe(0);
  console.log('NA_FIX2_ALL_INPUTS',JSON.stringify({maxPending,cap:16*1024*1024,firstScreenBytes:first}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch FIX2: close leaves no fixture fds and immediate reopen never needs a retry',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-close-fds-'));
 const key={serverIdentity:'close-fds',paneId:'%1',birthGeneration:1};
 let maxAfterClose=0,maxCloseMs=0;
 try {
  for(let round=0;round<30;round++) {
   const s=createProjectionStore({historyRoot:root,mode:round===0?'create':'recover'});
   try {
    for(let n=0;n<2000;n++)await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:round*2000+n,softWrap:false,physicalRow:{text:String(n),cells:[]}});
   }finally{const started=performance.now();await s.close();maxCloseMs=Math.max(maxCloseMs,performance.now()-started);}
   const fds=readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd).startsWith(root+'/');}catch{return false;}});
   maxAfterClose=Math.max(maxAfterClose,fds.length);expect(fds).toHaveLength(0);
  }
  // The normal path must never ride the 5 s stuck-worker fallback.
  expect(maxCloseMs).toBeLessThan(1000);
  console.log('NA_FIX2_CLOSE',JSON.stringify({rounds:30,rowsPerRound:2000,maxAfterClose,maxCloseMs:Math.round(maxCloseMs)}));
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);

test('newarch DEBT: a disk worker that never exits is terminated without throwing at close',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-close-stuck-'));
 const key={serverIdentity:'close-stuck',paneId:'%1',birthGeneration:1};
 const s=createProjectionStore({historyRoot:root,mode:'create'});
 try {
  for(let n=0;n<200;n++)await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:String(n),cells:[]}});
  s.flush();
  // Swallow the close request: from the store's side the worker is alive and never exits.
  const worker=(s as any).worker;expect(worker).toBeTruthy();worker.postMessage=()=>{};
  const started=performance.now();await s.close();const closeMs=performance.now()-started;
  expect((s as any).worker).toBeNull();expect(closeMs).toBeLessThan(10000);
  const fds=readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd).startsWith(root+'/');}catch{return false;}});
  // Normal close proves fd=0 above. A terminated worker cannot finalize its own
  // SQLite handle; only that bounded set may remain, and it must not block reopen.
  expect(fds.length).toBeLessThanOrEqual(4);
  const again=createProjectionStore({historyRoot:root,mode:'recover'});
  try {expect(again.token(key).nextLineId).toBe(200);}finally{await again.close();}
  console.log('NA_DEBT_STUCK_CLOSE',JSON.stringify({closeMs:Math.round(closeMs),fdsAfterClose:fds.length}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch FIX2: open loop hot pane 1000 per second plus twenty panes at 100',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-hot-loop-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'});
 const keys=Array.from({length:21},(_,i)=>({serverIdentity:'hot-loop',paneId:`%${i}`,birthGeneration:1}));
 const produced=keys.map(()=>0),refused=keys.map(()=>0),accepted=keys.map(()=>0),jobs=new Set<Promise<unknown>>();
 let maxPending=0;
 try {
  const start=performance.now();
  const feed=(elapsed:number)=>{
   for(let i=0;i<21;i++) {
    const due=Math.floor(elapsed*(i===0?1000:100)/1000);
    while(produced[i]<due) {
     const seq=produced[i]++,text=`${i}:${seq}`.padEnd(80,' ');
     const job=s.appendScroll({paneKey:keys[i],sourceEpoch:1,geometryGeneration:1,receiveSeq:seq,softWrap:false,
      physicalRow:{text,cells:[...text].map(grapheme=>({grapheme,width:1 as const,continuation:false,fg:null,bg:null,style:0}))}})
      .then(r=>{if(isProjectionRefusal(r))refused[i]++;else accepted[i]++;},()=>{refused[i]++;});
     jobs.add(job);void job.then(()=>jobs.delete(job));
    }
   }
  };
  while(performance.now()-start<10000){feed(performance.now()-start);maxPending=Math.max(maxPending,s.health().pendingBytes);await Bun.sleep(2);}
  feed(10000);await Promise.all(jobs);s.flush();
  let wrong=0,missing=0;
  for(let i=1;i<21;i++) {
   const token=s.token(keys[i]);const page=s.readPage(token,null,2000);
   missing+=Math.max(0,1000-page.lines.length);
   wrong+=page.lines.filter((line,n)=>line.text!==`${i}:${n}`.padEnd(80,' ')).length;
  }
  const normalRefused=refused.slice(1).reduce((a,b)=>a+b,0);
  console.log('NA_FIX2_HOT_LOOP',JSON.stringify({durationMs:10000,hotRate:1000,normalRate:100,normalPanes:20,normalRefused,hotRefused:refused[0],accepted,maxPending,wrong,missing}));
  expect(normalRefused).toBe(0);expect(wrong+missing).toBe(0);expect(maxPending).toBeLessThanOrEqual(16*1024*1024);
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

// DEBT2 (review3 04a/04b/04c/01c): admission must follow panes with work now, not every pane ever seen.
async function knownPanesStore(root:string,prefix:string,known:number) {
 const key=(i:number)=>({serverIdentity:prefix,paneId:`%${i}`,birthGeneration:1});
 const cell=(g:string)=>({grapheme:g,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 let s=createProjectionStore({historyRoot:root,mode:'create'});
 for(let i=0;i<known;i++){const t=`old ${i}`.padEnd(80,' ');await s.appendScroll({paneKey:key(i),sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:t,cells:[...t].map(cell)}});}
 await s.close();
 s=createProjectionStore({historyRoot:root,mode:'recover'});
 expect(s.health().panes).toHaveLength(known);
 return {s,key,cell};
}
const textFrame=(cell:(g:string,fg?:number|null)=>any,cols:number,rows:number,shift:number,coloured:boolean)=>
 Array.from({length:rows},(_,y)=>Array.from({length:cols},(_,x)=>({...cell(String.fromCharCode(33+((y*7+x+shift)%90))),fg:coloured?(x>>3)%8:null})));

test('newarch DEBT2 D9: an idle store with 21..2000 known panes takes a 3000-row burst from one pane',async()=>{
 const out:any[]=[];
 for(const known of [21,100,500,2000]) {
  const root=mkdtempSync(join(tmpdir(),'na-debt2-burst-'));
  const {s,key,cell}=await knownPanesStore(root,'burst',known);
  try {
   expect(s.health()).toMatchObject({status:'healthy',pendingBytes:0});
   let ok=0,refused=0;const jobs:Promise<unknown>[]=[];
   // `cat` of a big file: the pipe reader hands over 3000 rows in one tick.
   for(let n=0;n<3000;n++){const t=`line ${n} of a big file`.padEnd(80,' ');
    jobs.push(s.appendScroll({paneKey:key(0),sourceEpoch:1,geometryGeneration:1,receiveSeq:n+2,softWrap:false,physicalRow:{text:t,cells:[...t].map(g=>cell(g))}}).then(r=>{if(isProjectionRefusal(r))refused++;else ok++;},()=>{refused++;}));}
   const pendingAtBurst=s.health().pendingBytes;
   let frame='accepted';
   try {const r=await s.replaceScreen({paneKey:key(1),sourceEpoch:1,geometryGeneration:1,receiveSeq:9,cols:120,rows:40,kind:'normal',cells:textFrame(cell,120,40,0,false),cursor:{row:0,col:0,visible:true}});if(isProjectionRefusal(r))frame='pressure';}
   catch(error){frame=String(error);}
   await Promise.all(jobs);s.flush();
   expect(s.token(key(0)).nextLineId).toBe(3001);
   out.push({known,ok,refused,pendingAtBurst,frame,rejectedRows:s.health().rejectedRows,status:s.health().status});
   expect(refused).toBe(0);expect(frame).toBe('accepted');expect(s.health().rejectedRows).toBe(0);
   expect((s as any).pendingByPane.size).toBe(0);
  }finally{await s.close();rmSync(root,{recursive:true,force:true});}
 }
 console.log('NA_DEBT2_BURST',JSON.stringify(out));
},120000);

test('newarch DEBT2 D10: full-text frames up to 208x60 are never refused on an idle store with 2000 known panes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-debt2-frames-'));
 const {s,key,cell}=await knownPanesStore(root,'frames',2000);
 const out:any[]=[];
 try {
  for(const [cols,rows] of [[80,24],[120,40],[200,60],[208,60]])for(const coloured of [false,true]) {
   const tries:string[]=[];
   for(let a=0;a<5;a++) {
    const cells=textFrame(cell,cols,rows,a,coloured);
    try {const r=await s.replaceScreen({paneKey:key(1),sourceEpoch:1,geometryGeneration:1,receiveSeq:2+a,cols,rows,kind:'normal',cells,cursor:{row:0,col:0,visible:true}});tries.push(isProjectionRefusal(r)?'pressure':'accepted');}
    catch(error){tries.push(String(error));}
    if(a%2)s.flush();else await Bun.sleep(20);
   }
   const shown=JSON.parse(String(s.screen(key(1))!.cells_json));
   out.push({cols,rows,coloured,tries,lastCell:shown[rows-1][cols-1].grapheme});
   expect(tries).toEqual(Array(5).fill('accepted'));
   expect(shown[rows-1][cols-1]).toMatchObject(textFrame(cell,cols,rows,4,coloured)[rows-1][cols-1]);
  }
  // A pane already over its history share (queue empty) still publishes its screen.
  const big='x'.repeat(1024*1024);let refusedRows=0;
  const rows=Array.from({length:12},(_,n)=>s.appendScroll({paneKey:key(2),sourceEpoch:1,geometryGeneration:1,receiveSeq:10+n,softWrap:false,physicalRow:{text:big,cells:[]}}).then(r=>{if(isProjectionRefusal(r))refusedRows++;}));
  // Refusal is decided synchronously; read status before any flush can recover the pane.
  // FIX1 §3: one pane over its share is backpressure on that pane, not a degraded store.
  const statusAtRefusal=s.health();
  const shown=s.replaceScreen({paneKey:key(2),sourceEpoch:1,geometryGeneration:1,receiveSeq:30,cols:208,rows:60,kind:'normal',cells:textFrame(cell,208,60,0,true),cursor:null});
  await Promise.all(rows);expect(isProjectionRefusal(await shown)).toBe(false);
  expect(refusedRows).toBeGreaterThan(0);expect(statusAtRefusal).toMatchObject({status:'healthy',pressure:'recoverable'});
  s.flush();expect(s.health().pendingBytes).toBe(0);
  console.log('NA_DEBT2_FRAMES',JSON.stringify({known:2000,results:out,hotPanePressuredRows:refusedRows,statusAtRefusal:statusAtRefusal.status}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},120000);

test('newarch DEBT2: queued frames of one pane coalesce to the latest and release replaced bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-debt2-coalesce-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'}),internal=s as any;
 clearInterval(internal.timer); // explicit flushes only, so pending bytes are exact
 const key={serverIdentity:'coalesce',paneId:'%1',birthGeneration:1};
 const cell=(g:string)=>({grapheme:g,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 const row=(seq:number,epoch:number)=>s.appendScroll({paneKey:key,sourceEpoch:epoch,geometryGeneration:1,receiveSeq:seq,softWrap:false,physicalRow:{text:'r'+seq,cells:[]}});
 const frame=(seq:number,shift:number)=>({paneKey:key,sourceEpoch:2,geometryGeneration:1,receiveSeq:seq,cols:208,rows:60,kind:'normal' as const,cells:textFrame(cell,208,60,shift,false),cursor:null});
 const frameJobBytes=Buffer.byteLength(JSON.stringify(frame(0,0)))+512;
 try {
  // A source-epoch transition queues behind the row; every later frame lands on the queued tail.
  const first=[row(1,1),...Array.from({length:50},(_,a)=>s.replaceScreen(frame(2+a,a)))];
  expect([...internal.queues.values()].map((q:any[])=>q.length)).toEqual([2]);
  expect(internal.pendingBytes()).toBeLessThan(2*frameJobBytes);
  await Promise.all(first);
  expect(JSON.parse(String(s.screen(key)!.cells_json))[59][207].grapheme).toBe(textFrame(cell,208,60,49,false)[59][207].grapheme);
  s.flush();expect(s.health().pendingBytes).toBe(0);
  // Frames that cannot coalesce (a row sits between them) are pumped one by one;
  // each replaces the previous unflushed frame instead of adding to it.
  const small=(seq:number,shift:number)=>({...frame(seq,shift),sourceEpoch:3,cols:80,rows:24,cells:textFrame(cell,80,24,shift,false)});
  const smallBytes=Buffer.byteLength(JSON.stringify(small(0,0)))+512;
  const mixed:Promise<unknown>[]=[row(99,2),s.replaceScreen(small(100,0))];
  for(let a=1;a<=10;a++)mixed.push(row(100+2*a,3),s.replaceScreen(small(101+2*a,a)));
  expect([...internal.queues.values()][0].length).toBe(12);
  await Promise.all(mixed);
  const pending=internal.pendingBytes();
  expect(pending).toBeLessThan(2*smallBytes);
  s.flush();expect(s.health().pendingBytes).toBe(0);expect(internal.pendingByPane.size).toBe(0);
  console.log('NA_DEBT2_COALESCE',JSON.stringify({framesOffered:50,queuedJobs:2,frameJobBytes,smallFrameJobBytes:smallBytes,pendingAfterElevenPumpedFrames:pending,naiveSum:11*smallBytes}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch D11: a malformed frame is refused alone; the queued frame stays live until restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-d11-coalesce-'));
 let s=createProjectionStore({historyRoot:root,mode:'create'});const internal=s as any;
 clearInterval(internal.timer); // explicit flushes only, so the queue shape and pending bytes are exact
 const key={serverIdentity:'d11',paneId:'%1',birthGeneration:1};
 const cell=(g:string)=>({grapheme:g,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 const good={paneKey:key,sourceEpoch:2,geometryGeneration:1,receiveSeq:2,cols:80,rows:24,kind:'normal' as const,cells:textFrame(cell,80,24,7,false),cursor:null};
 const bad=[
  {...good,receiveSeq:3,cells:good.cells.slice(0,23)},                      // rows != cells.length
  {...good,receiveSeq:4,cursor:{row:24,col:0,visible:true}},                 // cursor outside the frame
 ];
 const out:any={};
 try {
  // The source-epoch transition queues the good frame behind a row, so later frames take the coalesce path.
  const r=s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'r1',cells:[]}});
  const kept=s.replaceScreen(good);
  const q=[...internal.queues.values()][0];expect(q.length).toBe(2);
  const pendingBefore=internal.pendingBytes(),tailBytes=q[1].bytes;
  out.refusals=[];
  for(const f of bad){try{await s.replaceScreen(f);out.refusals.push('accepted');}catch(error){out.refusals.push(String(error));}}
  // Refused synchronously, before the queued tail or any reservation moved.
  expect(out.refusals).toEqual(['Error: invalid-frame','Error: invalid-cursor']);
  expect(q[1].bytes).toBe(tailBytes);expect(internal.pendingBytes()).toBe(pendingBefore);
  await r;out.goodReceipt=await kept.then(()=>'resolved',e=>String(e));
  expect(out.goodReceipt).toBe('resolved');
  const shown=JSON.parse(String(s.screen(key)!.cells_json));
  out.liveRows=shown.length;out.liveLastCell=shown[23][79].grapheme;
  expect(shown).toHaveLength(24);expect(shown[23][79].grapheme).toBe(good.cells[23][79].grapheme);
  s.flush();expect(s.health().pendingBytes).toBe(0);expect(internal.pendingByPane.size).toBe(0);
  await s.close();
  s=createProjectionStore({historyRoot:root,mode:'recover'});
  out.screenAfterRestart=s.screen(key);expect(out.screenAfterRestart).toBeNull();
  expect(s.readPage(s.token(key),null,2).lines.map(line=>line.text)).toEqual(['r1']);
  console.log('NA_D11_COALESCE_VALIDATE',JSON.stringify(out));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('I2 FIX1 A-B4: hot pane 20000 rows/s beside 21 panes: backpressure on the hot pane only, no loss issue, store never stopped',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-debt2-hot-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'});
 const keys=Array.from({length:21},(_,i)=>({serverIdentity:'hot20k',paneId:`%${i}`,birthGeneration:1}));
 const hot={serverIdentity:'hot20k',paneId:'%hot',birthGeneration:1};
 const cell=(g:string)=>({grapheme:g,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 const jobs=new Set<Promise<unknown>>(),statusSeen=new Set<string>();
 let produced=0,hotProduced=0,hotOk=0,hotRefused=0,hotLost=0,normalRefused=0,frameRefused=0,lastFrame=-1e9,fseq=0;
 const track=(p:Promise<unknown>)=>{jobs.add(p);void p.finally(()=>jobs.delete(p));};
 const originalError=console.error;console.error=()=>{};
 try {
  const start=performance.now();
  while(performance.now()-start<10000) {
   const now=performance.now()-start;
   for(const due=Math.floor(now/10);produced<due;produced++)for(let i=0;i<21;i++){const t=`${i}:${produced}`.padEnd(80,' ');
    track(s.appendScroll({paneKey:keys[i],sourceEpoch:1,geometryGeneration:1,receiveSeq:produced+1,softWrap:false,physicalRow:{text:t,cells:[...t].map(cell)}}).then(r=>{if(isProjectionRefusal(r))normalRefused++;},()=>{normalRefused++;}));}
   for(const due=Math.floor(now*20);hotProduced<due;hotProduced++){const t=`h:${hotProduced}`.padEnd(80,' ');
    track(s.appendScroll({paneKey:hot,sourceEpoch:1,geometryGeneration:1,receiveSeq:hotProduced+1,softWrap:false,physicalRow:{text:t,cells:[...t].map(cell)}}).then(r=>{if(isProjectionRefusal(r))hotRefused++;else hotOk++;},()=>{hotLost++;}));}
   if(now-lastFrame>=100){lastFrame=now;fseq++;for(const k of [...keys,hot])
    track(s.replaceScreen({paneKey:k,sourceEpoch:1,geometryGeneration:1,receiveSeq:fseq,cols:80,rows:24,kind:'normal',cells:textFrame(cell,80,24,fseq,false),cursor:null}).then(r=>{if(isProjectionRefusal(r))frameRefused++;},()=>{frameRefused++;}));}
   statusSeen.add(s.health().status);
   await Bun.sleep(10);
  }
  await Promise.all(jobs);s.flush();
  let missing=0,wrong=0;
  for(let i=0;i<21;i++){const page=s.readPage(s.token(keys[i]),null,2000);missing+=produced-page.lines.length;
   wrong+=page.lines.filter((l,n)=>l.text!==`${i}:${n}`.padEnd(80,' ')).length;}
  const disk=new Database(s.file,{readonly:true});
  let issues:any;
  try {issues=disk.query("SELECT count(*) AS n,coalesce(sum(missing_count),0) AS missing FROM na_issue WHERE kind='ingest-oversize'").get();}finally{disk.close();}
  console.error=originalError;
  console.log('NA_DEBT2_HOT20K',JSON.stringify({durationMs:10000,hotRate:20000,normalPanes:21,normalRate:100,produced,hotProduced,hotOk,hotPressure:hotRefused,hotLost,normalRefused,frameRefused,missing,wrong,statusSeen:[...statusSeen],issues}));
  expect(normalRefused).toBe(0);expect(frameRefused).toBe(0);expect(missing+wrong).toBe(0);
  expect(hotRefused).toBeGreaterThan(0);expect(hotLost).toBe(0);expect(statusSeen.has('stopped')).toBe(false);
  // Backpressure on the hot pane is not loss: no capacity issue is written at all.
  expect(issues).toEqual({n:0,missing:0});
  // Every hot row the store accepted is readable (the fixture producer ignores pause, so no order oracle here).
  expect(s.token(hot).nextLineId).toBe(hotOk);
 }finally{console.error=originalError;await s.close();rmSync(root,{recursive:true,force:true});}
},60000);

// I2 §7: probe the disk writer independently of parser/capture and the host package.
test('I2 probe: bundled projection worker drains and reopens its own durable database',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-bundle-'));
 try {
  const build=await Bun.build({entrypoints:[join(import.meta.dir,'../src/sqlite-history/projection-store.ts')],outdir:join(root,'bundle'),target:'bun'});
  expect(build.success).toBe(true);
  const script=`import {createProjectionStore} from ${JSON.stringify(join(root,'bundle/projection-store.js'))};
   const key={serverIdentity:'bundle',paneId:'%1',birthGeneration:1};
   let s=createProjectionStore({historyRoot:${JSON.stringify(join(root,'data'))},mode:'create'});
   const cpu=process.cpuUsage(),start=performance.now();
   for(let n=0;n<2000;n++)await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:'ไทย '+n,cells:[]}});
   await new Promise(r=>setTimeout(r,100));
   const durableBeforeClose=s.token(key).durableRevision;await s.close();
   s=createProjectionStore({historyRoot:${JSON.stringify(join(root,'data'))},mode:'recover'});
   const count=s.token(key).nextLineId;await s.close();
   console.log('I2_BUNDLE_PROBE',JSON.stringify({count,durableBeforeClose,elapsedMs:performance.now()-start,cpu:process.cpuUsage(cpu)}));
   if(count!==2000 || durableBeforeClose===0)process.exitCode=1;`;
  const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  console.log(out);if(err)console.error(err);expect(exit).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test('I4 FIX1 S: 126000 rows in 60s batch across 21 panes without capture payload growth',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i4-s-126k-')),s=createProjectionStore({historyRoot:root,mode:'create'});
 const keys=Array.from({length:21},(_,pane)=>({serverIdentity:'i4-s-load',paneId:`%${pane}`,birthGeneration:1}));
 const cell=(grapheme:string)=>({grapheme,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 const physical=()=>readdirSync(join(root,'newarch-v5')).filter(name=>name.startsWith('history.sqlite3')).reduce((sum,name)=>sum+statSync(join(root,'newarch-v5',name)).size,0);
 let logicalBytes=0,peakIncrement=0,refused=0;
 const flushAges:number[]=[];
 try {
  const disk0=physical(),cpu0=process.cpuUsage(),started=performance.now();
  for(let tick=0;tick<6000;tick++) {
   const target=started+(tick+1)*10,delay=target-performance.now();if(delay>0)await Bun.sleep(delay);
   const jobs=keys.map((key,pane)=>{
    const text=`${pane}:${tick} ไทย`.padEnd(80,String((pane+tick)%10)),cells=[...text].map(cell);
    logicalBytes+=Buffer.byteLength(text)+Buffer.byteLength(encodeCells(cells));
    return s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:tick+1,softWrap:false,physicalRow:{text,cells}}).then(result=>{if(isProjectionRefusal(result))refused++;});
   });
   await Promise.all(jobs);
   if(tick%100===0){peakIncrement=Math.max(peakIncrement,physical()-disk0);flushAges.push(s.health().lastFlushAgeMs);}
  }
  s.flush();peakIncrement=Math.max(peakIncrement,physical()-disk0);flushAges.push(s.health().lastFlushAgeMs);
  const elapsedMs=performance.now()-started,cpu=process.cpuUsage(cpu0),cpuCores=(cpu.user+cpu.system)/1000/elapsedMs;
  const disk=new Database(s.file,{readonly:true});
  // v4 keeps only the latest na_commit row; commit_seq counts every commit.
  const commits=Number((disk.query('SELECT max(commit_seq) AS n FROM na_commit').get() as any).n);
  // Settled lines are sealed into na_block; count both stores of durable lines.
  const rows=Number((disk.query('SELECT (SELECT count(*) FROM na_line)+(SELECT coalesce(sum(line_count),0) FROM na_block) AS n').get() as any).n);
  const captures=Number((disk.query('SELECT count(*) AS n FROM na_capture').get() as any).n);
  const durableScreen=disk.query("SELECT name FROM sqlite_master WHERE name='na_screen'").get();disk.close();
  const health=s.health(),diskIncrement=physical()-disk0,ratio=diskIncrement/logicalBytes;
  const sortedFlushAges=flushAges.toSorted((a,b)=>a-b);
  const flushAgeP95Ms=sortedFlushAges[Math.ceil(sortedFlushAges.length*.95)-1]??0;
  const maxFlushAgeMs=sortedFlushAges.at(-1)??0;
  console.log('I4_S_126K',JSON.stringify({rows,elapsedMs,cpuCores,commits,rowsPerTransaction:rows/commits,ramBatches:health.ramBatches,
   averageRamOperationsPerBatch:health.averageRamOperationsPerBatch,refused,flushAgeP95Ms,maxFlushAgeMs,diskIncrement,peakIncrement,logicalBytes,ratio,captures,durableScreen}));
  expect(rows).toBe(126000);expect(refused).toBe(0);expect(elapsedMs).toBeLessThan(65000);
  expect(commits).toBeLessThanOrEqual(6000);expect(rows/commits).toBeGreaterThanOrEqual(21);
  // The >=21 target is durable rows/transaction above. RAM turns may split at
  // the 4 ms fairness boundary and are reported only as a scheduling metric.
  // Wave 6 records every acknowledgement and owns the <=150 ms flush gate.
  // This fixture samples once per second, which aliases periodic checkpoints.
  expect(ratio).toBeLessThanOrEqual(1.5);expect(peakIncrement/logicalBytes).toBeLessThanOrEqual(1.5);
  expect(captures).toBe(0);expect(durableScreen).toBeNull();
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},90000);

test('I2 probe: measure A borrowing before B through E arrive without disk acknowledgements',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-borrow-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'});clearInterval((s as any).timer);
 const admitted:number[]=[],refused:number[]=[];
 try {
  for(let pane=0;pane<5;pane++) {
   admitted[pane]=0;refused[pane]=0;
   for(let n=0;n<(pane===0?7:2);n++) {
    const r=await s.appendScroll({paneKey:{serverIdentity:'borrow',paneId:`%${pane}`,birthGeneration:1},sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:'x'.repeat(1024*1024),cells:[]}});
    if(isProjectionRefusal(r))refused[pane]++;else admitted[pane]++;
   }
  }
  console.log('I2_BORROW_PROBE',JSON.stringify({admitted,refused,health:s.health()}));
  expect(s.health().pendingBytes).toBeLessThanOrEqual(16*1024*1024);
  // A borrowed ~7 MiB; B..E still get their 1 MiB rows through the pool that A may not exhaust.
  expect(admitted[0]).toBeGreaterThan(2);expect(admitted.slice(1).every(n=>n>=1)).toBe(true);
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('I2: acknowledgement clears pressure only after durable cache eviction (real rows, no stubbed counter)',async()=>{
 // F1: fewer than 5000 real rows fill 2 MiB. Acknowledgement must reclaim
 // durable cache rows before reopening admission; merely clearing stopped is insufficient.
 const root=mkdtempSync(join(tmpdir(),'na-i2-cache-')),s=createProjectionStore({historyRoot:root,mode:'create',cacheBytes:2*1024*1024});
 clearInterval((s as any).timer);
 const key={serverIdentity:'cache',paneId:'%1',birthGeneration:1};
 try {
  let n=0,refusal:any=null;
  while(!refusal && n<5000){const r:any=await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:`keep ${n}`.padEnd(300,'.'),cells:[]}});if(!isProjectionRefusal(r))n++;else if(r.scope==='pane')s.flush();else refusal=r;}
  expect(refusal).toMatchObject({scope:'store'});expect(n).toBeLessThan(5000);
  s.flush();
  expect(s.health()).toMatchObject({status:'healthy',pressure:'recoverable',pendingBytes:0,rejectedRows:0});
  expect(s.health().ramBytes+1024).toBeLessThanOrEqual(2*1024*1024);
  const resident=(s as any).ram.db.query('SELECT count(*) AS n FROM na_line').get().n;
  expect(resident).toBeLessThan(n);
  const state=await Promise.race([s.drained(key).then(()=>'drained'),Bun.sleep(300).then(()=>'waiting')]);
  expect(state).toBe('drained');
  expect(s.health().panes[0].status).toBe('healthy');   // pressure is not a pane fault
  expect(s.token(key).nextLineId).toBe(n);expect(s.token(key).durableRevision).toBe(s.token(key).revision);
  for(let first=0;first<n;first+=100) {
   const lines=s.readPage(s.token(key),first,Math.min(100,n-first)).lines;
   expect(lines.length).toBe(Math.min(100,n-first));
   for(let i=0;i<lines.length;i++)expect(lines[i].text).toBe(`keep ${first+i}`.padEnd(300,'.'));
  }
  expect(await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:`keep ${n}`.padEnd(300,'.'),cells:[]}})).not.toHaveProperty('accepted',false);
  expect(s.token(key).nextLineId).toBe(n+1);expect(s.health().pressure).toBe('none');
  console.log('I2_CACHE_PRESSURE',JSON.stringify({rows:n,resident,ramBytes:s.health().ramBytes,state}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('I2: 208x60 interleaved frames retain all scrolls under one bounded latest-frame reservation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-interleave-')),s=createProjectionStore({historyRoot:root,mode:'create'});
 const key={serverIdentity:'interleave',paneId:'%1',birthGeneration:1};
 const cell=(grapheme:string)=>({grapheme,width:1,continuation:false,fg:null,bg:null,style:0});
 try {
  const jobs:Promise<unknown>[]=[];
  for(let n=0;n<40;n++) {
   jobs.push(s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:String(n),cells:[]}}));
   jobs.push(s.replaceScreen({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,cols:208,rows:60,kind:'normal',cells:textFrame(cell,208,60,n,true),cursor:null}));
  }
  expect(s.health().pendingBytes).toBeLessThan(1024*1024);
  await Promise.all(jobs);s.flush();
  expect(s.readPage(s.token(key),null,100).lines.map(r=>r.text)).toEqual(Array.from({length:40},(_,n)=>String(n)));
  expect(JSON.parse(String(s.screen(key)!.cells_json))[59][207]).toEqual(textFrame(cell,208,60,39,true)[59][207]);
  expect(s.health().pendingBytes).toBe(0);
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

const I2_FIX1_MUTATIONS=[
  {name:'A-B2 quiescent-check',file:'ram-store.ts',before:"|| evidence.receiveSeqBefore!==evidence.receiveSeqAfter)throw new Error('capture-not-quiescent');",after:")throw new Error('capture-not-quiescent');"},
  {name:'C-F13 freelist',file:'ram-store.ts',before:'return (pages.page_count-free.freelist_count)*this.pageSize;',after:'return pages.page_count*this.pageSize;'},
  {name:'A-B4 guarantee',file:'projection-store.ts',before:"return mineBorrow<=Math.floor(pool/Math.max(2,borrowers)) && borrowed+mineBorrow<=pool?'ok':'pane';",after:"return 'ok';"},
  {name:'A-B1 fast-path',file:'projection-store.ts',before:'if(fence>=0) {',after:'if(queued.length) {'},
  {name:'C-F12 cas-at-admission',file:'projection-store.ts',before:'const receipt=this.ram.recordIssue(value,undefined,true);',after:'const receipt=this.ram.recordIssue(value);'},
  {name:'C-F11 async-epoch',file:'projection-store.ts',before:'.then(receipt=>{this.kickFlush();return receipt;}',after:'.then(receipt=>{this.flush();return receipt;}'},
];
// FIX2: each mutant removes one repair of this round; its oracle must go red.
const I2_FIX2_MUTATIONS=[
  {name:'FIX2-M2 history-only admission',file:'projection-store.ts',before:"if(historyOnly?change.expectedRevision>revision:this.queues.get(pane)?.length || revision!==change.expectedRevision)throw new Error('stale-revision');",after:"if(this.queues.get(pane)?.length || revision!==change.expectedRevision)throw new Error('stale-revision');"},
  {name:'FIX2-M2 history-only run-time',file:'ram-store.ts',before:'if (historyOnly ? change.expectedRevision > Number(p.revision) : p.revision !== change.expectedRevision) throw',after:'if (p.revision !== change.expectedRevision) throw'},
  {name:'FIX2-M1 count-once',file:'projection-store.ts',before:'if(identity===null || this.lastOversize.get(id)!==identity) {',after:'if(true) {'},
  {name:'FIX2-M1 own-name',file:'projection-store.ts',before:'throw new Error(PROJECTION_OVERSIZE);',after:"throw new Error('ingest-capacity');"},
  {name:'FIX2-B1 null-evidence',file:'ram-store.ts',before:"if(evidence?.kind==='quiescent') {",after:'if(evidence!==undefined) {'},
  {name:'FIX2-B1 uncertain-rows',file:'ram-store.ts',before:'this.screen(c,c.captureId,c.completedAt,c.observedFields,undefined,uncertain);',after:'this.screen(c,c.captureId,c.completedAt,c.observedFields);'},
];
const I4_FIX1_S_MUTATIONS=[
  {name:'I4-S capture-payload-columns',file:'schema.ts',before:'screen_hash BLOB NOT NULL, history_hash BLOB NOT NULL,',after:'screen_cells_json BLOB NOT NULL, history_cells_json BLOB NOT NULL,'},
  {name:'I4-S metadata-screen-hash',file:'ram-store.ts',before:"screenHash.digest(),historyHash.digest()",after:"Buffer.alloc(32),historyHash.digest()"},
  {name:'I4-S persist-screen-table',file:'projection-store.ts',before:"['na_capture','na_line','na_issue']",after:"['na_capture','na_line','na_screen','na_issue']"},
];
const I4_FIX2_S_MUTATIONS=[
 {name:'I4-S2 page-size',file:'ram-store.ts',before:'PRAGMA page_size=8192;',after:'PRAGMA page_size=4096;'},
 {name:'I4-S2 reclaim',file:'projection-store.ts',before:'this.ram.evict(panes,keep)',after:'this.ram.evict(panes,5000)'},
 {name:'I4-S2 chunk-bound',file:'projection-store.ts',before:'const chunkSize=256,',after:'const chunkSize=512,'},
];
// NEWARCH-SWITCHON S2: each mutant undoes one part of the compact store.
const S2_MUTATIONS=[
 {name:'S2 per-cell-json',file:'codec.ts',before:"export function encodeRow(text: string, cells: readonly Cell[]): { text: string; cells: string } {\n",after:"export function encodeRow(text: string, cells: readonly Cell[]): { text: string; cells: string } {\n  return legacy(text, cells);\n"},
 {name:'S2 no-seal',file:'projection-store.ts',before:'function sealBlocks(disk:Database,panes:SqlRow[],force:boolean):void {',after:'function sealBlocks(disk:Database,panes:SqlRow[],force:boolean):void { return;'},
 {name:'S2 hidden-flag',file:'codec.ts',before:"`${count}:${colourToken(fg)}:${colourToken(bg)}:${style || ''}`",after:"`${count}:${colourToken(fg)}:${colourToken(bg)}:${(style & ~128) || ''}`"},
 {name:'S2 v5-as-v3',file:'schema.ts',before:'export const PROJECTION_SCHEMA_VERSION = 5;',after:'export const PROJECTION_SCHEMA_VERSION = 3;'},
];
const F1_S_MUTATIONS=[
 {name:'F1-S advance-watermark-on-full',file:'projection-store.ts',before:"if(isStorageFull(error)) {\n      this.storageEventId",after:"if(isStorageFull(error)) {\n      this.ram.db.exec('UPDATE na_pane SET durable_revision=revision');\n      this.storageEventId"},
 {name:'F1-S discard-retry-batch',file:'projection-store.ts',before:"this.storageRetryAt=Date.now()+STORAGE_RETRY_MS",after:"this.retry=null;this.storageRetryAt=Date.now()+STORAGE_RETRY_MS"},
 {name:'F1-S admit-during-pause',file:'projection-store.ts',before:"if(this.storageStatus!=='healthy')return Promise.resolve(this.pressure(event.paneKey,512,'store',true));",after:"if(false)return Promise.resolve(this.pressure(event.paneKey,512,'store',true));"},
];
async function runI2Mutations(cases:typeof I2_FIX1_MUTATIONS,label:string) {
 const root=mkdtempSync(join(tmpdir(),'na-i2-mutation-'));
 const results:any[]=[];
 try {
  for(const mutation of cases)for(const broken of [false,true]) {
   const outdir=join(root,mutation.name.replace(/\W+/g,'-')+'-'+broken);
   const result=await Bun.build({entrypoints:[join(import.meta.dir,'../src/sqlite-history/projection-store.ts')],outdir,target:'bun',plugins:[{
    name:'controlled-mutation',setup(build){build.onLoad({filter:/\/(ram-store|projection-store|schema|codec)\.ts$/},args=>{
     let contents=readFileSync(args.path,'utf8');
     if(broken && args.path.endsWith('/'+mutation.file)) {expect(contents).toContain(mutation.before);contents=contents.replace(mutation.before,mutation.after);}
     return {contents,loader:'ts'};
    });}
   }]});
   expect(result.success).toBe(true);
   const script=`import {createProjectionStore} from ${JSON.stringify(join(outdir,'projection-store.js'))};
    import {Database} from 'bun:sqlite';
    const name=${JSON.stringify(mutation.name)},data=${JSON.stringify(join(outdir,'data'))};
    const key={serverIdentity:'mutation',paneId:'%1',birthGeneration:1};
    const cell=g=>({grapheme:g,width:1,continuation:false,fg:null,bg:null,style:0});
    const row=(text,n,k=key)=>({paneKey:k,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text,cells:[...text].map(cell)}});
    const frame=(g)=>({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,cols:1,rows:1,kind:'normal',cells:[[cell(g)]],cursor:null});
    const assert=(value,message)=>{if(!value)throw Error('MUTATION_RED: '+message);};
    const s=createProjectionStore({historyRoot:data,mode:'create',cacheBytes:name.includes('reclaim')?1024*1024:name.includes('freelist')?6*1024*1024:undefined});
    try {
     if(name.startsWith('F1-S ')) {
      const states=[];s.options.onStorageState=state=>states.push(structuredClone(state));
      await s.appendScroll(row('durable',1));s.flush();const before=s.token(key);
      const limiter=s.disk;const pages=limiter.query('PRAGMA page_count').get().page_count;
      limiter.exec('PRAGMA max_page_count='+pages);
      const large='x'.repeat(512*1024);await s.appendScroll({...row('',2),physicalRow:{text:large,cells:[]}});
      let full=false;try{s.flush();}catch{full=true;}assert(full,'fixture must reach real SQLITE_FULL');
      const paused=s.health();
      assert(paused.storage.status==='storage-paused','store must publish storage-paused');
      assert(s.token(key).durableRevision===before.durableRevision,'failed commit must not advance durable watermark');
      const refused=await s.appendScroll(row('must wait',3));assert(refused.accepted===false,'storage-paused must refuse new history');
      limiter.exec('PRAGMA max_page_count=2147483646');
      const started=Date.now();while(s.health().storage.status!=='healthy'&&Date.now()-started<4000)await Bun.sleep(25);
      const recovery=states.find(state=>state.status==='recovering');
      assert(s.health().storage.status==='healthy','store must recover after space returns');
      assert(recovery?.retry.batchId===paused.storage.retry.batchId,'recovery must retry the same batch id');
      assert(s.readPage(s.token(key),0,10).lines.map(line=>line.text).join('|')==='durable|'+large,'retry must make the admitted batch durable exactly once');
     } else if(name.startsWith('S2 ')) {
      const blank=g=>({grapheme:g,width:1,continuation:false,fg:'default',bg:'default',style:0});
      const pad=cells=>{while(cells.length<120)cells.push(blank(' '));return {text:cells.filter(c=>!c.continuation).map(c=>c.grapheme).join(''),cells};};
      const text=(t,fg='default',style=0)=>[...t].map(g=>({...blank(g),fg,style}));
      const wide=g=>[{...blank(g),width:2},{grapheme:'',width:0,continuation:true,fg:'default',bg:'default',style:0}];
      const oracle=n=>pad([...text('P01 '+String(n).padStart(6,'0')+' '),...text('color'+n%10,'index:'+(1+n%7)),...text(' ไทย'),...wide('漢'),...wide('字'),...wide('😀'),...text(' '+'x'.repeat(n%13))]);
      if(name.includes('hidden')) {
       const hidden=pad([...text('pass: '),...text('secret','default',128)]);
       await s.appendScroll({...row('',1),physicalRow:hidden});s.flush();
       const line=s.readPage(s.token(key),0,1).lines[0];
       assert(JSON.stringify({text:line.text,cells:line.cells})===JSON.stringify(hidden),'hidden (SGR 8) must round-trip');
      } else if(name.includes('v5-as-v3')) {
       await s.appendScroll(row('v5',1));s.flush();await s.close();
       const {readFileSync}=await import('node:fs');
       const version=readFileSync(s.file).readUInt32BE(60);
       assert(version!==2 && version!==3,'a v3-era reader (accepts 2 or 3) must refuse a v5 file; header says '+version);
      } else {
       const {cellsToAnsi}=await import(${JSON.stringify(join(import.meta.dir,'../src/pipe-history-runtime.ts'))});
       const {readdirSync,statSync}=await import('node:fs');
       const observedFields=['grapheme','width','continuation','fg','bg','style','cursor-position','cursor-visible'];
       for(let at=0;at<6000;at+=64) {
        const slice=Array.from({length:64},(_,k)=>oracle(at+k+1));
        for(const [k,physical] of slice.entries())await s.appendScroll({...row('',at+k+1),physicalRow:physical});
        await s.calibrate({capture:{...frame('A'),captureId:'nonce-'+at+'/1',requestedAt:at,completedAt:at+1,firstHistoryRow:0,history:slice,observedFields,ambiguousRows:0,result:'unfenced'},
         expectedRevision:s.token(key).revision,checks:slice.map((_,k)=>({lineId:at+k,captureRow:k})),repairs:[]});
       }
       s.flush();let R=0;
       for(let at=0;at<6000;at+=2000)for(const l of s.readPage(s.token(key),at,2000).lines)R+=Buffer.byteLength(cellsToAnsi(l.cells));
       const folder=data+'/newarch-v5',D=readdirSync(folder).reduce((n,f)=>n+statSync(folder+'/'+f).size,0);
       console.log('S2_MUTATION_RATIO',JSON.stringify({name,D,R,ratio:D/R}));
       assert(D<=1.5*R,'disk must stay within 1.5 x the rows it holds: D/R='+(D/R).toFixed(3));
      }
     } else if(name.startsWith('I4-S2')) {
      const physical={text:'P01 000123 color3 ไทย漢字😀 '+'x'.repeat(80),cells:Array.from({length:120},(_,i)=>({...cell(i<34?String.fromCharCode(65+i%26):'x'),fg:i<34?i%7:null}))};
      let pressure=0;
      const n=name.includes('page-size')?5000:name.includes('reclaim')?1600:800;
      for(let i=0;i<n;i++) {
       const event={...row('',i+1),physicalRow:physical};let r=await s.appendScroll(event);
       if(r.accepted===false){pressure++;const done=await Promise.race([s.drained(key).then(()=>true),Bun.sleep(250).then(()=>false)]);assert(done,'durable cache must reopen without new dirty data');r=await s.appendScroll(event);}
       assert(r.accepted!==false,'refused row must become admissible');if(i%40===39)s.flush();
      }
      s.flush();
      if(name.includes('page-size'))assert(s.health().ramBytes/n<2000,'realistic row footprint must avoid overflow page');
      else if(name.includes('reclaim'))assert(pressure>0,'fixture must reach real RAM pressure');
      else {
       const capture={...frame('A'),captureId:'chunks',requestedAt:1,completedAt:2,firstHistoryRow:0,history:Array.from({length:n},()=>physical),observedFields:[],ambiguousRows:0,result:'fixture'};
       await s.calibrate({capture,expectedRevision:s.token(key).revision,checks:Array.from({length:n},(_,i)=>({lineId:i,captureRow:i})),repairs:[]});
       const counts=s.ram.db.query('SELECT compared_rows FROM na_capture').all();
       assert(counts.every(r=>r.compared_rows<=256),'every calibration commit must map at most 256 rows');
       assert(s.readPage(s.token(key),0,n).lines.every(r=>r.checkState==='checked'),'all requested rows must be checked');
      }
     } else if(name.includes('capture-payload-columns')) {
      const disk=new Database(s.file,{readonly:true});
      const payload=disk.query("SELECT name FROM pragma_table_info('na_capture') WHERE name IN ('screen_cells_json','history_cells_json','cells_json','payload_json')").all();disk.close();
      assert(payload.length===0,'capture receipt schema must have no payload-capable columns');
     } else if(name.includes('metadata-screen-hash')) {
      const capture=(id,g)=>({...frame(g),captureId:id,requestedAt:1,completedAt:2,firstHistoryRow:0,history:[],observedFields:['grapheme'],ambiguousRows:0,result:'fixture'});
      const quiet={kind:'quiescent',sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:1,receiveSeqAfter:1};
      await s.replaceScreen(frame('A'));await s.calibrate({capture:capture('one','A'),expectedRevision:s.token(key).revision,captureEvidence:quiet,checks:[],repairs:[]});
      await s.calibrate({capture:capture('two','Z'),expectedRevision:s.token(key).revision,captureEvidence:quiet,checks:[],repairs:[]});
      const hashes=s.ram.db.query('SELECT screen_hash FROM na_capture ORDER BY capture_id').all().map(row=>Buffer.from(row.screen_hash).toString('hex'));
      assert(hashes.length===2 && hashes[0]!==hashes[1],'metadata hash must change when capture cells change');
     } else if(name.includes('persist-screen-table')) {
      await s.replaceScreen(frame('A'));let ok=true;try{s.flush();}catch{ok=false;}
      const disk=new Database(s.file,{readonly:true});const durableScreen=disk.query("SELECT name FROM sqlite_master WHERE name='na_screen'").get();disk.close();
      assert(ok && durableScreen===null,'screen must remain RAM-only and flushable without a disk table');
     } else if(name.startsWith('FIX2-M2')) {
      await s.appendScroll(row('stable',1));const read=s.token(key);
      await s.appendScroll(row('moved',2));
      const queued=Array.from({length:20},(_,n)=>s.appendScroll(row('q'+n,3+n)));
      let ok=true;
      try {await s.calibrate({capture:{...frame('Z'),captureId:'history-only',requestedAt:1,completedAt:2,firstHistoryRow:0,history:[{text:'stable',cells:[...'stable'].map(cell)}],observedFields:[],ambiguousRows:0,result:'fixture'},expectedRevision:read.revision,captureEvidence:null,checks:[{lineId:0,captureRow:0}],repairs:[]});}catch{ok=false;}
      await Promise.all(queued);
      assert(ok && s.readPage(s.token(key),null,5).lines[0].checkState==='checked','history-only calibration must not be refused for queued rows or a moved revision');
     } else if(name.startsWith('FIX2-M1')) {
      const huge={...row('',2),physicalRow:{text:'x'.repeat(17*1024*1024),cells:[]}};
      const errors=[];for(let i=0;i<3;i++)errors.push(String(await s.appendScroll(huge).then(()=>'accepted',e=>e)));
      assert(errors.every(e=>e.includes('ingest-oversize')),'oversize must reject under its own name: '+errors[0]);
      assert(s.health().rejectedRows===1,'one oversized event re-offered 3 times is one loss, got '+s.health().rejectedRows);
     } else if(name.startsWith('FIX2-B1')) {
      await s.replaceScreen(frame('A'));
      const capture=id=>({...frame('Z'),captureId:id,requestedAt:1,completedAt:2,firstHistoryRow:0,history:[],observedFields:[],ambiguousRows:0,result:'fixture'});
      let ok=true;
      try {await s.calibrate({capture:capture('null'),expectedRevision:s.token(key).revision,captureEvidence:null,checks:[],repairs:[]});}catch{ok=false;}
      assert(ok && JSON.parse(s.screen(key).cells_json)[0][0].grapheme==='A','null evidence checks history only, without an error');
      await s.calibrate({capture:capture('emoji'),expectedRevision:s.token(key).revision,captureEvidence:{kind:'quiescent',sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:1,receiveSeqAfter:1,uncertainRows:[0]},checks:[],repairs:[]});
      assert(s.screen(key).uncertain_rows_json==='[0]' && JSON.parse(s.screen(key).cells_json)[0][0].grapheme==='Z','an uncertain row is drawn and kept uncertified');
     } else if(name.includes('quiescent')) {
      await s.replaceScreen(frame('A'));
      let rejected=false;
      try {await s.calibrate({capture:{...frame('Z'),captureId:'moving',requestedAt:1,completedAt:2,firstHistoryRow:0,history:[],observedFields:[],ambiguousRows:0,result:'fixture'},expectedRevision:s.token(key).revision,captureEvidence:{kind:'quiescent',sourceEpoch:1,geometryGeneration:1,receiveSeqBefore:1,receiveSeqAfter:2},checks:[],repairs:[]});}
      catch(e){rejected=String(e).includes('capture-not-quiescent');}
      assert(rejected && JSON.parse(s.screen(key).cells_json)[0][0].grapheme==='A','bytes during capture must not calibrate the screen');
     } else if(name.includes('freelist')) {
      clearInterval(s.timer);let n=0,refused=false;
      while(!refused && n<20000){const r=await s.appendScroll(row(('row '+n+' ').padEnd(1000,'x'),n+1));if(r.accepted!==false)n++;else if(r.scope==='pane')s.flush();else refused=true;}
      assert(refused,'fixture must reach RAM pressure');s.flush();
      const state=await Promise.race([s.drained(key).then(()=>'drained'),new Promise(r=>setTimeout(()=>r('stuck'),1500))]);
      assert(state==='drained','eviction must clear RAM pressure');
     } else if(name.includes('guarantee')) {
      clearInterval(s.timer);
      // A fills whatever it is allowed in 8 KiB rows (no disk acknowledgement), then B offers one 8 KiB row.
      const text=n=>('A'+n).padEnd(8192,'a');let n=0;
      while(n<4000 && (await s.appendScroll({...row('',n,{...key,paneId:'%A'}),physicalRow:{text:text(n),cells:[]}})).accepted!==false)n++;
      const b=await s.appendScroll({...row('',1,{...key,paneId:'%B'}),physicalRow:{text:text(0).replace('A','B'),cells:[]}});
      assert(b.accepted!==false,'a late pane gets its guaranteed quota while A borrows');
     } else if(name.includes('fast-path')) {
      for(let n=0;n<200;n++)void s.appendScroll(row('r'+n,n));
      void s.replaceScreen(frame('F'));
      assert(s.screen(key) && JSON.parse(s.screen(key).cells_json)[0][0].grapheme==='F','frame must not wait behind queued rows');
      await new Promise(r=>setTimeout(r,50));
     } else if(name.includes('cas')) {
      await s.appendScroll(row('seed',0));
      const rows=Array.from({length:20},(_,n)=>s.appendScroll(row('busy'+n,n+1)));
      const t=s.token(key);let ok=true;
      try {await s.recordIssue({paneKey:key,sourceEpoch:1,geometryGeneration:1,expectedRevision:t.revision,boundaryLineId:t.nextLineId,kind:'fault',reason:'fixture',missingCount:null,recoverable:true});}catch{ok=false;}
      await Promise.all(rows);assert(ok,'CAS is taken at admission, not after queued output');
     } else {
      await s.appendScroll(row('before',1));s.flush();
      const lock=new Database(s.file);lock.exec('BEGIN IMMEDIATE');
      let ok=true;const started=performance.now();
      try {await s.transitionEpoch({paneKey:key,sourceEpoch:1,nextEpoch:2,geometryGeneration:1,expectedRevision:s.token(key).revision,boundaryLineId:1,kind:'restart',reason:'fixture',missingCount:null,recoverable:true});}catch{ok=false;}
      const ms=performance.now()-started;lock.exec('COMMIT');lock.close();
      assert(ok && ms<50,'transition must return the RAM receipt without waiting for the disk ('+Math.round(ms)+' ms)');
     }
    } finally {try{await s.close();}catch{}}`;
   const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
   const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   const red=err.match(/error: (MUTATION_RED: [^\n]*)/)?.[1]??null;
   results.push({name:mutation.name,broken,exit,red});
   console.log('I2_MUTATION',JSON.stringify({name:mutation.name,broken,exit,red,stderrTail:red?undefined:err.slice(-400)}));
   expect(exit).toBe(broken?1:0);if(broken)expect(err).toContain('MUTATION_RED:');
  }
  console.log(label,JSON.stringify(results));
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('I2 FIX1 mutations: each repaired finding has an oracle that goes red when its fix is removed',()=>runI2Mutations(I2_FIX1_MUTATIONS,'I2_FIX1_MUTATIONS'),180000);
test('I2 FIX2 mutations: null evidence, uncertain rows, history-only calibration and oversize counting each go red when removed',()=>runI2Mutations(I2_FIX2_MUTATIONS,'I2_FIX2_MUTATIONS'),180000);
test('I4 FIX1 S mutations: capture payload, swallowed metadata hash and durable screen each go red',()=>runI2Mutations(I4_FIX1_S_MUTATIONS,'I4_FIX1_S_MUTATIONS'),180000);
test('SWITCHON S2 mutations: per-cell JSON, unsealed lines, a dropped hidden bit and a v3 header each go red',()=>runI2Mutations(S2_MUTATIONS,'S2_MUTATIONS'),180000);
test('F1-S mutations: early watermark, discarded retry and admission while paused each go red',()=>runI2Mutations(F1_S_MUTATIONS,'F1_S_MUTATIONS'),180000);

test('I2 FIX1 D12 contract probe: late B through E burst beside a borrowing A loses no row (normalRefused = 0)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-d12-')),s=createProjectionStore({historyRoot:root,mode:'create'});
 clearInterval((s as any).timer);   // no background flush: only drained() moves the disk writer
 // v4 rows reserve ~0.6 KiB each, so A offers 12000 to still outrun its guarantee plus borrow share.
 const counts=[12000,3000,3000,3000,3000],firstPass=Array(5).fill(0),pressure=Array(5).fill(0),lost=Array(5).fill(0);
 const key=(pane:number)=>({serverIdentity:'d12',paneId:`%${pane}`,birthGeneration:1});
 const cell=(grapheme:string)=>({grapheme,width:1,continuation:false,fg:null,bg:null,style:0});
 const event=(pane:number,n:number)=>{const text=`${pane} line ${n} of a big file`.padEnd(80,' ');
  return {paneKey:key(pane),sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text,cells:[...text].map(cell)}};};
 try {
  // A arrives first and borrows; then B..E each hand over a whole burst in one tick.
  const offered=counts.map((count,pane)=>Array.from({length:count},(_,n)=>s.appendScroll(event(pane,n))));
  const outcomes=await Promise.all(offered.map(p=>Promise.all(p)));
  outcomes.forEach((o,pane)=>{firstPass[pane]=o.findIndex(isProjectionRefusal);if(firstPass[pane]<0)firstPass[pane]=o.length;});
  const {guarantee}=(s as any).quota((s as any).rosterSize);
  const pendingAtBurst=s.health().pendingBytes;
  // Each producer re-offers from its first refused row, in order, after drained().
  await Promise.all(counts.map(async(count,pane)=>{
   for(let n=firstPass[pane];n<count;n++)await storeRow(s,event(pane,n),()=>pressure[pane]++).catch(()=>{lost[pane]++;});
  }));
  s.flush();
  let missing=0,wrong=0;
  for(let pane=0;pane<5;pane++){
   const token=s.token(key(pane));let anchor:number|null=null,seen=0;
   do{const page=s.readPage(token,anchor,2000);for(const l of page.lines){if(l.text!==event(pane,seen).physicalRow.text)wrong++;seen++;}anchor=page.hasMore?page.nextAnchor:null;}while(anchor!==null);
   missing+=counts[pane]-seen;
  }
  const normalRefused=lost.slice(1).reduce((a,b)=>a+b,0);
  const rowBytes=event(1,0).physicalRow.text.length;
  console.log('I2_D12_CONTRACT_PROBE',JSON.stringify({counts,firstPass,pressure,lost,normalRefused,missing,wrong,guarantee,pendingAtBurst,health:{...s.health(),panes:undefined}}));
  expect(pendingAtBurst).toBeLessThanOrEqual(16*1024*1024);
  expect(normalRefused).toBe(0);expect(lost[0]).toBe(0);expect(missing).toBe(0);expect(wrong).toBe(0);
  // Guarantee: every late pane was admitted at least its quota worth of rows in the first pass, while A was borrowing.
  expect(firstPass[0]).toBeLessThan(counts[0]);
  for(let pane=1;pane<5;pane++)expect(firstPass[pane]).toBeGreaterThan(Math.floor(guarantee/(rowBytes*20)));
  expect(s.health()).toMatchObject({rejectedRows:0,pressure:'none'});
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},60000);

test('I2: shutdown after 2000 and 20000 accepted rows has durable receipts and immediate reopen',async()=>{
 for(const count of [2000,20000]) {
  const root=mkdtempSync(join(tmpdir(),'na-i2-drain-')),key={serverIdentity:'drain',paneId:'%1',birthGeneration:1};
  let s=createProjectionStore({historyRoot:root,mode:'create'});
  try {
   for(let n=0;n<count;n++)await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:String(n),cells:[]}});
   const pendingAtClose=s.health().pendingBytes,started=performance.now();await s.close();const closeMs=performance.now()-started;
   s=createProjectionStore({historyRoot:root,mode:'recover'});
   expect(s.token(key).nextLineId).toBe(count);expect(s.token(key).revision).toBe(s.token(key).durableRevision);
   console.log('I2_DRAIN',JSON.stringify({count,pendingAtClose,closeMs}));
  }finally{await s.close();rmSync(root,{recursive:true,force:true});}
 }
},60000);

 test('I4 FIX2 S mutations: footprint, idle recovery, and calibration bound',()=>runI2Mutations(I4_FIX2_S_MUTATIONS,'I4_FIX2_S_MUTATION_PROOF'),60000);
