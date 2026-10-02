import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxClientMessage, SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive } from "../src/history-archive";
import { StreamDisplayEngine } from "../src/display-engine";
import { STREAM_BUDGET, type CaptureEngine, type HistoryEngine, type HistoryPage, type LiveFrame, type ReadView, type StreamIdentity, type ViewerRoute } from "../src/stream-contract";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";

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
