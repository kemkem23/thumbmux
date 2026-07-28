/**
 * Backpressure contract for TmuxWsMux.
 *
 * Bun's ws.send() returns -1 when the frame is ENQUEUED under backpressure.
 * The -1 frame itself is delivered (base advances); subsequent server-pushed
 * frames are skipped until handleDrain hands CURRENT truth (never a replay).
 * Client-requested replies (pong / history / error) stay unconditional.
 */
import { describe, expect, test } from "bun:test";
import { applyMuxDelta, splitMuxOutputData } from "../../core/src/protocol";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const SESSION = "sim-bp";

type Frame = Record<string, any>;

class FakeWS {
  sent: string[] = [];
  attempts = 0;
  failSends = 0;
  droppedSends = 0;
  backpressuredSends = 0;
  closed: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  /** When true, expose Bun-shaped getBufferedAmount/close on the instance. */
  duckTyped = false;

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
    if (this.backpressuredSends > 0) {
      this.backpressuredSends -= 1;
      // Bun reports -1 when the frame is enqueued under backpressure — the
      // outbound buffer is non-empty until the peer drains. Model that so
      // auto-resume (bufferedAmount === 0) does not fire on the very next
      // push unless the test intentionally clears the buffer.
      if (this.bufferedAmount === 0) this.bufferedAmount = Math.max(data.length, 1);
      return -1;
    }
    return data.length;
  }

  getBufferedAmount() {
    return this.bufferedAmount;
  }

  close(code = 1013, reason = "") {
    this.closed.push({ code, reason: String(reason) });
  }

  frames(channel = SESSION): Frame[] {
    return this.sent.map((data) => JSON.parse(data)).filter((frame) =>
      frame.channel === channel && (frame.type === "output" || frame.type === "delta"));
  }

  allFrames(): Frame[] {
    return this.sent.map((data) => JSON.parse(data));
  }

  sessionListFrames(): Frame[] {
    return this.allFrames().filter((f) => f.channel === "__sessions" && f.type === "sessions");
  }

  cursorFrames(channel = SESSION): Frame[] {
    return this.allFrames().filter((f) => f.channel === channel && f.type === "cursor");
  }
}

/** Minimal socket with neither getBufferedAmount nor close. */
class BareWS {
  sent: string[] = [];
  attempts = 0;
  backpressuredSends = 0;

  send(data: string) {
    this.attempts += 1;
    this.sent.push(data);
    if (this.backpressuredSends > 0) {
      this.backpressuredSends -= 1;
      return -1;
    }
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

function reconstruct(frames: Frame[]): string {
  let base: string[] | null = null;
  for (const frame of frames) {
    if (frame.type === "output") {
      base = splitMuxOutputData(frame.data);
    } else if (frame.type === "delta") {
      if (!base) throw new Error("delta before any full base");
      const next = applyMuxDelta(base, frame);
      if (!next) throw new Error(`invalid delta against base of length ${base.length}`);
      base = next;
    }
  }
  if (!base) throw new Error("no frames to reconstruct");
  return base.join("\n");
}

function makeHarness(opts: {
  initial?: string;
  backpressure?: ConstructorParameters<typeof TmuxWsMux>[0]["backpressure"];
  hooks?: ConstructorParameters<typeof TmuxWsMux>[0]["hooks"];
  sessions?: () => unknown[];
} = {}) {
  const initial = opts.initial ?? Array.from({ length: 40 }, (_, i) => `row-${i}`).join("\n");
  const contents = new Map([[SESSION, initial]]);
  let activity = 0;
  const cursor = { x: 0, y: 0, paneHeight: 1, visible: true };
  const driver: TmuxDriver = {
    listSessions: opts.sessions ?? (() => [...contents.keys()].map((name) => ({ name }))),
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
    resizeWindow: () => {},
    hash: (content) => content,
  };
  const mux = new TmuxWsMux({
    driver,
    profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
    sessionListIntervalMs: 20,
    backpressure: opts.backpressure,
    hooks: opts.hooks,
  });
  return {
    mux,
    cursor,
    initial,
    setContent: (content: string) => contents.set(SESSION, content),
    setSessions: (list: unknown[]) => {
      (driver as any)._sessions = list;
    },
  };
}

describe("backpressure — skip / drain / shed", () => {
  test("1. blocked socket is skipped, peers are not", async () => {
    const { mux, setContent, initial } = makeHarness();
    const healthy = new FakeWS();
    const blocked = new FakeWS();
    try {
      mux.subscribe(SESSION, healthy, undefined, { delta: true });
      mux.subscribe(SESSION, blocked, undefined, { delta: true });
      await until(() => healthy.frames().length === 1 && blocked.frames().length === 1);

      blocked.backpressuredSends = 1;
      const c1 = `${initial}\nchange-1`;
      setContent(c1);
      await until(() => healthy.frames().length === 2 && blocked.frames().length === 2);
      expect(mux.isBackpressured(blocked)).toBe(true);
      expect(mux.isBackpressured(healthy)).toBe(false);

      const mutations = [
        `${c1}\nchange-2`,
        `${c1}\nchange-2\nchange-3`,
        `${c1}\nchange-2\nchange-3\nchange-4`,
      ];
      const blockedAtBlock = blocked.frames().length;
      for (let i = 0; i < mutations.length; i++) {
        const beforeHealthy = healthy.frames().length;
        setContent(mutations[i]!);
        await until(() => healthy.frames().length === beforeHealthy + 1);
        // Blocked socket must not receive any of these three.
        expect(blocked.frames().length).toBe(blockedAtBlock);
      }

      expect(reconstruct(healthy.frames())).toBe(mutations[2]);
      expect(reconstruct(blocked.frames())).toBe(c1);
      expect(mux.isBackpressured(blocked)).toBe(true);
      expect(mux.isBackpressured(healthy)).toBe(false);
    } finally {
      mux.stop();
    }
  });

  test("2. drain delivers latest truth, not history", async () => {
    const { mux, setContent, initial } = makeHarness();
    const healthy = new FakeWS();
    const blocked = new FakeWS();
    try {
      mux.subscribe(SESSION, healthy, undefined, { delta: true });
      mux.subscribe(SESSION, blocked, undefined, { delta: true });
      await until(() => healthy.frames().length === 1 && blocked.frames().length === 1);

      blocked.backpressuredSends = 1;
      const c1 = `${initial}\nA`;
      setContent(c1);
      await until(() => blocked.frames().length === 2 && mux.isBackpressured(blocked));

      const mid = `${c1}\nB`;
      const latest = `${c1}\nB\nC`;
      setContent(mid);
      await until(() => healthy.frames().length >= 3);
      setContent(latest);
      await until(() => healthy.frames().length >= 4);
      // Still only the -1 frame beyond initial for blocked.
      expect(blocked.frames().length).toBe(2);

      const beforeDrain = blocked.frames().length;
      const bpEvents: Array<string> = [];
      // Drain without a custom hook on this mux — assert via frames only.
      mux.handleDrain(blocked);
      expect(mux.isBackpressured(blocked)).toBe(false);
      expect(blocked.frames().length).toBe(beforeDrain + 1);
      const catchUp = blocked.frames().at(-1)!;
      expect(catchUp.type).toBe("output");
      expect(catchUp.data).toBe(latest);
      // Must NOT be intermediate mid state.
      expect(catchUp.data).not.toBe(mid);
      expect(reconstruct(blocked.frames())).toBe(latest);

      // Further deltas reconstruct exactly from the catch-up base.
      const next = `${latest}\nD`;
      setContent(next);
      await until(() => blocked.frames().length === beforeDrain + 2);
      expect(blocked.frames().at(-1)!.type).toBe("delta");
      expect(reconstruct(blocked.frames())).toBe(next);
      expect(bpEvents).toEqual([]); // placeholder kept quiet
    } finally {
      mux.stop();
    }
  });

  test("3. drain with nothing missed sends nothing", async () => {
    const { mux, setContent, initial } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      setContent(`${initial}\nonly`);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      const before = ws.frames().length;
      mux.handleDrain(ws);
      expect(mux.isBackpressured(ws)).toBe(false);
      // No content change while blocked → no catch-up frame.
      expect(ws.frames().length).toBe(before);
    } finally {
      mux.stop();
    }
  });

  test("4. no stale base — reconstruction and applyMuxDelta never fail after drain", async () => {
    const { mux, setContent, initial } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      const c1 = `${initial}\none`;
      setContent(c1);
      await until(() => ws.frames().length === 2);

      const c2 = `${c1}\ntwo`;
      const c3 = `${c1}\ntwo\nthree`;
      setContent(c2);
      await new Promise((r) => setTimeout(r, 60));
      setContent(c3);
      await new Promise((r) => setTimeout(r, 60));
      expect(ws.frames().length).toBe(2);

      mux.handleDrain(ws);
      await until(() => ws.frames().length === 3);
      expect(ws.frames().at(-1)).toMatchObject({ type: "output", data: c3 });

      // Server base must equal the lines of the last frame the client actually has.
      const clientLines = reconstruct(ws.frames()).split("\n");
      const serverBase = (mux as any).outputBases.get(SESSION)?.get(ws) as string[] | undefined;
      expect(serverBase).toEqual(clientLines);

      // Subsequent deltas must apply cleanly.
      const c4 = `${c3}\nfour`;
      setContent(c4);
      await until(() => ws.frames().length === 4);
      const delta = ws.frames().at(-1)!;
      expect(delta.type).toBe("delta");
      expect(applyMuxDelta(splitMuxOutputData(c3), delta)).toEqual(splitMuxOutputData(c4));
      expect(reconstruct(ws.frames())).toBe(c4);
    } finally {
      mux.stop();
    }
  });

  test("5. maxBlockedMs shedding", async () => {
    const closed: Array<{ ws: FakeWS; reason: string }> = [];
    const events: Array<{ event: string; ws: FakeWS }> = [];
    const { mux, setContent, initial } = makeHarness({
      backpressure: {
        maxBlockedMs: 0,
        close: (ws, reason) => { closed.push({ ws: ws as FakeWS, reason }); },
      },
      hooks: {
        onBackpressure: (ws, event) => { events.push({ event, ws: ws as FakeWS }); },
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      setContent(`${initial}\nblock-me`);
      await until(() => ws.frames().length === 2);
      // maxBlockedMs:0 → shed immediately on the -1 path.
      expect(closed.length).toBe(1);
      expect(closed[0]!.ws).toBe(ws);
      expect(events.some((e) => e.event === "closed" && e.ws === ws)).toBe(true);

      const afterShed = ws.frames().length;
      setContent(`${initial}\nblock-me\nmore`);
      await new Promise((r) => setTimeout(r, 80));
      expect(ws.frames().length).toBe(afterShed);

      // handleDrain after shed must not push anything.
      mux.handleDrain(ws);
      expect(ws.frames().length).toBe(afterShed);
      // close fires exactly once
      expect(closed.length).toBe(1);
    } finally {
      mux.stop();
    }
  });

  test("6. maxBufferedBytes shedding", async () => {
    const closed: FakeWS[] = [];
    const events: string[] = [];
    const { mux, setContent, initial } = makeHarness({
      backpressure: {
        maxBlockedMs: 60_000, // would not shed on time
        maxBufferedBytes: 100,
        bufferedAmount: (ws) => (ws as FakeWS).bufferedAmount,
        close: (ws) => { closed.push(ws as FakeWS); },
      },
      hooks: {
        onBackpressure: (_ws, event) => { events.push(event); },
      },
    });
    const ws = new FakeWS();
    ws.bufferedAmount = 0;
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.bufferedAmount = 101; // over cap
      ws.backpressuredSends = 1;
      setContent(`${initial}\nover-buffer`);
      await until(() => ws.frames().length === 2);
      // Shed on the -1 path via buffered amount, even though maxBlockedMs is large.
      expect(closed).toEqual([ws]);
      expect(events).toContain("closed");

      const after = ws.frames().length;
      setContent(`${initial}\nover-buffer\nagain`);
      await new Promise((r) => setTimeout(r, 80));
      expect(ws.frames().length).toBe(after);
    } finally {
      mux.stop();
    }
  });

  test("7. duck-typed defaults (getBufferedAmount + close on the socket)", async () => {
    // No configured hooks — mux must use ws.getBufferedAmount() and ws.close().
    const { mux, setContent, initial } = makeHarness({
      backpressure: {
        maxBlockedMs: 60_000,
        maxBufferedBytes: 50,
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.bufferedAmount = 51;
      ws.backpressuredSends = 1;
      setContent(`${initial}\nduck`);
      await until(() => ws.frames().length === 2);
      expect(ws.closed.length).toBe(1);
      expect(ws.closed[0]!.code).toBe(1013);

      const after = ws.frames().length;
      setContent(`${initial}\nduck\nmore`);
      await new Promise((r) => setTimeout(r, 80));
      expect(ws.frames().length).toBe(after);
    } finally {
      mux.stop();
    }
  });

  test("8. adapter with neither getBufferedAmount nor close never throws; skipped until drain", async () => {
    const { mux, setContent, initial } = makeHarness({
      // Large maxBlockedMs so we do not shed within the test window.
      backpressure: { maxBlockedMs: 60_000, maxBufferedBytes: 1 },
    });
    const ws = new BareWS();
    try {
      mux.subscribe(SESSION, ws as any, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      const c1 = `${initial}\nbare-1`;
      setContent(c1);
      await until(() => ws.frames().length === 2);
      expect(mux.isBackpressured(ws as any)).toBe(true);

      const before = ws.frames().length;
      setContent(`${c1}\nbare-2`);
      await new Promise((r) => setTimeout(r, 80));
      // Skipped, no throw.
      expect(ws.frames().length).toBe(before);

      mux.handleDrain(ws as any);
      expect(mux.isBackpressured(ws as any)).toBe(false);
      expect(ws.frames().length).toBe(before + 1);
      expect(ws.frames().at(-1)).toMatchObject({ type: "output", data: `${c1}\nbare-2` });
    } finally {
      mux.stop();
    }
  });

  test("9. cursor-only frames suppressed while blocked; drain full carries current cursor", async () => {
    const { mux, setContent, initial, cursor } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      // Force a content change that returns -1 so we enter blocked.
      setContent(`${initial}\ncur`);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      const framesBeforeCursor = ws.frames().length;
      const cursorBefore = ws.cursorFrames().length;
      // Content-identical capture with a moved cursor → cursor-only path.
      cursor.x = 7;
      await new Promise((r) => setTimeout(r, 80));
      // No cursor frame delivered while blocked.
      expect(ws.cursorFrames().length).toBe(cursorBefore);
      expect(ws.frames().length).toBe(framesBeforeCursor);

      mux.handleDrain(ws);
      // Catch-up is a full output carrying the current cursor.
      const catchUp = ws.frames().at(-1)!;
      expect(catchUp.type).toBe("output");
      expect(catchUp.cursor).toEqual({ row: 0, col: 7 });
      expect(catchUp.data).toBe(`${initial}\ncur`);
    } finally {
      mux.stop();
    }
  });

  test("10. session-list pushes suppressed while blocked and re-pushed on drain", async () => {
    let sessionList: unknown[] = [{ name: "a" }];
    const { mux, setContent, initial } = makeHarness({
      sessions: () => sessionList,
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      mux.subscribeSessions(ws);
      await until(() => ws.frames().length === 1 && ws.sessionListFrames().length >= 1);
      const listBefore = ws.sessionListFrames().length;

      ws.backpressuredSends = 1;
      setContent(`${initial}\nlist`);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      // Change the session list while blocked — broadcast must skip this socket.
      sessionList = [{ name: "a" }, { name: "b" }];
      // Force a broadcast by waiting for the poller session-list tick, or call privately.
      (mux as any).lastSessionsJson = "";
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(listBefore);

      mux.handleDrain(ws);
      // Owed session list is pushed on drain.
      expect(ws.sessionListFrames().length).toBe(listBefore + 1);
      const latest = ws.sessionListFrames().at(-1)!;
      expect(JSON.parse(latest.data)).toEqual(sessionList);
    } finally {
      mux.stop();
    }
  });

  test("11. state is released on disconnect (unsubscribeAll)", async () => {
    const { mux, setContent, initial } = makeHarness();
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      setContent(`${initial}\ndisc`);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      mux.unsubscribeAll(ws);
      expect(mux.isBackpressured(ws)).toBe(false);

      // Re-subscribe the same object — must receive frames again (clean state).
      const before = ws.frames().length;
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length > before);
      expect(ws.frames().at(-1)!.type).toBe("output");

      const next = `${initial}\ndisc\nagain`;
      setContent(next);
      await until(() => ws.frames().length >= before + 2);
      expect(reconstruct(ws.frames().slice(before))).toBe(next);
    } finally {
      mux.stop();
    }
  });

  test("12. enabled:false reproduces pre-fix keep-sending behaviour", async () => {
    const { mux, setContent, initial } = makeHarness({
      backpressure: { enabled: false },
    });
    const healthy = new FakeWS();
    const slow = new FakeWS();
    try {
      mux.subscribe(SESSION, healthy, undefined, { delta: true });
      mux.subscribe(SESSION, slow, undefined, { delta: true });
      await until(() => healthy.frames().length === 1 && slow.frames().length === 1);

      slow.backpressuredSends = 1;
      const c1 = `${initial}\nL1`;
      setContent(c1);
      await until(() => healthy.frames().length === 2 && slow.frames().length === 2);
      expect(mux.isBackpressured(slow)).toBe(false);

      // Three more changes: BOTH sockets receive every frame (legacy behaviour).
      const mutations = [
        `${c1}\nL2`,
        `${c1}\nL2\nL3`,
        `${c1}\nL2\nL3\nL4`,
      ];
      for (let i = 0; i < mutations.length; i++) {
        setContent(mutations[i]!);
        await until(() =>
          healthy.frames().length === 3 + i
          && slow.frames().length === 3 + i);
      }
      expect(reconstruct(healthy.frames())).toBe(mutations[2]);
      expect(reconstruct(slow.frames())).toBe(mutations[2]);
    } finally {
      mux.stop();
    }
  });

  test("13. blocked socket with nothing pending is untouched on onlyPending path (fix 4b)", async () => {
    // Scenario: socket B is blocked but has no pending full/reset marker.
    // Another viewer forces the hash-unchanged `onlyPending` tick (e.g. a
    // reconnect that needs a full). B must NOT get requireFullOutput just
    // because it is blocked — drain then sends nothing for B.
    const { mux, setContent, initial } = makeHarness();
    const healthy = new FakeWS();
    const blocked = new FakeWS();
    try {
      mux.subscribe(SESSION, healthy, undefined, { delta: true });
      mux.subscribe(SESSION, blocked, undefined, { delta: true });
      await until(() => healthy.frames().length === 1 && blocked.frames().length === 1);

      // Put blocked into backpressure with a content change (-1 enqueue).
      // That -1 frame is delivered and bookkeeping advances — so after this
      // tick blocked has NO pending full/reset of its own.
      blocked.backpressuredSends = 1;
      const c1 = `${initial}\nonly-pending`;
      setContent(c1);
      await until(() =>
        healthy.frames().length === 2
        && blocked.frames().length === 2
        && mux.isBackpressured(blocked));

      // Clear any residual pending that markBlocked/requireFull might have
      // left from the skip path on subsequent pushes: force one hash-changed
      // tick that healthy receives and blocked skips (this SETS requireFull
      // on blocked — we need the opposite). Instead: drain immediately with
      // nothing further missed would clear that; re-block with no pending.
      //
      // After the -1 frame, bases advanced and pendings cleared. A follow-up
      // content change while blocked WOULD requireFull. We deliberately do
      // NOT change content — instead mark healthy as needing a full so the
      // next capture is hash-unchanged (same content) + onlyPending path.
      (mux as any).requireFullOutput(SESSION, healthy);
      // Content unchanged → hash-unchanged branch → sendPendingOutputFrames.
      // Poll/capture with same content.
      await until(() => healthy.frames().length === 3, 2_000);

      // Healthy got its pending full; blocked must still have exactly 2
      // output frames and still be backpressured.
      expect(mux.isBackpressured(blocked)).toBe(true);
      expect(blocked.frames().length).toBe(2);

      // Drain with nothing pending → no catch-up frame (fix 4b).
      const beforeDrain = blocked.frames().length;
      mux.handleDrain(blocked);
      expect(mux.isBackpressured(blocked)).toBe(false);
      expect(blocked.frames().length).toBe(beforeDrain);
    } finally {
      mux.stop();
    }
  });

  test("14. auto-resume when buffered amount drops to 0 (no handleDrain)", async () => {
    // Host never wires drain — mux self-heals when the adapter reports 0.
    const events: Array<{ event: string; info: { blockedMs: number; bufferedBytes?: number } }> = [];
    const { mux, setContent, initial } = makeHarness({
      hooks: {
        onBackpressure: (_ws, event, info) => { events.push({ event, info }); },
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      // Enter blocked via -1. Keep a positive buffer so auto-resume does not fire yet.
      ws.bufferedAmount = 4096;
      ws.backpressuredSends = 1;
      const c1 = `${initial}\nauto-1`;
      setContent(c1);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));
      expect(events.some((e) => e.event === "blocked")).toBe(true);

      // Miss at least one content change while buffer stays positive → pending full.
      const c2 = `${c1}\nauto-2`;
      setContent(c2);
      await new Promise((r) => setTimeout(r, 80));
      expect(mux.isBackpressured(ws)).toBe(true);
      expect(ws.frames().length).toBe(2);

      // Buffer fully drains — next content change auto-resumes (NO handleDrain).
      ws.bufferedAmount = 0;
      const c3 = `${c2}\nauto-3`;
      const before = ws.frames().length;
      setContent(c3);
      await until(() => ws.frames().length > before);

      expect(mux.isBackpressured(ws)).toBe(false);
      const catchUp = ws.frames().at(-1)!;
      expect(catchUp.type).toBe("output");
      expect(catchUp.data).toBe(c3);
      expect(reconstruct(ws.frames())).toBe(c3);

      // onBackpressure("drained") exactly once, with bufferedBytes: 0.
      const drained = events.filter((e) => e.event === "drained");
      expect(drained.length).toBe(1);
      expect(drained[0]!.info.bufferedBytes).toBe(0);

      // No handleDrain was called — confirmed by single drained from auto-resume only.
    } finally {
      mux.stop();
    }
  });

  test("15. positive buffered amount keeps the socket skipped (no early resume)", async () => {
    const events: string[] = [];
    const { mux, setContent, initial } = makeHarness({
      hooks: {
        onBackpressure: (_ws, event) => { events.push(event); },
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.bufferedAmount = 2048;
      ws.backpressuredSends = 1;
      const c1 = `${initial}\nhold`;
      setContent(c1);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      const before = ws.frames().length;
      setContent(`${c1}\nstill-held`);
      await new Promise((r) => setTimeout(r, 80));
      setContent(`${c1}\nstill-held\nagain`);
      await new Promise((r) => setTimeout(r, 80));

      // Still blocked, still only the -1 frame beyond initial, no drained event.
      expect(mux.isBackpressured(ws)).toBe(true);
      expect(ws.frames().length).toBe(before);
      expect(events.filter((e) => e === "drained")).toEqual([]);
    } finally {
      mux.stop();
    }
  });

  test("16. adapter without getBufferedAmount still requires explicit handleDrain", async () => {
    // BareWS has no getBufferedAmount — auto-resume must not fire; pin the
    // pre-hardening path (explicit drain only).
    const events: string[] = [];
    const { mux, setContent, initial } = makeHarness({
      hooks: {
        onBackpressure: (_ws, event) => { events.push(event); },
      },
    });
    const ws = new BareWS();
    try {
      mux.subscribe(SESSION, ws as any, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      ws.backpressuredSends = 1;
      const c1 = `${initial}\nbare-auto`;
      setContent(c1);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws as any));

      const before = ws.frames().length;
      setContent(`${c1}\nmissed`);
      await new Promise((r) => setTimeout(r, 80));
      expect(mux.isBackpressured(ws as any)).toBe(true);
      expect(ws.frames().length).toBe(before);
      expect(events.filter((e) => e === "drained")).toEqual([]);

      // Explicit drain still works.
      mux.handleDrain(ws as any);
      expect(mux.isBackpressured(ws as any)).toBe(false);
      expect(ws.frames().length).toBe(before + 1);
      expect(ws.frames().at(-1)).toMatchObject({ type: "output", data: `${c1}\nmissed` });
      expect(events.filter((e) => e === "drained").length).toBe(1);
    } finally {
      mux.stop();
    }
  });

  test("17. auto-resume settles session-list debt exactly once", async () => {
    let sessionList: unknown[] = [{ name: "a" }];
    const events: string[] = [];
    const { mux, setContent, initial } = makeHarness({
      sessions: () => sessionList,
      hooks: {
        onBackpressure: (_ws, event) => { events.push(event); },
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      mux.subscribeSessions(ws);
      await until(() => ws.frames().length === 1 && ws.sessionListFrames().length >= 1);
      const listBefore = ws.sessionListFrames().length;

      // Block with a positive buffer so auto-resume does not fire on the next tick.
      ws.bufferedAmount = 1024;
      ws.backpressuredSends = 1;
      setContent(`${initial}\nlist-debt`);
      await until(() => ws.frames().length === 2 && mux.isBackpressured(ws));

      // List change while blocked → skipped, debt recorded.
      sessionList = [{ name: "a" }, { name: "b" }];
      (mux as any).lastSessionsJson = "";
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(listBefore);

      // Buffer drains; next CONTENT push auto-resumes and settles the debt.
      ws.bufferedAmount = 0;
      const beforeFrames = ws.frames().length;
      setContent(`${initial}\nlist-debt\ncatch`);
      await until(() => ws.frames().length > beforeFrames && mux.isBackpressured(ws) === false);

      // List delivered exactly once (debt settlement), not twice.
      expect(ws.sessionListFrames().length).toBe(listBefore + 1);
      expect(JSON.parse(ws.sessionListFrames().at(-1)!.data)).toEqual(sessionList);
      expect(events.filter((e) => e === "drained").length).toBe(1);

      // A no-op rebroadcast of the same list must not push again.
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(listBefore + 1);
    } finally {
      mux.stop();
    }
  });

  test("18. shed still wins over auto-resume", async () => {
    const closed: FakeWS[] = [];
    const events: string[] = [];
    const { mux, setContent, initial } = makeHarness({
      backpressure: {
        maxBlockedMs: 60_000,
        maxBufferedBytes: 100,
        bufferedAmount: (ws) => (ws as FakeWS).bufferedAmount,
        close: (ws) => { closed.push(ws as FakeWS); },
      },
      hooks: {
        onBackpressure: (_ws, event) => { events.push(event); },
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.frames().length === 1);

      // Over the byte cap — shed on the -1 path (and on any later skip check).
      ws.bufferedAmount = 101;
      ws.backpressuredSends = 1;
      setContent(`${initial}\nshed-over-auto`);
      await until(() => ws.frames().length === 2);
      expect(closed).toEqual([ws]);
      expect(events).toContain("closed");
      expect(events).not.toContain("drained");
      expect(mux.isBackpressured(ws)).toBe(false); // shed, not blocked

      // Even if buffer later reports 0, a shed socket is never auto-resumed.
      ws.bufferedAmount = 0;
      const after = ws.frames().length;
      setContent(`${initial}\nshed-over-auto\nmore`);
      await new Promise((r) => setTimeout(r, 80));
      expect(ws.frames().length).toBe(after);
      expect(events.filter((e) => e === "drained")).toEqual([]);
      expect(closed.length).toBe(1); // close exactly once
    } finally {
      mux.stop();
    }
  });
});
