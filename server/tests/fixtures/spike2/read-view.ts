import { ScratchLedger } from './scratch';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { prepared } from '../../../src/sqlite-history/ram-store';

/** Disposable spike adapter. The store's existing coordinator owns all grants.
 * Only encoded immutable SQL rows cross to the single read/match worker. */
export class ReadViewCoordinator {
  readonly scratch = new ScratchLedger();
  private gate = false;
  private active: string | null = null;
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  stats = { grants: 0, releases: 0, pages: 0, overlayBytesHigh: 0, openFence: 0, operations: {} as Record<string,number> };
  constructor(private store: any) {
    const snapshot = store.snapshot.bind(store);
    store.snapshot = () => this.gate ? null : snapshot();
  }
  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.worker = new Worker(new URL('./capture-worker.ts', import.meta.url));
    worker.on('message', ({ id, value, error }) => {
      const p = this.pending.get(id); if (!p) return;
      this.pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(value);
    });
    const fail = (error: Error) => { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); };
    worker.on('error', fail);
    worker.on('exit', code => { if (this.worker === worker) this.worker = null; fail(new Error(`read worker exited ${code}`)); });
    worker.unref(); return worker;
  }
  rpc(op: string, input: any): Promise<any> {
    this.stats.operations[op]=(this.stats.operations[op]??0)+1;
    const worker = this.ensureWorker(), id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); worker.postMessage({ id, op, input: op === 'begin' ? {...input, scratch:this.scratch.shared} : input }); });
  }
  async open(key: any, deadline: number, signal?: AbortSignal) {
    if (this.active) throw new Error('read-view-busy');
    if (signal?.aborted || performance.now() >= deadline) throw new Error('read-view-cancelled');
    this.store.owner();
    const t = this.store.token(key), no = this.store.ram.paneNo(key);
    const start = Math.max(this.store.ram.firstLineId(key), t.nextLineId - 5012);
    const token = Object.freeze({ ...t, paneKey: Object.freeze({ ...key }), requestId: randomUUID(),
      paneNo: no, start, end: t.nextLineId, deadline, wallDeadline: Date.now() + deadline - performance.now() });
    this.active = token.requestId; this.gate = true; this.stats.grants++;
    let closed = false;
    let releasePromise: Promise<void> | undefined;
    const release = () => releasePromise ??= (async () => {
      closed = true;
      try { await this.rpc('release', { requestId: token.requestId }); }
      finally {
        if (this.active === token.requestId) { this.active = null; this.gate = false; this.stats.releases++; this.scratch.set(2,0); }
        signal?.removeEventListener('abort', cancel); clearTimeout(timer);
      }
    })();
    const cancel = () => { void release().catch(() => {}); };
    const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      // Synchronous grant + COW encoded rows: append and ACK eviction cannot
      // mutate these values; the writer cannot start a post-grant snapshot.
      // Reserve encoded SQL/JS/IPC copies before materializing the overlay.
      const size:any = prepared(this.store.ram.db, 'SELECT coalesce(sum(length(cast(cells as blob))+length(cast(text as blob))+1024),0) n FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? AND revision>?').get(no,start,token.end,t.durableRevision);
      this.scratch.set(2, Number(size.n)*4);
      const overlay = prepared(this.store.ram.db, 'SELECT * FROM na_line WHERE pane_no=? AND line_id>=? AND line_id<? AND revision>? ORDER BY line_id')
        .all(no, start, token.end, t.durableRevision).map((r: any) => Object.freeze({ ...r }));
      const bytes = Buffer.byteLength(JSON.stringify(overlay));
      if (bytes > 8 * 1024 * 1024) throw new Error('read-view-overlay-budget');
      this.stats.overlayBytesHigh = Math.max(this.stats.overlayBytesHigh, bytes);
      const ack = await this.rpc('open', { file: this.store.file, token, overlay });
      if (closed || signal?.aborted || performance.now() >= deadline) throw new Error('read-view-cancelled');
      if (ack.requestId !== token.requestId || ack.fence < t.durableRevision || ack.fence > t.revision) throw new Error('read-view-fence');
      this.stats.openFence = ack.fence; this.gate = false;
      return { token, release, page: async (lo: number, hi: number) => {
        if (closed || signal?.aborted || performance.now() >= deadline) throw new Error('read-view-cancelled');
        if (lo < start || hi > token.end || hi < lo || hi - lo > 256) throw new Error('read-view-range');
        const page = await this.rpc('page', { requestId: token.requestId, lo, hi });
        if (closed || signal?.aborted) throw new Error('read-view-cancelled');
        this.stats.pages++; return page;
      } };
    } catch (error) { await release(); throw error; }
  }
  async close() {
    const worker = this.worker;
    if (worker) { await this.rpc('close', {}); this.worker = null; await worker.terminate(); }
    this.gate = false; this.active = null;
  }
}
