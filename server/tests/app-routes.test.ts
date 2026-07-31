import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppRoutes } from "../src/app-routes";
import {
  createBunTmuxDriver,
  killTmuxSession,
} from "../src/bun-driver";
import { FileHistoryArchive } from "../src/history-archive";
import type { TmuxDriver, WsLike } from "../src/ws-mux";

type WireFrame = {
  channel?: string;
  type?: string;
  data?: string;
};

let sequence = 0;

function appRoutesPrefix(label: string): string {
  sequence += 1;
  return `approutes-${process.pid}-${label}-${Date.now()}-${sequence}`;
}

function hasTmuxSession(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0;
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
});
