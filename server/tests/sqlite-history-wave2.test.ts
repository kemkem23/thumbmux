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
    expect(f.store.rows(sid,0,40).map(row=>row.text)).toEqual(received[0].rows.map(row=>row.text));
    expect(bridge.ledger()).toEqual([{requestId:receipt.requestId,sessionId:sid,digest:receipt.digest,
      legacyCommitted:true,sqliteCommitted:true,sqliteRevision:1}]);
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
    const progress:number[]=[];const input={sourceId:'closed-source',snapshotDirectory:directory,format:'file-jsonl' as const,
      name:'closed',lifecycleKey:'closed-lifecycle',onProgress:(value:any)=>progress.push(value.recordCursor)};
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
    expect(progress).toContain(500);expect(progress).toContain(1100);
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
