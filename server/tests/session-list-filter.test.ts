/**
 * DEFECT C — session-list broadcasts must honour per-principal allowlists.
 *
 * Without a filterSessionList hook the mux is byte-identical to pre-0.4
 * (one shared serialized __sessions frame for every socket). With the hook
 * each socket receives only the rows it is allowed to see; a throwing hook
 * fails closed for that socket alone.
 */
import { describe, expect, test } from "bun:test";
import type { SessionListItem } from "../../core/src/protocol";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const PANE = "pane-s";

type Frame = Record<string, any>;

class FakeWS {
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

  allFrames(): Frame[] {
    return this.sent.map((data) => JSON.parse(data));
  }

  sessionListFrames(): Frame[] {
    return this.allFrames().filter((f) => f.channel === "__sessions" && f.type === "sessions");
  }

  /** Raw wire strings that carry a session-list frame. */
  sessionListRaw(): string[] {
    return this.sent.filter((s) => {
      try {
        const f = JSON.parse(s);
        return f.channel === "__sessions" && f.type === "sessions";
      } catch {
        return false;
      }
    });
  }

  outputFrames(channel = PANE): Frame[] {
    return this.allFrames().filter((f) =>
      f.channel === channel && (f.type === "output" || f.type === "delta"));
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

type SessionRow = SessionListItem & { owner?: string };

function sessionRow(name: string, owner?: string): SessionRow {
  const row: SessionRow = {
    name,
    created: "0",
    windows: 1,
    attached: false,
    activityAt: 0,
  };
  if (owner !== undefined) row.owner = owner;
  return row;
}

function makeHarness(opts: {
  sessions?: () => SessionRow[];
  hooks?: ConstructorParameters<typeof TmuxWsMux>[0]["hooks"];
  sessionListIntervalMs?: number;
  pollNormalMs?: number;
} = {}) {
  let sessionList: SessionRow[] = [
    sessionRow("alpha", "A"),
    sessionRow("beta", "B"),
    sessionRow("gamma", "C"),
  ];
  const contents = new Map([[PANE, "line-0"]]);
  let activity = 0;
  const driver: TmuxDriver = {
    listSessions: () => (opts.sessions ? opts.sessions() : sessionList),
    capturePane: async (session) => contents.get(session) ?? "",
    captureWithCursor: async (session) => ({
      content: contents.get(session) ?? "",
      cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
      trailingBlanks: 0,
    }),
    sendKeys: () => {},
    getSessionActivity: () => {
      activity += 1;
      return new Map([...contents.keys()].map((s) => [s, activity]));
    },
    getHistoryLimit: () => 2000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
  const mux = new TmuxWsMux({
    driver,
    profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
    pollNormalMs: opts.pollNormalMs ?? 10,
    pollReconcileMs: 10,
    sessionListIntervalMs: opts.sessionListIntervalMs ?? 20,
    hooks: opts.hooks,
  });
  return {
    mux,
    driver,
    getSessions: () => sessionList,
    setSessions: (list: SessionRow[]) => {
      sessionList = list;
    },
    setContent: (content: string) => contents.set(PANE, content),
  };
}

/** Filter by principal id stored on the client object `{ principal: "A" }`. */
function principalFilter(
  sessions: readonly SessionListItem[],
  _ws: unknown,
  client: unknown,
): readonly SessionListItem[] {
  const principal = (client as { principal?: string } | undefined)?.principal;
  if (!principal) return [];
  return (sessions as readonly SessionRow[]).filter((s) => s.owner === principal || s.name === principal);
}

describe("session-list filter (DEFECT C)", () => {
  test("host mutation can push changed inventory without waiting for the poll interval", () => {
    const { mux, setSessions } = makeHarness({ sessionListIntervalMs: 60_000 });
    const ws = new FakeWS();
    try {
      mux.subscribeSessions(ws);
      expect(ws.sessionListFrames()).toHaveLength(1);
      expect(ws.sessionListRaw()[0]).toContain("alpha");

      setSessions([sessionRow("beta")]);
      mux.broadcastSessionList();

      expect(ws.sessionListFrames()).toHaveLength(2);
      expect(ws.sessionListRaw().at(-1)).not.toContain("alpha");
      expect(ws.sessionListRaw().at(-1)).toContain("beta");
    } finally {
      mux.stop();
    }
  });

  test("1. no hook = today's behaviour (shared complete list + global dedupe)", async () => {
    const { mux, setSessions, getSessions } = makeHarness();
    const listSocket = new FakeWS();
    const paneSocket = new FakeWS();
    try {
      mux.subscribeSessions(listSocket);
      mux.subscribe(PANE, paneSocket);
      await until(() => listSocket.sessionListFrames().length >= 1);

      // Force a push so paneSocket (pane-only) also gets the list.
      (mux as any).lastSessionsJson = "";
      (mux as any).broadcastSessionList();

      await until(() => paneSocket.sessionListFrames().length >= 1);

      const listRaw = listSocket.sessionListRaw().at(-1)!;
      const paneRaw = paneSocket.sessionListRaw().at(-1)!;
      // Identical complete payload for both delivery paths.
      expect(listRaw).toBe(paneRaw);
      const payload = JSON.parse(JSON.parse(listRaw).data);
      expect(payload).toEqual(getSessions());
      // Both names present.
      expect(listRaw).toContain("alpha");
      expect(listRaw).toContain("beta");
      expect(listRaw).toContain("gamma");

      // Unchanged list is still deduped — no repeat push.
      const before = listSocket.sessionListFrames().length;
      const beforePane = paneSocket.sessionListFrames().length;
      (mux as any).broadcastSessionList();
      expect(listSocket.sessionListFrames().length).toBe(before);
      expect(paneSocket.sessionListFrames().length).toBe(beforePane);

      // A real change pushes once more, still identical.
      setSessions([sessionRow("alpha"), sessionRow("beta"), sessionRow("delta")]);
      (mux as any).broadcastSessionList();
      expect(listSocket.sessionListFrames().length).toBe(before + 1);
      expect(paneSocket.sessionListFrames().length).toBe(beforePane + 1);
      expect(listSocket.sessionListRaw().at(-1)).toBe(paneSocket.sessionListRaw().at(-1));
      expect(listSocket.sessionListRaw().at(-1)!).toContain("delta");
    } finally {
      mux.stop();
    }
  });

  test("2. cross-principal isolation on reply AND push", async () => {
    const { mux, setSessions } = makeHarness({
      hooks: {
        filterSessionList: (sessions, ws, client) => {
          const tag = (ws as FakeWS & { tag?: string }).tag;
          if (tag === "A") return (sessions as readonly SessionRow[]).filter((s) => s.name === "alpha");
          if (tag === "B") return (sessions as readonly SessionRow[]).filter((s) => s.name === "beta");
          return [];
        },
      },
    });
    const socketA = new FakeWS() as FakeWS & { tag?: string };
    const socketB = new FakeWS() as FakeWS & { tag?: string };
    socketA.tag = "A";
    socketB.tag = "B";
    try {
      mux.subscribeSessions(socketA, { principal: "A" });
      mux.subscribeSessions(socketB, { principal: "B" });
      await until(() =>
        socketA.sessionListFrames().length >= 1 && socketB.sessionListFrames().length >= 1);

      // Initial reply isolation — assert on raw sent strings.
      const rawA0 = socketA.sessionListRaw()[0]!;
      const rawB0 = socketB.sessionListRaw()[0]!;
      expect(rawA0).toContain("alpha");
      expect(rawA0).not.toContain("beta");
      expect(rawA0).not.toContain("gamma");
      expect(rawB0).toContain("beta");
      expect(rawB0).not.toContain("alpha");
      expect(rawB0).not.toContain("gamma");
      expect(JSON.parse(JSON.parse(rawA0).data)).toEqual([sessionRow("alpha", "A")]);
      expect(JSON.parse(JSON.parse(rawB0).data)).toEqual([sessionRow("beta", "B")]);

      // Later push still isolated.
      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("gamma", "C"),
        sessionRow("alpha-2", "A"),
      ]);
      // The filter only matches exact name "alpha" for A — still no beta.
      (mux as any).broadcastSessionList();
      await until(() => socketA.sessionListFrames().length >= 2 && socketB.sessionListFrames().length >= 2);

      const rawA1 = socketA.sessionListRaw().at(-1)!;
      const rawB1 = socketB.sessionListRaw().at(-1)!;
      expect(rawA1).toContain("alpha");
      expect(rawA1).not.toContain("beta");
      expect(rawA1).not.toContain("gamma");
      expect(rawB1).toContain("beta");
      expect(rawB1).not.toContain("alpha");
      expect(rawB1).not.toContain("gamma");
    } finally {
      mux.stop();
    }
  });

  test("3. client pass-through on reply, push, and pane-only undefined", async () => {
    const seen: Array<{ ws: FakeWS; client: unknown; phase: string }> = [];
    let phase = "init";
    const clientA = { principal: "A", token: "tok-a" };
    const { mux, setSessions } = makeHarness({
      hooks: {
        filterSessionList: (sessions, ws, client) => {
          seen.push({ ws: ws as FakeWS, client, phase });
          return principalFilter(sessions, ws, client);
        },
      },
    });
    const listSocket = new FakeWS();
    const paneOnly = new FakeWS();
    try {
      mux.handleMessage({ type: "sessions_subscribe", client: clientA }, listSocket);
      await until(() => listSocket.sessionListFrames().length >= 1);
      expect(seen.length).toBe(1);
      expect(seen[0]!.client).toBe(clientA); // exact object identity
      expect(seen[0]!.ws).toBe(listSocket);

      // Pane-only subscriber: never sent sessions_subscribe → client is undefined.
      phase = "pane";
      mux.subscribe(PANE, paneOnly);
      // Force a broadcast so paneOnly receives a list push.
      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
      ]);
      (mux as any).broadcastSessionList();
      await until(() => paneOnly.sessionListFrames().length >= 1);

      const paneCalls = seen.filter((s) => s.ws === paneOnly);
      expect(paneCalls.length).toBeGreaterThanOrEqual(1);
      for (const c of paneCalls) {
        expect(c.client).toBeUndefined();
      }

      // Later push for listSocket still gets the same client object.
      phase = "push";
      const before = seen.filter((s) => s.ws === listSocket).length;
      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("gamma", "C"),
      ]);
      (mux as any).broadcastSessionList();
      await until(() => seen.filter((s) => s.ws === listSocket).length > before);
      const later = seen.filter((s) => s.ws === listSocket && s.phase === "push");
      expect(later.length).toBeGreaterThanOrEqual(1);
      for (const c of later) {
        expect(c.client).toBe(clientA);
      }
    } finally {
      mux.stop();
    }
  });

  test("4. fail closed: throwing hook silences one socket, peers still receive", async () => {
    const { mux, setSessions } = makeHarness({
      hooks: {
        filterSessionList: (sessions, ws) => {
          if ((ws as FakeWS & { bad?: boolean }).bad) {
            throw new Error("principal lookup failed");
          }
          return sessions;
        },
      },
    });
    const good = new FakeWS();
    const bad = new FakeWS() as FakeWS & { bad?: boolean };
    bad.bad = true;
    try {
      // Throwing on initial reply must not throw out of the mux.
      expect(() => mux.subscribeSessions(bad)).not.toThrow();
      expect(bad.sessionListFrames().length).toBe(0);

      mux.subscribeSessions(good);
      await until(() => good.sessionListFrames().length >= 1);
      expect(good.sessionListFrames().length).toBe(1);
      expect(JSON.parse(good.sessionListFrames()[0]!.data)).toEqual([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("gamma", "C"),
      ]);
      expect(bad.sessionListFrames().length).toBe(0);

      // Push round: bad still silent, good still receives.
      setSessions([sessionRow("only")]);
      expect(() => (mux as any).broadcastSessionList()).not.toThrow();
      expect(good.sessionListFrames().length).toBe(2);
      expect(JSON.parse(good.sessionListFrames().at(-1)!.data)).toEqual([sessionRow("only")]);
      expect(bad.sessionListFrames().length).toBe(0);
    } finally {
      mux.stop();
    }
  });

  test("4b. throwing filter logs once via logError (message only, fail closed)", async () => {
    const logs: unknown[][] = [];
    // Inject logError through the constructor option — same channel
    // subscribeSessions / broadcastSessionList already use.
    let sessionList: SessionRow[] = [
      sessionRow("alpha", "A"),
      sessionRow("beta", "B"),
    ];
    const contents = new Map([[PANE, "line-0"]]);
    let activity = 0;
    const driver: TmuxDriver = {
      listSessions: () => sessionList,
      capturePane: async (session) => contents.get(session) ?? "",
      captureWithCursor: async (session) => ({
        content: contents.get(session) ?? "",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      }),
      sendKeys: () => {},
      getSessionActivity: () => {
        activity += 1;
        return new Map([...contents.keys()].map((s) => [s, activity]));
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
      logError: (...args: unknown[]) => { logs.push(args); },
      hooks: {
        filterSessionList: () => {
          throw new Error("principal lookup failed");
        },
      },
    });
    const ws = new FakeWS();
    try {
      expect(() => mux.subscribeSessions(ws)).not.toThrow();
      // Fail closed: no session-list frame delivered.
      expect(ws.sessionListFrames().length).toBe(0);
      // Exactly one logError call for this occurrence.
      expect(logs.length).toBe(1);
      const line = logs[0]!.map(String).join(" ");
      expect(line).toContain("filterSessionList threw");
      expect(line).toContain("principal lookup failed");
      // Never the sessions payload (names a principal must not see).
      expect(line).not.toContain("alpha");
      expect(line).not.toContain("beta");
      expect(JSON.stringify(logs[0])).not.toContain("alpha");
    } finally {
      mux.stop();
    }
  });

  test("5. poll-driven path also filters", async () => {
    const { mux, setSessions } = makeHarness({
      sessionListIntervalMs: 30,
      pollNormalMs: 15,
      hooks: {
        filterSessionList: (sessions, ws) => {
          const tag = (ws as FakeWS & { tag?: string }).tag;
          if (tag === "A") return (sessions as readonly SessionRow[]).filter((s) => s.name === "alpha");
          return sessions;
        },
      },
    });
    const socketA = new FakeWS() as FakeWS & { tag?: string };
    socketA.tag = "A";
    try {
      // Pane subscribe starts the poll loop; session-list ticks ride on it.
      mux.subscribe(PANE, socketA);
      mux.subscribeSessions(socketA, { principal: "A" });
      await until(() => socketA.sessionListFrames().length >= 1);
      const afterReply = socketA.sessionListFrames().length;
      expect(socketA.sessionListRaw()[0]!).toContain("alpha");
      expect(socketA.sessionListRaw()[0]!).not.toContain("beta");

      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("omega", "Z"),
      ]);
      // Wait for the real poll loop to fire broadcastSessionList (not a direct call).
      await until(() => socketA.sessionListFrames().length > afterReply, 3_000);
      const latest = socketA.sessionListRaw().at(-1)!;
      expect(latest).toContain("alpha");
      expect(latest).not.toContain("beta");
      expect(latest).not.toContain("omega");
    } finally {
      mux.stop();
    }
  });

  test("6. global dedupe unchanged; other-principal changes still push filtered view", async () => {
    const { mux, setSessions } = makeHarness({
      hooks: {
        filterSessionList: (sessions) =>
          (sessions as readonly SessionRow[]).filter((s) => s.name === "alpha"),
      },
    });
    const ws = new FakeWS();
    try {
      mux.subscribeSessions(ws);
      await until(() => ws.sessionListFrames().length >= 1);
      const n0 = ws.sessionListFrames().length;

      // Byte-identical provider result → no push at all, even with a filter.
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(n0);

      // Global change that only alters ANOTHER principal's rows still updates
      // lastSessionsJson (unfiltered) so a push fires — the filtered socket
      // may receive a repeat of its unchanged view (deliberate, out of scope
      // to per-socket-dedupe). Its view must not be corrupted with the other
      // principal's rows.
      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("gamma", "C"),
        sessionRow("beta-extra", "B"),
      ]);
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(n0 + 1);
      const raw = ws.sessionListRaw().at(-1)!;
      expect(raw).toContain("alpha");
      expect(raw).not.toContain("beta");
      expect(raw).not.toContain("gamma");
      expect(raw).not.toContain("beta-extra");
      expect(JSON.parse(JSON.parse(raw).data)).toEqual([sessionRow("alpha", "A")]);
    } finally {
      mux.stop();
    }
  });

  test("7. drain catch-up is filtered", async () => {
    const { mux, setSessions, setContent } = makeHarness({
      hooks: {
        filterSessionList: (sessions, ws) => {
          const tag = (ws as FakeWS & { tag?: string }).tag;
          if (tag === "A") return (sessions as readonly SessionRow[]).filter((s) => s.name === "alpha");
          return sessions;
        },
      },
    });
    const ws = new FakeWS() as FakeWS & { tag?: string };
    ws.tag = "A";
    try {
      mux.subscribe(PANE, ws, undefined, { delta: true });
      mux.subscribeSessions(ws, { principal: "A" });
      await until(() =>
        ws.outputFrames().length >= 1 && ws.sessionListFrames().length >= 1);
      const listBefore = ws.sessionListFrames().length;

      // Enter backpressure via a content push that returns -1.
      ws.backpressuredSends = 1;
      setContent("line-0\nblock");
      await until(() => ws.outputFrames().length >= 2 && mux.isBackpressured(ws));

      // Session list changes while blocked — broadcast skips, marks owed.
      setSessions([
        sessionRow("alpha", "A"),
        sessionRow("beta", "B"),
        sessionRow("secret", "Z"),
      ]);
      (mux as any).broadcastSessionList();
      expect(ws.sessionListFrames().length).toBe(listBefore);

      mux.handleDrain(ws);
      expect(ws.sessionListFrames().length).toBe(listBefore + 1);
      const catchUp = ws.sessionListRaw().at(-1)!;
      expect(catchUp).toContain("alpha");
      expect(catchUp).not.toContain("beta");
      expect(catchUp).not.toContain("secret");
      expect(JSON.parse(JSON.parse(catchUp).data)).toEqual([sessionRow("alpha", "A")]);
    } finally {
      mux.stop();
    }
  });

  test("8. lastSessionsJson is not clobbered by catch-up (fix 4a)", async () => {
    let sessionList: SessionRow[] = [sessionRow("a")];
    const { mux, setContent } = makeHarness({
      sessions: () => sessionList,
    });
    // Override provider to track the same mutable list.
    (mux as any).sessionListProvider = () => sessionList;

    const blocked = new FakeWS();
    const healthy = new FakeWS();
    try {
      mux.subscribe(PANE, blocked, undefined, { delta: true });
      mux.subscribe(PANE, healthy, undefined, { delta: true });
      mux.subscribeSessions(blocked);
      mux.subscribeSessions(healthy);
      await until(() =>
        blocked.sessionListFrames().length >= 1
        && healthy.sessionListFrames().length >= 1
        && blocked.outputFrames().length >= 1
        && healthy.outputFrames().length >= 1);

      // Block socket A.
      blocked.backpressuredSends = 1;
      setContent("line-0\nbp");
      await until(() => mux.isBackpressured(blocked) && blocked.outputFrames().length >= 2);

      // List change while A blocked — B receives it, A is owed.
      const healthyListBefore = healthy.sessionListFrames().length;
      const blockedListBefore = blocked.sessionListFrames().length;
      sessionList = [sessionRow("a"), sessionRow("b")];
      (mux as any).broadcastSessionList();
      expect(healthy.sessionListFrames().length).toBe(healthyListBefore + 1);
      expect(JSON.parse(healthy.sessionListFrames().at(-1)!.data)).toEqual(sessionList);
      expect(blocked.sessionListFrames().length).toBe(blockedListBefore);

      // Drain A — catch-up must NOT set lastSessionsJson to a value that
      // would suppress the next real global change for B.
      mux.handleDrain(blocked);
      expect(blocked.sessionListFrames().length).toBe(blockedListBefore + 1);

      // NEXT global change must still reach B (and A).
      const healthyAfterDrain = healthy.sessionListFrames().length;
      const blockedAfterDrain = blocked.sessionListFrames().length;
      sessionList = [sessionRow("a"), sessionRow("b"), sessionRow("c")];
      (mux as any).broadcastSessionList();
      expect(healthy.sessionListFrames().length).toBe(healthyAfterDrain + 1);
      expect(blocked.sessionListFrames().length).toBe(blockedAfterDrain + 1);
      expect(JSON.parse(healthy.sessionListFrames().at(-1)!.data)).toEqual(sessionList);
      expect(JSON.parse(blocked.sessionListFrames().at(-1)!.data)).toEqual(sessionList);
    } finally {
      mux.stop();
    }
  });
});
