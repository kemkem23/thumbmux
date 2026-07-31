import { describe, expect, test } from "bun:test";
import {
  applyMuxDelta,
  splitMuxOutputData,
  type MuxFullOutputFrame,
} from "../../core/src/protocol";
import { TmuxWsMux, type TmuxDriver } from "../src/ws-mux";

const SESSION = "recording-hook-session";

type WireFrame = Record<string, any>;

class FakeWS {
  sent: string[] = [];

  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }

  frames(): WireFrame[] {
    return this.sent.map((data) => JSON.parse(data));
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

function reconstruct(frames: readonly WireFrame[]): MuxFullOutputFrame {
  let base: string[] | null = null;
  let latest: MuxFullOutputFrame | null = null;
  for (const frame of frames) {
    if (frame.channel !== SESSION) continue;
    if (frame.type === "output") {
      base = splitMuxOutputData(frame.data);
      latest = frame as MuxFullOutputFrame;
      continue;
    }
    if (frame.type === "delta") {
      if (!base) throw new Error("delta arrived before a full frame");
      const next = applyMuxDelta(base, frame);
      if (!next) throw new Error("invalid delta frame");
      base = next;
      latest = {
        channel: frame.channel,
        type: "output",
        data: next.join("\n"),
        ...(frame.cursor !== undefined ? { cursor: frame.cursor } : {}),
      };
    }
  }
  if (!latest || !base) throw new Error("no output state to reconstruct");
  return { ...latest, data: base.join("\n") };
}

function makeHarness(
  onOutput: (session: string, frame: MuxFullOutputFrame) => void,
  logError: (...args: unknown[]) => void = () => {},
) {
  let content = Array.from({ length: 80 }, (_, index) => `stable-${index}`).join("\n");
  let activity = 0;
  const cursor = { x: 2, y: 0, paneHeight: 1, visible: true };
  const driver: TmuxDriver = {
    listSessions: () => [],
    capturePane: async () => content,
    captureWithCursor: async () => ({
      content,
      cursor: { ...cursor },
      trailingBlanks: 0,
    }),
    sendKeys: () => {},
    getSessionActivity: () => new Map([[SESSION, ++activity]]),
    getHistoryLimit: () => 2_000,
    setSessionHistoryLimit: () => {},
    resizeWindow: () => {},
    hash: (value) => value,
  };
  const mux = new TmuxWsMux<FakeWS>({
    driver,
    hooks: { onOutput },
    logError,
    profile: () => ({ resize: false, currentPaneOnly: false, archive: false }),
    pollNormalMs: 10,
    pollReconcileMs: 10,
  });
  return {
    mux,
    cursor,
    setContent(next: string) {
      content = next;
    },
  };
}

describe("recording output hook", () => {
  test("receives canonical full snapshots for mux output, including delta and cursor-only delivery", async () => {
    const captured: Array<{ session: string; frame: MuxFullOutputFrame }> = [];
    const { mux, cursor, setContent } = makeHarness((session, frame) => {
      captured.push({ session, frame });
    });
    const ws = new FakeWS();

    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => captured.length >= 1 && ws.frames().some((frame) => frame.type === "output"));

      const changed = `${captured[0]!.frame.data}\nchanged-tail`;
      setContent(changed);
      await until(() => captured.length >= 2 && ws.frames().some((frame) => frame.type === "delta"));

      const afterContent = reconstruct(ws.frames());
      const capturedContent = captured.at(-1)!;
      expect(capturedContent.session).toBe(afterContent.channel);
      expect(capturedContent.frame.type).toBe("output");
      expect(capturedContent.frame.data).toBe(afterContent.data);
      expect(capturedContent.frame.cursor).toEqual(afterContent.cursor);

      const beforeCursorCaptureCount = captured.length;
      cursor.x = 9;
      await until(() => ws.frames().some((frame) => frame.type === "cursor" && frame.cursor?.col === 9));
      await until(() => captured.length > beforeCursorCaptureCount);

      const cursorWire = ws.frames().findLast((frame) => frame.type === "cursor");
      const cursorCapture = captured.at(-1)!.frame;
      expect(cursorCapture.type).toBe("output");
      expect(cursorCapture.data).toBe(reconstruct(ws.frames()).data);
      expect(cursorCapture.cursor).toEqual(cursorWire.cursor);
    } finally {
      mux.stop();
    }
  });

  test("a throwing output hook cannot interrupt delivery to any viewer", async () => {
    let hookCalls = 0;
    const { mux } = makeHarness(
      () => {
        hookCalls += 1;
        throw new Error("recorder unavailable");
      },
      () => {
        throw new Error("logger unavailable");
      },
    );
    const viewerA = new FakeWS();
    const viewerB = new FakeWS();

    try {
      mux.subscribe(SESSION, viewerA);
      mux.subscribe(SESSION, viewerB);
      await until(() => viewerA.frames().some((frame) => frame.type === "output"));
      await until(() => viewerB.frames().some((frame) => frame.type === "output"));

      const a = reconstruct(viewerA.frames());
      const b = reconstruct(viewerB.frames());
      expect(hookCalls).toBeGreaterThan(0);
      expect(a.data).toBe(b.data);
      expect(viewerA.frames().some((frame) => frame.type === "error")).toBe(false);
      expect(viewerB.frames().some((frame) => frame.type === "error")).toBe(false);
    } finally {
      mux.stop();
    }
  });
});
