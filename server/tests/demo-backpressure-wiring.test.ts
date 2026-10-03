import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxWsMux } from "@thumbmux/server";

test("demo forwards Bun websocket drain events to TmuxWsMux", async () => {
  const historyRoot = await mkdtemp(join(tmpdir(), "thumbmux-demo-wiring-"));
  const previousHistoryRoot = process.env.THUMBMUX_HISTORY_ROOT;
  process.env.THUMBMUX_HISTORY_ROOT = historyRoot;
  let registered: any;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: any) => {
    registered = options;
    return {} as any;
  }) as typeof Bun.serve);
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const handleDrainSpy = spyOn(TmuxWsMux.prototype, "handleDrain").mockImplementation(() => {});

  try {
    await import("../../demo/serve.ts");

    const drain = registered?.websocket?.drain;
    expect(drain).toBeFunction();
    if (typeof drain !== "function") return;

    const ws = { send: () => 1 };
    drain(ws);

    expect(handleDrainSpy).toHaveBeenCalledTimes(1);
    expect(handleDrainSpy).toHaveBeenLastCalledWith(ws);
  } finally {
    handleDrainSpy.mockRestore();
    logSpy.mockRestore();
    serveSpy.mockRestore();
    if (previousHistoryRoot === undefined) delete process.env.THUMBMUX_HISTORY_ROOT;
    else process.env.THUMBMUX_HISTORY_ROOT = previousHistoryRoot;
    await rm(historyRoot, { recursive: true, force: true });
  }
});

// Lot I: native shared Python J -> C streaming pages -> real SQLite H -> D.
// No mock H receipts or VT frame/row arrays can conceal a seam failure here.
import { StreamRuntime, StreamVtTransport } from '../src/stream-runtime';
import { STREAM_BUDGET, type StreamIdentity } from '../src/stream-contract';
const streamTestIdentity: StreamIdentity = {pane:{serverIdentity:'isolated-i',paneId:'%1',birthGeneration:1},sourceEpoch:1,geometryGeneration:0};
const streamPorts = {
  visible: async () => ({status:'error' as const,code:'unsupported' as const,message:'no tmux oracle in this fixture'}),
  async *repairChunks() { yield {status:'error' as const,code:'unresolved-gap' as const,message:'no recovery source in fixture'}; },
  syncRepair: async (): Promise<never> => { throw Error('unexpected repair'); },
  verifyRepair: async () => false,
  repairedCheckpoint: async () => ({status:'error' as const,code:'unresolved-gap' as const,message:'no checkpoint'}),
  cancelOperation: async () => {},
};
test('stream I native C-H-D: quiet attach, bounded pages, disconnect, checkpoint reopen', async () => {
  const root = await mkdtemp(join(tmpdir(),'stream-i-'));
  let runtime = new StreamRuntime({path:join(root,'stream.sqlite')});
  try {
    let pane = await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
    await pane.ingest(Buffer.from(Array.from({length:620},(_,i)=>`row-${i}\r\n`).join('')));
    const head = pane.frame.head;
    expect(head).toBeGreaterThan(600);
    expect(pane.frame.durableRevision).toBe(pane.frame.revision);
    const route={viewerId:'v',identity:pane.identity,routeGeneration:1};
    let calls=0;
    expect((await pane.attach(route,()=>calls++)).status).toBe('ok');
    expect(calls).toBe(1); // quiet pane, no input is needed to resolve attach
    const request={requestId:'all',identity:pane.identity,routeGeneration:1,
      range:{start:0,end:head},deadlineMonoMs:performance.now()+STREAM_BUDGET.readDeadlineMs};
    let cursor: import('../src/stream-contract').PageCursor|null=null;
    const texts:string[]=[];
    do {
      const page=await pane.page(route,request,cursor,256,{isCancelled:()=>false});
      if(page.status!=='ok')throw Error(JSON.stringify(page));
      texts.push(...page.value.fragments.map(f=>f.row.cells.map(c=>c.text).join('').trimEnd()));
      cursor=page.value.nextAfter;
    }while(cursor);
    expect(texts).toEqual(Array.from({length:head},(_,i)=>`row-${i}`));
    await pane.detach('v');
    expect(pane.stats().display.attachedViewers).toBe(0);
    expect(pane.stats().history.pins).toBe(0);
    await runtime.close();
    runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
    pane=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
    expect(pane.frame.head).toBe(head);
    expect((await pane.attach({viewerId:'reopened',identity:pane.identity,routeGeneration:2},()=>{})).status).toBe('ok');
    await pane.detach('reopened');
    await pane.ingest(Buffer.from('after-reopen\r\n'));
    expect(pane.frame.head).toBe(head+1);
    expect(pane.frame.durableRevision).toBe(pane.frame.revision);
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);

test('stream I atomic multi-page input retries an admitted prefix without duplicate rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-prefix-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try{
  const pane=await runtime.add(streamTestIdentity,{columns:80,rows:80},streamPorts,true);
  await pane.ingest(Buffer.from(Array.from({length:80},(_,i)=>String.fromCharCode(65+i%26).repeat(80)).join('\r\n')));
  const beforeHead=pane.frame.head,beforeRevision=pane.frame.revision;
  const history=runtime.history!,append=history.appendFinalized.bind(history);let calls=0;
  history.appendFinalized=async request=>{
   calls++;
   if(calls===2)return{status:'busy',reason:'pressure',retryAfterMs:1};
   return append(request);
  };
  await pane.ingest(Buffer.from('\x1b[2J'));
  expect(calls).toBeGreaterThan(3);
  expect(pane.frame.head).toBe(beforeHead+80);
  expect(pane.frame.revision).toBeGreaterThan(beforeRevision+1);
  expect(pane.frame.durableRevision).toBe(pane.frame.revision);
  expect(history.stats().ownedPendingBytes).toBe(0);
  expect(runtime.scratch.heldBytes).toBe(0);
  expect(runtime.admission.heldBytes).toBe(0);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);

test('stream I viewer admission is global across panes and releases on disconnect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-viewers-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try{
  const a=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  const b=await runtime.add({...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%2'}},{columns:20,rows:4},streamPorts);
  for(let i=0;i<STREAM_BUDGET.panes;i++)expect((await a.attach({viewerId:`v${i}`,identity:a.identity,routeGeneration:1},()=>{})).status).toBe('ok');
  const route={viewerId:'overflow',identity:b.identity,routeGeneration:1};
  expect((await b.attach(route,()=>{})).status).toBe('busy');
  await a.detach('v0');expect((await b.attach(route,()=>{})).status).toBe('ok');
  expect(b.stats().display.attachedViewers).toBe(STREAM_BUDGET.panes);
  expect((await a.attach({viewerId:'v1',identity:a.identity,routeGeneration:-1},()=>{})).status).toBe('error');
  expect(b.stats().display.attachedViewers).toBe(STREAM_BUDGET.panes-1);
  expect((await a.attach({viewerId:'v1',identity:a.identity,routeGeneration:2},()=>{})).status).toBe('ok');
  expect(b.stats().display.attachedViewers).toBe(STREAM_BUDGET.panes);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);


import { TmuxWsMux as SourceMux, type TmuxDriver, type MuxProjectionSource } from '../src/ws-mux';
for (const completion of ['resolve','reject'] as const) {
 for (const transition of ['route','rejoin','stop','current'] as const) {
  test(`stream I async history ${completion} is fenced across ${transition}`, async () => {
   let resolve!: (page: unknown) => void, reject!: (error: Error) => void;
   const pending = new Promise<unknown>((yes,no) => { resolve=yes; reject=no; });
   let generation=1;
   const projection: MuxProjectionSource = {
    owns:()=>true, ownsPipe:()=>true, snapshot:()=>null, routeGeneration:()=>generation,
    watch:()=>()=>{}, onRouteChange:()=>()=>{}, readBefore:()=>pending, readAfter:()=>pending,
   };
   const driver: TmuxDriver = {
    listSessions:()=>[], capturePane:async()=>'', sendKeys:()=>{}, getSessionActivity:()=>new Map(),
    getHistoryLimit:()=>0, setSessionHistoryLimit:()=>{}, resizeWindow:()=>{}, hash:s=>s,
   };
   const messages: Array<{type:string;data:string}>=[];
   const ws={send:(raw:string)=>{messages.push(JSON.parse(raw));return raw.length;}};
   const keeper={send:(raw:string)=>raw.length};
   const mux=new SourceMux({driver,projection,logError:()=>{}});
   try {
    mux.subscribe('pane',keeper); mux.subscribe('pane',ws);
    mux.expandHistory('pane',ws,null,20);
    if(transition==='route')generation++;
    if(transition==='stop')mux.stop();
    if(transition==='rejoin'){mux.unsubscribe('pane',ws);mux.subscribe('pane',ws);}
    if(completion==='resolve')resolve({lines:['current row'],startLine:0,hasMore:false});
    else reject(Error('history read failed'));
    // Drain both the success callback and its rejection handler, without timers.
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const replies=messages.filter(m=>m.type==='history'||m.type==='error');
    expect(replies).toHaveLength(transition==='current'?1:0);
    if(transition==='current') {
     expect(replies[0]!.type).toBe(completion==='resolve'?'history':'error');
     if(completion==='resolve')expect(JSON.parse(replies[0]!.data).lines).toEqual(['current row']);
     else expect(replies[0]!.data).toBe('history_temporarily_unavailable');
    }
   } finally { mux.unsubscribeAll(ws);mux.unsubscribeAll(keeper);mux.stop(); }
  });
 }
}

import { StreamSourceTransport } from '../../../../src/integrations/stream-source-transport';
import { StreamPipeHost } from '../../../../src/integrations/stream-pipe-host';

test('stream I shared worker death replays full parser state for both panes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-worker-recovery-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try {
  const a=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  const b=await runtime.add({...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%2'}},{columns:20,rows:4},streamPorts);
  a.stopCadence();b.stopCadence();
  await a.ingest(Buffer.from('a0\r\na1\r\na2\r\na3\r\n\x1b[3'));
  await b.ingest(Buffer.concat([Buffer.from('b0\r\nb1\r\nb2\r\nb3\r\n'),Buffer.from('ก').subarray(0,2)]));
  const oldPid=a.rpc.pid!;
  expect(b.rpc.pid).toBe(oldPid);
  const done=(a.rpc as any).lease.done as Promise<void>;
  process.kill(oldPid,'SIGKILL');await done;
  await a.ingest(Buffer.from('1mRED\r\n'));
  await b.ingest(Buffer.concat([Buffer.from('ก').subarray(2),Buffer.from('\r\n')]));
  expect(a.rpc.pid).not.toBe(oldPid);expect(b.rpc.pid).toBe(a.rpc.pid);
  const text=(pane:typeof a)=>pane.frame.changedRows.map(r=>r.content.cells.map(c=>c.text).join('').trimEnd());
  expect(text(a)).toEqual(['a2','a3','RED','']);
  expect(text(b)).toEqual(['b2','b3','ก','']);
  expect(a.frame.changedRows[2]!.content.cells[0]!.style).toContain(31);
  expect(a.frame.head).toBe(2);expect(b.frame.head).toBe(2);
  expect(a.frame.durableRevision).toBe(a.frame.revision);
  expect(b.frame.durableRevision).toBe(b.frame.revision);
  expect(runtime.history!.stats().ownedPendingBytes).toBe(0);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);

test('stream I lost J reply retries the same event without duplicate durable rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-rpc-retry-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try {
  const pane=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  pane.stopCadence();
  await pane.ingest(Buffer.from('r0\r\nr1\r\nr2\r\nr3\r\n'));
  const lease=(pane.rpc as any).lease;
  const write=lease.socket.write.bind(lease.socket);
  let killed=false;
  lease.socket.write=(packet:Buffer,...rest:any[])=>{
   const result=write(packet,...rest);
   if(!killed&&packet[0]===74){killed=true;lease.kill('SIGKILL');}
   return result;
  };
  await pane.ingest(Buffer.from('r4\r\n'));
  expect(killed).toBe(true);expect(pane.frame.head).toBe(2);
  const route={viewerId:'retry-reader',identity:pane.identity,routeGeneration:1};
  expect((await pane.attach(route,()=>{})).status).toBe('ok');
  const page=await pane.page(route,{requestId:'retry-rows',identity:pane.identity,routeGeneration:1,
   range:{start:0,end:2},deadlineMonoMs:performance.now()+1000},null,256,{isCancelled:()=>false});
  if(page.status!=='ok')throw Error(JSON.stringify(page));
  expect(page.value.fragments.map(f=>f.row.cells.map(c=>c.text).join('').trimEnd())).toEqual(['r0','r1']);
  await pane.detach(route.viewerId);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);

test('stream I source retirement waits for child exit AND consumer settlement, fences reuse',async()=>{
 let exit!: (code:number)=>void, release!:()=>void, entered!:()=>void;
 const reached=new Promise<void>(resolve=>{entered=resolve;});
 const consumer=new Promise<void>(resolve=>{release=resolve;});
 let kills=0;
 const transport=new StreamSourceTransport({tmuxSocket:'/private/test.sock',spawnCapture:()=>({
  stdout:new ReadableStream({start(controller){controller.enqueue(Buffer.from('sealed row'));}}),
  stderr:new ReadableStream(),exited:new Promise<number>(resolve=>{exit=resolve;}),kill:()=>{kills++;},
 })});
 const controller=new AbortController();
 const read=transport.read(['capture-pane','-p','-t','%1'],controller.signal,1024,async()=>{entered();await consumer;});
 const rejected=read.then(()=>false,()=>true);
 await reached;controller.abort();
 let retired=false;
 const retirement=transport.cancelOperation(controller.signal).then(()=>{retired=true;});
 await Promise.resolve();expect(kills).toBe(1);expect(retired).toBe(false);
 exit(137);await Promise.resolve();await Promise.resolve();expect(retired).toBe(false);
 release();await retirement;expect(await rejected).toBe(true);
 expect(transport.activeOperations).toBe(0);
 await expect(transport.read(['capture-pane','-p'],controller.signal,1024,()=>{})).rejects.toThrow('retired');
 await transport.close();
});

test('stream I source read enforces byte budget and reaps before rejecting',async()=>{
 let kills=0,exit!:(code:number)=>void;
 const transport=new StreamSourceTransport({tmuxSocket:'/private/test.sock',spawnCapture:()=>({
  stdout:new ReadableStream({start(c){c.enqueue(new Uint8Array(1025));c.close();}}),
  stderr:new ReadableStream({start(c){c.close();}}),
  exited:new Promise<number>(resolve=>{exit=resolve;}),kill:()=>{kills++;exit(137);},
 })});
 let deliveries=0;
 await expect(transport.read(['capture-pane','-p'],new AbortController().signal,1024,()=>{deliveries++;})).rejects.toThrow('byte budget');
 expect(deliveries).toBe(0);expect(kills).toBe(1);expect(transport.activeOperations).toBe(0);
 await transport.close();
});

test('stream I host joins row continuations and rejects oversized wire pages, releasing viewer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-wire-page-'));
 const host=new StreamPipeHost({root,tmuxSocket:'/private/unused.sock'});
 let calls=0,detaches=0,oversize=false;
 const fake={frame:{head:1,identity:streamTestIdentity},
  attach:async()=>({status:'ok'}),detach:async()=>{detaches++;},
  page:async()=>{
   const second=++calls%2===0;
   const content=oversize?'x'.repeat(STREAM_BUDGET.pageBytesPerViewer):second?'B':'A';
   return{status:'ok',value:{fragments:[{row:{id:{lineId:0},cells:[{text:content,width:1,style:[]}]},
    startCell:second?1:0,endCell:second?2:1,complete:false}],
    nextAfter:second?null:{requestId:'page',direction:'after',lineId:0,cellOffset:1}}};
  }};
 (host as any).entries.set('test',{pane:fake,route:'newarch',generation:1,off:()=>{}});
 try {
  const page=await host.projection.readBefore('test',null,20) as {lines:string[]};
  expect(page.lines.map(x=>x.replace(/\x1b\[[0-9;]*m/g,''))).toEqual(['AB']);
  expect(detaches).toBe(1);
  oversize=true;
  await expect(host.projection.readBefore('test',null,20) as Promise<unknown>).rejects.toThrow('byte budget');
  expect(detaches).toBe(2);expect((host as any).pageBytes).toBe(0);
 }finally{(host as any).entries.clear();await host.close();await rm(root,{recursive:true,force:true});}
});

test('stream I C visible cancellation reaps its real source child without killing the shared VT',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-source-retire-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 const source=new StreamSourceTransport({tmuxSocket:'/private/injected.sock',spawnCapture:argv=>{
  expect(argv.slice(0,3)).toEqual(['tmux','-S','/private/injected.sock']);
  const proc=Bun.spawn(['python3','-c','import sys,time; sys.stdout.write("ready\\n"); sys.stdout.flush(); time.sleep(60)'],{stdout:'pipe',stderr:'pipe'});
  child=proc;return proc;
 }});
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try {
  const pane=await runtime.add(streamTestIdentity,{columns:20,rows:4},{...streamPorts,
   visible:async(_identity,_tail,signal)=>{
    await source.read(['capture-pane','-p','-t','%1'],signal,1024,()=>{});
    return{status:'error',code:'io',message:'unexpected source completion'};
   },cancelOperation:signal=>source.cancelOperation(signal),
  });
  pane.stopCadence();const pid=pane.rpc.pid;
  const verdict=await pane.capture.checkVisible(pane.identity);
  expect(verdict.status).toBe('error');
  if(verdict.status==='error')expect(verdict.code).toBe('deadline');
  await source.close();await new Promise(resolve=>setTimeout(resolve,0));
  expect(child).toBeDefined();expect(await child!.exited).not.toBe(0);
  expect(()=>process.kill(child!.pid,0)).toThrow();
  expect(source.activeOperations).toBe(0);expect(runtime.scratch.heldBytes).toBe(0);
  await pane.ingest(Buffer.from('still alive'));
  expect(pane.rpc.pid).toBe(pid);
  expect(pane.frame.changedRows[0]!.content.cells.map(c=>c.text).join('').trimEnd()).toBe('still alive');
 }finally{await source.close();await runtime.close();await rm(root,{recursive:true,force:true});}
},10000);

test('stream I bootstrap also needs saved cursor when no escape sequence is pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-saved-cursor-evidence-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try {
  const a=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  const b=await runtime.add({...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%2'}},{columns:20,rows:4},streamPorts);
  a.stopCadence();b.stopCadence();
  // All sequences are complete. capture-pane -P cannot recover this hidden
  // state: it exposes unfinished escape bytes, not DEC saved cursor state.
  await a.ingest(Buffer.from('\x1b[2;2H\x1b7\x1b[HBASE'));
  await b.ingest(Buffer.from('\x1b[3;3H\x1b7\x1b[HBASE'));
  expect(a.frame.changedRows).toEqual(b.frame.changedRows);
  expect(a.frame.cursor).toEqual(b.frame.cursor);
  expect(a.frame.head).toBe(b.frame.head);
  await a.ingest(Buffer.from('\x1b8X'));
  await b.ingest(Buffer.from('\x1b8X'));
  expect(a.frame.changedRows[1]!.content.cells[1]!.text).toBe('X');
  expect(b.frame.changedRows[2]!.content.cells[2]!.text).toBe('X');
  expect(a.frame.changedRows).not.toEqual(b.frame.changedRows);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},10000);


test('stream I RPC retirement waits for a late pool acquire and lease release',async()=>{
 const rpc=new StreamVtTransport();
 let acquire!:(lease:any)=>void,release!:()=>void;
 const released=new Promise<void>(resolve=>{release=resolve;});
 const pool={acquire:()=>new Promise<any>(resolve=>{acquire=resolve;})};
 const started=rpc.start(pool as any,{columns:20,rows:4},1).then(()=>false,()=>true);
 let retired=false,destroyed=false;
 const retirement=rpc.retire().then(()=>{retired=true;});
 await Promise.resolve();await Promise.resolve();expect(retired).toBe(false);
 acquire({socket:{destroy:()=>{destroyed=true;}},release:()=>released});
 await Promise.resolve();await Promise.resolve();expect(destroyed).toBe(true);expect(retired).toBe(false);
 release();await retirement;expect(await started).toBe(true);expect(retired).toBe(true);
});

test('stream I bootstrap cannot reconstruct pending parser state from identical visible rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-bootstrap-evidence-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try {
  const a=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  const b=await runtime.add({...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%2'}},{columns:20,rows:4},streamPorts);
  a.stopCadence();b.stopCadence();
  await a.ingest(Buffer.from('BASE\x1b[3'));
  await b.ingest(Buffer.from('BASE\x1b[4'));
  const visible=(pane:typeof a)=>({rows:pane.frame.changedRows,cursor:pane.frame.cursor,
   geometry:pane.frame.geometry,buffer:pane.frame.buffer,head:pane.frame.head});
  // A stable screenshot, cursor, geometry and retained-row count cannot
  // distinguish these states. The differing prefix predates a newly opened
  // pipe, so receive-side sequence numbers cannot supply it either.
  expect(visible(a)).toEqual(visible(b));
  const ca=await a.drain(),cb=await b.drain();
  expect(ca).not.toBeNull();expect(cb).not.toBeNull();
  expect(ca!.state).not.toEqual(cb!.state);
  await a.ingest(Buffer.from('1mX'));
  await b.ingest(Buffer.from('1mX'));
  const cell=(pane:typeof a)=>pane.frame.changedRows[0]!.content.cells[4]!;
  expect(cell(a).text).toBe('X');expect(cell(b).text).toBe('X');
  expect(cell(a).style).toContain(31);
  expect(cell(b).style).toContain(41);
  expect(cell(a)).not.toEqual(cell(b));
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},10000);

// ---------------------------------------------------------------------------
// F14 (REPAIR-PLAN §2/§6): the 13 "stream I" cases that stood here drove the
// DESIGN-I3 StreamPipeHost, which is no longer the flag-on path (10-I keeps it
// importable only). They failed on the K base for that reason (05-A: 13 fail).
// Each is replaced by a behavioural case on FlagOnPipeHost/S/A below; the map
// is in orchestrator-runs/…/t-fix/REPORT.md §F14:
//   catalog publishes only committed intervals      → T-fix 05-A catalog v3, B2-03
//   rollback bridge / host rollback / handoff never  → T-fix B2-03, OFF-01
//     ends silently / flag-off freezes a tenure
//   source EOF fails closed (contradicts B3)         → T-fix B3-02 (retained, irrecoverable)
//   catalog v1 artifacts migrate                     → T-fix R20 (kept guards + typed pending)
//   flag off runs nothing without a tenure           → T-fix OFF-01
//   real pipe prehistory/full history/clear-history  → T-fix S-06, B1-03, B3-02 (dup/order/silent oracle)
//   real pipe EOF / unproven writer stays PREPARED   → T-fix B3-02, B2-03
// ---------------------------------------------------------------------------
import { StreamArchiveCatalog } from '../../../../src/integrations/stream-archive-bridge';
import { Database } from 'bun:sqlite';
import { writeFileSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync as mkdirSyncFs } from 'node:fs';
import { ARCHIVE_CATALOG_VERSION } from '../../../../src/integrations/stream-archive-bridge';
const plain=(line:string)=>line.replace(/\x1b\[[0-9;]*m/g,'');
const fixturePane=(id:string)=>({serverIdentity:'/fixture.sock#S1',paneId:id,birthGeneration:7});
/** Load a catalog dumped by the real v1 code (see the fixture header). */
function v1Catalog(dir:string,name:'pre-r5'|'r5',copy='a'):string{
  const path=join(dir,`${name}-${copy}.sqlite`),db=new Database(path,{create:true});
  db.exec(readFileSync(join(import.meta.dir,'fixtures',`stream-archive-catalog-v1-${name}.sql`),'utf8'));db.close();
  return path;
}

test('T-fix R20 v1 catalogs (round 4/5) migrate once into a typed pending state: no fabricated PREPARED proof; read-only open refuses; a corrupt row leaves the artifact untouched',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tfix-r20-'));
  try{
    for(const name of ['pre-r5','r5'] as const){
      const path=v1Catalog(dir,name);
      expect(()=>new StreamArchiveCatalog(path,true)).toThrow('must be migrated');
      const catalog=new StreamArchiveCatalog(path);
      try{
        expect(catalog.owner(fixturePane('%1'))).toMatchObject({route:'legacy',generation:2,globalStart:10});
        // %3 held a v1 PREPARED rollback with no fence proof: the migrated
        // state is legacy-unverified-pending with a readable prefix, never a
        // PreparedHandoff and never an error that sends I to a fresh prepare.
        const pending=await catalog.recoverPending(fixturePane('%3'),{isCancelled:()=>false});
        console.log(`T-fix R20 ${name} recoverPending(%3) ${JSON.stringify(pending).slice(0,300)}`);
        expect(pending.status).toBe('ok');
        if(pending.status==='ok')expect(String(pending.value.kind)).toBe('legacy-unverified-pending');
        const none=await catalog.recoverPending(fixturePane('%9'),{isCancelled:()=>false});
        expect(none.status==='ok'?String(none.value.kind):none.status).toBe('none');
      }finally{catalog.close();}
      const db=new Database(path,{readonly:true});
      expect(db.query('SELECT version FROM sa_format').get()).toEqual({version:ARCHIVE_CATALOG_VERSION});
      db.close();
      new StreamArchiveCatalog(path).close();
    }
    const path=v1Catalog(dir,'pre-r5','corrupt');
    const db=new Database(path);db.query("UPDATE sa_owner SET digest='00' WHERE instr(pane,'\"%2\"')>0").run();db.close();
    const before=readFileSync(path);
    expect(()=>new StreamArchiveCatalog(path)).toThrow('checksum');
    expect(readFileSync(path).equals(before)).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
},30000);
// ---------------------------------------------------------------------------
// T11 (NEWARCH flag-on lot 11-T) — independent oracle + adversarial fixtures.
// The oracle never calls matcher/stitch/product code: expected timelines are
// literal producer events; verdicts are literal violation codes. Product-side
// integration (B1-02/B1-03/B2-03/B3-02/OFF-01 against S/C/H/A/W wired by I) is
// NOT claimed here — those cases are registered below as pending until I lands.
// The region between the markers is self-contained so MUTATION runs can copy it.
// ---------------------------------------------------------------------------
// T11-ORACLE-BEGIN
type T11Expected = { readonly text: string; readonly epoch: string };
type T11Actual =
  | { readonly kind: 'row'; readonly pane: string; readonly epoch: string; readonly text: string }
  | { readonly kind: 'gap'; readonly pane: string; readonly positioned: boolean;
      readonly countKind: 'exact' | 'estimate' | 'unknown'; readonly missingCount: number | null; readonly lowerBound: number };
type T11Mode = 'normal' | 'planned' | 'fault' | 'recoverable';
type T11Verdict = { readonly violations: readonly string[]; readonly matched: number; readonly missing: number; readonly covered: number };

/** Longest strictly increasing subsequence; returns the kept positions. */
function t11Lis(values: readonly number[]): Set<number> {
  const tails: number[] = []; const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[tails[mid]!]! < values[i]!) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const kept = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) kept.add(i);
  return kept;
}

/** Judge one pane's product timeline against the producer's literal events. */
function t11JudgeTimeline(pane: string, expected: readonly T11Expected[], actual: readonly T11Actual[], mode: T11Mode): T11Verdict {
  const v = new Set<string>();
  const occurrences = new Map<string, number[]>();
  expected.forEach((e, i) => occurrences.set(e.text, [...(occurrences.get(e.text) ?? []), i]));
  const matchOf = new Array<number>(actual.length).fill(-1); // actual index -> expected index
  const misplaced = new Set<number>(); // expected events present but out of order
  const rowIdx: number[] = [];
  actual.forEach((a, i) => {
    if (a.pane !== pane) { v.add('cross-pane'); return; }
    if (a.kind === 'row') rowIdx.push(i);
    else if (!a.positioned) v.add('unpositioned-gap');
  });
  // 1. Unique texts are anchors (producer-stamped IDs); order = LIS over expected index.
  const anchors = rowIdx.filter(i => (occurrences.get((actual[i] as { text: string }).text)?.length ?? 0) === 1);
  const anchorExp = anchors.map(i => occurrences.get((actual[i] as { text: string }).text)![0]!);
  const kept = t11Lis(anchorExp);
  const usedExp = new Set<number>();
  anchors.forEach((ai, k) => { if (kept.has(k)) { matchOf[ai] = anchorExp[k]!; usedExp.add(anchorExp[k]!); } });
  // 2. Repeated (unstamped) texts: count-preserving in-order match between anchors.
  const boundaries = [-1, ...anchors.filter((_, k) => kept.has(k)), actual.length];
  for (let b = 0; b + 1 < boundaries.length; b++) {
    const lo = boundaries[b]!, hi = boundaries[b + 1]!;
    const eLo = lo < 0 ? -1 : matchOf[lo]!, eHi = hi >= actual.length ? expected.length : matchOf[hi]!;
    let cursor = eLo + 1;
    for (let i = lo + 1; i < hi; i++) {
      const a = actual[i]!;
      if (a.kind !== 'row' || a.pane !== pane || (occurrences.get(a.text)?.length ?? 0) < 2) continue;
      let e = cursor;
      while (e < eHi && (expected[e]!.text !== a.text || usedExp.has(e))) e++;
      if (e < eHi) { matchOf[i] = e; usedExp.add(e); cursor = e + 1; }
    }
  }
  // 3. Every unmatched row is a duplicate, an order violation or an extra.
  for (const i of rowIdx) {
    if (matchOf[i]! >= 0) { if ((actual[i] as { epoch: string }).epoch !== expected[matchOf[i]!]!.epoch) v.add('wrong-epoch'); continue; }
    const owners = occurrences.get((actual[i] as { text: string }).text);
    if (!owners) v.add('extra');
    else if (owners.every(e => usedExp.has(e))) v.add('duplicate');
    else { v.add('order'); misplaced.add(owners.find(e => !usedExp.has(e))!); }
  }
  // 4. Missing runs need a positioned gap strictly between their matched neighbours.
  const posOfExp = new Map<number, number>();
  matchOf.forEach((e, i) => { if (e >= 0) posOfExp.set(e, i); });
  const gapAt = (lo: number, hi: number) => actual.some((a, i) => i > lo && i < hi && a.kind === 'gap' && a.pane === pane && a.positioned);
  const present = (e: number) => usedExp.has(e) || misplaced.has(e);
  let missing = 0, covered = 0;
  for (let e = 0; e < expected.length; e++) {
    if (present(e)) continue;
    let end = e; while (end + 1 < expected.length && !present(end + 1)) end++;
    const run = end - e + 1; missing += run;
    const lo = e === 0 ? -1 : posOfExp.get(e - 1)!;
    const hi = end + 1 >= expected.length ? actual.length : posOfExp.get(end + 1)!;
    if (gapAt(lo, hi)) covered += run; else v.add('silent-missing');
    e = end;
  }
  // 5. Count claims: grouped per interval between matched rows.
  const matchedPos = [...posOfExp.values()].sort((a, b) => a - b);
  const groups = new Map<string, { gaps: Extract<T11Actual, { kind: 'gap' }>[]; missing: number }>();
  actual.forEach((a, i) => {
    if (a.kind !== 'gap' || a.pane !== pane || !a.positioned) return;
    const lo = [...matchedPos].reverse().find(p => p < i) ?? -1;
    const hi = matchedPos.find(p => p > i) ?? actual.length;
    const eLo = lo < 0 ? -1 : matchOf[lo]!, eHi = hi >= actual.length ? expected.length : matchOf[hi]!;
    let m = 0; for (let e = eLo + 1; e < eHi; e++) if (!present(e)) m++;
    const key = `${lo}:${hi}`;
    const g = groups.get(key) ?? { gaps: [], missing: m }; g.gaps.push(a); groups.set(key, g);
  });
  for (const { gaps, missing: m } of groups.values()) {
    for (const g of gaps) {
      if (g.countKind === 'unknown' && g.missingCount !== null) v.add('unknown-as-number');
      if (g.countKind !== 'unknown' && g.missingCount === null) v.add('known-count-null');
    }
    if (gaps.every(g => g.countKind === 'exact') && gaps.reduce((s, g) => s + (g.missingCount ?? 0), 0) !== m) v.add('exact-count-wrong');
    if (gaps.reduce((s, g) => s + g.lowerBound, 0) > m) v.add('lower-bound-exceeds');
  }
  // 6. Mode: normal/planned allow no gap and no loss; a recoverable fixture must recover.
  if (mode === 'normal' || mode === 'planned') {
    if (actual.some(a => a.kind === 'gap')) v.add('gap-in-normal');
    if (missing) v.add('missing-in-normal');
  }
  if (mode === 'recoverable' && missing) v.add('not-recovered');
  return { violations: [...v].sort(), matched: usedExp.size, missing, covered };
}

/** Raw spool replay judge: exact bytes, one epoch, contiguous offsets from 0. */
function t11JudgeRawReplay(oracle: Uint8Array, epoch: string,
  records: readonly { readonly epoch: string; readonly start: number; readonly end: number; readonly bytes: Uint8Array }[]): string[] {
  const v = new Set<string>(); let offset = 0;
  for (const r of records) {
    if (r.epoch !== epoch) { v.add('wrong-epoch'); continue; }
    if (r.end - r.start !== r.bytes.length) v.add('length-mismatch');
    if (r.start > offset) v.add('offset-hole');
    if (r.start < offset) v.add('offset-overlap');
    for (let i = 0; i < r.bytes.length; i++) if (oracle[r.start + i] !== r.bytes[i]) { v.add('byte-mismatch'); break; }
    offset = Math.max(offset, r.end);
  }
  if (offset < oracle.length) v.add('short');
  if (offset > oracle.length) v.add('long');
  return [...v].sort();
}

/** S's independent raw oracle (02-S evidence/fixture-vectors.json), regenerated. */
function t11RawOracle(): Uint8Array {
  const parts: string[] = ['\x1b[31m'];
  for (let i = 0; i < 4608; i++) parts.push((i === 101 || i === 102 ? 'REPEATED' : `${String(i).padStart(5, '0')}: กข界 é`) + '\r\n');
  parts.push('\x1b[0mEND');
  const text = new TextEncoder().encode(parts.join(''));
  const out = new Uint8Array(text.length + 2); out.set(text); out.set([0x00, 0xff], text.length);
  return out;
}

const t11Ev = (n: number, epoch = 'e1') => ({ text: `EV${String(n).padStart(5, '0')}`, epoch });
const t11Row = (n: number, epoch = 'e1', pane = 'p1'): T11Actual => ({ kind: 'row', pane, epoch, text: `EV${String(n).padStart(5, '0')}` });
const t11Gap = (countKind: 'exact' | 'estimate' | 'unknown', missingCount: number | null, lowerBound = 0, positioned = true): T11Actual =>
  ({ kind: 'gap', pane: 'p1', positioned, countKind, missingCount, lowerBound });
const t11Range = (a: number, b: number, epoch = 'e1') => Array.from({ length: b - a + 1 }, (_, i) => t11Row(a + i, epoch));

/** Adversarial timelines with literal verdicts. Expected codes are hand-written. */
function t11TimelineFixtures(): { name: string; mode: T11Mode; expected: T11Expected[]; actual: T11Actual[]; violations: string[] }[] {
  const base = Array.from({ length: 100 }, (_, i) => t11Ev(i + 1));
  // Two identical adjacent events (101,102 in S's raw oracle) carry no stamp.
  const rep: T11Expected[] = [t11Ev(1), t11Ev(2), { text: 'REPEATED', epoch: 'e1' }, { text: 'REPEATED', epoch: 'e1' }, t11Ev(3)];
  const r = (text: string): T11Actual => ({ kind: 'row', pane: 'p1', epoch: 'e1', text });
  return [
    { name: 'clean exact timeline', mode: 'normal', expected: base, actual: t11Range(1, 100), violations: [] },
    { name: 'duplicate stamped row', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(50), ...t11Range(51, 100)], violations: ['duplicate'] },
    { name: 'two rows swapped', mode: 'fault', expected: base, actual: [...t11Range(1, 49), t11Row(51), t11Row(50), ...t11Range(52, 100)], violations: ['order'] },
    { name: 'prefix exact, suffix reordered (no prefix-only check)', mode: 'fault', expected: base, actual: [...t11Range(1, 60), t11Row(99), ...t11Range(61, 98), t11Row(100)], violations: ['order'] },
    { name: 'one row silently dropped', mode: 'fault', expected: base, actual: [...t11Range(1, 40), ...t11Range(42, 100)], violations: ['silent-missing'] },
    { name: 'Q21: 13 lost under an unknown positioned gap', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('unknown', null), ...t11Range(54, 100)], violations: [] },
    { name: 'Q21: exact 13 (>5) accepted', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('exact', 13, 13), ...t11Range(54, 100)], violations: [] },
    { name: 'gap drawn at the wrong place', mode: 'fault', expected: base, actual: [...t11Range(1, 40), ...t11Range(54, 70), t11Gap('unknown', null), ...t11Range(71, 100)], violations: ['silent-missing'] },
    { name: 'unknown encoded as 0', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('unknown', 0), ...t11Range(54, 100)], violations: ['unknown-as-number'] },
    { name: 'exact count off by one', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('exact', 12, 12), ...t11Range(54, 100)], violations: ['exact-count-wrong'] },
    { name: 'estimate lower bound above real loss', mode: 'fault', expected: base, actual: [...t11Range(1, 40), t11Gap('estimate', 20, 20), ...t11Range(54, 100)], violations: ['lower-bound-exceeds'] },
    { name: 'session-wide marker without position', mode: 'fault', expected: base, actual: [t11Gap('unknown', null, 0, false), ...t11Range(1, 40), ...t11Range(54, 100)], violations: ['silent-missing', 'unpositioned-gap'] },
    { name: 'EOF tail dropped silently', mode: 'fault', expected: base, actual: t11Range(1, 80), violations: ['silent-missing'] },
    { name: 'EOF tail dropped behind a trailing gap', mode: 'fault', expected: base, actual: [...t11Range(1, 80), t11Gap('unknown', null)], violations: [] },
    { name: 'normal path may not use a gap even with nothing lost', mode: 'normal', expected: base, actual: [...t11Range(1, 50), t11Gap('unknown', null), ...t11Range(51, 100)], violations: ['gap-in-normal'] },
    { name: 'planned switch loss hidden behind a gap', mode: 'planned', expected: base, actual: [...t11Range(1, 50), t11Gap('exact', 2, 2), ...t11Range(53, 100)], violations: ['gap-in-normal', 'missing-in-normal'] },
    { name: 'recoverable fixture answered with a gap', mode: 'recoverable', expected: base, actual: [...t11Range(1, 50), t11Gap('unknown', null), ...t11Range(60, 100)], violations: ['not-recovered'] },
    { name: 'cross-pane row leaked in', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(51, 'e1', 'p2'), ...t11Range(51, 100)], violations: ['cross-pane'] },
    { name: 'old-epoch callback row accepted', mode: 'fault', expected: base, actual: [...t11Range(1, 50), t11Row(51, 'e0'), ...t11Range(52, 100)], violations: ['wrong-epoch'] },
    { name: 'foreign text appended', mode: 'fault', expected: base, actual: [...t11Range(1, 100), r('ghost')], violations: ['extra'] },
    { name: 'identical adjacent events both kept', mode: 'normal', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('REPEATED'), r('EV00003')], violations: [] },
    { name: 'identical adjacent events collapsed (Set(text) dedup)', mode: 'fault', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('EV00003')], violations: ['silent-missing'] },
    { name: 'identical adjacent events tripled', mode: 'fault', expected: rep, actual: [r('EV00001'), r('EV00002'), r('REPEATED'), r('REPEATED'), r('REPEATED'), r('EV00003')], violations: ['duplicate'] },
  ];
}

/** Raw replay adversaries cut at S's split points. */
function t11RawFixtures(oracle: Uint8Array) {
  const cuts = [0, 1, 2, 7, 16383, 16384, 32769, oracle.length - 1, oracle.length];
  const clean = cuts.slice(0, -1).map((start, i) => ({ epoch: 'E1', start, end: cuts[i + 1]!, bytes: oracle.slice(start, cuts[i + 1]!) }));
  const flipped = clean.map(r => ({ ...r, bytes: r.bytes.slice() })); flipped[5]!.bytes[0]! ^= 0x01;
  return [
    { name: 'clean split replay', records: clean, violations: [] as string[] },
    { name: 'dropped chunk', records: clean.filter((_, i) => i !== 4), violations: ['offset-hole'] },
    { name: 'duplicated chunk', records: [...clean.slice(0, 5), clean[4]!, ...clean.slice(5)], violations: ['offset-overlap'] },
    { name: 'reordered chunks', records: [clean[0]!, clean[2]!, clean[1]!, ...clean.slice(3)], violations: ['offset-hole', 'offset-overlap'] },
    { name: 'flipped byte', records: flipped, violations: ['byte-mismatch'] },
    { name: 'chunk from another epoch', records: clean.map((r, i) => i === 3 ? { ...r, epoch: 'E0' } : r), violations: ['offset-hole', 'wrong-epoch'] },
    { name: 'truncated tail (no fake EOF)', records: clean.slice(0, -1), violations: ['short'] },
    { name: 'length field lies', records: clean.map((r, i) => i === 6 ? { ...r, end: r.end + 1 } : r), violations: ['length-mismatch', 'offset-overlap'] },
  ];
}

/** Throws on the first verdict that differs from its literal expectation. */
function t11OracleSelfTest(): string[] {
  const names: string[] = [];
  for (const f of t11TimelineFixtures()) {
    const got = t11JudgeTimeline('p1', f.expected, f.actual, f.mode).violations.join(',');
    if (got !== f.violations.join(',')) throw new Error(`T11 timeline fixture "${f.name}": expected [${f.violations}] got [${got}]`);
    names.push(f.name);
  }
  const oracle = t11RawOracle();
  for (const f of t11RawFixtures(oracle)) {
    const got = t11JudgeRawReplay(oracle, 'E1', f.records).join(',');
    if (got !== f.violations.join(',')) throw new Error(`T11 raw fixture "${f.name}": expected [${f.violations}] got [${got}]`);
    names.push(f.name);
  }
  return names;
}
// T11-ORACLE-END

import { createHash as t11Hash } from 'node:crypto';
import { spawnSync as t11Spawn } from 'node:child_process';
import { mkdtempSync as t11Mkdtemp, rmSync as t11Rm } from 'node:fs';
import { streamDigest as t11Digest } from '../src/stream-contract';
import type * as T11F from '../src/stream-contract';

test('T11 oracle: S raw-byte oracle regenerates byte-identical (02-S fixture-vectors sha256)', () => {
  const oracle = t11RawOracle();
  // Literals copied from 02-S evidence/fixture-vectors.json, not computed here.
  expect(oracle.length).toBe(101366);
  expect(t11Hash('sha256').update(oracle).digest('hex')).toBe('a6f1410f58b27671f03a10dbf359514983318b02c9a7f87201e7cb55d1c3b2b8');
  const lines = Buffer.from(oracle).toString('utf8').split('\r\n');
  expect(lines[101]).toBe('REPEATED');
  expect(lines[102]).toBe('REPEATED');
  expect(lines.length - 1).toBe(4608);
});

test('T11 oracle: every adversarial timeline and raw replay gets its literal verdict', () => {
  const names = t11OracleSelfTest();
  expect(names.length).toBe(23 + 8);
});

test('T11 oracle: Q21 >5 loss is accepted only when located; unknown stays null; normal path stays loss 0', () => {
  const base = Array.from({ length: 30 }, (_, i) => t11Ev(i + 1));
  const lost = [...t11Range(1, 5), t11Gap('unknown', null), ...t11Range(26, 30)];
  const verdict = t11JudgeTimeline('p1', base, lost, 'fault');
  expect(verdict).toEqual({ violations: [], matched: 10, missing: 20, covered: 20 });
  expect(t11JudgeTimeline('p1', base, lost, 'normal').violations).toEqual(['gap-in-normal', 'missing-in-normal']);
});

// Oracle mutants: each damages one rule in an isolated copy of the region above;
// the self-test must exit 1 (instrument proven able to see the failure class).
const T11_ORACLE_MUTANTS: Record<string, [string, string]> = {
  'order-blind (accept every anchor)': ['const kept = t11Lis(anchorExp);', 'const kept = new Set(anchorExp.map((_, k) => k));'],
  'gap-anywhere covers any loss': ['if (gapAt(lo, hi)) covered += run;', 'if (gapAt(-1, actual.length)) covered += run;'],
  'unknown may be 0': ["if (g.countKind === 'unknown' && g.missingCount !== null)", "if (g.countKind === 'unknown' && g.missingCount !== null && g.missingCount !== 0)"],
  'Set(text) presence instead of event identity': ['const present = (e: number) => usedExp.has(e) || misplaced.has(e);', 'const present = (e: number) => rowIdx.some(i => (actual[i] as { text: string }).text === expected[e]!.text);'],
  'normal mode tolerates gaps': ["if (mode === 'normal' || mode === 'planned') {", "if (false) {"],
  'raw replay ignores epoch': ["if (r.epoch !== epoch) { v.add('wrong-epoch'); continue; }", ''],
  'raw replay accepts a short spool as EOF': ["if (offset < oracle.length) v.add('short');", ''],
};
for (const [mutation, [from, to]] of Object.entries(T11_ORACLE_MUTANTS)) {
  test(`T11 MUTATION oracle "${mutation}" turns the self-test red in an isolated copy`, () => {
    const self = readFileSync(import.meta.path, 'utf8');
    const begin = self.indexOf('// T11-ORACLE-BEGIN'), end = self.indexOf('// T11-ORACLE-END');
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const region = self.slice(begin, end);
    expect(region.split(from).length).toBe(2);
    const dir = t11Mkdtemp(join(tmpdir(), 't11-oracle-mutant-'));
    try {
      for (const damaged of [false, true]) {
        const script = join(dir, `scenario-${damaged}.ts`);
        writeFileSync(script, `${damaged ? region.replace(from, to) : region}\nt11OracleSelfTest();\n`);
        const r = t11Spawn(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
        console.log(`T11 MUTATION oracle ${mutation} damaged=${damaged} exit=${r.status} ${(r.stderr ?? '').split('\n').find(l => l.startsWith('error:')) ?? ''}`);
        expect(r.status).toBe(damaged ? 1 : 0);
      }
    } finally { t11Rm(dir, { recursive: true, force: true }); }
  });
}

// ---- Cases S and A handed to T (02-S/05-A REPORT "งานที่ยังไม่ครบ"). They run
// unconditionally (T-fix): a missing API is a red assertion, never a skip.
const t11Pane: T11F.PaneKey = { serverIdentity: 't11-server', paneId: '%7', birthGeneration: 1 };
const t11Sha = (s: string) => t11Hash('sha256').update(s).digest('hex');
const t11Epoch: T11F.PipeEpoch = { pane: t11Pane, attachId: 't11-attach', collectorIncarnation: 't11-collector' };
const t11File = (path: string, body: string): T11F.EvidenceFile => ({ path, bytes: Buffer.byteLength(body), sha256: t11Sha(body) });
const t11Intent: T11F.AttachIntent = { operationId: 't11-op', pane: t11Pane, expectedGeneration: 0, attachId: 't11-attach', episodeId: 't11-episode', parentEpisodeId: null, kind: 'recovery', rootUUID: 't11-root' };
const t11UnknownGap: T11F.Gap = { version: 1, episodeId: 't11-episode', parentEpisodeId: null, pane: t11Pane, leftRowId: { pane: t11Pane, segmentId: 't11-seg', rowOrdinal: 7 }, rightSegmentId: 't11-seg-2', reason: 'unproven-overlap', countKind: 'unknown', missingCount: null, withheldRows: 3, lowerBound: 0, openedAt: 10, closedAt: null, clockEpoch: 't11-clock', quality: 'degraded' };
const t11Coverage: T11F.Coverage = [
  { kind: 'rows', range: { pane: t11Pane, segmentId: 't11-seg', start: 0, end: 8 }, digest: t11Sha('rows-0-8') },
  { kind: 'gap', gap: t11UnknownGap, digest: t11Sha('gap-unknown') },
];
const t11Commit: T11F.CommitAttachRequest = {
  operationId: 't11-op', pane: t11Pane, expectedGeneration: 0, attachId: 't11-attach', admission: 'active-degraded',
  binding: { kind: 'collector-binding', epoch: t11Epoch, attachId: 't11-attach', rootUUID: 't11-root', bootNonce: 't11-collector', ownerGeneration: 0, process: { pid: 4242, startTime: '777', bootId: 't11-boot' }, peerUid: 1000, fifoId: 't11-fifo', handshakeId: 't11-handshake', artifactSha256: t11Sha('artifact') },
  packet: { version: 1, snapshotId: 't11-snap', episodeId: 't11-episode', captureCount: 1, complete: true, pane: t11Pane, geometry: { columns: 80, rows: 24 }, geometryGeneration: 1, historySize: 4500, historyLimit: 4500, cursor: { x: 0, y: 23, visible: true }, activeBuffer: 'normal', mainHistory: 'available', snapshot: t11File('snap.bin', 'snap'), commandTranscript: t11File('transcript.txt', 'pipe-open;capture-start;capture-end'), rawRange: { epoch: t11Epoch, start: 0, end: 64 }, boundary: { kind: 'overlap-unknown', reason: 'split-command' }, startedAtMonoMs: 1, endedAtMonoMs: 2, clockEpoch: 't11-clock', stateKnown: { savedCursor: false } },
  durable: { kind: 'rows-gaps-durable', operationId: 't11-op', commitId: 't11-rows-commit', generation: 1, coverage: t11Coverage, digest: t11Sha('rows-gaps') },
};

/** Synthetic authority adapter: answers from an evidence store and a lease
 * registry on disk, never by echoing the request (05-A MUTATION.md demand). */
function t11Authorities(root: string) {
  const read = (name: string) => {
    const path = join(root, 'evidence', name);
    if (!existsSync(path)) throw new Error(`T11 authority: no evidence ${name}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const same = <T>(kind: string, stored: T, offered: unknown): T => {
    if (t11Digest(kind, stored) !== t11Digest(kind, offered)) throw new Error(`T11 authority: ${kind} differs from durable evidence`);
    return stored;
  };
  return {
    attach: (r: T11F.CommitAttachRequest) => same('attach', read(`attach-${r.attachId}.json`), r),
    prefix: (i: T11F.HandoffIntent) => read(`prefix-${i.handoffId}.json`) as T11F.Coverage,
    suffix: (p: T11F.SuffixPin) => same('suffix', read(`suffix-${p.pin.pinId}.json`), p),
    receipt: (r: T11F.CommitHandoffRequest) => same('receipt', read(`receipt-${r.receipt.receipt.handoffId}.json`), r.receipt),
    writer: (b: T11F.WriterBinding) => {
      if (!(read('leases.json').live as string[]).includes(b.bindingId)) throw new Error('T11 authority: writer lease not live');
      return same('writer', read(`writer-${b.bindingId}.json`), b);
    },
    remote: (_s: T11F.SealedExport, v: T11F.VerifiedBundle) => same('remote', read(`remote-${v.bundle.bundleId}.json`), v),
    location: (r: T11F.SegmentRowRange) => read(`location-${r.segmentId}.json`) as T11F.SegmentLocation,
  };
}

test('T-fix 05-A catalog v3: intent never publishes owner; stale CAS/handshake refused; lost ACK idempotent; abort cannot delete a committed owner; unknown gap stays null', async () => {
  const root = t11Mkdtemp(join(tmpdir(), 't11-catalog-'));
  try {
    mkdirSyncFs(join(root, 'evidence'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'attach-t11-attach.json'), JSON.stringify(t11Commit));
    writeFileSync(join(root, 'evidence', 'leases.json'), JSON.stringify({ live: [] }));
    const path = join(root, 'catalog-v3.sqlite');
    const Catalog = StreamArchiveCatalog as unknown as new (path: string, readOnly: boolean, authorities: unknown) => any;
    let catalog = new Catalog(path, false, t11Authorities(root));
    const first = await catalog.beginAttach(t11Intent);
    expect(first.status).toBe('ok');
    expect(catalog.owner(t11Pane)).toBeNull();
    expect(await catalog.beginAttach(t11Intent)).toEqual(first);
    expect((await catalog.beginAttach({ ...t11Intent, attachId: 'competing' })).status).toBe('error');
    expect((await catalog.commitAttach({ ...t11Commit, expectedGeneration: 999 })).status).toBe('error');
    expect((await catalog.commitAttach({ ...t11Commit, binding: { ...t11Commit.binding, handshakeId: '' } })).status).toBe('error');
    // The adapter reads evidence: a request whose capture differs from what was durable is refused.
    expect((await catalog.commitAttach({ ...t11Commit, packet: { ...t11Commit.packet, snapshotId: 'forged' } })).status).toBe('error');
    expect(catalog.owner(t11Pane)).toBeNull();
    const committed = await catalog.commitAttach(t11Commit);
    expect(committed.status).toBe('ok');
    const owner = catalog.owner(t11Pane);
    expect(owner?.generation).toBe(t11Intent.expectedGeneration + 1);
    catalog.close(); catalog = new Catalog(path, false, t11Authorities(root));
    expect(await catalog.commitAttach(t11Commit)).toEqual(committed);
    expect(await catalog.abortAttach({ ...t11Intent, reason: 'lost-ACK' })).toEqual(committed);
    expect(catalog.owner(t11Pane)).toEqual(owner);
    // Same operation id, different request digest = collision, not a silent retry.
    expect((await catalog.commitAttach({ ...t11Commit, admission: 'active-exact' })).status).toBe('error');
    const retry = { ...t11Intent, operationId: 'recovery', attachId: 'recovery', episodeId: 'recovery', expectedGeneration: owner.generation };
    expect((await catalog.beginAttach(retry)).status).toBe('ok');
    const aborted = await catalog.abortAttach({ ...retry, reason: 'pipe-refused' });
    expect(aborted.status).toBe('ok');
    expect(catalog.owner(t11Pane)).toEqual(owner);
    expect(await catalog.abortAttach({ ...retry, reason: 'duplicate-callback' })).toEqual(aborted);
    const coverage = catalog.readCoverage(t11Pane).coverage as T11F.Coverage;
    expect(coverage).toEqual(t11Coverage);
    const gap = coverage.find(c => c.kind === 'gap');
    expect(gap?.kind === 'gap' && gap.gap.missingCount).toBeNull();
    catalog.close();
  } finally { t11Rm(root, { recursive: true, force: true }); }
});

test('T-fix 05-A remote index: upload exit 0 without verified readback is refused; offline location is remote-unavailable, never EOF', async () => {
  const root = t11Mkdtemp(join(tmpdir(), 't11-remote-'));
  try {
    mkdirSyncFs(join(root, 'evidence'), { recursive: true });
    const range: T11F.SegmentRowRange = { pane: t11Pane, segmentId: 't11-seg', start: 0, end: 8 };
    const offline: T11F.SegmentLocation = { kind: 'remote-unavailable', range, bundleId: 't11-bundle', reason: 'offline', retryAfterMs: 1000 };
    writeFileSync(join(root, 'evidence', 'location-t11-seg.json'), JSON.stringify(offline));
    const Catalog = StreamArchiveCatalog as unknown as new (path: string, readOnly: boolean, authorities: unknown) => any;
    const catalog = new Catalog(join(root, 'catalog-v3.sqlite'), false, t11Authorities(root));
    const location = await catalog.getLocation(range);
    expect(location.status === 'ok' ? location.value.kind : location.status).not.toBe('local');
    if (location.status === 'ok') expect(location.value).toEqual(offline);
    const bundle = { version: 1, bundleId: 't11-bundle-unverified' } as unknown as T11F.ArchiveBundle;
    const unverified = await Promise.resolve().then(() => catalog.commitRemoteIndex({ operationId: 't11-remote', pane: t11Pane, expectedGeneration: 1, sealed: {} as T11F.SealedExport, verified: { bundle } as T11F.VerifiedBundle })).catch((error: unknown) => ({ status: 'thrown', error }));
    expect(unverified.status).not.toBe('ok');
    catalog.close();
  } finally { t11Rm(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T-fix (NEWARCH flag-on repair round 1, REPAIR-PLAN §6). The 12 S-vectors and
// four integration entries that were test.todo now execute against the real
// path: a private tmux server (explicit -S socket, never the default server),
// the real collector process (FlagOnCollectorSupervisor → stream-spool-service),
// the real FlagOnSourceTransport pipe command (F1 is caught here, T never writes
// its own attach pipe), and FlagOnPipeHost with real H/A/W stores under a tmp
// root. The oracle is the producer's own event log written outside the PTY
// before each line, judged by t11JudgeTimeline over the public projection pages.
// A case red on the K base is red at its behavioural assertion; the reason
// printed by each failing step is part of the evidence (no sleep-guessing:
// producer barriers are files, host progress is polled against the oracle).
// ---------------------------------------------------------------------------
import { FlagOnPipeHost, FlagOnCollectorSupervisor, FlagOnHistoryReadback } from '../../../../src/integrations/stream-pipe-host';
import { FlagOnSourceTransport } from '../../../../src/integrations/stream-source-transport';
import { StreamSpoolClient as FxSpoolClient } from '../../../../src/integrations/stream-spool-client';
import { openSync as fxOpen, writeSync as fxWrite, closeSync as fxClose, renameSync as renameSyncFs, readlinkSync as readlinkSyncFs } from 'node:fs';

const FX_PRODUCER = String.raw`import os, sys, time
d, tag = sys.argv[1], sys.argv[2]
first = int(sys.argv[3]) if len(sys.argv) > 3 else 0
log = open(os.path.join(d, 'events.log'), 'a', buffering=1)
seq = 0
def emit(n):
    global seq
    for _ in range(n):
        seq += 1
        log.write('%d\n' % seq)
        os.write(1, ('E%07d %s %s\n' % (seq, tag, 'x' * (seq % 17))).encode())
emit(first)
step = 0
while True:
    step += 1
    cmd = os.path.join(d, 'cmd%d' % step)
    while not os.path.exists(cmd):
        time.sleep(0.002)
    spec = open(cmd).read().split()
    if spec[0] == 'burst':
        emit(int(spec[1]))
    elif spec[0] == 'pad':
        for _ in range(int(spec[1])):
            os.write(1, b'~pad~\n')
    elif spec[0] == 'stream':
        stop = os.path.join(d, 'stop%d' % step)
        while not os.path.exists(stop):
            emit(1)
            time.sleep(float(spec[1]))
    tmp = os.path.join(d, 'done%d.tmp' % step)
    open(tmp, 'w').write(str(seq))
    os.rename(tmp, os.path.join(d, 'done%d' % step))
`;
const fxRoots: string[] = [];
type FxOpts = { tag: string; historyLimit?: number; cols?: number; rows?: number; first?: number };
type FxHost = InstanceType<typeof FlagOnPipeHost>;
async function fxUntil(f: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await f()) return; await Bun.sleep(25); }
  if (!(await f())) throw Error(`T-fix timed out (${ms}ms): ${what}`);
}
/** Private tmux + external producer + flag-on root. Session `s` runs the producer. */
async function fxRig(o: FxOpts) {
  const dir = t11Mkdtemp(join(tmpdir(), 'tfix-')); fxRoots.push(dir);
  const sockDir = join(dir, 'tmuxdir', `tmux-${process.getuid!()}`); mkdirSyncFs(sockDir, { recursive: true, mode: 0o700 });
  const socket = join(sockDir, 'default');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'TMUX' && k !== 'TMUX_PANE') env[k] = v;
  env.TMUX_TMPDIR = join(dir, 'tmuxdir');
  const tmux = (args: string[]) => { const r = Bun.spawnSync(['tmux', '-S', socket, '-f', '/dev/null', ...args], { env });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };
  const must = (args: string[]) => { const r = tmux(args); if (r.exitCode) throw Error(`T-fix tmux ${args[0]}: ${r.stderr}`); return r.stdout; };
  const prod = join(dir, 'prod'); mkdirSyncFs(prod);
  writeFileSync(join(dir, 'producer.py'), FX_PRODUCER);
  const producer = (tag = o.tag, first = o.first ?? 0, d = prod) => `exec python3 -B ${dir}/producer.py ${d} ${tag} ${first}`;
  must(['start-server', ';', 'set-option', '-g', 'history-limit', String(o.historyLimit ?? 4500), ';',
    'new-session', '-d', '-s', 's', '-x', String(o.cols ?? 80), '-y', String(o.rows ?? 24), producer()]);
  const paneId = must(['list-panes', '-t', '=s', '-F', '#{pane_id}']).trim().split('\n')[0]!;
  const stamp = must(['display-message', '-p', '#{pid}@#{start_time}']).trim();
  const [sessionId, , panePid] = must(['display-message', '-p', '-t', paneId, '#{session_id}\t#{pane_id}\t#{pane_pid}']).trim().split('\t');
  const root = join(dir, 'root'); mkdirSyncFs(root, { mode: 0o700 });
  const allow = (sessionIds: string[]) => writeFileSync(join(root, 'allowlist.json'), JSON.stringify({ version: 1, server: stamp, sessions: sessionIds.map(sessionId => ({ sessionId })) }));
  allow([sessionId!]);
  const pane: T11F.PaneKey = { serverIdentity: `${socket}#${stamp}`, paneId, birthGeneration: Number(panePid) };
  let step = 0;
  const publish = (k: number, spec: string) => { writeFileSync(join(prod, `cmd${k}.tmp`), spec); renameSyncFs(join(prod, `cmd${k}.tmp`), join(prod, `cmd${k}`)); };
  const done = async (k: number) => { await fxUntil(() => existsSync(join(prod, `done${k}`)), 30_000, `producer step ${k}`); return Number(readFileSync(join(prod, `done${k}`), 'utf8')); };
  const logs: string[] = [], hosts: FxHost[] = [];
  const previousHistory = process.env.TERMINAL_HISTORY_DIR;
  process.env.TERMINAL_HISTORY_DIR = join(dir, 'legacy-history'); mkdirSyncFs(process.env.TERMINAL_HISTORY_DIR, { recursive: true });
  const rig = {
    dir, socket, env, tmux, must, root, pane, paneId, stamp, sessionId: sessionId!, serverPid: Number(stamp.split('@')[0]), logs, hosts, allow, prod, producer,
    burst: async (n: number) => { const k = ++step; publish(k, `burst ${n}`); return done(k); },
    pad: async (n: number) => { const k = ++step; publish(k, `pad ${n}`); return done(k); },
    stream: (interval = 0.002) => { const k = ++step; publish(k, `stream ${interval}`);
      return { stop: async () => { writeFileSync(join(prod, `stop${k}`), ''); return done(k); } }; },
    events: (): number[] => existsSync(join(prod, 'events.log')) ? readFileSync(join(prod, 'events.log'), 'utf8').split('\n').filter(Boolean).map(Number) : [],
    /** Independent terminal oracle: event ids tmux itself holds (history + screen). */
    tmuxEvents: (target = paneId, tag = o.tag): number[] => [...must(['capture-pane', '-p', '-S', '-', '-E', '-', '-t', target]).matchAll(new RegExp(`E(\\d{7}) ${tag}`, 'g'))].map(m => Number(m[1])),
    async host(mode: 'flag-on' | 'compat' = 'flag-on', extra: Partial<ConstructorParameters<typeof FlagOnPipeHost>[0]> = {}): Promise<FxHost> {
      const host = new FlagOnPipeHost({ root, tmuxSocket: socket, mode, tickMs: 50, healthMs: 100, log: m => logs.push(m), ...extra });
      hosts.push(host); await host.start(); return host;
    },
    collector: () => JSON.parse(readFileSync(join(root, 'flagon', 'collector.json'), 'utf8')) as { pid: number; endpoint: import('../../../../src/integrations/stream-spool-service').SpoolEndpoint },
    paneRecords: (): any[] => existsSync(join(root, 'flagon', 'panes')) ? readdirSync(join(root, 'flagon', 'panes')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(root, 'flagon', 'panes', f), 'utf8'))) : [],
    /** Capture files written by every attach of this root (S writes one per claimed episode). */
    captures: (): string[] => { const c = join(root, 'flagon', 'collector'); return existsSync(c) ? readdirSync(c).filter(d => existsSync(join(c, d, 'capture.bin'))) : []; },
    pipe: (target = paneId) => must(['display-message', '-p', '-t', target, '#{pane_pipe}']).trim(),
    /** Public projection pages, oldest first; markers become positioned unknown gaps. */
    timeline(host: FxHost, session = 's', limit = 97): { actual: T11Actual[]; lines: number; pages: string[] } {
      const pages: { lines: string[]; startLine: number | null; markers?: { lineId: number }[] }[] = [];
      let at: number | null = null;
      for (let g = 0; g < 10_000; g++) {
        const p = host.projection.readBefore(session, at, limit) as any;
        pages.unshift(p); if (!p.hasMore || p.startLine === null) break; at = p.startLine;
      }
      const actual: T11Actual[] = [], flat: string[] = [];
      for (const p of pages) p.lines.forEach((line, i) => {
        const id = (p.startLine ?? 0) + i; flat.push(line);
        if ((p.markers ?? []).some(m => m.lineId === id)) { actual.push({ kind: 'gap', pane: 'p1', positioned: true, countKind: 'unknown', missingCount: null, lowerBound: 0 }); return; }
        const text = plain(line).trimEnd(); const m = new RegExp(`^(E\\d{7} ${o.tag})\\b`).exec(text);
        if (m) actual.push({ kind: 'row', pane: 'p1', epoch: 'e1', text: m[1]! });
        else if (text && text !== '~pad~') actual.push({ kind: 'row', pane: 'p1', epoch: 'e1', text });
      });
      return { actual, lines: flat.length, pages: flat };
    },
    expected: (from: number, to: number): T11Expected[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({ text: `E${String(from + i).padStart(7, '0')} ${o.tag}`, epoch: 'e1' })),
    /** Judge [from..to] (events before `from` were evicted by tmux before any attach). */
    judge(host: FxHost, from: number, to: number, mode: T11Mode) {
      const t = rig.timeline(host);
      const actual = t.actual.filter(a => a.kind !== 'row' || !/^E\d{7} /.test(a.text) || Number(a.text.slice(1, 8)) >= from);
      return { ...t11JudgeTimeline('p1', rig.expected(from, to), actual, mode), rows: actual.filter(a => a.kind === 'row').length, gaps: actual.filter(a => a.kind === 'gap').length };
    },
    has(host: FxHost, seq: number) { return rig.timeline(host).actual.some(a => a.kind === 'row' && a.text === `E${String(seq).padStart(7, '0')} ${o.tag}`); },
    async cleanup() {
      for (const h of hosts) await h.close().catch(() => {});
      tmux(['kill-server']);
      for (const pid of readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
        try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(a => a.startsWith(dir + '/'))) process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
      if (previousHistory === undefined) delete process.env.TERMINAL_HISTORY_DIR; else process.env.TERMINAL_HISTORY_DIR = previousHistory;
      await Bun.sleep(100);
      t11Rm(dir, { recursive: true, force: true });
    },
  };
  return rig;
}
type FxRig = Awaited<ReturnType<typeof fxRig>>;
/** Real collector process + S's real pipe command against the rig's pane. */
async function fxSource(rig: FxRig, rootUUID = 'tfixroot') {
  mkdirSyncFs(join(rig.root, 'flagon'), { recursive: true, mode: 0o700 });
  const supervisor = new FlagOnCollectorSupervisor(join(rig.root, 'flagon', 'collector'), rootUUID, m => rig.logs.push(m));
  const ensured = await supervisor.ensure();
  const source = (client = ensured.client) => new FlagOnSourceTransport({ tmuxSocket: rig.socket, expectedServerPid: rig.serverPid, geometryGeneration: () => 0,
    collector: client, verifyIdentity: (intent, seen) => seen.serverPid === rig.serverPid && seen.paneId === intent.pane.paneId });
  let n = 0;
  const intent = (over: Partial<T11F.AttachIntent> = {}): T11F.AttachIntent => {
    const id = `tfix-${process.pid}-${++n}`;
    return { operationId: `op-${id}`, pane: rig.pane, expectedGeneration: 0, attachId: id, episodeId: `ep-${id}`, parentEpisodeId: null, kind: 'recovery', rootUUID, ...over };
  };
  const durableBytes = async (client: FxSpoolClient, binding: T11F.Binding) => {
    const out: number[] = []; for await (const r of client.readDurable(binding)) { if (r.payload.kind === 'bytes') out.push(...r.payload.bytes); } return Buffer.from(out);
  };
  return { supervisor, ...ensured, source, intent, durableBytes, never: { isCancelled: () => false } };
}
const fxIds = (bytes: Buffer | string, tag: string) => [...(typeof bytes === 'string' ? bytes : bytes.toString('latin1')).matchAll(new RegExp(`E(\\d{7}) ${tag}`, 'g'))].map(m => Number(m[1]));
const fxContiguous = (ids: number[]) => ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1);
const fxWhy = (r: unknown) => JSON.stringify(r).slice(0, 400);

// ── 02-S S-vectors ──
test('T-fix S-01 foreground collector + actual tmux FIFO writer: a second client after closing the first sees the same collector, payload once, offsets from 0', async () => {
  const rig = await fxRig({ tag: 's01' });
  try {
    const s = await fxSource(rig);
    const intent = s.intent();
    const opened = await s.source().openRecovery(intent, s.never);
    console.log(`T-fix S-01 openRecovery ${fxWhy(opened)}`);
    expect(opened.status).toBe('ok'); // F1: S's own pipe command must pass the collector handshake on real tmux
    if (opened.status !== 'ok') return;
    const last = await rig.burst(40);
    await fxUntil(async () => fxIds(await s.durableBytes(s.client, opened.value.binding), 's01').includes(last), 10_000, 'raw reaches the spool');
    s.client.close();
    const again = await s.supervisor.ensure();
    expect(again.spawned).toBe(false);
    expect(again.endpoint.bootNonce).toBe(s.endpoint.bootNonce);
    const raw = await s.durableBytes(again.client, opened.value.binding);
    const ids = fxIds(raw, 's01');
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    const first = (await again.client.replay(opened.value.binding, -1)).records[0]!;
    expect(first.range.start).toBe(0);
    again.client.close();
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-02 SIGKILL collector after an observed ACK; restart same root; replay of the old binding keeps every ACKed byte and the old epoch faults collector-restart', async () => {
  const rig = await fxRig({ tag: 's02' });
  try {
    const s = await fxSource(rig);
    const opened = await s.source().openRecovery(s.intent(), s.never);
    console.log(`T-fix S-02 openRecovery ${fxWhy(opened)}`);
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    const last = await rig.burst(200);
    let acked = 0;
    await fxUntil(async () => { const st = await s.client.status(opened.value.binding); acked = st.ack.through.byteOffset;
      return fxIds(await s.durableBytes(s.client, opened.value.binding), 's02').includes(last); }, 10_000, 'ACK covers the burst');
    process.kill(s.supervisor.pid!, 'SIGKILL');
    await fxUntil(() => !s.supervisor.alive(), 5_000, 'collector dead');
    const restarted = await s.supervisor.ensure();
    expect(restarted.spawned).toBe(true);
    const page = await restarted.client.replay(opened.value.binding, -1);
    expect(page.incident).toBe('collector-restart');
    const raw = await s.durableBytes(restarted.client, opened.value.binding);
    expect(raw.length).toBeGreaterThanOrEqual(acked);
    expect(fxIds(raw, 's02')).toEqual(Array.from({ length: last }, (_, i) => i + 1));
    await expect(restarted.client.status(opened.value.binding)).rejects.toThrow('collector continuity unavailable');
    restarted.client.close();
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-03 capture claimed, host gone before tmux: a retry of the same episode from a new transport is interrupted-capture with no second claim or capture', async () => {
  const rig = await fxRig({ tag: 's03' });
  try {
    const s = await fxSource(rig);
    const intent = s.intent();
    const prepared = await s.client.prepare(intent);
    await s.client.claimCapture(prepared.binding);
    for (const delay of [0, 200]) {
      await Bun.sleep(delay);
      const retry = await s.source().openRecovery(intent, s.never);
      console.log(`T-fix S-03 retry+${delay}ms ${fxWhy(retry)}`);
      expect(retry.status).not.toBe('ok');
      expect(fxWhy(retry)).toContain('interrupted-capture');
    }
    await expect(s.client.claimCapture(prepared.binding)).rejects.toThrow('interrupted-capture');
    expect(rig.captures()).toEqual([]);
    expect(rig.pipe()).toBe('0');
  } finally { await rig.cleanup(); }
}, 60_000);

for (const create of ['new-session', 'new-window', 'split-window'] as const) {
  test(`T-fix S-04 birth by ${create}: an immediate producer's byte 0 is the first spool byte and the episode carries a birth certificate, not overlap-unknown`, async () => {
    const rig = await fxRig({ tag: 'boot' });
    try {
      const s = await fxSource(rig);
      // The private server is fresh: its next pane id is the oracle's knowledge, not the product's guess.
      const next = `%${Number(rig.paneId.slice(1)) + 1}`;
      const bprod = join(rig.dir, 'bprod'); mkdirSyncFs(bprod);
      const cmd = rig.producer('s04', 50, bprod);
      const argv = create === 'new-session' ? ['new-session', '-d', '-s', 'b', '-x', '80', '-y', '24', cmd]
        : create === 'new-window' ? ['new-window', '-d', '-t', '=s:', cmd] : ['split-window', '-d', '-t', `${rig.paneId}`, cmd];
      const pane = { ...rig.pane, paneId: next };
      const source = new FlagOnSourceTransport({ tmuxSocket: rig.socket, expectedServerPid: rig.serverPid, geometryGeneration: () => 0, collector: s.client,
        birthCommand: () => argv, verifyIdentity: (i, seen) => seen.serverPid === rig.serverPid && seen.paneId === i.pane.paneId });
      const opened = await source.openBirth(s.intent({ kind: 'birth', pane }), s.never);
      console.log(`T-fix S-04 ${create} openBirth ${fxWhy(opened)} predicted=${next} panes=${rig.must(['list-panes', '-a', '-F', '#{pane_id}']).trim().split('\n').join(',')}`);
      expect(opened.status).toBe('ok');
      if (opened.status !== 'ok') return;
      await fxUntil(async () => fxIds(await s.durableBytes(s.client, opened.value.binding), 's04').includes(50), 10_000, 'birth bytes');
      const raw = await s.durableBytes(s.client, opened.value.binding);
      expect(raw.toString('latin1').startsWith('E0000001 s04 ')).toBe(true);
      expect(fxIds(raw, 's04')).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      // R09: a certified birth episode is not an overlap-unknown recovery.
      expect(opened.value.packet.boundary.kind).not.toBe('overlap-unknown');
      const certify = (source as unknown as { certifyBirth?: (id: string, b: T11F.Binding) => Promise<T11F.Result<T11F.BirthCertificateR2>> }).certifyBirth;
      expect(typeof certify).toBe('function');
      const cert = await certify!.call(source, opened.value.packet.snapshotId, opened.value.binding);
      expect(cert.status).toBe('ok');
      if (cert.status === 'ok') { expect(cert.value.command).toBe(create); expect(cert.value.rawStart.byteOffset).toBe(0); }
    } finally { await rig.cleanup(); }
  }, 60_000);
}

test('T-fix S-05 a foreign pipe before the guarded list stays unchanged; refusal captures nothing; our FIFO is retired', async () => {
  const rig = await fxRig({ tag: 's05' });
  try {
    const s = await fxSource(rig);
    const foreign = join(rig.dir, 'foreign.raw');
    rig.must(['pipe-pane', '-O', '-t', rig.paneId, `cat >> '${foreign}'`]);
    const intent = s.intent();
    const refused = await s.source().openRecovery(intent, s.never);
    console.log(`T-fix S-05 refused ${fxWhy(refused)}`);
    expect(refused.status).not.toBe('ok');
    const last = await rig.burst(25);
    await fxUntil(() => existsSync(foreign) && fxIds(readFileSync(foreign), 's05').includes(last), 10_000, 'foreign keeps receiving');
    expect(rig.pipe()).toBe('1');
    const dir = join(rig.root, 'flagon', 'collector', intent.attachId);
    expect(existsSync(join(dir, 'input.fifo'))).toBe(false);
    expect(existsSync(join(dir, 'capture.bin')) ? statSync(join(dir, 'capture.bin')).size : 0).toBe(0);
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-06 4500 retained rows + screen with the producer writing across pipe/capture/commit: one capture, complete hashed file, overlap-unknown until certified', async () => {
  const rig = await fxRig({ tag: 's06' });
  try {
    await rig.burst(6000);
    const s = await fxSource(rig);
    const stream = rig.stream(0.001);
    await Bun.sleep(100);
    const opened = await s.source().openRecovery(s.intent(), s.never);
    const last = await stream.stop();
    console.log(`T-fix S-06 openRecovery ${fxWhy(opened)}`);
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    const packet = opened.value.packet;
    expect(packet.captureCount).toBe(1);
    const file = readFileSync(packet.snapshot.path);
    expect(file.length).toBe(packet.snapshot.bytes);
    expect(t11Hash('sha256').update(file).digest('hex')).toBe(packet.snapshot.sha256);
    expect(packet.boundary.kind).toBe('overlap-unknown');
    const C = fxIds(file, 's06');
    expect(fxContiguous(C)).toBe(true);
    expect(C.length).toBeGreaterThanOrEqual(4500);
    await fxUntil(async () => fxIds(await s.durableBytes(s.client, opened.value.binding), 's06').includes(last), 10_000, 'tail in spool');
    const P = fxIds(await s.durableBytes(s.client, opened.value.binding), 's06');
    expect(fxContiguous(P)).toBe(true);
    const missing = []; for (let e = C[0]!; e <= last; e++) if (!C.includes(e) && !P.includes(e)) missing.push(e);
    expect(missing).toEqual([]);
    expect(rig.captures().length).toBe(1);
  } finally { await rig.cleanup(); }
}, 90_000);

test('T-fix S-07 lost finish ACK, same-intent retry from a new client: identical OpenCapture, zero pipe reopen, zero second capture', async () => {
  const rig = await fxRig({ tag: 's07' });
  try {
    const s = await fxSource(rig);
    const intent = s.intent();
    const opened = await s.source().openRecovery(intent, s.never);
    console.log(`T-fix S-07 openRecovery ${fxWhy(opened)}`);
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    const writer = () => readdirSync('/proc').filter(x => /^\d+$/.test(x)).find(pid => { try { return readlinkSyncFs(`/proc/${pid}/fd/3`).includes(intent.attachId); } catch { return false; } });
    const before = writer();
    s.client.close();
    const fresh = new FxSpoolClient(s.endpoint);
    const retried = await s.source(fresh).openRecovery(intent, s.never);
    expect(retried.status).toBe('ok');
    if (retried.status === 'ok') expect(t11Digest('open', retried.value)).toBe(t11Digest('open', opened.value));
    expect(rig.captures().length).toBe(1);
    expect(rig.pipe()).toBe('1');
    expect(writer()).toBe(before);
    fresh.close();
  } finally { await rig.cleanup(); }
}, 60_000);

/** Test-owned FIFO writer for collector-only vectors (no claim about S's pipe command). */
function fxFifoWriter(fifo: string, handshake: string) {
  // A PID with no /proc entry: the collector keeps the nonce-authenticated bytes
  // and has no process to retire (it must never signal this test process).
  let pid = 4_190_000; while (existsSync(`/proc/${pid}`)) pid--;
  const fd = fxOpen(fifo, 'w');
  fxWrite(fd, `${handshake} ${pid}\n`);
  return { write: (s: string) => fxWrite(fd, s), close: () => fxClose(fd) };
}
/** Raw socket abuse from a separate python process (Bun's node:net is not the subject). */
const FX_FLOOD = String.raw`import socket, sys, time
path, mode = sys.argv[1], sys.argv[2]
if mode == 'frame':
    s = socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(path)
    out = b''
    try:
        s.sendall(b'x' * (300 * 1024) + b'\n'); out = s.recv(65536)
    except Exception as e:
        out = ('closed:%s' % type(e).__name__).encode()
    print(out.decode(errors='replace')[:200])
else:
    held = []
    for _ in range(int(mode)):
        try:
            c = socket.socket(socket.AF_UNIX); c.setblocking(False); c.connect_ex(path); held.append(c)
        except Exception:
            pass
    time.sleep(0.3)
    print(len(held))
`;
function fxFlood(dir: string, sock: string, mode: string): string {
  writeFileSync(join(dir, 'flood.py'), FX_FLOOD);
  const r = t11Spawn('python3', ['-B', join(dir, 'flood.py'), sock, mode], { encoding: 'utf8', timeout: 10_000 });
  return `${r.status}:${(r.stdout ?? '').trim()}:${(r.stderr ?? '').trim().slice(0, 200)}`;
}

test('T-fix S-08 mutated epoch/rootUUID/nonce/ownerGeneration/peer and forged ACK/evidence are refused and the watermark does not move', async () => {
  const rig = await fxRig({ tag: 's08' });
  try {
    const s = await fxSource(rig);
    const prepared = await s.client.prepare(s.intent());
    const w = fxFifoWriter(join(prepared.directory, 'input.fifo'), prepared.binding.handshakeId);
    w.write('E0000001 s08 hello\n');
    await fxUntil(async () => (await s.client.status(prepared.binding)).ack.through.byteOffset > 0, 5_000, 'first ACK');
    const ack = (await s.client.status(prepared.binding)).ack;
    const b = prepared.binding;
    const forged: T11F.Binding[] = [
      { ...b, epoch: { ...b.epoch, attachId: 'other' } }, { ...b, rootUUID: 'other' }, { ...b, bootNonce: 'other' },
      { ...b, ownerGeneration: b.ownerGeneration + 1 }, { ...b, peerUid: b.peerUid + 1 }, { ...b, handshakeId: 'forged' },
    ];
    for (const f of forged) await expect(s.client.status(f)).rejects.toThrow();
    const wrongRoot = new FxSpoolClient({ ...s.endpoint, rootUUID: 'other' });
    await expect(wrongRoot.status(b)).rejects.toThrow('fence'); wrongRoot.close();
    await s.client.claimCapture(b);
    const fakePacket = { version: 1, snapshotId: 'x', episodeId: prepared.binding.attachId, captureCount: 1, complete: true, pane: rig.pane,
      rawRange: { epoch: b.epoch, start: 0, end: ack.through.byteOffset + 99 } } as unknown as T11F.CapturePacket;
    await expect(s.client.finish({ binding: b, packet: fakePacket, durable: { ...ack, through: { ...ack.through, byteOffset: ack.through.byteOffset + 99 } } })).rejects.toThrow();
    await expect(s.client.finish({ binding: b, packet: { ...fakePacket, rawRange: { epoch: b.epoch, start: 0, end: ack.through.byteOffset } } as T11F.CapturePacket,
      durable: { ...ack, recordDigest: 'f'.repeat(64) } })).rejects.toThrow();
    expect((await s.client.status(b)).ack).toEqual(ack);
    w.close();
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-09 oversized frame, >32 connections, short writes, FIFO EOF and producer silence stay bounded; EOF exposes the last offset and silence never reopens', async () => {
  const rig = await fxRig({ tag: 's09' });
  try {
    const s = await fxSource(rig);
    const sock = join(rig.root, 'flagon', 'collector', 'collector.sock');
    const frame = fxFlood(rig.dir, sock, 'frame');
    console.log(`T-fix S-09 oversized frame -> ${frame} collectorAlive=${s.supervisor.alive()}`);
    expect(frame).not.toContain('"ok":true');
    expect(s.supervisor.alive()).toBe(true);
    const flood = fxFlood(rig.dir, sock, '40');
    console.log(`T-fix S-09 40 connections -> ${flood} collectorAlive=${s.supervisor.alive()}`);
    expect(s.supervisor.alive()).toBe(true);
    const prepared = await s.client.prepare(s.intent());
    const w = fxFifoWriter(join(prepared.directory, 'input.fifo'), prepared.binding.handshakeId);
    let bytes = 0;
    for (const piece of ['E0000001 s09 ', 'a', 'b\n', 'E0000002 s09 c\n']) { w.write(piece); bytes += piece.length; await Bun.sleep(15); }
    await fxUntil(async () => (await s.client.status(prepared.binding)).ack.through.byteOffset === bytes, 5_000, 'short writes durable');
    await Bun.sleep(400); // producer silence: no incident, no reopen
    const silent = await s.client.status(prepared.binding);
    expect(silent.incident).toBeNull(); expect(silent.connected).toBe(true);
    w.close();
    await fxUntil(async () => (await s.client.replay(prepared.binding, -1)).incident === 'pipe-eof', 5_000, 'EOF fault');
    const page = await s.client.replay(prepared.binding, -1);
    expect(page.ack.through.byteOffset).toBe(bytes);
    expect(page.live).toBe(false);
    expect(s.supervisor.alive()).toBe(true);
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-10 a raw-io incident spends the reserve without ACKing the failed bytes; after the incident resolves the reserve is rearmed from physical free space', async () => {
  const rig = await fxRig({ tag: 's10' });
  try {
    const s = await fxSource(rig);
    const reserve = join(rig.root, 'flagon', 'collector', 'incident.reserve');
    expect(statSync(reserve).blocks * 512).toBeGreaterThan(0);
    const prepared = await s.client.prepare(s.intent());
    const fd = fxOpen(join(prepared.directory, 'input.fifo'), 'w');
    fxWrite(fd, 'x'.repeat(4096)); // handshake budget exceeded: an I/O incident, not a byte
    await fxUntil(async () => (await s.client.replay(prepared.binding, -1)).incident !== null, 5_000, 'incident');
    fxClose(fd);
    const page = await s.client.replay(prepared.binding, -1);
    expect(page.ack.through.byteOffset).toBe(0);
    expect(statSync(reserve).size).toBe(0);
    await expect(s.client.prepare(s.intent())).rejects.toThrow('reserve');
    const rearm = (s.client as unknown as { rearmReserve?: (r: unknown) => Promise<unknown> }).rearmReserve;
    expect(typeof rearm).toBe('function'); // R10: S must expose rearm after a resolved incident (K-r2 rearmReserve)
    if (typeof rearm !== 'function') return;
    await rearm.call(s.client, { operationId: 'rearm-1', pane: rig.pane, expectedGeneration: 0, incidentId: page.incident, resolvedCommitId: 'resolved' });
    expect(statSync(reserve).blocks * 512).toBeGreaterThan(0);
    expect((await s.client.prepare(s.intent())).phase).toBe('prepared');
  } finally { await rig.cleanup(); }
}, 60_000);

test('T-fix S-11 host restart vs collector: closing a client keeps the reader; a planned collector stop with a live pipe is refused', async () => {
  const rig = await fxRig({ tag: 's11' });
  try {
    const s = await fxSource(rig);
    const prepared = await s.client.prepare(s.intent());
    const w = fxFifoWriter(join(prepared.directory, 'input.fifo'), prepared.binding.handshakeId);
    w.write('E0000001 s11 a\n');
    await fxUntil(async () => (await s.client.status(prepared.binding)).connected, 5_000, 'connected');
    s.client.close();
    const pid = s.supervisor.pid!;
    process.kill(pid, 'SIGTERM');
    await Bun.sleep(400);
    expect(s.supervisor.alive()).toBe(true);
    const again = await s.supervisor.ensure();
    expect(again.spawned).toBe(false);
    w.write('E0000002 s11 b\n');
    await fxUntil(async () => (await again.client.status(prepared.binding)).ack.through.byteOffset === 30, 5_000, 'reader kept');
    expect((await again.client.status(prepared.binding)).connected).toBe(true);
    w.close(); again.client.close();
  } finally { await rig.cleanup(); }
}, 60_000);

// ── integration entries (B1/B2/B3/OFF) and §6 regression lines on FlagOnPipeHost ──
/** Run a flag-on host in a child process so a crash point is a real SIGKILL. */
const FX_CHILD = String.raw`const [mod, root, socket] = process.argv.slice(2);
const { FlagOnPipeHost } = await import(mod);
const host = new FlagOnPipeHost({ root, tmuxSocket: socket, mode: 'flag-on', tickMs: 50, healthMs: 100 });
await host.start();
console.log('ATTACH ' + JSON.stringify(await host.attach('s')));
await new Promise(() => {});
`;

const FX_CRASH_STATES: [string, (rig: FxRig) => boolean][] = [
  ['pipe-open', rig => rig.paneRecords().some(r => r.phase === 'attaching')],
  ['captured', rig => rig.captures().length > 0],
  ['committed', rig => rig.paneRecords().some(r => r.phase === 'committed')],
];
for (const [state, reached] of FX_CRASH_STATES) {
  test(`T-fix B1-03 host SIGKILL at ${state}: the next boot withdraws the intent, keeps capture ≤1 per episode and admits exactly one recovery episode without dup/order/silent loss`, async () => {
    const rig = await fxRig({ tag: 'b13' });
    try {
      await rig.burst(300);
      writeFileSync(join(rig.dir, 'child.ts'), FX_CHILD);
      const mod = join(import.meta.dir, '../../../../src/integrations/stream-pipe-host.ts');
      const child = Bun.spawn([process.execPath, join(rig.dir, 'child.ts'), mod, rig.root, rig.socket],
        { stdout: 'pipe', stderr: 'pipe', env: { ...rig.env, TERMINAL_HISTORY_DIR: join(rig.dir, 'legacy-history') } });
      const stream = rig.stream(0.003);
      try { await fxUntil(() => reached(rig), 20_000, `child reaches ${state}`); }
      finally { child.kill('SIGKILL'); await child.exited; await stream.stop(); }
      const host = await rig.host();
      await fxUntil(() => host.status().sessions.some(x => x.admission !== null && x.fault === null), 20_000, `boot after ${state}`);
      const status = host.status();
      console.log(`T-fix B1-03 after ${state}: ${fxWhy(status.sessions)} incidents=${fxWhy(status.incidents.slice(-3))}`);
      expect(rig.paneRecords().filter(r => r.phase === 'attaching')).toEqual([]);
      const episodes = new Set(rig.paneRecords().map(r => r.intent.episodeId));
      expect(rig.captures().length).toBeLessThanOrEqual(episodes.size);
      expect(status.sessions.filter(x => x.session === 's' && x.admission !== null)).toHaveLength(1);
      const last = await rig.burst(20); await rig.pad(30);
      await fxUntil(() => rig.has(host, last), 15_000, `row ${last} after ${state}`);
      expect(rig.judge(host, rig.tmuxEvents()[0] ?? 1, last, 'fault').violations).toEqual([]);
      expect(rig.pipe()).toBe('1');
    } finally { await rig.cleanup(); }
  }, 120_000);
}

test('T-fix B2-03 PREPARED handoff survives boots with flag 0 and 1, before and after writer registration, and resolves to legacy once receipt+binding+pin read back', async () => {
  const rig = await fxRig({ tag: 'b23' });
  const { startPipeHistoryHostFromEnv, stopPipeHistoryHost, activeCompatHost } = await import('../../../../src/integrations/pipe-history-host');
  try {
    await rig.burst(100);
    let host = await rig.host();
    const attached = await host.attach('s');
    console.log(`T-fix B2-03 attach ${fxWhy(attached)}`);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    await fxUntil(() => host.status().sessions[0]?.verified === true, 15_000, 'verified');
    await rig.burst(30); await rig.pad(30);
    const switched = await host.setRoute('s', 'legacy');
    console.log(`T-fix B2-03 setRoute ${fxWhy(switched)}`);
    await host.close(); rig.hosts.length = 0;
    // flag 0 boot: the compatibility host continues the tenure and resolves the handoff.
    await startPipeHistoryHostFromEnv({ CORTEX_NEWARCH_ROOT: rig.root, CORTEX_NEWARCH_TMUX_SOCKET: rig.socket, CORTEX_STREAM_FIRST: '0' }, m => rig.logs.push(m));
    const compat = activeCompatHost();
    expect(compat).not.toBeNull();
    const last = await rig.burst(20); await rig.pad(30);
    await fxUntil(() => compat!.catalog?.owner(rig.pane)?.route === 'legacy', 15_000, 'compat resolves PREPARED to legacy');
    const pending = await compat!.catalog!.recoverPending(rig.pane, { isCancelled: () => false });
    expect(['none', 'committed']).toContain(pending.status === 'ok' ? String(pending.value.kind) : pending.status);
    await stopPipeHistoryHost();
    // flag 1 boot after the handoff: legacy stays the owner, no second capture of the tenure.
    const captures = rig.captures().length;
    host = await rig.host();
    expect(host.catalog!.owner(rig.pane)?.route).toBe('legacy');
    expect(rig.captures().length).toBe(captures);
    void last;
  } finally { await stopPipeHistoryHost().catch(() => {}); await rig.cleanup(); }
}, 120_000);

for (const scenario of ['retained', 'irrecoverable'] as const) {
  test(`T-fix B3-02 pipe EOF (${scenario}): every ACKed byte reaches H, the rebind is ≤10 s, and ${scenario === 'retained' ? 'the retained suffix is recovered' : 'the lost range sits under a located pipe-eof gap with count null'}`, async () => {
    const rig = await fxRig({ tag: 'b32' });
    try {
      await rig.burst(200);
      const from = rig.tmuxEvents()[0]!;
      const host = await rig.host();
      const attached = await host.attach('s');
      console.log(`T-fix B3-02 attach ${fxWhy(attached)}`);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      await fxUntil(() => host.status().sessions[0]?.verified === true, 15_000, 'verified');
      const record = rig.paneRecords()[0]!;
      const writer = readdirSync('/proc').filter(x => /^\d+$/.test(x)).find(pid => { try { return readlinkSyncFs(`/proc/${pid}/fd/3`).includes(record.intent.attachId); } catch { return false; } });
      expect(writer).toBeDefined();
      const stream = rig.stream(0.004);
      await Bun.sleep(200);
      const killedAt = performance.now();
      process.kill(Number(writer), 'SIGKILL');
      if (scenario === 'irrecoverable') { await fxUntil(() => rig.pipe() === '0', 5_000, 'pipe closed'); rig.must(['clear-history', '-t', rig.paneId]); }
      await fxUntil(() => { const x = host.status().sessions[0]; return !!x && x.fault === null && rig.paneRecords().some(r => r.intent.attachId !== record.intent.attachId && r.phase === 'committed'); }, 10_000, 'rebind ≤10 s');
      const rebindMs = performance.now() - killedAt;
      const last = await stream.stop(); await rig.pad(30);
      await fxUntil(() => rig.has(host, last), 15_000, `row ${last}`);
      const client = new FxSpoolClient(rig.collector().endpoint);
      const acked = (await client.replay(record.binding, -1)).ack.through.byteOffset; client.close();
      const rb = new FlagOnHistoryReadback(join(rig.root, 'flagon', 'history', 'flag-on-v1.sqlite'));
      const inH = rb.epoch(record.binding.epoch)?.offset ?? -1; rb.close();
      const verdict = rig.judge(host, from, last, scenario === 'retained' ? 'recoverable' : 'fault');
      console.log(`T-fix B3-02 ${scenario} rebindMs=${Math.round(rebindMs)} acked=${acked} inH=${inH} ${fxWhy(verdict)}`);
      expect(inH).toBe(acked);
      expect(verdict.violations).toEqual([]);
      expect(rig.timeline(host).actual.some(a => a.kind === 'gap')).toBe(true);
    } finally { await rig.cleanup(); }
  }, 120_000);
}

test('T-fix OFF-01 flag absent/0 without a tenure: no file, collector, worker or timer; with a tenure the compatibility host continues the legacy archive and keeps the archive worker', async () => {
  const rig = await fxRig({ tag: 'off' });
  const { startPipeHistoryHostFromEnv, stopPipeHistoryHost, activeCompatHost } = await import('../../../../src/integrations/pipe-history-host');
  const { terminalHistoryArchive } = await import('../../../../src/integrations/terminal-history');
  try {
    const bare = join(rig.dir, 'bare'); mkdirSyncFs(bare, { mode: 0o700 });
    const collectors = () => readdirSync('/proc').filter(x => /^\d+$/.test(x)).filter(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('stream-spool-service'); } catch { return false; } }).length;
    const before = collectors();
    for (const flag of [undefined, '0'] as const) {
      const env: Record<string, string> = { CORTEX_NEWARCH_ROOT: bare, CORTEX_NEWARCH_TMUX_SOCKET: rig.socket };
      if (flag) env.CORTEX_STREAM_FIRST = flag;
      await startPipeHistoryHostFromEnv(env, () => {});
      expect(activeCompatHost()).toBeNull();
      await stopPipeHistoryHost();
      expect(readdirSync(bare).filter(f => f.startsWith('stream-') || f === 'flagon')).toEqual([]);
      expect(collectors()).toBe(before);
    }
    await rig.burst(50);
    const host = await rig.host();
    const attached = await host.attach('s');
    console.log(`T-fix OFF-01 attach ${fxWhy(attached)}`);
    expect(attached.ok).toBe(true);
    await host.close(); rig.hosts.length = 0;
    const legacyBefore = terminalHistoryArchive.getManifest('s').totalLines;
    await startPipeHistoryHostFromEnv({ CORTEX_NEWARCH_ROOT: rig.root, CORTEX_NEWARCH_TMUX_SOCKET: rig.socket, CORTEX_NEWARCH_ARCHIVE_REMOTE: join(rig.dir, 'remote') }, m => rig.logs.push(m));
    const compat = activeCompatHost();
    expect(compat?.status().mode).toBe('compat');
    await rig.burst(30); await rig.pad(30);
    await fxUntil(() => terminalHistoryArchive.getManifest('s').totalLines > legacyBefore, 15_000, 'compat continues the legacy archive');
    // R21: the tenure's archive remote is the same under compatibility (IH must pass it through).
    expect(compat!.status().archive).not.toBeNull();
  } finally { await stopPipeHistoryHost().catch(() => {}); await rig.cleanup(); }
}, 120_000);

test('T-fix R16 host restart with a silent producer reads the same public pages (no EOF, no new gap); output after restart continues the timeline once', async () => {
  const rig = await fxRig({ tag: 'r16' });
  try {
    await rig.burst(120);
    const from = rig.tmuxEvents()[0]!;
    let host = await rig.host();
    const attached = await host.attach('s');
    console.log(`T-fix R16 attach ${fxWhy(attached)}`);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    await fxUntil(() => host.status().sessions[0]?.verified === true, 15_000, 'verified');
    const mid = await rig.burst(40); await rig.pad(30);
    await fxUntil(() => rig.has(host, mid), 15_000, `row ${mid}`);
    const before = rig.timeline(host);
    await host.close(); rig.hosts.length = 0;
    host = await rig.host();
    await fxUntil(() => host.status().sessions.length === 1, 10_000, 'resumed');
    const quiet = rig.timeline(host);
    expect(quiet.lines).toBe(before.lines);
    expect(quiet.pages).toEqual(before.pages);
    const last = await rig.burst(40); await rig.pad(30);
    await fxUntil(() => rig.has(host, last), 15_000, `row ${last} after restart`);
    const verdict = rig.judge(host, from, last, 'fault');
    expect(verdict.violations).toEqual([]);
    expect(rig.judge(host, mid + 1, last, 'planned').violations).toEqual([]);
  } finally { await rig.cleanup(); }
}, 120_000);

// ── cleanup proof (runs last in this file) ──
test('T-fix S-12 after every fixture: no socket, FIFO, sender, collector or tmux server of these rigs is left', async () => {
  expect(fxRoots.length).toBeGreaterThan(0);
  const left: string[] = [];
  for (const pid of readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    try { const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); if (fxRoots.some(d => argv.some(a => a.includes(d)))) left.push(`${pid} ${argv.join(' ')}`); } catch {}
  }
  expect(left).toEqual([]);
  for (const d of fxRoots) expect(existsSync(d)).toBe(false);
});
