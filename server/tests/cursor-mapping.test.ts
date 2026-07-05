/**
 * Cursor mapping vs driver capture semantics — the production bug class this
 * pins down: a driver whose capturePane TRIMS trailing blank lines (kemcortex
 * does, for bandwidth) makes content-derived trailing-blank counts read 0, so
 * the caret was displaced UP by the pane's real blank bottom rows. The
 * captureWithCursor contract fixes it by having the driver count blanks on
 * the raw capture, in the same tmux invocation as the capture itself.
 *
 * Scripted fake driver — no tmux needed.
 */
import { describe, expect, test } from "bun:test";
import { TmuxWsMux, type TmuxDriver, type RawCursorState } from "../src";

const SES = "fake-session";

class FakeWS {
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  frames(type?: string) {
    return this.sent.map((s) => JSON.parse(s)).filter((m) =>
      m.channel === SES && (!type || m.type === type));
  }
}

async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}

/** 10-row viewport: 4 content rows, 6 blank rows below — CC-like layout. */
function makeState() {
  return {
    viewport: ["$ hello", "world", "line3", "last-content", "", "", "", "", "", ""],
    cursor: { x: 5, y: 1, paneHeight: 10, visible: true } as RawCursorState,
    activity: 1,
  };
}
type State = ReturnType<typeof makeState>;

function baseDriver(state: State): TmuxDriver {
  return {
    listSessions: () => [{ name: SES }],
    // UNTRIMMED, like the reference bun driver (trailing viewport blanks kept)
    capturePane: async () => state.viewport.join("\n") + "\n",
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SES, ++state.activity]]),
    getHistoryLimit: () => 2000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (c: string) => c,
  };
}

/** Trimming driver (kemcortex-style): content loses trailing blanks, but the
 * atomic contract reports how many the raw capture had. */
function atomicTrimmingDriver(state: State): TmuxDriver {
  return {
    ...baseDriver(state),
    captureWithCursor: async () => ({
      content: state.viewport.slice(0, 4).join("\n"),
      cursor: { ...state.cursor },
      trailingBlanks: 6,
    }),
  };
}

describe("cursor mapping", () => {
  test("driver-reported trailingBlanks anchor the row even when content is trimmed", async () => {
    const state = makeState();
    const mux = new TmuxWsMux({ driver: atomicTrimmingDriver(state), pollNormalMs: 25 });
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
      await until(() => ws.frames("output").length > 0);
      const frame = ws.frames("output").at(-1);
      // cursor y=1, paneHeight=10, rawTrailingBlanks=6 → last content row is
      // viewport row 3 → row = 3 - 1 = 2 lines above it. Content-derived
      // counting (the old bug) would say row 8-1... i.e. NOT 2.
      expect(frame.cursor).toEqual({ row: 2, col: 5 });
      expect(frame.data).toBe(state.viewport.slice(0, 4).join("\n"));
    } finally {
      mux.stop();
    }
  });

  test("cursor move without content change emits a data-less cursor frame", async () => {
    const state = makeState();
    const mux = new TmuxWsMux({ driver: atomicTrimmingDriver(state), pollNormalMs: 25 });
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
      await until(() => ws.frames("output").length > 0);
      const outputsBefore = ws.frames("output").length;

      state.cursor = { ...state.cursor, x: 4 }; // ← arrow key: content identical
      await until(() => ws.frames("cursor").length > 0);

      const cur = ws.frames("cursor").at(-1);
      expect(cur.cursor).toEqual({ row: 2, col: 4 });
      expect(cur.data).toBeUndefined();
      expect(ws.frames("output").length).toBe(outputsBefore); // no pane re-send
    } finally {
      mux.stop();
    }
  });

  test("cursor below the last content line maps to a NEGATIVE row (no clamp)", async () => {
    const state = makeState();
    state.cursor = { ...state.cursor, y: 4 }; // first blank row, right below "last-content"
    const mux = new TmuxWsMux({ driver: atomicTrimmingDriver(state), pollNormalMs: 25 });
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
      await until(() => ws.frames("output").length > 0);
      // anchor = viewport row 3; cursor y=4 is one blank row below it
      expect(ws.frames("output").at(-1).cursor).toEqual({ row: -1, col: 5 });
    } finally {
      mux.stop();
    }
  });

  test("cursor hidden (copy-mode / cursor_flag=0) broadcasts null", async () => {
    const state = makeState();
    const mux = new TmuxWsMux({ driver: atomicTrimmingDriver(state), pollNormalMs: 25 });
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
      await until(() => ws.frames("output").length > 0);
      state.cursor = { ...state.cursor, visible: false };
      await until(() => ws.frames("cursor").some((m) => m.cursor === null));
    } finally {
      mux.stop();
    }
  });

  test("legacy getCursor driver (untrimmed capture) still maps correctly on content change", async () => {
    const state = makeState();
    const driver: TmuxDriver = {
      ...baseDriver(state),
      getCursor: async () => ({ ...state.cursor }),
    };
    const mux = new TmuxWsMux({ driver, pollNormalMs: 25 });
    const ws = new FakeWS();
    try {
      mux.handleMessage({ type: "subscribe", session: SES }, ws as any);
      await until(() => ws.frames("output").length > 0);
      // trailing blanks derived from the untrimmed content: 6 → same row
      expect(ws.frames("output").at(-1).cursor).toEqual({ row: 2, col: 5 });

      // Legacy path is two non-atomic tmux calls — cursor-only moves are NOT
      // broadcast (a mid-repaint sample would spam spurious frames).
      state.cursor = { ...state.cursor, x: 4 };
      await new Promise((r) => setTimeout(r, 150));
      expect(ws.frames("cursor").length).toBe(0);
    } finally {
      mux.stop();
    }
  });
});
