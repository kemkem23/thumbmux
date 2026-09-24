import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  console.log('NA_DISK_FULL',JSON.stringify({sqliteFull:true,hostFaults:faults.length,rowsLost:0,pendingAfterRetry:s.health().pendingBytes}));
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
    for(let n=s.token(key).nextLineId;;n++) {
      await s.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:n+1,softWrap:false,physicalRow:{text:String(n),cells:[]}});
      if(n%31===0){s.flush();const fd=openSync(${JSON.stringify(oracle+'.next')},'w');writeSync(fd,JSON.stringify({next:s.token(key).nextLineId}));fsyncSync(fd);closeSync(fd);renameSync(${JSON.stringify(oracle+'.next')},${JSON.stringify(oracle)});}
      if(n%8===0)await Bun.sleep(1);
    }`;
   const child=Bun.spawn([process.execPath,'--eval',script],{stdout:'ignore',stderr:'pipe'});
   await Bun.sleep(150+Math.floor(Math.random()*200));child.kill('SIGKILL');await child.exited;
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
  const outcomes=await Promise.all(Array.from({length:20},(_,i)=>s.appendScroll(event('x'.repeat(1024*1024),i)).then(()=>true,()=>false)));
  const refused=outcomes.filter(v=>!v).length;expect(refused).toBeGreaterThan(0);expect(s.health().rejectedRows).toBe(refused);
  await s.replaceScreen({paneKey:key,sourceEpoch:1,geometryGeneration:1,receiveSeq:20,cols:1,rows:1,kind:'normal',cells:[[{grapheme:'Z',width:1,continuation:false,fg:null,bg:null,style:0}]],cursor:null});
  expect(JSON.parse(String(s.screen(key)!.cells_json))[0][0].grapheme).toBe('Z');
  expect((s as any).ram.pane(key).health).toBe('degraded');
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
