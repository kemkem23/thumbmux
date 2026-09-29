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

// Deferred tmux completion: no real subprocess or wall-clock sleep is needed.
test("H2 slow activity poll leaves frame tasks runnable and coalesces ticks", async () => {
  const originalSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  let finish!: (code: number) => void;
  let calls = 0;
  let syncCalls = 0;
  Bun.spawnSync = (() => { syncCalls++; return successfulProcess("alpha|10\n"); }) as any;
  Bun.spawn = (() => {
    calls++;
    return { stdout: new Blob(["alpha|10\n"]).stream(), stderr: new Blob([]).stream(),
      exited: new Promise<number>((resolve) => { finish = resolve; }), kill() {} };
  }) as any;
  const driver = createBunTmuxDriver() as any;
  const mux = new TmuxWsMux({ driver });
  try {
    await (mux as any).poll();
    let frames = 0;
    await new Promise<void>((resolve) => setTimeout(() => { frames++; resolve(); }, 0));
    for (let i = 0; i < 20; i++) await (mux as any).poll();
    console.log(`H2_FRAME sync=${syncCalls} async=${calls} framesBeforeCompletion=${frames}`);
    expect(syncCalls).toBe(0);
    expect(calls).toBe(1);
    expect(frames).toBe(1);
    expect(driver.activityPoll.status().pending).toBe(true);
    finish(0);
    await driver.activityPoll.settled();
    expect(driver.activityPoll.peek().get("alpha")).toBe(10);
    expect(driver.activityPoll.status().ageMs).toBeGreaterThanOrEqual(0);
  } finally {
    driver.activityPoll?.stop();
    mux.stop();
    Bun.spawnSync = originalSync;
    Bun.spawn = originalSpawn;
  }
});

test("H2 cancel fences out-of-order completion, failure preserves last success, stop settles", async () => {
  const originalSpawn = Bun.spawn;
  const pending: Array<{ finish: (code: number) => void; killed: boolean }> = [];
  Bun.spawn = (() => {
    const entry = { finish: (_code: number) => {}, killed: false };
    pending.push(entry);
    return { stdout: new Blob([`${pending.length === 1 ? "old" : "new"}|${pending.length}\n`]).stream(),
      stderr: new Blob(["sample failed"]).stream(),
      exited: new Promise<number>((resolve) => { entry.finish = resolve; }),
      kill() { entry.killed = true; } };
  }) as any;
  const driver = createBunTmuxDriver() as any;
  try {
    const poll = driver.activityPoll;
    expect(poll).toBeDefined();
    driver.getSessionActivity();
    const cancelled = poll.settled();
    poll.cancel();
    await cancelled;
    expect(pending[0]!.killed).toBe(true);
    driver.getSessionActivity();
    pending[1]!.finish(0);
    await poll.settled();
    pending[0]!.finish(0);
    await Bun.sleep(0);
    expect([...poll.peek()]).toEqual([["new", 2]]);
    driver.getSessionActivity();
    pending[2]!.finish(1);
    await poll.settled();
    expect([...poll.peek()]).toEqual([["new", 2]]);
    expect(poll.status().error).toContain("sample failed");
    expect(driver.getSessionActivity().size).toBe(0); // unknown forces safe capture
    const stopped = poll.settled();
    poll.stop();
    await stopped;
    expect(pending[3]!.killed).toBe(true);
    driver.getSessionActivity();
    expect(pending).toHaveLength(4);
  } finally {
    driver.activityPoll?.stop();
    Bun.spawn = originalSpawn;
  }
});
