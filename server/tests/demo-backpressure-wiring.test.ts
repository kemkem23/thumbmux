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
import { StreamRuntime } from '../src/stream-runtime';
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
    await pane.ingest(Buffer.from('after-reopen\r\n'));
    expect(pane.frame.head).toBe(head+1);
    expect(pane.frame.durableRevision).toBe(pane.frame.revision);
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);

test('stream I atomic multi-page input retries an admitted prefix without duplicate rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stream-i-prefix-'));
 const runtime=new StreamRuntime({path:join(root,'stream.sqlite')});
 try{
  const pane=await runtime.add(streamTestIdentity,{columns:20,rows:4},streamPorts);
  const history=runtime.history!,append=history.appendFinalized.bind(history);let calls=0;
  history.appendFinalized=async request=>{
   calls++;
   if(calls===2)return{status:'busy',reason:'pressure',retryAfterMs:1};
   return append(request);
  };
  await pane.ingest(Buffer.from('\x1b[600S'));
  expect(calls).toBeGreaterThan(3);
  expect(pane.frame.head).toBe(600);
  expect(pane.frame.revision).toBe(3);
  expect(pane.frame.durableRevision).toBe(3);
  expect(history.stats().ownedPendingBytes).toBe(0);
  expect(runtime.scratch.heldBytes).toBe(0);
  expect(runtime.admission.heldBytes).toBe(0);
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);
