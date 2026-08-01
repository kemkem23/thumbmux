import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppRoutes } from "../src/app-routes";
import {
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
} from "../src/bun-driver";
import { FileHistoryArchive } from "../src/history-archive";
import {
  createTokenGuard,
  type HttpAuthorizationContext,
} from "../src/token-guard";
import type { TmuxDriver, WsLike } from "../src/ws-mux";

type WireFrame = {
  channel?: string;
  type?: string;
  data?: string;
  status?: number;
  code?: string;
  message?: string;
};

type CapturingSocket = WsLike & {
  data: unknown;
  frames: WireFrame[];
};

let sequence = 0;

function appRoutesPrefix(label: string): string {
  sequence += 1;
  return `approutes-${process.pid}-${label}-${Date.now()}-${sequence}`;
}

function hasTmuxSession(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0;
}

function paneContains(name: string, expected: string): boolean {
  const capture = Bun.spawnSync([
    "tmux",
    "capture-pane",
    "-t",
    `=${name}:`,
    "-p",
    "-S",
    "-100",
  ]);
  return capture.exitCode === 0 && capture.stdout.toString().includes(expected);
}

function killQuietly(name: string | null): void {
  if (!name) return;
  try {
    killTmuxSession(name);
  } catch {
    // The route may already have killed it; cleanup must preserve the first failure.
  }
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
      frames.push(JSON.parse(event.data) as WireFrame);
    } catch {
      // The app routes only emit JSON; a malformed frame will fail the waits below.
    }
  });
  return frames;
}

function createCapturingSocket(data: unknown): CapturingSocket {
  const frames: WireFrame[] = [];
  return {
    data,
    frames,
    send(raw) {
      frames.push(JSON.parse(raw) as WireFrame);
      return raw.length;
    },
  };
}

function sessionNames(frame: WireFrame | undefined): string[] {
  if (frame?.type !== "sessions" || typeof frame.data !== "string") return [];
  const rows = JSON.parse(frame.data) as Array<{ name?: unknown }>;
  return rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

async function closeWebSocket(ws: WebSocket | null): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
  });
  ws.close();
  await Promise.race([closed, Bun.sleep(1_000)]);
}

function inertDriver(rows: ReturnType<TmuxDriver["listSessions"]> = []): TmuxDriver {
  return {
    listSessions: () => rows,
    capturePane: async () => "",
    sendKeys: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => Bun.hash(content).toString(36),
  };
}

describe("createAppRoutes", () => {
  test("runs spawn/list/WS/kill end to end through a real Bun server and real tmux", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "thumbmux-app-routes-history-"));
    const driver = createBunTmuxDriver();
    const namePrefix = appRoutesPrefix("e2e");
    const marker = "APPROUTES_CALC=84823";
    const routes = createAppRoutes({
      driver,
      archive: new FileHistoryArchive({ root: archiveRoot }),
      spawn: { cwd: "/tmp", namePrefix },
      upload: false,
      prefs: false,
      mux: {
        pollNormalMs: 40,
        pollBurstMs: 20,
        pollReconcileMs: 40,
        sessionListIntervalMs: 40,
      },
    });

    let server: ReturnType<typeof Bun.serve> | null = null;
    let ws: WebSocket | null = null;
    let session: string | null = null;
    let restoreInvalidate: (() => void) | null = null;

    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req, bunServer) {
          return await routes.fetch(req, bunServer)
            ?? new Response("host fallback", { status: 418 });
        },
        websocket: routes.websocket,
      });
      const origin = `http://127.0.0.1:${server.port}`;

      const fallback = await fetch(`${origin}/host-owned`);
      expect(fallback.status).toBe(418);

      const spawnResponse = await fetch(`${origin}/api/spawn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "printf 'APPROUTES_CALC=%s\\n' \"$((271 * 313))\"",
        }),
      });
      const spawned = await spawnResponse.json() as { ok?: boolean; name?: string };
      session = spawned.name ?? null;

      expect(spawnResponse.status).toBe(201);
      expect(spawned.ok).toBe(true);
      expect(session?.startsWith(`${namePrefix}-`)).toBe(true);
      expect(session && hasTmuxSession(session)).toBe(true);

      const listResponse = await fetch(`${origin}/api/sessions`);
      const sessions = await listResponse.json() as Array<{ name?: string }>;
      expect(listResponse.status).toBe(200);
      expect(sessions.some((row) => row.name === session)).toBe(true);

      ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/tmux`);
      const frames = collectFrames(ws);
      await until(
        () => ws?.readyState === WebSocket.OPEN,
        "app-routes websocket did not open",
      );
      await until(
        () => frames.some((frame) => {
          if (frame.type !== "sessions" || frame.channel !== "__sessions") return false;
          const rows = JSON.parse(frame.data ?? "[]") as Array<{ name?: string }>;
          return rows.some((row) => row.name === session);
        }),
        "websocket open did not bootstrap the real session list",
      );

      ws.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => frames.some((frame) => (
          frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(marker)
        )),
        "real tmux output did not arrive through the websocket mux",
      );

      const nestedHostRoute = await fetch(
        `${origin}/api/sessions/${encodeURIComponent(session!)}/host-owned`,
        { method: "DELETE" },
      );
      expect(nestedHostRoute.status).toBe(418);
      expect(hasTmuxSession(session!)).toBe(true);

      let existedAtInvalidation: boolean | null = null;
      let invalidatedViewers: number | null = null;
      const invalidate = routes.mux.invalidateSession.bind(routes.mux);
      const invalidateSpy = spyOn(routes.mux, "invalidateSession").mockImplementation(
        (name, options) => {
          existedAtInvalidation = hasTmuxSession(name);
          invalidatedViewers = invalidate(name, options);
          return invalidatedViewers;
        },
      );
      restoreInvalidate = () => invalidateSpy.mockRestore();

      const errorsBeforeDelete = frames.filter((frame) => (
        frame.type === "error" && frame.channel === session
      )).length;
      const deleteResponse = await fetch(
        `${origin}/api/sessions/${encodeURIComponent(session!)}`,
        { method: "DELETE" },
      );
      const deleted = await deleteResponse.json() as { ok?: boolean; name?: string };

      expect(deleteResponse.status).toBe(200);
      expect(deleted).toEqual({ ok: true, name: session });
      expect(existedAtInvalidation).toBe(false);
      expect(invalidatedViewers).toBe(1);
      expect(hasTmuxSession(session!)).toBe(false);
      await until(
        () => frames.filter((frame) => (
          frame.type === "error" && frame.channel === session
        )).length > errorsBeforeDelete,
        "DELETE did not invalidate the subscribed mux lifecycle",
      );
      await until(
        () => frames.some((frame) => {
          if (frame.type !== "sessions" || frame.channel !== "__sessions") return false;
          const rows = JSON.parse(frame.data ?? "[]") as Array<{ name?: string }>;
          return !rows.some((row) => row.name === session);
        }),
        "session-list push did not remove the killed session",
      );

      const errorsBeforeResubscribe = frames.filter((frame) => (
        frame.type === "error" && frame.channel === session
      )).length;
      ws.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => frames.filter((frame) => (
          frame.type === "error" && frame.channel === session
        )).length > errorsBeforeResubscribe,
        "subscribing to the invalidated session did not produce an error",
      );
    } finally {
      restoreInvalidate?.();
      await closeWebSocket(ws);
      if (server) await server.stop(true);
      routes.mux.stop();
      killQuietly(session);
      await rm(archiveRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("composes upload and prefs handlers and honors a custom REST base path", async () => {
    const root = await mkdtemp(join(tmpdir(), "thumbmux-app-routes-http-"));
    const uploadDir = join(root, "uploads");
    const prefsFile = join(root, "prefs", "thumbmux.json");
    let listCalls = 0;
    const driver = inertDriver([{
      name: appRoutesPrefix("listed"),
      created: String(Date.now()),
      windows: 1,
      attached: false,
      activityAt: Date.now(),
    }]);
    const originalList = driver.listSessions;
    driver.listSessions = () => {
      listCalls += 1;
      return originalList();
    };
    const routes = createAppRoutes({
      driver,
      archive: null,
      spawn: false,
      upload: { dir: uploadDir },
      prefs: { file: prefsFile },
      kill: { enabled: false },
      basePath: "/thumbmux/",
    });
    const noUpgrade = { upgrade: () => false };

    try {
      expect(await routes.fetch(
        new Request("http://app.test/api/sessions"),
        noUpgrade,
      )).toBeNull();

      const listResponse = await routes.fetch(
        new Request("http://app.test/thumbmux/sessions"),
        noUpgrade,
      );
      expect(listResponse?.status).toBe(200);
      expect(await listResponse?.json()).toHaveLength(1);
      expect(listCalls).toBe(1);

      const form = new FormData();
      form.append("files", new File(["route-upload"], "route.txt"));
      const uploadResponse = await routes.fetch(
        new Request("http://app.test/thumbmux/upload", { method: "POST", body: form }),
        noUpgrade,
      );
      expect(uploadResponse?.status).toBe(201);
      const uploadResult = await uploadResponse?.json() as {
        files?: Array<{ stored?: string }>;
      };
      const storedFiles = await readdir(uploadDir);
      expect(storedFiles).toHaveLength(1);
      expect(storedFiles).toEqual([uploadResult.files?.[0]?.stored]);
      expect(storedFiles[0]).not.toBe("route.txt");

      const putPrefs = await routes.fetch(
        new Request("http://app.test/thumbmux/prefs", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontPx: 19, theme: { bg: "#123456" } }),
        }),
        noUpgrade,
      );
      expect(putPrefs?.status).toBe(200);
      const deleteFont = await routes.fetch(
        new Request("http://app.test/thumbmux/prefs", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontPx: null }),
        }),
        noUpgrade,
      );
      expect(deleteFont?.status).toBe(200);
      const getPrefs = await routes.fetch(
        new Request("http://app.test/thumbmux/prefs"),
        noUpgrade,
      );
      expect(await getPrefs?.json()).toEqual({ theme: { bg: "#123456" } });

      const wrongUploadMethod = await routes.fetch(
        new Request("http://app.test/thumbmux/upload"),
        noUpgrade,
      );
      expect(wrongUploadMethod?.status).toBe(405);
      const postPrefs = await routes.fetch(
        new Request("http://app.test/thumbmux/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontPx: 99 }),
        }),
        noUpgrade,
      );
      expect(postPrefs?.status).toBe(405);
      const prefsAfterHostMethod = await routes.fetch(
        new Request("http://app.test/thumbmux/prefs"),
        noUpgrade,
      );
      expect(await prefsAfterHostMethod?.json()).toEqual({ theme: { bg: "#123456" } });
    } finally {
      routes.mux.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("disabled HTTP routes return null so the host can continue routing", async () => {
    const routes = createAppRoutes({
      driver: inertDriver(),
      archive: null,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
    });
    const noUpgrade = { upgrade: () => false };
    const requests = [
      new Request("http://app.test/api/spawn", { method: "POST" }),
      new Request("http://app.test/api/upload", { method: "POST" }),
      new Request("http://app.test/api/prefs"),
      new Request("http://app.test/api/prefs", { method: "PUT" }),
      new Request(`http://app.test/api/sessions/${appRoutesPrefix("disabled")}`, {
        method: "DELETE",
      }),
    ];

    try {
      for (const request of requests) {
        expect(await routes.fetch(request, noUpgrade)).toBeNull();
      }
      expect(await routes.fetch(
        new Request("http://app.test/not-thumbmux"),
        noUpgrade,
      )).toBeNull();
    } finally {
      routes.mux.stop();
    }
  });

  test("enables spawn by default while storage routes without options stay host-owned", async () => {
    const routes = createAppRoutes({
      driver: inertDriver(),
      archive: null,
      kill: { enabled: false },
    });
    const noUpgrade = { upgrade: () => false };

    try {
      const spawnResponse = await routes.fetch(
        new Request("http://app.test/api/spawn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        noUpgrade,
      );
      expect(spawnResponse?.status).toBe(400);
      expect(await routes.fetch(
        new Request("http://app.test/api/spawn"),
        noUpgrade,
      )).toHaveProperty("status", 405);
      expect(await routes.fetch(
        new Request("http://app.test/api/upload", { method: "POST" }),
        noUpgrade,
      )).toBeNull();
      expect(await routes.fetch(
        new Request("http://app.test/api/prefs"),
        noUpgrade,
      )).toBeNull();
    } finally {
      routes.mux.stop();
    }
  });

  test("wires every websocket lifecycle callback, including binary messages and drain", () => {
    const routes = createAppRoutes({
      driver: inertDriver(),
      archive: null,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
    });
    const ws: WsLike = { send: () => 1 };
    const subscribe = spyOn(routes.mux, "subscribeSessions").mockImplementation(() => {});
    const message = spyOn(routes.mux, "handleMessage").mockImplementation(() => {});
    const unsubscribe = spyOn(routes.mux, "unsubscribeAll").mockImplementation(() => {});
    const drain = spyOn(routes.mux, "handleDrain").mockImplementation(() => {});

    try {
      routes.websocket.open(ws);
      routes.websocket.message(
        ws,
        new TextEncoder().encode(JSON.stringify({ type: "ping" })),
      );
      routes.websocket.message(ws, "not json");
      routes.websocket.drain(ws);
      routes.websocket.close(ws);

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenLastCalledWith(ws);
      expect(message).toHaveBeenCalledTimes(1);
      expect(message).toHaveBeenLastCalledWith({ type: "ping" }, ws);
      expect(drain).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenLastCalledWith(ws);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenLastCalledWith(ws);
    } finally {
      drain.mockRestore();
      unsubscribe.mockRestore();
      message.mockRestore();
      subscribe.mockRestore();
      routes.mux.stop();
    }
  });

  test("upgrades only the fixed GET websocket path and distinguishes handled upgrades", async () => {
    const routes = createAppRoutes({
      driver: inertDriver(),
      archive: null,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
    });
    let upgrades = 0;
    const acceptsUpgrade = {
      upgrade: () => {
        upgrades += 1;
        return true;
      },
    };

    try {
      const accepted = await routes.fetch(
        new Request("http://app.test/ws/tmux"),
        acceptsUpgrade,
      );
      expect(upgrades).toBe(1);
      expect(accepted).toBeInstanceOf(Response);
      expect(accepted?.status).toBe(204);

      expect(await routes.fetch(
        new Request("http://app.test/ws/tmux", { method: "POST" }),
        acceptsUpgrade,
      )).toBeNull();
      expect(await routes.fetch(
        new Request("http://app.test/api/ws/tmux"),
        acceptsUpgrade,
      )).toBeNull();
      expect(upgrades).toBe(1);
    } finally {
      routes.mux.stop();
    }
  });

  test("blocks the filter-only cross-session subscribe and keys attack", async () => {
    const driver = createBunTmuxDriver();
    const allowedSession = appRoutesPrefix("guard-a");
    const deniedSession = appRoutesPrefix("guard-b");
    const allowedSeed = `APPROUTES_ALLOWED_${Date.now()}`;
    const deniedSeed = `APPROUTES_HIDDEN_${Date.now()}`;
    const attemptedMarker = `APPROUTES_DENIED_KEYS_${Date.now()}`;
    const token = `app-routes-guard-${process.pid}-${Date.now()}`;
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
      kill: { enabled: false },
      mux: {
        pollNormalMs: 30,
        pollBurstMs: 15,
        pollReconcileMs: 30,
        sessionListIntervalMs: 30,
      },
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let ws: WebSocket | null = null;

    try {
      spawnTmuxSession(
        allowedSession,
        "/tmp",
        `printf '${allowedSeed}\\n'`,
      );
      spawnTmuxSession(
        deniedSession,
        "/tmp",
        `printf '${deniedSeed}\\n'`,
      );
      await until(
        () => paneContains(allowedSession, allowedSeed)
          && paneContains(deniedSession, deniedSeed),
        "guard attack fixtures did not reach their tmux panes",
      );

      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req, bunServer) {
          return await routes.fetch(req, bunServer)
            ?? new Response("host fallback", { status: 418 });
        },
        websocket: routes.websocket,
      });
      ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(token)}`,
      );
      const frames = collectFrames(ws);
      await until(
        () => ws?.readyState === WebSocket.OPEN,
        "guarded websocket did not open",
      );

      ws.send(JSON.stringify({ type: "subscribe", session: allowedSession }));
      await until(
        () => frames.some((frame) => (
          frame.type === "output"
          && frame.channel === allowedSession
          && frame.data?.includes(allowedSeed)
        )),
        "guarded principal could not read its allowed session",
      );

      const subscribeErrorsBefore = frames.filter((frame) => frame.type === "auth_error").length;
      ws.send(JSON.stringify({ type: "subscribe", session: deniedSession }));
      await until(
        () => frames.filter((frame) => frame.type === "auth_error").length > subscribeErrorsBefore
          || frames.some((frame) => frame.type === "output" && frame.channel === deniedSession),
        "cross-session subscribe produced neither a denial nor leaked output",
      );

      const keyErrorsBefore = frames.filter((frame) => frame.type === "auth_error").length;
      ws.send(JSON.stringify({
        type: "keys",
        session: deniedSession,
        data: `printf '${attemptedMarker}\\n'\r`,
      }));
      await until(
        () => frames.filter((frame) => frame.type === "auth_error").length > keyErrorsBefore
          || paneContains(deniedSession, attemptedMarker),
        "cross-session keys produced neither a denial nor a pane write",
      );

      expect(paneContains(deniedSession, attemptedMarker)).toBe(false);
      expect(frames.some((frame) => (
        frame.type === "output" && frame.channel === deniedSession
      ))).toBe(false);
      const authErrors = frames.filter((frame) => frame.type === "auth_error");
      expect(authErrors.slice(-2)).toEqual([
        { type: "auth_error", status: 403, code: "forbidden_session" },
        { type: "auth_error", status: 403, code: "forbidden_session" },
      ]);
      const listFrame = frames.find((frame) => (
        frame.type === "sessions" && frame.channel === "__sessions"
      ));
      expect(sessionNames(listFrame)).toEqual([allowedSession]);
    } finally {
      await closeWebSocket(ws);
      if (server) await server.stop(true);
      routes.mux.stop();
      killQuietly(allowedSession);
      killQuietly(deniedSession);
    }
  }, 30_000);

  test("V1 attack: an expired token stops an already-subscribed output stream", async () => {
    const driver = createBunTmuxDriver();
    const session = appRoutesPrefix("expiry-stream");
    const initialMarker = `APPROUTES_BEFORE_EXPIRY_${Date.now()}`;
    const afterMarker = `APPROUTES_AFTER_EXPIRY_${Date.now()}`;
    const token = `app-routes-expiry-stream-${process.pid}-${Date.now()}`;
    const controlToken = `app-routes-expiry-control-${process.pid}-${Date.now()}`;
    const expiresAt = 2_000;
    let now = 1_000;
    const guard = createTokenGuard({
      grants: [
        {
          token,
          scope: "read",
          expiresAt,
          sessions: [session],
        },
        {
          token: controlToken,
          scope: "read",
          expiresAt: 10_000,
          sessions: [session],
        },
      ],
      now: () => now,
    });
    const routes = createAppRoutes({
      driver,
      archive: null,
      guard,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
      mux: {
        pollNormalMs: 30,
        pollBurstMs: 15,
        pollReconcileMs: 30,
        sessionListIntervalMs: 30,
      },
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let ws: WebSocket | null = null;
    let controlWs: WebSocket | null = null;

    try {
      spawnTmuxSession(session, "/tmp", `printf '${initialMarker}\\n'`);
      await until(
        () => paneContains(session, initialMarker),
        "expiry attack fixture did not reach its tmux pane",
      );
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req, bunServer) {
          return await routes.fetch(req, bunServer)
            ?? new Response("host fallback", { status: 418 });
        },
        websocket: routes.websocket,
      });
      ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(token)}`,
      );
      const frames = collectFrames(ws);
      await until(() => ws?.readyState === WebSocket.OPEN, "expiry websocket did not open");
      ws.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => frames.some((frame) => frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(initialMarker)),
        "allowed pre-expiry output did not arrive",
      );
      controlWs = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(controlToken)}`,
      );
      const controlFrames = collectFrames(controlWs);
      await until(
        () => controlWs?.readyState === WebSocket.OPEN,
        "expiry control websocket did not open",
      );
      controlWs.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => controlFrames.some((frame) => frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(initialMarker)),
        "expiry control did not receive the authorized baseline",
      );

      now = expiresAt;
      await Bun.sleep(250);
      const typed = Bun.spawnSync([
        "tmux", "send-keys", "-t", `=${session}:`, "-l",
        `printf '${afterMarker}\\n'`,
      ]);
      expect(typed.exitCode).toBe(0);
      const submitted = Bun.spawnSync(["tmux", "send-keys", "-t", `=${session}:`, "Enter"]);
      expect(submitted.exitCode).toBe(0);
      await until(
        () => paneContains(session, afterMarker),
        "post-expiry marker did not reach the pane",
      );
      await until(
        () => controlFrames.some((frame) => frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(afterMarker)),
        "unexpired control did not receive post-expiry output",
      );
      await Bun.sleep(25);

      const leaked = frames.some((frame) => frame.channel === session
        && frame.data?.includes(afterMarker));
      console.log(`V1_EXPIRY_ATTACK leakedAfterExpiry=${leaked}`);
      expect(leaked).toBe(false);
    } finally {
      await closeWebSocket(ws);
      await closeWebSocket(controlWs);
      if (server) await server.stop(true);
      routes.mux.stop();
      killQuietly(session);
    }
  }, 30_000);

  test("V1 attack: revoked subscribed socket stops receiving fresh pane output", async () => {
    const session = appRoutesPrefix("v1-revoke");
    const beforeMarker = `V1_BEFORE_REVOKE_${Date.now()}`;
    const afterMarker = `V1_AFTER_REVOKE_${Date.now()}`;
    const token = `v1-revoke-${process.pid}-${Date.now()}`;
    const controlToken = `v1-revoke-control-${process.pid}-${Date.now()}`;
    const driver = createBunTmuxDriver();
    const guard = createTokenGuard({
      grants: [
        {
          token,
          scope: "read",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
        },
        {
          token: controlToken,
          scope: "read",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
        },
      ],
    });
    const routes = createAppRoutes({
      driver,
      archive: null,
      guard,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
      mux: {
        pollNormalMs: 20,
        pollBurstMs: 10,
        pollReconcileMs: 25,
        sessionListIntervalMs: 25,
      },
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let ws: WebSocket | null = null;
    let controlWs: WebSocket | null = null;

    try {
      spawnTmuxSession(session, "/tmp", `printf '${beforeMarker}\\n'`);
      await until(
        () => paneContains(session, beforeMarker),
        "V1 revoke fixture did not reach its pane",
      );
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req, bunServer) {
          return await routes.fetch(req, bunServer)
            ?? new Response("host fallback", { status: 418 });
        },
        websocket: routes.websocket,
      });
      ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(token)}`,
      );
      const frames = collectFrames(ws);
      await until(
        () => ws?.readyState === WebSocket.OPEN,
        "V1 revoked-output socket did not open",
      );
      ws.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => frames.some((frame) => (
          frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(beforeMarker)
        )),
        "V1 revoked-output socket did not receive the authorized baseline",
      );
      controlWs = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws/tmux?t=${encodeURIComponent(controlToken)}`,
      );
      const controlFrames = collectFrames(controlWs);
      await until(
        () => controlWs?.readyState === WebSocket.OPEN,
        "V1 revoke control websocket did not open",
      );
      controlWs.send(JSON.stringify({ type: "subscribe", session }));
      await until(
        () => controlFrames.some((frame) => (
          frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(beforeMarker)
        )),
        "V1 revoke control did not receive the authorized baseline",
      );

      expect(guard.revoke(token)).toBe(true);
      driver.sendKeys(session, `printf '${afterMarker}\\n'\\r`);
      await until(
        () => paneContains(session, afterMarker),
        "V1 post-revoke marker did not reach the pane",
      );
      await until(
        () => controlFrames.some((frame) => (
          frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(afterMarker)
        )),
        "unrevoked control did not receive post-revoke output",
      );
      await Bun.sleep(25);

      const leaked = frames.some((frame) => (
        frame.type === "output"
        && frame.channel === session
        && frame.data?.includes(afterMarker)
      ));
      console.log(`V1_REVOKE_ATTACK leakedAfterRevoke=${leaked}`);
      expect(leaked).toBe(false);
    } finally {
      await closeWebSocket(ws);
      await closeWebSocket(controlWs);
      if (server) await server.stop(true);
      routes.mux.stop();
      killQuietly(session);
    }
  }, 30_000);

  test("V1 revoke attack: revocation during subscribe blocks cached output", async () => {
    const session = appRoutesPrefix("revoke-subscribe");
    const marker = `V1_CACHED_BEFORE_REVOKE_${Date.now()}`;
    const token = `v1-revoke-subscribe-${process.pid}-${Date.now()}`;
    const controlToken = `v1-revoke-subscribe-control-${process.pid}-${Date.now()}`;
    const driver = inertDriver();
    driver.capturePane = async () => marker;
    const guard = createTokenGuard({
      grants: [
        {
          token,
          scope: "read",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
        },
        {
          token: controlToken,
          scope: "read",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
        },
      ],
    });
    let revokeResult: boolean | null = null;
    const routes = createAppRoutes({
      driver,
      archive: null,
      guard,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
      mux: {
        pollNormalMs: 20,
        pollReconcileMs: 20,
        hooks: {
          onSubscribe(_session, _ws, client) {
            if ((client as { revoke?: boolean } | undefined)?.revoke) {
              revokeResult = guard.revoke(token);
            }
          },
        },
      },
    });
    const upgrade = async (credential: string): Promise<unknown> => {
      let data: unknown;
      const response = await routes.fetch(
        new Request(`http://app.test/ws/tmux?t=${encodeURIComponent(credential)}`),
        {
          upgrade(_req, options) {
            data = (options as { data?: unknown } | undefined)?.data;
            return true;
          },
        },
      );
      expect(response?.status).toBe(204);
      return data;
    };
    const control = createCapturingSocket(await upgrade(controlToken));
    const attacker = createCapturingSocket(await upgrade(token));

    try {
      routes.websocket.open(control);
      routes.websocket.message(control, JSON.stringify({ type: "subscribe", session }));
      await until(
        () => control.frames.some((frame) => frame.type === "output"
          && frame.channel === session
          && frame.data?.includes(marker)),
        "control did not seed cached output before the subscribe-time revoke",
      );

      routes.websocket.open(attacker);
      attacker.frames.length = 0;
      routes.websocket.message(attacker, JSON.stringify({
        type: "subscribe",
        session,
        client: { revoke: true },
      }));

      const leaked = attacker.frames.some((frame) => frame.type === "output"
        && frame.channel === session
        && frame.data?.includes(marker));
      console.log(`V1_SUBSCRIBE_REVOKE_ATTACK leakedCachedOutput=${leaked}`);
      expect(revokeResult).toBe(true);
      expect(leaked).toBe(false);
    } finally {
      routes.websocket.close(attacker);
      routes.websocket.close(control);
      routes.mux.stop();
    }
  });

  test("authenticates upgrades, filters pushed lists, and rechecks expiry per message", async () => {
    const allowedSession = appRoutesPrefix("fake-a");
    const deniedSession = appRoutesPrefix("fake-b");
    const token = `app-routes-fake-${process.pid}-${Date.now()}`;
    const expiresAt = 2_000;
    let now = 1_000;
    let rows: ReturnType<TmuxDriver["listSessions"]> = [
      {
        name: allowedSession,
        created: "1",
        windows: 1,
        attached: false,
        activityAt: 1,
      },
      {
        name: deniedSession,
        created: "1",
        windows: 1,
        attached: false,
        activityAt: 1,
      },
    ];
    const driver = inertDriver();
    driver.listSessions = () => rows;
    let keyCalls = 0;
    driver.sendKeys = () => { keyCalls += 1; };
    const guard = createTokenGuard({
      grants: [{
        token,
        scope: "interactive",
        expiresAt,
        sessions: [allowedSession],
      }],
      now: () => now,
    });
    const hostFilterInputs: string[][] = [];
    let hostCloseCalls = 0;
    const routes = createAppRoutes({
      driver,
      archive: null,
      guard,
      spawn: false,
      upload: false,
      prefs: false,
      kill: { enabled: false },
      mux: {
        sessionListIntervalMs: 20,
        hooks: {
          filterSessionList(sessions) {
            hostFilterInputs.push(sessions.map(({ name }) => name));
            return [...sessions, rows.find(({ name }) => name === deniedSession)!];
          },
          onSocketClose() {
            hostCloseCalls += 1;
            throw new Error("host cleanup failed");
          },
        },
      },
    });
    let upgradeCalls = 0;
    let upgradeOptions: {
      data?: unknown;
      headers?: Record<string, string>;
    } | undefined;
    const acceptsUpgrade = {
      upgrade(_req: Request, options?: unknown) {
        upgradeCalls += 1;
        upgradeOptions = options as typeof upgradeOptions;
        return true;
      },
    };
    let socket: CapturingSocket | null = null;

    try {
      const missing = await routes.fetch(
        new Request("http://app.test/ws/tmux"),
        acceptsUpgrade,
      );
      expect(missing?.status).toBe(401);
      expect(await missing?.json()).toMatchObject({
        ok: false,
        status: 401,
        code: "missing_credential",
      });
      expect(upgradeCalls).toBe(0);

      const accepted = await routes.fetch(
        new Request(`http://app.test/ws/tmux?t=${encodeURIComponent(token)}`),
        acceptsUpgrade,
      );
      expect(accepted?.status).toBe(204);
      expect(upgradeCalls).toBe(1);
      expect(upgradeOptions?.data).toBeDefined();
      expect(JSON.stringify(upgradeOptions?.data)).not.toContain(token);
      expect(upgradeOptions?.headers?.["set-cookie"]).toContain("HttpOnly");

      socket = createCapturingSocket(upgradeOptions?.data);
      routes.websocket.open(socket);
      const initialLists = socket.frames.filter((frame) => frame.type === "sessions");
      expect(initialLists).toHaveLength(1);
      expect(sessionNames(initialLists[0])).toEqual([allowedSession]);

      rows = [
        rows[0]!,
        { ...rows[1]!, activityAt: 2 },
      ];
      await until(
        () => socket!.frames.filter((frame) => frame.type === "sessions").length >= 2,
        "guarded fake socket did not receive the changed session-list push",
      );
      const pushedLists = socket.frames.filter((frame) => frame.type === "sessions");
      expect(pushedLists.every((frame) => (
        JSON.stringify(sessionNames(frame)) === JSON.stringify([allowedSession])
      ))).toBe(true);
      expect(hostFilterInputs.length).toBeGreaterThanOrEqual(2);
      expect(hostFilterInputs.every((names) => (
        JSON.stringify(names) === JSON.stringify([allowedSession])
      ))).toBe(true);

      const malformedBefore = socket.frames.length;
      routes.websocket.message(socket, "not json");
      expect(socket.frames.slice(malformedBefore)).toEqual([
        { type: "auth_error", status: 403, code: "forbidden_operation" },
      ]);

      routes.websocket.message(socket, JSON.stringify({
        type: "keys",
        session: allowedSession,
        data: "before-expiry",
      }));
      expect(keyCalls).toBe(1);

      now = expiresAt;
      routes.websocket.message(socket, JSON.stringify({
        type: "keys",
        session: allowedSession,
        data: "after-expiry",
      }));
      expect(keyCalls).toBe(1);
      expect(socket.frames.at(-1)).toEqual({
        type: "auth_error",
        status: 401,
        code: "expired_credential",
      });

      routes.websocket.close(socket);
      expect(hostCloseCalls).toBe(1);
      socket = null;
    } finally {
      if (socket) routes.websocket.close(socket);
      routes.mux.stop();
    }
  });

  test("requires explicit sessions-kill permission and kills the exact session when granted", async () => {
    const session = appRoutesPrefix("kill-guard");
    const deniedToken = `app-routes-kill-denied-${process.pid}-${Date.now()}`;
    const allowedToken = `app-routes-kill-allowed-${process.pid}-${Date.now()}`;
    const guard = createTokenGuard({
      grants: [
        {
          token: deniedToken,
          scope: "interactive",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
        },
        {
          token: allowedToken,
          scope: "interactive",
          expiresAt: Date.now() + 60_000,
          sessions: [session],
          permissions: ["sessions-kill"],
        },
      ],
    });
    const authorizeHttp = guard.authorizeHttp.bind(guard);
    const authorizedOperations: Array<HttpAuthorizationContext["operation"]> = [];
    guard.authorizeHttp = (req, principal, context) => {
      authorizedOperations.push(context?.operation);
      return authorizeHttp(req, principal, context);
    };
    const routes = createAppRoutes({
      driver: createBunTmuxDriver(),
      archive: null,
      guard,
      spawn: false,
      upload: false,
      prefs: false,
    });
    const noUpgrade = { upgrade: () => false };

    try {
      spawnTmuxSession(session, "/tmp");
      expect(hasTmuxSession(session)).toBe(true);

      const denied = await routes.fetch(
        new Request(
          `http://app.test/api/sessions/${encodeURIComponent(session)}?t=${encodeURIComponent(deniedToken)}`,
          { method: "DELETE" },
        ),
        noUpgrade,
      );
      expect(denied?.status).toBe(403);
      expect(await denied?.json()).toMatchObject({
        ok: false,
        status: 403,
        code: "forbidden_scope",
      });
      expect(hasTmuxSession(session)).toBe(true);

      const allowed = await routes.fetch(
        new Request(
          `http://app.test/api/sessions/${encodeURIComponent(session)}?t=${encodeURIComponent(allowedToken)}`,
          { method: "DELETE" },
        ),
        noUpgrade,
      );
      expect(allowed?.status).toBe(200);
      expect(await allowed?.json()).toEqual({ ok: true, name: session });
      expect(hasTmuxSession(session)).toBe(false);
      expect(authorizedOperations).toContain("sessions-kill");
    } finally {
      routes.mux.stop();
      killQuietly(session);
    }
  });

  test("guards every HTTP operation on custom paths before invoking handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "thumbmux-app-routes-guard-http-"));
    const uploadDir = join(root, "uploads");
    const prefsFile = join(root, "prefs", "thumbmux.json");
    const visibleSession = appRoutesPrefix("http-visible");
    const hiddenSession = appRoutesPrefix("http-hidden");
    const spawnedSession = appRoutesPrefix("http-spawned");
    const readToken = `app-routes-http-read-${process.pid}-${Date.now()}`;
    const interactiveToken = `app-routes-http-interactive-${process.pid}-${Date.now()}`;
    const expiresAt = Date.now() + 60_000;
    const driver = inertDriver([
      {
        name: visibleSession,
        created: "1",
        windows: 1,
        attached: false,
        activityAt: 1,
      },
      {
        name: hiddenSession,
        created: "1",
        windows: 1,
        attached: false,
        activityAt: 1,
      },
    ]);
    let spawnCalls = 0;
    const guard = createTokenGuard({
      grants: [
        {
          token: readToken,
          scope: "read",
          expiresAt,
          sessions: [visibleSession],
        },
        {
          token: interactiveToken,
          scope: "interactive",
          expiresAt,
          permissions: ["sessions-kill"],
        },
      ],
    });
    const authorizeHttp = guard.authorizeHttp.bind(guard);
    const authorizedOperations: Array<HttpAuthorizationContext["operation"]> = [];
    guard.authorizeHttp = (req, principal, context) => {
      authorizedOperations.push(context?.operation);
      return authorizeHttp(req, principal, context);
    };
    const routes = createAppRoutes({
      driver,
      archive: null,
      guard,
      basePath: "/thumbmux",
      spawn: {
        cwd: root,
        spawn: () => { spawnCalls += 1; },
      },
      upload: { dir: uploadDir },
      prefs: { file: prefsFile },
    });
    const noUpgrade = { upgrade: () => false };
    const tokenUrl = (path: string, token: string): string => {
      const separator = path.includes("?") ? "&" : "?";
      return `http://app.test${path}${separator}t=${encodeURIComponent(token)}`;
    };

    try {
      const missingSpawn = await routes.fetch(
        new Request("http://app.test/thumbmux/spawn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: spawnedSession }),
        }),
        noUpgrade,
      );
      expect(missingSpawn?.status).toBe(401);
      expect(spawnCalls).toBe(0);

      const deniedSpawn = await routes.fetch(
        new Request(tokenUrl("/thumbmux/spawn", readToken), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: spawnedSession }),
        }),
        noUpgrade,
      );
      expect(deniedSpawn?.status).toBe(403);
      expect(await deniedSpawn?.json()).toMatchObject({ code: "forbidden_scope" });
      expect(spawnCalls).toBe(0);

      const allowedSpawn = await routes.fetch(
        new Request(tokenUrl("/thumbmux/spawn", interactiveToken), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: spawnedSession }),
        }),
        noUpgrade,
      );
      expect(allowedSpawn?.status).toBe(201);
      expect(spawnCalls).toBe(1);
      expect(allowedSpawn?.headers.get("set-cookie")).toContain("HttpOnly");

      const list = await routes.fetch(
        new Request(tokenUrl("/thumbmux/sessions", readToken)),
        noUpgrade,
      );
      expect(list?.status).toBe(200);
      expect((await list?.json() as Array<{ name?: string }>).map(({ name }) => name))
        .toEqual([visibleSession]);

      const deniedUpload = await routes.fetch(
        new Request(tokenUrl("/thumbmux/upload", readToken), {
          method: "POST",
          body: new FormData(),
        }),
        noUpgrade,
      );
      expect(deniedUpload?.status).toBe(403);
      expect(await deniedUpload?.json()).toMatchObject({ code: "forbidden_scope" });

      const form = new FormData();
      form.append("files", new File(["guarded-upload"], "guarded.txt"));
      const allowedUpload = await routes.fetch(
        new Request(tokenUrl("/thumbmux/upload", interactiveToken), {
          method: "POST",
          body: form,
        }),
        noUpgrade,
      );
      expect(allowedUpload?.status).toBe(201);
      expect(await readdir(uploadDir)).toHaveLength(1);

      const deniedPrefs = await routes.fetch(
        new Request(tokenUrl("/thumbmux/prefs", readToken), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontPx: 99 }),
        }),
        noUpgrade,
      );
      expect(deniedPrefs?.status).toBe(403);
      expect(await deniedPrefs?.json()).toMatchObject({ code: "forbidden_scope" });

      const allowedPrefs = await routes.fetch(
        new Request(tokenUrl("/thumbmux/prefs", interactiveToken), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontPx: 21 }),
        }),
        noUpgrade,
      );
      expect(allowedPrefs?.status).toBe(200);
      const readPrefs = await routes.fetch(
        new Request(tokenUrl("/thumbmux/prefs", readToken)),
        noUpgrade,
      );
      expect(await readPrefs?.json()).toEqual({ fontPx: 21 });

      const wrongMethods = [
        ["/thumbmux/spawn", "GET", "POST"],
        ["/thumbmux/upload", "GET", "POST"],
        ["/thumbmux/prefs", "POST", "GET, PUT"],
        ["/thumbmux/sessions", "POST", "GET"],
        [`/thumbmux/sessions/${encodeURIComponent(visibleSession)}`, "GET", "DELETE"],
        ["/ws/tmux", "POST", "GET"],
      ] as const;
      for (const [path, method, allow] of wrongMethods) {
        const response = await routes.fetch(
          new Request(`http://app.test${path}`, { method }),
          noUpgrade,
        );
        expect(response?.status).toBe(405);
        expect(response?.headers.get("allow")).toBe(allow);
      }
      for (const operation of [
        "sessions-list",
        "sessions-spawn",
        "upload",
        "prefs-read",
        "prefs-write",
      ] as const) {
        expect(authorizedOperations).toContain(operation);
      }
    } finally {
      routes.mux.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
