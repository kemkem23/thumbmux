import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive, TmuxWsMux, type TmuxDriver } from "../src/index";

const SESSION = "reopen-live-depth";
const LIVE = 1000;
const TOTAL = 6000;

class FakeWS {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    return 1;
  }
  hasOutput() {
    return this.sent.some((frame) => frame.includes('"type":"output"'));
  }
}

function item(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

async function until(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met before timeout");
}

const harnesses: Array<{ mux: TmuxWsMux<FakeWS>; root: string }> = [];

afterEach(() => {
  for (const { mux, root } of harnesses.splice(0)) {
    mux.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("archive-seeded reopen capture depth", () => {
  test("reopens at full liveLineLimit depth, not the INITIAL -250 bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "reopen-depth-"));
    const lines = Array.from({ length: TOTAL }, (_, index) => `L${String(index + 1).padStart(5, "0")}`);
    const captureStarts: number[] = [];
    const driver: TmuxDriver = {
      listSessions: () => [item(SESSION)],
      capturePane: async (_session, opts) => {
        const start = opts.startLine ?? -LIVE;
        captureStarts.push(start);
        const from = start < 0 ? Math.max(0, lines.length + start) : start;
        return lines.slice(from).join("\n");
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, 1]]),
      getHistoryLimit: () => TOTAL,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (content) => content,
    };
    const mux = new TmuxWsMux<FakeWS>({
      driver,
      archive: new FileHistoryArchive({ root, maxLines: TOTAL }),
      liveLineLimit: LIVE,
      pollNormalMs: 60_000,
      pollBurstMs: 60_000,
      burstDurationMs: 60_000,
      pollReconcileMs: 60_000,
    });
    harnesses.push({ mux, root });

    const first = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SESSION }, first);
    await until(() => first.hasOutput());
    await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
    expect((mux as any).archiveSeeded.has(SESSION)).toBe(true);

    mux.handleMessage({ type: "unsubscribe", session: SESSION }, first);
    captureStarts.length = 0;

    const reopened = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SESSION }, reopened);
    await until(() => reopened.hasOutput());
    await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));

    // Pre-fix bug used INITIAL (-250) here, opening a 710-line seam against
    // an archive that ends at total-liveLineLimit.
    expect(captureStarts[0]).toBe(-LIVE);
    expect(captureStarts).not.toContain(-250);
  });
});

// ── NEWARCH L2-I lot I4: sessions routed to the pipe-pane projection ─────────
import type { MuxProjectionSnapshot, MuxProjectionSource } from "../src/index";

type Spy = { captures: number; pipes: number; ingests: number };
function projectionHarness(options: { owns: boolean; capture?: (call: number) => Promise<string> }) {
  const spy: Spy = { captures: 0, pipes: 0, ingests: 0 };
  let owns = options.owns;
  let generation = 1;
  let watchers = new Set<() => void>();
  const routeListeners = new Set<(session: string) => void>();
  let snapshot: MuxProjectionSnapshot = {
    content: [...HISTORY, "screen-a", "screen-b"].join("\n"),
    cursor: { row: 0, col: 3 },
    screen: { alt: false, mouseSgr: false, mouseAny: false },
    boundary: { generation: "newarch:x:%1:1:r1", liveStartLine: 10, walSequence: "5", walOffset: 5 },
    newarch: {
      v: "newarch-frame-v1", paneKey: { serverIdentity: "srv", paneId: "%1", birthGeneration: 1 },
      sourceEpoch: 1, geometryGeneration: 0, routeGeneration: 1, cols: 80, rows: 2, revision: 5, durableRevision: 4,
      nextLineId: 12, liveStartLine: 10, displaySource: "pipe", degraded: false, markers: [],
    },
  };
  const reads: Array<[string, number | null]> = [];
  const projection: MuxProjectionSource = {
    owns: () => owns,
    snapshot: () => (owns ? snapshot : null),
    routeGeneration: () => generation,
    watch: (_session, onChange) => { watchers.add(onChange); return () => { watchers.delete(onChange); }; },
    onRouteChange: (listener) => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; },
    readBefore: (_session, beforeLine) => { reads.push(["before", beforeLine]); return { lines: ["h9"], startLine: 9, hasMore: true }; },
    readAfter: (_session, afterLine) => { reads.push(["after", afterLine]); return { lines: [], startLine: null, hasMore: false }; },
  };
  const driver: TmuxDriver = {
    listSessions: () => [item(SESSION)],
    capturePane: async () => { spy.captures++; return options.capture ? options.capture(spy.captures) : "legacy-1\nlegacy-2"; },
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, 1]]),
    getHistoryLimit: () => 2000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver, projection,
    pipes: { startPipe: () => { spy.pipes++; return true; }, stopPipe: () => {}, handleRename: () => {} },
    archive: {
      ingestSnapshot: (_s, content) => { spy.ingests++; return { liveContent: content }; },
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }), renameSession: () => {},
    },
    pollNormalMs: 60_000, pollBurstMs: 60_000, burstDurationMs: 60_000, pollReconcileMs: 60_000,
  });
  harnesses.push({ mux, root: mkdtempSync(join(tmpdir(), "newarch-mux-")) });
  return {
    mux, spy, reads,
    set(next: Partial<MuxProjectionSnapshot> & { newarch?: Partial<MuxProjectionSnapshot["newarch"]> }) {
      snapshot = { ...snapshot, ...next, newarch: { ...snapshot.newarch, ...(next.newarch ?? {}) } };
    },
    fire() { for (const watcher of [...watchers]) watcher(); },
    route(to: boolean) { owns = to; generation++; for (const listener of [...routeListeners]) listener(SESSION); },
  };
}
const HISTORY = Array.from({ length: 60 }, (_, i) => `history row ${String(i + 10).padStart(4, "0")} with enough text to make a delta cheaper`);
const frames = (ws: FakeWS) => ws.sent.map((raw) => JSON.parse(raw)).filter((f) => f.channel === SESSION);

describe("NEWARCH I4: projection-routed sessions", () => {
  test("a routed session takes frames and history from the projection and never reaches the legacy ingress", async () => {
    const h = projectionHarness({ owns: true });
    const ws = new FakeWS();
    h.mux.handleMessage({ type: "subscribe", session: SESSION, delta: true }, ws);
    await until(() => frames(ws).some((f) => f.type === "output"));
    const first = frames(ws).find((f) => f.type === "output")!;
    expect(first.data).toBe([...HISTORY, "screen-a", "screen-b"].join("\n"));
    expect(first.newarch.v).toBe("newarch-frame-v1");
    expect(first.boundary.liveStartLine).toBe(10);

    // An append continues the base: a delta that carries the new descriptor.
    h.set({ content: [...HISTORY, "history row 0070", "screen-a", "screen-c"].join("\n"), newarch: { revision: 7, nextLineId: 71 }, boundary: { generation: "newarch:x:%1:1:r1", liveStartLine: 10, walSequence: "7", walOffset: 7 } });
    h.fire();
    await until(() => frames(ws).some((f) => f.type === "delta"));
    const delta = frames(ws).find((f) => f.type === "delta")!;
    expect(delta.newarch.revision).toBe(7);
    expect(delta.prefix).toBe(HISTORY.length);

    // A new source epoch cannot continue any base: a complete frame follows.
    const before = frames(ws).length;
    h.set({ content: [...HISTORY, "history row 0070", "screen-d"].join("\n"), newarch: { sourceEpoch: 2, revision: 9 } });
    h.fire();
    await until(() => frames(ws).length > before);
    expect(frames(ws).at(-1)!.type).toBe("output");

    h.mux.handleMessage({ type: "history_expand", session: SESSION, beforeLine: 10, limit: 1 } as never, ws);
    const page = JSON.parse(frames(ws).find((f) => f.type === "history")!.data);
    expect(page).toEqual({ lines: ["h9"], startLine: 9, hasMore: true });
    expect(h.reads).toEqual([["before", 10]]);

    h.mux.handleMessage({ type: "keys", session: SESSION, data: "x" } as never, ws);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Legacy ingress for the routed session: no capture, no dirty pipe, no archive ingest.
    expect(h.spy).toEqual({ captures: 0, pipes: 0, ingests: 0 });
  });

  test("a route switch resets viewers with resync and a legacy capture already in flight never publishes", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const h = projectionHarness({ owns: false, capture: (call) => (call === 1 ? gate : Promise.resolve("legacy-1\nlegacy-2")) });
    const ws = new FakeWS();
    h.mux.handleMessage({ type: "subscribe", session: SESSION, delta: true }, ws);
    await until(() => h.spy.captures === 1);
    h.route(true);
    await until(() => frames(ws).some((f) => f.type === "output"));
    const switched = frames(ws).filter((f) => f.type === "output");
    expect(switched).toHaveLength(1);
    expect(switched[0].reset).toBe("resync");
    expect(switched[0].newarch.routeGeneration).toBe(1);
    release("stale-legacy-row");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ws.sent.some((raw) => raw.includes("stale-legacy-row"))).toBe(false);
    expect(h.spy.ingests).toBe(0);

    // Back to legacy: one complete frame from a fresh legacy capture, marked resync, without a newarch descriptor.
    h.route(false);
    await until(() => frames(ws).filter((f) => f.type === "output").length === 2);
    const back = frames(ws).filter((f) => f.type === "output")[1];
    expect(back.reset).toBe("resync");
    expect(back.newarch).toBeUndefined();
    expect(back.data).toContain("legacy");
  });
});
