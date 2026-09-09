import { randomUUID } from 'node:crypto';
import { sha } from './codec';
import type {
  HistoryContext, HistoryFault, HistoryHealth, HistoryImportProgress, HistoryPageV1, HistoryRow,
  LegacyProjection, LegacyProjectionAcknowledgement, ShadowBatchSnapshot, ShadowComparisonReport,
  ShadowFrameRecord, ShadowRuntimeState, ShadowSourceOracle, ShadowUnresolvedRecord,
} from './types';

function shadowFault(sessionId:string,detector:string,expected:unknown,observed:unknown,timestamp:number):HistoryFault {
  const body={sessionId,detector,expected,observed,timestamp};
  return {issue_id:`shadow-${sha(JSON.stringify(body)).slice(0,24)}`,...body,missing_count:null};
}

function coordinates<T extends {ordinal:number}>(left:readonly T[],right:readonly T[],bytes:(value:T)=>string) {
  const a=new Map(left.map(value=>[value.ordinal,value])),b=new Map(right.map(value=>[value.ordinal,value]));
  const shared=[...a.keys()].filter(key=>b.has(key)).sort((x,y)=>x-y);
  return {matched:shared.length,mismatches:shared.filter(key=>Buffer.compare(Buffer.from(bytes(a.get(key)!)),Buffer.from(bytes(b.get(key)!)))!==0),
    leftOnly:[...a.keys()].filter(key=>!b.has(key)).sort((x,y)=>x-y),rightOnly:[...b.keys()].filter(key=>!a.has(key)).sort((x,y)=>x-y)};
}

function sourceDiff(observed:readonly HistoryRow[],oracle:readonly HistoryRow[]) {
  const actual=new Map(observed.map(row=>[row.line_no,row])),expected=new Map(oracle.map(row=>[row.line_no,row]));
  const shared=[...expected.keys()].filter(key=>actual.has(key));
  return {missingCoordinates:[...expected.keys()].filter(key=>!actual.has(key)).sort((a,b)=>a-b),
    extraCoordinates:[...actual.keys()].filter(key=>!expected.has(key)).sort((a,b)=>a-b),
    byteMismatches:shared.filter(key=>actual.get(key)!.kind!==expected.get(key)!.kind ||
      Buffer.compare(Buffer.from(actual.get(key)!.text),Buffer.from(expected.get(key)!.text))!==0).sort((a,b)=>a-b)};
}

/** Pure shadow comparator. The optional source oracle is independent of both
 * projections: legacy is never treated as the answer key for source completeness. */
export function compareShadowBatch(sessionId:string,legacy:ShadowBatchSnapshot,sqlite:ShadowBatchSnapshot,
  oracle:ShadowSourceOracle|null,comparedAt:number):ShadowComparisonReport {
  const legacyRows=new Map(legacy.rows.map(row=>[row.line_no,row])),sqliteRows=new Map(sqlite.rows.map(row=>[row.line_no,row]));
  const shared=[...legacyRows.keys()].filter(key=>sqliteRows.has(key)).sort((a,b)=>a-b);
  const lineBytes=shared.filter(key=>Buffer.compare(Buffer.from(legacyRows.get(key)!.text),Buffer.from(sqliteRows.get(key)!.text))!==0);
  const lineKinds=shared.filter(key=>legacyRows.get(key)!.kind!==sqliteRows.get(key)!.kind);
  const frames=coordinates<ShadowFrameRecord>(legacy.frames,sqlite.frames,value=>value.bytes);
  const unresolved=coordinates<ShadowUnresolvedRecord>(legacy.unresolved,sqlite.unresolved,value=>value.sha256);
  const lines={matchedCoordinates:shared.length,byteMismatches:lineBytes,kindMismatches:lineKinds,
    legacyOnly:[...legacyRows.keys()].filter(key=>!sqliteRows.has(key)).sort((a,b)=>a-b),
    sqliteOnly:[...sqliteRows.keys()].filter(key=>!legacyRows.has(key)).sort((a,b)=>a-b)};
  const receipts={legacyRequestId:legacy.requestId,sqliteRequestId:sqlite.requestId,match:legacy.requestId===sqlite.requestId};
  let source:ShadowComparisonReport['source']={status:'unknown',legacy:null,sqlite:null};
  if(oracle) {
    const left=sourceDiff(legacy.rows,oracle.rows),right=sourceDiff(sqlite.rows,oracle.rows);
    const bad=!oracle.rows.length || oracle.requestId!==legacy.requestId || oracle.requestId!==sqlite.requestId ||
      [...Object.values(left),...Object.values(right)].some(values=>values.length>0);
    source={status:bad?'mismatch':'verified',legacy:left,sqlite:right};
  }
  const faults:HistoryFault[]=[];
  if(!receipts.match)faults.push(shadowFault(sessionId,'shadow-receipt-mismatch',legacy.requestId,sqlite.requestId,comparedAt));
  if(lineBytes.length||lineKinds.length||lines.legacyOnly.length||lines.sqliteOnly.length)faults.push(shadowFault(sessionId,'shadow-line-mismatch',
    {byteMismatches:[],kindMismatches:[],legacyOnly:[],sqliteOnly:[]},{byteMismatches:lineBytes,kindMismatches:lineKinds,legacyOnly:lines.legacyOnly,sqliteOnly:lines.sqliteOnly},comparedAt));
  if(frames.mismatches.length||frames.leftOnly.length||frames.rightOnly.length)faults.push(shadowFault(sessionId,'shadow-frame-mismatch',
    {byteMismatches:[],legacyOnly:[],sqliteOnly:[]},{byteMismatches:frames.mismatches,legacyOnly:frames.leftOnly,sqliteOnly:frames.rightOnly},comparedAt));
  if(unresolved.mismatches.length||unresolved.leftOnly.length||unresolved.rightOnly.length)faults.push(shadowFault(sessionId,'shadow-unresolved-mismatch',
    {digestMismatches:[],legacyOnly:[],sqliteOnly:[]},{digestMismatches:unresolved.mismatches,legacyOnly:unresolved.leftOnly,sqliteOnly:unresolved.rightOnly},comparedAt));
  if(source.status==='mismatch')faults.push(shadowFault(sessionId,'shadow-source-mismatch','both projections match a non-empty independent oracle',source,comparedAt));
  return {sessionId,requestId:sqlite.requestId,comparedAt,receipts,lines,
    frames:{matchedOrdinals:frames.matched,byteMismatches:frames.mismatches,legacyOnly:frames.leftOnly,sqliteOnly:frames.rightOnly},
    unresolved:{matchedOrdinals:unresolved.matched,digestMismatches:unresolved.mismatches,legacyOnly:unresolved.leftOnly,sqliteOnly:unresolved.rightOnly},source,faults};
}

/** Pure watchdog detector. Scheduling and alarm delivery remain host concerns. */
export function inspectShadowRuntime(state:ShadowRuntimeState,now:number,staleAfterMs=30000):HistoryFault[] {
  const findings:HistoryFault[]=[];
  const last=state.lastProbeAt??state.startedAt;
  if(now-last>staleAfterMs || state.inFlightSince!==null&&now-state.inFlightSince>staleAfterMs)findings.push(shadowFault(state.sessionId,'shadow-collector-stale',
    `probe/in-flight age <=${staleAfterMs}ms`,{probeAge:now-last,inFlightAge:state.inFlightSince===null?null:now-state.inFlightSince},now));
  if(state.targetRevision>state.exportedRevision && state.exportLagSince!==null && now-state.exportLagSince>staleAfterMs)findings.push(shadowFault(state.sessionId,'shadow-export-lag',
    {revision:state.targetRevision,age:`<=${staleAfterMs}ms`},{revision:state.exportedRevision,age:now-state.exportLagSince},now));
  if(state.lastWriteFailure)findings.push(shadowFault(state.sessionId,'shadow-write-failure','both shadow destinations acknowledged the batch',state.lastWriteFailure,now));
  return findings;
}

/** Call from a host watchdog/process independent of the collector event loop.
 * No internal timer: a frozen collector cannot freeze this caller's scheduling. */
export function inspectHistoryHealth(health:HistoryHealth,now=Date.now()):HistoryFault[] {
  const findings:HistoryFault[]=[];
  const fault=(detector:string,expected:unknown,observed:unknown)=>findings.push({issue_id:randomUUID(),
    sessionId:health.sessionId,detector,expected,observed,timestamp:now,missing_count:null});
  if(now-(health.lastProbeAt??health.startedAt)>30000)fault('probe-stale','probe age <=30000ms',now-(health.lastProbeAt??health.startedAt));
  if(now-(health.lastCommitAt??health.startedAt)>30000)fault('commit-stale','commit age <=30000ms',now-(health.lastCommitAt??health.startedAt));
  if(health.continuity==='unknown')fault('source-unknown','independent source interval evidence','unknown');
  if(health.continuity==='failed'||health.fault && health.fault.detector!=='source-unknown')fault('collector-failed','no collector failure',health.fault);
  return findings;
}

/** Transport independent viewer detector; no existing viewer is wired to this in wave 1. */
export function validateHistoryPage(context:HistoryContext,page:HistoryPageV1):void {
  if(JSON.stringify(context)!==JSON.stringify(page.context))throw new Error('viewer-context-mismatch');
  if(page.rows.length!==page.endLine-page.startLine || page.rows.some((r,i)=>r.line_no!==page.startLine+i || r.line_no<context.firstLine || r.line_no>=context.liveStart))throw new Error('viewer-range-mismatch');
}

/** An independent original-record oracle must supply the expected occurrence list.
 * Sequential database allocation is deliberately irrelevant to this comparison. */
export function verifyHistoryOracle(expected:readonly HistoryRow[],observed:readonly HistoryRow[]):void {
  if(!expected.length)throw new Error('oracle-empty');
  if(expected.length!==observed.length || expected.some((r,i)=>r.line_no!==observed[i]?.line_no
    || r.kind!==observed[i]?.kind || r.text!==observed[i]?.text))throw new Error('source-oracle-mismatch');
}

export function inspectHistoryMirror(sessionId:string,targetRevision:number,exportedRevision:number,lagSince:number,now=Date.now()):HistoryFault|null {
  return exportedRevision<targetRevision && now-lagSince>30000 ? {issue_id:randomUUID(),sessionId,detector:'mirror-stale',expected:targetRevision,observed:exportedRevision,timestamp:now,missing_count:null}:null;
}

export function verifyDualWriteAcknowledgement(projection:LegacyProjection,acknowledgement:LegacyProjectionAcknowledgement):void {
  const digest=sha(JSON.stringify(projection));
  if(acknowledgement.requestId!==projection.requestId || acknowledgement.digest!==digest)throw new Error('legacy-projection-mismatch');
}

/** The caller schedules this outside the importer event loop. A persisted checkpoint
 * timestamp makes a restarted watchdog able to distinguish progress from silence. */
export function inspectImportProgress(progress:HistoryImportProgress,now=Date.now()):HistoryFault|null {
  if(progress.state==='verified' || progress.state==='quarantined' || now-progress.checkpointAt<=30000)return null;
  return {issue_id:randomUUID(),sessionId:progress.sessionId??'',detector:'import-progress-stale',
    expected:'checkpoint age <=30000ms',observed:now-progress.checkpointAt,timestamp:now,missing_count:null};
}
