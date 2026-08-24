import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createOutputWalStartCursor,
  parseOutputWalJson,
  readOutputWalTail,
  type OutputWalRecord,
  type OutputWalTailCursor,
} from "./output-wal";

/**
 * Durable raw-WAL -> terminal-grid materializer.
 *
 * The raw WAL is the lossless source of truth.  This module replays it through
 * a tmux server that is reachable only through a fresh, explicit `-S` socket;
 * it never connects to the user's ordinary tmux server. The replay pane's cat
 * reads a private named FIFO argument and writes only to the pane. It never
 * reads terminal stdin, so terminal-generated DSR/DA replies cannot loop back
 * into replay output. Bytes stay binary-safe without shell interpolation.
 *
 * WAL control payload schema (v1):
 *
 * - lifecycle: `{ event: "start" | "resume" | "end", identity, geometry }`
 * - resize: `{ phase: "prepare" | "commit" | "abort", changeId, from, to,
 *   reason? }`
 * - checkpoint: `{ event: "barrier", requestId }` (ordering barrier only)
 *
 * A resize is applied only after its matching commit.  Output between prepare
 * and commit/abort is rejected.  A WAL ending at prepare is materialized only
 * through the verified pre-resize state and reported incomplete; callers must
 * not advertise that cursor as fully resolved.
 *
 * Immutable tmux history is captured with `capture-pane -e -N`, appended to a
 * materialized ANSI log, fsynced, and then removed from the private emulator
 * with `clear-history`.  This bounds emulator memory and, importantly, drains
 * physical rows before any committed resize can reflow them.
 *
 * A checkpoint atomically binds the raw-WAL cursor, history byte length, and
 * current screen/cursor.  Recovery truncates only an uncommitted materialized
 * tail, replays the committed WAL prefix from byte zero, and verifies both the
 * stored history and screen byte-for-byte before appending anything new.  We
 * deliberately rebuild from raw bytes instead of trying to restore a captured
 * screen: tmux does not expose wrap flags, tab stops, scroll regions, or all VT
 * parser state, so a screen-only restore would make a later resize lossy.
 */

const CHECKPOINT_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_REPLAY_CHUNK_BYTES = 16 * 1024;
const DEFAULT_HISTORY_CAPTURE_ROWS = 256;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_HISTORY_LIMIT = 65_536;
const DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH = 1024 * 1024;
const COMMAND_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const MAX_COLS = 4_096;
const MAX_ROWS = 4_096;
const MAX_CELLS = 4_194_304;

export type TerminalReplayGeometry = {
  cols: number;
  rows: number;
};

export type TerminalReplayIdentity = {
  session: string;
  instanceId: string;
  paneTarget: string;
  tmuxServerPid: number;
  sessionCreated: number;
  /** Optional physical PTY epoch identity emitted by newer recorders. */
  sessionId?: string;
  windowId?: string;
  paneId?: string;
  generation?: string;
};

export type TerminalReplayLifecycle = {
  event: "start" | "resume" | "end";
  identity: TerminalReplayIdentity;
  geometry: TerminalReplayGeometry;
};

export type TerminalReplayResize = {
  phase: "prepare" | "commit" | "abort";
  changeId: string;
  from: TerminalReplayGeometry;
  to: TerminalReplayGeometry;
  reason?: string;
};

export type TerminalReplayBarrier = {
  event: "barrier";
  requestId: string;
};

export type TerminalReplayScreen = {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternateOn: boolean;
  mouseSgr: boolean;
  mouseAny: boolean;
  /** `capture-pane -e -N`, including one LF record terminator per row. */
  cellsBase64: string;
  /** Bytes held by tmux/chunker at an incomplete escape sequence or UTF-8 code point. */
  pendingEscapeBase64: string;
};

export type TerminalReplayCheckpoint = {
  version: 1;
  walPath: string;
  cursor: {
    walOffset: number;
    sequence: string;
  };
  historyBytes: number;
  lifecycle: "none" | "active" | "ended";
  identity: TerminalReplayIdentity | null;
  geometry: TerminalReplayGeometry | null;
  pendingResize: TerminalReplayResize | null;
  screen: TerminalReplayScreen | null;
};

export type TerminalReplayMaterializerOptions = {
  walPath: string;
  stateDir: string;
  /** Defaults to `<stateDir>/history.ansi`. */
  historyPath?: string;
  /** Defaults to `<stateDir>/checkpoint.json`. */
  checkpointPath?: string;
  tmuxCommand?: string;
  /** Tests/hosts may supply a fresh absolute socket path. It must not exist. */
  socketPath?: string;
  replayChunkBytes?: number;
  historyCaptureRows?: number;
  historyLimit?: number;
  commandTimeoutMs?: number;
  /**
   * Preferred raw-WAL frame budget for open/refresh. Defaults to 1 MiB.
   * A single complete WAL record larger than this is accepted to guarantee
   * progress; producers should therefore keep output records independently
   * bounded (the shipped PTY proxy caps them at 64 KiB).
   */
  maxWalFrameBytesPerRefresh?: number;
};

export type TerminalReplayResult = {
  complete: boolean;
  verified: boolean;
  recoveredFromCheckpoint: boolean;
  ended: boolean;
  walOffset: number;
  sequence: bigint;
  /** More complete WAL records were visible after this bounded checkpoint. */
  hasMoreWal: boolean;
  historyBytes: number;
  identity: TerminalReplayIdentity | null;
  geometry: TerminalReplayGeometry | null;
  pendingResize: TerminalReplayResize | null;
  screen: TerminalReplayScreen | null;
  historyPath: string;
  checkpointPath: string;
};

type LifecycleState = "none" | "active" | "ended";
type HistoryMode = "verify" | "append";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return selected;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseGeometry(value: unknown, label: string): TerminalReplayGeometry {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const cols = safeInteger(value.cols, `${label}.cols`, 1);
  const rows = safeInteger(value.rows, `${label}.rows`, 1);
  if (cols > MAX_COLS || rows > MAX_ROWS || cols * rows > MAX_CELLS) {
    throw new Error(`${label} exceeds the replay geometry bound`);
  }
  return { cols, rows };
}

function parseIdentity(value: unknown, label: string): TerminalReplayIdentity {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const optional = (field: "sessionId" | "windowId" | "paneId" | "generation") => (
    value[field] === undefined ? undefined : nonEmptyString(value[field], `${label}.${field}`)
  );
  return {
    session: nonEmptyString(value.session, `${label}.session`),
    instanceId: nonEmptyString(value.instanceId, `${label}.instanceId`),
    paneTarget: nonEmptyString(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: safeInteger(value.tmuxServerPid, `${label}.tmuxServerPid`, 1),
    sessionCreated: safeInteger(value.sessionCreated, `${label}.sessionCreated`, 0),
    ...(optional("sessionId") === undefined ? {} : { sessionId: optional("sessionId") }),
    ...(optional("windowId") === undefined ? {} : { windowId: optional("windowId") }),
    ...(optional("paneId") === undefined ? {} : { paneId: optional("paneId") }),
    ...(optional("generation") === undefined ? {} : { generation: optional("generation") }),
  };
}

function parseLifecycle(value: unknown): TerminalReplayLifecycle {
  if (!isObject(value)) throw new Error("lifecycle WAL payload must be an object");
  if (value.event !== "start" && value.event !== "resume" && value.event !== "end") {
    throw new Error("lifecycle.event must be start, resume, or end");
  }
  return {
    event: value.event,
    identity: parseIdentity(value.identity, "lifecycle.identity"),
    geometry: parseGeometry(value.geometry, "lifecycle.geometry"),
  };
}

function parseResize(value: unknown): TerminalReplayResize {
  if (!isObject(value)) throw new Error("resize WAL payload must be an object");
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error("resize.phase must be prepare, commit, or abort");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("resize.reason must be a string when present");
  }
  return {
    phase: value.phase,
    changeId: nonEmptyString(value.changeId, "resize.changeId"),
    from: parseGeometry(value.from, "resize.from"),
    to: parseGeometry(value.to, "resize.to"),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function parseBarrier(value: unknown): TerminalReplayBarrier {
  if (!isObject(value) || value.event !== "barrier") {
    throw new Error("checkpoint WAL payload must be a barrier object");
  }
  return {
    event: "barrier",
    requestId: nonEmptyString(value.requestId, "checkpoint.requestId"),
  };
}

function sameGeometry(a: TerminalReplayGeometry, b: TerminalReplayGeometry): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function sameIdentity(a: TerminalReplayIdentity, b: TerminalReplayIdentity): boolean {
  return a.session === b.session
    && a.instanceId === b.instanceId
    && a.paneTarget === b.paneTarget
    && a.tmuxServerPid === b.tmuxServerPid
    && a.sessionCreated === b.sessionCreated
    && a.sessionId === b.sessionId
    && a.windowId === b.windowId
    && a.paneId === b.paneId
    && a.generation === b.generation;
}

function sameResize(a: TerminalReplayResize, b: TerminalReplayResize): boolean {
  return a.changeId === b.changeId
    && sameGeometry(a.from, b.from)
    && sameGeometry(a.to, b.to);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeAll(fd: number, bytes: Uint8Array, position?: number): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(
      fd,
      bytes,
      written,
      bytes.byteLength - written,
      position === undefined ? null : position + written,
    );
    if (count <= 0) throw new Error("terminal replay write made no progress");
    written += count;
  }
}

function readExact(fd: number, length: number, position: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, bytes, read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  if (read !== length) {
    throw new Error(`terminal replay expected ${length} bytes at ${position}, got ${read}`);
  }
  return bytes;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function writeAtomicJson(path: string, value: unknown): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_DSYNC,
    PRIVATE_FILE_MODE,
  );
  try {
    writeAll(fd, body);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function validBase64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}

function parseScreen(value: unknown): TerminalReplayScreen {
  if (!isObject(value)) throw new Error("checkpoint.screen must be an object");
  const geometry = parseGeometry(value, "checkpoint.screen");
  const cursorX = safeInteger(value.cursorX, "checkpoint.screen.cursorX", 0);
  const cursorY = safeInteger(value.cursorY, "checkpoint.screen.cursorY", 0);
  if (cursorX >= geometry.cols || cursorY >= geometry.rows) {
    throw new Error("checkpoint screen cursor lies outside its geometry");
  }
  for (const field of ["cursorVisible", "alternateOn", "mouseSgr", "mouseAny"] as const) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`checkpoint.screen.${field} must be boolean`);
    }
  }
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: value.cursorVisible as boolean,
    alternateOn: value.alternateOn as boolean,
    mouseSgr: value.mouseSgr as boolean,
    mouseAny: value.mouseAny as boolean,
    cellsBase64: validBase64(value.cellsBase64, "checkpoint.screen.cellsBase64"),
    pendingEscapeBase64: validBase64(
      value.pendingEscapeBase64,
      "checkpoint.screen.pendingEscapeBase64",
    ),
  };
}

function parseCheckpoint(value: unknown): TerminalReplayCheckpoint {
  if (!isObject(value) || value.version !== CHECKPOINT_VERSION) {
    throw new Error(`unsupported terminal replay checkpoint version`);
  }
  if (!isObject(value.cursor)) throw new Error("checkpoint.cursor must be an object");
  const sequence = nonEmptyString(value.cursor.sequence, "checkpoint.cursor.sequence");
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) {
    throw new Error("checkpoint.cursor.sequence must be an unsigned decimal bigint");
  }
  if (value.lifecycle !== "none" && value.lifecycle !== "active" && value.lifecycle !== "ended") {
    throw new Error("checkpoint.lifecycle is invalid");
  }
  const identity = value.identity === null ? null : parseIdentity(value.identity, "checkpoint.identity");
  const geometry = value.geometry === null ? null : parseGeometry(value.geometry, "checkpoint.geometry");
  const pendingResize = value.pendingResize === null ? null : parseResize(value.pendingResize);
  const screen = value.screen === null ? null : parseScreen(value.screen);
  if (value.lifecycle === "none" && (identity || geometry || screen || pendingResize)) {
    throw new Error("empty checkpoint must not carry terminal state");
  }
  if (value.lifecycle !== "none" && (!identity || !geometry || !screen)) {
    throw new Error("active/ended checkpoint is missing terminal state");
  }
  if (geometry && screen && !sameGeometry(geometry, screen)) {
    throw new Error("checkpoint geometry and screen geometry differ");
  }
  if (pendingResize && pendingResize.phase !== "prepare") {
    throw new Error("checkpoint.pendingResize must be a prepare record");
  }
  if (value.lifecycle !== "active" && pendingResize) {
    throw new Error("only an active checkpoint may carry a pending resize");
  }
  return {
    version: 1,
    walPath: nonEmptyString(value.walPath, "checkpoint.walPath"),
    cursor: {
      walOffset: safeInteger(value.cursor.walOffset, "checkpoint.cursor.walOffset", 0),
      sequence,
    },
    historyBytes: safeInteger(value.historyBytes, "checkpoint.historyBytes", 0),
    lifecycle: value.lifecycle,
    identity,
    geometry,
    pendingResize,
    screen,
  };
}

export function readTerminalReplayCheckpoint(path: string): TerminalReplayCheckpoint | null {
  if (!existsSync(path)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse terminal replay checkpoint ${path}: ${String(error)}`);
  }
  return parseCheckpoint(decoded);
}

function sameScreen(a: TerminalReplayScreen | null, b: TerminalReplayScreen | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameNullableIdentity(
  a: TerminalReplayIdentity | null,
  b: TerminalReplayIdentity | null,
): boolean {
  return a === null ? b === null : b !== null && sameIdentity(a, b);
}

function sameNullableGeometry(
  a: TerminalReplayGeometry | null,
  b: TerminalReplayGeometry | null,
): boolean {
  return a === null ? b === null : b !== null && sameGeometry(a, b);
}

function sameNullableResize(
  a: TerminalReplayResize | null,
  b: TerminalReplayResize | null,
): boolean {
  return a === null ? b === null : b !== null && a.phase === b.phase && sameResize(a, b);
}

class MaterializedHistoryFile {
  private fd: number;
  private readonly committedBytes: number;
  private derivedBytes = 0;
  private writePosition: number;

  constructor(
    readonly path: string,
    checkpoint: TerminalReplayCheckpoint | null,
  ) {
    const directory = dirname(path);
    ensurePrivateDirectory(directory);
    const existed = existsSync(path);
    this.fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_DSYNC,
      PRIVATE_FILE_MODE,
    );
    chmodSync(path, PRIVATE_FILE_MODE);
    if (!existed) fsyncDirectory(directory);

    this.committedBytes = checkpoint?.historyBytes ?? 0;
    const currentBytes = fstatSync(this.fd).size;
    if (currentBytes < this.committedBytes) {
      this.close();
      throw new Error(
        `materialized history is ${currentBytes} bytes, below committed ${this.committedBytes}`,
      );
    }
    // Bytes after the atomic checkpoint are an uncommitted crash tail.  The
    // raw WAL still owns them, so trimming only this derived suffix is safe.
    if (currentBytes > this.committedBytes) {
      truncateSync(path, this.committedBytes);
      fdatasyncSync(this.fd);
    }
    this.writePosition = this.committedBytes;
  }

  accept(bytes: Uint8Array, mode: HistoryMode): void {
    if (bytes.byteLength === 0) return;
    if (mode === "verify") {
      if (this.derivedBytes + bytes.byteLength > this.committedBytes) {
        throw new Error("replayed history exceeds the committed checkpoint length");
      }
      const expected = readExact(this.fd, bytes.byteLength, this.derivedBytes);
      if (!expected.equals(Buffer.from(bytes))) {
        throw new Error(`replayed history differs at byte ${this.derivedBytes}`);
      }
    } else {
      if (this.derivedBytes !== this.writePosition) {
        throw new Error(
          `materialized history cursor diverged: ${this.derivedBytes}/${this.writePosition}`,
        );
      }
      writeAll(this.fd, bytes, this.writePosition);
      this.writePosition += bytes.byteLength;
    }
    this.derivedBytes += bytes.byteLength;
  }

  finishVerification(): void {
    if (this.derivedBytes !== this.committedBytes) {
      throw new Error(
        `replayed history length ${this.derivedBytes} differs from committed ${this.committedBytes}`,
      );
    }
  }

  flush(): void {
    fdatasyncSync(this.fd);
  }

  get bytes(): number {
    return this.writePosition;
  }

  close(): void {
    if (this.fd < 0) return;
    fdatasyncSync(this.fd);
    closeSync(this.fd);
    this.fd = -1;
  }
}

type PrivateTmuxOptions = {
  command: string;
  socketPath?: string;
  replayChunkBytes: number;
  historyCaptureRows: number;
  historyLimit: number;
  commandTimeoutMs: number;
};

/**
 * Splits raw output at VT token boundaries, rather than arbitrary byte
 * boundaries.  tmux can turn one `CSI Ps S` into as many history rows as the
 * pane is tall, so byte-sized batching alone is not a safe bound.
 *
 * An incomplete CSI or UTF-8 code point is deliberately not sent to tmux yet.
 * It survives WAL record boundaries in `pendingBytes` and is reported in the
 * durable screen checkpoint. All complete bytes flush before `accept` returns.
 */
class StatefulVtReplayChunker {
  private readonly batchParts: Buffer[] = [];
  private batchBytes = 0;
  private batchRowEffect = 0;
  private pendingParts: Buffer[] = [];
  private pendingLength = 0;
  private pendingIsCsi = false;
  private pendingUtf8Expected = 0;

  constructor(
    private readonly maxBatchBytes: number,
    private readonly rowEffectBudget: number,
  ) {}

  private flush(emit: (chunk: Uint8Array) => void): void {
    if (this.batchBytes === 0) return;
    emit(Buffer.concat(this.batchParts, this.batchBytes));
    this.batchParts.length = 0;
    this.batchBytes = 0;
    this.batchRowEffect = 0;
  }

  private addAtomic(
    token: Buffer,
    rowEffect: number,
    emit: (chunk: Uint8Array) => void,
  ): void {
    if (this.batchBytes > 0
      && (this.batchBytes + token.byteLength > this.maxBatchBytes
        || this.batchRowEffect + rowEffect > this.rowEffectBudget)) {
      this.flush(emit);
    }
    this.batchParts.push(token);
    this.batchBytes += token.byteLength;
    this.batchRowEffect += rowEffect;
    // A single atomic CSI may be larger than the byte limit.  It is still one
    // token, and its row effect is independently bounded below history-limit.
    if (this.batchBytes >= this.maxBatchBytes
      || this.batchRowEffect >= this.rowEffectBudget) {
      this.flush(emit);
    }
  }

  private addOrdinary(
    bytes: Uint8Array,
    emit: (chunk: Uint8Array) => void,
  ): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.batchBytes >= this.maxBatchBytes
        || this.batchRowEffect >= this.rowEffectBudget) {
        this.flush(emit);
      }
      const availableBytes = this.maxBatchBytes - this.batchBytes;
      const availableRows = this.rowEffectBudget - this.batchRowEffect;
      const take = Math.min(bytes.byteLength - offset, availableBytes, availableRows);
      if (take <= 0) {
        this.flush(emit);
        continue;
      }
      this.batchParts.push(Buffer.from(bytes.subarray(offset, offset + take)));
      this.batchBytes += take;
      // Conservatively, every ordinary byte may scroll one physical row.
      this.batchRowEffect += take;
      offset += take;
    }
  }

  private appendPending(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.pendingParts.push(Buffer.from(bytes));
    this.pendingLength += bytes.byteLength;
  }

  private takePending(): Buffer {
    const pending = Buffer.concat(this.pendingParts, this.pendingLength);
    this.pendingParts = [];
    this.pendingLength = 0;
    this.pendingIsCsi = false;
    this.pendingUtf8Expected = 0;
    return pending;
  }

  private utf8Length(first: number): number {
    if (first >= 0xc2 && first <= 0xdf) return 2;
    if (first >= 0xe0 && first <= 0xef) return 3;
    if (first >= 0xf0 && first <= 0xf4) return 4;
    return 1;
  }

  private csiRowEffect(token: Buffer, rows: number): number {
    const final = token[token.byteLength - 1];
    if (final !== 0x53) return token.byteLength; // CSI ... S (scroll up)
    const parameter = token.subarray(2, -1).toString("ascii");
    // Unknown/private parameter forms are bounded by a full-pane scroll.
    if (!/^[0-9]*$/.test(parameter)) return rows;
    const requested = parameter === "" || parameter === "0"
      ? 1
      : Math.min(Number(parameter), rows);
    return Math.max(1, Math.min(requested, rows));
  }

  accept(
    bytes: Uint8Array,
    rows: number,
    emit: (chunk: Uint8Array) => void,
  ): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.pendingLength > 0) {
        if (this.pendingUtf8Expected > 0) {
          const needed = this.pendingUtf8Expected - this.pendingLength;
          const take = Math.min(needed, bytes.byteLength - offset);
          this.appendPending(bytes.subarray(offset, offset + take));
          offset += take;
          if (this.pendingLength === this.pendingUtf8Expected) {
            const token = this.takePending();
            this.addAtomic(token, token.byteLength, emit);
          }
          continue;
        }
        if (!this.pendingIsCsi) {
          const next = bytes[offset]!;
          this.appendPending(bytes.subarray(offset, offset + 1));
          offset += 1;
          if (next === 0x5b) {
            this.pendingIsCsi = true;
          } else {
            const token = this.takePending();
            this.addAtomic(token, token.byteLength, emit);
          }
          continue;
        }

        let end = offset;
        while (end < bytes.byteLength && !(bytes[end]! >= 0x40 && bytes[end]! <= 0x7e)) {
          end += 1;
        }
        if (end === bytes.byteLength) {
          this.appendPending(bytes.subarray(offset));
          offset = bytes.byteLength;
          break;
        }
        this.appendPending(bytes.subarray(offset, end + 1));
        offset = end + 1;
        const token = this.takePending();
        this.addAtomic(token, this.csiRowEffect(token, rows), emit);
        continue;
      }

      let special = offset;
      while (special < bytes.byteLength
        && bytes[special] !== 0x1b
        && bytes[special]! < 0x80) {
        special += 1;
      }
      if (special > offset) {
        this.addOrdinary(bytes.subarray(offset, special), emit);
        offset = special;
      }
      if (offset < bytes.byteLength && bytes[offset] === 0x1b) {
        this.appendPending(bytes.subarray(offset, offset + 1));
        this.pendingIsCsi = false;
        offset += 1;
      } else if (offset < bytes.byteLength) {
        const expected = this.utf8Length(bytes[offset]!);
        if (expected === 1) {
          this.addOrdinary(bytes.subarray(offset, offset + 1), emit);
          offset += 1;
        } else if (offset + expected <= bytes.byteLength) {
          const token = Buffer.from(bytes.subarray(offset, offset + expected));
          this.addAtomic(token, token.byteLength, emit);
          offset += expected;
        } else {
          this.appendPending(bytes.subarray(offset));
          this.pendingUtf8Expected = expected;
          offset = bytes.byteLength;
        }
      }
    }
    this.flush(emit);
  }

  get pendingBytes(): Buffer {
    return Buffer.concat(this.pendingParts, this.pendingLength);
  }

  reset(): void {
    this.batchParts.length = 0;
    this.batchBytes = 0;
    this.batchRowEffect = 0;
    this.pendingParts = [];
    this.pendingLength = 0;
    this.pendingIsCsi = false;
    this.pendingUtf8Expected = 0;
  }
}

class PrivateTmuxReplay {
  private readonly command: string;
  private readonly replayChunkBytes: number;
  private readonly historyCaptureRows: number;
  private readonly historyLimit: number;
  private readonly commandTimeoutMs: number;
  private readonly temporaryRoot: string;
  private readonly mirrorPath: string;
  private readonly inputFifoPath: string;
  private readonly configPath: string;
  private readonly session: string;
  private readonly target: string;
  readonly socketPath: string;
  private started = false;
  private inputFd = -1;
  private peakMirrorBytes = 0;
  private readonly chunker: StatefulVtReplayChunker;

  constructor(options: PrivateTmuxOptions) {
    this.command = options.command;
    this.replayChunkBytes = options.replayChunkBytes;
    this.historyCaptureRows = options.historyCaptureRows;
    this.historyLimit = options.historyLimit;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.chunker = new StatefulVtReplayChunker(
      this.replayChunkBytes,
      Math.max(1, this.historyLimit - MAX_ROWS),
    );
    if (options.socketPath && !isAbsolute(options.socketPath)) {
      throw new Error("terminal replay socketPath must be absolute");
    }
    if (options.socketPath && existsSync(options.socketPath)) {
      throw new Error(`terminal replay socket already exists: ${options.socketPath}`);
    }
    this.temporaryRoot = mkdtempSync(join(tmpdir(), "thumbmux-terminal-replay-"));
    chmodSync(this.temporaryRoot, PRIVATE_DIRECTORY_MODE);
    this.mirrorPath = join(this.temporaryRoot, "raw-output.mirror");
    const mirrorFd = openSync(
      this.mirrorPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    closeSync(mirrorFd);
    this.inputFifoPath = join(this.temporaryRoot, "replay-input.fifo");
    const fifo = spawnSync("mkfifo", ["-m", "600", this.inputFifoPath], {
      encoding: null,
      timeout: this.commandTimeoutMs,
      windowsHide: true,
    });
    if (fifo.error || fifo.status !== 0 || !statSync(this.inputFifoPath).isFIFO()) {
      const detail = Buffer.from(fifo.stderr ?? []).toString("utf8").trim();
      rmSync(this.temporaryRoot, { recursive: true, force: true });
      throw new Error(`cannot create private replay FIFO${detail ? `: ${detail}` : ""}`);
    }
    this.configPath = join(this.temporaryRoot, "tmux.conf");
    const configFd = openSync(
      this.configPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_DSYNC,
      PRIVATE_FILE_MODE,
    );
    try {
      // history-limit is copied when a pane is created; setting it afterwards
      // does not enlarge an existing pane's ring. Load this private config on
      // the very first server command so burst chunks cannot wrap at tmux's
      // default 2,000 rows before the materializer gets a chance to drain.
      writeAll(configFd, Buffer.from(
        `set-option -g history-limit ${this.historyLimit}\nset-option -g status off\n`,
        "utf8",
      ));
      fdatasyncSync(configFd);
    } finally {
      closeSync(configFd);
    }
    fsyncDirectory(this.temporaryRoot);
    this.socketPath = options.socketPath ?? join(this.temporaryRoot, "tmux.sock");
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    this.session = `sh-thumbmux-replay-${suffix}`;
    this.target = `=${this.session}:0.0`;
  }

  private run(args: readonly string[], input?: Uint8Array): Buffer {
    const result = spawnSync(
      this.command,
      ["-S", this.socketPath, ...args],
      {
        input,
        encoding: null,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        timeout: this.commandTimeoutMs,
        windowsHide: true,
      },
    );
    if (result.error) {
      throw new Error(`private tmux ${args[0] ?? "command"} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim();
      throw new Error(
        `private tmux ${args[0] ?? "command"} exited ${String(result.status)}`
        + (detail ? `: ${detail}` : ""),
      );
    }
    return Buffer.from(result.stdout ?? []);
  }

  private format(format: string): string {
    return this.run(["display-message", "-p", "-t", this.target, format])
      .toString("utf8")
      .replace(/\n$/, "");
  }

  private waitFor(
    description: string,
    predicate: () => boolean,
  ): void {
    const deadline = Date.now() + this.commandTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() <= deadline) {
      try {
        if (predicate()) return;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      sleepSync(2);
    }
    throw new Error(
      `timed out waiting for private tmux ${description}`
      + (lastError ? `: ${String(lastError)}` : ""),
    );
  }

  private replayCommand(): string {
    const quotedFifo = `'${this.inputFifoPath.replaceAll("'", "'\\''")}'`;
    // cat receives the FIFO as a file argument.  Its terminal stdin is never
    // read, so DSR/DA replies written by tmux cannot feed back into output.
    return `stty raw -echo; exec cat -- ${quotedFifo}`;
  }

  private attachMirror(): void {
    truncateSync(this.mirrorPath, 0);
    const quotedMirror = `'${this.mirrorPath.replaceAll("'", "'\\''")}'`;
    this.run([
      "pipe-pane",
      "-O",
      "-t",
      this.target,
      `exec cat >> ${quotedMirror}`,
    ]);
    this.waitFor("pipe attachment", () => this.format("#{pane_pipe}") === "1");
  }

  private waitForCat(): void {
    this.waitFor("cat startup", () => {
      const [command, dead] = this.format("#{pane_current_command}|#{pane_dead}").split("|");
      if (dead === "1") throw new Error("private replay pane died during startup");
      return command === "cat";
    });
  }

  start(geometry: TerminalReplayGeometry): void {
    if (this.started) throw new Error("private terminal replay pane already exists");
    // -f is effective only when this first command starts the fresh server.
    // The generated private config contains only deterministic replay options.
    this.run([
      "-f",
      this.configPath,
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows),
      this.replayCommand(),
    ]);
    this.started = true;
    this.waitForCat();
    const configuredLimit = safeInteger(
      Number(this.run(["show-options", "-gv", "history-limit"]).toString("utf8").trim()),
      "private replay history-limit",
      1,
    );
    if (configuredLimit !== this.historyLimit) {
      throw new Error(
        `private replay history-limit is ${configuredLimit}, expected ${this.historyLimit}`,
      );
    }
    this.run(["clear-history", "-t", this.target]);

    // This bounded raw mirror is an out-of-band completion fence. It is
    // truncated after every batch, so storage is O(max batch), not O(WAL).
    this.attachMirror();
    this.inputFd = openSync(this.inputFifoPath, constants.O_WRONLY);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(
        `private replay pane started at ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`,
      );
    }
  }

  private ensureAlive(): void {
    if (!this.started) throw new Error("private terminal replay pane is not started");
    if (this.format("#{pane_dead}") === "1") {
      throw new Error("private terminal replay pane died");
    }
  }

  private waitForMirroredBytes(expected: Uint8Array): void {
    this.waitFor(`${expected.byteLength} mirrored output bytes`, () => {
      const size = statSync(this.mirrorPath).size;
      this.peakMirrorBytes = Math.max(this.peakMirrorBytes, size);
      if (size > expected.byteLength) {
        throw new Error(
          `private replay emitted unexpected bytes: ${size} > ${expected.byteLength}`,
        );
      }
      return size === expected.byteLength;
    });
    const mirrorFd = openSync(this.mirrorPath, constants.O_RDONLY);
    let actual: Buffer;
    try {
      actual = readExact(mirrorFd, expected.byteLength, 0);
    } finally {
      closeSync(mirrorFd);
    }
    if (!actual.equals(Buffer.from(expected))) {
      throw new Error("private replay changed output bytes in the current replay batch");
    }
    truncateSync(this.mirrorPath, 0);
    this.ensureAlive();
  }

  private feedChunk(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.inputFd < 0) {
      throw new Error("private replay FIFO writer is not open");
    }
    if (statSync(this.mirrorPath).size !== 0) {
      throw new Error("private replay mirror was not empty at batch start");
    }
    writeAll(this.inputFd, bytes);
    this.waitForMirroredBytes(bytes);
  }

  feed(
    bytes: Uint8Array,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    this.chunker.accept(bytes, this.currentGeometry().rows, (chunk) => {
      this.feedChunk(chunk);
      this.drainHistory(onHistory);
    });
    if (bytes.byteLength === 0) this.drainHistory(onHistory);
  }

  currentGeometry(): TerminalReplayGeometry {
    const [colsText, rowsText] = this.format("#{pane_width}|#{pane_height}").split("|");
    return {
      cols: safeInteger(Number(colsText), "private replay pane width", 1),
      rows: safeInteger(Number(rowsText), "private replay pane height", 1),
    };
  }

  resize(
    geometry: TerminalReplayGeometry,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    this.drainHistory(onHistory);
    this.run([
      "resize-window",
      "-t",
      this.target,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows),
    ]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(
        `private replay resize produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`,
      );
    }
    // Shrinking a pane may move physical rows into history.  Commit those rows
    // immediately so no later resize can reflow them a second time.
    this.drainHistory(onHistory);
  }

  /**
   * Commit the old PTY generation's final visible rows exactly once, then
   * replace the emulator pane with a genuinely blank terminal.  Repainting a
   * screenshot cannot reset hidden VT modes, tab stops, or parser state.
   */
  sealVisibleAndReset(
    geometry: TerminalReplayGeometry,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    this.drainHistory(onHistory);
    const oldScreen = this.captureScreen();
    onHistory(Buffer.from(oldScreen.cellsBase64, "base64"));

    if (this.inputFd < 0) throw new Error("private replay FIFO writer is not open");
    const previousWriter = this.inputFd;
    truncateSync(this.mirrorPath, 0);
    // Keep the previous FIFO writer open until the replacement cat has opened
    // its read end; otherwise the last pane can exit before respawn completes.
    this.run([
      "respawn-pane",
      "-k",
      "-t",
      this.target,
      this.replayCommand(),
    ]);
    this.waitForCat();
    if (this.format("#{pane_pipe}") !== "1") this.attachMirror();
    const replacementWriter = openSync(this.inputFifoPath, constants.O_WRONLY);
    this.inputFd = replacementWriter;
    closeSync(previousWriter);
    this.chunker.reset();
    this.run(["clear-history", "-t", this.target]);

    const current = this.currentGeometry();
    if (!sameGeometry(current, geometry)) {
      this.run([
        "resize-window",
        "-t",
        this.target,
        "-x",
        String(geometry.cols),
        "-y",
        String(geometry.rows),
      ]);
    }
    this.run(["clear-history", "-t", this.target]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(
        `private replay generation reset produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`,
      );
    }
  }

  private historySize(): number {
    const text = this.format("#{history_size}");
    return safeInteger(Number(text), "private replay history_size", 0);
  }

  drainHistory(onHistory: (captured: Uint8Array) => void): void {
    const historySize = this.historySize();
    if (historySize === 0) return;
    for (let start = -historySize; start <= -1; start += this.historyCaptureRows) {
      const end = Math.min(-1, start + this.historyCaptureRows - 1);
      const expectedRows = end - start + 1;
      const captured = this.run([
        "capture-pane",
        "-p",
        "-e",
        "-N",
        "-t",
        this.target,
        "-S",
        String(start),
        "-E",
        String(end),
      ]);
      let terminators = 0;
      for (const byte of captured) if (byte === 0x0a) terminators += 1;
      if (terminators !== expectedRows) {
        throw new Error(
          `capture-pane returned ${terminators} rows, expected ${expectedRows}`,
        );
      }
      onHistory(captured);
    }
    this.run(["clear-history", "-t", this.target]);
    const remaining = this.historySize();
    if (remaining !== 0) {
      throw new Error(`private replay clear-history left ${remaining} rows`);
    }
  }

  captureScreen(): TerminalReplayScreen {
    const historySize = this.historySize();
    if (historySize !== 0) {
      throw new Error(`cannot checkpoint with ${historySize} undrained history rows`);
    }
    const statusFormat = [
      "#{cursor_x}",
      "#{cursor_y}",
      "#{pane_width}",
      "#{pane_height}",
      "#{history_size}",
      "#{cursor_flag}",
      "#{alternate_on}",
      "#{mouse_sgr_flag}",
      "#{mouse_any_flag}",
    ].join("|");
    const output = this.run([
      "display-message",
      "-p",
      "-t",
      this.target,
      statusFormat,
      ";",
      "capture-pane",
      "-p",
      "-e",
      "-N",
      "-t",
      this.target,
      "-S",
      "0",
      "-E",
      "-",
      ";",
      "capture-pane",
      "-p",
      "-P",
      "-t",
      this.target,
    ]);
    const statusEnd = output.indexOf(0x0a);
    if (statusEnd < 0) throw new Error("private replay screen status has no terminator");
    const status = output.subarray(0, statusEnd).toString("utf8").split("|");
    if (status.length !== 9) throw new Error("private replay screen status is malformed");
    const [x, y, cols, rows, history, cursor, alternate, mouseSgr, mouseAny] = status.map(Number);
    if (history !== 0) throw new Error("private replay history changed during checkpoint capture");
    const geometry = parseGeometry({ cols, rows }, "private replay checkpoint geometry");

    let screenEnd = statusEnd + 1;
    for (let row = 0; row < geometry.rows; row += 1) {
      screenEnd = output.indexOf(0x0a, screenEnd);
      if (screenEnd < 0) throw new Error("private replay screen capture is truncated");
      screenEnd += 1;
    }
    const cells = output.subarray(statusEnd + 1, screenEnd);
    const pendingWithTerminator = output.subarray(screenEnd);
    if (pendingWithTerminator.byteLength === 0
      || pendingWithTerminator[pendingWithTerminator.byteLength - 1] !== 0x0a) {
      throw new Error("private replay pending-sequence capture has no terminator");
    }
    const tmuxPending = pendingWithTerminator.subarray(0, -1);
    const pending = Buffer.concat([tmuxPending, this.chunker.pendingBytes]);
    const cursorX = safeInteger(x, "private replay cursor_x", 0);
    const cursorY = safeInteger(y, "private replay cursor_y", 0);
    if (cursorX >= geometry.cols || cursorY >= geometry.rows) {
      throw new Error("private replay cursor lies outside pane geometry");
    }
    return {
      ...geometry,
      cursorX,
      cursorY,
      cursorVisible: cursor === 1,
      alternateOn: alternate === 1,
      mouseSgr: mouseSgr === 1,
      mouseAny: mouseAny === 1,
      cellsBase64: cells.toString("base64"),
      pendingEscapeBase64: pending.toString("base64"),
    };
  }

  close(): void {
    if (this.started) {
      try { this.run(["pipe-pane", "-t", this.target]); } catch { /* private server may be gone */ }
      // This socket is freshly allocated and owned solely by this instance.
      // kill-server cannot affect any host/user tmux session.
      try { this.run(["kill-server"]); } catch { /* best effort */ }
      this.started = false;
    }
    if (this.inputFd >= 0) {
      try { closeSync(this.inputFd); } catch { /* best effort */ }
      this.inputFd = -1;
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* best effort */ }
    }
    rmSync(this.temporaryRoot, { recursive: true, force: true });
  }

  get boundedMirrorPath(): string {
    return this.mirrorPath;
  }

  get peakBoundedMirrorBytes(): number {
    return this.peakMirrorBytes;
  }
}

type ReplaySnapshot = {
  lifecycle: LifecycleState;
  identity: TerminalReplayIdentity | null;
  geometry: TerminalReplayGeometry | null;
  pendingResize: TerminalReplayResize | null;
  screen: TerminalReplayScreen | null;
};

class ReplayEngine {
  private lifecycle: LifecycleState = "none";
  private identity: TerminalReplayIdentity | null = null;
  private geometry: TerminalReplayGeometry | null = null;
  private pendingResize: TerminalReplayResize | null = null;
  private recordsSeen = 0;

  constructor(private readonly tmux: PrivateTmuxReplay) {}

  private requireActive(record: OutputWalRecord): void {
    if (this.lifecycle !== "active" || !this.identity || !this.geometry) {
      throw new Error(
        `WAL ${record.kind} record ${record.sequence} appears outside an active lifecycle`,
      );
    }
  }

  private requireLogicalIdentity(next: TerminalReplayIdentity, label: string): void {
    if (!this.identity
      || next.session !== this.identity.session
      || next.instanceId !== this.identity.instanceId) {
      throw new Error(`${label} changes the WAL logical session identity`);
    }
  }

  private processLifecycle(
    record: OutputWalRecord,
    value: TerminalReplayLifecycle,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    if (value.event === "start") {
      if (this.recordsSeen !== 0 || this.lifecycle !== "none") {
        throw new Error("lifecycle start must be the first WAL record and may appear only once");
      }
      this.tmux.start(value.geometry);
      this.lifecycle = "active";
      this.identity = value.identity;
      this.geometry = value.geometry;
      return;
    }

    this.requireActive(record);
    this.requireLogicalIdentity(value.identity, `lifecycle ${value.event}`);
    if (this.pendingResize) {
      throw new Error(`lifecycle ${value.event} appears during prepared resize ${this.pendingResize.changeId}`);
    }

    if (value.event === "resume") {
      // A resume is a committed source-epoch boundary.  session+instanceId are
      // stable, while the pane target/server PID/session creation and geometry
      // may legitimately change after tmux or the recorder restarts.
      const generationChanged = value.identity.generation !== undefined
        && value.identity.generation !== this.identity!.generation;
      if (generationChanged) {
        // A new direct-PTY generation starts from a blank emulator. Preserve
        // the prior generation's last visible screen as immutable history,
        // but do not leak any hidden VT state into the replacement pane.
        this.tmux.sealVisibleAndReset(value.geometry, onHistory);
      } else {
        this.tmux.drainHistory(onHistory);
        if (!sameGeometry(this.geometry!, value.geometry)) {
          this.tmux.resize(value.geometry, onHistory);
        }
      }
      this.identity = value.identity;
      this.geometry = value.geometry;
      return;
    }

    if (!sameGeometry(this.geometry!, value.geometry)) {
      throw new Error(
        `lifecycle end geometry ${value.geometry.cols}x${value.geometry.rows} differs from replay ${this.geometry!.cols}x${this.geometry!.rows}`,
      );
    }
    this.tmux.drainHistory(onHistory);
    this.identity = value.identity;
    this.lifecycle = "ended";
  }

  private processResize(
    record: OutputWalRecord,
    value: TerminalReplayResize,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    this.requireActive(record);
    if (value.phase === "prepare") {
      if (this.pendingResize) {
        throw new Error(
          `resize prepare ${value.changeId} overlaps prepared ${this.pendingResize.changeId}`,
        );
      }
      if (!sameGeometry(this.geometry!, value.from)) {
        throw new Error(
          `resize prepare ${value.changeId} starts at ${value.from.cols}x${value.from.rows}, replay is ${this.geometry!.cols}x${this.geometry!.rows}`,
        );
      }
      this.tmux.drainHistory(onHistory);
      this.pendingResize = value;
      return;
    }

    if (!this.pendingResize) {
      // Control-mode `%layout-change` is already the ordered authoritative
      // commit from tmux itself, so it intentionally has no prepare record.
      if (value.phase === "commit" && value.reason === "tmux-control-layout") {
        if (!sameGeometry(this.geometry!, value.from)) {
          throw new Error(`authoritative resize ${value.changeId} source geometry changed`);
        }
        this.tmux.resize(value.to, onHistory);
        this.geometry = value.to;
        return;
      }
      throw new Error(`resize ${value.phase} ${value.changeId} has no matching prepare`);
    }
    if (!sameResize(this.pendingResize, value)) {
      throw new Error(`resize ${value.phase} ${value.changeId} does not match its prepare`);
    }
    if (!sameGeometry(this.geometry!, value.from)) {
      throw new Error(`resize ${value.phase} ${value.changeId} source geometry changed`);
    }
    if (value.phase === "commit") {
      this.tmux.resize(value.to, onHistory);
      this.geometry = value.to;
    }
    // abort deliberately leaves the emulator at `from`.
    this.pendingResize = null;
  }

  process(
    record: OutputWalRecord,
    onHistory: (captured: Uint8Array) => void,
  ): void {
    try {
      switch (record.kind) {
        case "lifecycle":
          this.processLifecycle(record, parseLifecycle(parseOutputWalJson(record)), onHistory);
          break;
        case "output":
          this.requireActive(record);
          if (this.pendingResize) {
            throw new Error(
              `output appears during prepared resize ${this.pendingResize.changeId}`,
            );
          }
          this.tmux.feed(record.payload, onHistory);
          break;
        case "resize":
          this.processResize(record, parseResize(parseOutputWalJson(record)), onHistory);
          break;
        case "checkpoint":
          parseBarrier(parseOutputWalJson(record));
          break;
        default: {
          const exhaustive: never = record.kind;
          throw new Error(`unknown WAL record kind ${String(exhaustive)}`);
        }
      }
      this.recordsSeen += 1;
    } catch (error) {
      throw new Error(`terminal replay failed at WAL record ${record.sequence}: ${String(error)}`);
    }
  }

  snapshot(): ReplaySnapshot {
    return {
      lifecycle: this.lifecycle,
      identity: this.identity ? { ...this.identity } : null,
      geometry: this.geometry ? { ...this.geometry } : null,
      pendingResize: this.pendingResize
        ? {
            ...this.pendingResize,
            from: { ...this.pendingResize.from },
            to: { ...this.pendingResize.to },
          }
        : null,
      screen: this.lifecycle === "none" ? null : this.tmux.captureScreen(),
    };
  }

  get hasPendingResize(): boolean {
    return this.pendingResize !== null;
  }
}

function assertCheckpointSnapshot(
  checkpoint: TerminalReplayCheckpoint,
  snapshot: ReplaySnapshot,
): void {
  if (checkpoint.lifecycle !== snapshot.lifecycle) {
    throw new Error(
      `replayed lifecycle ${snapshot.lifecycle} differs from checkpoint ${checkpoint.lifecycle}`,
    );
  }
  if (!sameNullableIdentity(checkpoint.identity, snapshot.identity)) {
    throw new Error("replayed lifecycle identity differs from checkpoint");
  }
  if (!sameNullableGeometry(checkpoint.geometry, snapshot.geometry)) {
    throw new Error("replayed geometry differs from checkpoint");
  }
  if (!sameNullableResize(checkpoint.pendingResize, snapshot.pendingResize)) {
    throw new Error("replayed pending resize differs from checkpoint");
  }
  if (!sameScreen(checkpoint.screen, snapshot.screen)) {
    throw new Error("replayed terminal screen/cursor differs from checkpoint");
  }
}

export class TerminalReplayMaterializer {
  readonly walPath: string;
  readonly stateDir: string;
  readonly historyPath: string;
  readonly checkpointPath: string;
  private readonly tmuxCommand: string;
  private readonly socketPath: string | undefined;
  private readonly replayChunkBytes: number;
  private readonly historyCaptureRows: number;
  private readonly historyLimit: number;
  private readonly commandTimeoutMs: number;
  private readonly maxWalFrameBytesPerRefresh: number;

  constructor(options: TerminalReplayMaterializerOptions) {
    this.walPath = resolve(nonEmptyString(options.walPath, "walPath"));
    this.stateDir = resolve(nonEmptyString(options.stateDir, "stateDir"));
    this.historyPath = resolve(options.historyPath ?? join(this.stateDir, "history.ansi"));
    this.checkpointPath = resolve(options.checkpointPath ?? join(this.stateDir, "checkpoint.json"));
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    nonEmptyString(this.tmuxCommand, "tmuxCommand");
    this.socketPath = options.socketPath;
    this.replayChunkBytes = positiveInteger(
      options.replayChunkBytes,
      DEFAULT_REPLAY_CHUNK_BYTES,
      "replayChunkBytes",
    );
    this.historyCaptureRows = positiveInteger(
      options.historyCaptureRows,
      DEFAULT_HISTORY_CAPTURE_ROWS,
      "historyCaptureRows",
    );
    this.historyLimit = positiveInteger(
      options.historyLimit,
      DEFAULT_HISTORY_LIMIT,
      "historyLimit",
    );
    this.commandTimeoutMs = positiveInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.maxWalFrameBytesPerRefresh = positiveInteger(
      options.maxWalFrameBytesPerRefresh,
      DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH,
      "maxWalFrameBytesPerRefresh",
    );
    if (this.historyLimit <= MAX_ROWS) {
      throw new Error(
        `historyLimit must be greater than the maximum replay pane height ${MAX_ROWS}`,
      );
    }
    if (this.walPath === this.historyPath || this.walPath === this.checkpointPath) {
      throw new Error("terminal replay output paths must not overwrite the raw WAL");
    }
    if (this.historyPath === this.checkpointPath) {
      throw new Error("terminal replay historyPath and checkpointPath must differ");
    }
    ensurePrivateDirectory(this.stateDir);
  }

  /**
   * Open a long-lived incremental materializer.  Recovery replays the committed
   * prefix once; each later `refresh()` keeps the same private tmux/VT state and
   * applies only records after the durable cursor.
   */
  open(): TerminalReplaySession {
    return new TerminalReplaySession({
      walPath: this.walPath,
      historyPath: this.historyPath,
      checkpointPath: this.checkpointPath,
      tmuxCommand: this.tmuxCommand,
      socketPath: this.socketPath,
      replayChunkBytes: this.replayChunkBytes,
      historyCaptureRows: this.historyCaptureRows,
      historyLimit: this.historyLimit,
      commandTimeoutMs: this.commandTimeoutMs,
      maxWalFrameBytesPerRefresh: this.maxWalFrameBytesPerRefresh,
    });
  }

  /** One-shot convenience for repair jobs and tests. Hosts should use open(). */
  materialize(): TerminalReplayResult {
    const session = this.open();
    try {
      let result = session.current;
      while (result.hasMoreWal) result = session.refresh();
      return result;
    } finally {
      session.close();
    }
  }
}

type TerminalReplaySessionOptions = {
  walPath: string;
  historyPath: string;
  checkpointPath: string;
  tmuxCommand: string;
  socketPath?: string;
  replayChunkBytes: number;
  historyCaptureRows: number;
  historyLimit: number;
  commandTimeoutMs: number;
  maxWalFrameBytesPerRefresh: number;
};

export class TerminalReplaySession {
  private readonly walPath: string;
  private readonly historyPath: string;
  private readonly checkpointPath: string;
  private readonly recoveredFromCheckpoint: boolean;
  private readonly maxWalFrameBytesPerRefresh: number;
  private readonly history: MaterializedHistoryFile;
  private readonly tmux: PrivateTmuxReplay;
  private readonly engine: ReplayEngine;
  private lastOffset = 0;
  private lastSequence = 0n;
  private lastAt = 0;
  private tailCursor: OutputWalTailCursor | null = null;
  private hasMoreWal = false;
  private closed = false;
  private result: TerminalReplayResult;

  /** @internal Construct via TerminalReplayMaterializer.open(). */
  constructor(options: TerminalReplaySessionOptions) {
    this.walPath = options.walPath;
    this.historyPath = options.historyPath;
    this.checkpointPath = options.checkpointPath;
    this.maxWalFrameBytesPerRefresh = options.maxWalFrameBytesPerRefresh;
    const checkpoint = readTerminalReplayCheckpoint(this.checkpointPath);
    if (checkpoint && resolve(checkpoint.walPath) !== this.walPath) {
      throw new Error(
        `checkpoint belongs to ${checkpoint.walPath}, not ${this.walPath}`,
      );
    }
    this.recoveredFromCheckpoint = checkpoint !== null;
    const history = new MaterializedHistoryFile(this.historyPath, checkpoint);
    let tmux: PrivateTmuxReplay;
    try {
      tmux = new PrivateTmuxReplay({
        command: options.tmuxCommand,
        socketPath: options.socketPath,
        replayChunkBytes: options.replayChunkBytes,
        historyCaptureRows: options.historyCaptureRows,
        historyLimit: options.historyLimit,
        commandTimeoutMs: options.commandTimeoutMs,
      });
    } catch (error) {
      history.close();
      throw error;
    }
    this.history = history;
    this.tmux = tmux;
    this.engine = new ReplayEngine(this.tmux);

    try {
      if (existsSync(this.walPath)) {
        this.tailCursor = createOutputWalStartCursor(this.walPath);
      }
      const checkpointOffset = checkpoint?.cursor.walOffset ?? 0;
      let checkpointVerified = checkpoint === null;

      const verifyBoundary = () => {
        if (!checkpoint || checkpointVerified) return;
        if (this.lastOffset !== checkpointOffset) return;
        if (this.lastSequence !== BigInt(checkpoint.cursor.sequence)) {
          throw new Error(
            `replayed sequence ${this.lastSequence} differs from checkpoint ${checkpoint.cursor.sequence}`,
          );
        }
        this.history.finishVerification();
        assertCheckpointSnapshot(checkpoint, this.engine.snapshot());
        checkpointVerified = true;
      };

      // Cursor zero is a valid checkpoint for an empty WAL.
      verifyBoundary();

      // Rebuild only the already committed prefix before accepting new
      // derived bytes. This work can be long after a process restart, but it
      // stays in this worker and each raw read is bounded. A no-checkpoint
      // lane deliberately skips this loop and advances only one batch below.
      while (!checkpointVerified) {
        if (!this.tailCursor) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        const remaining = checkpointOffset - this.lastOffset;
        if (remaining <= 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
        }
        const batch = readOutputWalTail(this.walPath, this.tailCursor, {
          maxFrameBytes: Math.min(this.maxWalFrameBytesPerRefresh, remaining),
        });
        if (batch.records.length === 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        for (const record of batch.records) {
          if (record.offset !== this.lastOffset) {
            throw new Error(
              `recovery WAL record begins at ${record.offset}, expected ${this.lastOffset}`,
            );
          }
          if (record.nextOffset > checkpointOffset) {
            throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
          }
          this.engine.process(
            record,
            (captured) => this.history.accept(captured, "verify"),
          );
          this.lastOffset = record.nextOffset;
          this.lastSequence = record.sequence;
          this.lastAt = record.at;
        }
        if (batch.cursor.offset !== this.lastOffset
          || batch.cursor.lastSequence !== this.lastSequence
          || batch.cursor.lastAt !== this.lastAt) {
          throw new Error("recovery WAL cursor diverged from processed records");
        }
        this.tailCursor = batch.cursor;
        verifyBoundary();
        if (!checkpointVerified && !batch.hasMore) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
      }
      if (!checkpointVerified) {
        throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
      }

      if (checkpoint) {
        // Recovery first publishes the exact existing checkpoint. The host may
        // have crashed after this derived commit but before its pageable store
        // commit; advancing here would make that store trail by two batches.
        // A non-mutating peek tells the host to index this handoff and then
        // call refresh for the next bounded suffix.
        this.hasMoreWal = this.peekTailHasMore();
      } else {
        // A brand-new lane has no checkpoint to hand off, so open creates its
        // first bounded checkpoint. Every later public result is one batch.
        this.consumeTail();
      }

      this.result = this.commitCheckpoint();
    } catch (error) {
      try { this.history.close(); } finally { this.tmux.close(); }
      this.closed = true;
      throw error;
    }
  }

  private commitCheckpoint(): TerminalReplayResult {
    const snapshot = this.engine.snapshot();
    this.history.flush();
    const nextCheckpoint: TerminalReplayCheckpoint = {
      version: 1,
      walPath: this.walPath,
      cursor: {
        walOffset: this.lastOffset,
        sequence: this.lastSequence.toString(),
      },
      historyBytes: this.history.bytes,
      lifecycle: snapshot.lifecycle,
      identity: snapshot.identity,
      geometry: snapshot.geometry,
      pendingResize: snapshot.pendingResize,
      screen: snapshot.screen,
    };
    writeAtomicJson(this.checkpointPath, nextCheckpoint);
    const complete = snapshot.pendingResize === null;
    return {
      complete,
      verified: complete,
      recoveredFromCheckpoint: this.recoveredFromCheckpoint,
      ended: snapshot.lifecycle === "ended",
      walOffset: this.lastOffset,
      sequence: this.lastSequence,
      hasMoreWal: this.hasMoreWal,
      historyBytes: this.history.bytes,
      identity: snapshot.identity,
      geometry: snapshot.geometry,
      pendingResize: snapshot.pendingResize,
      screen: snapshot.screen,
      historyPath: this.historyPath,
      checkpointPath: this.checkpointPath,
    };
  }

  get current(): TerminalReplayResult {
    return this.result;
  }

  /** Diagnostic path proving this session remains on its isolated tmux server. */
  get privateSocketPath(): string {
    return this.tmux.socketPath;
  }

  /** @internal Test/diagnostic proof that the raw fence is truncated per batch. */
  get privateMirrorPath(): string {
    return this.tmux.boundedMirrorPath;
  }

  /** @internal Largest observed on-disk completion-fence size. */
  get privatePeakMirrorBytes(): number {
    return this.tmux.peakBoundedMirrorBytes;
  }

  private peekTailHasMore(): boolean {
    if (!this.tailCursor || !existsSync(this.walPath)) return false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxRecords: 1,
      maxFrameBytes: this.maxWalFrameBytesPerRefresh,
    });
    return batch.records.length > 0 || batch.hasMore;
  }

  private consumeTail(): boolean {
    if (!this.tailCursor) {
      if (!existsSync(this.walPath)) {
        this.hasMoreWal = false;
        return false;
      }
      this.tailCursor = createOutputWalStartCursor(this.walPath);
    }

    let changed = false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxFrameBytes: this.maxWalFrameBytesPerRefresh,
      // When the last published checkpoint ended at PREPARE, expose the
      // matching COMMIT/ABORT as its own verified handoff before accepting
      // post-resize output. Otherwise a host store that correctly rejected
      // the incomplete checkpoint could trail by two raw-output batches.
      ...(this.engine.hasPendingResize ? { maxRecords: 1 } : {}),
    });
    for (const record of batch.records) {
      if (record.offset !== this.lastOffset) {
        throw new Error(
          `incremental WAL record begins at ${record.offset}, expected ${this.lastOffset}`,
        );
      }
      this.engine.process(record, (captured) => this.history.accept(captured, "append"));
      this.lastOffset = record.nextOffset;
      this.lastSequence = record.sequence;
      this.lastAt = record.at;
      changed = true;
    }
    if (batch.cursor.offset !== this.lastOffset
      || batch.cursor.lastSequence !== this.lastSequence
      || batch.cursor.lastAt !== this.lastAt) {
      throw new Error("incremental WAL cursor diverged from processed records");
    }
    this.tailCursor = batch.cursor;
    this.hasMoreWal = batch.hasMore;
    return changed;
  }

  /**
   * Consume at most one bounded, record-aligned WAL suffix batch. The private
   * tmux stays alive, so normal service operation never replays the committed
   * prefix. Callers must index this result before refreshing again when
   * `hasMoreWal` is true.
   */
  refresh(): TerminalReplayResult {
    if (this.closed) throw new Error("terminal replay session is closed");
    try {
      const previousHasMoreWal = this.hasMoreWal;
      const changed = this.consumeTail();
      if (changed || previousHasMoreWal !== this.hasMoreWal) {
        this.result = this.commitCheckpoint();
      }
      return this.result;
    } catch (error) {
      // The atomic checkpoint deliberately remains behind. A fresh open() will
      // truncate the derived suffix and rebuild exact VT state from raw WAL.
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.history.close(); } finally { this.tmux.close(); }
  }
}
