import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { fixture, ids, observation, evidence } from './sqlite-history/helpers';
import { legacyProjectionDigest, OptInHistoryBridge } from '../src/sqlite-history/bridge';
import { compareShadowBatch, inspectShadowRuntime } from '../src/sqlite-history/detectors';
import type {
  HistoryRow, LegacyProjection, ShadowBatchSnapshot, ShadowRuntimeState,
} from '../src/sqlite-history/types';

const rows=(values:string[]):HistoryRow[]=>values.map((text,line_no)=>({line_no,kind:'terminal',text}));
const snapshot=(requestId:string,values:string[]):ShadowBatchSnapshot=>({requestId,revision:1,rows:rows(values),frames:[],unresolved:[]});

test('shadow bridge sends one capture to both writers, compares receipts/bytes, and has no reader surface',async()=>{
  const f=fixture();try{
    const sid=await f.store.register({name:'shadow',lifecycleKey:'shadow'}),reports:any[]=[];let captures=0,writes=0;
    const expected=ids(40),frameBytes=JSON.stringify({v:1,session:'shadow',at:100,frame:{channel:'shadow',type:'output',data:ids(50).join('\n'),cursor:null}});
    const bridge=new OptInHistoryBridge(f.store,{spoolDirectory:join(f.dir,'spool'),sessions:()=>[sid],recordFrames:true,
      driver:{geometryGeneration:()=>1,capture:async()=>{captures++;return observation(ids(50),10);}},
      legacyProjection:{write:async projection=>{writes++;return {requestId:projection.requestId,digest:legacyProjectionDigest(projection),
        shadow:{requestId:projection.requestId,revision:1,rows:rows(expected),frames:[{ordinal:0,bytes:frameBytes}],unresolved:[]}};}},
      shadow:{now:()=>1234,sourceOracle:projection=>({requestId:projection.requestId,rows:rows(expected),frames:[{ordinal:0,bytes:frameBytes}],unresolved:[]}),
        onComparison:report=>reports.push(report)}});
    const receipt=await bridge.probe(sid);
    expect(captures).toBe(1);expect(writes).toBe(1);expect(receipt.requestId).toBe(reports[0].requestId);
    expect(reports).toHaveLength(1);expect(reports[0].comparedAt).toBe(1234);expect(reports[0].faults).toEqual([]);
    expect(reports[0].lines).toMatchObject({matchedCoordinates:40,byteMismatches:[],legacyOnly:[],sqliteOnly:[]});
    expect(reports[0].frames).toMatchObject({matchedOrdinals:1,byteMismatches:[],legacyOnly:[],sqliteOnly:[]});
    expect(reports[0].unresolved).toMatchObject({matchedOrdinals:0,digestMismatches:[]});
    expect(reports[0].source.status).toBe('verified');expect('readBefore' in bridge).toBe(false);
    expect(bridge.ledger()[0]).toMatchObject({legacyCommitted:true,sqliteCommitted:true,shadowCompared:true,shadowDelivered:true});
    console.log('SHADOW_BRIDGE_PROOF',JSON.stringify({captures,writes,reports:reports.length,matchedLines:reports[0].lines.matchedCoordinates,
      matchedFrames:reports[0].frames.matchedOrdinals,source:reports[0].source.status,faults:reports[0].faults.length}));
  }finally{await f.cleanup();}
});

test('independent source oracle catches the same wrong legacy and SQLite answer',()=>{
  const legacy=snapshot('batch-1',['source-0','source-2']),sqlite=snapshot('batch-1',['source-0','source-2']);
  const report=compareShadowBatch('fixture',legacy,sqlite,{requestId:'batch-1',rows:rows(['source-0','source-1','source-2'])},2000);
  expect(report.lines).toEqual({matchedCoordinates:2,byteMismatches:[],kindMismatches:[],legacyOnly:[],sqliteOnly:[]});
  expect(report.source.status).toBe('mismatch');expect(report.source.legacy).toEqual(report.source.sqlite);
  expect(report.source.legacy).toMatchObject({missingCoordinates:[2],byteMismatches:[1]});
  expect(report.faults.map(f=>f.detector)).toEqual(['shadow-source-mismatch']);evidence(report.faults[0]);
});

test('shadow comparator reports receipt, line, frame, and unresolved faults separately',()=>{
  const legacy:ShadowBatchSnapshot={requestId:'legacy-id',revision:4,rows:rows(['a','legacy-byte']),
    frames:[{ordinal:0,bytes:'frame-old'}],unresolved:[{ordinal:0,sha256:'unresolved-old'}]};
  const sqlite:ShadowBatchSnapshot={requestId:'sqlite-id',revision:7,rows:[...rows(['a','sqlite-byte']),{line_no:2,kind:'gap',text:'gap'}],
    frames:[{ordinal:0,bytes:'frame-new'},{ordinal:1,bytes:'extra'}],unresolved:[{ordinal:0,sha256:'unresolved-new'}]};
  const report=compareShadowBatch('fixture',legacy,sqlite,null,3000);
  expect(report.source.status).toBe('unknown');
  expect(report.faults.map(f=>f.detector)).toEqual(['shadow-receipt-mismatch','shadow-line-mismatch','shadow-frame-mismatch','shadow-unresolved-mismatch']);
  expect(report.lines).toMatchObject({matchedCoordinates:2,byteMismatches:[1],legacyOnly:[],sqliteOnly:[2]});
  expect(report.frames).toEqual({matchedOrdinals:1,byteMismatches:[0],legacyOnly:[],sqliteOnly:[1]});
  expect(report.unresolved).toEqual({matchedOrdinals:1,digestMismatches:[0],legacyOnly:[],sqliteOnly:[]});
  report.faults.forEach(evidence);
});

test('pure shadow runtime detector cries for export lag, write failure, and stale collector',()=>{
  const state:ShadowRuntimeState={sessionId:'fixture',startedAt:1000,lastProbeAt:1000,inFlightSince:2000,
    targetRevision:8,exportedRevision:6,exportLagSince:1000,lastWriteFailure:{backend:'sqlite',at:2500,error:'synthetic-full'}};
  const faults=inspectShadowRuntime(state,32001);
  expect(faults.map(f=>f.detector)).toEqual(['shadow-collector-stale','shadow-export-lag','shadow-write-failure']);faults.forEach(evidence);
  expect(inspectShadowRuntime({...state,lastProbeAt:32000,inFlightSince:null,targetRevision:8,exportedRevision:8,exportLagSince:null,lastWriteFailure:null},32001)).toEqual([]);
  console.log('SHADOW_DETECTOR_PROOF',JSON.stringify({faults:faults.map(f=>f.detector),quietAfterRepair:true}));
});

test('shadow comparison delivery is persisted and resumed without rewriting either backend',async()=>{
  const f=fixture();try{
    const sid=await f.store.register({name:'resume-shadow',lifecycleKey:'resume-shadow'}),expected=ids(40);let writes=0,deliveries=0,fail=true;
    const options={spoolDirectory:join(f.dir,'spool'),sessions:()=>[sid],driver:{geometryGeneration:()=>1,capture:async()=>observation(ids(50),10)},
      legacyProjection:{write:async(projection:LegacyProjection)=>{writes++;return {requestId:projection.requestId,digest:legacyProjectionDigest(projection),
        shadow:{requestId:projection.requestId,revision:1,rows:rows(expected),frames:[],unresolved:[]}};}},
      shadow:{now:()=>4000,sourceOracle:(projection:LegacyProjection)=>({requestId:projection.requestId,rows:rows(expected)}),onComparison:()=>{deliveries++;if(fail)throw new Error('synthetic alarm sink outage');}}};
    const first=new OptInHistoryBridge(f.store,options);await expect(first.probe(sid)).rejects.toThrow('synthetic alarm sink outage');
    expect(first.ledger()[0]).toMatchObject({legacyCommitted:true,sqliteCommitted:true,shadowCompared:true,shadowDelivered:false});
    fail=false;const resumed=new OptInHistoryBridge(f.store,options);await resumed.resumePending();
    expect(writes).toBe(1);expect(f.store.session(sid).revision).toBe(1);expect(deliveries).toBe(2);
    expect(resumed.ledger()[0]).toMatchObject({shadowCompared:true,shadowDelivered:true});
  }finally{await f.cleanup();}
});
