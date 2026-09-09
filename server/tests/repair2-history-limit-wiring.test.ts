/**
 * F2 / B01 round 2 — the two places inside this package that size a deep
 * capture must name the session they are capturing.
 *
 * `history_limit` is frozen on a pane at birth. `TmuxDriver.getHistoryLimit()`
 * with no session therefore cannot answer for the session being captured: a
 * tmux-backed driver resolves an untargeted read to whichever session was
 * created last. Both call sites already hold a session name; round 1 left both
 * calling the ambient form, so a session holding 50000 lines was served through
 * a 1000-line window on the WebSocket path people actually use.
 *
 * No tmux here on purpose: the driver is a recorder, so the argument each call
 * site passes is the measurement.
 */
import { expect, test } from "bun:test";
import type { SessionListItem } from "../../core/src/protocol";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";
import { RetentionLane } from "../src/retention-lane";

const DEEP_A = "wiring-deep-a";
const SHALLOW_B = "wiring-shallow-b";
const DEEP = 50_000;
const SHALLOW = 1_000;
const LIVE_LINE_LIMIT = 2_000;

/** Depth per session, plus what an untargeted read would have answered. */
const DEPTHS: Record<string, number> = { [DEEP_A]: DEEP, [SHALLOW_B]: SHALLOW };
/** A tmux-backed driver answers for the newest session when asked ambiently. */
const AMBIENT = SHALLOW;

function sessionListItem(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

type Recorder = {
  /** One entry per getHistoryLimit call: the argument, exactly as received. */
  limitArgs: (string | undefined)[];
  captures: { session: string; startLine: number | undefined }[];
};

function recordingDriver(recorder: Recorder, lineCount = 60): TmuxDriver {
  return {
    listSessions: () => [sessionListItem(DEEP_A), sessionListItem(SHALLOW_B)],
    capturePane: async (session, opts) => {
      recorder.captures.push({ session, startLine: opts.startLine });
      return Array.from({ length: lineCount }, (_, i) => `${session}-L${i}`).join("\n");
    },
    sendKeys: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: (session?: string) => {
      recorder.limitArgs.push(session);
      if (session === undefined) return AMBIENT;
      return DEPTHS[session] ?? AMBIENT;
    },
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

class FakeWS {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    return 1;
  }
  outputFrames(channel: string) {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.channel === channel && frame.type === "output");
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

test("full-history capture sizes the window from the session it is capturing", async () => {
  const recorder: Recorder = { limitArgs: [], captures: [] };
  const mux = new TmuxWsMux<FakeWS>({
    driver: recordingDriver(recorder),
    liveLineLimit: LIVE_LINE_LIMIT,
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    burstDurationMs: 60_000,
    pollReconcileMs: 60_000,
  });
  const ws = new FakeWS();
  try {
    mux.subscribe(DEEP_A, ws);
    await until(() => ws.outputFrames(DEEP_A).length === 1);
    await until(() => !(mux as any).queuedCapturesInFlight.has(DEEP_A));

    // The measurement: which session the depth was asked about.
    expect(recorder.limitArgs).toContain(DEEP_A);
    expect(recorder.limitArgs).not.toContain(undefined);

    const deepest = Math.min(
      ...recorder.captures
        .filter((c) => c.session === DEEP_A)
        .map((c) => c.startLine ?? 0),
    );
    expect(deepest).toBe(-DEEP);
    // Ambient would have produced this instead, and it is a different number.
    expect(deepest).not.toBe(-Math.max(AMBIENT, LIVE_LINE_LIMIT));
  } finally {
    mux.stop();
  }
});

test("two sessions on one mux get two different full-history windows", async () => {
  const recorder: Recorder = { limitArgs: [], captures: [] };
  const mux = new TmuxWsMux<FakeWS>({
    driver: recordingDriver(recorder),
    liveLineLimit: LIVE_LINE_LIMIT,
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    burstDurationMs: 60_000,
    pollReconcileMs: 60_000,
  });
  const deepWs = new FakeWS();
  const shallowWs = new FakeWS();
  try {
    mux.subscribe(DEEP_A, deepWs);
    await until(() => deepWs.outputFrames(DEEP_A).length === 1);
    await until(() => !(mux as any).queuedCapturesInFlight.has(DEEP_A));
    mux.subscribe(SHALLOW_B, shallowWs);
    await until(() => shallowWs.outputFrames(SHALLOW_B).length === 1);
    await until(() => !(mux as any).queuedCapturesInFlight.has(SHALLOW_B));

    expect(recorder.limitArgs).not.toContain(undefined);
    const deepest = (session: string) =>
      Math.min(
        ...recorder.captures
          .filter((c) => c.session === session)
          .map((c) => c.startLine ?? 0),
      );
    expect(deepest(DEEP_A)).toBe(-DEEP);
    // SHALLOW_B's own depth is below the live window, so the live window wins —
    // the point is that it is NOT sized from DEEP_A, and not from a single
    // ambient number shared by both.
    expect(deepest(SHALLOW_B)).toBe(-LIVE_LINE_LIMIT);
    expect(deepest(DEEP_A)).not.toBe(deepest(SHALLOW_B));
  } finally {
    mux.stop();
  }
});

test("the retention lane's deep re-capture names its session", async () => {
  const recorder: Recorder = { limitArgs: [], captures: [] };
  let needsDeeper = true;
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
    appendAnchored: (_session, captured) => {
      // First append reports a hole, so the lane takes the deep branch once.
      const result = {
        appended: captured.length,
        liveStartLine: 0,
        totalLines: captured.length,
        gap: false,
        deferred: false,
        needsDeeper,
      };
      needsDeeper = false;
      return result;
    },
  };
  const lane = new RetentionLane({
    driver: recordingDriver(recorder),
    archive,
    liveLineLimit: LIVE_LINE_LIMIT,
    sessions: () => [DEEP_A],
    intervalMs: 60_000,
  });
  await (lane as any).capture(DEEP_A);

  expect(recorder.limitArgs).toEqual([DEEP_A]);
  const deepest = Math.min(...recorder.captures.map((c) => c.startLine ?? 0));
  expect(deepest).toBe(-DEEP);
  expect(deepest).not.toBe(-Math.max(AMBIENT, LIVE_LINE_LIMIT));
});

test("the contract still accepts a host written before the session parameter", () => {
  // Additive on purpose: `getHistoryLimit(session?: string)` keeps an older
  // host's `() => number` assignable, so widening the interface is not a
  // breaking change for embedders. Such a host answers ambient — that is the
  // cost of not passing a session, and it is why every call site here does.
  const legacy: TmuxDriver = {
    ...recordingDriver({ limitArgs: [], captures: [] }),
    getHistoryLimit: () => AMBIENT,
  };
  expect(legacy.getHistoryLimit(DEEP_A)).toBe(AMBIENT);
  expect(legacy.getHistoryLimit(DEEP_A)).not.toBe(DEEP);
});
