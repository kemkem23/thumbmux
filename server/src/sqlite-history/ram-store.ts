import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECTION_RAM_SCREEN_SCHEMA, PROJECTION_SCHEMA } from './schema';
import type { PaneKey, PhysicalRow, ProjectionCalibration, ProjectionIssueInput, ProjectionFrame, ProjectionReceipt, ProjectionToken, ScrollEvent } from './types';

// Version 3 stores lines WITHOUT ROWID under (pane_key,line_id), so this range
// seeks the table primary key without maintaining duplicate identity indexes.
export const EVICT_LINES_SQL='DELETE FROM na_line WHERE pane_key=? AND line_id<? AND revision<=?';

export type SqlRow = Record<string, string | number | null>;
export const paneId = (key: PaneKey): string => {
  if (!key.serverIdentity || !key.paneId) throw new Error('invalid-pane-key');
  integer(key.birthGeneration);
  return JSON.stringify([key.serverIdentity, key.paneId, key.birthGeneration]);
};
export function integer(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid-integer');
  return n;
}
export function validateRow(row: PhysicalRow): void {
  if (typeof row.text !== 'string' || !row.text.isWellFormed() || !Array.isArray(row.cells)) throw new Error('invalid-row');
  for (const c of row.cells) {
    if (typeof c.grapheme !== 'string' || !c.grapheme.isWellFormed() || ![0,1,2].includes(c.width)
      || typeof c.continuation !== 'boolean' || !Number.isSafeInteger(c.style)
      || ![c.fg,c.bg].every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) throw new Error('invalid-cell');
  }
}
type CellRun=[string,number,boolean,string|number|null,string|number|null,number,number];
function cellRuns(cells:PhysicalRow['cells']):CellRun[] {
  const runs:CellRun[]=[];
  for(const c of cells) {
    const last=runs[runs.length-1];
    if(last && last[0]===c.grapheme && last[1]===c.width && last[2]===c.continuation
      && last[3]===c.fg && last[4]===c.bg && last[5]===c.style)last[6]++;
    else runs.push([c.grapheme,c.width,c.continuation,c.fg,c.bg,c.style,1]);
  }
  return runs;
}
function expandRuns(runs:any[]):PhysicalRow['cells'] {
  // Earlier v2 files used [cell,count]; both encodings are lossless/readable.
  return runs.flatMap(run=>{
    if(typeof run[0]==='object')return Array.from({length:run[1]},()=>({...run[0]}));
    const [grapheme,width,continuation,fg,bg,style,n]=run;
    return Array.from({length:n},()=>({grapheme,width,continuation,fg,bg,style}));
  });
}
export function encodeCells(cells:PhysicalRow['cells']):string {return JSON.stringify(cellRuns(cells));}
export function decodeCells(encoded:string):PhysicalRow['cells'] {return expandRuns(JSON.parse(encoded));}
export function encodeFrameCells(cells:PhysicalRow['cells'][]):string {
  return JSON.stringify({rle:1,rows:cells.map(cellRuns)});
}
export function decodeFrameCells(encoded:string):PhysicalRow['cells'][] {
  const value=JSON.parse(encoded);return value.rle===1?value.rows.map(expandRuns):value;
}
export function validateFrame(frame: ProjectionFrame): void {
  integer(frame.cols); integer(frame.rows); integer(frame.receiveSeq);
  if (!frame.cols || !frame.rows || !['normal','alternate'].includes(frame.kind)
    || frame.cells.length !== frame.rows || frame.cells.some(row => row.length !== frame.cols)) throw new Error('invalid-frame');
  frame.cells.forEach(cells => validateRow({text:'',cells}));
  if (frame.cursor && (!Number.isInteger(frame.cursor.row) || !Number.isInteger(frame.cursor.col)
    || frame.cursor.row < 0 || frame.cursor.row >= frame.rows || frame.cursor.col < 0 || frame.cursor.col >= frame.cols
    || typeof frame.cursor.visible !== 'boolean')) throw new Error('invalid-cursor');
}
const UPSERT_IDENTITIES:Record<string,string[]>={na_pane:['pane_key'],na_capture:['pane_key','capture_id'],
  na_line:['pane_key','line_id'],na_screen:['pane_key','screen_kind'],na_issue:['issue_id'],na_commit:['commit_id']};
const UPSERT_SQL=new Map<string,string>();
const UPSERT_STATEMENTS=new WeakMap<Database,Map<string,ReturnType<Database['query']>>>();
export function upsert(db: Database, table: string, row: SqlRow): void {
  // All identifiers come exclusively from the schema and SQLite column metadata.
  if (!/^na_(pane|capture|line|screen|issue|commit)$/.test(table)) throw new Error('invalid-table');
  const columns=Object.keys(row),signature=table+':'+columns.join(',');
  let sql=UPSERT_SQL.get(signature);
  if(!sql) {
    if(columns.some(c=>!/^[a-z_]+$/.test(c)))throw new Error('invalid-column');
    // Identity columns are equal on every possible UNIQUE conflict. Reassigning
    // them causes SQLite to schedule unnecessary parent-key foreign-key work.
    const mutable=columns.filter(c=>!UPSERT_IDENTITIES[table].includes(c));
    sql=`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})
      ON CONFLICT DO UPDATE SET ${mutable.map(c=>`${c}=excluded.${c}`).join(',')}`;
    UPSERT_SQL.set(signature,sql);
  }
  let statements=UPSERT_STATEMENTS.get(db);
  if(!statements){statements=new Map();UPSERT_STATEMENTS.set(db,statements);}
  let statement=statements.get(signature);
  if(!statement){statement=db.query(sql);statements.set(signature,statement);}
  statement.run(...Object.values(row));
}

/** Only the bounded live working set lives here. Disk history is never loaded wholesale. */
export class ProjectionRam {
  readonly db = new Database(':memory:', {strict:true});
  private readonly pageSize:number;
  constructor() {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA cache_size=-262144;');
    this.db.exec(PROJECTION_SCHEMA);this.db.exec(PROJECTION_RAM_SCREEN_SCHEMA);
    this.db.exec('CREATE INDEX na_line_capture ON na_line(pane_key,checked_capture_id)');
    this.pageSize=Number((this.db.query('PRAGMA page_size').get() as {page_size:number}).page_size);
  }
  pane(key: PaneKey): SqlRow {
    const row = this.db.query('SELECT * FROM na_pane WHERE pane_key=?').get(paneId(key)) as SqlRow | null;
    if (!row) throw new Error('unknown-pane');
    return row;
  }
  token(key: PaneKey): ProjectionToken {
    const p=this.pane(key);
    return {paneKey:{...key},sourceEpoch:Number(p.source_epoch),geometryGeneration:Number(p.geometry_generation),
      revision:Number(p.revision),durableRevision:Number(p.durable_revision),nextLineId:Number(p.next_line_id)};
  }
  ensure(key: PaneKey, epoch: number, geometry: number): SqlRow {
    const id=paneId(key); integer(epoch); integer(geometry);
    const p=this.db.query('SELECT * FROM na_pane WHERE pane_key=?').get(id) as SqlRow|null;
    if(!p) {
      this.db.query(`INSERT INTO na_pane
        (pane_key,session_uuid,server_identity,pane_id,birth_generation,source_epoch,geometry_generation,cols,rows,screen_kind)
        VALUES (?,?,?,?,?,?,?,0,0,'normal')`).run(id,randomUUID(),key.serverIdentity,key.paneId,key.birthGeneration,epoch,geometry);
      return this.pane(key);
    }
    if(epoch<Number(p.source_epoch) || geometry<Number(p.geometry_generation))throw new Error('stale-generation');
    // Most rows and frames belong to the current generation. There is no metadata
    // transition to write, and the freshly read pane already contains the receipt.
    if(epoch===Number(p.source_epoch) && geometry===Number(p.geometry_generation))return p;
    if (epoch > Number(p.source_epoch)) this.db.query('INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(
      randomUUID(),id,epoch,Number(p.revision)+1,p.next_line_id,'gap','source-epoch-changed',null,Date.now());
    this.db.query('UPDATE na_pane SET source_epoch=?,geometry_generation=?,receive_seq=? WHERE pane_key=?').run(epoch,geometry,epoch>Number(p.source_epoch)?-1:p.receive_seq,id);
    return this.pane(key);
  }
  bump(key: PaneKey): ProjectionReceipt {
    const row=this.db.query('UPDATE na_pane SET revision=revision+1 WHERE pane_key=? AND revision<9007199254740991 RETURNING revision,durable_revision,next_line_id').get(paneId(key)) as SqlRow|null;
    if(!row)throw new Error('unknown-pane-or-revision-overflow');
    return {revision:Number(row.revision),durableRevision:Number(row.durable_revision),nextLineId:Number(row.next_line_id)};
  }

  append(event: ScrollEvent, preparedCells?:string): ProjectionReceipt {
    validateRow(event.physicalRow); integer(event.receiveSeq);
    if (typeof event.softWrap !== 'boolean') throw new Error('invalid-soft-wrap');
    const p=this.ensure(event.paneKey,event.sourceEpoch,event.geometryGeneration), id=paneId(event.paneKey);
    integer(Number(p.next_line_id)+1);
    if (event.sourceEpoch === Number(p.source_epoch) && event.receiveSeq < Number(p.receive_seq)) throw new Error('stale-receive-seq');
    this.db.query('INSERT INTO na_line VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(id,event.sourceEpoch,p.next_line_id,
      Number(p.revision)+1,event.geometryGeneration,event.physicalRow.text,preparedCells??encodeCells(event.physicalRow.cells),
      +event.softWrap,'unchecked','awaiting-capture');
    this.db.query('UPDATE na_pane SET next_line_id=next_line_id+1,receive_seq=? WHERE pane_key=?').run(event.receiveSeq,id);
    this.db.query("UPDATE na_line SET check_reason='evicted-before-check',revision=? WHERE pane_key=? AND line_id=? AND check_state='unchecked'")
      .run(Number(p.revision)+1,id,Number(p.next_line_id)-4500);
    return this.bump(event.paneKey);
  }
  /** `uncertain`: capture rows drawn but not certified (D18); a pipe frame always clears them. */
  screen(frame: ProjectionFrame, captureId: string | null = null, at: number | null = null, observed: string[] = [], preparedCells?:string, uncertain: readonly number[] = []): void {
    if(preparedCells===undefined)validateFrame(frame);
    const p=this.ensure(frame.paneKey,frame.sourceEpoch,frame.geometryGeneration), id=paneId(frame.paneKey);
    this.db.query('INSERT INTO na_screen VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pane_key,screen_kind) DO UPDATE SET revision=excluded.revision,geometry_generation=excluded.geometry_generation,cols=excluded.cols,rows=excluded.rows,cells_json=excluded.cells_json,cursor_json=excluded.cursor_json,last_capture_id=excluded.last_capture_id,captured_at=excluded.captured_at,display_source=excluded.display_source,observed_fields_json=excluded.observed_fields_json,uncertain_rows_json=excluded.uncertain_rows_json')
      .run(id,frame.kind,Number(p.revision)+1,frame.geometryGeneration,frame.cols,frame.rows,preparedCells??encodeFrameCells(frame.cells),JSON.stringify(frame.cursor),captureId,at,captureId?'tmux-calibrated':'pipe',JSON.stringify(observed),JSON.stringify(uncertain));
    this.db.query('UPDATE na_pane SET cols=?,rows=?,screen_kind=? WHERE pane_key=?').run(frame.cols,frame.rows,frame.kind,id);
  }
  /** Revision the caller's CAS is compared with; a pane not yet seen is revision 0. */
  revisionOf(key: PaneKey): number {
    const row=this.db.query('SELECT revision FROM na_pane WHERE pane_key=?').get(paneId(key)) as SqlRow|null;
    return row?Number(row.revision):0;
  }
  /**
   * `casAtAdmission`: the store already compared expectedRevision when it
   * admitted the job (F12); jobs admitted earlier for the same pane then run
   * first by queue order, so the run-time revision is no longer the caller's.
   */
  recordIssue(issue: ProjectionIssueInput, nextEpoch?: number, casAtAdmission=false): ProjectionReceipt {
    const id=paneId(issue.paneKey);
    const p=(this.db.query('SELECT * FROM na_pane WHERE pane_key=?').get(id) as SqlRow|null)??this.ensure(issue.paneKey,issue.sourceEpoch,issue.geometryGeneration);
    if(!casAtAdmission && p.revision!==issue.expectedRevision)throw new Error('stale-revision');
    if(p.source_epoch!==issue.sourceEpoch || p.geometry_generation!==issue.geometryGeneration)throw new Error('stale-generation');
    integer(issue.boundaryLineId);
    if(issue.boundaryLineId>Number(p.next_line_id) || !issue.kind || !issue.reason || typeof issue.recoverable!=='boolean')throw new Error('invalid-issue');
    if(issue.missingCount!==null)integer(issue.missingCount);
    if(nextEpoch!==undefined) {
      integer(nextEpoch);if(nextEpoch<=Number(p.source_epoch))throw new Error('nonmonotonic-epoch');
      this.db.query('UPDATE na_pane SET source_epoch=?,receive_seq=-1 WHERE pane_key=?').run(nextEpoch,id);
    }
    this.db.query('INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(randomUUID(),id,nextEpoch??p.source_epoch,
      Number(p.revision)+1,issue.boundaryLineId,issue.kind,issue.reason,issue.missingCount,Date.now());
    this.db.query("UPDATE na_pane SET health=? WHERE pane_key=?").run(issue.recoverable?'degraded':'unverified',id);
    return this.bump(issue.paneKey);
  }
  /**
   * `historyOnly` (M2): without screen evidence nothing on screen is replaced,
   * and every checked or repaired history row is compared byte for byte below,
   * so rows and frames that arrived after the caller's read cannot make it
   * wrong. Only a revision the pane never had (from the future) is refused.
   */
  calibrate(change: ProjectionCalibration, historyOnly=false): ProjectionReceipt {
    const c=change.capture, p=this.pane(c.paneKey), id=paneId(c.paneKey);
    if (historyOnly ? change.expectedRevision > Number(p.revision) : p.revision !== change.expectedRevision) throw new Error('stale-revision');
    if (p.source_epoch !== c.sourceEpoch || p.geometry_generation !== c.geometryGeneration) throw new Error('stale-generation');
    validateFrame(c); c.history.forEach(validateRow);
    if (!c.captureId || !Number.isFinite(c.requestedAt) || !Number.isFinite(c.completedAt) || c.completedAt<c.requestedAt) throw new Error('invalid-capture');
    integer(c.firstHistoryRow); integer(c.ambiguousRows);
    const mapped=new Set<number>(), captureRows=new Set<number>();
    type Mutation={lineId:number;captureRow:number;repair:boolean;state:'checked'|'content-matched';keep?:boolean};
    const mutations:Mutation[]=[...change.repairs.map(r=>({...r,repair:true,state:'checked' as const})),
      ...change.checks.map(r=>({...r,repair:false,state:'checked' as const})),
      ...(change.contentMatches??[]).map(r=>({...r,repair:false,state:'content-matched' as const}))];
    let correctedCells=0;
    for(const m of mutations) {
      integer(m.lineId); integer(m.captureRow);
      if(mapped.has(m.lineId) || captureRows.has(m.captureRow) || !c.history[m.captureRow]) throw new Error('duplicate-or-invalid-mapping');
      mapped.add(m.lineId);captureRows.add(m.captureRow);
      const row=this.db.query('SELECT * FROM na_line WHERE pane_key=? AND line_id=?').get(id,m.lineId) as SqlRow | null;
      if(!row || row.source_epoch!==c.sourceEpoch || row.geometry_generation!==c.geometryGeneration) throw new Error('capture-line-generation');
      const expected=c.history[m.captureRow];
      if(m.repair) {
        const repair=m as typeof m & {physicalRow:PhysicalRow}; validateRow(repair.physicalRow);
        if(JSON.stringify(repair.physicalRow)!==JSON.stringify(expected)) throw new Error('repair-not-capture');
        const previous=decodeCells(String(row.cells_json));
        correctedCells+=expected.cells.filter((cell,i)=>JSON.stringify(cell)!==JSON.stringify(previous[i])).length;
      } else if(row.text!==expected.text || JSON.stringify(decodeCells(String(row.cells_json)))!==JSON.stringify(expected.cells)) throw new Error('check-not-exact');
      // A content match never downgrades an identity already proven by anchors.
      m.keep=m.state==='content-matched' && row.check_state==='checked';
    }
    // Hash one row at a time. The transient capture is never assembled into a
    // giant JSON value and there is no durable column capable of storing it.
    const screenHash=createHash('sha256'),historyHash=createHash('sha256');
    for(const cells of c.cells)screenHash.update(encodeCells(cells)).update('\n');
    for(const row of c.history)historyHash.update(row.text).update('\0').update(encodeCells(row.cells)).update('\n');
    this.db.query('INSERT INTO na_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.captureId,Number(p.revision)+1,c.sourceEpoch,c.requestedAt,c.completedAt,c.geometryGeneration,c.firstHistoryRow,c.history.length,screenHash.digest('hex'),historyHash.digest('hex'),JSON.stringify(c.observedFields),mapped.size,correctedCells,c.ambiguousRows,c.result);
    for(const m of mutations) {
      if(m.keep)continue;
      const expected=c.history[m.captureRow];
      // Changing content and its receipt is one transaction; no old label survives.
      this.db.query('UPDATE na_line SET revision=?,text=?,cells_json=?,check_state=?,check_reason=?,checked_capture_id=?,checked_row=? WHERE pane_key=? AND line_id=?')
        .run(Number(p.revision)+1,expected.text,encodeCells(expected.cells),m.state,m.state==='checked'?'exact-capture':'content-capture',c.captureId,m.captureRow,id,m.lineId);
    }
    const evidence=change.captureEvidence;
    if(evidence?.kind==='quiescent') {
      // FIX1 §1.2: stable metadata, no byte received while capturing, and the
      // revision CAS above (every pipe frame or row bumps the revision). The
      // capture becomes the displayed screen in this same transaction; the next
      // pipe frame renders over it again. The parser frame is never fed from it.
      integer(evidence.receiveSeqBefore);integer(evidence.receiveSeqAfter);
      if(evidence.sourceEpoch!==c.sourceEpoch || evidence.geometryGeneration!==c.geometryGeneration
        || evidence.receiveSeqBefore!==evidence.receiveSeqAfter)throw new Error('capture-not-quiescent');
      // §7.4 D18: uncertain emoji rows are drawn with the capture but kept apart
      // as not certified, never a reason to refuse the rest of the screen.
      const uncertain=[...new Set(evidence.uncertainRows??[])].sort((a,b)=>a-b);
      if(uncertain.some(r=>!Number.isSafeInteger(r) || r<0 || r>=c.rows))throw new Error('invalid-uncertain-rows');
      this.screen(c,c.captureId,c.completedAt,c.observedFields,undefined,uncertain);
    }
    // Without quiescent evidence (unfenced, null or absent) a capture checks history only, never the screen.
    return this.bump(c.paneKey);
  }
  /** Live pages only: eviction returns pages to the freelist, which page_count still counts (F13). */
  bytes(): number {
    const pages=this.db.query('PRAGMA page_count').get() as {page_count:number};
    const free=this.db.query('PRAGMA freelist_count').get() as {freelist_count:number};
    return (pages.page_count-free.freelist_count)*this.pageSize;
  }
  evict(panes: SqlRow[]): void {
    // Indexed ranges only for committed panes; never visit every resident line.
    for (const p of panes) {
      this.db.query(EVICT_LINES_SQL)
        .run(p.pane_key, Math.max(0, Number(p.next_line_id)-5000), p.revision);
      this.db.query(`DELETE FROM na_capture WHERE pane_key=? AND revision<=?
        AND NOT EXISTS(SELECT 1 FROM na_line l WHERE l.pane_key=na_capture.pane_key AND l.checked_capture_id=na_capture.capture_id)
        AND NOT EXISTS(SELECT 1 FROM na_screen s WHERE s.pane_key=na_capture.pane_key AND s.last_capture_id=na_capture.capture_id)`)
        .run(p.pane_key,p.revision);
      this.db.query('DELETE FROM na_issue WHERE pane_key=? AND revision<=?').run(p.pane_key,p.revision);
    }
  }
}
