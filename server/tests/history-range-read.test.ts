import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxClientMessage, SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive } from "../src/history-archive";
import { NewarchV2Display, StreamDisplayEngine } from "../src/display-engine";
import type { NewarchGap, NewarchHistoryExtension, NewarchV2HistoryCursor, NewarchV2HistoryRequest, NewarchV2Incident, NewarchV2PaneDescriptor } from "../../core/src/protocol";
import { STREAM_BUDGET, type CaptureEngine, type CommittedStreamRow, type HistoryEngine, type HistoryPage, type LiveFrame, type ReadView, type StreamIdentity, type V2HistoryPage, type V2HistoryReader, type V2SessionOwnerRecord, type ViewerRoute } from "../src/stream-contract";
import type { HistoryArchiveLike, TmuxDriver } from "../src/ws-mux";
// D3 mutation controls re-run this file against a mutant sibling module
// written only inside the cage's copy (never the worktree, never HEAD).
const { TmuxWsMux } = (await import(process.env.D3_MUTANT_WS_MUX ?? "../src/ws-mux")) as typeof import("../src/ws-mux");
type TmuxWsMux = InstanceType<typeof TmuxWsMux>;

const SESSION = "range-read";

class FakeWS {
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  historyPages(): Array<{ lines: string[]; startLine: number | null; hasMore: boolean }> {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.channel === SESSION && frame.type === "history")
      .map((frame) => JSON.parse(frame.data));
  }

  historyErrors(): Array<{
    channel: string;
    type: string;
    data: string;
    code: string;
    request: string;
    retryable: boolean;
  }> {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => (
        frame.channel === SESSION &&
        frame.type === "error" &&
        frame.request === "history_expand"
      ));
  }
}

function sessionListItem(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

function fakeDriver(): TmuxDriver {
  return {
    listSessions: () => [sessionListItem(SESSION)],
    capturePane: async () => "",
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, 0]]),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
}

function generatedLine(sequence: number): string {
  const checksum = Math.imul(sequence + 17, 2_654_435_761) >>> 0;
  return JSON.stringify({ sequence, checksum: checksum.toString(16).padStart(8, "0") });
}

test("history_expand afterLine reads the requested middle range from a real archive", () => {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-range-read-test-"));
  const written = Array.from({ length: 1_200 }, (_, sequence) => generatedLine(sequence));
  const archive = new FileHistoryArchive({ root, maxLines: written.length });
  const mux = new TmuxWsMux({ driver: fakeDriver(), archive });
  const ws = new FakeWS();

  try {
    archive.ingestSnapshot(SESSION, written.join("\n"), {
      previousContent: null,
      fullHistory: true,
      liveLineLimit: 100,
    });

    const afterLine = 249;
    const limit = 500;
    const request: MuxClientMessage = {
      type: "history_expand",
      session: SESSION,
      afterLine,
      limit,
    };
    mux.handleMessage(request, ws);

    const result = ws.historyPages().at(-1)!;
    const returnedSequences = result.lines.map((line) => JSON.parse(line).sequence as number);
    expect(result.startLine).toBe(afterLine + 1);
    expect(result.lines).toEqual(written.slice(afterLine + 1, afterLine + 1 + limit));
    expect(returnedSequences).toEqual(
      Array.from({ length: limit }, (_, offset) => result.startLine! + offset),
    );
    expect(result.hasMore).toBe(true);

    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      afterLine: null,
      limit: 3,
    }, ws);
    expect(ws.historyPages().at(-1)).toEqual({
      lines: written.slice(0, 3),
      startLine: 0,
      hasMore: true,
    });

    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      beforeLine: 1_100,
      afterLine: 9,
      limit: 3,
    }, ws);
    expect(ws.historyPages().at(-1)).toEqual({
      lines: written.slice(10, 13),
      startLine: 10,
      hasMore: true,
    });

    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      afterLine: 1_097,
      limit: 10,
    }, ws);
    expect(ws.historyPages().at(-1)).toEqual({
      lines: written.slice(1_098, 1_100),
      startLine: 1_098,
      hasMore: false,
    });

    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      afterLine: 1_099,
      limit: 10,
    }, ws);
    expect(ws.historyPages().at(-1)).toEqual({ lines: [], startLine: null, hasMore: false });
  } finally {
    mux.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy archives return an empty forward page while beforeLine clients stay unchanged", () => {
  const beforeCalls: Array<{ session: string; beforeLine: number | null; limit?: number }> = [];
  const legacyPage = { lines: ["legacy-row"], startLine: 41, hasMore: true };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, content) => ({ liveContent: content }),
    readBefore: (session, beforeLine, limit) => {
      beforeCalls.push({ session, beforeLine, limit });
      return legacyPage;
    },
    renameSession: () => {},
  };
  const mux = new TmuxWsMux({ driver: fakeDriver(), archive });
  const noArchiveMux = new TmuxWsMux({ driver: fakeDriver() });
  const ws = new FakeWS();
  const noArchiveWs = new FakeWS();

  try {
    const forwardRequest: MuxClientMessage = {
      type: "history_expand",
      session: SESSION,
      afterLine: 41,
      limit: 2,
    };
    mux.handleMessage(forwardRequest, ws);
    noArchiveMux.handleMessage(forwardRequest, noArchiveWs);
    expect(ws.historyPages().at(-1)).toEqual({ lines: [], startLine: null, hasMore: false });
    expect(ws.sent.at(-1)).toBe(noArchiveWs.sent.at(-1));
    expect(beforeCalls).toEqual([]);

    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      beforeLine: 42,
      limit: 7,
    }, ws);
    expect(ws.historyPages().at(-1)).toEqual(legacyPage);
    expect(ws.sent.at(-1)).toBe(JSON.stringify({
      channel: SESSION,
      type: "history",
      data: JSON.stringify(legacyPage),
    }));
    expect(beforeCalls).toEqual([{ session: SESSION, beforeLine: 42, limit: 7 }]);
  } finally {
    mux.stop();
    noArchiveMux.stop();
  }
});

test("a beforeLine-only client still selects readBefore when both archive directions exist", () => {
  const calls: string[] = [];
  const backwardPage = { lines: ["backward"], startLine: 12, hasMore: false };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, content) => ({ liveContent: content }),
    readBefore: () => {
      calls.push("before");
      return backwardPage;
    },
    readAfter: () => {
      calls.push("after");
      return { lines: ["forward"], startLine: 14, hasMore: false };
    },
    renameSession: () => {},
  };
  const mux = new TmuxWsMux({ driver: fakeDriver(), archive });
  const ws = new FakeWS();

  try {
    mux.handleMessage({
      type: "history_expand",
      session: SESSION,
      beforeLine: 13,
      limit: 1,
    }, ws);

    expect(calls).toEqual(["before"]);
    expect(ws.sent).toEqual([JSON.stringify({
      channel: SESSION,
      type: "history",
      data: JSON.stringify(backwardPage),
    })]);
  } finally {
    mux.stop();
  }
});

test("a throwing readAfter returns one retryable non-sensitive error instead of archive EOF", () => {
  const logs: unknown[][] = [];
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, content) => ({ liveContent: content }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    readAfter: () => {
      throw new Error("readAfter exploded");
    },
    renameSession: () => {},
  };
  const mux = new TmuxWsMux({
    driver: fakeDriver(),
    archive,
    logError: (...args: unknown[]) => { logs.push(args); },
  });
  const ws = new FakeWS();
  const request: MuxClientMessage = {
    type: "history_expand",
    session: SESSION,
    afterLine: 41,
    limit: 2,
  };
  let thrown: unknown;

  try {
    try {
      mux.handleMessage(request, ws);
    } catch (error) {
      thrown = error;
    }
    expect(ws.historyPages()).toEqual([]);
    expect(ws.historyErrors()).toEqual([{
      channel: SESSION,
      type: "error",
      data: "history_temporarily_unavailable",
      code: "history_temporarily_unavailable",
      request: "history_expand",
      retryable: true,
    }]);
    expect(ws.sent[0]).not.toContain("readAfter exploded");
    expect(thrown).toBeUndefined();
    expect(logs).toEqual([[
      `[thumbmux-mux] archive readAfter error for "${SESSION}":`,
      "readAfter exploded",
    ]]);
  } finally {
    mux.stop();
  }
});

test("a throwing readBefore returns one retryable non-sensitive error instead of archive EOF", () => {
  const logs: unknown[][] = [];
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, content) => ({ liveContent: content }),
    readBefore: () => {
      throw new Error("readBefore exploded");
    },
    readAfter: () => ({ lines: [], startLine: null, hasMore: false }),
    renameSession: () => {},
  };
  const mux = new TmuxWsMux({
    driver: fakeDriver(),
    archive,
    logError: (...args: unknown[]) => { logs.push(args); },
  });
  const ws = new FakeWS();
  const request: MuxClientMessage = {
    type: "history_expand",
    session: SESSION,
    beforeLine: 42,
    limit: 7,
  };
  let thrown: unknown;

  try {
    try {
      mux.handleMessage(request, ws);
    } catch (error) {
      thrown = error;
    }
    expect(ws.historyPages()).toEqual([]);
    expect(ws.historyErrors()).toEqual([{
      channel: SESSION,
      type: "error",
      data: "history_temporarily_unavailable",
      code: "history_temporarily_unavailable",
      request: "history_expand",
      retryable: true,
    }]);
    expect(ws.sent[0]).not.toContain("readBefore exploded");
    expect(thrown).toBeUndefined();
    expect(logs).toEqual([[
      `[thumbmux-mux] archive readBefore error for "${SESSION}":`,
      "readBefore exploded",
    ]]);
  } finally {
    mux.stop();
  }
});

for (const direction of ["before", "after"] as const) {
  const method = direction === "before" ? "readBefore" : "readAfter";

  test(`a throwing ${method} and throwing logger still produce exactly one retryable error frame`, () => {
    let archiveCalls = 0;
    const logs: unknown[][] = [];
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, content) => ({ liveContent: content }),
      readBefore: () => {
        if (direction === "before") {
          archiveCalls += 1;
          throw new Error("readBefore exploded");
        }
        return { lines: [], startLine: null, hasMore: false };
      },
      readAfter: () => {
        if (direction === "after") {
          archiveCalls += 1;
          throw new Error("readAfter exploded");
        }
        return { lines: [], startLine: null, hasMore: false };
      },
      renameSession: () => {},
    };
    const mux = new TmuxWsMux({
      driver: fakeDriver(),
      archive,
      logError: (...args: unknown[]) => {
        logs.push(args);
        throw new Error("error logger exploded");
      },
    });
    const ws = new FakeWS();
    const request: MuxClientMessage = direction === "after"
      ? { type: "history_expand", session: SESSION, afterLine: 41, limit: 2 }
      : { type: "history_expand", session: SESSION, beforeLine: 42, limit: 7 };
    let thrown: unknown;

    try {
      try {
        mux.handleMessage(request, ws);
      } catch (error) {
        thrown = error;
      }

      expect(archiveCalls).toBe(1);
      expect(logs).toEqual([[
        `[thumbmux-mux] archive ${method} error for "${SESSION}":`,
        `${method} exploded`,
      ]]);
      expect(ws.sent).toHaveLength(1);
      expect(ws.historyPages()).toEqual([]);
      expect(ws.historyErrors()).toEqual([{
        channel: SESSION,
        type: "error",
        data: "history_temporarily_unavailable",
        code: "history_temporarily_unavailable",
        request: "history_expand",
        retryable: true,
      }]);
      expect(ws.sent[0]).not.toContain(`${method} exploded`);
      expect(thrown).toBeUndefined();
    } finally {
      mux.stop();
    }
  });
}

// ── NEWARCH stream-first lot D: bounded immutable display reads ────────────

const DISPLAY_PANE = { serverIdentity: "display-server", paneId: "%21", birthGeneration: 1 } as const;

function displayIdentity(sourceEpoch = 1, geometryGeneration = 1): StreamIdentity {
  return { pane: DISPLAY_PANE, sourceEpoch, geometryGeneration };
}

function displayFrame(identity = displayIdentity(), revision = 1): LiveFrame {
  return {
    identity, revision, durableRevision: revision, head: 1, screenRevision: revision,
    buffer: "normal", geometry: { columns: 80, rows: 24 }, cursor: { x: 0, y: 0, visible: true },
    overlap: null,
    changedRows: [{
      y: 0,
      content: { cells: [{ text: `frame-${revision}`, width: 1, style: [] }], softWrap: false, wrapPad: 0, uncertainFields: [] },
    }],
  };
}

function displayRoute(viewerId: string, routeGeneration = 1): ViewerRoute {
  return { viewerId, identity: displayIdentity(), routeGeneration };
}

function displayView(route: ViewerRoute, requestId: string, lineId: number): ReadView {
  return {
    requestId, identity: route.identity, routeGeneration: route.routeGeneration,
    range: { start: lineId, end: lineId + 1 }, deadlineMonoMs: performance.now() + 1_000,
    grantRevision: lineId + 1, durableAtGrant: lineId + 1, headAtGrant: lineId + 1,
    overlayHandle: `overlay-${requestId}`,
  };
}

function displayPage(view: ReadView, text: string): HistoryPage {
  const row = {
    id: { pane: view.identity.pane, lineId: view.range.start }, revision: view.grantRevision,
    source: { pane: view.identity.pane, sourceEpoch: view.identity.sourceEpoch, packetSeq: view.range.start + 1, scrollOrdinal: 0 },
    geometryGeneration: view.identity.geometryGeneration, geometry: { columns: 80, rows: 24 },
    cells: [{ text, width: 1 as const, style: [] }], softWrap: false, wrapPad: 0, uncertainFields: [],
  };
  return {
    view, fragments: [{ row, startCell: 0, endCell: 1, complete: true }], payloadBytes: Buffer.byteLength(text),
    nextBefore: null, nextAfter: null, hasMoreBefore: false, hasMoreAfter: false,
  };
}

function displayHarness() {
  const listeners = new Set<(frame: LiveFrame) => void>();
  const released: Array<{ requestId: string; reason: string }> = [];
  const readLines: number[] = [];
  const capture = {
    subscribe: (_pane, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as Pick<CaptureEngine, "subscribe"> as CaptureEngine;
  const history = {
    grantReadView: async request => ({ status: "ok", value: {
      ...request, grantRevision: request.range.end, durableAtGrant: request.range.end,
      headAtGrant: request.range.end, overlayHandle: `overlay-${request.requestId}`,
    } }),
    openReadView: async view => ({ status: "ok", value: {
      view, diskSnapshotRevision: view.durableAtGrant, snapshotHandle: `snapshot-${view.requestId}`,
    } }),
    readPage: async ack => {
      readLines.push(ack.view.range.start);
      return { status: "ok", value: displayPage(ack.view, `row-${ack.view.range.start}`) };
    },
    releaseReadView: async (view, reason) => { released.push({ requestId: view.requestId, reason }); },
  } as Pick<HistoryEngine, "grantReadView" | "openReadView" | "readPage" | "releaseReadView"> as HistoryEngine;
  return { capture, history, listeners, released, readLines };
}

test("NEWARCH D: 21 viewers keep independent immutable pages inside both cache caps", async () => {
  const h = displayHarness();
  const baseReadPage = h.history.readPage.bind(h.history);
  const oneMiB = "x".repeat(1024 * 1024);
  h.history.readPage = async (ack, cursor, limit, cancel) => {
    const base = await baseReadPage(ack, cursor, limit, cancel);
    return base.status === "ok"
      ? { status: "ok", value: displayPage(ack.view, `${ack.view.range.start}:${oneMiB}`) }
      : base;
  };
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const attachments = Array.from({ length: 21 }, async (_, index) => {
    const route = displayRoute(`viewer-${index}`);
    const attached = engine.attach(route, () => {});
    for (const listener of h.listeners) listener(displayFrame());
    expect((await attached).status).toBe("ok");
    const request = displayView(route, `request-${index}`, index);
    const page = await engine.page(route, request, null, 500, { isCancelled: () => false });
    expect(page.status).toBe("ok");
    if (page.status === "ok") {
      expect(page.value.fragments[0]!.row.id.lineId).toBe(index);
      expect(Object.isFrozen(page.value.fragments[0]!.row.cells)).toBe(true);
    }
  });
  await Promise.all(attachments);
  expect(h.readLines.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => i));
  expect(h.released).toHaveLength(21);
  expect(engine.stats().pagePoolBytes).toBeLessThanOrEqual(STREAM_BUDGET.pagePoolBytes);
  expect(Math.max(...Object.values(engine.stats().pageBytesByViewer))).toBeLessThanOrEqual(STREAM_BUDGET.pageBytesPerViewer);
  expect(Object.keys(engine.stats().pageBytesByViewer).length).toBeLessThan(21);
});

test("NEWARCH D: stale routes cannot receive frames or read pages and detach is generation-safe", async () => {
  const h = displayHarness();
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const oldRoute = displayRoute("same-viewer", 1);
  const newRoute = displayRoute("same-viewer", 2);
  let oldFrames = 0;
  let newFrames = 0;
  const oldAttach = engine.attach(oldRoute, () => { oldFrames++; });
  for (const listener of h.listeners) listener(displayFrame());
  await oldAttach;
  const newAttach = engine.attach(newRoute, () => { newFrames++; });
  for (const listener of h.listeners) listener(displayFrame(displayIdentity(), 2));
  await newAttach;
  await engine.detach(oldRoute, "late old disconnect");
  for (const listener of h.listeners) listener(displayFrame(displayIdentity(), 3));
  expect(oldFrames).toBe(1);
  expect(newFrames).toBe(2);
  const stale = await engine.page(oldRoute, displayView(oldRoute, "stale", 0), null, 1, { isCancelled: () => false });
  expect(stale).toEqual({ status: "stale", reason: "route" });
});

test("NEWARCH D: timeout and cancellation are errors, never false EOF, and always release the pin", async () => {
  const h = displayHarness();
  h.history.readPage = async () => await new Promise(() => {});
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const route = displayRoute("slow-viewer");
  const attached = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await attached;
  const request = { ...displayView(route, "deadline", 0), deadlineMonoMs: performance.now() + 20 };
  const result = await engine.page(route, request, null, 500, { isCancelled: () => false });
  expect(result).toEqual({ status: "error", code: "deadline", message: "display page deadline exceeded" });
  expect(h.released).toEqual([{ requestId: "deadline", reason: "deadline" }]);

  const cancelled = await engine.page(route, displayView(route, "cancelled", 0), null, 500, { isCancelled: () => true });
  expect(cancelled).toEqual({ status: "cancelled", reason: "cancelled" });
  expect(h.released).toHaveLength(1);
});

test("NEWARCH D: WebSocket reservations stop at 8 MiB and a detached generation cannot double-release", async () => {
  const h = displayHarness();
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const route = displayRoute("backpressured");
  const attached = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await attached;
  const release = engine.reserveEncodedBytes(route.viewerId, STREAM_BUDGET.wsPendingBytes)!;
  expect(engine.reserveEncodedBytes("another-viewer", 1)).toBeNull();
  expect(engine.stats().wsPendingBytes).toBe(STREAM_BUDGET.wsPendingBytes);
  await engine.detach(route, "socket closed");
  expect(engine.stats().wsPendingBytes).toBe(0);
  release();
  expect(engine.stats().wsPendingBytes).toBe(0);
});

test("NEWARCH D: a page at line one million never asks capture for historical tail", async () => {
  const h = displayHarness();
  let subscriptions = 0;
  h.capture.subscribe = (_pane, listener) => {
    subscriptions++;
    h.listeners.add(listener);
    return () => { h.listeners.delete(listener); };
  };
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const route = displayRoute("deep-scrollback");
  const attached = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await attached;
  const result = await engine.page(route, displayView(route, "million", 999_999), null, 500, { isCancelled: () => false });
  expect(result.status).toBe("ok");
  expect(h.readLines).toEqual([999_999]);
  expect(subscriptions).toBe(1);
});


test("NEWARCH D growth: 10000 viewer identities leave no retained bookkeeping", async () => {
  const h = displayHarness();
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const sizes = () => Object.values(engine).filter(v => v instanceof Map).map(v => v.size);
  let early: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const route = displayRoute(`churn-${i}`);
    const ready = engine.attach(route, () => {});
    for (const listener of h.listeners) listener(displayFrame());
    await ready;
    const lateRelease = engine.reserveEncodedBytes(route.viewerId, 10)!;
    await engine.detach(route, "churn");
    lateRelease(); lateRelease();
    if (i === 999) early = sizes();
  }
  expect(sizes()).toEqual(early);
  expect(sizes().every(n => n === 0)).toBe(true);
  expect(h.listeners.size).toBe(0);
  expect(engine.stats().wsPendingBytes).toBe(0);
});

test("NEWARCH D growth: late release cannot debit a reused viewer or a fresh reservation", async () => {
  const h = displayHarness();
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const route = displayRoute("reused");
  const ready = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await ready;
  const old = engine.reserveEncodedBytes(route.viewerId, 10)!;
  await engine.detach(route, "old socket discarded");
  const fresh = engine.reserveEncodedBytes(route.viewerId, 30)!;
  old(); old();
  expect(engine.stats().wsPendingBytes).toBe(30);
  fresh(); fresh();
  expect(engine.stats().wsPendingBytes).toBe(0);
  for (let i = 0; i < 10000; i++) engine.reserveEncodedBytes(`empty-${i}`, 0);
  expect(Object.values(engine).filter(v => v instanceof Map).every(v => v.size === 0)).toBe(true);
});

// ── NEWARCH flag-on lot D: typed history states survive the display engine ──

const FLAG_CAPS = { extensionVersion: 1 as const, supported: ["history-states-v1", "catalog-v3"] as const, required: ["history-states-v1"] as const };
const FLAG_CURSOR = { version: 1 as const, token: "opaque-from-h" };
function flagGap(pane: { serverIdentity: string; paneId: string; birthGeneration: number } = DISPLAY_PANE, countKind: "unknown" | "exact" = "unknown", missingCount: number | null = null) {
  return {
    version: 1 as const, episodeId: "ep-d", parentEpisodeId: null, pane,
    leftRowId: { pane, segmentId: "seg-1", rowOrdinal: 9 }, rightSegmentId: "seg-2",
    reason: "pipe-eof" as const, countKind, missingCount, withheldRows: 1, lowerBound: 0,
    openedAt: 1, closedAt: null, clockEpoch: "clock-d", quality: "degraded" as const,
  } as unknown as NewarchGap;
}
function flagOnExtension(overrides: Partial<NewarchHistoryExtension> = {}): NewarchHistoryExtension {
  return {
    version: 1,
    capabilities: { ...FLAG_CAPS, supported: [...FLAG_CAPS.supported], required: [...FLAG_CAPS.required] },
    states: [
      { kind: "gap", gap: flagGap() },
      { kind: "remote-required", range: { pane: DISPLAY_PANE, segmentId: "seg-0", start: 0, end: 64 }, bundleId: "bundle-0" },
      { kind: "pressure", level: "critical", collecting: true, sinceMonoMs: 3 },
    ],
    before: { kind: "blocked", cursor: FLAG_CURSOR, state: { kind: "pending", operationId: "op-d", retryAfterMs: 50 } },
    after: { kind: "end" },
    ...overrides,
  };
}

async function flagOnHarness(
  page: (view: ReadView) => HistoryPage,
  // null = a display that was never negotiated for flag-on.
  flagOn: ConstructorParameters<typeof StreamDisplayEngine>[0]["flagOn"] | null = { supported: ["history-states-v1", "catalog-v3"], required: true },
) {
  const h = displayHarness();
  h.history.readPage = async ack => ({ status: "ok", value: page(ack.view) });
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history, ...(flagOn ? { flagOn } : {}) });
  const route = displayRoute("flag-viewer");
  const attached = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await attached;
  const result = await engine.page(route, displayView(route, "flag-request", 5), null, 10, { isCancelled: () => false });
  return { h, result };
}

test("NEWARCH D RD-01: a pending (blocked) page keeps its prefix and typed states, frozen, never EOF", async () => {
  const { h, result } = await flagOnHarness(view => ({
    ...displayPage(view, "prefix-row"), hasMoreBefore: true, flagOn: flagOnExtension(),
  }));
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.value.fragments.map(f => f.row.cells[0]!.text)).toEqual(["prefix-row"]);
  expect(result.value.hasMoreBefore).toBe(true);
  expect(result.value.flagOn?.before).toEqual(flagOnExtension().before);
  expect(result.value.flagOn?.states.map(s => s.kind)).toEqual(["gap", "remote-required", "pressure"]);
  const gap = result.value.flagOn!.states[0]!;
  expect(gap.kind === "gap" && gap.gap.missingCount).toBeNull();
  expect(Object.isFrozen(result.value.flagOn!.states)).toBe(true);
  // Labels/states never ride inside row cells.
  expect(JSON.stringify(result.value.fragments)).not.toContain("pending");
  expect(h.released).toEqual([{ requestId: "flag-request", reason: "page-complete" }]);
});

test("NEWARCH D RD-01: an empty blocked page is ok with more-before, not an empty EOF page", async () => {
  const { result } = await flagOnHarness(view => ({
    ...displayPage(view, "x"), fragments: [], payloadBytes: 0, hasMoreBefore: true, flagOn: flagOnExtension(),
  }));
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.value.fragments).toHaveLength(0);
    expect(result.value.hasMoreBefore).toBe(true);
    expect(result.value.flagOn?.before.kind).toBe("blocked");
  }
});

test("NEWARCH D: pages that would read as false EOF or hide states are refused with the pin released", async () => {
  const cases: Array<[string, (view: ReadView) => HistoryPage, "integrity" | "unsupported"]> = [
    ["blocked edge but legacy hasMoreBefore=false", view => ({ ...displayPage(view, "r"), flagOn: flagOnExtension() }), "integrity"],
    ["end edge but legacy hasMoreAfter=true", view => ({ ...displayPage(view, "r"), hasMoreBefore: true, hasMoreAfter: true, flagOn: flagOnExtension() }), "integrity"],
    ["required flag-on but bare page", view => displayPage(view, "r"), "integrity"],
    ["unknown count rendered as 0", view => ({ ...displayPage(view, "r"), hasMoreBefore: true,
      flagOn: flagOnExtension({ states: [{ kind: "gap", gap: { ...flagGap(), missingCount: 0 } as unknown as NewarchGap }] }) }), "integrity"],
    ["gap of another pane", view => ({ ...displayPage(view, "r"), hasMoreBefore: true,
      flagOn: flagOnExtension({ states: [{ kind: "gap", gap: flagGap({ ...DISPLAY_PANE, paneId: "%99" }) }] }) }), "integrity"],
    ["blocked by exact", view => ({ ...displayPage(view, "r"), hasMoreBefore: true,
      flagOn: flagOnExtension({ before: { kind: "blocked", cursor: FLAG_CURSOR, state: { kind: "exact" } as never } }) }), "integrity"],
    ["unknown state kind", view => ({ ...displayPage(view, "r"), hasMoreBefore: true,
      flagOn: flagOnExtension({ states: [{ kind: "eof" } as never] }) }), "integrity"],
    ["required capability not negotiated", view => ({ ...displayPage(view, "r"), hasMoreBefore: true,
      flagOn: flagOnExtension({ capabilities: { extensionVersion: 1, supported: ["history-states-v1", "stitch-v1"], required: ["stitch-v1"] } }) }), "unsupported"],
  ];
  for (const [name, page, code] of cases) {
    const { h, result } = await flagOnHarness(page);
    expect([name, result.status, result.status === "error" ? result.code : null]).toEqual([name, "error", code]);
    expect([name, h.released.length]).toEqual([name, 1]);
  }
});

test("NEWARCH D: a display not negotiated for flag-on refuses an envelope instead of dropping it", async () => {
  const { result } = await flagOnHarness(view => ({
    ...displayPage(view, "r"), hasMoreBefore: true, flagOn: flagOnExtension(),
  }), null);
  expect(result).toEqual({ status: "error", code: "unsupported", message: "display was not negotiated for flag-on history states" });
});

test("NEWARCH D-fix R18/R13: repair pressure keeps backend time and row, and remote is not EOF", async () => {
  const wallMs = 1_700_000_000_123;
  const incidentId = "incident-storage-7";
  const leftRow = { pane: DISPLAY_PANE, segmentId: "seg-9", rowOrdinal: 41 };
  const repairCaps = { revision: 2, supported: ["incident-r2", "timeline-replay-r2"], required: ["incident-r2"] };
  const incident = {
    revision: 2 as const, incidentId, pane: DISPLAY_PANE, leftRowId: leftRow,
    openedAtWallMs: wallMs, openedAtMonoMs: 80, clockEpoch: "clock-d",
    collecting: false as const, reason: "storage-outage" as const, quality: "degraded" as const,
    resolvedAtWallMs: null,
  };
  const remoteCursor = { version: 1 as const, token: "opaque-remote-T" };
  const repairPage = (pressure: Record<string, unknown>): NewarchHistoryExtension => ({
    ...flagOnExtension(),
    states: [pressure as never],
    before: {
      kind: "blocked",
      cursor: remoteCursor,
      state: { kind: "remote-required", range: { pane: DISPLAY_PANE, segmentId: "seg-0", start: 0, end: 64 }, bundleId: "bundle-0" },
    },
    repair: repairCaps,
  } as NewarchHistoryExtension);

  const missing = await flagOnHarness(view => ({
    ...displayPage(view, "prefix-row"),
    hasMoreBefore: true,
    flagOn: repairPage({ kind: "pressure", level: "emergency", collecting: false, sinceMonoMs: 5 }),
  }));
  expect(missing.result.status).toBe("error");
  if (missing.result.status === "error") expect(missing.result.code).toBe("integrity");
  expect(missing.h.released).toEqual([{ requestId: "flag-request", reason: "invalid-flag-on" }]);

  const zeroRow = await flagOnHarness(view => ({
    ...displayPage(view, "prefix-row"),
    hasMoreBefore: true,
    flagOn: repairPage({
      kind: "pressure", level: "emergency", collecting: false, sinceMonoMs: 5,
      repair: { ...incident, leftRowId: 0 },
    }),
  }));
  expect(zeroRow.result.status).toBe("error");

  const kept = await flagOnHarness(view => ({
    ...displayPage(view, "prefix-row"),
    hasMoreBefore: true,
    flagOn: repairPage({
      kind: "pressure", level: "emergency", collecting: false, sinceMonoMs: 5, repair: incident,
    }),
  }));
  expect(kept.result.status).toBe("ok");
  if (kept.result.status !== "ok") return;
  expect(kept.result.value.hasMoreBefore).toBe(true);
  expect(kept.result.value.flagOn?.before).toEqual({
    kind: "blocked",
    cursor: remoteCursor,
    state: { kind: "remote-required", range: { pane: DISPLAY_PANE, segmentId: "seg-0", start: 0, end: 64 }, bundleId: "bundle-0" },
  });
  const pressure = kept.result.value.flagOn?.states.find(state => state.kind === "pressure") as {
    repair?: { openedAtWallMs?: number; leftRowId?: unknown; incidentId?: string };
  };
  expect(pressure.repair?.openedAtWallMs).toBe(wallMs);
  expect(pressure.repair?.leftRowId).toEqual(leftRow);
  expect(pressure.repair?.incidentId).toBe(incidentId);
  expect(Object.isFrozen(kept.result.value.flagOn)).toBe(true);
  const dumped = JSON.stringify(kept.result.value.fragments);
  expect(dumped).not.toContain(incidentId);
  expect(dumped).not.toContain(String(wallMs));
  expect(dumped).not.toContain("หยุดเก็บประวัติ");
  expect(dumped).not.toContain("ประวัติช่วงนี้อยู่ในคลังสำรอง");

  const beforeFirst = await flagOnHarness(view => ({
    ...displayPage(view, "prefix-row"),
    fragments: [],
    payloadBytes: 0,
    hasMoreBefore: true,
    flagOn: repairPage({
      kind: "pressure", level: "emergency", collecting: false, sinceMonoMs: 5,
      repair: { ...incident, leftRowId: null },
    }),
  }));
  expect(beforeFirst.result.status).toBe("ok");
  if (beforeFirst.result.status !== "ok") return;
  const nullPressure = beforeFirst.result.value.flagOn?.states.find(state => state.kind === "pressure") as {
    repair?: { leftRowId?: unknown };
  };
  expect(nullPressure.repair?.leftRowId).toBeNull();
  expect(beforeFirst.result.value.hasMoreBefore).toBe(true);
  expect(beforeFirst.result.value.flagOn?.before.kind).toBe("blocked");
});

test("NEWARCH D: a history that stays busy returns busy, never an empty EOF page", async () => {
  const h = displayHarness();
  let calls = 0;
  h.history.readPage = async () => { calls++; return { status: "busy", retryAfterMs: 1, reason: "queue" }; };
  const engine = new StreamDisplayEngine({ capture: h.capture, history: h.history });
  const route = displayRoute("busy-viewer");
  const attached = engine.attach(route, () => {});
  for (const listener of h.listeners) listener(displayFrame());
  await attached;
  const result = await engine.page(route, displayView(route, "busy", 0), null, 10, { isCancelled: () => false });
  expect(result.status).toBe("busy");
  expect(calls).toBe(STREAM_BUDGET.maxReadRetries + 1);
  expect(h.released).toEqual([{ requestId: "busy", reason: "busy" }]);
});

const V2_GEOMETRY = {
  policy: "fixed-at-birth" as const, columns: 100, rows: 40,
  configVersion: "q22-default-1", panesPerWindow: 1 as const,
};
const V2_PANE = { serverIdentity: "srv", paneId: "pane-a", birthGeneration: 1 };
const V2_SESSION = { serverIdentity: "srv", sessionId: "sess-1" };

function v2Descriptor(paneId: string): NewarchV2PaneDescriptor {
  return {
    schema: "newarch-v2", session: V2_SESSION,
    pane: { serverIdentity: "srv", paneId, birthGeneration: 1 },
    windowId: `win-${paneId}`, owner: "capture-engine", birthOperationId: `birth-${paneId}`,
    geometry: V2_GEOMETRY, state: "active",
  };
}

function v2Owner(): V2SessionOwnerRecord {
  return {
    schema: "newarch-v2", session: V2_SESSION, owner: "capture-engine",
    birthOperationId: "birth-sess", state: "active", generation: 1,
  };
}

function v2Row(ordinal: number, segmentId = "seg"): CommittedStreamRow {
  const id = { pane: V2_PANE, segmentId, rowOrdinal: ordinal };
  const origin = { kind: "durable" as const, rowId: id };
  return {
    id, origin, cells: [{ text: `r${ordinal}`, width: 1, style: [] }],
    geometry: { columns: 100, rows: 40 }, buffer: "normal", wrapStatus: "unwrapped",
    wrapPad: 0, finalized: true, uncertainFields: [], cellOrigins: [origin],
  };
}

function v2Cursor(storeId: string): NewarchV2HistoryCursor {
  return { schema: "newarch-v2", pane: V2_PANE, storeId, timelineRevision: 3, token: "cursor-token-1" };
}

function v2Incident(collecting: boolean): NewarchV2Incident {
  return {
    schema: "newarch-v2", incidentId: "incident-before-first", pane: V2_PANE, reason: "pipe-eof",
    frontier: null, affected: { after: null, through: null },
    openedAtWallMs: Date.UTC(2026, 9, 4, 1, 2, 3), openedAtMonoMs: 10, clockEpoch: "epoch-1",
    collecting, missing: { countKind: "unknown", missingCount: null },
    ruleVersion: "explicit-gap@1", configVersion: "q22-default-1", geometry: V2_GEOMETRY,
    revision: 1, sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null,
    action: collecting ? "annotate" : "gap-and-stop", evidence: null,
  };
}

function v2Page(input: Pick<V2HistoryPage, "entries" | "states" | "before" | "after"> & { payloadBytes?: number }): V2HistoryPage {
  return {
    schema: "newarch-v2", pane: V2_PANE, revision: 3, payloadBytes: input.payloadBytes ?? 2,
    entries: input.entries, states: input.states, before: input.before, after: input.after,
  };
}

function v2Request(cursor: NewarchV2HistoryCursor | null = null): NewarchV2HistoryRequest {
  return { schema: "newarch-v2", pane: V2_PANE, cursor, direction: "after", maxEntries: 20, maxBytes: 4096 };
}

function v2Reader(overrides: Partial<V2HistoryReader>): V2HistoryReader {
  const unused = () => ({ status: "error" as const, code: "integrity" as const, message: "unused v2 port" });
  return {
    owner: unused, receipt: unused, checkpoint: unused, page: async () => unused(),
    panes: () => ({ status: "ok", value: { panes: [], next: null } }),
    sessionOwner: () => ({ status: "ok", value: null }),
    sealed: unused, export: unused, locator: unused, lastAudit: unused,
    ...overrides,
  };
}

test("NEWARCH v2 D: several panes stay a list and the last pane is not chosen", () => {
  const panes = [v2Descriptor("pane-a"), v2Descriptor("pane-b")];
  const display = new NewarchV2Display(v2Reader({
    sessionOwner: () => ({ status: "ok", value: v2Owner() }),
    panes: () => ({ status: "ok", value: { panes, next: null } }),
  }));
  const selected = display.select(V2_SESSION);
  expect(selected.status).toBe("ok");
  if (selected.status !== "ok") return;
  expect(selected.value.kind).toBe("ambiguous");
  if (selected.value.kind !== "ambiguous") return;
  expect(selected.value.panes.map(pane => pane.pane.paneId)).toEqual(["pane-a", "pane-b"]);
  const only = new NewarchV2Display(v2Reader({
    sessionOwner: () => ({ status: "ok", value: v2Owner() }),
    panes: () => ({ status: "ok", value: { panes: [panes[0]!], next: null } }),
  })).select(V2_SESSION);
  expect(only.status === "ok" && only.value.kind).toBe("selected");
  const unknown = new NewarchV2Display(v2Reader({
    sessionOwner: () => ({ status: "error", code: "io", message: "owner store unreadable" }),
  })).select(V2_SESSION);
  expect(unknown.status === "ok" && unknown.value.kind).toBe("owner-unavailable");
  const absent = new NewarchV2Display(v2Reader({
    sessionOwner: () => ({ status: "ok", value: null }),
  })).select(V2_SESSION);
  expect(absent.status === "ok" && absent.value.kind).toBe("missing");
});

test("NEWARCH v2 D: viewer geometry never resizes a fixed pane", () => {
  const display = new NewarchV2Display(v2Reader({}));
  for (const intent of [
    { source: "viewport" as const, columns: 40, rows: 20 },
    { source: "font" as const, columns: 80, rows: 30 },
    { source: "rotation" as const, columns: 70, rows: 20 },
    { source: "keyboard-inset" as const, columns: 40, rows: 12 },
    { source: "fit-width" as const, columns: 100, rows: 40 },
    { source: "apply-geometry" as const, columns: 120, rows: 50 },
  ]) {
    const answer = display.geometry(v2Descriptor("pane-a"), intent);
    expect(answer.resize).toBeNull();
    expect(answer.reply.status).toBe("fixed");
    expect(answer.reply.geometry).toEqual(V2_GEOMETRY);
  }
});

test("NEWARCH v2 D: one cursor walks local to remote to local and each row once", async () => {
  const seen: string[] = [];
  const pages = new Map<string, V2HistoryPage>([
    ["", v2Page({
      entries: [{ kind: "row", row: v2Row(1) }, { kind: "row", row: v2Row(2) }],
      states: [{ kind: "exact", auditedRevision: 3 }],
      before: { kind: "end" }, after: { kind: "more", cursor: v2Cursor("local") },
    })],
    ["local", v2Page({
      entries: [{ kind: "row", row: v2Row(3) }],
      states: [{ kind: "exact", auditedRevision: 3 }],
      before: { kind: "more", cursor: v2Cursor("local") },
      after: { kind: "more", cursor: v2Cursor("remote") },
    })],
    ["remote", v2Page({
      entries: [{ kind: "row", row: v2Row(4) }],
      states: [{ kind: "exact", auditedRevision: 3 }],
      before: { kind: "more", cursor: v2Cursor("remote") },
      after: { kind: "more", cursor: v2Cursor("local-restored") },
    })],
    ["local-restored", v2Page({
      entries: [{ kind: "row", row: v2Row(5) }],
      states: [{ kind: "exact", auditedRevision: 3 }],
      before: { kind: "more", cursor: v2Cursor("local-restored") },
      after: { kind: "end" },
    })],
  ]);
  const display = new NewarchV2Display(v2Reader({
    page: async request => {
      const storeId = request.cursor?.storeId ?? "";
      seen.push(`${storeId}:${request.cursor?.token ?? ""}`);
      const page = pages.get(storeId);
      if (!page) return { status: "error", code: "integrity", message: "missing page" };
      return { status: "ok", value: page };
    },
  }));
  const span = await display.readSpan(v2Request(), 8);
  expect(span.status).toBe("ok");
  if (span.status !== "ok") return;
  expect(span.value.ended).toBe(true);
  expect(span.value.blocked).toBeNull();
  expect(span.value.entries.map(entry => entry.kind === "row" ? entry.row.id.rowOrdinal : null)).toEqual([1, 2, 3, 4, 5]);
  expect(seen).toEqual([":", "local:cursor-token-1", "remote:cursor-token-1", "local-restored:cursor-token-1"]);
});

test("NEWARCH v2 D: a missing remote is blocked, not an empty end, and the pin is held across the read", async () => {
  const log: string[] = [];
  const blocked = v2Page({
    entries: [],
    states: [{ kind: "remote-unavailable", bundleId: "bundle-1", reason: "missing", retryAfterMs: 1000 }],
    before: { kind: "end" },
    after: {
      kind: "blocked", cursor: v2Cursor("remote"),
      state: { kind: "remote-unavailable", bundleId: "bundle-1", reason: "missing", retryAfterMs: 1000 },
    },
  });
  const display = new NewarchV2Display(v2Reader({
    page: async () => {
      log.push("read");
      expect(log).toEqual(["pin", "read"]);
      return { status: "ok", value: blocked };
    },
  }), {
    submit: async command => {
      log.push(command.kind);
      expect(command.kind === "pin" || command.kind === "release-pin").toBe(true);
      return { status: "ok", value: null };
    },
  });
  const span = await display.readSpan(v2Request(v2Cursor("remote")), 4, "seg");
  expect(log).toEqual(["pin", "read", "release-pin"]);
  expect(span.status).toBe("ok");
  if (span.status !== "ok") return;
  expect(span.value.entries).toEqual([]);
  expect(span.value.ended).toBe(false);
  expect(span.value.blocked?.kind).toBe("remote-unavailable");
});

test("NEWARCH v2 D: a blocking state reported as the end is refused, and a candidate row is not history", async () => {
  const falseEnd = v2Page({
    entries: [],
    states: [{ kind: "storage-unavailable", pendingIncidentId: "pending-1", retryAfterMs: 1000 }],
    before: { kind: "end" }, after: { kind: "end" },
  });
  const display = new NewarchV2Display(v2Reader({
    page: async () => ({ status: "ok", value: falseEnd }),
  }));
  const refused = await display.page(v2Request());
  expect(refused.status).toBe("error");
  if (refused.status === "error") expect(refused.message).toContain("end of history");
  const candidate = v2Row(1);
  const leaked = v2Page({
    entries: [{ kind: "row", row: { ...candidate, finalized: false } }],
    states: [{ kind: "exact", auditedRevision: 3 }],
    before: { kind: "end" }, after: { kind: "end" },
  });
  const hidden = await new NewarchV2Display(v2Reader({
    page: async () => ({ status: "ok", value: leaked }),
  })).page(v2Request());
  expect(hidden.status).toBe("error");
  if (hidden.status === "error") expect(hidden.message).toContain("candidate");
  const incident = v2Incident(false);
  const kept = await new NewarchV2Display(v2Reader({
    page: async () => ({ status: "ok", value: v2Page({
      entries: [{ kind: "incident", incident }],
      states: [{ kind: "incident", incident }],
      before: { kind: "end" }, after: { kind: "end" },
    }) }),
  })).page(v2Request());
  expect(kept.status).toBe("ok");
  if (kept.status === "ok") {
    expect(kept.value.entries[0]).toMatchObject({ kind: "incident", incident: { frontier: null, collecting: false } });
  }
});

// --- D3 (flag-on, 2026-10-05): v2 cursor request/reply on the mux socket ---

type V2Frame = Record<string, unknown> & { type: string; requestId?: string; status?: string; code?: string };

function v2Frames(ws: FakeWS): V2Frame[] {
  return ws.sent.map(data => JSON.parse(data) as V2Frame).filter(frame => frame.type === "history_v2");
}

function d3Cursor(storeId: string, token: string, pane = V2_PANE, timelineRevision = 3): NewarchV2HistoryCursor {
  return { schema: "newarch-v2", pane, storeId, timelineRevision, token };
}

function d3Expand(requestId: string, cursor: NewarchV2HistoryCursor | null, overrides: Partial<NewarchV2HistoryRequest> = {}) {
  return {
    type: "history_expand_v2" as const, session: SESSION, requestId,
    request: { schema: "newarch-v2" as const, pane: V2_PANE, cursor, direction: "before" as const, maxEntries: 256, maxBytes: 2 * 1024 * 1024, ...overrides },
  };
}

function d3Mux(options: {
  page?: (session: string, request: NewarchV2HistoryRequest) => unknown;
  selection?: () => ReturnType<NonNullable<ConstructorParameters<typeof TmuxWsMux>[0]["newarchV2"]>>;
  resized?: Array<{ cols: number; rows: number }>;
}) {
  const driver = fakeDriver();
  if (options.resized) driver.resizeWindow = (_session, cols, rows) => { options.resized!.push({ cols, rows }); };
  const ctor = TmuxWsMux as unknown as new (opts: Record<string, unknown>) => TmuxWsMux;
  return new ctor({
    driver,
    newarchV2: (session: string) => session === SESSION
      ? (options.selection ? options.selection() : { kind: "selected", pane: v2Descriptor("pane-a") })
      : null,
    ...(options.page ? { newarchV2History: options.page } : {}),
  });
}

async function d3Settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("D3: history_expand_v2 walks three pages back and forward again with the server's own v2 cursors", async () => {
  const seen: Array<{ direction: string; store: string | null; token: string | null }> = [];
  const page = (_s: string, request: NewarchV2HistoryRequest) => {
    seen.push({ direction: request.direction, store: request.cursor?.storeId ?? null, token: request.cursor?.token ?? null });
    const at = request.cursor ? Number(request.cursor.storeId.slice(1)) : 3;
    const index = request.direction === "before" ? at - 1 : at + 1;
    const rows = [1, 2].map(k => ({ kind: "row" as const, row: v2Row(index * 10 + k) }));
    return {
      status: "ok",
      value: v2Page({
        entries: rows, states: [{ kind: "exact", auditedRevision: 3 }],
        before: index > 0 ? { kind: "more", cursor: d3Cursor(`p${index}`, `tok-before-${index}`) } : { kind: "end" },
        after: index < 3 ? { kind: "more", cursor: d3Cursor(`p${index}`, `tok-after-${index}`) } : { kind: "end" },
      }),
    };
  };
  const mux = d3Mux({ page });
  const ws = new FakeWS();
  let cursor: NewarchV2HistoryCursor | null = null;
  for (let step = 0; step < 3; step++) {
    mux.handleMessage(d3Expand(`b${step}`, cursor) as never, ws);
    await d3Settle();
    const reply = v2Frames(ws).at(-1)!;
    expect(reply.requestId).toBe(`b${step}`);
    expect(reply.status).toBe("ok");
    expect(reply.channel).toBe(SESSION);
    const entries = reply.entries as Array<{ kind: string; id: { rowOrdinal: number }; cells: unknown[] } & Record<string, unknown>>;
    expect(entries.map(entry => entry.id.rowOrdinal)).toEqual([(2 - step) * 10 + 1, (2 - step) * 10 + 2]);
    // provenance stays on the server: the wire row is a screen projection only
    expect(entries.every(entry => !("cellOrigins" in entry) && !("origin" in entry) && !("row" in entry))).toBe(true);
    cursor = (reply.before as { kind: string; cursor: NewarchV2HistoryCursor }).cursor ?? null;
  }
  expect((v2Frames(ws).at(-1)!.before as { kind: string }).kind).toBe("end");
  // ...and back: the after cursor of the oldest page reads the next page forward.
  const oldest = v2Frames(ws).at(-1)!;
  const forward = (oldest.after as { cursor: NewarchV2HistoryCursor }).cursor;
  mux.handleMessage(d3Expand("f0", forward, { direction: "after" }) as never, ws);
  await d3Settle();
  const back = v2Frames(ws).at(-1)!;
  expect(back.status).toBe("ok");
  expect((back.entries as Array<{ id: { rowOrdinal: number } }>).map(e => e.id.rowOrdinal)).toEqual([11, 12]);
  // the reader received each v2 cursor verbatim, never a flattened line number
  expect(seen).toEqual([
    { direction: "before", store: null, token: null },
    { direction: "before", store: "p2", token: "tok-before-2" },
    { direction: "before", store: "p1", token: "tok-before-1" },
    { direction: "after", store: "p0", token: "tok-after-0" },
  ]);
  expect(ws.sent.some(data => JSON.parse(data).type === "history")).toBe(false);
});

test("D3: a request for another pane, or with another pane's cursor, is wrong-pane and never reaches the reader", async () => {
  let reads = 0;
  const mux = d3Mux({ page: () => { reads++; return { status: "ok", value: v2Page({ entries: [], states: [], before: { kind: "end" }, after: { kind: "end" } }) }; } });
  const ws = new FakeWS();
  const otherPane = { serverIdentity: "srv", paneId: "pane-b", birthGeneration: 1 };
  mux.handleMessage(d3Expand("x1", null, { pane: otherPane }) as never, ws);
  mux.handleMessage(d3Expand("x2", d3Cursor("p1", "tok", otherPane)) as never, ws);
  // same pane id, but a recreated server / reborn pane is a different pane
  mux.handleMessage(d3Expand("x3", d3Cursor("p1", "tok", { ...V2_PANE, birthGeneration: 2 })) as never, ws);
  await d3Settle();
  const frames = v2Frames(ws);
  expect(frames.map(frame => [frame.requestId, frame.status, frame.code])).toEqual([
    ["x1", "error", "wrong-pane"], ["x2", "error", "wrong-pane"], ["x3", "error", "wrong-pane"],
  ]);
  expect(reads).toBe(0);
});

test("D3: legacy, unavailable owner, oversized request and oversized cursor are typed errors, not empty pages", async () => {
  const ws = new FakeWS();
  const legacy = new TmuxWsMux({ driver: fakeDriver() });
  legacy.handleMessage(d3Expand("l1", null) as never, ws);
  const unavailable = d3Mux({ selection: () => ({ kind: "owner-unavailable", retryAfterMs: 750 }), page: () => { throw new Error("must not read"); } });
  unavailable.handleMessage(d3Expand("u1", null) as never, ws);
  const mux = d3Mux({ page: () => { throw new Error("must not read"); } });
  mux.handleMessage(d3Expand("o1", null, { maxEntries: 257 }) as never, ws);
  mux.handleMessage(d3Expand("o2", null, { maxBytes: 2 * 1024 * 1024 + 1 }) as never, ws);
  mux.handleMessage(d3Expand("o3", d3Cursor("p1", "x".repeat(4097))) as never, ws);
  await d3Settle();
  const frames = v2Frames(ws);
  expect(frames.map(frame => [frame.requestId, frame.status, frame.code, frame.retryAfterMs])).toEqual([
    ["l1", "error", "unsupported", null],
    ["u1", "error", "owner-unavailable", 750],
    ["o1", "error", "bounded-read", null],
    ["o2", "error", "bounded-read", null],
    ["o3", "error", "bounded-read", null],
  ]);
  expect(frames.every(frame => !("entries" in frame))).toBe(true);
});

test("D3: a reader page with another pane's row or cursor is refused, and reader faults map to typed errors", async () => {
  const foreignPane = { serverIdentity: "srv", paneId: "pane-b", birthGeneration: 1 };
  const foreignRow = { ...v2Row(7), id: { pane: foreignPane, segmentId: "seg", rowOrdinal: 7 } };
  const answers: unknown[] = [
    { status: "ok", value: v2Page({ entries: [{ kind: "row", row: foreignRow }], states: [], before: { kind: "end" }, after: { kind: "end" } }) },
    { status: "ok", value: v2Page({ entries: [], states: [], before: { kind: "more", cursor: d3Cursor("p1", "t", foreignPane) }, after: { kind: "end" } }) },
    { status: "busy", retryAfterMs: 400, reason: "queue" },
    { status: "stale", reason: "epoch" },
    { status: "error", code: "io", message: "disk" },
    Promise.reject(new Error("reader threw")),
  ];
  let call = 0;
  const mux = d3Mux({ page: () => answers[call++] });
  const ws = new FakeWS();
  for (let i = 0; i < answers.length; i++) mux.handleMessage(d3Expand(`r${i}`, null) as never, ws);
  await d3Settle();
  const frames = v2Frames(ws);
  expect(frames.map(frame => [frame.requestId, frame.status, frame.code])).toEqual([
    ["r0", "error", "wrong-pane"],
    ["r1", "error", "wrong-pane"],
    ["r2", "error", "owner-unavailable"],
    ["r3", "error", "stale-cursor"],
    ["r4", "error", "owner-unavailable"],
    ["r5", "error", "owner-unavailable"],
  ]);
  expect(frames[2]!.retryAfterMs).toBe(400);
  expect(ws.sent.some(data => JSON.stringify(JSON.parse(data)).includes("disk"))).toBe(false);
});

test("D3: an incident before the first row and a pending storage state travel to the client intact", async () => {
  const pending = { kind: "storage-unavailable" as const, pendingIncidentId: "pending-1", retryAfterMs: 500 };
  const mux = d3Mux({
    page: () => ({
      status: "ok",
      value: v2Page({
        entries: [{ kind: "incident", incident: v2Incident(false) }, { kind: "row", row: v2Row(1) }],
        states: [{ kind: "incident", incident: v2Incident(false) }, pending],
        before: { kind: "blocked", cursor: d3Cursor("p0", "blocked-tok"), state: pending },
        after: { kind: "end" },
      }),
    }),
  });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("i1", null) as never, ws);
  await d3Settle();
  const reply = v2Frames(ws).at(-1)!;
  expect(reply.status).toBe("ok");
  const entries = reply.entries as Array<Record<string, unknown>>;
  expect(entries[0]).toEqual({ kind: "incident", incident: v2Incident(false) });
  expect((entries[0]!.incident as NewarchV2Incident).frontier).toBeNull();
  expect(reply.states).toEqual([{ kind: "incident", incident: v2Incident(false) }, pending]);
  expect((reply.before as { kind: string }).kind).toBe("blocked");
  expect(reply.payloadBytes).toBeGreaterThan(0);
});

test("D3: a v2 reply that would exceed the wire page bound is refused as bounded-read", async () => {
  const wide = { ...v2Row(1), cells: Array.from({ length: 100 }, () => ({ text: "x".repeat(100), width: 1 as const, style: [] })) };
  const mux = d3Mux({
    page: () => ({ status: "ok", value: v2Page({ entries: [{ kind: "row", row: wide }], states: [], before: { kind: "end" }, after: { kind: "end" } }) }),
  });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("big", null, { maxBytes: 4096 }) as never, ws);
  await d3Settle();
  expect(v2Frames(ws).map(frame => [frame.status, frame.code])).toEqual([["error", "bounded-read"]]);
});

test("D3: an async reply is dropped when the session's pane changes before it lands", async () => {
  let release!: (value: unknown) => void;
  let current = v2Descriptor("pane-a");
  const mux = d3Mux({
    selection: () => ({ kind: "selected", pane: current }),
    page: () => new Promise(resolve => { release = resolve; }),
  });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("late", null) as never, ws);
  current = v2Descriptor("pane-b");
  release({ status: "ok", value: v2Page({ entries: [{ kind: "row", row: v2Row(1) }], states: [], before: { kind: "end" }, after: { kind: "end" } }) });
  await d3Settle();
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code])).toEqual([["late", "error", "wrong-pane"]]);
});

test("D3-r1: storage or remote unavailable is never an ok page whose requested direction is end", async () => {
  const pending = { kind: "storage-unavailable" as const, pendingIncidentId: "pending-1", retryAfterMs: 500 };
  const remote = { kind: "remote-unavailable" as const, bundleId: "bundle-9", reason: "offline" as const, retryAfterMs: 1000 };
  const blocked = (state: typeof pending | typeof remote) => ({ kind: "blocked" as const, cursor: d3Cursor("p0", "blocked-tok"), state });
  const pages = [
    v2Page({ entries: [], states: [pending], before: { kind: "end" }, after: { kind: "end" } }),
    v2Page({ entries: [{ kind: "row", row: v2Row(1) }], states: [pending], before: { kind: "end" }, after: blocked(pending) }),
    v2Page({ entries: [], states: [remote], before: blocked(remote), after: { kind: "end" } }),
    // control: the requested direction is blocked, so the page is legal
    v2Page({ entries: [{ kind: "row", row: v2Row(2) }], states: [pending], before: blocked(pending), after: { kind: "end" } }),
  ];
  let call = 0;
  const mux = d3Mux({ page: () => ({ status: "ok", value: pages[call++] }) });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("u0", null) as never, ws);
  mux.handleMessage(d3Expand("u1", null) as never, ws);
  mux.handleMessage(d3Expand("u2", d3Cursor("p1", "tok-after"), { direction: "after" }) as never, ws);
  mux.handleMessage(d3Expand("u3", null) as never, ws);
  await d3Settle();
  // stale-cursor (restart from the tail), never wrong-pane (which drops the pane) and never ok
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code ?? null])).toEqual([
    ["u0", "error", "stale-cursor"],
    ["u1", "error", "stale-cursor"],
    ["u2", "error", "stale-cursor"],
    ["u3", "ok", null],
  ]);
});

test("D3-r1: identity text over 256 bytes or a birth below 1 never reaches the reader, and is never echoed", async () => {
  let reads = 0;
  const empty = () => { reads++; return { status: "ok", value: v2Page({ entries: [], states: [], before: { kind: "end" }, after: { kind: "end" } }) }; };
  const mux = d3Mux({ page: empty });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("s1", d3Cursor("s".repeat(257), "tok")) as never, ws);
  mux.handleMessage(d3Expand("s2", d3Cursor("\u0e01".repeat(86), "tok")) as never, ws);
  mux.handleMessage(d3Expand("s3", null, { pane: { ...V2_PANE, paneId: "p".repeat(300) } }) as never, ws);
  mux.handleMessage(d3Expand("s4", d3Cursor("s".repeat(256), "tok")) as never, ws);
  // a selected pane born at generation 0 is outside the contract (birth >= 1)
  const zero = { ...V2_PANE, birthGeneration: 0 };
  const unborn = d3Mux({ page: empty, selection: () => ({ kind: "selected", pane: { ...v2Descriptor("pane-a"), pane: zero } }) });
  unborn.handleMessage(d3Expand("s5", null, { pane: zero }) as never, ws);
  await d3Settle();
  expect(reads).toBe(1);
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code ?? null])).toEqual([
    ["s1", "error", "bounded-read"],
    ["s2", "error", "bounded-read"],
    ["s4", "ok", null],
  ]);
  expect(ws.sent.some(data => data.includes("p".repeat(300)))).toBe(false);
});

test("D3-r1: a row that is not finalized never travels as history", async () => {
  const live = { ...v2Row(9), finalized: false, cells: [{ text: "secret", width: 1 as const, style: [] }] };
  const mux = d3Mux({
    page: () => ({ status: "ok", value: v2Page({ entries: [{ kind: "row", row: v2Row(8) }, { kind: "row", row: live }], states: [], before: { kind: "end" }, after: { kind: "end" } }) }),
  });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("nf", null) as never, ws);
  await d3Settle();
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code ?? null])).toEqual([["nf", "error", "unsupported"]]);
  expect(ws.sent.some(data => data.includes("secret"))).toBe(false);
});

test("D3-r1: an incident without a valid pane is an error frame, never a throw", async () => {
  const { pane: _drop, ...paneless } = v2Incident(false);
  const mux = d3Mux({
    page: () => ({ status: "ok", value: v2Page({ entries: [{ kind: "incident", incident: paneless as never }], states: [], before: { kind: "end" }, after: { kind: "end" } }) }),
  });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("np", null) as never, ws);
  await d3Settle();
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code ?? null])).toEqual([["np", "error", "unsupported"]]);
});

test("D3-r1: an owner that turns unavailable during the read answers owner-unavailable with its retry, not wrong-pane", async () => {
  let release!: (value: unknown) => void;
  type Selection = ReturnType<NonNullable<ConstructorParameters<typeof TmuxWsMux>[0]["newarchV2"]>>;
  let selection: Selection = { kind: "selected", pane: v2Descriptor("pane-a") };
  const mux = d3Mux({ selection: () => selection, page: () => new Promise(resolve => { release = resolve; }) });
  const ws = new FakeWS();
  mux.handleMessage(d3Expand("ou", null) as never, ws);
  selection = { kind: "owner-unavailable", retryAfterMs: 750 };
  release({ status: "ok", value: v2Page({ entries: [{ kind: "row", row: v2Row(1) }], states: [], before: { kind: "end" }, after: { kind: "end" } }) });
  await d3Settle();
  expect(v2Frames(ws).map(frame => [frame.requestId, frame.status, frame.code, frame.retryAfterMs])).toEqual([["ou", "error", "owner-unavailable", 750]]);
});

test("D3 gate: a fixed v2 window refuses every resize and answers the birth geometry", () => {
  const resized: Array<{ cols: number; rows: number }> = [];
  const mux = d3Mux({ resized });
  for (const [cols, rows] of [[40, 20], [80, 24], [120, 50]] as const) {
    const reply = mux.handleResize(SESSION, cols, rows);
    expect(reply?.status).toBe("fixed");
    expect(reply?.geometry).toEqual(V2_GEOMETRY);
    expect(mux.applyGeometry(SESSION, cols, rows)?.status).toBe("fixed");
  }
  expect(resized).toEqual([]);
});

// --- D3 mutation controls: each mutant must turn a named D3 case red ---

const D3_SERVER_MUTANTS: ReadonlyArray<{ id: string; from: string; to: string; killer: string }> = [
  { id: "read-any-pane", from: 'if (readable.kind === "wrong-pane") return fail("wrong-pane");', to: "", killer: "is wrong-pane and never reaches the reader" },
  { id: "wire-keeps-provenance", from: 'if (entry?.kind !== "row" || !entry.row || !Array.isArray(entry.row.cells)) return null;', to: 'if (entry?.kind === "row") return entry as never;', killer: "walks three pages back" },
  { id: "cursor-unbounded", from: "&& v2Utf8.encode(cursor.token).length <= NEWARCH_V2_WIRE_LIMITS.cursorBytes", to: "", killer: "oversized cursor are typed errors" },
  { id: "late-reply-after-pane-change", from: 'if (this.newarchV2Readable(session, pane).kind !== "selected") return fail("wrong-pane");', to: "", killer: "pane changes before it lands" },
  { id: "reply-unchecked", from: 'return newarchV2ReplyMatches(message, reply) ? reply : v2ErrorReply(message, "wrong-pane");', to: "return reply;", killer: "another pane's row or cursor is refused" },
  { id: "unavailable-end-ok", from: 'if (ahead.kind === "end" && page.states.some(', to: "if (false && page.states.some(", killer: "never an ok page whose requested direction is end" },
  { id: "payload-unbounded", from: 'if (payloadBytes > request.maxBytes) return v2ErrorReply(message, "bounded-read");', to: "", killer: "exceed the wire page bound" },
];

test.skipIf(process.env.D3_MUTANT_WS_MUX !== undefined)("D3 mutation controls: every server mutant is killed by its own case", () => {
  const source = new URL("../src/ws-mux.ts", import.meta.url).pathname;
  const mutant = new URL("../src/ws-mux.d3mutant.ts", import.meta.url).pathname;
  const original = readFileSync(source, "utf8");
  const run = (module: string) => spawnSync(process.execPath, ["test", new URL(import.meta.url).pathname, "-t", "D3"], {
    env: { ...process.env, D3_MUTANT_WS_MUX: module }, encoding: "utf8", timeout: 120_000,
  });
  const lines: string[] = [];
  try {
    writeFileSync(mutant, original);
    const control = run(mutant);
    lines.push(`D3-MUTANT control exit=${control.status}`);
    expect(control.status).toBe(0);
    for (const m of D3_SERVER_MUTANTS) {
      expect(original.split(m.from).length - 1).toBe(1);
      writeFileSync(mutant, original.replace(m.from, m.to));
      const result = run(mutant);
      const out = `${result.stdout}${result.stderr}`;
      const killed = out.split("\n").filter(line => line.startsWith("(fail)")).map(line => line.replace(/ \[[^\]]*\]$/, ""));
      lines.push(`D3-MUTANT ${m.id} exit=${result.status} killed=${JSON.stringify(killed)}`);
      expect(result.status).toBe(1);
      expect(out).not.toContain("SyntaxError");
      expect(killed.some(line => line.includes(m.killer))).toBe(true);
    }
  } finally {
    rmSync(mutant, { force: true });
    console.log(lines.join("\n"));
  }
}, 900_000);
