import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive, TmuxWsMux, type TmuxDriver } from "../src/index";

const SESSION = "archive-subscription-seeding";
const HISTORY_LINE_COUNT = 600;
const LIVE_LINE_LIMIT = 40;
const TAIL_LINE_LIMIT = 10;

type HistoryPage = {
  lines: string[];
  startLine: number | null;
  hasMore: boolean;
};

class FakeWS {
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
    return 1;
  }

  historyPages(): HistoryPage[] {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.channel === SESSION && frame.type === "history")
      .map((frame) => JSON.parse(frame.data));
  }
}

function sessionListItem(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

const harnesses: Array<{ mux: TmuxWsMux<FakeWS>; root: string }> = [];

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-archive-subscription-test-"));
  const lines = Array.from(
    { length: HISTORY_LINE_COUNT },
    (_, index) => `captured-history-${index + 1}`,
  );
  const captureStarts: Array<number | undefined> = [];
  const driver: TmuxDriver = {
    listSessions: () => [sessionListItem(SESSION)],
    capturePane: async (_session, opts) => {
      captureStarts.push(opts.startLine);
      return lines.slice(opts.startLine ?? -LIVE_LINE_LIMIT).join("\n");
    },
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, 1]]),
    getHistoryLimit: () => HISTORY_LINE_COUNT,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (content) => content,
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver,
    archive: new FileHistoryArchive({ root, maxLines: HISTORY_LINE_COUNT }),
    liveLineLimit: LIVE_LINE_LIMIT,
    pollNormalMs: 60_000,
    pollBurstMs: 60_000,
    burstDurationMs: 60_000,
    pollReconcileMs: 60_000,
  });
  harnesses.push({ mux, root });
  return { mux, captureStarts };
}

async function waitForCaptureQueue(mux: TmuxWsMux<FakeWS>) {
  await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
}

async function subscribe(
  mux: TmuxWsMux<FakeWS>,
  ws: FakeWS,
  tail?: number,
) {
  mux.handleMessage({ type: "subscribe", session: SESSION, tail }, ws);
  await waitForCaptureQueue(mux);
}

function expandHistory(mux: TmuxWsMux<FakeWS>, ws: FakeWS): HistoryPage {
  mux.handleMessage({
    type: "history_expand",
    session: SESSION,
    beforeLine: null,
    limit: HISTORY_LINE_COUNT,
  }, ws);
  return ws.historyPages().at(-1)!;
}

afterEach(() => {
  for (const { mux, root } of harnesses.splice(0)) {
    mux.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("FileHistoryArchive subscription seeding", () => {
  test("tail -> unsubscribe -> full seeds history without a thumbnail full capture", async () => {
    const { mux, captureStarts } = makeHarness();
    const viewer = new FakeWS();

    await subscribe(mux, viewer, TAIL_LINE_LIMIT);
    expect(captureStarts.filter((start) => start === -HISTORY_LINE_COUNT)).toHaveLength(0);

    mux.handleMessage({ type: "unsubscribe", session: SESSION }, viewer);
    await subscribe(mux, viewer);

    expect(expandHistory(mux, viewer).lines.length).toBeGreaterThan(0);
    expect(captureStarts.filter((start) => start === -HISTORY_LINE_COUNT)).toHaveLength(1);
  });

  test("full -> unsubscribe -> tail -> full keeps the already-seeded history", async () => {
    const { mux, captureStarts } = makeHarness();
    const firstFull = new FakeWS();
    const reopened = new FakeWS();

    await subscribe(mux, firstFull);
    mux.handleMessage({ type: "unsubscribe", session: SESSION }, firstFull);
    await subscribe(mux, reopened, TAIL_LINE_LIMIT);
    await subscribe(mux, reopened);

    expect(expandHistory(mux, reopened).lines.length).toBeGreaterThan(0);
    expect(captureStarts.filter((start) => start === -HISTORY_LINE_COUNT)).toHaveLength(1);
  });

  test("mixed tail and full viewers seed history once for the shared session", async () => {
    const { mux, captureStarts } = makeHarness();
    const thumbnail = new FakeWS();
    const full = new FakeWS();

    await subscribe(mux, thumbnail, TAIL_LINE_LIMIT);
    await subscribe(mux, full);

    expect(expandHistory(mux, full).lines.length).toBeGreaterThan(0);
    expect(captureStarts.filter((start) => start === -HISTORY_LINE_COUNT)).toHaveLength(1);
  });
});
