import { expect, test } from "bun:test";
import type { MuxHistoryBoundary, NewarchV2Incident, SessionListItem } from "../../core/src/protocol";
import { NewarchV2Display } from "../src/display-engine";
import type { V2HistoryPage, V2HistoryReader } from "../src/stream-contract";
import {
  TmuxWsMux,
  type HistoryArchiveLike,
  type TmuxDriver,
} from "../src/ws-mux";

const SESSION = "durable-seam";

class FakeWS {
  sent: string[] = [];
  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }
  outputFrames(): Array<Record<string, any>> {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.type === "output" || frame.type === "delta");
  }
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

test("durable boundary rides every frame and archive-only growth pushes output", async () => {
  const content = Array.from({ length: 80 }, (_, index) => `screen-${index}`).join("\n");
  let activity = 0;
  let boundary: MuxHistoryBoundary = {
    generation: "generation-1",
    liveStartLine: 40_000,
    walSequence: "100",
    walOffset: 8_000,
  };
  const driver: TmuxDriver = {
    listSessions: () => [{ name: SESSION }] as SessionListItem[],
    capturePane: async () => content,
    captureWithCursor: async () => ({
      content,
      cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
      trailingBlanks: 0,
    }),
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, ++activity]]),
    getHistoryLimit: () => 50_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (value) => value,
  };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, snapshot) => ({ liveContent: snapshot }),
    readBefore: () => ({
      lines: [], startLine: null, endLine: 0, hasMore: false, totalArchivedLines: 0,
    }),
    boundary: () => ({ ...boundary }),
    renameSession: () => {},
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver,
    archive,
    profile: () => ({ resize: false, currentPaneOnly: false, archive: true }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
  });
  const ws = new FakeWS();
  try {
    mux.subscribe(SESSION, ws, undefined, { delta: true });
    await until(() => ws.outputFrames().length >= 1);
    expect(ws.outputFrames()[0]).toMatchObject({ type: "output", boundary });

    const before = ws.outputFrames().length;
    boundary = {
      ...boundary,
      liveStartLine: boundary.liveStartLine + 25,
      walSequence: "125",
      walOffset: boundary.walOffset + 2_000,
    };
    await until(() => ws.outputFrames().length > before);
    const archiveOnlyUpdate = ws.outputFrames().at(-1)!;
    expect(archiveOnlyUpdate.boundary).toEqual(boundary);
    expect(archiveOnlyUpdate.type).not.toBe("cursor");

    // An idle capture with the same content and same boundary dedupes again.
    const stableCount = ws.outputFrames().length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ws.outputFrames()).toHaveLength(stableCount);
  } finally {
    mux.stop();
  }
});

test("a boundary advancing during async capture retries instead of publishing a mixed seam", async () => {
  let boundary: MuxHistoryBoundary = {
    generation: "generation-1",
    liveStartLine: 100,
    walSequence: "10",
    walOffset: 1_000,
  };
  let captureCount = 0;
  let releaseFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const driver: TmuxDriver = {
    listSessions: () => [] as never,
    capturePane: async () => "unused",
    captureWithCursor: async () => {
      captureCount += 1;
      if (captureCount === 1) await firstCapture;
      return {
        content: captureCount === 1 ? "stale-screen" : "current-screen",
        cursor: null,
        trailingBlanks: 0,
      };
    },
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, captureCount]]),
    getHistoryLimit: () => 50_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (value) => value,
  };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, snapshot) => ({ liveContent: snapshot }),
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    boundary: () => ({ ...boundary }),
    renameSession: () => {},
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver,
    archive,
    profile: () => ({ resize: false, currentPaneOnly: false, archive: true }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
  });
  const ws = new FakeWS();
  try {
    mux.subscribe(SESSION, ws, undefined, { delta: true });
    await until(() => captureCount === 1);
    boundary = {
      ...boundary,
      liveStartLine: 110,
      walSequence: "20",
      walOffset: 2_000,
    };
    releaseFirst();
    await until(() => ws.outputFrames().length === 1);
    expect(captureCount).toBeGreaterThanOrEqual(2);
    expect(ws.outputFrames()[0]).toMatchObject({
      type: "output",
      data: "current-screen",
      boundary,
    });
    expect(ws.outputFrames().some((frame) => frame.data === "stale-screen")).toBe(false);
  } finally {
    mux.stop();
  }
});

test("an atomic archive token reaches ingest and a host reset keeps viewers attached", async () => {
  const boundary: MuxHistoryBoundary = {
    generation: "generation-token",
    liveStartLine: 42,
    walSequence: "9",
    walOffset: 900,
  };
  let content = "before-reset";
  let activity = 0;
  const tokens: Array<string | undefined> = [];
  const driver: TmuxDriver = {
    listSessions: () => [{ name: SESSION }] as SessionListItem[],
    capturePane: async () => content,
    captureWithCursor: async () => ({
      content,
      cursor: null,
      trailingBlanks: 0,
      archiveCaptureToken: `token:${content}`,
    }),
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, ++activity]]),
    getHistoryLimit: () => 50_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (value) => value,
  };
  const archive: HistoryArchiveLike = {
    ingestSnapshot: (_session, snapshot, options) => {
      tokens.push(options.captureToken);
      expect(options.captureToken).toBe(`token:${snapshot}`);
      return { liveContent: snapshot };
    },
    readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
    boundary: () => ({ ...boundary }),
    renameSession: () => {},
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver,
    archive,
    profile: () => ({ resize: false, currentPaneOnly: false, archive: true }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
  });
  const ws = new FakeWS();
  try {
    mux.subscribe(SESSION, ws);
    await until(() => ws.outputFrames().length === 1);
    expect(ws.outputFrames()[0]).toMatchObject({ data: "before-reset", boundary });

    content = "after-reset";
    expect(mux.resetSessionOutput(SESSION)).toBe(1);
    await until(() => ws.outputFrames().length === 2);
    expect(ws.outputFrames()[1]).toMatchObject({
      type: "output",
      data: "after-reset",
      reset: "resync",
      boundary,
    });
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  } finally {
    mux.stop();
  }
});

const V2_PANE = { serverIdentity: "srv", paneId: "pane-a", birthGeneration: 1 };
const V2_GEOMETRY = {
  policy: "fixed-at-birth" as const, columns: 100, rows: 40,
  configVersion: "q22-default-1", panesPerWindow: 1 as const,
};

function stoppedIncident(): NewarchV2Incident {
  return {
    schema: "newarch-v2", incidentId: "incident-before-ack", pane: V2_PANE, reason: "unverified-restart",
    frontier: null, affected: { after: null, through: null },
    openedAtWallMs: Date.UTC(2026, 9, 4, 4, 5, 6), openedAtMonoMs: 1, clockEpoch: "epoch-1",
    collecting: false, missing: { countKind: "unknown", missingCount: null },
    ruleVersion: "explicit-gap@1", configVersion: "q22-default-1", geometry: V2_GEOMETRY,
    revision: 1, sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null,
    action: "gap-and-stop", evidence: null,
  };
}

test("NEWARCH v2 D: an incident before the first row is readable with no live pane", async () => {
  const incident = stoppedIncident();
  const page: V2HistoryPage = {
    schema: "newarch-v2", pane: V2_PANE, revision: 1, payloadBytes: 1,
    entries: [{ kind: "incident", incident }],
    states: [{ kind: "incident", incident }],
    before: { kind: "end" }, after: { kind: "end" },
  };
  let reads = 0;
  const reader: V2HistoryReader = {
    owner: () => ({ status: "error", code: "integrity", message: "unused" }),
    receipt: () => ({ status: "error", code: "integrity", message: "unused" }),
    checkpoint: () => ({ status: "error", code: "integrity", message: "unused" }),
    panes: () => ({ status: "ok", value: { panes: [], next: null } }),
    sessionOwner: () => ({ status: "ok", value: null }),
    sealed: () => ({ status: "error", code: "integrity", message: "unused" }),
    export: () => ({ status: "error", code: "integrity", message: "unused" }),
    locator: () => ({ status: "error", code: "integrity", message: "unused" }),
    lastAudit: () => ({ status: "error", code: "integrity", message: "unused" }),
    page: async () => {
      reads += 1;
      return { status: "ok", value: page };
    },
  };
  const display = new NewarchV2Display(reader);
  const read = await display.page({
    schema: "newarch-v2", pane: V2_PANE, cursor: null, direction: "after", maxEntries: 10, maxBytes: 1000,
  });
  expect(reads).toBe(1);
  expect(read.status).toBe("ok");
  if (read.status !== "ok") return;
  expect(read.value.entries).toHaveLength(1);
  const entry = read.value.entries[0];
  expect(entry?.kind).toBe("incident");
  if (entry?.kind !== "incident") return;
  expect(entry.incident.frontier).toBeNull();
  expect(entry.incident.collecting).toBe(false);
  expect(entry.incident.reason).toBe("unverified-restart");
});
