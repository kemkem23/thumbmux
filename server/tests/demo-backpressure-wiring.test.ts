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

async function until(f:()=>boolean,what:string){for(let i=0;i<400&&!f();i++)await Bun.sleep(10);if(!f())throw Error(`timed out: ${what}`);}
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

test('stream I handoff never ends silently: no writer keeps the route, an unproven writer stays PREPARED across shutdown, an unfreezable tenure is released whole',async()=>{
  const lines=Array.from({length:20},(_,i)=>`w${i}`);
  // Planned switch with no legacy writer registered: nothing is touched.
  const root=await mkdtemp(join(tmpdir(),'stream-i-r6-nowriter-'));
  const history={size:0,limit:2000,rows:[] as string[]};
  const rig=await r5Host(root,{},history);
  try{
    const pane=await rig.attach();setLegacyWriterKick(null);
    await rig.handlers().onBytes(Buffer.from(lines.map(l=>l+'\r\n').join('')));
    const F=(await pane.drain())!.head;history.size=F;history.rows=lines.slice(0,F);
    const refused=await rig.host.setRoute('s','legacy');
    expect(refused).toMatchObject({ok:false,from:'newarch',to:'newarch'});
    expect(refused.error).toContain('no legacy writer registered');
    expect(rig.events).toEqual(['start','route:s:true']);
    expect(rig.host.projection.owns('s')).toBe(true);
    expect(rig.host.archive!.catalog.pending(rig.identity.pane)).toBeNull();
    // The failed attempt is not cached: once a writer exists the switch works.
    setLegacyWriterKick(async s=>{rig.events.push('writer:'+s);return writerRan;});
    expect((await rig.host.setRoute('s','legacy')).ok).toBe(true);
    expect(rig.host.archive!.catalog.owner(rig.identity.pane)).toMatchObject({route:'legacy',localStart:F});
  }finally{await rig.close();await rm(root,{recursive:true,force:true});}
  // Source EOF; the writer pass does not list the session; the host stops.
  const root2=await mkdtemp(join(tmpdir(),'stream-i-r6-unproven-'));
  const h2={size:0,limit:2000,rows:[] as string[]};
  const rig2=await r5Host(root2,{},h2,()=>({sessionsConsidered:0}));
  try{
    const pane=await rig2.attach();const h=rig2.handlers();
    await h.onBytes(Buffer.from(lines.map(l=>l+'\r\n').join('')));
    const F=(await pane.drain())!.head;h2.size=F;h2.rows=lines.slice(0,F);
    h.onBroken({reason:'eof',message:'source EOF'});
    await until(()=>rig2.host.pendingHandoffs().includes('s'),'EOF handoff waits for a proven writer');
    const catalog=rig2.host.archive!.catalog;
    expect(catalog.pending(rig2.identity.pane)).toMatchObject({id:'source-eof:1',phase:'PREPARED'});
    expect(catalog.owner(rig2.identity.pane)!.route).toBe('stream');
    // Released to legacy (the writer may run) while the catalog waits.
    expect(rig2.host.projection.owns('s')).toBe(false);
    expect(rig2.host.status().pendingHandoffs).toEqual(['s']);
    const closed=await rig2.host.close();
    expect(closed.issues).toEqual(['s: handoff left PREPARED, legacy writer not proven']);
    expect(closed.drained).toBe(false);
    // The next boot proves the same fence against tmux and commits it.
    const again=new StreamPipeHost({root:root2,tmuxSocket:rig2.host.options.tmuxSocket});
    (again as any).pipes=(rig2.host as any).pipes;(again as any).tmux=(rig2.host as any).tmux;
    await again.start();
    expect(again.finalize).toEqual({finalized:[],resolved:['source-eof:1'],blocked:[]});
    expect(again.archive!.catalog.owner(rig2.identity.pane)).toMatchObject({route:'legacy',localStart:F});
    await again.close();
  }finally{await rig2.close().catch(()=>{});await rm(root2,{recursive:true,force:true});}
  // Source EOF where H cannot freeze a clean interval: no row is frozen, the
  // pane goes back to legacy whole (it re-reads every row tmux holds).
  const root3=await mkdtemp(join(tmpdir(),'stream-i-r6-unfrozen-'));
  const h3={size:0,limit:2000,rows:[] as string[]};
  const rig3=await r5Host(root3,{},h3);const legacy=new FakeLegacyArchive(),archive=composeLegacyArchive(legacy);
  try{
    const pane=await rig3.attach();const h=rig3.handlers();
    await h.onBytes(Buffer.from(lines.map(l=>l+'\r\n').join('')));
    const F=(await pane.drain())!.head;h3.size=F;h3.rows=lines.slice(0,F);
    const rows=rig3.host.archive!.rows!,real=rows.durable.bind(rows);
    (rows as any).durable=(k:any)=>{const d=real(k);return d&&{...d,revision:d.durable+1};};
    h.onBroken({reason:'eof',message:'source EOF'});
    const catalog=rig3.host.archive!.catalog;
    await until(()=>catalog.owner(rig3.identity.pane)?.route==='legacy','unfrozen release');
    (rows as any).durable=real;
    expect(catalog.owner(rig3.identity.pane)).toMatchObject({route:'legacy',globalStart:0,localStart:0});
    expect(catalog.segmentAt(rig3.identity.pane,0)).toBeNull();
    expect(catalog.handoff(rig3.identity.pane,'source-eof:1')!.prepared!.segment.seam.reason).toContain('stream rows not frozen');
    // Nothing frozen: the session is plain legacy again, every tmux row once.
    legacy.lines.set('s',[...lines,'after']);
    walk(archive,'s',[...lines,'after'],5);
  }finally{await rig3.close();await rm(root3,{recursive:true,force:true});}
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
    return{pane:{serverIdentity:`${server.socket}#${stamp}`,paneId:pane!,birthGeneration:Number(pid)},sourceEpoch:1,geometryGeneration:0};};
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

// ---- Pending integration (I). Cases S and A handed to T (02-S/05-A REPORT
// "งานที่ยังไม่ครบ"). They run only when the API exists on the tree under test;
// on the K base they are skipped/todo and are reported INCOMPLETE, never PASS.
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

const t11CatalogV3 = typeof (StreamArchiveCatalog.prototype as unknown as Record<string, unknown>).beginAttach === 'function';
test.skipIf(!t11CatalogV3)('T11 PENDING-I 05-A catalog v3: intent never publishes owner; stale CAS/handshake refused; lost ACK idempotent; abort cannot delete a committed owner; unknown gap stays null', async () => {
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

test.skipIf(!t11CatalogV3)('T11 PENDING-I 05-A remote index: upload exit 0 without verified readback is refused; offline location is remote-unavailable, never EOF', async () => {
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

// 02-S fixture-vectors.json cases: need S's collector + I's wiring. Every replay
// must be judged with t11JudgeRawReplay(t11RawOracle(), epoch, records).
for (const [id, action] of [
  ['S-01', 'foreground collector + actual FIFO writer; second host client after closing first → same collector identity, payload once, offsets from 0'],
  ['S-02', 'SIGKILL collector after observed ACK; restart same root; replay old binding → every ACKed byte survives; old epoch fault=collector-restart'],
  ['S-03', 'claim capture; host disconnects before tmux; retry same episode before/after deadline → no second claim; interrupted-capture'],
  ['S-04', 'new-session/new-window/split-window producers write byte 0 immediately; delayed catalog commit → all bytes; genesis certificate before exact birth'],
  ['S-05', 'foreign pipe before and raced with the guarded list → foreign unchanged; refusal has zero capture; own sender/FIFO retired'],
  ['S-06', '4500 retained history + screen; producer writes across pipe/capture/commit barriers → one capture, complete file/hash, overlap-unknown until certified'],
  ['S-07', 'lost finish ACK then same-intent retry from a new client → identical OpenCapture, zero pipe reopens, zero captures'],
  ['S-08', 'mutated epoch/rootUUID/nonce/ownerGeneration/peer UID, forged ACK/evidence digest → refused, watermark unchanged'],
  ['S-09', 'flood >256KiB frame, >32 connections, short writes, FIFO EOF, producer silence → bounded; silence does not reopen; EOF exposes last offset'],
  ['S-10', 'synthetic ENOSPC/fsync faults at cap → no ACK for failed transaction; reserve used for incident; unverified raw retained'],
  ['S-11', 'host shutdown/restart vs collector close with live pipes → client close keeps reader; planned close refused'],
  ['S-12', 'after all fixtures → no socket/FIFO/sender/collector left; store removed only by its owner'],
] as const) test.todo(`T11 PENDING-I 02-S ${id}: ${action}`);

for (const [id, behaviour] of [
  ['B1-03', 'crash in every attach state / refused / duplicate callback / lost ACK → intent withdrawn, foreign owner intact, capture-count ≤1 per episode'],
  ['B2-03', 'PREPARED boot with flag 0/1 before/after registration, receipt+dead binding, spool overflow before seed, keeper interleaving, migrated v2'],
  ['B3-02', 'retained case recovers the whole suffix; irrecoverable missing all under located gaps (t11JudgeTimeline fault mode), count unknown = null'],
  ['OFF-01', 'flag absent/0 without tenure → no I/O, worker, timer or Drive job; with tenure → compatibility continues, receipt before handoff'],
] as const) test.todo(`T11 PENDING-I ${id}: ${behaviour}`);
