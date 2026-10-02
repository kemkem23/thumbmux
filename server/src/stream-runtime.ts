/** Stream-first I lifecycle. This module never opens tmux or a legacy store. */
import { PipeVtPool, CheckpointCaptureVt, type CaptureVtRpc } from './pipe-vt-worker';
import { CaptureAdmission, StreamCaptureEngine, type CapturePorts } from './capture-engine';
import { StreamHistoryEngine } from './history-engine';
import { StreamDisplayEngine } from './display-engine';
import { STREAM_BUDGET as B, streamDigest, type StreamIdentity, type Geometry, type LiveFrame,
  type InputEvent, type Result, type VtCheckpoint, type ViewerRoute, type ReadRequest,
  type PageCursor, type CancelToken, type StreamObserver } from './stream-contract';

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
  get pid(): number | null { return this.lease?.pid ?? null; }
  async start(pool: PipeVtPool, geometry: Geometry, epoch: number): Promise<void> {
    this.lease = await pool.acquire();
    const socket = this.lease.socket;
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(Error('stream VT channel closed')));
    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 4 * B.vtBytesPerPane) { void this.retire(); return; }
      while (this.buffer.length >= 5) {
        const length = this.buffer.readUInt32BE(1);
        if (length > 4 * B.vtBytesPerPane) { void this.retire(); return; }
        if (this.buffer.length < length + 5) return;
        const kind = this.buffer.toString('ascii', 0, 1);
        const body = this.buffer.subarray(5, length + 5);
        this.buffer = this.buffer.subarray(length + 5);
        // A attaches an inert legacy channel, which emits its blank U once.
        // J replies alone own transactional state; unsolicited E remains fatal.
        if (kind === 'U' || kind === 'H') continue;
        const pending = this.pending;
        if (!pending || pending.kind !== kind) { this.fail(Error('unexpected stream RPC reply')); void this.retire(); return; }
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
    if (this.closed || !this.lease || this.pending) throw Error('stream RPC unavailable');
    if (body.length > 1024 * 1024) throw Error('stream RPC input budget');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { kind: reply, resolve, reject };
        timer = setTimeout(() => { void this.retire(); }, B.recoveryMs);
        this.lease!.socket.write(wire(kind, body), error => { if (error) this.fail(error); });
      });
    } finally { if (timer) clearTimeout(timer); }
  }
  async transaction(request: Parameters<CaptureVtRpc['transaction']>[0]): ReturnType<CaptureVtRpc['transaction']> {
    try { return { status: 'ok', value: await this.call('J', 'J', Buffer.from(JSON.stringify(request))) }; }
    catch (error) { return { status: 'error', code: 'io', message: String(error) }; }
  }
  retire(): Promise<void> {
    return this.retirement ??= (async () => {
      this.closed = true;
      this.fail(Error('stream RPC retired'));
      const lease = this.lease;
      if (lease) { lease.kill('SIGKILL'); await lease.done; lease.socket.destroy(); await lease.release(); }
      this.buffer = Buffer.alloc(0);
    })();
  }
  async close(): Promise<void> {
    if (this.pending) return this.retire();
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
  private viewerSlots = new Map<string, StreamRuntimePane>();
  constructor(readonly options: StreamRuntimeOptions) {
    this.pool = options.pool ?? new PipeVtPool({ python: options.python });
  }
  displayEngine(): StreamDisplayEngine {
    if (!this.sharedDisplay) {
      const lookup = (key: StreamIdentity['pane']) => {
        const pane = this.panes.get(JSON.stringify(key));
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
  async add(identity: StreamIdentity, geometry: Geometry, ports: StreamPanePorts, scrollOnClear = false): Promise<StreamRuntimePane> {
    const key = JSON.stringify(identity.pane);
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
        if (pane.frame.geometry.columns !== geometry.columns || pane.frame.geometry.rows !== geometry.rows) await pane.resize(geometry);
      } catch (error) { this.panes.delete(key); throw error; }
      return pane;
    } catch (error) { await rpc.close(); throw error; }
  }
  async remove(pane: StreamRuntimePane): Promise<void> {
    await pane.close(); this.panes.delete(JSON.stringify(pane.identity.pane));
  }
  async close(): Promise<void> {
    this.closing = true;
    // No finally-close: failed drain keeps H and its recovery evidence alive.
    for (const pane of this.panes.values()) await pane.close();
    if (this.history?.stats().ownedPendingBytes) throw Error('stream close refused: undurable pending');
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
      cancelOperation: async signal => { await Promise.all([this.ports.cancelOperation(signal), this.rpc.retire()]); }});
    this.capture.subscribe(this.identity.pane, frame => { this.frame = frame; this.identity = frame.identity; });
    this.display = this.runtime.displayEngine();
  }
  async recover(): Promise<void> {
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
      const self = this;
      async function* inputs(): AsyncIterable<InputEvent> {
        while (true) {
          const next = await recovery.next(); if (next.done) return;
          const item = unwrap(next.value);
          if (item.kind === 'input') { self.sequence = item.event.position.packetSeq; yield item.event; }
        }
      }
      this.frame = unwrap(await this.capture.restore(cp, inputs()));
    } finally { await recovery.return?.(); }
  }
  /** Whole FIFO slice is owned until the promise resolves; never acknowledge a
   * partial slice as capacity-pressure (which would cause duplicate retry). */
  ingest(bytes: Uint8Array): Promise<void> {
    if (!this.accepting || bytes.length > 64 * 1024 || this.inputBytes) return Promise.reject(Error('stream input admission'));
    this.inputBytes = bytes.length;
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
    this.chain = this.chain.then(() => this.event({kind: 'resize', geometry}));
    await this.chain;
    for (const route of this.viewers.values()) await this.display.detach(route, 'geometry changed');
    for (const id of this.viewers.keys()) this.runtime.releaseViewer(id);
    this.viewers.clear();
  }
  async attach(route: ViewerRoute, onFrame: (frame: LiveFrame) => void): Promise<Result<LiveFrame>> {
    if (!this.runtime.reserveViewer(route.viewerId, this)) return {status:'busy',reason:'pressure',retryAfterMs:20};
    this.viewers.set(route.viewerId, route);
    const result = await this.display.attach(route, frame => {
      try { onFrame(frame); } catch (error) { void this.detach(route.viewerId); throw error; }
    });
    if (result.status !== 'ok') { await this.display.detach(route, 'attach failed'); this.viewers.delete(route.viewerId); this.runtime.releaseViewer(route.viewerId); }
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
  async close(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    await this.drain();
    for (const id of [...this.viewers.keys()]) await this.detach(id);
    await this.rpc.close(); this.closed = true;
  }
  stats() { return {inputBytes: this.inputBytes, packetSeq: this.sequence, frame: this.frame,
    workerPid: this.rpc.pid, display: this.display.stats(), history: this.runtime.history!.stats()}; }
}
