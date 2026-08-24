import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseTerminalGeometry,
  parseTerminalWalIdentity,
  parseTerminalWalSafeId,
  resolveTerminalWalPaths,
  type TerminalGeometry,
  type TerminalWalPtyIdentity,
} from "./terminal-wal";

export const TERMINAL_PTY_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG";
export const TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV = "THUMBMUX_TERMINAL_PROXY_ASSET_SHA256";
export const TERMINAL_PTY_WAL_HEALTH_FILE = "pty-proxy-status.json";
export const TERMINAL_PTY_WAL_DIAGNOSTIC_FILE = "pty-proxy-diagnostics.log";

const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_MAX_OUTPUT_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const MAX_CONFIG_JSON_BYTES = 1024 * 1024;

export type TerminalPtyWalProxyTmuxOptions = {
  executable?: string;
  socketName?: string;
  socketPath?: string;
};

export type TerminalPtyWalProxyConfig = {
  directory: string;
  identity: {
    session: string;
    instanceId: string;
    paneTarget: string;
  };
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  tmux?: TerminalPtyWalProxyTmuxOptions;
  pythonExecutable?: string;
  maxOutputRecordBytes?: number;
  maxPendingInputBytes?: number;
  heartbeatMs?: number;
  terminateGraceMs?: number;
};

export type NormalizedTerminalPtyWalProxyConfig = {
  directory: string;
  identity: TerminalPtyWalProxyConfig["identity"];
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  tmux: {
    executable: string;
    socketName?: string;
    socketPath?: string;
  };
  pythonExecutable: string;
  maxOutputRecordBytes: number;
  maxPendingInputBytes: number;
  heartbeatMs: number;
  terminateGraceMs: number;
};

export type TerminalPtyWalProxyHealth = {
  version: 1;
  state: "starting" | "armed" | "ready" | "resizing" | "ending" | "disconnected" | "ended" | "fatal";
  generation: string;
  pid: number;
  pidStartTicks: string;
  childPid: number | null;
  foregroundPid: number | null;
  foregroundPidStartTicks: string | null;
  foregroundCommand: string | null;
  source: TerminalWalPtyIdentity | null;
  geometry: TerminalGeometry | null;
  updatedAt: number;
  heartbeatAt: number;
  walSequence: string;
  walNextOffset: number;
  deliveredSequence: string;
  deliveredNextOffset: number;
  childExitCode?: number;
  error?: string;
};

export type TerminalPtyWalProxyLaunchSpec = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function stringWithoutNul(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} must be a string without NUL`);
  }
  return value;
}

function commandName(value: unknown, label: string, fallback?: string): string {
  const selected = value === undefined ? fallback : value;
  const text = nonEmptyString(selected, label);
  if (text.includes("/")) {
    if (!isAbsolute(text) || resolve(text) !== text) throw new Error(`${label} must be normalized when it is a path`);
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) {
    throw new Error(`${label} command name is invalid`);
  }
  return text;
}

function bounded(value: unknown, fallback: number, label: string, maximum: number): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || (selected as number) <= 0 || (selected as number) > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return selected as number;
}

function parseIdentity(value: unknown): TerminalPtyWalProxyConfig["identity"] {
  if (!isObject(value)) throw new Error("terminal PTY WAL identity must be an object");
  exactKeys(value, ["session", "instanceId", "paneTarget"], [], "identity");
  if (typeof value.session !== "string" || !SAFE_SESSION.test(value.session)) {
    throw new Error("identity.session must be a safe tmux session name");
  }
  const instanceId = parseTerminalWalSafeId(value.instanceId, "identity.instanceId");
  const expected = new RegExp(`^=${value.session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+\\.\\d+$`);
  if (typeof value.paneTarget !== "string" || !expected.test(value.paneTarget)) {
    throw new Error("identity.paneTarget must be an exact =session:window.pane target");
  }
  return { session: value.session, instanceId, paneTarget: value.paneTarget };
}

function parseTmux(value: unknown): NormalizedTerminalPtyWalProxyConfig["tmux"] {
  if (value === undefined) return { executable: "tmux" };
  if (!isObject(value)) throw new Error("terminal PTY WAL tmux must be an object");
  exactKeys(value, [], ["executable", "socketName", "socketPath"], "tmux");
  if (value.socketName !== undefined && value.socketPath !== undefined) {
    throw new Error("tmux.socketName and tmux.socketPath are mutually exclusive");
  }
  const executable = commandName(value.executable, "tmux.executable", "tmux");
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

export function parseTerminalPtyWalProxyConfig(value: unknown): NormalizedTerminalPtyWalProxyConfig {
  if (!isObject(value)) throw new Error("terminal PTY WAL config must be an object");
  exactKeys(
    value,
    ["directory", "identity", "argv"],
    [
      "cwd",
      "env",
      "tmux",
      "pythonExecutable",
      "maxOutputRecordBytes",
      "maxPendingInputBytes",
      "heartbeatMs",
      "terminateGraceMs",
    ],
    "terminal PTY WAL config",
  );
  const directory = nonEmptyString(value.directory, "directory");
  resolveTerminalWalPaths(directory);
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 4_096) {
    throw new Error("argv must contain 1 through 4096 arguments");
  }
  const argv = value.argv.map((part, index) => nonEmptyString(part, `argv[${index}]`));
  let cwd: string | undefined;
  if (value.cwd !== undefined) {
    cwd = nonEmptyString(value.cwd, "cwd");
    if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error("cwd must be an absolute normalized path");
  }
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!isObject(value.env)) throw new Error("env must be an object");
    for (const [name, raw] of Object.entries(value.env)) {
      if (!SAFE_ENVIRONMENT_NAME.test(name) || name === TERMINAL_PTY_WAL_CONFIG_ENV) {
        throw new Error(`env name ${JSON.stringify(name)} is not allowed`);
      }
      env[name] = stringWithoutNul(raw, `env.${name}`);
    }
  }
  const maxOutputRecordBytes = bounded(
    value.maxOutputRecordBytes,
    DEFAULT_MAX_OUTPUT_RECORD_BYTES,
    "maxOutputRecordBytes",
    16 * 1024 * 1024,
  );
  const maxPendingInputBytes = bounded(
    value.maxPendingInputBytes,
    DEFAULT_MAX_PENDING_INPUT_BYTES,
    "maxPendingInputBytes",
    64 * 1024 * 1024,
  );
  if (maxPendingInputBytes < maxOutputRecordBytes) {
    throw new Error("maxPendingInputBytes must be at least maxOutputRecordBytes");
  }
  return {
    directory,
    identity: parseIdentity(value.identity),
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    env,
    tmux: parseTmux(value.tmux),
    pythonExecutable: commandName(value.pythonExecutable, "pythonExecutable", "python3"),
    maxOutputRecordBytes,
    maxPendingInputBytes,
    heartbeatMs: bounded(value.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs", 60_000),
    terminateGraceMs: bounded(
      value.terminateGraceMs,
      DEFAULT_TERMINATE_GRACE_MS,
      "terminateGraceMs",
      300_000,
    ),
  };
}

export function parseTerminalPtyWalProxyConfigJson(json: string): NormalizedTerminalPtyWalProxyConfig {
  if (typeof json !== "string" || json.length === 0) {
    throw new Error(`${TERMINAL_PTY_WAL_CONFIG_ENV} must contain JSON`);
  }
  if (Buffer.byteLength(json, "utf8") > MAX_CONFIG_JSON_BYTES) {
    throw new Error(`${TERMINAL_PTY_WAL_CONFIG_ENV} exceeds ${MAX_CONFIG_JSON_BYTES} bytes`);
  }
  try {
    return parseTerminalPtyWalProxyConfig(JSON.parse(json));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${TERMINAL_PTY_WAL_CONFIG_ENV} is not valid JSON`);
    throw error;
  }
}

/** Resolve the shipped Python helper from either source or the bundled dist entry. */
export function resolveTerminalPtyWalProxyScriptPath(): string {
  const candidates = [
    fileURLToPath(new URL("./terminal-pty-wal-proxy.py", import.meta.url)),
    fileURLToPath(new URL("../src/integrations/terminal-pty-wal-proxy.py", import.meta.url)),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("shipped terminal PTY WAL proxy helper was not found");
  return path;
}

export function createTerminalPtyWalProxyLaunchSpec(
  value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): TerminalPtyWalProxyLaunchSpec {
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
      PYTHONUNBUFFERED: "1",
    },
  };
}

/** Launch as a foreground pane process; stdout/stderr must remain the outer PTY. */
export function spawnTerminalPtyWalProxy(
  value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig,
): ChildProcess {
  const launch = createTerminalPtyWalProxyLaunchSpec(value);
  return spawn(launch.executable, launch.args, {
    env: launch.env,
    stdio: "inherit",
  });
}

export function terminalPtyWalProxyHealthPath(directory: string): string {
  return join(resolveTerminalWalPaths(directory).directory, TERMINAL_PTY_WAL_HEALTH_FILE);
}

export function readTerminalPtyWalProxyHealth(directory: string): TerminalPtyWalProxyHealth {
  const value: unknown = JSON.parse(readFileSync(terminalPtyWalProxyHealthPath(directory), "utf8"));
  if (!isObject(value)) throw new Error("terminal PTY WAL health file must be an object");
  const required = [
    "version", "state", "generation", "pid", "pidStartTicks", "childPid", "foregroundPid",
    "foregroundPidStartTicks", "foregroundCommand", "source", "geometry",
    "updatedAt", "heartbeatAt", "walSequence", "walNextOffset", "deliveredSequence", "deliveredNextOffset",
  ];
  exactKeys(value, required, ["assetSha256", "childExitCode", "error"], "terminal PTY WAL health");
  const states = new Set(["starting", "armed", "ready", "resizing", "ending", "disconnected", "ended", "fatal"]);
  if (value.version !== 1 || typeof value.state !== "string" || !states.has(value.state)) {
    throw new Error("terminal PTY WAL health state/version is invalid");
  }
  const generation = parseTerminalWalSafeId(value.generation, "health.generation");
  const safeInteger = (raw: unknown, label: string, minimum: number): number => {
    if (!Number.isSafeInteger(raw) || (raw as number) < minimum) throw new Error(`${label} is invalid`);
    return raw as number;
  };
  const decimal = (raw: unknown, label: string): string => {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
    return raw;
  };
  const source = value.source === null ? null : parseTerminalWalIdentity(value.source);
  if (source && (!source.sessionId || !source.windowId || !source.paneId || source.generation !== generation)) {
    throw new Error("terminal PTY WAL health physical source is incomplete or from another generation");
  }
  const geometry = value.geometry === null ? null : parseTerminalGeometry(value.geometry, "health.geometry");
  const childPid = value.childPid === null ? null : safeInteger(value.childPid, "health.childPid", 1);
  const foregroundPid = value.foregroundPid === null
    ? null
    : safeInteger(value.foregroundPid, "health.foregroundPid", 1);
  const foregroundPidStartTicks = value.foregroundPidStartTicks === null
    ? null
    : decimal(value.foregroundPidStartTicks, "health.foregroundPidStartTicks");
  const foregroundCommand = value.foregroundCommand === null
    ? null
    : nonEmptyString(value.foregroundCommand, "health.foregroundCommand");
  if ((foregroundPid === null) !== (foregroundPidStartTicks === null)
    || (foregroundPid === null) !== (foregroundCommand === null)) {
    throw new Error("terminal PTY WAL foreground health fields must be supplied together");
  }
  const childExitCode = value.childExitCode === undefined
    ? undefined
    : safeInteger(value.childExitCode, "health.childExitCode", 0);
  if (typeof value.pidStartTicks !== "string" || !/^[1-9]\d*$/.test(value.pidStartTicks)) {
    throw new Error("health.pidStartTicks is invalid");
  }
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 2_048)) {
    throw new Error("health.error is invalid");
  }
  if (value.assetSha256 !== undefined
    && (typeof value.assetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.assetSha256))) {
    throw new Error("health.assetSha256 is invalid");
  }
  return {
    version: 1,
    state: value.state as TerminalPtyWalProxyHealth["state"],
    generation,
    pid: safeInteger(value.pid, "health.pid", 1),
    pidStartTicks: value.pidStartTicks,
    childPid,
    foregroundPid,
    foregroundPidStartTicks,
    foregroundCommand,
    source: source as TerminalWalPtyIdentity | null,
    geometry,
    updatedAt: safeInteger(value.updatedAt, "health.updatedAt", 0),
    heartbeatAt: safeInteger(value.heartbeatAt, "health.heartbeatAt", 0),
    walSequence: decimal(value.walSequence, "health.walSequence"),
    walNextOffset: safeInteger(value.walNextOffset, "health.walNextOffset", 0),
    deliveredSequence: decimal(value.deliveredSequence, "health.deliveredSequence"),
    deliveredNextOffset: safeInteger(value.deliveredNextOffset, "health.deliveredNextOffset", 0),
    ...(childExitCode === undefined ? {} : { childExitCode }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}
