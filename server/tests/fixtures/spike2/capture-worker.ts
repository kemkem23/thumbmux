import { ScratchLedger, rowCharge } from './scratch';
import { parentPort } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { closeSync, openSync, readSync, writeSync, unlinkSync } from 'node:fs';
import { CaptureChunkDecoder } from './decoder';
import { ExactRowTokens, matchTokens } from './prototype';
import { closePrepared, prepared, paneId, lineRow, encodeCells, decodeCells } from '../../../src/sqlite-history/ram-store';
import { readDiskLines } from '../../../src/sqlite-history/projection-reader';
import { projectionArchiveInternals } from '../../../src/sqlite-history/projection-store';
const MASK = 1 | 4 | 8 | 16 | 64 | 256;
let job: any = null;
let scratch = new ScratchLedger();
let db: Database | null = null, view: any = null, overlay = new Map<number, any>();
function releaseView() { if (db) { try { db.exec('ROLLBACK'); } finally { closePrepared(db); db = null; } } view = null; overlay.clear(); }
function finish() {
  releaseView();
  if (job) { closeSync(job.fd); unlinkSync(job.path); job.registry.close(); job = null; }
  scratch.set(1,0); scratch.set(4,0);
}
function physical(index: number) {
  const entry = job.entries[index]; if (!entry) throw new Error('capture row missing');
  const buffer = Buffer.alloc(entry.length);
  if (readSync(job.fd, buffer, 0, buffer.length, entry.offset) !== buffer.length) throw new Error('capture spool short read');
  const [text, cells] = JSON.parse(buffer.toString()); return { text, cells: decodeCells(cells) };
}
function accept(chunks: Iterable<any[]>) {
  for (const chunk of chunks) {
    job.maxDecoded = Math.max(job.maxDecoded, chunk.length);
    for (const row of chunk) {
      if (job.entries.length >= 5012) throw new Error('capture horizon exceeded');
      const cells = row.cells.map((c: any) => ({ ...c, fg: c.fg.replace(/^rgb:(\d+);(\d+);(\d+)$/, 'rgb:$1,$2,$3'), bg: c.bg.replace(/^rgb:(\d+);(\d+);(\d+)$/, 'rgb:$1,$2,$3') }));
      const text = cells.filter((c: any) => !c.continuation).map((c: any) => c.grapheme).join('');
      const data = Buffer.from(JSON.stringify([text, encodeCells(cells)]));
      if (job.bytes + data.length > 8 * 1024 * 1024) throw new Error('capture encoded spool exceeded');
      let wrote = 0;
      while (wrote < data.length) { const n = writeSync(job.fd, data, wrote, data.length-wrote, job.bytes+wrote); if (!n) throw new Error('capture short write'); wrote += n; }
      job.entries.push({ offset: job.bytes, length: data.length }); job.bytes += data.length;
      job.tokens.push(job.registry.intern({ cells: cells.map((c: any) => ({ ...c, style: c.style & MASK })), softWrap: false }));
      if (row.uncertain) job.uncertain.push(row.index);
    }
  }
}
function page(lo: number, hi: number) {
  if (!view || Date.now() >= view.wallDeadline || lo < view.start || hi > view.end || hi-lo > 256) throw new Error('view bounds/deadline');
  const size:any=prepared(db!, 'SELECT coalesce(sum(length(cast(cells as blob))+length(cast(text as blob))+1024),0) n FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<?').get(view.paneNo,lo,hi);
  const overlayBytes=Array.from(overlay.values()).filter((r:any)=>r.line_id>=lo && r.line_id<hi).reduce((n:number,r:any)=>n+r.cells.length*2+r.text.length*2+1024,0);
  scratch.set(1,(Number(size.n)+overlayBytes)*4+(hi-lo)*(job?.cols??240)*128);
  const result = new Map(readDiskLines(db!, view.paneNo, lo, hi).map(r => [Number(r.line_id), r]));
  for (let n=lo; n<hi; n++) {
    const disk: any = result.get(n), ram = overlay.get(n);
    if (disk && ram && disk.revision === ram.revision && Object.keys(ram).some(k => ram[k] !== disk[k])) throw new Error('equal revision integrity');
    if (ram && (!disk || ram.revision > disk.revision)) result.set(n, ram);
    const row: any = result.get(n);
    if (!row || row.revision > view.revision || Number(row.pane_no) !== view.paneNo) throw new Error('read-view-gap');
  }
  return [...result.values()].sort((a:any,b:any) => a.line_id-b.line_id);
}
parentPort!.on('message', ({ id, op, input }) => {
  try {
    let value: any;
    if (op === 'begin') {
      if (job) throw new Error('capture busy');
      scratch = new ScratchLedger(input.scratch);
      scratch.set(4, 10024*384+5012*384);
      if(input.cols>240)throw new Error('capture geometry budget');
      job = { path: input.path, fd: openSync(input.path, 'wx+', 0o600), bytes: 0, rawBytes: 0, cols:input.cols,
        entries: [], tokens: [], uncertain: [], maxDecoded: 0,
        decoder: new CaptureChunkDecoder(input.cols,65536,n=>scratch.set(1,n)), registry: new ExactRowTokens(input.path+'.exact') };
      value = true;
    } else if (op === 'bytes') {
      job.rawBytes += input.bytes.length;
      if (job.rawBytes > 8*1024*1024) throw new Error('capture raw budget');
      accept(job.decoder.write(input.bytes)); value = true;
    } else if (op === 'end') {
      accept(job.decoder.end());
      if(input.rows>80)throw new Error('capture screen budget');
      const count = job.entries.length, history = Math.max(0, count-input.rows);
      const screen=Array.from({length:count-history}, (_,i)=>physical(history+i).cells);
      job.screenCharge=screen.reduce((n:number,cells:any)=>n+rowCharge({cells}),0);scratch.set(3,job.screenCharge);
      value = { count: history, screen, screenCharge:job.screenCharge,
        uncertainHistory: job.uncertain.filter((i:number)=>i<history), uncertainScreen: job.uncertain.filter((i:number)=>i>=history).map((i:number)=>i-history),
        stats: { rawBytes:job.rawBytes, encodedBytes:job.bytes, maxDecoded:job.maxDecoded, exactBytes:job.registry.stats.diskBytes } };
      job.history = history;
    } else if (op === 'open') {
      if (view) throw new Error('read-view-busy');
      view = input.token;
      db = new Database(input.file, { readonly:true, strict:true });
      db.exec('PRAGMA cache_size=-2048; PRAGMA query_only=ON; BEGIN');
      const p:any = prepared(db,'SELECT * FROM na_pane WHERE pane_key=?').get(paneId(view.paneKey));
      const fence = Number(p?.revision ?? 0);
      if ((p && Number(p.pane_no)!==view.paneNo) || fence<view.durableRevision || fence>view.revision) throw new Error('read-view-fence');
      overlay = new Map(input.overlay.map((r:any)=>[Number(r.line_id),r]));
      value = {requestId:view.requestId,fence};
    } else if (op === 'match') {
      const recent:any[] = [], checked = new Set<number>();
      for (let lo=view.start; lo<view.end; lo+=256) for (const r of page(lo,Math.min(view.end,lo+256))) {
        // Canonical runtime deliberately uses softWrap=false for physical tmux rows.
        if (Number(r.source_epoch)!==view.sourceEpoch || Number(r.geometry_generation)!==view.geometryGeneration) { recent.length=0; continue; }
        if(Number(r.check_state)>0)checked.add(Number(r.line_id));
        const row = lineRow(r);
        recent.push({lineId:Number(r.line_id),sourceEpoch:Number(r.source_epoch),geometryGeneration:Number(r.geometry_generation),
          token:job.registry.intern({cells:row.cells as any,softWrap:false})});
      }
      const fenced = recent.filter(r=>r.lineId<=input.lastLineId);
      value = matchTokens(fenced, job.tokens.slice(0,job.history), {
        sourceEpoch:view.sourceEpoch,geometryGeneration:view.geometryGeneration,completeRetainedTail:input.complete,
        maxTailGap:recent.length-fenced.length+256, uncertainCapturedRows:new Set(job.uncertain.filter((i:number)=>i<job.history)) });
      value.checks = value.checks.filter((r:any)=>!checked.has(r.lineId));
      value.contentMatches = value.contentMatches.filter((r:any)=>!checked.has(r.lineId));
      value.repairs = value.repairs.map((r:any)=>({lineId:r.lineId,capturedRow:r.capturedRow}));
    } else if (op === 'rows') {
      if (input.indices.length>256) throw new Error('repair chunk too large');
      value = []; let charged=0;
      for(const index of input.indices){const row=physical(index); charged+=rowCharge(row)*2; scratch.set(3,(job.screenCharge??0)+charged); value.push(row);}
    } else if (op === 'hydrate') {
      if (input.ids.length>256) throw new Error('hydrate chunk too large');
      // Sparse lookups do not expand min..max into an unbounded range.
      const rows:any[]=[];
      const ids=[...new Set<number>(input.ids)].sort((a,b)=>a-b);
      for(let at=0;at<ids.length;) { const lo=ids[at]!; let hi=lo+1;at++;
        while(at<ids.length && ids[at]===hi && hi-lo<256){hi++;at++;}
        rows.push(...page(lo,hi));
      }
      const receipts = [...projectionArchiveInternals.captureReceipts(db!, view.paneNo, rows.filter(r=>r.checked_capture_id!==null).map(r=>String(r.checked_capture_id))).values()];
      scratch.set(3, scratch.stats.charged[3]! + Buffer.byteLength(JSON.stringify({rows,receipts}))*4);
      value = { rows, receipts };
    } else if (op === 'page') {
      value = page(input.lo,input.hi).map(raw=>({raw,physical:lineRow(raw)}));
    } else if (op === 'release') { if (view?.requestId===input.requestId) releaseView(); value=true;
    } else if (op === 'finish' || op === 'close') { finish(); value=true;
    } else throw new Error('unknown capture operation');
    parentPort!.postMessage({id,value});
  } catch (error) { if(op==='open')releaseView(); parentPort!.postMessage({id,error:String(error)}); }
});
