import { Database } from 'bun:sqlite';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { decodeCells, integer, paneId, type ProjectionRam, type SqlRow } from './ram-store';
import type { PaneKey, ProjectionArchiveReaderPort, ProjectionCheckState, ProjectionIssue, ProjectionPage, ProjectionToken } from './types';

/** Overlay pending issue updates on their durable copies, just as for history rows. */
export function readProjectionIssues(ram:ProjectionRam,disk:Database,token:ProjectionToken):ProjectionIssue[] {
  const found=new Map<string,SqlRow>();
  for(const db of [disk,ram.db])for(const row of db.query('SELECT * FROM na_issue WHERE pane_key=? AND revision<=?').all(paneId(token.paneKey),token.revision) as SqlRow[])found.set(String(row.issue_id),row);
  return [...found.values()].sort((a,b)=>Number(a.revision)-Number(b.revision)).map(projectionIssue);
}

export function projectionIssue(r:SqlRow):ProjectionIssue {
  return {issueId:String(r.issue_id),sourceEpoch:Number(r.source_epoch),revision:Number(r.revision),boundaryLineId:r.boundary_line_id===null?null:Number(r.boundary_line_id),
    kind:String(r.kind),reason:String(r.reason),missingCount:r.missing_count===null?null:Number(r.missing_count),detectedAt:Number(r.detected_at),resolvedAt:r.resolved_at===null?null:Number(r.resolved_at)};
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
    checkState:r.check_state as ProjectionCheckState,checkReason:String(r.check_reason),
    checkedCaptureId:r.checked_capture_id as string|null,checkedRow:r.checked_row as number|null}))};
}

/**
 * Read-only bridge for closed v2/v3 projection archives. It never ATTACHes the
 * archive to a live writer and intentionally exposes rows/issues only: v2
 * capture/screen payloads are legacy data, not a source for the current display.
 */
export function openProjectionArchive(input:string):ProjectionArchiveReaderPort {
  const file=resolve(input),stat=lstatSync(file);
  if(stat.isSymbolicLink() || !stat.isFile() || stat.nlink!==1 || /^brain\.db(?:$|[-.])/i.test(basename(file)))throw new Error('unsafe-archive-path');
  const fd=openSync(file,'r');let version:number;
  try {
    const head=Buffer.alloc(100),n=readSync(fd,head,0,100,0);
    version=n===100 && head.subarray(0,16).toString()==='SQLite format 3\0'?head.readUInt32BE(60):0;
  }finally{closeSync(fd);}
  if(version!==2 && version!==3)throw new Error('unsupported-projection-archive');
  const db=new Database(file,{readonly:true,strict:true});
  db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
  let closed=false;
  const ensure=()=>{if(closed)throw new Error('archive-closed');};
  const token=(key:PaneKey):ProjectionToken=>{
    ensure();const row=db.query('SELECT * FROM na_pane WHERE pane_key=?').get(paneId(key)) as SqlRow|null;
    if(!row)throw new Error('unknown-pane');
    if(Number(row.revision)!==Number(row.durable_revision))throw new Error('archive-watermark-corrupt');
    return {paneKey:{...key},sourceEpoch:Number(row.source_epoch),geometryGeneration:Number(row.geometry_generation),
      revision:Number(row.revision),durableRevision:Number(row.durable_revision),nextLineId:Number(row.next_line_id)};
  };
  return {schemaVersion:version,token,readPage(expected,anchor,limit){
    ensure();integer(limit);if(limit<1 || limit>2000)throw new Error('page-limit');
    const current=token(expected.paneKey);
    if(current.revision!==expected.revision || current.durableRevision!==expected.durableRevision || current.sourceEpoch!==expected.sourceEpoch
      || current.geometryGeneration!==expected.geometryGeneration || current.nextLineId!==expected.nextLineId)throw new Error('page-retry');
    const start=anchor===null?0:integer(anchor),end=Math.min(current.nextLineId,start+limit);
    if(start>current.nextLineId)throw new Error('page-anchor');
    const rows=db.query('SELECT * FROM na_line WHERE pane_key=? AND line_id>=? AND line_id<? ORDER BY line_id').all(paneId(expected.paneKey),start,end) as SqlRow[];
    if(rows.length!==end-start || rows.some((row,index)=>Number(row.line_id)!==start+index || Number(row.revision)>expected.revision))throw new Error('page-seam-hole');
    const issues=(db.query('SELECT * FROM na_issue WHERE pane_key=? AND revision<=? ORDER BY revision').all(paneId(expected.paneKey),expected.revision) as SqlRow[]).map(projectionIssue);
    return {token:{...current},issues,nextAnchor:end,hasMore:end<current.nextLineId,lines:rows.map(row=>({lineId:Number(row.line_id),
      sourceEpoch:Number(row.source_epoch),geometryGeneration:Number(row.geometry_generation),revision:Number(row.revision),text:String(row.text),
      cells:decodeCells(String(row.cells_json)),softWrap:!!row.soft_wrap,checkState:row.check_state as ProjectionCheckState,
      checkReason:String(row.check_reason),checkedCaptureId:row.checked_capture_id as string|null,checkedRow:row.checked_row as number|null}))};
  },close(){if(!closed){closed=true;db.close();}}};
}
