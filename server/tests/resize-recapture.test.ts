import { describe, expect, test } from "bun:test";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";

const SESSION = "sim-resize";

class FakeWS {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  outputFrames() {
    return this.sent.map((data) => JSON.parse(data)).filter((frame) =>
      frame.channel === SESSION && (frame.type === "output" || frame.type === "delta"));
  }
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

describe("resize recapture", () => {
  test("an accepted resize invalidates every viewer and forces a full resize reset", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
    const resizes: Array<{ cols: number; rows: number }> = [];
    let activity = 0;
    const driver: TmuxDriver = {
      listSessions: () => [{ name: SESSION }],
      capturePane: async () => content,
      captureWithCursor: async () => ({
        content,
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      }),
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, ++activity]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: (_session, cols, rows) => { resizes.push({ cols, rows }); },
      hash: (value) => value,
    };
    const mux = new TmuxWsMux({
      driver,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
      pollNormalMs: 10,
      pollReconcileMs: 10,
    });
    const full = new FakeWS();
    const tail = new FakeWS();
    try {
      mux.subscribe(SESSION, full, undefined, { delta: true });
      mux.subscribe(SESSION, tail, undefined, { tail: 4, delta: true });
      await until(() => full.outputFrames().length === 1 && tail.outputFrames().length === 1);
      const beforeFull = full.outputFrames().length;
      const beforeTail = tail.outputFrames().length;

      mux.handleMessage({ type: "resize", session: SESSION, cols: 100, rows: 31 }, full);
      await until(() => full.outputFrames().length > beforeFull && tail.outputFrames().length > beforeTail);

      expect(resizes).toEqual([{ cols: 100, rows: 31 }]);
      expect((mux as any).pendingArchiveReflows.has(SESSION)).toBe(false);
      expect(full.outputFrames().at(-1)).toMatchObject({ type: "output", reset: "resize", data: content });
      expect(tail.outputFrames().at(-1)).toMatchObject({
        type: "output",
        reset: "resize",
        data: content.split("\n").slice(-4).join("\n"),
      });
    } finally {
      mux.stop();
    }
  });

  test("passes replace through the first successful archive ingest after resize only", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
    let activity = 0;
    const driver: TmuxDriver = {
      listSessions: () => [{ name: SESSION }],
      capturePane: async () => content,
      captureWithCursor: async () => ({
        content,
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      }),
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, ++activity]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (value) => value,
    };
    const attempts: Array<boolean | undefined> = [];
    const successful: Array<boolean | undefined> = [];
    let failNext = false;
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, value, opts) => {
        attempts.push(opts.replace);
        if (failNext) {
          failNext = false;
          throw new Error("simulated archive failure");
        }
        successful.push(opts.replace);
        return { liveContent: value };
      },
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
      renameSession: () => {},
    };
    const mux = new TmuxWsMux({
      driver,
      archive,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: true }),
      pollNormalMs: 10,
      pollReconcileMs: 10,
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.outputFrames().length > 0);
      await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
      mux.stop();
      attempts.length = 0;
      successful.length = 0;

      const before = ws.outputFrames().length;
      failNext = true;
      mux.handleMessage({ type: "resize", session: SESSION, cols: 100, rows: 31 }, ws);
      await until(() => attempts.length === 1 && !(mux as any).queuedCapturesInFlight.has(SESSION));

      await (mux as any).captureAndBroadcastAsync(SESSION, new Set([ws]));
      await (mux as any).captureAndBroadcastAsync(SESSION, new Set([ws]));

      expect(attempts).toEqual([true, true, undefined]);
      expect(successful).toEqual([true, undefined]);
      expect(ws.outputFrames().length).toBeGreaterThan(before);
      expect(ws.outputFrames().at(-1)).toMatchObject({ type: "output", reset: "resize" });
    } finally {
      mux.stop();
    }
  });

  test("in-flight captures cannot consume newer resize generations", async () => {
    type Capture = {
      content: string;
      cursor: { x: number; y: number; paneHeight: number; visible: boolean };
      trailingBlanks: number;
    };
    function deferredCapture() {
      let resolve!: (capture: Capture) => void;
      const promise = new Promise<Capture>((done) => { resolve = done; });
      return { promise, resolve };
    }

    const oldCapture = deferredCapture();
    const firstResizeCapture = deferredCapture();
    const secondResizeCapture = deferredCapture();
    const deferred = [oldCapture, firstResizeCapture, secondResizeCapture];
    let captureCount = 0;
    const resizes: Array<{ cols: number; rows: number }> = [];
    const driver: TmuxDriver = {
      listSessions: () => [{ name: SESSION }],
      capturePane: async () => "",
      captureWithCursor: async () => {
        const next = deferred[captureCount++];
        if (next) return next.promise;
        return {
          content: "layout-2",
          cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
          trailingBlanks: 0,
        };
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, 1]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: (_session, cols, rows) => { resizes.push({ cols, rows }); },
      hash: (value) => value,
    };
    const ingests: Array<{
      content: string;
      fullHistory: boolean;
      replace: boolean | undefined;
    }> = [];
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, content, opts) => {
        ingests.push({ content, fullHistory: opts.fullHistory, replace: opts.replace });
        return { liveContent: content };
      },
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
      renameSession: () => {},
    };
    const mux = new TmuxWsMux({
      driver,
      archive,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: true }),
      pollNormalMs: 60_000,
      pollReconcileMs: 60_000,
    });
    const ws = new FakeWS();
    const late = new FakeWS();
    const viewers = new Set([ws]);
    (mux as any).subscribers.set(SESSION, viewers);
    (mux as any).setDeltaSubscription(SESSION, ws, true);
    (mux as any).contents.set(SESSION, "cached-old-layout");
    (mux as any).hashes.set(SESSION, "cached-old-layout");

    try {
      // This models the initial archive-seeding capture. Its one-shot full
      // history intent must survive both resize generations and land on C.
      const captureA = (mux as any).captureAndBroadcastAsync(SESSION, viewers, { fullHistory: true });
      await until(() => captureCount === 1);

      mux.applyGeometry(SESSION, 100, 31, ws);
      await until(() => captureCount === 2);
      mux.applyGeometry(SESSION, 80, 31, ws);

      oldCapture.resolve({
        content: "old-layout",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await captureA;
      expect(ingests).toEqual([]);
      expect(ws.outputFrames()).toEqual([]);
      expect((mux as any).queuedCapturesFullHistory.has(SESSION)).toBe(true);
      expect((mux as any).outputBases.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(ws)).toBe("resize");

      // A viewer arriving while B is stale must not receive cached-old-layout
      // or establish a delta base from it. Its first frame must wait for C.
      mux.subscribe(SESSION, late, undefined, { delta: true });
      expect(late.outputFrames()).toEqual([]);
      expect((mux as any).outputBases.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(late)).toBe("resize");

      firstResizeCapture.resolve({
        content: "layout-1",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await until(() => captureCount === 3);
      expect(ingests).toEqual([]);
      expect(ws.outputFrames()).toEqual([]);
      expect(late.outputFrames()).toEqual([]);
      expect((mux as any).outputBases.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).outputBases.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(ws)).toBe("resize");
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(late)).toBe("resize");

      secondResizeCapture.resolve({
        content: "layout-2",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
      await (mux as any).captureAndBroadcastAsync(SESSION, viewers);

      expect(resizes).toEqual([{ cols: 100, rows: 31 }, { cols: 80, rows: 31 }]);
      expect(ingests).toEqual([
        { content: "layout-2", fullHistory: true, replace: true },
        { content: "layout-2", fullHistory: false, replace: undefined },
      ]);
      expect(ws.outputFrames()).toHaveLength(1);
      expect(ws.outputFrames()[0]).toMatchObject({
        type: "output",
        data: "layout-2",
        reset: "resize",
      });
      expect(late.outputFrames()).toHaveLength(1);
      expect(late.outputFrames()[0]).toMatchObject({
        type: "output",
        data: "layout-2",
        reset: "resize",
      });
      expect((mux as any).outputBases.get(SESSION)?.get(ws)).toEqual(["layout-2"]);
      expect((mux as any).outputBases.get(SESSION)?.get(late)).toEqual(["layout-2"]);
      expect((mux as any).pendingOutputResets.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingArchiveReflows.has(SESSION)).toBe(false);
    } finally {
      mux.stop();
    }
  });
});
