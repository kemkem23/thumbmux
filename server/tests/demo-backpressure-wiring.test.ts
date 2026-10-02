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

import { StreamArchiveCatalog, StreamArchiveBridge, type ArchiveRangeReader } from '../../../../src/integrations/stream-archive-bridge';
import { type FinalizedRow } from '../src/stream-contract';

test('stream I archive catalog publishes only committed intervals, resumes decisions and maps fragmented rows across route changes', async () => {
  const root = await mkdtemp(join(tmpdir(),'stream-i-archive-'));
  const runtime = new StreamRuntime({path:join(root,'stream.sqlite')});
  let catalog = new StreamArchiveCatalog(join(root,'catalog.sqlite'));
  try {
    const pane = await runtime.add(streamTestIdentity,{columns:20,rows:3},streamPorts);
    const identity = pane.identity.pane;
    const initial = {pane:identity,route:'legacy' as const,generation:1,globalStart:0,localStart:0,root:'legacy-A',schema:'fixture'};
    catalog.initialize(initial);
    await pane.ingest(Buffer.from('repeat\r\n\r\nrepeat\r\nA\r\nB\r\n'));
    const first = (await pane.drain())!;
    expect(first.head).toBeGreaterThan(0);
    catalog.begin(identity,'forward',1,'stream');
    const middle = {pane:identity,route:'stream' as const,generation:2,globalStart:first.head,localStart:0,root:'stream-B',schema:'sh-v1'};
    expect(() => catalog.prepare(identity,'forward',first,middle,'screenshot')).toThrow('full-state');
    catalog.prepare(identity,'forward',first,middle,first.stateDigest);
    expect(() => catalog.begin(identity,'conflicting',1,'stream')).toThrow();
    expect(catalog.pending(identity)?.id).toBe('forward');
    expect(catalog.segmentAt(identity,0)).toBeNull();
    expect(catalog.owner(identity)).toEqual(initial);
    catalog.close(); catalog = new StreamArchiveCatalog(join(root,'catalog.sqlite'));
    expect(catalog.pending(identity)?.phase).toBe('PREPARED');
    catalog.commit(identity,'forward'); catalog.commit(identity,'forward');
    expect(catalog.owner(identity)).toEqual(middle);
    expect(catalog.pending(identity)).toBeNull();
    await pane.ingest(Buffer.from('repeat\r\n\r\nC\r\nD\r\n'));
    const second = (await pane.drain())!;
    catalog.begin(identity,'rollback',2,'legacy');
    const suffix = {...middle,route:'legacy' as const,generation:3,globalStart:second.head,localStart:second.head,root:'legacy-C',schema:'fixture'};
    // Only this backend-local head is synthetic; native VT state and the
    // SQLite row oracle below are unchanged. This exercises a nonzero offset.
    const localSecond = {...second,head:second.head-first.head};
    catalog.prepare(identity,'rollback',localSecond,suffix,second.stateDigest);
    catalog.commit(identity,'rollback');
    expect(() => catalog.begin(identity,'other',2,'stream')).toThrow('CAS');
    expect(() => catalog.begin(identity,'rollback',1,'legacy')).toThrow('collision');
    expect(catalog.segmentAt(identity,first.head)?.root).toBe('stream-B');
    expect(catalog.segmentAt(identity,second.head)).toBeNull(); // live screen isn't archived
    catalog.begin(identity,'abort-me',3,'stream'); catalog.abort(identity,'abort-me');
    expect(catalog.pending(identity)).toBeNull();
    expect(() => catalog.commit(identity,'abort-me')).toThrow('not prepared');
    expect(() => catalog.abort(identity,'rollback')).toThrow('committed');
    const route = {viewerId:'archive-oracle',identity:pane.identity,routeGeneration:3};
    expect((await pane.attach(route,()=>{})).status).toBe('ok');
    const page = await pane.page(route,{requestId:'archive-oracle',identity:pane.identity,routeGeneration:3,
      range:{start:0,end:second.head},deadlineMonoMs:performance.now()+1000},null,256,{isCancelled:()=>false});
    if (page.status !== 'ok') throw Error(JSON.stringify(page));
    const rows = new Map(page.value.fragments.map(f => [f.row.id.lineId,f.row]));
    await pane.detach(route.viewerId);
    let retired = 0;
    const reader: ArchiveRangeReader = {
      read: async (segment,line,cell) => {
        const globalLine = segment.globalStart + line - segment.localStart;
        const original = rows.get(globalLine)!;
        const row = {...original,id:{...original.id,lineId:line}};
        const end = Math.min(cell+2,row.cells.length);
        return {fragment:{row:{...row,cells:row.cells.slice(cell,end)},startCell:cell,endCell:end,complete:cell===0&&end===row.cells.length},rowEnd:end===row.cells.length};
      },
      retire:async()=>{ retired++; },
    };
    catalog.close(); catalog = new StreamArchiveCatalog(join(root,'catalog.sqlite'),true);
    const bridge = new StreamArchiveBridge(catalog,{legacy:reader,stream:reader});
    const restored = new Map<number,FinalizedRow>();
    await bridge.read(identity,0,second.head,new AbortController().signal,async fragment => {
      const previous = restored.get(fragment.row.id.lineId);
      restored.set(fragment.row.id.lineId,{...fragment.row,cells:[...(previous?.cells??[]),...fragment.row.cells]});
    });
    expect([...restored]).toEqual([...rows]);
    expect(retired).toBe(2);
    expect(catalog.committed(identity,'rollback')).toBe(true);
    expect(() => catalog.initialize(initial)).toThrow();
    const failure: ArchiveRangeReader = {...reader,read:async()=>{throw Error('archive busy');}};
    const broken = new StreamArchiveBridge(catalog,{legacy:failure,stream:reader});
    await expect(broken.read(identity,0,1,new AbortController().signal,async()=>{})).rejects.toThrow('archive busy');
    expect(retired).toBe(4);
  } finally { catalog.close(); await runtime.close(); await rm(root,{recursive:true,force:true}); }
},30000);

// Lot I round 5: rollback archive handoff (DESIGN-I3 §2) and source EOF
// (§3) through the real host, real C/H SQLite, catalog and legacy composite.
import { Database } from 'bun:sqlite';
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { StreamArchiveRowReader } from '../src/history-engine';
import { StreamLegacyComposite, StreamSegmentReader, composeLegacyArchive, installStreamArchive,
  openStreamArchive, rowAnsi, type ArchiveSegment } from '../../../../src/integrations/stream-archive-bridge';
import { openStreamArchiveForLegacy, closeStreamArchiveForLegacy, writeStreamTenureMarker } from '../../../../src/integrations/stream-pipe-host';
import { setLegacyWriterKick } from '../../../../src/integrations/stream-archive-registry';
import { streamRowsReader } from '../../../../src/integrations/stream-archive-bridge';

/** terminal-history page semantics: before is exclusive end, after is
 * exclusive start, pages clamp below the requested limit. */
class FakeLegacyArchive {
  lines = new Map<string,string[]>(); live = new Map<string,number>(); calls = 0;
  readBefore(s:string,before:number|null,limit=500){
    this.calls++; const all=this.lines.get(s)??[];
    const end=Math.max(0,Math.min(before??all.length,all.length)),start=Math.max(0,end-Math.min(limit,7));
    return {lines:all.slice(start,end),startLine:start,endLine:end,hasMore:start>0,totalArchivedLines:all.length};
  }
  readAfter(s:string,after:number|null,limit=500){
    this.calls++; const all=this.lines.get(s)??[];
    const start=Math.max(0,Math.min(after===null?0:after+1,all.length)),end=Math.min(start+Math.min(limit,7),all.length);
    return {lines:all.slice(start,end),startLine:start,endLine:end,hasMore:end<all.length,totalArchivedLines:all.length};
  }
  liveStartLine(s:string){return this.live.get(s)??null;}
  boundary(s:string){return this.live.has(s)?{generation:'g',liveStartLine:this.live.get(s)!,walSequence:'1',walOffset:0}:null;}
  renameSession(a:string,b:string){const l=this.lines.get(a);this.lines.delete(a);if(l)this.lines.set(b,l);}
  dropSession(s:string){this.lines.delete(s);}
  ingestSnapshot(){return{liveContent:''};}
}
const plain=(line:string)=>line.replace(/\x1b\[[0-9;]*m/g,'');
async function oracleRows(pane:import('../src/stream-runtime').StreamRuntimePane,end:number):Promise<string[]>{
  const route={viewerId:`oracle-${crypto.randomUUID()}`,identity:pane.identity,routeGeneration:1};
  expect((await pane.attach(route,()=>{})).status).toBe('ok');
  const out:string[]=[];let cursor=null as any;
  try{do{
    const r=await pane.page(route,{requestId:route.viewerId,identity:pane.identity,routeGeneration:1,range:{start:0,end},
      deadlineMonoMs:performance.now()+1000},cursor,256,{isCancelled:()=>false});
    if(r.status!=='ok')throw Error(JSON.stringify(r));
    for(const f of r.value.fragments){expect(f.complete).toBe(true);out[f.row.id.lineId]=rowAnsi(f.row);}
    cursor=r.value.nextAfter;
  }while(cursor);}finally{await pane.detach(route.viewerId);}
  return out;
}
/** Every page shape, both directions, against the oracle: missing/dup/order 0. */
function walk(archive:ReturnType<typeof composeLegacyArchive<FakeLegacyArchive>>,session:string,oracle:string[],limit:number){
  const back:string[]=[];let before:number|null=null,guard=0;
  for(;;){
    const p=archive.readBefore(session,before,limit) as any;
    expect(p.totalArchivedLines).toBe(oracle.length);expect(p.endLine-p.startLine).toBe(p.lines.length);
    back.unshift(...p.lines);if(!p.hasMore)break;before=p.startLine;if(++guard>10_000)throw Error('no progress');
  }
  const fwd:string[]=[];let after:number|null=null;
  for(;;){
    const p=archive.readAfter!(session,after,limit) as any;
    fwd.push(...p.lines);if(!p.hasMore)break;after=p.endLine-1;if(++guard>20_000)throw Error('no progress');
  }
  expect(back).toEqual(oracle);expect(fwd).toEqual(oracle);
}

test('stream I rollback bridge: legacy reads join the frozen sh_* interval exactly, seam stays unknown, base untouched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stream-i-r5-bridge-'));
  const runtime=new StreamRuntime({path:join(root,'stream-history.sqlite')});
  const legacy=new FakeLegacyArchive(),archive=composeLegacyArchive(legacy);
  let composite:StreamLegacyComposite|null=null;
  try{
    const pane=await runtime.add(streamTestIdentity,{columns:12,rows:3},streamPorts);pane.stopCadence();
    // Repeats, blanks, wide/combining cells, SGR and a soft-wrapped row.
    const text=['same','','same','\x1b[31mred\x1b[0m','กข','中文字','x'.repeat(30),'',...Array.from({length:40},(_,i)=>`r${i}`)];
    await pane.ingest(Buffer.from(text.join('\r\n')+'\r\n'));
    const cp=(await pane.drain())!,F=cp.head,oracle=await oracleRows(pane,F);
    expect(F).toBeGreaterThan(40);expect(oracle.filter(l=>plain(l).trimEnd()==='same')).toHaveLength(2);
    // Untouched base: no composite or an unbound session forwards verbatim.
    legacy.lines.set('s',['L0','L1']);legacy.lines.set('other',['o']);
    expect(archive.readBefore('s',null,5)).toEqual(legacy.readBefore('s',null,5));
    composite=openStreamArchive(root,true)!;
    installStreamArchive(composite);
    const page=archive.readBefore('other',null,5);expect(page).toEqual(legacy.readBefore('other',null,5));
    const owner={pane:pane.identity.pane,route:'stream' as const,generation:1,globalStart:0,localStart:0,root:'sh',schema:'sh-v1'};
    composite.catalog.initialize(owner);composite.catalog.bindSession('s',owner.pane);
    composite.catalog.begin(owner.pane,'planned:1',1,'legacy');
    expect(()=>composite!.catalog.prepareFence(owner.pane,'planned:1',{localEnd:F,revision:cp.revision,checkpoint:cp},
      {...owner,route:'stream',generation:2,globalStart:F},{kind:'source-authoritative',reason:'tmux'},{kind:'planned',missingCount:null,reason:'x'})).toThrow();
    // The legacy archive already holds 2 rows; legacy resumes at local 0 here
    // because nothing legacy was frozen before the stream tenure (fresh pane).
    composite.catalog.prepareFence(owner.pane,'planned:1',{localEnd:F,revision:cp.revision,checkpoint:cp},
      {...owner,route:'legacy',generation:2,globalStart:F,localStart:0,root:'legacy',schema:'th'},
      {kind:'source-authoritative',reason:'legacy capture re-reads tmux state'},{kind:'planned',missingCount:null,reason:'writer detached'});
    composite.catalog.commit(owner.pane,'planned:1');
    const all=[...oracle,'L0','L1'];
    for(const limit of [1,3,7,500,2000])walk(archive,'s',all,limit);
    const last=archive.readBefore('s',F+1,3) as any;
    expect(last.markers).toEqual([{lineId:F,kind:'stream-planned',reason:'writer detached',missingCount:null}]);
    expect((archive.readBefore('s',F-5,3) as any).markers).toEqual([]);
    legacy.live.set('s',1);
    expect(archive.liveStartLine!('s')).toBe(F+1);
    expect((archive.boundary!('s') as any).liveStartLine).toBe(F+1);
    expect(archive.readBefore('s',null,3)).toMatchObject({startLine:all.length-3,endLine:all.length});
    // Rename follows the label; drop forgets it; nothing is matched by text.
    archive.renameSession!('s','t');walk(archive,'t',all,7);
    expect(archive.readBefore('s',null,5)).toEqual(legacy.readBefore('s',null,5));
    // Async fragment bridge reads the same rows from the sh_* backend.
    const seg=composite.catalog.segmentAt(owner.pane,0)!;
    expect(seg).toMatchObject({route:'stream',globalStart:0,globalEnd:F,seam:{kind:'planned',missingCount:null}});
    const reader=new StreamSegmentReader(composite.rows!);const got:string[]=[];
    const {StreamArchiveBridge}=await import('../../../../src/integrations/stream-archive-bridge');
    await new StreamArchiveBridge(composite.catalog,{stream:reader,legacy:reader}).read(owner.pane,0,F,new AbortController().signal,async f=>{got[f.row.id.lineId]=rowAnsi(f.row);});
    expect(got).toEqual(oracle);
    // Mutants: a frozen revision below the row, a misaligned legacy page and a
    // tampered fragment are errors, never a short page or an EOF.
    const frozen:ArchiveSegment={...seg,revision:0};
    await expect(reader.read(frozen,0,0,new AbortController().signal)).rejects.toThrow('newer than frozen');
    const realBefore=legacy.readBefore.bind(legacy);
    legacy.readBefore=(s,b,l)=>{const p=realBefore(s,b,l);return{...p,startLine:p.startLine+1};};
    expect(()=>archive.readBefore('t',null,2)).toThrow('range fence');
    legacy.readBefore=realBefore;
    archive.dropSession!('t');expect(composite.catalog.paneForSession('t')).toBeNull();
    composite.catalog.bindSession('t',owner.pane);
    await runtime.close();
    composite.rows!.close();(composite as any).reader=null;
    const db=new Database(join(root,'stream-history.sqlite'));
    expect(db.query("UPDATE sh_fragment SET payload=replace(payload,'\"width\":1','\"width\":2') WHERE line=10").run().changes).toBe(1);db.close();
    expect(()=>archive.readBefore('t',F,500)).toThrow('checksum');
  }finally{
    installStreamArchive(null);composite?.close();
    await runtime.close().catch(()=>{});await rm(root,{recursive:true,force:true});
  }
},30000);

/** A keeper tick report for one session that proves the writer ran. */
const writerRan={sessionsConsidered:1,caughtUp:1,linesAppended:0};
/** Host with a real unix socket path, a fake tmux identity and a fake pipe owner.
 * `history` is what the fake tmux reports as the pane's retained history (rows
 * as plain text). The legacy writer kick is registered the way src/index.ts
 * registers the keeper; `kick` replaces its report. */
async function r5Host(root:string,options:{legacyLines?:(s:string)=>number}={},history:{size:number,limit:number,rows?:string[]}|null=null,
  kick:(s:string)=>unknown=()=>writerRan){
  const sock=join(root,'tmux.sock');const server=Bun.listen({unix:sock,socket:{data(){}}});
  writeFileSync(join(root,'allowlist.json'),JSON.stringify({server:'S1',sessions:[{sessionId:'$1'}]}));
  const events:string[]=[];let handlers:any=null;
  setLegacyWriterKick(async s=>{events.push('writer:'+s);return kick(s);});
  const host=new StreamPipeHost({root,tmuxSocket:sock,legacyLines:()=>0,handoffRetryMs:20,...options});
  (host as any).tmux=(args:string[])=>args.includes('#{history_size} #{history_limit}')
    ?(history?{exitCode:0,stderr:'',stdout:`${history.size} ${history.limit}\n`+(history.rows??Array.from({length:history.size},()=>'')).map(l=>l+'\n').join('')}:{exitCode:1,stderr:'gone',stdout:''})
    :args.includes('#{history_size} #{cursor_x} #{cursor_y} #{alternate_on} #{pane_width} #{pane_height}')
      ?{exitCode:0,stderr:'',stdout:'0 0 0 0 12 3\n\n\n\n'}
    :{exitCode:0,stderr:'',stdout:args.includes('-t')?'$1\t%9\t123\n':'S1\n'};
  (host as any).pipes={
    startBinaryPipe:(_s:string,h:any)=>{handlers=h;events.push('start');return true;},
    stopPipe:async(s:string)=>{events.push('stop:'+s);return{sourceDetached:true,readerEof:true,lastAdmittedSequence:null,lastAckedSequence:null,
      ramRevision:null,durableRevision:null,issues:[],unknownTail:false};},
  };
  await host.start();
  host.projection.onRouteChange(s=>events.push('route:'+s+':'+host.projection.ownsPipe(s)));
  const identity={pane:{serverIdentity:`${sock}#S1`,paneId:'%9',birthGeneration:123},sourceEpoch:1,geometryGeneration:0};
  const attach=async(session='s')=>{
    const pane=await host.runtime.add(identity,{columns:12,rows:3},streamPorts);pane.stopCadence();
    await host.attachSource(session,pane,1);return pane;
  };
  return{host,events,attach,handlers:()=>handlers,identity,close:async()=>{try{await host.close();}finally{server.stop(true);setLegacyWriterKick(null);}}};
}

test('stream I host rollback: planned route switch and shutdown commit one durable interval and release the pipe first',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stream-i-r5-host-'));
  const history={size:0,limit:2000};
  const rig=await r5Host(root,{},history);const legacy=new FakeLegacyArchive(),archive=composeLegacyArchive(legacy);
  try{
    // No tenure yet: the host started without creating a catalog or marker.
    expect(rig.host.archive).toBeNull();expect(existsSync(join(root,'stream-archive.sqlite'))).toBe(false);
    const pane=await rig.attach();
    expect(existsSync(join(root,'stream-tenure'))).toBe(true);
    expect(rig.host.projection.owns('s')).toBe(true);
    await rig.handlers().onBytes(Buffer.from(Array.from({length:30},(_,i)=>`p${i}\r\n`).join('')));
    const F=(await pane.drain())!.head,oracle=await oracleRows(pane,F);
    // tmux holds the same F rows: the fence is proven by content, not count.
    history.size=F;(history as any).rows=oracle.map(l=>plain(l).trimEnd());
    const receipt=await rig.host.setRoute('s','legacy');
    expect(receipt).toMatchObject({ok:true,from:'newarch',to:'legacy'});
    // Our writer is detached before the legacy path is told to attach its own.
    // Exactly one route announcement, only after the pipe was stopped, then
    // the legacy writer is started at once (no viewer exists here).
    expect(rig.events).toEqual(['start','route:s:true','stop:s','route:s:false','writer:s']);
    expect(rig.host.projection.owns('s')).toBe(false);
    const catalog=rig.host.archive!.catalog;
    // tmux still holds the F stream rows from its row 0: legacy resumes after them.
    expect(catalog.owner(rig.identity.pane)).toMatchObject({route:'legacy',generation:2,globalStart:F,localStart:F});
    expect(catalog.segmentAt(rig.identity.pane,F-1)).toMatchObject({route:'stream',globalEnd:F,seam:{kind:'planned',missingCount:null}});
    expect(catalog.segmentAt(rig.identity.pane,F-1)!.seam.reason).toContain('fence exact: tmux row 0 is stream row 0');
    legacy.lines.set('s',[...oracle.map(l=>'tmux:'+plain(l)),'after-0']);
    walk(archive,'s',[...oracle,'after-0'],7);
    // A second switch and re-entry are refused, not faked.
    expect((await rig.host.setRoute('s','newarch')).ok).toBe(false);
    await expect(rig.attach()).rejects.toThrow('stream re-entry requires bootstrap proof');
  }finally{await rig.close();await rm(root,{recursive:true,force:true});}
  // Shutdown freezes every live tenure; the next boot finalizes nothing new.
  const root2=await mkdtemp(join(tmpdir(),'stream-i-r5-shutdown-'));
  const rig2=await r5Host(root2);
  try{
    const pane=await rig2.attach('z');await rig2.handlers().onBytes(Buffer.from('a\r\nb\r\nc\r\nd\r\n'));
    const F=(await pane.drain())!.head;
    const closed=await rig2.host.close();expect(closed.issues).toEqual([]);expect(closed.drained).toBe(true);
    // Shutdown leaves the handoff PREPARED: the next boot proves its fence
    // again against what tmux and the legacy writer hold, then commits.
    expect(rig2.host.archive).not.toBeNull();
    const again=new StreamPipeHost({root:root2,tmuxSocket:(rig2.host.options.tmuxSocket)});
    (again as any).pipes=(rig2.host as any).pipes;(again as any).tmux=(rig2.host as any).tmux;
    await again.start();
    expect(again.finalize).toEqual({finalized:[],resolved:['shutdown:1'],blocked:[]});
    expect(again.archive!.catalog.segmentAt(rig2.identity.pane,0)).toMatchObject({globalEnd:F,seam:{kind:'shutdown',missingCount:null}});
    await again.close();
  }finally{await rig2.close().catch(()=>{});await rm(root2,{recursive:true,force:true});}
},60000);

test('stream I source EOF fails closed: no reopen, durable unresolved gap, rows kept, pane handed to legacy; prehistory is refused',async()=>{
  const root=await mkdtemp(join(tmpdir(),'stream-i-r5-eof-'));
  // tmux unreadable at the fence (pane gone): the fence assumes row 0.
  const rig=await r5Host(root);const legacy=new FakeLegacyArchive(),archive=composeLegacyArchive(legacy);
  try{
    const pane=await rig.attach();const h=rig.handlers();
    await h.onBytes(Buffer.from(Array.from({length:20},(_,i)=>`e${i}\r\n`).join('')+'\x1b[3'));
    const F=(await pane.drain())!.head,oracle=await oracleRows(pane,F);
    h.onBroken({reason:'eof',message:'source EOF'});
    expect(()=>h.prepareRestart(2)).toThrow('no upstream journal');
    h.onBroken({reason:'eof',message:'source EOF'}); // notifyBroken after the refusal
    const catalog=rig.host.archive!.catalog;
    for(let i=0;i<200&&catalog.owner(rig.identity.pane)?.route!=='legacy';i++)await Bun.sleep(10);
    expect(catalog.owner(rig.identity.pane)).toMatchObject({route:'legacy',globalStart:F,generation:2,localStart:F});
    for(let i=0;i<200&&rig.events.length<5;i++)await Bun.sleep(10);
    expect(rig.events).toEqual(['start','route:s:true','stop:s','route:s:false','writer:s']);
    const durable=rig.host.archive!.rows!.durable(rig.identity.pane)!;
    // C fenced the episode durably at EOF; the catalog seam is its final verdict.
    expect(durable.gap).toMatchObject({reason:'eof',missingCount:null,lastAdmittedRow:F-1});
    const seam=catalog.segmentAt(rig.identity.pane,0)!.seam;
    expect(seam).toMatchObject({kind:'source-eof',missingCount:null});
    expect(seam.reason.startsWith('source EOF; fence source-gone:')).toBe(true);
    expect(durable.head).toBe(F);
    // Below the fence the legacy suffix is empty, not an error.
    legacy.lines.set('s',Array.from({length:F-1},(_,i)=>`tmux${i}`));
    walk(archive,'s',oracle,3);
    legacy.lines.set('s',[...Array.from({length:F},(_,i)=>`tmux${i}`),'resumed']);
    walk(archive,'s',[...oracle,'resumed'],3);
    expect((archive.readBefore('s',F+1,2) as any).markers).toEqual([{lineId:F,kind:'stream-source-eof',reason:seam.reason,missingCount:null}]);
  }finally{await rig.close();await rm(root,{recursive:true,force:true});}
  const root2=await mkdtemp(join(tmpdir(),'stream-i-r5-prehistory-'));
  const rig2=await r5Host(root2,{legacyLines:()=>3});
  try{
    await expect(rig2.attach('p')).rejects.toThrow('legacy prehistory');
    // Refused before any tenure: no catalog, no marker.
    expect(rig2.host.archive).toBeNull();expect(existsSync(join(root2,'stream-tenure'))).toBe(false);
    expect(rig2.events).toEqual([]);
  }finally{await rig2.close();await rm(root2,{recursive:true,force:true});}
},60000);

test('stream I flag-off boot freezes a crashed tenure (replay), resolves PREPARED, aborts PREPARE, and opens nothing without a catalog',async()=>{
  const empty=await mkdtemp(join(tmpdir(),'stream-i-r5-none-'));
  expect(await openStreamArchiveForLegacy(empty,()=>{})).toBeNull();
  expect(existsSync(join(empty,'stream-archive.sqlite'))).toBe(false);
  await rm(empty,{recursive:true,force:true});
  const root=await mkdtemp(join(tmpdir(),'stream-i-r5-crash-')),crash=await mkdtemp(join(tmpdir(),'stream-i-r5-crash-copy-'));
  const runtime=new StreamRuntime({path:join(root,'stream-history.sqlite')});
  writeStreamTenureMarker(root);
  const catalogA=openStreamArchive(root,true)!;
  try{
    const a=await runtime.add(streamTestIdentity,{columns:12,rows:3},streamPorts);a.stopCadence();
    const bKey={...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%2'}};
    const cKey={...streamTestIdentity,pane:{...streamTestIdentity.pane,paneId:'%3'}};
    const b=await runtime.add(bKey,{columns:12,rows:3},streamPorts);b.stopCadence();
    const c=await runtime.add(cKey,{columns:12,rows:3},streamPorts);c.stopCadence();
    for(const [p,tag] of [[a,'a'],[b,'b'],[c,'c']] as const){
      await p.ingest(Buffer.from(Array.from({length:12},(_,i)=>`${tag}${i}\r\n`).join('')));await p.drain();
    }
    const owner=(pane:typeof a)=>({pane:pane.identity.pane,route:'stream' as const,generation:1,globalStart:0,localStart:0,root:'sh',schema:'sh-v1'});
    for(const p of [a,b,c])catalogA.catalog.initialize(owner(p));
    catalogA.catalog.bindSession('a',a.identity.pane);
    // b: PREPARED rollback whose commit ACK was lost; c: PREPARE without proof.
    const bcp=(await b.drain())!;
    catalogA.catalog.begin(b.identity.pane,'eof:1',1,'legacy');
    catalogA.catalog.prepareFence(b.identity.pane,'eof:1',{localEnd:bcp.head,revision:bcp.revision,checkpoint:bcp},
      {...owner(b),route:'legacy',generation:2,globalStart:bcp.head},{kind:'source-authoritative',reason:'tmux'},
      {kind:'source-eof',missingCount:null,reason:'eof'});
    catalogA.catalog.begin(c.identity.pane,'planned:1',1,'legacy');
    // a: the process "dies" after H journaled input but before its checkpoint
    // was written. The copy is taken at H's own pre-checkpoint boundary (no
    // transaction open), so it holds journal input no checkpoint covers. The
    // live pane continues normally and is the oracle.
    const files=['stream-tenure','stream-history.sqlite','stream-history.sqlite-wal','stream-history.sqlite-shm','stream-archive.sqlite','stream-archive.sqlite-wal','stream-archive.sqlite-shm'];
    let armed=true;
    (runtime.history as any).options.boundary=(at:string)=>{
      if(!armed||at!=='checkpoint-before-write')return;armed=false;
      for(const f of files)if(existsSync(join(root,f)))copyFileSync(join(root,f),join(crash,f));
    };
    await a.ingest(Buffer.from(Array.from({length:12},(_,i)=>`late${i}\r\n`).join('')));
    expect(armed).toBe(false);
    const finalA=(await a.drain())!.head,oracleA=await oracleRows(a,finalA);
    catalogA.close();await runtime.close();
    const pre=new StreamArchiveRowReader(join(crash,'stream-history.sqlite'));
    const before=pre.durable(a.identity.pane)!;pre.close();
    const logs:string[]=[];
    const report=(await openStreamArchiveForLegacy(crash,m=>logs.push(m)))!;
    try{
      // b's PREPARED has no attach anchor: its fence cannot be proven again,
      // so it is aborted and fenced closed, keeping its recorded event.
      expect(report.resolved).toEqual([]);
      expect(report.blocked).toEqual([]);
      expect(report.finalized.sort()).toEqual(['finalize:1','finalize:1:after:eof:1','finalize:1:after:planned:1']);
      const legacy=new FakeLegacyArchive(),archive=composeLegacyArchive(legacy);
      // Replay projected the journal tail with original IDs: same rows as the
      // pane that drained normally, nothing duplicated or invented.
      walk(archive,'a',oracleA,7);
      // The copy really held unprojected journal input, so replay was exercised.
      expect(before.journalAfterCheckpoint).toBe(true);
      const {activeStreamArchive}=await import('../../../../src/integrations/stream-archive-bridge');
      const cat=activeStreamArchive()!.catalog;
      expect(cat.owner(c.identity.pane)).toMatchObject({route:'legacy',generation:2});
      expect(cat.handoff(c.identity.pane,'planned:1')!.phase).toBe('ABORTED');
      expect(cat.segmentAt(b.identity.pane,0)!.seam.kind).toBe('source-eof');
      expect(cat.segmentAt(b.identity.pane,0)!.seam.reason).toContain('refenced at boot; fence source-gone: no attach anchor');
      expect(cat.handoff(b.identity.pane,'eof:1')!.phase).toBe('ABORTED');
      expect(cat.streamOwners()).toEqual([]);
    }finally{closeStreamArchiveForLegacy();}
    // Booting again is idempotent.
    const second=(await openStreamArchiveForLegacy(crash,()=>{}))!;
    expect(second).toEqual({finalized:[],resolved:[],blocked:[]});closeStreamArchiveForLegacy();
  }finally{
    try{catalogA.close();}catch{}await runtime.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});await rm(crash,{recursive:true,force:true});
  }
},60000);

import { readFileSync, readdirSync, statSync, mkdirSync as mkdirSyncFs } from 'node:fs';
import { finalizeStreamOwners, ARCHIVE_CATALOG_VERSION } from '../../../../src/integrations/stream-archive-bridge';
const fixturePane=(id:string)=>({serverIdentity:'/fixture.sock#S1',paneId:id,birthGeneration:7});
/** Load a catalog dumped by the real v1 code (see the fixture header). */
function v1Catalog(dir:string,name:'pre-r5'|'r5',copy='a'):string{
  const path=join(dir,`${name}-${copy}.sqlite`),db=new Database(path,{create:true});
  db.exec(readFileSync(join(import.meta.dir,'fixtures',`stream-archive-catalog-v1-${name}.sql`),'utf8'));db.close();
  return path;
}

test('stream I catalog v1 artifacts from round 4 and round 5 open, migrate once, and finalize with this code',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stream-i-v1-'));
  try{
    for(const name of ['pre-r5','r5'] as const){
      const path=v1Catalog(dir,name);
      const raw=new Database(path,{readonly:true});
      expect(raw.query('SELECT version FROM sa_format').get()).toEqual({version:1});
      const hadRoute=(raw.query("SELECT name FROM pragma_table_info('sa_owner')").all() as any[]).some(c=>c.name==='route');
      raw.close();
      expect(hadRoute).toBe(name==='r5');
      // A read-only open never migrates; it says what is needed.
      expect(()=>new StreamArchiveCatalog(path,true)).toThrow('must be migrated');
      const catalog=new StreamArchiveCatalog(path);
      try{
        expect(catalog.hasTenure()).toBe(true);
        expect(catalog.owner(fixturePane('%1'))).toMatchObject({route:'legacy',generation:2,globalStart:10});
        expect(catalog.streamOwners().map(o=>o.pane.paneId).sort()).toEqual(['%2','%3']);
        const seg=catalog.segmentAt(fixturePane('%1'),9)!;
        expect(seg).toMatchObject({route:'stream',globalStart:0,globalEnd:10});
        // Round 4 recorded no seam: it is unknown, never promoted to 0.
        expect(seg.seam).toEqual(name==='pre-r5'
          ?{kind:'planned',missingCount:null,reason:'interval written by a v1 catalog; its seam was not recorded'}
          :{kind:'planned',missingCount:null,reason:'writer detached'});
        const pending=catalog.pending(fixturePane('%3'))!;
        expect(pending.phase).toBe('PREPARED');
        expect(pending.prepared!.proof.kind).toBe('vt-import');
        // Boot finalization over the migrated file: the old PREPARED rollback
        // carries no fence proof (its destination is the round-5 `+0`), so it
        // is aborted and fenced closed; the live tenure is frozen, the old
        // interval untouched.
        const report=await finalizeStreamOwners(catalog,null,{kind:'restart',missingCount:null,reason:'boot'});
        expect(report).toEqual({finalized:['finalize:1','finalize:1:after:eof:1'],resolved:[],blocked:[]});
        expect(catalog.handoff(fixturePane('%3'),'eof:1')!.phase).toBe('ABORTED');
        expect(catalog.segmentAt(fixturePane('%3'),0)).toMatchObject({globalEnd:4,handoffId:'finalize:1:after:eof:1',
          seam:name==='pre-r5'?{kind:'planned',missingCount:null}:{kind:'source-eof',missingCount:null}});
        expect(catalog.owner(fixturePane('%3'))).toMatchObject({route:'legacy',localStart:4});
        expect(catalog.streamOwners()).toEqual([]);
        if(name==='r5')expect(catalog.paneForSession('s1')).toEqual(fixturePane('%1'));
      }finally{catalog.close();}
      const db=new Database(path,{readonly:true});
      expect(db.query('SELECT version FROM sa_format').get()).toEqual({version:ARCHIVE_CATALOG_VERSION});
      expect((db.query("SELECT name FROM pragma_table_info('sa_owner')").all() as any[]).map(c=>c.name)).toEqual(['pane','route','payload','digest']);
      db.close();
      // Reopening a migrated catalog is a no-op.
      new StreamArchiveCatalog(path).close();
    }
    // A corrupt v1 row aborts the migration and leaves the artifact as it was.
    const path=v1Catalog(dir,'pre-r5','corrupt');
    const db=new Database(path);db.query("UPDATE sa_owner SET digest='00' WHERE instr(pane,'\"%2\"')>0").run();db.close();
    const before=readFileSync(path);
    expect(()=>new StreamArchiveCatalog(path)).toThrow('checksum');
    const after=new Database(path,{readonly:true});
    expect(after.query('SELECT version FROM sa_format').get()).toEqual({version:1});
    expect((after.query("SELECT name FROM pragma_table_info('sa_owner')").all() as any[]).map(c=>c.name)).toEqual(['pane','payload','digest']);
    after.close();
    expect(readFileSync(path).equals(before)).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
},30000);

/** Private tmux server (explicit -S socket, never the default server). */
function privateTmux(dir:string,historyLimit=2000){
  const socket=join(dir,'tmuxdir',`tmux-${process.getuid!()}`,'default');
  mkdirSyncFs(join(dir,'tmuxdir',`tmux-${process.getuid!()}`),{recursive:true,mode:0o700});
  const env:Record<string,string>={};
  for(const [k,v] of Object.entries(process.env))if(v!==undefined&&k!=='TMUX'&&k!=='TMUX_PANE')env[k]=v;
  env.TMUX_TMPDIR=join(dir,'tmuxdir');
  const t=(args:string[])=>{
    const r=Bun.spawnSync(['tmux','-S',socket,'-f','/dev/null',...args],{env});
    if(r.exitCode!==0)throw Error(r.stderr.toString());return r.stdout.toString();
  };
  const session=(name:string,command='sleep 600',cols=12,rows=3)=>{
    t(['start-server',';','set-option','-g','history-limit',String(historyLimit),';',
      'new-session','-d','-s',name,'-x',String(cols),'-y',String(rows),command]);
    return t(['display-message','-p','-t',`=${name}:0.0`,'#{pane_id}']).trim();
  };
  return{socket,t,session,kill:()=>Bun.spawnSync(['tmux','-S',socket,'kill-server'],{env})};
}
const streamFiles=(root:string)=>readdirSync(root).filter(n=>n.startsWith('stream-')).sort()
  .map(n=>{const p=join(root,n),st=statSync(p);return[n,st.isFile()?Bun.hash(readFileSync(p)).toString(36):'dir',st.mtimeMs];});

test('stream I flag off: boots run nothing of stream-first without a recorded tenure; with one, rollback runs and closes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stream-i-flagoff-'));const server=privateTmux(dir);
  const {startPipeHistoryHostFromEnv,stopPipeHistoryHost}=await import('../../../../src/integrations/pipe-history-host');
  const {activeStreamArchive}=await import('../../../../src/integrations/stream-archive-bridge');
  try{
    server.session('fo');
    const root=join(dir,'root');mkdirSyncFs(root,{recursive:true});
    // An empty catalog, as a flag-on host of the previous round created at
    // start without any attach: no owner, no marker. It is not a tenure.
    new StreamArchiveCatalog(join(root,'stream-archive.sqlite')).close();
    const before=streamFiles(root);
    expect(before.map(f=>f[0])).toEqual(['stream-archive.sqlite']);
    for(const flag of [undefined,'0',undefined,'0']){
      const env:Record<string,string>={CORTEX_NEWARCH_ROOT:root,CORTEX_NEWARCH_TMUX_SOCKET:server.socket};
      if(flag)env.CORTEX_STREAM_FIRST=flag;
      const host=await startPipeHistoryHostFromEnv(env,()=>{});
      expect(host).not.toBeNull();expect('archive' in (host as object)).toBe(false);
      expect(activeStreamArchive()).toBeNull();
      await stopPipeHistoryHost();
      // Not one stream file created, opened for write or touched.
      expect(streamFiles(root)).toEqual(before);
    }
    // A recorded tenure (marker + an owner still on stream): flag-off boot
    // freezes it before the legacy host starts, and stop uninstalls it.
    const c=new StreamArchiveCatalog(join(root,'stream-archive.sqlite'));
    c.initialize({pane:fixturePane('%5'),route:'stream',generation:1,globalStart:0,localStart:0,root:'sh',schema:'sh-v1'});c.close();
    writeStreamTenureMarker(root);
    const logs:string[]=[];
    await startPipeHistoryHostFromEnv({CORTEX_NEWARCH_ROOT:root,CORTEX_NEWARCH_TMUX_SOCKET:server.socket},m=>logs.push(m));
    expect(activeStreamArchive()!.catalog.owner(fixturePane('%5'))).toMatchObject({route:'legacy',generation:2});
    expect(logs.filter(l=>l.includes('rollback blocked'))).toEqual([]);
    await stopPipeHistoryHost();
    expect(activeStreamArchive()).toBeNull();
  }finally{await stopPipeHistoryHost().catch(()=>{});server.kill();await rm(dir,{recursive:true,force:true});}
},60000);

/** Real stream host on a private tmux server: real allowlist and pane
 * identity, real pipe-pane FIFO (the stream sees only bytes tmux pipes after
 * attach), the real history keeper registered as the legacy writer kick the
 * way src/index.ts registers it, and a real TerminalHistoryArchive read
 * through DbHistoryArchive. Nothing on either side is fed or seeded by hand.
 * Session `s` waits on `go1`/`go2` and then prints b*, c*; session `p` prints
 * before anything can attach. */
async function realPipeRig(historyLimit:number,{register=true,bLines=30,cLines=20}={}){
  const dir=await mkdtemp(join(tmpdir(),'stream-i-pipe-'));const server=privateTmux(dir,historyLimit);
  const previousDir=process.env.TERMINAL_HISTORY_DIR;process.env.TERMINAL_HISTORY_DIR=join(dir,'history');
  const {TerminalHistoryArchive}=await import('../../../../src/integrations/terminal-history');
  const {DbHistoryArchive}=await import('../../../../src/integrations/db-history-archive');
  const {runHistoryKeeperTick}=await import('../../../../src/integrations/history-keeper');
  const b=Array.from({length:bLines},(_,i)=>`b${i}`),c=Array.from({length:cLines},(_,i)=>`c${i}`);
  writeFileSync(join(dir,'b.txt'),b.map(l=>l+'\n').join(''));writeFileSync(join(dir,'c.txt'),c.map(l=>l+'\n').join(''));
  writeFileSync(join(dir,'a.txt'),Array.from({length:30},(_,i)=>`a${i}\n`).join(''));
  const wait=(f:string)=>`while [ ! -e ${dir}/${f} ]; do sleep 0.05; done`;
  const paneId=server.session('s',`sh -c '${wait('go1')}; cat ${dir}/b.txt; ${wait('go2')}; cat ${dir}/c.txt; exec sleep 600'`);
  const pPane=server.session('p',`sh -c 'cat ${dir}/a.txt; exec sleep 600'`);
  const capture=(start:number)=>{
    const lines=server.t(['capture-pane','-t',paneId,'-p','-e','-S',String(start)]).split('\n');
    while(lines.length&&lines.at(-1)!.trim()==='')lines.pop();return lines.join('\n');
  };
  const tmuxHas=async(id:string,text:string)=>{
    const has=()=>server.t(['capture-pane','-t',id,'-p','-S',String(-historyLimit)]).split('\n').some(l=>l.trimEnd()===text);
    for(let i=0;i<200&&!has();i++)await Bun.sleep(25);expect(has()).toBe(true);
  };
  const file=new TerminalHistoryArchive(),legacyArchive=composeLegacyArchive(new DbHistoryArchive(file as any));
  const root=join(dir,'root');mkdirSyncFs(root);
  const stamp=server.t(['display-message','-p','#{pid}@#{start_time}']).trim();
  const ids=(name:string)=>server.t(['display-message','-p','-t',`=${name}:0.0`,'#{session_id}\t#{pane_id}\t#{pane_pid}']).trim().split('\t');
  writeFileSync(join(root,'allowlist.json'),JSON.stringify({server:stamp,sessions:[{sessionId:ids('s')[0]},{sessionId:ids('p')[0]}]}));
  const host=new StreamPipeHost({root,tmuxSocket:server.socket,handoffRetryMs:30});
  const listed={value:true};
  const deps={
    listSessions:()=>listed.value?[{name:'s',paneRows:3}]:[],sampleDeadPanes:()=>new Set<string>(),historyLimit:()=>historyLimit,liveLineLimit:()=>3,
    routedAway:(name:string)=>host.isRouted(name),capture:async(_s:string,o:{startLine:number})=>capture(o.startLine),
    archivedTail:(name:string,n:number)=>{const t=file.getManifest(name).totalLines;return t?file.readRange(name,Math.max(0,t-n),t):[];},
    appendLines:(name:string,l:string[])=>file.appendLines(name,l),appendMarker:(name:string,x:string)=>file.appendLines(name,[x]),warn:()=>{},
  };
  const kick=(name:string)=>runHistoryKeeperTick(deps,{session:name});
  if(register)setLegacyWriterKick(kick);
  await host.start();
  const identityOf=(name:string)=>{const [,pane,pid]=ids(name);
    return{pane:{serverIdentity:`${server.socket}#${stamp}`,paneId:pane,birthGeneration:Number(pid)},sourceEpoch:1,geometryGeneration:0};};
  const identity=identityOf('s');
  const attach=async(name='s')=>{
    const pane=await host.runtime.add(identityOf(name),{columns:12,rows:3},streamPorts);pane.stopCadence();
    try{await host.attachSource(name,pane,1);}catch(error){await host.runtime.remove(pane);throw error;}
    return pane;
  };
  /** Wait until the stream parsed (through the pipe) and H made durable the
   * row `text`; returns the durable head. Rows are read as the fence reads them. */
  const streamHas=async(pane:import('../src/stream-runtime').StreamRuntimePane,text:string)=>{
    for(let i=0;i<200;i++){
      await pane.drain().catch(()=>{});const d=host.archive!.rows!.durable(identity.pane);
      if(d&&streamRowsReader(host.archive!.rows,identity.pane,d.durable)(0,d.head).includes(text))return d.head;
      await Bun.sleep(25);
    }
    throw Error(`stream never parsed ${text}`);
  };
  /** The joined legacy history, paged both ways at several sizes (must agree). */
  const history=()=>{
    const back:string[]=[],fwd:string[]=[];
    for(const limit of [1,4,500]){
      back.length=0;fwd.length=0;let at:number|null=null;
      for(let g=0;;g++){const p=legacyArchive.readBefore('s',at,limit) as any;back.unshift(...p.lines);if(!p.hasMore)break;at=p.startLine;if(g>500)throw Error('no progress');}
      at=null;for(let g=0;;g++){const p=legacyArchive.readAfter!('s',at,limit) as any;fwd.push(...p.lines);if(!p.hasMore)break;at=p.endLine-1;if(g>500)throw Error('no progress');}
      expect(fwd).toEqual(back);
    }
    return back.map(l=>plain(l).trimEnd());
  };
  const catalog=()=>host.archive!.catalog;
  const cleanup=async()=>{
    setLegacyWriterKick(null);await host.close().catch(()=>{});installStreamArchive(null);server.kill();
    if(previousDir===undefined)delete process.env.TERMINAL_HISTORY_DIR;else process.env.TERMINAL_HISTORY_DIR=previousDir;
    await rm(dir,{recursive:true,force:true});
  };
  return{dir,server,host,paneId,pPane,root,identity,attach,streamHas,tmuxHas,history,catalog,file,kick,listed,b,c,cleanup,
    go:(f:string)=>writeFileSync(join(dir,f),''),keeperTick:()=>runHistoryKeeperTick(deps)};
}
const tmuxHistorySize=(r:{server:{t:(a:string[])=>string},paneId:string})=>Number(r.server.t(['display-message','-p','-t',r.paneId,'#{history_size}']).trim());
const until=async(f:()=>boolean,what:string)=>{for(let i=0;i<400&&!f();i++)await Bun.sleep(10);if(!f())throw Error(`timed out: ${what}`);};

test('stream I real pipe: tmux prehistory is refused at attach; a blank pane rolls back with a content-proven fence and the real writer',async()=>{
  const r=await realPipeRig(2000);
  try{
    // `p` printed 30 rows before any attach. The legacy archive holds none of
    // them, which is all the previous admission checked; tmux does.
    await r.tmuxHas(r.pPane,'a29');
    await expect(r.attach('p')).rejects.toThrow('tmux prehistory');
    expect(r.host.archive).toBeNull();expect(existsSync(join(r.root,'stream-tenure'))).toBe(false);
    // `s` is blank: the anchor is recorded and only piped bytes reach the stream.
    const pane=await r.attach();
    expect(r.catalog().owner(r.identity.pane)!.anchor).toMatchObject({sourceRow:0});
    r.go('go1');await r.tmuxHas(r.paneId,'b29');
    const F=await r.streamHas(pane,`b${r.b.length-3}`);
    expect(F).toBe(r.b.length-2);expect(tmuxHistorySize(r)).toBe(F);
    const receipt=await r.host.setRoute('s','legacy');
    expect(receipt).toMatchObject({ok:true,from:'newarch',to:'legacy'});
    expect(r.host.pendingHandoffs()).toEqual([]);
    const seam=r.catalog().segmentAt(r.identity.pane,F-1)!.seam;
    expect(seam.reason).toContain('fence exact: tmux row 0 is stream row 0');
    expect(r.catalog().owner(r.identity.pane)).toMatchObject({route:'legacy',globalStart:F,localStart:F});
    // The writer already ran (no viewer exists): proven by its own append.
    expect(r.file.getManifest('s').totalLines).toBeGreaterThan(0);
    r.go('go2');await r.tmuxHas(r.paneId,`c${r.c.length-1}`);await r.keeperTick();
    const text=r.history(),printed=[...r.b,...r.c];
    expect(text).toEqual(printed.slice(0,text.length));
    expect(text.length).toBeGreaterThan(F+10);
    expect(new Set(text).size).toBe(text.length);
  }finally{await r.cleanup();}
},60000);

test('stream I real pipe: a full tmux history is aligned by content, not assumed — every row once',async()=>{
  const r=await realPipeRig(10);
  try{
    const pane=await r.attach();
    r.go('go1');await r.tmuxHas(r.paneId,'b29');
    const F=await r.streamHas(pane,'b27');
    expect(F).toBe(28);expect(tmuxHistorySize(r)).toBeGreaterThanOrEqual(9);
    expect((await r.host.setRoute('s','legacy')).ok).toBe(true);
    const held=r.catalog().owner(r.identity.pane)!.localStart;
    // tmux dropped the oldest rows; the rows it still holds were matched.
    expect(r.catalog().segmentAt(r.identity.pane,F-1)!.seam.reason).toContain(`fence exact: tmux row 0 is stream row ${F-held}`);
    // The writer's seed is tmux's copy of the matched rows; all are skipped.
    // (Output after this would overflow a 10-row tmux before the keeper's
    // next tick — the keeper's own gap path, not the handoff's.)
    await r.keeperTick();
    const text=r.history();
    expect(text.slice(0,F)).toEqual(r.b.slice(0,F));
    expect(text).toEqual(r.b.slice(0,text.length));
    expect(new Set(text).size).toBe(text.length);
  }finally{await r.cleanup();}
},60000);

test('stream I real pipe: clear-history in the tenure is aligned by content, never by count; unmatched tmux rows fail closed with nothing doubled',async()=>{
  const r=await realPipeRig(2000,{cLines:30});
  try{
    const pane=await r.attach();
    r.go('go1');await r.tmuxHas(r.paneId,'b29');
    const F0=await r.streamHas(pane,'b27');
    r.server.t(['clear-history','-t',r.paneId]);
    r.go('go2');await r.tmuxHas(r.paneId,'c29');const F=await r.streamHas(pane,'c27');
    // tmux history climbed back above the stream's first rows: a count-only
    // fence called this exact and silently skipped real rows (review N2).
    expect(tmuxHistorySize(r)).toBeGreaterThanOrEqual(F0);
    expect((await r.host.setRoute('s','legacy')).ok).toBe(true);
    const seam=r.catalog().segmentAt(r.identity.pane,0)!.seam;
    expect(seam.reason).toContain(`fence exact: tmux row 0 is stream row ${F0}`);
    await r.keeperTick();
    const text=r.history(),printed=[...r.b,...r.c];
    // Every row up to the writer's live window, once, in order.
    expect(text.length).toBeGreaterThanOrEqual(F);expect(text).toEqual(printed.slice(0,text.length));
  }finally{await r.cleanup();}
  // Source EOF, then tmux history cleared and new output: tmux holds no row
  // the stream holds, so no offset is proven. Every row tmux held is skipped
  // (the declared gap); no stream row is shown twice.
  const q=await realPipeRig(2000,{register:false,cLines:30});
  try{
    const pane=await q.attach();
    q.go('go1');await q.tmuxHas(q.paneId,'b29');const F=await q.streamHas(pane,'b27');
    q.server.t(['pipe-pane','-t',q.paneId]);
    await until(()=>q.host.status().awaitingWriter.includes('s'),'EOF reached the host');
    q.server.t(['clear-history','-t',q.paneId]);
    q.go('go2');await q.tmuxHas(q.paneId,'c29');
    setLegacyWriterKick(q.kick);
    await until(()=>q.catalog().owner(q.identity.pane)?.route==='legacy','handoff after the writer registered');
    const seam=q.catalog().segmentAt(q.identity.pane,F-1)!.seam;
    expect(seam).toMatchObject({kind:'source-eof',missingCount:null});
    expect(seam.reason).toContain('fence unproven: no source offset matches the stream rows by content');
    await q.keeperTick();
    const text=q.history();
    expect(text.slice(0,F)).toEqual(q.b.slice(0,F));
    expect(new Set(text).size).toBe(text.length);
    expect(text.slice(F).some(l=>/^b/.test(l))).toBe(false);
  }finally{await q.cleanup();}
},60000);

test('stream I real pipe EOF: no writer keeps the route; once one registers the pane goes to legacy and output after the EOF is not lost',async()=>{
  const r=await realPipeRig(2000,{register:false});
  try{
    const pane=await r.attach();
    r.go('go1');await r.tmuxHas(r.paneId,'b29');
    const F=await r.streamHas(pane,'b27');
    // A real source EOF: tmux closes the pipe; the reader sees end of file.
    r.server.t(['pipe-pane','-t',r.paneId]);
    await until(()=>r.host.status().awaitingWriter.includes('s'),'EOF reached the host');
    // No legacy writer: nothing switched, the owner is still the stream.
    expect(r.host.isRouted('s')).toBe(true);
    expect(r.catalog().owner(r.identity.pane)!.route).toBe('stream');
    expect(r.host.archive!.rows!.durable(r.identity.pane)!.gap).toMatchObject({reason:'eof',missingCount:null});
    // tmux keeps printing; the stream receives none of it.
    r.go('go2');await r.tmuxHas(r.paneId,'c19');
    await pane.drain().catch(()=>{});expect(r.host.archive!.rows!.durable(r.identity.pane)!.head).toBe(F);
    setLegacyWriterKick(r.kick);
    await until(()=>r.catalog().owner(r.identity.pane)?.route==='legacy','handoff after the writer registered');
    expect(r.host.isRouted('s')).toBe(false);expect(r.host.status().awaitingWriter).toEqual([]);
    const seam=r.catalog().segmentAt(r.identity.pane,F-1)!.seam;
    expect(seam).toMatchObject({kind:'source-eof',missingCount:null});
    expect(seam.reason).toContain('fence exact');
    await r.keeperTick();
    // The EOF gap is declared, but tmux kept every byte: the joined history is
    // the printed sequence once, including what was written after the EOF.
    const text=r.history(),printed=[...r.b,...r.c];
    expect(text).toEqual(printed.slice(0,text.length));
    expect(text.length).toBeGreaterThan(r.b.length+10);
  }finally{await r.cleanup();}
},60000);

test('stream I real pipe: a legacy writer that throws or does not list the session is not a rollback — PREPARED, served without doubles, committed once proven',async()=>{
  const r=await realPipeRig(2000);
  try{
    const pane=await r.attach();
    r.go('go1');await r.tmuxHas(r.paneId,'b29');
    const F=await r.streamHas(pane,'b27');
    setLegacyWriterKick(()=>{throw Error('keeper exploded');});
    const first=await r.host.setRoute('s','legacy');
    expect(first.ok).toBe(false);expect(first.error).toContain('legacy writer not proven: legacy writer: keeper exploded');
    expect(r.host.pendingHandoffs()).toEqual(['s']);
    expect(r.catalog().pending(r.identity.pane)!.phase).toBe('PREPARED');
    expect(r.catalog().owner(r.identity.pane)!.route).toBe('stream');
    // The real writer, but the session is not listed (e.g. skipped by policy).
    r.listed.value=false;setLegacyWriterKick(r.kick);
    const second=await r.host.setRoute('s','legacy');
    expect(second.error).toContain('the legacy writer does not list this session');
    // Served as it will commit: the frozen rows, then nothing doubled.
    expect(r.history()).toEqual(r.b.slice(0,F));
    r.listed.value=true;
    await until(()=>r.catalog().owner(r.identity.pane)?.route==='legacy','retry commits once the writer is proven');
    expect(r.host.pendingHandoffs()).toEqual([]);
    r.go('go2');await r.tmuxHas(r.paneId,'c19');await r.keeperTick();
    const text=r.history(),printed=[...r.b,...r.c];
    expect(text).toEqual(printed.slice(0,text.length));expect(text.length).toBeGreaterThan(F+10);
  }finally{await r.cleanup();}
},60000);
