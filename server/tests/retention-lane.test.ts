import { expect, test } from "bun:test";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";

type AppendCall = { session: string; lines: number; paneRows: number; deeperAvailable?: boolean };

function archiveSpy(overrides: Partial<HistoryArchiveLike> = {}) {
  const calls: AppendCall[] = [];
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
    appendAnchored: (session, captured, opts) => {
      calls.push({
        session,
        lines: captured.length,
        paneRows: opts.paneRows,
        deeperAvailable: opts.deeperAvailable,
      });
      return {
        appended: captured.length,
        liveStartLine: 0,
        totalLines: captured.length,
        gap: false,
        deferred: false,
        needsDeeper: false,
      };
    },
    ...overrides,
  };
  return { archive, calls };
}

function driver(capture: string, rows: Record<string, unknown>[] = [{ name: "cc-a" }]): TmuxDriver {
  return {
    listSessions: () => rows as never,
    capturePane: async () => capture,
    sendKeys: () => {},
    getSessionActivity: () => new Map([["cc-a", 1]]),
    getHistoryLimit: () => 50_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

test("a retained session with no viewer is captured and archived", async () => {
  const { archive, calls } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo\nthree"),
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.session).toBe("cc-a");
  expect(calls[0]!.lines).toBe(3);
  mux.stop();
});

test("retention sends no frames", async () => {
  const { archive } = archiveSpy();
  const sent: string[] = [];
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo"),
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.subscribeSessions({ send: (data: string) => { sent.push(data); return 1; } } as never);
  mux.retainSession("cc-a");
  sent.length = 0;

  await mux.runRetentionTickForTests();

  expect(sent).toEqual([]);
  mux.stop();
});

test("releasing a session stops retaining it", async () => {
  const { archive, calls } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo"),
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");
  mux.releaseSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(calls).toEqual([]);
  mux.stop();
});

test("retention is off unless the host asks for it", async () => {
  const { archive, calls } = archiveSpy();
  const mux = new TmuxWsMux({ driver: driver("one\ntwo"), archive });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(calls).toEqual([]);
  mux.stop();
});

test("retention refuses to start against an archive that cannot anchor", () => {
  // A lane that silently falls back to the path this release exists to replace
  // would keep losing history while looking healthy.
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
  };
  expect(() => new TmuxWsMux({
    driver: driver("one"),
    archive,
    retention: { enabled: true },
  })).toThrow(/appendAnchored/);
});

test("a session the viewer lane owns is left to it", async () => {
  const { archive, calls } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo"),
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");
  mux.subscribe("cc-a", { send: () => 1 } as never);

  await mux.runRetentionTickForTests();

  // The viewer lane captures this session four times a second through the same
  // archive; a second writer would only race it.
  expect(calls).toEqual([]);
  mux.stop();
});

test("the pane height comes from the session row, and a missing one stores less rather than more", async () => {
  const { archive, calls } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo", [{ name: "cc-a", paneRows: 41 }]),
    archive,
    liveLineLimit: 700,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");
  await mux.runRetentionTickForTests();
  expect(calls[0]!.paneRows).toBe(41);

  const bare = archiveSpy();
  const muxBare = new TmuxWsMux({
    driver: driver("one\ntwo", [{ name: "cc-a" }]),
    archive: bare.archive,
    liveLineLimit: 700,
    retention: { enabled: true, intervalMs: 10 },
  });
  muxBare.retainSession("cc-a");
  await muxBare.runRetentionTickForTests();
  // Unknown screen height must err deep: a too-small guess stores rows tmux can
  // still repaint, which is how stale copies get written as history.
  expect(bare.calls[0]!.paneRows).toBe(700);

  mux.stop();
  muxBare.stop();
});

test("a shallow miss escalates to one full-ring capture before anything is written", async () => {
  const depths: number[] = [];
  let call = 0;
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
    appendAnchored: () => {
      call++;
      return call === 1
        ? { appended: 0, liveStartLine: 0, totalLines: 0, gap: false, deferred: false, needsDeeper: true }
        : { appended: 5, liveStartLine: 0, totalLines: 5, gap: false, deferred: false, needsDeeper: false };
    },
  };
  const mux = new TmuxWsMux({
    driver: {
      ...driver("one\ntwo"),
      capturePane: async (_session, opts) => { depths.push(opts.startLine ?? 0); return "one\ntwo"; },
    },
    archive,
    liveLineLimit: 1_000,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(depths).toEqual([-2_000, -50_000]);
  expect(mux.retentionStatus()[0]?.archivedLines).toBe(5);
  mux.stop();
});

test("status reports what was archived, so a stalled session is visible", async () => {
  const { archive } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: driver("one\ntwo\nthree"),
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();
  const [status] = mux.retentionStatus();

  expect(status?.session).toBe("cc-a");
  expect(status?.archivedLines).toBe(3);
  expect(status?.lastArchivedAt).not.toBeNull();
  expect(status?.lastError).toBeNull();
  mux.stop();
});

test("a capture that throws is recorded rather than swallowed", async () => {
  const { archive } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: { ...driver(""), capturePane: async () => { throw new Error("pane vanished"); } },
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(mux.retentionStatus()[0]?.lastError).toContain("pane vanished");
  mux.stop();
});

test("the mux never shrinks a session's scrollback", async () => {
  // tmux's ring is the buffer that makes a polling archive safe, and the shrink
  // was always a no-op on a live pane: history-limit only applies to windows
  // created after it is set.
  const shrinks: number[] = [];
  const { archive } = archiveSpy();
  const mux = new TmuxWsMux({
    driver: { ...driver("one\ntwo"), setSessionHistoryLimit: (_s, limit) => { shrinks.push(limit); } },
    archive,
    retention: { enabled: true, intervalMs: 10 },
  });
  mux.retainSession("cc-a");

  await mux.runRetentionTickForTests();

  expect(shrinks).toEqual([]);
  mux.stop();
});
