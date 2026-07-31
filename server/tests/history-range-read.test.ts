import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxClientMessage, SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive } from "../src/history-archive";
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

test("a throwing readAfter still returns the no-archive page and logs the failure", () => {
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
  const noArchiveMux = new TmuxWsMux({ driver: fakeDriver() });
  const ws = new FakeWS();
  const noArchiveWs = new FakeWS();
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
    noArchiveMux.handleMessage(request, noArchiveWs);

    expect(ws.sent).toEqual(noArchiveWs.sent);
    expect(ws.historyPages()).toEqual([{ lines: [], startLine: null, hasMore: false }]);
    expect(thrown).toBeUndefined();
    expect(logs).toEqual([[
      `[thumbmux-mux] archive readAfter error for "${SESSION}":`,
      "readAfter exploded",
    ]]);
  } finally {
    mux.stop();
    noArchiveMux.stop();
  }
});

test("a throwing readBefore still returns the no-archive page and logs the failure", () => {
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
  const noArchiveMux = new TmuxWsMux({ driver: fakeDriver() });
  const ws = new FakeWS();
  const noArchiveWs = new FakeWS();
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
    noArchiveMux.handleMessage(request, noArchiveWs);

    expect(ws.sent).toEqual(noArchiveWs.sent);
    expect(ws.historyPages()).toEqual([{ lines: [], startLine: null, hasMore: false }]);
    expect(thrown).toBeUndefined();
    expect(logs).toEqual([[
      `[thumbmux-mux] archive readBefore error for "${SESSION}":`,
      "readBefore exploded",
    ]]);
  } finally {
    mux.stop();
    noArchiveMux.stop();
  }
});

for (const direction of ["before", "after"] as const) {
  const method = direction === "before" ? "readBefore" : "readAfter";

  test(`a throwing ${method} and throwing logger still produce exactly one empty history frame`, () => {
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
      expect(ws.historyPages()).toEqual([{ lines: [], startLine: null, hasMore: false }]);
      expect(thrown).toBeUndefined();
    } finally {
      mux.stop();
    }
  });
}
