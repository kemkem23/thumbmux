import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  TerminalReplayMaterializer,
  type TerminalReplayGeometry,
  type TerminalReplayIdentity,
  type TerminalReplayMaterializerOptions,
  type TerminalReplayResize,
  type TerminalReplayResult,
  type TerminalReplayScreen,
  type TerminalReplaySession,
} from "../terminal-replay-materializer";

/** Wire version for the private parent <-> replay-worker protocol. */
export const TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION = 1 as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 512 * 1024 * 1024;
const MAX_REQUEST_FRAME_BYTES = 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
const MAX_SHUTDOWN_GRACE_MS = 60_000;
const MAX_PATH_BYTES = 4_096;
const MAX_STRING_BYTES = 16_384;
const MAX_ERROR_BYTES = 8_192;
const MAX_STDERR_TAIL_BYTES = 16_384;
const MAX_UINT64 = (1n << 64n) - 1n;

type ReplayCommand = "open" | "current" | "refresh" | "close";

export type TerminalReplayWorkerResultWire = Omit<TerminalReplayResult, "sequence"> & {
  /** Decimal uint64; JSON numbers cannot represent every WAL sequence exactly. */
  sequence: string;
};

export type TerminalReplayWorkerClientOptions = {
  materializer: TerminalReplayMaterializerOptions;
  /** Runtime used to launch the shipped worker. Defaults to process.execPath. */
  runtimePath?: string;
  /** Override for tests/source checkouts. Published builds use the shipped worker. */
  workerPath?: string | URL;
  /** Applies independently to open/current/refresh. Defaults to ten minutes. */
  requestTimeoutMs?: number;
  /** Time to wait for a graceful close before SIGTERM/SIGKILL. */
  shutdownGraceMs?: number;
  /** Hard cap for one worker response, including the rendered screen. */
  maxResponseFrameBytes?: number;
};

export interface TerminalReplayWorkerClient {
  readonly pid: number;
  readonly closed: boolean;
  /** Most recent successful open/current/refresh result, without another IPC hop. */
  readonly lastResult: TerminalReplayResult;
  current(): Promise<TerminalReplayResult>;
  refresh(): Promise<TerminalReplayResult>;
  /** Idempotent. Resolves only after the derived worker process has been reaped. */
  close(): Promise<void>;
}

export class TerminalReplayWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalReplayWorkerError";
    this.code = code;
  }
}

type OpenRequest = {
  protocol: 1;
  id: string;
  command: "open";
  materializer: TerminalReplayMaterializerOptions;
  maxResponseFrameBytes: number;
};

type SimpleRequest = {
  protocol: 1;
  id: string;
  command: Exclude<ReplayCommand, "open">;
};

type WorkerRequest = OpenRequest | SimpleRequest;

type SuccessResponse = {
  protocol: 1;
  id: string;
  ok: true;
  result?: TerminalReplayWorkerResultWire;
};

type ErrorResponse = {
  protocol: 1;
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

type WorkerResponse = SuccessResponse | ErrorResponse;

type PendingRequest = {
  command: ReplayCommand;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: TerminalReplayResult | undefined) => void;
  reject: (error: Error) => void;
};

type NormalizedClientOptions = {
  materializer: TerminalReplayMaterializerOptions;
  runtimePath: string;
  workerPath: string;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  maxResponseFrameBytes: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_STRING_BYTES,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes || value.includes("\0")) {
    throw new Error(`${label} exceeds its byte bound or contains NUL`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function parseGeometry(value: unknown, label: string): TerminalReplayGeometry {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["cols", "rows"], [], label);
  const cols = boundedInteger(value.cols, `${label}.cols`, 1, 4_096);
  const rows = boundedInteger(value.rows, `${label}.rows`, 1, 4_096);
  if (cols * rows > 4_194_304) throw new Error(`${label} exceeds the cell bound`);
  return { cols, rows };
}

function parseIdentity(value: unknown, label: string): TerminalReplayIdentity {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const required = [
    "session",
    "instanceId",
    "paneTarget",
    "tmuxServerPid",
    "sessionCreated",
  ] as const;
  const optional = ["sessionId", "windowId", "paneId", "generation"] as const;
  exactKeys(value, required, optional, label);
  const result: TerminalReplayIdentity = {
    session: boundedString(value.session, `${label}.session`),
    instanceId: boundedString(value.instanceId, `${label}.instanceId`),
    paneTarget: boundedString(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: boundedInteger(
      value.tmuxServerPid,
      `${label}.tmuxServerPid`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sessionCreated: boundedInteger(
      value.sessionCreated,
      `${label}.sessionCreated`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  for (const key of optional) {
    if (value[key] !== undefined) result[key] = boundedString(value[key], `${label}.${key}`);
  }
  return result;
}

function parseResize(value: unknown, label: string): TerminalReplayResize {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["phase", "changeId", "from", "to"], ["reason"], label);
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error(`${label}.phase is invalid`);
  }
  return {
    phase: value.phase,
    changeId: boundedString(value.changeId, `${label}.changeId`),
    from: parseGeometry(value.from, `${label}.from`),
    to: parseGeometry(value.to, `${label}.to`),
    ...(value.reason === undefined
      ? {}
      : { reason: boundedString(value.reason, `${label}.reason`, MAX_STRING_BYTES, true) }),
  };
}

function parseBase64(value: unknown, label: string): string {
  const encoded = boundedString(value, label, MAX_RESPONSE_FRAME_BYTES, true);
  if (encoded.length % 4 !== 0
    || (encoded.length > 0 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))) {
    throw new Error(`${label} must be canonical base64`);
  }
  return encoded;
}

function parseScreen(value: unknown, label: string): TerminalReplayScreen {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, [
    "cols",
    "rows",
    "cursorX",
    "cursorY",
    "cursorVisible",
    "alternateOn",
    "mouseSgr",
    "mouseAny",
    "cellsBase64",
    "pendingEscapeBase64",
  ], [], label);
  const geometry = parseGeometry({ cols: value.cols, rows: value.rows }, label);
  const cursorX = boundedInteger(value.cursorX, `${label}.cursorX`, 0, geometry.cols - 1);
  const cursorY = boundedInteger(value.cursorY, `${label}.cursorY`, 0, geometry.rows - 1);
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: booleanValue(value.cursorVisible, `${label}.cursorVisible`),
    alternateOn: booleanValue(value.alternateOn, `${label}.alternateOn`),
    mouseSgr: booleanValue(value.mouseSgr, `${label}.mouseSgr`),
    mouseAny: booleanValue(value.mouseAny, `${label}.mouseAny`),
    cellsBase64: parseBase64(value.cellsBase64, `${label}.cellsBase64`),
    pendingEscapeBase64: parseBase64(
      value.pendingEscapeBase64,
      `${label}.pendingEscapeBase64`,
    ),
  };
}

function parseNullable<T>(
  value: unknown,
  parser: (selected: unknown, label: string) => T,
  label: string,
): T | null {
  return value === null ? null : parser(value, label);
}

function parseUint64Decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal uint64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw new Error(`${label} exceeds uint64`);
  return parsed;
}

/** Convert a replay result into its JSON-safe, lossless IPC representation. */
export function terminalReplayResultToWire(
  result: TerminalReplayResult,
): TerminalReplayWorkerResultWire {
  return {
    complete: result.complete,
    verified: result.verified,
    recoveredFromCheckpoint: result.recoveredFromCheckpoint,
    ended: result.ended,
    walOffset: result.walOffset,
    sequence: result.sequence.toString(),
    hasMoreWal: result.hasMoreWal,
    historyBytes: result.historyBytes,
    identity: result.identity,
    geometry: result.geometry,
    pendingResize: result.pendingResize,
    screen: result.screen,
    historyPath: result.historyPath,
    checkpointPath: result.checkpointPath,
  };
}

/** Strictly validate and revive a JSON-safe replay result, including bigint. */
export function terminalReplayResultFromWire(value: unknown): TerminalReplayResult {
  const label = "terminal replay worker result";
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, [
    "complete",
    "verified",
    "recoveredFromCheckpoint",
    "ended",
    "walOffset",
    "sequence",
    "hasMoreWal",
    "historyBytes",
    "identity",
    "geometry",
    "pendingResize",
    "screen",
    "historyPath",
    "checkpointPath",
  ], [], label);
  const geometry = parseNullable(value.geometry, parseGeometry, `${label}.geometry`);
  const screen = parseNullable(value.screen, parseScreen, `${label}.screen`);
  if (geometry && screen && (geometry.cols !== screen.cols || geometry.rows !== screen.rows)) {
    throw new Error(`${label}.screen geometry differs from result geometry`);
  }
  return {
    complete: booleanValue(value.complete, `${label}.complete`),
    verified: booleanValue(value.verified, `${label}.verified`),
    recoveredFromCheckpoint: booleanValue(
      value.recoveredFromCheckpoint,
      `${label}.recoveredFromCheckpoint`,
    ),
    ended: booleanValue(value.ended, `${label}.ended`),
    walOffset: boundedInteger(value.walOffset, `${label}.walOffset`, 0, Number.MAX_SAFE_INTEGER),
    sequence: parseUint64Decimal(value.sequence, `${label}.sequence`),
    hasMoreWal: booleanValue(value.hasMoreWal, `${label}.hasMoreWal`),
    historyBytes: boundedInteger(
      value.historyBytes,
      `${label}.historyBytes`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    identity: parseNullable(value.identity, parseIdentity, `${label}.identity`),
    geometry,
    pendingResize: parseNullable(value.pendingResize, parseResize, `${label}.pendingResize`),
    screen,
    historyPath: boundedString(value.historyPath, `${label}.historyPath`, MAX_PATH_BYTES),
    checkpointPath: boundedString(
      value.checkpointPath,
      `${label}.checkpointPath`,
      MAX_PATH_BYTES,
    ),
  };
}

function normalizeMaterializerOptions(value: unknown): TerminalReplayMaterializerOptions {
  const label = "terminal replay materializer options";
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const optional = [
    "historyPath",
    "checkpointPath",
    "tmuxCommand",
    "socketPath",
    "replayChunkBytes",
    "historyCaptureRows",
    "historyLimit",
    "commandTimeoutMs",
    "maxWalFrameBytesPerRefresh",
  ] as const;
  exactKeys(value, ["walPath", "stateDir"], optional, label);
  const path = (key: "walPath" | "stateDir" | "historyPath" | "checkpointPath") =>
    resolve(boundedString(value[key], `${label}.${key}`, MAX_PATH_BYTES));
  const normalized: TerminalReplayMaterializerOptions = {
    walPath: path("walPath"),
    stateDir: path("stateDir"),
  };
  if (value.historyPath !== undefined) normalized.historyPath = path("historyPath");
  if (value.checkpointPath !== undefined) normalized.checkpointPath = path("checkpointPath");
  if (value.tmuxCommand !== undefined) {
    normalized.tmuxCommand = boundedString(value.tmuxCommand, `${label}.tmuxCommand`, MAX_PATH_BYTES);
  }
  if (value.socketPath !== undefined) {
    const socketPath = boundedString(value.socketPath, `${label}.socketPath`, MAX_PATH_BYTES);
    if (!isAbsolute(socketPath)) throw new Error(`${label}.socketPath must be absolute`);
    normalized.socketPath = resolve(socketPath);
  }
  if (value.replayChunkBytes !== undefined) {
    normalized.replayChunkBytes = boundedInteger(
      value.replayChunkBytes,
      `${label}.replayChunkBytes`,
      1,
      16 * 1024 * 1024,
    );
  }
  if (value.historyCaptureRows !== undefined) {
    normalized.historyCaptureRows = boundedInteger(
      value.historyCaptureRows,
      `${label}.historyCaptureRows`,
      1,
      1_000_000,
    );
  }
  if (value.historyLimit !== undefined) {
    normalized.historyLimit = boundedInteger(
      value.historyLimit,
      `${label}.historyLimit`,
      4_097,
      10_000_000,
    );
  }
  if (value.commandTimeoutMs !== undefined) {
    normalized.commandTimeoutMs = boundedInteger(
      value.commandTimeoutMs,
      `${label}.commandTimeoutMs`,
      1,
      MAX_REQUEST_TIMEOUT_MS,
    );
  }
  if (value.maxWalFrameBytesPerRefresh !== undefined) {
    normalized.maxWalFrameBytesPerRefresh = boundedInteger(
      value.maxWalFrameBytesPerRefresh,
      `${label}.maxWalFrameBytesPerRefresh`,
      1,
      256 * 1024 * 1024,
    );
  }
  return normalized;
}

function normalizeWorkerPath(value: string | URL | undefined): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") throw new Error("workerPath URL must use file:");
    return fileURLToPath(value);
  }
  if (value !== undefined) return resolve(boundedString(value, "workerPath", MAX_PATH_BYTES));
  return fileURLToPath(new URL("./terminal-replay-worker-entry.js", import.meta.url));
}

function normalizeClientOptions(value: TerminalReplayWorkerClientOptions): NormalizedClientOptions {
  if (!isPlainObject(value)) throw new Error("terminal replay worker client options must be an object");
  exactKeys(value, ["materializer"], [
    "runtimePath",
    "workerPath",
    "requestTimeoutMs",
    "shutdownGraceMs",
    "maxResponseFrameBytes",
  ], "terminal replay worker client options");
  const runtimePath = resolve(boundedString(
    value.runtimePath ?? process.execPath,
    "runtimePath",
    MAX_PATH_BYTES,
  ));
  const workerPath = normalizeWorkerPath(value.workerPath);
  if (!existsSync(runtimePath)) throw new Error(`terminal replay runtime does not exist: ${runtimePath}`);
  if (!existsSync(workerPath)) throw new Error(`terminal replay worker does not exist: ${workerPath}`);
  return {
    materializer: normalizeMaterializerOptions(value.materializer),
    runtimePath,
    workerPath,
    requestTimeoutMs: boundedInteger(
      value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      10,
      MAX_REQUEST_TIMEOUT_MS,
    ),
    shutdownGraceMs: boundedInteger(
      value.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      "shutdownGraceMs",
      10,
      MAX_SHUTDOWN_GRACE_MS,
    ),
    maxResponseFrameBytes: boundedInteger(
      value.maxResponseFrameBytes ?? DEFAULT_MAX_RESPONSE_FRAME_BYTES,
      "maxResponseFrameBytes",
      1_024,
      MAX_RESPONSE_FRAME_BYTES,
    ),
  };
}

function encodeJsonFrame(value: unknown, maximumBytes: number, label: string): Buffer {
  let encoded: Buffer;
  try {
    encoded = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable`, { cause: error });
  }
  if (encoded.byteLength === 0 || encoded.byteLength > maximumBytes) {
    throw new Error(`${label} is ${encoded.byteLength} bytes; limit is ${maximumBytes}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(encoded.byteLength, 0);
  return Buffer.concat([header, encoded], encoded.byteLength + 4);
}

class JsonFrameDecoder {
  private readonly header = Buffer.allocUnsafe(4);
  private headerBytes = 0;
  private frameBytes = -1;
  private received = 0;
  private chunks: Buffer[] = [];

  constructor(private readonly maximumBytes: number) {}

  push(chunkValue: Uint8Array, onFrame: (frame: Buffer) => void): void {
    const chunk = Buffer.from(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength);
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.frameBytes < 0) {
        const take = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < 4) continue;
        this.frameBytes = this.header.readUInt32BE(0);
        this.headerBytes = 0;
        if (this.frameBytes === 0 || this.frameBytes > this.maximumBytes) {
          throw new Error(
            `IPC frame length ${this.frameBytes} is outside 1..${this.maximumBytes}`,
          );
        }
      }

      const take = Math.min(this.frameBytes - this.received, chunk.byteLength - offset);
      this.chunks.push(chunk.subarray(offset, offset + take));
      this.received += take;
      offset += take;
      if (this.received !== this.frameBytes) continue;

      const frame = this.chunks.length === 1
        ? Buffer.from(this.chunks[0]!)
        : Buffer.concat(this.chunks, this.frameBytes);
      this.frameBytes = -1;
      this.received = 0;
      this.chunks = [];
      onFrame(frame);
    }
  }

  finish(): void {
    if (this.headerBytes !== 0 || this.frameBytes >= 0) {
      throw new Error("IPC stream ended in the middle of a frame");
    }
  }
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeJson(frame: Buffer, label: string): unknown {
  try {
    return JSON.parse(fatalUtf8Decoder.decode(frame));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function parseRequest(value: unknown): WorkerRequest {
  const label = "terminal replay worker request";
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${label}.id has invalid characters`);
  if (value.command === "open") {
    exactKeys(value, [
      "protocol",
      "id",
      "command",
      "materializer",
      "maxResponseFrameBytes",
    ], [], label);
    return {
      protocol: 1,
      id,
      command: "open",
      materializer: normalizeMaterializerOptions(value.materializer),
      maxResponseFrameBytes: boundedInteger(
        value.maxResponseFrameBytes,
        `${label}.maxResponseFrameBytes`,
        1_024,
        MAX_RESPONSE_FRAME_BYTES,
      ),
    };
  }
  if (value.command !== "current" && value.command !== "refresh" && value.command !== "close") {
    throw new Error(`${label}.command is invalid`);
  }
  exactKeys(value, ["protocol", "id", "command"], [], label);
  return { protocol: 1, id, command: value.command };
}

function parseResponse(value: unknown): WorkerResponse {
  const label = "terminal replay worker response";
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${label}.id has invalid characters`);
  if (value.ok === true) {
    exactKeys(value, ["protocol", "id", "ok"], ["result"], label);
    return {
      protocol: 1,
      id,
      ok: true,
      ...(value.result === undefined
        ? {}
        : { result: terminalReplayResultToWire(terminalReplayResultFromWire(value.result)) }),
    };
  }
  if (value.ok !== false) throw new Error(`${label}.ok must be boolean`);
  exactKeys(value, ["protocol", "id", "ok", "error"], [], label);
  if (!isPlainObject(value.error)) throw new Error(`${label}.error must be an object`);
  exactKeys(value.error, ["code", "message"], [], `${label}.error`);
  const code = boundedString(value.error.code, `${label}.error.code`, 64);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error(`${label}.error.code is invalid`);
  return {
    protocol: 1,
    id,
    ok: false,
    error: {
      code,
      message: boundedString(value.error.message, `${label}.error.message`, MAX_ERROR_BYTES, true),
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message, "utf8");
  return encoded.byteLength <= MAX_ERROR_BYTES
    ? message
    : encoded.subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

async function writeJsonFrame(
  stream: Writable,
  value: unknown,
  maximumBytes: number,
  label: string,
): Promise<void> {
  const frame = encodeJsonFrame(value, maximumBytes, label);
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(frame, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

/**
 * Worker-side stdio loop. stdout is reserved exclusively for framed protocol
 * responses; callers must route diagnostics to stderr.
 */
export async function runTerminalReplayWorkerStdio(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  const decoder = new JsonFrameDecoder(MAX_REQUEST_FRAME_BYTES);
  let session: TerminalReplaySession | null = null;
  let opened = false;
  let maxResponseFrameBytes = DEFAULT_MAX_RESPONSE_FRAME_BYTES;
  let signalReceived = false;

  const onSignal = () => {
    signalReceived = true;
    input.destroy();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    for await (const chunk of input) {
      const frames: Buffer[] = [];
      decoder.push(chunk as Uint8Array, (frame) => frames.push(frame));
      for (const frame of frames) {
        const request = parseRequest(decodeJson(frame, "terminal replay worker request"));
        if (request.command === "open") {
          if (opened) {
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "INVALID_STATE", message: "replay worker is already open" },
            } satisfies ErrorResponse, maxResponseFrameBytes, "terminal replay worker response");
            continue;
          }
          maxResponseFrameBytes = request.maxResponseFrameBytes;
          try {
            session = new TerminalReplayMaterializer(request.materializer).open();
            opened = true;
            const response = {
              protocol: 1,
              id: request.id,
              ok: true,
              result: terminalReplayResultToWire(session.current),
            } satisfies SuccessResponse;
            await writeJsonFrame(
              output,
              response,
              maxResponseFrameBytes,
              "terminal replay worker response",
            );
          } catch (error) {
            if (session) session.close();
            session = null;
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "OPEN_FAILED", message: errorMessage(error) },
            } satisfies ErrorResponse, maxResponseFrameBytes, "terminal replay worker response");
            return 1;
          }
          continue;
        }

        if (!opened || !session) {
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "INVALID_STATE", message: "replay worker is not open" },
          } satisfies ErrorResponse, maxResponseFrameBytes, "terminal replay worker response");
          continue;
        }

        if (request.command === "close") {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true,
          } satisfies SuccessResponse, maxResponseFrameBytes, "terminal replay worker response");
          return 0;
        }

        try {
          const result = request.command === "refresh" ? session.refresh() : session.current;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true,
            result: terminalReplayResultToWire(result),
          } satisfies SuccessResponse, maxResponseFrameBytes, "terminal replay worker response");
        } catch (error) {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "MATERIALIZER_FAILED", message: errorMessage(error) },
          } satisfies ErrorResponse, maxResponseFrameBytes, "terminal replay worker response");
          return 1;
        }
      }
    }
    if (!signalReceived) decoder.finish();
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (session) session.close();
  }
}

class ProcessTerminalReplayWorkerClient implements TerminalReplayWorkerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: NormalizedClientOptions;
  private readonly decoder: JsonFrameDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1n;
  private latestResult: TerminalReplayResult | null = null;
  private terminalError: TerminalReplayWorkerError | null = null;
  private stdoutEnded = false;
  private exited = false;
  private terminating = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stderrTail = Buffer.alloc(0);
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(options: NormalizedClientOptions) {
    this.options = options;
    this.decoder = new JsonFrameDecoder(options.maxResponseFrameBytes);
    this.child = spawn(options.runtimePath, [options.workerPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    // Deliberately do not unref: a graceful parent shutdown must close and
    // reap this derived worker instead of silently orphaning it.
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    this.attachProcessListeners();
  }

  get pid(): number {
    if (this.child.pid === undefined) throw new Error("terminal replay worker has no PID");
    return this.child.pid;
  }

  get closed(): boolean {
    return this.closing || this.exited;
  }

  get lastResult(): TerminalReplayResult {
    if (!this.latestResult) throw new Error("terminal replay worker has not opened");
    return this.latestResult;
  }

  private diagnosticSuffix(): string {
    const stderr = this.stderrTail.toString("utf8").trim();
    return stderr.length === 0 ? "" : `; stderr: ${stderr}`;
  }

  private attachProcessListeners(): void {
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.terminalError) return;
      try {
        this.decoder.push(chunk, (frame) => this.handleResponseFrame(frame));
      } catch (error) {
        this.fail(new TerminalReplayWorkerError(
          "PROTOCOL_ERROR",
          `invalid replay worker stdout: ${errorMessage(error)}`,
          { cause: error },
        ));
      }
    });
    this.child.stdout.on("end", () => {
      this.stdoutEnded = true;
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(new TerminalReplayWorkerError(
          "PROTOCOL_ERROR",
          `replay worker stdout ended mid-frame: ${errorMessage(error)}`,
          { cause: error },
        ));
        return;
      }
      if (!this.closing && !this.exited) {
        this.fail(new TerminalReplayWorkerError(
          "UNEXPECTED_EOF",
          `replay worker stdout closed unexpectedly${this.diagnosticSuffix()}`,
        ));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const combined = Buffer.concat([this.stderrTail, chunk]);
      this.stderrTail = combined.byteLength <= MAX_STDERR_TAIL_BYTES
        ? combined
        : combined.subarray(combined.byteLength - MAX_STDERR_TAIL_BYTES);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) {
        this.fail(new TerminalReplayWorkerError(
          "IPC_WRITE_FAILED",
          `cannot write to replay worker: ${error.message}`,
          { cause: error },
        ));
      }
    });
    this.child.on("error", (error) => {
      this.fail(new TerminalReplayWorkerError(
        "SPAWN_FAILED",
        `cannot start replay worker: ${error.message}`,
        { cause: error },
      ));
    });
    const markExited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.resolveExit();
      if (!this.closing && !this.terminalError) {
        this.fail(new TerminalReplayWorkerError(
          "WORKER_EXITED",
          `replay worker exited with code ${String(code)} signal ${String(signal)}${this.diagnosticSuffix()}`,
        ));
      }
    };
    this.child.on("exit", markExited);
    // A spawn failure emits error + close but not necessarily exit.
    this.child.on("close", markExited);
  }

  private handleResponseFrame(frame: Buffer): void {
    let response: WorkerResponse;
    try {
      response = parseResponse(decodeJson(frame, "terminal replay worker response"));
    } catch (error) {
      throw new Error(errorMessage(error), { cause: error });
    }
    const pending = this.pending.get(response.id);
    if (!pending) throw new Error(`response has unknown or duplicate id ${response.id}`);
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (!response.ok) {
      pending.reject(new TerminalReplayWorkerError(response.error.code, response.error.message));
      return;
    }
    const expectsResult = pending.command !== "close";
    if (expectsResult !== (response.result !== undefined)) {
      pending.reject(new TerminalReplayWorkerError(
        "PROTOCOL_ERROR",
        `response for ${pending.command} ${expectsResult ? "has no result" : "has an unexpected result"}`,
      ));
      this.fail(new TerminalReplayWorkerError(
        "PROTOCOL_ERROR",
        `response shape does not match ${pending.command}`,
      ));
      return;
    }
    const result = response.result === undefined
      ? undefined
      : terminalReplayResultFromWire(response.result);
    if (result) this.latestResult = result;
    pending.resolve(result);
  }

  private fail(error: TerminalReplayWorkerError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.beginTerminate();
  }

  private beginTerminate(): void {
    if (this.exited || this.terminating) return;
    this.terminating = true;
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      if (!this.exited) {
        try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, this.options.shutdownGraceMs);
    timer.unref?.();
  }

  private send(command: ReplayCommand): Promise<TerminalReplayResult | undefined> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.exited || this.stdoutEnded) {
      return Promise.reject(new TerminalReplayWorkerError(
        "WORKER_EXITED",
        `replay worker is not running${this.diagnosticSuffix()}`,
      ));
    }
    const id = `r${this.nextId.toString(36)}`;
    this.nextId += 1n;
    const request: WorkerRequest = command === "open"
      ? {
          protocol: 1,
          id,
          command,
          materializer: this.options.materializer,
          maxResponseFrameBytes: this.options.maxResponseFrameBytes,
        }
      : { protocol: 1, id, command };
    const frame = encodeJsonFrame(request, MAX_REQUEST_FRAME_BYTES, "terminal replay worker request");

    return new Promise<TerminalReplayResult | undefined>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const error = new TerminalReplayWorkerError(
          "REQUEST_TIMEOUT",
          `replay worker ${command} timed out after ${this.options.requestTimeoutMs}ms`,
        );
        rejectRequest(error);
        this.fail(error);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        command,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      this.child.stdin.write(frame, (error) => {
        if (!error) return;
        const failure = new TerminalReplayWorkerError(
          "IPC_WRITE_FAILED",
          `cannot write ${command} to replay worker: ${error.message}`,
          { cause: error },
        );
        this.fail(failure);
      });
    });
  }

  private enqueue(command: "current" | "refresh"): Promise<TerminalReplayResult> {
    if (this.closing) {
      return Promise.reject(new TerminalReplayWorkerError("CLIENT_CLOSED", "replay worker is closed"));
    }
    const operation = this.queue.then(async () => {
      const result = await this.send(command);
      if (!result) throw new Error(`replay worker ${command} returned no result`);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async open(): Promise<void> {
    const result = await this.send("open");
    if (!result) throw new TerminalReplayWorkerError("PROTOCOL_ERROR", "open returned no result");
    this.latestResult = result;
  }

  current(): Promise<TerminalReplayResult> {
    return this.enqueue("current");
  }

  refresh(): Promise<TerminalReplayResult> {
    return this.enqueue("refresh");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.then(async () => {
      if (!this.exited && !this.terminalError && !this.stdoutEnded) {
        try {
          await this.send("close");
          this.child.stdin.end();
        } catch {
          this.beginTerminate();
        }
      } else if (!this.exited) {
        this.beginTerminate();
      }
      if (!this.exited) {
        const timeout = new Promise<void>((resolveTimeout) => {
          const timer = setTimeout(() => {
            this.beginTerminate();
            resolveTimeout();
          }, this.options.shutdownGraceMs);
          timer.unref?.();
        });
        await Promise.race([this.exitPromise, timeout]);
        if (!this.exited) {
          try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
          await this.exitPromise;
        }
      }
    }, async () => {
      this.beginTerminate();
      await this.exitPromise;
    });
    return this.closePromise;
  }
}

/**
 * Spawn the shipped replay worker, open one long-lived materializer, and wait
 * for its first verified snapshot. The child remains supervised/referenced;
 * hosts must await `client.close()` during graceful shutdown.
 */
export async function createTerminalReplayWorkerClient(
  options: TerminalReplayWorkerClientOptions,
): Promise<TerminalReplayWorkerClient> {
  const client = new ProcessTerminalReplayWorkerClient(normalizeClientOptions(options));
  try {
    await client.open();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
