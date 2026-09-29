import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { PIPE_VT_LICENSE_FILE, PIPE_VT_VENDOR_FILE, PIPE_VT_VENDOR_SHA256, PIPE_VT_WORKER_FILE } from "./pipe-vt-assets";

/**
 * Host side of the NEWARCH L2-P VT worker (`pipe-vt-worker.py`).
 *
 * The host never decodes pipe bytes: each chunk is framed as-is with its
 * receive sequence and the Python worker feeds one incremental pyte stream,
 * so UTF-8 and escape sequences may split anywhere. The worker answers with
 * `U` updates carrying scrolled rows (always before the frame of the same
 * update, and before pyte drops them) and the dirty rows of the screen.
 *
 * Host->worker input goes through a private FIFO written with non-blocking
 * writeSync, not the child's stdin: measured on Bun 1.3.11, 100 small
 * stdin writes/s cost ~20% of a core in the host, the FIFO ~2.6%.
 */

export { PIPE_VT_LICENSE_FILE, PIPE_VT_VENDOR_FILE, PIPE_VT_VENDOR_SHA256, PIPE_VT_WORKER_FILE } from "./pipe-vt-assets";

/**
 * [fg, bg, attrs bitmask, cells]. `cells` is a string when every cell is a
 * single BMP code unit of width 1 (one UTF-16 unit per cell), otherwise one
 * grapheme per cell with "" as the stub cell of a wide glyph. The compact
 * form keeps plain rows to a few strings instead of one string per cell.
 */
export type PipeVtRun = [fg: string, bg: string, attrs: number, cells: string | string[]];
export type PipeVtRow = PipeVtRun[];

/** One entry per terminal cell, whichever form the run uses. */
export function pipeVtRunCells(run: PipeVtRun): string[] {
  return typeof run[3] === "string" ? run[3].split("") : run[3];
}

export const PIPE_VT_ATTR = {
  bold: 1,
  italics: 2,
  underscore: 4,
  strikethrough: 8,
  reverse: 16,
  blink: 32,
} as const;

export type PipeVtScroll = {
  row: PipeVtRow;
  /** Row continues into the next physical row (soft wrap). */
  wrap: boolean;
  /** Last cell is blank padding left by a wide glyph that wrapped. */
  pad: boolean;
  gen: number;
  seq: number | null;
  epoch: number;
};

export type PipeVtCursor = { x: number; y: number; visible: boolean };

export type PipeVtFrame = {
  kind: "normal" | "alternate";
  cols: number;
  rows: number;
  full: boolean;
  /** Rows the screen scrolled up by before `dirty` applies (0 when full). */
  shift: number;
  dirty: Record<string, PipeVtRow>;
  wraps: Record<string, boolean>;
  pads: number[];
  cursor: PipeVtCursor;
};

export type PipeVtUpdate = {
  epoch: number;
  scrollOnClear: boolean | null;
  seqFrom: number | null;
  seqTo: number | null;
  gen: number;
  scrolls: PipeVtScroll[];
  frame: PipeVtFrame;
  parseNs: number;
  encodeNs: number;
  /** Worker stage durations (absent from workers older than P2 diagnostics). */
  stages?: PipeVtWorkerStages;
  /** json.dumps + UTF-8 of this update's own body, in the worker. */
  serializeNs?: number;
};

/**
 * Worker-side durations for the D frames acknowledged by one update, each on
 * the worker's monotonic clock. `waitNs` is how long the oldest D frame sat
 * complete in the worker before dispatch (fairness / budget wait), `holdNs`
 * that frame's completion -> emit start (wait + parse of every frame + the
 * coalescing window). Kernel socket/FIFO buffering before the worker read is
 * outside every worker stage and lands in the host's transport residual.
 */
export type PipeVtWorkerStages = {
  inFrames: number;
  inBytes: number;
  waitNs: number;
  maxWaitNs: number;
  holdNs: number;
  /**
   * Bounds on how late the read that completed the oldest frame came after
   * its bytes became readable: lower = sibling channels served earlier in the
   * same poll turn, upper = the loop-busy window since the previous poll (a
   * blocked poll counts only its own wait). Both sit inside `transportMs`.
   */
  readLagNs: number;
  readLagMaxNs: number;
};

/**
 * One update's path, host clock (ms) for host spans, worker durations as
 * reported. Spans nest, so the stages do not sum across different updates:
 *   feed(seqFrom) ─ worker hold ─ encode ─ serialize ─ arrival ─ mainQueue ─ decode ─ consumer
 * `transportMs` = feedToArrival - (hold + encode + serialize): host write
 * buffering, kernel socket/FIFO (including `readLag*` — the shared loop busy
 * with sibling panes), worker output buffering and event-loop delivery. It is a residual of nested durations, never a clock difference.
 * The old driver's "parse" (ingest -> onFrame) is feedToArrival + mainQueue +
 * decode + (part of) consumer, not parser CPU time; parser CPU is `worker.parseNs`.
 */
export type PipeVtStageTrace = {
  seqFrom: number | null;
  seqTo: number | null;
  epoch: number;
  /** Fed D frames whose seq this update acknowledged (0 for partial emits). */
  matchedFeeds: number;
  bodyBytes: number;
  /** Host feed of the oldest / newest matched seq -> arrival of the completing chunk. */
  feedToArrivalMs: number | null;
  lastFeedToArrivalMs: number | null;
  /** Arrival -> start of this update's decode: waits behind earlier consumers. */
  mainQueueMs: number;
  decodeMs: number;
  /** onUpdate call until its receipt settled. */
  consumerMs: number;
  /** Oldest matched feed -> consumer settled (the host-visible end to end). */
  feedToConsumedMs: number | null;
  transportMs: number | null;
  worker: PipeVtWorkerStages & { parseNs: number; encodeNs: number; serializeNs: number } | null;
};

export type PipeVtReady = { vendorSha256: string; cols: number; rows: number; pid: number };

export type PipeVtFault = {
  kind: "worker-exit" | "worker-error" | "protocol" | "vendor-hash" | "spawn" | "clear-policy-unknown" | "shutdown-timeout";
  at: number;
  message: string;
};

export type PipeVtDrainReceipt = {
  workerEof: boolean;
  outputDrained: boolean;
  issues: string[];
  unknownTail: boolean;
};

export type PipeVtAssets = { worker: string; vendor: string; license: string };

export function pipeVtAssets(directory: string = import.meta.dir): PipeVtAssets {
  return {
    worker: join(directory, PIPE_VT_WORKER_FILE),
    vendor: join(directory, PIPE_VT_VENDOR_FILE),
    license: join(directory, PIPE_VT_LICENSE_FILE),
  };
}

/** Refuse to start on a vendor archive other than the pinned one. */
export function verifyPipeVtAssets(assets: PipeVtAssets): string {
  const sha = createHash("sha256").update(readFileSync(assets.vendor)).digest("hex");
  if (sha !== PIPE_VT_VENDOR_SHA256) {
    throw new Error(`pipe-vt vendor hash mismatch: expected ${PIPE_VT_VENDOR_SHA256}, got ${sha}`);
  }
  const license = readFileSync(assets.license, "utf8");
  if (!license.includes("GNU LESSER GENERAL PUBLIC LICENSE") || !license.includes(PIPE_VT_VENDOR_SHA256)) {
    throw new Error("pipe-vt licence file does not cover the pinned vendor archive");
  }
  readFileSync(assets.worker);
  return sha;
}

export type PipeVtWorkerOptions = {
  pool?: PipeVtPool;
  sourceEpoch?: number;
  onHistoryClear?: (event: { seq: number; epoch: number }) => unknown;
  cols: number;
  rows: number;
  onUpdate: (update: PipeVtUpdate) => unknown;
  onFault: (fault: PipeVtFault) => void;
  assets?: PipeVtAssets;
  python?: string;
  now?: () => number;
  /**
   * Diagnostics only: called after each update's consumer settled. Without it
   * no feed timestamps are kept. Never throws into the pipe path.
   */
  onStageTrace?: (trace: PipeVtStageTrace) => void;
  /** Monotonic ms clock for stage traces (default performance.now). */
  traceNow?: () => number;
};

/** Feed timestamps kept for tracing; older ones are dropped and counted. */
export const PIPE_VT_TRACE_PENDING_MAX = 8192;

/** Data frames share this budget; control frames (Z/F/X/C/Q) never compete for it. */
export const PIPE_VT_DATA_QUEUE_BYTES = 1024 * 1024;
/** Extra room reserved for control frames only, on top of the data budget. */
export const PIPE_VT_CONTROL_RESERVE_BYTES = 64 * 1024;
/** Unprocessed worker output above this pauses stdout; below the low mark resumes. */
const OUTPUT_HIGH_WATERMARK = 1024 * 1024;
const OUTPUT_LOW_WATERMARK = 256 * 1024;

function header(kind: string, length: number): Buffer {
  const out = Buffer.allocUnsafe(5);
  out.write(kind, 0, "latin1");
  out.writeUInt32BE(length, 1);
  return out;
}

type SharedGeneration = {
  child: ChildProcess; directory: string; path: string; ready: Promise<void>;
  done: Promise<void>; users: number; dead: boolean; sockets: Set<Socket>;
};
type SharedLease = { socket: Socket; pid: number; done: Promise<void>; release(): Promise<void>; kill(signal: NodeJS.Signals): void };

/** One interpreter, independent bounded duplex channels and parser state per pane.
 * A dead generation is never reused. Every attached socket sees EOF on process
 * death, so every collector emits its own loss marker and restarts its epoch.
 */
export class PipeVtPool {
  private current: SharedGeneration | null = null;
  private generations = new Set<SharedGeneration>();
  private closed = false;
  constructor(private readonly options: { assets?: PipeVtAssets; python?: string } = {}) {}

  private launch(): SharedGeneration {
    const assets = this.options.assets ?? pipeVtAssets();
    verifyPipeVtAssets(assets);
    const directory = mkdtempSync(join(tmpdir(), "pipe-vt-pool-"));
    const path = join(directory, "worker.sock");
    const child = spawn(this.options.python ?? "python3", ["-B", assets.worker, "--multiplex", path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" },
    });
    let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveDone!: () => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const generation: SharedGeneration = { child, directory, path, ready, done, users: 0, dead: false, sockets: new Set() };
    this.generations.add(generation);
    let stderr = "", output = "";
    const timer = setTimeout(() => { rejectReady(new Error("shared parser startup timed out")); child.kill("SIGKILL"); }, 5000);
    child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
    child.stdout?.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-4096);
      if (output.includes("MULTIPLEX_READY\n")) { clearTimeout(timer); resolveReady(); }
    });
    child.on("error", rejectReady);
    child.on("exit", () => {
      generation.dead = true;
      // EOF cannot reach a paused socket until its consumer drains. Destroy
      // explicitly so even a blocked pane reports process death immediately.
      for (const socket of generation.sockets) socket.destroy();
    });
    child.on("close", () => {
      generation.dead = true; clearTimeout(timer);
      rejectReady(new Error(`shared parser exited: ${stderr}`));
      if (this.current === generation) this.current = null;
      rmSync(directory, { recursive: true, force: true });
      this.generations.delete(generation); resolveDone();
    });
    return generation;
  }

  async acquire(): Promise<SharedLease> {
    if (this.closed) throw new Error("parser pool closed");
    const gen = this.current && !this.current.dead ? this.current : (this.current = this.launch());
    gen.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (--gen.users === 0) {
        if (this.current === gen) this.current = null;
        gen.dead = true;
        // All pane channels have closed; no parser state remains to flush.
        gen.child.kill("SIGKILL");
        await gen.done;
      }
    };
    try {
      await gen.ready;
      if (gen.dead || this.closed) throw new Error("shared parser exited during attach");
      // Caller installs data/close listeners before sending its A frame.
      const socket = createConnection({ path: gen.path });
      gen.sockets.add(socket);
      socket.once("close", () => gen.sockets.delete(socket));
      return { socket, pid: gen.child.pid!, done: gen.done, release, kill: signal => {
        gen.dead = true; if (this.current === gen) this.current = null; gen.child.kill(signal);
      } };
    } catch (error) { await release(); throw error; }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const gen of this.generations) { gen.dead = true; gen.child.kill("SIGKILL"); }
    await Promise.all([...this.generations].map(gen => gen.done));
  }
}

export class PipeVtWorker {
  private lease: SharedLease | null = null;
  private socket: Socket | null = null;
  /** Set only after Q was parsed and every final update was written before B. */
  private quitAck = false;
  private leaseDone: Promise<void> = Promise.resolve();
  private child: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private closing = false;
  private exited = false;
  private readyResolve: ((ready: PipeVtReady) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private exitWaiters: Array<() => void> = [];
  private inputDir: string | null = null;
  private inputFd: number | null = null;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private outputTail: Promise<void> = Promise.resolve();
  private outputPendingBytes = 0;
  private outputPaused = false;
  /** Set after a bounded close gave up on the consumer: later output is dropped. */
  private abandoned = false;
  private closePromise: Promise<PipeVtDrainReceipt> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Traced feeds not yet acknowledged: parallel seq / host-time columns. */
  private traceSeqs: number[] = [];
  private traceTimes: number[] = [];
  private traceHead = 0;
  private traceDropped = 0;
  readonly ready: Promise<PipeVtReady>;
  pid: number | null = null;

  constructor(private readonly options: PipeVtWorkerOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
  }

  private notifyFault(event: PipeVtFault): void {
    try { this.options.onFault(event); }
    catch (error) { console.error("[pipe-vt] onFault callback failed:", error); }
  }

  private async startShared(): Promise<void> {
    try {
      const lease = await this.options.pool!.acquire();
      this.lease = lease;
      this.pid = lease.pid;
      const socket = this.socket = lease.socket;
      socket.on("data", (chunk: Buffer) => this.receiveOutput(chunk));
      let channelError: Error | undefined;
      socket.on("error", (error) => {
        channelError = error;
        // close owns fault delivery: a socket error can precede the child exit
        // event, while the pool still points at the dying generation.
      });
      socket.on("close", () => {
        this.exited = true;
        this.leaseDone = lease.release();
        for (const waiter of this.exitWaiters.splice(0)) waiter();
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Let process close invalidate the generation before recovery. A
            // channel-only failure must remain bounded and spare its siblings.
            await Promise.race([lease.done, new Promise<void>(resolve => {
              timer = setTimeout(resolve, 100);
            })]);
          } finally { if (timer) clearTimeout(timer); }
          const message = channelError?.message ?? "shared parser channel closed unexpectedly; unacknowledged tail is unknown";
          this.readyReject?.(new Error(message));
          if (!this.closing) {
            this.notifyFault({ kind: "worker-exit", at: (this.options.now ?? Date.now)(), message });
          }
        })();
      });
      const attach = Buffer.alloc(12);
      attach.writeUInt16BE(this.options.cols); attach.writeUInt16BE(this.options.rows, 2);
      attach.writeBigUInt64BE(BigInt(this.options.sourceEpoch ?? 1), 4);
      socket.write(Buffer.concat([header("A", attach.length), attach]));
    } catch (error) {
      this.socket?.destroy();
      await this.lease?.release();
      this.readyReject?.(error as Error);
      this.notifyFault({ kind: "spawn", at: (this.options.now ?? Date.now)(), message: String(error) });
    }
  }

  start(): Promise<PipeVtReady> {
    const assets = this.options.assets ?? pipeVtAssets();
    const now = this.options.now ?? Date.now;
    try {
      verifyPipeVtAssets(assets);
    } catch (error) {
      const message = (error as Error).message;
      this.notifyFault({ kind: "vendor-hash", at: now(), message });
      this.readyReject?.(new Error(message));
      return this.ready;
    }
    if (this.options.pool) { void this.startShared(); return this.ready; }
    // Private FIFO for input; O_RDWR so neither side blocks on open and the
    // worker only sees EOF once we close it.
    this.inputDir = mkdtempSync(join(tmpdir(), "pipe-vt-"));
    const fifo = join(this.inputDir, "in.fifo");
    if (spawnSync("mkfifo", ["-m", "600", fifo]).status !== 0) {
      const message = `mkfifo failed for ${fifo}`;
      this.notifyFault({ kind: "spawn", at: now(), message });
      this.readyReject?.(new Error(message));
      this.releaseInput();
      return this.ready;
    }
    this.inputFd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const child = spawn(
      this.options.python ?? "python3",
      ["-B", assets.worker, String(this.options.cols), String(this.options.rows), fifo, String(this.options.sourceEpoch ?? 1)],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LANG: "C.UTF-8" } },
    );
    this.child = child;
    this.pid = child.pid ?? null;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => this.receiveOutput(chunk));
    child.on("error", (error) => {
      this.notifyFault({ kind: "spawn", at: now(), message: error.message });
      this.readyReject?.(error);
    });
    child.on("close", (code, signal) => {
      this.exited = true;
      this.releaseInput();
      if (!this.closing) {
        const message = `worker exited code=${code} signal=${signal} ${stderr.slice(-2000)}`.trim();
        this.notifyFault({ kind: "worker-exit", at: now(), message });
        this.readyReject?.(new Error(message));
      }
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
    return this.ready;
  }

  private receiveOutput(chunk: Buffer): void {
    if (this.abandoned) return;
    this.outputPendingBytes += chunk.byteLength;
    if (!this.outputPaused && this.outputPendingBytes > OUTPUT_HIGH_WATERMARK) {
      this.outputPaused = true;
      (this.socket ?? this.child?.stdout)?.pause();
    }
    const arrivedAt = this.options.onStageTrace ? this.traceClock() : 0;
    this.outputTail = this.outputTail.then(() => this.onStdout(chunk, arrivedAt)).catch((error) => {
      this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: String(error) });
    }).then(() => this.releaseOutput(chunk.byteLength));
  }

  /** A channel failure never kills sibling parsers; kill() is the process fault hook. */
  private terminateChannel(): void {
    if (this.socket) this.socket.destroy(); else this.child?.kill("SIGKILL");
  }

  private releaseOutput(bytes: number): void {
    this.outputPendingBytes -= bytes;
    if (this.outputPaused && this.outputPendingBytes <= OUTPUT_LOW_WATERMARK) {
      this.outputPaused = false;
      (this.socket ?? this.child?.stdout)?.resume();
    }
  }

  inputBacklogBytes(): number { return this.socket?.writableLength ?? this.queuedBytes; }

  /** Unprocessed worker output bytes (test observability). */
  outputBacklogBytes(): number {
    return this.outputPendingBytes;
  }

  /** Traced feeds awaiting acknowledgement, and feeds dropped from tracing. */
  traceBacklog(): { pending: number; dropped: number; retained: number } {
    return { pending: this.traceSeqs.length - this.traceHead, dropped: this.traceDropped, retained: this.traceSeqs.length };
  }

  private traceClock(): number {
    return (this.options.traceNow ?? performance.now.bind(performance))();
  }

  private traceFeed(seq: number, fedAt: number): void {
    if (this.traceSeqs.length - this.traceHead >= PIPE_VT_TRACE_PENDING_MAX) { this.traceHead++; this.traceDropped++; }
    this.traceSeqs.push(seq);
    this.traceTimes.push(fedAt);
    this.compactTrace();
  }

  /** Keep both columns within twice the pending window. */
  private compactTrace(): void {
    if (this.traceHead > 1024 && this.traceHead * 2 > this.traceSeqs.length) {
      this.traceSeqs = this.traceSeqs.slice(this.traceHead);
      this.traceTimes = this.traceTimes.slice(this.traceHead);
      this.traceHead = 0;
    }
  }

  /** Remove every traced feed acknowledged by `seqTo`; returns [count, first, last] times. */
  private traceAck(seqTo: number | null): [number, number | null, number | null] {
    let n = 0, first: number | null = null, last: number | null = null;
    if (seqTo !== null) {
      while (this.traceHead < this.traceSeqs.length && this.traceSeqs[this.traceHead]! <= seqTo) {
        const t = this.traceTimes[this.traceHead++]!;
        first ??= t; last = t; n++;
      }
    }
    this.compactTrace();
    return [n, first, last];
  }

  private emitTrace(update: PipeVtUpdate, bodyBytes: number, arrivedAt: number, startedAt: number,
    decodedAt: number, consumedAt: number): void {
    const [matchedFeeds, first, last] = this.traceAck(update.seqTo);
    const stages = update.stages;
    const worker = stages ? { ...stages, parseNs: update.parseNs, encodeNs: update.encodeNs, serializeNs: update.serializeNs ?? 0 } : null;
    const feedToArrivalMs = first === null ? null : arrivedAt - first;
    const trace: PipeVtStageTrace = {
      seqFrom: update.seqFrom, seqTo: update.seqTo, epoch: update.epoch, matchedFeeds, bodyBytes,
      feedToArrivalMs, lastFeedToArrivalMs: last === null ? null : arrivedAt - last,
      mainQueueMs: startedAt - arrivedAt, decodeMs: decodedAt - startedAt, consumerMs: consumedAt - decodedAt,
      feedToConsumedMs: first === null ? null : consumedAt - first,
      transportMs: feedToArrivalMs === null || worker === null ? null
        : feedToArrivalMs - (worker.holdNs + worker.encodeNs + worker.serializeNs) / 1e6,
      worker,
    };
    try { this.options.onStageTrace!(trace); }
    catch (error) { console.error("[pipe-vt] onStageTrace callback failed:", error); }
  }

  private async onStdout(chunk: Buffer, arrivedAt = 0): Promise<void> {
    if (this.abandoned) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length - offset >= 5) {
      const kind = String.fromCharCode(this.pending[offset]!);
      const length = this.pending.readUInt32BE(offset + 1);
      if (length > 16 * 1024 * 1024) {
        this.pending = Buffer.alloc(0);
        this.terminateChannel();
        throw new Error("worker output exceeds 16 MiB frame bound");
      }
      if (this.pending.length - offset < 5 + length) break;
      const tracing = kind === "U" && this.options.onStageTrace !== undefined;
      const startedAt = tracing ? this.traceClock() : 0;
      const body = this.pending.subarray(offset + 5, offset + 5 + length).toString("utf8");
      offset += 5 + length;
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: (error as Error).message });
        continue;
      }
      if (kind === "U" || kind === "H") {
        const decodedAt = tracing ? this.traceClock() : 0;
        try {
          const receipt = kind === "U" ? this.options.onUpdate(message as PipeVtUpdate)
            : this.options.onHistoryClear?.(message as { seq: number; epoch: number });
          // Messages stay ordered by awaiting the receipt here; stdout keeps
          // flowing into the bounded backlog instead of pausing per update.
          if (receipt && typeof (receipt as PromiseLike<unknown>).then === "function") await receipt;
          if (this.abandoned) return;
        } catch (error) {
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `consumer failed: ${String(error)}` });
        }
        if (tracing) this.emitTrace(message as PipeVtUpdate, length, arrivedAt, startedAt, decodedAt, this.traceClock());
      }
      else if (kind === "B") {
        this.quitAck = (message as { workerEof?: boolean }).workerEof === true;
      } else if (kind === "R") {
        this.readyResolve?.(message as PipeVtReady);
        this.readyResolve = null;
      } else if (kind === "E") {
        const error = message as { kind?: string; message?: string };
        this.notifyFault({
          kind: error.kind === "vendor-hash" ? "vendor-hash" : error.kind === "clear-policy-unknown" ? "clear-policy-unknown" : "worker-error",
          at: (this.options.now ?? Date.now)(),
          message: String(error.message ?? ""),
        });
      } else {
        this.notifyFault({ kind: "protocol", at: (this.options.now ?? Date.now)(), message: `unknown frame ${kind}` });
      }
    }
    this.pending = offset === this.pending.length ? Buffer.alloc(0) : this.pending.subarray(offset);
  }

  private write(parts: Buffer[], control = true): boolean {
    if (this.socket) {
      if (this.exited || this.socket.destroyed || !this.socket.writable) return false;
      const packet = Buffer.concat(parts);
      const limit = PIPE_VT_DATA_QUEUE_BYTES + (control ? PIPE_VT_CONTROL_RESERVE_BYTES : 0);
      if (this.socket.writableLength + packet.length > limit) return false;
      this.socket.write(packet);
      return true;
    }
    if (this.inputFd === null || this.exited) return false;
    const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const limit = PIPE_VT_DATA_QUEUE_BYTES + (control ? PIPE_VT_CONTROL_RESERVE_BYTES : 0);
    if (this.queuedBytes + bytes > limit) return false;
    this.queue.push(parts.length === 1 ? parts[0]! : Buffer.concat(parts));
    this.queuedBytes += bytes;
    this.flush();
    return this.inputFd !== null;
  }

  /** Write queued frames; a full FIFO (EAGAIN) retries shortly, never drops. */
  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.queue.length && this.inputFd !== null) {
      const head = this.queue[0]!;
      let written = 0;
      try {
        written = writeSync(this.inputFd, head);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
          this.releaseInput();
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `worker input failed: ${(error as Error).message}` });
          this.terminateChannel();
          return;
        }
      }
      if (written === head.length) {
        this.queuedBytes -= written;
        this.queue.shift();
        continue;
      }
      if (written > 0) { this.queuedBytes -= written; this.queue[0] = head.subarray(written); }
      this.flushTimer ??= setTimeout(() => this.flush(), 1);
      return;
    }
  }

  private releaseInput(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queue = [];
    this.queuedBytes = 0;
    if (this.inputFd !== null) {
      try { closeSync(this.inputFd); } catch {}
      this.inputFd = null;
    }
    if (this.inputDir) {
      rmSync(this.inputDir, { recursive: true, force: true });
      this.inputDir = null;
    }
  }

  /** Forward raw pipe bytes untouched; `seq` is the receive sequence. */
  canAccept(bytes: number): boolean {
    return !this.exited && (this.socket?.writableLength ?? this.queuedBytes) + bytes + 21 <= PIPE_VT_DATA_QUEUE_BYTES;
  }

  feed(seq: number, bytes: Uint8Array, epoch = 1): boolean {
    const prefix = Buffer.allocUnsafe(16);
    prefix.writeBigUInt64BE(BigInt(seq));
    prefix.writeBigUInt64BE(BigInt(epoch), 8);
    const fedAt = this.options.onStageTrace ? this.traceClock() : 0;
    const accepted = this.write([header("D", 16 + bytes.byteLength), prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)], false);
    if (accepted && this.options.onStageTrace) this.traceFeed(seq, fedAt);
    return accepted;
  }

  setScrollOnClear(enabled: boolean): boolean {
    return this.write([header("C", 1), Buffer.from([Number(enabled)])]);
  }

  /** Ordered parser reset: unlike RIS, drops alt, decoder, DCS and saved modes. */
  reset(epoch: number): boolean {
    const payload = Buffer.allocUnsafe(8);
    payload.writeBigUInt64BE(BigInt(epoch));
    return this.write([header("X", 8), payload]);
  }

  resize(cols: number, rows: number, geometryGeneration: number): boolean {
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt16BE(cols, 0);
    payload.writeUInt16BE(rows, 2);
    payload.writeUInt32BE(geometryGeneration >>> 0, 4);
    return this.write([header("Z", 8), payload]);
  }

  requestFull(seq: number): boolean {
    const payload = Buffer.allocUnsafe(8);
    payload.writeBigUInt64BE(BigInt(seq));
    return this.write([header("F", 8), payload]);
  }

  /**
   * Drain queued input, flush the last update, then wait for exit and for
   * every already-read update to be consumed. Both waits are bounded: a
   * consumer receipt that never settles ends in a `shutdown-timeout` fault
   * and the remaining output is dropped, so close always returns.
   */
  close(timeoutMs = 5_000): Promise<PipeVtDrainReceipt> {
    if (this.closePromise) return this.closePromise;
    if (!this.child && !this.lease) return Promise.resolve({ workerEof: false, outputDrained: false,
      issues: ["worker was never started"], unknownTail: true });
    this.closing = true;
    if (this.exited) return this.closePromise = this.settleOutput(timeoutMs, false,
      ["worker exited before orderly shutdown"]);
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const quitQueued = this.write([header("Q", 0)]);
    let forced = !quitQueued;
    if (!quitQueued) this.terminateChannel();
    const timer = setTimeout(() => {
      forced = true;
      this.terminateChannel();
      // A paused stdout never ends, so the close event would never fire.
      this.outputPaused = false;
      (this.socket ?? this.child?.stdout)?.resume();
    }, timeoutMs);
    return this.closePromise = exited.finally(() => clearTimeout(timer)).then(() => this.settleOutput(
      timeoutMs, quitQueued && !forced,
      forced ? [`worker did not exit after quit within ${timeoutMs}ms`] : [],
    ));
  }

  private settleOutput(timeoutMs: number, workerEof: boolean, issues: string[]): Promise<PipeVtDrainReceipt> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    return Promise.race([this.outputTail.then(() => "done" as const), deadline]).then(async (result) => {
      if (timer) clearTimeout(timer);
      const outputDrained = result === "done";
      if (!this.quitAck) {
        workerEof = false;
        issues.push("parser did not acknowledge Q after its final update");
      }
      if (!outputDrained) {
        this.abandoned = true;
        this.terminateChannel();
        issues.push(`worker output consumer did not settle within ${timeoutMs}ms; remaining updates dropped`);
        this.notifyFault({ kind: "shutdown-timeout", at: (this.options.now ?? Date.now)(), message: issues.at(-1)! });
      }
      await this.leaseDone;
      return { workerEof, outputDrained, issues, unknownTail: !workerEof || !outputDrained || issues.length > 0 };
    });
  }

  /** Test/fault hook: kill the worker without the orderly quit frame. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.lease) this.lease.kill(signal); else this.child?.kill(signal);
  }
}
