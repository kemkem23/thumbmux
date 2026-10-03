/** Stream-first I lifecycle. This module never opens tmux or a legacy store. */
import { PipeVtPool, CheckpointCaptureVt, type CaptureVtRpc } from './pipe-vt-worker';
import { CaptureAdmission, CaptureCadence, StreamCaptureEngine, type CapturePorts } from './capture-engine';
import { StreamHistoryEngine } from './history-engine';
import { StreamDisplayEngine } from './display-engine';
import { STREAM_BUDGET as B, streamDigest, type StreamIdentity, type Geometry, type LiveFrame,
  type InputEvent, type Result, type VtCheckpoint, type ViewerRoute, type ReadRequest,
  type PageCursor, type CancelToken, type StreamObserver } from './stream-contract';

const paneKey = (pane: StreamIdentity['pane']) => JSON.stringify([pane.serverIdentity, pane.paneId, pane.birthGeneration]);
const unwrap = <T>(r: Result<T>): T => { if (r.status !== 'ok') throw Error(JSON.stringify(r)); return r.value; };
const wire = (kind: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5); header.write(kind); header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
};

/** One outstanding J request per channel. Cancellation kills and reaps the
 * shared generation before ACK: destroying a socket alone cannot retire J. */
export class StreamVtTransport implements CaptureVtRpc {
  private lease: Awaited<ReturnType<PipeVtPool['acquire']>> | null = null;
  private pending: { kind: string; resolve(value: any): void; reject(error: Error): void } | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private retirement: Promise<void> | null = null;
  private resetting: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private pool: PipeVtPool | null = null;
  private geometry: Geometry | null = null;
  private epoch = 0;
  private transactionActive = false;
  get pid(): number | null { return this.lease?.pid ?? null; }
  start(pool: PipeVtPool, geometry: Geometry, epoch: number): Promise<void> {
    if (this.starting) return Promise.reject(Error('stream RPC already starting'));
    const work=this.openChannel(pool,geometry,epoch);
    this.starting=work;
    const settled=()=>{if(this.starting===work)this.starting=null;};
    void work.then(settled,settled);
    return work;
  }
  private async openChannel(pool: PipeVtPool, geometry: Geometry, epoch: number): Promise<void> {
    if (this.closed) throw Error('stream RPC retired');
    this.pool = pool; this.geometry = geometry; this.epoch = epoch;
    const lease = await pool.acquire();
    if (this.closed) { lease.socket.destroy(); await lease.release(); throw Error('stream RPC retired'); }
    this.lease = lease;
    const socket = lease.socket;
    socket.on('error', error => { if (this.lease === lease) this.fail(error); });
    socket.on('close', () => { if (this.lease === lease) this.fail(Error('stream VT channel closed')); });
    socket.on('data', (chunk: Buffer) => {
      if (this.closed || this.lease !== lease) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 4 * B.vtBytesPerPane) { void this.resetGeneration(); return; }
      while (this.buffer.length >= 5) {
        const length = this.buffer.readUInt32BE(1);
        if (length > 4 * B.vtBytesPerPane) { void this.resetGeneration(); return; }
        if (this.buffer.length < length + 5) return;
        const kind = this.buffer.toString('ascii', 0, 1);
        const body = this.buffer.subarray(5, length + 5);
        this.buffer = this.buffer.subarray(length + 5);
        // A attaches an inert legacy channel, which emits its blank U once.
        // J replies alone own transactional state; unsolicited E remains fatal.
        if (kind === 'U' || kind === 'H') continue;
        const pending = this.pending;
        if (!pending || pending.kind !== kind) { this.fail(Error('unexpected stream RPC reply')); void this.resetGeneration(); return; }
        this.pending = null;
        try { pending.resolve(JSON.parse(body.toString('utf8'))); }
        catch (error) { pending.reject(error as Error); }
      }
    });
    const attach = Buffer.alloc(12);
    attach.writeUInt16BE(geometry.columns); attach.writeUInt16BE(geometry.rows, 2);
    attach.writeBigUInt64BE(BigInt(epoch), 4);
    await this.call('A', 'R', attach);
  }
  private fail(error: Error): void {
    this.pending?.reject(error); this.pending = null;
  }
  private async call(kind: string, reply: string, body: Buffer): Promise<any> {
    if (this.closed || !this.lease || this.lease.socket.destroyed || this.pending) throw Error('stream RPC unavailable');
    if (body.length > 1024 * 1024) throw Error('stream RPC input budget');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { kind: reply, resolve, reject };
        timer = setTimeout(() => { void this.resetGeneration(); }, B.recoveryMs);
        const lease=this.lease!, pending=this.pending;
        lease.socket.write(wire(kind, body), error => {
          if (error && this.lease===lease && this.pending===pending) this.fail(error);
        });
      });
    } finally { if (timer) clearTimeout(timer); }
  }
  async transaction(request: Parameters<CaptureVtRpc['transaction']>[0]): ReturnType<CaptureVtRpc['transaction']> {
    if (this.transactionActive || this.closed) return {status:'error',code:'io',message:'stream RPC unavailable'};
    this.transactionActive = true;
    try {
      // J is a pure transaction over the supplied checkpoint + event. Repeating
      // the identical request on another worker cannot append H rows twice.
      // Never retry an operation explicitly retired by its owner.
      for (let attempt = 0; ; attempt++) {
        try { return {status:'ok',value:await this.call('J','J',Buffer.from(JSON.stringify(request)))}; }
        catch (error) {
          if (attempt || this.closed || !this.pool || !this.geometry) throw error;
          await this.resetGeneration();
          if (this.closed) throw error;
          await this.start(this.pool, this.geometry, this.epoch);
        }
      }
    } catch (error) { return {status:'error',code:'io',message:String(error)}; }
    finally { this.transactionActive = false; }
  }
  private resetGeneration(): Promise<void> {
    if (this.resetting) return this.resetting;
    const lease = this.lease;
    this.lease = null;
    this.fail(Error('stream RPC generation retired'));
    this.buffer = Buffer.alloc(0);
    const work = (async () => {
      if (lease) { lease.kill('SIGKILL'); await lease.done; lease.socket.destroy(); await lease.release(); }
    })();
    this.resetting = work;
    void work.then(() => { if (this.resetting === work) this.resetting = null; }, () => {});
    return work;
  }
  retire(): Promise<void> {
    this.closed = true;
    return this.retirement ??= (async()=>{
      await this.resetGeneration();
      // acquire() may have started before retirement but not returned its
      // lease yet. Its closed check must release that lease before the ACK.
      await this.starting?.catch(()=>{});
      await this.resetGeneration();
    })();
  }
  async close(): Promise<void> {
    if (this.pending || this.transactionActive || this.resetting) return this.retire();
    this.closed = true;
    this.lease?.socket.destroy(); await this.lease?.release(); this.buffer = Buffer.alloc(0);
  }
}

export interface StreamPanePorts extends Pick<CapturePorts,
  'visible' | 'repairChunks' | 'syncRepair' | 'verifyRepair' | 'repairedCheckpoint'> {
  /** Resolve after source RPC/readers/commits are retired, not merely aborted. */
  cancelOperation(signal: AbortSignal): Promise<void>;
}
export interface StreamRuntimeOptions {
  path: string; pool?: PipeVtPool; python?: string; observer?: StreamObserver;
}
export class StreamRuntime {
  readonly pool: PipeVtPool;
  readonly admission = new CaptureAdmission();
  readonly scratch = new CaptureAdmission(B.scratchBytes);
  history: StreamHistoryEngine | null = null;
  private panes = new Map<string, StreamRuntimePane>();
  private closing = false;
  private sharedDisplay: StreamDisplayEngine | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private ticks = new Map<StreamRuntimePane, Promise<void>>();
  private viewerSlots = new Map<string, StreamRuntimePane>();
  constructor(readonly options: StreamRuntimeOptions) {
    this.pool = options.pool ?? new PipeVtPool({ python: options.python });
    this.timer = setInterval(() => {
      for (const pane of this.panes.values()) {
        if (this.ticks.has(pane)) continue;
        const task = pane.tick(); this.ticks.set(pane, task);
        const settled = () => { if (this.ticks.get(pane) === task) this.ticks.delete(pane); };
        void task.then(settled, settled);
      }
    }, 25);
    this.timer.unref?.();
  }
  displayEngine(): StreamDisplayEngine {
    if (!this.sharedDisplay) {
      const lookup = (key: StreamIdentity['pane']) => {
        const pane = this.panes.get(paneKey(key));
        if (!pane) throw Error('stream pane no longer attached'); return pane;
      };
      const capture: import('./stream-contract').CaptureEngine = {
        acceptInput: event => lookup(event.identity.pane).capture.acceptInput(event),
        checkpoint: (pane, reason) => lookup(pane).capture.checkpoint(pane, reason),
        restore: (checkpoint, input) => lookup(checkpoint.identity.pane).capture.restore(checkpoint, input),
        checkVisible: identity => lookup(identity.pane).capture.checkVisible(identity),
        repair: (episode, cancel) => lookup(episode.pane).capture.repair(episode, cancel),
        drain: (pane, deadline) => lookup(pane).capture.drain(pane, deadline),
        subscribe: (key, listener) => {
          const pane = lookup(key), off = pane.capture.subscribe(key, listener);
          listener(pane.frame); return off;
        },
      };
      this.sharedDisplay = new StreamDisplayEngine({capture, history: this.history!, observer: this.options.observer, retryUntilDeadline: true});
    }
    return this.sharedDisplay;
  }
  reserveViewer(id: string, owner: StreamRuntimePane): boolean {
    if (this.viewerSlots.has(id)) return this.viewerSlots.get(id) === owner;
    if (this.viewerSlots.size >= B.panes) return false;
    this.viewerSlots.set(id, owner); return true;
  }
  releaseViewer(id: string): void { this.viewerSlots.delete(id); }
  /** `adoptRecoveredGeometry`: boot finalization replays a stored tenure and
   * must not append a resize event that the source never produced. */
  async add(identity: StreamIdentity, geometry: Geometry, ports: StreamPanePorts, scrollOnClear = false,
    options: { adoptRecoveredGeometry?: boolean } = {}): Promise<StreamRuntimePane> {
    const key = paneKey(identity.pane);
    if (this.closing || this.panes.has(key) || this.panes.size >= B.panes) throw Error('stream pane admission');
    const rpc = new StreamVtTransport();
    try {
      await rpc.start(this.pool, geometry, identity.sourceEpoch);
      const vt = unwrap(await CheckpointCaptureVt.create(rpc, identity, geometry, scrollOnClear));
      const state = unwrap(await vt.snapshot());
      this.history ??= new StreamHistoryEngine({ path: this.options.path, codecVersions: [state.codecVersion], stagePrefixesOnDisk: true });
      const pane = new StreamRuntimePane(this, rpc, vt, identity, ports);
      this.panes.set(key, pane);
      try {
        await pane.recover();
        if (!options.adoptRecoveredGeometry && (pane.frame.geometry.columns !== geometry.columns || pane.frame.geometry.rows !== geometry.rows)) await pane.resize(geometry);
      } catch (error) { this.panes.delete(key); throw error; }
      pane.startCadence();
      return pane;
    } catch (error) { await rpc.close(); throw error; }
  }
  /** Handoff release: the caller already froze the pane's durable fence (a
   * checkpoint, or rows flushed behind a durable gap episode). No new drain. */
  async retire(pane: StreamRuntimePane): Promise<void> {
    pane.stopCadence(); await this.ticks.get(pane);
    await pane.retire(); this.panes.delete(paneKey(pane.identity.pane));
  }
  async remove(pane: StreamRuntimePane): Promise<void> {
    pane.stopCadence(); await this.ticks.get(pane);
    await pane.close(); this.panes.delete(paneKey(pane.identity.pane));
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.ticks.values());
    // No finally-close: failed drain keeps H and its recovery evidence alive.
    for (const pane of this.panes.values()) await pane.close();
    if (this.history?.stats().ownedPendingBytes || this.scratch.heldBytes || this.admission.heldBytes)
      throw Error('stream close refused: undurable pending or quarantined operation');
    const receipt = this.history?.close();
    if (receipt?.undurableBytes) throw Error('stream close lost undurable state');
    this.panes.clear(); await this.pool.close();
  }
}

export class StreamRuntimePane {
  capture!: StreamCaptureEngine;
  display!: StreamDisplayEngine;
  frame: LiveFrame;
  identity: StreamIdentity;
  private sequence = 0;
  private accepting = true;
  private chain: Promise<void> = Promise.resolve();
  private inputBytes = 0;
  private viewers = new Map<string, ViewerRoute>();
  private closed = false;
  private cadence!: CaptureCadence;
  private cadenceReady = false;
  private receivedAt = -Infinity;
  private liveViewers = 0;
  setLiveViewers(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > B.panes) throw Error('stream viewer count');
    this.liveViewers = count;
  }
  constructor(readonly runtime: StreamRuntime, readonly rpc: StreamVtTransport,
    private readonly vt: CheckpointCaptureVt, identity: StreamIdentity, private readonly ports: StreamPanePorts) {
    this.identity = structuredClone(identity);
    this.frame = {...vt.screen(), head: 0, revision: 0, durableRevision: 0};
    this.makeCapture();
  }
  private makeCapture(): void {
    this.capture = new StreamCaptureEngine({...this.ports, identity: this.identity, history: this.runtime.history!, vt: this.vt,
      initial: this.frame, admission: this.runtime.admission, scratch: this.runtime.scratch,
      now: () => performance.now(), observer: this.runtime.options.observer,
      // C's scoped asynchronous operations are source reads/repair closeout.
      // The source owner retires precisely those operations. Killing the shared
      // VT here would also interrupt unrelated panes on a visible-read timeout.
      cancelOperation: signal => this.ports.cancelOperation(signal)});
    this.capture.subscribe(this.identity.pane, frame => { this.frame = frame; this.identity = frame.identity; });
    this.display = this.runtime.displayEngine();
    this.cadence = new CaptureCadence(this.capture, () => this.identity, () => performance.now());
  }
  startCadence(): void { this.cadenceReady = true; }
  stopCadence(): void { this.cadenceReady = false; }
  async tick(): Promise<void> {
    if (!this.cadenceReady || this.closed) return;
    this.cadence.activity(this.viewers.size + this.liveViewers, performance.now() - this.receivedAt < B.visibleIdleMs);
    await this.cadence.tick();
  }
  async recover(): Promise<void> {
    unwrap(this.runtime.history!.discardStaged(this.identity.pane));
    const recovery = this.runtime.history!.recover(this.identity.pane, null, {isCancelled: () => false})[Symbol.asyncIterator]();
    try {
      const first = await recovery.next();
      if (first.done || first.value.status === 'stale') return;
      const chunk = unwrap(first.value);
      if (chunk.kind !== 'checkpoint') {
        // A crash may leave only journal input and staged prefixes. Replay
        // from the empty initial VT using original event IDs; H deduplicates.
        let item: import('./stream-contract').RecoveryChunk = chunk;
        for (;;) {
          if (item.kind === 'input') {
            unwrap(await this.capture.acceptInput(item.event));
            unwrap(await this.capture.drain(this.identity.pane, performance.now() + B.recoveryMs));
            this.sequence = item.event.position.packetSeq;
          }
          const next = await recovery.next(); if (next.done) return;
          item = unwrap(next.value);
        }
      }
      const cp = chunk.checkpoint;
      this.identity = cp.identity;
      this.frame = {...this.vt.screen(), identity: cp.identity, head: 0, revision: 0, durableRevision: 0};
      this.makeCapture();
      this.sequence = cp.inputFence.through.packetSeq;
      // Restore the checkpoint alone, then feed journal input one event at a
      // time with a drain between, like the checkpoint-free path: C's restore
      // refuses a second event while the first is still pending.
      async function* none(): AsyncIterable<InputEvent> {}
      this.frame = unwrap(await this.capture.restore(cp, none()));
      for (;;) {
        const next = await recovery.next(); if (next.done) break;
        const item = unwrap(next.value);
        if (item.kind !== 'input') continue;
        unwrap(await this.capture.acceptInput(item.event));
        unwrap(await this.capture.drain(this.identity.pane, performance.now() + B.recoveryMs));
        this.sequence = item.event.position.packetSeq;
      }
    } finally { await recovery.return?.(); }
  }
  /** Whole FIFO slice is owned until the promise resolves; never acknowledge a
   * partial slice as capacity-pressure (which would cause duplicate retry). */
  ingest(bytes: Uint8Array): Promise<void> {
    if (!this.accepting || bytes.length > 64 * 1024 || this.inputBytes) return Promise.reject(Error('stream input admission'));
    this.inputBytes = bytes.length; this.receivedAt = performance.now();
    const owned = Uint8Array.from(bytes);
    const work = this.chain.then(async () => {
      for (let offset = 0; offset < owned.length; offset += 512) {
        await this.event({kind: 'bytes', bytes: Array.from(owned.subarray(offset, offset + 512))});
      }
    });
    this.chain = work;
    return work.finally(() => { this.inputBytes = 0; });
  }
  private async event(payload: InputEvent['payload']): Promise<void> {
    const identity = payload.kind === 'resize' ? {...this.identity, geometryGeneration: this.identity.geometryGeneration + 1} : this.identity;
    const body = {identity, position: {sourceEpoch: identity.sourceEpoch, packetSeq: this.sequence + 1},
      receivedAtMonoMs: performance.now(), payload};
    const input = {...body, digest: streamDigest('input', body)};
    const deadline = performance.now() + B.recoveryMs;
    for (;;) {
      const result = await this.capture.acceptInput(input);
      if (result.status === 'ok') { this.sequence++; break; }
      if (result.status !== 'busy' || performance.now() >= deadline) throw Error(JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, Math.max(1, result.retryAfterMs)));
    }
    // Journal ACK is not the final frame ACK. Drain bounded pending before the
    // next source packet, including any prefix whose first append was busy.
    unwrap(await this.capture.drain(this.identity.pane, deadline));
  }
  async resize(geometry: Geometry): Promise<void> {
    if (!this.accepting) throw Error('stream closed');
    this.cadence.event();
    this.chain = this.chain.then(() => this.event({kind: 'resize', geometry}));
    await this.chain;
    for (const route of this.viewers.values()) await this.display.detach(route, 'geometry changed');
    for (const id of this.viewers.keys()) this.runtime.releaseViewer(id);
    this.viewers.clear();
  }
  async attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>> {
    if (!this.runtime.reserveViewer(route.viewerId, this)) return {status:'busy',reason:'pressure',retryAfterMs:20};
    const previous = this.viewers.get(route.viewerId);
    const owned = structuredClone(route);
    this.viewers.set(route.viewerId, owned);
    let result: Result<LiveFrame>;
    try {
      result = await this.display.attach(owned, frame => {
        try { onFrame(frame); } catch (error) {
          if (this.viewers.get(owned.viewerId) === owned) void this.detach(owned.viewerId);
          throw error;
        }
      });
    } catch (error) { result = {status: 'error', code: 'io', message: String(error)}; }
    if (this.viewers.get(owned.viewerId) !== owned) return {status: 'stale', reason: 'route'};
    if (result.status !== 'ok') {
      await this.display.detach(owned, 'attach failed');
      if (previous) await this.display.detach(previous, 'invalid replacement');
      this.viewers.delete(owned.viewerId); this.runtime.releaseViewer(owned.viewerId);
    }
    return result;
  }
  page(route: ViewerRoute, request: ReadRequest, cursor: PageCursor | null, limit: number, cancel: CancelToken) {
    return this.display.page(route, request, cursor, limit, cancel);
  }
  async detach(viewerId: string): Promise<void> {
    const route = this.viewers.get(viewerId); if (!route) return;
    await this.display.detach(route, 'disconnect'); this.viewers.delete(viewerId); this.runtime.releaseViewer(viewerId);
  }
  async drain(): Promise<VtCheckpoint | null> {
    await this.chain;
    if (!this.sequence) return null;
    unwrap(await this.capture.drain(this.identity.pane, performance.now() + B.recoveryMs));
    return unwrap(await this.capture.checkpoint(this.identity.pane, 'handoff'));
  }
  /** Await the input already handed to this pane, without draining it. */
  async settle(): Promise<void> { await this.chain.catch(() => {}); }
  async retire(): Promise<void> {
    if (this.closed) return;
    this.accepting = false; this.cadenceReady = false;
    await this.settle();
    for (const id of [...this.viewers.keys()]) await this.detach(id);
    await this.rpc.close(); this.closed = true;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.accepting = false; this.cadenceReady = false;
    await this.drain();
    for (const id of [...this.viewers.keys()]) await this.detach(id);
    await this.rpc.close(); this.closed = true;
  }
  stats() { return {inputBytes: this.inputBytes, packetSeq: this.sequence, frame: this.frame,
    workerPid: this.rpc.pid, display: this.display.stats(), history: this.runtime.history!.stats()}; }
}

// ───────────────────────────── NEWARCH flag-on (lot 10-I) ─────────────────────────────
// Pipe-bytes → finalized rows for the flag-on path (DESIGN-FINAL §3.3/§4.1).
// Every cell keeps the raw byte that wrote it (`pipe`) or the capture cell it
// came from (`capture` baseline), so C's stitch can tell a captured row that
// merely scrolls into history from new output. Parser state that the capture
// cannot reveal starts unknown and is cleared only by an explicit program
// command or by a visible verification against tmux (`verifyVisible`). Rows
// that depend on unknown state carry `uncertainFields` and are withheld by the
// caller under a gap; nothing here invents cells or guesses a seam.

import type { Cell as FlagOnCell, PipeEpoch as FlagOnEpoch, RowOrigin as FlagOnOrigin,
  StitchRow as FlagOnStitchRow, Cursor as FlagOnCursor } from './stream-contract';

export const FLAGON_DECODER_CODEC = 'flagon-decoder-v1';
/** Same field names as C's KnownStateTracker so withheld reasons line up. */
export const FLAGON_STATE_FIELDS = ['sgr', 'cursor', 'savedCursor', 'margins', 'charset', 'pendingUtf8', 'pendingEscape', 'wrap'] as const;
export type FlagOnStateField = typeof FLAGON_STATE_FIELDS[number] | 'unsupported-sequence' | 'geometry';
interface DCell { text: string; width: 0 | 1 | 2; style: [number, number, number]; origin: FlagOnOrigin }
interface DLine { cells: DCell[]; wrapped: boolean; uncertain: Set<FlagOnStateField>; touched: boolean }
interface Pen { style: number; fg: number; bg: number }
interface Screen { lines: DLine[]; cursor: { x: number; y: number }; saved: { x: number; y: number; pen: Pen; unknown: boolean } | null }
export interface FlagOnDecoderSeed {
  /** Capture rows of the live screen (packet rows at index ≥ historySize), top first. */
  readonly screen: readonly FlagOnStitchRow[];
  readonly cursor: FlagOnCursor;
  readonly alternate: boolean;
  readonly stateKnown: Readonly<Record<string, boolean>>;
}
export interface FlagOnDecoderOptions {
  readonly epoch: FlagOnEpoch;
  readonly geometry: Geometry;
  /** tmux `scroll-on-clear` (default on in 3.4): ED 2 pushes the screen into history. */
  readonly scrollOnClear: boolean;
  readonly seed?: FlagOnDecoderSeed;
}
const DEFAULT_PEN: Pen = { style: 0, fg: -1, bg: -1 };
const sgrCode = (n: number): number => n;
const PRINT_DEPS: readonly FlagOnStateField[] = ['sgr', 'charset', 'cursor', 'pendingUtf8', 'pendingEscape', 'wrap', 'unsupported-sequence', 'geometry'];

export class FlagOnVtDecoder {
  readonly epoch: FlagOnEpoch;
  geometry: Geometry;
  private normal: Screen;
  private alt: Screen | null = null;
  private pen: Pen = { ...DEFAULT_PEN };
  private unknown = new Set<FlagOnStateField>();
  private top = 0;
  private bottom: number;
  private autowrap = true;
  private pendingWrap = false;
  private utf8: number[] = [];
  private utf8Need = 0;
  private utf8Start = 0;
  private esc: { kind: 'esc' | 'csi' | 'osc' | 'str' | 'charset'; buf: number[]; start: number } | null = null;
  private ordinal = 0;
  private offset = 0;
  private readonly scrollOnClear: boolean;
  /** Finalized rows waiting for `take()`. */
  private out: FlagOnStitchRow[] = [];
  /** tmux's visible screen read while bytes were still in flight: compared at
   * every line feed and feed end until it matches or expires (see verifyVisible). */
  private target: { visible: Parameters<FlagOnVtDecoder['verifyVisible']>[0]; until: number; done: (r: { verified: boolean; reason: string | null; at: number }) => void } | null = null;
  /** Byte offsets where an earlier run proved this exact state (replay after a
   * host restart re-applies them; the parser is deterministic). */
  private proven: number[] = [];
  replayProven(offsets: readonly number[]): void { this.proven = [...offsets].filter(o => o >= this.offset).sort((a, b) => a - b); }
  constructor(options: FlagOnDecoderOptions) {
    this.epoch = options.epoch; this.geometry = options.geometry; this.scrollOnClear = options.scrollOnClear;
    this.bottom = options.geometry.rows - 1;
    this.normal = this.blankScreen();
    const seed = options.seed;
    if (seed) {
      for (const field of FLAGON_STATE_FIELDS) if (!this.known(seed.stateKnown, field)) this.unknown.add(field);
      const screen = seed.alternate ? (this.alt = this.blankScreen()) : this.normal;
      if (seed.alternate) this.unknown.add('margins');
      seed.screen.slice(0, options.geometry.rows).forEach((row, y) => {
        const line = screen.lines[y]!;
        line.cells = row.cells.slice(0, options.geometry.columns).map((cell, x) => ({ text: cell.text, width: cell.width,
          style: [cell.style[0] ?? 0, cell.style[1] ?? -1, cell.style[2] ?? -1] as [number, number, number],
          origin: row.cellOrigins[x] ?? row.cellOrigins[0] ?? row.origin }));
        // A blank captured row still is that row: tag it so its scroll-out is recognised.
        if (!line.cells.length && row.origin.kind === 'capture') line.cells = [];
        (line as DLine & { baseline?: FlagOnOrigin }).baseline = row.origin;
        for (const f of row.uncertainFields) line.uncertain.add(f as FlagOnStateField);
      });
      screen.cursor = { x: Math.min(seed.cursor.x, options.geometry.columns - 1), y: Math.min(seed.cursor.y, options.geometry.rows - 1) };
    }
    // Margins are never shown by capture-pane; with no seed (birth) everything is known.
  }
  private known(state: Readonly<Record<string, boolean>>, field: string): boolean {
    if (state[field] === true) return true;
    // CapturePacket names some fields differently (attributes = SGR pen, modes = charset/wrap).
    if (field === 'sgr') return state.attributes === true;
    if (field === 'charset') return state.modes === true;
    return false;
  }
  private blankLine(): DLine { return { cells: [], wrapped: false, uncertain: new Set(), touched: false }; }
  private blankScreen(): Screen { return { lines: Array.from({ length: this.geometry.rows }, () => this.blankLine()), cursor: { x: 0, y: 0 }, saved: null }; }
  private get screen(): Screen { return this.alt ?? this.normal; }
  unknownFields(): FlagOnStateField[] { return [...this.unknown]; }
  get position(): number { return this.offset; }
  get alternateActive(): boolean { return this.alt !== null; }
  cursor(): { x: number; y: number } { return { ...this.screen.cursor }; }
  /** Feed acknowledged raw bytes starting at collector offset `start`. */
  feed(bytes: ArrayLike<number>, start: number): void {
    if (start !== this.offset) throw Error(`decoder offset ${this.offset} fed ${start}`);
    if (this.proven[0] === start) { this.proven.shift(); this.clearProven(); }
    for (let i = 0; i < bytes.length; i++) {
      this.byte(bytes[i]!, start + i);
      if (this.proven.length && this.proven[0] === start + i + 1) { this.proven.shift(); this.clearProven(); }
      if (this.target && bytes[i] === 0x0a) this.tryTarget(start + i + 1);
    }
    this.offset = start + bytes.length;
    if (this.target) this.tryTarget(this.offset);
  }
  /** Verify against a visible read taken at an unknown byte position at or
   * after the current one (output kept flowing). The first parser state that
   * reproduces it exactly — checked at line feeds and feed ends, up to
   * `withinBytes` further bytes — proves the state; none expires unverified. */
  verifyLater(visible: Parameters<FlagOnVtDecoder['verifyVisible']>[0], withinBytes: number): Promise<{ verified: boolean; reason: string | null; at: number }> {
    this.target?.done({ verified: false, reason: 'superseded', at: this.offset });
    return new Promise(done => { this.target = { visible, until: this.offset + withinBytes, done }; this.tryTarget(this.offset); });
  }
  private tryTarget(at: number): void {
    const t = this.target!; const r = this.verifyVisible(t.visible);
    if (r.verified || at >= t.until) { this.target = null; t.done(r.verified ? { ...r, at } : { verified: false, reason: r.reason ?? 'expired', at }); }
  }
  /** Rows that scrolled into history since the last call, oldest first. */
  take(): FlagOnStitchRow[] { const rows = this.out; this.out = []; return rows; }
  private pipeOrigin(at: number): FlagOnOrigin { return { kind: 'pipe', range: { epoch: this.epoch, start: at, end: at + 1 }, ordinal: 0 }; }
  private cellAt(line: DLine, x: number): DCell | undefined { return line.cells[x]; }
  private markLine(line: DLine, deps: readonly FlagOnStateField[]): void {
    line.touched = true;
    for (const d of deps) if (this.unknown.has(d)) line.uncertain.add(d);
  }
  private markAll(field: FlagOnStateField): void {
    this.unknown.add(field);
    for (const line of this.screen.lines) line.uncertain.add(field);
  }
  private blank(at: number): DCell { return { text: ' ', width: 1, style: [this.pen.style & 0, -1, this.pen.bg], origin: this.pipeOrigin(at) }; }
  private padTo(line: DLine, x: number, at: number): void { while (line.cells.length < x) line.cells.push(this.blank(at)); }
  private byte(b: number, at: number): void {
    if (this.esc) { this.escByte(b, at); return; }
    if (this.utf8Need > 0) {
      if ((b & 0xc0) === 0x80) { this.utf8.push(b); if (this.utf8.length === this.utf8Need) this.flushUtf8(); return; }
      this.utf8 = []; this.utf8Need = 0; // malformed: dropped, tmux shows U+FFFD; mark the row
      this.markLine(this.screen.lines[this.screen.cursor.y]!, ['pendingUtf8']); this.unknown.add('pendingUtf8');
    }
    if (this.unknown.has('pendingEscape') && (b === 0x1b || b === 0x0a || b === 0x0d)) this.unknown.delete('pendingEscape');
    if (this.unknown.has('pendingUtf8') && (b < 0x80 || b >= 0xc0)) this.unknown.delete('pendingUtf8');
    if (b >= 0xc0 && b < 0xf8) { this.utf8 = [b]; this.utf8Need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2; this.utf8Start = at; return; }
    if (b >= 0x80 && b < 0xc0) return; // stray continuation (unknown pendingUtf8 already covers it)
    switch (b) {
      case 0x1b: this.esc = { kind: 'esc', buf: [], start: at }; return;
      case 0x0d: this.screen.cursor.x = 0; this.pendingWrap = false; return;
      case 0x0a: case 0x0b: case 0x0c: this.lineFeed(at); return;
      case 0x08: if (this.screen.cursor.x > 0) this.screen.cursor.x--; this.pendingWrap = false; return;
      case 0x09: { const x = this.screen.cursor.x; this.screen.cursor.x = Math.min(this.geometry.columns - 1, (Math.floor(x / 8) + 1) * 8);
        this.padTo(this.screen.lines[this.screen.cursor.y]!, this.screen.cursor.x, at); return; }
      case 0x0e: case 0x0f: this.unknown.delete('charset'); return;
      case 0x07: case 0x00: return;
    }
    if (b < 0x20 || b === 0x7f) return;
    this.print(String.fromCharCode(b), at, at);
  }
  private flushUtf8(): void {
    const text = Buffer.from(this.utf8).toString('utf8'); const start = this.utf8Start;
    this.utf8 = []; this.utf8Need = 0;
    this.print(text, start, start + Buffer.byteLength(text) - 1);
  }
  private print(text: string, at: number, _end: number): void {
    const cp = text.codePointAt(0)!;
    let width = (cp < 0x7f ? 1 : Math.max(0, Math.min(2, Bun.stringWidth(text)))) as 0 | 1 | 2;
    if (text.includes('️') && width === 1) width = 2;
    const s = this.screen, cols = this.geometry.columns;
    if (width === 0) {
      // Combining mark joins the previous cell, exactly as capture decoding does.
      const line = s.lines[s.cursor.y]!; const x = this.pendingWrap ? cols - 1 : s.cursor.x - 1;
      let prev = x >= 0 ? line.cells[x] : undefined;
      if (prev && prev.width === 0 && x > 0) prev = line.cells[x - 1];
      if (prev) { prev.text += text; this.markLine(line, PRINT_DEPS); }
      return;
    }
    if (this.pendingWrap && this.autowrap) { s.lines[s.cursor.y]!.wrapped = true; s.cursor.x = 0; this.lineFeed(at); }
    this.pendingWrap = false;
    if (width === 2 && s.cursor.x === cols - 1) {
      if (this.autowrap) { const l = s.lines[s.cursor.y]!; this.padTo(l, cols, at); l.wrapped = true; s.cursor.x = 0; this.lineFeed(at); }
      else return;
    }
    const line = s.lines[s.cursor.y]!;
    this.padTo(line, s.cursor.x, at);
    const style: [number, number, number] = [this.pen.style, sgrCode(this.pen.fg), sgrCode(this.pen.bg)];
    const origin = this.pipeOrigin(at);
    // Overwriting half of a wide cell leaves a blank in the other half (tmux behaviour).
    const old = line.cells[s.cursor.x];
    if (old && old.width === 0 && s.cursor.x > 0) line.cells[s.cursor.x - 1] = this.blank(at);
    if (old && old.width === 2 && line.cells[s.cursor.x + 1]?.width === 0) line.cells[s.cursor.x + 1] = this.blank(at);
    line.cells[s.cursor.x] = { text, width, style, origin };
    if (width === 2) line.cells[s.cursor.x + 1] = { text: '', width: 0, style, origin };
    this.markLine(line, PRINT_DEPS);
    const next = s.cursor.x + width;
    if (next >= cols) { s.cursor.x = cols - 1; this.pendingWrap = true; } else s.cursor.x = next;
    if (this.unknown.has('wrap') && next < cols) this.unknown.delete('wrap');
  }
  private lineFeed(at: number): void {
    const s = this.screen;
    this.pendingWrap = false;
    if (s.cursor.y === this.bottom) this.scrollUp(1, at);
    else if (s.cursor.y < this.geometry.rows - 1) s.cursor.y++;
  }
  /** Region scroll; in the normal buffer tmux moves the region's top line into history. */
  private scrollUp(n: number, at: number): void {
    const s = this.screen;
    for (let i = 0; i < n; i++) {
      const [gone] = s.lines.splice(this.top, 1);
      s.lines.splice(this.bottom, 0, this.blankLine());
      if (!this.alt && gone) this.emit(gone, at, this.unknown.has('margins') ? ['margins'] : []);
    }
  }
  private scrollDown(n: number): void {
    const s = this.screen;
    for (let i = 0; i < n; i++) { s.lines.splice(this.bottom, 1); s.lines.splice(this.top, 0, this.blankLine()); }
  }
  private emit(line: DLine, at: number, extra: readonly FlagOnStateField[]): void {
    const cols = this.geometry.columns;
    const cells = line.cells.slice(0, cols);
    const baseline = (line as DLine & { baseline?: FlagOnOrigin }).baseline;
    // Full width like capture -N decoding: trailing blanks are explicit cells.
    while (cells.length < cols) cells.push({ text: ' ', width: 1, style: [0, -1, -1], origin: baseline ?? this.pipeOrigin(at) });
    if (cells[cols - 1]?.width === 2) cells[cols - 1] = { text: ' ', width: 1, style: cells[cols - 1]!.style, origin: cells[cols - 1]!.origin };
    const origins = cells.map(c => c.origin);
    const pipes = origins.filter((o): o is Extract<FlagOnOrigin, { kind: 'pipe' }> => o.kind === 'pipe');
    const start = pipes.length ? Math.min(...pipes.map(o => o.range.start)) : at;
    const uncertain = new Set<string>([...line.uncertain, ...extra]);
    this.out.push({
      origin: { kind: 'pipe', range: { epoch: this.epoch, start: Math.min(start, at), end: at + 1 }, ordinal: this.ordinal++ },
      cells: cells.filter(c => c.width !== 0).map(c => ({ text: c.text, width: c.width, style: c.style }) as FlagOnCell),
      geometry: this.geometry, buffer: 'normal', wrapStatus: line.wrapped ? 'wrapped' : 'unwrapped', wrapPad: 0,
      finalized: true, uncertainFields: [...uncertain].sort(),
      cellOrigins: cells.filter(c => c.width !== 0).map(c => c.origin),
    });
  }
  private eraseInLine(line: DLine, from: number, to: number, at: number): void {
    this.padTo(line, to, at);
    for (let x = from; x < to; x++) line.cells[x] = this.blank(at);
    // Trailing blanks written by an erase are not "used" cells.
    while (line.cells.length && line.cells.at(-1)!.text === ' ' && line.cells.at(-1)!.style[0] === 0 && line.cells.at(-1)!.style[2] === -1
      && line.cells.at(-1)!.origin.kind === 'pipe') line.cells.pop();
    this.markLine(line, ['cursor', 'unsupported-sequence', 'geometry']);
  }
  private escByte(b: number, at: number): void {
    const e = this.esc!;
    if (e.kind === 'esc') {
      this.esc = null;
      switch (b) {
        case 0x5b: this.esc = { kind: 'csi', buf: [], start: e.start }; return;
        case 0x5d: this.esc = { kind: 'osc', buf: [], start: e.start }; return;
        case 0x50: case 0x5f: case 0x5e: case 0x58: case 0x6b: this.esc = { kind: 'str', buf: [], start: e.start }; return;
        case 0x28: case 0x29: case 0x2a: case 0x2b: this.esc = { kind: 'charset', buf: [], start: e.start }; return;
        case 0x37: this.save(); return;
        case 0x38: this.restore(); return;
        case 0x44: this.lineFeed(at); return;
        case 0x45: this.screen.cursor.x = 0; this.lineFeed(at); return;
        case 0x4d: { const s = this.screen; this.pendingWrap = false; if (s.cursor.y === this.top) this.scrollDown(1); else if (s.cursor.y > 0) s.cursor.y--; return; }
        case 0x63: this.reset(); return;
        case 0x3d: case 0x3e: case 0x5c: return;
        default: this.markAll('unsupported-sequence'); return;
      }
    }
    if (e.kind === 'charset') { this.esc = null; this.unknown.delete('charset'); return; }
    if (e.kind === 'osc' || e.kind === 'str') {
      if (b === 0x07 && e.kind === 'osc') { this.esc = null; return; }
      if (b === 0x5c && e.buf.at(-1) === 0x1b) { this.esc = null; return; }
      if (e.buf.length > 4096) { this.esc = null; this.markAll('unsupported-sequence'); return; }
      e.buf.push(b); return;
    }
    // CSI
    if (b >= 0x20 && b < 0x40) { if (e.buf.length > 64) { this.esc = null; this.markAll('unsupported-sequence'); return; } e.buf.push(b); return; }
    this.esc = null;
    if (b < 0x40 || b > 0x7e) { this.markAll('unsupported-sequence'); return; }
    this.csi(String.fromCharCode(...e.buf), b, at);
  }
  private csi(raw: string, final: number, at: number): void {
    const s = this.screen, cols = this.geometry.columns, rows = this.geometry.rows;
    const priv = /^[?<=>]/.test(raw) ? raw[0] : '';
    const body = priv ? raw.slice(1) : raw;
    if (/[^0-9;:]/.test(body)) { this.markAll('unsupported-sequence'); return; }
    const p = body === '' ? [] : body.split(';').map(x => x === '' ? 0 : Number(x.split(':')[0]));
    const n = (i: number, d = 1) => (p[i] ?? 0) || d;
    const clampY = (y: number) => Math.max(0, Math.min(rows - 1, y));
    const clampX = (x: number) => Math.max(0, Math.min(cols - 1, x));
    const f = String.fromCharCode(final);
    if (priv === '?') {
      if (f === 'h' || f === 'l') {
        const on = f === 'h';
        for (const mode of p) {
          if (mode === 1049 || mode === 1047 || mode === 47) this.switchBuffer(on, mode === 1049);
          else if (mode === 7) this.autowrap = on;
          // 25 cursor visibility, mouse, bracketed paste, focus: no cell effect.
        }
      }
      return;
    }
    if (priv) return; // DA2, xterm queries: no screen effect
    this.pendingWrap = f === 'm' ? this.pendingWrap : false;
    switch (f) {
      case 'A': s.cursor.y = Math.max(s.cursor.y >= this.top ? this.top : 0, s.cursor.y - n(0)); return;
      case 'B': case 'e': s.cursor.y = Math.min(s.cursor.y <= this.bottom ? this.bottom : rows - 1, s.cursor.y + n(0)); return;
      case 'C': case 'a': s.cursor.x = clampX(s.cursor.x + n(0)); return;
      case 'D': s.cursor.x = clampX(s.cursor.x - n(0)); return;
      case 'E': s.cursor.x = 0; s.cursor.y = clampY(s.cursor.y + n(0)); return;
      case 'F': s.cursor.x = 0; s.cursor.y = clampY(s.cursor.y - n(0)); return;
      case 'G': case '`': s.cursor.x = clampX(n(0) - 1); return;
      case 'd': s.cursor.y = clampY(n(0) - 1); this.unknown.delete('cursor'); return;
      case 'H': case 'f': s.cursor.y = clampY(n(0) - 1); s.cursor.x = clampX(n(1) - 1); this.unknown.delete('cursor'); return;
      case 'J': return this.eraseDisplay(p[0] ?? 0, at);
      case 'K': { const line = s.lines[s.cursor.y]!; const mode = p[0] ?? 0;
        if (mode === 0) this.eraseInLine(line, s.cursor.x, cols, at);
        else if (mode === 1) this.eraseInLine(line, 0, s.cursor.x + 1, at);
        else this.eraseInLine(line, 0, cols, at);
        return; }
      case 'X': this.eraseInLine(s.lines[s.cursor.y]!, s.cursor.x, Math.min(cols, s.cursor.x + n(0)), at); return;
      case 'P': { const line = s.lines[s.cursor.y]!; line.cells.splice(s.cursor.x, n(0)); this.markLine(line, ['cursor', 'unsupported-sequence']); return; }
      case '@': { const line = s.lines[s.cursor.y]!; this.padTo(line, s.cursor.x, at);
        line.cells.splice(s.cursor.x, 0, ...Array.from({ length: n(0) }, () => this.blank(at))); line.cells.length = Math.min(line.cells.length, cols);
        this.markLine(line, ['cursor', 'unsupported-sequence']); return; }
      case 'L': if (s.cursor.y >= this.top && s.cursor.y <= this.bottom) for (let i = 0; i < n(0); i++) { s.lines.splice(this.bottom, 1); s.lines.splice(s.cursor.y, 0, this.blankLine()); } return;
      case 'M': if (s.cursor.y >= this.top && s.cursor.y <= this.bottom) for (let i = 0; i < n(0); i++) { s.lines.splice(s.cursor.y, 1); s.lines.splice(this.bottom, 0, this.blankLine()); } return;
      case 'S': this.scrollUp(n(0), at); return;
      case 'T': this.scrollDown(n(0)); return;
      case 'm': return this.sgr(p, body);
      case 'r': { const t = n(0) - 1, bt = (p[1] ?? 0) ? p[1]! - 1 : rows - 1;
        if (t < bt && bt < rows) { this.top = t; this.bottom = bt; this.unknown.delete('margins'); this.unknown.delete('cursor'); s.cursor = { x: 0, y: 0 }; }
        return; }
      case 's': if (body === '') this.save(); return;
      case 'u': if (body === '') this.restore(); return;
      case 'b': this.markAll('unsupported-sequence'); return; // REP needs the previous graphic
      default: return; // n, c, t, q, h/l ANSI modes: no cell effect
    }
  }
  private sgr(p: number[], body: string): void {
    if (p.length === 0 || (p.length === 1 && p[0] === 0 && !body.includes(':'))) { this.pen = { ...DEFAULT_PEN }; this.unknown.delete('sgr'); return; }
    for (let i = 0; i < p.length; i++) {
      const v = p[i]!;
      if (v === 0) { this.pen = { ...DEFAULT_PEN }; this.unknown.delete('sgr'); }
      else if (v >= 1 && v <= 9) this.pen.style |= 1 << (v - 1);
      else if (v === 21) this.pen.style = (this.pen.style & ~8) | 512;
      else if (v === 22) this.pen.style &= ~3;
      else if (v === 23) this.pen.style &= ~4;
      else if (v === 24) this.pen.style &= ~(8 | 512);
      else if (v === 25) this.pen.style &= ~(16 | 32);
      else if (v === 27) this.pen.style &= ~64;
      else if (v === 28) this.pen.style &= ~128;
      else if (v === 29) this.pen.style &= ~256;
      else if (v === 39) this.pen.fg = -1;
      else if (v === 49) this.pen.bg = -1;
      else if (v >= 30 && v <= 37) this.pen.fg = v - 30;
      else if (v >= 40 && v <= 47) this.pen.bg = v - 40;
      else if (v >= 90 && v <= 97) this.pen.fg = v - 90 + 8;
      else if (v >= 100 && v <= 107) this.pen.bg = v - 100 + 8;
      else if (v === 38 || v === 48 || v === 58) {
        const mode = p[i + 1];
        if (mode === 5) { const c = p[i + 2] ?? 0; if (v === 38) this.pen.fg = c; else if (v === 48) this.pen.bg = c; i += 2; }
        else if (mode === 2) { const [r, g, bl] = [p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0]; const c = 256 + ((r << 16) | (g << 8) | bl);
          if (v === 38) this.pen.fg = c; else if (v === 48) this.pen.bg = c; i += 4; }
        else { this.markAll('unsupported-sequence'); return; }
      }
    }
  }
  private eraseDisplay(mode: number, at: number): void {
    const s = this.screen, cols = this.geometry.columns;
    if (mode === 3) return; // clear-history: committed rows are not tmux's to remove
    if (mode === 2) {
      if (!this.alt && this.scrollOnClear) {
        // tmux grid_view_clear_history: every line up to the last used one goes to history.
        let last = 0;
        s.lines.forEach((line, y) => { if (line.cells.length) last = y + 1; });
        for (let i = 0; i < last; i++) { const [gone] = s.lines.splice(0, 1); s.lines.push(this.blankLine()); this.emit(gone!, at, []); }
      }
      s.lines = s.lines.map(() => this.blankLine());
      return;
    }
    const y = s.cursor.y;
    if (mode === 0) { this.eraseInLine(s.lines[y]!, s.cursor.x, cols, at); for (let i = y + 1; i < s.lines.length; i++) s.lines[i] = this.blankLine(); }
    else if (mode === 1) { this.eraseInLine(s.lines[y]!, 0, s.cursor.x + 1, at); for (let i = 0; i < y; i++) s.lines[i] = this.blankLine(); }
  }
  private save(): void {
    this.screen.saved = { ...this.screen.cursor, pen: { ...this.pen }, unknown: this.unknown.has('cursor') };
    if (this.unknown.has('cursor')) this.unknown.add('savedCursor'); else this.unknown.delete('savedCursor');
  }
  private restore(): void {
    const saved = this.screen.saved;
    if (!saved || this.unknown.has('savedCursor')) { this.unknown.add('cursor'); return; }
    this.screen.cursor = { x: saved.x, y: saved.y }; this.pen = { ...saved.pen };
    if (saved.unknown) this.unknown.add('cursor'); else this.unknown.delete('cursor');
  }
  private switchBuffer(on: boolean, saveCursor: boolean): void {
    if (on && !this.alt) {
      if (saveCursor) this.save();
      this.alt = this.blankScreen(); this.alt.cursor = { ...this.normal.cursor };
    } else if (!on && this.alt) {
      this.alt = null; if (saveCursor) this.restore();
    }
  }
  private reset(): void {
    this.alt = null; this.normal = this.blankScreen(); this.pen = { ...DEFAULT_PEN };
    this.top = 0; this.bottom = this.geometry.rows - 1; this.autowrap = true; this.pendingWrap = false; this.unknown.clear();
  }
  /** The live screen as non-finalized rows (display only, never committed). */
  screenRows(): FlagOnStitchRow[] {
    return this.screen.lines.map((line, y) => ({
      origin: { kind: 'pipe', range: { epoch: this.epoch, start: this.offset, end: this.offset }, ordinal: -1 - y },
      cells: line.cells.filter(c => c.width !== 0).map(c => ({ text: c.text, width: c.width, style: c.style }) as FlagOnCell),
      geometry: this.geometry, buffer: this.alt ? 'alternate' : 'normal', wrapStatus: line.wrapped ? 'wrapped' : 'unwrapped',
      wrapPad: 0, finalized: false, uncertainFields: [...line.uncertain].sort(), cellOrigins: line.cells.filter(c => c.width !== 0).map(c => c.origin),
    }));
  }
  /** Visible verification (DESIGN §3.3): `visible` is tmux's own screen read
   * (`capture-pane -p -e -N` of the visible rows) with its cursor and scroll
   * region. When every cell, the cursor, the buffer and the region agree, the
   * parser provably reproduces the terminal: unknown fields are cleared and
   * every live row is proven. Any difference leaves the state unknown and is
   * reported, so the caller can keep withholding. */
  verifyVisible(visible: { rows: readonly (readonly FlagOnCell[])[]; cursor: { x: number; y: number }; alternate: boolean;
    regionTop: number; regionBottom: number; geometry: Geometry }): { verified: boolean; reason: string | null } {
    if (visible.geometry.columns !== this.geometry.columns || visible.geometry.rows !== this.geometry.rows) return { verified: false, reason: 'geometry' };
    if (visible.alternate !== !!this.alt) return { verified: false, reason: 'buffer' };
    if (this.pendingWrap ? false : (visible.cursor.x !== this.screen.cursor.x || visible.cursor.y !== this.screen.cursor.y)) return { verified: false, reason: 'cursor' };
    if (visible.regionTop !== this.top || visible.regionBottom !== this.bottom) return { verified: false, reason: 'margins' };
    const mine = this.screen.lines;
    for (let y = 0; y < this.geometry.rows; y++) {
      const want = [...(visible.rows[y] ?? [])];
      const have = (mine[y]?.cells ?? []).filter(c => c.width !== 0);
      const trim = (cells: { text: string; style: readonly number[] }[]) => {
        const out = [...cells]; while (out.length && out.at(-1)!.text === ' ' && out.at(-1)!.style[0] === 0 && (out.at(-1)!.style[2] ?? -1) === -1) out.pop(); return out;
      };
      const a = trim(have), c = trim(want);
      if (a.length !== c.length) return { verified: false, reason: `row ${y}` };
      for (let x = 0; x < a.length; x++) {
        const p = a[x]!, q = c[x]!;
        if (p.text !== q.text || (p.style[0] ?? 0) !== (q.style[0] ?? 0) || (p.style[1] ?? -1) !== (q.style[1] ?? -1) || (p.style[2] ?? -1) !== (q.style[2] ?? -1))
          return { verified: false, reason: `row ${y} cell ${x}` };
      }
    }
    this.clearProven();
    return { verified: true, reason: null };
  }
  /** The pen itself is not visible; a verified screen still leaves it as the
   * style the parser holds, which tmux just rendered identically. */
  private clearProven(): void {
    for (const field of ['cursor', 'margins', 'charset', 'pendingUtf8', 'pendingEscape', 'wrap', 'unsupported-sequence', 'geometry', 'sgr'] as const) this.unknown.delete(field);
    for (const line of this.screen.lines) line.uncertain.clear();
  }
  /** Geometry changed without a mapping: rows keep their cells but become unknown. */
  resize(geometry: Geometry): void {
    const resizeScreen = (s: Screen) => {
      while (s.lines.length > geometry.rows) { s.lines.shift(); }
      while (s.lines.length < geometry.rows) s.lines.push(this.blankLine());
      for (const line of s.lines) { line.cells.length = Math.min(line.cells.length, geometry.columns); line.uncertain.add('geometry'); }
      s.cursor = { x: Math.min(s.cursor.x, geometry.columns - 1), y: Math.min(s.cursor.y, geometry.rows - 1) };
    };
    this.geometry = geometry; resizeScreen(this.normal); if (this.alt) resizeScreen(this.alt);
    this.top = 0; this.bottom = geometry.rows - 1; this.unknown.add('geometry'); this.unknown.add('cursor');
  }
}
