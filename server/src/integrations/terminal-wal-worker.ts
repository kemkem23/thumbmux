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
  unlinkSync,
  writeSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import {
  OutputWalWriter,
  parseOutputWalJson,
  readOutputWal,
  type OutputWalRecord,
} from "../output-wal";
import {
  TERMINAL_WAL_PROTOCOL_VERSION,
  parseTerminalGeometry,
  parseTerminalWalControlRequest,
  parseTerminalWalIdentity,
  parseTerminalWalReason,
  parseTerminalWalSafeId,
  resolveTerminalWalPaths,
  type TerminalGeometry,
  type TerminalWalAck,
  type TerminalWalControlError,
  type TerminalWalControlRequest,
  type TerminalWalIdentity,
  type TerminalWalLifecycleRecord,
  type TerminalWalPaths,
  type TerminalWalResizeRecord,
} from "./terminal-wal";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_CONFIG_JSON_BYTES = 64 * 1024;
const MAX_BUFFERED_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

export const TERMINAL_WAL_WORKER_CONFIG_ENV = "THUMBMUX_TERMINAL_WAL_CONFIG";

export type TerminalWalWorkerConfig = {
  directory: string;
  identity: TerminalWalIdentity;
  geometry: TerminalGeometry;
  maxBufferedOutputBytes?: number;
  maxOutputRecordBytes?: number;
  maxControlFrameBytes?: number;
};

export type NormalizedTerminalWalWorkerConfig = {
  paths: TerminalWalPaths;
  identity: TerminalWalIdentity;
  geometry: TerminalGeometry;
  maxBufferedOutputBytes: number;
  maxOutputRecordBytes: number;
  maxControlFrameBytes: number;
};

export type TerminalWalWorkerDependencies = {
  input?: Readable;
  clock?: () => number;
  onFatal?: (error: Error) => void;
};

export type TerminalWalWorkerStatus = {
  started: boolean;
  failed: boolean;
  geometry: TerminalGeometry;
  pendingChangeId: string | null;
  bufferedOutputBytes: number;
  inputBackpressured: boolean;
  controlConnected: boolean;
};

type PendingResize = Omit<TerminalWalResizeRecord, "phase">;

type ExistingWalState = {
  empty: boolean;
  active: boolean;
  logicalIdentity: Pick<TerminalWalIdentity, "session" | "instanceId"> | null;
  pendingResize: PendingResize | null;
};

class TerminalWalControlStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalWalControlStateError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactConfigKeys(value: Record<string, unknown>): void {
  const required = ["directory", "identity", "geometry"];
  const allowed = new Set([
    ...required,
    "maxBufferedOutputBytes",
    "maxOutputRecordBytes",
    "maxControlFrameBytes",
  ]);
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      throw new Error(`terminal WAL worker config.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`terminal WAL worker config.${key} is not allowed`);
  }
}

function boundedOption(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value as number;
}

export function parseTerminalWalWorkerConfig(value: unknown): NormalizedTerminalWalWorkerConfig {
  if (!isPlainObject(value)) throw new Error("terminal WAL worker config must be an object");
  assertExactConfigKeys(value);
  const maxOutputRecordBytes = boundedOption(
    value.maxOutputRecordBytes,
    DEFAULT_MAX_OUTPUT_RECORD_BYTES,
    "maxOutputRecordBytes",
    MAX_OUTPUT_RECORD_BYTES,
  );
  const maxBufferedOutputBytes = boundedOption(
    value.maxBufferedOutputBytes,
    DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
    "maxBufferedOutputBytes",
    MAX_BUFFERED_OUTPUT_BYTES,
  );
  if (maxBufferedOutputBytes < maxOutputRecordBytes) {
    throw new Error("maxBufferedOutputBytes must be at least maxOutputRecordBytes");
  }
  return {
    paths: resolveTerminalWalPaths(value.directory as string),
    identity: parseTerminalWalIdentity(value.identity),
    geometry: parseTerminalGeometry(value.geometry),
    maxBufferedOutputBytes,
    maxOutputRecordBytes,
    maxControlFrameBytes: boundedOption(
      value.maxControlFrameBytes,
      DEFAULT_MAX_CONTROL_FRAME_BYTES,
      "maxControlFrameBytes",
      MAX_CONTROL_FRAME_BYTES,
    ),
  };
}

function validateNormalizedTerminalWalWorkerConfig(value: unknown): NormalizedTerminalWalWorkerConfig {
  if (!isPlainObject(value)) throw new Error("normalized terminal WAL worker config must be an object");
  const expectedKeys = [
    "paths",
    "identity",
    "geometry",
    "maxBufferedOutputBytes",
    "maxOutputRecordBytes",
    "maxControlFrameBytes",
  ];
  if (Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    throw new Error("normalized terminal WAL worker config has invalid fields");
  }
  if (!isPlainObject(value.paths) || typeof value.paths.directory !== "string") {
    throw new Error("normalized terminal WAL worker config.paths is invalid");
  }
  const paths = resolveTerminalWalPaths(value.paths.directory);
  if (Object.keys(value.paths).sort().join(",") !== "directory,lockPath,socketPath,walPath"
    || value.paths.walPath !== paths.walPath
    || value.paths.socketPath !== paths.socketPath
    || value.paths.lockPath !== paths.lockPath) {
    throw new Error("normalized terminal WAL worker paths must be derived from directory");
  }
  const maxOutputRecordBytes = boundedOption(
    value.maxOutputRecordBytes,
    DEFAULT_MAX_OUTPUT_RECORD_BYTES,
    "maxOutputRecordBytes",
    MAX_OUTPUT_RECORD_BYTES,
  );
  const maxBufferedOutputBytes = boundedOption(
    value.maxBufferedOutputBytes,
    DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
    "maxBufferedOutputBytes",
    MAX_BUFFERED_OUTPUT_BYTES,
  );
  if (maxBufferedOutputBytes < maxOutputRecordBytes) {
    throw new Error("maxBufferedOutputBytes must be at least maxOutputRecordBytes");
  }
  return {
    paths,
    identity: parseTerminalWalIdentity(value.identity),
    geometry: parseTerminalGeometry(value.geometry),
    maxBufferedOutputBytes,
    maxOutputRecordBytes,
    maxControlFrameBytes: boundedOption(
      value.maxControlFrameBytes,
      DEFAULT_MAX_CONTROL_FRAME_BYTES,
      "maxControlFrameBytes",
      MAX_CONTROL_FRAME_BYTES,
    ),
  };
}

export function parseTerminalWalWorkerConfigJson(json: string): NormalizedTerminalWalWorkerConfig {
  if (typeof json !== "string" || json.length === 0) {
    throw new Error(`${TERMINAL_WAL_WORKER_CONFIG_ENV} must contain JSON`);
  }
  if (Buffer.byteLength(json, "utf8") > MAX_CONFIG_JSON_BYTES) {
    throw new Error(`${TERMINAL_WAL_WORKER_CONFIG_ENV} exceeds ${MAX_CONFIG_JSON_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`${TERMINAL_WAL_WORKER_CONFIG_ENV} is not valid JSON`);
  }
  return parseTerminalWalWorkerConfig(value);
}

function sameGeometry(left: TerminalGeometry, right: TerminalGeometry): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

function parseLifecycleRecord(record: OutputWalRecord): TerminalWalLifecycleRecord {
  const value = parseOutputWalJson<unknown>(record);
  if (!isPlainObject(value)) throw new Error("terminal WAL lifecycle payload must be an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "event,geometry,identity") {
    throw new Error("terminal WAL lifecycle payload has invalid fields");
  }
  if (value.event !== "start" && value.event !== "resume" && value.event !== "end") {
    throw new Error("terminal WAL lifecycle event is invalid");
  }
  return {
    event: value.event,
    identity: parseTerminalWalIdentity(value.identity),
    geometry: parseTerminalGeometry(value.geometry, "lifecycle.geometry"),
  };
}

function parseResizeRecord(record: OutputWalRecord): TerminalWalResizeRecord {
  const value = parseOutputWalJson<unknown>(record);
  if (!isPlainObject(value)) throw new Error("terminal WAL resize payload must be an object");
  const allowed = new Set(["phase", "changeId", "from", "to", "reason"]);
  for (const key of ["phase", "changeId", "from", "to"]) {
    if (!Object.hasOwn(value, key)) throw new Error(`terminal WAL resize.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`terminal WAL resize.${key} is not allowed`);
  }
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error("terminal WAL resize phase is invalid");
  }
  const changeId = typeof value.changeId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.changeId)
    ? value.changeId
    : null;
  if (!changeId) throw new Error("terminal WAL resize changeId is invalid");
  if (value.reason !== undefined
    && (typeof value.reason !== "string" || value.reason.length > 512 || /[\0\r\n]/.test(value.reason))) {
    throw new Error("terminal WAL resize reason is invalid");
  }
  return {
    phase: value.phase,
    changeId,
    from: parseTerminalGeometry(value.from, "resize.from"),
    to: parseTerminalGeometry(value.to, "resize.to"),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
  };
}

function samePendingResize(left: PendingResize, right: TerminalWalResizeRecord): boolean {
  return left.changeId === right.changeId
    && sameGeometry(left.from, right.from)
    && sameGeometry(left.to, right.to)
    && left.reason === right.reason;
}

/** Fail closed before appending to a WAL whose incarnation chain is ambiguous. */
function inspectExistingWal(path: string): ExistingWalState {
  let records = 0;
  let active = false;
  let logicalIdentity: ExistingWalState["logicalIdentity"] = null;
  let pendingResize: PendingResize | null = null;
  for (const record of readOutputWal(path)) {
    records += 1;
    if (records === 1 && record.kind !== "lifecycle") {
      throw new Error("terminal WAL first record must be lifecycle start");
    }
    if (record.kind === "lifecycle") {
      if (pendingResize) {
        throw new Error("terminal WAL lifecycle record appears inside a pending resize");
      }
      const lifecycle = parseLifecycleRecord(record);
      if (records === 1) {
        if (lifecycle.event !== "start") {
          throw new Error("terminal WAL first lifecycle event must be start");
        }
        logicalIdentity = {
          session: lifecycle.identity.session,
          instanceId: lifecycle.identity.instanceId,
        };
        active = true;
        continue;
      }
      if (lifecycle.event === "start") {
        throw new Error("terminal WAL may contain only one start event");
      }
      if (!logicalIdentity
        || lifecycle.identity.session !== logicalIdentity.session
        || lifecycle.identity.instanceId !== logicalIdentity.instanceId) {
        throw new Error("terminal WAL lifecycle logical identity changed");
      }
      if (lifecycle.event === "end") {
        if (!active) throw new Error("terminal WAL contains end while already inactive");
        active = false;
      } else {
        if (!active) {
          throw new Error("terminal WAL contains resume after logical lifecycle end");
        }
        // A source/process crash has no END, so a new source epoch resumes the
        // still-active logical instance.
        active = true;
      }
      continue;
    }

    if (!active) throw new Error("terminal WAL contains data after end without resume");
    if (record.kind === "resize") {
      const resize = parseResizeRecord(record);
      if (resize.phase === "prepare") {
        if (pendingResize) throw new Error("terminal WAL contains nested resize prepare records");
        pendingResize = {
          changeId: resize.changeId,
          from: resize.from,
          to: resize.to,
          ...(resize.reason === undefined ? {} : { reason: resize.reason }),
        };
      } else {
        if (!pendingResize || !samePendingResize(pendingResize, resize)) {
          throw new Error(`terminal WAL resize ${resize.phase} has no matching prepare`);
        }
        pendingResize = null;
      }
    } else if (pendingResize) {
      throw new Error(`terminal WAL ${record.kind} record appears inside a pending resize`);
    }
  }
  return { empty: records === 0, active, logicalIdentity, pendingResize };
}

function copyGeometry(value: TerminalGeometry): TerminalGeometry {
  return { cols: value.cols, rows: value.rows };
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) throw new Error("terminal WAL writer lock write made no progress");
    offset += count;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function assertRegularFileOrAbsent(path: string, label: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file when it exists`);
  }
}

function acquireWriterLock(paths: TerminalWalPaths, instanceId: string): string {
  const contents = `${JSON.stringify({ pid: process.pid, instanceId })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(
        paths.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_DSYNC,
        PRIVATE_FILE_MODE,
      );
      try {
        writeAll(fd, Buffer.from(contents, "utf8"));
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(paths.directory);
      return contents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertRegularFileOrAbsent(paths.lockPath, "terminal WAL writer lock");
      let owner: unknown;
      try {
        owner = JSON.parse(readFileSync(paths.lockPath, "utf8"));
      } catch {
        throw new Error("terminal WAL writer lock is malformed; refusing unsafe takeover");
      }
      if (!isPlainObject(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) {
        throw new Error("terminal WAL writer lock has an invalid owner; refusing unsafe takeover");
      }
      if (processIsAlive(owner.pid as number)) {
        throw new Error(`terminal WAL already has a live writer process ${owner.pid}`);
      }
      unlinkSync(paths.lockPath);
      fsyncDirectory(paths.directory);
    }
  }
  throw new Error("terminal WAL could not acquire its single-writer lock");
}

function releaseWriterLock(paths: TerminalWalPaths, expectedContents: string | null): void {
  if (!expectedContents || !existsSync(paths.lockPath)) return;
  assertRegularFileOrAbsent(paths.lockPath, "terminal WAL writer lock");
  if (readFileSync(paths.lockPath, "utf8") !== expectedContents) {
    throw new Error("terminal WAL writer lock owner changed; refusing to remove it");
  }
  unlinkSync(paths.lockPath);
  fsyncDirectory(paths.directory);
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe, rejectProbe) => {
    const socket = createConnection({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolveProbe(false);
      } else {
        rejectProbe(error);
      }
    });
  });
}

async function prepareSocketPath(paths: TerminalWalPaths): Promise<void> {
  if (!existsSync(paths.socketPath)) return;
  const stat = lstatSync(paths.socketPath);
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error("terminal WAL control path exists and is not a Unix socket");
  }
  if (await socketAcceptsConnections(paths.socketPath)) {
    throw new Error("terminal WAL control socket is already served by another process");
  }
  unlinkSync(paths.socketPath);
  fsyncDirectory(paths.directory);
}

function sanitizeProtocolMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\0\r\n]/g, " ").slice(0, 2_048) || "unknown terminal WAL error";
}

/**
 * Sole owner of one terminal output WAL.
 *
 * stdin stays in paused/readable mode. During a prepared resize the worker
 * reads only up to the configured memory bound, then leaves the rest in the
 * stream/kernel pipe so normal OS backpressure applies instead of dropping it.
 */
export class TerminalWalWorker {
  readonly config: NormalizedTerminalWalWorkerConfig;
  private readonly input: Readable;
  private readonly clock: (() => number) | undefined;
  private readonly onFatal: ((error: Error) => void) | undefined;
  private server: Server | null = null;
  private socketBound = false;
  private writer: OutputWalWriter | null = null;
  private lockContents: string | null = null;
  private activeControl: Socket | null = null;
  private controlBuffer = Buffer.alloc(0);
  private geometry: TerminalGeometry;
  private pendingResize: PendingResize | null = null;
  private bufferedOutput: Buffer[] = [];
  private bufferedOutputBytes = 0;
  private inputBackpressured = false;
  private started = false;
  private stopping: Promise<void> | null = null;
  private fatalError: Error | null = null;

  constructor(config: TerminalWalWorkerConfig | NormalizedTerminalWalWorkerConfig, dependencies: TerminalWalWorkerDependencies = {}) {
    this.config = "paths" in config
      ? validateNormalizedTerminalWalWorkerConfig(config)
      : parseTerminalWalWorkerConfig(config);
    this.input = dependencies.input ?? process.stdin;
    this.clock = dependencies.clock;
    this.onFatal = dependencies.onFatal;
    this.geometry = copyGeometry(this.config.geometry);
  }

  get paths(): TerminalWalPaths {
    return this.config.paths;
  }

  get status(): TerminalWalWorkerStatus {
    return {
      started: this.started,
      failed: this.fatalError !== null,
      geometry: copyGeometry(this.geometry),
      pendingChangeId: this.pendingResize?.changeId ?? null,
      bufferedOutputBytes: this.bufferedOutputBytes,
      inputBackpressured: this.inputBackpressured,
      controlConnected: this.activeControl !== null && !this.activeControl.destroyed,
    };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("terminal WAL worker is already started");
    if (this.stopping) throw new Error("terminal WAL worker is stopping");
    if (this.input.readableObjectMode || this.input.readableEncoding !== null) {
      throw new Error("terminal WAL stdin must be a raw byte stream without object mode or text encoding");
    }
    const { paths } = this.config;
    mkdirSync(paths.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (realpathSync(paths.directory) !== paths.directory) {
      throw new Error("terminal WAL directory must not resolve through a symlink");
    }
    chmodSync(paths.directory, PRIVATE_DIRECTORY_MODE);
    assertRegularFileOrAbsent(paths.walPath, "terminal WAL");
    await prepareSocketPath(paths);
    this.lockContents = acquireWriterLock(paths, this.config.identity.instanceId);
    try {
      const server = createServer((socket) => this.acceptControl(socket));
      this.server = server;
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(paths.socketPath);
      });
      this.socketBound = true;
      chmodSync(paths.socketPath, PRIVATE_FILE_MODE);
      fsyncDirectory(dirname(paths.socketPath));

      this.writer = new OutputWalWriter({
        path: paths.walPath,
        clock: this.clock,
        // This is the on-disk format bound, not today's chunking preference.
        // Keeping it stable lets a restarted worker read older, larger frames.
        maxPayloadBytes: MAX_OUTPUT_RECORD_BYTES,
      });
      const existing = inspectExistingWal(paths.walPath);
      if (!existing.empty && (
        existing.logicalIdentity?.session !== this.config.identity.session
        || existing.logicalIdentity.instanceId !== this.config.identity.instanceId
      )) {
        throw new Error("terminal WAL logical identity does not match the requested worker");
      }
      if (!existing.empty && !existing.active) {
        throw new Error("terminal WAL logical lifecycle already ended; refusing resume");
      }
      if (existing.pendingResize) {
        this.writer.appendJson(
          "resize",
          { phase: "abort", ...existing.pendingResize } satisfies TerminalWalResizeRecord,
        );
      }
      const lifecycle: TerminalWalLifecycleRecord = {
        event: existing.empty ? "start" : "resume",
        identity: this.config.identity,
        geometry: copyGeometry(this.geometry),
      };
      this.writer.appendJson("lifecycle", lifecycle);
      this.started = true;
      this.input.on("readable", this.handleInputReadable);
      this.input.on("error", this.handleInputError);
      this.drainInput();
    } catch (error) {
      await this.cleanupAfterFailedStart();
      throw error;
    }
  }

  /** Disconnect this source epoch without ending the logical terminal. */
  async stop(options: { writeLifecycleEnd?: boolean } = {}): Promise<void> {
    if (this.stopping) return await this.stopping;
    this.stopping = this.stopInternal(options.writeLifecycleEnd === true);
    return await this.stopping;
  }

  /** Explicit, irreversible lifecycle close. Use only when the logical instance ended. */
  async closeLogicalLifecycle(): Promise<void> {
    return await this.stop({ writeLifecycleEnd: true });
  }

  /**
   * Synchronous ordered-source ingress. A tmux control-mode recorder uses this
   * instead of stdin so layout and output notifications keep one total order.
   */
  appendOrderedOutput(payload: Uint8Array): OutputWalRecord[] {
    if (!(payload instanceof Uint8Array)) {
      throw new Error("ordered terminal WAL output must be raw bytes");
    }
    if (this.pendingResize) {
      throw new Error("ordered terminal WAL output cannot enter during a pending resize");
    }
    this.drainInput();
    const writer = this.requireWriter();
    const records: OutputWalRecord[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += this.config.maxOutputRecordBytes) {
      const end = Math.min(payload.byteLength, offset + this.config.maxOutputRecordBytes);
      records.push(writer.appendOutput(payload.subarray(offset, end)));
    }
    return records;
  }

  /** Record an observed ordered layout boundary before consuming its redraw. */
  recordOrderedResize(
    toValue: TerminalGeometry,
    changeIdValue: string,
    reasonValue?: string,
  ): { prepare: OutputWalRecord; commit: OutputWalRecord } {
    if (this.pendingResize) throw new Error("ordered resize cannot nest inside a pending resize");
    const to = parseTerminalGeometry(toValue, "ordered resize.to");
    const changeId = parseTerminalWalSafeId(changeIdValue, "ordered resize.changeId");
    const reason = parseTerminalWalReason(reasonValue);
    this.drainInput();
    const writer = this.requireWriter();
    const boundary: PendingResize = {
      changeId,
      from: copyGeometry(this.geometry),
      to: copyGeometry(to),
      ...(reason === undefined ? {} : { reason }),
    };
    const prepare = writer.appendJson(
      "resize",
      { phase: "prepare", ...boundary } satisfies TerminalWalResizeRecord,
    );
    // Both appends are synchronous+durable; no next control-mode line can be
    // consumed between PREPARE and COMMIT.
    const commit = writer.appendJson(
      "resize",
      { phase: "commit", ...boundary } satisfies TerminalWalResizeRecord,
    );
    this.geometry = copyGeometry(to);
    return { prepare, commit };
  }

  private readonly handleInputReadable = (): void => {
    if (!this.started || this.fatalError) return;
    try {
      this.drainInput();
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly handleInputError = (error: Error): void => {
    this.fail(error);
  };

  private drainInput(): void {
    const writer = this.requireWriter();
    while (true) {
      let limit = this.config.maxOutputRecordBytes;
      if (this.pendingResize) {
        const remaining = this.config.maxBufferedOutputBytes - this.bufferedOutputBytes;
        if (remaining <= 0) {
          this.inputBackpressured = true;
          return;
        }
        limit = Math.min(limit, remaining);
      }
      const available = this.input.readableLength;
      const wanted = available > 0 ? Math.min(limit, available) : limit;
      const chunk: unknown = this.input.read(wanted);
      if (chunk === null) {
        this.inputBackpressured = false;
        return;
      }
      if (typeof chunk === "string") {
        throw new Error("terminal WAL stdin must be raw bytes; encoded text streams are rejected");
      }
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("terminal WAL stdin produced a non-byte chunk");
      }
      const bytes = Buffer.from(chunk);
      if (bytes.byteLength === 0) continue;
      if (bytes.byteLength > limit) {
        throw new Error("terminal WAL stdin violated the bounded read contract");
      }
      if (this.pendingResize) {
        this.bufferedOutput.push(bytes);
        this.bufferedOutputBytes += bytes.byteLength;
        this.inputBackpressured = this.bufferedOutputBytes >= this.config.maxBufferedOutputBytes;
      } else {
        writer.appendOutput(bytes);
      }
    }
  }

  private flushBufferedOutput(): void {
    const writer = this.requireWriter();
    for (const bytes of this.bufferedOutput) writer.appendOutput(bytes);
    this.bufferedOutput = [];
    this.bufferedOutputBytes = 0;
    this.inputBackpressured = false;
  }

  private acceptControl(socket: Socket): void {
    if (!this.started || this.fatalError) {
      socket.destroy(new Error("terminal WAL worker is not available"));
      return;
    }
    if (this.activeControl && !this.activeControl.destroyed) {
      const response: TerminalWalControlError = {
        protocol: TERMINAL_WAL_PROTOCOL_VERSION,
        requestId: "connection",
        status: "error",
        code: "CONTROLLER_EXISTS",
        message: "terminal WAL worker permits one control connection",
      };
      socket.end(`${JSON.stringify(response)}\n`);
      return;
    }
    this.activeControl = socket;
    this.controlBuffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => this.receiveControl(socket, chunk));
    socket.on("error", () => {
      // Connection errors are local to the controller. The writer and stdin
      // must stay alive so a host restart can reconnect and finish a resize.
    });
    socket.on("close", () => {
      if (this.activeControl === socket) {
        this.activeControl = null;
        this.controlBuffer = Buffer.alloc(0);
      }
    });
  }

  private receiveControl(socket: Socket, chunk: Buffer): void {
    if (socket !== this.activeControl || this.fatalError) return;
    this.controlBuffer = Buffer.concat([this.controlBuffer, Buffer.from(chunk)]);
    if (this.controlBuffer.byteLength > this.config.maxControlFrameBytes) {
      this.sendControlError(socket, "protocol", "FRAME_TOO_LARGE", "control frame exceeds configured limit");
      socket.end();
      return;
    }
    while (true) {
      const newline = this.controlBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const frame = this.controlBuffer.subarray(0, newline);
      this.controlBuffer = this.controlBuffer.subarray(newline + 1);
      this.handleControlFrame(socket, frame);
      if (socket.destroyed || this.fatalError) return;
    }
  }

  private handleControlFrame(socket: Socket, frame: Buffer): void {
    let raw: unknown;
    let request: TerminalWalControlRequest;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      raw = JSON.parse(text);
      request = parseTerminalWalControlRequest(raw);
    } catch (error) {
      const candidate = isPlainObject(raw) ? raw.requestId : undefined;
      const requestId = typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)
        ? candidate
        : "protocol";
      this.sendControlError(socket, requestId, "INVALID_REQUEST", sanitizeProtocolMessage(error));
      return;
    }

    try {
      const record = this.applyControl(request);
      const response: TerminalWalAck = {
        protocol: TERMINAL_WAL_PROTOCOL_VERSION,
        requestId: request.requestId,
        status: "ack",
        sequence: record.sequence.toString(),
        nextOffset: record.nextOffset,
      };
      // append/applyControl is synchronous and OutputWalWriter only returns
      // after fdatasync. No ACK can be emitted ahead of durable storage.
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const message = sanitizeProtocolMessage(error);
      if (error instanceof TerminalWalControlStateError) {
        this.sendControlError(socket, request.requestId, "INVALID_STATE", message);
      } else {
        this.fail(error);
      }
    }
  }

  private applyControl(request: TerminalWalControlRequest): OutputWalRecord {
    const writer = this.requireWriter();
    if (request.command === "ACTIVATE") {
      throw new TerminalWalControlStateError("ACTIVATE requires the direct PTY WAL proxy");
    }
    if (request.command === "BARRIER") {
      if (this.pendingResize) {
        throw new TerminalWalControlStateError("cannot create a barrier while a resize is pending");
      }
      // Pull every byte currently accepted by the Readable before fixing the
      // checkpoint in the WAL. Cross-file-descriptor kernel ordering remains
      // the caller's responsibility (documented by the controller contract).
      this.drainInput();
      return writer.appendJson("checkpoint", { event: "barrier", requestId: request.requestId });
    }

    if (request.command === "END") {
      // This pipe/tmux-control worker cannot synchronously stop and drain its
      // upstream producer. END is implemented only by the direct PTY proxy,
      // where the child process group and master FD are owned by one process.
      throw new TerminalWalControlStateError("END requires the direct PTY WAL proxy");
    }

    if (request.command === "RESIZE_PREPARE") {
      if (this.pendingResize) {
        throw new TerminalWalControlStateError(`resize ${this.pendingResize.changeId} is already pending`);
      }
      if (!sameGeometry(request.from, this.geometry)) {
        throw new TerminalWalControlStateError(
          `resize source ${request.from.cols}x${request.from.rows} does not match ${this.geometry.cols}x${this.geometry.rows}`,
        );
      }
      if (sameGeometry(request.from, request.to)) {
        throw new TerminalWalControlStateError("resize destination must differ from its source");
      }
      this.drainInput();
      const pending: PendingResize = {
        changeId: request.changeId,
        from: copyGeometry(request.from),
        to: copyGeometry(request.to),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      };
      const record = writer.appendJson("resize", { phase: "prepare", ...pending } satisfies TerminalWalResizeRecord);
      // No JS callback can interleave with the synchronous append. From this
      // assignment until COMMIT/ABORT is durable, stdin bytes are buffered.
      this.pendingResize = pending;
      this.drainInput();
      return record;
    }

    const pending = this.pendingResize;
    if (!pending) throw new TerminalWalControlStateError("no resize is pending");
    if (pending.changeId !== request.changeId) {
      throw new TerminalWalControlStateError(
        `resize ${request.changeId} does not match pending ${pending.changeId}`,
      );
    }
    const phase = request.command === "RESIZE_COMMIT" ? "commit" : "abort";
    const record = writer.appendJson("resize", { phase, ...pending } satisfies TerminalWalResizeRecord);
    // appendJson has fsynced the boundary. Only now may buffered output follow.
    if (phase === "commit") this.geometry = copyGeometry(pending.to);
    this.pendingResize = null;
    this.flushBufferedOutput();
    this.drainInput();
    return record;
  }

  private sendControlError(socket: Socket, requestId: string, code: string, error: unknown): void {
    const response: TerminalWalControlError = {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      status: "error",
      code,
      message: sanitizeProtocolMessage(error),
    };
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private requireWriter(): OutputWalWriter {
    if (!this.writer) throw new Error("terminal WAL worker has no active writer");
    return this.writer;
  }

  private fail(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    this.input.pause();
    this.onFatal?.(this.fatalError);
    void this.stop({ writeLifecycleEnd: false }).catch(() => undefined);
  }

  private async stopInternal(writeLifecycleEnd: boolean): Promise<void> {
    this.input.off("readable", this.handleInputReadable);
    this.input.off("error", this.handleInputError);
    let failure: unknown = null;
    let writerClosed = this.writer === null;
    const writer = this.writer;
    if (writer) {
      try {
        if (!this.fatalError) {
          if (this.pendingResize) {
            const pending = this.pendingResize;
            writer.appendJson(
              "resize",
              { phase: "abort", ...pending } satisfies TerminalWalResizeRecord,
            );
            this.pendingResize = null;
            this.flushBufferedOutput();
          }
          this.drainInput();
          if (writeLifecycleEnd) {
            const lifecycle: TerminalWalLifecycleRecord = {
              event: "end",
              identity: this.config.identity,
              geometry: copyGeometry(this.geometry),
            };
            writer.appendJson("lifecycle", lifecycle);
          }
        }
      } catch (error) {
        failure = error;
      }
      try {
        writer.close();
        this.writer = null;
        writerClosed = true;
      } catch (error) {
        failure ??= error;
      }
    }
    this.started = false;
    this.activeControl?.destroy();
    this.activeControl = null;
    try {
      await this.closeServer();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.removeSocketIfOwned();
    } catch (error) {
      failure ??= error;
    }
    // If fdatasync/close failed, retain the ownership marker until this
    // process exits. A second writer must not attach to a possibly-open fd.
    if (writerClosed) {
      const lockContents = this.lockContents;
      try {
        releaseWriterLock(this.config.paths, lockContents);
        this.lockContents = null;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  private async cleanupAfterFailedStart(): Promise<void> {
    let failure: unknown = null;
    let writerClosed = this.writer === null;
    const writer = this.writer;
    if (writer) {
      try {
        writer.close();
        this.writer = null;
        writerClosed = true;
      } catch (error) {
        failure = error;
      }
    }
    try {
      await this.closeServer();
    } catch (error) {
      failure ??= error;
    }
    try {
      this.removeSocketIfOwned();
    } catch (error) {
      failure ??= error;
    }
    if (writerClosed) {
      const lockContents = this.lockContents;
      try {
        releaseWriterLock(this.config.paths, lockContents);
        this.lockContents = null;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    if (!server.listening) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private removeSocketIfOwned(): void {
    if (!this.socketBound) return;
    this.socketBound = false;
    const path = this.config.paths.socketPath;
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isSocket()) return;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  }
}

/** Run the standalone stdin/socket worker used by a future tmux pipe command. */
export async function runTerminalWalWorkerFromEnvironment(): Promise<TerminalWalWorker> {
  const encoded = process.env[TERMINAL_WAL_WORKER_CONFIG_ENV];
  const config = parseTerminalWalWorkerConfigJson(encoded ?? "");
  const worker = new TerminalWalWorker(config, {
    input: process.stdin,
    onFatal: (error) => {
      console.error(`[thumbmux terminal-wal] fatal: ${error.message}`);
      process.exitCode = 1;
    },
  });
  await worker.start();
  const stop = () => {
    void worker.stop().finally(() => {
      process.exitCode ??= 0;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdin.once("end", stop);
  return worker;
}
