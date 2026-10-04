import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FullPermit } from './prototype';
import { ReadViewCoordinator } from './read-view';
import { prepared, upsert } from '../../../src/sqlite-history/ram-store';
const coordinators = new WeakMap<object, ReadViewCoordinator>();
export function coordinator(store: any) {
  let c = coordinators.get(store);
  if (!c) {
    c = new ReadViewCoordinator(store); coordinators.set(store,c);
    const close = store.close.bind(store);
    store.close = async (...args:any[]) => { console.error('SPIKE2_P0_TELEMETRY', JSON.stringify(p0Stats(store))); await c!.close(); return close(...args); };
  }
  return c;
}
export const permit = new FullPermit();
const states = new WeakMap<object, any>();
let activePaneId: string | null = null, streaming = false;
export async function lifetime(pane:any, signal:AbortSignal, deadline:number, run:()=>Promise<void>) {
  return permit.run(JSON.stringify(pane.paneKey),signal,deadline,async()=> {
    const c=coordinator(pane.runtime.store), state={signal,deadline,c,view:null as any}; states.set(pane,state);
    try { activePaneId=pane.paneKey.paneId; c.scratch.set(0,2*1024*1024); await run(); }
    finally { try { await state.view?.release(); await c.rpc('finish',{}); } finally { c.scratch.set(0,0); c.scratch.set(3,0); activePaneId=null; states.delete(pane); } }
  });
}
export async function streamCapture(host:any, paneId:string, tail:number, rows:number, signal:AbortSignal,
  parse:(line:string)=>any, format:string, spawn:(argv:string[])=>any) {
  if(activePaneId!==paneId || streaming)throw new Error('capture without exclusive lifetime');
  const c=coordinator(host.store), nonce=randomUUID(), mark=(x:string)=>`␞P0${nonce}-${x}␞`;
  const args=['list-panes','-a','-F',mark('B')+format,';','display-message','-p','-t',paneId,mark('S'),';',
    'capture-pane','-p','-e','-N','-t',paneId,...(tail>0?['-S',`-${tail}`]:[]),';',
    'display-message','-p','-t',paneId,mark('E'),';','list-panes','-a','-F',mark('A')+format];
  const requestedAt=Date.now(), proc=spawn(host.argv(args)); streaming=true;
  const abort=()=>{try{proc.kill('SIGKILL');}catch{}}; signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const stderr=(async()=>{const r=proc.stderr.getReader();let out='';try{while(true){const p=await r.read();if(p.done)break;out+=new TextDecoder().decode(p.value).slice(0,4096-out.length);}}finally{r.releaseLock();}return out;})(), reader=proc.stdout.getReader(), utf8=new TextDecoder();
  let buffer='', phase='before', before:any, after:any, initialized=false;
  let body='';
  async function flushBody(){ if(body){const bytes=Buffer.from(body); for(let i=0;i<bytes.length;i+=65536)await c.rpc('bytes',{bytes:bytes.subarray(i,i+65536)});body='';} }
  async function line(text:string) {
    if(text.startsWith(mark('B')) || text.startsWith(mark('A'))) {
      const isBefore=text.startsWith(mark('B')), p=parse(text.slice(mark('B').length));
      if(p && p.server!==host.serverStamp)throw new Error('capture server identity changed');
      if(p?.paneId===paneId){if(isBefore)before=p.meta;else after=p.meta;} return;
    }
    if(text===mark('S')) {
      if(!before)throw new Error('capture before missing');
      if(before.cols>240 || before.rows>80)throw new Error('capture geometry budget');
      await c.rpc('begin',{cols:before.cols,path:join(host.store.options.historyRoot,`p0-${nonce}.spool`)});
      initialized=true;phase='body';return;
    }
    if(text===mark('E')){await flushBody();phase='after';return;}
    if(phase==='body'){body+=text+'\n';if(Buffer.byteLength(body)>=32768)await flushBody();}
  }
  try {
    while(true){const part=await reader.read();if(signal.aborted)throw new Error('capture aborted');if(part.done)break;
      if(part.value.byteLength>262144)throw new Error('capture transport chunk budget');
      buffer+=utf8.decode(part.value,{stream:true});let at:number;
      while((at=buffer.indexOf('\n'))>=0){const next=buffer.slice(0,at);buffer=buffer.slice(at+1);await line(next);}
      if(Buffer.byteLength(buffer)>65536)throw new Error('capture line budget');
    }
    buffer+=utf8.decode();if(buffer)await line(buffer);
    const code=await proc.exited, err=await stderr;
    if(code!==0 || !initialized || !after || phase!=='after')throw new Error(`capture framing/exit ${code}: ${err.slice(0,200)}`);
    const p0=await c.rpc('end',{rows:after.rows});
    host.counters.batches++;host.counters.captureRows+=p0.count+after.rows;
    return {captureId:nonce,requestedAt,completedAt:Date.now(),before,after,body:'',tail,p0};
  } catch(error){abort();await proc.exited;await stderr;throw error;}
  finally{streaming=false;signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function matchCapture(pane:any,capture:any,fence:any,read:any) {
  const state=states.get(pane);if(!state)throw new Error('P0 lifetime missing');
  state.view=await state.c.open(pane.paneKey,state.deadline,state.signal);
  if(state.view.token.sourceEpoch!==read.sourceEpoch || state.view.token.geometryGeneration!==read.geometryGeneration)throw new Error('P0 generation changed');
  return state.c.rpc('match',{lastLineId:fence.recentLastLineId??-1,complete:capture.completeRetainedTail});
}
/** A RAM commit is exposed immediately, before the next async chunk. The
 * callback owns COW hot repair and cannot be skipped on a later rejection. */
export async function commitChunks(pane:any,input:any) {
  const state=states.get(pane);if(!state)throw new Error('P0 lifetime missing');
  const store=pane.runtime.store,c=input.capture,meta=c.after;
  const mappings=[...input.checks.map((m:any)=>({...m,kind:'checks'})),...input.contentMatches.map((m:any)=>({...m,kind:'contentMatches'})),...input.repairs.map((m:any)=>({...m,kind:'repairs'}))]
    .sort((a:any,b:any)=>a.capturedRow-b.capturedRow);
  let receipt=store.token(pane.paneKey), expected=input.expectedRevision;
  const chunkRows=Math.max(1,Math.min(256,Math.floor(2*1024*1024/(meta.cols*512+2048))));
  const chunks=Math.max(1,Math.ceil(mappings.length/chunkRows));
  for(let i=0;i<chunks;i++) {
    if(state.signal.aborted || performance.now()>=state.deadline)throw new Error('P0 repair deadline');
    const subset=mappings.slice(i*chunkRows,(i+1)*chunkRows), rows=await state.c.rpc('rows',{indices:subset.map((m:any)=>m.capturedRow)});
    const cold=state.view?await state.c.rpc('hydrate',{ids:subset.map((m:any)=>m.lineId)}):{rows:[],receipts:[]};
    const capture={paneKey:pane.paneKey,sourceEpoch:meta.sourceEpoch,geometryGeneration:meta.geometryGeneration,receiveSeq:0,
      cells:c.frame.cells,kind:meta.kind,cols:meta.cols,rows:meta.rows,cursor:meta.cursor?{row:meta.cursor.y,col:meta.cursor.x,visible:meta.cursor.visible}:null,
      captureId:`${c.captureId}:p0:${i}`,requestedAt:c.requestedAt,completedAt:c.completedAt,firstHistoryRow:subset[0]?.capturedRow??0,
      history:rows,observedFields:[...c.observedFields],ambiguousRows:(c.uncertainHistoryRows?.length??0)+(c.uncertainScreenRows?.length??0),result:input.captureEvidence.kind};
    const change:any={capture,expectedRevision:expected,captureEvidence:i===chunks-1?input.captureEvidence:null,
      checks:[],contentMatches:[],repairs:[]};
    subset.forEach((m:any,j:number)=>change[m.kind].push({lineId:m.lineId,captureRow:j,...(m.kind==='repairs'?{physicalRow:rows[j]}:{})}));
    // Refresh only the admission CAS, never the frozen read view. Append may
    // advance the pane; each touched row must still equal the view below.
    expected=store.token(pane.paneKey).revision; change.expectedRevision=expected;
    const payload={change,cold}, bytes=Buffer.byteLength(JSON.stringify(payload))+512;
    receipt=await store.enqueue(pane.paneKey,payload,(p:any)=>{
      if(pane.closed || state.signal.aborted || performance.now()>=state.deadline)throw new Error('P0 repair cancelled before commit');
      const current=store.token(pane.paneKey);
      if(current.sourceEpoch!==meta.sourceEpoch || current.geometryGeneration!==meta.geometryGeneration || current.revision!==expected)throw new Error('stale-revision');
      if(input.captureEvidence.kind==='quiescent' && pane.received!==input.captureEvidence.receiveSeqAfter)throw new Error('stale-receive-fence');
      for(const row of p.cold.rows) {
        const present:any=prepared(store.ram.db,'SELECT * FROM na_line WHERE pane_no=? AND line_id=?').get(row.pane_no,row.line_id);
        if(present && (present.revision!==row.revision || present.cells!==row.cells || present.text!==row.text))throw new Error('stale-row-revision');
      }
      for(const row of p.cold.receipts)upsert(store.ram.db,'na_capture',row);
      for(const row of p.cold.rows)if(!prepared(store.ram.db,'SELECT 1 FROM na_line WHERE pane_no=? AND line_id=?').get(row.pane_no,row.line_id))upsert(store.ram.db,'na_line',row);
      return store.ram.calibrate(p.change,false);
    },'barrier',bytes);
    // This synchronous COW callback is adjacent to the committed receipt.
    const repairMap=new Map(subset.filter((m:any)=>m.kind==='repairs').map((m:any)=>[m.lineId,rows[subset.indexOf(m)].cells]));
    try {
      if(repairMap.size){pane.ring=pane.ring.map((r:any)=>repairMap.has(r.lineId)?Object.freeze({...r,cells:repairMap.get(r.lineId),ansiCache:{}}):r);pane.ringRepairs++;}
      const floor=pane.ring[0]?.lineId??0;
      for(const m of subset)if(m.lineId>=floor)pane.certified.add(m.lineId);
    } catch(error){pane.pendingHotRepair={captureId:c.captureId,chunk:i,revision:receipt.revision,ids:subset.map((m:any)=>m.lineId)};throw error;}
    state.c.scratch.set(3,c.p0ScreenCharge??0);
    expected=receipt.revision;
  }
  pane.countCapture();pane.lastStoreCommitAt=pane.runtime.now();pane.stats.storeCommits++;pane.skippedCommit=false;
  return receipt;
}
export function p0Stats(store:any){return {permit:permit.stats,scratch:coordinators.get(store)?.scratch.stats,readView:coordinators.get(store)?.stats};}
