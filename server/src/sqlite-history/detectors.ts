import { randomUUID } from 'node:crypto';
import type { HistoryContext, HistoryFault, HistoryHealth, HistoryPageV1, HistoryRow } from './types';

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
