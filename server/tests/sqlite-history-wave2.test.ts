import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(s.health().status).toBe('degraded');expect(s.token(key).durableRevision).toBe(0);
  expect(s.readPage(s.token(key),null,1).lines[0].text).toBe(event.physicalRow.text);
  expect(s.health().pendingBytes).toBeGreaterThan(0);
  disk.exec('PRAGMA max_page_count=1073741823');s.flush();
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

test('newarch: scroll pressure recovers, live screen survives, exact loss issue persists',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-pressure-')),faults:any[]=[];
 const key={serverIdentity:'pressure',paneId:'%1',birthGeneration:1};
 const s=createProjectionStore({historyRoot:root,mode:'create',onFault:f=>faults.push(f)});
 const event=(text:string,receiveSeq:number)=>({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq,softWrap:false,physicalRow:{text,cells:[]}});
 try {
  // Queue pressure is deterministic; no producer waits for a prior receipt.
  const queued=Array.from({length:20},(_,i)=>s.appendScroll(event('x'.repeat(1024*1024),i)).then(()=>true,()=>false));
  expect((s as any).ram.pane(key).health).toBe('degraded');
  const outcomes=await Promise.all(queued);
  const refused=outcomes.filter(v=>!v).length;expect(refused).toBeGreaterThan(0);expect(s.health().rejectedRows).toBe(refused);
  await s.replaceScreen({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:20,cols:1,rows:1,kind:'normal',cells:[[{grapheme:'Z',width:1,continuation:false,fg:null,bg:null,style:0}]],cursor:null});
  expect(JSON.parse(String(s.screen(key)!.cells_json))[0][0].grapheme).toBe('Z');
  s.flush();await s.appendScroll(event('recovered',21));s.flush();expect(s.health().status).toBe('healthy');
  const disk=new Database(s.file,{readonly:true});
  try {
    expect(disk.query("SELECT sum(missing_count) AS n FROM na_issue WHERE kind='ingest-capacity'").get()).toEqual({n:refused});
    expect(disk.query('SELECT health FROM na_pane').get()).toEqual({health:'healthy'});
  }finally{disk.close();}
  console.log('NA_PRESSURE',JSON.stringify({refused,counter:s.health().rejectedRows,faultNotifications:faults.length,screen:'Z',recovered:s.health().status}));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch: close releases timer and handles even when final flush throws',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-close-full-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'}),disk=(s as any).disk as Database;
 try {
  const pages=(disk.query('PRAGMA page_count').get() as any).page_count;disk.exec(`PRAGMA max_page_count=${pages}`);
  await s.appendScroll({paneKey:{serverIdentity:'close',paneId:'%1',birthGeneration:1},sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'x'.repeat(300000),cells:[]}});
  await expect(s.close()).rejects.toThrow(/full/i);await s.close();
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
   for(let j=0;j<10;j++)jobs.push(s.appendScroll(event(0,n*10+j)).catch(()=>{hotRefused++;}));
   for(let i=1;i<21;i++)jobs.push(s.appendScroll(event(i,n)).catch(()=>{normalRefused++;}));
   maxPending=Math.max(maxPending,internal.pendingBytes());
  }
  const before=faultCalls;
  for(let n=0;n<2000;n++) {
   const rejected=event(0,2000+n,'x'.repeat(1024*1024));
   Object.defineProperty(rejected.physicalRow,'cells',{get(){poisonReads++;throw Error('copied-rejected-cells');}});
   jobs.push(s.appendScroll(rejected).then(()=>{throw Error('oversize-admitted');},error=>{
    expect(String(error)).toContain('ingest-capacity');hotRefused++;
   }));
  }
  expect(faultCalls-before).toBe(0);expect(poisonReads).toBe(0);
  await Promise.all(jobs);s.flush();
  const disk=new Database(s.file,{readonly:true});
  try {
   expect(disk.query("SELECT sum(missing_count) AS n FROM na_issue WHERE kind='ingest-capacity'").get()).toEqual({n:hotRefused});
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
  await expect(s.replaceScreen({...frame,cells:[[{...cell,grapheme:'z'.repeat(16*1024*1024)}]]})).rejects.toThrow('ingest-capacity');
  expect(JSON.parse(String(s.screen(key)!.cells_json))[0][0].grapheme).toBe('x');
  expect(s.token(key).revision).toBeGreaterThan(before); // explicit fault, not the rejected screen
  s.flush();
  // Queue a generation transition behind an accepted scroll, then an oversized frame.
  const row=s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:2,softWrap:false,physicalRow:{text:'kept',cells:[]}});
  const transition=s.replaceScreen({...frame,sourceEpoch:2});
  const oversized=s.replaceScreen({...frame,sourceEpoch:2,cells:[[{...cell,grapheme:'z'.repeat(16*1024*1024)}]]});
  await expect(oversized).rejects.toThrow('ingest-capacity');await Promise.all([row,transition]);
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
      .then(()=>{accepted[i]++;},()=>{refused[i]++;});
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
    jobs.push(s.appendScroll({paneKey:key(0),sourceEpoch:1,geometryGeneration:1,receiveSeq:n+2,softWrap:false,physicalRow:{text:t,cells:[...t].map(g=>cell(g))}}).then(()=>{ok++;},()=>{refused++;}));}
   const pendingAtBurst=s.health().pendingBytes;
   let frame='accepted';
   try {await s.replaceScreen({paneKey:key(1),sourceEpoch:1,geometryGeneration:1,receiveSeq:9,cols:120,rows:40,kind:'normal',cells:textFrame(cell,120,40,0,false),cursor:{row:0,col:0,visible:true}});}
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
    try {await s.replaceScreen({paneKey:key(1),sourceEpoch:1,geometryGeneration:1,receiveSeq:2+a,cols,rows,kind:'normal',cells,cursor:{row:0,col:0,visible:true}});tries.push('accepted');}
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
  const rows=Array.from({length:12},(_,n)=>s.appendScroll({paneKey:key(2),sourceEpoch:1,geometryGeneration:1,receiveSeq:10+n,softWrap:false,physicalRow:{text:big,cells:[]}}).catch(()=>{refusedRows++;}));
  // Refusal is decided synchronously; read status before any flush can recover the pane.
  // One pane over its share degrades that pane, not the whole store (O9).
  const statusAtRefusal=s.health().status;
  const shown=s.replaceScreen({paneKey:key(2),sourceEpoch:1,geometryGeneration:1,receiveSeq:30,cols:208,rows:60,kind:'normal',cells:textFrame(cell,208,60,0,true),cursor:null});
  await Promise.all(rows);await shown;
  expect(refusedRows).toBeGreaterThan(0);expect(statusAtRefusal).toBe('degraded');
  s.flush();expect(s.health().pendingBytes).toBe(0);
  console.log('NA_DEBT2_FRAMES',JSON.stringify({known:2000,results:out,hotPaneRefusedRows:refusedRows,statusAtRefusal}));
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

test('newarch D11: a malformed frame landing on a queued frame is refused alone; the queued frame stays durable',async()=>{
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
  s.flush();expect(s.health().pendingBytes).toBe(0);expect(internal.pendingByPane.size).toBe(0);
  await s.close();
  s=createProjectionStore({historyRoot:root,mode:'recover'});
  const shown=JSON.parse(String(s.screen(key)!.cells_json));
  out.durableRows=shown.length;out.durableLastCell=shown[23][79].grapheme;
  expect(shown).toHaveLength(24);expect(shown[23][79].grapheme).toBe(good.cells[23][79].grapheme);
  console.log('NA_D11_COALESCE_VALIDATE',JSON.stringify(out));
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('newarch DEBT2: hot pane 20000 rows/s beside 21 panes, one issue per episode, store never stopped',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-debt2-hot-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'});
 const keys=Array.from({length:21},(_,i)=>({serverIdentity:'hot20k',paneId:`%${i}`,birthGeneration:1}));
 const hot={serverIdentity:'hot20k',paneId:'%hot',birthGeneration:1};
 const cell=(g:string)=>({grapheme:g,width:1 as const,continuation:false,fg:null,bg:null,style:0});
 const jobs=new Set<Promise<unknown>>(),statusSeen=new Set<string>();
 let produced=0,hotProduced=0,hotOk=0,hotRefused=0,normalRefused=0,frameRefused=0,lastFrame=-1e9,fseq=0;
 const track=(p:Promise<unknown>)=>{jobs.add(p);void p.finally(()=>jobs.delete(p));};
 const originalError=console.error;console.error=()=>{};
 try {
  const start=performance.now();
  while(performance.now()-start<10000) {
   const now=performance.now()-start;
   for(const due=Math.floor(now/10);produced<due;produced++)for(let i=0;i<21;i++){const t=`${i}:${produced}`.padEnd(80,' ');
    track(s.appendScroll({paneKey:keys[i],sourceEpoch:1,geometryGeneration:1,receiveSeq:produced+1,softWrap:false,physicalRow:{text:t,cells:[...t].map(cell)}}).catch(()=>{normalRefused++;}));}
   for(const due=Math.floor(now*20);hotProduced<due;hotProduced++){const t=`h:${hotProduced}`.padEnd(80,' ');
    track(s.appendScroll({paneKey:hot,sourceEpoch:1,geometryGeneration:1,receiveSeq:hotProduced+1,softWrap:false,physicalRow:{text:t,cells:[...t].map(cell)}}).then(()=>{hotOk++;},()=>{hotRefused++;}));}
   if(now-lastFrame>=100){lastFrame=now;fseq++;for(const k of [...keys,hot])
    track(s.replaceScreen({paneKey:k,sourceEpoch:1,geometryGeneration:1,receiveSeq:fseq,cols:80,rows:24,kind:'normal',cells:textFrame(cell,80,24,fseq,false),cursor:null}).catch(()=>{frameRefused++;}));}
   statusSeen.add(s.health().status);
   await Bun.sleep(10);
  }
  await Promise.all(jobs);s.flush();
  let missing=0,wrong=0;
  for(let i=0;i<21;i++){const page=s.readPage(s.token(keys[i]),null,2000);missing+=produced-page.lines.length;
   wrong+=page.lines.filter((l,n)=>l.text!==`${i}:${n}`.padEnd(80,' ')).length;}
  const disk=new Database(s.file,{readonly:true});
  let issues:any;
  try {issues=disk.query("SELECT count(*) AS n,coalesce(sum(missing_count),0) AS missing FROM na_issue WHERE kind='ingest-capacity'").get();}finally{disk.close();}
  console.error=originalError;
  console.log('NA_DEBT2_HOT20K',JSON.stringify({durationMs:10000,hotRate:20000,normalPanes:21,normalRate:100,produced,hotProduced,hotOk,hotRefused,normalRefused,frameRefused,missing,wrong,statusSeen:[...statusSeen],issues}));
  expect(normalRefused).toBe(0);expect(frameRefused).toBe(0);expect(missing+wrong).toBe(0);
  expect(hotRefused).toBeGreaterThan(0);expect(statusSeen.has('stopped')).toBe(false);
  // Review3 saw 677 issue rows for one continuous 30 s episode; it is one episode here.
  expect(issues).toEqual({n:1,missing:hotRefused});
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

test('I2 probe: measure A borrowing before B through E arrive without disk acknowledgements',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-borrow-'));
 const s=createProjectionStore({historyRoot:root,mode:'create'});clearInterval((s as any).timer);
 const admitted:number[]=[],refused:number[]=[];
 try {
  for(let pane=0;pane<5;pane++) {
   admitted[pane]=0;refused[pane]=0;
   for(let n=0;n<(pane===0?7:2);n++) {
    try {await s.appendScroll({paneKey:{serverIdentity:'borrow',paneId:`%${pane}`,birthGeneration:1},sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text:'x'.repeat(1024*1024),cells:[]}});admitted[pane]++;}
    catch(error){expect(String(error)).toContain('ingest-capacity');refused[pane]++;}
   }
  }
  console.log('I2_BORROW_PROBE',JSON.stringify({admitted,refused,health:s.health()}));
  expect(s.health().pendingBytes).toBeLessThanOrEqual(16*1024*1024);
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

test('I2: acknowledgement cannot clear RAM pressure before cache also recovers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-cache-')),s=createProjectionStore({historyRoot:root,mode:'create'}),internal=s as any;
 const key={serverIdentity:'cache',paneId:'%1',birthGeneration:1};
 const bytes=internal.ram.bytes.bind(internal.ram);
 try {
  await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'keep',cells:[]}});
  internal.ram.bytes=()=>256*1024*1024+1;
  await expect(s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:2,softWrap:false,physicalRow:{text:'pressure',cells:[]}})).rejects.toThrow('ingest-capacity');
  s.flush();expect(s.health()).toMatchObject({status:'stopped',pressure:'recoverable'});
  expect(s.health().panes[0].status).toBe('degraded');
  internal.ram.bytes=bytes;
  await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:3,softWrap:false,physicalRow:{text:'recovered',cells:[]}});
  s.flush();expect(s.health().status).toBe('healthy');
 }finally{internal.ram.bytes=bytes;await s.close();rmSync(root,{recursive:true,force:true});}
});

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

test('I2 mutations: stale issue, unfenced screen and cache recovery each make an independent oracle fail',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-mutation-'));
 const cases=[
  {name:'issue-cas',file:'ram-store.ts',before:"if(p.revision!==issue.expectedRevision)throw new Error('stale-revision');",after:'/* mutation: removed issue CAS */'},
  {name:'capture-fence',file:'ram-store.ts',before:"if(evidence?.kind==='byte-fence') {",after:"if(true) {"},
  {name:'cache-recovery',file:'projection-store.ts',before:'if(this.pendingBytes()<PENDING_MAX/2 && this.ram.bytes()<=CACHE_MAX) {',after:'if(this.pendingBytes()<PENDING_MAX/2) {'},
 ];
 try {
  for(const mutation of cases)for(const broken of [false,true]) {
   const outdir=join(root,mutation.name+'-'+broken);
   const result=await Bun.build({entrypoints:[join(import.meta.dir,'../src/sqlite-history/projection-store.ts')],outdir,target:'bun',plugins:[{
    name:'controlled-mutation',setup(build){build.onLoad({filter:/\/(ram-store|projection-store)\.ts$/},args=>{
     let contents=readFileSync(args.path,'utf8');
     if(broken && args.path.endsWith('/'+mutation.file)) {
      expect(contents).toContain(mutation.before);contents=contents.replace(mutation.before,mutation.after);
      // Remove the remaining fence validations too: the mutant represents the old unconditional capture-screen write.
      if(mutation.name==='capture-fence')contents=contents.replace('integer(evidence.receiveSeq);','').replace("if(evidence.sourceEpoch!==c.sourceEpoch || evidence.receiveSeq!==c.receiveSeq || evidence.receiveSeq!==p.receive_seq)throw new Error('capture-fence-mismatch');",'');
     }
     return {contents,loader:'ts'};
    });}
   }]});
   expect(result.success).toBe(true);
   const script=`import {createProjectionStore} from ${JSON.stringify(join(outdir,'projection-store.js'))};
    const key={serverIdentity:'mutation',paneId:'%1',birthGeneration:1};
    const s=createProjectionStore({historyRoot:${JSON.stringify(join(outdir,'data'))},mode:'create'});
    const assert=(value,message)=>{if(!value)throw Error('MUTATION_RED: '+message);};
    const row={paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,softWrap:false,physicalRow:{text:'one',cells:[]}};
    try {
     await s.appendScroll(row);
     if(${JSON.stringify(mutation.name)}==='issue-cas') {
      let rejected=false;try {await s.recordIssue({paneKey:key,sourceEpoch:1,geometryGeneration:1,expectedRevision:0,boundaryLineId:1,kind:'fault',reason:'fixture',missingCount:null,recoverable:false});}catch(e){rejected=String(e).includes('stale-revision');}
      assert(rejected,'stale issue must be refused');
     } else if(${JSON.stringify(mutation.name)}==='capture-fence') {
      const cell={grapheme:'A',width:1,continuation:false,fg:null,bg:null,style:0};
      const frame={paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:1,cols:1,rows:1,kind:'normal',cells:[[cell]],cursor:null};
      await s.replaceScreen(frame);
      await s.calibrate({capture:{...frame,captureId:'unfenced',requestedAt:1,completedAt:2,firstHistoryRow:0,history:[],observedFields:[],ambiguousRows:0,result:'fixture'},expectedRevision:s.token(key).revision,captureEvidence:{kind:'unfenced',reason:'fixture'},checks:[],repairs:[]});
      assert(s.screen(key).display_source==='pipe','unfenced capture must not replace screen');
     } else {
      const bytes=s.ram.bytes.bind(s.ram);s.ram.bytes=()=>256*1024*1024+1;
      try {await s.appendScroll({...row,receiveSeq:2});}catch{}
      s.flush();const state=s.health().status;s.ram.bytes=bytes;
      assert(state==='stopped','cache pressure must remain stopped');
     }
    } finally {await s.close();}`;
   const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'pipe',stderr:'pipe'});
   const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   console.log('I2_MUTATION',JSON.stringify({name:mutation.name,broken,exit,stdout:out,stderr:err}));
   expect(exit).toBe(broken?1:0);if(broken)expect(err).toContain('MUTATION_RED:');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);

test('I2 contract probe: late B through E burst exceeds the existing borrow budget',async()=>{
 const root=mkdtempSync(join(tmpdir(),'na-i2-d12-')),s=createProjectionStore({historyRoot:root,mode:'create'});
 clearInterval((s as any).timer);
 const admitted=Array(5).fill(0),refused=Array(5).fill(0),jobs:Promise<unknown>[]=[];
 try {
  const cell=(grapheme:string)=>({grapheme,width:1,continuation:false,fg:null,bg:null,style:0});
  for(let pane=0;pane<5;pane++)for(let n=0;n<(pane===0?6000:3000);n++) {
   const text=`line ${n} of a big file`.padEnd(80,' ');
   jobs.push(s.appendScroll({paneKey:{serverIdentity:'d12',paneId:`%${pane}`,birthGeneration:1},sourceEpoch:1,geometryGeneration:1,receiveSeq:n,softWrap:false,physicalRow:{text,cells:[...text].map(cell)}}).then(()=>{admitted[pane]++;},()=>{refused[pane]++;}));
  }
  await Promise.all(jobs);
  console.log('I2_D12_CONTRACT_PROBE',JSON.stringify({admitted,refused,pendingBytes:s.health().pendingBytes,normalRefused:refused.slice(1).reduce((a,b)=>a+b,0)}));
  expect(s.health().pendingBytes).toBeLessThanOrEqual(16*1024*1024);
  // Observation of an OPEN debt, not an acceptance assertion that normal loss is OK.
  expect(refused.slice(1).reduce((a,b)=>a+b,0)).toBeGreaterThan(0);
 }finally{await s.close();rmSync(root,{recursive:true,force:true});}
},30000);

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
