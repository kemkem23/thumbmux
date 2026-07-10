import { describe, expect, test } from "bun:test";
import { applyMuxDelta, splitMuxOutputData } from "../../core/src/protocol";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const SESSION = "sim-delta";

type Frame = Record<string, any>;

class FakeWS {
  sent: string[] = [];
  attempts = 0;
  failSends = 0;
  droppedSends = 0;

  send(data: string) {
    this.attempts += 1;
    if (this.failSends > 0) {
      this.failSends -= 1;
      throw new Error("simulated send failure");
    }
    if (this.droppedSends > 0) {
      this.droppedSends -= 1;
      return 0;
    }
    this.sent.push(data);
    return data.length;
  }

  frames(channel = SESSION): Frame[] {
    return this.sent.map((data) => JSON.parse(data)).filter((frame) =>
      frame.channel === channel && (frame.type === "output" || frame.type === "delta"));
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

function longContent(last = "initial") {
  return [...Array.from({ length: 80 }, (_, index) => `stable-${index}`), last].join("\n");
}

function makeHarness(initial = longContent()) {
  const contents = new Map([[SESSION, initial]]);
  const resizes: Array<{ session: string; cols: number; rows: number }> = [];
  let activity = 0;
  const cursor = { x: 4, y: 0, paneHeight: 1, visible: true };
  const driver: TmuxDriver = {
    listSessions: () => [...contents.keys()].map((name) => ({ name })),
    capturePane: async (session) => contents.get(session) ?? "",
    captureWithCursor: async (session) => ({
      content: contents.get(session) ?? "",
      cursor: { ...cursor },
      trailingBlanks: 0,
    }),
    sendKeys: () => {},
    getSessionActivity: () => {
      activity += 1;
      return new Map([...contents.keys()].map((session) => [session, activity]));
    },
    getHistoryLimit: () => 2000,
    setSessionHistoryLimit: () => {},
    resizeWindow: (session, cols, rows) => { resizes.push({ session, cols, rows }); },
    hash: (content) => content,
  };
  const mux = new TmuxWsMux({
    driver,
    profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
  });
  return {
    mux,
    cursor,
    resizes,
    setContent: (content: string, session = SESSION) => contents.set(session, content),
    renameContent: (from: string, to: string) => {
      const content = contents.get(from) ?? "";
      contents.delete(from);
      contents.set(to, content);
    },
  };
}

describe("server delta conformance", () => {
  test("sends full first, then independently reconstructable full and tail deltas", async () => {
    const { mux, setContent } = makeHarness();
    const full = new FakeWS();
    const tail = new FakeWS();
    try {
      mux.subscribe(SESSION, full, undefined, { delta: true });
      await until(() => full.frames().length === 1);
      const fullFirst = full.frames()[0];
      expect(fullFirst.type).toBe("output");

      mux.subscribe(SESSION, tail, undefined, { tail: 60, delta: true });
      await until(() => tail.frames().length === 1);
      const tailFirst = tail.frames()[0];
      expect(tailFirst.type).toBe("output");
      expect(splitMuxOutputData(tailFirst.data)).toHaveLength(60);

      setContent(longContent("changed"));
      await until(() => full.frames().some((frame) => frame.type === "delta")
        && tail.frames().some((frame) => frame.type === "delta"));
      const fullDelta = full.frames().findLast((frame) => frame.type === "delta");
      const tailDelta = tail.frames().findLast((frame) => frame.type === "delta");

      expect(fullDelta.baseLength).toBe(splitMuxOutputData(fullFirst.data).length);
      expect(tailDelta.baseLength).toBe(splitMuxOutputData(tailFirst.data).length);
      expect(applyMuxDelta(splitMuxOutputData(fullFirst.data), fullDelta)).toEqual(splitMuxOutputData(longContent("changed")));
      expect(applyMuxDelta(splitMuxOutputData(tailFirst.data), tailDelta)).toEqual(splitMuxOutputData(longContent("changed")).slice(-60));

      const beforeFallback = full.frames().length;
      setContent("replacement without a shared prefix");
      await until(() => full.frames().length > beforeFallback);
      const fallback = full.frames().at(-1);
      expect(fallback.type).toBe("output");
      expect(fallback.data).toBe("replacement without a shared prefix");
    } finally {
      mux.stop();
    }
  });

  test("retains a failed-send base and clears bases on subscription lifecycle events", async () => {
    const { mux, setContent } = makeHarness();
    const primary = new FakeWS();
    const witness = new FakeWS();
    try {
      mux.subscribe(SESSION, primary, undefined, { delta: true });
      mux.subscribe(SESSION, witness, undefined, { delta: true });
      await until(() => primary.frames().length === 1 && witness.frames().length === 1);

      primary.droppedSends = 1;
      setContent(["missed", ...longContent("one").split("\n").slice(1)].join("\n"));
      await until(() => primary.droppedSends === 0);
      const beforeRecovery = primary.frames().length;
      setContent(["missed", ...longContent("two").split("\n").slice(1)].join("\n"));
      await until(() => primary.frames().length > beforeRecovery);
      // If the failed delivery advanced the base, this would be a small delta
      // against the missed snapshot. The last successful base has no prefix.
      expect(primary.frames().at(-1).type).toBe("output");

      mux.unsubscribe(SESSION, primary);
      const beforeResubscribe = primary.frames().length;
      mux.subscribe(SESSION, primary, undefined, { delta: true });
      await until(() => primary.frames().length > beforeResubscribe);
      expect(primary.frames().at(-1).type).toBe("output");

      mux.unsubscribeAll(primary);
      const beforeReconnect = primary.frames().length;
      mux.subscribe(SESSION, primary, undefined, { delta: true });
      await until(() => primary.frames().length > beforeReconnect);
      expect(primary.frames().at(-1).type).toBe("output");
    } finally {
      mux.stop();
    }
  });

  test("resync and rename invalidate the affected socket base without changing cursor-only delivery", async () => {
    const { mux, cursor, renameContent, setContent } = makeHarness();
    const ws = new FakeWS();
    const renamed = "sim-delta-renamed";
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);
      setContent(longContent("delta before resync"));
      await until(() => ws.frames().some((frame) => frame.type === "delta"));

      const beforeResync = ws.frames().length;
      mux.handleMessage({ type: "resync", session: SESSION }, ws);
      await until(() => ws.frames().length > beforeResync);
      const resync = ws.frames().at(-1);
      expect(resync).toMatchObject({ type: "output", reset: "resync", data: longContent("delta before resync") });

      renameContent(SESSION, renamed);
      mux.handleSessionRename(SESSION, renamed);
      await until(() => ws.frames(renamed).length > 0);
      expect(ws.frames(renamed).at(-1).type).toBe("output");

      const beforeCursorOnly = ws.frames(renamed).length;
      cursor.x += 1;
      await until(() => ws.sent.map((data) => JSON.parse(data)).some((frame) => frame.channel === renamed && frame.type === "cursor"));
      expect(ws.frames(renamed)).toHaveLength(beforeCursorOnly);
    } finally {
      mux.stop();
    }
  });

  test("a subscriber without delta opt-in receives only classic full output frames", async () => {
    const { mux, setContent } = makeHarness();
    const legacy = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SESSION }, legacy);
      await until(() => legacy.frames().length === 1);

      setContent(longContent("legacy update"));
      await until(() => legacy.frames().length > 1);

      const frames = legacy.frames();
      expect(frames.every((frame) => frame.type === "output")).toBe(true);
      expect(frames.at(-1)).toMatchObject({ type: "output", data: longContent("legacy update") });
    } finally {
      mux.stop();
    }
  });

  test("the latest subscription can revoke delta eligibility", async () => {
    const { mux, setContent } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SESSION, delta: true }, ws);
      await until(() => ws.frames().length === 1);
      setContent(longContent("delta before opt-out"));
      await until(() => ws.frames().some((frame) => frame.type === "delta"));

      mux.handleMessage({ type: "subscribe", session: SESSION }, ws);
      await until(() => ws.frames().at(-1)?.type === "output");
      const beforeUpdate = ws.frames().length;
      setContent(longContent("full after opt-out"));
      await until(() => ws.frames().length > beforeUpdate);
      expect(ws.frames().at(-1)).toMatchObject({ type: "output", data: longContent("full after opt-out") });
    } finally {
      mux.stop();
    }
  });
});
