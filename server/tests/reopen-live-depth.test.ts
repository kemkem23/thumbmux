import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionListItem } from "../../core/src/protocol";
import { FileHistoryArchive, TmuxWsMux, type TmuxDriver } from "../src/index";

const SESSION = "reopen-live-depth";
const LIVE = 1000;
const TOTAL = 6000;

class FakeWS {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    return 1;
  }
  hasOutput() {
    return this.sent.some((frame) => frame.includes('"type":"output"'));
  }
}

function item(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

async function until(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met before timeout");
}

const harnesses: Array<{ mux: TmuxWsMux<FakeWS>; root: string }> = [];

afterEach(() => {
  for (const { mux, root } of harnesses.splice(0)) {
    mux.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("archive-seeded reopen capture depth", () => {
  test("reopens at full liveLineLimit depth, not the INITIAL -250 bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "reopen-depth-"));
    const lines = Array.from({ length: TOTAL }, (_, index) => `L${String(index + 1).padStart(5, "0")}`);
    const captureStarts: number[] = [];
    const driver: TmuxDriver = {
      listSessions: () => [item(SESSION)],
      capturePane: async (_session, opts) => {
        const start = opts.startLine ?? -LIVE;
        captureStarts.push(start);
        const from = start < 0 ? Math.max(0, lines.length + start) : start;
        return lines.slice(from).join("\n");
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, 1]]),
      getHistoryLimit: () => TOTAL,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (content) => content,
    };
    const mux = new TmuxWsMux<FakeWS>({
      driver,
      archive: new FileHistoryArchive({ root, maxLines: TOTAL }),
      liveLineLimit: LIVE,
      pollNormalMs: 60_000,
      pollBurstMs: 60_000,
      burstDurationMs: 60_000,
      pollReconcileMs: 60_000,
    });
    harnesses.push({ mux, root });

    const first = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SESSION }, first);
    await until(() => first.hasOutput());
    await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
    expect((mux as any).archiveSeeded.has(SESSION)).toBe(true);

    mux.handleMessage({ type: "unsubscribe", session: SESSION }, first);
    captureStarts.length = 0;

    const reopened = new FakeWS();
    mux.handleMessage({ type: "subscribe", session: SESSION }, reopened);
    await until(() => reopened.hasOutput());
    await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));

    // Pre-fix bug used INITIAL (-250) here, opening a 710-line seam against
    // an archive that ends at total-liveLineLimit.
    expect(captureStarts[0]).toBe(-LIVE);
    expect(captureStarts).not.toContain(-250);
  });
});
