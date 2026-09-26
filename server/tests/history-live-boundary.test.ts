import { expect, test } from "bun:test";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";

function driver(): TmuxDriver {
  return {
    listSessions: () => [{ name: "s" }] as never,
    capturePane: async () => "",
    sendKeys: () => {},
    getSessionActivity: () => new Map(),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

function recordingArchive(liveStartLine?: () => number | null) {
  const reads: (number | null)[] = [];
  const archive: HistoryArchiveLike = {
    ingestSnapshot: () => ({ liveContent: "" }),
    readBefore: (_session, beforeLine) => {
      reads.push(beforeLine);
      return { lines: [], startLine: null, hasMore: false };
    },
    renameSession: () => {},
    ...(liveStartLine ? { liveStartLine } : {}),
  };
  return { archive, reads };
}

test("a null beforeLine pages from the live boundary, not the end of the archive", () => {
  // The client's first history request sends null, meaning "the oldest row I can
  // show". With an archive that also stores the live window, answering from the
  // end would hand back rows the viewer already has on screen.
  const { archive, reads } = recordingArchive(() => 900);
  const mux = new TmuxWsMux({ driver: driver(), archive });
  const sent: string[] = [];

  mux.expandHistory("s", { send: (data: string) => { sent.push(data); return 1; } } as never, null, 100);

  expect(reads).toEqual([900]);
  expect(sent).toHaveLength(1);
  mux.stop();
});

test("an explicit beforeLine from the client is still honoured verbatim", () => {
  const { archive, reads } = recordingArchive(() => 900);
  const mux = new TmuxWsMux({ driver: driver(), archive });

  mux.expandHistory("s", { send: () => 1 } as never, 300, 100);

  expect(reads).toEqual([300]);
  mux.stop();
});

test("an archive without a live boundary behaves exactly as before", () => {
  const { archive, reads } = recordingArchive();
  const mux = new TmuxWsMux({ driver: driver(), archive });

  mux.expandHistory("s", { send: () => 1 } as never, null, 100);

  expect(reads).toEqual([null]);
  mux.stop();
});

test("a throwing live boundary returns a retryable error without reading a duplicate-prone tail", () => {
  const { archive, reads } = recordingArchive(() => { throw new Error("boundary unavailable"); });
  const mux = new TmuxWsMux({ driver: driver(), archive });
  const sent: string[] = [];

  mux.expandHistory("s", { send: (data: string) => { sent.push(data); return 1; } } as never, null, 100);

  expect(reads).toEqual([]);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toEqual({
    channel: "s",
    type: "error",
    data: "history_temporarily_unavailable",
    code: "history_temporarily_unavailable",
    request: "history_expand",
    retryable: true,
  });
  expect(sent[0]).not.toContain("boundary unavailable");
  mux.stop();
});

// ── NEWARCH L2-I lot I4: the projection live window and its seam ─────────────
import { muxHistoryBoundaryTransition, validateMuxHistoryBoundary, validateNewarchFrameMeta } from "../../core/src/protocol";
import { BLANK_CELL, ProjectionLiveWindow, parserRowCells, type PipeHistoryPane } from "../src/pipe-history-runtime";

/** A pane double with exactly the surface the live window reads. */
function fakePane(cols = 20, rows = 4) {
  const paneKey = { serverIdentity: "srv", paneId: "%7", birthGeneration: 1 };
  const ring: Array<{ lineId: number; sourceEpoch: number; geometryGeneration: number; cells: ReturnType<typeof parserRowCells>; softWrap: boolean; ansi?: string }> = [];
  let next = 0, revision = 0, kind: "normal" | "alternate" = "normal", sourceEpoch = 1;
  const row = (text: string) => parserRowCells([["default", "default", 0, text.padEnd(cols).slice(0, cols)]], cols);
  const pane = {
    paneKey,
    recentRows: () => ring,
    view: () => ({
      paneKey, session: "s", cells: Array.from({ length: rows }, (_, y) => y === 0 ? row(`screen ${next}`) : new Array(cols).fill(BLANK_CELL)),
      cursor: { x: 3, y: 1, visible: true }, kind, cols, rows, displaySource: "pipe" as const,
      token: { paneKey, sourceEpoch, geometryGeneration: 0, revision, durableRevision: revision, nextLineId: next },
      sourceEpoch, geometryGeneration: 0, mouseSgr: false, mouseAny: false, degraded: false, issues: [],
    }),
    readRange: (start: number, end: number) => {
      const lines = ring.filter((r) => r.lineId >= start && r.lineId < end).map((r) => `row ${r.lineId}`);
      return { lines, startLine: start, issues: [], token: pane.view().token };
    },
  };
  return {
    pane: pane as unknown as PipeHistoryPane,
    append(n: number) { for (let i = 0; i < n; i++) { ring.push({ lineId: next, sourceEpoch, geometryGeneration: 0, cells: row(`row ${next}`), softWrap: false }); next++; revision++; } },
    alt(on: boolean) { kind = on ? "alternate" : "normal"; revision++; },
    epoch() { sourceEpoch++; revision++; },
  };
}

test("NEWARCH I4: the live window start moves forward only in whole windows and every seam step is an advance", () => {
  const window = new ProjectionLiveWindow(10);
  const f = fakePane();
  f.append(5);
  let previous = window.snapshot(f.pane, 3)!;
  expect(previous.boundary.liveStartLine).toBe(0);
  expect(previous.content.split("\n")).toHaveLength(5 + 4);
  // Trailing blank screen rows are counted below the last content line.
  expect(previous.cursor).toEqual({ row: 4 - 1 - 3 - 1, col: 3 });
  expect(validateNewarchFrameMeta(previous.newarch)).not.toBeNull();
  const starts = new Set<number>([0]);
  for (let step = 0; step < 40; step++) {
    f.append(1 + (step % 3));
    const next = window.snapshot(f.pane, 3)!;
    expect(validateMuxHistoryBoundary(next.boundary)).not.toBeNull();
    expect(muxHistoryBoundaryTransition(previous.boundary, next.boundary)).toBe("advance");
    const history = next.content.split("\n").slice(0, -4);
    expect(history[0]).toBe(`row ${next.boundary.liveStartLine}`);
    expect(history.at(-1)).toBe(`row ${next.newarch.nextLineId - 1}`);
    starts.add(next.boundary.liveStartLine);
    previous = next;
  }
  // Start 0 until the window holds 2x10 rows, then a few whole-window jumps (not one per row).
  expect(Math.max(...starts)).toBeGreaterThan(0);
  expect(starts.size).toBeLessThan(10);
  expect(previous.content.split("\n").length - 4).toBeLessThanOrEqual(20);
  // An epoch change keeps the seam generation: line ids are pane-global.
  f.epoch();
  f.append(1);
  const afterEpoch = window.snapshot(f.pane, 3)!;
  expect(muxHistoryBoundaryTransition(previous.boundary, afterEpoch.boundary)).toBe("advance");
  expect(afterEpoch.newarch.sourceEpoch).toBe(2);
});

test("NEWARCH I4: history pages below the live window are contiguous projection line ids", () => {
  const window = new ProjectionLiveWindow(10);
  const f = fakePane();
  f.append(57);
  const snapshot = window.snapshot(f.pane, 1)!;
  const start = snapshot.boundary.liveStartLine;
  expect(start).toBeGreaterThan(0);
  const seen: number[] = [];
  let before: number | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = window.readBefore(f.pane, before, 7);
    if (page.startLine === null) break;
    expect(page.lines).toEqual(Array.from({ length: page.lines.length }, (_, i) => `row ${page.startLine! + i}`));
    seen.unshift(...page.lines.map((_, i) => page.startLine! + i));
    before = page.startLine;
    if (!page.hasMore) break;
  }
  expect(seen).toEqual(Array.from({ length: start }, (_, i) => i));
  const after = window.readAfter(f.pane, 4, 3);
  expect(after.lines).toEqual(["row 5", "row 6", "row 7"]);
});

test("NEWARCH I4: an alternate screen publishes only the screen, the seam at the newest line", () => {
  const window = new ProjectionLiveWindow(10);
  const f = fakePane();
  f.append(12);
  window.snapshot(f.pane, 1);
  f.alt(true);
  const alt = window.snapshot(f.pane, 1)!;
  expect(alt.screen.alt).toBe(true);
  expect(alt.boundary.liveStartLine).toBe(12);
  expect(alt.content.split("\n")).toHaveLength(4);
});
