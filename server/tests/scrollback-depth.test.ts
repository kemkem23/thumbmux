import { describe, expect, test } from "bun:test";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const SESSION = "scrollback-depth";
const HISTORY_LIMIT = 6_000;
const LIVE_LINE_LIMIT = 2_000;

class FakeWS {
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
    return 1;
  }

  outputFrames() {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.channel === SESSION && frame.type === "output");
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

function makeHarness() {
  const lines = Array.from({ length: HISTORY_LIMIT }, (_, index) => `line-${index + 1}`);
  const captureStarts: Array<number | undefined> = [];
  const driver: TmuxDriver = {
    listSessions: () => [{ name: SESSION }],
    capturePane: async (_session, opts) => {
      captureStarts.push(opts.startLine);
      const startLine = opts.startLine ?? -LIVE_LINE_LIMIT;
      return lines.slice(startLine).join("\n");
    },
    sendKeys: (_session, data) => { lines.push(data); },
    getSessionActivity: () => new Map([[SESSION, 1]]),
    getHistoryLimit: () => HISTORY_LIMIT,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
  const mux = new TmuxWsMux({
    driver,
    liveLineLimit: LIVE_LINE_LIMIT,
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    burstDurationMs: 60_000,
    pollReconcileMs: 60_000,
  });
  return { mux, lines, captureStarts };
}

async function waitForCaptureQueue(mux: TmuxWsMux<FakeWS>) {
  await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
}

describe("scrollback depth without a history archive", () => {
  test("keeps the normal live depth on the update after the full-history first paint", async () => {
    const { mux, captureStarts } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws);
      await until(() => ws.outputFrames().length === 1);
      await waitForCaptureQueue(mux);

      expect(ws.outputFrames()[0].data.split("\n")).toHaveLength(HISTORY_LIMIT);

      mux.handleKeys(SESSION, "update-after-first-paint", ws);
      await until(() => ws.outputFrames().length === 2);
      await waitForCaptureQueue(mux);

      const secondPaint = ws.outputFrames()[1];
      expect(secondPaint.data).toContain("update-after-first-paint");
      expect(secondPaint.data.split("\n")).toHaveLength(LIVE_LINE_LIMIT);
      expect(secondPaint.data.split("\n").length).toBeGreaterThan(250);
      expect(captureStarts).toEqual([-HISTORY_LIMIT, -LIVE_LINE_LIMIT]);
      expect((mux as any).archiveSeeded.has(SESSION)).toBe(true);
    } finally {
      mux.stop();
    }
  });

  test("does not repeat a full-history capture or disturb an existing viewer for a late subscriber", async () => {
    const { mux, captureStarts } = makeHarness();
    const existing = new FakeWS();
    const late = new FakeWS();
    try {
      mux.subscribe(SESSION, existing);
      await until(() => existing.outputFrames().length === 1);
      await waitForCaptureQueue(mux);

      mux.handleKeys(SESSION, "normal-depth-update", existing);
      await until(() => existing.outputFrames().length === 2);
      await waitForCaptureQueue(mux);
      const existingFramesBeforeLateSubscribe = existing.outputFrames().length;

      mux.subscribe(SESSION, late);
      await until(() => late.outputFrames().length >= 1);
      await waitForCaptureQueue(mux);

      expect(captureStarts).toEqual([
        -HISTORY_LIMIT,
        -LIVE_LINE_LIMIT,
        -LIVE_LINE_LIMIT,
      ]);
      expect(captureStarts.filter((start) => start === -HISTORY_LIMIT)).toHaveLength(1);
      expect(existing.outputFrames()).toHaveLength(existingFramesBeforeLateSubscribe);
      expect(late.outputFrames()).toHaveLength(1);
      expect(late.outputFrames()[0].data.split("\n")).toHaveLength(LIVE_LINE_LIMIT);
    } finally {
      mux.stop();
    }
  });

  test("reopens at the normal live depth after the last viewer disconnects", async () => {
    const { mux, captureStarts } = makeHarness();
    const first = new FakeWS();
    const reopened = new FakeWS();
    try {
      mux.subscribe(SESSION, first);
      await until(() => first.outputFrames().length === 1);
      await waitForCaptureQueue(mux);

      mux.unsubscribe(SESSION, first);
      mux.subscribe(SESSION, reopened);
      await until(() => reopened.outputFrames().length === 1);
      await waitForCaptureQueue(mux);

      expect(captureStarts).toEqual([-HISTORY_LIMIT, -LIVE_LINE_LIMIT]);
      expect(reopened.outputFrames()[0].data.split("\n")).toHaveLength(LIVE_LINE_LIMIT);
      expect(reopened.outputFrames()[0].data.split("\n").length).toBeGreaterThan(250);
    } finally {
      mux.stop();
    }
  });

  test("coalesces a subscriber arriving during bootstrap to one full-history capture", async () => {
    const lines = Array.from({ length: HISTORY_LIMIT }, (_, index) => `line-${index + 1}`);
    const captureStarts: Array<number | undefined> = [];
    let releaseFirstCapture!: () => void;
    const firstCaptureGate = new Promise<void>((resolve) => { releaseFirstCapture = resolve; });
    const driver: TmuxDriver = {
      listSessions: () => [{ name: SESSION }],
      capturePane: async (_session, opts) => {
        captureStarts.push(opts.startLine);
        if (captureStarts.length === 1) await firstCaptureGate;
        const startLine = opts.startLine ?? -LIVE_LINE_LIMIT;
        return lines.slice(startLine).join("\n");
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, 1]]),
      getHistoryLimit: () => HISTORY_LIMIT,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (content) => content,
    };
    const mux = new TmuxWsMux({
      driver,
      liveLineLimit: LIVE_LINE_LIMIT,
      pollNormalMs: 60_000,
      pollReconcileMs: 60_000,
    });
    const first = new FakeWS();
    const concurrent = new FakeWS();
    try {
      mux.subscribe(SESSION, first);
      await until(() => captureStarts.length === 1);

      mux.subscribe(SESSION, concurrent);
      releaseFirstCapture();
      await until(() =>
        captureStarts.length === 2
        && !(mux as any).queuedCapturesInFlight.has(SESSION));

      expect(captureStarts).toEqual([-HISTORY_LIMIT, -LIVE_LINE_LIMIT]);
      expect(captureStarts.filter((start) => start === -HISTORY_LIMIT)).toHaveLength(1);
      expect(first.outputFrames().map((frame) => frame.data.split("\n").length)).toEqual([
        HISTORY_LIMIT,
        LIVE_LINE_LIMIT,
      ]);
      expect(concurrent.outputFrames().map((frame) => frame.data.split("\n").length)).toEqual([
        HISTORY_LIMIT,
        LIVE_LINE_LIMIT,
      ]);
    } finally {
      mux.stop();
    }
  });
});
