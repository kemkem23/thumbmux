import { expect, test } from "bun:test";
import { RetentionLane, type RetentionLaneStatus } from "../src/retention-lane";
import type { HistoryArchiveLike, TmuxDriver } from "../src/ws-mux";

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

type LaneDriver = Pick<TmuxDriver, "capturePane" | "getHistoryLimit" | "listSessions">;

function driver(capture: string, rows: Record<string, unknown>[] = [{ name: "cc-a" }]): LaneDriver {
  return {
    listSessions: () => rows as never,
    capturePane: async () => capture,
    getHistoryLimit: () => 50_000,
  };
}

test("a listed session is captured and archived", async () => {
  const { archive, calls } = archiveSpy();
  const lane = new RetentionLane({
    driver: driver("one\ntwo\nthree"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
  });

  await lane.tick();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.session).toBe("cc-a");
  expect(calls[0]!.lines).toBe(3);
});

test("an archive whose appendAnchored is a class method still works", async () => {
  // The lane held that function in a local and called it detached, so `this`
  // was undefined for any real class. Every spy here is a closure and none of
  // them could see it; the live-tmux test failed on its first run instead.
  class MethodArchive {
    lines = 0;
    ingestSnapshot() { return { liveContent: "" }; }
    readBefore() { return { lines: [], startLine: null, hasMore: false }; }
    renameSession() {}
    appendAnchored(_session: string, captured: readonly string[]) {
      this.lines += captured.length;   // throws if `this` was lost
      return {
        appended: captured.length,
        liveStartLine: 0,
        totalLines: this.lines,
        gap: false,
        deferred: false,
        needsDeeper: false,
      };
    }
  }
  const archive = new MethodArchive();
  const errors: (string | null)[] = [];
  const lane = new RetentionLane({
    driver: driver("one\ntwo\nthree"),
    archive: archive as unknown as HistoryArchiveLike,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    onStatus: (status) => errors.push(status.lastError),
  });

  await lane.tick();

  expect(errors).toEqual([null]);
  expect(archive.lines).toBe(3);
});

test("the host's list is read fresh every tick, so releasing a session is just not listing it", async () => {
  const { archive, calls } = archiveSpy();
  let listed: string[] = ["cc-a"];
  const lane = new RetentionLane({
    driver: driver("one\ntwo"),
    archive,
    sessions: () => listed,
    liveLineLimit: 1_000,
  });

  await lane.tick();
  expect(calls).toHaveLength(1);

  listed = [];
  await lane.tick();

  // No retained-set of its own means no second copy of the host's policy to
  // fall out of sync with.
  expect(calls).toHaveLength(1);
});

test("a lane refuses to exist against an archive that cannot anchor", () => {
  // Falling back to the viewer-shaped ingest would keep the lane looking healthy
  // while losing history, which is the failure this release exists to end.
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
  };
  expect(() => new RetentionLane({
    driver: driver("one"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
  })).toThrow(/appendAnchored/);
});

test("a session a viewer owns is left to the viewer's own captures", async () => {
  const { archive, calls } = archiveSpy();
  const lane = new RetentionLane({
    driver: driver("one\ntwo"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    hasViewers: (session) => session === "cc-a",
  });

  await lane.tick();

  expect(calls).toEqual([]);
});

test("the pane height comes from the session row, and a missing one stores less rather than more", async () => {
  const known = archiveSpy();
  await new RetentionLane({
    driver: driver("one\ntwo", [{ name: "cc-a", paneRows: 41 }]),
    archive: known.archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 700,
  }).tick();
  expect(known.calls[0]!.paneRows).toBe(41);

  const bare = archiveSpy();
  await new RetentionLane({
    driver: driver("one\ntwo", [{ name: "cc-a" }]),
    archive: bare.archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 700,
  }).tick();
  // An unknown screen height must err deep: too small stores rows tmux can still
  // repaint, which is how a stale copy gets written down as history.
  expect(bare.calls[0]!.paneRows).toBe(700);
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
  const seen: RetentionLaneStatus[] = [];
  const lane = new RetentionLane({
    driver: {
      ...driver("one\ntwo"),
      capturePane: async (_session, opts) => { depths.push(opts.startLine ?? 0); return "one\ntwo"; },
    },
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    onStatus: (status) => seen.push(status),
  });

  await lane.tick();

  expect(depths).toEqual([-2_000, -50_000]);
  expect(seen.at(-1)?.archivedLines).toBe(5);
});

test("status reaches the host on every attempt, so a stalled session is visible", async () => {
  const { archive } = archiveSpy();
  const seen: RetentionLaneStatus[] = [];
  const lane = new RetentionLane({
    driver: driver("one\ntwo\nthree"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    onStatus: (status) => seen.push(status),
  });

  await lane.tick();

  expect(seen).toHaveLength(1);
  expect(seen[0]!.session).toBe("cc-a");
  expect(seen[0]!.archivedLines).toBe(3);
  expect(seen[0]!.lastArchivedAt).not.toBeNull();
  expect(seen[0]!.lastError).toBeNull();
});

test("a capture that throws is reported rather than swallowed", async () => {
  const { archive } = archiveSpy();
  const errors: (string | null)[] = [];
  const lane = new RetentionLane({
    driver: { ...driver(""), capturePane: async () => { throw new Error("pane vanished"); } },
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    onStatus: (status) => errors.push(status.lastError),
  });

  await lane.tick();

  // A lane that reports only its successes is indistinguishable from a dead one.
  expect(errors.at(-1)).toContain("pane vanished");
});

test("a status hook that throws does not take the lane down with it", async () => {
  const { archive, calls } = archiveSpy();
  const lane = new RetentionLane({
    driver: driver("one\ntwo"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    onStatus: () => { throw new Error("host telemetry exploded"); },
  });

  await lane.tick();
  await lane.tick();

  expect(calls).toHaveLength(2);
});

test("a slow tick does not overlap itself", async () => {
  const { archive, calls } = archiveSpy();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lane = new RetentionLane({
    driver: { ...driver("one"), capturePane: async () => { await gate; return "one"; } },
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
  });

  const first = lane.tick();
  await lane.tick();          // returns immediately: the first is still running
  release();
  await first;

  expect(calls).toHaveLength(1);
});

test("start and stop own the timer, and nothing runs before start", async () => {
  const { archive, calls } = archiveSpy();
  const lane = new RetentionLane({
    driver: driver("one\ntwo"),
    archive,
    sessions: () => ["cc-a"],
    liveLineLimit: 1_000,
    intervalMs: 5,
  });

  await Bun.sleep(20);
  expect(calls).toEqual([]);

  lane.start();
  await Bun.sleep(40);
  lane.stop();
  const afterStop = calls.length;
  expect(afterStop).toBeGreaterThan(0);

  await Bun.sleep(30);
  expect(calls).toHaveLength(afterStop);
});
