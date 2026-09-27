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
import { BLANK_CELL, ProjectionLiveWindow, parserRowCells, screenOverlap, type PipeHistoryPane } from "../src/pipe-history-runtime";

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

// ── NEWARCH-SWITCHON H2: rows tmux pulled back on resize, by tmux's own counters ──
import { resizePullback } from "../src/pipe-history-runtime";

/** A calibrated pane double: ring rows `ring` (line ids 0..), a screen of `screen` texts, an optional pull-back. */
function calibratedPane(ring: string[], screen: string[], pulledBack: { rows: number; endLine: number } | null, displaySource: "pipe" | "tmux-calibrated" = "tmux-calibrated") {
  const cols = 12;
  const paneKey = { serverIdentity: "srv", paneId: "%9", birthGeneration: 1 };
  const row = (text: string) => parserRowCells([["default", "default", 0, text.padEnd(cols).slice(0, cols)]], cols);
  const rows = ring.map((text, lineId) => ({ lineId, sourceEpoch: 1, geometryGeneration: 0, cells: row(text), softWrap: false }));
  const token = { paneKey, sourceEpoch: 1, geometryGeneration: 0, revision: 1, durableRevision: 1, nextLineId: ring.length };
  const pane = {
    paneKey,
    recentRows: () => rows,
    view: () => ({
      paneKey, session: "s", cells: screen.map(row), cursor: { x: 0, y: screen.length - 1, visible: true }, kind: "normal" as const,
      cols, rows: screen.length, displaySource, token, sourceEpoch: 1, geometryGeneration: 0, mouseSgr: false, mouseAny: false,
      degraded: false, issues: [], pulledBack,
    }),
    readRange: () => null,
  };
  return pane as unknown as PipeHistoryPane;
}
const liveLines = (pane: PipeHistoryPane) => new ProjectionLiveWindow(1000).snapshot(pane, 1)!.content.split("\n").map((l) => l.trimEnd());

test("SWITCHON H2: pull-back is history_size before - after, clamped to the rows added; never text", () => {
  const meta = (rows: number, historySize: number, alternate = false) => ({ rows, historySize, alternate });
  // 24 -> 37 with 100 rows of history: tmux pulls 13 back.
  expect(resizePullback(meta(24, 100), meta(37, 87))).toBe(13);
  // Only 5 rows of history: 5 come back, the rest of the growth is blank.
  expect(resizePullback(meta(24, 5), meta(37, 0))).toBe(5);
  // A clear-history during the growth drops more than the rows added: clamp.
  expect(resizePullback(meta(24, 100), meta(37, 0))).toBe(13);
  // Output scrolled 4 rows into history between the two reads: 9 still on screen.
  expect(resizePullback(meta(24, 100), meta(37, 91))).toBe(9);
  // Shrinking pushes rows into history; nothing is pulled.
  expect(resizePullback(meta(37, 87), meta(24, 100))).toBe(0);
  // Same height, history shrank (clear-history): not a pull-back.
  expect(resizePullback(meta(24, 100), meta(24, 0))).toBe(0);
  // tmux never pulls history into the alternate screen.
  expect(resizePullback(meta(24, 100, true), meta(37, 87, true))).toBe(0);
  // Unreadable history_size: no number, no guess.
  expect(resizePullback(meta(24, Number.NaN), meta(37, 87))).toBe(0);
  expect(resizePullback(meta(24, 100), meta(37, Number.NaN))).toBe(0);
});

test("SWITCHON H2: a calibrated screen hides exactly the pulled-back rows from the live window, in order", () => {
  const ring = Array.from({ length: 50 }, (_, i) => `R-${String(i).padStart(3, "0")}`);
  // tmux 24 -> 37: the newest 13 history rows (37..49) are back at the top of the screen.
  const screen = [...ring.slice(37), ...Array.from({ length: 23 }, (_, i) => `R-${String(50 + i).padStart(3, "0")}`), ""];
  const pane = calibratedPane(ring, screen, { rows: 13, endLine: 50 });
  expect(screenOverlap(pane.view())).toBe(13);
  const ids = liveLines(pane).filter((l) => l.startsWith("R-")).map((l) => Number(l.slice(2)));
  expect(ids).toEqual(Array.from({ length: 73 }, (_, i) => i));
  // A pipe screen never holds pulled-back rows (the parser does not pull history in).
  expect(screenOverlap({ displaySource: "pipe", kind: "normal", pulledBack: { rows: 13, endLine: 50 } })).toBe(0);
  expect(screenOverlap({ displaySource: "tmux-calibrated", kind: "alternate", pulledBack: { rows: 13, endLine: 50 } })).toBe(0);
  expect(screenOverlap({ displaySource: "tmux-calibrated", kind: "normal", pulledBack: null })).toBe(0);
});

test("SWITCHON H2: A,A in history and A,A,B on screen is four A rows, not two (no content equality)", () => {
  const pane = calibratedPane(["x", "A", "A"], ["A", "A", "B", ""], null);
  expect(screenOverlap(pane.view())).toBe(0);
  expect(liveLines(pane).filter((l) => l === "A")).toHaveLength(4);
  // Blank rows are no stronger evidence than text rows.
  const blank = calibratedPane(["x", ""], ["", "y"], null);
  expect(liveLines(blank)).toEqual(["x", "", "", "y"]);
});

// ── NEWARCH-SWITCHON P: frame-path cost without changing what a viewer sees ──
import { FRAME_BUDGET_SHARE, FrameBudget, trimStatsRing } from "../src/pipe-history-runtime";
import { decodeFrameCells, encodeFrameCells, validateFrame } from "../src/sqlite-history/ram-store";

/** fakePane plus issues and ring repairs (the surface snapshot reads). */
function issuePane(cols = 20, rows = 4) {
  const paneKey = { serverIdentity: "srv", paneId: "%8", birthGeneration: 1 };
  const row = (text: string) => parserRowCells([["default", "default", 0, text.padEnd(cols).slice(0, cols)]], cols);
  const ring: Array<{ lineId: number; sourceEpoch: number; geometryGeneration: number; cells: ReturnType<typeof row>; softWrap: boolean; ansi?: string }> = [];
  const issues: any[] = [];
  let next = 0, revision = 0;
  const pane: any = {
    paneKey, ringRepairs: 0,
    recentRows: () => ring,
    view: () => ({
      paneKey, session: "s", cells: Array.from({ length: rows }, (_, y) => row(`screen ${y}`)), cursor: null, kind: "normal", cols, rows,
      displaySource: "pipe", token: { paneKey, sourceEpoch: 1, geometryGeneration: 0, revision, durableRevision: revision, nextLineId: next },
      sourceEpoch: 1, geometryGeneration: 0, mouseSgr: false, mouseAny: false, degraded: issues.length > 0, issues,
    }),
    readRange: () => null,
  };
  return {
    pane: pane as PipeHistoryPane,
    append(n: number) { for (let i = 0; i < n; i++) { ring.push({ lineId: next, sourceEpoch: 1, geometryGeneration: 0, cells: row(`row ${next}`), softWrap: false }); next++; revision++; } },
    issue(lineId: number, kind = "gap") { issues.push({ kind, reason: kind, missingCount: null, boundaryLineId: lineId, revision: ++revision }); },
    repair(lineId: number, text: string) { const r = ring.find((x) => x.lineId === lineId)!; r.cells = row(text); r.ansi = undefined; pane.ringRepairs++; revision++; },
  };
}

test("SWITCHON P: every marker inside the live window reaches the frame, not only the newest 16", () => {
  const f = issuePane();
  f.append(3000);
  const window = new ProjectionLiveWindow(1000);
  const start = window.snapshot(f.pane, 1)!.boundary.liveStartLine;
  expect(start).toBe(2000);
  // 5 markers below the window, 30 inside it, all older than the newest 16 would reach.
  for (let i = 0; i < 5; i++) f.issue(100 + i);
  for (let i = 0; i < 30; i++) f.issue(start + 10 * i);
  f.append(1);
  const markers = window.snapshot(f.pane, 1)!.newarch.markers;
  const ids = markers.map((m) => m.lineId);
  // All 30 in-window markers, in store order; below-window ones only if among the newest 16 (none here).
  expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => start + 10 * i));
  // Below the window the newest 16 still ride along (the header warning) when they are the newest.
  const g = issuePane();
  g.append(3000);
  const w2 = new ProjectionLiveWindow(1000);
  w2.snapshot(g.pane, 1);
  for (let i = 0; i < 20; i++) g.issue(50 + i);
  const below = w2.snapshot(g.pane, 1)!.newarch.markers.map((m) => m.lineId);
  expect(below).toEqual(Array.from({ length: 16 }, (_, i) => 54 + i));
});

test("SWITCHON P: the cached live window text equals a fresh join through appends, repairs and window moves", () => {
  const f = issuePane();
  const cached = new ProjectionLiveWindow(50);
  const starts: number[] = [];
  for (let step = 0; step < 60; step++) {
    f.append(1 + (step % 7));
    if (step % 11 === 5) f.repair(Math.max(0, cached.snapshot(f.pane, 1)!.boundary.liveStartLine + 1), `fixed ${step}`);
    const got = cached.snapshot(f.pane, 1)!;
    starts.push(got.boundary.liveStartLine);
    const lines = got.content.split("\n");
    const history = lines.slice(0, -4);
    const ring = f.pane.recentRows().filter((r) => r.lineId >= got.boundary.liveStartLine);
    expect(history).toEqual(ring.map((r) => r.cells.map((c) => c.grapheme).join("").trimEnd()));
    expect(lines.slice(-4)).toEqual(["screen 0", "screen 1", "screen 2", "screen 3"]);
  }
  expect(new Set(starts).size).toBeGreaterThan(2);
});

test("SWITCHON P: the frame budget is idle below its share and busy above it (decayed, not cumulative)", () => {
  let now = 0;
  const budget = new FrameBudget(() => now);
  // 1 ms of frame work every 10 ms = 10% of the thread: never busy.
  for (let i = 0; i < 200; i++) { now += 10; budget.spend(1); }
  expect(budget.share()).toBeLessThan(FRAME_BUDGET_SHARE);
  expect(budget.busy()).toBe(false);
  // 5 ms every 10 ms = 50%: busy.
  for (let i = 0; i < 200; i++) { now += 10; budget.spend(5); }
  expect(budget.busy()).toBe(true);
  // Quiet again: the load decays, a later light pane is not throttled by old work.
  now += 2000;
  expect(budget.busy()).toBe(false);
});

test("SWITCHON P: statistics rings keep at most the newest samples and drop old stamps", () => {
  const limit = 1024;
  const values: number[] = [], times: number[] = [];
  for (let i = 0; i < 100_000; i++) { values.push(i); times.push(i); trimStatsRing(values, times, limit, -Infinity); }
  expect(values.length).toBeLessThanOrEqual(limit + (limit >> 2));
  expect(values.length).toBe(times.length);
  expect(values.at(-1)).toBe(99_999);
  // Age: every stamp older than the floor goes at the next age check.
  const stamps: number[] = [];
  for (let i = 0; i < 4096; i++) { stamps.push(i); trimStatsRing(stamps, stamps, 1_000_000, i - 100); }
  expect(stamps[0]).toBeGreaterThanOrEqual(4096 - 100 - 1024);
  expect(stamps.at(-1)).toBe(4095);
});

test("SWITCHON P: RAM frames round-trip through the compact row codec, and rle:1 frames still decode", () => {
  const cols = 12;
  const row = (runs: Array<[string, string, number, string]>) => parserRowCells(runs, cols);
  const cells = [
    row([["index:1", "default", 1, "bold"], ["rgb:1,2,3", "index:200", 0, " 漢😀"]]),
    row([["default", "default", 8 | 2, "hidden dim"]]),
    row([["default", "index:4", 0, "ไทย  "]]),
    new Array(cols).fill(BLANK_CELL),
  ];
  const frame = { paneKey: { serverIdentity: "s", paneId: "%1", birthGeneration: 1 }, sourceEpoch: 1, geometryGeneration: 0, receiveSeq: 1,
    cells, kind: "normal" as const, cols, rows: cells.length, cursor: { row: 0, col: 0, visible: true } };
  validateFrame(frame);
  const encoded = encodeFrameCells(cells);
  expect(JSON.parse(encoded).rle).toBe(2);
  expect(JSON.stringify(decodeFrameCells(encoded))).toBe(JSON.stringify(cells));
  // The same row objects encode to the same text (the per-row cache), and a new row is encoded anew.
  expect(encodeFrameCells(cells)).toBe(encoded);
  const changed = [cells[0]!, row([["default", "default", 0, "new"]]), cells[2]!, cells[3]!];
  expect(JSON.stringify(decodeFrameCells(encodeFrameCells(changed)))).toBe(JSON.stringify(changed));
  // A frame written before this change (legacy runs) is still readable.
  const legacy = JSON.stringify({ rle: 1, rows: [[[" ", 1, false, "default", "default", 0, cols]]] });
  expect(decodeFrameCells(legacy)[0]).toHaveLength(cols);
});
