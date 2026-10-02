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
