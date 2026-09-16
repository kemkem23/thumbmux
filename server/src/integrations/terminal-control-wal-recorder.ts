import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fdatasyncSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { OutputWalRecoverySnapshot } from "../output-wal";
import {
  TerminalWalWorker,
  parseTerminalWalWorkerConfig,
  type NormalizedTerminalWalWorkerConfig,
  type TerminalWalWorkerConfig,
} from "./terminal-wal-worker";
import {
  parseTmuxControlWalBytesLine,
  type TerminalGeometry,
  type TmuxControlWalEvent,
} from "./terminal-wal";
import { TmuxControlStreamBuffer } from "./tmux-control-stream";

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PRE_READY_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CONTROL_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONFIG_JSON_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const TERMINAL_CONTROL_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_CONTROL_WAL_CONFIG";
export const TERMINAL_CONTROL_WAL_STATUS_FILE = "recorder-status.json";

export type TerminalControlTmuxOptions = {
  executable?: string;
  socketName?: string;
  socketPath?: string;
};

export type TerminalControlWalRecorderConfig = {
  worker: TerminalWalWorkerConfig;
  tmux?: TerminalControlTmuxOptions;
  readyTimeoutMs?: number;
  maxPreReadyEventBytes?: number;
  maxControlLineBytes?: number;
};

export type NormalizedTerminalControlWalRecorderConfig = {
  worker: NormalizedTerminalWalWorkerConfig;
  tmux: Required<Pick<TerminalControlTmuxOptions, "executable">>
    & Pick<TerminalControlTmuxOptions, "socketName" | "socketPath">;
  readyTimeoutMs: number;
  maxPreReadyEventBytes: number;
  maxControlLineBytes: number;
};

export type TerminalControlSourceIdentity = {
  session: string;
  sessionId: string;
  windowId: string;
  paneId: string;
  paneTarget: string;
  tmuxServerPid: number;
  sessionCreated: number;
  geometry: TerminalGeometry;
};

export type TerminalControlProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type TerminalControlWalRecorderDependencies = {
  spawnControl?: (executable: string, args: string[]) => TerminalControlProcess;
  resolveIdentity?: (
    config: NormalizedTerminalControlWalRecorderConfig,
  ) => Promise<TerminalControlSourceIdentity>;
  reconcilePause?: (
    request: TerminalControlPauseReconcileRequest,
  ) => Promise<TerminalControlRecoveryCapture | void>;
  onAlert?: (message: string) => void;
  onFatal?: (error: Error) => void;
};

export type TerminalControlPauseReconcileRequest = {
  gapId: string;
  paneId: string;
  source: TerminalControlSourceIdentity;
  capturedSeqBefore: string;
};

export type TerminalControlRecoveryCapture = {
  recoveredBytes: Uint8Array;
  recoveredRows: number;
  truncated: boolean;
  identity: TerminalControlSourceIdentity;
  geometry: TerminalGeometry;
  boundary: "matched" | "ambiguous";
};

export type TerminalControlWalRecorderStatus = {
  state: "created" | "attaching" | "validating" | "ready" | "end-armed" | "exiting" | "disconnected" | "fatal";
  source: TerminalControlSourceIdentity | null;
  pendingEventBytes: number;
  bufferedControlBytes: number;
  fatalMessage: string | null;
  degraded: boolean;
  alert: string | null;
};

export type TerminalControlWalHealth = {
  version: 1;
  state: "attaching" | "ready" | "end-armed" | "disconnected" | "fatal";
  pid: number;
  source: TerminalControlSourceIdentity | null;
  updatedAt: number;
  degraded?: boolean;
  alert?: string;
  error?: string;
};

type PendingRecorderEvent =
  | TmuxControlWalEvent
  | { kind: "raw-wal-line"; bytes: Uint8Array }
  | { kind: "pause"; paneId: string }
  | { kind: "continue"; paneId: string };

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
    if (!Object.hasOwn(value, key) || value[key] === undefined) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function boundedOption(value: unknown, fallback: number, label: string, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value as number;
}

function parseTmuxOptions(value: unknown): NormalizedTerminalControlWalRecorderConfig["tmux"] {
  if (value === undefined) return { executable: "tmux" };
  if (!isPlainObject(value)) throw new Error("terminal control WAL tmux config must be an object");
  exactKeys(value, [], ["executable", "socketName", "socketPath"], "tmux");
  const executable = value.executable ?? "tmux";
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0")) {
    throw new Error("tmux.executable must be a non-empty command or absolute path");
  }
  if (executable.includes("/") && (!isAbsolute(executable) || resolve(executable) !== executable)) {
    throw new Error("tmux.executable with a slash must be an absolute normalized path");
  }
  if (!executable.includes("/") && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executable)) {
    throw new Error("tmux.executable command name is invalid");
  }
  if (value.socketName !== undefined && value.socketPath !== undefined) {
    throw new Error("tmux.socketName and tmux.socketPath are mutually exclusive");
  }
  if (value.socketName !== undefined
    && (typeof value.socketName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.socketName))) {
    throw new Error("tmux.socketName is invalid");
  }
  if (value.socketPath !== undefined && (
    typeof value.socketPath !== "string"
    || !isAbsolute(value.socketPath)
    || resolve(value.socketPath) !== value.socketPath
    || value.socketPath.includes("\0")
  )) {
    throw new Error("tmux.socketPath must be an absolute normalized path");
  }
  return {
    executable,
    ...(value.socketName === undefined ? {} : { socketName: value.socketName as string }),
    ...(value.socketPath === undefined ? {} : { socketPath: value.socketPath as string }),
  };
}

export function parseTerminalControlWalRecorderConfig(
  value: unknown,
): NormalizedTerminalControlWalRecorderConfig {
  if (!isPlainObject(value)) throw new Error("terminal control WAL config must be an object");
  exactKeys(
    value,
    ["worker"],
    ["tmux", "readyTimeoutMs", "maxPreReadyEventBytes", "maxControlLineBytes"],
    "terminal control WAL config",
  );
  const maxControlLineBytes = boundedOption(
    value.maxControlLineBytes,
    DEFAULT_MAX_CONTROL_LINE_BYTES,
    "maxControlLineBytes",
    256 * 1024 * 1024,
  );
  return {
    worker: parseTerminalWalWorkerConfig(value.worker),
    tmux: parseTmuxOptions(value.tmux),
    readyTimeoutMs: boundedOption(value.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, "readyTimeoutMs", 300_000),
    maxPreReadyEventBytes: boundedOption(
      value.maxPreReadyEventBytes,
      DEFAULT_MAX_PRE_READY_EVENT_BYTES,
      "maxPreReadyEventBytes",
      256 * 1024 * 1024,
    ),
    maxControlLineBytes,
  };
}

function validateNormalizedRecorderConfig(
  value: NormalizedTerminalControlWalRecorderConfig,
): NormalizedTerminalControlWalRecorderConfig {
  if (!isPlainObject(value) || !isPlainObject(value.worker) || !isPlainObject(value.worker.paths)) {
    throw new Error("normalized terminal control WAL config is invalid");
  }
  exactKeys(
    value,
    ["worker", "tmux", "readyTimeoutMs", "maxPreReadyEventBytes", "maxControlLineBytes"],
    [],
    "normalized terminal control WAL config",
  );
  const reparsed = parseTerminalControlWalRecorderConfig({
    worker: {
      directory: value.worker.paths.directory,
      identity: value.worker.identity,
      geometry: value.worker.geometry,
      maxBufferedOutputBytes: value.worker.maxBufferedOutputBytes,
      maxOutputRecordBytes: value.worker.maxOutputRecordBytes,
      maxControlFrameBytes: value.worker.maxControlFrameBytes,
    },
    tmux: value.tmux,
    readyTimeoutMs: value.readyTimeoutMs,
    maxPreReadyEventBytes: value.maxPreReadyEventBytes,
    maxControlLineBytes: value.maxControlLineBytes,
  });
  for (const key of ["directory", "walPath", "socketPath", "lockPath"] as const) {
    if (value.worker.paths[key] !== reparsed.worker.paths[key]) {
      throw new Error("normalized terminal control WAL paths must be derived from directory");
    }
  }
  return reparsed;
}

export function parseTerminalControlWalRecorderConfigJson(
  json: string,
): NormalizedTerminalControlWalRecorderConfig {
  if (typeof json !== "string" || json.length === 0) {
    throw new Error(`${TERMINAL_CONTROL_WAL_CONFIG_ENV} must contain JSON`);
  }
  if (Buffer.byteLength(json) > MAX_CONFIG_JSON_BYTES) {
    throw new Error(`${TERMINAL_CONTROL_WAL_CONFIG_ENV} exceeds ${MAX_CONFIG_JSON_BYTES} bytes`);
  }
  try {
    return parseTerminalControlWalRecorderConfig(JSON.parse(json));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${TERMINAL_CONTROL_WAL_CONFIG_ENV} is not valid JSON`);
    }
    throw error;
  }
}

function tmuxSelectorArgs(tmux: NormalizedTerminalControlWalRecorderConfig["tmux"]): string[] {
  if (tmux.socketName) return ["-L", tmux.socketName];
  if (tmux.socketPath) return ["-S", tmux.socketPath];
  return [];
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} is not an unsigned integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is out of range`);
  return number;
}

const IDENTITY_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{window_id}",
  "#{pane_id}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pid}",
  "#{session_created}",
].join("|");

export async function resolveTerminalControlSourceIdentity(
  config: NormalizedTerminalControlWalRecorderConfig,
): Promise<TerminalControlSourceIdentity> {
  const args = [
    ...tmuxSelectorArgs(config.tmux),
    "display-message",
    "-p",
    "-t",
    config.worker.identity.paneTarget,
    IDENTITY_FORMAT,
  ];
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveExec, rejectExec) => {
    execFile(
      config.tmux.executable,
      args,
      { encoding: "utf8", timeout: config.readyTimeoutMs, maxBuffer: 64 * 1024 },
      (error, resultStdout, resultStderr) => {
        if (error) {
          rejectExec(new Error(`tmux identity query failed: ${error.message}`));
          return;
        }
        resolveExec({ stdout: resultStdout, stderr: resultStderr });
      },
    );
  });
  if (stderr.trim().length !== 0) throw new Error(`tmux identity query wrote stderr: ${stderr.trim()}`);
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error("tmux identity query must return exactly one line");
  const parts = lines[0]!.split("|");
  if (parts.length !== 10) throw new Error("tmux identity query returned an invalid field count");
  const [session, sessionId, windowId, paneId, windowIndex, paneIndex, cols, rows, pid, created] = parts;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session!)) {
    throw new Error("tmux identity query returned an invalid session name");
  }
  if (!/^\$\d+$/.test(sessionId!) || !/^@\d+$/.test(windowId!) || !/^%\d+$/.test(paneId!)) {
    throw new Error("tmux identity query returned an invalid object ID");
  }
  const paneTarget = `=${session}:${positiveInteger(windowIndex!, "window index")}.${positiveInteger(paneIndex!, "pane index")}`;
  return {
    session: session!,
    sessionId: sessionId!,
    windowId: windowId!,
    paneId: paneId!,
    paneTarget,
    geometry: {
      cols: positiveInteger(cols!, "pane width"),
      rows: positiveInteger(rows!, "pane height"),
    },
    tmuxServerPid: positiveInteger(pid!, "tmux server pid"),
    sessionCreated: positiveInteger(created!, "session created"),
  };
}

function defaultSpawnControl(executable: string, args: string[]): TerminalControlProcess {
  return spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
}

async function defaultReconcilePause(
  recorder: NormalizedTerminalControlWalRecorderConfig,
  request: TerminalControlPauseReconcileRequest,
): Promise<TerminalControlRecoveryCapture> {
  if (request.source.geometry.rows > 10_000) {
    throw new Error("tmux pause reconciliation exceeds the 10000-row memory budget");
  }
  const start = -(10_000 - request.source.geometry.rows);
  const args = [
    ...tmuxSelectorArgs(recorder.tmux),
    "capture-pane",
    "-p",
    "-e",
    "-S",
    String(start),
    "-t",
    request.paneId,
  ];
  const captured = await new Promise<{ bytes: Buffer; truncated: boolean }>((resolveCapture, rejectCapture) => {
    execFile(recorder.tmux.executable, args, {
      encoding: "buffer",
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (stderr.byteLength !== 0) {
        rejectCapture(new Error("tmux pause reconciliation wrote stderr"));
        return;
      }
      const bytes = Buffer.from(stdout).subarray(0, 8 * 1024 * 1024);
      if (error && !("killed" in error && error.killed)
        && !("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
        rejectCapture(new Error(`tmux pause reconciliation failed: ${error.message}`));
        return;
      }
      resolveCapture({ bytes, truncated: error !== null || Buffer.byteLength(stdout) > bytes.byteLength });
    });
  });
  const observed = await resolveTerminalControlSourceIdentity(recorder);
  if (observed.sessionId !== request.source.sessionId
    || observed.windowId !== request.source.windowId
    || observed.paneId !== request.source.paneId
    || observed.paneTarget !== request.source.paneTarget
    || observed.tmuxServerPid !== request.source.tmuxServerPid
    || observed.sessionCreated !== request.source.sessionCreated) {
    throw new Error("tmux pause reconciliation source identity changed");
  }
  const recoveredRows = captured.bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  return {
    recoveredBytes: captured.bytes,
    recoveredRows: Math.min(recoveredRows, 10_000),
    truncated: captured.truncated || recoveredRows > 10_000,
    identity: observed,
    geometry: observed.geometry,
    // Without a unique byte/sequence anchor the ring is evidence beside the
    // gap, never permission to splice it into the canonical byte stream.
    boundary: "ambiguous",
  };
}

function sameGeometry(left: TerminalGeometry, right: TerminalGeometry): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

function validateSource(
  config: NormalizedTerminalControlWalRecorderConfig,
  sessionChanged: { sessionId: string; session: string },
  source: TerminalControlSourceIdentity,
): void {
  const expected = config.worker;
  if (sessionChanged.session !== expected.identity.session || source.session !== expected.identity.session) {
    throw new Error("tmux attached session name does not match WAL identity");
  }
  if (sessionChanged.sessionId !== source.sessionId) {
    throw new Error("tmux attached session ID changed during identity validation");
  }
  if (source.paneTarget !== expected.identity.paneTarget) {
    throw new Error("tmux pane target does not match exact WAL pane target");
  }
  if (source.tmuxServerPid !== expected.identity.tmuxServerPid
    || source.sessionCreated !== expected.identity.sessionCreated) {
    throw new Error("tmux source epoch does not match WAL identity");
  }
  if (!sameGeometry(source.geometry, expected.geometry)) {
    throw new Error("tmux source geometry does not match WAL start geometry");
  }
}

function eventBytes(event: PendingRecorderEvent): number {
  if (event.kind === "output" || event.kind === "raw-wal-line") return event.bytes.byteLength;
  return 256;
}

function bytesStartWith(line: Uint8Array, prefix: string): boolean {
  if (line.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (line[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function isWalNotification(line: Uint8Array): boolean {
  return bytesStartWith(line, "%output ")
    || bytesStartWith(line, "%extended-output ")
    || bytesStartWith(line, "%layout-change ");
}

/** Decode protocol-only lines; terminal output payload never passes here. */
function strictAsciiControlLine(line: Uint8Array): string {
  if (line.byteLength === 0) throw new Error("tmux control notification must not be empty");
  for (const byte of line) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error("tmux control protocol line contains a non-ASCII byte");
    }
  }
  return Buffer.from(line).toString("ascii");
}

export function terminalControlWalStatusPath(directory: string): string {
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("terminal control WAL status directory must be absolute and normalized");
  }
  return join(directory, TERMINAL_CONTROL_WAL_STATUS_FILE);
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("terminal control WAL status write made no progress");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateStatusDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (realpathSync(directory) !== directory) {
    throw new Error("terminal control WAL status directory must not resolve through a symlink");
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const path = terminalControlWalStatusPath(directory);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("terminal control WAL status path must be a regular file");
    }
  }
}

function persistTerminalControlWalHealth(directory: string, health: TerminalControlWalHealth): void {
  ensurePrivateStatusDirectory(directory);
  const path = terminalControlWalStatusPath(directory);
  const temporary = join(
    directory,
    `.${TERMINAL_CONTROL_WAL_STATUS_FILE}.tmp-${process.pid}-${health.updatedAt}`,
  );
  let fd = -1;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_DSYNC,
      PRIVATE_FILE_MODE,
    );
    writeAll(fd, Buffer.from(`${JSON.stringify(health)}\n`, "utf8"));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function readTerminalControlWalHealth(directory: string): TerminalControlWalHealth | null {
  const path = terminalControlWalStatusPath(directory);
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainObject(value)
    || value.version !== 1
    || (value.state !== "attaching" && value.state !== "ready"
      && value.state !== "end-armed" && value.state !== "disconnected" && value.state !== "fatal")
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || !Number.isSafeInteger(value.updatedAt)
    || (value.updatedAt as number) < 0
    || (value.source !== null && !isPlainObject(value.source))
    || (value.degraded !== undefined && typeof value.degraded !== "boolean")
    || (value.alert !== undefined && typeof value.alert !== "string")
    || (value.error !== undefined && typeof value.error !== "string")) {
    throw new Error("terminal control WAL status file is invalid");
  }
  return value as TerminalControlWalHealth;
}

/**
 * Ordered tmux control-mode capture lane.
 *
 * stdout is consumed one complete notification at a time. WAL writes are
 * synchronous+durable, so a layout PREPARE/COMMIT finishes before the next
 * output notification is removed from the stream buffer.
 */
export class TerminalControlWalRecorder {
  readonly config: NormalizedTerminalControlWalRecorderConfig;
  private readonly dependencies: Required<Pick<TerminalControlWalRecorderDependencies, "spawnControl" | "resolveIdentity" | "reconcilePause">>
    & Pick<TerminalControlWalRecorderDependencies, "onFatal" | "onAlert">;
  private readonly input = new PassThrough();
  private readonly worker: TerminalWalWorker;
  private readonly sourceEpoch = randomUUID();
  private readonly stream: TmuxControlStreamBuffer;
  private process: TerminalControlProcess | null = null;
  private state: TerminalControlWalRecorderStatus["state"] = "created";
  private source: TerminalControlSourceIdentity | null = null;
  private fatalError: Error | null = null;
  private degraded = false;
  private alertMessage: string | null = null;
  private readonly recoveryQueue: TerminalControlPauseReconcileRequest[] = [];
  private recoveryRunning = false;
  private activeRecovery: TerminalControlPauseReconcileRequest | null = null;
  private readonly settledGapIds = new Set<string>();
  private pauseTimes: number[] = [];
  private attachCommandDone = false;
  private commandBlock: { at: string; number: string; flags: string } | null = null;
  private sessionChanged: { sessionId: string; session: string } | null = null;
  private validationStarted = false;
  private pendingEvents: PendingRecorderEvent[] = [];
  private pendingEventBytes = 0;
  private layoutCounter = 0;
  private endOnSourceExit = false;
  private stderr = Buffer.alloc(0);
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private readySettled = false;
  private pendingContinueAck: {
    paneId: string;
    request: TerminalControlPauseReconcileRequest;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    config: TerminalControlWalRecorderConfig | NormalizedTerminalControlWalRecorderConfig,
    dependencies: TerminalControlWalRecorderDependencies = {},
  ) {
    this.config = "maxPreReadyEventBytes" in config && "paths" in config.worker
      ? validateNormalizedRecorderConfig(config as NormalizedTerminalControlWalRecorderConfig)
      : parseTerminalControlWalRecorderConfig(config);
    this.dependencies = {
      spawnControl: dependencies.spawnControl ?? defaultSpawnControl,
      resolveIdentity: dependencies.resolveIdentity ?? resolveTerminalControlSourceIdentity,
      reconcilePause: dependencies.reconcilePause ?? ((request) => defaultReconcilePause(this.config, request)),
      ...(dependencies.onFatal === undefined ? {} : { onFatal: dependencies.onFatal }),
      ...(dependencies.onAlert === undefined ? {} : { onAlert: dependencies.onAlert }),
    };
    this.worker = new TerminalWalWorker(this.config.worker, { input: this.input, walFormat: 2 });
    this.stream = new TmuxControlStreamBuffer({
      maxLineBytes: this.config.maxControlLineBytes,
      maxBufferedBytes: this.config.maxControlLineBytes + 64 * 1024,
    });
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
  }

  get status(): TerminalControlWalRecorderStatus {
    return {
      state: this.state,
      source: this.source,
      pendingEventBytes: this.pendingEventBytes,
      bufferedControlBytes: this.stream.bufferedBytes,
      fatalMessage: this.fatalError?.message ?? null,
      degraded: this.degraded,
      alert: this.alertMessage,
    };
  }

  async start(): Promise<void> {
    if (this.state !== "created") return await this.readyPromise;
    this.state = "attaching";
    const args = [
      ...tmuxSelectorArgs(this.config.tmux),
      "-C",
      "attach-session",
      "-f",
      "read-only,ignore-size,pause-after=1",
      "-t",
      this.config.worker.identity.paneTarget,
    ];
    try {
      this.writeHealth("attaching");
      const child = this.dependencies.spawnControl(this.config.tmux.executable, args);
      this.process = child;
      child.stdout.on("data", this.handleStdout);
      child.stdout.once("end", this.handleStdoutEnd);
      child.stderr.on("data", this.handleStderr);
      child.once("error", (error) => this.fail(error));
      child.once("exit", (code, signal) => {
        if (this.state === "disconnected" || this.state === "exiting") return;
        if (code !== 0 || signal) {
          this.fail(new Error(`tmux control client exited code=${code} signal=${signal}`));
        }
      });
      this.readyTimer = setTimeout(() => {
        this.fail(new Error(`tmux control recorder was not ready within ${this.config.readyTimeoutMs}ms`));
      }, this.config.readyTimeoutMs);
    } catch (error) {
      this.fail(error);
    }
    return await this.readyPromise;
  }

  /** Disconnect this source client; the logical terminal remains resumable. */
  async stop(): Promise<void> {
    return await this.teardown(false);
  }

  /**
   * Arm an ordered END. Capture continues until tmux itself emits %exit; only
   * then is END appended after every preceding notification is durable.
   */
  armLogicalEndOnSourceExit(): void {
    if (this.state === "end-armed") return;
    if (this.state !== "ready" || !this.worker.status.started || !this.source) {
      throw new Error("logical END can only be armed while terminal capture is ready");
    }
    this.endOnSourceExit = true;
    this.state = "end-armed";
    try {
      // This atomic health transition is the detached host's ACK. It must be
      // visible before the host kills the tmux session/source.
      this.writeHealth("end-armed");
    } catch (error) {
      this.endOnSourceExit = false;
      this.state = "ready";
      throw error;
    }
  }

  /** Cancel a previously armed END when the host could not stop tmux. */
  cancelLogicalEndOnSourceExit(): void {
    if (this.state === "ready" && !this.endOnSourceExit) return;
    if (this.state !== "end-armed" || !this.endOnSourceExit) {
      throw new Error("logical END is not armed");
    }
    this.endOnSourceExit = false;
    this.state = "ready";
    try {
      this.writeHealth("ready");
    } catch (error) {
      this.endOnSourceExit = true;
      this.state = "end-armed";
      throw error;
    }
  }

  /**
   * Close an already disconnected source's logical lifecycle. Active capture
   * must use armLogicalEndOnSourceExit so unread pipe bytes cannot be skipped.
   */
  async closeLogicalLifecycle(): Promise<void> {
    if (this.state === "ready" || this.state === "end-armed"
      || this.state === "validating" || this.state === "attaching" || this.state === "exiting") {
      throw new Error("cannot write logical END while the tmux source is active; arm END and wait for %exit");
    }
    if (this.state === "fatal") {
      throw new Error("cannot write logical END after a fatal capture error");
    }
    if (!this.worker.status.started) {
      if (!existsSync(this.config.worker.paths.walPath)) {
        if (this.state !== "disconnected") await this.teardown(false);
        throw new Error("cannot close a logical lifecycle before its WAL START");
      }
      if (this.state !== "disconnected") await this.teardown(false);
      const closer = new TerminalWalWorker(this.config.worker, { input: new PassThrough(), walFormat: 2 });
      await closer.start();
      await closer.closeLogicalLifecycle();
      this.writeHealth("disconnected");
      return;
    }
    return await this.teardown(true);
  }

  /** Explicit teardown kills only this read-only client, never the tmux session. */
  private async teardown(writeLifecycleEnd: boolean): Promise<void> {
    if (this.state === "disconnected") return;
    this.state = "exiting";
    if (this.pendingContinueAck) {
      clearTimeout(this.pendingContinueAck.timer);
      this.pendingContinueAck = null;
    }
    this.process?.stdout.pause();
    this.process?.kill("SIGTERM");
    if (this.worker.status.started) {
      if (writeLifecycleEnd) await this.worker.closeLogicalLifecycle();
      else await this.worker.stop();
    }
    this.state = "disconnected";
    if (this.fatalError) this.writeHealth("fatal", this.fatalError.message);
    else this.writeHealth("disconnected");
    this.clearReadyTimer();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error("terminal control WAL recorder stopped before readiness"));
    }
  }

  private readonly handleStdout = (chunk: Uint8Array): void => {
    if (this.state === "fatal" || this.state === "disconnected" || this.state === "exiting") return;
    try {
      this.stream.append(chunk);
      while (true) {
        const line = this.stream.peekLine();
        if (line === null) break;
        this.handleLine(line);
        // A line leaves memory only after parsing and every synchronous WAL
        // side effect succeeded. On failure, this line and all later bytes stay
        // retained while stdout is paused.
        this.stream.consumeLine();
        if (this.shouldStopReading()) break;
      }
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.state === "disconnected" || this.state === "exiting" || this.state === "fatal") return;
    try {
      this.stream.finish();
      this.fail(new Error("tmux control stdout ended without %exit"));
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly handleStderr = (chunk: Uint8Array): void => {
    this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]);
    if (this.stderr.byteLength > DEFAULT_MAX_STDERR_BYTES) {
      this.fail(new Error("tmux control stderr exceeds diagnostic limit"));
    }
  };

  private handleLine(bytes: Uint8Array): void {
    if (this.commandBlock) {
      // Command payload is arbitrary rendered text (including UTF-8 and
      // notification lookalikes). Only the matching terminator is protocol.
      // refresh-client may emit the actual continue acknowledgement here;
      // accept only the pane for which this recorder has a pending request.
      const line = Buffer.from(bytes).toString("utf8");
      if (this.pendingContinueAck && line === `%continue ${this.pendingContinueAck.paneId}`) {
        this.enqueueOrApply({ kind: "continue", paneId: this.pendingContinueAck.paneId });
        return;
      }
      const end = /^(%end|%error) (\d+) (\d+) (\d+)$/.exec(line);
      if (!end) return;
      if (end[2] !== this.commandBlock.at
        || end[3] !== this.commandBlock.number
        || end[4] !== this.commandBlock.flags) {
        throw new Error("tmux control command block terminator does not match %begin");
      }
      this.commandBlock = null;
      if (end[1] === "%error") throw new Error("tmux control command returned %error");
      if (!this.attachCommandDone) this.attachCommandDone = true;
      this.maybeBeginValidation();
      return;
    }

    if (isWalNotification(bytes)) {
      // Keep notifications byte-exact until the exact pane/window identity is
      // known. In particular tmux 3.4 emits printable UTF-8 bytes raw while
      // octal-escaping control bytes in the same payload. Command response
      // payload was handled above and must never reach this notification path.
      this.enqueueOrApply({ kind: "raw-wal-line", bytes: Buffer.from(bytes) });
      return;
    }

    const line = strictAsciiControlLine(bytes);
    const pause = /^%(pause|continue) (%\d+)$/.exec(line);
    if (pause) {
      // tmux 3.4 may send %continue before the %end for refresh-client.
      const event: PendingRecorderEvent = { kind: pause[1] as "pause" | "continue", paneId: pause[2]! };
      this.enqueueOrApply(event);
      return;
    }
    const begin = /^%begin (\d+) (\d+) (\d+)$/.exec(line);
    if (begin) {
      this.commandBlock = { at: begin[1]!, number: begin[2]!, flags: begin[3]! };
      return;
    }

    const session = /^%session-changed (\$\d+) ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(line);
    if (session) {
      if (session[2] !== this.config.worker.identity.session) {
        throw new Error("tmux control client attached to the wrong session");
      }
      if (this.sessionChanged && (
        this.sessionChanged.sessionId !== session[1] || this.sessionChanged.session !== session[2]
      )) {
        throw new Error("tmux control client changed session identity");
      }
      this.sessionChanged = { sessionId: session[1]!, session: session[2]! };
      this.maybeBeginValidation();
      return;
    }

    if (line === "%exit" || line.startsWith("%exit ")) {
      this.state = "exiting";
      this.process?.stdout.pause();
      queueMicrotask(() => void this.finishFromExit());
      return;
    }

    if (line.startsWith("%config-error ")) {
      throw new Error(`tmux control configuration error: ${line.slice("%config-error ".length)}`);
    }

    // Known notifications that do not carry terminal bytes. Identity-changing
    // notifications are intentionally rejected instead of guessed through.
    if (line === "%sessions-changed"
      || /^%message [ -~]*$/.test(line)
      || /^%paste-buffer-(?:changed|deleted) [^ ]+$/.test(line)
      || /^%unlinked-window-(?:add|close|renamed) @\d+(?: [ -~]+)?$/.test(line)
      || /^%window-renamed @\d+ [ -~]+$/.test(line)) {
      return;
    }
    if (/^%(?:session-renamed|client-session-changed|client-detached|session-window-changed|window-add|window-close|window-pane-changed|pane-mode-changed)\b/.test(line)) {
      throw new Error(`tmux control identity changed: ${line}`);
    }
    throw new Error(`unsupported tmux control notification: ${line}`);
  }

  private maybeBeginValidation(): void {
    if (!this.attachCommandDone || !this.sessionChanged || this.validationStarted || this.fatalError) return;
    this.validationStarted = true;
    this.state = "validating";
    void this.dependencies.resolveIdentity(this.config).then(async (source) => {
      if (this.fatalError || this.state !== "validating") return;
      validateSource(this.config, this.sessionChanged!, source);
      this.source = source;
      await this.worker.start();
      if (this.fatalError || this.state !== "validating") {
        await this.worker.stop();
        return;
      }
      this.state = "ready";
      for (const event of this.pendingEvents) this.applyEvent(event);
      this.pendingEvents = [];
      this.pendingEventBytes = 0;
      this.writeHealth("ready");
      this.clearReadyTimer();
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady();
      }
    }).catch((error) => this.fail(error));
  }

  private enqueueOrApply(event: PendingRecorderEvent): void {
    if (this.state === "ready" || this.state === "end-armed") {
      this.applyEvent(event);
      return;
    }
    this.pendingEvents.push(event);
    this.pendingEventBytes += eventBytes(event);
    if (this.pendingEventBytes > this.config.maxPreReadyEventBytes) {
      throw new Error(`tmux pre-ready events exceed ${this.config.maxPreReadyEventBytes} bytes`);
    }
  }

  private applyEvent(event: PendingRecorderEvent): void {
    const source = this.source;
    if (!source) throw new Error("terminal control source is not validated");
    if (event.kind === "raw-wal-line") {
      this.applyEvent(parseTmuxControlWalBytesLine(event.bytes, {
        paneId: source.paneId,
        windowId: source.windowId,
      }));
      return;
    }
    if (event.kind === "pause" || event.kind === "continue") {
      if (event.paneId !== source.paneId) throw new Error(`tmux ${event.kind} came from the wrong pane`);
      if (event.kind === "pause") {
        // appendOrderedGap returns only after fsync. If it throws, fail()
        // pauses stdout and this continue command is never sent.
        const gapId = randomUUID();
        this.degraded = true;
        const gap = this.worker.appendOrderedGap({
          gapId,
          sourceEpoch: this.sourceEpoch,
          paneId: event.paneId,
          reason: "tmux-pause",
          detectedAt: Date.now(),
          missingBytes: null,
          coverage: "unknown",
        });
        const request = {
          gapId,
          paneId: event.paneId,
          source,
          capturedSeqBefore: (gap.sequence - 1n).toString(),
        };
        const now = Date.now();
        this.pauseTimes = this.pauseTimes.filter((at) => now - at < 60_000);
        this.pauseTimes.push(now);
        if (this.pauseTimes.length >= 3) {
          this.tripRecoveryLimit(request, "tmux pause rate reached 3 events within 60 seconds");
          return;
        }
        this.continuePane(request);
      } else {
        // Acknowledge the pending continue timer so it does not fire.
        if (this.pendingContinueAck?.paneId === event.paneId) {
          const pending = this.pendingContinueAck;
          clearTimeout(pending.timer);
          this.pendingContinueAck = null;
          this.enqueueRecovery(pending.request);
        }
      }
      return;
    }
    if (event.kind === "output") {
      if (event.paneId !== source.paneId) throw new Error("tmux output came from the wrong pane");
      this.worker.appendOrderedOutput(event.bytes);
      return;
    }
    if (event.windowId !== source.windowId || event.paneId !== source.paneId) {
      throw new Error("tmux layout-change came from the wrong window or pane");
    }
    this.layoutCounter += 1;
    this.worker.recordOrderedResize(
      event.geometry,
      `layout:${this.layoutCounter}`,
      "tmux-control-layout",
    );
  }

  private continuePane(request: TerminalControlPauseReconcileRequest): void {
    const { paneId } = request;
    // Validate paneId before using it to construct the command.
    // An unexpected format is an error path, not something to forward to tmux.
    if (!/^%[0-9]+$/.test(paneId)) {
      throw new Error(`tmux pause pane ID does not match expected format: ${paneId}`);
    }
    const child = this.process;
    if (!child || !child.stdin.writable) throw new Error("tmux control stdin is not writable");
    // Clear any previous pending ack that was not resolved (should not happen
    // in normal operation since tmux sends %pause per pane, not concurrently).
    if (this.pendingContinueAck) {
      clearTimeout(this.pendingContinueAck.timer);
      this.pendingContinueAck = null;
    }
    // tmux 3.4 requires the pane-action argument to be quoted; sending
    // %<id>:continue without quotes causes a parse error and %error response.
    // Verified live: unquoted → %error (50ms); quoted → %continue (50ms).
    const timer = setTimeout(() => {
      this.fail(new Error(`tmux %continue for ${paneId} was not acknowledged within 2000ms`));
    }, 2_000);
    this.pendingContinueAck = { paneId, request, timer };
    child.stdin.write(`refresh-client -A "${paneId}:continue"\n`, (error) => {
      if (error) this.fail(error);
    });
  }

  private enqueueRecovery(request: TerminalControlPauseReconcileRequest): void {
    this.recoveryQueue.push(request);
    if (this.recoveryQueue.length + (this.recoveryRunning ? 1 : 0) > 8) {
      this.tripRecoveryLimit(request, "tmux pause recovery queue exceeded 8 jobs");
      return;
    }
    void this.drainRecoveryQueue();
  }

  private async drainRecoveryQueue(): Promise<void> {
    if (this.recoveryRunning || this.fatalError) return;
    const request = this.recoveryQueue.shift();
    if (!request) return;
    this.recoveryRunning = true;
    this.activeRecovery = request;
    try {
      const capture = await this.dependencies.reconcilePause(request);
      if (!this.settledGapIds.has(request.gapId)) {
        if (!capture) throw new Error("pause reconciliation returned no result");
        this.appendRecoveryResult(request, capture);
      }
    } catch (error) {
      if (!this.settledGapIds.has(request.gapId)) this.appendRecoveryFailure(request, error);
      for (const queued of this.recoveryQueue.splice(0)) {
        if (!this.settledGapIds.has(queued.gapId)) {
          this.appendRecoveryFailure(queued, new Error("pause reconciliation aborted after prior failure"));
        }
      }
      this.fail(error);
    } finally {
      this.activeRecovery = null;
      this.recoveryRunning = false;
      if (!this.fatalError) void this.drainRecoveryQueue();
    }
  }

  private recoveryIdentity(identity: TerminalControlSourceIdentity) {
    return {
      session: identity.session,
      sessionId: identity.sessionId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      paneTarget: identity.paneTarget,
      tmuxServerPid: identity.tmuxServerPid,
      sessionCreated: identity.sessionCreated,
    };
  }

  private appendRecoveryResult(
    request: TerminalControlPauseReconcileRequest,
    capture: TerminalControlRecoveryCapture,
  ): void {
    const status = capture.boundary === "matched" && !capture.truncated ? "success" : "ambiguous";
    this.worker.appendOrderedRecovery({
      gapId: request.gapId,
      sourceEpoch: this.sourceEpoch,
      paneId: request.paneId,
      provenance: "recovered-from-ring",
      status,
      recoveredBytesBase64: Buffer.from(capture.recoveredBytes).toString("base64"),
      recoveredRows: capture.recoveredRows,
      truncated: capture.truncated,
      identity: this.recoveryIdentity(capture.identity),
      geometry: capture.geometry,
      capturedSeqBefore: request.capturedSeqBefore,
      capturedSeqAfter: this.worker.lastDurableSequence.toString(),
      boundary: capture.boundary,
    } satisfies OutputWalRecoverySnapshot);
    this.settledGapIds.add(request.gapId);
  }

  private appendRecoveryFailure(request: TerminalControlPauseReconcileRequest, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\0\r\n]/g, " ").slice(0, 2_048);
    this.worker.appendOrderedRecovery({
      gapId: request.gapId,
      sourceEpoch: this.sourceEpoch,
      paneId: request.paneId,
      provenance: "recovered-from-ring",
      status: "failed",
      recoveredBytesBase64: "",
      recoveredRows: null,
      truncated: null,
      identity: this.recoveryIdentity(request.source),
      geometry: request.source.geometry,
      capturedSeqBefore: request.capturedSeqBefore,
      capturedSeqAfter: this.worker.lastDurableSequence.toString(),
      boundary: null,
      error: message,
    });
    this.settledGapIds.add(request.gapId);
  }

  private tripRecoveryLimit(current: TerminalControlPauseReconcileRequest, message: string): void {
    const pending = [this.activeRecovery, ...this.recoveryQueue.splice(0), current]
      .filter((request): request is TerminalControlPauseReconcileRequest => request !== null);
    for (const request of pending) {
      if (!this.settledGapIds.has(request.gapId)) this.appendRecoveryFailure(request, new Error(message));
    }
    this.alertMessage = message;
    this.dependencies.onAlert?.(message);
    this.fail(new Error(message));
  }

  private async finishFromExit(): Promise<void> {
    try {
      if (!this.worker.status.started) {
        throw new Error("tmux control client exited before WAL readiness");
      }
      // %exit itself is the ordered source boundary. tmux 3.4 can emit
      // informational notifications after it (for example %window-renamed),
      // so bytes after this complete line are deliberately outside the WAL
      // source epoch and must not turn a safely drained END into a fatal.
      // %exit closes only this source epoch. The logical instance remains
      // active unless the host durably armed an explicit logical END first.
      if (this.endOnSourceExit) await this.worker.closeLogicalLifecycle();
      else await this.worker.stop();
      this.endOnSourceExit = false;
      this.state = "disconnected";
      this.writeHealth("disconnected");
      this.clearReadyTimer();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.fatalError || this.state === "disconnected") return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    this.state = "fatal";
    // Cancel any pending %continue acknowledgement timer to avoid a second
    // call to fail() after the first one has already set the fatal state.
    if (this.pendingContinueAck) {
      clearTimeout(this.pendingContinueAck.timer);
      this.pendingContinueAck = null;
    }
    // Detach only this read-only control client. The pane and tmux server are
    // owned by the host and must survive recorder failure/retry.
    // TODO(§3.2 item 7): persist failure/unclean-source gaps when possible;
    // a disk failure must never be reported as a successfully persisted gap.
    this.process?.stdout.pause();
    this.process?.kill("SIGTERM");
    void this.worker.stop({ writeLifecycleEnd: false }).catch(() => undefined);
    this.clearReadyTimer();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(this.fatalError);
    }
    try {
      this.writeHealth("fatal", this.fatalError.message);
    } catch {
      // The original failure remains authoritative (often the same disk).
    }
    this.dependencies.onFatal?.(this.fatalError);
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private shouldStopReading(): boolean {
    return this.state === "fatal" || this.state === "exiting" || this.state === "disconnected";
  }

  private writeHealth(
    state: TerminalControlWalHealth["state"],
    error?: string,
  ): void {
    persistTerminalControlWalHealth(this.config.worker.paths.directory, {
      version: 1,
      state,
      pid: process.pid,
      source: this.source,
      updatedAt: Date.now(),
      ...(this.degraded ? { degraded: true } : {}),
      ...(this.alertMessage === null ? {} : { alert: this.alertMessage }),
      ...(error === undefined
        ? {}
        : { error: error.replace(/[\0\r\n]/g, " ").slice(0, 2_048) }),
    });
  }

}

export type TerminalControlWalLifecycleSignal = "SIGTERM" | "SIGINT" | "SIGUSR1" | "SIGUSR2";

export type TerminalControlWalSignalTarget = {
  once(signal: TerminalControlWalLifecycleSignal, listener: () => void): unknown;
  on(signal: TerminalControlWalLifecycleSignal, listener: () => void): unknown;
};

export type TerminalControlWalSignalRecorder = Pick<
  TerminalControlWalRecorder,
  "stop" | "armLogicalEndOnSourceExit" | "cancelLogicalEndOnSourceExit"
>;

type TerminalControlWalRetryRecorder = TerminalControlWalSignalRecorder & {
  start(): Promise<void>;
};

export type TerminalControlWalRetrySupervisorDependencies = {
  factory: (onFatal: (error: Error) => void) => TerminalControlWalRetryRecorder;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  onAlert?: (message: string) => void;
};

/** Bounded source-epoch retry: 5s, 15s, 60s, then a durable external alert. */
export class TerminalControlWalRetrySupervisor implements TerminalControlWalSignalRecorder {
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly now: () => number;
  private current: TerminalControlWalRetryRecorder | null = null;
  private timer: unknown = null;
  private stopped = false;
  private failures: number[] = [];
  private readonly handled = new Set<TerminalControlWalRetryRecorder>();

  constructor(private readonly dependencies: TerminalControlWalRetrySupervisorDependencies) {
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = dependencies.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = dependencies.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.current || this.stopped) return;
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    let recorder!: TerminalControlWalRetryRecorder;
    recorder = this.dependencies.factory((error) => { void this.handleFailure(recorder, error); });
    this.current = recorder;
    try {
      await recorder.start();
    } catch (error) {
      await this.handleFailure(recorder, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleFailure(recorder: TerminalControlWalRetryRecorder, error: Error): Promise<void> {
    if (this.stopped || this.current !== recorder || this.handled.has(recorder)) return;
    this.handled.add(recorder);
    await recorder.stop().catch(() => undefined);
    if (this.current === recorder) this.current = null;
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < 5 * 60_000);
    this.failures.push(now);
    const retryIndex = this.failures.length - 1;
    const delays = [5_000, 15_000, 60_000] as const;
    if (retryIndex >= delays.length) {
      const message = `terminal control WAL stopped after 3 retries within 5 minutes: ${error.message}`;
      this.dependencies.onAlert?.(message);
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.launch();
    }, delays[retryIndex]!);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    const recorder = this.current;
    this.current = null;
    if (recorder) await recorder.stop();
  }

  armLogicalEndOnSourceExit(): void {
    if (!this.current) throw new Error("terminal control WAL has no active recorder epoch");
    this.current.armLogicalEndOnSourceExit();
  }

  cancelLogicalEndOnSourceExit(): void {
    if (!this.current) throw new Error("terminal control WAL has no active recorder epoch");
    this.current.cancelLogicalEndOnSourceExit();
  }
}

/**
 * Standalone-runner signal contract:
 * SIGTERM/SIGINT detach a source epoch. SIGUSR2 arms END-on-%exit without
 * pausing capture; SIGUSR1 cancels that arm if the host cannot stop tmux.
 */
export function installTerminalControlWalSignalHandlers(
  recorder: TerminalControlWalSignalRecorder,
  options: {
    target?: TerminalControlWalSignalTarget;
    onError?: (error: Error) => void;
  } = {},
): void {
  const target = options.target ?? process;
  const report = options.onError ?? (() => undefined);
  const invoke = (operation: () => Promise<void> | void) => {
    try {
      void Promise.resolve(operation()).catch((error) => {
        report(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
    }
  };
  target.once("SIGTERM", () => invoke(() => recorder.stop()));
  target.once("SIGINT", () => invoke(() => recorder.stop()));
  // USR signals stay reusable: a failed tmux kill may be cancelled and then
  // armed again by a later host reconciliation attempt.
  target.on("SIGUSR1", () => invoke(() => recorder.cancelLogicalEndOnSourceExit()));
  target.on("SIGUSR2", () => invoke(() => recorder.armLogicalEndOnSourceExit()));
}

export async function runTerminalControlWalRecorderFromEnvironment(): Promise<TerminalControlWalRetrySupervisor> {
  const config = parseTerminalControlWalRecorderConfigJson(
    process.env[TERMINAL_CONTROL_WAL_CONFIG_ENV] ?? "",
  );
  const supervisor = new TerminalControlWalRetrySupervisor({
    factory: (onFatal) => new TerminalControlWalRecorder(config, { onFatal }),
    onAlert: (message) => {
      console.error(`[thumbmux terminal-control-wal] alert: ${message}`);
      process.exitCode = 1;
    },
  });
  await supervisor.start();
  installTerminalControlWalSignalHandlers(supervisor, {
    onError: (error) => {
      console.error(`[thumbmux terminal-control-wal] fatal: ${error.message}`);
      process.exitCode = 1;
    },
  });
  return supervisor;
}
