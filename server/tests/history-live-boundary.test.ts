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
