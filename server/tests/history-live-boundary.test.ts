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

test("SWITCHON P: RAM frames encode each unchanged row once and still round-trip exactly", () => {
  const cols = 12;
  const row = (runs: Array<[string, string, number, string | string[]]>) => parserRowCells(runs, cols);
  const cells = [
    // Wide cells as the worker sends them: one entry per terminal cell, "" for the continuation.
    row([["red", "default", 1, "bold"], ["0a0b0c", "brightblue", 0, [" ", "漢", "", "😀", ""]]]),
    row([["default", "default", 8 | 2, "strike italics"]]),
    row([["default", "blue", 0, "ไทย  "]]),
    new Array(cols).fill(BLANK_CELL),
  ];
  const frame = { paneKey: { serverIdentity: "s", paneId: "%1", birthGeneration: 1 }, sourceEpoch: 1, geometryGeneration: 0, receiveSeq: 1,
    cells, kind: "normal" as const, cols, rows: cells.length, cursor: { row: 0, col: 0, visible: true } };
  validateFrame(frame);
  const encoded = encodeFrameCells(cells);
  // CANARY-FIX D: frames are written as `fc:2` (text + the durable row codec per row), never `rle:1`.
  expect(JSON.parse(encoded).fc).toBe(2);
  expect(JSON.parse(encoded).rle).toBeUndefined();
  expect(JSON.stringify(decodeFrameCells(encoded))).toBe(JSON.stringify(cells));
  // The same row objects encode to the same text (the per-row cache), and a new row is encoded anew.
  expect(encodeFrameCells(cells)).toBe(encoded);
  const changed = [cells[0]!, row([["default", "default", 0, "new"]]), cells[2]!, cells[3]!];
  expect(JSON.stringify(decodeFrameCells(encodeFrameCells(changed)))).toBe(JSON.stringify(changed));
  // Each row is stored as [text, cells] in the durable row codec: 12 blanks are one run and no text.
  expect(JSON.parse(encoded).rows[3]).toEqual(["", `${cols}||`]);
  // An `rle:1` frame an earlier release wrote still reads back cell for cell.
  const bold = row([["red", "default", 1, "bold"]]);
  const legacy = JSON.stringify({ rle: 1, rows: [
    [...[..."bold"].map((grapheme) => [grapheme, 1, false, "index:1", "default", 1, 1]), [" ", 1, false, "default", "default", 0, cols - 4]],
    [[" ", 1, false, "default", "default", 0, cols]],
  ] });
  expect(JSON.stringify(decodeFrameCells(legacy))).toBe(JSON.stringify([bold, cells[3]]));
  expect(() => decodeFrameCells(JSON.stringify({ fc: 3, rows: [] }))).toThrow("frame-codec-unknown");
});

import { PipeHistoryPane, PipeHistoryRuntime } from "../src/pipe-history-runtime";
test("CANARY-FIX M: a calibration snapshot stays as it was read across appends and ring eviction, without copying at read", async () => {
  const runtime = new PipeHistoryRuntime({ sharedParser: false, ringRows: 8, store: { token: () => { throw new Error("no pane"); } } as never });
  const pane = new PipeHistoryPane(runtime, {
    paneKey: { serverIdentity: "s", paneId: "%1", birthGeneration: 1 }, session: "s", calibrate: false,
    meta: { cols: 4, rows: 2, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 100, panePid: 1, mouseSgr: false, mouseAny: false },
    capture: async () => { throw new Error("unused"); },
  });
  try {
    const p = pane as unknown as { remember(row: unknown): void; read(): { recentHistory: { lineId: number }[]; recentLastLineId?: number | null } };
    const add = (lineId: number) => p.remember({ lineId, sourceEpoch: 1, geometryGeneration: 0, cells: [BLANK_CELL], softWrap: false });
    for (let id = 0; id < 10; id++) add(id);
    const snap = p.read();
    expect(snap.recentLastLineId).toBe(9);
    // 600 more rows: the ring passes 8 + 512 and evicts; the snapshot must not see any of it.
    for (let id = 10; id < 610; id++) add(id);
    expect(snap.recentHistory.map((r) => r.lineId)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(snap.recentHistory).toBe(snap.recentHistory);
    const now = p.read().recentHistory.map((r) => r.lineId);
    expect(now[0]).toBeGreaterThan(9);
    expect(now.at(-1)).toBe(609);
  } finally { await runtime.close?.(); }
});

test("CANARY-FIX M: a pipe frame reaches viewers only after its RAM receipt, and its receive latency closes then", async () => {
  let resolveWrite!: (receipt: unknown) => void; const writes: unknown[] = [];
  const store = {
    token: () => { throw new Error("no pane"); },
    replaceScreen: (frame: unknown) => { writes.push(frame); return new Promise((resolve) => { resolveWrite = resolve; }); },
  };
  const runtime = new PipeHistoryRuntime({ sharedParser: false, store: store as never });
  const pane = new PipeHistoryPane(runtime, {
    paneKey: { serverIdentity: "s", paneId: "%1", birthGeneration: 1 }, session: "s", calibrate: false,
    meta: { cols: 4, rows: 2, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 100, panePid: 1, mouseSgr: false, mouseAny: false },
    capture: async () => { throw new Error("unused"); },
  });
  try {
    const p = pane as unknown as { onFrame(event: unknown): void; receiveTimes: { seq: number; at: bigint }[]; received: number };
    const updates: string[] = []; pane.subscribe((u) => updates.push(u.source));
    p.received = 1; p.receiveTimes.push({ seq: 1, at: runtime.nowNs() });
    p.onFrame({ kind: "normal", receiveSeq: 1, sourceEpoch: 1, geometryGeneration: 0, cursor: { x: 1, y: 0, visible: true },
      cells: { cols: 4, rows: 2, full: true, shift: 0, dirty: { "0": [["default", "default", 0, "hi"]] } } });
    // Written to RAM at once, but nothing is shown and the chunk is still open until the receipt.
    expect(writes).toHaveLength(1);
    await Promise.resolve();
    expect(pane.view().displaySource).toBe("none");
    expect(updates).toEqual([]);
    expect(pane.pendingReceipts()).toBe(1);
    expect(pane.stats.latencyMs).toHaveLength(0);
    resolveWrite({ accepted: true, revision: 1, durableRevision: 0, nextLineId: 0 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(pane.view().displaySource).toBe("pipe");
    expect(updates).toEqual(["pipe"]);
    expect(pane.pendingReceipts()).toBe(0);
    expect(pane.stats.latencyMs).toHaveLength(1);
  } finally { await runtime.close(); }
});

// ── NEWARCH2 M3: row ownership — frozen shared rows, certified ids on the ring floor, one canonical row per capture row ──
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PipeHistoryPane as M3Pane, PipeHistoryRuntime as M3Runtime, applyFrameDelta, canonicalCaptureCells } from "../src/pipe-history-runtime";
import { TmuxCaptureDecoder } from "../src/tmux-capture-normalize";
// Namespace reads: on a runtime without the M3 surface only these tests fail, not the whole file.
import * as M3 from "../src/pipe-history-runtime";
import * as N3 from "../src/tmux-capture-normalize";
const { canonicalCaptureDecoder, decodeCanonicalCapture, pipeHistoryAllocations, sharedBlankRow } = M3 as any as {
  canonicalCaptureDecoder(cols: number): TmuxCaptureDecoder;
  decodeCanonicalCapture(decoder: TmuxCaptureDecoder, body: string): Array<Array<{ grapheme: string }>>;
  pipeHistoryAllocations(): Record<string, number>;
  sharedBlankRow(cols: number): typeof BLANK_CELL[];
};
const CACHE_BYTE_MODEL = (N3 as any).CACHE_BYTE_MODEL as Record<"slot" | "arrayHeader" | "object" | "stringHeader" | "char" | "mapEntry" | "setEntry", number>;

/** A real PipeHistoryPane (no parser, no calibrator timer) over a store double that assigns line ids. */
function m3Harness(opts: { ringRows?: number; cols?: number; rows?: number } = {}) {
  const cols = opts.cols ?? 12, rows = opts.rows ?? 2;
  const paneKey = { serverIdentity: "m3", paneId: "%3", birthGeneration: 1 };
  let next = 0, revision = 0, hold: Promise<void> | null = null, body = "";
  let meta = { cols, rows, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 100, panePid: 1, mouseSgr: false, mouseAny: false };
  const calibrations: any[] = [];
  const store = {
    token: () => ({ paneKey, sourceEpoch: 1, geometryGeneration: 0, revision, durableRevision: 0, nextLineId: next }),
    calibrate: async (input: unknown) => { calibrations.push(input); if (hold) await hold; return { revision: ++revision, durableRevision: 0, nextLineId: next }; },
    replaceScreen: async () => ({ accepted: true, revision: ++revision, durableRevision: 0, nextLineId: next }),
    recordIssue: async () => ({ revision }),
    health: () => ({ panes: [] }),
  };
  const runtime = new M3Runtime({ sharedParser: false, ringRows: opts.ringRows ?? 8, store: store as never });
  const pane = new M3Pane(runtime, {
    paneKey, session: "m3", calibrate: false, commitIntervalMs: 0, meta,
    capture: async () => ({ captureId: `c${revision}`, requestedAt: 0, completedAt: 0, before: meta, after: meta, body, tail: 0 }),
  });
  const p = pane as any;
  const row = (text: string, width = cols) => parserRowCells([["default", "default", 0, text.padEnd(width).slice(0, width)]], width);
  const h = {
    runtime, pane, p, calibrations, cols, row,
    async close() { await pane.close(); await runtime.close(); },
    add(n: number, sourceEpoch = 1, geometryGeneration = 0) {
      for (let i = 0; i < n; i++) { p.remember({ lineId: next, sourceEpoch, geometryGeneration, cells: row(`r${next}`), softWrap: false }); next++; revision++; }
    },
    certified: () => p.certified as Set<number>,
    setBody(value: string) { body = value; },
    setMeta(value: Partial<typeof meta>) { meta = { ...meta, ...value }; },
    hold(value: Promise<void> | null) { hold = value; },
    /** One calibration commit: a captured row per check id and per repaired id. */
    commit(checks: number[], repairs: Array<[number, string]> = []) {
      const history = [...checks.map((id) => ({ cells: row(`r${id}`), softWrap: false })), ...repairs.map(([, text]) => ({ cells: row(text), softWrap: false }))];
      const cmeta = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 0, cols, rows, kind: "normal" as const, cursor: { x: 0, y: 0, visible: true } };
      const capture = { paneKey, captureId: `k${revision}`, requestedAt: 0, completedAt: 0, before: cmeta, after: cmeta,
        frame: { cells: [], cursor: cmeta.cursor, kind: "normal", geometryGeneration: 0, receiveSeq: -1 }, history, completeRetainedTail: true, observedFields: [] };
      return p.commitCalibration({
        capture, expectedRevision: revision, captureEvidence: { kind: "unfenced", reason: "m3" }, contentMatches: [],
        checks: checks.map((lineId, capturedRow) => ({ lineId, capturedRow })),
        repairs: repairs.map(([lineId], i) => ({ lineId, capturedRow: checks.length + i, row: history[checks.length + i] })),
      });
    },
  };
  return h;
}
const m3Floor = (h: ReturnType<typeof m3Harness>) => h.pane.recentRows()[0]?.lineId ?? 0;

test("NEWARCH2 M3: certified ids follow the ring floor through append and eviction, and certified rows are never journaled twice", async () => {
  const h = m3Harness({ ringRows: 8 });
  try {
    let worst = 0, evictions = 0, lastFloor = 0;
    for (let step = 0; step < 150; step++) {
      h.add(20);
      await h.commit(h.pane.recentRows().slice(-20).map((r) => r.lineId));
      const ring = h.pane.recentRows(), certified = h.certified();
      if (m3Floor(h) !== lastFloor) { evictions++; lastFloor = m3Floor(h); }
      worst = Math.max(worst, certified.size - ring.length);
      // The bound: never more ids than ring rows, none below the floor.
      expect(certified.size).toBeLessThanOrEqual(ring.length);
      for (const id of certified) expect(id).toBeGreaterThanOrEqual(m3Floor(h));
    }
    expect(evictions).toBeGreaterThan(4);
    // Every row still in the ring that was committed stays certified: a second commit of them writes nothing.
    const inRing = h.pane.recentRows().map((r) => r.lineId).filter((id) => h.certified().has(id));
    expect(inRing.length).toBeGreaterThan(0);
    const writes = h.calibrations.length;
    await h.commit(inRing);
    expect(h.calibrations.length).toBe(writes);
    // Rows evicted while the store commits are not kept either.
    let release!: () => void; h.hold(new Promise<void>((resolve) => { release = resolve; }));
    const pending = h.commit(h.pane.recentRows().slice(-5).map((r) => r.lineId));
    const heldIds = h.calibrations.at(-1).checks.map((c: { lineId: number }) => c.lineId);
    h.add(600);
    release(); h.hold(null); await pending;
    for (const id of heldIds) expect(h.certified().has(id)).toBe(false);
    expect(h.certified().size).toBeLessThanOrEqual(h.pane.recentRows().length);
    console.log("NEWARCH2_M3_CERTIFIED", JSON.stringify({ steps: 150, rows: 3000 + 600, evictions, worstExcessOverRing: worst, ring: h.pane.recentRows().length, certified: h.certified().size }));
  } finally { await h.close(); }
});

test("NEWARCH2 M3: a calibration snapshot keeps its rows across append, eviction and a repair; ring rows are frozen", async () => {
  const h = m3Harness({ ringRows: 8 });
  try {
    h.add(10);
    const snap = h.p.read();
    const original = h.pane.recentRows().map((r) => r.cells);
    expect(h.pane.recentRows().every((r) => Object.isFrozen(r))).toBe(true);
    // Repair line 3 before the snapshot is first read (its copy is lazy).
    await h.commit([], [[3, "fixed"]]);
    expect(snap.recentHistory.map((r: { cells: unknown }) => r.cells)).toEqual(original);
    expect(snap.recentHistory[3].cells).toBe(original[3]);
    expect(h.pane.recentRows()[3]!.cells.map((c) => c.grapheme).join("").trimEnd()).toBe("fixed");
    expect(Object.isFrozen(h.pane.recentRows()[3])).toBe(true);
    expect(h.p.ringRepairs).toBe(1);
    // A snapshot across a repair and an eviction: still the rows it was read with.
    const snap2 = h.p.read();
    await h.commit([], [[5, "again"]]);
    h.add(600);
    expect(snap2.recentHistory.map((r: { lineId: number }) => r.lineId)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(snap2.recentHistory[5].cells).toBe(original[5]);
    expect(snap2.recentHistory[3].cells.map((c: { grapheme: string }) => c.grapheme).join("").trimEnd()).toBe("fixed");
    // The live window shows the repaired text (the ANSI cache follows the row's cells).
    h.p.onFrame({ kind: "normal", receiveSeq: 0, sourceEpoch: 1, geometryGeneration: 0, cursor: { x: 0, y: 0, visible: true },
      cells: { cols: h.cols, rows: 2, full: true, shift: 0, dirty: { "0": [["default", "default", 0, "screen"]] } } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const g = m3Harness({ ringRows: 8 });
    g.add(4); await g.commit([], [[2, "repaired"]]);
    g.p.onFrame({ kind: "normal", receiveSeq: 0, sourceEpoch: 1, geometryGeneration: 0, cursor: { x: 0, y: 0, visible: true },
      cells: { cols: g.cols, rows: 2, full: true, shift: 0, dirty: { "0": [["default", "default", 0, "screen"]] } } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const content = new ProjectionLiveWindow(100).snapshot(g.pane, 1)!.content.split("\n");
    expect(content.slice(0, 4)).toEqual(["r0", "r1", "repaired", "r3"]);
    await g.close();
  } finally { await h.close(); }
});

test("NEWARCH2 M3: blank rows share one frozen array per width; unicode, style and colour rows are converted as before", () => {
  const before = pipeHistoryAllocations();
  const a = parserRowCells([["default", "default", 0, " ".repeat(12)]], 12);
  const b = parserRowCells([["default", "default", 0, [" ", " "]], ["default", "default", 0, " ".repeat(10)]]);
  const empty = parserRowCells([], 12);
  expect(a).toBe(b); expect(a).toBe(empty); expect(a).toBe(sharedBlankRow(12));
  expect(Object.isFrozen(a)).toBe(true);
  expect(a).toEqual(new Array(12).fill(BLANK_CELL));
  expect(sharedBlankRow(20)).not.toBe(a); expect(sharedBlankRow(20)).toHaveLength(20);
  // Blank-looking rows that carry a style or a colour are not blank.
  const bold = parserRowCells([["default", "default", 1, "  "]], 12);
  expect(bold).not.toBe(a); expect(bold[0]!.style).toBe(1); expect(bold[5]).toBe(BLANK_CELL);
  expect(parserRowCells([["default", "red", 0, "  "]], 12)[0]!.bg).toBe("index:1");
  expect(parserRowCells([["default", "default", 0, "  x"]], 12)).not.toBe(a);
  // Wide, continuation, combining and Thai cells.
  const wide = parserRowCells([["default", "default", 0, ["漢", "", "é", "ไ", "ท", "ย"]], ["0a0b0c", "default", 2, "i"]], 8);
  expect(wide.map((c) => [c.grapheme, c.width, c.continuation])).toEqual([["漢", 2, false], ["", 0, true], ["é", 1, false], ["ไ", 1, false], ["ท", 1, false], ["ย", 1, false], ["i", 1, false], [" ", 1, false]]);
  expect(wide[6]!.fg).toBe("rgb:10,11,12"); expect(wide[6]!.style).toBe(4); expect(wide[7]).toBe(BLANK_CELL);
  const after = pipeHistoryAllocations();
  // Four non-blank rows took arrays; the blank ones took none.
  expect(after.parserRowArrays - before.parserRowArrays).toBe(4);
  // Frame assembly: new and shifted-in blank rows are the shared row; a resize moves to that width's row.
  const s0 = applyFrameDelta(undefined, { cols: 12, rows: 3, full: true, shift: 0, dirty: { "0": [["default", "default", 0, "top"]] } } as never).screen;
  expect(s0.cells[1]).toBe(a); expect(s0.cells[2]).toBe(a);
  const s1 = applyFrameDelta(s0, { cols: 12, rows: 3, full: false, shift: 1, dirty: {} } as never).screen;
  expect(s1.cells[0]).toBe(a); expect(s1.cells[2]).toBe(a);
  const s2 = applyFrameDelta(s1, { cols: 20, rows: 2, full: false, shift: 0, dirty: {} } as never).screen;
  expect(s2.cells[0]).toBe(sharedBlankRow(20));
});

test("NEWARCH2 M3: a capture row is decoded to one canonical array (the memo's), equal to the two-step path for unicode/style/blank", async () => {
  const cols = 24;
  const body = [
    "\x1b[38;5;196mpalette\x1b[0m plain", "\x1b[1;2mbold dim\x1b[0m 漢字 ไทย", "", "   ",
    "\x1b[48;2;1;2;3mrgb\x1b[0m", "flag 🇹🇭🇯🇵 row", "\x1b[31mred", "still red\x1b[0m", "é combining", "\x1b[7;9mrev strike\x1b[0m",
  ].join("\n") + "\n";
  const plain = new TmuxCaptureDecoder(cols);
  const reference = plain.decode(body).map((r) => canonicalCaptureCells(r as never, cols));
  const decoder = canonicalCaptureDecoder(cols);
  const before = pipeHistoryAllocations();
  const first = decodeCanonicalCapture(decoder, body), second = decodeCanonicalCapture(decoder, body);
  const after = pipeHistoryAllocations();
  expect(JSON.stringify(first)).toBe(JSON.stringify(reference));
  expect(JSON.stringify(second)).toBe(JSON.stringify(reference));
  expect(decoder.uncertainRows).toEqual(plain.uncertainRows);
  expect(plain.uncertainRows.length).toBeGreaterThan(0);
  // Same interned cells as the two-step path (identity comparisons such as sameScreen still hold).
  first.forEach((row, y) => row.forEach((cell, x) => expect(cell).toBe(reference[y]![x]!)));
  // No second array per row; a memo hit is the same row.
  expect(after.canonicalRowArrays - before.canonicalRowArrays).toBe(0);
  expect(after.canonicalRowsShared - before.canonicalRowsShared).toBe(2 * first.length);
  expect(second[0]).toBe(first[0]);
  // Through the pane's capture port: the capture frame's rows are the decoder memo's rows.
  const h = m3Harness({ cols, rows: 3 });
  try {
    h.add(1);
    h.setBody(body);
    const capture = await h.p.capture(0, new AbortController().signal);
    const memoRows = new Set([...h.p.decoder.cache.values()].map((e: { cells: unknown }) => e.cells));
    expect(capture.frame.cells.length).toBe(3);
    for (const row of [...capture.frame.cells, ...capture.history.map((r: { cells: unknown }) => r.cells)]) {
      if (!h.p.decoder.uncertainRows.length || row !== capture.history[5]?.cells) expect(memoRows.has(row) || row === capture.history[5]?.cells).toBe(true);
    }
    expect(JSON.stringify([...capture.history.map((r: { cells: unknown }) => r.cells), ...capture.frame.cells])).toBe(JSON.stringify(reference));
    console.log("NEWARCH2_M3_CANONICAL", JSON.stringify({ rows: first.length, canonicalArraysBefore: reference.length, canonicalArraysAfter: after.canonicalRowArrays - before.canonicalRowArrays }));
  } finally { await h.close(); }
});

test("NEWARCH2 M3: epoch and resize keep the ring floor rule, and a width change replaces the decoder with rows of the new width", async () => {
  const h = m3Harness({ ringRows: 8, cols: 12, rows: 2 });
  try {
    h.add(300, 1, 0);
    await h.commit(h.pane.recentRows().slice(-40).map((r) => r.lineId));
    h.add(300, 2, 1);
    await h.commit(h.pane.recentRows().slice(-40).map((r) => r.lineId));
    for (const id of h.certified()) expect(id).toBeGreaterThanOrEqual(m3Floor(h));
    expect(h.certified().size).toBeLessThanOrEqual(h.pane.recentRows().length);
    expect(new Set(h.pane.recentRows().map((r) => r.sourceEpoch))).toEqual(new Set([2]));
    h.setBody("a\nb\n\n");
    await h.p.capture(0, new AbortController().signal);
    expect(h.p.decoder.cols).toBe(12);
    const narrow = h.p.decoder;
    h.setMeta({ cols: 20 });
    h.setBody("wide row\n\n\n");
    const capture = await h.p.capture(0, new AbortController().signal);
    expect(h.p.decoder).not.toBe(narrow);
    expect(h.p.decoder.cols).toBe(20);
    expect(capture.frame.cells.every((r: unknown[]) => r.length === 20)).toBe(true);
    const stats = h.pane.memoryStats();
    expect(stats.decoder!.cellSlots % 20).toBe(0);
    expect(stats.decoder!.entries).toBeGreaterThan(0);
  } finally { await h.close(); }
});

test("NEWARCH2 M3: memoryStats counts ring, certified and memo bytes by the explicit model; shared rows once", async () => {
  const h = m3Harness({ ringRows: 100, cols: 10 });
  try {
    expect(h.pane.memoryStats()).toEqual({ ring: { rows: 0, rowArrays: 0, sharedRows: 0, cellSlots: 0, ansiRows: 0, ansiChars: 0, floor: null, bytes: CACHE_BYTE_MODEL.arrayHeader }, certified: { ids: 0, bytes: 0 }, decoder: null, bytes: CACHE_BYTE_MODEL.arrayHeader });
    h.add(5);
    for (let i = 0; i < 3; i++) h.p.remember({ lineId: 5 + i, sourceEpoch: 1, geometryGeneration: 0, cells: parserRowCells([], 10), softWrap: false });
    await h.commit([0, 1, 2]);
    const m = CACHE_BYTE_MODEL, s = h.pane.memoryStats();
    expect(s.ring).toMatchObject({ rows: 8, rowArrays: 6, sharedRows: 2, cellSlots: 60, floor: 0 });
    expect(s.ring.bytes).toBe(m.arrayHeader + 8 * (m.slot + m.object) + 6 * m.arrayHeader + 60 * m.slot + s.ring.ansiRows * m.stringHeader + s.ring.ansiChars * m.char);
    expect(s.certified).toEqual({ ids: 3, bytes: 3 * m.setEntry });
    h.setBody("abc\n\x1b[31mred\x1b[0m\n");
    await h.p.capture(0, new AbortController().signal);
    const d = h.pane.memoryStats().decoder!;
    expect(d.entries).toBe(2); expect(d.cellSlots).toBe(20);
    expect(d.bytes).toBe(2 * (m.mapEntry + m.object + m.arrayHeader + m.stringHeader) + 20 * m.slot + d.keyChars * m.char);
    expect(h.pane.memoryStats().bytes).toBe(h.pane.memoryStats().ring.bytes + 3 * m.setEntry + d.bytes);
  } finally { await h.close(); }
});

test("NEWARCH2 M3: attach-close churn leaves no per-pane state behind and allocates no canonical copies", async () => {
  const before = pipeHistoryAllocations();
  const excess: number[] = [];
  for (let cycle = 0; cycle < 40; cycle++) {
    const h = m3Harness({ ringRows: 8, cols: 10 + (cycle % 5) });
    try {
      expect(h.pane.memoryStats().bytes).toBe(CACHE_BYTE_MODEL.arrayHeader);
      h.add(560);
      await h.commit(h.pane.recentRows().slice(-8).map((r) => r.lineId));
      h.setBody(`cycle ${cycle}\n\x1b[32mgreen\x1b[0m\n\n`);
      await h.p.capture(0, new AbortController().signal);
      h.p.onFrame({ kind: "normal", receiveSeq: 0, sourceEpoch: 1, geometryGeneration: 0, cursor: { x: 0, y: 0, visible: true },
        cells: { cols: h.cols, rows: 2, full: true, shift: 0, dirty: { "0": [["default", "default", 0, `c${cycle}`]] } } });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      excess.push(h.certified().size - h.pane.recentRows().length);
    } finally { await h.close(); }
  }
  const after = pipeHistoryAllocations();
  expect(Math.max(...excess)).toBeLessThanOrEqual(0);
  expect(after.canonicalRowArrays - before.canonicalRowArrays).toBe(0);
  expect(after.blankRowWidths).toBeLessThanOrEqual(64);
  console.log("NEWARCH2_M3_CHURN", JSON.stringify({ cycles: 40, maxCertifiedExcess: Math.max(...excess), canonicalArrays: after.canonicalRowArrays - before.canonicalRowArrays, blankWidths: after.blankRowWidths }));
});

test("NEWARCH2 M3 mutation controls: threshold pruning, in-place repair, canonical copy and fresh blank rows each fail", () => {
  const root = mkdtempSync(join(tmpdir(), "m3-mutation-"));
  const src = new URL("../src/", import.meta.url).pathname;
  const prelude = `import assert from 'node:assert/strict';
const R = await import('./subject.ts');
const key = { serverIdentity: 'm', paneId: '%1', birthGeneration: 1 };
let next = 0, rev = 0;
const store = { token: () => ({ paneKey: key, sourceEpoch: 1, geometryGeneration: 0, revision: rev, durableRevision: 0, nextLineId: next }),
  calibrate: async () => ({ revision: ++rev, durableRevision: 0, nextLineId: next }), recordIssue: async () => ({ revision: rev }) };
const meta = { cols: 6, rows: 2, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 100, panePid: 1, mouseSgr: false, mouseAny: false };
const runtime = new R.PipeHistoryRuntime({ sharedParser: false, ringRows: 8, store });
const pane = new R.PipeHistoryPane(runtime, { paneKey: key, session: 'm', calibrate: false, commitIntervalMs: 0, meta, capture: async () => { throw new Error('unused'); } });
const row = t => R.parserRowCells([['default', 'default', 0, t.padEnd(6)]], 6);
const add = n => { for (let i = 0; i < n; i++) { pane.remember({ lineId: next, sourceEpoch: 1, geometryGeneration: 0, cells: row('r' + next), softWrap: false }); next++; rev++; } };
const cm = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 0, cols: 6, rows: 2, kind: 'normal', cursor: { x: 0, y: 0, visible: true } };
const commit = (checks, repairs = []) => { const history = [...checks.map(id => ({ cells: row('r' + id), softWrap: false })), ...repairs.map(([, t]) => ({ cells: row(t), softWrap: false }))];
  return pane.commitCalibration({ capture: { paneKey: key, captureId: 'k', requestedAt: 0, completedAt: 0, before: cm, after: cm, frame: { cells: [], cursor: cm.cursor, kind: 'normal', geometryGeneration: 0, receiveSeq: -1 }, history, completeRetainedTail: true, observedFields: [] },
    expectedRevision: rev, captureEvidence: { kind: 'unfenced', reason: 'm' }, contentMatches: [], checks: checks.map((lineId, capturedRow) => ({ lineId, capturedRow })),
    repairs: repairs.map(([lineId], i) => ({ lineId, capturedRow: checks.length + i, row: history[checks.length + i] })) }); };
`;
  const cases = [
    { name: "certified-threshold", from: "for (const id of this.certified) if (id < floor) this.certified.delete(id);",
      to: "if (this.certified.size > 20_000) for (const id of this.certified) if (id < floor) this.certified.delete(id);",
      body: `for (let s = 0; s < 40; s++) { add(20); await commit(pane.recentRows().slice(-20).map(r => r.lineId)); }
assert.ok(pane.certified.size <= pane.recentRows().length, 'MUTATION certified ' + pane.certified.size + ' ids over a ring of ' + pane.recentRows().length);` },
    { name: "repair-in-place", from: "this.ring = this.ring.map(row => {\n          const cells = byId.get(row.lineId);\n          return cells ? Object.freeze({ ...row, cells }) : row;\n        });",
      to: "for (let i = 0; i < this.ring.length; i++) { const cells = byId.get(this.ring[i].lineId); if (cells) this.ring[i] = Object.freeze({ ...this.ring[i], cells }); }",
      body: `add(10); const snap = pane.read(); const old = pane.recentRows()[3].cells; await commit([], [[3, 'fixed']]);
assert.equal(snap.recentHistory[3].cells, old, 'MUTATION repair changed a snapshot read before it');` },
    { name: "canonical-copy", from: "return new TmuxCaptureDecoder(cols, undefined, undefined, canonicalCell);", to: "return new TmuxCaptureDecoder(cols);",
      body: `const d = R.canonicalCaptureDecoder(6); const a = R.pipeHistoryAllocations().canonicalRowArrays; R.decodeCanonicalCapture(d, 'ab\\n\\x1b[31mc\\x1b[0m\\n');
assert.equal(R.pipeHistoryAllocations().canonicalRowArrays - a, 0, 'MUTATION capture rows copied into second canonical arrays');` },
    { name: "fresh-blank-rows", from: "if (row.every(isBlankRun)) {", to: "if (false) {",
      body: `assert.equal(R.parserRowCells([['default', 'default', 0, '      ']], 6), R.parserRowCells([], 6), 'MUTATION blank rows are separate arrays');` },
  ];
  try {
    const original = readFileSync(new URL("../src/pipe-history-runtime.ts", import.meta.url), "utf8").replaceAll("from './", `from '${src}`);
    for (const item of cases) {
      expect(original.split(item.from)).toHaveLength(2);
      writeFileSync(join(root, "runner.ts"), prelude + item.body + "\nawait runtime.close();\n");
      for (const mutated of [false, true]) {
        writeFileSync(join(root, "subject.ts"), mutated ? original.replace(item.from, item.to) : original);
        const result = spawnSync(process.execPath, [join(root, "runner.ts")], { encoding: "utf8", timeout: 20000 });
        console.log("NEWARCH2_M3_MUTATION", JSON.stringify({ name: item.name, mutated, exit: result.status, stderr: result.stderr.slice(0, 300) }));
        expect(result.status).toBe(mutated ? 1 : 0);
        if (mutated) expect(result.stderr).toContain("MUTATION");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
