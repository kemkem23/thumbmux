import { describe, expect, test } from "bun:test";
import { createBunTmuxDriver } from "../src/bun-driver";
import { TmuxWsMux } from "../src/ws-mux";

type FakeProcess = {
  exitCode: number;
  stdout: { toString(): string };
  stderr: { toString(): string };
};

function successfulProcess(stdout: string): FakeProcess {
  return {
    exitCode: 0,
    stdout: { toString: () => stdout },
    stderr: { toString: () => "" },
  };
}

class FakeWS {
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
    return data.length;
  }

  sessionListFrames(): Array<{ channel: string; type: string; data: string }> {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((frame) => frame.channel === "__sessions" && frame.type === "sessions");
  }
}

describe("default Bun driver session-list activity", () => {
  test("reuses the poll activity sample in __sessions without another activity call", async () => {
    const originalSpawnSync = Bun.spawnSync;
    const tmuxCalls: string[][] = [];
    Bun.spawnSync = ((command: string[]) => {
      tmuxCalls.push(command);
      if (command[1] === "list-sessions") {
        return successfulProcess(
          "alpha|1700000000|2|1\nbeta|1700000001|1|0\n",
        );
      }
      if (command[1] === "list-windows") {
        return successfulProcess(
          "alpha|1700000100\nalpha|1700000250\nbeta|1700000200\n",
        );
      }
      throw new Error(`unexpected tmux call: ${command.join(" ")}`);
    }) as typeof Bun.spawnSync;

    const driver = createBunTmuxDriver();
    const getSessionActivity = driver.getSessionActivity.bind(driver);
    let activityMethodCalls = 0;
    let sampledActivity = new Map<string, number>();
    driver.getSessionActivity = () => {
      activityMethodCalls += 1;
      sampledActivity = getSessionActivity();
      return sampledActivity;
    };

    const mux = new TmuxWsMux({
      driver,
      pollNormalMs: 60_000,
      sessionListIntervalMs: 60_000,
    });
    const ws = new FakeWS();

    try {
      mux.subscribeSessions(ws);
      await (mux as any).poll();

      expect(activityMethodCalls).toBe(1);
      expect(tmuxCalls.filter((call) => call[1] === "list-windows")).toHaveLength(1);

      const frame = ws.sessionListFrames().at(-1)!;
      const items = JSON.parse(frame.data) as Array<{ name: string; activityAt?: unknown }>;
      expect(items).toHaveLength(sampledActivity.size);
      expect(items.every((item) => typeof item.activityAt === "number")).toBe(true);
      for (const item of items) {
        expect(item.activityAt).toBe(sampledActivity.get(item.name));
      }
    } finally {
      mux.stop();
      Bun.spawnSync = originalSpawnSync;
    }
  });
});
