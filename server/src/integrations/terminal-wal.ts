import { randomUUID } from "node:crypto";
import { Socket, createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { decodeTmuxControlValue, paneGeometryFromTmuxLayout } from "../tmux-control-stream";

export const TERMINAL_WAL_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_WAL_FILE_NAME = "output.wal";
export const TERMINAL_WAL_SOCKET_NAME = "control.sock";
export const TERMINAL_WAL_LOCK_NAME = "writer.lock";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type TerminalGeometry = {
  cols: number;
  rows: number;
};

export type TerminalWalIdentity = {
  session: string;
  instanceId: string;
  paneTarget: string;
  tmuxServerPid: number;
  sessionCreated: number;
  /** Physical tmux source identity. Present together on direct PTY epochs. */
  sessionId?: string;
  windowId?: string;
  paneId?: string;
  /** Random, process-unique source generation. Present on direct PTY epochs. */
  generation?: string;
};

export type TerminalWalPtyIdentity = TerminalWalIdentity & {
  sessionId: string;
  windowId: string;
  paneId: string;
  generation: string;
};

export type TerminalWalLifecycleRecord = {
  event: "start" | "resume" | "end";
  identity: TerminalWalIdentity;
  geometry: TerminalGeometry;
};

export type TerminalWalResizeRecord = {
  phase: "prepare" | "commit" | "abort";
  changeId: string;
  from: TerminalGeometry;
  to: TerminalGeometry;
  reason?: string;
};

export type TerminalWalCheckpointRecord = {
  event: "barrier";
  requestId: string;
};

export type TerminalWalPaths = {
  directory: string;
  walPath: string;
  socketPath: string;
  lockPath: string;
};

export type TerminalWalControlRequest =
  | {
      protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
      requestId: string;
      command: "ACTIVATE";
      generation: string;
    }
  | {
      protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
      requestId: string;
      command: "BARRIER";
    }
  | {
      protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
      requestId: string;
      command: "END";
    }
  | {
      protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
      requestId: string;
      command: "RESIZE_PREPARE";
      changeId: string;
      from: TerminalGeometry;
      to: TerminalGeometry;
      reason?: string;
    }
  | {
      protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
      requestId: string;
      command: "RESIZE_COMMIT" | "RESIZE_ABORT";
      changeId: string;
    };

export type TerminalWalAck = {
  protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
  requestId: string;
  status: "ack";
  sequence: string;
  nextOffset: number;
  /** Present for direct PTY proxy epochs; older pipe workers omit it. */
  generation?: string;
};

export type TerminalWalControlError = {
  protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
  requestId: string;
  status: "error";
  code: string;
  message: string;
};

export type TerminalWalControlResponse = TerminalWalAck | TerminalWalControlError;

export type TmuxControlWalEvent =
  | {
      kind: "output";
      paneId: string;
      bytes: Uint8Array;
      extended: false;
    }
  | {
      kind: "output";
      paneId: string;
      bytes: Uint8Array;
      extended: true;
      ageMs: number;
      futureArgs: string[];
    }
  | {
      kind: "layout-change";
      windowId: string;
      paneId: string;
      geometry: TerminalGeometry;
      windowLayout: string;
      visibleLayout: string;
      windowFlags: string;
    };

export type TerminalWalControllerOptions = {
  directory: string;
  requestTimeoutMs?: number;
  maxControlFrameBytes?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  // Keep this check explicit so undefined cannot silently stand in for a
  // required field after JSON parsing or an object spread.
  for (const key of requiredSet) {
    if (value[key] === undefined) throw new Error(`${label}.${key} is required`);
  }
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

export function parseTerminalGeometry(value: unknown, label = "geometry"): TerminalGeometry {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  assertExactKeys(value, ["cols", "rows"], [], label);
  return {
    cols: boundedInteger(value.cols, `${label}.cols`, 1, 65_535),
    rows: boundedInteger(value.rows, `${label}.rows`, 1, 65_535),
  };
}

export function parseTerminalWalIdentity(value: unknown): TerminalWalIdentity {
  if (!isPlainObject(value)) throw new Error("identity must be an object");
  assertExactKeys(
    value,
    ["session", "instanceId", "paneTarget", "tmuxServerPid", "sessionCreated"],
    ["sessionId", "windowId", "paneId", "generation"],
    "identity",
  );
  if (typeof value.session !== "string" || !SAFE_SESSION.test(value.session)) {
    throw new Error("identity.session must be a safe tmux session name");
  }
  if (typeof value.instanceId !== "string" || !SAFE_ID.test(value.instanceId)) {
    throw new Error("identity.instanceId must be a safe non-empty identifier");
  }
  const expectedPane = new RegExp(`^=${value.session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+\\.\\d+$`);
  if (typeof value.paneTarget !== "string" || !expectedPane.test(value.paneTarget)) {
    throw new Error("identity.paneTarget must be an exact =session:window.pane target");
  }
  const sourceFields = [value.sessionId, value.windowId, value.paneId, value.generation];
  const sourceFieldCount = sourceFields.filter((field) => field !== undefined).length;
  if (sourceFieldCount !== 0 && sourceFieldCount !== sourceFields.length) {
    throw new Error("identity physical source fields must be supplied together");
  }
  if (sourceFieldCount !== 0) {
    if (typeof value.sessionId !== "string" || !/^\$\d+$/.test(value.sessionId)) {
      throw new Error("identity.sessionId must be a tmux session ID");
    }
    if (typeof value.windowId !== "string" || !/^@\d+$/.test(value.windowId)) {
      throw new Error("identity.windowId must be a tmux window ID");
    }
    if (typeof value.paneId !== "string" || !/^%\d+$/.test(value.paneId)) {
      throw new Error("identity.paneId must be a tmux pane ID");
    }
    if (typeof value.generation !== "string" || !SAFE_ID.test(value.generation)) {
      throw new Error("identity.generation must be a safe non-empty identifier");
    }
  }
  return {
    session: value.session,
    instanceId: value.instanceId,
    paneTarget: value.paneTarget,
    tmuxServerPid: boundedInteger(value.tmuxServerPid, "identity.tmuxServerPid", 1, 2_147_483_647),
    sessionCreated: boundedInteger(value.sessionCreated, "identity.sessionCreated", 0, Number.MAX_SAFE_INTEGER),
    ...(sourceFieldCount === 0 ? {} : {
      sessionId: value.sessionId as string,
      windowId: value.windowId as string,
      paneId: value.paneId as string,
      generation: value.generation as string,
    }),
  };
}

export function parseTerminalWalSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe non-empty identifier`);
  }
  return value;
}

export function parseTerminalWalReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error("reason must be at most 512 characters without control line breaks");
  }
  return value;
}

export function resolveTerminalWalPaths(directory: string): TerminalWalPaths {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) {
    throw new Error("terminal WAL directory must be a non-empty absolute path");
  }
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("terminal WAL directory must be an absolute normalized path");
  }
  const socketPath = join(directory, TERMINAL_WAL_SOCKET_NAME);
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`terminal WAL socket path must be at most ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
  }
  return {
    directory,
    walPath: join(directory, TERMINAL_WAL_FILE_NAME),
    socketPath,
    lockPath: join(directory, TERMINAL_WAL_LOCK_NAME),
  };
}

export function parseTerminalWalControlRequest(value: unknown): TerminalWalControlRequest {
  if (!isPlainObject(value)) throw new Error("control request must be an object");
  if (value.protocol !== TERMINAL_WAL_PROTOCOL_VERSION) {
    throw new Error(`control request.protocol must be ${TERMINAL_WAL_PROTOCOL_VERSION}`);
  }
  const requestId = parseTerminalWalSafeId(value.requestId, "control request.requestId");
  if (value.command === "ACTIVATE") {
    assertExactKeys(
      value,
      ["protocol", "requestId", "command", "generation"],
      [],
      "control request",
    );
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      command: "ACTIVATE",
      generation: parseTerminalWalSafeId(value.generation, "control request.generation"),
    };
  }
  if (value.command === "BARRIER" || value.command === "END") {
    assertExactKeys(value, ["protocol", "requestId", "command"], [], "control request");
    return { protocol: TERMINAL_WAL_PROTOCOL_VERSION, requestId, command: value.command };
  }
  if (value.command === "RESIZE_PREPARE") {
    assertExactKeys(
      value,
      ["protocol", "requestId", "command", "changeId", "from", "to"],
      ["reason"],
      "control request",
    );
    const reason = parseTerminalWalReason(value.reason);
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      command: "RESIZE_PREPARE",
      changeId: parseTerminalWalSafeId(value.changeId, "control request.changeId"),
      from: parseTerminalGeometry(value.from, "control request.from"),
      to: parseTerminalGeometry(value.to, "control request.to"),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (value.command === "RESIZE_COMMIT" || value.command === "RESIZE_ABORT") {
    assertExactKeys(
      value,
      ["protocol", "requestId", "command", "changeId"],
      [],
      "control request",
    );
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      command: value.command,
      changeId: parseTerminalWalSafeId(value.changeId, "control request.changeId"),
    };
  }
  throw new Error("control request.command is not supported");
}

function parseOnePaneLayout(
  layout: string,
  label: string,
): { paneId: string; geometry: TerminalGeometry } {
  const match = /^([0-9a-fA-F]{4}),([1-9]\d{0,4})x([1-9]\d{0,4}),(\d+),(\d+),(\d+)$/.exec(layout);
  if (!match) throw new Error(`${label} is not a one-pane tmux layout`);
  const cols = boundedInteger(Number(match[2]), `${label}.cols`, 1, 65_535);
  const rows = boundedInteger(Number(match[3]), `${label}.rows`, 1, 65_535);
  boundedInteger(Number(match[4]), `${label}.x`, 0, 65_535);
  boundedInteger(Number(match[5]), `${label}.y`, 0, 65_535);
  const paneNumber = boundedInteger(Number(match[6]), `${label}.pane`, 0, Number.MAX_SAFE_INTEGER);
  return { paneId: `%${paneNumber}`, geometry: { cols, rows } };
}

function bytesStartWith(line: Uint8Array, prefix: string): boolean {
  if (line.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (line[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function asciiControlHeader(bytes: Uint8Array, label: string): string {
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) throw new Error(`${label} contains a non-ASCII header byte`);
  }
  return Buffer.from(bytes).toString("ascii");
}

export type TmuxControlWalTarget = {
  paneId: string;
  windowId?: string;
};

/** Byte-safe form: ASCII headers are parsed separately from raw UTF-8 payload. */
export function parseTmuxControlWalBytesLine(
  line: Uint8Array,
  target?: TmuxControlWalTarget,
): TmuxControlWalEvent {
  if (!(line instanceof Uint8Array) || line.byteLength === 0) {
    throw new Error("tmux control line must be one non-empty byte line");
  }
  if (bytesStartWith(line, "%output ")) {
    const separator = Buffer.from(line).indexOf(0x20, "%output ".length);
    if (separator < 0) throw new Error("malformed tmux %output notification");
    const paneId = asciiControlHeader(line.subarray("%output ".length, separator), "tmux output pane id");
    if (!/^%\d+$/.test(paneId)) throw new Error("malformed tmux %output pane id");
    return {
      kind: "output",
      paneId,
      bytes: decodeTmuxControlValue(line.subarray(separator + 1)),
      extended: false,
    };
  }
  if (bytesStartWith(line, "%extended-output ")) {
    const boundary = Buffer.from(line).indexOf(Buffer.from(" : "));
    if (boundary < 0) throw new Error("malformed tmux %extended-output boundary");
    const header = asciiControlHeader(line.subarray(0, boundary), "tmux extended-output header").split(" ");
    if (header.length < 3
      || header[0] !== "%extended-output"
      || !/^%\d+$/.test(header[1]!)
      || !/^\d+$/.test(header[2]!)
      || header.slice(3).some((item) => item.length === 0 || /[^!-~]/.test(item))) {
      throw new Error("malformed tmux %extended-output notification");
    }
    const ageMs = boundedInteger(Number(header[2]), "tmux extended-output age", 0, Number.MAX_SAFE_INTEGER);
    return {
      kind: "output",
      paneId: header[1]!,
      bytes: decodeTmuxControlValue(line.subarray(boundary + 3)),
      extended: true,
      ageMs,
      futureArgs: header.slice(3),
    };
  }
  if (bytesStartWith(line, "%layout-change ")) {
    const text = asciiControlHeader(line, "tmux layout-change");
    const match = /^%layout-change (@\d+) ([^ ]+) ([^ ]+)(?: ([!-~]*))?$/.exec(text);
    if (!match) throw new Error("malformed tmux %layout-change notification");
    if (target?.windowId && target.windowId !== match[1]) {
      throw new Error("tmux layout-change came from the wrong window");
    }
    if (target) {
      if (!/^%\d+$/.test(target.paneId)) throw new Error("tmux WAL target pane id is invalid");
      const geometry = paneGeometryFromTmuxLayout(match[3]!, target.paneId)
        ?? paneGeometryFromTmuxLayout(match[2]!, target.paneId);
      if (!geometry) throw new Error(`tmux layout-change does not contain target ${target.paneId}`);
      return {
        kind: "layout-change",
        windowId: match[1]!,
        paneId: target.paneId,
        geometry,
        windowLayout: match[2]!,
        visibleLayout: match[3]!,
        windowFlags: match[4] ?? "",
      };
    }
    const window = parseOnePaneLayout(match[2]!, "tmux window layout");
    const visible = parseOnePaneLayout(match[3]!, "tmux visible layout");
    if (window.paneId !== visible.paneId || !(
      window.geometry.cols === visible.geometry.cols
      && window.geometry.rows === visible.geometry.rows
    )) {
      throw new Error("tmux one-pane visible layout does not match its window layout");
    }
    return {
      kind: "layout-change",
      windowId: match[1]!,
      paneId: window.paneId,
      geometry: window.geometry,
      windowLayout: match[2]!,
      visibleLayout: match[3]!,
      windowFlags: match[4] ?? "",
    };
  }
  throw new Error("tmux control notification is not a WAL input event");
}

/**
 * Parse only the ordered tmux control-mode notifications that are safe inputs
 * to the terminal WAL. Unknown and malformed lines fail closed deliberately.
 */
export function parseTmuxControlWalLine(line: string): TmuxControlWalEvent {
  if (typeof line !== "string" || line.length === 0 || /[\0\r\n]/.test(line)) {
    throw new Error("tmux control line must be one non-empty line");
  }
  return parseTmuxControlWalBytesLine(Buffer.from(line, "utf8"));
}

function parseTerminalWalControlResponse(value: unknown): TerminalWalControlResponse {
  if (!isPlainObject(value)) throw new Error("control response must be an object");
  if (value.protocol !== TERMINAL_WAL_PROTOCOL_VERSION) {
    throw new Error(`control response.protocol must be ${TERMINAL_WAL_PROTOCOL_VERSION}`);
  }
  const requestId = parseTerminalWalSafeId(value.requestId, "control response.requestId");
  if (value.status === "ack") {
    assertExactKeys(
      value,
      ["protocol", "requestId", "status", "sequence", "nextOffset"],
      ["generation"],
      "control response",
    );
    if (typeof value.sequence !== "string" || !/^[1-9]\d*$/.test(value.sequence)) {
      throw new Error("control response.sequence must be a positive decimal string");
    }
    const generation = value.generation === undefined
      ? undefined
      : parseTerminalWalSafeId(value.generation, "control response.generation");
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      status: "ack",
      sequence: value.sequence,
      nextOffset: boundedInteger(value.nextOffset, "control response.nextOffset", 1, Number.MAX_SAFE_INTEGER),
      ...(generation === undefined ? {} : { generation }),
    };
  }
  if (value.status === "error") {
    assertExactKeys(
      value,
      ["protocol", "requestId", "status", "code", "message"],
      [],
      "control response",
    );
    const code = parseTerminalWalSafeId(value.code, "control response.code");
    if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 2_048) {
      throw new Error("control response.message must be 1 through 2048 characters");
    }
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      status: "error",
      code,
      message: value.message,
    };
  }
  throw new Error("control response.status is not supported");
}

function positiveBoundedOption(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  return boundedInteger(value, label, 1, maximum);
}

/**
 * Serialized client for the worker's private Unix control socket.
 *
 * Only one command is in flight. This is intentional: a resize is a WAL
 * transaction boundary, not a collection of independently reorderable RPCs.
 */
export class TerminalWalController {
  readonly paths: TerminalWalPaths;
  private readonly requestTimeoutMs: number;
  private readonly maxControlFrameBytes: number;
  private readonly idPrefix = randomUUID();
  private nextRequest = 0;
  private socket: Socket | null = null;
  private responseBuffer = Buffer.alloc(0);
  private pending: {
    requestId: string;
    resolve: (response: TerminalWalAck) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private requestTail: Promise<unknown> = Promise.resolve();

  constructor(options: TerminalWalControllerOptions) {
    this.paths = resolveTerminalWalPaths(options.directory);
    this.requestTimeoutMs = positiveBoundedOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      300_000,
    );
    this.maxControlFrameBytes = positiveBoundedOption(
      options.maxControlFrameBytes,
      DEFAULT_MAX_CONTROL_FRAME_BYTES,
      "maxControlFrameBytes",
      1024 * 1024,
    );
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const socket = createConnection({ path: this.paths.socketPath });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const onConnect = () => {
        socket.off("error", onInitialError);
        resolveConnect();
      };
      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        rejectConnect(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
    });
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.failPending(error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.failPending(new Error("terminal WAL control socket closed"));
    });
  }

  barrier(requestId = this.makeRequestId("barrier")): Promise<TerminalWalAck> {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "BARRIER",
    });
  }

  /** Release a direct PTY child only after the host has published its T0. */
  activate(
    generation: string,
    requestId = this.makeRequestId("activate"),
  ): Promise<TerminalWalAck> {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "ACTIVATE",
      generation: parseTerminalWalSafeId(generation, "generation"),
    });
  }

  /**
   * Irreversibly end a logical terminal. A direct PTY proxy acknowledges only
   * after the child is stopped, terminated, drained through PTY EOF and the
   * lifecycle END record is durable.
   */
  endLogicalLifecycle(requestId = this.makeRequestId("end")): Promise<TerminalWalAck> {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "END",
    });
  }

  prepareResize(options: {
    changeId: string;
    from: TerminalGeometry;
    to: TerminalGeometry;
    reason?: string;
    requestId?: string;
  }): Promise<TerminalWalAck> {
    const reason = parseTerminalWalReason(options.reason);
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(
        options.requestId ?? this.makeRequestId("prepare"),
        "requestId",
      ),
      command: "RESIZE_PREPARE",
      changeId: parseTerminalWalSafeId(options.changeId, "changeId"),
      from: parseTerminalGeometry(options.from, "from"),
      to: parseTerminalGeometry(options.to, "to"),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  commitResize(changeId: string, requestId = this.makeRequestId("commit")): Promise<TerminalWalAck> {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "RESIZE_COMMIT",
      changeId: parseTerminalWalSafeId(changeId, "changeId"),
    });
  }

  abortResize(changeId: string, requestId = this.makeRequestId("abort")): Promise<TerminalWalAck> {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "RESIZE_ABORT",
      changeId: parseTerminalWalSafeId(changeId, "changeId"),
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.failPending(new Error("terminal WAL controller closed"));
  }

  private makeRequestId(kind: string): string {
    this.nextRequest += 1;
    return `${kind}:${this.idPrefix}:${this.nextRequest}`;
  }

  private enqueue(request: TerminalWalControlRequest): Promise<TerminalWalAck> {
    const operation = this.requestTail.then(() => this.send(request));
    this.requestTail = operation.catch(() => undefined);
    return operation;
  }

  private async send(request: TerminalWalControlRequest): Promise<TerminalWalAck> {
    if (!this.connected) await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("terminal WAL control socket is not connected");
    if (this.pending) throw new Error("terminal WAL controller invariant: request already pending");
    const encoded = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (encoded.byteLength > this.maxControlFrameBytes) {
      throw new Error(`terminal WAL control request exceeds ${this.maxControlFrameBytes} bytes`);
    }
    return await new Promise<TerminalWalAck>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== request.requestId) return;
        this.pending = null;
        socket.destroy();
        rejectRequest(new Error(`terminal WAL control request ${request.requestId} timed out`));
      }, this.requestTimeoutMs);
      this.pending = {
        requestId: request.requestId,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      };
      socket.write(encoded, (error) => {
        if (error) this.failPending(error);
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, Buffer.from(chunk)]);
    if (this.responseBuffer.byteLength > this.maxControlFrameBytes) {
      this.socket?.destroy(new Error("terminal WAL control response exceeds frame limit"));
      return;
    }
    const newline = this.responseBuffer.indexOf(0x0a);
    if (newline < 0) return;
    const frame = this.responseBuffer.subarray(0, newline);
    this.responseBuffer = this.responseBuffer.subarray(newline + 1);
    if (this.responseBuffer.byteLength !== 0) {
      this.socket?.destroy(new Error("terminal WAL controller received unsolicited response data"));
      return;
    }
    let response: TerminalWalControlResponse;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      response = parseTerminalWalControlResponse(JSON.parse(text));
    } catch (error) {
      this.socket?.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const pending = this.pending;
    if (!pending || pending.requestId !== response.requestId) {
      this.socket?.destroy(new Error("terminal WAL controller received an unmatched response"));
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (response.status === "error") {
      const error = new Error(`${response.code}: ${response.message}`);
      error.name = "TerminalWalControlError";
      pending.reject(error);
      return;
    }
    pending.resolve(response);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }
}
