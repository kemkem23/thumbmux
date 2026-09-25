import type { Database } from 'bun:sqlite';
import { decodeCells, integer, paneId, type ProjectionRam, type SqlRow } from './ram-store';
import type { ProjectionIssue, ProjectionPage, ProjectionToken } from './types';

/** Overlay pending issue updates on their durable copies, just as for history rows. */
export function readProjectionIssues(ram:ProjectionRam,disk:Database,token:ProjectionToken):ProjectionIssue[] {
  const found=new Map<string,SqlRow>();
  for(const db of [disk,ram.db])for(const row of db.query('SELECT * FROM na_issue WHERE pane_key=? AND revision<=?').all(paneId(token.paneKey),token.revision) as SqlRow[])found.set(String(row.issue_id),row);
  return [...found.values()].sort((a,b)=>Number(a.revision)-Number(b.revision)).map(r=>({
    issueId:String(r.issue_id),sourceEpoch:Number(r.source_epoch),revision:Number(r.revision),boundaryLineId:r.boundary_line_id===null?null:Number(r.boundary_line_id),
    kind:String(r.kind),reason:String(r.reason),missingCount:r.missing_count===null?null:Number(r.missing_count),detectedAt:Number(r.detected_at),resolvedAt:r.resolved_at===null?null:Number(r.resolved_at)}));
}

/** One revision token spans disk pages and the RAM tail. A changed revision is a retry. */
export function readProjectionPage(ram: ProjectionRam, disk: Database, token: ProjectionToken, anchor: number | null, limit: number): ProjectionPage {
  integer(limit); if(limit<1 || limit>2000) throw new Error('page-limit');
  const start=anchor===null?0:integer(anchor), current=ram.token(token.paneKey);
  const matches=()=> {
    const now=ram.token(token.paneKey);
    if(now.revision!==token.revision || now.sourceEpoch!==token.sourceEpoch || now.geometryGeneration!==token.geometryGeneration
      || now.nextLineId!==token.nextLineId) throw new Error('page-retry');
  };
  matches();
  const end=Math.min(current.nextLineId,start+limit);
  if(start>current.nextLineId) throw new Error('page-anchor');
  const id=paneId(token.paneKey), byId=new Map<number,SqlRow>();
  // RAM overlays durable rows that were corrected after the last disk commit.
  const query='SELECT * FROM na_line WHERE pane_key=? AND line_id>=? AND line_id<? ORDER BY line_id';
  for(const db of [disk,ram.db]) for(const row of db.query(query).all(id,start,end) as SqlRow[]) byId.set(Number(row.line_id),row);
  const values=[...byId.values()].sort((a,b)=>Number(a.line_id)-Number(b.line_id));
  if(values.length!==end-start || values.some((r,i)=>r.line_id!==start+i || Number(r.revision)>token.revision)) throw new Error('page-seam-hole');
  matches();
  return {token:{...current},issues:readProjectionIssues(ram,disk,current),nextAnchor:end,hasMore:end<current.nextLineId,lines:values.map(r=>({lineId:Number(r.line_id),
    sourceEpoch:Number(r.source_epoch),geometryGeneration:Number(r.geometry_generation),revision:Number(r.revision),
    text:String(r.text),cells:decodeCells(String(r.cells_json)),softWrap:!!r.soft_wrap,
    checkState:r.check_state as 'checked'|'unchecked',checkReason:String(r.check_reason),
    checkedCaptureId:r.checked_capture_id as string|null,checkedRow:r.checked_row as number|null}))};
}
