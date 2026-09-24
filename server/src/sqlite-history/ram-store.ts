import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { PROJECTION_SCHEMA } from './schema';
import type { PaneKey, PhysicalRow, ProjectionCalibration, ProjectionFrame, ProjectionReceipt, ProjectionToken, ScrollEvent } from './types';

// Schema 2's UNIQUE(pane_key,line_id) is sqlite_autoindex_na_line_2.
// Pin that range: the revision index otherwise walks every durable resident row.
export const EVICT_LINES_SQL='DELETE FROM na_line INDEXED BY sqlite_autoindex_na_line_2 WHERE pane_key=? AND line_id<? AND revision<=?';

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
    const last=runs.at(-1);
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
  db.query(sql).run(...Object.values(row));
}

/** Only the bounded live working set lives here. Disk history is never loaded wholesale. */
export class ProjectionRam {
  readonly db = new Database(':memory:', {strict:true});
  constructor() { this.db.exec('PRAGMA foreign_keys=ON; PRAGMA cache_size=-262144;'); this.db.exec(PROJECTION_SCHEMA);this.db.exec('CREATE INDEX na_line_capture ON na_line(pane_key,checked_capture_id)'); }
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
    this.db.query(`INSERT OR IGNORE INTO na_pane
      (pane_key,session_uuid,server_identity,pane_id,birth_generation,source_epoch,geometry_generation,cols,rows,screen_kind)
      VALUES (?,?,?,?,?,?,?,0,0,'normal')`).run(id,randomUUID(),key.serverIdentity,key.paneId,key.birthGeneration,epoch,geometry);
    const p=this.pane(key);
    if (epoch < Number(p.source_epoch) || geometry < Number(p.geometry_generation)) throw new Error('stale-generation');
    if (epoch > Number(p.source_epoch)) this.db.query('INSERT INTO na_issue VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(
      randomUUID(),id,epoch,Number(p.revision)+1,p.next_line_id,'gap','source-epoch-changed',null,Date.now());
    this.db.query('UPDATE na_pane SET source_epoch=?,geometry_generation=?,receive_seq=? WHERE pane_key=?').run(epoch,geometry,epoch>Number(p.source_epoch)?-1:p.receive_seq,id);
    return this.pane(key);
  }
  bump(key: PaneKey): ProjectionReceipt {
    const p=this.pane(key); integer(Number(p.revision)+1);
    this.db.query('UPDATE na_pane SET revision=revision+1 WHERE pane_key=?').run(paneId(key));
    const {revision,durableRevision,nextLineId}=this.token(key);
    return {revision,durableRevision,nextLineId};
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
  screen(frame: ProjectionFrame, captureId: string | null = null, at: number | null = null, observed: string[] = []): void {
    validateFrame(frame);
    const p=this.ensure(frame.paneKey,frame.sourceEpoch,frame.geometryGeneration), id=paneId(frame.paneKey);
    this.db.query('INSERT INTO na_screen VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pane_key,screen_kind) DO UPDATE SET revision=excluded.revision,geometry_generation=excluded.geometry_generation,cols=excluded.cols,rows=excluded.rows,cells_json=excluded.cells_json,cursor_json=excluded.cursor_json,last_capture_id=excluded.last_capture_id,captured_at=excluded.captured_at,display_source=excluded.display_source,observed_fields_json=excluded.observed_fields_json')
      .run(id,frame.kind,Number(p.revision)+1,frame.geometryGeneration,frame.cols,frame.rows,encodeFrameCells(frame.cells),JSON.stringify(frame.cursor),captureId,at,captureId?'tmux':'pipe',JSON.stringify(observed));
    this.db.query('UPDATE na_pane SET cols=?,rows=?,screen_kind=? WHERE pane_key=?').run(frame.cols,frame.rows,frame.kind,id);
  }
  calibrate(change: ProjectionCalibration): ProjectionReceipt {
    const c=change.capture, p=this.pane(c.paneKey), id=paneId(c.paneKey);
    if (p.revision !== change.expectedRevision) throw new Error('stale-revision');
    if (p.source_epoch !== c.sourceEpoch || p.geometry_generation !== c.geometryGeneration) throw new Error('stale-generation');
    validateFrame(c); c.history.forEach(validateRow);
    if (!c.captureId || !Number.isFinite(c.requestedAt) || !Number.isFinite(c.completedAt) || c.completedAt<c.requestedAt) throw new Error('invalid-capture');
    integer(c.firstHistoryRow); integer(c.ambiguousRows);
    const mapped=new Set<number>(), captureRows=new Set<number>();
    const mutations=[...change.repairs.map(r=>({...r,repair:true})),...change.checks.map(r=>({...r,repair:false}))];
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
    }
    this.db.query('INSERT INTO na_capture VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.captureId,Number(p.revision)+1,c.sourceEpoch,c.requestedAt,c.completedAt,c.geometryGeneration,c.firstHistoryRow,c.history.length,JSON.stringify(c.cells),JSON.stringify(c.history),mapped.size,correctedCells,c.ambiguousRows,c.result);
    for(const m of mutations) {
      const expected=c.history[m.captureRow];
      // Changing content and its receipt is one transaction; no old label survives.
      this.db.query("UPDATE na_line SET revision=?,text=?,cells_json=?,check_state='checked',check_reason='exact-capture',checked_capture_id=?,checked_row=? WHERE pane_key=? AND line_id=?")
        .run(Number(p.revision)+1,expected.text,encodeCells(expected.cells),c.captureId,m.captureRow,id,m.lineId);
    }
    this.screen(c,c.captureId,c.completedAt,c.observedFields);
    return this.bump(c.paneKey);
  }
  bytes(): number {
    const pages=this.db.query('PRAGMA page_count').get() as {page_count:number};
    const size=this.db.query('PRAGMA page_size').get() as {page_size:number};
    return pages.page_count*size.page_size;
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
