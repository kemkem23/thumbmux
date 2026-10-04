import { closeSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { matchHistoryRows, rowKey, type CapturedRow, type HistoryRow, type MatchScope } from './matcher';

/** One instance belongs to the host, not to a pane. Admission precedes any
 * capture/batch creation. The caller owns it through commit AND hot sync. */
export class FullPermit {
  active = 0; highWater = 0; maxQueued = 0;
  private queue: { pane: string; start(): void }[] = [];
  private waiting = new Set<string>();
  private metrics = {requested:0,started:0,completed:0,cancelled:0,deadlineMisses:0,queueDeadlineMisses:0,waitCount:0,waitSumMs:0,waitMaxMs:0,serviceSumMs:0,serviceMaxMs:0};
  private errors: Record<string,number> = {};
  failure(error: unknown) { const key=String(error).slice(0,120); const label=key in this.errors || Object.keys(this.errors).length<24 ? key : 'other'; this.errors[label]=(this.errors[label]??0)+1; }
  get stats() { return {active:this.active,queued:this.queue.length,highWater:this.highWater,maxQueued:this.maxQueued,...this.metrics,errors:{...this.errors}}; }
  async run<T>(pane: string, signal: AbortSignal, deadline: number, job: () => Promise<T>): Promise<T> {
    const enqueued=performance.now(); this.metrics.requested++;
    if (signal.aborted || performance.now() >= deadline) {this.metrics.cancelled++;this.metrics.deadlineMisses++;throw new Error('capture deadline exceeded');}
    if (this.waiting.has(pane) || this.queue.length >= 21) throw new Error('capture queue busy');
    this.waiting.add(pane);
    try {
      await new Promise<void>((resolve, reject) => {
        let granted = false;
        const remove = () => { const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1); };
        const cancel = () => { if (granted) return; remove(); clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new Error('capture deadline exceeded')); };
        const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
        const item = { pane, start: () => {
          if (signal.aborted || performance.now() >= deadline) { cancel(); this.next(); return; }
          granted = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
          this.metrics.started++;
          this.active++; this.highWater = Math.max(this.highWater, this.active); resolve();
        } };
        signal.addEventListener('abort', cancel, { once: true });
        if (this.active) { this.queue.push(item); this.maxQueued = Math.max(this.maxQueued, this.queue.length); }
        else item.start();
      });
    } catch (error) { this.waiting.delete(pane); this.metrics.cancelled++; this.metrics.queueDeadlineMisses++;this.metrics.deadlineMisses++;
      const wait=performance.now()-enqueued;this.metrics.waitCount++;this.metrics.waitSumMs+=wait;this.metrics.waitMaxMs=Math.max(this.metrics.waitMaxMs,wait);throw error; }
    const started=performance.now(), wait=started-enqueued;
    this.metrics.waitCount++;this.metrics.waitSumMs+=wait;this.metrics.waitMaxMs=Math.max(this.metrics.waitMaxMs,wait);
    try {
      if (signal.aborted || performance.now() >= deadline) throw new Error('capture deadline exceeded');
      const result=await job();
      if(signal.aborted || performance.now()>=deadline){this.metrics.cancelled++;this.metrics.deadlineMisses++;}
      else this.metrics.completed++;
      return result;
    } catch(error){this.metrics.cancelled++; if(signal.aborted || performance.now()>=deadline)this.metrics.deadlineMisses++;this.failure(error);throw error;}
    finally { const service=performance.now()-started;this.metrics.serviceSumMs+=service;this.metrics.serviceMaxMs=Math.max(this.metrics.serviceMaxMs,service);this.active--; this.waiting.delete(pane); this.next(); }
  }
  private next() { if (!this.active) this.queue.shift()?.start(); }
}

/** Exact disk-backed token registry, intended to live in the read/match worker.
 * Hash is a lookup accelerator only. Buckets hold offsets, never decoded rows.
 * Colliding candidates are compared using the canonical complete cell key.
 * Scratch is bounded to two encoded rows plus O(horizon) integer descriptors.
 * This is diagnostic spool, NOT the persistent history or its read fence. */
export class ExactRowTokens {
  private fd: number; private bytes = 0;
  private entries: { offset: number; length: number }[] = [];
  private buckets = new Map<string, number[]>();
  constructor(readonly path: string, readonly byteLimit = 128 * 1024 * 1024,
    private hash: (value: string) => string = value => createHash('sha256').update(value).digest('hex')) {
    this.fd = openSync(path, 'wx+', 0o600);
  }
  intern(row: CapturedRow): number {
    const exact = rowKey(row);
    const data = Buffer.from(exact);
    if (data.byteLength > 1024 * 1024) throw new Error('exact row byte budget exceeded');
    const key = this.hash(exact), bucket = this.buckets.get(key) ?? [];
    for (const id of bucket) {
      const entry = this.entries[id - 1]!;
      if (entry.length !== data.byteLength) continue;
      const other = Buffer.alloc(entry.length);
      if (readSync(this.fd, other, 0, other.length, entry.offset) !== other.length) throw new Error('short exact spool read');
      if (other.equals(data)) return id;
    }
    if (this.entries.length >= 10024 || this.bytes + data.length > this.byteLimit) throw new Error('exact spool budget exceeded');
    let at = 0;
    while (at < data.length) {
      const n = writeSync(this.fd, data, at, data.length - at, this.bytes + at);
      if (!n) throw new Error('short exact spool write');
      at += n;
    }
    this.entries.push({ offset: this.bytes, length: data.length }); this.bytes += data.length;
    const id = this.entries.length; bucket.push(id); this.buckets.set(key, bucket); return id;
  }
  get stats() { return { rows: this.entries.length, diskBytes: this.bytes }; }
  close() { if (this.fd < 0) return; closeSync(this.fd); this.fd = -1; unlinkSync(this.path); }
}
const tokenCell = (token: number) => ({ grapheme: String(token), width: 1 as const, continuation: false, fg: 'default', bg: 'default', style: 0 });
/** Reuse the original matching algorithm on exact equivalence classes, not
 * hashes. Each class represents every cell field AND softWrap. No decoded
 * capture array is reconstructed for the old matcher. */
export function matchTokens(recent: readonly { lineId: number; sourceEpoch: number; geometryGeneration: number; token: number }[],
  captured: readonly number[], scope: MatchScope) {
  if (recent.length > 5012 || captured.length > 5012) throw new Error('matching horizon budget exceeded');
  const rows: HistoryRow[] = recent.map(r => ({ ...r, cells: [tokenCell(r.token)], softWrap: false }));
  return matchHistoryRows(rows, captured.map(token => ({ cells: [tokenCell(token)], softWrap: false })), scope);
}

export type ViewToken = Readonly<{ identity: string; revision: number; durable: number; head: number; start: number; end: number; deadline: number }>;
export type RevisionRow = { lineId: number; revision: number; exact: string; identity: string };
/** An explicit adapter seam. grant must run in the storage coordinator and
 * readerOpen must establish a real transaction by READING before its ACK.
 * A mock satisfying this interface is not evidence the current store does. */
export interface ViewPorts {
  grant(start: number, end: number): Promise<{ token: ViewToken; overlay: readonly RevisionRow[] }>;
  readerOpen(token: ViewToken): Promise<{ identity: string; fence: number }>;
  openAck(token: ViewToken, fence: number): Promise<void>;
  diskPage(token: ViewToken, start: number, end: number): Promise<readonly RevisionRow[]>;
  release(token: ViewToken): Promise<void>;
}
export async function withFrozenView<T>(ports: ViewPorts, start: number, end: number,
  use: (token: ViewToken, page: (start: number, end: number) => Promise<RevisionRow[]>) => Promise<T>): Promise<T> {
  const { token, overlay } = await ports.grant(start, end);
  try {
    if (token.start !== start || token.end !== end || end > token.head || end - start > 5012 || start < 0 || end < start
      || token.deadline <= performance.now()) throw new Error('invalid view grant');
    const frozen = overlay.map(r => Object.freeze({ ...r }));
    const opened = await ports.readerOpen(token);
    if (opened.identity !== token.identity || opened.fence < token.durable || opened.fence > token.revision) throw new Error('invalid disk fence');
    await ports.openAck(token, opened.fence);
    return await use(token, async (lo, hi) => {
      if (lo < start || hi > end || hi < lo || hi - lo > 256 || performance.now() >= token.deadline) throw new Error('view page bounds/deadline');
      const merged = new Map<number, RevisionRow>();
      for (const r of [...await ports.diskPage(token, lo, hi), ...frozen.filter(r => r.lineId >= lo && r.lineId < hi)]) {
        if (r.identity !== token.identity || r.lineId < lo || r.lineId >= hi || r.revision > token.revision) throw new Error('view row outside fence');
        const old = merged.get(r.lineId);
        if (old?.revision === r.revision && old.exact !== r.exact) throw new Error('equal revision integrity failure');
        if (!old || old.revision < r.revision) merged.set(r.lineId, r);
      }
      const rows = [...merged.values()].sort((a, b) => a.lineId - b.lineId);
      if (rows.length !== hi - lo || rows.some((r, i) => r.lineId !== lo + i)) throw new Error('view gap is not EOF');
      return rows;
    });
  } finally { await ports.release(token); }
}

/** Sequential repair; immediately synchronize EVERY committed prefix before
 * attempting the next chunk. The store must expose the receipt per chunk.
 * onSyncFailure records a blocking descriptor; no screen/anchor on failure. */
export async function repairPrefix<T>(chunks: readonly T[][], ports: {
  identity(): string; expectedIdentity: string;
  commit(chunk: readonly T[], index: number): Promise<{ revision: number; ids: readonly number[] }>;
  sync(chunk: readonly T[], receipt: { revision: number; ids: readonly number[] }): Promise<void>;
  onSyncFailure(receipt: { revision: number; ids: readonly number[] }): void;
  finish(): Promise<void>;
}) {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunk.length > 256 || ports.identity() !== ports.expectedIdentity) throw new Error('repair bounds/identity changed');
    const receipt = await ports.commit(chunk, i);
    try { await ports.sync(chunk, receipt); } catch (error) { ports.onSyncFailure(receipt); throw error; }
    if (ports.identity() !== ports.expectedIdentity) throw new Error('repair identity changed after commit');
  }
  await ports.finish();
}

/** Bounded stdout consumer; awaited callbacks provide IPC backpressure.
 * Run this on the read/match worker, never on the publish loop. */
export async function consumeCaptureStream(stream: ReadableStream<Uint8Array>, path: string,
  signal: AbortSignal, onBytes: (bytes: Uint8Array) => Promise<void>, maxBytes = 8 * 1024 * 1024) {
  const fd = openSync(path, 'wx', 0o600), reader = stream.getReader(); let bytes = 0;
  const abort = () => { void reader.cancel(new Error('capture aborted')).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('capture aborted');
      const part = await reader.read();
      if (signal.aborted) throw new Error('capture aborted');
      if (part.done) break;
      for (let at = 0; at < part.value.length; at += 65536) {
        const chunk = part.value.subarray(at, at + 65536);
        if (bytes + chunk.length > maxBytes) throw new Error('raw spool budget exceeded');
        let written = 0;
        while (written < chunk.length) {
          const n = writeSync(fd, chunk, written, chunk.length - written, bytes + written);
          if (!n) throw new Error('short raw spool write');
          written += n;
        }
        bytes += chunk.length;
        await onBytes(chunk);
      }
    }
    return { bytes };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock(); closeSync(fd); unlinkSync(path);
  }
}
