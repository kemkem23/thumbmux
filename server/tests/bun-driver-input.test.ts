import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("Bun tmux driver pane screen status (FS1)", () => {
  test("display-message format samples alternate_on + mouse flags in the same invocation", () => {
    const src = readFileSync(join(import.meta.dir, "../src/bun-driver.ts"), "utf8");
    // Both the standalone cursor query and the combined capture path must
    // include the three flags on the EXISTING format string — never a second
    // tmux call. Shared as PANE_STATUS_FMT so both paths cannot drift.
    const format =
      "#{cursor_x}|#{cursor_y}|#{pane_height}|#{cursor_flag}|#{pane_in_mode}|#{alternate_on}|#{mouse_sgr_flag}|#{mouse_any_flag}";
    expect(src).toContain(format);
    expect(src).toMatch(/const PANE_STATUS_FMT\s*=/);
    // getCursor + captureWithCursor both reference the shared constant.
    const statusRefs = src.match(/PANE_STATUS_FMT/g);
    expect((statusRefs?.length ?? 0)).toBeGreaterThanOrEqual(3); // def + 2 uses
    // Guard against a regression that splits screen sampling into its own call
    // (a second display-message that only asks for alt/mouse).
    expect(src).not.toMatch(
      /display-message[\s\S]{0,200}#\{alternate_on\}[\s\S]{0,80}display-message[\s\S]{0,200}#\{cursor_x\}/,
    );
  });

  test("captureWithCursor returns a MuxPaneScreen from the combined status line", async () => {
    const status =
      "3|1|24|1|0|1|1|0\n" + // x|y|h|flag|in_mode|alt|mouseSgr|mouseAny
      "hello\nworld\n\n";
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    Bun.spawn = ((cmd: string[]) => {
      expect(cmd.slice(0, 2)).toEqual(["tmux", "display-message"]);
      expect(cmd.join(" ")).toContain("#{alternate_on}");
      expect(cmd.join(" ")).toContain("capture-pane");
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(status));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) { c.close(); },
        }),
        exited: Promise.resolve(0),
      } as any;
    }) as typeof Bun.spawn;
    try {
      const combined = await createBunTmuxDriver().captureWithCursor!("s", { currentPaneOnly: true });
      expect(combined.screen).toEqual({ alt: true, mouseSgr: true, mouseAny: false });
      expect(combined.cursor).toEqual({ x: 3, y: 1, paneHeight: 24, visible: true });
      expect(combined.content).toContain("hello");
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
    }
  });
});

describe("Bun tmux driver input delivery", () => {
  test("keeps ordinary input on the literal send-keys fast path", () => {
    const calls: SpawnCall[] = [];
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      return successProcess();
    }, () => createBunTmuxDriver().sendKeys("pane-a", "plain input"));

    expect(calls).toEqual([{
      command: ["tmux", "send-keys", "-t", "=pane-a:", "-l", "--", "plain input"],
      options: undefined,
    }]);
  });

  test("allows legacy tmux prefix and pattern resolution only when requested", () => {
    const calls: SpawnCall[] = [];
    withSpawnStub((command, options) => {
      calls.push({ command, options });
      return successProcess();
    }, () => createBunTmuxDriver({ targetMode: "legacy" }).sendKeys("pane-prefix", "plain input"));

    expect(calls[0]!.command).toEqual([
      "tmux", "send-keys", "-t", "pane-prefix", "-l", "--", "plain input",
    ]);
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
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "=pane-large:"]);
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
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "=pane-nul:"]);
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
