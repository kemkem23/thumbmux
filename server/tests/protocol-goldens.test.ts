import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TmuxWsMux,
  type HistoryArchiveLike,
  type MuxHooks,
  type TmuxDriver,
} from "../src/ws-mux";

type JsonObject = Record<string, unknown>;

type GoldenLine = {
  line: number;
  value: JsonObject;
};

type GoldenFile = {
  headers: string[];
  lines: GoldenLine[];
};

const SESSION = "golden-v071";
const GOLDEN_COMMIT = "82e00cabd515fcda821c236215334e95bffd2faf";
const CLIENT_GOLDEN_PATH = join(import.meta.dir, "../../contract/goldens/client-v0.7.1.jsonl");
const SERVER_GOLDEN_PATH = join(import.meta.dir, "../../contract/goldens/server-v0.7.1.jsonl");
const AUTH_ERROR_GOLDEN_PATH = join(import.meta.dir, "../../contract/goldens/server-v0.8.0.jsonl");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGolden(path: string): GoldenFile {
  const headers: string[] = [];
  const lines: GoldenLine[] = [];
  for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const text = raw.trim();
    if (!text) continue;
    if (text.startsWith("#")) {
      headers.push(text.slice(1).trim());
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new Error(`${path}:${index + 1} is not valid JSON`, { cause });
    }
    if (!isObject(value)) throw new Error(`${path}:${index + 1} is not a JSON object`);
    lines.push({ line: index + 1, value });
  }
  return { headers, lines };
}

const clientGolden = readGolden(CLIENT_GOLDEN_PATH);
const serverGolden = readGolden(SERVER_GOLDEN_PATH);
const authErrorGolden = readGolden(AUTH_ERROR_GOLDEN_PATH);

class RecordingWS {
  sent: string[] = [];

  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }

  clear(): void {
    this.sent.length = 0;
  }

  frames(type?: string): JsonObject[] {
    return this.sent
      .map((data) => JSON.parse(data) as unknown)
      .filter(isObject)
      .filter((frame) => type === undefined || frame.type === type);
  }
}

type HarnessCalls = {
  capture: number;
  clientInfo: Array<{ ws: RecordingWS; client: unknown }>;
  historyAfter: Array<{ session: string; afterLine: number | null; limit?: number }>;
  historyBefore: Array<{ session: string; beforeLine: number | null; limit?: number }>;
  keys: Array<{ session: string; data: string }>;
  keysHook: number;
  listSessions: number;
  resize: Array<{ session: string; cols: number; rows: number }>;
  resizeTelemetry: number;
  subscribe: number;
  unsubscribe: number;
};

type HarnessState = {
  activity: number;
  content: string;
  cursor: { x: number; y: number; paneHeight: number; visible: boolean };
  sessions: Array<{
    name: string;
    created: string;
    windows: number;
    attached: boolean;
    activityAt: number;
  }>;
};

function initialContent(): string {
  return Array.from({ length: 12 }, (_, index) => {
    if (index === 11) return "initial suffix";
    return `${String(index).padStart(2, "0")}-${"A".repeat(128)}`;
  }).join("\n");
}

function createHarness(): {
  calls: HarnessCalls;
  mux: TmuxWsMux<RecordingWS>;
  state: HarnessState;
  ws: RecordingWS;
} {
  const state: HarnessState = {
    activity: 1,
    content: initialContent(),
    cursor: { x: 3, y: 0, paneHeight: 1, visible: true },
    sessions: [{
      name: SESSION,
      created: "1720000000",
      windows: 1,
      attached: false,
      activityAt: 1720000001,
    }],
  };
  const calls: HarnessCalls = {
    capture: 0,
    clientInfo: [],
    historyAfter: [],
    historyBefore: [],
    keys: [],
    keysHook: 0,
    listSessions: 0,
    resize: [],
    resizeTelemetry: 0,
    subscribe: 0,
    unsubscribe: 0,
  };
  const driver: TmuxDriver = {
    listSessions: () => {
      calls.listSessions++;
      return state.sessions.map((session) => ({ ...session }));
    },
    capturePane: async () => {
      calls.capture++;
      return state.content;
    },
    captureWithCursor: async () => {
      calls.capture++;
      return {
        content: state.content,
        cursor: { ...state.cursor },
        trailingBlanks: 0,
      };
    },
    sendKeys: (session, data) => { calls.keys.push({ session, data }); },
    getSessionActivity: () => new Map([[SESSION, state.activity]]),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: (session, cols, rows) => { calls.resize.push({ session, cols, rows }); },
    hash: (content) => content,
  };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, content) => ({ liveContent: content }),
    readBefore: (session, beforeLine, limit) => {
      calls.historyBefore.push({ session, beforeLine, limit });
      return { lines: [`before-page-${calls.historyBefore.length}`], startLine: 40, hasMore: true };
    },
    readAfter: (session, afterLine, limit) => {
      calls.historyAfter.push({ session, afterLine, limit });
      return { lines: [`after-page-${calls.historyAfter.length}`], startLine: 42, hasMore: false };
    },
    renameSession: () => {},
  };
  const hooks: MuxHooks<RecordingWS> = {
    onClientInfo: (ws, client) => { calls.clientInfo.push({ ws, client }); },
    onSubscribe: () => { calls.subscribe++; },
    onUnsubscribe: () => { calls.unsubscribe++; },
    onKeys: () => { calls.keysHook++; },
    onResizeTelemetry: () => { calls.resizeTelemetry++; },
  };
  const mux = new TmuxWsMux<RecordingWS>({
    driver,
    archive,
    hooks,
    pipes: null,
    profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
    backpressure: { enabled: false },
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    burstDurationMs: 60_000,
    pollReconcileMs: 60_000,
    sessionListIntervalMs: 60_000,
    logError: () => {},
  });
  return { calls, mux, state, ws: new RecordingWS() };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function dispatch(mux: TmuxWsMux<RecordingWS>, message: JsonObject, ws: RecordingWS): void {
  // Deliberately cross the version boundary only here. The frozen input is not
  // typed as today's union, so changing the current type cannot rewrite it.
  mux.handleMessage(message as any, ws);
}

function clientGoldenLabel(message: JsonObject): string {
  if (message.type === "subscribe") return message.tail === undefined ? "subscribe/full" : "subscribe/tail";
  if (message.type === "history_expand") return message.afterLine === undefined ? "history/before" : "history/after";
  return String(message.type);
}

const EXPECTED_CLIENT_TYPES = [
  "client_info",
  "history_expand",
  "keys",
  "ping",
  "resize",
  "resync",
  "sessions_subscribe",
  "sessions_unsubscribe",
  "subscribe",
  "unsubscribe",
];

const EXPECTED_SERVER_VARIANTS = [
  "output/full",
  "output/resize",
  "output/resync",
  "delta",
  "cursor",
  "history",
  "sessions",
  "pong",
  "error",
];

function requireString(frame: JsonObject, field: string, type: string): string {
  const value = frame[field];
  if (typeof value !== "string") throw new Error(`v0.7.1 ${type}.${field} must be a string`);
  return value;
}

function requireInteger(frame: JsonObject, field: string, type: string): number {
  const value = frame[field];
  if (!Number.isInteger(value)) throw new Error(`v0.7.1 ${type}.${field} must be an integer`);
  return value as number;
}

function readCursor(frame: JsonObject, required: boolean, type: string): void {
  const present = Object.prototype.hasOwnProperty.call(frame, "cursor");
  if (!present) {
    if (required) throw new Error(`v0.7.1 ${type}.cursor is required`);
    return;
  }
  const cursor = frame.cursor;
  if (cursor === null) return;
  if (!isObject(cursor) || !Number.isInteger(cursor.row) || !Number.isInteger(cursor.col)) {
    throw new Error(`v0.7.1 ${type}.cursor must be null or integer row/col`);
  }
}

const utf8 = new TextEncoder();

function v071PrefixHash(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(JSON.stringify(lines))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

class V071ServerReader {
  private bases = new Map<string, string[]>();

  read(frame: unknown): string {
    if (!isObject(frame)) throw new Error("v0.7.1 frame must be an object");
    const type = requireString(frame, "type", "frame");
    if (type === "pong") return "pong";

    const channel = requireString(frame, "channel", type);
    switch (type) {
      case "output": {
        const data = requireString(frame, "data", type);
        readCursor(frame, false, type);
        let variant = "output/full";
        if (Object.prototype.hasOwnProperty.call(frame, "reset")) {
          if (frame.reset !== "resize" && frame.reset !== "resync") {
            throw new Error("v0.7.1 output.reset must be resize or resync");
          }
          variant = `output/${frame.reset}`;
        }
        this.bases.set(channel, data.split("\n"));
        return variant;
      }
      case "delta": {
        const base = this.bases.get(channel);
        if (!base) throw new Error(`v0.7.1 delta has no output base for ${channel}`);
        const baseLength = requireInteger(frame, "baseLength", type);
        const prefix = requireInteger(frame, "prefix", type);
        const prefixHash = requireString(frame, "prefixHash", type);
        if (baseLength !== base.length) throw new Error("v0.7.1 delta.baseLength does not match its output base");
        if (prefix < 0 || prefix > base.length) throw new Error("v0.7.1 delta.prefix is out of range");
        if (prefixHash !== v071PrefixHash(base.slice(0, prefix))) {
          throw new Error("v0.7.1 delta.prefixHash does not match its output base");
        }
        if (!Array.isArray(frame.lines) || !frame.lines.every((line) => typeof line === "string")) {
          throw new Error("v0.7.1 delta.lines must be a string array");
        }
        readCursor(frame, false, type);
        this.bases.set(channel, base.slice(0, prefix).concat(frame.lines as string[]));
        return "delta";
      }
      case "cursor":
        readCursor(frame, true, type);
        return "cursor";
      case "history": {
        const data = requireString(frame, "data", type);
        const page = JSON.parse(data) as unknown;
        if (
          !isObject(page)
          || !Array.isArray(page.lines)
          || !page.lines.every((line) => typeof line === "string")
          || !(page.startLine === null || Number.isInteger(page.startLine))
          || typeof page.hasMore !== "boolean"
        ) {
          throw new Error("v0.7.1 history.data must encode a history page");
        }
        return "history";
      }
      case "sessions": {
        if (channel !== "__sessions") throw new Error("v0.7.1 sessions.channel must be __sessions");
        const data = requireString(frame, "data", type);
        const sessions = JSON.parse(data) as unknown;
        if (!Array.isArray(sessions) || !sessions.every((row) => isObject(row) && typeof row.name === "string")) {
          throw new Error("v0.7.1 sessions.data must encode rows with names");
        }
        return "sessions";
      }
      case "error":
        requireString(frame, "data", type);
        return "error";
      default:
        throw new Error(`v0.7.1 reader does not know frame type ${type}`);
    }
  }
}

function withUnknownFields(frame: JsonObject): JsonObject {
  const extended: JsonObject = { ...frame, futureMinorField: { enabled: true } };
  if (isObject(frame.cursor)) extended.cursor = { ...frame.cursor, futureCursorField: "ignored" };
  if (frame.type === "history" && typeof frame.data === "string") {
    extended.data = JSON.stringify({ ...(JSON.parse(frame.data) as JsonObject), futurePageField: 1 });
  }
  if (frame.type === "sessions" && typeof frame.data === "string") {
    extended.data = JSON.stringify((JSON.parse(frame.data) as JsonObject[]).map((row) => ({
      ...row,
      futureSessionField: "ignored",
    })));
  }
  return extended;
}

async function produceCurrentServerFrames(): Promise<JsonObject[]> {
  const harness = createHarness();
  const { mux, state, ws } = harness;
  try {
    dispatch(mux, { type: "subscribe", session: SESSION, delta: true }, ws);
    await until(() => ws.frames("output").length > 0, "initial full output");
    const full = ws.frames("output").at(-1)!;
    mux.stop();

    const outputCountBeforeResize = ws.frames("output").length;
    dispatch(mux, { type: "resize", session: SESSION, cols: 120, rows: 40 }, ws);
    await until(
      () => ws.frames("output").slice(outputCountBeforeResize).some((frame) => frame.reset === "resize"),
      "resize reset output",
    );
    await until(() => (mux as any).queuedCapturesInFlight.size === 0, "resize capture completion");
    const resize = ws.frames("output").findLast((frame) => frame.reset === "resize")!;

    dispatch(mux, { type: "resync", session: SESSION }, ws);
    const resync = ws.frames("output").findLast((frame) => frame.reset === "resync")!;
    await until(() => (mux as any).queuedCapturesInFlight.size === 0, "resync capture completion");

    const changed = state.content.split("\n");
    changed[changed.length - 1] = "changed suffix";
    state.content = changed.join("\n");
    state.activity++;
    dispatch(mux, { type: "keys", session: SESSION, data: "delta-trigger" }, ws);
    await until(() => ws.frames("delta").length > 0, "delta output");
    await until(() => (mux as any).queuedCapturesInFlight.size === 0, "delta capture completion");
    const delta = ws.frames("delta").at(-1)!;

    state.cursor.x += 2;
    state.activity++;
    dispatch(mux, { type: "keys", session: SESSION, data: "cursor-trigger" }, ws);
    await until(() => ws.frames("cursor").length > 0, "cursor-only output");
    await until(() => (mux as any).queuedCapturesInFlight.size === 0, "cursor capture completion");
    const cursor = ws.frames("cursor").at(-1)!;

    dispatch(mux, { type: "history_expand", session: SESSION, beforeLine: null, limit: 500 }, ws);
    const history = ws.frames("history").at(-1)!;

    const listWS = new RecordingWS();
    dispatch(mux, { type: "sessions_subscribe" }, listWS);
    const sessions = listWS.frames("sessions").at(-1)!;
    dispatch(mux, { type: "ping" }, listWS);
    const pong = listWS.frames("pong").at(-1)!;

    expect(mux.invalidateSession(SESSION)).toBe(1);
    const error = ws.frames("error").at(-1)!;

    return [full, resize, resync, delta, cursor, history, sessions, pong, error];
  } finally {
    mux.stop();
  }
}

describe("v0.7.1 wire goldens", () => {
  test("headers pin the source revision and the additive-only editing policy", () => {
    for (const golden of [clientGolden, serverGolden]) {
      const header = golden.headers.join(" ");
      expect(header).toContain("tag=v0.7.1-dist");
      expect(header).toContain(GOLDEN_COMMIT);
      expect(header).toContain("major bump");
      expect(header).toContain("appending new lines (additive)");
      expect(header).toContain("breaking change");
      expect(header).toContain("CONTRACT.md");
    }
  });

  test("client fixture covers the complete v0.7.1 discriminator inventory and both subscribe modes", () => {
    const types = [...new Set(clientGolden.lines.map(({ value }) => String(value.type)))].sort();
    expect(types).toEqual(EXPECTED_CLIENT_TYPES);
    const subscriptions = clientGolden.lines.filter(({ value }) => value.type === "subscribe");
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.filter(({ value }) => value.tail === undefined)).toHaveLength(1);
    expect(subscriptions.filter(({ value }) => typeof value.tail === "number")).toHaveLength(1);
  });

  for (const golden of clientGolden.lines) {
    test(`client line ${golden.line} ${clientGoldenLabel(golden.value)} has an observable mux effect`, async () => {
      const harness = createHarness();
      const { calls, mux, state, ws } = harness;
      const message = golden.value;
      try {
        switch (message.type) {
          case "client_info":
            dispatch(mux, message, ws);
            expect(calls.clientInfo).toHaveLength(1);
            expect(calls.clientInfo[0]?.ws).toBe(ws);
            break;
          case "subscribe": {
            dispatch(mux, message, ws);
            await until(() => ws.frames("output").length > 0, "subscription output");
            expect(calls.subscribe).toBe(1);
            expect(calls.capture).toBeGreaterThan(0);
            const data = ws.frames("output").at(-1)?.data;
            expect(typeof data).toBe("string");
            const lineCount = String(data).split("\n").length;
            if (typeof message.tail === "number") expect(lineCount).toBe(message.tail);
            else expect(lineCount).toBeGreaterThan(8);
            break;
          }
          case "unsubscribe":
            mux.subscribe(SESSION, ws);
            await until(() => ws.frames("output").length > 0, "unsubscribe precondition");
            dispatch(mux, message, ws);
            expect(calls.unsubscribe).toBe(1);
            expect(mux.invalidateSession(SESSION)).toBe(0);
            break;
          case "keys":
            dispatch(mux, message, ws);
            expect(calls.keys).toHaveLength(1);
            expect(calls.keysHook).toBe(1);
            break;
          case "resize":
            dispatch(mux, message, ws);
            expect(calls.resize).toHaveLength(1);
            expect(calls.resizeTelemetry).toBe(1);
            break;
          case "history_expand":
            dispatch(mux, message, ws);
            if (Object.prototype.hasOwnProperty.call(message, "afterLine")) {
              expect(calls.historyAfter).toHaveLength(1);
              expect(calls.historyBefore).toHaveLength(0);
            } else {
              expect(calls.historyBefore).toHaveLength(1);
              expect(calls.historyAfter).toHaveLength(0);
            }
            expect(ws.frames("history")).toHaveLength(1);
            expect(() => JSON.parse(String(ws.frames("history")[0]?.data))).not.toThrow();
            break;
          case "ping":
            dispatch(mux, message, ws);
            expect(ws.frames("pong")).toHaveLength(1);
            break;
          case "sessions_subscribe":
            dispatch(mux, message, ws);
            expect(calls.listSessions).toBe(1);
            expect(ws.frames("sessions")).toHaveLength(1);
            break;
          case "sessions_unsubscribe":
            dispatch(mux, { type: "sessions_subscribe" }, ws);
            ws.clear();
            dispatch(mux, message, ws);
            state.sessions.push({
              name: "added-after-unsubscribe",
              created: "1720000002",
              windows: 1,
              attached: false,
              activityAt: 1720000003,
            });
            (mux as any).broadcastSessionList();
            expect(ws.frames("sessions")).toHaveLength(0);
            break;
          case "resync":
            mux.subscribe(SESSION, ws, undefined, { delta: true });
            await until(() => ws.frames("output").length > 0, "resync precondition");
            ws.clear();
            dispatch(mux, message, ws);
            expect(ws.frames("output").some((frame) => frame.reset === "resync")).toBe(true);
            break;
          default:
            throw new Error(`unhandled v0.7.1 client golden type ${String(message.type)}`);
        }
      } finally {
        mux.stop();
      }
    });
  }

  test("frozen v0.7.1 server frames parse in sequence and tolerate additive fields", () => {
    const reader = new V071ServerReader();
    const variants = serverGolden.lines.map(({ value }) => reader.read(value));
    expect(variants).toEqual(EXPECTED_SERVER_VARIANTS);

    const additiveReader = new V071ServerReader();
    const additiveVariants = serverGolden.lines.map(({ value }) => additiveReader.read(withUnknownFields(value)));
    expect(additiveVariants).toEqual(EXPECTED_SERVER_VARIANTS);
  });

  test("the v0.7.1 reader rejects a required field rename", () => {
    const frame = { ...serverGolden.lines[0]!.value, payload: serverGolden.lines[0]!.value.data };
    delete frame.data;
    expect(() => new V071ServerReader().read(frame)).toThrow("v0.7.1 output.data must be a string");
  });

  test("every current mux frame remains readable by the unknown-field-tolerant v0.7.1 reader", async () => {
    const frames = await produceCurrentServerFrames();
    const reader = new V071ServerReader();
    expect(frames.map((frame) => reader.read(frame))).toEqual(EXPECTED_SERVER_VARIANTS);

    const additiveReader = new V071ServerReader();
    expect(frames.map((frame) => additiveReader.read(withUnknownFields(frame)))).toEqual(EXPECTED_SERVER_VARIANTS);
  });
});

describe("v0.8.0 additive server wire goldens", () => {
  test("V2 attack: v0.7.1 MuxServerMessage consumers compile against the current declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-v071-source-compat-"));
    const declarationRoot = join(root, "current-declaration");
    const declarationPath = join(declarationRoot, "protocol.d.ts");
    const consumerPath = join(root, "consumer.ts");
    const protocolPath = resolve(import.meta.dir, "../../core/src/protocol.ts");
    const tscPath = resolve(import.meta.dir, "../../node_modules/.bin/tsc");

    try {
      const emit = Bun.spawnSync([
        tscPath,
        "--declaration",
        "--emitDeclarationOnly",
        "--strict",
        "--target", "ESNext",
        "--module", "Preserve",
        "--moduleResolution", "bundler",
        "--lib", "ESNext,DOM",
        "--outDir", declarationRoot,
        protocolPath,
      ]);
      const emitDiagnostics = `${emit.stdout.toString()}${emit.stderr.toString()}`;
      expect(emitDiagnostics).toBe("");
      expect(emit.exitCode).toBe(0);

      writeFileSync(consumerPath, [
        `import type { MuxServerMessage } from ${JSON.stringify(declarationPath)};`,
        "export function route(frame: MuxServerMessage): string {",
        "  const channel: string = frame.channel;",
        "  switch (frame.type) {",
        "    case \"output\":",
        "    case \"delta\":",
        "    case \"sessions\":",
        "    case \"history\":",
        "    case \"error\":",
        "    case \"cursor\":",
        "      return channel;",
        "    default: {",
        "      const exhaustive: never = frame;",
        "      return exhaustive;",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"));

      const result = Bun.spawnSync([
        tscPath,
        "--noEmit",
        "--strict",
        "--target", "ESNext",
        "--module", "Preserve",
        "--moduleResolution", "bundler",
        "--lib", "ESNext,DOM",
        "--allowImportingTsExtensions",
        consumerPath,
      ]);
      const diagnostics = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(diagnostics).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("pins the guarded-route auth_error frame reported by the V1 attack", () => {
    expect(authErrorGolden.headers.join(" ")).toContain("v0.8.0");
    expect(authErrorGolden.headers.join(" ")).toContain("appending new lines (additive)");
    expect(authErrorGolden.lines.map(({ value }) => value)).toEqual([
      { type: "auth_error", status: 403, code: "forbidden_session" },
    ]);
  });

  test("V1 attack: auth_error is exposed through additive server frame types", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-auth-error-typecheck-"));
    const attackPath = join(root, "auth-error-contract.ts");
    const protocolPath = resolve(import.meta.dir, "../../core/src/protocol.ts");
    const frame = authErrorGolden.lines[0]?.value;
    try {
      writeFileSync(attackPath, [
        `import type { MuxAuthErrorFrame, MuxServerFrame } from ${JSON.stringify(protocolPath)};`,
        `const denial: MuxAuthErrorFrame = ${JSON.stringify(frame)};`,
        "const frame: MuxServerFrame = denial;",
        "const cursor: MuxAuthErrorFrame[\"cursor\"] = undefined;",
        "void denial;",
        "void frame;",
        "void cursor;",
        "",
      ].join("\n"));
      const result = Bun.spawnSync([
        resolve(import.meta.dir, "../../node_modules/.bin/tsc"),
        "--noEmit",
        "--strict",
        "--target", "ESNext",
        "--module", "Preserve",
        "--moduleResolution", "bundler",
        "--lib", "ESNext,DOM",
        "--allowImportingTsExtensions",
        attackPath,
      ]);
      const diagnostics = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(diagnostics).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("V1 attack: packaged client exposes channel-less auth_error to the host", async () => {
    type HostListener = (event: { type: string; detail?: unknown }) => void;
    class HostEventTarget {
      private listeners = new Map<string, Set<HostListener>>();

      addEventListener(type: string, listener: HostListener): void {
        let listeners = this.listeners.get(type);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(type, listeners);
        }
        listeners.add(listener);
      }

      removeEventListener(type: string, listener: HostListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      dispatchEvent(event: { type: string; detail?: unknown }): boolean {
        for (const listener of this.listeners.get(event.type) ?? []) listener(event);
        return true;
      }
    }

    class AuthErrorWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static instances: AuthErrorWebSocket[] = [];

      readyState = AuthErrorWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      sent: string[] = [];

      constructor(_url: string) {
        AuthErrorWebSocket.instances.push(this);
      }

      send(data: string): void {
        this.sent.push(data);
      }

      close(): void {
        this.readyState = AuthErrorWebSocket.CLOSING;
      }

      open(): void {
        this.readyState = AuthErrorWebSocket.OPEN;
        this.onopen?.();
      }

      receive(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }

    const globalNames = ["window", "document", "navigator", "WebSocket", "$state"] as const;
    const originals = new Map(
      globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const setGlobal = (name: typeof globalNames[number], value: unknown): void => {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    const fakeWindow = Object.assign(new HostEventTarget(), {
      location: {
        protocol: "https:",
        host: "thumbmux.test",
        href: "https://thumbmux.test/terminal",
        pathname: "/terminal",
      },
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
      screen: { width: 390, height: 844 },
      visualViewport: undefined,
    });
    const fakeDocument = Object.assign(new HostEventTarget(), { visibilityState: "visible" });

    try {
      AuthErrorWebSocket.instances = [];
      setGlobal("$state", <T>(value: T) => value);
      setGlobal("window", fakeWindow);
      setGlobal("document", fakeDocument);
      setGlobal("navigator", { userAgent: "test", language: "en", platform: "test" });
      setGlobal("WebSocket", AuthErrorWebSocket);

      const { TmuxMux } = await import("../../svelte/src/ws-mux.svelte");
      const received: unknown[] = [];
      fakeWindow.addEventListener("thumbmux:auth-error", (event) => received.push(event.detail));

      const mux = new TmuxMux();
      const stopSessions = mux.onSessions(() => {});
      const socket = AuthErrorWebSocket.instances[0]!;
      socket.open();
      socket.receive({ type: "auth_error", status: 403, code: "forbidden_session" });

      expect(received).toEqual([
        { type: "auth_error", status: 403, code: "forbidden_session" },
      ]);

      stopSessions();
      mux.dispose();
    } finally {
      for (const name of globalNames) {
        const descriptor = originals.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});
