// src/integrations/terminal-wal.ts
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
var TERMINAL_WAL_PROTOCOL_VERSION = 1;
var TERMINAL_WAL_FILE_NAME = "output.wal";
var TERMINAL_WAL_SOCKET_NAME = "control.sock";
var TERMINAL_WAL_LOCK_NAME = "writer.lock";
var DEFAULT_REQUEST_TIMEOUT_MS = 15000;
var DEFAULT_MAX_CONTROL_FRAME_BYTES = 64 * 1024;
var MAX_UNIX_SOCKET_PATH_BYTES = 100;
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertExactKeys(value, required, optional, label) {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label}.${key} is not allowed`);
  }
  for (const key of requiredSet) {
    if (value[key] === undefined)
      throw new Error(`${label}.${key} is required`);
  }
}
function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
function parseTerminalGeometry(value, label = "geometry") {
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  assertExactKeys(value, ["cols", "rows"], [], label);
  return {
    cols: boundedInteger(value.cols, `${label}.cols`, 1, 65535),
    rows: boundedInteger(value.rows, `${label}.rows`, 1, 65535)
  };
}
function parseTerminalWalIdentity(value) {
  if (!isPlainObject(value))
    throw new Error("identity must be an object");
  assertExactKeys(value, ["session", "instanceId", "paneTarget", "tmuxServerPid", "sessionCreated"], ["sessionId", "windowId", "paneId", "generation"], "identity");
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
    tmuxServerPid: boundedInteger(value.tmuxServerPid, "identity.tmuxServerPid", 1, 2147483647),
    sessionCreated: boundedInteger(value.sessionCreated, "identity.sessionCreated", 0, Number.MAX_SAFE_INTEGER),
    ...sourceFieldCount === 0 ? {} : {
      sessionId: value.sessionId,
      windowId: value.windowId,
      paneId: value.paneId,
      generation: value.generation
    }
  };
}
function parseTerminalWalSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe non-empty identifier`);
  }
  return value;
}
function parseTerminalWalReason(value) {
  if (value === undefined)
    return;
  if (typeof value !== "string" || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error("reason must be at most 512 characters without control line breaks");
  }
  return value;
}
function resolveTerminalWalPaths(directory) {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\x00")) {
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
    lockPath: join(directory, TERMINAL_WAL_LOCK_NAME)
  };
}
function parseTerminalWalControlResponse(value) {
  if (!isPlainObject(value))
    throw new Error("control response must be an object");
  if (value.protocol !== TERMINAL_WAL_PROTOCOL_VERSION) {
    throw new Error(`control response.protocol must be ${TERMINAL_WAL_PROTOCOL_VERSION}`);
  }
  const requestId = parseTerminalWalSafeId(value.requestId, "control response.requestId");
  if (value.status === "ack") {
    assertExactKeys(value, ["protocol", "requestId", "status", "sequence", "nextOffset"], ["generation"], "control response");
    if (typeof value.sequence !== "string" || !/^[1-9]\d*$/.test(value.sequence)) {
      throw new Error("control response.sequence must be a positive decimal string");
    }
    const generation = value.generation === undefined ? undefined : parseTerminalWalSafeId(value.generation, "control response.generation");
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      status: "ack",
      sequence: value.sequence,
      nextOffset: boundedInteger(value.nextOffset, "control response.nextOffset", 1, Number.MAX_SAFE_INTEGER),
      ...generation === undefined ? {} : { generation }
    };
  }
  if (value.status === "error") {
    assertExactKeys(value, ["protocol", "requestId", "status", "code", "message"], [], "control response");
    const code = parseTerminalWalSafeId(value.code, "control response.code");
    if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 2048) {
      throw new Error("control response.message must be 1 through 2048 characters");
    }
    return {
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId,
      status: "error",
      code,
      message: value.message
    };
  }
  throw new Error("control response.status is not supported");
}
function positiveBoundedOption(value, fallback, label, maximum) {
  if (value === undefined)
    return fallback;
  return boundedInteger(value, label, 1, maximum);
}

class TerminalWalController {
  paths;
  requestTimeoutMs;
  maxControlFrameBytes;
  idPrefix = randomUUID();
  nextRequest = 0;
  socket = null;
  responseBuffer = Buffer.alloc(0);
  pending = null;
  requestTail = Promise.resolve();
  constructor(options) {
    this.paths = resolveTerminalWalPaths(options.directory);
    this.requestTimeoutMs = positiveBoundedOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 300000);
    this.maxControlFrameBytes = positiveBoundedOption(options.maxControlFrameBytes, DEFAULT_MAX_CONTROL_FRAME_BYTES, "maxControlFrameBytes", 1024 * 1024);
  }
  get connected() {
    return this.socket !== null && !this.socket.destroyed;
  }
  async connect() {
    if (this.connected)
      return;
    const socket = createConnection({ path: this.paths.socketPath });
    await new Promise((resolveConnect, rejectConnect) => {
      const onConnect = () => {
        socket.off("error", onInitialError);
        resolveConnect();
      };
      const onInitialError = (error) => {
        socket.off("connect", onConnect);
        rejectConnect(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
    });
    this.socket = socket;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => this.failPending(error));
    socket.on("close", () => {
      if (this.socket === socket)
        this.socket = null;
      this.failPending(new Error("terminal WAL control socket closed"));
    });
  }
  barrier(requestId = this.makeRequestId("barrier")) {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "BARRIER"
    });
  }
  activate(generation, requestId = this.makeRequestId("activate")) {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "ACTIVATE",
      generation: parseTerminalWalSafeId(generation, "generation")
    });
  }
  endLogicalLifecycle(requestId = this.makeRequestId("end")) {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "END"
    });
  }
  prepareResize(options) {
    const reason = parseTerminalWalReason(options.reason);
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(options.requestId ?? this.makeRequestId("prepare"), "requestId"),
      command: "RESIZE_PREPARE",
      changeId: parseTerminalWalSafeId(options.changeId, "changeId"),
      from: parseTerminalGeometry(options.from, "from"),
      to: parseTerminalGeometry(options.to, "to"),
      ...reason === undefined ? {} : { reason }
    });
  }
  commitResize(changeId, requestId = this.makeRequestId("commit")) {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "RESIZE_COMMIT",
      changeId: parseTerminalWalSafeId(changeId, "changeId")
    });
  }
  abortResize(changeId, requestId = this.makeRequestId("abort")) {
    return this.enqueue({
      protocol: TERMINAL_WAL_PROTOCOL_VERSION,
      requestId: parseTerminalWalSafeId(requestId, "requestId"),
      command: "RESIZE_ABORT",
      changeId: parseTerminalWalSafeId(changeId, "changeId")
    });
  }
  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed)
      socket.destroy();
    this.failPending(new Error("terminal WAL controller closed"));
  }
  makeRequestId(kind) {
    this.nextRequest += 1;
    return `${kind}:${this.idPrefix}:${this.nextRequest}`;
  }
  enqueue(request) {
    const operation = this.requestTail.then(() => this.send(request));
    this.requestTail = operation.catch(() => {
      return;
    });
    return operation;
  }
  async send(request) {
    if (!this.connected)
      await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed)
      throw new Error("terminal WAL control socket is not connected");
    if (this.pending)
      throw new Error("terminal WAL controller invariant: request already pending");
    const encoded = Buffer.from(`${JSON.stringify(request)}
`, "utf8");
    if (encoded.byteLength > this.maxControlFrameBytes) {
      throw new Error(`terminal WAL control request exceeds ${this.maxControlFrameBytes} bytes`);
    }
    return await new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== request.requestId)
          return;
        this.pending = null;
        socket.destroy();
        rejectRequest(new Error(`terminal WAL control request ${request.requestId} timed out`));
      }, this.requestTimeoutMs);
      this.pending = {
        requestId: request.requestId,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      };
      socket.write(encoded, (error) => {
        if (error)
          this.failPending(error);
      });
    });
  }
  receive(chunk) {
    this.responseBuffer = Buffer.concat([this.responseBuffer, Buffer.from(chunk)]);
    if (this.responseBuffer.byteLength > this.maxControlFrameBytes) {
      this.socket?.destroy(new Error("terminal WAL control response exceeds frame limit"));
      return;
    }
    const newline = this.responseBuffer.indexOf(10);
    if (newline < 0)
      return;
    const frame = this.responseBuffer.subarray(0, newline);
    this.responseBuffer = this.responseBuffer.subarray(newline + 1);
    if (this.responseBuffer.byteLength !== 0) {
      this.socket?.destroy(new Error("terminal WAL controller received unsolicited response data"));
      return;
    }
    let response;
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
  failPending(error) {
    const pending = this.pending;
    if (!pending)
      return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }
}

// src/integrations/terminal-pty-wal-proxy.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute as isAbsolute2, join as join2, resolve as resolve2 } from "node:path";
var TERMINAL_PTY_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG";
var TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV = "THUMBMUX_TERMINAL_PROXY_ASSET_SHA256";
var TERMINAL_PTY_WAL_HEALTH_FILE = "pty-proxy-status.json";
var SAFE_SESSION2 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var DEFAULT_MAX_OUTPUT_RECORD_BYTES = 64 * 1024;
var DEFAULT_MAX_PENDING_INPUT_BYTES = 1024 * 1024;
var DEFAULT_HEARTBEAT_MS = 1000;
var DEFAULT_TERMINATE_GRACE_MS = 5000;
var MAX_CONFIG_JSON_BYTES = 1024 * 1024;
function isObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined)
      throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label}.${key} is not allowed`);
  }
}
function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\x00")) {
    throw new Error(`${label} must be a non-empty string without NUL`);
  }
  return value;
}
function stringWithoutNul(value, label) {
  if (typeof value !== "string" || value.includes("\x00")) {
    throw new Error(`${label} must be a string without NUL`);
  }
  return value;
}
function commandName(value, label, fallback) {
  const selected = value === undefined ? fallback : value;
  const text = nonEmptyString(selected, label);
  if (text.includes("/")) {
    if (!isAbsolute2(text) || resolve2(text) !== text)
      throw new Error(`${label} must be normalized when it is a path`);
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) {
    throw new Error(`${label} command name is invalid`);
  }
  return text;
}
function bounded(value, fallback, label, maximum) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return selected;
}
function parseIdentity(value) {
  if (!isObject(value))
    throw new Error("terminal PTY WAL identity must be an object");
  exactKeys(value, ["session", "instanceId", "paneTarget"], [], "identity");
  if (typeof value.session !== "string" || !SAFE_SESSION2.test(value.session)) {
    throw new Error("identity.session must be a safe tmux session name");
  }
  const instanceId = parseTerminalWalSafeId(value.instanceId, "identity.instanceId");
  const expected = new RegExp(`^=${value.session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+\\.\\d+$`);
  if (typeof value.paneTarget !== "string" || !expected.test(value.paneTarget)) {
    throw new Error("identity.paneTarget must be an exact =session:window.pane target");
  }
  return { session: value.session, instanceId, paneTarget: value.paneTarget };
}
function parseTmux(value) {
  if (value === undefined)
    return { executable: "tmux" };
  if (!isObject(value))
    throw new Error("terminal PTY WAL tmux must be an object");
  exactKeys(value, [], ["executable", "socketName", "socketPath"], "tmux");
  if (value.socketName !== undefined && value.socketPath !== undefined) {
    throw new Error("tmux.socketName and tmux.socketPath are mutually exclusive");
  }
  const executable = commandName(value.executable, "tmux.executable", "tmux");
  if (value.socketName !== undefined && (typeof value.socketName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.socketName))) {
    throw new Error("tmux.socketName is invalid");
  }
  if (value.socketPath !== undefined && (typeof value.socketPath !== "string" || !isAbsolute2(value.socketPath) || resolve2(value.socketPath) !== value.socketPath || value.socketPath.includes("\x00"))) {
    throw new Error("tmux.socketPath must be an absolute normalized path");
  }
  return {
    executable,
    ...value.socketName === undefined ? {} : { socketName: value.socketName },
    ...value.socketPath === undefined ? {} : { socketPath: value.socketPath }
  };
}
function parseTerminalPtyWalProxyConfig(value) {
  if (!isObject(value))
    throw new Error("terminal PTY WAL config must be an object");
  exactKeys(value, ["directory", "identity", "argv"], [
    "cwd",
    "env",
    "tmux",
    "pythonExecutable",
    "maxOutputRecordBytes",
    "maxPendingInputBytes",
    "heartbeatMs",
    "terminateGraceMs"
  ], "terminal PTY WAL config");
  const directory = nonEmptyString(value.directory, "directory");
  resolveTerminalWalPaths(directory);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 4096) {
    throw new Error("argv must contain 1 through 4096 arguments");
  }
  const argv = value.argv.map((part, index) => nonEmptyString(part, `argv[${index}]`));
  let cwd;
  if (value.cwd !== undefined) {
    cwd = nonEmptyString(value.cwd, "cwd");
    if (!isAbsolute2(cwd) || resolve2(cwd) !== cwd)
      throw new Error("cwd must be an absolute normalized path");
  }
  const env = {};
  if (value.env !== undefined) {
    if (!isObject(value.env))
      throw new Error("env must be an object");
    for (const [name, raw] of Object.entries(value.env)) {
      if (!SAFE_ENVIRONMENT_NAME.test(name) || name === TERMINAL_PTY_WAL_CONFIG_ENV) {
        throw new Error(`env name ${JSON.stringify(name)} is not allowed`);
      }
      env[name] = stringWithoutNul(raw, `env.${name}`);
    }
  }
  const maxOutputRecordBytes = bounded(value.maxOutputRecordBytes, DEFAULT_MAX_OUTPUT_RECORD_BYTES, "maxOutputRecordBytes", 16 * 1024 * 1024);
  const maxPendingInputBytes = bounded(value.maxPendingInputBytes, DEFAULT_MAX_PENDING_INPUT_BYTES, "maxPendingInputBytes", 64 * 1024 * 1024);
  if (maxPendingInputBytes < maxOutputRecordBytes) {
    throw new Error("maxPendingInputBytes must be at least maxOutputRecordBytes");
  }
  return {
    directory,
    identity: parseIdentity(value.identity),
    argv,
    ...cwd === undefined ? {} : { cwd },
    env,
    tmux: parseTmux(value.tmux),
    pythonExecutable: commandName(value.pythonExecutable, "pythonExecutable", "python3"),
    maxOutputRecordBytes,
    maxPendingInputBytes,
    heartbeatMs: bounded(value.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs", 60000),
    terminateGraceMs: bounded(value.terminateGraceMs, DEFAULT_TERMINATE_GRACE_MS, "terminateGraceMs", 300000)
  };
}
function resolveTerminalPtyWalProxyScriptPath() {
  const candidates = [
    fileURLToPath(new URL("./terminal-pty-wal-proxy.py", import.meta.url)),
    fileURLToPath(new URL("../src/integrations/terminal-pty-wal-proxy.py", import.meta.url))
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path)
    throw new Error("shipped terminal PTY WAL proxy helper was not found");
  return path;
}
function createTerminalPtyWalProxyLaunchSpec(value, baseEnvironment = process.env) {
  const config = parseTerminalPtyWalProxyConfig(value);
  const encoded = JSON.stringify(config);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONFIG_JSON_BYTES) {
    throw new Error(`terminal PTY WAL config exceeds ${MAX_CONFIG_JSON_BYTES} bytes`);
  }
  const assetPath = resolveTerminalPtyWalProxyScriptPath();
  const assetSha256 = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
  return {
    executable: config.pythonExecutable,
    args: ["-u", assetPath],
    env: {
      ...baseEnvironment,
      [TERMINAL_PTY_WAL_CONFIG_ENV]: encoded,
      [TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV]: assetSha256,
      PYTHONUNBUFFERED: "1"
    }
  };
}
function terminalPtyWalProxyHealthPath(directory) {
  return join2(resolveTerminalWalPaths(directory).directory, TERMINAL_PTY_WAL_HEALTH_FILE);
}
function readTerminalPtyWalProxyHealth(directory) {
  const value = JSON.parse(readFileSync(terminalPtyWalProxyHealthPath(directory), "utf8"));
  if (!isObject(value))
    throw new Error("terminal PTY WAL health file must be an object");
  const required = [
    "version",
    "state",
    "generation",
    "pid",
    "pidStartTicks",
    "childPid",
    "foregroundPid",
    "foregroundPidStartTicks",
    "foregroundCommand",
    "source",
    "geometry",
    "updatedAt",
    "heartbeatAt",
    "walSequence",
    "walNextOffset",
    "deliveredSequence",
    "deliveredNextOffset"
  ];
  exactKeys(value, required, ["assetSha256", "childExitCode", "error"], "terminal PTY WAL health");
  const states = new Set(["starting", "armed", "ready", "resizing", "ending", "disconnected", "ended", "fatal"]);
  if (value.version !== 1 || typeof value.state !== "string" || !states.has(value.state)) {
    throw new Error("terminal PTY WAL health state/version is invalid");
  }
  const generation = parseTerminalWalSafeId(value.generation, "health.generation");
  const safeInteger = (raw, label, minimum) => {
    if (!Number.isSafeInteger(raw) || raw < minimum)
      throw new Error(`${label} is invalid`);
    return raw;
  };
  const decimal = (raw, label) => {
    if (typeof raw !== "string" || !/^\d+$/.test(raw))
      throw new Error(`${label} is invalid`);
    return raw;
  };
  const source = value.source === null ? null : parseTerminalWalIdentity(value.source);
  if (source && (!source.sessionId || !source.windowId || !source.paneId || source.generation !== generation)) {
    throw new Error("terminal PTY WAL health physical source is incomplete or from another generation");
  }
  const geometry = value.geometry === null ? null : parseTerminalGeometry(value.geometry, "health.geometry");
  const childPid = value.childPid === null ? null : safeInteger(value.childPid, "health.childPid", 1);
  const foregroundPid = value.foregroundPid === null ? null : safeInteger(value.foregroundPid, "health.foregroundPid", 1);
  const foregroundPidStartTicks = value.foregroundPidStartTicks === null ? null : decimal(value.foregroundPidStartTicks, "health.foregroundPidStartTicks");
  const foregroundCommand = value.foregroundCommand === null ? null : nonEmptyString(value.foregroundCommand, "health.foregroundCommand");
  if (foregroundPid === null !== (foregroundPidStartTicks === null) || foregroundPid === null !== (foregroundCommand === null)) {
    throw new Error("terminal PTY WAL foreground health fields must be supplied together");
  }
  const childExitCode = value.childExitCode === undefined ? undefined : safeInteger(value.childExitCode, "health.childExitCode", 0);
  if (typeof value.pidStartTicks !== "string" || !/^[1-9]\d*$/.test(value.pidStartTicks)) {
    throw new Error("health.pidStartTicks is invalid");
  }
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 2048)) {
    throw new Error("health.error is invalid");
  }
  if (value.assetSha256 !== undefined && (typeof value.assetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.assetSha256))) {
    throw new Error("health.assetSha256 is invalid");
  }
  return {
    version: 1,
    state: value.state,
    generation,
    pid: safeInteger(value.pid, "health.pid", 1),
    pidStartTicks: value.pidStartTicks,
    childPid,
    foregroundPid,
    foregroundPidStartTicks,
    foregroundCommand,
    source,
    geometry,
    updatedAt: safeInteger(value.updatedAt, "health.updatedAt", 0),
    heartbeatAt: safeInteger(value.heartbeatAt, "health.heartbeatAt", 0),
    walSequence: decimal(value.walSequence, "health.walSequence"),
    walNextOffset: safeInteger(value.walNextOffset, "health.walNextOffset", 0),
    deliveredSequence: decimal(value.deliveredSequence, "health.deliveredSequence"),
    deliveredNextOffset: safeInteger(value.deliveredNextOffset, "health.deliveredNextOffset", 0),
    ...childExitCode === undefined ? {} : { childExitCode },
    ...value.error === undefined ? {} : { error: value.error }
  };
}

// src/integrations/terminal-replay-worker.ts
import {
  spawn as spawn2
} from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { isAbsolute as isAbsolute4, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/terminal-replay-materializer.ts
import { spawn, spawnSync } from "node:child_process";
import * as crypto2 from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  constants as constants2,
  existsSync as existsSync3,
  fdatasyncSync as fdatasyncSync2,
  fchmodSync,
  fstatSync as fstatSync2,
  fsyncSync as fsyncSync2,
  lstatSync,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  openSync as openSync2,
  readFileSync as readFileSync2,
  readSync as readSync2,
  realpathSync,
  renameSync,
  rmSync,
  statSync as statSync2,
  truncateSync as truncateSync2,
  unlinkSync,
  writeSync as writeSync2
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute as isAbsolute3, join as join3, resolve as resolve3 } from "node:path";

// src/output-wal.ts
import {
  chmodSync,
  closeSync,
  constants,
  existsSync as existsSync2,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync
} from "node:fs";
var MAGIC = Buffer.from("THMWAL01", "ascii");
var VERSION = 1;
var HEADER_BYTES = 40;
var CHECKSUM_INPUT_BYTES = 24;
var DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
var KIND_TO_CODE = {
  lifecycle: 1,
  output: 2,
  resize: 3,
  checkpoint: 4
};
var CODE_TO_KIND = new Map(Object.entries(KIND_TO_CODE).map(([kind, code]) => [code, kind]));
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0;n < 256; n++) {
    let value = n;
    for (let bit = 0;bit < 8; bit++) {
      value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}
var CRC_TABLE = makeCrcTable();
function crc32Parts(parts) {
  let crc = 4294967295;
  for (const part of parts) {
    for (let index = 0;index < part.byteLength; index++) {
      crc = CRC_TABLE[(crc ^ part[index]) & 255] ^ crc >>> 8;
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
function readExact(fd, buffer, offset, length, position) {
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, offset + read, length - read, position + read);
    if (count === 0)
      break;
    read += count;
  }
  return read;
}
function positivePayloadLimit(value) {
  const limit = value ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("thumbmux output WAL maxPayloadBytes must be a positive safe integer");
  }
  return limit;
}
function safeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`thumbmux output WAL ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}
function parseHeader(header, offset, previousSequence, previousAt, maxPayloadBytes) {
  if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    return { kind: "corrupt", offset, message: `invalid WAL magic at byte ${offset}` };
  }
  if (header.readUInt8(8) !== VERSION) {
    return { kind: "corrupt", offset, message: `unsupported WAL version at byte ${offset}` };
  }
  const kind = CODE_TO_KIND.get(header.readUInt8(9));
  if (!kind) {
    return { kind: "corrupt", offset, message: `unknown WAL record kind at byte ${offset}` };
  }
  if (header.readUInt16LE(10) !== 0 || header.readUInt32LE(36) !== 0) {
    return { kind: "corrupt", offset, message: `non-zero reserved WAL header field at byte ${offset}` };
  }
  const payloadLength = header.readUInt32LE(12);
  if (payloadLength > maxPayloadBytes) {
    return {
      kind: "corrupt",
      offset,
      message: `WAL payload at byte ${offset} exceeds ${maxPayloadBytes} bytes`
    };
  }
  const sequence = header.readBigUInt64LE(16);
  if (sequence !== previousSequence + 1n) {
    return {
      kind: "corrupt",
      offset,
      message: `non-contiguous WAL sequence at byte ${offset}: ${sequence} after ${previousSequence}`
    };
  }
  const at = safeNumber(header.readBigUInt64LE(24), "timestamp");
  if (at < previousAt) {
    return {
      kind: "corrupt",
      offset,
      message: `decreasing WAL timestamp at byte ${offset}: ${at} after ${previousAt}`
    };
  }
  return {
    kind,
    payloadLength,
    sequence,
    at,
    checksum: header.readUInt32LE(32)
  };
}
function fileIdentity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}
function createOutputWalStartCursor(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    return {
      offset: 0,
      lastSequence: 0n,
      lastAt: 0,
      ...fileIdentity(fstatSync(fd))
    };
  } finally {
    closeSync(fd);
  }
}
function positiveBatchLimit(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`thumbmux output WAL ${label} must be a positive safe integer`);
  }
  return selected;
}
function readOutputWalTail(path, cursor, options = {}) {
  const maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
  const maxRecords = positiveBatchLimit(options.maxRecords, 1024, "maxRecords");
  const maxFrameBytes = positiveBatchLimit(options.maxFrameBytes, 64 * 1024 * 1024, "maxFrameBytes");
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.lastSequence < 0n || !Number.isSafeInteger(cursor.lastAt) || cursor.lastAt < 0 || !/^\d+$/.test(cursor.device) || !/^\d+$/.test(cursor.inode)) {
    throw new Error("thumbmux output WAL tail cursor is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    const identity = fileIdentity(stat);
    if (identity.device !== cursor.device || identity.inode !== cursor.inode) {
      throw new Error("thumbmux output WAL was replaced after the trusted tail cursor");
    }
    if (stat.size < cursor.offset) {
      throw new Error("thumbmux output WAL was truncated behind the trusted tail cursor");
    }
    let offset = cursor.offset;
    let lastSequence = cursor.lastSequence;
    let lastAt = cursor.lastAt;
    let frameBytes = 0;
    let incompleteTail = false;
    const records = [];
    while (offset < stat.size && records.length < maxRecords) {
      const remaining = stat.size - offset;
      if (remaining < HEADER_BYTES) {
        incompleteTail = true;
        break;
      }
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      if (readExact(fd, header, 0, HEADER_BYTES, offset) !== HEADER_BYTES) {
        incompleteTail = true;
        break;
      }
      const parsed = parseHeader(header, offset, lastSequence, lastAt, maxPayloadBytes);
      if ("message" in parsed)
        throw new Error(parsed.message);
      const recordBytes = HEADER_BYTES + parsed.payloadLength;
      if (remaining < recordBytes) {
        incompleteTail = true;
        break;
      }
      if (records.length > 0 && frameBytes + recordBytes > maxFrameBytes)
        break;
      const payload = Buffer.allocUnsafe(parsed.payloadLength);
      if (parsed.payloadLength > 0 && readExact(fd, payload, 0, parsed.payloadLength, offset + HEADER_BYTES) !== parsed.payloadLength) {
        incompleteTail = true;
        break;
      }
      const checksum = crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]);
      if (checksum !== parsed.checksum) {
        throw new Error(`WAL checksum mismatch at byte ${offset}`);
      }
      const nextOffset = offset + recordBytes;
      records.push({
        offset,
        nextOffset,
        sequence: parsed.sequence,
        at: parsed.at,
        kind: parsed.kind,
        payload
      });
      offset = nextOffset;
      lastSequence = parsed.sequence;
      lastAt = parsed.at;
      frameBytes += recordBytes;
    }
    return {
      records,
      cursor: { offset, lastSequence, lastAt, ...identity },
      incompleteTail,
      hasMore: !incompleteTail && offset < stat.size
    };
  } finally {
    closeSync(fd);
  }
}
function parseOutputWalJson(record) {
  if (record.kind === "output") {
    throw new Error("thumbmux output WAL output records are binary, not JSON");
  }
  return JSON.parse(Buffer.from(record.payload).toString("utf8"));
}

// src/terminal-replay-materializer.ts
var CHECKPOINT_VERSION = 1;
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var DEFAULT_REPLAY_CHUNK_BYTES = 16 * 1024;
var DEFAULT_HISTORY_CAPTURE_ROWS = 256;
var DEFAULT_COMMAND_TIMEOUT_MS = 1e4;
var DEFAULT_HISTORY_LIMIT = 65536;
var DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH = 1024 * 1024;
var COMMAND_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
var MAX_COLS = 4096;
var MAX_ROWS = 4096;
var MAX_CELLS = 4194304;
var REPLAY_WRITER_LOCK_FILE = "replay-writer-lock.sqlite";
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}
function positiveInteger(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return selected;
}
function nonEmptyString2(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function parseGeometry(value, label) {
  if (!isObject2(value))
    throw new Error(`${label} must be an object`);
  const cols = safeInteger(value.cols, `${label}.cols`, 1);
  const rows = safeInteger(value.rows, `${label}.rows`, 1);
  if (cols > MAX_COLS || rows > MAX_ROWS || cols * rows > MAX_CELLS) {
    throw new Error(`${label} exceeds the replay geometry bound`);
  }
  return { cols, rows };
}
function parseIdentity2(value, label) {
  if (!isObject2(value))
    throw new Error(`${label} must be an object`);
  const optional = (field) => value[field] === undefined ? undefined : nonEmptyString2(value[field], `${label}.${field}`);
  return {
    session: nonEmptyString2(value.session, `${label}.session`),
    instanceId: nonEmptyString2(value.instanceId, `${label}.instanceId`),
    paneTarget: nonEmptyString2(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: safeInteger(value.tmuxServerPid, `${label}.tmuxServerPid`, 1),
    sessionCreated: safeInteger(value.sessionCreated, `${label}.sessionCreated`, 0),
    ...optional("sessionId") === undefined ? {} : { sessionId: optional("sessionId") },
    ...optional("windowId") === undefined ? {} : { windowId: optional("windowId") },
    ...optional("paneId") === undefined ? {} : { paneId: optional("paneId") },
    ...optional("generation") === undefined ? {} : { generation: optional("generation") }
  };
}
function parseLifecycle(value) {
  if (!isObject2(value))
    throw new Error("lifecycle WAL payload must be an object");
  if (value.event !== "start" && value.event !== "resume" && value.event !== "end") {
    throw new Error("lifecycle.event must be start, resume, or end");
  }
  return {
    event: value.event,
    identity: parseIdentity2(value.identity, "lifecycle.identity"),
    geometry: parseGeometry(value.geometry, "lifecycle.geometry")
  };
}
function parseResize(value) {
  if (!isObject2(value))
    throw new Error("resize WAL payload must be an object");
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error("resize.phase must be prepare, commit, or abort");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("resize.reason must be a string when present");
  }
  return {
    phase: value.phase,
    changeId: nonEmptyString2(value.changeId, "resize.changeId"),
    from: parseGeometry(value.from, "resize.from"),
    to: parseGeometry(value.to, "resize.to"),
    ...value.reason === undefined ? {} : { reason: value.reason }
  };
}
function parseBarrier(value) {
  if (!isObject2(value) || value.event !== "barrier") {
    throw new Error("checkpoint WAL payload must be a barrier object");
  }
  return {
    event: "barrier",
    requestId: nonEmptyString2(value.requestId, "checkpoint.requestId")
  };
}
function sameGeometry(a, b) {
  return a.cols === b.cols && a.rows === b.rows;
}
function sameIdentity(a, b) {
  return a.session === b.session && a.instanceId === b.instanceId && a.paneTarget === b.paneTarget && a.tmuxServerPid === b.tmuxServerPid && a.sessionCreated === b.sessionCreated && a.sessionId === b.sessionId && a.windowId === b.windowId && a.paneId === b.paneId && a.generation === b.generation;
}
function sameResize(a, b) {
  return a.changeId === b.changeId && sameGeometry(a.from, b.from) && sameGeometry(a.to, b.to);
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function writeAll(fd, bytes, position) {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync2(fd, bytes, written, bytes.byteLength - written, position === undefined ? null : position + written);
    if (count <= 0)
      throw new Error("terminal replay write made no progress");
    written += count;
  }
}
function readExact2(fd, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync2(fd, bytes, read, length - read, position + read);
    if (count === 0)
      break;
    read += count;
  }
  if (read !== length) {
    throw new Error(`terminal replay expected ${length} bytes at ${position}, got ${read}`);
  }
  return bytes;
}
function fsyncDirectory(path) {
  const fd = openSync2(path, constants2.O_RDONLY | (constants2.O_DIRECTORY ?? 0));
  try {
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
}
function ensurePrivateDirectory(path) {
  const absolute = resolve3(path);
  const missing = [];
  let cursor = absolute;
  while (!existsSync3(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`cannot find an existing ancestor for terminal replay directory ${absolute}`);
    }
    cursor = parent;
  }
  const requireRealDirectory = (directory) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
      throw new Error(`terminal replay path is not a real directory: ${directory}`);
    }
  };
  requireRealDirectory(cursor);
  for (const directory of missing.reverse()) {
    try {
      mkdirSync2(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
    requireRealDirectory(directory);
    chmodSync2(directory, PRIVATE_DIRECTORY_MODE);
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
  }
  requireRealDirectory(absolute);
  chmodSync2(absolute, PRIVATE_DIRECTORY_MODE);
  fsyncDirectory(absolute);
  fsyncDirectory(dirname(absolute));
}
var PORTABLE_REPLAY_WRITER_LOCK_FILE = "replay-writer-lock.json";
var PORTABLE_REPLAY_KERNEL_LOCK_FILE = "replay-writer-lock.flock";
var FRESH_PORTABLE_LOCK_MS = 2000;
var PORTABLE_LOCK_HELPER_TIMEOUT_MS = 3000;
var PORTABLE_LOCK_HELPER = String.raw`
import fcntl, os, sys

lock_path, ready_path, contended_path, released_path, token = sys.argv[1:]
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        marker = os.open(contended_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(marker, token.encode("utf-8"))
        os.fsync(marker)
        os.close(marker)
        sys.exit(73)
    marker = os.open(ready_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(marker, token.encode("utf-8"))
    os.fsync(marker)
    os.close(marker)
    graceful_release = sys.stdin.buffer.read(1)
    fcntl.flock(fd, fcntl.LOCK_UN)
    if graceful_release:
        marker = os.open(released_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(marker, token.encode("utf-8"))
        os.fsync(marker)
        os.close(marker)
finally:
    os.close(fd)
`;
function waitForMarker(path, token, deadline) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      if (readFileSync2(path, "utf8") === token)
        return true;
    } catch {}
    Atomics.wait(sleeper, 0, 0, 5);
  }
  return false;
}

class PortableReplayKernelLease {
  helper;
  readyPath;
  contendedPath;
  releasedPath;
  token;
  released = false;
  constructor(helper, readyPath, contendedPath, releasedPath, token) {
    this.helper = helper;
    this.readyPath = readyPath;
    this.contendedPath = contendedPath;
    this.releasedPath = releasedPath;
    this.token = token;
  }
  static acquire(stateDir) {
    const token = crypto2.randomUUID();
    const lockPath = join3(stateDir, PORTABLE_REPLAY_KERNEL_LOCK_FILE);
    const readyPath = join3(stateDir, `.replay-writer-flock-ready-${token}`);
    const contendedPath = join3(stateDir, `.replay-writer-flock-contended-${token}`);
    const releasedPath = join3(stateDir, `.replay-writer-flock-released-${token}`);
    const helper = spawn("python3", ["-c", PORTABLE_LOCK_HELPER, lockPath, readyPath, contendedPath, releasedPath, token], { stdio: ["pipe", "ignore", "ignore"] });
    helper.on("error", () => {});
    helper.stdin?.on("error", () => {});
    if (!helper.pid) {
      helper.kill("SIGKILL");
      throw new Error("terminal replay portable writer lock helper did not start");
    }
    const deadline = Date.now() + PORTABLE_LOCK_HELPER_TIMEOUT_MS;
    for (;; ) {
      if (waitForMarker(readyPath, token, Math.min(deadline, Date.now() + 10))) {
        try {
          unlinkSync(readyPath);
        } catch {}
        return new PortableReplayKernelLease(helper, readyPath, contendedPath, releasedPath, token);
      }
      if (waitForMarker(contendedPath, token, Math.min(deadline, Date.now() + 10))) {
        try {
          unlinkSync(contendedPath);
        } catch {}
        helper.kill("SIGKILL");
        throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
      }
      if (Date.now() >= deadline) {
        helper.kill("SIGKILL");
        for (const path of [readyPath, contendedPath, releasedPath]) {
          try {
            unlinkSync(path);
          } catch {}
        }
        throw new Error("terminal replay portable writer lock helper timed out");
      }
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    this.helper.stdin?.write(Buffer.from([0]));
    const unlocked = waitForMarker(this.releasedPath, this.token, Date.now() + PORTABLE_LOCK_HELPER_TIMEOUT_MS);
    this.helper.stdin?.destroy();
    if (!unlocked)
      this.helper.kill("SIGKILL");
    for (const path of [this.readyPath, this.contendedPath, this.releasedPath]) {
      try {
        unlinkSync(path);
      } catch {}
    }
    if (!unlocked)
      throw new Error("terminal replay portable writer lock helper did not release");
  }
}
function isMissingSqliteRuntime(error) {
  return isObject2(error) && (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_UNKNOWN_BUILTIN_MODULE");
}
function openReplayWriterLockDatabase(path) {
  const runtimeRequire = createRequire(import.meta.url);
  let bunLoadError;
  try {
    const sqlite = runtimeRequire("bun:sqlite");
    return new sqlite.Database(path, { create: true, readwrite: true, strict: true });
  } catch (error) {
    if (!isMissingSqliteRuntime(error))
      throw error;
    bunLoadError = error;
  }
  try {
    const sqlite = runtimeRequire("node:sqlite");
    return new sqlite.DatabaseSync(path);
  } catch (nodeError) {
    if (!isMissingSqliteRuntime(nodeError))
      throw nodeError;
    return null;
  }
}
function currentBootId() {
  const value = readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!value)
    throw new Error("portable terminal replay lock cannot read the Linux boot id");
  return value;
}
function processStartTicks(pid) {
  try {
    const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0)
      return null;
    return stat.slice(close + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}
function readPortableClaim(path) {
  try {
    const value = JSON.parse(readFileSync2(path, "utf8"));
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || typeof value.bootId !== "string" || typeof value.processStartTicks !== "string")
      return null;
    return value;
  } catch {
    return null;
  }
}
function portableClaimIsAlive(claim, bootId) {
  return claim.bootId === bootId && processStartTicks(claim.pid) === claim.processStartTicks;
}

class PortableReplayWriterLease {
  path;
  directory;
  fd;
  claim;
  kernelLease;
  released = false;
  constructor(path, directory, fd, claim, kernelLease) {
    this.path = path;
    this.directory = directory;
    this.fd = fd;
    this.claim = claim;
    this.kernelLease = kernelLease;
  }
  static acquire(stateDir) {
    const kernelLease = PortableReplayKernelLease.acquire(stateDir);
    try {
      const path = join3(stateDir, PORTABLE_REPLAY_WRITER_LOCK_FILE);
      const stalePath = `${path}.stale`;
      const bootId = currentBootId();
      const startTicks = processStartTicks(process.pid);
      if (!startTicks)
        throw new Error("portable terminal replay lock cannot read its process start time");
      const claim = {
        token: crypto2.randomUUID(),
        pid: process.pid,
        bootId,
        processStartTicks: startTicks
      };
      const body = Buffer.from(`${JSON.stringify(claim)}
`, "utf8");
      const create = () => {
        let fd;
        try {
          fd = openSync2(path, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
        } catch (error) {
          if (error.code === "EEXIST")
            return null;
          throw error;
        }
        try {
          writeAll(fd, body);
          fdatasyncSync2(fd);
          fsyncDirectory(stateDir);
          return new PortableReplayWriterLease(path, stateDir, fd, claim, kernelLease);
        } catch (error) {
          closeSync2(fd);
          try {
            unlinkSync(path);
          } catch {}
          throw error;
        }
      };
      for (let attempt = 0;attempt < 8; attempt += 1) {
        const created = create();
        if (created)
          return created;
        const existing = readPortableClaim(path);
        if (!existing) {
          try {
            const age = Date.now() - statSync2(path).mtimeMs;
            if (age >= 0 && age < FRESH_PORTABLE_LOCK_MS) {
              throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes("active writer"))
              throw error;
          }
        }
        if (existing && portableClaimIsAlive(existing, bootId)) {
          throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
        }
        try {
          unlinkSync(stalePath);
        } catch {}
        try {
          renameSync(path, stalePath);
        } catch (error) {
          if (error.code === "ENOENT")
            continue;
          throw error;
        }
        const quarantined = readPortableClaim(stalePath);
        if (quarantined && portableClaimIsAlive(quarantined, bootId)) {
          try {
            if (!existsSync3(path))
              renameSync(stalePath, path);
            else
              unlinkSync(stalePath);
          } catch {}
          throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
        }
        try {
          unlinkSync(stalePath);
        } catch {}
        fsyncDirectory(stateDir);
      }
      throw new Error(`terminal replay portable writer lock is contended: ${stateDir}`);
    } catch (error) {
      kernelLease.release();
      throw error;
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    try {
      closeSync2(this.fd);
    } catch {}
    try {
      const current = readPortableClaim(this.path);
      if (current?.token === this.claim.token) {
        try {
          unlinkSync(this.path);
          fsyncDirectory(this.directory);
        } catch {}
      }
    } finally {
      this.kernelLease.release();
    }
  }
}
function isSqliteLockContention(error) {
  if (!isObject2(error))
    return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" || error.code === "ERR_SQLITE_ERROR" && typeof error.message === "string" && /\b(?:database|database table) is locked\b/i.test(error.message);
}

class TerminalReplayWriterLease {
  database;
  released = false;
  constructor(database) {
    this.database = database;
  }
  static acquire(stateDir) {
    ensurePrivateDirectory(stateDir);
    const lockPath = join3(stateDir, REPLAY_WRITER_LOCK_FILE);
    const existed = existsSync3(lockPath);
    const lockFd = openSync2(lockPath, constants2.O_CREAT | constants2.O_RDWR | constants2.O_DSYNC | (constants2.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
    try {
      if (!fstatSync2(lockFd).isFile()) {
        throw new Error(`terminal replay writer lock is not a regular file: ${lockPath}`);
      }
      fchmodSync(lockFd, PRIVATE_FILE_MODE);
      fdatasyncSync2(lockFd);
    } finally {
      closeSync2(lockFd);
    }
    if (!existed)
      fsyncDirectory(stateDir);
    let database = null;
    try {
      database = openReplayWriterLockDatabase(lockPath);
      if (!database)
        return PortableReplayWriterLease.acquire(stateDir);
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec(`
        CREATE TABLE IF NOT EXISTS replay_writer_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
        )
      `);
      database.exec("BEGIN IMMEDIATE");
      return new TerminalReplayWriterLease(database);
    } catch (error) {
      if (database) {
        try {
          database.close();
        } catch {}
      }
      if (isSqliteLockContention(error)) {
        throw new Error(`terminal replay state already has an active writer: ${stateDir}`, { cause: error });
      }
      throw error;
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    try {
      this.database.exec("ROLLBACK");
    } catch {}
    try {
      this.database.close();
    } catch {}
  }
}
function writeAtomicJson(path, value) {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join3(directory, `.${basename(path)}.tmp-${process.pid}-${crypto2.randomUUID()}`);
  const body = Buffer.from(`${JSON.stringify(value)}
`, "utf8");
  const fd = openSync2(temporary, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
  try {
    writeAll(fd, body);
    fdatasyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync2(path, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
function validBase64(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}
function parseScreen(value) {
  if (!isObject2(value))
    throw new Error("checkpoint.screen must be an object");
  const geometry = parseGeometry(value, "checkpoint.screen");
  const cursorX = safeInteger(value.cursorX, "checkpoint.screen.cursorX", 0);
  const cursorY = safeInteger(value.cursorY, "checkpoint.screen.cursorY", 0);
  if (cursorX >= geometry.cols || cursorY >= geometry.rows) {
    throw new Error("checkpoint screen cursor lies outside its geometry");
  }
  for (const field of ["cursorVisible", "alternateOn", "mouseSgr", "mouseAny"]) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`checkpoint.screen.${field} must be boolean`);
    }
  }
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: value.cursorVisible,
    alternateOn: value.alternateOn,
    mouseSgr: value.mouseSgr,
    mouseAny: value.mouseAny,
    cellsBase64: validBase64(value.cellsBase64, "checkpoint.screen.cellsBase64"),
    pendingEscapeBase64: validBase64(value.pendingEscapeBase64, "checkpoint.screen.pendingEscapeBase64")
  };
}
function parseCheckpoint(value) {
  if (!isObject2(value) || value.version !== CHECKPOINT_VERSION) {
    throw new Error(`unsupported terminal replay checkpoint version`);
  }
  if (!isObject2(value.cursor))
    throw new Error("checkpoint.cursor must be an object");
  const sequence = nonEmptyString2(value.cursor.sequence, "checkpoint.cursor.sequence");
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) {
    throw new Error("checkpoint.cursor.sequence must be an unsigned decimal bigint");
  }
  if (value.lifecycle !== "none" && value.lifecycle !== "active" && value.lifecycle !== "ended") {
    throw new Error("checkpoint.lifecycle is invalid");
  }
  const identity = value.identity === null ? null : parseIdentity2(value.identity, "checkpoint.identity");
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
    walPath: nonEmptyString2(value.walPath, "checkpoint.walPath"),
    cursor: {
      walOffset: safeInteger(value.cursor.walOffset, "checkpoint.cursor.walOffset", 0),
      sequence
    },
    historyBytes: safeInteger(value.historyBytes, "checkpoint.historyBytes", 0),
    lifecycle: value.lifecycle,
    identity,
    geometry,
    pendingResize,
    screen
  };
}
function readTerminalReplayCheckpoint(path) {
  if (!existsSync3(path))
    return null;
  let decoded;
  try {
    decoded = JSON.parse(readFileSync2(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse terminal replay checkpoint ${path}: ${String(error)}`);
  }
  return parseCheckpoint(decoded);
}
function sameScreen(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameNullableIdentity(a, b) {
  return a === null ? b === null : b !== null && sameIdentity(a, b);
}
function sameNullableGeometry(a, b) {
  return a === null ? b === null : b !== null && sameGeometry(a, b);
}
function sameNullableResize(a, b) {
  return a === null ? b === null : b !== null && a.phase === b.phase && sameResize(a, b);
}

class MaterializedHistoryFile {
  path;
  fd;
  committedBytes;
  derivedBytes = 0;
  writePosition;
  constructor(path, checkpoint) {
    this.path = path;
    const directory = dirname(path);
    ensurePrivateDirectory(directory);
    const existed = existsSync3(path);
    this.fd = openSync2(path, constants2.O_CREAT | constants2.O_RDWR | constants2.O_DSYNC, PRIVATE_FILE_MODE);
    chmodSync2(path, PRIVATE_FILE_MODE);
    if (!existed)
      fsyncDirectory(directory);
    this.committedBytes = checkpoint?.historyBytes ?? 0;
    const currentBytes = fstatSync2(this.fd).size;
    if (currentBytes < this.committedBytes) {
      this.close();
      throw new Error(`materialized history is ${currentBytes} bytes, below committed ${this.committedBytes}`);
    }
    if (currentBytes > this.committedBytes) {
      truncateSync2(path, this.committedBytes);
      fdatasyncSync2(this.fd);
    }
    this.writePosition = this.committedBytes;
  }
  accept(bytes, mode) {
    if (bytes.byteLength === 0)
      return;
    if (mode === "verify") {
      if (this.derivedBytes + bytes.byteLength > this.committedBytes) {
        throw new Error("replayed history exceeds the committed checkpoint length");
      }
      const expected = readExact2(this.fd, bytes.byteLength, this.derivedBytes);
      if (!expected.equals(Buffer.from(bytes))) {
        throw new Error(`replayed history differs at byte ${this.derivedBytes}`);
      }
    } else {
      if (this.derivedBytes !== this.writePosition) {
        throw new Error(`materialized history cursor diverged: ${this.derivedBytes}/${this.writePosition}`);
      }
      writeAll(this.fd, bytes, this.writePosition);
      this.writePosition += bytes.byteLength;
    }
    this.derivedBytes += bytes.byteLength;
  }
  finishVerification() {
    if (this.derivedBytes !== this.committedBytes) {
      throw new Error(`replayed history length ${this.derivedBytes} differs from committed ${this.committedBytes}`);
    }
  }
  flush() {
    fdatasyncSync2(this.fd);
  }
  get bytes() {
    return this.writePosition;
  }
  close() {
    if (this.fd < 0)
      return;
    fdatasyncSync2(this.fd);
    closeSync2(this.fd);
    this.fd = -1;
  }
}

class StatefulVtReplayChunker {
  maxBatchBytes;
  rowEffectBudget;
  batchParts = [];
  batchBytes = 0;
  batchRowEffect = 0;
  pendingParts = [];
  pendingLength = 0;
  pendingIsCsi = false;
  pendingUtf8Expected = 0;
  constructor(maxBatchBytes, rowEffectBudget) {
    this.maxBatchBytes = maxBatchBytes;
    this.rowEffectBudget = rowEffectBudget;
  }
  flush(emit) {
    if (this.batchBytes === 0)
      return;
    emit(Buffer.concat(this.batchParts, this.batchBytes));
    this.batchParts.length = 0;
    this.batchBytes = 0;
    this.batchRowEffect = 0;
  }
  addAtomic(token, rowEffect, emit) {
    if (this.batchBytes > 0 && (this.batchBytes + token.byteLength > this.maxBatchBytes || this.batchRowEffect + rowEffect > this.rowEffectBudget)) {
      this.flush(emit);
    }
    this.batchParts.push(token);
    this.batchBytes += token.byteLength;
    this.batchRowEffect += rowEffect;
    if (this.batchBytes >= this.maxBatchBytes || this.batchRowEffect >= this.rowEffectBudget) {
      this.flush(emit);
    }
  }
  addOrdinary(bytes, emit) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.batchBytes >= this.maxBatchBytes || this.batchRowEffect >= this.rowEffectBudget) {
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
      this.batchRowEffect += take;
      offset += take;
    }
  }
  appendPending(bytes) {
    if (bytes.byteLength === 0)
      return;
    this.pendingParts.push(Buffer.from(bytes));
    this.pendingLength += bytes.byteLength;
  }
  takePending() {
    const pending = Buffer.concat(this.pendingParts, this.pendingLength);
    this.pendingParts = [];
    this.pendingLength = 0;
    this.pendingIsCsi = false;
    this.pendingUtf8Expected = 0;
    return pending;
  }
  utf8Length(first) {
    if (first >= 194 && first <= 223)
      return 2;
    if (first >= 224 && first <= 239)
      return 3;
    if (first >= 240 && first <= 244)
      return 4;
    return 1;
  }
  csiRowEffect(token, rows) {
    const final = token[token.byteLength - 1];
    if (final !== 83)
      return token.byteLength;
    const parameter = token.subarray(2, -1).toString("ascii");
    if (!/^[0-9]*$/.test(parameter))
      return rows;
    const requested = parameter === "" || parameter === "0" ? 1 : Math.min(Number(parameter), rows);
    return Math.max(1, Math.min(requested, rows));
  }
  accept(bytes, rows, emit) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.pendingLength > 0) {
        if (this.pendingUtf8Expected > 0) {
          const needed = this.pendingUtf8Expected - this.pendingLength;
          const take = Math.min(needed, bytes.byteLength - offset);
          this.appendPending(bytes.subarray(offset, offset + take));
          offset += take;
          if (this.pendingLength === this.pendingUtf8Expected) {
            const token2 = this.takePending();
            this.addAtomic(token2, token2.byteLength, emit);
          }
          continue;
        }
        if (!this.pendingIsCsi) {
          const next = bytes[offset];
          this.appendPending(bytes.subarray(offset, offset + 1));
          offset += 1;
          if (next === 91) {
            this.pendingIsCsi = true;
          } else {
            const token2 = this.takePending();
            this.addAtomic(token2, token2.byteLength, emit);
          }
          continue;
        }
        let end = offset;
        while (end < bytes.byteLength && !(bytes[end] >= 64 && bytes[end] <= 126)) {
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
      while (special < bytes.byteLength && bytes[special] !== 27 && bytes[special] < 128) {
        special += 1;
      }
      if (special > offset) {
        this.addOrdinary(bytes.subarray(offset, special), emit);
        offset = special;
      }
      if (offset < bytes.byteLength && bytes[offset] === 27) {
        this.appendPending(bytes.subarray(offset, offset + 1));
        this.pendingIsCsi = false;
        offset += 1;
      } else if (offset < bytes.byteLength) {
        const expected = this.utf8Length(bytes[offset]);
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
  get pendingBytes() {
    return Buffer.concat(this.pendingParts, this.pendingLength);
  }
  reset() {
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
  command;
  replayChunkBytes;
  historyCaptureRows;
  historyLimit;
  commandTimeoutMs;
  temporaryRoot;
  mirrorPath;
  inputFifoPath;
  configPath;
  session;
  target;
  socketPath;
  started = false;
  inputFd = -1;
  peakMirrorBytes = 0;
  chunker;
  constructor(options) {
    this.command = options.command;
    this.replayChunkBytes = options.replayChunkBytes;
    this.historyCaptureRows = options.historyCaptureRows;
    this.historyLimit = options.historyLimit;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.chunker = new StatefulVtReplayChunker(this.replayChunkBytes, Math.max(1, this.historyLimit - MAX_ROWS));
    if (options.socketPath && !isAbsolute3(options.socketPath)) {
      throw new Error("terminal replay socketPath must be absolute");
    }
    if (options.socketPath && existsSync3(options.socketPath)) {
      throw new Error(`terminal replay socket already exists: ${options.socketPath}`);
    }
    this.temporaryRoot = mkdtempSync(join3(tmpdir(), "thumbmux-terminal-replay-"));
    chmodSync2(this.temporaryRoot, PRIVATE_DIRECTORY_MODE);
    this.mirrorPath = join3(this.temporaryRoot, "raw-output.mirror");
    const mirrorFd = openSync2(this.mirrorPath, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY, PRIVATE_FILE_MODE);
    closeSync2(mirrorFd);
    this.inputFifoPath = join3(this.temporaryRoot, "replay-input.fifo");
    const fifo = spawnSync("mkfifo", ["-m", "600", this.inputFifoPath], {
      encoding: null,
      timeout: this.commandTimeoutMs,
      windowsHide: true
    });
    if (fifo.error || fifo.status !== 0 || !statSync2(this.inputFifoPath).isFIFO()) {
      const detail = Buffer.from(fifo.stderr ?? []).toString("utf8").trim();
      rmSync(this.temporaryRoot, { recursive: true, force: true });
      throw new Error(`cannot create private replay FIFO${detail ? `: ${detail}` : ""}`);
    }
    this.configPath = join3(this.temporaryRoot, "tmux.conf");
    const configFd = openSync2(this.configPath, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
    try {
      writeAll(configFd, Buffer.from(`set-option -g history-limit ${this.historyLimit}
set-option -g status off
`, "utf8"));
      fdatasyncSync2(configFd);
    } finally {
      closeSync2(configFd);
    }
    fsyncDirectory(this.temporaryRoot);
    this.socketPath = options.socketPath ?? join3(this.temporaryRoot, "tmux.sock");
    const suffix = crypto2.randomUUID().replaceAll("-", "").slice(0, 12);
    this.session = `sh-thumbmux-replay-${suffix}`;
    this.target = `=${this.session}:0.0`;
  }
  run(args, input) {
    const result = spawnSync(this.command, ["-S", this.socketPath, ...args], {
      input,
      encoding: null,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      timeout: this.commandTimeoutMs,
      windowsHide: true
    });
    if (result.error) {
      throw new Error(`private tmux ${args[0] ?? "command"} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim();
      throw new Error(`private tmux ${args[0] ?? "command"} exited ${String(result.status)}` + (detail ? `: ${detail}` : ""));
    }
    return Buffer.from(result.stdout ?? []);
  }
  format(format) {
    return this.run(["display-message", "-p", "-t", this.target, format]).toString("utf8").replace(/\n$/, "");
  }
  waitFor(description, predicate) {
    const deadline = Date.now() + this.commandTimeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        if (predicate())
          return;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      sleepSync(2);
    }
    throw new Error(`timed out waiting for private tmux ${description}` + (lastError ? `: ${String(lastError)}` : ""));
  }
  replayCommand() {
    const quotedFifo = `'${this.inputFifoPath.replaceAll("'", "'\\''")}'`;
    return `stty raw -echo; exec cat -- ${quotedFifo}`;
  }
  attachMirror() {
    truncateSync2(this.mirrorPath, 0);
    const quotedMirror = `'${this.mirrorPath.replaceAll("'", "'\\''")}'`;
    this.run([
      "pipe-pane",
      "-O",
      "-t",
      this.target,
      `exec cat >> ${quotedMirror}`
    ]);
    this.waitFor("pipe attachment", () => this.format("#{pane_pipe}") === "1");
  }
  waitForCat() {
    this.waitFor("cat startup", () => {
      const [command, dead] = this.format("#{pane_current_command}|#{pane_dead}").split("|");
      if (dead === "1")
        throw new Error("private replay pane died during startup");
      return command === "cat";
    });
  }
  start(geometry) {
    if (this.started)
      throw new Error("private terminal replay pane already exists");
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
      this.replayCommand()
    ]);
    this.started = true;
    this.waitForCat();
    const configuredLimit = safeInteger(Number(this.run(["show-options", "-gv", "history-limit"]).toString("utf8").trim()), "private replay history-limit", 1);
    if (configuredLimit !== this.historyLimit) {
      throw new Error(`private replay history-limit is ${configuredLimit}, expected ${this.historyLimit}`);
    }
    this.run(["clear-history", "-t", this.target]);
    this.attachMirror();
    this.inputFd = openSync2(this.inputFifoPath, constants2.O_WRONLY);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay pane started at ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
  }
  ensureAlive() {
    if (!this.started)
      throw new Error("private terminal replay pane is not started");
    if (this.format("#{pane_dead}") === "1") {
      throw new Error("private terminal replay pane died");
    }
  }
  waitForMirroredBytes(expected) {
    this.waitFor(`${expected.byteLength} mirrored output bytes`, () => {
      const size = statSync2(this.mirrorPath).size;
      this.peakMirrorBytes = Math.max(this.peakMirrorBytes, size);
      if (size > expected.byteLength) {
        throw new Error(`private replay emitted unexpected bytes: ${size} > ${expected.byteLength}`);
      }
      return size === expected.byteLength;
    });
    const mirrorFd = openSync2(this.mirrorPath, constants2.O_RDONLY);
    let actual;
    try {
      actual = readExact2(mirrorFd, expected.byteLength, 0);
    } finally {
      closeSync2(mirrorFd);
    }
    if (!actual.equals(Buffer.from(expected))) {
      throw new Error("private replay changed output bytes in the current replay batch");
    }
    truncateSync2(this.mirrorPath, 0);
    this.ensureAlive();
  }
  feedChunk(bytes) {
    if (bytes.byteLength === 0)
      return;
    if (this.inputFd < 0) {
      throw new Error("private replay FIFO writer is not open");
    }
    if (statSync2(this.mirrorPath).size !== 0) {
      throw new Error("private replay mirror was not empty at batch start");
    }
    writeAll(this.inputFd, bytes);
    this.waitForMirroredBytes(bytes);
  }
  feed(bytes, onHistory) {
    this.chunker.accept(bytes, this.currentGeometry().rows, (chunk) => {
      this.feedChunk(chunk);
      this.drainHistory(onHistory);
    });
    if (bytes.byteLength === 0)
      this.drainHistory(onHistory);
  }
  currentGeometry() {
    const [colsText, rowsText] = this.format("#{pane_width}|#{pane_height}").split("|");
    return {
      cols: safeInteger(Number(colsText), "private replay pane width", 1),
      rows: safeInteger(Number(rowsText), "private replay pane height", 1)
    };
  }
  resize(geometry, onHistory) {
    this.drainHistory(onHistory);
    this.run([
      "resize-window",
      "-t",
      this.target,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows)
    ]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay resize produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
    this.drainHistory(onHistory);
  }
  resizeUnseen(geometry) {
    this.discardHistory();
    this.run([
      "resize-window",
      "-t",
      this.target,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows)
    ]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay resize produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
    this.discardHistory();
  }
  sealVisibleAndReset(geometry, onHistory) {
    this.drainHistory(onHistory);
    const oldScreen = this.captureScreen();
    onHistory(Buffer.from(oldScreen.cellsBase64, "base64"));
    this.resetGeneration(geometry);
  }
  discardUnseenAndReset(geometry) {
    this.resetGeneration(geometry);
  }
  resetGeneration(geometry) {
    if (this.inputFd < 0)
      throw new Error("private replay FIFO writer is not open");
    const previousWriter = this.inputFd;
    truncateSync2(this.mirrorPath, 0);
    this.run([
      "respawn-pane",
      "-k",
      "-t",
      this.target,
      this.replayCommand()
    ]);
    this.waitForCat();
    if (this.format("#{pane_pipe}") !== "1")
      this.attachMirror();
    const replacementWriter = openSync2(this.inputFifoPath, constants2.O_WRONLY);
    this.inputFd = replacementWriter;
    closeSync2(previousWriter);
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
        String(geometry.rows)
      ]);
    }
    this.run(["clear-history", "-t", this.target]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay generation reset produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
  }
  discardHistory() {
    this.run(["clear-history", "-t", this.target]);
    const remaining = this.historySize();
    if (remaining !== 0) {
      throw new Error(`private replay clear-history left ${remaining} rows`);
    }
  }
  historySize() {
    const text = this.format("#{history_size}");
    return safeInteger(Number(text), "private replay history_size", 0);
  }
  drainHistory(onHistory) {
    const historySize = this.historySize();
    if (historySize === 0)
      return;
    for (let start = -historySize;start <= -1; start += this.historyCaptureRows) {
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
        String(end)
      ]);
      let terminators = 0;
      for (const byte of captured)
        if (byte === 10)
          terminators += 1;
      if (terminators !== expectedRows) {
        throw new Error(`capture-pane returned ${terminators} rows, expected ${expectedRows}`);
      }
      onHistory(captured);
    }
    this.run(["clear-history", "-t", this.target]);
    const remaining = this.historySize();
    if (remaining !== 0) {
      throw new Error(`private replay clear-history left ${remaining} rows`);
    }
  }
  captureScreen() {
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
      "#{mouse_any_flag}"
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
      this.target
    ]);
    const statusEnd = output.indexOf(10);
    if (statusEnd < 0)
      throw new Error("private replay screen status has no terminator");
    const status = output.subarray(0, statusEnd).toString("utf8").split("|");
    if (status.length !== 9)
      throw new Error("private replay screen status is malformed");
    const [x, y, cols, rows, history, cursor, alternate, mouseSgr, mouseAny] = status.map(Number);
    if (history !== 0)
      throw new Error("private replay history changed during checkpoint capture");
    const geometry = parseGeometry({ cols, rows }, "private replay checkpoint geometry");
    let screenEnd = statusEnd + 1;
    for (let row = 0;row < geometry.rows; row += 1) {
      screenEnd = output.indexOf(10, screenEnd);
      if (screenEnd < 0)
        throw new Error("private replay screen capture is truncated");
      screenEnd += 1;
    }
    const cells = output.subarray(statusEnd + 1, screenEnd);
    const pendingWithTerminator = output.subarray(screenEnd);
    if (pendingWithTerminator.byteLength === 0 || pendingWithTerminator[pendingWithTerminator.byteLength - 1] !== 10) {
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
      pendingEscapeBase64: pending.toString("base64")
    };
  }
  close() {
    if (this.started) {
      try {
        this.run(["pipe-pane", "-t", this.target]);
      } catch {}
      try {
        this.run(["kill-server"]);
      } catch {}
      this.started = false;
    }
    if (this.inputFd >= 0) {
      try {
        closeSync2(this.inputFd);
      } catch {}
      this.inputFd = -1;
    }
    if (existsSync3(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    rmSync(this.temporaryRoot, { recursive: true, force: true });
  }
  get boundedMirrorPath() {
    return this.mirrorPath;
  }
  get peakBoundedMirrorBytes() {
    return this.peakMirrorBytes;
  }
}

class ReplayEngine {
  tmux;
  lifecycle = "none";
  identity = null;
  geometry = null;
  pendingResize = null;
  recordsSeen = 0;
  hasOutputInGeneration = false;
  constructor(tmux) {
    this.tmux = tmux;
  }
  requireActive(record) {
    if (this.lifecycle !== "active" || !this.identity || !this.geometry) {
      throw new Error(`WAL ${record.kind} record ${record.sequence} appears outside an active lifecycle`);
    }
  }
  requireLogicalIdentity(next, label) {
    if (!this.identity || next.session !== this.identity.session || next.instanceId !== this.identity.instanceId) {
      throw new Error(`${label} changes the WAL logical session identity`);
    }
  }
  processLifecycle(record, value, onHistory) {
    if (value.event === "start") {
      if (this.recordsSeen !== 0 || this.lifecycle !== "none") {
        throw new Error("lifecycle start must be the first WAL record and may appear only once");
      }
      this.tmux.start(value.geometry);
      this.lifecycle = "active";
      this.identity = value.identity;
      this.geometry = value.geometry;
      this.hasOutputInGeneration = false;
      return;
    }
    this.requireActive(record);
    this.requireLogicalIdentity(value.identity, `lifecycle ${value.event}`);
    if (this.pendingResize) {
      throw new Error(`lifecycle ${value.event} appears during prepared resize ${this.pendingResize.changeId}`);
    }
    if (value.event === "resume") {
      const generationChanged = value.identity.generation !== undefined && value.identity.generation !== this.identity.generation;
      if (generationChanged) {
        if (this.hasOutputInGeneration) {
          this.tmux.sealVisibleAndReset(value.geometry, onHistory);
        } else {
          this.tmux.discardUnseenAndReset(value.geometry);
        }
        this.hasOutputInGeneration = false;
      } else {
        if (this.hasOutputInGeneration) {
          this.tmux.drainHistory(onHistory);
        } else {
          this.tmux.discardHistory();
        }
        if (!sameGeometry(this.geometry, value.geometry)) {
          if (this.hasOutputInGeneration) {
            this.tmux.resize(value.geometry, onHistory);
          } else {
            this.tmux.resizeUnseen(value.geometry);
          }
        }
      }
      this.identity = value.identity;
      this.geometry = value.geometry;
      return;
    }
    if (!sameGeometry(this.geometry, value.geometry)) {
      throw new Error(`lifecycle end geometry ${value.geometry.cols}x${value.geometry.rows} differs from replay ${this.geometry.cols}x${this.geometry.rows}`);
    }
    if (this.hasOutputInGeneration) {
      this.tmux.drainHistory(onHistory);
    } else {
      this.tmux.discardHistory();
    }
    this.identity = value.identity;
    this.lifecycle = "ended";
  }
  processResize(record, value, onHistory) {
    this.requireActive(record);
    if (value.phase === "prepare") {
      if (this.pendingResize) {
        throw new Error(`resize prepare ${value.changeId} overlaps prepared ${this.pendingResize.changeId}`);
      }
      if (!sameGeometry(this.geometry, value.from)) {
        throw new Error(`resize prepare ${value.changeId} starts at ${value.from.cols}x${value.from.rows}, replay is ${this.geometry.cols}x${this.geometry.rows}`);
      }
      if (this.hasOutputInGeneration) {
        this.tmux.drainHistory(onHistory);
      } else {
        this.tmux.discardHistory();
      }
      this.pendingResize = value;
      return;
    }
    if (!this.pendingResize) {
      if (value.phase === "commit" && value.reason === "tmux-control-layout") {
        if (!sameGeometry(this.geometry, value.from)) {
          throw new Error(`authoritative resize ${value.changeId} source geometry changed`);
        }
        if (this.hasOutputInGeneration) {
          this.tmux.resize(value.to, onHistory);
        } else {
          this.tmux.resizeUnseen(value.to);
        }
        this.geometry = value.to;
        return;
      }
      throw new Error(`resize ${value.phase} ${value.changeId} has no matching prepare`);
    }
    if (!sameResize(this.pendingResize, value)) {
      throw new Error(`resize ${value.phase} ${value.changeId} does not match its prepare`);
    }
    if (!sameGeometry(this.geometry, value.from)) {
      throw new Error(`resize ${value.phase} ${value.changeId} source geometry changed`);
    }
    if (value.phase === "commit") {
      if (this.hasOutputInGeneration) {
        this.tmux.resize(value.to, onHistory);
      } else {
        this.tmux.resizeUnseen(value.to);
      }
      this.geometry = value.to;
    }
    this.pendingResize = null;
  }
  process(record, onHistory) {
    try {
      switch (record.kind) {
        case "lifecycle":
          this.processLifecycle(record, parseLifecycle(parseOutputWalJson(record)), onHistory);
          break;
        case "output":
          this.requireActive(record);
          if (this.pendingResize) {
            throw new Error(`output appears during prepared resize ${this.pendingResize.changeId}`);
          }
          if (record.payload.byteLength > 0) {
            this.tmux.feed(record.payload, onHistory);
            this.hasOutputInGeneration = true;
          }
          break;
        case "resize":
          this.processResize(record, parseResize(parseOutputWalJson(record)), onHistory);
          break;
        case "checkpoint":
          parseBarrier(parseOutputWalJson(record));
          break;
        default: {
          const exhaustive = record.kind;
          throw new Error(`unknown WAL record kind ${String(exhaustive)}`);
        }
      }
      this.recordsSeen += 1;
    } catch (error) {
      throw new Error(`terminal replay failed at WAL record ${record.sequence}: ${String(error)}`);
    }
  }
  snapshot() {
    return {
      lifecycle: this.lifecycle,
      identity: this.identity ? { ...this.identity } : null,
      geometry: this.geometry ? { ...this.geometry } : null,
      pendingResize: this.pendingResize ? {
        ...this.pendingResize,
        from: { ...this.pendingResize.from },
        to: { ...this.pendingResize.to }
      } : null,
      screen: this.lifecycle === "none" ? null : this.tmux.captureScreen()
    };
  }
  get hasPendingResize() {
    return this.pendingResize !== null;
  }
}
function assertCheckpointSnapshot(checkpoint, snapshot) {
  if (checkpoint.lifecycle !== snapshot.lifecycle) {
    throw new Error(`replayed lifecycle ${snapshot.lifecycle} differs from checkpoint ${checkpoint.lifecycle}`);
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

class TerminalReplayMaterializer {
  walPath;
  stateDir;
  historyPath;
  checkpointPath;
  tmuxCommand;
  socketPath;
  replayChunkBytes;
  historyCaptureRows;
  historyLimit;
  commandTimeoutMs;
  maxWalFrameBytesPerRefresh;
  recoveryTarget;
  constructor(options) {
    this.walPath = resolve3(nonEmptyString2(options.walPath, "walPath"));
    this.stateDir = resolve3(nonEmptyString2(options.stateDir, "stateDir"));
    this.historyPath = resolve3(options.historyPath ?? join3(this.stateDir, "history.ansi"));
    this.checkpointPath = resolve3(options.checkpointPath ?? join3(this.stateDir, "checkpoint.json"));
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    nonEmptyString2(this.tmuxCommand, "tmuxCommand");
    this.socketPath = options.socketPath;
    this.replayChunkBytes = positiveInteger(options.replayChunkBytes, DEFAULT_REPLAY_CHUNK_BYTES, "replayChunkBytes");
    this.historyCaptureRows = positiveInteger(options.historyCaptureRows, DEFAULT_HISTORY_CAPTURE_ROWS, "historyCaptureRows");
    this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, "historyLimit");
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
    this.maxWalFrameBytesPerRefresh = positiveInteger(options.maxWalFrameBytesPerRefresh, DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH, "maxWalFrameBytesPerRefresh");
    if (options.recoverySequence === undefined !== (options.recoveryWalOffset === undefined)) {
      throw new Error("recoverySequence and recoveryWalOffset must be supplied together");
    }
    if (options.recoverySequence !== undefined && options.recoveryWalOffset !== undefined) {
      if (!/^[1-9]\d*$/.test(options.recoverySequence)) {
        throw new Error("recoverySequence must be a positive decimal bigint");
      }
      const sequence = BigInt(options.recoverySequence);
      if (sequence > (1n << 64n) - 1n)
        throw new Error("recoverySequence exceeds uint64");
      if (!Number.isSafeInteger(options.recoveryWalOffset) || options.recoveryWalOffset <= 0) {
        throw new Error("recoveryWalOffset must be a positive safe integer");
      }
      this.recoveryTarget = { sequence, walOffset: options.recoveryWalOffset };
    } else {
      this.recoveryTarget = null;
    }
    if (this.historyLimit <= MAX_ROWS) {
      throw new Error(`historyLimit must be greater than the maximum replay pane height ${MAX_ROWS}`);
    }
    if (this.walPath === this.historyPath || this.walPath === this.checkpointPath) {
      throw new Error("terminal replay output paths must not overwrite the raw WAL");
    }
    if (this.historyPath === this.checkpointPath) {
      throw new Error("terminal replay historyPath and checkpointPath must differ");
    }
    ensurePrivateDirectory(this.stateDir);
  }
  open() {
    return new TerminalReplaySession({
      walPath: this.walPath,
      stateDir: this.stateDir,
      historyPath: this.historyPath,
      checkpointPath: this.checkpointPath,
      tmuxCommand: this.tmuxCommand,
      socketPath: this.socketPath,
      replayChunkBytes: this.replayChunkBytes,
      historyCaptureRows: this.historyCaptureRows,
      historyLimit: this.historyLimit,
      commandTimeoutMs: this.commandTimeoutMs,
      maxWalFrameBytesPerRefresh: this.maxWalFrameBytesPerRefresh,
      recoveryTarget: this.recoveryTarget
    });
  }
  materialize() {
    const session = this.open();
    try {
      let result = session.current;
      while (result.hasMoreWal)
        result = session.refresh();
      return result;
    } finally {
      session.close();
    }
  }
}

class TerminalReplaySession {
  walPath;
  historyPath;
  checkpointPath;
  writerLease;
  recoveredFromCheckpoint;
  maxWalFrameBytesPerRefresh;
  recoveryTarget;
  history;
  tmux;
  engine;
  lastOffset = 0;
  lastSequence = 0n;
  lastAt = 0;
  tailCursor = null;
  hasMoreWal = false;
  closed = false;
  result;
  constructor(options) {
    this.walPath = options.walPath;
    this.historyPath = options.historyPath;
    this.checkpointPath = options.checkpointPath;
    this.maxWalFrameBytesPerRefresh = options.maxWalFrameBytesPerRefresh;
    this.recoveryTarget = options.recoveryTarget;
    const writerLease = TerminalReplayWriterLease.acquire(options.stateDir);
    this.writerLease = writerLease;
    let checkpoint;
    try {
      checkpoint = readTerminalReplayCheckpoint(this.checkpointPath);
      if (checkpoint && resolve3(checkpoint.walPath) !== this.walPath) {
        throw new Error(`checkpoint belongs to ${checkpoint.walPath}, not ${this.walPath}`);
      }
      if (checkpoint && this.recoveryTarget) {
        const checkpointSequence = BigInt(checkpoint.cursor.sequence);
        if (checkpoint.cursor.walOffset === this.recoveryTarget.walOffset && checkpointSequence !== this.recoveryTarget.sequence)
          throw new Error("terminal replay checkpoint target offset has a different sequence");
        if (checkpoint.cursor.walOffset > this.recoveryTarget.walOffset) {
          unlinkSync(this.checkpointPath);
          fsyncDirectory(dirname(this.checkpointPath));
          checkpoint = null;
        } else if (checkpoint.cursor.walOffset === this.recoveryTarget.walOffset) {
          this.recoveryTarget = null;
        }
      }
    } catch (error) {
      writerLease.release();
      throw error;
    }
    this.recoveredFromCheckpoint = checkpoint !== null;
    let history;
    try {
      history = new MaterializedHistoryFile(this.historyPath, checkpoint);
    } catch (error) {
      writerLease.release();
      throw error;
    }
    let tmux;
    try {
      tmux = new PrivateTmuxReplay({
        command: options.tmuxCommand,
        socketPath: options.socketPath,
        replayChunkBytes: options.replayChunkBytes,
        historyCaptureRows: options.historyCaptureRows,
        historyLimit: options.historyLimit,
        commandTimeoutMs: options.commandTimeoutMs
      });
    } catch (error) {
      try {
        history.close();
      } finally {
        writerLease.release();
      }
      throw error;
    }
    this.history = history;
    this.tmux = tmux;
    this.engine = new ReplayEngine(this.tmux);
    try {
      if (existsSync3(this.walPath)) {
        this.tailCursor = createOutputWalStartCursor(this.walPath);
      }
      const checkpointOffset = checkpoint?.cursor.walOffset ?? 0;
      let checkpointVerified = checkpoint === null;
      const verifyBoundary = () => {
        if (!checkpoint || checkpointVerified)
          return;
        if (this.lastOffset !== checkpointOffset)
          return;
        if (this.lastSequence !== BigInt(checkpoint.cursor.sequence)) {
          throw new Error(`replayed sequence ${this.lastSequence} differs from checkpoint ${checkpoint.cursor.sequence}`);
        }
        this.history.finishVerification();
        assertCheckpointSnapshot(checkpoint, this.engine.snapshot());
        checkpointVerified = true;
      };
      verifyBoundary();
      while (!checkpointVerified) {
        if (!this.tailCursor) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        const remaining = checkpointOffset - this.lastOffset;
        if (remaining <= 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
        }
        const batch = readOutputWalTail(this.walPath, this.tailCursor, {
          maxFrameBytes: Math.min(this.maxWalFrameBytesPerRefresh, remaining)
        });
        if (batch.records.length === 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        for (const record of batch.records) {
          if (record.offset !== this.lastOffset) {
            throw new Error(`recovery WAL record begins at ${record.offset}, expected ${this.lastOffset}`);
          }
          if (record.nextOffset > checkpointOffset) {
            throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
          }
          this.engine.process(record, (captured) => this.history.accept(captured, "verify"));
          this.lastOffset = record.nextOffset;
          this.lastSequence = record.sequence;
          this.lastAt = record.at;
        }
        if (batch.cursor.offset !== this.lastOffset || batch.cursor.lastSequence !== this.lastSequence || batch.cursor.lastAt !== this.lastAt) {
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
        this.hasMoreWal = this.peekTailHasMore();
      } else {
        this.consumeTail();
      }
      this.result = this.commitCheckpoint();
    } catch (error) {
      try {
        this.history.close();
      } finally {
        try {
          this.tmux.close();
        } finally {
          this.writerLease.release();
        }
      }
      this.closed = true;
      throw error;
    }
  }
  commitCheckpoint() {
    const snapshot = this.engine.snapshot();
    this.history.flush();
    const nextCheckpoint = {
      version: 1,
      walPath: this.walPath,
      cursor: {
        walOffset: this.lastOffset,
        sequence: this.lastSequence.toString()
      },
      historyBytes: this.history.bytes,
      lifecycle: snapshot.lifecycle,
      identity: snapshot.identity,
      geometry: snapshot.geometry,
      pendingResize: snapshot.pendingResize,
      screen: snapshot.screen
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
      checkpointPath: this.checkpointPath
    };
  }
  get current() {
    return this.result;
  }
  get privateSocketPath() {
    return this.tmux.socketPath;
  }
  get privateMirrorPath() {
    return this.tmux.boundedMirrorPath;
  }
  get privatePeakMirrorBytes() {
    return this.tmux.peakBoundedMirrorBytes;
  }
  peekTailHasMore() {
    if (!this.tailCursor || !existsSync3(this.walPath))
      return false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxRecords: 1,
      maxFrameBytes: this.maxWalFrameBytesPerRefresh
    });
    return batch.records.length > 0 || batch.hasMore;
  }
  consumeTail() {
    if (!this.tailCursor) {
      if (!existsSync3(this.walPath)) {
        this.hasMoreWal = false;
        return false;
      }
      this.tailCursor = createOutputWalStartCursor(this.walPath);
    }
    const targetRemaining = this.recoveryTarget ? this.recoveryTarget.walOffset - this.lastOffset : null;
    if (targetRemaining !== null && targetRemaining <= 0) {
      if (this.lastOffset !== this.recoveryTarget.walOffset || this.lastSequence !== this.recoveryTarget.sequence)
        throw new Error("terminal replay recovery target is not an exact WAL cursor");
      this.recoveryTarget = null;
      this.hasMoreWal = this.peekTailHasMore();
      return false;
    }
    let changed = false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxFrameBytes: targetRemaining === null ? this.maxWalFrameBytesPerRefresh : Math.min(this.maxWalFrameBytesPerRefresh, targetRemaining),
      ...this.engine.hasPendingResize ? { maxRecords: 1 } : {}
    });
    for (const record of batch.records) {
      if (record.offset !== this.lastOffset) {
        throw new Error(`incremental WAL record begins at ${record.offset}, expected ${this.lastOffset}`);
      }
      if (this.recoveryTarget && record.nextOffset > this.recoveryTarget.walOffset) {
        throw new Error("terminal replay recovery target is not a record boundary");
      }
      this.engine.process(record, (captured) => this.history.accept(captured, "append"));
      this.lastOffset = record.nextOffset;
      this.lastSequence = record.sequence;
      this.lastAt = record.at;
      changed = true;
    }
    if (batch.cursor.offset !== this.lastOffset || batch.cursor.lastSequence !== this.lastSequence || batch.cursor.lastAt !== this.lastAt) {
      throw new Error("incremental WAL cursor diverged from processed records");
    }
    this.tailCursor = batch.cursor;
    if (this.recoveryTarget && this.lastOffset === this.recoveryTarget.walOffset) {
      if (this.lastSequence !== this.recoveryTarget.sequence) {
        throw new Error("terminal replay recovery target sequence does not match its WAL offset");
      }
      this.recoveryTarget = null;
    }
    if (this.recoveryTarget && batch.records.length === 0) {
      throw new Error("terminal replay recovery target is beyond the readable WAL");
    }
    this.hasMoreWal = batch.hasMore || this.peekTailHasMore();
    return changed;
  }
  refresh() {
    if (this.closed)
      throw new Error("terminal replay session is closed");
    try {
      const previousHasMoreWal = this.hasMoreWal;
      const changed = this.consumeTail();
      if (changed || previousHasMoreWal !== this.hasMoreWal) {
        this.result = this.commitCheckpoint();
      }
      return this.result;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    try {
      this.history.close();
    } finally {
      try {
        this.tmux.close();
      } finally {
        this.writerLease.release();
      }
    }
  }
}

// src/integrations/terminal-replay-worker.ts
var TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION = 1;
var DEFAULT_REQUEST_TIMEOUT_MS2 = 10 * 60000;
var DEFAULT_SHUTDOWN_GRACE_MS = 5000;
var DEFAULT_MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
var MAX_RESPONSE_FRAME_BYTES = 512 * 1024 * 1024;
var MAX_REQUEST_FRAME_BYTES = 1024 * 1024;
var MAX_REQUEST_TIMEOUT_MS = 30 * 60000;
var MAX_SHUTDOWN_GRACE_MS = 60000;
var MAX_PATH_BYTES = 4096;
var MAX_STRING_BYTES = 16384;
var MAX_ERROR_BYTES = 8192;
var MAX_STDERR_TAIL_BYTES = 16384;
var MAX_UINT64 = (1n << 64n) - 1n;

class TerminalReplayWorkerError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "TerminalReplayWorkerError";
    this.code = code;
  }
}
function isPlainObject2(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys2(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label}.${key} is not allowed`);
  }
}
function boundedString(value, label, maximumBytes = MAX_STRING_BYTES, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes || value.includes("\x00")) {
    throw new Error(`${label} exceeds its byte bound or contains NUL`);
  }
  return value;
}
function boundedInteger2(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}
function booleanValue(value, label) {
  if (typeof value !== "boolean")
    throw new Error(`${label} must be boolean`);
  return value;
}
function parseGeometry2(value, label) {
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  exactKeys2(value, ["cols", "rows"], [], label);
  const cols = boundedInteger2(value.cols, `${label}.cols`, 1, 4096);
  const rows = boundedInteger2(value.rows, `${label}.rows`, 1, 4096);
  if (cols * rows > 4194304)
    throw new Error(`${label} exceeds the cell bound`);
  return { cols, rows };
}
function parseIdentity3(value, label) {
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  const required = [
    "session",
    "instanceId",
    "paneTarget",
    "tmuxServerPid",
    "sessionCreated"
  ];
  const optional = ["sessionId", "windowId", "paneId", "generation"];
  exactKeys2(value, required, optional, label);
  const result = {
    session: boundedString(value.session, `${label}.session`),
    instanceId: boundedString(value.instanceId, `${label}.instanceId`),
    paneTarget: boundedString(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: boundedInteger2(value.tmuxServerPid, `${label}.tmuxServerPid`, 1, Number.MAX_SAFE_INTEGER),
    sessionCreated: boundedInteger2(value.sessionCreated, `${label}.sessionCreated`, 0, Number.MAX_SAFE_INTEGER)
  };
  for (const key of optional) {
    if (value[key] !== undefined)
      result[key] = boundedString(value[key], `${label}.${key}`);
  }
  return result;
}
function parseResize2(value, label) {
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  exactKeys2(value, ["phase", "changeId", "from", "to"], ["reason"], label);
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error(`${label}.phase is invalid`);
  }
  return {
    phase: value.phase,
    changeId: boundedString(value.changeId, `${label}.changeId`),
    from: parseGeometry2(value.from, `${label}.from`),
    to: parseGeometry2(value.to, `${label}.to`),
    ...value.reason === undefined ? {} : { reason: boundedString(value.reason, `${label}.reason`, MAX_STRING_BYTES, true) }
  };
}
function parseBase64(value, label) {
  const encoded = boundedString(value, label, MAX_RESPONSE_FRAME_BYTES, true);
  if (encoded.length % 4 !== 0 || encoded.length > 0 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${label} must be canonical base64`);
  }
  return encoded;
}
function parseScreen2(value, label) {
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  exactKeys2(value, [
    "cols",
    "rows",
    "cursorX",
    "cursorY",
    "cursorVisible",
    "alternateOn",
    "mouseSgr",
    "mouseAny",
    "cellsBase64",
    "pendingEscapeBase64"
  ], [], label);
  const geometry = parseGeometry2({ cols: value.cols, rows: value.rows }, label);
  const cursorX = boundedInteger2(value.cursorX, `${label}.cursorX`, 0, geometry.cols - 1);
  const cursorY = boundedInteger2(value.cursorY, `${label}.cursorY`, 0, geometry.rows - 1);
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: booleanValue(value.cursorVisible, `${label}.cursorVisible`),
    alternateOn: booleanValue(value.alternateOn, `${label}.alternateOn`),
    mouseSgr: booleanValue(value.mouseSgr, `${label}.mouseSgr`),
    mouseAny: booleanValue(value.mouseAny, `${label}.mouseAny`),
    cellsBase64: parseBase64(value.cellsBase64, `${label}.cellsBase64`),
    pendingEscapeBase64: parseBase64(value.pendingEscapeBase64, `${label}.pendingEscapeBase64`)
  };
}
function parseNullable(value, parser, label) {
  return value === null ? null : parser(value, label);
}
function parseUint64Decimal(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal uint64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64)
    throw new Error(`${label} exceeds uint64`);
  return parsed;
}
function terminalReplayResultToWire(result) {
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
    checkpointPath: result.checkpointPath
  };
}
function terminalReplayResultFromWire(value) {
  const label = "terminal replay worker result";
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  exactKeys2(value, [
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
    "checkpointPath"
  ], [], label);
  const geometry = parseNullable(value.geometry, parseGeometry2, `${label}.geometry`);
  const screen = parseNullable(value.screen, parseScreen2, `${label}.screen`);
  if (geometry && screen && (geometry.cols !== screen.cols || geometry.rows !== screen.rows)) {
    throw new Error(`${label}.screen geometry differs from result geometry`);
  }
  return {
    complete: booleanValue(value.complete, `${label}.complete`),
    verified: booleanValue(value.verified, `${label}.verified`),
    recoveredFromCheckpoint: booleanValue(value.recoveredFromCheckpoint, `${label}.recoveredFromCheckpoint`),
    ended: booleanValue(value.ended, `${label}.ended`),
    walOffset: boundedInteger2(value.walOffset, `${label}.walOffset`, 0, Number.MAX_SAFE_INTEGER),
    sequence: parseUint64Decimal(value.sequence, `${label}.sequence`),
    hasMoreWal: booleanValue(value.hasMoreWal, `${label}.hasMoreWal`),
    historyBytes: boundedInteger2(value.historyBytes, `${label}.historyBytes`, 0, Number.MAX_SAFE_INTEGER),
    identity: parseNullable(value.identity, parseIdentity3, `${label}.identity`),
    geometry,
    pendingResize: parseNullable(value.pendingResize, parseResize2, `${label}.pendingResize`),
    screen,
    historyPath: boundedString(value.historyPath, `${label}.historyPath`, MAX_PATH_BYTES),
    checkpointPath: boundedString(value.checkpointPath, `${label}.checkpointPath`, MAX_PATH_BYTES)
  };
}
function normalizeMaterializerOptions(value) {
  const label = "terminal replay materializer options";
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
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
    "recoverySequence",
    "recoveryWalOffset"
  ];
  exactKeys2(value, ["walPath", "stateDir"], optional, label);
  const path = (key) => resolve4(boundedString(value[key], `${label}.${key}`, MAX_PATH_BYTES));
  const normalized = {
    walPath: path("walPath"),
    stateDir: path("stateDir")
  };
  if (value.historyPath !== undefined)
    normalized.historyPath = path("historyPath");
  if (value.checkpointPath !== undefined)
    normalized.checkpointPath = path("checkpointPath");
  if (value.tmuxCommand !== undefined) {
    normalized.tmuxCommand = boundedString(value.tmuxCommand, `${label}.tmuxCommand`, MAX_PATH_BYTES);
  }
  if (value.socketPath !== undefined) {
    const socketPath = boundedString(value.socketPath, `${label}.socketPath`, MAX_PATH_BYTES);
    if (!isAbsolute4(socketPath))
      throw new Error(`${label}.socketPath must be absolute`);
    normalized.socketPath = resolve4(socketPath);
  }
  if (value.replayChunkBytes !== undefined) {
    normalized.replayChunkBytes = boundedInteger2(value.replayChunkBytes, `${label}.replayChunkBytes`, 1, 16 * 1024 * 1024);
  }
  if (value.historyCaptureRows !== undefined) {
    normalized.historyCaptureRows = boundedInteger2(value.historyCaptureRows, `${label}.historyCaptureRows`, 1, 1e6);
  }
  if (value.historyLimit !== undefined) {
    normalized.historyLimit = boundedInteger2(value.historyLimit, `${label}.historyLimit`, 4097, 1e7);
  }
  if (value.commandTimeoutMs !== undefined) {
    normalized.commandTimeoutMs = boundedInteger2(value.commandTimeoutMs, `${label}.commandTimeoutMs`, 1, MAX_REQUEST_TIMEOUT_MS);
  }
  if (value.maxWalFrameBytesPerRefresh !== undefined) {
    normalized.maxWalFrameBytesPerRefresh = boundedInteger2(value.maxWalFrameBytesPerRefresh, `${label}.maxWalFrameBytesPerRefresh`, 1, 256 * 1024 * 1024);
  }
  if (value.recoverySequence === undefined !== (value.recoveryWalOffset === undefined)) {
    throw new Error(`${label}.recoverySequence and recoveryWalOffset must be supplied together`);
  }
  if (value.recoverySequence !== undefined && value.recoveryWalOffset !== undefined) {
    const recoverySequence = boundedString(value.recoverySequence, `${label}.recoverySequence`, 20);
    if (!/^[1-9]\d*$/.test(recoverySequence) || BigInt(recoverySequence) > MAX_UINT64) {
      throw new Error(`${label}.recoverySequence must be a positive uint64 decimal`);
    }
    normalized.recoverySequence = recoverySequence;
    normalized.recoveryWalOffset = boundedInteger2(value.recoveryWalOffset, `${label}.recoveryWalOffset`, 1, Number.MAX_SAFE_INTEGER);
  }
  return normalized;
}
function resolveTerminalReplayWorkerPath(value) {
  let workerPath;
  if (value instanceof URL) {
    if (value.protocol !== "file:")
      throw new Error("workerPath URL must use file:");
    workerPath = fileURLToPath2(value);
  } else if (value !== undefined) {
    workerPath = resolve4(boundedString(value, "workerPath", MAX_PATH_BYTES));
  } else {
    const candidates = [
      fileURLToPath2(new URL("./terminal-replay-worker-entry.js", import.meta.url)),
      fileURLToPath2(new URL("../terminal-replay-worker-entry.ts", import.meta.url))
    ];
    workerPath = candidates.find((candidate) => existsSync4(candidate)) ?? candidates[0];
  }
  if (!existsSync4(workerPath)) {
    throw new Error(`terminal replay worker does not exist: ${workerPath}`);
  }
  return workerPath;
}
function normalizeClientOptions(value) {
  if (!isPlainObject2(value))
    throw new Error("terminal replay worker client options must be an object");
  exactKeys2(value, ["materializer"], [
    "runtimePath",
    "workerPath",
    "requestTimeoutMs",
    "shutdownGraceMs",
    "maxResponseFrameBytes"
  ], "terminal replay worker client options");
  const runtimePath = resolve4(boundedString(value.runtimePath ?? process.execPath, "runtimePath", MAX_PATH_BYTES));
  const workerPath = resolveTerminalReplayWorkerPath(value.workerPath);
  if (!existsSync4(runtimePath))
    throw new Error(`terminal replay runtime does not exist: ${runtimePath}`);
  return {
    materializer: normalizeMaterializerOptions(value.materializer),
    runtimePath,
    workerPath,
    requestTimeoutMs: boundedInteger2(value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS2, "requestTimeoutMs", 10, MAX_REQUEST_TIMEOUT_MS),
    shutdownGraceMs: boundedInteger2(value.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs", 10, MAX_SHUTDOWN_GRACE_MS),
    maxResponseFrameBytes: boundedInteger2(value.maxResponseFrameBytes ?? DEFAULT_MAX_RESPONSE_FRAME_BYTES, "maxResponseFrameBytes", 1024, MAX_RESPONSE_FRAME_BYTES)
  };
}
function encodeJsonFrame(value, maximumBytes, label) {
  let encoded;
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
  maximumBytes;
  header = Buffer.allocUnsafe(4);
  headerBytes = 0;
  frameBytes = -1;
  received = 0;
  chunks = [];
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
  }
  push(chunkValue, onFrame) {
    const chunk = Buffer.from(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength);
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.frameBytes < 0) {
        const take2 = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take2);
        this.headerBytes += take2;
        offset += take2;
        if (this.headerBytes < 4)
          continue;
        this.frameBytes = this.header.readUInt32BE(0);
        this.headerBytes = 0;
        if (this.frameBytes === 0 || this.frameBytes > this.maximumBytes) {
          throw new Error(`IPC frame length ${this.frameBytes} is outside 1..${this.maximumBytes}`);
        }
      }
      const take = Math.min(this.frameBytes - this.received, chunk.byteLength - offset);
      this.chunks.push(chunk.subarray(offset, offset + take));
      this.received += take;
      offset += take;
      if (this.received !== this.frameBytes)
        continue;
      const frame = this.chunks.length === 1 ? Buffer.from(this.chunks[0]) : Buffer.concat(this.chunks, this.frameBytes);
      this.frameBytes = -1;
      this.received = 0;
      this.chunks = [];
      onFrame(frame);
    }
  }
  finish() {
    if (this.headerBytes !== 0 || this.frameBytes >= 0) {
      throw new Error("IPC stream ended in the middle of a frame");
    }
  }
}
var fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
function decodeJson(frame, label) {
  try {
    return JSON.parse(fatalUtf8Decoder.decode(frame));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}
function parseRequest(value) {
  const label = "terminal replay worker request";
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`${label}.id has invalid characters`);
  if (value.command === "open") {
    exactKeys2(value, [
      "protocol",
      "id",
      "command",
      "materializer",
      "maxResponseFrameBytes"
    ], [], label);
    return {
      protocol: 1,
      id,
      command: "open",
      materializer: normalizeMaterializerOptions(value.materializer),
      maxResponseFrameBytes: boundedInteger2(value.maxResponseFrameBytes, `${label}.maxResponseFrameBytes`, 1024, MAX_RESPONSE_FRAME_BYTES)
    };
  }
  if (value.command !== "current" && value.command !== "refresh" && value.command !== "close") {
    throw new Error(`${label}.command is invalid`);
  }
  exactKeys2(value, ["protocol", "id", "command"], [], label);
  return { protocol: 1, id, command: value.command };
}
function parseResponse(value) {
  const label = "terminal replay worker response";
  if (!isPlainObject2(value))
    throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`${label}.id has invalid characters`);
  if (value.ok === true) {
    exactKeys2(value, ["protocol", "id", "ok"], ["result"], label);
    return {
      protocol: 1,
      id,
      ok: true,
      ...value.result === undefined ? {} : { result: terminalReplayResultToWire(terminalReplayResultFromWire(value.result)) }
    };
  }
  if (value.ok !== false)
    throw new Error(`${label}.ok must be boolean`);
  exactKeys2(value, ["protocol", "id", "ok", "error"], [], label);
  if (!isPlainObject2(value.error))
    throw new Error(`${label}.error must be an object`);
  exactKeys2(value.error, ["code", "message"], [], `${label}.error`);
  const code = boundedString(value.error.code, `${label}.error.code`, 64);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code))
    throw new Error(`${label}.error.code is invalid`);
  return {
    protocol: 1,
    id,
    ok: false,
    error: {
      code,
      message: boundedString(value.error.message, `${label}.error.message`, MAX_ERROR_BYTES, true)
    }
  };
}
function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message, "utf8");
  return encoded.byteLength <= MAX_ERROR_BYTES ? message : encoded.subarray(0, MAX_ERROR_BYTES).toString("utf8");
}
async function writeJsonFrame(stream, value, maximumBytes, label) {
  const frame = encodeJsonFrame(value, maximumBytes, label);
  await new Promise((resolveWrite, rejectWrite) => {
    stream.write(frame, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}
async function runTerminalReplayWorkerStdio(input = process.stdin, output = process.stdout) {
  const decoder = new JsonFrameDecoder(MAX_REQUEST_FRAME_BYTES);
  let session = null;
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
      const frames = [];
      decoder.push(chunk, (frame) => frames.push(frame));
      for (const frame of frames) {
        const request = parseRequest(decodeJson(frame, "terminal replay worker request"));
        if (request.command === "open") {
          if (opened) {
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "INVALID_STATE", message: "replay worker is already open" }
            }, maxResponseFrameBytes, "terminal replay worker response");
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
              result: terminalReplayResultToWire(session.current)
            };
            await writeJsonFrame(output, response, maxResponseFrameBytes, "terminal replay worker response");
          } catch (error) {
            if (session)
              session.close();
            session = null;
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "OPEN_FAILED", message: errorMessage(error) }
            }, maxResponseFrameBytes, "terminal replay worker response");
            return 1;
          }
          continue;
        }
        if (!opened || !session) {
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "INVALID_STATE", message: "replay worker is not open" }
          }, maxResponseFrameBytes, "terminal replay worker response");
          continue;
        }
        if (request.command === "close") {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true
          }, maxResponseFrameBytes, "terminal replay worker response");
          return 0;
        }
        try {
          const result = request.command === "refresh" ? session.refresh() : session.current;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true,
            result: terminalReplayResultToWire(result)
          }, maxResponseFrameBytes, "terminal replay worker response");
        } catch (error) {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "MATERIALIZER_FAILED", message: errorMessage(error) }
          }, maxResponseFrameBytes, "terminal replay worker response");
          return 1;
        }
      }
    }
    if (!signalReceived)
      decoder.finish();
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (session)
      session.close();
  }
}

class ProcessTerminalReplayWorkerClient {
  child;
  options;
  decoder;
  pending = new Map;
  nextId = 1n;
  latestResult = null;
  terminalError = null;
  stdoutEnded = false;
  exited = false;
  terminating = false;
  closing = false;
  closePromise = null;
  queue = Promise.resolve();
  stderrTail = Buffer.alloc(0);
  exitPromise;
  resolveExit;
  constructor(options) {
    this.options = options;
    this.decoder = new JsonFrameDecoder(options.maxResponseFrameBytes);
    this.child = spawn2(options.runtimePath, [options.workerPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    this.attachProcessListeners();
  }
  get pid() {
    if (this.child.pid === undefined)
      throw new Error("terminal replay worker has no PID");
    return this.child.pid;
  }
  get closed() {
    return this.closing || this.exited;
  }
  get lastResult() {
    if (!this.latestResult)
      throw new Error("terminal replay worker has not opened");
    return this.latestResult;
  }
  diagnosticSuffix() {
    const stderr = this.stderrTail.toString("utf8").trim();
    return stderr.length === 0 ? "" : `; stderr: ${stderr}`;
  }
  attachProcessListeners() {
    this.child.stdout.on("data", (chunk) => {
      if (this.terminalError)
        return;
      try {
        this.decoder.push(chunk, (frame) => this.handleResponseFrame(frame));
      } catch (error) {
        this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `invalid replay worker stdout: ${errorMessage(error)}`, { cause: error }));
      }
    });
    this.child.stdout.on("end", () => {
      this.stdoutEnded = true;
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `replay worker stdout ended mid-frame: ${errorMessage(error)}`, { cause: error }));
        return;
      }
      if (!this.closing && !this.exited) {
        this.fail(new TerminalReplayWorkerError("UNEXPECTED_EOF", `replay worker stdout closed unexpectedly${this.diagnosticSuffix()}`));
      }
    });
    this.child.stderr.on("data", (chunk) => {
      const combined = Buffer.concat([this.stderrTail, chunk]);
      this.stderrTail = combined.byteLength <= MAX_STDERR_TAIL_BYTES ? combined : combined.subarray(combined.byteLength - MAX_STDERR_TAIL_BYTES);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) {
        this.fail(new TerminalReplayWorkerError("IPC_WRITE_FAILED", `cannot write to replay worker: ${error.message}`, { cause: error }));
      }
    });
    this.child.on("error", (error) => {
      this.fail(new TerminalReplayWorkerError("SPAWN_FAILED", `cannot start replay worker: ${error.message}`, { cause: error }));
    });
    const markExited = (code, signal) => {
      if (this.exited)
        return;
      this.exited = true;
      this.resolveExit();
      if (!this.closing && !this.terminalError) {
        this.fail(new TerminalReplayWorkerError("WORKER_EXITED", `replay worker exited with code ${String(code)} signal ${String(signal)}${this.diagnosticSuffix()}`));
      }
    };
    this.child.on("exit", markExited);
    this.child.on("close", markExited);
  }
  handleResponseFrame(frame) {
    let response;
    try {
      response = parseResponse(decodeJson(frame, "terminal replay worker response"));
    } catch (error) {
      throw new Error(errorMessage(error), { cause: error });
    }
    const pending = this.pending.get(response.id);
    if (!pending)
      throw new Error(`response has unknown or duplicate id ${response.id}`);
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (!response.ok) {
      pending.reject(new TerminalReplayWorkerError(response.error.code, response.error.message));
      return;
    }
    const expectsResult = pending.command !== "close";
    if (expectsResult !== (response.result !== undefined)) {
      pending.reject(new TerminalReplayWorkerError("PROTOCOL_ERROR", `response for ${pending.command} ${expectsResult ? "has no result" : "has an unexpected result"}`));
      this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `response shape does not match ${pending.command}`));
      return;
    }
    const result = response.result === undefined ? undefined : terminalReplayResultFromWire(response.result);
    if (result)
      this.latestResult = result;
    pending.resolve(result);
  }
  fail(error) {
    if (this.terminalError)
      return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.beginTerminate();
  }
  beginTerminate() {
    if (this.exited || this.terminating)
      return;
    this.terminating = true;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
    }, this.options.shutdownGraceMs);
    timer.unref?.();
  }
  send(command) {
    if (this.terminalError)
      return Promise.reject(this.terminalError);
    if (this.exited || this.stdoutEnded) {
      return Promise.reject(new TerminalReplayWorkerError("WORKER_EXITED", `replay worker is not running${this.diagnosticSuffix()}`));
    }
    const id = `r${this.nextId.toString(36)}`;
    this.nextId += 1n;
    const request = command === "open" ? {
      protocol: 1,
      id,
      command,
      materializer: this.options.materializer,
      maxResponseFrameBytes: this.options.maxResponseFrameBytes
    } : { protocol: 1, id, command };
    const frame = encodeJsonFrame(request, MAX_REQUEST_FRAME_BYTES, "terminal replay worker request");
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id))
          return;
        const error = new TerminalReplayWorkerError("REQUEST_TIMEOUT", `replay worker ${command} timed out after ${this.options.requestTimeoutMs}ms`);
        rejectRequest(error);
        this.fail(error);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        command,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest
      });
      this.child.stdin.write(frame, (error) => {
        if (!error)
          return;
        const failure = new TerminalReplayWorkerError("IPC_WRITE_FAILED", `cannot write ${command} to replay worker: ${error.message}`, { cause: error });
        this.fail(failure);
      });
    });
  }
  enqueue(command) {
    if (this.closing) {
      return Promise.reject(new TerminalReplayWorkerError("CLIENT_CLOSED", "replay worker is closed"));
    }
    const operation = this.queue.then(async () => {
      const result = await this.send(command);
      if (!result)
        throw new Error(`replay worker ${command} returned no result`);
      return result;
    });
    this.queue = operation.then(() => {
      return;
    }, () => {
      return;
    });
    return operation;
  }
  async open() {
    try {
      const result = await this.send("open");
      if (!result) {
        throw new TerminalReplayWorkerError("PROTOCOL_ERROR", "open returned no result");
      }
      this.latestResult = result;
    } catch (error) {
      this.fail(error instanceof TerminalReplayWorkerError ? error : new TerminalReplayWorkerError("OPEN_FAILED", errorMessage(error), { cause: error }));
      throw error;
    }
  }
  current() {
    return this.enqueue("current");
  }
  refresh() {
    return this.enqueue("refresh");
  }
  close() {
    if (this.closePromise)
      return this.closePromise;
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
        const timeout = new Promise((resolveTimeout) => {
          const timer = setTimeout(() => {
            this.beginTerminate();
            resolveTimeout();
          }, this.options.shutdownGraceMs);
          timer.unref?.();
        });
        await Promise.race([this.exitPromise, timeout]);
        if (!this.exited) {
          try {
            this.child.kill("SIGKILL");
          } catch {}
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
async function createTerminalReplayWorkerClient(options) {
  const client = new ProcessTerminalReplayWorkerClient(normalizeClientOptions(options));
  try {
    await client.open();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

// src/ws-mux.ts
import {
  chooseMuxOutputFrame,
  muxHistoryBoundaryTransition,
  splitMuxOutputData,
  validateMuxHistoryBoundary
} from "../core/index.js";
var muxTimeHooks = null;
function installMuxTimeHooksForTests(hooks) {
  const previous = muxTimeHooks;
  muxTimeHooks = hooks;
  return () => {
    muxTimeHooks = previous;
  };
}
function muxNowMs() {
  return muxTimeHooks?.clock() ?? Date.now();
}
function muxArmTimeout(fn, ms) {
  if (muxTimeHooks)
    return muxTimeHooks.setTimeout(fn, ms);
  return setTimeout(fn, ms);
}
function muxDisarmTimeout(handle) {
  if (muxTimeHooks) {
    muxTimeHooks.clearTimeout(handle);
    return;
  }
  clearTimeout(handle);
}
var DEFAULT_PROFILE = { resize: true, currentPaneOnly: false, archive: true };
var EMPTY_HISTORY_PAGE = { lines: [], startLine: null, hasMore: false };

class TmuxWsMux {
  compressFrames = false;
  wsSend(ws, data) {
    if (this.compressFrames)
      return ws.send(data, true);
    return ws.send(data);
  }
  driver;
  pipes;
  archive;
  hooks;
  profileOf;
  liveLineLimit;
  POLL_NORMAL;
  POLL_BURST;
  BURST_DURATION;
  SESSION_LIST_INTERVAL;
  PIPE_RECONCILE_INTERVAL;
  POLL_RECONCILE;
  INITIAL_CAPTURE_START_LINE;
  DEFAULT_CAPTURE_START_LINE;
  log;
  logError;
  subscribers = new Map;
  sessionListSubscribers = new Set;
  sessionListClients = new Map;
  contents = new Map;
  hashes = new Map;
  lastActivity = new Map;
  interval = null;
  sessionListInterval = null;
  lastSessionsJson = "";
  inFlight = false;
  currentRate;
  burstTimer = null;
  piped = new Set;
  immediateCaptureTimers = new Map;
  queuedCapturesInFlight = new Set;
  queuedCapturesPending = new Set;
  queuedCapturesFullHistory = new Set;
  queuedCaptureTails = new Map;
  fullHistoryCaptureOwners = new WeakSet;
  captureStartLines = new Map;
  archiveSeeded = new Set;
  pendingArchiveReflows = new Map;
  geometryGenerations = new Map;
  geometryGeneration = 0;
  lastReconcileCapture = new Map;
  lastAppliedGeometry = new Map;
  sessionListProvider;
  tails = new Map;
  deltaSubscribers = new Map;
  outputBases = new Map;
  pendingOutputFulls = new Map;
  pendingOutputResets = new Map;
  lastCursor = new Map;
  lastScreen = new Map;
  lastBoundary = new Map;
  pipeDebounceTimers = new Map;
  pipeMaxTimers = new Map;
  pollCounter = 0;
  bpEnabled;
  bpMaxBufferedBytes;
  bpMaxBlockedMs;
  bpBufferedAmount;
  bpClose;
  blockedSockets = new Map;
  shedSockets = new Set;
  owedSessionList = new Set;
  blockedTimeouts = new Map;
  constructor(opts) {
    this.compressFrames = opts.compressFrames === true;
    this.driver = opts.driver;
    this.pipes = opts.pipes ?? null;
    this.archive = opts.archive ?? null;
    this.hooks = opts.hooks ?? {};
    this.profileOf = opts.profile ?? (() => DEFAULT_PROFILE);
    this.liveLineLimit = opts.liveLineLimit ?? 2000;
    this.POLL_NORMAL = opts.pollNormalMs ?? 250;
    this.POLL_BURST = opts.pollBurstMs ?? 100;
    this.BURST_DURATION = opts.burstDurationMs ?? 5000;
    this.SESSION_LIST_INTERVAL = opts.sessionListIntervalMs ?? 5000;
    this.PIPE_RECONCILE_INTERVAL = opts.pipeReconcileMs ?? 1e4;
    this.POLL_RECONCILE = opts.pollReconcileMs ?? 3000;
    this.INITIAL_CAPTURE_START_LINE = -Math.min(250, this.liveLineLimit);
    this.DEFAULT_CAPTURE_START_LINE = -this.liveLineLimit;
    this.currentRate = this.POLL_NORMAL;
    this.log = opts.log ?? (() => {});
    this.logError = opts.logError ?? console.error;
    this.sessionListProvider = () => this.driver.listSessions();
    const bp = opts.backpressure ?? {};
    this.bpEnabled = bp.enabled !== false;
    this.bpMaxBufferedBytes = bp.maxBufferedBytes ?? 8 * 1024 * 1024;
    this.bpMaxBlockedMs = bp.maxBlockedMs ?? 30000;
    this.bpBufferedAmount = bp.bufferedAmount;
    this.bpClose = bp.close;
  }
  setSessionListProvider(provider) {
    this.sessionListProvider = provider ?? (() => this.driver.listSessions());
    this.lastSessionsJson = "";
  }
  subscribe(session, ws, client, opts = {}) {
    this.hooks.onSubscribe?.(session, ws, client);
    if (this.hooks.canSubscribe?.(session, ws, client) === false)
      return;
    let set = this.subscribers.get(session);
    if (!set) {
      set = new Set;
      this.subscribers.set(session, set);
    }
    set.add(ws);
    if (opts.tail && opts.tail > 0) {
      let t = this.tails.get(session);
      if (!t) {
        t = new Map;
        this.tails.set(session, t);
      }
      t.set(ws, Math.floor(opts.tail));
    } else {
      this.tails.get(session)?.delete(ws);
    }
    this.setDeltaSubscription(session, ws, opts.delta === true);
    this.invalidateOutputBase(session, ws);
    this.requireFullOutput(session, ws);
    const profile = this.profileOf(session);
    const cachedContent = this.contents.get(session);
    const resizeCapturePending = this.pendingArchiveReflows.has(session);
    if (resizeCapturePending) {
      this.requireResetOutput(session, ws, "resize");
    }
    if (cachedContent !== undefined && !resizeCapturePending) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null,
        ...this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}
      });
      this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
    } else if (!resizeCapturePending) {
      const startLine = this.archiveSeeded.has(session) ? this.DEFAULT_CAPTURE_START_LINE : this.INITIAL_CAPTURE_START_LINE;
      this.captureStartLines.set(session, startLine);
    }
    const wantsArchive = profile.archive && !this.archiveSeeded.has(session) && !(opts.tail && opts.tail > 0);
    this.queueCapture(session, { fullHistory: wantsArchive });
    this.ensurePolling();
    this.refreshSessionListSchedule();
    if (!this.piped.has(session)) {
      this.tryStartPipe(session);
    }
  }
  unsubscribe(session, ws, client) {
    this.hooks.onUnsubscribe?.(session, ws, client);
    this.tails.get(session)?.delete(ws);
    this.forgetOutputViewer(session, ws);
    const set = this.subscribers.get(session);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }
  unsubscribeAll(ws) {
    this.hooks.onSocketClose?.(ws);
    this.sessionListSubscribers.delete(ws);
    this.sessionListClients.delete(ws);
    for (const t of this.tails.values())
      t.delete(ws);
    this.forgetOutputSocket(ws);
    this.clearBackpressureState(ws);
    for (const [session, set] of this.subscribers) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }
  isBackpressured(ws) {
    return this.blockedSockets.has(ws);
  }
  handleDrain(ws) {
    if (this.shedSockets.has(ws))
      return;
    if (this.blockedSockets.has(ws)) {
      this.resumeBlockedSocket(ws, this.readBufferedAmount(ws));
      for (const [session, viewers] of this.subscribers) {
        if (!viewers.has(ws))
          continue;
        const pendingFull = this.pendingOutputFulls.get(session)?.has(ws) === true;
        const pendingReset = this.pendingOutputResets.get(session)?.has(ws) === true;
        if (!pendingFull && !pendingReset)
          continue;
        const cached = this.contents.get(session);
        if (cached === undefined)
          continue;
        this.sendOutputFrame(session, ws, {
          channel: session,
          type: "output",
          data: this.contentFor(session, ws, cached),
          cursor: this.lastCursor.get(session) ?? null,
          ...this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}
        });
        if (this.blockedSockets.has(ws) || this.shedSockets.has(ws))
          break;
      }
    }
    this.settleSessionListDebt(ws);
  }
  resumeBlockedSocket(ws, bufferedBytes) {
    if (this.shedSockets.has(ws))
      return false;
    const blocked = this.blockedSockets.get(ws);
    if (!blocked)
      return false;
    const blockedMs = muxNowMs() - blocked.since;
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.hooks.onBackpressure?.(ws, "drained", {
      blockedMs,
      bufferedBytes
    });
    return true;
  }
  settleSessionListDebt(ws) {
    if (this.owedSessionList.has(ws) && !this.blockedSockets.has(ws) && !this.shedSockets.has(ws)) {
      this.owedSessionList.delete(ws);
      this.pushSessionListTo(ws);
    }
  }
  clearBackpressureState(ws) {
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.shedSockets.delete(ws);
    this.owedSessionList.delete(ws);
  }
  clearBlockedTimeout(ws) {
    const timer = this.blockedTimeouts.get(ws);
    if (timer !== undefined)
      muxDisarmTimeout(timer);
    this.blockedTimeouts.delete(ws);
  }
  armBlockedTimeout(ws) {
    this.clearBlockedTimeout(ws);
    if (!this.bpEnabled)
      return;
    if (!(this.bpMaxBlockedMs > 0) || !Number.isFinite(this.bpMaxBlockedMs))
      return;
    const timer = muxArmTimeout(() => {
      this.blockedTimeouts.delete(ws);
      if (this.shedSockets.has(ws))
        return;
      if (!this.blockedSockets.has(ws))
        return;
      this.shedSocket(ws, `backpressure:blocked>${this.bpMaxBlockedMs}ms`);
    }, this.bpMaxBlockedMs);
    this.blockedTimeouts.set(ws, timer);
  }
  readBufferedAmount(ws) {
    if (this.bpBufferedAmount)
      return this.bpBufferedAmount(ws);
    const any = ws;
    if (typeof any.getBufferedAmount === "function") {
      try {
        return any.getBufferedAmount();
      } catch {
        return;
      }
    }
    return;
  }
  closeSlowSocket(ws, reason) {
    if (this.bpClose) {
      try {
        this.bpClose(ws, reason);
      } catch {}
      return;
    }
    const any = ws;
    if (typeof any.close === "function") {
      try {
        any.close(1013, reason);
      } catch {}
    }
  }
  markBlocked(ws) {
    if (!this.bpEnabled)
      return;
    if (this.shedSockets.has(ws))
      return;
    if (!this.blockedSockets.has(ws)) {
      this.blockedSockets.set(ws, { since: muxNowMs() });
      this.hooks.onBackpressure?.(ws, "blocked", {
        blockedMs: 0,
        bufferedBytes: this.readBufferedAmount(ws)
      });
      this.armBlockedTimeout(ws);
    }
    this.maybeShed(ws, "backpressure");
  }
  shedSocket(ws, reason) {
    if (this.shedSockets.has(ws))
      return;
    const blocked = this.blockedSockets.get(ws);
    const blockedMs = blocked ? muxNowMs() - blocked.since : 0;
    const bufferedBytes = this.readBufferedAmount(ws);
    this.shedSockets.add(ws);
    this.clearBlockedTimeout(ws);
    this.blockedSockets.delete(ws);
    this.closeSlowSocket(ws, reason);
    this.hooks.onBackpressure?.(ws, "closed", { blockedMs, bufferedBytes });
  }
  maybeShed(ws, why) {
    if (!this.bpEnabled)
      return false;
    if (this.shedSockets.has(ws))
      return true;
    const buffered = this.readBufferedAmount(ws);
    if (buffered !== undefined && buffered > this.bpMaxBufferedBytes) {
      this.shedSocket(ws, `backpressure:buffered>${this.bpMaxBufferedBytes}`);
      return true;
    }
    const blocked = this.blockedSockets.get(ws);
    if (blocked && muxNowMs() - blocked.since >= this.bpMaxBlockedMs) {
      this.shedSocket(ws, `backpressure:blocked>${this.bpMaxBlockedMs}ms`);
      return true;
    }
    return false;
  }
  shouldSkipServerPush(ws) {
    if (!this.bpEnabled)
      return false;
    if (this.shedSockets.has(ws))
      return true;
    if (!this.blockedSockets.has(ws))
      return false;
    if (this.maybeShed(ws, "skip"))
      return true;
    const buffered = this.readBufferedAmount(ws);
    if (buffered === 0) {
      this.resumeBlockedSocket(ws, 0);
      this.settleSessionListDebt(ws);
      return false;
    }
    return true;
  }
  sessionListDataFor(ws, sessions, unfilteredJson, client) {
    const filter = this.hooks.filterSessionList;
    if (!filter)
      return unfilteredJson;
    try {
      return JSON.stringify(filter(sessions, ws, client));
    } catch (e) {
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      this.logError("[thumbmux-mux] filterSessionList threw:", msg);
      return null;
    }
  }
  pushSessionListTo(ws) {
    try {
      const sessions = this.sessionListProvider();
      const unfilteredJson = JSON.stringify(sessions);
      const dataJson = this.sessionListDataFor(ws, sessions, unfilteredJson, this.sessionListClients.get(ws));
      if (dataJson === null)
        return;
      const status = this.wsSend(ws, JSON.stringify({
        channel: "__sessions",
        type: "sessions",
        data: dataJson
      }));
      if (status === 0) {
        if (!this.shedSockets.has(ws))
          this.owedSessionList.add(ws);
      } else if (status === -1) {
        this.markBlocked(ws);
      }
    } catch {}
  }
  mapRawCursor(raw, trailingBlanks) {
    if (!raw || !raw.visible)
      return null;
    const row = raw.paneHeight - 1 - trailingBlanks - raw.y;
    return { row, col: Math.max(0, raw.x) };
  }
  countTrailingBlanks(rawCapture) {
    const lines = rawCapture.replace(/\n$/, "").split(`
`);
    let last = lines.length;
    while (last > 0 && (lines[last - 1] ?? "").trim() === "")
      last--;
    return lines.length - last;
  }
  cursorEq(a, b) {
    const x = a ?? null, y = b ?? null;
    if (x === null || y === null)
      return x === y;
    return x.row === y.row && x.col === y.col;
  }
  screenEq(a, b) {
    const x = a ?? null, y = b ?? null;
    if (x === null || y === null)
      return x === y;
    return x.alt === y.alt && x.mouseSgr === y.mouseSgr && x.mouseAny === y.mouseAny;
  }
  boundaryEq(a, b) {
    if (a === undefined || b === undefined)
      return a === b;
    return muxHistoryBoundaryTransition(a, b) === "same";
  }
  sampleArchiveBoundary(session) {
    const provider = this.archive?.boundary;
    if (!provider)
      return;
    const raw = provider(session);
    if (raw === null) {
      if (this.lastBoundary.has(session)) {
        throw new Error(`durable history boundary disappeared for ${session}`);
      }
      return;
    }
    const boundary = validateMuxHistoryBoundary(raw);
    if (!boundary)
      throw new Error(`invalid durable history boundary for ${session}`);
    const previous = this.lastBoundary.get(session);
    if (previous && muxHistoryBoundaryTransition(previous, boundary) === "regression") {
      throw new Error(`durable history boundary regressed for ${session}`);
    }
    return boundary;
  }
  emitOutputHook(session, data, cursor, reset, screen, boundary) {
    const hook = this.hooks.onOutput;
    if (!hook)
      return;
    const frame = {
      channel: session,
      type: "output",
      data,
      cursor: cursor ? { ...cursor } : null,
      ...screen !== undefined ? { screen: screen ? { ...screen } : null } : {},
      ...boundary !== undefined ? { boundary: { ...boundary } } : {},
      ...reset ? { reset } : {}
    };
    try {
      hook(session, frame);
    } catch (cause) {
      let message = "unknown error";
      try {
        message = cause && typeof cause.message === "string" ? cause.message : String(cause);
      } catch {}
      try {
        this.logError("[thumbmux-mux] onOutput threw:", message);
      } catch {}
    }
  }
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.sessionListInterval) {
      clearInterval(this.sessionListInterval);
      this.sessionListInterval = null;
    }
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    for (const t of this.immediateCaptureTimers.values())
      clearTimeout(t);
    this.immediateCaptureTimers.clear();
    for (const t of this.pipeDebounceTimers.values())
      clearTimeout(t);
    this.pipeDebounceTimers.clear();
    for (const t of this.pipeMaxTimers.values())
      clearTimeout(t);
    this.pipeMaxTimers.clear();
    for (const t of this.blockedTimeouts.values())
      muxDisarmTimeout(t);
    this.blockedTimeouts.clear();
    for (const session of this.piped)
      this.pipes?.stopPipe(session);
    this.piped.clear();
  }
  contentFor(session, ws, content) {
    const tail = this.tails.get(session)?.get(ws);
    if (!tail)
      return content;
    const lines = content.split(`
`);
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "")
      end--;
    if (end === 0)
      return "";
    return lines.slice(Math.max(0, end - tail), end).join(`
`);
  }
  outputBaseFor(session, ws) {
    return this.outputBases.get(session)?.get(ws);
  }
  setDeltaSubscription(session, ws, enabled) {
    if (!enabled) {
      const viewers2 = this.deltaSubscribers.get(session);
      viewers2?.delete(ws);
      if (viewers2?.size === 0)
        this.deltaSubscribers.delete(session);
      return;
    }
    let viewers = this.deltaSubscribers.get(session);
    if (!viewers) {
      viewers = new Set;
      this.deltaSubscribers.set(session, viewers);
    }
    viewers.add(ws);
  }
  isDeltaSubscriber(session, ws) {
    return this.deltaSubscribers.get(session)?.has(ws) === true;
  }
  invalidateOutputBase(session, ws) {
    const bases = this.outputBases.get(session);
    if (!bases)
      return;
    bases.delete(ws);
    if (bases.size === 0)
      this.outputBases.delete(session);
  }
  invalidateOutputBases(session) {
    this.outputBases.delete(session);
  }
  requireFullOutput(session, ws) {
    let viewers = this.pendingOutputFulls.get(session);
    if (!viewers) {
      viewers = new Set;
      this.pendingOutputFulls.set(session, viewers);
    }
    viewers.add(ws);
  }
  requireResetOutput(session, ws, reset) {
    this.invalidateOutputBase(session, ws);
    let resets = this.pendingOutputResets.get(session);
    if (!resets) {
      resets = new Map;
      this.pendingOutputResets.set(session, resets);
    }
    resets.set(ws, reset);
  }
  hasPendingOutputFrame(session, viewers) {
    const fulls = this.pendingOutputFulls.get(session);
    const resets = this.pendingOutputResets.get(session);
    for (const ws of viewers) {
      if (fulls?.has(ws) || resets?.has(ws))
        return true;
    }
    return false;
  }
  forgetOutputViewer(session, ws) {
    this.setDeltaSubscription(session, ws, false);
    this.invalidateOutputBase(session, ws);
    const fulls = this.pendingOutputFulls.get(session);
    fulls?.delete(ws);
    if (fulls?.size === 0)
      this.pendingOutputFulls.delete(session);
    const resets = this.pendingOutputResets.get(session);
    resets?.delete(ws);
    if (resets?.size === 0)
      this.pendingOutputResets.delete(session);
  }
  forgetOutputSocket(ws) {
    for (const session of new Set([
      ...this.deltaSubscribers.keys(),
      ...this.outputBases.keys(),
      ...this.pendingOutputFulls.keys(),
      ...this.pendingOutputResets.keys()
    ])) {
      this.forgetOutputViewer(session, ws);
    }
  }
  sendGroupedOutputFrames(session, viewers, content, cursor, opts = {}) {
    const results = new Map;
    const fullGroups = new Map;
    const deltaByTail = new Map;
    for (const ws of viewers) {
      const reset = this.pendingOutputResets.get(session)?.get(ws);
      const pendingFull = this.pendingOutputFulls.get(session)?.has(ws) === true;
      if (opts.onlyPending && reset === undefined && !pendingFull)
        continue;
      if (this.shouldSkipServerPush(ws)) {
        if (!this.shedSockets.has(ws))
          this.requireFullOutput(session, ws);
        results.set(ws, false);
        continue;
      }
      const tail = opts.fixedData !== undefined ? undefined : this.tails.get(session)?.get(ws);
      const forceFull = reset !== undefined || pendingFull;
      const base = this.outputBaseFor(session, ws);
      const useDelta = this.isDeltaSubscriber(session, ws) && !forceFull && base !== undefined;
      if (!useDelta) {
        const key = `${tail ?? ""}\x00${reset ?? ""}`;
        let group = fullGroups.get(key);
        if (!group) {
          group = { tail, reset, base: undefined, sockets: [] };
          fullGroups.set(key, group);
        }
        group.sockets.push(ws);
      } else {
        let byBase = deltaByTail.get(tail);
        if (!byBase) {
          byBase = new Map;
          deltaByTail.set(tail, byBase);
        }
        const b = base;
        let group = byBase.get(b);
        if (!group) {
          group = { tail, reset: undefined, base: b, sockets: [] };
          byBase.set(b, group);
        }
        group.sockets.push(ws);
      }
    }
    const dataByTail = new Map;
    const nextBaseByData = new Map;
    const flushGroup = (group) => {
      let data;
      if (opts.fixedData !== undefined) {
        data = opts.fixedData;
      } else {
        const cached = dataByTail.get(group.tail);
        if (cached !== undefined) {
          data = cached;
        } else {
          data = this.contentFor(session, group.sockets[0], content);
          dataByTail.set(group.tail, data);
        }
      }
      const full = {
        channel: session,
        type: "output",
        data,
        cursor,
        ...this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {},
        ...this.lastBoundary.has(session) ? { boundary: this.lastBoundary.get(session) } : {}
      };
      const frame = group.reset ? { ...full, reset: group.reset } : full;
      const output = group.base === undefined ? frame : chooseMuxOutputFrame(frame, group.base);
      const serialized = JSON.stringify(output);
      for (const ws of group.sockets) {
        let ok = true;
        try {
          const status = this.wsSend(ws, serialized);
          if (status === 0) {
            this.requireFullOutput(session, ws);
            ok = false;
          } else if (status === -1) {
            this.markBlocked(ws);
          }
        } catch {
          this.requireFullOutput(session, ws);
          ok = false;
        }
        results.set(ws, ok);
        if (!ok)
          continue;
        if (this.isDeltaSubscriber(session, ws)) {
          let nextBase = nextBaseByData.get(data);
          if (!nextBase) {
            nextBase = splitMuxOutputData(data);
            nextBaseByData.set(data, nextBase);
          }
          let bases = this.outputBases.get(session);
          if (!bases) {
            bases = new Map;
            this.outputBases.set(session, bases);
          }
          bases.set(ws, nextBase);
        }
        const fulls = this.pendingOutputFulls.get(session);
        fulls?.delete(ws);
        if (fulls?.size === 0)
          this.pendingOutputFulls.delete(session);
        const resets = this.pendingOutputResets.get(session);
        resets?.delete(ws);
        if (resets?.size === 0)
          this.pendingOutputResets.delete(session);
      }
    };
    for (const group of fullGroups.values())
      flushGroup(group);
    for (const byBase of deltaByTail.values()) {
      for (const group of byBase.values())
        flushGroup(group);
    }
    return results;
  }
  sendOutputFrame(session, ws, full) {
    const results = this.sendGroupedOutputFrames(session, [ws], full.data, full.cursor ?? null, { fixedData: full.data });
    return results.get(ws) === true;
  }
  sendCursorFrame(session, ws, message) {
    if (this.shouldSkipServerPush(ws)) {
      if (!this.shedSockets.has(ws))
        this.requireFullOutput(session, ws);
      return false;
    }
    try {
      const status = this.wsSend(ws, message);
      if (status === 0) {
        this.requireFullOutput(session, ws);
        return false;
      }
      if (status === -1)
        this.markBlocked(ws);
      return true;
    } catch {
      this.requireFullOutput(session, ws);
      return false;
    }
  }
  sendPendingOutputFrames(session, viewers, content, cursor) {
    this.sendGroupedOutputFrames(session, viewers, content, cursor, { onlyPending: true });
  }
  invalidateSession(session, opts = {}) {
    const viewers = [...this.subscribers.get(session) ?? []];
    this.dropSessionState(session);
    this.archiveSeeded.delete(session);
    if (opts.purgeArchive) {
      try {
        this.archive?.dropSession?.(session);
      } catch (error) {
        try {
          const message2 = error instanceof Error ? error.message : String(error);
          this.logError(`[thumbmux-mux] archive dropSession error for "${session}":`, message2);
        } catch {}
      }
    }
    try {
      this.maybeStopPolling();
    } catch {}
    try {
      this.refreshSessionListSchedule();
    } catch {}
    const message = JSON.stringify({
      channel: session,
      type: "error",
      data: opts.reason ?? "Session not found"
    });
    for (const ws of viewers) {
      try {
        const status = this.wsSend(ws, message);
        if (status === -1)
          this.markBlocked(ws);
      } catch {}
    }
    return viewers.length;
  }
  resetSessionOutput(session) {
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0)
      return 0;
    this.contents.delete(session);
    this.hashes.delete(session);
    this.lastCursor.delete(session);
    this.lastScreen.delete(session);
    this.lastBoundary.delete(session);
    this.archiveSeeded.delete(session);
    this.captureStartLines.delete(session);
    for (const ws of viewers)
      this.requireResetOutput(session, ws, "resync");
    this.queueCapture(session, { fullHistory: true });
    return viewers.size;
  }
  dropSessionState(session) {
    const viewers = this.subscribers.get(session);
    this.subscribers.delete(session);
    viewers?.clear();
    this.tails.delete(session);
    this.deltaSubscribers.delete(session);
    this.outputBases.delete(session);
    this.pendingOutputFulls.delete(session);
    this.pendingOutputResets.delete(session);
    this.lastCursor.delete(session);
    this.lastScreen.delete(session);
    this.lastBoundary.delete(session);
    this.contents.delete(session);
    this.hashes.delete(session);
    this.lastActivity.delete(session);
    this.captureStartLines.delete(session);
    this.pendingArchiveReflows.delete(session);
    this.geometryGenerations.delete(session);
    this.clearImmediateCapture(session);
    this.queuedCapturesPending.delete(session);
    this.queuedCapturesInFlight.delete(session);
    this.queuedCapturesFullHistory.delete(session);
    this.queuedCaptureTails.delete(session);
    this.clearPipeCaptureTimers(session);
    this.lastReconcileCapture.delete(session);
    this.lastAppliedGeometry.delete(session);
    if (this.piped.delete(session)) {
      try {
        this.pipes?.stopPipe(session);
      } catch (error) {
        try {
          const message = error instanceof Error ? error.message : String(error);
          this.logError(`[thumbmux-mux] stopPipe error for "${session}":`, message);
        } catch {}
      }
    }
  }
  subscribeSessions(ws, client) {
    this.sessionListSubscribers.add(ws);
    this.sessionListClients.set(ws, client);
    if (this.shouldSkipServerPush(ws)) {
      if (!this.shedSockets.has(ws))
        this.owedSessionList.add(ws);
      this.refreshSessionListSchedule();
      return;
    }
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      const dataJson = this.sessionListDataFor(ws, sessions, json, client);
      if (dataJson === null) {
        this.refreshSessionListSchedule();
        return;
      }
      const status = this.wsSend(ws, JSON.stringify({
        channel: "__sessions",
        type: "sessions",
        data: dataJson
      }));
      if (status === 0) {
        if (!this.shedSockets.has(ws))
          this.owedSessionList.add(ws);
      } else if (status === -1) {
        this.markBlocked(ws);
        this.lastSessionsJson = json;
      } else {
        this.lastSessionsJson = json;
      }
    } catch (e) {
      this.logError("[thumbmux-mux] subscribeSessions error:", e.message);
    }
    this.refreshSessionListSchedule();
  }
  unsubscribeSessions(ws) {
    this.sessionListSubscribers.delete(ws);
    this.sessionListClients.delete(ws);
    this.owedSessionList.delete(ws);
    this.refreshSessionListSchedule();
  }
  handleResize(session, cols, rows, ws, client) {
    this.hooks.onResizeTelemetry?.(session, ws ?? null, { cols, rows }, client);
    if (!this.profileOf(session).resize)
      return;
    const verdict = this.hooks.onResizeRequest?.(session, ws ?? null, { cols, rows }, client) ?? { apply: true };
    if (!verdict.apply)
      return;
    this.applyGeometry(session, cols, rows, ws);
  }
  applyGeometry(session, cols, rows, ws) {
    try {
      const last = this.lastAppliedGeometry.get(session);
      if (last?.cols === cols && last.rows === rows)
        return;
      this.driver.resizeWindow(session, cols, rows);
      this.lastAppliedGeometry.set(session, { cols, rows });
      const generation = ++this.geometryGeneration;
      this.geometryGenerations.set(session, generation);
      this.pendingArchiveReflows.set(session, generation);
      this.invalidateOutputBases(session);
      for (const viewer of this.subscribers.get(session) ?? []) {
        this.requireResetOutput(session, viewer, "resize");
      }
      this.captureStartLines.set(session, this.archiveSeeded.has(session) ? this.DEFAULT_CAPTURE_START_LINE : this.INITIAL_CAPTURE_START_LINE);
      this.queueCapture(session, { fullHistory: false });
      this.refreshSessionListSchedule();
    } catch (e) {
      this.logError(`[thumbmux-mux] resize error for "${session}" to ${cols}x${rows}:`, e.message);
      try {
        ws && this.wsSend(ws, JSON.stringify({
          channel: session,
          type: "error",
          data: e.message ?? String(e)
        }));
      } catch {}
    }
  }
  handleKeys(session, data, ws, client) {
    if (ws)
      this.hooks.onKeys?.(session, ws, client);
    try {
      this.driver.sendKeys(session, data);
      if (this.piped.has(session))
        return;
      this.enterBurst();
      this.scheduleImmediateCapture(session);
    } catch (e) {
      this.logError(`[thumbmux-mux] sendKeys error for "${session}":`, e.message);
    }
  }
  reportArchiveReadErrorBestEffort(method, session, error) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      this.logError(`[thumbmux-mux] archive ${method} error for "${session}":`, message);
    } catch {}
  }
  sendHistoryReadErrorBestEffort(session, ws) {
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "error",
        data: "history_temporarily_unavailable",
        code: "history_temporarily_unavailable",
        request: "history_expand",
        retryable: true
      }));
    } catch {}
  }
  expandHistory(session, ws, beforeLine, limit) {
    let history = EMPTY_HISTORY_PAGE;
    let readFailed = false;
    if (this.archive && this.profileOf(session).archive) {
      let anchor = beforeLine ?? null;
      if (anchor === null && this.archive.liveStartLine) {
        try {
          anchor = this.archive.liveStartLine(session) ?? null;
        } catch (e) {
          this.reportArchiveReadErrorBestEffort("liveStartLine", session, e);
          readFailed = true;
        }
      }
      if (!readFailed) {
        try {
          history = this.archive.readBefore(session, anchor, limit);
        } catch (e) {
          this.reportArchiveReadErrorBestEffort("readBefore", session, e);
          readFailed = true;
        }
      }
    }
    if (readFailed) {
      this.sendHistoryReadErrorBestEffort(session, ws);
      return;
    }
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history)
      }));
    } catch {}
  }
  expandHistoryAfter(session, ws, afterLine, limit) {
    let history = EMPTY_HISTORY_PAGE;
    let readFailed = false;
    if (this.archive?.readAfter && this.profileOf(session).archive) {
      try {
        history = this.archive.readAfter(session, afterLine, limit);
      } catch (e) {
        this.reportArchiveReadErrorBestEffort("readAfter", session, e);
        readFailed = true;
      }
    }
    if (readFailed) {
      this.sendHistoryReadErrorBestEffort(session, ws);
      return;
    }
    try {
      this.wsSend(ws, JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history)
      }));
    } catch {}
  }
  handleMessage(msg, ws) {
    switch (msg.type) {
      case "ping":
        try {
          ws.send('{"type":"pong"}');
        } catch {}
        break;
      case "client_info":
        this.hooks.onClientInfo?.(ws, msg.client);
        break;
      case "subscribe":
        if (msg.session)
          this.subscribe(msg.session, ws, msg.client, { tail: msg.tail, delta: msg.delta });
        break;
      case "unsubscribe":
        if (msg.session)
          this.unsubscribe(msg.session, ws, msg.client);
        break;
      case "keys":
        if (msg.session && msg.data !== undefined)
          this.handleKeys(msg.session, msg.data, ws, msg.client);
        break;
      case "resize":
        if (msg.session && msg.cols && msg.rows)
          this.handleResize(msg.session, msg.cols, msg.rows, ws, msg.client);
        break;
      case "sessions_subscribe":
        this.subscribeSessions(ws, msg.client);
        break;
      case "sessions_unsubscribe":
        this.unsubscribeSessions(ws);
        break;
      case "history_expand":
        if (msg.session) {
          if (msg.afterLine !== undefined)
            this.expandHistoryAfter(msg.session, ws, msg.afterLine, msg.limit);
          else
            this.expandHistory(msg.session, ws, msg.beforeLine, msg.limit);
        }
        break;
      case "resync":
        if (msg.session)
          this.handleResync(msg.session, ws);
        break;
    }
  }
  handleResync(session, ws) {
    this.requireResetOutput(session, ws, "resync");
    const cachedContent = this.contents.get(session);
    if (cachedContent !== undefined) {
      this.sendOutputFrame(session, ws, {
        channel: session,
        type: "output",
        data: this.contentFor(session, ws, cachedContent),
        cursor: this.lastCursor.get(session) ?? null,
        ...this.lastScreen.has(session) ? { screen: this.lastScreen.get(session) ?? null } : {}
      });
    }
    this.queueCapture(session);
  }
  scheduleImmediateCapture(session) {
    this.clearImmediateCapture(session);
    this.immediateCaptureTimers.set(session, setTimeout(() => {
      this.immediateCaptureTimers.delete(session);
      this.queueCapture(session);
    }, 16));
  }
  clearImmediateCapture(session) {
    const timer = this.immediateCaptureTimers.get(session);
    if (!timer)
      return;
    clearTimeout(timer);
    this.immediateCaptureTimers.delete(session);
  }
  clearPipeCaptureTimers(session) {
    const debounce = this.pipeDebounceTimers.get(session);
    if (debounce)
      clearTimeout(debounce);
    this.pipeDebounceTimers.delete(session);
    const maxWait = this.pipeMaxTimers.get(session);
    if (maxWait)
      clearTimeout(maxWait);
    this.pipeMaxTimers.delete(session);
  }
  queueCapture(session, opts = {}) {
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0)
      return Promise.resolve();
    if (opts.fullHistory)
      this.queuedCapturesFullHistory.add(session);
    if (this.queuedCapturesInFlight.has(session)) {
      this.queuedCapturesPending.add(session);
      return this.queuedCaptureTails.get(session) ?? Promise.resolve();
    }
    this.queuedCapturesInFlight.add(session);
    const run = this.runQueuedCapture(session, viewers);
    this.queuedCaptureTails.set(session, run);
    return run;
  }
  async runQueuedCapture(session, viewers) {
    try {
      if (this.ownsSessionLifecycle(session, viewers)) {
        const fullHistory = this.queuedCapturesFullHistory.has(session);
        if (fullHistory)
          this.fullHistoryCaptureOwners.add(viewers);
        await this.captureAndBroadcastAsync(session, viewers, { fullHistory });
      }
    } finally {
      this.fullHistoryCaptureOwners.delete(viewers);
      if (!this.ownsSessionLifecycle(session, viewers)) {
        this.queuedCaptureTails.delete(session);
        return;
      }
      this.queuedCapturesInFlight.delete(session);
      if (this.queuedCapturesPending.delete(session)) {
        const successor = this.queueCapture(session);
        this.queuedCaptureTails.set(session, successor);
        await successor;
      } else {
        this.queuedCaptureTails.delete(session);
      }
    }
  }
  tryStartPipe(session) {
    if (!this.pipes)
      return;
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0)
      return;
    const ownsLifecycle = () => this.ownsSessionLifecycle(session, viewers);
    const started = this.pipes.startPipe(session, (_data) => {
      if (!ownsLifecycle())
        return;
      const doCapture = () => {
        if (!ownsLifecycle())
          return;
        const d = this.pipeDebounceTimers.get(session);
        if (d)
          clearTimeout(d);
        this.pipeDebounceTimers.delete(session);
        const m = this.pipeMaxTimers.get(session);
        if (m)
          clearTimeout(m);
        this.pipeMaxTimers.delete(session);
        this.queueCapture(session);
      };
      const existing = this.pipeDebounceTimers.get(session);
      if (existing)
        clearTimeout(existing);
      this.pipeDebounceTimers.set(session, setTimeout(doCapture, 15));
      if (!this.pipeMaxTimers.has(session)) {
        this.pipeMaxTimers.set(session, setTimeout(doCapture, 100));
      }
    }, () => {
      if (!ownsLifecycle())
        return;
      this.piped.delete(session);
      this.queueCapture(session);
      try {
        this.log(`[thumbmux-mux] Pipe broken for "${session}" — resuming poll fallback`);
      } catch {}
    }, () => {
      if (!ownsLifecycle())
        return;
      this.piped.add(session);
      try {
        this.log(`[thumbmux-mux] Pipe restarted for "${session}"`);
      } catch {}
    });
    if (started && ownsLifecycle()) {
      this.piped.add(session);
      try {
        this.log(`[thumbmux-mux] Pipe active for "${session}" — using as change trigger`);
      } catch {}
    }
  }
  handleSessionRename(oldSession, newSession) {
    const previousViewers = this.subscribers.get(oldSession);
    const fullHistoryInFlight = previousViewers ? this.fullHistoryCaptureOwners.has(previousViewers) : false;
    const viewers = previousViewers ? new Set(previousViewers) : undefined;
    if (viewers) {
      this.subscribers.set(newSession, viewers);
      this.subscribers.delete(oldSession);
    }
    const tails = this.tails.get(oldSession);
    if (tails) {
      this.tails.set(newSession, tails);
      this.tails.delete(oldSession);
    }
    const deltaSubscribers = this.deltaSubscribers.get(oldSession);
    if (deltaSubscribers) {
      this.deltaSubscribers.set(newSession, deltaSubscribers);
      this.deltaSubscribers.delete(oldSession);
    } else {
      this.deltaSubscribers.delete(newSession);
    }
    this.outputBases.delete(oldSession);
    this.outputBases.delete(newSession);
    this.pendingOutputFulls.delete(oldSession);
    this.pendingOutputFulls.delete(newSession);
    this.pendingOutputResets.delete(oldSession);
    this.pendingOutputResets.delete(newSession);
    if (viewers) {
      for (const ws of viewers)
        this.requireFullOutput(newSession, ws);
    }
    if (this.lastCursor.has(oldSession)) {
      this.lastCursor.set(newSession, this.lastCursor.get(oldSession) ?? null);
      this.lastCursor.delete(oldSession);
    }
    if (this.lastScreen.has(oldSession)) {
      this.lastScreen.set(newSession, this.lastScreen.get(oldSession) ?? null);
      this.lastScreen.delete(oldSession);
    }
    if (this.lastBoundary.has(oldSession)) {
      this.lastBoundary.set(newSession, this.lastBoundary.get(oldSession));
      this.lastBoundary.delete(oldSession);
    }
    const hash = this.hashes.get(oldSession);
    if (hash) {
      this.hashes.set(newSession, hash);
      this.hashes.delete(oldSession);
    }
    const content = this.contents.get(oldSession);
    if (content !== undefined) {
      this.contents.set(newSession, content);
      this.contents.delete(oldSession);
    }
    const captureStartLine = this.captureStartLines.get(oldSession);
    if (captureStartLine !== undefined) {
      this.captureStartLines.set(newSession, captureStartLine);
      this.captureStartLines.delete(oldSession);
    }
    const activity = this.lastActivity.get(oldSession);
    if (activity) {
      this.lastActivity.set(newSession, activity);
      this.lastActivity.delete(oldSession);
    }
    const lastReconcile = this.lastReconcileCapture.get(oldSession);
    if (lastReconcile) {
      this.lastReconcileCapture.set(newSession, lastReconcile);
      this.lastReconcileCapture.delete(oldSession);
    }
    const lastGeometry = this.lastAppliedGeometry.get(oldSession);
    if (lastGeometry) {
      this.lastAppliedGeometry.set(newSession, lastGeometry);
      this.lastAppliedGeometry.delete(oldSession);
    }
    const geometryGeneration = this.geometryGenerations.get(oldSession);
    this.geometryGenerations.delete(oldSession);
    this.geometryGenerations.delete(newSession);
    if (geometryGeneration !== undefined) {
      this.geometryGenerations.set(newSession, geometryGeneration);
    }
    if (this.immediateCaptureTimers.has(oldSession)) {
      this.clearImmediateCapture(oldSession);
      this.scheduleImmediateCapture(newSession);
    }
    this.clearPipeCaptureTimers(oldSession);
    const hadQueuedCapture = this.queuedCapturesPending.delete(oldSession);
    const hadCaptureInFlight = this.queuedCapturesInFlight.delete(oldSession);
    const needsFullHistory = this.queuedCapturesFullHistory.delete(oldSession) || fullHistoryInFlight;
    if (needsFullHistory)
      this.queuedCapturesFullHistory.add(newSession);
    if (hadQueuedCapture || hadCaptureInFlight) {
      this.queueCapture(newSession);
    }
    if (this.archiveSeeded.delete(oldSession)) {
      this.archiveSeeded.add(newSession);
    }
    const pendingArchiveReflow = this.pendingArchiveReflows.get(oldSession);
    this.pendingArchiveReflows.delete(oldSession);
    this.pendingArchiveReflows.delete(newSession);
    if (pendingArchiveReflow !== undefined) {
      this.pendingArchiveReflows.set(newSession, pendingArchiveReflow);
    }
    this.archive?.renameSession(oldSession, newSession);
    this.pipes?.handleRename(oldSession);
    if (this.piped.has(oldSession)) {
      this.piped.delete(oldSession);
      this.tryStartPipe(newSession);
    }
    this.queueCapture(newSession);
  }
  enterBurst() {
    if (this.burstTimer)
      clearTimeout(this.burstTimer);
    if (this.currentRate !== this.POLL_BURST) {
      this.currentRate = this.POLL_BURST;
      this.restartPolling();
    }
    this.burstTimer = setTimeout(() => {
      this.burstTimer = null;
      if (this.currentRate !== this.POLL_NORMAL) {
        this.currentRate = this.POLL_NORMAL;
        this.restartPolling();
      }
    }, this.BURST_DURATION);
  }
  restartPolling() {
    if (!this.interval)
      return;
    clearInterval(this.interval);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }
  async captureAndBroadcastAsync(session, viewers, opts = {}) {
    if (!this.ownsSessionLifecycle(session, viewers))
      return;
    const geometryGeneration = this.geometryGenerations.get(session);
    const archiveReflowGeneration = this.pendingArchiveReflows.get(session);
    try {
      const previousContent = this.contents.get(session) ?? null;
      const startLine = opts.fullHistory ? -Math.max(this.driver.getHistoryLimit(), this.liveLineLimit) : this.captureStartLines.get(session) ?? this.DEFAULT_CAPTURE_START_LINE;
      this.lastReconcileCapture.set(session, Date.now());
      const profile = this.profileOf(session);
      const useArchive = profile.archive && this.archive !== null && (!!opts.fullHistory || this.archiveSeeded.has(session));
      let boundaryBeforeCapture;
      if (useArchive) {
        try {
          boundaryBeforeCapture = this.sampleArchiveBoundary(session);
        } catch (archiveCause) {
          const message = archiveCause instanceof Error ? archiveCause.message : String(archiveCause);
          try {
            this.logError(`[thumbmux-mux] archive boundary error for "${session}":`, message);
          } catch {}
          if (opts.fullHistory)
            this.queuedCapturesFullHistory.add(session);
          return;
        }
      }
      const captureOpts = profile.currentPaneOnly ? { currentPaneOnly: true } : { startLine };
      let content;
      let rawCursor = null;
      let trailingBlanks = null;
      let rawScreen = undefined;
      let archiveCaptureToken;
      if (this.driver.captureWithCursor) {
        const combined = await this.driver.captureWithCursor(session, captureOpts);
        content = combined.content;
        rawCursor = combined.cursor;
        trailingBlanks = combined.trailingBlanks;
        if (Object.prototype.hasOwnProperty.call(combined, "screen")) {
          rawScreen = combined.screen ?? null;
        }
        archiveCaptureToken = combined.archiveCaptureToken;
      } else {
        content = await this.driver.capturePane(session, captureOpts);
      }
      if (!this.ownsSessionLifecycle(session, viewers))
        return;
      if (this.geometryGenerations.get(session) !== geometryGeneration) {
        if (opts.fullHistory)
          this.queueCapture(session, { fullHistory: true });
        return;
      }
      let liveContent;
      let boundary;
      if (!useArchive) {
        liveContent = content;
      } else {
        try {
          liveContent = this.archive.ingestSnapshot(session, content, {
            previousContent,
            fullHistory: !!opts.fullHistory,
            liveLineLimit: this.liveLineLimit,
            replace: archiveReflowGeneration !== undefined || undefined,
            captureToken: archiveCaptureToken
          }).liveContent;
          boundary = this.sampleArchiveBoundary(session);
          if (!this.boundaryEq(boundaryBeforeCapture, boundary)) {
            if (opts.fullHistory)
              this.queuedCapturesFullHistory.add(session);
            this.queueCapture(session, { fullHistory: !!opts.fullHistory });
            return;
          }
        } catch (archiveCause) {
          if (!this.ownsSessionLifecycle(session, viewers))
            return;
          const message = archiveCause instanceof Error ? archiveCause.message : String(archiveCause);
          try {
            this.logError(`[thumbmux-mux] archive ingest error for "${session}":`, message);
          } catch {}
          if (opts.fullHistory)
            this.queuedCapturesFullHistory.add(session);
          return;
        }
      }
      if (archiveReflowGeneration !== undefined && this.pendingArchiveReflows.get(session) === archiveReflowGeneration) {
        this.pendingArchiveReflows.delete(session);
      }
      if (opts.fullHistory) {
        this.archiveSeeded.add(session);
        this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
        this.queuedCapturesFullHistory.delete(session);
      }
      const previousBoundary = this.lastBoundary.get(session);
      const boundaryMoved = boundary !== undefined && !this.boundaryEq(previousBoundary, boundary);
      const hash = this.driver.hash(liveContent);
      this.contents.set(session, liveContent);
      if (hash === this.hashes.get(session)) {
        const atomicCursor = this.driver.captureWithCursor ? this.mapRawCursor(rawCursor, trailingBlanks ?? 0) : undefined;
        const cursor2 = atomicCursor !== undefined ? atomicCursor : this.lastCursor.get(session) ?? null;
        const cursorMoved = atomicCursor !== undefined && !this.cursorEq(atomicCursor, this.lastCursor.get(session));
        const atomicScreen = rawScreen;
        const screenMoved = atomicScreen !== undefined && !this.screenEq(atomicScreen, this.lastScreen.get(session));
        if (boundary !== undefined)
          this.lastBoundary.set(session, boundary);
        if (this.hasPendingOutputFrame(session, viewers)) {
          const pendingViewers = new Set;
          const fulls = this.pendingOutputFulls.get(session);
          const resets = this.pendingOutputResets.get(session);
          for (const ws of viewers) {
            if (fulls?.has(ws) || resets?.has(ws))
              pendingViewers.add(ws);
          }
          if (cursorMoved)
            this.lastCursor.set(session, atomicCursor);
          if (screenMoved)
            this.lastScreen.set(session, atomicScreen);
          if ((cursorMoved || screenMoved || boundaryMoved || archiveReflowGeneration !== undefined) && this.hooks.onOutput) {
            this.emitOutputHook(session, liveContent, cursor2, archiveReflowGeneration !== undefined ? "resize" : undefined, this.lastScreen.has(session) ? this.lastScreen.get(session) ?? null : undefined, boundary);
          }
          this.sendPendingOutputFrames(session, viewers, liveContent, cursor2);
          if (screenMoved || boundaryMoved) {
            for (const ws of viewers) {
              if (pendingViewers.has(ws))
                continue;
              this.sendOutputFrame(session, ws, {
                channel: session,
                type: "output",
                data: this.contentFor(session, ws, liveContent),
                cursor: cursor2,
                ...screenMoved ? { screen: atomicScreen } : {},
                ...boundary !== undefined ? { boundary } : {}
              });
            }
          } else if (cursorMoved) {
            const cursorMsg = JSON.stringify({
              channel: session,
              type: "cursor",
              cursor: atomicCursor
            });
            for (const ws of viewers) {
              if (pendingViewers.has(ws))
                continue;
              this.sendCursorFrame(session, ws, cursorMsg);
            }
          }
          return;
        }
        if (atomicCursor !== undefined || atomicScreen !== undefined || boundaryMoved) {
          if (cursorMoved && atomicCursor !== undefined)
            this.lastCursor.set(session, atomicCursor);
          if (screenMoved)
            this.lastScreen.set(session, atomicScreen);
          if (screenMoved || boundaryMoved) {
            const nextCursor = atomicCursor !== undefined ? atomicCursor : this.lastCursor.get(session) ?? null;
            if (this.hooks.onOutput) {
              this.emitOutputHook(session, liveContent, nextCursor, undefined, atomicScreen, boundary);
            }
            this.sendGroupedOutputFrames(session, viewers, liveContent, nextCursor);
          } else if (cursorMoved && atomicCursor !== undefined) {
            if (this.hooks.onOutput)
              this.emitOutputHook(session, liveContent, atomicCursor);
            const cursorMsg = JSON.stringify({ channel: session, type: "cursor", cursor: atomicCursor });
            for (const ws of viewers) {
              this.sendCursorFrame(session, ws, cursorMsg);
            }
          }
        }
        return;
      }
      this.hashes.set(session, hash);
      if (!this.driver.captureWithCursor && this.driver.getCursor) {
        try {
          rawCursor = await this.driver.getCursor(session);
        } catch {
          rawCursor = null;
        }
        trailingBlanks = this.countTrailingBlanks(content);
      }
      if (!this.ownsSessionLifecycle(session, viewers))
        return;
      if (this.geometryGenerations.get(session) !== geometryGeneration) {
        if (opts.fullHistory)
          this.queueCapture(session, { fullHistory: true });
        return;
      }
      const cursor = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
      if (boundary !== undefined)
        this.lastBoundary.set(session, boundary);
      this.lastCursor.set(session, cursor);
      if (rawScreen !== undefined)
        this.lastScreen.set(session, rawScreen);
      if (this.hooks.onOutput) {
        this.emitOutputHook(session, liveContent, cursor, archiveReflowGeneration !== undefined ? "resize" : undefined, rawScreen, boundary);
      }
      this.sendGroupedOutputFrames(session, viewers, liveContent, cursor);
    } catch (cause) {
      if (!this.ownsSessionLifecycle(session, viewers))
        return;
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.logError(`[thumbmux-mux] capture error for "${session}":`, message);
      } catch {}
      const errMsg = JSON.stringify({ channel: session, type: "error", data: "Session not found" });
      for (const ws of viewers) {
        try {
          this.wsSend(ws, errMsg);
        } catch {}
      }
    }
  }
  ownsSessionLifecycle(session, viewers) {
    return viewers.size > 0 && this.subscribers.get(session) === viewers;
  }
  ensurePolling() {
    if (this.interval)
      return;
    this.log(`[thumbmux-mux] Starting adaptive poll (${this.currentRate}ms)`);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }
  maybeStopPolling() {
    if (this.subscribers.size === 0 && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.log(`[thumbmux-mux] Stopped shared poll interval (no subscribers)`);
    }
  }
  refreshSessionListSchedule() {
    const needsDedicatedListPolling = this.sessionListSubscribers.size > 0 && this.subscribers.size === 0;
    if (needsDedicatedListPolling) {
      if (this.sessionListInterval)
        return;
      this.sessionListInterval = setInterval(() => this.broadcastSessionList(), this.SESSION_LIST_INTERVAL);
      return;
    }
    if (this.sessionListInterval) {
      clearInterval(this.sessionListInterval);
      this.sessionListInterval = null;
    }
  }
  async poll() {
    if (this.inFlight)
      return;
    this.inFlight = true;
    try {
      this.pollCounter++;
      const activity = this.driver.getSessionActivity();
      const tasks = [];
      const nowMs = Date.now();
      for (const [session, viewers] of this.subscribers) {
        if (viewers.size === 0)
          continue;
        if (this.piped.has(session)) {
          const lastReconcile = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastReconcile < this.PIPE_RECONCILE_INTERVAL)
            continue;
          tasks.push(this.queueCapture(session));
          continue;
        }
        const currentActivity = activity.get(session);
        const previousActivity = this.lastActivity.get(session);
        if (currentActivity !== undefined && previousActivity !== undefined && currentActivity <= previousActivity) {
          const lastCap = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastCap < this.POLL_RECONCILE)
            continue;
        }
        if (currentActivity !== undefined) {
          this.lastActivity.set(session, currentActivity);
        }
        tasks.push(this.queueCapture(session));
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      const sessionListInterval = Math.max(Math.round(this.SESSION_LIST_INTERVAL / this.currentRate), 1);
      if (this.pollCounter % sessionListInterval === 0) {
        this.broadcastSessionList();
      }
    } finally {
      this.inFlight = false;
    }
  }
  broadcastSessionList() {
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      if (json === this.lastSessionsJson)
        return;
      const hasFilter = !!this.hooks.filterSessionList;
      const sharedMsg = hasFilter ? null : JSON.stringify({ channel: "__sessions", type: "sessions", data: json });
      const sent = new Set;
      let anyAccounted = false;
      const trySend = (ws, client) => {
        if (sent.has(ws))
          return;
        sent.add(ws);
        if (this.shouldSkipServerPush(ws)) {
          if (!this.shedSockets.has(ws))
            this.owedSessionList.add(ws);
          anyAccounted = true;
          return;
        }
        try {
          let msg;
          if (sharedMsg !== null) {
            msg = sharedMsg;
          } else {
            const dataJson = this.sessionListDataFor(ws, sessions, json, client);
            if (dataJson === null)
              return;
            msg = JSON.stringify({
              channel: "__sessions",
              type: "sessions",
              data: dataJson
            });
          }
          const status = this.wsSend(ws, msg);
          if (status === 0) {
            if (!this.shedSockets.has(ws))
              this.owedSessionList.add(ws);
          } else if (status === -1) {
            this.markBlocked(ws);
            anyAccounted = true;
          } else {
            anyAccounted = true;
          }
        } catch {}
      };
      for (const ws of this.sessionListSubscribers) {
        trySend(ws, this.sessionListClients.get(ws));
      }
      for (const viewers of this.subscribers.values()) {
        for (const ws of viewers)
          trySend(ws, this.sessionListClients.get(ws));
      }
      if (anyAccounted)
        this.lastSessionsJson = json;
    } catch (e) {
      this.logError("[thumbmux-mux] broadcastSessionList error:", e.message);
    }
  }
}
// src/bun-driver.ts
var LARGE_INPUT_THRESHOLD_BYTES = 8 * 1024;
var PANE_STATUS_FMT = "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}|#{alternate_on}|#{mouse_sgr_flag}|#{mouse_any_flag}";
function exactTmuxTarget(name) {
  return `=${name}`;
}
function exactTmuxPaneTarget(name) {
  return `${exactTmuxTarget(name)}:`;
}
function targetResolvers(options) {
  const legacy = options.targetMode === "legacy";
  return {
    pane: legacy ? (name) => name : exactTmuxPaneTarget,
    session: legacy ? (name) => name : exactTmuxTarget
  };
}
function run(args) {
  const p = Bun.spawnSync(["tmux", ...args]);
  if (p.exitCode !== 0)
    throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}
function runWithStdin(args, stdin) {
  const p = Bun.spawnSync(["tmux", ...args], { stdin, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0)
    throw new Error(p.stderr.toString().trim() || `tmux ${args[0]} failed`);
  return p.stdout.toString();
}
function sendLargeInput(target, bytes) {
  const bufferName = `thumbmux-input-${crypto.randomUUID()}`;
  try {
    runWithStdin(["load-buffer", "-b", bufferName, "-"], bytes);
    run(["paste-buffer", "-d", "-r", "-b", bufferName, "-t", target]);
  } finally {
    try {
      run(["delete-buffer", "-b", bufferName]);
    } catch {}
  }
}
function parsePaneStatusLine(line) {
  const [x, y, h, flag, inMode, alt, mouseSgr, mouseAny] = line.split("|").map((v) => Number(v));
  const cursor = [x, y, h].every(Number.isFinite) ? { x, y, paneHeight: h, visible: flag === 1 && inMode === 0 } : null;
  return {
    cursor,
    screen: {
      alt: alt === 1,
      mouseSgr: mouseSgr === 1,
      mouseAny: mouseAny === 1
    }
  };
}
function createBunTmuxDriver(options = {}) {
  let latestActivity = new Map;
  const target = targetResolvers(options);
  return {
    listSessions() {
      try {
        return run(["list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}"]).trim().split(`
`).filter(Boolean).map((line) => {
          const [name, created, windows, attached] = line.split("|");
          return {
            name,
            created,
            windows: Number(windows) || 1,
            attached: attached === "1",
            activityAt: latestActivity.get(name) ?? 0
          };
        });
      } catch {
        return [];
      }
    },
    async capturePane(session, opts) {
      const args = ["capture-pane", "-t", target.pane(session), "-p", "-e"];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if (await p.exited !== 0)
        throw new Error(`capture-pane failed for ${session}`);
      return out;
    },
    sendKeys(session, data) {
      const bytes = new TextEncoder().encode(data);
      if (bytes.byteLength <= LARGE_INPUT_THRESHOLD_BYTES && !data.includes("\x00")) {
        run(["send-keys", "-t", target.pane(session), "-l", "--", data]);
        return;
      }
      sendLargeInput(target.pane(session), bytes);
    },
    getSessionActivity() {
      const map = new Map;
      try {
        for (const line of run(["list-windows", "-a", "-F", "#{session_name}|#{window_activity}"]).trim().split(`
`)) {
          const [name, at] = line.split("|");
          if (!name)
            continue;
          const t = Number(at) || 0;
          if (t > (map.get(name) ?? 0))
            map.set(name, t);
        }
      } catch {}
      latestActivity = map;
      return map;
    },
    getHistoryLimit() {
      try {
        const m = run(["show-options", "-g", "history-limit"]).match(/(\d+)/);
        return m ? Number(m[1]) : 2000;
      } catch {
        return 2000;
      }
    },
    setSessionHistoryLimit(session, limit) {
      run(["set-option", "-t", target.pane(session), "history-limit", String(limit)]);
    },
    resizeWindow(session, cols, rows) {
      run(["resize-window", "-t", target.pane(session), "-x", String(cols), "-y", String(rows)]);
    },
    hash(content) {
      return Bun.hash(content).toString(36);
    },
    async getCursor(session) {
      try {
        const out = run([
          "display-message",
          "-t",
          target.pane(session),
          "-p",
          PANE_STATUS_FMT
        ]).trim();
        return parsePaneStatusLine(out).cursor;
      } catch {
        return null;
      }
    },
    async captureWithCursor(session, opts) {
      const paneTarget = target.pane(session);
      const args = [
        "display-message",
        "-t",
        paneTarget,
        "-p",
        PANE_STATUS_FMT,
        ";",
        "capture-pane",
        "-t",
        paneTarget,
        "-p",
        "-e"
      ];
      if (!opts.currentPaneOnly && typeof opts.startLine === "number") {
        args.push("-S", String(opts.startLine));
      }
      const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if (await p.exited !== 0)
        throw new Error(`capture-pane failed for ${session}`);
      const nl = out.indexOf(`
`);
      const statusLine = nl === -1 ? out : out.slice(0, nl);
      const content = nl === -1 ? "" : out.slice(nl + 1);
      const lines = content.replace(/\n$/, "").split(`
`);
      let last = lines.length;
      while (last > 0 && (lines[last - 1] ?? "").trim() === "")
        last--;
      const { cursor, screen } = parsePaneStatusLine(statusLine.trim());
      return { content, cursor, trailingBlanks: lines.length - last, screen };
    }
  };
}
function spawnTmuxSession(name, cwd, command, options = {}) {
  const target = targetResolvers(options).pane(name);
  run(["new-session", "-d", "-s", name, "-c", cwd]);
  if (command)
    run(["send-keys", "-t", target, "-l", "--", command]);
  if (command)
    run(["send-keys", "-t", target, "Enter"]);
}
function killTmuxSession(name, options = {}) {
  run(["kill-session", "-t", targetResolvers(options).session(name)]);
}
// src/spawn-handler.ts
import { stat } from "node:fs/promises";
import { resolve as resolve5 } from "node:path";
import {
  DEFAULT_LAUNCH_PRESETS,
  buildLaunchCommand
} from "../core/index.js";
class SpawnHandlerError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "SpawnHandlerError";
    this.status = status;
  }
}
var SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;
var STRING_FIELDS = [
  "name",
  "cwd",
  "presetId",
  "agent",
  "permission",
  "model",
  "command"
];
var BOOLEAN_FIELDS = ["worktree", "autoName"];
function jsonError(status, error) {
  return Response.json({ error }, { status });
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function isDuplicateSessionError(error, reservedName) {
  return errorMessage2(error).trim().toLowerCase() === `duplicate session: ${reservedName}`.toLowerCase();
}
function parsePayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpawnHandlerError(400, "expected a JSON object");
  }
  const payload = value;
  for (const field of STRING_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      throw new SpawnHandlerError(400, `${field} must be a string`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      throw new SpawnHandlerError(400, `${field} must be a boolean`);
    }
  }
  return payload;
}
function assertSessionName(name, source) {
  const normalized = name.trim();
  if (!normalized || !SESSION_NAME_RE.test(normalized)) {
    const detail = "use only letters, numbers, _ and -";
    throw new SpawnHandlerError(source === "payload" ? 400 : 500, `invalid tmux session name${source === "host" ? " from host allocator" : ""}: ${detail}`);
  }
  return normalized;
}
function withNumericSuffix(base, taken, start = 2) {
  for (let suffix = start;suffix < 1e6; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate))
      return candidate;
  }
  throw new SpawnHandlerError(500, `could not allocate a unique session name for ${base}`);
}
async function resolveDirectory(raw, payload, validateCwd) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SpawnHandlerError(400, "cwd must be a non-empty string");
  }
  let cwd;
  try {
    cwd = resolve5(raw);
    const info = await stat(cwd);
    if (!info.isDirectory())
      throw new Error("not a directory");
  } catch (error) {
    throw new SpawnHandlerError(400, `invalid cwd: ${errorMessage2(error)}`);
  }
  if (validateCwd) {
    const verdict = await validateCwd(cwd, payload);
    if (verdict === false)
      throw new SpawnHandlerError(400, "cwd rejected by host policy");
    if (typeof verdict === "string")
      throw new SpawnHandlerError(400, verdict);
  }
  return cwd;
}
function createSpawnHandler(opts = {}) {
  const driver = opts.driver ?? createBunTmuxDriver();
  const presets = opts.presets ?? DEFAULT_LAUNCH_PRESETS;
  const spawn3 = opts.spawn ?? spawnTmuxSession;
  const reservedNames = new Set;
  let allocationTail = Promise.resolve();
  async function reserveName(payload, preset, blockedNames) {
    const previous = allocationTail;
    let release;
    allocationTail = new Promise((done) => {
      release = done;
    });
    await previous;
    try {
      const taken = new Set(driver.listSessions().map((session) => session.name).filter((name2) => typeof name2 === "string" && !!name2));
      for (const name2 of reservedNames)
        taken.add(name2);
      for (const name2 of blockedNames)
        taken.add(name2);
      const requested = payload.name;
      let name;
      if (requested !== undefined) {
        name = assertSessionName(requested, "payload");
        if (taken.has(name)) {
          if (payload.autoName !== true) {
            throw new SpawnHandlerError(409, `tmux session already exists: ${name}`);
          }
          name = withNumericSuffix(name, taken);
        }
      } else if (opts.generateName) {
        name = assertSessionName(await opts.generateName({ payload, existing: taken }), "host");
        if (taken.has(name))
          name = withNumericSuffix(name, taken);
      } else {
        const rawPrefix = opts.namePrefix ?? preset?.agent ?? payload.agent ?? "sh";
        const prefix = assertSessionName(rawPrefix || "sh", "host");
        name = `${prefix}-1`;
        if (taken.has(name))
          name = withNumericSuffix(prefix, taken, 2);
      }
      reservedNames.add(name);
      return name;
    } finally {
      release();
    }
  }
  return async function handleSpawn(req) {
    if (req.method !== "POST") {
      return jsonError(405, "method not allowed");
    }
    let reservedName = null;
    try {
      let rawPayload;
      try {
        rawPayload = await req.json();
      } catch {
        throw new SpawnHandlerError(400, "expected valid JSON");
      }
      const payload = parsePayload(rawPayload);
      let preset = null;
      let command = typeof payload.command === "string" && payload.command.length > 0 ? payload.command : undefined;
      let worktree = payload.worktree === true;
      if (payload.presetId !== undefined) {
        preset = presets.find((candidate) => candidate.id === payload.presetId) ?? null;
        if (!preset)
          throw new SpawnHandlerError(400, `unknown launch preset: ${payload.presetId}`);
        command = buildLaunchCommand(preset, payload.permission, payload.model) || undefined;
        worktree = !!preset.worktree;
      }
      if (command?.includes("\x00")) {
        throw new SpawnHandlerError(preset ? 500 : 400, preset ? "launch preset command must not contain NUL" : "command must not contain NUL");
      }
      const rawCwd = typeof opts.cwd === "function" ? await opts.cwd(payload) : payload.cwd ?? opts.cwd ?? process.cwd();
      const baseCwd = await resolveDirectory(rawCwd, payload, opts.validateCwd);
      const collidedNames = new Set;
      const canAutoName = payload.name === undefined || payload.autoName === true;
      const prepareWorktree = opts.prepareWorktree;
      const cleanupWorktree = opts.cleanupWorktree;
      if (worktree && !prepareWorktree) {
        throw new SpawnHandlerError(400, "worktree requested but no prepareWorktree hook is configured");
      }
      if (worktree && !cleanupWorktree) {
        throw new SpawnHandlerError(400, "worktree requested but no cleanupWorktree hook is configured");
      }
      for (let attempt = 0;attempt < 100; attempt += 1) {
        reservedName = await reserveName(payload, preset, collidedNames);
        let cwd = baseCwd;
        let worktreeCwd = null;
        try {
          if (worktree) {
            const preparedCwd = await prepareWorktree({
              name: reservedName,
              cwd,
              payload
            });
            if (preparedCwd.trim())
              worktreeCwd = resolve5(preparedCwd);
            cwd = await resolveDirectory(preparedCwd, payload, opts.validateCwd);
            worktreeCwd = cwd;
          }
          await spawn3(reservedName, cwd, command);
        } catch (error) {
          if (worktreeCwd) {
            await cleanupWorktree({
              name: reservedName,
              cwd: baseCwd,
              payload,
              worktreeCwd,
              cause: error
            });
          }
          if (error instanceof SpawnHandlerError)
            throw error;
          if (!isDuplicateSessionError(error, reservedName))
            throw error;
          if (!canAutoName) {
            throw new SpawnHandlerError(409, `tmux session already exists: ${reservedName}`);
          }
          collidedNames.add(reservedName);
          reservedNames.delete(reservedName);
          reservedName = null;
          continue;
        }
        return Response.json({ ok: true, name: reservedName }, { status: 201 });
      }
      throw new SpawnHandlerError(500, "could not allocate a unique tmux session name after 100 attempts");
    } catch (error) {
      if (error instanceof SpawnHandlerError) {
        return jsonError(error.status, error.message);
      }
      return jsonError(500, errorMessage2(error));
    } finally {
      if (reservedName)
        reservedNames.delete(reservedName);
    }
  };
}
// src/upload-handler.ts
import { Buffer as Buffer2 } from "node:buffer";
import { mkdir, open, rm } from "node:fs/promises";
import { join as join4, resolve as resolve6 } from "node:path";
import { makeStoredName } from "../core/index.js";
function isMultipartFilePart(value) {
  return typeof value !== "string" && value !== null && typeof value.size === "number" && typeof value.arrayBuffer === "function";
}
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && error.code === "EEXIST";
}
async function openUniqueDestination(dir, original) {
  for (let attempt = 0;; attempt += 1) {
    const random = Math.random().toString(36).slice(2, 8) || "0";
    const entropy = attempt === 0 ? random : `${random}-${attempt.toString(36)}`;
    const name = makeStoredName(original, Date.now(), entropy);
    const dest = join4(dir, name);
    try {
      const handle = await open(dest, "wx");
      return { dest, handle, name };
    } catch (error) {
      if (isAlreadyExists(error))
        continue;
      throw error;
    }
  }
}
function createUploadHandler(opts) {
  const dir = resolve6(opts.dir);
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytesPerFile ?? 200 * 1024 * 1024;
  const maxTotal = opts.maxTotalBytes;
  return async function handleUpload(req) {
    if (req.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "POST" } });
    }
    const form = await req.formData().catch(() => null);
    if (!form)
      return Response.json({ error: "expected multipart form-data" }, { status: 400 });
    const parts = Array.from(form.values());
    const allFileParts = parts.filter(isMultipartFilePart);
    if (allFileParts.length > maxFiles) {
      return Response.json({ error: `max ${maxFiles} files` }, { status: 413 });
    }
    for (const f of allFileParts) {
      if (f.size > maxBytes) {
        const name = typeof f.name === "string" && f.name ? f.name : "file";
        return Response.json({ error: `"${name}" exceeds ${maxBytes} bytes` }, { status: 413 });
      }
    }
    const uploadParts = form.getAll("files");
    if (uploadParts.some((part) => isMultipartFilePart(part) && typeof part.name !== "string")) {
      return Response.json({ error: "invalid file part" }, { status: 400 });
    }
    const files = uploadParts.filter((part) => isMultipartFilePart(part) && typeof part.name === "string");
    if (files.length === 0)
      return Response.json({ error: "no files" }, { status: 400 });
    if (maxTotal !== undefined) {
      let total = 0;
      for (const part of parts) {
        total += typeof part === "string" ? Buffer2.byteLength(part, "utf8") : isMultipartFilePart(part) ? part.size : 0;
        if (total > maxTotal) {
          return Response.json({ error: `request total exceeds ${maxTotal} bytes` }, { status: 413 });
        }
      }
    }
    await mkdir(dir, { recursive: true });
    const stored = [];
    const writtenPaths = [];
    try {
      for (const f of files) {
        const contents = new Uint8Array(await f.arrayBuffer());
        const { dest, handle, name } = await openUniqueDestination(dir, f.name);
        writtenPaths.push(dest);
        try {
          await handle.writeFile(contents);
        } finally {
          await handle.close().catch(() => {});
        }
        stored.push({ original: f.name, stored: name });
      }
    } catch (err) {
      await Promise.allSettled(writtenPaths.map((p) => rm(p, { force: true }).catch(() => {})));
      throw err;
    }
    return Response.json({ ok: true, files: stored, dir }, { status: 201 });
  };
}
// src/prefs-handler.ts
import { mergePrefs } from "../core/index.js";
import { mkdir as mkdir2, readFile, rename, writeFile } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var MAX_BYTES = 256 * 1024;
function createPrefsHandler(opts) {
  const { file } = opts;
  let seq = 0;
  let chain = Promise.resolve();
  function serialized(fn) {
    const p = chain.then(fn, fn);
    chain = p.then(() => {}, () => {});
    return p;
  }
  async function read() {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }
  return async function handlePrefs(req) {
    if (req.method === "GET") {
      return Response.json(await read());
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await req.text();
      if (body.length > MAX_BYTES) {
        return Response.json({ error: "prefs too large" }, { status: 413 });
      }
      let patch;
      try {
        patch = JSON.parse(body);
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return Response.json({ error: "prefs patch must be a JSON object" }, { status: 400 });
      }
      const next = await serialized(async () => {
        const merged = mergePrefs(await read(), patch);
        await mkdir2(dirname2(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${++seq}`;
        await writeFile(tmp, JSON.stringify(merged, null, 2) + `
`);
        await rename(tmp, file);
        return merged;
      });
      return Response.json(next);
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  };
}
// src/frame-journal.ts
import { appendFile, mkdir as mkdir3, readdir, readFile as readFile2, stat as stat2, truncate, unlink } from "node:fs/promises";
import { createHash as createHash2 } from "node:crypto";
import { dirname as dirname3, join as join5, resolve as resolve7 } from "node:path";
import {
  applyMuxDelta,
  chooseMuxOutputFrame as chooseMuxOutputFrame2,
  splitMuxOutputData as splitMuxOutputData2,
  shouldUseMuxDelta
} from "../core/index.js";
var DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
var DEFAULT_MAX_ROOT_BYTES = 256 * 1024 * 1024;
var DEFAULT_CHECKPOINT_CADENCE = 64;
var DEFAULT_MAX_PENDING_WRITES = 128;
var DEFAULT_ROOT = resolve7(process.cwd(), "thumbmux-frame-journal");
var NODE_STORAGE = {
  ensureDirectory: async (path) => {
    await mkdir3(path, { recursive: true });
  },
  readText: async (path) => readFile2(path, "utf8"),
  appendText: async (path, source) => {
    await appendFile(path, source, "utf8");
  },
  truncate: async (path, byteLength) => {
    await truncate(path, byteLength);
  },
  listNames: async (dir) => readdir(dir),
  byteLength: async (path) => (await stat2(path)).size,
  remove: async (path) => {
    await unlink(path);
  }
};

class FrameJournal {
  static DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
  static DEFAULT_MAX_ROOT_BYTES = DEFAULT_MAX_ROOT_BYTES;
  rootDir;
  clock;
  checkpointCadence;
  maxBytes;
  maxRootBytes;
  maxPendingWrites;
  onError;
  storage;
  rootReady;
  sessions = new Map;
  stopped = false;
  rootBytes = 0;
  rootBytesKnown = false;
  rootReservedBytes = 0;
  deletingSessions = new Set;
  closedLastAt = new Map;
  constructor(options = {}) {
    this.rootDir = resolve7(options.rootDir ?? DEFAULT_ROOT);
    this.clock = options.clock ?? (() => Date.now());
    this.checkpointCadence = options.checkpointCadence ?? DEFAULT_CHECKPOINT_CADENCE;
    if (!Number.isFinite(this.checkpointCadence) || !Number.isInteger(this.checkpointCadence) || this.checkpointCadence <= 0) {
      throw new Error("checkpointCadence must be a positive integer.");
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.maxBytes !== Infinity && (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0)) {
      throw new Error("maxBytes must be a finite positive number or Infinity.");
    }
    this.maxRootBytes = options.maxRootBytes ?? DEFAULT_MAX_ROOT_BYTES;
    if (this.maxRootBytes !== Infinity && (!Number.isFinite(this.maxRootBytes) || this.maxRootBytes <= 0)) {
      throw new Error("maxRootBytes must be a finite positive number or Infinity.");
    }
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
    if (this.maxPendingWrites !== Infinity && (!Number.isFinite(this.maxPendingWrites) || !Number.isInteger(this.maxPendingWrites) || this.maxPendingWrites <= 0)) {
      throw new Error("maxPendingWrites must be a positive integer or Infinity.");
    }
    this.onError = options.onError ?? (() => {
      return;
    });
    this.storage = options.storage ?? NODE_STORAGE;
    this.rootReady = this.storage.ensureDirectory(this.rootDir).then(() => this.scanRootBytes());
  }
  startSession(session) {
    if (this.deletingSessions.has(session)) {
      throw new Error(`Session "${session}" journal is being deleted.`);
    }
    const state = this.getOrCreateState(session);
    if (!state.recoveryFailed && !state.stopRequested)
      state.accepting = true;
    return this.snapshotState(state);
  }
  async recoverSession(session) {
    const state = this.getOrCreateState(session);
    const recovery = state.queue.then(async () => {
      await this.rootReady;
      let source = "";
      try {
        source = await this.storage.readText(state.path);
      } catch (cause) {
        if (!isFileNotFound(cause))
          throw cause;
        state.base = null;
        state.deltasSinceCheckpoint = 0;
        state.lastAt = null;
        state.recordCount = 0;
        state.recoveryFailed = false;
        state.bytes = 0;
        state.bytesKnown = true;
        state.accepting = !state.stopRequested;
        return this.snapshotState(state);
      }
      const prefix = completePrefixInfo(source);
      const priorFileBytes = Buffer.byteLength(source, "utf8");
      if (priorFileBytes > prefix.byteLength) {
        if (!this.storage.truncate) {
          throw new Error("Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to accept writes.");
        }
        await this.storage.truncate(state.path, prefix.byteLength);
        this.adjustRootBytes(prefix.byteLength - priorFileBytes);
        source = source.slice(0, prefix.charLength);
      }
      state.bytes = prefix.byteLength;
      state.bytesKnown = true;
      const recovered = parseAndValidateJournal(source, session, this.checkpointCadence);
      state.base = recovered.base;
      state.deltasSinceCheckpoint = recovered.deltasSinceCheckpoint;
      state.lastAt = recovered.lastAt;
      state.recordCount = recovered.recordCount;
      state.recoveryFailed = false;
      state.accepting = !state.stopRequested;
      return this.snapshotState(state);
    });
    state.queue = recovery.then(() => {
      return;
    }, (cause) => {
      state.base = null;
      state.deltasSinceCheckpoint = 0;
      state.lastAt = null;
      state.recordCount = 0;
      state.recoveryFailed = true;
      state.accepting = false;
      this.reportError({ session, path: state.path, phase: "recover", cause });
    });
    return recovery;
  }
  getSessionPath(session) {
    return this.makeSessionPath(session);
  }
  get sessionCount() {
    return this.sessions.size;
  }
  get rootByteCount() {
    return this.rootBytes;
  }
  capture(session, frame, at) {
    if (this.stopped)
      return false;
    if (this.deletingSessions.has(session))
      return false;
    const state = this.getOrCreateState(session);
    if (state.stopRequested || !state.accepting || state.recoveryFailed)
      return false;
    const fullFrame = normalizeFullFrame(session, frame);
    const recordAt = at ?? this.clock();
    if (!Number.isFinite(recordAt)) {
      throw new Error("Frame journal capture timestamp must be finite.");
    }
    if (state.pending >= this.maxPendingWrites) {
      this.reportError({
        session,
        path: state.path,
        phase: "drop",
        at: recordAt,
        cause: new Error("maxPendingWrites exceeded; capture dropped.")
      });
      return false;
    }
    let estimate = 0;
    const capsEnabled = this.maxBytes !== Infinity || this.maxRootBytes !== Infinity;
    if (capsEnabled) {
      estimate = Buffer.byteLength(JSON.stringify({ v: 1, session, at: recordAt, frame: fullFrame }), "utf8") + 33;
      if (this.maxBytes !== Infinity) {
        if (state.bytes + state.reservedBytes + estimate > this.maxBytes) {
          this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
          return false;
        }
      }
      if (this.maxRootBytes !== Infinity) {
        if (this.rootBytes + this.rootReservedBytes + estimate > this.maxRootBytes) {
          this.reportRootLimit(state, recordAt);
          return false;
        }
      }
      if (this.maxBytes !== Infinity)
        state.reservedBytes += estimate;
      if (this.maxRootBytes !== Infinity)
        this.rootReservedBytes += estimate;
    }
    state.pending += 1;
    state.queue = state.queue.then(async () => {
      try {
        if (state.recoveryFailed)
          return;
        await this.persistCapture(state, fullFrame, recordAt);
      } finally {
        state.pending -= 1;
        if (this.maxBytes !== Infinity)
          state.reservedBytes -= estimate;
        if (this.maxRootBytes !== Infinity)
          this.rootReservedBytes -= estimate;
      }
    }).catch((cause) => {
      state.base = null;
      state.deltasSinceCheckpoint = 0;
      this.reportError({
        session,
        path: state.path,
        phase: "write",
        at: recordAt,
        cause
      });
    });
    return true;
  }
  async flushSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    await state.queue;
  }
  async flushAll() {
    const flushes = Array.from(this.sessions.values()).map((state) => state.queue);
    await Promise.all(flushes);
  }
  async stopSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    state.accepting = false;
  }
  async closeSession(session) {
    const state = this.sessions.get(session);
    if (!state)
      return;
    state.stopRequested = true;
    state.accepting = false;
    await state.queue;
    if (state.lastAt !== null)
      this.closedLastAt.set(session, state.lastAt);
    this.sessions.delete(session);
  }
  async deleteSessionJournal(session) {
    await this.rootReady;
    if (!this.storage.remove) {
      throw new Error("storage.remove is unavailable; cannot delete session journal.");
    }
    this.deletingSessions.add(session);
    try {
      const path = this.makeSessionPath(session);
      const existing = this.sessions.get(session);
      let knownBytes = null;
      if (existing) {
        existing.stopRequested = true;
        existing.accepting = false;
        await existing.queue;
        if (existing.bytesKnown)
          knownBytes = existing.bytes;
        this.sessions.delete(session);
      }
      this.closedLastAt.delete(session);
      let removedBytes = knownBytes;
      if (removedBytes === null) {
        removedBytes = await this.measureFileBytes(path);
      }
      try {
        await this.storage.remove(path);
      } catch (cause) {
        if (!isFileNotFound(cause))
          throw cause;
        return false;
      }
      if (removedBytes > 0) {
        this.adjustRootBytes(-removedBytes);
      }
      return true;
    } finally {
      this.deletingSessions.delete(session);
    }
  }
  async stop() {
    this.stopped = true;
    for (const state of this.sessions.values()) {
      state.stopRequested = true;
      state.accepting = false;
    }
    await this.flushAll();
    this.sessions.clear();
    this.closedLastAt.clear();
    this.deletingSessions.clear();
  }
  getOrCreateState(session) {
    const existing = this.sessions.get(session);
    if (existing)
      return existing;
    const path = this.makeSessionPath(session);
    const preservedLastAt = this.closedLastAt.get(session) ?? null;
    const state = {
      session,
      path,
      base: null,
      deltasSinceCheckpoint: 0,
      lastAt: preservedLastAt,
      recordCount: 0,
      accepting: true,
      recoveryFailed: false,
      queue: Promise.resolve(),
      bytes: 0,
      bytesKnown: false,
      reservedBytes: 0,
      pending: 0,
      stopRequested: false,
      limitReported: false
    };
    this.sessions.set(session, state);
    return state;
  }
  snapshotState(state) {
    return {
      session: state.session,
      path: state.path,
      base: state.base ? state.base.slice() : [],
      recordCount: state.recordCount,
      lastAt: state.lastAt,
      deltasSinceCheckpoint: state.deltasSinceCheckpoint
    };
  }
  makeSessionPath(session) {
    const digest = hashSession(session);
    return join5(this.rootDir, `${digest}.ndjson`);
  }
  reportError(report) {
    try {
      this.onError(report);
    } catch {}
  }
  refuseSessionLimit(state, at, message) {
    state.accepting = false;
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error(message)
      });
    }
  }
  reportRootLimit(state, at) {
    if (!state.limitReported) {
      state.limitReported = true;
      this.reportError({
        session: state.session,
        path: state.path,
        phase: "limit",
        at,
        cause: new Error("maxRootBytes exceeded; capture refused.")
      });
    }
  }
  adjustRootBytes(delta) {
    this.rootBytes = Math.max(0, this.rootBytes + delta);
  }
  async scanRootBytes() {
    if (!this.storage.listNames) {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }
    let names;
    try {
      names = await this.storage.listNames(this.rootDir);
    } catch {
      this.rootBytes = 0;
      this.rootBytesKnown = true;
      return;
    }
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".ndjson"))
        continue;
      const path = join5(this.rootDir, name);
      total += await this.measureFileBytes(path);
    }
    this.rootBytes = total;
    this.rootBytesKnown = true;
  }
  async measureFileBytes(path) {
    if (this.storage.byteLength) {
      try {
        return await this.storage.byteLength(path);
      } catch (cause) {
        if (isFileNotFound(cause))
          return 0;
        throw cause;
      }
    }
    try {
      const text = await this.storage.readText(path);
      return Buffer.byteLength(text, "utf8");
    } catch (cause) {
      if (isFileNotFound(cause))
        return 0;
      throw cause;
    }
  }
  async ensureBytesKnown(state) {
    let source;
    try {
      source = await this.storage.readText(state.path);
    } catch (cause) {
      if (isFileNotFound(cause)) {
        state.bytes = 0;
        state.bytesKnown = true;
        return;
      }
      throw cause;
    }
    const prefix = completePrefixInfo(source);
    const priorFileBytes = Buffer.byteLength(source, "utf8");
    state.bytes = prefix.byteLength;
    state.bytesKnown = true;
    if (priorFileBytes > prefix.byteLength) {
      if (!this.storage.truncate) {
        state.accepting = false;
        state.recoveryFailed = true;
        throw new Error("Journal has a crash-torn trailing line and storage.truncate is unavailable; refusing to append.");
      }
      await this.storage.truncate(state.path, prefix.byteLength);
      this.adjustRootBytes(prefix.byteLength - priorFileBytes);
    }
  }
  async persistCapture(state, fullFrame, at) {
    await this.rootReady;
    if (!state.bytesKnown) {
      await this.ensureBytesKnown(state);
    }
    const recordAt = state.lastAt === null ? at : Math.max(state.lastAt, at);
    const base = state.base;
    let frame;
    if (base === null || fullFrame.reset !== undefined || state.deltasSinceCheckpoint >= this.checkpointCadence) {
      frame = fullFrame;
    } else {
      frame = chooseMuxOutputFrame2(fullFrame, base);
    }
    const record = {
      v: 1,
      session: state.session,
      at: recordAt,
      frame
    };
    let nextBase;
    let nextDeltaCount = state.deltasSinceCheckpoint;
    if (frame.type === "delta") {
      if (!shouldUseMuxDelta(fullFrame, frame) || base === null) {
        nextBase = splitMuxOutputData2(fullFrame.data);
        nextDeltaCount = 0;
      } else {
        const next = applyMuxDelta(base, frame);
        if (!next) {
          throw new Error("Unable to apply delta for persistent journal write.");
        }
        nextBase = next;
        nextDeltaCount = state.deltasSinceCheckpoint + 1;
      }
    } else {
      nextBase = splitMuxOutputData2(frame.data);
      nextDeltaCount = 0;
    }
    const line = `${JSON.stringify(record)}
`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.maxBytes !== Infinity && state.bytes + lineBytes > this.maxBytes) {
      this.refuseSessionLimit(state, recordAt, "maxBytes exceeded; session recording stopped.");
      return;
    }
    let claimedRoot = 0;
    if (this.maxRootBytes !== Infinity) {
      if (this.rootBytes + lineBytes > this.maxRootBytes) {
        this.reportRootLimit(state, recordAt);
        return;
      }
      this.adjustRootBytes(lineBytes);
      claimedRoot = lineBytes;
    }
    await this.storage.ensureDirectory(dirname3(state.path));
    try {
      await this.storage.appendText(state.path, line);
    } catch (cause) {
      if (claimedRoot > 0)
        this.adjustRootBytes(-claimedRoot);
      let rolledBack = false;
      if (state.bytesKnown && this.storage.truncate) {
        try {
          await this.storage.truncate(state.path, state.bytes);
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      if (!rolledBack) {
        state.recoveryFailed = true;
        state.accepting = false;
      }
      throw cause;
    }
    state.bytes += lineBytes;
    if (claimedRoot === 0)
      this.adjustRootBytes(lineBytes);
    state.base = nextBase;
    state.deltasSinceCheckpoint = nextDeltaCount;
    state.lastAt = recordAt;
    state.recordCount += 1;
  }
}
function completePrefixInfo(source) {
  const lastNewline = source.lastIndexOf(`
`);
  if (lastNewline === -1) {
    return { charLength: 0, byteLength: 0 };
  }
  const charLength = lastNewline + 1;
  return {
    charLength,
    byteLength: Buffer.byteLength(source.slice(0, charLength), "utf8")
  };
}
function hashSession(session) {
  if (typeof session !== "string")
    throw new Error("Frame journal session must be a string.");
  return createHash2("sha256").update(session, "utf8").digest("hex");
}
function isFileNotFound(cause) {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT");
}
function normalizeFullFrame(session, frame) {
  if (frame.type !== "output") {
    throw new Error("Frame journal only accepts output frames as captures.");
  }
  if (frame.channel !== session) {
    throw new Error("Frame journal capture channel must equal its session.");
  }
  if (typeof frame.data !== "string") {
    throw new Error("Frame journal capture data must be a string.");
  }
  const canonical = {
    channel: session,
    type: "output",
    data: frame.data
  };
  if (Object.prototype.hasOwnProperty.call(frame, "cursor")) {
    const cursor = frame.cursor;
    if (cursor === undefined) {} else if (cursor === null) {
      canonical.cursor = null;
    } else if (isFiniteIntegerCursor(cursor)) {
      canonical.cursor = { row: cursor.row, col: cursor.col };
    } else {
      throw new Error("Frame journal capture cursor must be {row:number,col:number} or null.");
    }
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    const reset = frame.reset;
    if (reset !== "resize" && reset !== "resync") {
      throw new Error('Frame journal capture reset must be "resize" or "resync".');
    }
    canonical.reset = reset;
  }
  return canonical;
}
function isFiniteIntegerCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value;
  if (Object.keys(cursor).length !== 2 || !Object.prototype.hasOwnProperty.call(cursor, "row") || !Object.prototype.hasOwnProperty.call(cursor, "col")) {
    return false;
  }
  return Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
}
function parseAndValidateJournal(source, expectedSession, checkpointCadence) {
  const lines = splitCompleteNdjsonLines(source);
  if (lines.length === 0) {
    return { base: [], lastAt: null, recordCount: 0, deltasSinceCheckpoint: 0 };
  }
  let currentBase = null;
  let deltaCount = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  let recordCount = 0;
  let lastAt = null;
  for (let i = 0;i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    if (rawLine.length === 0) {
      throw new Error(`Malformed blank line at NDJSON line ${lineNo}.`);
    }
    const record = parseJournalRecord(rawLine, lineNo);
    if (record.session !== expectedSession) {
      throw new Error(`Session mismatch at NDJSON line ${lineNo}: expected "${expectedSession}" but got "${record.session}".`);
    }
    if (!Number.isFinite(record.at)) {
      throw new Error(`Invalid at timestamp at NDJSON line ${lineNo}: must be finite.`);
    }
    if (record.at < previousAt) {
      throw new Error(`Out-of-order timestamp at NDJSON line ${lineNo}: ${record.at} < ${previousAt}.`);
    }
    if (record.frame.channel !== record.session) {
      throw new Error(`Session/channel mismatch at NDJSON line ${lineNo}: record.session="${record.session}" but frame.channel="${record.frame.channel}".`);
    }
    if (recordCount === 0 && record.frame.type === "delta") {
      throw new Error(`Invalid first record at NDJSON line ${lineNo}: journal must start with a full frame.`);
    }
    if (record.frame.type === "output") {
      currentBase = splitMuxOutputData2(record.frame.data);
      deltaCount = 0;
    } else {
      if (currentBase === null) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: no prior full frame available.`);
      }
      const next = applyMuxDelta(currentBase, record.frame);
      if (!next) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: apply failed against current base.`);
      }
      const candidate = {
        channel: expectedSession,
        type: "output",
        data: next.join(`
`)
      };
      if (Object.prototype.hasOwnProperty.call(record.frame, "cursor")) {
        candidate.cursor = record.frame.cursor;
      }
      if (!shouldUseMuxDelta(candidate, record.frame)) {
        throw new Error(`Invalid delta at NDJSON line ${lineNo}: candidate delta is not eligible under strict protocol semantics.`);
      }
      currentBase = next;
      deltaCount += 1;
      if (deltaCount > checkpointCadence) {
        throw new Error(`Checkpoint cadence exceeded at NDJSON line ${lineNo}: more than ${checkpointCadence} deltas follow one full frame.`);
      }
    }
    recordCount += 1;
    previousAt = record.at;
    lastAt = record.at;
  }
  return {
    base: currentBase ?? [],
    lastAt,
    recordCount,
    deltasSinceCheckpoint: deltaCount
  };
}
function splitCompleteNdjsonLines(source) {
  const lines = [];
  let start = 0;
  while (true) {
    const newline = source.indexOf(`
`, start);
    if (newline === -1)
      break;
    lines.push(source.slice(start, newline));
    start = newline + 1;
  }
  return lines;
}
function parseJournalRecord(rawLine, lineNo) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (cause) {
    throw new Error(`Malformed JSON at NDJSON line ${lineNo}: ${cause instanceof Error ? cause.message : "invalid JSON."}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid record at NDJSON line ${lineNo}: must be an object.`);
  }
  const record = parsed;
  const keys = Object.keys(record);
  const expected = ["v", "session", "at", "frame"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(`Invalid record shape at NDJSON line ${lineNo}: must contain exactly v, session, at, frame.`);
  }
  if (record.v !== 1) {
    throw new Error(`Invalid journal version at NDJSON line ${lineNo}: expected 1.`);
  }
  if (typeof record.session !== "string") {
    throw new Error(`Invalid session at NDJSON line ${lineNo}: expected a string session.`);
  }
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
    throw new Error(`Invalid at at NDJSON line ${lineNo}: expected a finite number.`);
  }
  const frame = parseFrame(record.frame, lineNo, record.session);
  return {
    v: 1,
    session: record.session,
    at: record.at,
    frame
  };
}
function parseFrame(value, lineNo, session) {
  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid frame at NDJSON line ${lineNo}: must be an object.`);
  }
  const frame = value;
  const type = frame.type;
  if (type === "output") {
    return parseFullFrame(frame, lineNo, session);
  }
  if (type === "delta") {
    return parseDeltaFrame(frame, lineNo, session);
  }
  throw new Error(`Invalid frame at NDJSON line ${lineNo}: unsupported frame type "${String(type)}".`);
}
function parseFullFrame(frame, lineNo, session) {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "data", "cursor", "reset"]);
  const required = ["channel", "type", "data"];
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid full frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "output" || typeof frame.type !== "string") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: expected type "output".`);
  }
  if (typeof frame.data !== "string") {
    throw new Error(`Invalid full frame at NDJSON line ${lineNo}: data must be a string.`);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    if (frame.reset !== "resize" && frame.reset !== "resync") {
      throw new Error(`Invalid full frame at NDJSON line ${lineNo}: reset must be "resize" or "resync".`);
    }
  }
  const cursor = parseOptionalCursor(frame, lineNo, "full frame");
  const parsed = {
    channel: session,
    type: "output",
    data: frame.data
  };
  if (cursor !== undefined)
    parsed.cursor = cursor;
  if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
    parsed.reset = frame.reset === "resize" || frame.reset === "resync" ? frame.reset : undefined;
  }
  return parsed;
}
function parseDeltaFrame(frame, lineNo, session) {
  const keys = Object.keys(frame);
  const allowed = new Set(["channel", "type", "baseLength", "prefix", "prefixHash", "lines", "cursor"]);
  const required = ["channel", "type", "baseLength", "prefix", "prefixHash", "lines"];
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid delta frame keys at NDJSON line ${lineNo}: unexpected property "${keys.find((key) => !allowed.has(key))}".`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(frame, key)) {
      throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: missing "${key}".`);
    }
  }
  if (typeof frame.channel !== "string" || frame.channel !== session) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: channel must equal record.session.`);
  }
  if (frame.type !== "delta" || typeof frame.type !== "string") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: expected type "delta".`);
  }
  if (typeof frame.baseLength !== "number" || !Number.isInteger(frame.baseLength) || frame.baseLength < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: baseLength must be a non-negative integer.`);
  }
  if (typeof frame.prefix !== "number" || !Number.isInteger(frame.prefix) || frame.prefix < 0) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefix must be a non-negative integer.`);
  }
  if (typeof frame.prefixHash !== "string") {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefixHash must be a string.`);
  }
  if (!Array.isArray(frame.lines) || !frame.lines.every((line) => typeof line === "string")) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: lines must be string[].`);
  }
  const cursor = parseOptionalCursor(frame, lineNo, "delta frame");
  if (frame.baseLength < 0 || frame.prefix > frame.baseLength) {
    throw new Error(`Invalid delta frame at NDJSON line ${lineNo}: prefix must be <= baseLength.`);
  }
  return {
    channel: frame.channel,
    type: "delta",
    baseLength: frame.baseLength,
    prefix: frame.prefix,
    prefixHash: frame.prefixHash,
    lines: frame.lines.slice(),
    ...Object.prototype.hasOwnProperty.call(frame, "cursor") ? { cursor } : {}
  };
}
function parseOptionalCursor(frame, lineNo, frameKind) {
  if (!Object.prototype.hasOwnProperty.call(frame, "cursor"))
    return;
  const value = frame.cursor;
  if (value === null)
    return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`);
  }
  const cursor = value;
  if (Object.keys(cursor).length !== 2 || !Number.isInteger(cursor.row) || !Number.isInteger(cursor.col)) {
    throw new Error(`Invalid ${frameKind} at NDJSON line ${lineNo}: cursor must be {row:number,col:number} or null.`);
  }
  return {
    row: cursor.row,
    col: cursor.col
  };
}
// src/token-guard.ts
import { createHash as createHash3, timingSafeEqual } from "node:crypto";
var ERROR_TEXT = {
  missing_credential: "authentication required",
  malformed_credential: "malformed credential",
  invalid_credential: "invalid credential",
  expired_credential: "credential expired",
  forbidden_scope: "insufficient scope",
  forbidden_session: "session denied",
  forbidden_operation: "operation denied"
};
var DEFAULT_COOKIE_NAME = "tmux_demo_t";
var DEFAULT_QUERY_PARAM = "t";
var DEFAULT_QUERY_COOKIE_SAFE = "<redacted>";
var SAFE_COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeDecode(value, plusAsSpace = true) {
  try {
    const normalized = plusAsSpace ? value.replace(/\+/g, "%20") : value;
    const decoded = decodeURIComponent(normalized);
    return decoded.includes("\r") || decoded.includes(`
`) ? null : decoded;
  } catch {
    return null;
  }
}
function parseQueryPairs(search) {
  if (!search)
    return [];
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query)
    return [];
  const segments = query.split("&");
  const pairs = [];
  for (const segment of segments) {
    if (!segment)
      return null;
    const eq = segment.indexOf("=");
    if (eq < 0)
      return null;
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null)
      return null;
    if (!name)
      return null;
    pairs.push({ name, value });
  }
  return pairs;
}
function parseSingleQueryValue(search, expected) {
  const parsed = parseQueryPairs(search);
  if (parsed === null)
    return { malformed: true };
  const matches = parsed.filter((entry) => entry.name === expected);
  if (matches.length === 0)
    return { malformed: false };
  if (matches.length !== 1)
    return { malformed: true };
  return { value: matches[0].value, malformed: false };
}
function extractQueryCredential(search, tokenParam) {
  if (!search)
    return { kind: "absent" };
  const query = search.startsWith("?") ? search.slice(1) : search;
  const segments = query.split("&");
  let hasQueryToken = false;
  let tokenValue;
  let tokenCount = 0;
  let malformed = false;
  for (const segment of segments) {
    if (!segment) {
      malformed = true;
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq < 0) {
      const rawName2 = segment;
      const name2 = safeDecode(rawName2);
      if (name2 === null) {
        malformed = true;
        continue;
      }
      if (name2 === tokenParam)
        return { kind: "invalid" };
      continue;
    }
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null || !name) {
      if (name === tokenParam)
        return { kind: "invalid" };
      malformed = true;
      continue;
    }
    if (name === tokenParam) {
      hasQueryToken = true;
      tokenCount += 1;
      tokenValue = value;
    }
  }
  if (!hasQueryToken)
    return { kind: "absent" };
  if (malformed)
    return { kind: "invalid" };
  if (tokenCount !== 1 || tokenValue === "")
    return { kind: "invalid" };
  return { kind: "valid", value: tokenValue ?? "" };
}
function parseCookieHeader(header, cookieName) {
  if (!header)
    return { kind: "absent" };
  const segments = header.split(";");
  let matches = 0;
  let tokenValue = null;
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment)
      return { kind: "invalid" };
    const eq = segment.indexOf("=");
    if (eq <= 0)
      return { kind: "invalid" };
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    if (rawName !== cookieName)
      continue;
    const value = safeDecode(rawValue, false);
    if (value === null)
      return { kind: "invalid" };
    if (matches >= 1)
      return { kind: "invalid" };
    tokenValue = value;
    matches += 1;
  }
  if (matches === 0)
    return { kind: "absent" };
  return { kind: "valid", value: tokenValue };
}
function sessionsEqual(a, b) {
  if (a === b)
    return true;
  if (a === undefined || b === undefined)
    return false;
  if (a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i++) {
    if (a[i] !== b[i])
      return false;
  }
  return true;
}
function principalMatchesGrant(principal, grant) {
  return principal.scope === grant.scope && principal.expiresAt === grant.expiresAt && sessionsEqual(principal.sessions, grant.sessions);
}
function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function isNonEmptySession(value) {
  return typeof value === "string" && value.length > 0;
}
function extractSession(row) {
  if (typeof row === "string")
    return row;
  if (typeof row !== "object" || row === null)
    return null;
  const candidate = row;
  return typeof candidate.name === "string" ? candidate.name : null;
}
function isTokenScope(value) {
  return value === "read" || value === "interactive";
}
function isTokenPermission(value) {
  return value === "sessions-kill";
}
function hasValidSessions(value) {
  return value === undefined || Array.isArray(value) && value.every((session) => typeof session === "string" && session.length > 0);
}
function hasValidPermissions(value) {
  return value === undefined || Array.isArray(value) && value.every(isTokenPermission);
}
function isValidGrant(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const grant = value;
  return typeof grant.token === "string" && grant.token.length > 0 && !/[\r\n]/.test(grant.token) && isTokenScope(grant.scope) && Number.isFinite(grant.expiresAt) && hasValidSessions(grant.sessions) && hasValidPermissions(grant.permissions);
}
function isValidPrincipal(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const principal = value;
  return isTokenScope(principal.scope) && Number.isFinite(principal.expiresAt) && hasValidSessions(principal.sessions);
}
function tokenDigest(token) {
  return createHash3("sha256").update(token, "utf8").digest();
}
function createTokenGuard(options) {
  const grants = options.grants ?? [];
  const queryParamName = options.queryParamName ?? DEFAULT_QUERY_PARAM;
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const now = options.now ?? Date.now;
  const redactionPlaceholder = options.redactionPlaceholder ?? DEFAULT_QUERY_COOKIE_SAFE;
  if (!queryParamName || /[\r\n]/.test(queryParamName)) {
    throw new Error("token guard: invalid queryParamName");
  }
  if (!SAFE_COOKIE_NAME.test(cookieName)) {
    throw new Error("token guard: invalid cookieName");
  }
  if (!Array.isArray(grants) || grants.some((grant) => !isValidGrant(grant))) {
    throw new Error("token guard: invalid grant configuration");
  }
  const configuredTokens = new Set(grants.map((grant) => grant.token));
  if (configuredTokens.size !== grants.length) {
    throw new Error("token guard: duplicate grant configuration");
  }
  const revokedState = new WeakMap;
  const snapshots = [];
  for (const grant of grants) {
    const token = grant.token;
    const scope = grant.scope;
    const expiresAt = grant.expiresAt;
    const sessions = grant.sessions;
    const permissions = grant.permissions;
    const snapshot = {
      token,
      scope,
      expiresAt,
      sessions: sessions === undefined ? undefined : Object.freeze([...sessions]),
      permissions: permissions === undefined ? undefined : Object.freeze([...permissions]),
      digest: tokenDigest(token),
      get revoked() {
        return revokedState.get(this) ?? false;
      },
      set revoked(value) {
        revokedState.set(this, value);
      }
    };
    Object.freeze(snapshot);
    snapshots.push(snapshot);
  }
  const redactionTokens = snapshots.map((s) => s.token);
  const issuedPrincipals = new WeakMap;
  const shouldUseSecureCookie = (request) => {
    if (options.cookieSecure === undefined) {
      const xfp = request.headers.get("x-forwarded-proto");
      if (xfp && /\bhttps\b/i.test(xfp.split(",")[0]?.trim() ?? ""))
        return true;
      const protocol = new URL(request.url).protocol;
      return protocol === "https:";
    }
    if (typeof options.cookieSecure === "boolean")
      return options.cookieSecure;
    return options.cookieSecure(request);
  };
  const isExpiredGrant = (grant) => {
    const currentTime = now();
    return !Number.isFinite(currentTime) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= currentTime;
  };
  const locateGrant = (token) => {
    const candidate = tokenDigest(token);
    let hit;
    for (const snapshot of snapshots) {
      if (timingSafeEqual(candidate, snapshot.digest)) {
        hit = snapshot;
      }
    }
    return hit;
  };
  const findGrantByToken = (token) => {
    const grant = locateGrant(token);
    if (!grant || grant.revoked)
      return;
    return grant;
  };
  const mintPrincipal = (grant) => {
    const principal = Object.freeze({
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      sessions: grant.sessions
    });
    issuedPrincipals.set(principal, grant);
    return principal;
  };
  const resolveActiveGrant = (principal) => {
    if (!isValidPrincipal(principal))
      return;
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined)
      return;
    if (!principalMatchesGrant(principal, grant))
      return;
    if (grant.revoked)
      return;
    return grant;
  };
  const isSessionAllowed = (principal, session) => {
    if (typeof session !== "string" || session.length === 0)
      return false;
    const grant = resolveActiveGrant(principal);
    if (grant === undefined || isExpiredGrant(grant))
      return false;
    if (grant.sessions === undefined)
      return true;
    if (grant.sessions.length === 0)
      return false;
    return grant.sessions.includes(session);
  };
  const hasPermission = (principal, permission) => resolveActiveGrant(principal)?.permissions?.includes(permission) === true;
  const sanitizePrincipal = (principal) => {
    const grant = issuedPrincipals.get(principal);
    if (!isValidPrincipal(principal) || grant === undefined || grant.revoked || !principalMatchesGrant(principal, grant)) {
      throw new Error("token guard: invalid principal");
    }
    return mintPrincipal(grant);
  };
  const createSocketPrincipal = (grant) => {
    const configuredGrant = isValidGrant(grant) ? findGrantByToken(grant.token) : undefined;
    if (!configuredGrant) {
      throw new Error("token guard: invalid configured grant");
    }
    return mintPrincipal(configuredGrant);
  };
  const makeCookieHeader = (grant, req) => {
    const snapshot = isValidGrant(grant) ? findGrantByToken(grant.token) : undefined;
    if (!snapshot) {
      throw new Error("token guard: invalid token value for cookie encoding");
    }
    const encoded = encodeURIComponent(snapshot.token);
    const remainingMs = snapshot.expiresAt - now();
    const maxAgeSeconds = Number.isFinite(remainingMs) ? Math.max(0, Math.floor(remainingMs / 1000)) : 0;
    let cookie = `${cookieName}=${encoded}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
    if (shouldUseSecureCookie(req))
      cookie += "; Secure";
    if (/\r|\n/.test(cookie)) {
      throw new Error("token guard: refused unsafe cookie header generation");
    }
    return cookie;
  };
  const redact = (text) => {
    if (!text)
      return text;
    let output = text;
    const genericQueryCredential = new RegExp(`(^|[?&])${escapeRegex(queryParamName)}=[^&#\\s]*`, "gi");
    const genericCookieCredential = new RegExp(`(^|[;,\\s])(${escapeRegex(cookieName)}\\s*=\\s*)[^;\\s]*`, "gi");
    output = output.replace(genericQueryCredential, `$1${redactionPlaceholder}`);
    output = output.replace(genericCookieCredential, `$1$2${redactionPlaceholder}`);
    for (const token of redactionTokens) {
      const encoded = encodeURIComponent(token);
      output = output.replaceAll(token, redactionPlaceholder);
      output = output.replaceAll(encoded, redactionPlaceholder);
    }
    return output;
  };
  const fail401 = (code) => ({
    ok: false,
    status: 401,
    code,
    message: ERROR_TEXT[code]
  });
  const fail403 = (code) => ({
    ok: false,
    status: 403,
    code,
    message: ERROR_TEXT[code]
  });
  const guardAuthenticateFailure = (request, source, result) => {
    switch (result.kind) {
      case "absent":
        return fail401(source === "query" ? "missing_credential" : "missing_credential");
      case "invalid":
        return fail401(source === "query" ? "malformed_credential" : "malformed_credential");
      case "not-found":
        return fail401(source === "query" ? "invalid_credential" : "invalid_credential");
      case "expired":
        return fail401("expired_credential");
      default:
        return fail401("missing_credential");
    }
  };
  const authenticate = (request) => {
    const token = extractQueryCredential(new URL(request.url).search, queryParamName);
    if (token.kind === "valid") {
      const grant2 = findGrantByToken(token.value);
      if (!grant2)
        return guardAuthenticateFailure(request, "query", { kind: "not-found" });
      if (isExpiredGrant(grant2)) {
        return guardAuthenticateFailure(request, "query", { kind: "expired" });
      }
      return {
        ok: true,
        status: 200,
        source: "query",
        principal: mintPrincipal(grant2),
        setCookie: makeCookieHeader(grant2, request)
      };
    }
    if (token.kind === "invalid") {
      return guardAuthenticateFailure(request, "query", { kind: "invalid" });
    }
    const cookie = parseCookieHeader(request.headers.get("cookie") ?? "", cookieName);
    if (cookie.kind === "absent") {
      return guardAuthenticateFailure(request, "cookie", { kind: "absent" });
    }
    if (cookie.kind === "invalid") {
      return guardAuthenticateFailure(request, "cookie", { kind: "invalid" });
    }
    const grant = findGrantByToken(cookie.value);
    if (!grant) {
      return guardAuthenticateFailure(request, "cookie", { kind: "not-found" });
    }
    if (isExpiredGrant(grant)) {
      return guardAuthenticateFailure(request, "cookie", { kind: "expired" });
    }
    return {
      ok: true,
      status: 200,
      source: "cookie",
      principal: mintPrincipal(grant)
    };
  };
  const ensureActivePrincipal = (principal) => {
    if (!isValidPrincipal(principal))
      return fail401("invalid_credential");
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined || !principalMatchesGrant(principal, grant)) {
      return fail401("invalid_credential");
    }
    if (grant.revoked)
      return fail401("invalid_credential");
    if (isExpiredGrant(grant))
      return fail401("expired_credential");
    return null;
  };
  const revoke = (token) => {
    if (typeof token !== "string" || token.length === 0)
      return false;
    const grant = locateGrant(token);
    if (!grant || grant.revoked)
      return false;
    grant.revoked = true;
    return true;
  };
  const authorizeHttp = (request, principal, context = {}) => {
    const expired = ensureActivePrincipal(principal);
    if (expired)
      return expired;
    const safePrincipal = sanitizePrincipal(principal);
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const path = url.pathname;
    let operation = context.operation;
    let inferredSession;
    let inferredRecordingId;
    if (operation === undefined) {
      if (method === "GET" && (path === "/ws" || path.startsWith("/ws/"))) {
        operation = "ws-upgrade";
      } else if (!path.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD")
          return fail403("forbidden_operation");
        operation = "static";
      } else if (method === "GET" && (path === "/api/auth" || path === "/api/auth/description")) {
        operation = "auth-description";
      } else if (method === "GET" && path === "/api/sessions") {
        operation = "sessions-list";
      } else if (method === "POST" && (path === "/api/spawn" || path === "/api/sessions")) {
        operation = "sessions-spawn";
      } else if (method === "GET" && path === "/api/prefs") {
        operation = "prefs-read";
      } else if ((method === "PUT" || method === "POST") && path === "/api/prefs") {
        operation = "prefs-write";
      } else if (method === "POST" && (path === "/api/upload" || path === "/api/uploads")) {
        operation = "upload";
      } else if (method === "GET" && path === "/api/recordings") {
        operation = "recordings-list";
      } else if (method === "POST" && path === "/api/recordings/start") {
        operation = "recording-start";
      } else if (method === "POST" && path === "/api/recordings/stop") {
        operation = "recording-stop";
      } else {
        const lifecycle = /^\/api\/sessions\/([^/]+)\/recording\/(start|stop)$/.exec(path);
        const download = /^\/api\/recordings\/([^/]+)\/download$/.exec(path);
        if (method === "POST" && lifecycle) {
          inferredSession = decodePathSegment(lifecycle[1] ?? "") ?? undefined;
          operation = lifecycle[2] === "start" ? "recording-start" : "recording-stop";
        } else if (method === "GET" && download) {
          inferredRecordingId = decodePathSegment(download[1] ?? "") ?? undefined;
          operation = "recordings-download";
        } else {
          return fail403("forbidden_operation");
        }
      }
    }
    if (operation === "static" || operation === "auth-description" || operation === "ws-upgrade" || operation === "sessions-list" || operation === "prefs-read") {
      return { ok: true, status: 200, operation };
    }
    if (operation === "sessions-spawn") {
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (safePrincipal.sessions !== undefined)
        return fail403("forbidden_scope");
      return { ok: true, status: 200, operation };
    }
    if (operation === "sessions-kill") {
      if (!isNonEmptySession(context.session))
        return fail403("forbidden_operation");
      if (safePrincipal.scope !== "interactive" || !hasPermission(safePrincipal, "sessions-kill")) {
        return fail403("forbidden_scope");
      }
      if (safePrincipal.sessions === undefined || !isSessionAllowed(safePrincipal, context.session)) {
        return fail403("forbidden_session");
      }
      return { ok: true, status: 200, operation, session: context.session };
    }
    if (operation === "prefs-write") {
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      return { ok: true, status: 200, operation };
    }
    if (operation === "upload") {
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (context.session !== undefined) {
        if (!isNonEmptySession(context.session))
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, context.session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "upload", session: context.session };
      }
      return { ok: true, status: 200, operation: "upload" };
    }
    if (operation === "recordings-list") {
      const parsed = parseSingleQueryValue(url.search, "session");
      if (parsed.malformed)
        return fail403("forbidden_operation");
      if (context.session !== undefined && parsed.value !== undefined && context.session !== parsed.value) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? parsed.value;
      if (!isNonEmptySession(session))
        return fail403("forbidden_operation");
      if (!isSessionAllowed(safePrincipal, session))
        return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }
    if (operation === "recording-start" || operation === "recording-stop") {
      if (context.session !== undefined && inferredSession !== undefined && context.session !== inferredSession) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? inferredSession;
      if (!isNonEmptySession(session))
        return fail403("forbidden_operation");
      if (safePrincipal.scope !== "interactive")
        return fail403("forbidden_scope");
      if (!isSessionAllowed(safePrincipal, session))
        return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }
    if (operation === "recordings-download") {
      if (context.recordingId !== undefined && inferredRecordingId !== undefined && context.recordingId !== inferredRecordingId) {
        return fail403("forbidden_operation");
      }
      const recordingId = context.recordingId ?? inferredRecordingId;
      if (!isNonEmptySession(recordingId))
        return fail403("forbidden_operation");
      let resolved;
      if (options.recordingSessionResolver) {
        try {
          const raw = options.recordingSessionResolver(recordingId);
          resolved = typeof raw === "string" && raw.length > 0 ? raw : undefined;
        } catch {
          return fail403("forbidden_operation");
        }
      }
      if (context.session !== undefined && resolved !== undefined && context.session !== resolved) {
        return fail403("forbidden_operation");
      }
      const session = resolved ?? context.session;
      if (safePrincipal.sessions !== undefined) {
        if (!isNonEmptySession(session) || !isSessionAllowed(safePrincipal, session)) {
          return fail403("forbidden_session");
        }
      }
      return { ok: true, status: 200, operation, session: session ?? recordingId };
    }
    return fail403("forbidden_operation");
  };
  const authorizeMuxMessage = (message, principal) => {
    const expired = ensureActivePrincipal(principal);
    if (expired)
      return expired;
    const safePrincipal = sanitizePrincipal(principal);
    const raw = message;
    if (typeof raw !== "object" || raw === null || typeof raw.type !== "string") {
      return fail403("forbidden_operation");
    }
    const type = raw.type;
    switch (type) {
      case "ping":
      case "client_info":
      case "sessions_subscribe":
      case "sessions_unsubscribe":
        return {
          ok: true,
          status: 200,
          operation: type
        };
      case "subscribe":
      case "unsubscribe":
      case "history_expand":
      case "resync": {
        const session = raw.session;
        if (!isNonEmptySession(session))
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: type, session };
      }
      case "keys": {
        if (safePrincipal.scope !== "interactive")
          return fail403("forbidden_scope");
        const session = raw.session;
        const data = raw.data;
        if (!isNonEmptySession(session) || typeof data !== "string")
          return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "keys", session };
      }
      case "resize": {
        if (safePrincipal.scope !== "interactive")
          return fail403("forbidden_scope");
        const session = raw.session;
        const cols = raw.cols;
        const rows = raw.rows;
        if (!isNonEmptySession(session) || !isInteger(cols) || !isInteger(rows) || cols <= 0 || rows <= 0) {
          return fail403("forbidden_operation");
        }
        if (!isSessionAllowed(safePrincipal, session))
          return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "resize", session };
      }
      default:
        return fail403("forbidden_operation");
    }
  };
  const filterSessions = (sessions, principal, nameOf = extractSession) => {
    if (ensureActivePrincipal(principal))
      return [];
    const safePrincipal = sanitizePrincipal(principal);
    if (safePrincipal.sessions === undefined)
      return [...sessions];
    if (safePrincipal.sessions.length === 0)
      return [];
    const allow = new Set(safePrincipal.sessions);
    return sessions.filter((item) => {
      const name = nameOf(item);
      return typeof name === "string" && allow.has(name);
    });
  };
  const wrapped = {
    options: {
      queryParamName,
      cookieName,
      redactionPlaceholder
    },
    authenticate,
    authorizeHttp,
    authorizeMuxMessage: (message, principal) => authorizeMuxMessage(message, principal),
    createSocketPrincipal,
    sanitizePrincipal,
    isSessionAllowed,
    filterSessions: (sessions, principal, nameOf) => filterSessions(sessions, principal, nameOf),
    makeCookieHeader: (grant, req) => makeCookieHeader(grant, req),
    redact: (text) => redact(text),
    revoke
  };
  return wrapped;
}
// src/history-archive.ts
import { createHash as createHash4, randomUUID as randomUUID3 } from "node:crypto";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync5,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  unlinkSync as unlinkSync2,
  writeFileSync
} from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { basename as basename2, join as join6 } from "node:path";
var DEFAULT_MAX_LINES = 20000;
var PRIVATE_DIRECTORY_MODE2 = 448;
var PRIVATE_FILE_MODE2 = 384;
function sessionKey(session) {
  return createHash4("sha256").update(session).digest("hex");
}
function limitAtLeastOne(value, fallback) {
  if (!Number.isFinite(value))
    return fallback;
  return Math.max(1, Math.floor(value));
}
function archiveCap(value) {
  if (!Number.isFinite(value))
    return DEFAULT_MAX_LINES;
  return Math.max(0, Math.floor(value));
}
function defaultArchiveRoot() {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : sessionKey(process.env.USER || process.env.USERNAME || "unknown-user").slice(0, 12);
  return join6(tmpdir2(), `thumbmux-history-u${user}-run-${process.pid}-${randomUUID3()}`);
}
function captureLines(content) {
  const terminated = content.endsWith(`
`) ? content.slice(0, -1) : content;
  if (terminated === "")
    return [];
  const lines = terminated.split(`
`);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "")
    lines.pop();
  return lines;
}
function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
function commonPrefixLength(left, right) {
  const shortest = Math.min(left.length, right.length);
  let common = 0;
  while (common < shortest && left[common] === right[common])
    common++;
  return common;
}
var CAPTURE_TAIL_REWRITE_ROWS = 2;
function looksLikeTailRepaint(previous, next) {
  const shortest = Math.min(previous.length, next.length);
  if (shortest === 0)
    return true;
  return commonPrefixLength(previous, next) >= Math.max(1, shortest - CAPTURE_TAIL_REWRITE_ROWS);
}
function minimumReliableOverlap(previous, next) {
  const shortest = Math.min(previous.length, next.length);
  if (shortest <= 1)
    return 2;
  return Math.min(shortest, Math.max(2, Math.min(8, Math.ceil(shortest / 2))));
}
function stableScrollDeparture(previous, next, maxTailRewrite = CAPTURE_TAIL_REWRITE_ROWS) {
  const exact = stableOverlap(previous, next);
  if (exact > 0) {
    return { overlap: exact, departed: previous.length - exact };
  }
  const tailMax = Math.min(Math.max(0, Math.floor(maxTailRewrite)), Math.max(0, previous.length - 1));
  for (let tail = 1;tail <= tailMax; tail++) {
    const prevStable = previous.slice(0, previous.length - tail);
    const overlap = stableOverlap(prevStable, next);
    if (overlap > 0) {
      return { overlap, departed: prevStable.length - overlap };
    }
  }
  return null;
}
function emptyState() {
  return {
    entries: [],
    initialized: false,
    live: [],
    liveStart: 0,
    nextLine: 0,
    disabled: false
  };
}
function stableOverlap(previous, next) {
  const longest = Math.min(previous.length, next.length);
  for (let size = longest;size > 0; size--) {
    let matches = true;
    for (let i = 0;i < size; i++) {
      if (previous[previous.length - size + i] !== next[i]) {
        matches = false;
        break;
      }
    }
    if (matches)
      return size;
  }
  return 0;
}
function uniqueWindowStart(lines, needle) {
  if (needle.length === 0 || lines.length < needle.length)
    return null;
  const latestStart = lines.length - needle.length;
  let found = null;
  for (let start = 0;start <= latestStart; start++) {
    let matches = true;
    for (let i = 0;i < needle.length; i++) {
      if (lines[start + i] !== needle[i]) {
        matches = false;
        break;
      }
    }
    if (!matches)
      continue;
    if (found !== null)
      return null;
    found = start;
  }
  return found;
}

class FileHistoryArchive {
  root;
  maxLines;
  storageReady;
  states = new Map;
  constructor(options = {}) {
    this.root = options.root || defaultArchiveRoot();
    this.maxLines = archiveCap(options.maxLines);
    try {
      this.secureRoot();
      this.storageReady = true;
    } catch {
      this.storageReady = false;
    }
  }
  ingestSnapshot(session, content, opts) {
    const liveLimit = limitAtLeastOne(opts.liveLineLimit, 1);
    const captured = captureLines(content);
    const nextLive = captured.slice(-liveLimit);
    const state = this.stateFor(session);
    if (state.disabled)
      return { liveContent: nextLive.join(`
`) };
    try {
      let entriesChanged = false;
      if (!state.initialized) {
        const splitAt = opts.fullHistory ? Math.max(0, captured.length - liveLimit) : 0;
        const initialLive = opts.fullHistory ? nextLive : captured.slice(-liveLimit);
        state.entries = opts.fullHistory ? captured.slice(0, splitAt).map((text, line) => ({ line, text })) : [];
        state.live = initialLive;
        state.liveStart = splitAt;
        state.nextLine = splitAt + initialLive.length;
        state.initialized = true;
        entriesChanged = true;
      } else {
        if (sameLines(state.live, nextLive)) {
          return { liveContent: state.live.join(`
`) };
        }
        let reconciledFullHistory = false;
        if (opts.fullHistory) {
          const splitAt = Math.max(0, captured.length - nextLive.length);
          const matchStart = uniqueWindowStart(captured, state.live);
          if (matchStart !== null && matchStart < splitAt) {
            const departed = captured.slice(matchStart, splitAt);
            for (let i = 0;i < departed.length; i++) {
              state.entries.push({ line: state.liveStart + i, text: departed[i] });
            }
            state.liveStart += departed.length;
            entriesChanged = departed.length > 0;
            reconciledFullHistory = true;
          }
        }
        if (!reconciledFullHistory && !opts.replace) {
          const match = looksLikeTailRepaint(state.live, nextLive) ? null : stableScrollDeparture(state.live, nextLive);
          if (match !== null && match.overlap >= minimumReliableOverlap(state.live, nextLive) && match.departed > 0) {
            const leavingCount = match.departed;
            for (let i = 0;i < leavingCount; i++) {
              state.entries.push({ line: state.liveStart + i, text: state.live[i] });
            }
            state.liveStart += leavingCount;
            entriesChanged = true;
          }
        }
        state.live = nextLive;
        state.nextLine = state.liveStart + nextLive.length;
      }
      entriesChanged = this.evict(state) || entriesChanged;
      this.persist(session, state, entriesChanged);
      return { liveContent: state.live.join(`
`) };
    } catch {
      state.disabled = true;
      return { liveContent: nextLive.join(`
`) };
    }
  }
  readBefore(session, beforeLine, limit = 500) {
    const state = this.stateFor(session);
    if (state.disabled || state.entries.length === 0) {
      return { lines: [], startLine: null, hasMore: false };
    }
    const upperBound = Number.isSafeInteger(beforeLine) ? Math.min(beforeLine, state.liveStart) : state.liveStart;
    const available = state.entries.filter((entry) => entry.line < upperBound);
    if (available.length === 0)
      return { lines: [], startLine: null, hasMore: false };
    const pageLimit = limitAtLeastOne(limit, 500);
    const page = available.slice(-pageLimit);
    return {
      lines: page.map((entry) => entry.text),
      startLine: page[0].line,
      hasMore: available.length > page.length
    };
  }
  readAfter(session, afterLine, limit = 500) {
    const state = this.stateFor(session);
    if (state.disabled || state.entries.length === 0) {
      return { lines: [], startLine: null, hasMore: false };
    }
    let first = 0;
    if (Number.isSafeInteger(afterLine)) {
      let low = 0;
      let high = state.entries.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (state.entries[middle].line <= afterLine)
          low = middle + 1;
        else
          high = middle;
      }
      first = low;
    }
    if (first >= state.entries.length) {
      return { lines: [], startLine: null, hasMore: false };
    }
    const pageLimit = limitAtLeastOne(limit, 500);
    const end = Math.min(first + pageLimit, state.entries.length);
    const page = state.entries.slice(first, end);
    return {
      lines: page.map((entry) => entry.text),
      startLine: page[0].line,
      hasMore: end < state.entries.length
    };
  }
  renameSession(oldSession, newSession) {
    if (oldSession === newSession)
      return;
    const oldState = this.states.get(oldSession);
    this.states.delete(newSession);
    if (oldState)
      this.states.set(newSession, oldState);
    this.states.delete(oldSession);
    const oldPaths = this.paths(oldSession);
    const newPaths = this.paths(newSession);
    try {
      this.removeFiles(newPaths);
      this.moveIfPresent(oldPaths.data, newPaths.data);
      this.moveIfPresent(oldPaths.meta, newPaths.meta);
    } catch {
      if (oldState)
        oldState.disabled = true;
    }
  }
  dropSession(session) {
    this.states.delete(session);
    if (!this.storageReady)
      return;
    this.removeFiles(this.paths(session));
  }
  stateFor(session) {
    const cached = this.states.get(session);
    if (cached)
      return cached;
    const state = this.load(session);
    this.states.set(session, state);
    return state;
  }
  load(session) {
    if (!this.storageReady)
      return { ...emptyState(), disabled: true };
    const paths = this.paths(session);
    const hasData = existsSync5(paths.data);
    const hasMeta = existsSync5(paths.meta);
    if (!hasData && !hasMeta)
      return emptyState();
    if (!hasData || !hasMeta)
      return { ...emptyState(), disabled: true };
    try {
      this.secureRoot();
      this.secureFile(paths.data);
      this.secureFile(paths.meta);
      const rawData = readFileSync3(paths.data, "utf8");
      if (rawData !== "" && !rawData.endsWith(`
`))
        throw new Error("partial archive record");
      const entries = rawData === "" ? [] : rawData.slice(0, -1).split(`
`).map((record) => this.parseEntry(record));
      const meta = JSON.parse(readFileSync3(paths.meta, "utf8"));
      if (!this.validMeta(meta) || !this.validEntries(entries, meta.liveStart))
        throw new Error("invalid archive state");
      const state = {
        entries,
        initialized: true,
        live: meta.live,
        liveStart: meta.liveStart,
        nextLine: meta.nextLine,
        disabled: false
      };
      if (this.evict(state))
        this.persist(session, state, true);
      return state;
    } catch {
      return { ...emptyState(), disabled: true };
    }
  }
  parseEntry(record) {
    const value = JSON.parse(record);
    if (!Number.isSafeInteger(value.line) || value.line < 0 || typeof value.text !== "string") {
      throw new Error("invalid archive record");
    }
    return { line: value.line, text: value.text };
  }
  validMeta(meta) {
    return meta?.v === 1 && Array.isArray(meta.live) && meta.live.every((line) => typeof line === "string") && Number.isSafeInteger(meta.liveStart) && meta.liveStart >= 0 && Number.isSafeInteger(meta.nextLine) && meta.nextLine === meta.liveStart + meta.live.length;
  }
  validEntries(entries, liveStart) {
    return entries.every((entry, index) => {
      const previous = entries[index - 1];
      return entry.line < liveStart && (!previous || previous.line + 1 === entry.line);
    });
  }
  evict(state) {
    if (state.entries.length > this.maxLines) {
      state.entries.splice(0, state.entries.length - this.maxLines);
      return true;
    }
    return false;
  }
  persist(session, state, entriesChanged) {
    const paths = this.paths(session);
    this.secureRoot();
    const meta = {
      v: 1,
      live: state.live,
      liveStart: state.liveStart,
      nextLine: state.nextLine
    };
    if (entriesChanged || !existsSync5(paths.data)) {
      const data = state.entries.map((entry) => JSON.stringify(entry)).join(`
`);
      this.writeAtomically(paths.data, data === "" ? "" : `${data}
`);
    }
    this.writeAtomically(paths.meta, JSON.stringify(meta));
  }
  paths(session) {
    const key = sessionKey(session);
    return {
      data: join6(this.root, `history-${key}.jsonl`),
      meta: join6(this.root, `history-${key}.json`)
    };
  }
  writeAtomically(path, data) {
    const temporary = join6(this.root, `.${basename2(path)}.${randomUUID3()}.tmp`);
    try {
      writeFileSync(temporary, data, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE2
      });
      chmodSync3(temporary, PRIVATE_FILE_MODE2);
      renameSync2(temporary, path);
      chmodSync3(path, PRIVATE_FILE_MODE2);
    } finally {
      if (existsSync5(temporary))
        unlinkSync2(temporary);
    }
  }
  moveIfPresent(source, destination) {
    if (existsSync5(source)) {
      renameSync2(source, destination);
      this.secureFile(destination);
    }
  }
  removeFiles(paths) {
    rmSync2(paths.data, { force: true });
    rmSync2(paths.meta, { force: true });
  }
  secureRoot() {
    mkdirSync3(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE2 });
    chmodSync3(this.root, PRIVATE_DIRECTORY_MODE2);
  }
  secureFile(path) {
    chmodSync3(path, PRIVATE_FILE_MODE2);
  }
}
// src/history-stitch.ts
function locateAnchor(hay, needle) {
  if (needle.length === 0 || hay.length < needle.length)
    return "missing";
  let found = -1;
  for (let start = 0;start <= hay.length - needle.length; start++) {
    let matches = true;
    for (let index = 0;index < needle.length; index++) {
      if (hay[start + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (!matches)
      continue;
    if (found !== -1)
      return "ambiguous";
    found = start;
  }
  return found === -1 ? "missing" : { index: found };
}
var EMPTY = { appended: [], anchored: false, deferred: false, tooShort: false };
function stitchCapture(input) {
  const cut = Math.max(0, input.captured.length - Math.max(1, input.paneRows));
  if (cut === 0)
    return { ...EMPTY, tooShort: true };
  if (input.archivedTail.length === 0) {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }
  const match = locateAnchor(input.captured, input.archivedTail);
  if (match === "ambiguous")
    return { ...EMPTY, deferred: true };
  if (match === "missing") {
    return { ...EMPTY, appended: input.captured.slice(0, cut) };
  }
  const from = match.index + input.archivedTail.length;
  return {
    ...EMPTY,
    anchored: true,
    appended: from >= cut ? [] : input.captured.slice(from, cut)
  };
}
// src/durable-history-archive.ts
import { createHash as createHash5 } from "node:crypto";
import {
  appendFileSync,
  chmodSync as chmodSync4,
  existsSync as existsSync6,
  mkdirSync as mkdirSync4,
  readdirSync,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  rmSync as rmSync3,
  truncateSync as truncateSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname4, join as join7 } from "node:path";
var DEFAULT_CHUNK_LINES = 500;
var DEFAULT_CHUNK_BYTES = 256 * 1024;
var PRIVATE_DIRECTORY_MODE3 = 448;
var PRIVATE_FILE_MODE3 = 384;
var ANCHOR_LINES = 40;
var GAP_MARKER_PREFIX = "⟦thumbmux gap:";
function isHistoryMarker(line) {
  return line.startsWith(GAP_MARKER_PREFIX);
}
function historyGapMarker(at) {
  return `${GAP_MARKER_PREFIX} history before this point could not be joined to what tmux ` + `still holds · ${at.toISOString()}⟧`;
}
function anchorFromTail(tail, want) {
  let end = tail.length;
  while (end > 0 && isHistoryMarker(tail[end - 1]))
    end--;
  let start = end;
  while (start > 0 && !isHistoryMarker(tail[start - 1]))
    start--;
  return tail.slice(Math.max(start, end - want), end);
}
function pathSegment(value) {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const reserved = cleaned === "" || cleaned === "." || cleaned === "..";
  if (!reserved && cleaned === value)
    return cleaned;
  const digest = createHash5("sha256").update(value).digest("hex").slice(0, 8);
  return `${reserved ? "session" : cleaned}-${digest}`;
}
function chunkName(startLine) {
  return `${String(startLine).padStart(12, "0")}.log`;
}
function countLines(text) {
  if (text === "")
    return 0;
  let count = 0;
  for (let index = 0;index < text.length; index++) {
    if (text.charCodeAt(index) === 10)
      count++;
  }
  return count;
}

class DurableHistoryArchive {
  root;
  groupOf;
  chunkLines;
  chunkBytes;
  maxLines;
  maxBytes;
  states = new Map;
  constructor(options) {
    this.root = options.root;
    this.groupOf = options.group ?? (() => "_ungrouped");
    this.chunkLines = Math.max(1, Math.floor(options.chunkLines ?? DEFAULT_CHUNK_LINES));
    this.chunkBytes = Math.max(1024, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
    this.maxLines = positiveCap(options.maxLinesPerSession);
    this.maxBytes = positiveCap(options.maxBytesPerSession);
  }
  ingestSnapshot(session, content, opts) {
    const captured = splitCapture(content);
    const liveLimit = Math.max(1, Math.floor(opts.liveLineLimit));
    this.appendAnchored(session, captured, { paneRows: liveLimit, liveLineLimit: liveLimit });
    return { liveContent: captured.slice(-liveLimit).join(`
`) };
  }
  readBefore(session, beforeLine, limit = 500) {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0)
      return emptyPage();
    const floor = archiveFloor(state);
    const requested = Number.isSafeInteger(beforeLine) ? beforeLine : state.liveStart;
    const end = Math.max(0, Math.min(requested, state.liveStart, state.totalLines));
    if (end <= floor)
      return emptyPage();
    const pageLimit = Math.max(1, Math.floor(limit));
    const start = Math.max(floor, end - pageLimit);
    const lines = this.readRange(state, start, end);
    return { lines, startLine: lines.length === 0 ? null : start, hasMore: start > floor };
  }
  readAfter(session, afterLine, limit = 500) {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0)
      return emptyPage();
    const floor = archiveFloor(state);
    const start = Math.max(floor, Math.min(Number.isSafeInteger(afterLine) ? afterLine + 1 : floor, state.totalLines));
    const end = Math.min(start + Math.max(1, Math.floor(limit)), state.liveStart);
    if (end <= start)
      return emptyPage();
    const lines = this.readRange(state, start, end);
    return { lines, startLine: lines.length === 0 ? null : start, hasMore: end < state.liveStart };
  }
  renameSession(oldSession, newSession) {
    if (oldSession === newSession)
      return;
    const from = this.sessionDir(oldSession);
    const to = this.sessionDir(newSession);
    this.states.delete(oldSession);
    this.states.delete(newSession);
    if (!existsSync6(from) || existsSync6(to))
      return;
    try {
      mkdirSync4(dirname4(to), { recursive: true, mode: PRIVATE_DIRECTORY_MODE3 });
      renameSync3(from, to);
    } catch {}
  }
  dropSession(session) {
    this.states.delete(session);
    rmSync3(this.sessionDir(session), { recursive: true, force: true });
  }
  liveStartLine(session) {
    const state = this.stateFor(session);
    if (state.disabled || state.totalLines === 0)
      return null;
    return state.liveStart;
  }
  appendAnchored(session, captured, opts) {
    const state = this.stateFor(session);
    if (state.disabled)
      return failedAppend();
    const tail = anchorFromTail(this.tailLines(state, ANCHOR_LINES * 4), ANCHOR_LINES);
    const stitch = stitchCapture({
      archivedTail: tail,
      captured,
      paneRows: opts.paneRows,
      liveLineLimit: opts.liveLineLimit
    });
    if (stitch.deferred || stitch.tooShort) {
      return {
        appended: 0,
        liveStartLine: state.liveStart,
        totalLines: state.totalLines,
        gap: false,
        deferred: stitch.deferred,
        needsDeeper: false,
        prunedLines: 0
      };
    }
    if (!stitch.anchored && tail.length > 0 && opts.deeperAvailable) {
      return {
        appended: 0,
        liveStartLine: state.liveStart,
        totalLines: state.totalLines,
        gap: false,
        deferred: false,
        needsDeeper: true,
        prunedLines: 0
      };
    }
    const gap = !stitch.anchored && tail.length > 0 && stitch.appended.length > 0;
    let prunedLines = 0;
    try {
      if (gap)
        this.append(state, [historyGapMarker(new Date)]);
      if (stitch.appended.length > 0)
        this.append(state, stitch.appended);
      state.liveStart = Math.max(0, state.totalLines - Math.min(Math.max(1, opts.liveLineLimit), state.totalLines));
      prunedLines = this.enforceCaps(state);
      this.writeMeta(session, state);
    } catch {
      state.disabled = true;
      return failedAppend();
    }
    return {
      appended: stitch.appended.length,
      liveStartLine: state.liveStart,
      totalLines: state.totalLines,
      gap,
      deferred: false,
      needsDeeper: false,
      prunedLines
    };
  }
  sessionDir(session) {
    return join7(this.root, pathSegment(this.groupOf(session)), pathSegment(session));
  }
  stateFor(session) {
    const cached = this.states.get(session);
    if (cached)
      return cached;
    const state = this.scan(session);
    this.states.set(session, state);
    return state;
  }
  scan(session) {
    const dir = this.sessionDir(session);
    const state = { dir, chunks: [], totalLines: 0, liveStart: 0, disabled: false };
    if (!existsSync6(dir))
      return state;
    try {
      const names = readdirSync(dir).filter((name) => name.endsWith(".log")).sort();
      for (const file of names) {
        const path = join7(dir, file);
        let text = readFileSync4(path, "utf8");
        if (text !== "" && !text.endsWith(`
`)) {
          const keep = text.lastIndexOf(`
`) + 1;
          truncateSync3(path, Buffer.byteLength(text.slice(0, keep)));
          text = text.slice(0, keep);
        }
        const start = Number.parseInt(file.slice(0, file.length - 4), 10);
        if (!Number.isSafeInteger(start))
          continue;
        state.chunks.push({ file, start, lines: countLines(text), bytes: Buffer.byteLength(text) });
      }
      state.chunks.sort((left, right) => left.start - right.start);
      const last = state.chunks[state.chunks.length - 1];
      state.totalLines = last ? last.start + last.lines : 0;
      state.liveStart = state.totalLines;
      const metaPath = join7(dir, "meta.json");
      if (existsSync6(metaPath)) {
        const meta = JSON.parse(readFileSync4(metaPath, "utf8"));
        if (Number.isSafeInteger(meta.liveStart)) {
          state.liveStart = Math.max(0, Math.min(meta.liveStart, state.totalLines));
        }
      }
    } catch {
      state.disabled = true;
    }
    return state;
  }
  append(state, lines) {
    mkdirSync4(state.dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE3 });
    let index = 0;
    while (index < lines.length) {
      let chunk = state.chunks[state.chunks.length - 1];
      if (!chunk || chunk.lines >= this.chunkLines || chunk.bytes >= this.chunkBytes) {
        chunk = { file: chunkName(state.totalLines), start: state.totalLines, lines: 0, bytes: 0 };
        state.chunks.push(chunk);
      }
      const room = this.chunkLines - chunk.lines;
      const slice = lines.slice(index, index + room);
      const payload = `${slice.join(`
`)}
`;
      const path = join7(state.dir, chunk.file);
      const fresh = !existsSync6(path);
      appendFileSync(path, payload);
      if (fresh)
        chmodSync4(path, PRIVATE_FILE_MODE3);
      chunk.lines += slice.length;
      chunk.bytes += Buffer.byteLength(payload);
      state.totalLines += slice.length;
      index += slice.length;
      if (chunk.lines >= this.chunkLines || chunk.bytes >= this.chunkBytes) {
        this.appendIndex(state, chunk);
      }
    }
  }
  enforceCaps(state) {
    if (this.maxLines === null && this.maxBytes === null)
      return 0;
    let pruned = 0;
    while (state.chunks.length > 1) {
      const oldest = state.chunks[0];
      const heldLines = state.totalLines - oldest.start;
      const heldBytes = state.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      const linesAfter = heldLines - oldest.lines;
      const bytesAfter = heldBytes - oldest.bytes;
      const overLines = this.maxLines !== null && heldLines > this.maxLines;
      const overBytes = this.maxBytes !== null && heldBytes > this.maxBytes;
      if (!overLines && !overBytes)
        break;
      if (this.maxLines !== null && linesAfter < this.maxLines)
        break;
      if (this.maxBytes !== null && bytesAfter < this.maxBytes)
        break;
      try {
        rmSync3(join7(state.dir, oldest.file), { force: true });
      } catch {
        break;
      }
      state.chunks.shift();
      pruned += oldest.lines;
    }
    if (pruned > 0)
      this.rewriteIndex(state);
    return pruned;
  }
  rewriteIndex(state) {
    try {
      const path = join7(state.dir, "index.jsonl");
      const body = state.chunks.map((chunk) => JSON.stringify({ file: chunk.file, start: chunk.start, lines: chunk.lines, bytes: chunk.bytes })).join(`
`);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync2(tmp, body === "" ? "" : `${body}
`);
      chmodSync4(tmp, PRIVATE_FILE_MODE3);
      renameSync3(tmp, path);
    } catch {}
  }
  appendIndex(state, chunk) {
    try {
      const path = join7(state.dir, "index.jsonl");
      const fresh = !existsSync6(path);
      appendFileSync(path, `${JSON.stringify({ file: chunk.file, start: chunk.start, lines: chunk.lines, bytes: chunk.bytes })}
`);
      if (fresh)
        chmodSync4(path, PRIVATE_FILE_MODE3);
    } catch {}
  }
  writeMeta(session, state) {
    const path = join7(state.dir, "meta.json");
    const body = JSON.stringify({
      v: 2,
      session,
      group: this.groupOf(session),
      totalLines: state.totalLines,
      liveStart: state.liveStart,
      updatedAt: new Date().toISOString()
    });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync2(tmp, body, { mode: PRIVATE_FILE_MODE3 });
    renameSync3(tmp, path);
  }
  readRange(state, start, end) {
    if (end <= start)
      return [];
    const lines = [];
    for (const chunk of state.chunks) {
      const chunkEnd = chunk.start + chunk.lines;
      if (chunkEnd <= start || chunk.start >= end)
        continue;
      const text = readFileSync4(join7(state.dir, chunk.file), "utf8");
      const chunkLines = text === "" ? [] : text.slice(0, -1).split(`
`);
      const from = Math.max(0, start - chunk.start);
      const to = Math.min(chunkLines.length, end - chunk.start);
      for (let index = from;index < to; index++)
        lines.push(chunkLines[index]);
    }
    return lines;
  }
  tailLines(state, want) {
    if (state.totalLines === 0)
      return [];
    return this.readRange(state, Math.max(0, state.totalLines - want), state.totalLines);
  }
}
function splitCapture(content) {
  const terminated = content.endsWith(`
`) ? content.slice(0, -1) : content;
  if (terminated === "")
    return [];
  const lines = terminated.split(`
`);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "")
    lines.pop();
  return lines;
}
function emptyPage() {
  return { lines: [], startLine: null, hasMore: false };
}
function failedAppend() {
  return { appended: 0, liveStartLine: 0, totalLines: 0, gap: false, deferred: false, needsDeeper: false, prunedLines: 0 };
}
function archiveFloor(state) {
  return state.chunks.length === 0 ? 0 : state.chunks[0].start;
}
function positiveCap(value) {
  if (value === undefined)
    return null;
  const floored = Math.floor(value);
  return Number.isFinite(floored) && floored > 0 ? floored : null;
}
// src/retention-lane.ts
function splitCapture2(content) {
  const terminated = content.endsWith(`
`) ? content.slice(0, -1) : content;
  if (terminated === "")
    return [];
  const lines = terminated.split(`
`);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "")
    lines.pop();
  return lines;
}

class RetentionLane {
  options;
  intervalMs;
  statuses = new Map;
  timer = null;
  ticking = false;
  constructor(options) {
    if (!options.archive.appendAnchored) {
      throw new Error("thumbmux: RetentionLane requires an archive with appendAnchored");
    }
    this.options = options;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 30000));
  }
  start() {
    if (this.timer)
      return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }
  stop() {
    if (!this.timer)
      return;
    clearInterval(this.timer);
    this.timer = null;
  }
  status() {
    return [...this.statuses.values()];
  }
  async tick() {
    if (this.ticking)
      return;
    this.ticking = true;
    try {
      for (const session of this.options.sessions()) {
        if (this.options.hasViewers?.(session))
          continue;
        await this.capture(session);
      }
    } finally {
      this.ticking = false;
    }
  }
  async capture(session) {
    const status = this.statuses.get(session) ?? {
      session,
      lastCaptureAt: 0,
      lastArchivedAt: null,
      archivedLines: 0,
      gaps: 0,
      lastError: null
    };
    this.statuses.set(session, status);
    const archive = this.options.archive;
    const append = (lines, opts) => archive.appendAnchored(session, lines, opts);
    const liveLineLimit = this.options.liveLineLimit;
    const paneRows = this.paneRows(session);
    try {
      let lines = splitCapture2(await this.options.driver.capturePane(session, {
        startLine: -liveLineLimit * 2
      }));
      status.lastCaptureAt = Date.now();
      let result = append(lines, { paneRows, liveLineLimit, deeperAvailable: true });
      if (result.needsDeeper) {
        const deep = -Math.max(this.options.driver.getHistoryLimit(), liveLineLimit);
        lines = splitCapture2(await this.options.driver.capturePane(session, { startLine: deep }));
        status.lastCaptureAt = Date.now();
        result = append(lines, { paneRows, liveLineLimit });
      }
      if (result.appended > 0) {
        status.archivedLines += result.appended;
        status.lastArchivedAt = Date.now();
      }
      if (result.gap)
        status.gaps++;
      status.lastError = null;
    } catch (cause) {
      status.lastError = cause instanceof Error ? cause.message : String(cause);
      try {
        this.options.log?.(`[thumbmux-retention] capture failed for "${session}":`, status.lastError);
      } catch {}
    }
    try {
      this.options.onStatus?.({ ...status });
    } catch {}
  }
  paneRows(session) {
    for (const row of this.options.driver.listSessions()) {
      if (row.name !== session)
        continue;
      const paneRows = row.paneRows;
      if (typeof paneRows === "number" && Number.isFinite(paneRows) && paneRows > 0) {
        return Math.floor(paneRows);
      }
      break;
    }
    return this.options.liveLineLimit;
  }
}
// src/app-routes.ts
var WS_PATH = "/ws/tmux";
var decoder = new TextDecoder;
var LIVE_AUTHORIZATION_RECHECK_MS = 100;
var LIVE_AUTHORIZATION_PROBE = Object.freeze({ type: "ping" });
var revokeObservers = new WeakMap;
function observeRevocations(guard, observer) {
  let entry = revokeObservers.get(guard);
  if (!entry) {
    let original;
    try {
      original = guard.revoke;
    } catch {
      return () => {};
    }
    const observers = new Set;
    const wrapped = (token) => {
      const revoked = Reflect.apply(original, guard, [token]);
      if (revoked) {
        for (const notify of [...observers]) {
          try {
            notify();
          } catch {}
        }
      }
      return revoked;
    };
    try {
      guard.revoke = wrapped;
      if (guard.revoke !== wrapped)
        return () => {};
    } catch {
      return () => {};
    }
    entry = { original, wrapped, observers };
    revokeObservers.set(guard, entry);
  }
  entry.observers.add(observer);
  return () => {
    entry.observers.delete(observer);
    if (entry.observers.size > 0)
      return;
    try {
      if (guard.revoke === entry.wrapped) {
        guard.revoke = entry.original;
        if (guard.revoke !== entry.original)
          return;
      }
    } catch {
      return;
    }
    revokeObservers.delete(guard);
  };
}
function normalizeBasePath(value) {
  const path = (value ?? "/api").trim();
  if (!path || path === "/")
    return "";
  const rooted = path.startsWith("/") ? path : `/${path}`;
  return rooted.replace(/\/+$/, "");
}
function parseMessage(raw) {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function decodeSessionName(encoded) {
  if (!encoded || encoded.includes("/"))
    return null;
  try {
    const name = decodeURIComponent(encoded);
    return name && !name.includes("/") ? name : null;
  } catch {
    return null;
  }
}
function errorMessage3(error) {
  return error instanceof Error ? error.message : String(error);
}
function guardFailureResponse(failure) {
  return Response.json({
    ok: false,
    status: failure.status,
    code: failure.code,
    message: failure.message
  }, { status: failure.status });
}
function withSetCookie(response, setCookie) {
  if (setCookie)
    response.headers.set("set-cookie", setCookie);
  return response;
}
function methodNotAllowed(allow) {
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: allow } });
}
function authenticateAndAuthorize(guard, req, context) {
  const auth = guard.authenticate(req);
  if (!auth.ok)
    return { ok: false, response: guardFailureResponse(auth) };
  const decision = guard.authorizeHttp(req, auth.principal, context);
  if (!decision.ok) {
    return {
      ok: false,
      response: withSetCookie(guardFailureResponse(decision), auth.setCookie)
    };
  }
  return {
    ok: true,
    principal: auth.principal,
    ...auth.setCookie ? { setCookie: auth.setCookie } : {}
  };
}
function sendAuthError(ws, failure) {
  ws.send(JSON.stringify({
    type: "auth_error",
    status: failure.status,
    code: failure.code
  }));
}
function createAppRoutes(options = {}) {
  const driver = options.driver ?? createBunTmuxDriver();
  const archive = options.archive === undefined ? new FileHistoryArchive({}) : options.archive;
  const guard = options.guard;
  const projectSessionList = options.projectSessionList;
  const reportSessionListProjectionFailure = (error) => {
    let message = "unknown error";
    try {
      message = errorMessage3(error);
    } catch {}
    try {
      (options.mux?.logError ?? console.error)("[thumbmux-app-routes] projectSessionList threw:", message);
    } catch {}
  };
  const socketPrincipals = new Map;
  const authorizationTimers = new Map;
  const socketCleanupNotified = new WeakSet;
  const withdrawingSockets = new WeakSet;
  let stopObservingRevocations = null;
  let stopped = false;
  let mux;
  const upgradePrincipals = new WeakMap;
  const clearAuthorizationTimer = (ws) => {
    const timer = authorizationTimers.get(ws);
    if (timer)
      clearTimeout(timer);
    authorizationTimers.delete(ws);
  };
  const stopRevocationObserverIfIdle = () => {
    if (socketPrincipals.size > 0 || !stopObservingRevocations)
      return;
    const stop = stopObservingRevocations;
    stopObservingRevocations = null;
    stop();
  };
  const forgetSocketAuthorization = (ws) => {
    clearAuthorizationTimer(ws);
    socketPrincipals.delete(ws);
    stopRevocationObserverIfIdle();
  };
  const principalIsActive = (principal) => {
    if (!guard)
      return true;
    try {
      return guard.authorizeMuxMessage(LIVE_AUTHORIZATION_PROBE, principal).ok;
    } catch {
      return false;
    }
  };
  const withdrawSocket = (ws) => {
    if (!socketPrincipals.has(ws))
      return;
    withdrawingSockets.add(ws);
    try {
      mux.unsubscribeAll(ws);
    } finally {
      withdrawingSockets.delete(ws);
      try {
        ws.close?.();
      } catch {}
    }
  };
  const sweepRevokedSockets = () => {
    for (const [ws, principal] of [...socketPrincipals]) {
      if (!principalIsActive(principal))
        withdrawSocket(ws);
    }
  };
  const ensureRevocationObserver = () => {
    if (!guard || stopped || stopObservingRevocations)
      return;
    stopObservingRevocations = observeRevocations(guard, sweepRevokedSockets);
  };
  const armAuthorizationCheck = (ws, principal) => {
    if (stopped)
      return;
    clearAuthorizationTimer(ws);
    const timer = setTimeout(() => {
      if (authorizationTimers.get(ws) !== timer)
        return;
      authorizationTimers.delete(ws);
      if (socketPrincipals.get(ws) !== principal)
        return;
      if (!principalIsActive(principal)) {
        withdrawSocket(ws);
        return;
      }
      armAuthorizationCheck(ws, principal);
    }, LIVE_AUTHORIZATION_RECHECK_MS);
    authorizationTimers.set(ws, timer);
    timer.unref?.();
  };
  const hostHooks = options.mux?.hooks;
  const muxHooks = guard ? {
    ...hostHooks,
    filterSessionList(sessions, ws, client) {
      const principal = socketPrincipals.get(ws);
      if (!principal)
        return [];
      const allowed = guard.filterSessions(sessions, principal, ({ name }) => name);
      if (!projectSessionList) {
        const projected = hostHooks?.filterSessionList ? hostHooks.filterSessionList(allowed, ws, client) : allowed;
        return guard.filterSessions(projected, principal, ({ name }) => name);
      }
      const projectInput = hostHooks?.filterSessionList ? guard.filterSessions(hostHooks.filterSessionList(allowed, ws, client), principal, ({ name }) => name) : allowed;
      return guard.filterSessions(projectSessionList(projectInput), principal, ({ name }) => name);
    },
    canSubscribe(session, ws, client) {
      if (hostHooks?.canSubscribe?.(session, ws, client) === false) {
        return false;
      }
      const principal = socketPrincipals.get(ws);
      if (principal && principalIsActive(principal))
        return true;
      withdrawSocket(ws);
      return false;
    },
    onSocketClose(ws) {
      forgetSocketAuthorization(ws);
      if (withdrawingSockets.has(ws))
        return;
      if (socketCleanupNotified.has(ws))
        return;
      socketCleanupNotified.add(ws);
      try {
        hostHooks?.onSocketClose?.(ws);
      } catch {}
    }
  } : projectSessionList ? {
    ...hostHooks,
    filterSessionList(sessions, ws, client) {
      const legacyProjected = hostHooks?.filterSessionList ? hostHooks.filterSessionList(sessions, ws, client) : sessions;
      return projectSessionList(legacyProjected);
    }
  } : hostHooks;
  const muxLog = options.log ? (...args) => options.log(args.map(String).join(" ")) : options.mux?.log;
  mux = new TmuxWsMux({
    ...options.mux,
    driver,
    archive,
    pipes: options.pipes ?? null,
    ...muxHooks ? { hooks: muxHooks } : {},
    ...muxLog ? { log: muxLog } : {}
  });
  if (guard) {
    const stopMux = mux.stop.bind(mux);
    mux.stop = () => {
      if (stopped) {
        stopMux();
        return;
      }
      stopped = true;
      for (const ws of [...socketPrincipals.keys()])
        withdrawSocket(ws);
      for (const timer of authorizationTimers.values())
        clearTimeout(timer);
      authorizationTimers.clear();
      socketPrincipals.clear();
      if (stopObservingRevocations) {
        const stop = stopObservingRevocations;
        stopObservingRevocations = null;
        stop();
      }
      stopMux();
    };
  }
  const spawnHandler = options.spawn === false ? null : createSpawnHandler({ ...options.spawn ?? {}, driver });
  const uploadHandler = options.upload === undefined || options.upload === false ? null : createUploadHandler(options.upload);
  const prefsHandler = options.prefs === undefined || options.prefs === false ? null : createPrefsHandler(options.prefs);
  const killEnabled = options.kill?.enabled !== false;
  const basePath = normalizeBasePath(options.basePath);
  const spawnPath = `${basePath}/spawn`;
  const uploadPath = `${basePath}/upload`;
  const prefsPath = `${basePath}/prefs`;
  const sessionsPath = `${basePath}/sessions`;
  const killPrefix = `${sessionsPath}/`;
  return {
    mux,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === WS_PATH) {
        if (req.method !== "GET") {
          return guard ? methodNotAllowed("GET") : null;
        }
        if (!guard) {
          if (!server.upgrade(req)) {
            return new Response("websocket upgrade failed", { status: 400 });
          }
          return new Response(null, { status: 204 });
        }
        if (stopped) {
          return new Response("websocket unavailable", { status: 503 });
        }
        const authorization = authenticateAndAuthorize(guard, req, { operation: "ws-upgrade" });
        if (!authorization.ok)
          return authorization.response;
        const socketData = Object.freeze({});
        upgradePrincipals.set(socketData, guard.sanitizePrincipal(authorization.principal));
        const upgraded = server.upgrade(req, {
          data: socketData,
          ...authorization.setCookie ? { headers: { "set-cookie": authorization.setCookie } } : {}
        });
        if (!upgraded) {
          upgradePrincipals.delete(socketData);
          return new Response("websocket upgrade failed", { status: 400 });
        }
        return new Response(null, { status: 204 });
      }
      if (path === spawnPath) {
        if (!spawnHandler)
          return null;
        if (!guard)
          return spawnHandler(req);
        if (req.method !== "POST")
          return methodNotAllowed("POST");
        const authorization = authenticateAndAuthorize(guard, req, { operation: "sessions-spawn" });
        if (!authorization.ok)
          return authorization.response;
        return withSetCookie(await spawnHandler(req), authorization.setCookie);
      }
      if (path === uploadPath) {
        if (!uploadHandler)
          return null;
        if (!guard)
          return uploadHandler(req);
        if (req.method !== "POST")
          return methodNotAllowed("POST");
        const session = url.searchParams.has("session") ? url.searchParams.get("session") ?? "" : undefined;
        const authorization = authenticateAndAuthorize(guard, req, {
          operation: "upload",
          ...session !== undefined ? { session } : {}
        });
        if (!authorization.ok)
          return authorization.response;
        return withSetCookie(await uploadHandler(req), authorization.setCookie);
      }
      if (path === prefsPath) {
        if (!prefsHandler)
          return null;
        if (req.method !== "GET" && req.method !== "PUT") {
          return methodNotAllowed("GET, PUT");
        }
        if (!guard)
          return prefsHandler(req);
        const authorization = authenticateAndAuthorize(guard, req, { operation: req.method === "GET" ? "prefs-read" : "prefs-write" });
        if (!authorization.ok)
          return authorization.response;
        return withSetCookie(await prefsHandler(req), authorization.setCookie);
      }
      if (path === sessionsPath) {
        if (req.method !== "GET") {
          return guard ? methodNotAllowed("GET") : null;
        }
        if (!guard) {
          const sessions = driver.listSessions();
          if (!projectSessionList)
            return Response.json(sessions);
          let projected;
          try {
            projected = projectSessionList(sessions);
          } catch (error) {
            reportSessionListProjectionFailure(error);
            return Response.json({ error: "session list projection failed" }, { status: 500 });
          }
          return Response.json(projected);
        }
        const authorization = authenticateAndAuthorize(guard, req, { operation: "sessions-list" });
        if (!authorization.ok)
          return authorization.response;
        if (projectSessionList) {
          const allowed = guard.filterSessions(driver.listSessions(), authorization.principal, ({ name }) => name);
          let projected;
          try {
            projected = projectSessionList(allowed);
          } catch (error) {
            reportSessionListProjectionFailure(error);
            return withSetCookie(Response.json({ error: "session list projection failed" }, { status: 500 }), authorization.setCookie);
          }
          return withSetCookie(Response.json(guard.filterSessions(projected, authorization.principal, ({ name }) => name)), authorization.setCookie);
        }
        return withSetCookie(Response.json(guard.filterSessions(driver.listSessions(), authorization.principal, ({ name }) => name)), authorization.setCookie);
      }
      if (path.startsWith(killPrefix)) {
        if (!killEnabled)
          return null;
        const encodedName = path.slice(killPrefix.length);
        if (!encodedName || encodedName.includes("/"))
          return null;
        if (req.method !== "DELETE") {
          return guard ? methodNotAllowed("DELETE") : null;
        }
        const name = decodeSessionName(encodedName);
        if (!name) {
          return Response.json({ error: "invalid session name" }, { status: 400 });
        }
        let setCookie;
        if (guard) {
          const authorization = authenticateAndAuthorize(guard, req, { operation: "sessions-kill", session: name });
          if (!authorization.ok)
            return authorization.response;
          setCookie = authorization.setCookie;
        }
        try {
          killTmuxSession(name);
          mux.invalidateSession(name);
          return withSetCookie(Response.json({ ok: true, name }), setCookie);
        } catch (error) {
          return withSetCookie(Response.json({ error: errorMessage3(error) }, { status: 404 }), setCookie);
        }
      }
      return null;
    },
    websocket: {
      message(ws, raw) {
        const message = parseMessage(raw);
        if (!guard) {
          if (message)
            mux.handleMessage(message, ws);
          return;
        }
        const principal = socketPrincipals.get(ws);
        if (!principal) {
          sendAuthError(ws, { status: 401, code: "invalid_credential" });
          return;
        }
        const decision = guard.authorizeMuxMessage(message, principal);
        if (!decision.ok) {
          try {
            sendAuthError(ws, decision);
          } finally {
            if (decision.status === 401)
              withdrawSocket(ws);
          }
          return;
        }
        if (!message) {
          sendAuthError(ws, { status: 403, code: "forbidden_operation" });
          return;
        }
        mux.handleMessage(message, ws);
      },
      open(ws) {
        if (guard) {
          const data = ws.data;
          if (stopped) {
            if (typeof data === "object" && data !== null) {
              upgradePrincipals.delete(data);
            }
            return;
          }
          socketCleanupNotified.delete(ws);
          const principal = typeof data === "object" && data !== null ? upgradePrincipals.get(data) : undefined;
          if (!principal) {
            sendAuthError(ws, { status: 401, code: "invalid_credential" });
            return;
          }
          upgradePrincipals.delete(data);
          const decision = guard.authorizeMuxMessage(LIVE_AUTHORIZATION_PROBE, principal);
          if (!decision.ok) {
            sendAuthError(ws, decision);
            return;
          }
          socketPrincipals.set(ws, principal);
          ensureRevocationObserver();
          armAuthorizationCheck(ws, principal);
        }
        mux.subscribeSessions(ws);
      },
      close(ws) {
        if (guard) {
          socketPrincipals.delete(ws);
          const data = ws.data;
          if (typeof data === "object" && data !== null) {
            upgradePrincipals.delete(data);
          }
        }
        mux.unsubscribeAll(ws);
      },
      drain(ws) {
        if (guard) {
          const principal = socketPrincipals.get(ws);
          if (!principal || !principalIsActive(principal)) {
            withdrawSocket(ws);
            return;
          }
        }
        mux.handleDrain(ws);
      }
    }
  };
}

// src/index.ts
var createTerminalPtyWalProxyLaunchSpec2 = createTerminalPtyWalProxyLaunchSpec;
var createTerminalReplayWorkerClient2 = createTerminalReplayWorkerClient;
var readTerminalPtyWalProxyHealth2 = readTerminalPtyWalProxyHealth;
var resolveTerminalReplayWorkerPath2 = resolveTerminalReplayWorkerPath;
var TerminalWalController2 = TerminalWalController;
var TERMINAL_PTY_WAL_CONFIG_ENV2 = TERMINAL_PTY_WAL_CONFIG_ENV;
export {
  stitchCapture,
  stableOverlap,
  spawnTmuxSession,
  resolveTerminalReplayWorkerPath2 as resolveTerminalReplayWorkerPath,
  readTerminalPtyWalProxyHealth2 as readTerminalPtyWalProxyHealth,
  looksLikeTailRepaint,
  locateAnchor,
  killTmuxSession,
  isHistoryMarker,
  installMuxTimeHooksForTests,
  historyGapMarker,
  exactTmuxTarget,
  exactTmuxPaneTarget,
  createUploadHandler,
  createTokenGuard,
  createTerminalReplayWorkerClient2 as createTerminalReplayWorkerClient,
  createTerminalPtyWalProxyLaunchSpec2 as createTerminalPtyWalProxyLaunchSpec,
  createSpawnHandler,
  createPrefsHandler,
  createBunTmuxDriver,
  createAppRoutes,
  anchorFromTail,
  TmuxWsMux,
  TerminalWalController2 as TerminalWalController,
  TERMINAL_PTY_WAL_CONFIG_ENV2 as TERMINAL_PTY_WAL_CONFIG_ENV,
  SpawnHandlerError,
  RetentionLane,
  FrameJournal,
  FileHistoryArchive,
  DurableHistoryArchive,
  DEFAULT_MAX_ROOT_BYTES,
  DEFAULT_MAX_BYTES
};
