import { Database } from 'bun:sqlite';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { checkReason, checkState, closePrepared, prepared, decodeCells, integer, lineRow, paneId, type ProjectionRam, type SqlRow } from './ram-store';
import { decodeBlock } from './codec';
import type { PaneKey, ProjectionArchiveReaderPort, ProjectionCheckState, ProjectionIssue, ProjectionLine, ProjectionPage, ProjectionToken } from './types';

/** Columns of one line inside a sealed block, in order; line_id is first_line_id+index. */
export const BLOCK_COLUMNS=['source_epoch','revision','geometry_generation','text','cells','soft_wrap','check_state','check_reason','checked_capture_id','checked_row'] as const;
/** Largest block a reader must look back for; the schema CHECK holds every block to it. */
const BLOCK_MAX=4096;
/**
 * Durable lines [start,end) of one pane: sealed blocks first, then the per-line
 * tail. The writer keeps them disjoint (a line in a block is patched in place),
 * so a per-line row winning here only matters for a damaged file.
 */
export function readDiskLines(disk:Database,paneNo:number,start:number,end:number):SqlRow[] {
  const byId=new Map<number,SqlRow>();
  for(const block of prepared(disk,'SELECT first_line_id,line_count,data FROM na_block WHERE pane_no=? AND first_line_id<? AND first_line_id>? ORDER BY first_line_id').all(paneNo,end,start-BLOCK_MAX) as SqlRow[]) {
    const first=Number(block.first_line_id),lines=decodeBlock(block.data as unknown as Uint8Array);
    if(lines.length!==Number(block.line_count))throw new Error('block-corrupt');
    for(let i=Math.max(0,start-first);i<lines.length && first+i<end;i++) {
      const row:SqlRow={pane_no:paneNo,line_id:first+i};
      BLOCK_COLUMNS.forEach((column,j)=>{row[column]=lines[i]![j] as string|number|null;});
      byId.set(first+i,row);
    }
  }
  for(const row of prepared(disk,'SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id').all(paneNo,start,end) as SqlRow[])byId.set(Number(row.line_id),row);
  return [...byId.values()].sort((a,b)=>Number(a.line_id)-Number(b.line_id));
}
/** A stored v4 line as the API line. */
export function projectionLine(r:SqlRow):ProjectionLine {
  const row=lineRow(r);
  return {lineId:Number(r.line_id),sourceEpoch:Number(r.source_epoch),geometryGeneration:Number(r.geometry_generation),revision:Number(r.revision),
    text:row.text,cells:row.cells,softWrap:!!r.soft_wrap,checkState:checkState(r.check_state),checkReason:checkReason(r.check_reason),
    checkedCaptureId:r.checked_capture_id as string|null,checkedRow:r.checked_row as number|null};
}

/** Overlay pending issue updates on their durable copies, just as for history rows. */
export function readProjectionIssues(ram:ProjectionRam,disk:Database,token:ProjectionToken):ProjectionIssue[] {
  const found=new Map<string,SqlRow>();
  for(const db of [disk,ram.db])for(const row of prepared(db,'SELECT * FROM na_issue WHERE pane_key=? AND revision<=?').all(paneId(token.paneKey),token.revision) as SqlRow[])found.set(String(row.issue_id),row);
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
  const no=ram.paneNo(token.paneKey), byId=new Map<number,SqlRow>();
  // RAM overlays durable rows that were corrected after the last disk commit.
  for(const row of readDiskLines(disk,no,start,end)) byId.set(Number(row.line_id),row);
  for(const row of prepared(ram.db,'SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? ORDER BY line_id').all(no,start,end) as SqlRow[]) byId.set(Number(row.line_id),row);
  const values=[...byId.values()].sort((a,b)=>Number(a.line_id)-Number(b.line_id));
  if(values.length!==end-start || values.some((r,i)=>r.line_id!==start+i || Number(r.revision)>token.revision)) throw new Error('page-seam-hole');
  matches();
  return {token:{...current},issues:readProjectionIssues(ram,disk,current),nextAnchor:end,hasMore:end<current.nextLineId,lines:values.map(projectionLine)};
}

/**
 * Read-only bridge for closed v2/v3 archives and v4 files (including the live
 * v4 file of a running host). It never ATTACHes the archive to a live writer
 * and intentionally exposes rows/issues only: v2 capture/screen payloads are
 * legacy data, not a source for the current display. A version it does not
 * know is refused, never guessed.
 */
export function openProjectionArchive(input:string):ProjectionArchiveReaderPort {
  const file=resolve(input),stat=lstatSync(file);
  if(stat.isSymbolicLink() || !stat.isFile() || stat.nlink!==1 || /^brain\.db(?:$|[-.])/i.test(basename(file)))throw new Error('unsafe-archive-path');
  const fd=openSync(file,'r');let version:number;
  try {
    const head=Buffer.alloc(100),n=readSync(fd,head,0,100,0);
    version=n===100 && head.subarray(0,16).toString()==='SQLite format 3\0'?head.readUInt32BE(60):0;
  }finally{closeSync(fd);}
  if(version!==2 && version!==3 && version!==4)throw new Error('unsupported-projection-archive');
  const db=new Database(file,{readonly:true,strict:true});
  db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
  let closed=false;
  const ensure=()=>{if(closed)throw new Error('archive-closed');};
  const token=(key:PaneKey):ProjectionToken=>{
    ensure();const row=prepared(db,'SELECT * FROM na_pane WHERE pane_key=?').get(paneId(key)) as SqlRow|null;
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
    const rows=version===4?readDiskLines(db,Number((prepared(db,'SELECT pane_no FROM na_pane WHERE pane_key=?').get(paneId(expected.paneKey)) as SqlRow).pane_no),start,end)
      :prepared(db,'SELECT * FROM na_line WHERE pane_key=? AND line_id>=? AND line_id<? ORDER BY line_id').all(paneId(expected.paneKey),start,end) as SqlRow[];
    if(rows.length!==end-start || rows.some((row,index)=>Number(row.line_id)!==start+index || Number(row.revision)>expected.revision))throw new Error('page-seam-hole');
    const issues=(prepared(db,'SELECT * FROM na_issue WHERE pane_key=? AND revision<=? ORDER BY revision').all(paneId(expected.paneKey),expected.revision) as SqlRow[]).map(projectionIssue);
    // v2/v3 lines are verbatim text + JSON runs with named check states.
    const legacy=(row:SqlRow):ProjectionLine=>({lineId:Number(row.line_id),
      sourceEpoch:Number(row.source_epoch),geometryGeneration:Number(row.geometry_generation),revision:Number(row.revision),text:String(row.text),
      cells:decodeCells(String(row.cells_json)),softWrap:!!row.soft_wrap,checkState:row.check_state as ProjectionCheckState,
      checkReason:String(row.check_reason),checkedCaptureId:row.checked_capture_id as string|null,checkedRow:row.checked_row as number|null});
    return {token:{...current},issues,nextAnchor:end,hasMore:end<current.nextLineId,lines:rows.map(version===4?projectionLine:legacy)};
  },close(){if(!closed){closed=true;closePrepared(db);}}};
}
