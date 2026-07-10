import { describe, expect, test } from "bun:test";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

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
});
