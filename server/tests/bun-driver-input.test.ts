import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBunTmuxDriver } from "../src/bun-driver";
import {
  createInputRouter,
  type InputMetadata,
  type PaneInputLease,
} from "../src/input-router";

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
      "A❤️ B\nworld\n\n";
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
      expect(combined.content).toContain("A❤️ B");
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
    }
  });

  test("capturePane preserves raw tmux capture bytes without guessing filler provenance", async () => {
    const rawCapture = "A❤️ B\n";
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => ({
      stdout: new Response(rawCapture).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as typeof Bun.spawn;
    try {
      expect(await createBunTmuxDriver().capturePane("s", { currentPaneOnly: true }))
        .toBe(rawCapture);
    } finally {
      Bun.spawn = originalSpawn;
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
      command: ["tmux", "send-keys", "-t", "=pane-a:0.0", "-l", "--", "plain input"],
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
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "=pane-large:0.0"]);
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
    expect(paste!.command).toEqual(["tmux", "paste-buffer", "-d", "-r", "-b", bufferName, "-t", "=pane-nul:0.0"]);
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

describe("NEWARCH L5 exact-pane input router", () => {
  const lease: PaneInputLease = { sessionId: "$7", paneId: "%42", generation: "birth-9" };

  function fixture(options: { sendThrows?: boolean; updateThrows?: boolean } = {}) {
    const metadata: InputMetadata[] = [];
    const claimed = new Set<string>();
    const sends: Array<{ paneId: string; data: string }> = [];
    const gaps: InputMetadata[] = [];
    const router = createInputRouter({
      currentLease: () => lease,
      sendExactPane: (paneId, data) => {
        sends.push({ paneId, data });
        if (options.sendThrows) throw new Error("ambiguous tmux handoff");
      },
      receipts: {
        claim(value) {
          if (claimed.has(value.eventId)) return false;
          claimed.add(value.eventId);
          metadata.push(value);
          return true;
        },
        update(value) {
          if (options.updateThrows) throw new Error("history unavailable");
          metadata.push(value);
        },
        auditGap(value) { gaps.push(value); },
      },
    });
    return { router, metadata, sends, gaps };
  }

  test("routes text and control bytes to the exact leased pane", () => {
    const f = fixture();
    for (const [clientSequence, kind, data] of [
      [1, "text", "สวัสดี"], [2, "control", "\x03"], [3, "submit", "\r"],
    ] as const) {
      expect(f.router.route({ eventId: `evt-${clientSequence}`, clientSequence, lease, kind, data }).status)
        .toBe("sent_to_tmux");
    }
    expect(f.sends).toEqual([
      { paneId: "%42", data: "สวัสดี" },
      { paneId: "%42", data: "\x03" },
      { paneId: "%42", data: "\r" },
    ]);
  });

  test("rejects a stale lifecycle lease before delivery or receipt claim", () => {
    const f = fixture();
    const stale = { ...lease, generation: "old-birth" };
    const result = f.router.route({ eventId: "stale", clientSequence: 1, lease: stale, kind: "text", data: "x" });
    expect(result.status).toBe("rejected_stale_lease");
    expect(f.sends).toEqual([]);
    expect(f.metadata).toEqual([]);
  });

  test("claims before delivery and never auto-resends a pending/duplicate event", () => {
    const f = fixture({ sendThrows: true });
    const operation = { eventId: "pending-crash", clientSequence: 8, lease, kind: "control" as const, data: "\x1b" };
    expect(f.router.route(operation).status).toBe("delivery_unknown");
    expect(f.router.route(operation).status).toBe("duplicate");
    expect(f.sends).toHaveLength(1);
  });

  test("records an audit gap after delivery without replaying input", () => {
    const f = fixture({ updateThrows: true });
    const result = f.router.route({ eventId: "gap", clientSequence: 9, lease, kind: "text", data: "once" });
    expect(result.status).toBe("sent_to_tmux");
    expect(f.sends).toHaveLength(1);
    expect(f.gaps).toHaveLength(1);
  });

  test("metadata contains the test secret zero times", () => {
    const secret = "L5-SECRET-do-not-record-9c2a";
    const f = fixture();
    f.router.route({ eventId: "secret-event", clientSequence: 10, lease, kind: "text", data: secret });
    expect(JSON.stringify(f.metadata).split(secret)).toHaveLength(1);
    expect(f.metadata.at(-1)).toMatchObject({ byteLength: new TextEncoder().encode(secret).byteLength });
    expect(Object.keys(f.metadata.at(-1)!)).not.toContain("data");
  });

  test("preserves a 64 KiB paste as one ordered exact-pane operation", () => {
    const f = fixture();
    const data = "ก".repeat(21_845) + "x";
    expect(new TextEncoder().encode(data).byteLength).toBe(65_536);
    f.router.route({ eventId: "paste-64k", clientSequence: 11, lease, kind: "paste", data });
    expect(f.sends).toEqual([{ paneId: "%42", data }]);
  });
});
