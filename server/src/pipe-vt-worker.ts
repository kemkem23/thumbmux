import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export const PIPE_VT_VENDOR_SHA256 = "626c68240ce421066a4c915fca0ca0b44576a274fc14d89cae85e6105a79940d";
export const PIPE_VT_WORKER_FILE = "pipe-vt-worker.py";
export const PIPE_VT_VENDOR_FILE = "pipe-vt-vendor.zip";
export const PIPE_VT_LICENSE_FILE = "pipe-vt-LICENSE.txt";

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
};

export type PipeVtReady = { vendorSha256: string; cols: number; rows: number; pid: number };

export type PipeVtFault = {
  kind: "worker-exit" | "worker-error" | "protocol" | "vendor-hash" | "spawn" | "clear-policy-unknown";
  at: number;
  message: string;
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
  sourceEpoch?: number;
  onHistoryClear?: (event: { seq: number; epoch: number }) => unknown;
  cols: number;
  rows: number;
  onUpdate: (update: PipeVtUpdate) => unknown;
  onFault: (fault: PipeVtFault) => void;
  assets?: PipeVtAssets;
  python?: string;
  now?: () => number;
};

function header(kind: string, length: number): Buffer {
  const out = Buffer.allocUnsafe(5);
  out.write(kind, 0, "latin1");
  out.writeUInt32BE(length, 1);
  return out;
}

export class PipeVtWorker {
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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
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
    child.stdout?.on("data", (chunk: Buffer) => {
      this.outputTail = this.outputTail.then(() => this.onStdout(chunk)).catch((error) => {
        this.notifyFault({ kind: "protocol", at: now(), message: String(error) });
      });
    });
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

  private async onStdout(chunk: Buffer): Promise<void> {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    while (this.pending.length - offset >= 5) {
      const kind = String.fromCharCode(this.pending[offset]!);
      const length = this.pending.readUInt32BE(offset + 1);
      if (length > 16 * 1024 * 1024) {
        this.pending = Buffer.alloc(0);
        this.child?.kill("SIGKILL");
        throw new Error("worker output exceeds 16 MiB frame bound");
      }
      if (this.pending.length - offset < 5 + length) break;
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
        try {
          const receipt = kind === "U" ? this.options.onUpdate(message as PipeVtUpdate)
            : this.options.onHistoryClear?.(message as { seq: number; epoch: number });
          if (receipt && typeof (receipt as PromiseLike<unknown>).then === "function") {
            // Bun's pipe pause/resume is costly at frame cadence. Only use it
            // when the consumer actually has an outstanding async receipt.
            this.child?.stdout?.pause();
            try { await receipt; } finally { this.child?.stdout?.resume(); }
          }
        } catch (error) {
          this.notifyFault({ kind: "worker-error", at: (this.options.now ?? Date.now)(), message: `consumer failed: ${String(error)}` });
        }
      }
      else if (kind === "R") {
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

  private write(parts: Buffer[]): boolean {
    if (this.inputFd === null || this.exited) return false;
    const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (this.queuedBytes + bytes > 1024 * 1024) return false;
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
          this.child?.kill("SIGKILL");
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
    return this.queuedBytes + bytes + 21 <= 1024 * 1024;
  }

  feed(seq: number, bytes: Uint8Array, epoch = 1): boolean {
    const prefix = Buffer.allocUnsafe(16);
    prefix.writeBigUInt64BE(BigInt(seq));
    prefix.writeBigUInt64BE(BigInt(epoch), 8);
    return this.write([header("D", 16 + bytes.byteLength), prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
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

  /** Drain queued input, flush the last update, then wait for exit. */
  close(timeoutMs = 5_000): Promise<void> {
    if (!this.child || this.exited) return Promise.resolve();
    this.closing = true;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.write([header("Q", 0)]);
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), timeoutMs);
    return exited.then(() => this.outputTail).finally(() => clearTimeout(timer));
  }

  /** Test/fault hook: kill the worker without the orderly quit frame. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child?.kill(signal);
  }
}
