import {
  PipeVtWorker,
  type PipeVtAssets,
  type PipeVtCursor,
  type PipeVtFault,
  type PipeVtRow,
  type PipeVtUpdate,
} from "./pipe-vt-worker";

/**
 * NEWARCH L2-P collector: one pane's binary pipe bytes -> VT worker ->
 * `onScroll` / `onFrame` / `onFault`, independent of how many viewers exist.
 *
 * The port shapes below are the local copy of PLAN §7 (frozen by the plan,
 * owned by L1); this file does not import another lane's types.
 *
 * Ordering guarantees:
 * - bytes are never decoded here; each chunk gets a receiveSeq and goes to
 *   the worker verbatim;
 * - every scrolled row reaches `onScroll` before the tray ring evicts
 *   anything to make room for it, and before the frame of the same update;
 * - `receiveSeq` is our receive order, not a tmux offset or source fence.
 */

export type PaneKey = { serverIdentity: string; paneId: string; birthGeneration: number };

export type PipeScrollEvent = {
  paneKey: PaneKey;
  sourceEpoch: number;
  geometryGeneration: number;
  physicalRow: PipeVtRow;
  softWrap: boolean;
  /** Last cell is wrap padding before a wide glyph (not content). */
  wrapPad: boolean;
  receiveSeq: number;
};

export type PipeFrameEvent = {
  cells: {
    full: boolean;
    cols: number;
    rows: number;
    dirty: Record<number, PipeVtRow>;
    softWrap: Record<number, boolean>;
    wrapPad: number[];
  };
  cursor: PipeVtCursor;
  kind: "normal" | "alternate";
  geometryGeneration: number;
  receiveSeq: number;
};

export type PipeFaultEvent = {
  kind: PipeVtFault["kind"] | "parser-backlog" | "closed";
  at: number;
  message?: string;
};

export interface PipeCollectorPorts {
  onScroll(event: PipeScrollEvent): void;
  onFrame(event: PipeFrameEvent): void;
  onFault(event: PipeFaultEvent): void;
}

export type PipeCollectorHealth = "starting" | "ok" | "degraded" | "broken" | "closed";

export type PipeLatencySummary = {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
};

export type PipeHistoryCollectorOptions = {
  paneKey: PaneKey;
  sourceEpoch: number;
  cols: number;
  rows: number;
  ports: PipeCollectorPorts;
  /** Tray ring of scrolled physical rows kept in memory (PLAN §3: 500). */
  ringRows?: number;
  /** Bytes sent to the parser but not yet answered (PLAN §3: 1 MiB/pane). */
  queueLimitBytes?: number;
  /** Test observability: called when the ring drops its oldest row. */
  onEvict?: (event: PipeScrollEvent) => void;
  assets?: PipeVtAssets;
  python?: string;
  nowNs?: () => bigint;
  now?: () => number;
  /** Keep per-seq latency samples (bounded) for measurement. */
  latencySampleLimit?: number;
};

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

export class PipeHistoryCollector {
  readonly paneKey: PaneKey;
  private sourceEpoch: number;
  private geometryGeneration = 0;
  private receiveSeq = 0;
  private ackedSeq = 0;
  private inflight: Array<{ seq: number; bytes: number; at: bigint }> = [];
  private inflightBytes = 0;
  private readonly ring: PipeScrollEvent[] = [];
  private ringStart = 0;
  private readonly ringRows: number;
  private readonly queueLimit: number;
  private readonly worker: PipeVtWorker;
  private readonly nowNs: () => bigint;
  private readonly now: () => number;
  private drainWaiters: Array<() => void> = [];
  private latencyMs: number[] = [];
  private readonly latencyLimit: number;
  private healthState: PipeCollectorHealth = "starting";
  private scrollCount = 0;
  private frameCount = 0;
  private workerParseNs = 0;
  private workerEncodeNs = 0;
  private hostHandleNs = 0n;

  constructor(private readonly options: PipeHistoryCollectorOptions) {
    this.paneKey = options.paneKey;
    this.sourceEpoch = options.sourceEpoch;
    this.ringRows = options.ringRows ?? 500;
    this.queueLimit = options.queueLimitBytes ?? 1024 * 1024;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    this.now = options.now ?? Date.now;
    this.latencyLimit = options.latencySampleLimit ?? 1_000_000;
    this.worker = new PipeVtWorker({
      cols: options.cols,
      rows: options.rows,
      assets: options.assets,
      python: options.python,
      now: this.now,
      onUpdate: (update) => this.onUpdate(update),
      onFault: (fault) => this.fault(fault.kind, fault.message, "broken"),
    });
  }

  async start(): Promise<void> {
    await this.worker.start();
    if (this.healthState === "starting") this.healthState = "ok";
  }

  get workerPid(): number | null {
    return this.worker.pid;
  }

  health(): PipeCollectorHealth {
    return this.healthState;
  }

  /**
   * Accept raw pipe bytes. Returns false while the parser backlog is over
   * its limit: the caller should await `drained()` before reading more.
   * Nothing is dropped either way.
   */
  ingest(bytes: Uint8Array, receivedAtNs: bigint = this.nowNs()): boolean {
    if (this.healthState === "closed") return false;
    const seq = ++this.receiveSeq;
    this.inflight.push({ seq, bytes: bytes.byteLength, at: receivedAtNs });
    this.inflightBytes += bytes.byteLength;
    this.worker.feed(seq, bytes);
    if (this.inflightBytes > this.queueLimit) {
      if (this.healthState === "ok") {
        this.fault("parser-backlog", `parser backlog ${this.inflightBytes} bytes > ${this.queueLimit}`, "degraded");
      }
      return false;
    }
    return true;
  }

  drained(): Promise<void> {
    if (this.inflightBytes <= this.queueLimit) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Geometry changed: new generation; the worker reflows and re-sends. */
  resize(cols: number, rows: number): number {
    this.geometryGeneration += 1;
    this.worker.resize(cols, rows, this.geometryGeneration);
    return this.geometryGeneration;
  }

  /** Continuity broke (pipe gap, restart): later rows belong to a new epoch. */
  beginSourceEpoch(epoch: number): void {
    if (epoch <= this.sourceEpoch) throw new Error(`source epoch must increase (${this.sourceEpoch} -> ${epoch})`);
    this.sourceEpoch = epoch;
  }

  currentSourceEpoch(): number {
    return this.sourceEpoch;
  }

  currentGeometryGeneration(): number {
    return this.geometryGeneration;
  }

  requestFullFrame(): void {
    this.worker.requestFull(this.receiveSeq);
  }

  /** Rows still held by the tray ring, oldest first. */
  ringSnapshot(): PipeScrollEvent[] {
    return this.ring.slice(this.ringStart);
  }

  stats() {
    const sorted = [...this.latencyMs].sort((a, b) => a - b);
    const latency: PipeLatencySummary = {
      samples: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
    };
    return {
      receiveSeq: this.receiveSeq,
      ackedSeq: this.ackedSeq,
      inflightBytes: this.inflightBytes,
      scrolls: this.scrollCount,
      frames: this.frameCount,
      workerParseMs: this.workerParseNs / 1e6,
      workerEncodeMs: this.workerEncodeNs / 1e6,
      hostHandleMs: Number(this.hostHandleNs) / 1e6,
      latency,
    };
  }

  resetLatency(): void {
    this.latencyMs = [];
    this.workerParseNs = 0;
    this.workerEncodeNs = 0;
    this.hostHandleNs = 0n;
  }

  async close(): Promise<void> {
    if (this.healthState === "closed") return;
    await this.worker.close();
    this.healthState = "closed";
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }

  /** Fault injection for tests: the parser process dies abruptly. */
  killWorker(): void {
    this.worker.kill("SIGKILL");
  }

  private fault(kind: PipeFaultEvent["kind"], message: string | undefined, health: PipeCollectorHealth): void {
    if (this.healthState === "closed") return;
    if (health === "broken" || this.healthState !== "broken") this.healthState = health;
    this.options.ports.onFault({ kind, at: this.now(), message });
  }

  private pushRing(event: PipeScrollEvent): void {
    // The port sees the row first; only then may the tray make room.
    this.options.ports.onScroll(event);
    this.scrollCount += 1;
    this.ring.push(event);
    while (this.ring.length - this.ringStart > this.ringRows) {
      const evicted = this.ring[this.ringStart]!;
      this.ringStart += 1;
      this.options.onEvict?.(evicted);
    }
    if (this.ringStart > 4096 && this.ringStart * 2 > this.ring.length) {
      this.ring.splice(0, this.ringStart);
      this.ringStart = 0;
    }
  }

  private onUpdate(update: PipeVtUpdate): void {
    const began = this.nowNs();
    this.workerParseNs += update.parseNs;
    this.workerEncodeNs += update.encodeNs;
    for (const scroll of update.scrolls) {
      this.pushRing({
        paneKey: this.paneKey,
        sourceEpoch: this.sourceEpoch,
        geometryGeneration: scroll.gen,
        physicalRow: scroll.row,
        softWrap: scroll.wrap,
        wrapPad: scroll.pad,
        receiveSeq: scroll.seq ?? this.ackedSeq,
      });
    }
    const seqTo = update.seqTo ?? this.ackedSeq;
    const dirty: Record<number, PipeVtRow> = {};
    const softWrap: Record<number, boolean> = {};
    for (const [y, row] of Object.entries(update.frame.dirty)) dirty[Number(y)] = row;
    for (const [y, wrap] of Object.entries(update.frame.wraps)) softWrap[Number(y)] = wrap;
    this.options.ports.onFrame({
      cells: {
        full: update.frame.full,
        cols: update.frame.cols,
        rows: update.frame.rows,
        dirty,
        softWrap,
        wrapPad: update.frame.pads,
      },
      cursor: update.frame.cursor,
      kind: update.frame.kind,
      geometryGeneration: update.gen,
      receiveSeq: seqTo,
    });
    this.frameCount += 1;
    // Everything up to seqTo is now published: record receive->frame latency.
    const published = this.nowNs();
    while (this.inflight.length && this.inflight[0]!.seq <= seqTo) {
      const entry = this.inflight.shift()!;
      this.inflightBytes -= entry.bytes;
      if (this.latencyMs.length < this.latencyLimit) {
        this.latencyMs.push(Number(published - entry.at) / 1e6);
      }
    }
    if (seqTo > this.ackedSeq) this.ackedSeq = seqTo;
    this.hostHandleNs += published - began;
    if (this.inflightBytes <= this.queueLimit) {
      if (this.healthState === "degraded") this.healthState = "ok";
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
  }
}

/**
 * Read a binary stream (FIFO reader stdout) into a collector without ever
 * decoding it, pausing while the parser backlog is over its limit.
 */
export async function pumpBinaryStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  collector: Pick<PipeHistoryCollector, "ingest" | "drained">,
): Promise<number> {
  let total = 0;
  const iterable = Symbol.asyncIterator in (stream as object)
    ? (stream as AsyncIterable<Uint8Array>)
    : { [Symbol.asyncIterator]: () => (stream as ReadableStream<Uint8Array>).getReader() as unknown as AsyncIterator<Uint8Array> };
  for await (const chunk of iterable) {
    total += chunk.byteLength;
    if (!collector.ingest(chunk)) await collector.drained();
  }
  return total;
}
