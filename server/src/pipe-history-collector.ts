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
  paneKey: PaneKey;
  sourceEpoch: number;
  cells: {
    full: boolean;
    cols: number;
    rows: number;
    /**
     * Apply first: move the previous screen up by this many rows (the
     * scrolled-out rows already went to onScroll), then patch `dirty`.
     */
    shift: number;
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
  kind: PipeVtFault["kind"] | "parser-backlog" | "worker-restarted" | "history-cleared" | "closed" | "consumer-rejected" | "source-reset";
  paneKey?: PaneKey;
  sourceEpoch?: number;
  missingCount?: null;
  at: number;
  message?: string;
  /** Bytes whose parsing could not be acknowledged; not a guessed row count. */
  unacknowledgedBytes?: number;
  receiveSeqFrom?: number;
  receiveSeqTo?: number;
  lostRows?: "unknown";
};

export interface PipeCollectorPorts {
  onScroll(event: PipeScrollEvent): unknown;
  onFrame(event: PipeFrameEvent): unknown;
  onFault(event: PipeFaultEvent): unknown;
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
  /** Actual pane option; unknown clear policy raises a fault, never guessed. */
  scrollOnClear?: boolean;
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
  private upstreamEpoch: number;
  private geometryGeneration = 0;
  private receiveSeq = 0;
  private ackedSeq = 0;
  private inflight: Array<{ seq: number; bytes: number; at: bigint }> = [];
  private inflightBytes = 0;
  private readonly ring: PipeScrollEvent[] = [];
  private ringStart = 0;
  private readonly ringRows: number;
  private readonly queueLimit: number;
  private worker: PipeVtWorker;
  private recovering: Promise<void> | null = null;
  private recoveryAttempts = 0;
  private closing = false;
  private cols: number;
  private rows: number;
  private scrollOnClear: boolean | undefined;
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
  private policyUnverified = false;

  constructor(private readonly options: PipeHistoryCollectorOptions) {
    this.paneKey = options.paneKey;
    this.sourceEpoch = options.sourceEpoch;
    this.upstreamEpoch = options.sourceEpoch;
    this.ringRows = options.ringRows ?? 500;
    this.queueLimit = options.queueLimitBytes ?? 1024 * 1024;
    this.nowNs = options.nowNs ?? (() => process.hrtime.bigint());
    this.now = options.now ?? Date.now;
    this.latencyLimit = options.latencySampleLimit ?? 1_000_000;
    this.cols = options.cols;
    this.rows = options.rows;
    this.scrollOnClear = options.scrollOnClear;
    this.worker = this.makeWorker();
  }

  private makeWorker(): PipeVtWorker {
    return new PipeVtWorker({
      sourceEpoch: this.sourceEpoch,
      onHistoryClear: ({ seq, epoch }) => {
        this.ring.length = 0;
        this.ringStart = 0;
        this.notifyFault({ kind: "history-cleared", at: this.now(),
          message: `CSI 3J cleared history in source epoch ${epoch}; visible screen retained`,
          receiveSeqFrom: seq, receiveSeqTo: seq });
      },
      cols: this.cols,
      rows: this.rows,
      assets: this.options.assets,
      python: this.options.python,
      now: this.now,
      onUpdate: (update) => this.onUpdate(update),
      onFault: (fault) => {
        if (fault.kind === "clear-policy-unknown") {
          this.policyUnverified = true;
          this.fault(fault.kind, fault.message, "degraded");
        } else this.fault(fault.kind, fault.message, "broken");
      },
    });
  }

  async start(): Promise<void> {
    await this.worker.start();
    if (this.scrollOnClear !== undefined) this.worker.setScrollOnClear(this.scrollOnClear);
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
   * One delivery may exceed the watermark by at most 64 KiB. A caller that
   * ignores drain, or sends an oversized delivery, gets an explicit loss issue.
   */
  ingest(bytes: Uint8Array, receivedAtNs: bigint = this.nowNs()): boolean {
    if (this.healthState === "closed") return false;
    if (this.healthState === "broken") {
      const seq = ++this.receiveSeq;
      this.notifyFault({ kind: "worker-exit", at: this.now(), message: "bytes rejected by dead parser", unacknowledgedBytes: bytes.byteLength, receiveSeqFrom: seq, receiveSeqTo: seq, lostRows: "unknown" });
      return false;
    }
    if (this.inflightBytes > this.queueLimit || bytes.byteLength > this.queueLimit + 64 * 1024) {
      const seq = ++this.receiveSeq;
      this.healthState = "degraded";
      this.notifyFault({ kind: "parser-backlog", at: this.now(), message: "input rejected at bounded parser admission; drain before retrying new bytes",
        unacknowledgedBytes: bytes.byteLength, receiveSeqFrom: seq, receiveSeqTo: seq, lostRows: "unknown" });
      return false;
    }
    const seq = ++this.receiveSeq;
    this.inflight.push({ seq, bytes: bytes.byteLength, at: receivedAtNs });
    this.inflightBytes += bytes.byteLength;
    if (!this.worker.feed(seq, bytes, this.sourceEpoch)) {
      this.fault("worker-exit", "parser rejected input", "broken");
      return false;
    }
    if (this.inflightBytes > this.queueLimit) {
      if (this.healthState === "ok") {
        this.fault("parser-backlog", `parser backlog ${this.inflightBytes} bytes > ${this.queueLimit}`, "degraded");
      }
      return false;
    }
    return true;
  }

  drained(): Promise<void> {
    if (this.healthState === "broken" || this.healthState === "closed" || this.inflightBytes <= this.queueLimit) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Geometry changed: new generation; the worker reflows and re-sends. */
  resize(cols: number, rows: number): number {
    this.cols = cols;
    this.rows = rows;
    this.geometryGeneration += 1;
    this.worker.resize(cols, rows, this.geometryGeneration);
    return this.geometryGeneration;
  }

  /** Continuity broke (pipe gap, restart): later rows belong to a new epoch. */
  beginSourceEpoch(epoch: number): void {
    if (epoch <= this.upstreamEpoch) throw new Error(`upstream epoch must increase (${this.upstreamEpoch} -> ${epoch})`);
    this.upstreamEpoch = epoch;
    // Parser recovery and upstream pipe restarts are independent breaks.
    this.sourceEpoch = Math.max(this.sourceEpoch + 1, epoch);
    this.notifyFault({ kind: "source-reset", at: this.now(), message: "owner requested parser reset; external reset ordering remains unverified",
      receiveSeqFrom: this.ackedSeq + 1, receiveSeqTo: this.receiveSeq, lostRows: "unknown" });
    if (!this.worker.reset(this.sourceEpoch)) this.fault("worker-error", "parser reset admission failed", "broken");
  }

  setScrollOnClear(enabled: boolean): void {
    this.scrollOnClear = enabled;
    if (!this.worker.setScrollOnClear(enabled)) this.fault("worker-error", "clear policy admission failed", "broken");
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

  /** Raw receive->frame samples in ms, for pooled percentiles across panes. */
  latencySamples(): readonly number[] {
    return this.latencyMs;
  }

  resetLatency(): void {
    this.latencyMs = [];
    this.workerParseNs = 0;
    this.workerEncodeNs = 0;
    this.hostHandleNs = 0n;
  }

  async close(): Promise<void> {
    if (this.healthState === "closed") return;
    this.closing = true;
    await this.recovering;
    await this.worker.close();
    this.healthState = "closed";
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }

  /** Fault injection for tests: the parser process dies abruptly. */
  killWorker(): void {
    this.worker.kill("SIGKILL");
  }

  /** Consumer faults cannot interrupt cleanup, waiter release or recovery. */
  private notifyFault(event: PipeFaultEvent): void {
    const contextual = { paneKey: this.paneKey, sourceEpoch: this.sourceEpoch,
      ...(event.lostRows === "unknown" ? { missingCount: null } : {}), ...event };
    try { Promise.resolve(this.options.ports.onFault(contextual)).catch(error => console.error("[pipe-history] onFault callback failed:", error)); }
    catch (error) { console.error("[pipe-history] onFault callback failed:", error); }
  }

  private fault(kind: PipeFaultEvent["kind"], message: string | undefined, health: PipeCollectorHealth): void {
    if (this.healthState === "closed") return;
    if (health === "broken" || this.healthState !== "broken") this.healthState = health;
    const loss = health === "broken" || kind === "clear-policy-unknown" ? {
      unacknowledgedBytes: this.inflightBytes,
      receiveSeqFrom: this.ackedSeq + 1,
      receiveSeqTo: this.receiveSeq,
      lostRows: "unknown" as const,
    } : {};
    if (health === "broken") {
      this.inflight = [];
      this.inflightBytes = 0;
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
    this.notifyFault({ kind, at: this.now(), message, ...loss });
    if (health === "broken" && !this.closing && !this.recovering && kind !== "vendor-hash" && this.recoveryAttempts < 3) {
      // Defer until the current exit/input callback has finished. No waiter
      // depends on recovery completing; rejected bytes remain explicit faults.
      this.recoveryAttempts++;
      this.recovering = Promise.resolve().then(async () => {
        await this.worker.close();
        if (this.closing) return;
        this.sourceEpoch++;
        this.worker = this.makeWorker();
        await this.worker.start();
        if (this.scrollOnClear !== undefined) this.worker.setScrollOnClear(this.scrollOnClear);
        this.worker.resize(this.cols, this.rows, this.geometryGeneration);
        this.healthState = this.policyUnverified ? "degraded" : "ok";
        this.notifyFault({ kind: "worker-restarted", at: this.now(), message: `parser respawned; source epoch ${this.sourceEpoch}; calibration required` });
      }).catch((error) => {
        this.healthState = "broken";
        this.notifyFault({ kind: "spawn", at: this.now(), message: String(error), lostRows: "unknown" });
      }).finally(() => { this.recovering = null; });
    }
  }

  private async pushRing(event: PipeScrollEvent): Promise<void> {
    // The port sees the row first; only then may the tray make room.
    await this.options.ports.onScroll(event);
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

  private async onUpdate(update: PipeVtUpdate): Promise<void> {
    if (this.healthState === "broken" || this.healthState === "closed") return;
    const began = this.nowNs();
    this.workerParseNs += update.parseNs;
    this.workerEncodeNs += update.encodeNs;
    try {
    for (const scroll of update.scrolls) {
      await this.pushRing({
        paneKey: this.paneKey,
        sourceEpoch: scroll.epoch,
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
    await this.options.ports.onFrame({
      paneKey: this.paneKey,
      sourceEpoch: update.epoch,
      cells: {
        full: update.frame.full,
        shift: update.frame.shift,
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
    // A parsed input acknowledgment, not process readiness, proves recovery.
    if (seqTo > this.ackedSeq) {
      this.ackedSeq = seqTo;
      this.recoveryAttempts = 0;
    }
    this.hostHandleNs += published - began;
    if (this.inflightBytes <= this.queueLimit) {
      if (this.scrollOnClear !== undefined && update.scrollOnClear === this.scrollOnClear) this.policyUnverified = false;
      if (this.healthState === "degraded" && !this.policyUnverified) this.healthState = "ok";
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
    } catch (error) {
      this.fault("consumer-rejected", `scroll/frame receipt rejected: ${String(error)}`, "broken");
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
    : { async *[Symbol.asyncIterator]() {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) break;
          yield value.value;
        }
      } finally { reader.releaseLock(); }
    } };
  for await (const chunk of iterable) {
    total += chunk.byteLength;
    if (!collector.ingest(chunk)) await collector.drained();
  }
  return total;
}
