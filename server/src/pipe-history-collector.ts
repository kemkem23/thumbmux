import {
  PipeVtWorker,
  type PipeVtPool,
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
 *
 * Consumer contract (review 2 m1, m4, M1):
 * - `onFrame` carries a DELTA (`shift` then `dirty`), not a full screen.
 *   Under capacity pressure the very same frame object is offered again,
 *   unchanged. A consumer must apply a frame atomically and only when it
 *   answers "accepted"; applying it and then refusing would apply `shift`
 *   twice on the re-offer.
 * - "The source is quiet" must be judged from the RECEIVE counter,
 *   `stats().receiveSeq` (bytes taken off the pipe), read before and after a
 *   capture. A frame's `receiveSeq` is the last PARSED seq; bytes received
 *   but still in the parser are invisible to it.
 * - Capacity pressure (`isCapacityPressure`) is transient: the event is
 *   offered again until accepted. Oversize (`isOversize`: `ingest-oversize`,
 *   legacy `ingest-capacity`) is permanent: the event is offered once,
 *   dropped, and declared by exactly one `consumer-oversize` fault.
 */

export type PaneKey = { serverIdentity: string; paneId: string; birthGeneration: number };

export type PipeScrollEvent = {
  /** Additive v1 event identity; absent on legacy worker output. */
  packetEpoch?: number;
  packetSeq?: number | null;
  scrollOrdinal?: number | null;
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
  kind: PipeVtFault["kind"] | "parser-backlog" | "worker-restarted" | "history-cleared" | "closed" | "consumer-rejected" | "source-reset"
    | "consumer-pressure" | "consumer-pressure-cleared" | "consumer-oversize";
  paneKey?: PaneKey;
  sourceEpoch?: number;
  /** null = unknown; a number only on `consumer-oversize` of a scroll (1). */
  missingCount?: number | null;
  at: number;
  message?: string;
  /** Bytes whose parsing could not be acknowledged; not a guessed row count. */
  unacknowledgedBytes?: number;
  receiveSeqFrom?: number;
  receiveSeqTo?: number;
  /** "unknown", or the exact count of a declared drop (`consumer-oversize`). */
  lostRows?: "unknown" | number;
  /** `consumer-oversize` only: which event the consumer can never admit. */
  droppedEvent?: "scroll" | "frame";
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

export type PipeCollectorDrainReceipt = {
  lastAdmittedSequence: number;
  lastAckedSequence: number;
  /** Filled by the runtime/store adapter, which owns these revision spaces. */
  ramRevision: number | null;
  durableRevision: number | null;
  issues: string[];
  unknownTail: boolean;
};

export type PipeHistoryCollectorOptions = {
  pool?: PipeVtPool;
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
  /** Bound for the worker's orderly close and output drain (default 5 s). */
  closeTimeoutMs?: number;
  /** First retry delay after a capacity-pressure receipt; doubles to 100 ms. */
  pressureRetryMs?: number;
};

/**
 * A consumer answer meaning "full for now, nothing was kept": the store's
 * `{ accepted: false, reason: "capacity-pressure" }` receipt, or an error with
 * that reason (or that word in its message) from a store that still throws.
 * It is backpressure, never a parser fault: the same event is offered again.
 */
export function isCapacityPressure(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const answer = value as { reason?: unknown; message?: unknown };
  if (answer.reason === "capacity-pressure") return true;
  return value instanceof Error && /\bcapacity-pressure\b/.test(String(answer.message));
}

/**
 * A consumer answer meaning "this one event can never fit, even in an idle
 * store" (review 2 M1): reason or error message `ingest-oversize` (I2 FIX2),
 * or the legacy `ingest-capacity` message of the FIX1 store. Waiting cannot
 * help, so the event is offered once, dropped, and declared with one
 * `consumer-oversize` marker; the pane keeps flowing and the parser stays.
 */
export function isOversize(value: unknown): boolean {
  if (value === null || typeof value !== "object" || isCapacityPressure(value)) return false;
  const answer = value as { reason?: unknown; message?: unknown };
  if (answer.reason === "ingest-oversize" || answer.reason === "ingest-capacity") return true;
  return value instanceof Error && /\b(?:ingest-oversize|ingest-capacity)\b/.test(String(answer.message));
}

/** A resolved receipt that explicitly refuses for a reason other than pressure. */
function isRefusal(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as { accepted?: unknown }).accepted === false
    && !isCapacityPressure(value) && !isOversize(value);
}

/** Receipt value of an event the consumer refused as oversize (dropped, declared). */


type BunPeek = { peek?: ((promise: unknown) => unknown) & { status?: (promise: unknown) => string } };

/**
 * A receipt that is already settled as "not accepted" (rejected, or fulfilled
 * with a capacity-pressure answer), read without awaiting it (Bun only).
 */
function refusedNow(receipt: PromiseLike<unknown>): boolean {
  const peek = (globalThis as { Bun?: BunPeek }).Bun?.peek;
  const status = peek?.status?.(receipt);
  if (status === "rejected") return true;
  return status === "fulfilled" && isCapacityPressure(peek!(receipt));
}

function isReceipt(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

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
  private readonly ring: Array<PipeScrollEvent | undefined> = [];
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
  private acceptedBytes = 0;
  private refusedBytes = 0;
  /** Bytes received while a dead parser is being replaced; fed to the new one. */
  private held: Array<{ seq: number; bytes: Uint8Array }> = [];
  private pressureEpisode = false;
  private pressureRetries = 0;
  private oversizeDrops = 0;
  private closePromise: Promise<PipeCollectorDrainReceipt> | null = null;

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
    // Callbacks are bound to this instance: output of a replaced worker that
    // is still draining must never land in the new epoch.
    const worker: PipeVtWorker = new PipeVtWorker({
      pool: this.options.pool,
      sourceEpoch: this.sourceEpoch,
      onHistoryClear: ({ seq, epoch }) => {
        if (worker !== this.worker) return;
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
      onUpdate: (update) => worker === this.worker ? this.onUpdate(update) : undefined,
      onFault: (fault) => {
        if (fault.kind === "shutdown-timeout") {
          // Reported by the worker being closed; its unconsumed updates are gone.
          this.notifyFault({ kind: fault.kind, at: this.now(), message: fault.message, lostRows: "unknown" });
          return;
        }
        if (worker !== this.worker) return;
        if (fault.kind === "clear-policy-unknown") {
          this.policyUnverified = true;
          this.fault(fault.kind, fault.message, "degraded");
        } else this.fault(fault.kind, fault.message, "broken");
      },
    });
    return worker;
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
    if (this.healthState === "closed") {
      this.refusedBytes += bytes.byteLength;
      const seq = ++this.receiveSeq;
      this.notifyFault({ kind: "closed", at: this.now(), unacknowledgedBytes: bytes.byteLength,
        receiveSeqFrom: seq, receiveSeqTo: seq, lostRows: "unknown" });
      return false;
    }
    if (this.healthState === "broken" && this.recovering && !this.closing) {
      // The replacement parser is starting: keep the bytes (the caller waits
      // on drained() for the recovery) instead of reading the FIFO and
      // throwing them away. Only bytes beyond the bound are refused.
      if (this.inflightBytes + bytes.byteLength <= this.queueLimit + 64 * 1024) {
        const seq = ++this.receiveSeq;
        this.inflight.push({ seq, bytes: bytes.byteLength, at: receivedAtNs });
        this.inflightBytes += bytes.byteLength;
        this.held.push({ seq, bytes: bytes.slice() });
        return false;
      }
    }
    if (this.healthState === "broken") {
      this.refusedBytes += bytes.byteLength;
      const seq = ++this.receiveSeq;
      this.notifyFault({ kind: "worker-exit", at: this.now(), message: "bytes rejected by dead parser", unacknowledgedBytes: bytes.byteLength, receiveSeqFrom: seq, receiveSeqTo: seq, lostRows: "unknown" });
      return false;
    }
    if (this.inflightBytes > this.queueLimit || bytes.byteLength > this.queueLimit + 64 * 1024
      || !this.worker.canAccept(bytes.byteLength)) {
      this.refusedBytes += bytes.byteLength;
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
      this.refusedBytes += bytes.byteLength;
      this.fault("worker-exit", "parser rejected input", "broken");
      return false;
    }
    this.acceptedBytes += bytes.byteLength;
    if (!this.readyForDelivery()) {
      if (this.inflightBytes > this.queueLimit && this.healthState === "ok") {
        this.fault("parser-backlog", `parser pressure: ${this.inflightBytes} inflight bytes; next delivery must wait for IPC and parser capacity`, "degraded");
      }
      return false;
    }
    return true;
  }

  /**
   * Resolves when the next delivery can be accepted. While a dead parser is
   * being replaced this waits for the replacement, so the reader leaves the
   * bytes in the FIFO instead of reading and discarding them.
   */
  drained(): Promise<void> {
    if (this.healthState === "closed") return Promise.resolve();
    if (this.recovering) return this.recovering.then(() => this.drained());
    if (this.healthState === "broken" || this.readyForDelivery()) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private readyForDelivery(): boolean {
    return this.inflightBytes <= this.queueLimit && this.worker.canAccept(64 * 1024);
  }

  /** Geometry changed: new generation; the worker reflows and re-sends. */
  resize(cols: number, rows: number): number {
    this.cols = cols;
    this.rows = rows;
    this.geometryGeneration += 1;
    // A respawning parser receives the current geometry once it starts.
    if (this.parserLive() && !this.worker.resize(cols, rows, this.geometryGeneration)) {
      this.fault("worker-error", "resize admission failed", "broken");
    }
    return this.geometryGeneration;
  }

  /** The current worker accepts control frames (not dead, closing or respawning). */
  private parserLive(): boolean {
    return this.healthState !== "broken" && this.healthState !== "closed" && !this.recovering;
  }

  /** Continuity broke (pipe gap, restart): later rows belong to a new epoch. */
  beginSourceEpoch(epoch: number): void {
    if (epoch <= this.upstreamEpoch) throw new Error(`upstream epoch must increase (${this.upstreamEpoch} -> ${epoch})`);
    this.upstreamEpoch = epoch;
    const previousEpoch = this.sourceEpoch;
    // Parser recovery and upstream pipe restarts are independent breaks.
    this.sourceEpoch = Math.max(this.sourceEpoch + 1, epoch);
    // Only the unacknowledged tail can be affected; acknowledged rows are
    // kept. `receiveSeqFrom = receiveSeqTo + 1` is a pure boundary after
    // receiveSeqTo: the upstream gap before the next byte is of unknown size.
    this.notifyFault({ kind: "source-reset", at: this.now(), message: "owner requested parser reset; external reset ordering remains unverified",
      sourceEpoch: previousEpoch, receiveSeqFrom: this.ackedSeq + 1, receiveSeqTo: this.receiveSeq, lostRows: "unknown" });
    // A respawning parser already starts in the new epoch with a fresh state.
    if (this.parserLive() && !this.worker.reset(this.sourceEpoch)) this.fault("worker-error", "parser reset admission failed", "broken");
  }

  setScrollOnClear(enabled: boolean): void {
    this.scrollOnClear = enabled;
    if (this.parserLive() && !this.worker.setScrollOnClear(enabled)) this.fault("worker-error", "clear policy admission failed", "broken");
  }

  currentSourceEpoch(): number {
    return this.sourceEpoch;
  }

  currentGeometryGeneration(): number {
    return this.geometryGeneration;
  }

  requestFullFrame(): boolean {
    if (!this.parserLive()) return false;
    if (this.worker.requestFull(this.receiveSeq)) return true;
    this.fault("worker-error", "full-frame request admission failed", "broken");
    return false;
  }

  /** Rows still held by the tray ring, oldest first. */
  ringSnapshot(): PipeScrollEvent[] {
    // Only the evicted prefix has empty slots; the active suffix is dense.
    return this.ring.slice(this.ringStart) as PipeScrollEvent[];
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
      restartCount: this.recoveryAttempts,
      receiveSeq: this.receiveSeq,
      ackedSeq: this.ackedSeq,
      inflightBytes: this.inflightBytes,
      acceptedBytes: this.acceptedBytes,
      refusedBytes: this.refusedBytes,
      pressureRetries: this.pressureRetries,
      oversizeDrops: this.oversizeDrops,
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

  close(): Promise<PipeCollectorDrainReceipt> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return this.closePromise = (async () => {
      await this.recovering;
      const worker = await this.worker.close(this.options.closeTimeoutMs);
      this.healthState = "closed";
      for (const waiter of this.drainWaiters.splice(0)) waiter();
      return this.shutdownReceipt(worker.issues, worker.unknownTail);
    })();
  }

  private shutdownReceipt(issues: string[], workerUnknown = false): PipeCollectorDrainReceipt {
    const receiptIssues = [...issues];
    if (this.ackedSeq !== this.receiveSeq) {
      receiptIssues.push(`collector acknowledged ${this.ackedSeq} of ${this.receiveSeq} admitted sequences`);
    }
    if (this.inflightBytes !== 0) receiptIssues.push(`collector retained ${this.inflightBytes} unacknowledged bytes`);
    if (this.held.length !== 0) receiptIssues.push(`collector retained ${this.held.length} recovery deliveries`);
    return {
      lastAdmittedSequence: this.receiveSeq,
      lastAckedSequence: this.ackedSeq,
      ramRevision: null,
      durableRevision: null,
      issues: receiptIssues,
      unknownTail: workerUnknown || receiptIssues.length > 0,
    };
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
      receiveSeqFrom: Math.min(this.ackedSeq + 1, this.receiveSeq),
      receiveSeqTo: this.receiveSeq,
      lostRows: "unknown" as const,
    } : {};
    if (health === "broken") {
      this.inflight = [];
      this.inflightBytes = 0;
      this.held = [];
    }
    this.notifyFault({ kind, at: this.now(), message, ...loss });
    if (health === "broken" && !this.closing && !this.recovering && kind !== "vendor-hash" && this.recoveryAttempts < 3) {
      // Defer until the current exit/input callback has finished. Drain
      // waiters wait for the replacement; bytes received meanwhile are held.
      this.recoveryAttempts++;
      this.recovering = Promise.resolve().then(async () => {
        await this.worker.close(this.options.closeTimeoutMs);
        if (this.closing) return;
        this.sourceEpoch++;
        this.worker = this.makeWorker();
        await this.worker.start();
        if (this.scrollOnClear !== undefined) this.worker.setScrollOnClear(this.scrollOnClear);
        this.worker.resize(this.cols, this.rows, this.geometryGeneration);
        for (const entry of this.held.splice(0)) {
          if (!this.worker.feed(entry.seq, entry.bytes, this.sourceEpoch)) throw new Error("replacement parser refused held bytes");
          this.acceptedBytes += entry.bytes.byteLength;
        }
        this.healthState = this.policyUnverified ? "degraded" : "ok";
        this.notifyFault({ kind: "worker-restarted", at: this.now(), message: `parser respawned; source epoch ${this.sourceEpoch}; calibration required` });
      }).catch((error) => {
        this.healthState = "broken";
        const lost = this.held.splice(0);
        this.inflight = [];
        this.inflightBytes = 0;
        this.notifyFault({ kind: "spawn", at: this.now(), message: String(error), lostRows: "unknown",
          ...(lost.length ? { receiveSeqFrom: lost[0]!.seq, receiveSeqTo: lost.at(-1)!.seq,
            unacknowledgedBytes: lost.reduce((sum, entry) => sum + entry.bytes.byteLength, 0) } : {}) });
      }).finally(() => {
        this.recovering = null;
        for (const waiter of this.drainWaiters.splice(0)) waiter();
      });
    } else if (health === "broken") {
      for (const waiter of this.drainWaiters.splice(0)) waiter();
    }
  }

  /** Refusal retains the exact event and pauses input. Oversize requires the
   * sink to stream/spool it; it is never permission to discard history. */
  private deliver(send: () => unknown): { receipt: unknown; pressured: boolean } {
    const refused = (v: unknown) => isCapacityPressure(v) || isOversize(v);
    let answer: unknown;
    try { answer = send(); }
    catch (e) {
      if (refused(e)) return {receipt:this.retryPressure(send),pressured:true};
      throw e;
    }
    if (isReceipt(answer)) return {pressured:true, receipt:Promise.resolve(answer).then(
      value => {
        if (refused(value)) return this.retryPressure(send);
        if (isRefusal(value)) throw new Error(`consumer refused: ${JSON.stringify(value)}`);
      }, e => { if (refused(e)) return this.retryPressure(send); throw e; })};
    if (refused(answer)) return {receipt:this.retryPressure(send),pressured:true};
    if (isRefusal(answer)) throw new Error(`consumer refused: ${JSON.stringify(answer)}`);
    return {receipt:undefined,pressured:false};
  }
  private async retryPressure(send: () => unknown): Promise<void> {
    if (!this.pressureEpisode) {
      this.pressureEpisode = true;
      if (this.healthState === "ok") this.healthState = "degraded";
      this.notifyFault({kind:"consumer-pressure",at:this.now(),
        message:"consumer refused; exact output retained and input paused until accepted"});
    }
    let delay = this.options.pressureRetryMs ?? 2;
    for (;;) {
      if (this.closing || this.healthState === "closed" || this.healthState === "broken")
        throw new Error("collector closed with unacknowledged consumer output");
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 100); this.pressureRetries++;
      let answer: unknown;
      try { answer = await send(); }
      catch(e) { if (isCapacityPressure(e) || isOversize(e)) continue; throw e; }
      if (isCapacityPressure(answer) || isOversize(answer)) continue;
      if (isRefusal(answer)) throw new Error(`consumer refused: ${JSON.stringify(answer)}`);
      return;
    }
  }

  private endPressure(): void {
    if (!this.pressureEpisode) return;
    this.pressureEpisode = false;
    this.notifyFault({ kind: "consumer-pressure-cleared", at: this.now(), message: "consumer accepts again" });
  }

  private remember(event: PipeScrollEvent): void {
    this.scrollCount += 1;
    this.ring.push(event);
    while (this.ring.length - this.ringStart > this.ringRows) {
      const evicted = this.ring[this.ringStart]!;
      // Release ownership before user code runs, even if onEvict throws.
      // Compacting the empty prefix later must not retain discarded rows.
      this.ring[this.ringStart] = undefined;
      this.ringStart += 1;
      this.options.onEvict?.(evicted);
    }
    if (this.ringStart > 4096 && this.ringStart * 2 > this.ring.length) {
      this.ring.splice(0, this.ringStart);
      this.ringStart = 0;
    }
  }

  /**
   * Offer scrolled rows from `index` on as one pipelined batch: every row is
   * handed to onScroll in order without waiting for the previous receipt.
   * A row that meets synchronous capacity pressure ends the batch there (it
   * is retried alone), so no later row is offered before it is accepted.
   * Rows enter the tray ring only once accepted, still in order.
   */
  private offerScrolls(events: PipeScrollEvent[], index: number): unknown {
    const pending: unknown[] = [];
    let accepted = index;
    let stop = events.length;
    for (let i = index; i < events.length; i++) {
      const event = events[i]!;
      const { receipt, pressured } = this.deliver(() => this.options.ports.onScroll(event));
      if ((receipt === undefined) && pending.length === 0) {
        if (receipt === undefined) this.remember(event);
        accepted = i + 1;
        continue;
      }
      pending.push(receipt);
      if (pressured) { stop = i + 1; break; }
    }
    if (pending.length === 0) return;
    return Promise.all(pending).then((answers) => {
      // All receipts have acknowledged these exact rows.
      for (let i = accepted; i < stop; i++) this.remember(events[i]!);
      if (stop < events.length) return this.offerScrolls(events, stop);
    });
  }

  private onUpdate(update: PipeVtUpdate): unknown {
    if (this.healthState === "broken" || this.healthState === "closed") return;
    const began = this.nowNs();
    this.workerParseNs += update.parseNs;
    this.workerEncodeNs += update.encodeNs;
    const seqTo = update.seqTo ?? this.ackedSeq;
    const complete = () => {
      this.frameCount += 1;
      this.endPressure();
      const published = this.nowNs();
      while (this.inflight.length && this.inflight[0]!.seq <= seqTo) {
        const entry = this.inflight.shift()!;
        this.inflightBytes -= entry.bytes;
        if (this.latencyMs.length < this.latencyLimit) this.latencyMs.push(Number(published - entry.at) / 1e6);
      }
      if (seqTo > this.ackedSeq) {
        this.ackedSeq = seqTo;
        this.recoveryAttempts = 0;
      }
      this.hostHandleNs += published - began;
      if (this.readyForDelivery()) {
        if (this.scrollOnClear !== undefined && update.scrollOnClear === this.scrollOnClear) this.policyUnverified = false;
        if (this.healthState === "degraded" && !this.policyUnverified) this.healthState = "ok";
        for (const waiter of this.drainWaiters.splice(0)) waiter();
      }
    };
    const publish = () => {
      if (this.healthState === "broken" || this.healthState === "closed") return;
      const dirty: Record<number, PipeVtRow> = {};
      const softWrap: Record<number, boolean> = {};
      for (const [y, row] of Object.entries(update.frame.dirty)) dirty[Number(y)] = row;
      for (const [y, wrap] of Object.entries(update.frame.wraps)) softWrap[Number(y)] = wrap;
      const frame: PipeFrameEvent = {
        paneKey: this.paneKey, sourceEpoch: update.epoch,
        cells: { full: update.frame.full, shift: update.frame.shift,
          cols: update.frame.cols, rows: update.frame.rows, dirty, softWrap, wrapPad: update.frame.pads },
        cursor: update.frame.cursor, kind: update.frame.kind,
        geometryGeneration: update.gen, receiveSeq: seqTo,
      };
      const { receipt } = this.deliver(() => this.options.ports.onFrame(frame));
      if (isReceipt(receipt)) return receipt.then(complete);
      complete();
    };
    const rejected = (error: unknown) => {
      this.fault("consumer-rejected", `scroll/frame receipt rejected: ${String(error)}`, "broken");
    };
    try {
      const scrolls = update.scrolls.map((scroll) => ({ paneKey: this.paneKey, sourceEpoch: scroll.epoch,
        geometryGeneration: scroll.gen, physicalRow: scroll.row,
        packetEpoch: scroll.packetEpoch, packetSeq: scroll.packetSeq, scrollOrdinal: scroll.scrollOrdinal,
        softWrap: scroll.wrap, wrapPad: scroll.pad, receiveSeq: scroll.seq ?? this.ackedSeq }));
      const receipt = this.offerScrolls(scrolls, 0);
      if (isReceipt(receipt)) return Promise.resolve(receipt).then(publish).catch(rejected);
      const published = publish();
      if (isReceipt(published)) return Promise.resolve(published).catch(rejected);
    } catch (error) { rejected(error); }
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
    for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
      if (!collector.ingest(chunk.subarray(offset, offset + 64 * 1024))) await collector.drained();
    }
  }
  return total;
}
