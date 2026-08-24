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
  onFatal?: (error: Error) => void;
};

export type TerminalControlWalRecorderStatus = {
  state: "created" | "attaching" | "validating" | "ready" | "end-armed" | "exiting" | "disconnected" | "fatal";
  source: TerminalControlSourceIdentity | null;
  pendingEventBytes: number;
  bufferedControlBytes: number;
  fatalMessage: string | null;
};

export type TerminalControlWalHealth = {
  version: 1;
  state: "attaching" | "ready" | "end-armed" | "disconnected" | "fatal";
  pid: number;
  source: TerminalControlSourceIdentity | null;
  updatedAt: number;
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
  private readonly dependencies: Required<Pick<TerminalControlWalRecorderDependencies, "spawnControl" | "resolveIdentity">>
    & Pick<TerminalControlWalRecorderDependencies, "onFatal">;
  private readonly input = new PassThrough();
  private readonly worker: TerminalWalWorker;
  private readonly stream: TmuxControlStreamBuffer;
  private process: TerminalControlProcess | null = null;
  private state: TerminalControlWalRecorderStatus["state"] = "created";
  private source: TerminalControlSourceIdentity | null = null;
  private fatalError: Error | null = null;
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
      ...(dependencies.onFatal === undefined ? {} : { onFatal: dependencies.onFatal }),
    };
    this.worker = new TerminalWalWorker(this.config.worker, { input: this.input });
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
      const closer = new TerminalWalWorker(this.config.worker, { input: new PassThrough() });
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
    if (!this.commandBlock && isWalNotification(bytes)) {
      // Keep notifications byte-exact until the exact pane/window identity is
      // known. In particular tmux 3.4 emits printable UTF-8 bytes raw while
      // octal-escaping control bytes in the same payload.
      this.enqueueOrApply({ kind: "raw-wal-line", bytes: Buffer.from(bytes) });
      return;
    }

    const line = strictAsciiControlLine(bytes);
    if (this.commandBlock) {
      const end = /^(%end|%error) (\d+) (\d+) (\d+)$/.exec(line);
      if (!end) {
        throw new Error("tmux control command produced unexpected output");
      }
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

    const pause = /^%(pause|continue) (%\d+)$/.exec(line);
    if (pause) {
      const event: PendingRecorderEvent = { kind: pause[1] as "pause" | "continue", paneId: pause[2]! };
      this.enqueueOrApply(event);
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
      if (event.kind === "pause") this.continuePane(event.paneId);
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

  private continuePane(paneId: string): void {
    const child = this.process;
    if (!child || !child.stdin.writable) throw new Error("tmux control stdin is not writable");
    child.stdin.write(`refresh-client -A ${paneId}:continue\n`, (error) => {
      if (error) this.fail(error);
    });
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
    // Do not kill or keep reading: the retained stream bytes plus the kernel
    // pipe apply backpressure to tmux, preserving failure evidence/no-drop.
    this.process?.stdout.pause();
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

export async function runTerminalControlWalRecorderFromEnvironment(): Promise<TerminalControlWalRecorder> {
  const config = parseTerminalControlWalRecorderConfigJson(
    process.env[TERMINAL_CONTROL_WAL_CONFIG_ENV] ?? "",
  );
  const recorder = new TerminalControlWalRecorder(config, {
    onFatal: (error) => {
      console.error(`[thumbmux terminal-control-wal] fatal: ${error.message}`);
      process.exitCode = 1;
    },
  });
  await recorder.start();
  installTerminalControlWalSignalHandlers(recorder, {
    onError: (error) => {
      console.error(`[thumbmux terminal-control-wal] signal action failed: ${String(error)}`);
      process.exitCode = 1;
    },
  });
  return recorder;
}
