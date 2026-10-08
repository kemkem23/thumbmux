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

// The four stream I cases that drive the host StreamSourceTransport /
// StreamPipeHost rigs before T11 live in tests/integrations/tmux-pipe-process.test.ts (TP-A).
// (public split has no src/integrations).
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
import { writeFileSync, readFileSync } from 'node:fs';
// T-fix R20 (v1 catalog migration on the host StreamArchiveCatalog) moved to
// tests/integrations/terminal-durable-history-runtime.test.ts.
// ---------------------------------------------------------------------------
// T11 (NEWARCH flag-on lot 11-T) — independent oracle + adversarial fixtures.
// The oracle never calls matcher/stitch/product code: expected timelines are
// literal producer events; verdicts are literal violation codes. Product-side
// integration (B1-02/B1-03/B2-03/B3-02/OFF-01 against S/C/H/A/W wired by I) is
// NOT claimed here — those cases are registered below as pending until I lands.
// The region between the markers (fixtures/t11-oracle.ts) is self-contained so
// MUTATION runs can copy it.
// ---------------------------------------------------------------------------
// The oracle region itself lives in fixtures/t11-oracle.ts so the host flag-on
// rigs from T11 onward (tests/integrations/tmux-pipe-process-v2.test.ts, TP-B) judge with the same code.
import { t11JudgeTimeline, t11RawOracle, t11Ev, t11Gap, t11Range, t11OracleSelfTest } from './fixtures/t11-oracle';

import { createHash as t11Hash } from 'node:crypto';
import { spawnSync as t11Spawn } from 'node:child_process';
import { mkdtempSync as t11Mkdtemp, rmSync as t11Rm } from 'node:fs';

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
    const self = readFileSync(new URL('./fixtures/t11-oracle.ts', import.meta.url).pathname, 'utf8');
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

// ---- Cases S and A (05-A catalog v3 / remote index) drive the host
// StreamArchiveCatalog and moved to tests/integrations/terminal-durable-history-runtime.test.ts;
// the T-fix flag-on rig (S-01…S-12, R10/R14/R16, B1-03/B2-03/B3-02, OFF-01, V2-01)
// drives FlagOnPipeHost after T11 in tests/integrations/tmux-pipe-process-v2.test.ts (TP-B).

// ---------------------------------------------------------------------------
// NEWARCH v2 lot T (PLAN-v2 §8 V2-01…19 rows owned by T, §9 sampler contract).
// The reference composition above is the executable spec I/H/S plug into; the
// mutants prove each judge sees its failure class (§8 minimal mutant list).
// ---------------------------------------------------------------------------
import * as TV2K from '../src/stream-contract';
// T-V2-HARNESS-BEGIN
// PLAN-v2 §8 lot T: reference composition of the K-v2 contract + independent
// judges. One capture engine owns H for every NEWARCH pane for life. The model
// uses K's pure guards (TV2K) at the points where I/H/S must use them; real
// lots plug their composition into the same scenarios. Mutants below damage
// one invariant each in an isolated copy and must turn their scenarios red.
type TV2Key = string;
type TV2Event = { readonly seq: number; readonly writer: string; readonly holder: string | null;
  readonly pane: TV2Key | null; readonly kind: string; readonly detail: string };
interface TV2Row { readonly text: string; readonly ordinal: number }
interface TV2PaneDisk {
  desc: TV2K.NewarchV2PaneDescriptor; epoch: string; revision: number; rows: TV2Row[];
  incidents: Map<string, TV2K.NewarchV2Incident>; receipts: Map<string, TV2K.V2Receipt>;
  checkpoint: { id: string; through: number; replayFloor: number; revision: number } | null;
  stopped: boolean; lastAudit: string | null; auditedRevision: number | null; resizesSeen: number;
}
interface TV2Disk {
  lock: { engineId: string; alive: boolean } | null; generation: number; corrupt: boolean;
  sessions: Map<string, { state: 'reserved' | 'active' | 'closed'; birthOp: string }>;
  panes: Map<TV2Key, TV2PaneDisk>;
  journal: Map<string, { pane: TV2K.PaneKey; attachId: string; sessionId: string; activated: boolean }>;
  raw: Map<TV2Key, { epoch: string; records: string[]; trimmed: number; acked: number; resizes: number }>;
  emergency: Map<string, TV2K.NewarchV2Incident>; reserveUsed: number; reserveCap: number;
  /** E (#6): S's reserve slots — a journalled record, or empty and physically allocated — and its one scratch name per slot. */
  slots: (TV2K.V2EmergencyIncident | null)[]; scratch: Set<string>;
  legacy: Map<string, string[]>; files: string[]; timers: number; events: TV2Event[];
  space: { capRows: number };
}
interface TV2TmuxPane {
  id: string; name: string; sessionId: string; window: string; cols: number; rows: number;
  program: 'held' | 'running' | 'dead'; pipe: string | null; screen: string[]; born: 'gate' | 'raw';
}
interface TV2World {
  disk: TV2Disk; tmux: { serverId: string; next: number; windows: number; panes: Map<string, TV2TmuxPane> };
  emitted: Map<TV2Key, string[]>; collectorEpoch: string; collectorUp: boolean;
  flagBirth: boolean; audit: TV2K.V2AuditConfig; captures: number; seq: number;
  killAt: string | null;
  /** E (#6): every reserve-rearm observation H handed out (a test reads a stale one back). */
  observations: TV2K.V2ReserveRearmObservation[];
}
class TV2Kill extends Error {}
const tv2Assert = (ok: unknown, msg: string): void => { if (!ok) throw new Error(`T-V2 ${msg}`); };
const tv2Yield = () => new Promise<void>(r => setTimeout(r, 0));
const TV2_GEOMETRY = TV2K.v2BirthGeometry(TV2K.NEWARCH_V2_DEFAULT_CONFIG);
/** Engine-side pane index. PLAN-v2 §2: stable identity -> PaneKey set, never a session name. */
const tv2Index = (desc: TV2K.NewarchV2PaneDescriptor): TV2Key => TV2K.v2PaneKey(desc.pane);

function tv2World(over: Partial<Pick<TV2World, 'flagBirth' | 'audit'>> & { capRows?: number; reserveCap?: number } = {}): TV2World {
  return {
    disk: { lock: null, generation: 0, corrupt: false, sessions: new Map(), panes: new Map(), journal: new Map(),
      raw: new Map(), emergency: new Map(), reserveUsed: 0, reserveCap: over.reserveCap ?? 4, legacy: new Map(),
      slots: Array.from({ length: over.reserveCap ?? 4 }, () => null), scratch: new Set(),
      files: [], timers: 0, events: [], space: { capRows: over.capRows ?? 1_000_000 } },
    tmux: { serverId: 'srv@1', next: 0, windows: 0, panes: new Map() }, emitted: new Map(),
    collectorEpoch: 'collector-1', collectorUp: true, flagBirth: over.flagBirth ?? true,
    audit: over.audit ?? TV2K.NEWARCH_V2_DEFAULT_CONFIG.audit, captures: 0, seq: 0, killAt: null, observations: [],
  };
}
function tv2PaneOf(w: TV2World, k: TV2Key): TV2TmuxPane | undefined {
  for (const p of w.tmux.panes.values()) if (TV2K.v2PaneKey({ serverIdentity: w.tmux.serverId, paneId: p.id, birthGeneration: 1 }) === k) return p;
  return undefined;
}
/** Producer output. Bytes reach the spool only through the pane's current pipe. */
function tv2Emit(w: TV2World, paneId: string, text: string): void {
  const p = w.tmux.panes.get(paneId); tv2Assert(p && p.program === 'running', `emit on ${paneId} that is not running`);
  const k = TV2K.v2PaneKey({ serverIdentity: w.tmux.serverId, paneId, birthGeneration: 1 });
  p!.screen.push(text); if (p!.screen.length > p!.rows) p!.screen.shift();
  w.emitted.set(k, [...(w.emitted.get(k) ?? []), text]);
  const raw = w.disk.raw.get(k);
  if (p!.pipe && raw && w.collectorUp && p!.pipe === raw.epoch) raw.records.push(text);
}
/** Raw tmux command outside the gate (split/new-window/resize). */
function tv2RawSplit(w: TV2World, paneId: string): string {
  const src = w.tmux.panes.get(paneId)!; const id = `%${w.tmux.next++}`;
  src.cols = Math.floor((src.cols - 1) / 2);
  w.tmux.panes.set(id, { id, name: src.name, sessionId: src.sessionId, window: src.window, cols: src.cols, rows: src.rows,
    program: 'running', pipe: null, screen: [], born: 'raw' });
  return id;
}
/** Any resize (product or raw). A live collector journals the layout change (S's hook). */
function tv2Resize(w: TV2World, paneId: string, cols: number): void {
  const p = w.tmux.panes.get(paneId)!; p.cols = cols;
  const raw = w.disk.raw.get(TV2K.v2PaneKey({ serverIdentity: w.tmux.serverId, paneId, birthGeneration: 1 }));
  if (raw && w.collectorUp) raw.resizes++;
}
function tv2Keeper(w: TV2World): void {
  for (const p of w.tmux.panes.values()) {
    if (p.program !== 'running') continue;
    const session: TV2K.NewarchV2SessionKey = { serverIdentity: w.tmux.serverId, sessionId: p.sessionId };
    const owner: TV2K.V2OwnerLookup = w.disk.corrupt ? { kind: 'unknown', reason: 'corrupt' }
      : w.disk.sessions.has(p.sessionId) ? { kind: 'capture-engine', pane: tv2Descriptor(w, p, 'lookup') }
      : { kind: 'legacy', session };
    if (!TV2K.v2LegacyAppendAllowed(owner, session)) continue;
    const old = w.disk.legacy.get(p.name) ?? [];
    const fresh = p.screen.filter(t => !old.includes(t));
    if (!fresh.length) continue;
    w.disk.legacy.set(p.name, [...old, ...fresh]);
    w.disk.events.push({ seq: w.seq++, writer: 'legacy', holder: w.disk.lock?.engineId ?? null, pane: null, kind: 'legacy-append', detail: `${p.sessionId}:${fresh.length}` });
  }
}
function tv2Descriptor(w: TV2World, p: TV2TmuxPane, birthOp: string, state: TV2K.NewarchV2PaneDescriptor['state'] = 'active'): TV2K.NewarchV2PaneDescriptor {
  return { schema: 'newarch-v2', session: { serverIdentity: w.tmux.serverId, sessionId: p.sessionId },
    pane: { serverIdentity: w.tmux.serverId, paneId: p.id, birthGeneration: 1 }, windowId: p.window,
    owner: 'capture-engine', birthOperationId: birthOp, geometry: TV2_GEOMETRY, state };
}
function tv2Incident(pane: TV2PaneDisk, reason: TV2K.NewarchV2Incident['reason'], op: string, stop: boolean,
  after: number | null = pane.rows.at(-1)?.ordinal ?? null, clock = 1): TV2K.NewarchV2Incident {
  const row = (n: number | null) => n === null ? null : { pane: pane.desc.pane, segmentId: 'seg', rowOrdinal: n };
  const incident: TV2K.NewarchV2Incident = { schema: 'newarch-v2', incidentId: TV2K.v2IncidentId(pane.desc.pane, op),
    pane: pane.desc.pane, reason, frontier: row(pane.rows.at(-1)?.ordinal ?? null), affected: { after: row(after), through: null },
    openedAtWallMs: clock, openedAtMonoMs: clock, clockEpoch: 'tv2', collecting: !stop, missing: { countKind: 'unknown', missingCount: null },
    ruleVersion: '1', configVersion: TV2_GEOMETRY.configVersion, geometry: TV2_GEOMETRY, revision: pane.revision,
    sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null,
    action: stop ? 'gap-and-stop' : 'annotate', evidence: null };
  TV2K.validateV2Incident(incident);
  return incident;
}

/** E (#6): a slot torn by zeroing it in place (only a mutant writes one). */
const TV2_TORN = Object.freeze({ torn: true }) as unknown as TV2K.V2EmergencyIncident;
/** S's reserve append: the same id keeps its retained record; otherwise a free slot; none free = exhausted. */
function tv2ReserveAppend(d: TV2Disk, record: TV2K.V2EmergencyIncident): 'journalled' | 'exhausted' {
  const id = record.incident.incidentId;
  if (d.slots.some(s => s !== null && s !== TV2_TORN && s.incident.incidentId === id)) return 'journalled';
  const free = d.slots.indexOf(null);
  if (free < 0) return 'exhausted';
  d.slots[free] = record; d.emergency.set(id, record.incident); d.reserveUsed++;
  return 'journalled';
}
/** The journalled storage incidents of one pane (or every pane). */
const tv2Held = (d: TV2Disk, k: TV2Key | null = null) => d.slots.filter((s): s is TV2K.V2EmergencyIncident =>
  s !== null && s !== TV2_TORN && (k === null || TV2K.v2PaneKey(s.incident.pane) === k));

function tv2Engine(w: TV2World, engineId: string) {
  const d = w.disk;
  if (d.corrupt) return { opened: false as const, reason: 'owner-store-corrupt' };
  if (d.lock?.alive) return { opened: false as const, reason: 'locked' };
  d.lock = { engineId, alive: true }; d.generation++;
  const generation = d.generation; let dead = false; let closed = false;
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(f);
    queues.set(key, next.catch(() => {})); return next;
  };
  const live = () => !dead && d.lock?.engineId === engineId && d.lock.alive && d.generation === generation;
  const barrier = (at: string) => { if (w.killAt === at) { w.killAt = null; kill(); throw new TV2Kill(at); } };
  /** E (#6): host RAM — the H row cap a pane's storage fault was seen at, and the durability label of a pane whose reserve was full. */
  const held = new Map<TV2Key, number>(); const durability = new Map<TV2Key, string>();
  /** Inside S's synchronous slot write: `collector:` kills the collector there; `host:` kills only the host, the write goes on. */
  let hostDying = false;
  const collectorBarrier = (at: string) => {
    if (w.killAt === `collector:${at}`) { w.killAt = null; w.collectorUp = false; throw new TV2Kill(at); }
    if (w.killAt === `host:${at}`) { w.killAt = null; hostDying = true; }
  };
  /** H transaction: capability + lock + generation checked inside every write. */
  async function write(pane: TV2Key | null, kind: string, apply: () => void, detail = '', writer = `engine:${engineId}`): Promise<void> {
    await tv2Yield();
    if (!live()) throw new Error(`T-V2 capability refused for ${engineId}`);
    apply();
    d.events.push({ seq: w.seq++, writer, holder: d.lock?.engineId ?? null, pane, kind, detail });
  }
  function kill(): void { dead = true; if (d.lock?.engineId === engineId) d.lock.alive = false; }
  async function incident(k: TV2Key, reason: TV2K.NewarchV2Incident['reason'], op: string, stop: boolean, after?: number | null): Promise<void> {
    const p = d.panes.get(k)!; const i = tv2Incident(p, reason, op, stop, after);
    if (p.incidents.has(i.incidentId)) return;
    await write(k, stop ? 'stop' : 'incident', () => { p.incidents.set(i.incidentId, i); if (stop) p.stopped = true; }, reason);
    if (stop) retire(k);
  }
  function retire(k: TV2Key): void {
    const p = tv2PaneOf(w, k); const raw = d.raw.get(k);
    if (p && raw && p.pipe === raw.epoch) p.pipe = null;
  }
  /** C puts the journalled incident in H: the same bytes (clocks, frontier) under one operation; the pane stops. */
  async function materialize(k: TV2Key, record: TV2K.V2EmergencyIncident): Promise<void> {
    const p = d.panes.get(k)!; const id = record.incident.incidentId, op = `storage-${id}`;
    const incident = record.incident;
    await write(k, 'materialize', () => {
      p.incidents.set(id, incident); p.stopped = true; p.revision++;
      p.receipts.set(op, { schema: 'newarch-v2', kind: 'ssot-durable', operationId: op, pane: p.desc.pane, digest: TV2K.v2Digest('tv2-stop', incident),
        commitId: `c-${p.revision}`, generation, revision: p.revision, frontier: null, checkpointId: p.checkpoint?.id ?? null });
    }, id);
    retire(k);
  }
  /** H's reserve-rearm observation at THIS engine's generation (path A): read-only; null without a durable resolution. */
  function reserveRearm(k: TV2Key, id: string): TV2K.V2ReserveRearmObservation | null {
    const p = d.panes.get(k), incident = p?.incidents.get(id), receipt = p?.receipts.get(`storage-${id}`);
    if (!live() || !p || !incident || !receipt) return null;
    const observation: TV2K.V2ReserveRearmObservation = { schema: 'newarch-v2', purpose: 'reserve-rearm', pane: p.desc.pane, incidentId: id,
      incidentDigest: TV2K.v2EmergencyIncidentDigest(incident), resolvedReceipt: receipt, authorizedGeneration: TV2K.v2WriterGeneration(generation) };
    w.observations.push(observation);
    return observation;
  }
  /** S's rearm(id): replace the ONE slot holding id — scratch, rename, directory sync — never zero it in place; no other id is touched. */
  function collectorRearm(id: string): void {
    const i = d.slots.findIndex(s => s !== null && s !== TV2_TORN && s.incident.incidentId === id);
    if (i < 0) return;
    const scratch = `slot-${i}.rearm`;
    d.scratch.add(scratch); collectorBarrier('scratch-before-rename');
    collectorBarrier('scratch-fsync-before-rename');
    d.slots[i] = null; d.scratch.delete(scratch); d.emergency.delete(id); d.reserveUsed--;
    collectorBarrier('rename-before-dirsync');
    collectorBarrier('dirsync-before-reply');
  }
  /** BS's rearmReserve: the observation is checked against H's LIVE generation and the receipt H holds, then S is asked once. */
  async function dispatch(k: TV2Key, id: string, observation: TV2K.V2ReserveRearmObservation | null): Promise<'rearmed' | 'refused'> {
    const p = d.panes.get(k)!; const incident = p.incidents.get(id), receipt = p.receipts.get(`storage-${id}`);
    if (!incident || !receipt || !w.collectorUp) return 'refused';
    if (!TV2K.v2ReserveRearmAllowed(observation, p.desc.pane, id, TV2K.v2EmergencyIncidentDigest(incident), receipt, TV2K.v2WriterGeneration(d.generation))) return 'refused';
    barrier('dispatch-before-reply');
    collectorRearm(id);
    if (hostDying) { hostDying = false; kill(); throw new TV2Kill('host died in the collector write'); }
    barrier('reply-before-record');
    // Rearm never ACKs, trims or resumes: the receipt of g authorizes nothing at g+1.
    await write(k, 'rearm', () => {}, id);
    return 'rearmed';
  }
  async function rearm(k: TV2Key, id: string): Promise<'rearmed' | 'refused'> {
    const observation = reserveRearm(k, id);
    barrier('observation-before-dispatch');
    return dispatch(k, id, observation);
  }
  function observe(k: TV2Key): TV2K.V2GeometryObservation | null {
    const p = tv2PaneOf(w, k); if (!p || p.program === 'dead') return null;
    const inWindow = [...w.tmux.panes.values()].filter(x => x.window === p.window && x.program !== 'dead').length;
    return { pane: { serverIdentity: w.tmux.serverId, paneId: p.id, birthGeneration: 1 }, windowId: p.window,
      window: { columns: p.cols, rows: p.rows }, terminal: { columns: p.cols, rows: p.rows }, panesInWindow: inWindow };
  }
  async function pumpNow(k: TV2Key): Promise<void> {
    const p = d.panes.get(k); const raw = d.raw.get(k);
    if (!p || !raw || p.stopped) return;
    const pending = tv2Held(d, k);
    if (pending.length) {
      // E (#6): a journalled storage incident holds the pane — nothing is replayed — until the disk grew and it is in H.
      const at = held.get(k);
      if (at === undefined || d.space.capRows <= at) return;
      barrier('journal-before-h');
      await materialize(k, pending[0]!);
      barrier('h-before-rearm');
      await rearm(k, pending[0]!.incident.incidentId);
      return;
    }
    const seen = observe(k);
    if (!seen || !TV2K.v2GeometryMatches(p.desc, seen) || raw.resizes !== p.resizesSeen) {
      await incident(k, 'geometry-violation', `geometry:${raw.acked}`, true, p.checkpoint ? p.rows.at(-1)?.ordinal ?? null : null);
      return;
    }
    if (raw.epoch !== p.epoch) { await incident(k, 'collector-epoch-changed', `epoch:${raw.epoch}`, true); return; }
    const end = raw.records.length; if (end <= raw.acked) return;
    const batch = raw.records.slice(raw.acked, end);
    if (batch.some(t => t.startsWith('\u0000'))) { await incident(k, 'decoder-anomaly', `protocol:${raw.acked}`, true); return; }
    const op = `batch:${raw.acked}:${end}`;
    if (p.rows.length + batch.length > d.space.capRows) {
      // ENOSPC: H cannot write. The host journals ONE storage-outage incident (clocks and frontier frozen) in S's
      // reserve before any receipt; no ACK, no trim. A full reserve is a durability FAILED label, not a throw.
      const i = tv2Incident(p, 'storage-outage', `storage-outage-${op}`, true, undefined, w.seq++);
      if (tv2ReserveAppend(d, { incident: i, digest: TV2K.v2EmergencyIncidentDigest(i), cause: 'ENOSPC' }) === 'exhausted')
        durability.set(k, 'storage-unavailable; durability FAILED: emergency reserve exhausted');
      else held.set(k, d.space.capRows);
      retire(k); return;
    }
    barrier('before-commit');
    const digest = TV2K.v2Digest('tv2-batch', { k, op, batch });
    const fence: TV2K.V2WriteFence = { operationId: op, pane: p.desc.pane, expectedGeneration: generation, expectedRevision: p.revision, digest };
    const disposition = TV2K.v2WriteDisposition(fence, d.generation, p.revision, p.receipts.get(op) ?? null);
    if (disposition === 'integrity' || disposition === 'stale') throw new Error(`T-V2 write ${disposition}`);
    if (disposition === 'commit') {
      await write(k, 'batch', () => {
        const base = p.rows.length;
        p.rows.push(...batch.map((text, j) => ({ text, ordinal: base + j })));
        p.revision++;
        p.checkpoint = { id: `ck-${p.revision}`, through: end, replayFloor: end, revision: p.revision };
        p.receipts.set(op, { schema: 'newarch-v2', kind: 'ssot-durable', operationId: op, pane: p.desc.pane, digest,
          commitId: `c-${p.revision}`, generation, revision: p.revision, frontier: null, checkpointId: p.checkpoint.id });
      }, op);
    }
    barrier('commit-before-ack');
    const receipt = p.receipts.get(op)!;
    tv2Assert(receipt.checkpointId === p.checkpoint?.id || disposition === 'retry', 'receipt/checkpoint mismatch');
    raw.acked = end;
    barrier('ack-before-trim');
    const trimThrough = Math.min(p.checkpoint!.replayFloor, raw.acked);
    raw.trimmed = Math.max(raw.trimmed, trimThrough);
    d.events.push({ seq: w.seq++, writer: `spool:${engineId}`, holder: d.lock?.engineId ?? null, pane: k, kind: 'trim', detail: `${trimThrough}/${p.checkpoint!.replayFloor}/${raw.acked}` });
  }
  const engine = {
    opened: true as const, engineId, generation,
    get dead() { return dead; }, kill,
    pump: (k: TV2Key) => serial(k, () => pumpNow(k)),
    pumpAll: async () => { for (const k of [...d.panes.keys()]) await engine.pump(k); },
    /** PLAN-v2 §3 birth order. Errors before release return a typed failure; never legacy. */
    async birth(name: string, sessionId: string, opts: { window?: 'new-session' | 'new-window'; failAt?: string } = {}) {
      const op = `birth:${sessionId}:${w.tmux.next}`;
      if (!w.flagBirth) return { status: 'rejected' as const, reason: 'disabled', programReleased: false };
      if (!d.sessions.has(sessionId)) await write(null, 'reserve', () => d.sessions.set(sessionId, { state: 'reserved', birthOp: op }), sessionId);
      const id = `%${w.tmux.next++}`; const window = `@${w.tmux.windows++}`;
      const p: TV2TmuxPane = { id, name, sessionId, window, cols: 80, rows: 24, program: 'held', pipe: null, screen: [], born: 'gate' };
      w.tmux.panes.set(id, p);
      const desc = tv2Descriptor(w, p, op); const k = tv2Index(desc);
      p.cols = TV2_GEOMETRY.columns; p.rows = TV2_GEOMETRY.rows;
      if (opts.failAt === 'geometry') { p.cols = 99; }
      const attachId = `${w.collectorEpoch}:${id}`;
      d.raw.set(TV2K.v2PaneKey(desc.pane), { epoch: attachId, records: [], trimmed: 0, acked: 0, resizes: 0 }); p.pipe = attachId;
      d.journal.set(op, { pane: desc.pane, attachId, sessionId, activated: false });
      const seen = observe(TV2K.v2PaneKey(desc.pane));
      if (!seen || !TV2K.v2GeometryMatches(desc, seen) || opts.failAt === 'binding') {
        p.pipe = null; p.program = 'dead'; w.tmux.panes.delete(id); d.raw.delete(TV2K.v2PaneKey(desc.pane));
        await write(null, 'cancel-birth', () => d.journal.delete(op), op);
        return { status: 'rejected' as const, reason: seen ? 'geometry' : 'binding', programReleased: false, cleanup: 'complete' };
      }
      barrier('ready-before-binding');
      await write(k, 'activate', () => {
        d.panes.set(k, { desc, epoch: attachId, revision: 0, rows: [], incidents: new Map(), receipts: new Map(),
          checkpoint: null, stopped: false, lastAudit: null, auditedRevision: null, resizesSeen: 0 });
        d.sessions.get(sessionId)!.state = 'active'; d.journal.get(op)!.activated = true;
      }, op);
      p.program = 'running';
      return { status: 'active' as const, paneId: id, key: k };
    },
    /** Boot/resume: recover journal bindings, then prove continuity before replay. */
    async resume(): Promise<void> {
      for (const [op, j] of d.journal) {
        if (j.activated) continue;
        const k = TV2K.v2PaneKey(j.pane); const p = w.tmux.panes.get(j.pane.paneId);
        if (p && p.pipe === j.attachId) p.pipe = null;
        if (p && p.program === 'held') { p.program = 'dead'; w.tmux.panes.delete(p.id); }
        await write(k, 'unrecorded-birth', () => {
          const desc = { ...tv2Descriptor(w, p ?? { id: j.pane.paneId, name: '', sessionId: j.sessionId, window: '@?', cols: 0, rows: 0, program: 'dead', pipe: null, screen: [], born: 'gate' }, op), state: 'stopped' as const };
          const pd: TV2PaneDisk = { desc, epoch: j.attachId, revision: 0, rows: [], incidents: new Map(), receipts: new Map(),
            checkpoint: null, stopped: true, lastAudit: null, auditedRevision: null, resizesSeen: 0 };
          const i = tv2Incident(pd, 'birth-failed', `recover:${op}`, true, null);
          pd.incidents.set(i.incidentId, i); d.panes.set(k, pd); j.activated = true;
        }, op);
      }
      // E (#6): journalled storage incidents BEFORE the continuity proof: into H (same bytes, one operation), then a rearm with a fresh observation.
      for (const record of tv2Held(d)) {
        const k = TV2K.v2PaneKey(record.incident.pane); const p = d.panes.get(k)!; const id = record.incident.incidentId;
        if (p.incidents.has(id)) { barrier('h-before-rearm'); await rearm(k, id); continue; }
        if (p.rows.length >= d.space.capRows) continue;
        barrier('journal-before-h');
        await materialize(k, record);
        barrier('h-before-rearm');
        await rearm(k, id);
      }
      for (const [k, p] of d.panes) {
        if (p.stopped) continue;
        const tp = tv2PaneOf(w, k); const raw = d.raw.get(k);
        const proof: TV2K.V2ResumeProof['kind'] | string = !tp || tp.program === 'dead' ? 'identity'
          : !raw || raw.epoch !== p.epoch || tp.pipe !== raw.epoch ? 'collector-epoch'
          : raw.trimmed > raw.acked ? 'raw' : raw.resizes !== p.resizesSeen ? 'geometry' : 'continuous';
        if (proof === 'continuous') { await engine.pump(k); continue; }
        if (tp && raw && tp.pipe === raw.epoch) tp.pipe = null;
        await incident(k, proof === 'collector-epoch' ? 'collector-epoch-changed' : 'unverified-restart', `resume:${proof}:${p.revision}`, true);
      }
    },
    /** Topology inventory: panes in a v2 session that the gate did not create. */
    async inventory(): Promise<void> {
      for (const tp of w.tmux.panes.values()) {
        const k = TV2K.v2PaneKey({ serverIdentity: w.tmux.serverId, paneId: tp.id, birthGeneration: 1 });
        if (!d.sessions.has(tp.sessionId) || d.panes.has(k) || tp.born !== 'raw') continue;
        await write(k, 'unrecorded-birth', () => {
          const pd: TV2PaneDisk = { desc: tv2Descriptor(w, tp, `raw:${tp.id}`, 'unrecorded'), epoch: '', revision: 0, rows: [],
            incidents: new Map(), receipts: new Map(), checkpoint: null, stopped: true, lastAudit: null, auditedRevision: null, resizesSeen: 0 };
          const i = tv2Incident(pd, 'unrecorded-birth', `raw:${tp.id}`, true, null); pd.incidents.set(i.incidentId, i); d.panes.set(k, pd);
        }, tp.id);
      }
    },
    incident: (k: TV2Key, reason: TV2K.NewarchV2Incident['reason'], op: string, stop = true) => serial(k, () => incident(k, reason, op, stop)),
    /** E (#6): the host's durability label of a pane (null = none). */
    durability: (k: TV2Key): string | null => durability.get(k) ?? null,
    /** E (#6): BS's rearm with a given observation (a test hands it a stale one). */
    rearmWith: (k: TV2Key, id: string, observation: TV2K.V2ReserveRearmObservation) => serial(k, () => dispatch(k, id, observation)),
    /** E (#6): a rearm RPC reaching S late. */
    collectorRearm: (id: string) => collectorRearm(id),
    /** Auditor: capture-pane visible screen, compare against the DB projection at one revision. */
    async audit(k: TV2Key, between?: () => Promise<void>): Promise<string> {
      if (!w.audit.enabled) return 'disabled';
      const p = d.panes.get(k)!; const raw = d.raw.get(k)!; const tp = tv2PaneOf(w, k);
      if (!tp || tp.program === 'dead') return 'pane-dead';
      w.captures++;
      const revision = p.revision, acked = raw.acked, snapshot = [...tp.screen];
      if (between) await between();
      return serial(k, async () => {
        if (raw.records.length !== raw.acked || raw.acked !== acked || p.revision !== revision) {
          await write(k, 'audit-status', () => { p.lastAudit = 'inconclusive:racing'; }, 'racing');
          return 'inconclusive';
        }
        const stored = p.rows.slice(-snapshot.length).map(r => r.text);
        if (stored.join('\n') === snapshot.join('\n')) {
          await write(k, 'audit-status', () => { p.lastAudit = 'match'; p.auditedRevision = revision; }, `match@${revision}`);
          return 'match';
        }
        const first = stored.findIndex((t, j) => t !== snapshot[j]);
        const after = first <= 0 ? (p.rows.length > stored.length ? p.rows[p.rows.length - stored.length - 1]!.ordinal : null) : p.rows[p.rows.length - stored.length + first - 1]!.ordinal;
        await write(k, 'audit-annotate', () => {
          const i = tv2Incident(p, 'audit-mismatch', `audit:${revision}`, false, after);
          p.incidents.set(i.incidentId, i); p.lastAudit = 'annotate';
        }, `expected=${revision} revision=${p.revision}`);
        return 'annotate';
      });
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.all([...queues.values()]);
      if (live()) d.lock = null;
    },
    get closed() { return closed; },
  };
  return engine;
}
function tv2Open(w: TV2World, id: string): Extract<ReturnType<typeof tv2Engine>, { opened: true }> {
  const e = tv2Engine(w, id); tv2Assert(e.opened, `engine ${id} did not open: ${(e as { reason?: string }).reason}`);
  return e as Extract<ReturnType<typeof tv2Engine>, { opened: true }>;
}

/** Independent judge over the disk log and the producer oracle. */
function tv2Judge(w: TV2World, opts: { normal?: boolean } = {}): string[] {
  const v = new Set<string>(); const d = w.disk;
  const v2Sessions = new Set(d.events.filter(e => e.kind === 'reserve').map(e => e.detail));
  for (const e of d.events) {
    if (e.kind === 'trim') { const [t, floor, acked] = e.detail.split('/').map(Number); if (t! > floor! || t! > acked!) v.add('early-trim'); continue; }
    if (e.writer === 'legacy') { if (v2Sessions.has(e.detail.split(':')[0]!)) v.add('legacy-write-v2'); continue; }
    if (e.writer !== `engine:${e.holder}`) v.add('second-writer');
    if (e.kind === 'audit-annotate' || e.kind === 'audit-repair') {
      const m = /expected=(\d+) revision=(\d+)/.exec(e.detail); if (m && m[1] !== m[2]) v.add('stale-audit');
    }
  }
  for (const [sid, s] of d.sessions) if (!['reserved', 'active', 'closed'].includes(s.state)) v.add(`owner-state:${sid}`);
  for (const [k, p] of d.panes) {
    const stops = d.events.filter(e => e.pane === k && e.kind === 'stop');
    const stopAt = stops[0]?.seq ?? Infinity;
    if (d.events.some(e => e.pane === k && e.kind === 'batch' && e.seq > stopAt)) v.add('commit-after-stop');
    // resume must prove continuity BEFORE replaying: no batch of that engine precedes its unproven-resume stop
    for (const s of stops.filter(e => e.detail === 'unverified-restart' || e.detail === 'collector-epoch-changed')) {
      const since = d.events.find(e => e.holder === s.holder)?.seq ?? s.seq;
      if (d.events.some(e => e.pane === k && e.kind === 'batch' && e.holder === s.holder && e.seq >= since && e.seq < s.seq)) v.add('replay-before-proof');
    }
    const texts = p.rows.map(r => r.text);
    if (new Set(texts).size !== texts.length) v.add('duplicate');
    const emitted = w.emitted.get(k) ?? [];
    const pos = texts.map(t => emitted.indexOf(t));
    if (pos.some((x, i) => x < 0 || (i > 0 && x <= pos[i - 1]!))) v.add('order-or-foreign');
    const incidents = [...p.incidents.values(), ...[...d.emergency.values()].filter(i => TV2K.v2PaneKey(i.pane) === k)];
    const gaps = incidents.filter(i => i.action === 'gap-and-stop');
    if (opts.normal && incidents.length) v.add('incident-in-normal');
    // every emitted event is stored once, or lies after a positioned stop gap
    let last: number | null = null;
    for (const t of emitted) {
      const at = texts.indexOf(t);
      if (at >= 0) { last = p.rows[at]!.ordinal; continue; }
      const covered = gaps.some(g => g.affected.through === null
        && (g.affected.after === null || (last !== null && g.affected.after.rowOrdinal <= last)));
      if (!covered) { v.add('silent-loss'); break; }
    }
    const tp = tv2PaneOf(w, k); const raw = d.raw.get(k);
    if (p.stopped && tp && raw && tp.pipe === raw.epoch) v.add('stopped-pipe-left-open');
  }
  for (const p of w.tmux.panes.values()) if (p.born === 'gate' && p.program === 'running' && !p.pipe) {
    const k = TV2K.v2PaneKey({ serverIdentity: w.tmux.serverId, paneId: p.id, birthGeneration: 1 });
    const pending = [...d.emergency.values()].some(i => TV2K.v2PaneKey(i.pane) === k);
    if (!d.panes.get(k)?.stopped && !pending) v.add('running-without-pipe');
  }
  return [...v].sort();
}
const tv2Lines = (n: number, from = 1, tag = 'A') => Array.from({ length: n }, (_, i) => `E${String(from + i).padStart(5, '0')} ${tag}`);
const tv2Rows = (w: TV2World, k: TV2Key) => w.disk.panes.get(k)?.rows.map(r => r.text) ?? [];
const tv2Expect = (w: TV2World, want: string[], opts: { normal?: boolean } = {}) => {
  const got = tv2Judge(w, opts); tv2Assert(got.join(',') === want.join(','), `judge expected [${want}] got [${got}]`);
};

/** §9 sampler contract (Q): online sums only, PID+startTime identity, missing read invalidates. */
function tv2Sampler() {
  const s = { n: 0, st: 0, sy: 0, stt: 0, sty: 0, max: 0, valid: true, reason: '', windows: [0, 0, 0, 0, 0, 0] as number[],
    tree: new Map<number, string>() };
  return {
    add(tMin: number, procs: readonly { pid: number; startTime: string; pss: number | null; product: boolean }[]): void {
      let y = 0;
      for (const p of procs) {
        if (!p.product) continue;
        const known = s.tree.get(p.pid);
        if (known !== undefined && known !== p.startTime) { s.valid = false; s.reason = 'pid-reuse'; }
        s.tree.set(p.pid, p.startTime);
        if (p.pss === null) { s.valid = false; s.reason = 'missing-sample'; continue; }
        y += p.pss;
      }
      s.max = Math.max(s.max, y);
      for (const [i, [a, b]] of ([[10, 20], [30, 40], [50, 60]] as const).entries()) if (tMin >= a && tMin < b) { s.windows[i * 2]! += y; s.windows[i * 2 + 1]!++; }
      if (tMin < 10) return;
      const t = tMin / 60; s.n++; s.st += t; s.sy += y; s.stt += t * t; s.sty += t * y;
    },
    verdict() {
      const slope = (s.n * s.sty - s.st * s.sy) / (s.n * s.stt - s.st * s.st);
      const mean = (i: number) => s.windows[i * 2]! / Math.max(1, s.windows[i * 2 + 1]!);
      const pass = s.valid && s.max <= 1536 && slope <= 10 && mean(1) - mean(0) <= 10 && mean(2) - mean(0) <= 10;
      return { pass, valid: s.valid, reason: s.reason, slope, max: s.max, means: [mean(0), mean(1), mean(2)] };
    },
    /** Retained slots: arrays/maps count their entries, scalars count one. */
    stateBytes: () => Object.values(s).reduce((n: number, x) => n + (Array.isArray(x) ? x.length : x instanceof Map ? x.size : 1), 0),
  };
}

// ---- E (#6) views of the reserve/rearm path. Until the model has that path these
// read as undefined and each E-RF case fails at its own E-RF label.
type TV2EView = { slots?: (TV2K.V2EmergencyIncident | null)[]; scratch?: Set<string> };
type TV2EEngine = { durability?: (k: TV2Key) => string | null; collectorRearm?: (id: string) => void;
  rearmWith?: (k: TV2Key, id: string, observation: TV2K.V2ReserveRearmObservation) => Promise<string> };
const tv2EDisk = (w: TV2World) => w.disk as unknown as TV2EView;
const tv2EOf = (e: unknown) => e as TV2EEngine;
const tv2EObservations = (w: TV2World) => (w as unknown as { observations?: TV2K.V2ReserveRearmObservation[] }).observations ?? [];
/** The model's stand-in for the EvidenceFile S answers for a reserve slot. */
const TV2_SLOT_FILE: TV2K.EvidenceFile = { path: 'tv2-reserve-slot', bytes: 65536, sha256: '0'.repeat(64) };
/** One pane turn that may end at a TV2Kill barrier; any other throw fails the case at its label. */
async function tv2Turn(e: { pump: (k: TV2Key) => Promise<void> }, k: TV2Key, label: string): Promise<void> {
  try { await e.pump(k); } catch (err) { if (!(err instanceof TV2Kill)) tv2Assert(false, `${label} pump threw ${String(err)}`); }
}
const tv2Count = (w: TV2World, k: TV2Key, kind: string) => w.disk.events.filter(x => x.pane === k && x.kind === kind).length;
/** A pane whose storage fault is journalled (5 rows over a 3-row H), with `reserveCap` slots. */
async function tv2Journalled(label: string, reserveCap = 1) {
  const w = tv2World({ capRows: 3, reserveCap }); const e = tv2Open(w, 'e1');
  const a = await e.birth('a', 'S1') as { paneId: string; key: string };
  for (const t of tv2Lines(5)) tv2Emit(w, a.paneId, t);
  await tv2Turn(e, a.key, label);
  const id = [...w.disk.emergency.keys()][0] ?? '';
  return { w, e, a, id, p: w.disk.panes.get(a.key)! };
}

const tv2Scenarios: Record<string, () => Promise<void>> = {
  /** V2-01 Codex F1: A, flag off, B (live and across restart). */
  async 'V2-01 flag off closes the birth gate only: B lands in H once, no legacy write, cap still enforced'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const born = await e.birth('work', 'S1'); tv2Assert(born.status === 'active', 'birth');
    const { paneId, key } = born as { paneId: string; key: string };
    for (const t of tv2Lines(5)) tv2Emit(w, paneId, t); await e.pumpAll();
    w.flagBirth = false;
    for (const t of tv2Lines(5, 6)) tv2Emit(w, paneId, t); await e.pumpAll(); tv2Keeper(w);
    tv2Assert(tv2Rows(w, key).length === 10, `live flag-off rows ${tv2Rows(w, key).length}`);
    tv2Assert((await e.birth('next', 'S2')).status === 'rejected', 'flag off still admits births');
    e.kill();
    for (const t of tv2Lines(5, 11)) tv2Emit(w, paneId, t);
    const e2 = tv2Open(w, 'e2'); await e2.resume(); tv2Keeper(w);
    tv2Assert(tv2Rows(w, key).length === 15, `restart flag-off rows ${tv2Rows(w, key).length}`);
    tv2Expect(w, [], { normal: true });
    w.disk.space.capRows = 16; for (const t of tv2Lines(5, 16)) tv2Emit(w, paneId, t); await e2.pumpAll();
    tv2Assert(w.disk.emergency.size === 1, 'cap did not stop the pane while the flag is off');
    tv2Keeper(w); tv2Expect(w, []);
  },
  /** V2-04 Codex F3/R14: collector READY, host killed before persisting activation. */
  async 'V2-04 kill after collector READY before binding: journal recovery retires own pipe, foreign pipe untouched, no candidate rows'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const foreign = await e.birth('other', 'S0'); tv2Assert(foreign.status === 'active', 'first birth');
    const f = w.tmux.panes.get((foreign as { paneId: string }).paneId)!; f.pipe = 'someone-else';
    w.killAt = 'ready-before-binding';
    let killed = false; try { await e.birth('work', 'S1'); } catch (err) { killed = err instanceof TV2Kill; }
    tv2Assert(killed, 'barrier not reached');
    const held = [...w.tmux.panes.values()].find(p => p.name === 'work')!;
    tv2Assert(held.program === 'held' && held.pipe !== null, 'program released before activation');
    const e2 = tv2Open(w, 'e2'); await e2.resume(); tv2Keeper(w);
    tv2Assert(!w.tmux.panes.has(held.id) || w.tmux.panes.get(held.id)!.pipe === null, 'own pipe not retired');
    tv2Assert(f.pipe === 'someone-else', 'foreign pipe changed');
    const rec = [...w.disk.panes.values()].find(p => p.desc.pane.paneId === held.id)!;
    tv2Assert(rec && rec.stopped && rec.rows.length === 0, 'recovered pane published rows or is not stopped');
    tv2Assert([...rec.incidents.values()].some(i => i.frontier === null && i.reason === 'birth-failed'), 'no frontier=null incident');
    tv2Assert(w.disk.sessions.get('S1')?.state !== undefined, 'owner tombstone lost');
    tv2Expect(w, []);
  },
  /** V2-05: storage fault before the first ACK, restart with flag off. */
  async 'V2-05 incident before first ACK survives restart and flag-off with frontier=null'() {
    const w = tv2World({ capRows: 0 }); const e = tv2Open(w, 'e1');
    const { paneId, key } = await e.birth('work', 'S1') as { paneId: string; key: string };
    tv2Emit(w, paneId, 'E00001 A'); await e.pumpAll();
    tv2Assert(w.disk.raw.get(key)!.acked === 0, 'ACK after failed write');
    const pending = [...w.disk.emergency.values()];
    tv2Assert(pending.length === 1 && pending[0]!.frontier === null, 'no pending incident with frontier=null');
    e.kill(); w.flagBirth = false; w.disk.space.capRows = 100;
    const e2 = tv2Open(w, 'e2'); await e2.resume();
    const p = w.disk.panes.get(key)!;
    const durable = [...p.incidents.values()];
    tv2Assert(durable.length === 1 && durable[0]!.incidentId === pending[0]!.incidentId && durable[0]!.frontier === null, 'incident not materialized once with same id');
    tv2Assert(w.disk.emergency.size === 0 && w.disk.reserveUsed === 0, 'reserve not rearmed');
    tv2Expect(w, []);
  },
  /** V2-06 F5/M-FINAL-1/R10: first burst committed, then fill. */
  async 'V2-06 burst commits first, the fill stops with a positioned incident and keeps unconfirmed raw'() {
    const w = tv2World({ capRows: 30 }); const e = tv2Open(w, 'e1');
    const { paneId, key } = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(20)) tv2Emit(w, paneId, t); await e.pumpAll();
    tv2Assert(tv2Rows(w, key).length === 20, 'first burst not admitted');
    for (const t of tv2Lines(20, 21)) tv2Emit(w, paneId, t); await e.pumpAll();
    const raw = w.disk.raw.get(key)!;
    tv2Assert(raw.acked === 20 && raw.records.length === 40 && raw.trimmed <= 20, 'unconfirmed raw trimmed or ACKed');
    const i = [...w.disk.emergency.values()][0];
    tv2Assert(i && i.frontier?.rowOrdinal === 19, `incident frontier ${JSON.stringify(i?.frontier)}`);
    tv2Assert(w.tmux.panes.get(paneId)!.pipe === null, 'pipe still open after full');
    tv2Expect(w, []);
  },
  /** V2-07 B-FINAL-1: two windows, stop one, rename, reuse the name. */
  async 'V2-07 two windows keep separate PaneKeys; stop one, rename, reuse the name: keeper never writes v2'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    const b = await e.birth('work', 'S1', { window: 'new-window' }) as { paneId: string; key: string };
    tv2Assert(a.key !== b.key && w.disk.panes.size === 2, 'two windows share one record');
    for (const t of tv2Lines(3, 1, 'a')) tv2Emit(w, a.paneId, t);
    for (const t of tv2Lines(3, 1, 'b')) tv2Emit(w, b.paneId, t);
    await e.pumpAll();
    await e.incident(a.key, 'identity-change', 'stop-a');
    for (const t of tv2Lines(3, 4, 'b')) tv2Emit(w, b.paneId, t); await e.pumpAll();
    tv2Assert(tv2Rows(w, b.key).length === 6 && tv2Rows(w, a.key).length === 3, 'stopping one window stopped the other');
    for (const p of w.tmux.panes.values()) if (p.sessionId === 'S1') p.name = 'renamed';
    w.tmux.panes.set('%90', { id: '%90', name: 'work', sessionId: 'L1', window: '@90', cols: 80, rows: 24, program: 'running', pipe: null, screen: ['plain'], born: 'raw' });
    for (const t of tv2Lines(2, 7, 'b')) tv2Emit(w, b.paneId, t);
    tv2Keeper(w); await e.pumpAll();
    tv2Assert(JSON.stringify(w.disk.legacy.get('work')) === '["plain"]', `legacy store ${JSON.stringify([...w.disk.legacy])}`);
    tv2Assert(tv2Rows(w, b.key).length === 8, 'renamed v2 pane stopped collecting');
    tv2Expect(w, []);
  },
  /** V2-08 B-FINAL-1: raw split outside the gate. */
  async 'V2-08 raw split: no legacy fallback, the original pane stops with geometry-violation, the new pane is not adopted'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(4)) tv2Emit(w, a.paneId, t); await e.pumpAll();
    const raw = tv2RawSplit(w, a.paneId);
    tv2Emit(w, a.paneId, 'E00005 A'); tv2Emit(w, raw, 'raw-pane');
    await e.pumpAll(); await e.inventory(); tv2Keeper(w);
    const p = w.disk.panes.get(a.key)!;
    tv2Assert(p.stopped && [...p.incidents.values()].some(i => i.reason === 'geometry-violation' && i.affected.after?.rowOrdinal === 3), 'geometry violation not positioned');
    tv2Assert(tv2Rows(w, a.key).length === 4, 'a batch after the violation was published');
    const unrecorded = [...w.disk.panes.values()].find(x => x.desc.pane.paneId === raw);
    tv2Assert(unrecorded && unrecorded.desc.state === 'unrecorded' && unrecorded.rows.length === 0 && !w.disk.raw.has(TV2K.v2PaneKey(unrecorded.desc.pane))
      && [...unrecorded.incidents.values()].some(i => i.reason === 'unrecorded-birth' && i.frontier === null), 'raw pane adopted or not listed as unrecorded');
    tv2Assert(!w.disk.legacy.size, 'legacy fallback for a v2 session');
    tv2Expect(w, []);
  },
  /** V2-09 M-FINAL-2/R15: collector changes while the host is down. */
  async 'V2-09 collector epoch change during downtime: gap + stop under the same owner, no rebind, no capture'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(4)) tv2Emit(w, a.paneId, t); await e.pumpAll();
    e.kill(); w.collectorUp = false; tv2Emit(w, a.paneId, 'E00005 A');
    w.collectorEpoch = 'collector-2'; w.collectorUp = true;
    w.disk.raw.get(a.key)!.epoch = `collector-2:${a.paneId}`;
    const e2 = tv2Open(w, 'e2'); await e2.resume(); tv2Keeper(w);
    const p = w.disk.panes.get(a.key)!;
    tv2Assert(p.stopped && [...p.incidents.values()].some(i => i.reason === 'collector-epoch-changed' && i.action === 'gap-and-stop'), 'epoch change not a stop gap');
    tv2Assert(w.captures === 0 && w.tmux.panes.get(a.paneId)!.pipe !== `collector-2:${a.paneId}`, 'rebind or recovery capture');
    tv2Assert(w.disk.sessions.get('S1')!.state === 'active', 'owner changed');
    tv2Expect(w, []);
    // a foreign pipe replaced ours while the host was down: no rebind, no replay before the proof
    const v = tv2World(); const f = tv2Open(v, 'e1');
    const b = await f.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(3)) tv2Emit(v, b.paneId, t); await f.pumpAll(); f.kill();
    tv2Emit(v, b.paneId, 'E00004 A'); v.tmux.panes.get(b.paneId)!.pipe = 'foreign'; tv2Emit(v, b.paneId, 'E00005 A');
    await tv2Open(v, 'e2').resume();
    tv2Assert(v.disk.panes.get(b.key)!.stopped && v.tmux.panes.get(b.paneId)!.pipe === 'foreign', 'foreign pipe replaced or pane kept collecting');
    tv2Expect(v, []);
  },
  /** V2-10 M-FINAL-3/R09: refusal before release. */
  async 'V2-10 birth refused before release: typed failure, cleanup, program never ran, no fallback'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const r = await e.birth('work', 'S1', { failAt: 'geometry' });
    tv2Assert(r.status === 'rejected' && r.programReleased === false && (r as { cleanup?: string }).cleanup === 'complete', `result ${JSON.stringify(r)}`);
    tv2Assert(![...w.tmux.panes.values()].some(p => p.program === 'running'), 'program ran without a pipe');
    const ok = await e.birth('work', 'S1') as { paneId: string; key: string };
    tv2Emit(w, ok.paneId, 'E00001 A'); await e.pumpAll();
    tv2Assert(tv2Rows(w, ok.key)[0] === 'E00001 A', 'byte0 not first row');
    tv2Keeper(w); tv2Expect(w, [], { normal: true });
  },
  /** V2-11 T1/m-final-1: lost ACK, generation right/wrong. */
  async 'V2-11 lost ACK: retry with a new generation returns the original receipt; a wrong digest is integrity'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(3)) tv2Emit(w, a.paneId, t);
    w.killAt = 'commit-before-ack'; await e.pump(a.key).catch((err: unknown) => { if (!(err instanceof TV2Kill)) throw err; });
    const p = w.disk.panes.get(a.key)!; const receipt = [...p.receipts.values()][0]!;
    const e2 = tv2Open(w, 'e2'); await e2.resume();
    tv2Assert(tv2Rows(w, a.key).length === 3 && p.receipts.size === 1 && [...p.receipts.values()][0] === receipt, 'retry duplicated');
    const fence: TV2K.V2WriteFence = { operationId: receipt.operationId, pane: receipt.pane, expectedGeneration: w.disk.generation, expectedRevision: p.revision, digest: '1'.repeat(64) };
    tv2Assert(TV2K.v2WriteDisposition(fence, w.disk.generation, p.revision, receipt) === 'integrity', 'wrong digest accepted');
    tv2Assert(TV2K.v2WriteDisposition({ ...fence, digest: receipt.digest, expectedGeneration: 1 }, w.disk.generation, p.revision, receipt) === 'stale', 'old generation accepted');
    tv2Expect(w, [], { normal: true });
  },
  /** V2-12 T2/m-final-2: protocol vs storage fault, kill mid rearm. */
  async 'V2-12 protocol fault does not spend reserve; storage fault is durable once; failed writes never ACK'() {
    const w = tv2World({ capRows: 2, reserveCap: 1 }); const e = tv2Open(w, 'e1');
    const a = await e.birth('a', 'S1') as { paneId: string; key: string };
    const b = await e.birth('b', 'S2') as { paneId: string; key: string };
    tv2Emit(w, a.paneId, '\u0000bad-sequence'); await e.pump(a.key);
    tv2Assert(w.disk.reserveUsed === 0 && w.disk.panes.get(a.key)!.stopped, 'protocol fault spent reserve or kept going');
    for (const t of tv2Lines(3, 1, 'b')) tv2Emit(w, b.paneId, t); await e.pump(b.key);
    tv2Assert(w.disk.reserveUsed === 1 && w.disk.raw.get(b.key)!.acked === 0, 'storage fault ACKed or skipped reserve');
    await e.pump(b.key); tv2Assert(w.disk.reserveUsed === 1, 'rearm/retry spent reserve twice');
    e.kill(); w.disk.space.capRows = 10;
    const e2 = tv2Open(w, 'e2'); await e2.resume(); await e2.resume();
    tv2Assert(w.disk.reserveUsed === 0 && [...w.disk.panes.get(b.key)!.incidents.values()].length === 1, 'materialized twice or reserve not rearmed');
    tv2Expect(w, []);
  },
  /** V2-14: auditor outcomes through the single writer. */
  async 'V2-14 auditor: match records a watermark, racing is inconclusive, finalized mismatch annotates, disabled captures nothing'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(50)) tv2Emit(w, a.paneId, t); await e.pumpAll();
    tv2Assert(await e.audit(a.key) === 'match', 'match');
    const p = w.disk.panes.get(a.key)!; const rev = p.revision;
    tv2Assert(await e.audit(a.key, async () => { tv2Emit(w, a.paneId, 'E00051 A'); await e.pump(a.key); }) === 'inconclusive', 'stale snapshot applied');
    tv2Assert(p.rows.length === 51 && p.revision === rev + 1 && p.auditedRevision === rev, 'inconclusive changed rows/auditedRevision');
    p.rows[45] = { ...p.rows[45]!, text: 'garbled' };
    tv2Assert(await e.audit(a.key) === 'annotate', 'mismatch not annotated');
    tv2Assert(p.rows[45]!.text === 'garbled', 'finalized row overwritten from one screen');
    tv2Assert([...p.incidents.values()].some(i => i.reason === 'audit-mismatch' && i.affected.after?.rowOrdinal === 44 && i.action === 'annotate'), 'annotation range');
    const off = tv2World({ audit: { ...TV2K.NEWARCH_V2_DEFAULT_CONFIG.audit, enabled: false } }); const eo = tv2Open(off, 'e1');
    const o = await eo.birth('work', 'S1') as { paneId: string; key: string };
    tv2Emit(off, o.paneId, 'E00001 A'); await eo.pumpAll();
    tv2Assert(await eo.audit(o.key) === 'disabled' && off.captures === 0 && off.disk.timers === 0, 'disabled auditor captured');
    tv2Assert(!w.disk.events.some(x => x.kind.startsWith('audit') && x.writer !== 'engine:e1'), 'auditor used another writer');
    p.rows[45] = { ...p.rows[45]!, text: 'E00046 A' };
    const judged = tv2Judge(w); tv2Assert(judged.join(',') === '', `judge ${judged}`);
  },
  /** V2-14 stale: a commit lands between capture and apply. */
  async 'V2-14 stale audit evidence is dropped, never applied at a newer revision'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(10)) tv2Emit(w, a.paneId, t); await e.pumpAll();
    const p = w.disk.panes.get(a.key)!; p.rows[9] = { ...p.rows[9]!, text: 'garbled' };
    const r = await e.audit(a.key, async () => { p.rows[9] = { ...p.rows[9]!, text: 'E00010 A' }; tv2Emit(w, a.paneId, 'E00011 A'); await e.pump(a.key); });
    tv2Assert(r === 'inconclusive' && ![...p.incidents.values()].length, `stale audit result ${r}`);
    tv2Expect(w, [], { normal: true });
  },
  /** V2-16: kill at every checkpoint/ACK/trim barrier; two engines on one root. */
  async 'V2-16 kill at each commit/ACK/trim barrier replays once without trimming needed raw; a second engine cannot open'() {
    for (const at of ['before-commit', 'commit-before-ack', 'ack-before-trim']) {
      const w = tv2World(); const e = tv2Open(w, 'e1');
      const a = await e.birth('work', 'S1') as { paneId: string; key: string };
      for (const t of tv2Lines(3)) tv2Emit(w, a.paneId, t); await e.pumpAll();
      for (const t of tv2Lines(3, 4)) tv2Emit(w, a.paneId, t);
      w.killAt = at; await e.pump(a.key).catch((err: unknown) => { if (!(err instanceof TV2Kill)) throw err; });
      tv2Assert(e.dead, `${at} barrier not reached`);
      await tv2Open(w, 'e2').resume();
      tv2Assert(tv2Rows(w, a.key).join() === tv2Lines(6).join(), `${at}: rows ${tv2Rows(w, a.key)}`);
      tv2Expect(w, [], { normal: true });
    }
    const w = tv2World(); tv2Open(w, 'e1');
    tv2Assert(!tv2Engine(w, 'e2').opened, 'second engine opened the same root');
    tv2Assert(w.disk.generation === 1, 'refused open bumped generation');
  },
  /** V2-03 F2 + m-final-4: actual resize during pump/close, and 100->120->100 while the host is down. */
  async 'V2-03 resize during pump stops before commit and close waits; 100-120-100 in downtime is never exact'() {
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(5)) tv2Emit(w, a.paneId, t); await e.pumpAll();
    for (const t of tv2Lines(5, 6)) tv2Emit(w, a.paneId, t);
    tv2Resize(w, a.paneId, 120);
    const pumping = e.pump(a.key);
    await e.close();
    const p = w.disk.panes.get(a.key)!;
    tv2Assert(p.stopped && [...p.incidents.values()].some(i => i.reason === 'geometry-violation' && i.affected.after?.rowOrdinal === 4), 'close returned before the durable stop');
    tv2Assert(tv2Rows(w, a.key).length === 5, 'batch across the violation published as exact');
    await pumping; tv2Expect(w, []);
    const v = tv2World(); const f = tv2Open(v, 'e1');
    const b = await f.birth('work', 'S1') as { paneId: string; key: string };
    for (const t of tv2Lines(3)) tv2Emit(v, b.paneId, t); await f.pumpAll(); f.kill();
    tv2Resize(v, b.paneId, 120); tv2Emit(v, b.paneId, 'E00004 A'); tv2Resize(v, b.paneId, 100); tv2Emit(v, b.paneId, 'E00005 A');
    await tv2Open(v, 'e2').resume();
    const q = v.disk.panes.get(b.key)!;
    tv2Assert(q.stopped && tv2Rows(v, b.key).length === 3, `100-120-100 replayed as exact: ${tv2Rows(v, b.key)}`);
    tv2Assert([...q.incidents.values()].some(i => i.reason === 'unverified-restart' && i.affected.after?.rowOrdinal === 2), 'downtime resize not labelled');
    tv2Expect(v, []);
  },
  /** V2-19 OFF-01/R16: empty root vs owned root with the flag off. */
  async 'V2-19 empty root flag-off creates nothing; an owned root keeps serving its pane'() {
    const empty = tv2World({ flagBirth: false });
    tv2Assert(empty.disk.files.length === 0 && empty.disk.timers === 0 && empty.disk.lock === null, 'empty root touched');
    const w = tv2World(); const e = tv2Open(w, 'e1');
    const a = await e.birth('work', 'S1') as { paneId: string; key: string };
    tv2Emit(w, a.paneId, 'E00001 A'); await e.pumpAll(); await e.close();
    w.flagBirth = false; tv2Emit(w, a.paneId, 'E00002 A');
    const e2 = tv2Open(w, 'e2'); await e2.resume(); tv2Keeper(w);
    tv2Assert(tv2Rows(w, a.key).length === 2 && w.disk.sessions.get('S1')!.state === 'active', 'flag off dropped the owner');
    tv2Expect(w, [], { normal: true });
  },
  /** §9 sampler (Q contract): fixed state, PID reuse and missing reads invalidate. */
  async 'PSS sampler rejects +250 MiB/h, mid growth, missing reads and PID reuse with fixed state'() {
    const run = (f: (t: number) => number, mutate?: (t: number) => { pid: number; startTime: string; pss: number | null; product: boolean }[]) => {
      const s = tv2Sampler(); const sizes: number[] = [];
      for (let i = 0; i <= 3600; i++) { const t = i / 60; s.add(t, mutate?.(t) ?? [{ pid: 10, startTime: 'a', pss: f(t), product: true }, { pid: 11, startTime: 'b', pss: 20, product: true }]); if (i % 900 === 0) sizes.push(s.stateBytes()); }
      return { ...s.verdict(), sizes };
    };
    const flat = run(() => 340);
    tv2Assert(flat.pass && Math.abs(flat.slope) < 0.001, `flat ${JSON.stringify(flat)}`);
    tv2Assert(new Set(flat.sizes.slice(1)).size === 1, `sampler state grows ${flat.sizes}`);
    tv2Assert(!run(t => 340 + 250 * t / 60).pass, '+250 MiB/h passed');
    tv2Assert(!run(t => 340 + (t > 25 && t < 45 ? 80 : t >= 45 ? 80 - (t - 45) * 5 : 0)).pass, 'mid growth then drop passed');
    tv2Assert(!run(() => 340, t => [{ pid: 10, startTime: 'a', pss: t > 30 && t < 30.05 ? null : 340, product: true }]).valid, 'missing read counted as valid');
    tv2Assert(run(() => 340, t => [{ pid: 10, startTime: t > 40 ? 'reused' : 'a', pss: t > 40 ? 5 : 340 + t, product: true }]).valid === false, 'PID reuse passed');
  },
  /** E-RF-01 (E-prestudy §2): the reserve is full and H cannot write. */
  async 'E-RF-01 reserve full while H is full: durability FAILED is a readable state; no receipt, no ACK, intake stops'() {
    const w = tv2World({ capRows: 1, reserveCap: 1 }); const e = tv2Open(w, 'e1');
    const a = await e.birth('a', 'S1') as { paneId: string; key: string };
    const b = await e.birth('b', 'S2') as { paneId: string; key: string };
    for (const t of tv2Lines(3, 1, 'a')) tv2Emit(w, a.paneId, t); await e.pump(a.key);
    tv2Assert(w.disk.reserveUsed === 1, `E-RF-01 the first storage fault did not take the only slot (${w.disk.reserveUsed})`);
    for (const t of tv2Lines(3, 1, 'b')) tv2Emit(w, b.paneId, t);
    let thrown: unknown = null; try { await e.pump(b.key); } catch (err) { thrown = err; }
    tv2Assert(thrown === null, `E-RF-01 a full reserve threw instead of a durability state: ${String(thrown)}`);
    const label = tv2EOf(e).durability?.(b.key) ?? null;
    tv2Assert(label !== null && label.startsWith('storage-unavailable; durability FAILED'), `E-RF-01 durability label ${JSON.stringify(label)}`);
    const pb = w.disk.panes.get(b.key)!, raw = w.disk.raw.get(b.key)!;
    tv2Assert(raw.acked === 0 && pb.receipts.size === 0 && pb.rows.length === 0 && w.disk.reserveUsed === 1, 'E-RF-01 receipt, ACK or reserve without durability');
    tv2Assert(w.tmux.panes.get(b.paneId)!.pipe === null, 'E-RF-01 intake not stopped');
    await e.pump(b.key); tv2Emit(w, b.paneId, 'E-RF-01 late');
    tv2Assert(raw.records.length === 3 && raw.acked === 0 && pb.receipts.size === 0, 'E-RF-01 intake resumed without durability');
  },
  /** E-RF-02: protocol fault vs storage fault after the first batch. */
  async 'E-RF-02 a protocol fault spends no reserve; a storage fault after the first batch journals one storage-outage that materializes; nothing past it ACKed'() {
    const w = tv2World({ capRows: 5, reserveCap: 2 }); const e = tv2Open(w, 'e1');
    const a = await e.birth('a', 'S1') as { paneId: string; key: string };
    const b = await e.birth('b', 'S2') as { paneId: string; key: string };
    tv2Emit(w, a.paneId, '\u0000E-RF-02 bad'); await e.pump(a.key);
    tv2Assert(w.disk.reserveUsed === 0 && w.disk.emergency.size === 0 && w.disk.panes.get(a.key)!.stopped, 'E-RF-02 protocol fault spent reserve or kept going');
    for (const t of tv2Lines(3, 1, 'b')) tv2Emit(w, b.paneId, t); await e.pump(b.key);
    for (const t of tv2Lines(4, 4, 'b')) tv2Emit(w, b.paneId, t); await e.pump(b.key);
    const pending = [...w.disk.emergency.values()];
    tv2Assert(pending.length === 1 && pending[0]!.reason === 'storage-outage', `E-RF-02 storage fault journalled as ${pending.map(i => i.reason)}`);
    const record = tv2EDisk(w).slots?.find(s => s !== null && s.incident.incidentId === pending[0]!.incidentId) ?? null;
    tv2Assert(record !== null && ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(record.cause)
      && TV2K.v2MaterializesPending(TV2K.v2PendingFromEmergency(record, TV2_SLOT_FILE), pending[0]!), 'E-RF-02 the journalled record does not materialize its pending incident');
    const raw = w.disk.raw.get(b.key)!, pb = w.disk.panes.get(b.key)!;
    tv2Assert(raw.acked === 3 && pb.rows.length === 3 && raw.trimmed <= pb.checkpoint!.replayFloor, 'E-RF-02 raw past the first batch ACKed or trimmed');
    tv2Expect(w, []);
  },
  /** E-RF-03 (the MAJOR case): H took the incident in g, the host died before rearm. */
  async 'E-RF-03 H took the incident in g and the host died before rearm: at g+1 the old guard is false, the receipt stays g, one incident, rearmed by a fresh observation'() {
    const { w, e, a, p } = await tv2Journalled('E-RF-03');
    w.disk.space.capRows = 100; w.killAt = 'h-before-rearm'; await tv2Turn(e, a.key, 'E-RF-03');
    if (!e.dead) e.kill();
    const g = w.disk.generation;
    const e2 = tv2Open(w, 'e2'); await e2.resume();
    const receipt = [...p.receipts.values()].find(r => r.operationId.startsWith('storage-')) ?? null;
    tv2Assert(receipt !== null && receipt.generation === g && w.disk.generation === g + 1, `E-RF-03 storage receipt generation ${receipt?.generation} at ${w.disk.generation}`);
    const id = [...p.incidents.keys()][0]!;
    const resolution: TV2K.V2IncidentResolution = { schema: 'newarch-v2', pane: p.desc.pane, incidentId: id, state: 'resolved', receipt, writerGeneration: TV2K.v2WriterGeneration(receipt!.generation) };
    tv2Assert(!TV2K.v2IncidentResolvedBy(resolution, id, receipt!, TV2K.v2WriterGeneration(w.disk.generation)), 'E-RF-03 the old guard holds at g+1');
    tv2Assert(p.incidents.size === 1 && tv2Count(w, a.key, 'materialize') === 1, `E-RF-03 materialized twice (${p.incidents.size} incidents, ${tv2Count(w, a.key, 'materialize')} writes)`);
    tv2Assert(w.disk.reserveUsed === 0 && w.disk.emergency.size === 0 && w.disk.events.some(x => x.kind === 'rearm' && x.writer === 'engine:e2'), 'E-RF-03 reserve not rearmed by a fresh observation at g+1');
    tv2Assert(p.stopped && w.tmux.panes.get(a.paneId)!.pipe === null, 'E-RF-03 rearm resumed the pane');
    tv2Expect(w, []);
  },
  /** E-RF-04: an observation taken, then the host died before dispatch. */
  async 'E-RF-04 an observation taken before the host died is refused at g+1; a fresh read sends the rearm'() {
    const { w, e, a, id } = await tv2Journalled('E-RF-04');
    w.disk.space.capRows = 100; w.killAt = 'observation-before-dispatch'; await tv2Turn(e, a.key, 'E-RF-04');
    const stale = tv2EObservations(w).at(-1) ?? null;
    tv2Assert(e.dead && stale !== null && w.disk.reserveUsed === 1, 'E-RF-04 no host death between observation and dispatch');
    const e2 = tv2Open(w, 'e2');
    const replay = tv2EOf(e2).rearmWith;
    const verdict = replay ? await replay(a.key, id, stale!) : 'missing';
    tv2Assert(verdict === 'refused' && w.disk.reserveUsed === 1 && !w.disk.events.some(x => x.kind === 'rearm'), `E-RF-04 the stale observation of g was dispatched (${verdict})`);
    await e2.resume();
    tv2Assert(w.disk.reserveUsed === 0 && w.disk.events.some(x => x.kind === 'rearm' && x.writer === 'engine:e2'), 'E-RF-04 a fresh observation at g+1 did not rearm');
    tv2Expect(w, []);
  },
  /** E-RF-05: the journal is durable, H is not (killed in between). */
  async 'E-RF-05 journal durable, H not yet: after reopen the same id, digest and clocks land in H once, nothing after them'() {
    const { w, e, a, p } = await tv2Journalled('E-RF-05');
    const journalled = [...w.disk.emergency.values()][0]!;
    w.disk.space.capRows = 100; w.killAt = 'journal-before-h'; await tv2Turn(e, a.key, 'E-RF-05');
    tv2Assert(p.rows.length === 0, `E-RF-05 H took ${p.rows.length} rows past the journalled incident`);
    tv2Assert(e.dead, 'E-RF-05 no host death between journal and H');
    w.seq += 1_000;
    const e2 = tv2Open(w, 'e2'); await e2.resume();
    const held = [...p.incidents.values()];
    tv2Assert(held.length === 1 && held[0]!.incidentId === journalled.incidentId && TV2K.v2EmergencyIncidentDigest(held[0]!) === TV2K.v2EmergencyIncidentDigest(journalled)
      && tv2Count(w, a.key, 'materialize') === 1, 'E-RF-05 H holds other bytes than the journal, or holds them twice');
    tv2Expect(w, []);
  },
  /** E-RF-06: the rearm RPC was sent, the host died before S answered. */
  async 'E-RF-06 rearm sent, host died before the reply: reopen neither reuses the old observation nor writes H again'() {
    const { w, e, a, p } = await tv2Journalled('E-RF-06');
    w.disk.space.capRows = 100; w.killAt = 'dispatch-before-reply'; await tv2Turn(e, a.key, 'E-RF-06');
    tv2Assert(e.dead && p.incidents.size === 1, 'E-RF-06 no host death after the rearm was sent');
    const used = tv2EObservations(w).length;
    const e2 = tv2Open(w, 'e2'); await e2.resume(); await e2.resume();
    tv2Assert(p.incidents.size === 1 && tv2Count(w, a.key, 'materialize') === 1, 'E-RF-06 H written again after the lost reply');
    tv2Assert(w.disk.reserveUsed === 0 && tv2EObservations(w).slice(used).every(o => o.authorizedGeneration === w.disk.generation),
      'E-RF-06 reserve not rearmed at g+1, or an observation of g reused');
    tv2Expect(w, []);
  },
  /** E-RF-07: death while S writes the scratch of the slot. */
  async 'E-RF-07 death in the slot write: host death leaves the collector write whole; collector death keeps the old slot, one scratch, no new epoch'() {
    {
      const { w, e, a, p } = await tv2Journalled('E-RF-07 host');
      w.disk.space.capRows = 100; w.killAt = 'host:scratch-before-rename'; await tv2Turn(e, a.key, 'E-RF-07 host');
      const slots = tv2EDisk(w).slots ?? null, scratch = tv2EDisk(w).scratch ?? null;
      tv2Assert(e.dead && slots !== null && slots.every(s => s === null) && scratch !== null && scratch.size === 0, 'E-RF-07 host death undid or tore the collector write');
      const e2 = tv2Open(w, 'e2'); await e2.resume();
      tv2Assert(p.incidents.size === 1 && p.stopped && tv2Count(w, a.key, 'materialize') === 1, 'E-RF-07 host restart wrote H again');
      tv2Expect(w, []);
    }
    {
      const { w, e, a, id, p } = await tv2Journalled('E-RF-07 collector');
      const epoch = w.collectorEpoch, paneEpoch = p.epoch;
      w.disk.space.capRows = 100; w.killAt = 'collector:scratch-before-rename'; await tv2Turn(e, a.key, 'E-RF-07 collector');
      const slots = tv2EDisk(w).slots ?? null, scratch = tv2EDisk(w).scratch ?? null;
      tv2Assert(!e.dead && !w.collectorUp && slots !== null && slots.some(s => s !== null && s.incident.incidentId === id) && scratch !== null && scratch.size === 1,
        'E-RF-07 collector death lost the old slot or left other than one scratch');
      e.kill(); const e2 = tv2Open(w, 'e2'); await e2.resume();
      tv2Assert(w.disk.reserveUsed === 1 && p.stopped && w.collectorEpoch === epoch && p.epoch === paneEpoch, 'E-RF-07 reserve cleared, pane resumed or epoch changed while the collector is down');
      w.collectorUp = true; await e2.resume();
      tv2Assert(w.disk.reserveUsed === 0 && scratch!.size === 0 && p.incidents.size === 1, 'E-RF-07 the restarted collector did not rearm the same slot');
      tv2Expect(w, []);
    }
  },
  /** E-RF-08: rename done, directory not synced; or synced and the reply lost. */
  async 'E-RF-08 rename before the directory sync, or the reply lost after it: the slot is the old incident or empty, never torn; a missing id is not a reason to write H again'() {
    for (const at of ['collector:rename-before-dirsync', 'host:dirsync-before-reply']) {
      const { w, e, a, p } = await tv2Journalled(`E-RF-08 ${at}`);
      w.disk.space.capRows = 100; w.killAt = at; await tv2Turn(e, a.key, `E-RF-08 ${at}`);
      const slots = tv2EDisk(w).slots ?? null;
      tv2Assert(slots !== null && (at.startsWith('host:') ? e.dead : !w.collectorUp)
        && slots.every(s => s === null || (typeof s === 'object' && 'incident' in s && TV2K.v2EmergencyIncidentDigest(s.incident) === s.digest)), `E-RF-08 ${at}: torn slot or no death`);
      w.collectorUp = true; if (!e.dead) e.kill();
      const e2 = tv2Open(w, 'e2'); await e2.resume(); await e2.resume();
      tv2Assert(p.incidents.size === 1 && tv2Count(w, a.key, 'materialize') === 1 && w.disk.reserveUsed === 0, `E-RF-08 ${at}: H written again or the reserve left held`);
      tv2Expect(w, []);
    }
  },
  /** E-RF-09: S answered, the host died before recording it; two reopens. */
  async 'E-RF-09 the reply arrived but the host died before recording it: two reopens read H and the slot, not a RAM flag'() {
    const { w, e, a, p } = await tv2Journalled('E-RF-09');
    w.disk.space.capRows = 100; w.killAt = 'reply-before-record'; await tv2Turn(e, a.key, 'E-RF-09');
    tv2Assert(e.dead && w.disk.reserveUsed === 0, 'E-RF-09 no host death between the reply and its record');
    const receipt = [...p.receipts.values()].find(r => r.operationId.startsWith('storage-'))!;
    const e2 = tv2Open(w, 'e2'); await e2.resume(); e2.kill();
    const e3 = tv2Open(w, 'e3'); await e3.resume();
    tv2Assert(p.incidents.size === 1 && tv2Count(w, a.key, 'materialize') === 1 && p.receipts.get(receipt.operationId) === receipt && receipt.generation === 1,
      'E-RF-09 a reopen wrote H again or changed the receipt');
    tv2Expect(w, []);
  },
  /** E-RF-10: two panes share the one slot over time. */
  async 'E-RF-10 A rearmed, its slot reused by B: a late rearm of A does not clear B, and B materializes on its own'() {
    const w = tv2World({ capRows: 3, reserveCap: 1 }); const e = tv2Open(w, 'e1');
    const a = await e.birth('a', 'S1') as { paneId: string; key: string };
    const b = await e.birth('b', 'S2') as { paneId: string; key: string };
    for (const t of tv2Lines(5, 1, 'a')) tv2Emit(w, a.paneId, t); await tv2Turn(e, a.key, 'E-RF-10');
    const A = [...w.disk.emergency.keys()][0] ?? '';
    w.disk.space.capRows = 4; await tv2Turn(e, a.key, 'E-RF-10');
    tv2Assert(w.disk.reserveUsed === 0 && w.disk.panes.get(a.key)!.incidents.has(A), 'E-RF-10 A was not materialized and rearmed');
    for (const t of tv2Lines(5, 1, 'b')) tv2Emit(w, b.paneId, t); await tv2Turn(e, b.key, 'E-RF-10');
    const B = [...w.disk.emergency.keys()][0] ?? '';
    tv2Assert(B !== '' && B !== A && w.disk.reserveUsed === 1, 'E-RF-10 B did not take the freed slot');
    const late = tv2EOf(e).collectorRearm;
    tv2Assert(late !== undefined, 'E-RF-10 no collector rearm to deliver late');
    late!(A);
    tv2Assert(w.disk.emergency.has(B) && w.disk.reserveUsed === 1, 'E-RF-10 the late rearm of A cleared B');
    w.disk.space.capRows = 100; await tv2Turn(e, b.key, 'E-RF-10');
    tv2Assert(w.disk.panes.get(b.key)!.incidents.has(B) && w.disk.reserveUsed === 0, 'E-RF-10 B did not materialize on its own');
    tv2Expect(w, []);
  },
  /** E-RF-11: a second storage fault after a rearm. */
  async 'E-RF-11 after a rearm a new storage fault journals one new incident; the receipt of g ACKs and trims nothing'() {
    const { w, e, a } = await tv2Journalled('E-RF-11');
    w.disk.space.capRows = 100; await tv2Turn(e, a.key, 'E-RF-11');
    const rawA = w.disk.raw.get(a.key)!;
    tv2Assert(w.disk.reserveUsed === 0 && rawA.acked === 0 && rawA.trimmed === 0 && rawA.records.length === 5, `E-RF-11 rearm ACKed or trimmed with the receipt of g (acked ${rawA.acked}, trimmed ${rawA.trimmed})`);
    e.kill(); const e2 = tv2Open(w, 'e2'); await e2.resume();
    tv2Assert(rawA.acked === 0 && rawA.trimmed === 0, 'E-RF-11 g+1 ACKed or trimmed with the receipt of g');
    const b = await e2.birth('b', 'S2') as { paneId: string; key: string };
    w.disk.space.capRows = 3;
    for (const t of tv2Lines(5, 1, 'b')) tv2Emit(w, b.paneId, t); await tv2Turn(e2, b.key, 'E-RF-11');
    const pending = [...w.disk.emergency.values()];
    tv2Assert(pending.length === 1 && TV2K.v2PaneKey(pending[0]!.pane) === b.key && pending[0]!.reason === 'storage-outage' && w.disk.reserveUsed === 1,
      'E-RF-11 the rearmed reserve did not take one new incident');
    tv2Expect(w, []);
  },
};
// T-V2-HARNESS-END

// Each mutant damages one PLAN-v2 §8 invariant in an isolated copy of the
// harness region; every listed scenario must go red, the clean copy green.
const TV2_MUTANTS: Record<string, { from: string; to: string; red: readonly string[] }> = {
  'flag-off stops the pump': { from: "    if (!p || !raw || p.stopped) return;\n", to: "    if (!p || !raw || p.stopped || !w.flagBirth) return;\n", red: ['V2-01', 'V2-19'] },
  'keeper may write a NEWARCH session': { from: 'if (!TV2K.v2LegacyAppendAllowed(owner, session)) continue;', to: "if (owner.kind === 'unknown') continue;", red: ['V2-01', 'V2-07'] },
  'pane index keyed by session name': { from: 'const tv2Index = (desc: TV2K.NewarchV2PaneDescriptor): TV2Key => TV2K.v2PaneKey(desc.pane);', to: 'const tv2Index = (desc: TV2K.NewarchV2PaneDescriptor): TV2Key => desc.session.sessionId;', red: ['V2-07'] },
  'geometry guard skipped': { from: '    if (!seen || !TV2K.v2GeometryMatches(p.desc, seen) || raw.resizes !== p.resizesSeen) {', to: '    if (!seen) {', red: ['V2-03', 'V2-08'] },
  'resume replays before the continuity proof': { from: "        if (p.stopped) continue;\n        const tp = tv2PaneOf(w, k); const raw = d.raw.get(k);", to: "        if (p.stopped) continue;\n        await pumpNow(k);\n        const tp = tv2PaneOf(w, k); const raw = d.raw.get(k);", red: ['V2-09'] },
  'close does not wait for the pane queue': { from: '      await Promise.all([...queues.values()]);', to: '', red: ['V2-03'] },
  'incident needs an input ACK': { from: '        if (p.rows.length >= d.space.capRows) continue;', to: '        if (p.rows.length >= d.space.capRows || d.raw.get(k)!.acked === 0) continue;', red: ['V2-05'] },
  'auditor writes through its own connection': { from: "        }, `expected=${revision} revision=${p.revision}`);", to: "        }, `expected=${revision} revision=${p.revision}`, 'auditor');", red: ['V2-14 auditor'] },
  'stale audit revision accepted': { from: '        if (raw.records.length !== raw.acked || raw.acked !== acked || p.revision !== revision) {', to: '        if (raw.records.length !== raw.acked) {', red: ['V2-14 stale'] },
  'raw trimmed before the checkpoint commits': { from: "    barrier('before-commit');", to: "    raw.trimmed = end; barrier('before-commit');", red: ['V2-16'] },
  'stop hands the session back to legacy': { from: '() => { p.incidents.set(i.incidentId, i); if (stop) p.stopped = true; }', to: '() => { p.incidents.set(i.incidentId, i); if (stop) { p.stopped = true; d.sessions.delete(p.desc.session.sessionId); } }', red: ['V2-07'] },
  'second engine opens a live root': { from: "  if (d.lock?.alive) return { opened: false as const, reason: 'locked' };", to: '', red: ['V2-16'] },
  'sampler keeps every sample': { from: '      s.max = Math.max(s.max, y);', to: '      s.max = Math.max(s.max, y); (s as unknown as { kept: number[] }).kept = [...((s as unknown as { kept?: number[] }).kept ?? []), y];', red: ['PSS sampler'] },
};

for (const [name, run] of Object.entries(tv2Scenarios)) test(`T-V2 ${name}`, run, 30_000);

for (const [mutation, m] of Object.entries(TV2_MUTANTS)) {
  test(`T-V2 MUTATION "${mutation}" turns ${m.red.join(' + ')} red in an isolated copy`, () => {
    const self = readFileSync(import.meta.path, 'utf8');
    const begin = self.indexOf('// T-V2-HARNESS-' + 'BEGIN'), end = self.indexOf('// T-V2-HARNESS-' + 'END');
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const region = self.slice(begin, end);
    expect(region.split(m.from).length).toBe(2);
    const targets = Object.keys(tv2Scenarios).filter(n => m.red.some(r => n.startsWith(r)));
    expect(targets.length).toBeGreaterThanOrEqual(m.red.length);
    const contract = new URL('../src/stream-contract.ts', import.meta.url).pathname;
    const dir = t11Mkdtemp(join(tmpdir(), 'tv2-mutant-'));
    try {
      for (const damaged of [false, true]) {
        const script = join(dir, `scenario-${damaged}.ts`);
        writeFileSync(script, `import * as TV2K from ${JSON.stringify(contract)};\n${damaged ? region.replace(m.from, m.to) : region}\n`
          + `for (const name of ${JSON.stringify(targets)}) await tv2Scenarios[name]!();\n`);
        const r = t11Spawn(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 });
        console.log(`T-V2 MUTATION ${mutation} damaged=${damaged} exit=${r.status} ${(r.stderr ?? '').split('\n').find(l => l.startsWith('error:')) ?? ''}`);
        expect(r.status).toBe(damaged ? 1 : 0);
      }
    } finally { t11Rm(dir, { recursive: true, force: true }); }
  }, 120_000);
}
