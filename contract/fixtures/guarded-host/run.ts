/*
 * FROZEN CONTRACT FIXTURE — RULES §9.
 * Changes require a matching contract manifest change and the CONTRACT.md
 * deprecation procedure.
 */

import type { TmuxDriver } from "thumbmux/server";
import { assertContractFixturePort, assertContractFixtureRuntime } from "./runtime-guard";

const privateRuntime = assertContractFixtureRuntime();
const {
  createAppRoutes,
  createBunTmuxDriver,
  createTokenGuard,
  killTmuxSession,
  spawnTmuxSession,
} = await import("thumbmux/server");

type WireFrame = {
  channel?: string;
  type?: string;
  data?: string;
  status?: number;
  code?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(message);
}

function collectFrames(ws: WebSocket): WireFrame[] {
  const frames: WireFrame[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (typeof parsed === "object" && parsed !== null) {
        frames.push(parsed as WireFrame);
      }
    } catch {
      // Malformed package output cannot satisfy any assertion below.
    }
  });
  return frames;
}

function sessionNames(frame: WireFrame | undefined): string[] {
  if (frame?.type !== "sessions" || typeof frame.data !== "string") return [];
  const parsed: unknown = JSON.parse(frame.data);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row: unknown) => {
      if (typeof row !== "object" || row === null) return null;
      const name = (row as { name?: unknown }).name;
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => name !== null);
}

async function paneContains(
  driver: TmuxDriver,
  session: string,
  marker: string,
): Promise<boolean> {
  try {
    const content = await driver.capturePane(session, {
      currentPaneOnly: false,
      startLine: -100,
    });
    return content.includes(marker);
  } catch {
    return false;
  }
}

function hasSession(driver: TmuxDriver, session: string): boolean {
  return driver.listSessions().some(({ name }) => name === session);
}

function killQuietly(session: string): void {
  try {
    killTmuxSession(session);
  } catch {
    // A failed assertion must not prevent cleanup of the other session.
  }
}

async function closeWebSocket(ws: WebSocket | null): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
  });
  ws.close();
  await Promise.race([closed, Bun.sleep(1_000)]);
}

async function listenerIsClosed(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/listener-probe`, {
      signal: AbortSignal.timeout(500),
    });
    return false;
  } catch {
    return true;
  }
}

const runId = `${process.pid}-${Date.now()}`;
const allowedSession = `ctrfix-guard-${runId}-allowed`;
const deniedSession = `ctrfix-guard-${runId}-denied`;
const allowedSeed = `CTR_FIX_ALLOWED_${runId}`;
const deniedSeed = `CTR_FIX_DENIED_${runId}`;
const attemptedMarker = `CTR_FIX_BLOCKED_KEYS_${runId}`;
const token = `ctrfix-token-${runId}`;
const driver = createBunTmuxDriver();
const guard = createTokenGuard({
  grants: [{
    token,
    scope: "interactive",
    expiresAt: Date.now() + 60_000,
    sessions: [allowedSession],
  }],
});
const routes = createAppRoutes({
  driver,
  archive: null,
  guard,
  spawn: false,
  upload: false,
  prefs: false,
  kill: { enabled: true },
  mux: {
    pollNormalMs: 30,
    pollBurstMs: 15,
    pollReconcileMs: 30,
    sessionListIntervalMs: 30,
  },
});

let server: ReturnType<typeof Bun.serve> | null = null;
let ws: WebSocket | null = null;
let origin = "";
let listenerClosed = false;
let killStatus = 0;
let subscribeDenied = false;
let keysDenied = false;
let markerAbsent = false;

try {
  spawnTmuxSession(
    allowedSession,
    privateRuntime,
    `printf '${allowedSeed}\\n'`,
  );
  spawnTmuxSession(
    deniedSession,
    privateRuntime,
    `printf '${deniedSeed}\\n'`,
  );
  await until(
    async () => await paneContains(driver, allowedSession, allowedSeed)
      && await paneContains(driver, deniedSession, deniedSeed),
    "guard fixture seeds did not reach their tmux panes",
  );

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, bunServer) {
      return await routes.fetch(req, bunServer)
        ?? new Response("not found", { status: 404 });
    },
    websocket: routes.websocket,
  });
  assertContractFixturePort(server.port);
  origin = `http://127.0.0.1:${server.port}`;

  ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(token)}`,
  );
  const frames = collectFrames(ws);
  await until(
    () => ws?.readyState === WebSocket.OPEN,
    "guarded WebSocket did not open",
  );

  ws.send(JSON.stringify({ type: "subscribe", session: allowedSession }));
  await until(
    () => frames.some((frame) => frame.type === "output"
      && frame.channel === allowedSession
      && frame.data?.includes(allowedSeed)),
    "the guarded principal could not read its allowed session",
  );

  const sessionsFrame = frames.find((frame) =>
    frame.type === "sessions" && frame.channel === "__sessions"
  );
  assert(
    JSON.stringify(sessionNames(sessionsFrame)) === JSON.stringify([allowedSession]),
    "the guarded session list exposed a session outside the allowlist",
  );

  const subscribeErrorsBefore = frames.filter((frame) =>
    frame.type === "auth_error"
  ).length;
  ws.send(JSON.stringify({ type: "subscribe", session: deniedSession }));
  await until(
    () => frames.filter((frame) => frame.type === "auth_error").length
        > subscribeErrorsBefore
      || frames.some((frame) =>
        frame.type === "output" && frame.channel === deniedSession
      ),
    "cross-session subscribe produced neither a denial nor leaked output",
  );
  const subscribeError = frames.filter((frame) =>
    frame.type === "auth_error"
  ).at(subscribeErrorsBefore);
  subscribeDenied = subscribeError?.status === 403
    && subscribeError.code === "forbidden_session";
  assert(subscribeDenied, "cross-session subscribe was not denied with auth_error 403");
  // A broken guard could emit a denial and still fall through to the async mux
  // subscribe path. Give several poll cycles a chance to expose that leak.
  await Bun.sleep(150);
  assert(
    !frames.some((frame) =>
      frame.type === "output" && frame.channel === deniedSession
    ),
    "cross-session subscribe exposed output from the denied session",
  );

  const keyErrorsBefore = frames.filter((frame) =>
    frame.type === "auth_error"
  ).length;
  ws.send(JSON.stringify({
    type: "keys",
    session: deniedSession,
    data: `printf '${attemptedMarker}\\n'\r`,
  }));
  await until(
    async () => frames.filter((frame) => frame.type === "auth_error").length
        > keyErrorsBefore
      || await paneContains(driver, deniedSession, attemptedMarker),
    "cross-session keys produced neither a denial nor a pane write",
  );
  const keysError = frames.filter((frame) =>
    frame.type === "auth_error"
  ).at(keyErrorsBefore);
  keysDenied = keysError?.status === 403
    && keysError.code === "forbidden_session";
  assert(keysDenied, "cross-session keys were not denied with auth_error 403");
  await Bun.sleep(150);
  markerAbsent = !await paneContains(driver, deniedSession, attemptedMarker);
  assert(
    markerAbsent,
    "cross-session keys reached the denied tmux pane",
  );

  const killResponse = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(allowedSession)}?t=${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  killStatus = killResponse.status;
  const killBody = await killResponse.json() as { code?: unknown };
  assert(killStatus === 403, "session kill without permission was not denied with HTTP 403");
  assert(
    killBody.code === "forbidden_scope",
    "session kill without permission returned the wrong guard error",
  );
  assert(
    hasSession(driver, allowedSession),
    "a denied session kill still removed the allowed session",
  );
} finally {
  await closeWebSocket(ws);
  if (server) {
    await server.stop(true);
    listenerClosed = await listenerIsClosed(origin);
  }
  routes.mux.stop();
  killQuietly(allowedSession);
  killQuietly(deniedSession);
}

const remainingSessions = driver.listSessions()
  .map(({ name }) => name)
  .filter((name) => name === allowedSession || name === deniedSession);
assert(listenerClosed, "the guarded fixture listener remained open after server.stop");
assert(remainingSessions.length === 0, "the guarded fixture left tmux sessions behind");

console.log(JSON.stringify({
  fixture: "guarded-host",
  subscribeDenied,
  keysDenied,
  markerAbsent,
  killStatus,
  cleanup: {
    listenerClosed,
    remainingSessions,
  },
}));
