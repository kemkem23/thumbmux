import { describe, expect, test } from "bun:test";
import { createBunTmuxDriver } from "../src/bun-driver";

type SpawnCall = {
  command: string[];
  options: Record<string, unknown> | undefined;
};

function successProcess() {
  return {
    exitCode: 0,
    stdout: { toString: () => "" },
    stderr: { toString: () => "" },
  } as any;
}

function withSpawnStub(stub: (command: string[], options?: Record<string, unknown>) => any, run: () => void) {
  const original = Bun.spawnSync;
  Bun.spawnSync = stub as typeof Bun.spawnSync;
  try {
    run();
  } finally {
    Bun.spawnSync = original;
  }
}

describe("Bun tmux driver input delivery", () => {
  test("keeps ordinary input on the literal send-keys fast path", () => {
    const calls: SpawnCall[] = [];
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      return successProcess();
    }, () => createBunTmuxDriver().sendKeys("pane-a", "plain input"));

    expect(calls).toEqual([{
      command: ["tmux", "send-keys", "-t", "pane-a", "-l", "--", "plain input"],
      options: undefined,
    }]);
  });

  test("loads large Unicode input from stdin, pastes to its target, and removes the buffer", () => {
    const calls: SpawnCall[] = [];
    const data = `start\n${"🙂".repeat(2049)}\u0000end`;
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      return successProcess();
    }, () => createBunTmuxDriver().sendKeys("pane-large", data));

    expect(calls).toHaveLength(3);
    const [load, paste, cleanup] = calls;
    expect(load!.command.slice(0, 3)).toEqual(["tmux", "load-buffer", "-b"]);
    const bufferName = load!.command[3]!;
    expect(bufferName).toMatch(/^thumbmux-input-/);
    expect(load!.command.slice(4)).toEqual(["-"]);
    expect(Array.from(load!.options!.stdin as Uint8Array)).toEqual(Array.from(new TextEncoder().encode(data)));
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "pane-large"]);
    expect(cleanup!.command).toEqual(["tmux", "delete-buffer", "-b", bufferName]);
  });

  test("routes a short NUL key through stdin and preserves its bytes", () => {
    const calls: SpawnCall[] = [];
    const data = "a\0b";
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      return successProcess();
    }, () => createBunTmuxDriver().sendKeys("pane-nul", data));

    expect(calls).toHaveLength(3);
    const [load, paste, cleanup] = calls;
    expect(load!.command.slice(0, 3)).toEqual(["tmux", "load-buffer", "-b"]);
    const bufferName = load!.command[3]!;
    expect(load!.command.slice(4)).toEqual(["-"]);
    expect(Array.from(load!.options!.stdin as Uint8Array)).toEqual([0x61, 0x00, 0x62]);
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "pane-nul"]);
    expect(cleanup!.command).toEqual(["tmux", "delete-buffer", "-b", bufferName]);
  });

  test("cleans the per-call buffer when paste fails", () => {
    const calls: SpawnCall[] = [];
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      if (command[1] === "paste-buffer") {
        return { ...successProcess(), exitCode: 1, stderr: { toString: () => "paste failed" } };
      }
      return successProcess();
    }, () => {
      expect(() => createBunTmuxDriver().sendKeys("pane-failure", "x".repeat(8193))).toThrow("paste failed");
    });

    expect(calls.at(-1)!.command.slice(0, 2)).toEqual(["tmux", "delete-buffer"]);
  });
});
