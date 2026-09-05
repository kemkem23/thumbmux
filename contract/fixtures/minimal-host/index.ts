/*
 * FROZEN CONSUMER CONTRACT FIXTURE.
 * Changes require a matching contract-manifest update and the deprecation
 * process in CONTRACT.md. Do not update this file to follow an implementation.
 */

import type { TmuxDriver } from "thumbmux/server";
import { assertContractFixturePort, assertContractFixtureRuntime } from "./runtime-guard";

const privateRuntime = assertContractFixtureRuntime();
const {
  FileHistoryArchive,
  TmuxWsMux,
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
} = await import("thumbmux/server");

type WireFrame = {
  channel?: string;
  type: string;
  data?: string;
};

type HistoryPage = {
  lines: string[];
  startLine: number | null;
  hasMore: boolean;
};

type LiveSocket = {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
};

type UpgradeServer = {
  upgrade(request: Request, options: { data: Record<string, never> }): boolean;
};

type FixtureServer = {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
};

type SpawnResult = {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

type SocketHandlers = {
  open(socket: LiveSocket): void;
  message(socket: LiveSocket, message: string | Uint8Array | ArrayBuffer): void;
  close(socket: LiveSocket): void;
  drain(socket: LiveSocket): void;
};

type BunRuntime = {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request, server: UpgradeServer): Response | undefined;
    websocket: SocketHandlers;
  }): FixtureServer;
  spawnSync(command: string[]): SpawnResult;
};

const runtime = (globalThis as unknown as { Bun: BunRuntime }).Bun;
const unique = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const session = `ctrfix-min-${unique}`;
const archiveRoot = `${privateRuntime}/${session}-history`;
const seedPrefix = `CTR-FIXTURE-SEED-${unique}`;
const keysMarker = `CTR-FIXTURE-KEYS-${unique}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertNumber(actual: number, expected: number, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function decodeMessage(message: string | Uint8Array | ArrayBuffer): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(message);
}

function lineCount(data: string): number {
  if (data === "") return 0;
  return data.replace(/\n$/, "").split("\n").length;
}

async function connect(endpoint: string): Promise<{
  socket: WebSocket;
  frames: WireFrame[];
}> {
  const socket = new WebSocket(endpoint);
  const frames: WireFrame[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as WireFrame);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out opening WebSocket")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed to open"));
    }, { once: true });
  });
  return { socket, frames };
}

async function waitForFrame(
  frames: WireFrame[],
  startIndex: number,
  predicate: (frame: WireFrame) => boolean,
  label: string,
): Promise<WireFrame> {
  return until(
    () => frames.slice(startIndex).find(predicate),
    label,
  );
}

async function listenerIsClosed(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(`${url}/after-stop-${crypto.randomUUID()}`, {
      headers: { connection: "close" },
      signal: controller.signal,
    });
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function proveDrainCatchUp(): Promise<{ frames: number; latest: string }> {
  const probeSession = "ctrfix-drain-contract";
  let pane = "before-drain";
  let captures = 0;
  const driver: TmuxDriver = {
    listSessions: () => [{
      name: probeSession,
      created: "0",
      windows: 1,
      attached: false,
      activityAt: 0,
    }],
    capturePane: async () => {
      captures += 1;
      return pane;
    },
    sendKeys: (_session, data) => {
      pane = data;
    },
    getSessionActivity: () => new Map([[probeSession, captures]]),
    getHistoryLimit: () => 100,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };

  class BackpressuredSocket {
    readonly frames: WireFrame[] = [];
    private firstSend = true;

    send(data: string): number {
      this.frames.push(JSON.parse(data) as WireFrame);
      if (this.firstSend) {
        this.firstSend = false;
        return -1;
      }
      return 1;
    }
  }

  const mux = new TmuxWsMux<BackpressuredSocket>({
    driver,
    profile: () => ({ resize: false, currentPaneOnly: false, archive: false }),
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    pollReconcileMs: 60_000,
  });
  const socket = new BackpressuredSocket();

  try {
    mux.handleMessage({ type: "subscribe", session: probeSession }, socket);
    await until(() => mux.isBackpressured(socket), "deterministic backpressure");
    assertNumber(socket.frames.length, 1, "initial backpressured frame was not isolated");

    const latest = "after-drain";
    mux.handleMessage({ type: "keys", session: probeSession, data: latest }, socket);
    await until(() => captures >= 2, "capture while backpressured");
    assertNumber(socket.frames.length, 1, "a blocked socket received an unsolicited push");

    mux.handleDrain(socket);
    const catchUp = socket.frames.at(-1);
    assertNumber(socket.frames.length, 2, "handleDrain did not send one catch-up frame");
    assert(catchUp?.type === "output", "handleDrain catch-up was not an output frame");
    assert(catchUp.data === latest, "handleDrain replayed stale pane state");
    assert(!mux.isBackpressured(socket), "handleDrain left the socket blocked");
    return { frames: socket.frames.length, latest };
  } finally {
    mux.stop();
  }
}

async function main(): Promise<void> {
  assert(runtime && typeof runtime.serve === "function", "this fixture requires Bun");
  const tmuxVersion = runtime.spawnSync(["tmux", "-V"]);
  assert(tmuxVersion.exitCode === 0, "this fixture requires tmux");
  assert(session.startsWith("ctrfix-"), "fixture session must use the ctrfix- prefix");
  assert(archiveRoot.startsWith(`${privateRuntime}/ctrfix-min-`), "unsafe archive root");

  const driver = createBunTmuxDriver();
  const archive = new FileHistoryArchive({ root: archiveRoot, maxLines: 1_000 });
  const mux = new TmuxWsMux<LiveSocket>({
    driver,
    archive,
    liveLineLimit: 40,
    pollNormalMs: 80,
    pollBurstMs: 30,
    burstDurationMs: 1_000,
    pollReconcileMs: 200,
  });
  // Frozen consumers keep calling the legacy public spelling throughout its
  // promised removal window. This call must compile and execute against the
  // packed artifact, while the package emits its one-time warning.
  mux.broadcastSessionList();

  let server: FixtureServer | undefined;
  let serverSocket: LiveSocket | undefined;
  let client: WebSocket | undefined;
  let httpBase = "";
  let drainForwards = 0;
  let tailRows = 0;
  let fullRows = 0;
  let historyRows = 0;
  let failure: unknown;

  const handlers: SocketHandlers = {
    open(socket) {
      serverSocket = socket;
    },
    message(socket, message) {
      mux.handleMessage(JSON.parse(decodeMessage(message)), socket);
    },
    close(socket) {
      mux.unsubscribeAll(socket);
    },
    drain(socket) {
      drainForwards += 1;
      mux.handleDrain(socket);
    },
  };

  try {
    spawnTmuxSession(session, privateRuntime);
    driver.setSessionHistoryLimit(session, 1_000);
    driver.sendKeys(
      session,
      `i=1; while [ "$i" -le 180 ]; do printf '${seedPrefix}-%04d\\n' "$i"; i=$((i+1)); done\r`,
    );
    await until(
      async () => (await driver.capturePane(session, { startLine: -250 }))
        .includes(`${seedPrefix}-0180`) || false,
      "seeded tmux scrollback",
    );

    server = runtime.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, upgradeServer) {
        if (new URL(request.url).pathname === "/ws"
          && upgradeServer.upgrade(request, { data: {} })) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: handlers,
    });
    assertContractFixturePort(server.port);
    httpBase = `http://127.0.0.1:${server.port}`;
    const connected = await connect(`ws://127.0.0.1:${server.port}/ws`);
    client = connected.socket;
    const { frames } = connected;
    await until(() => serverSocket, "server-side WebSocket");

    let start = frames.length;
    client.send(JSON.stringify({ type: "subscribe", session, tail: 10 }));
    const tail = await waitForFrame(
      frames,
      start,
      (frame) => frame.channel === session && frame.type === "output",
      "tail output",
    );
    assert(typeof tail.data === "string", "tail output had no pane data");
    tailRows = lineCount(tail.data);
    assert(tailRows > 0 && tailRows <= 10, "tail subscription ignored its row bound");
    assert(tail.data.includes(seedPrefix), "tail output did not come from the real pane");

    client.send(JSON.stringify({ type: "unsubscribe", session }));
    start = frames.length;
    client.send(JSON.stringify({ type: "subscribe", session }));
    const full = await waitForFrame(
      frames,
      start,
      (frame) => frame.channel === session
        && frame.type === "output"
        && typeof frame.data === "string"
        && lineCount(frame.data) > tailRows,
      "full output after tail unsubscribe",
    );
    assert(typeof full.data === "string", "full output had no pane data");
    fullRows = lineCount(full.data);
    assert(fullRows > tailRows, "full subscription remained tail-sized");

    start = frames.length;
    client.send(JSON.stringify({
      type: "history_expand",
      session,
      beforeLine: null,
      limit: 1_000,
    }));
    const historyFrame = await waitForFrame(
      frames,
      start,
      (frame) => frame.channel === session && frame.type === "history",
      "history expansion after tail-to-full transition",
    );
    assert(typeof historyFrame.data === "string", "history frame had no page data");
    const history = JSON.parse(historyFrame.data) as HistoryPage;
    assert(Array.isArray(history.lines), "history page did not contain lines");
    historyRows = history.lines.length;
    assert(historyRows > 0, "tail-to-full transition lost all old rows");
    assert(
      history.lines.some((line) => line.includes(`${seedPrefix}-0001`)),
      "history expansion did not return the oldest real pane rows",
    );

    start = frames.length;
    client.send(JSON.stringify({
      type: "keys",
      session,
      data: `printf '%s\\n' '${keysMarker}'\r`,
    }));
    await waitForFrame(
      frames,
      start,
      (frame) => frame.channel === session
        && frame.type === "output"
        && typeof frame.data === "string"
        && frame.data.includes(keysMarker),
      "keys marker output",
    );
    await until(
      async () => (await driver.capturePane(session, { startLine: -100 }))
        .includes(keysMarker) || false,
      "keys marker in tmux pane",
    );

    const drainBefore = drainForwards;
    handlers.drain(serverSocket!);
    assert(drainForwards === drainBefore + 1, "Bun drain callback was not forwarded once");

    const backpressure = await proveDrainCatchUp();
    console.log(JSON.stringify({
      fixture: "minimal-host",
      session,
      tailRows,
      fullRows,
      historyRows,
      keysReachedPane: true,
      drainForwards,
      backpressure,
    }));
  } catch (error) {
    failure = error;
  } finally {
    try { client?.close(); } catch {}
    try { await server?.stop(true); } catch {}
    mux.stop();
    try { killTmuxSession(session); } catch {}
    // The outer runner removes the exact dev:ino-attested runtime with
    // rm --one-file-system after proving every listener/session is gone.
  }

  const sessionAbsent = !driver.listSessions().some((row) => row.name === session);
  const listenerClosed = httpBase === "" || await listenerIsClosed(httpBase);
  console.log(JSON.stringify({
    fixture: "minimal-host-cleanup",
    sessionAbsent,
    listenerClosed,
  }));
  assert(sessionAbsent, "fixture tmux session survived cleanup");
  assert(listenerClosed, "fixture listener survived cleanup");
  if (failure !== undefined) throw failure;
}

await main();
