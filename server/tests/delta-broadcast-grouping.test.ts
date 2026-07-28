/**
 * Characterization + contract pins for multi-viewer output broadcast.
 *
 * Cases 1–4 pin today's observable per-socket behaviour (full/tail, delta vs
 * classic, drop/throw recovery, per-socket reset). They must stay green both
 * before and after the broadcast-grouping refactor.
 *
 * Case 5 (base sharing) pins the NEW optimization: identical successful delta
 * viewers must share one immutable next-base array instance. It is skipped
 * until the refactor lands; enable it in the same change that groups sends.
 */
import { describe, expect, test } from "bun:test";
import { applyMuxDelta, splitMuxOutputData } from "../../core/src/protocol";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const SESSION = "sim-delta-group";

type Frame = Record<string, any>;

class FakeWS {
  sent: string[] = [];
  attempts = 0;
  failSends = 0;
  droppedSends = 0;
  backpressuredSends = 0;

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

/** Mirror private contentFor trailing-blank trim + tail slice. */
function expectedView(content: string, tail?: number): string {
  if (!tail) return content;
  const lines = content.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  if (end === 0) return "";
  return lines.slice(Math.max(0, end - tail), end).join("\n");
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

function makeHarness(initial = "line-0\nline-1\nline-2\nline-3") {
  const contents = new Map([[SESSION, initial]]);
  let activity = 0;
  const cursor = { x: 0, y: 0, paneHeight: 1, visible: true };
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
    resizeWindow: () => {},
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
    setContent: (content: string) => contents.set(SESSION, content),
  };
}

async function waitAllFrames(sockets: FakeWS[], min: number) {
  await until(() => sockets.every((ws) => ws.frames().length >= min));
}

describe("delta broadcast grouping — characterization", () => {
  test("heterogeneous viewers reconstruct exactly across a long mutation sequence", async () => {
    const initial = Array.from({ length: 40 }, (_, i) => `stable-${i}`).join("\n");
    const { mux, setContent } = makeHarness(initial);

    const fullDeltaA = new FakeWS();
    const fullDeltaB = new FakeWS();
    const tailDeltaA = new FakeWS();
    const tailDeltaB = new FakeWS();
    const tailOnly = new FakeWS();
    const fullOnly = new FakeWS();

    const all = [fullDeltaA, fullDeltaB, tailDeltaA, tailDeltaB, tailOnly, fullOnly];

    try {
      mux.subscribe(SESSION, fullDeltaA, undefined, { delta: true });
      mux.subscribe(SESSION, fullDeltaB, undefined, { delta: true });
      mux.subscribe(SESSION, tailDeltaA, undefined, { tail: 24, delta: true });
      mux.subscribe(SESSION, tailDeltaB, undefined, { tail: 24, delta: true });
      mux.subscribe(SESSION, tailOnly, undefined, { tail: 24 });
      mux.subscribe(SESSION, fullOnly, undefined, {});

      await waitAllFrames(all, 1);

      const specs: Array<{ ws: FakeWS; tail?: number; delta: boolean }> = [
        { ws: fullDeltaA, delta: true },
        { ws: fullDeltaB, delta: true },
        { ws: tailDeltaA, tail: 24, delta: true },
        { ws: tailDeltaB, tail: 24, delta: true },
        { ws: tailOnly, tail: 24, delta: false },
        { ws: fullOnly, delta: false },
      ];

      const assertViews = (content: string) => {
        for (const { ws, tail, delta } of specs) {
          const frames = ws.frames();
          expect(reconstruct(frames)).toBe(expectedView(content, tail));
          if (!delta) {
            expect(frames.every((f) => f.type === "output")).toBe(true);
          }
        }
      };
      assertViews(initial);

      const wide = "→ ✓ ｗｉｄｅ";
      const longLine = "L".repeat(4000);
      const mutations: string[] = [
        `${initial}\nappended-line`,
        [...initial.split("\n").slice(0, -1), "changed-last"].join("\n") + "\nappended-line",
        (() => {
          const lines = initial.split("\n");
          lines[20] = "changed-middle";
          return [...lines.slice(0, -1), "changed-last", "appended-line"].join("\n");
        })(),
        (() => {
          const lines = initial.split("\n");
          lines[0] = "changed-FIRST";
          lines[20] = "changed-middle";
          return [...lines.slice(0, -1), "changed-last", "appended-line"].join("\n");
        })(),
        "totally\ndifferent\nbuffer\nnow",
        "single-line-only",
        "",
        "ends-with-newline\n",
        `prefix\n${wide}\n${longLine}\nsuffix`,
      ];

      let expectedCount = 1;
      for (const next of mutations) {
        const before = all.map((ws) => ws.frames().length);
        setContent(next);
        expectedCount += 1;
        await until(() => all.every((ws, i) => ws.frames().length >= before[i]! + 1));
        for (const ws of all) {
          expect(ws.frames().length).toBe(expectedCount);
        }
        assertViews(next);
      }
    } finally {
      mux.stop();
    }
  });

  test("exactly one output/delta frame per socket per content change", async () => {
    const initial = Array.from({ length: 30 }, (_, i) => `row-${i}`).join("\n");
    const { mux, setContent } = makeHarness(initial);
    const sockets = [new FakeWS(), new FakeWS(), new FakeWS()];
    try {
      mux.subscribe(SESSION, sockets[0]!, undefined, { delta: true });
      mux.subscribe(SESSION, sockets[1]!, undefined, { tail: 24, delta: true });
      mux.subscribe(SESSION, sockets[2]!, undefined, { tail: 24 });
      await waitAllFrames(sockets, 1);

      const N = 7;
      for (let i = 0; i < N; i++) {
        setContent(`${initial}\nmutation-${i}`);
        await waitAllFrames(sockets, 1 + i + 1);
      }

      for (const ws of sockets) {
        expect(ws.frames().length).toBe(1 + N);
      }
    } finally {
      mux.stop();
    }
  });

  test("a failing socket inside a group does not poison peers (drop and throw)", async () => {
    for (const mode of ["drop", "throw"] as const) {
      const initial = Array.from({ length: 50 }, (_, i) => `base-${i}`).join("\n");
      const { mux, setContent } = makeHarness(initial);
      const survivor = new FakeWS();
      const failing = new FakeWS();
      try {
        mux.subscribe(SESSION, survivor, undefined, { delta: true });
        mux.subscribe(SESSION, failing, undefined, { delta: true });
        await waitAllFrames([survivor, failing], 1);

        const next = `${initial}\nfailed-broadcast`;
        if (mode === "drop") failing.droppedSends = 1;
        else failing.failSends = 1;

        const beforeSurvivor = survivor.frames().length;
        const beforeFailing = failing.frames().length;
        const attemptsBefore = failing.attempts;
        setContent(next);

        // Survivor must receive the update; failing socket's send is dropped/thrown.
        await until(() =>
          survivor.frames().length === beforeSurvivor + 1
          && failing.attempts > attemptsBefore
          && failing.frames().length === beforeFailing);

        expect(survivor.frames().at(-1)!.type).toBe("delta");
        expect(reconstruct(survivor.frames())).toBe(next);
        // Failing socket still holds the pre-failure reconstruction.
        expect(reconstruct(failing.frames())).toBe(initial);

        const survivorBase = (mux as any).outputBases.get(SESSION)?.get(survivor) as string[] | undefined;
        const failingBase = (mux as any).outputBases.get(SESSION)?.get(failing) as string[] | undefined;
        expect(survivorBase).toBeDefined();
        expect(failingBase).toBeDefined();
        // Failing socket must not have advanced onto the survivor's new base.
        expect(failingBase).not.toBe(survivorBase);
        expect(failingBase).toEqual(splitMuxOutputData(initial));
        expect(survivorBase).toEqual(splitMuxOutputData(next));

        // Following broadcast: failing socket is forced full; survivor continues with delta.
        const after = `${next}\nrecovered`;
        const sCount = survivor.frames().length;
        const fCount = failing.frames().length;
        setContent(after);
        await until(() =>
          survivor.frames().length === sCount + 1
          && failing.frames().length === fCount + 1);

        expect(failing.frames().at(-1)).toMatchObject({ type: "output", data: after });
        expect(survivor.frames().at(-1)!.type).toBe("delta");
        expect(reconstruct(survivor.frames())).toBe(after);
        expect(reconstruct(failing.frames())).toBe(after);
      } finally {
        mux.stop();
      }
    }
  });

  test("pending reset markers are per socket", async () => {
    const initial = Array.from({ length: 40 }, (_, i) => `r-${i}`).join("\n");
    const { mux, setContent } = makeHarness(initial);
    const a = new FakeWS();
    const b = new FakeWS();
    const c = new FakeWS();
    try {
      mux.subscribe(SESSION, a, undefined, { delta: true });
      mux.subscribe(SESSION, b, undefined, { delta: true });
      mux.subscribe(SESSION, c, undefined, { delta: true });
      await waitAllFrames([a, b, c], 1);

      // Drop the immediate resync paint so the reset marker survives into the
      // next content-change broadcast (same path as a lost resync frame).
      a.droppedSends = 1;
      const changed = `${initial}\nwith-reset`;
      setContent(changed);
      mux.handleMessage({ type: "resync", session: SESSION }, a);

      await until(() =>
        a.frames().length >= 2
        && b.frames().length >= 2
        && c.frames().length >= 2);

      const aFrame = a.frames().at(-1)!;
      expect(aFrame).toMatchObject({ type: "output", reset: "resync", data: changed });

      const bFrame = b.frames().at(-1)!;
      const cFrame = c.frames().at(-1)!;
      expect(bFrame.type).toBe("delta");
      expect(cFrame.type).toBe("delta");
      expect(bFrame.reset).toBeUndefined();
      expect(cFrame.reset).toBeUndefined();

      expect(reconstruct(a.frames())).toBe(changed);
      expect(reconstruct(b.frames())).toBe(changed);
      expect(reconstruct(c.frames())).toBe(changed);
    } finally {
      mux.stop();
    }
  });
});

describe("delta broadcast grouping — optimization pin", () => {
  // NEW behaviour (not characterization) — pins the grouping optimization.
  test("successful identical delta viewers share one next-base array instance", async () => {
    const initial = Array.from({ length: 40 }, (_, i) => `share-${i}`).join("\n");
    const { mux, setContent } = makeHarness(initial);
    const a = new FakeWS();
    const b = new FakeWS();
    try {
      mux.subscribe(SESSION, a, undefined, { delta: true });
      mux.subscribe(SESSION, b, undefined, { delta: true });
      await waitAllFrames([a, b], 1);

      setContent(`${initial}\nshared-base`);
      await until(() => a.frames().length >= 2 && b.frames().length >= 2);

      const baseA = (mux as any).outputBases.get(SESSION)?.get(a);
      const baseB = (mux as any).outputBases.get(SESSION)?.get(b);
      expect(baseA).toBeDefined();
      expect(baseB).toBe(baseA); // same array instance
    } finally {
      mux.stop();
    }
  });
});
