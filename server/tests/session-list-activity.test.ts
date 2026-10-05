import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const originalSpawn = Bun.spawn;
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

    Bun.spawn = ((command: string[]) => {
      const result = Bun.spawnSync(command);
      return { stdout: new Blob([result.stdout.toString()]).stream(), stderr: new Blob([]).stream(),
        exited: Promise.resolve(result.exitCode), kill() {} };
    }) as any;
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
      await driver.activityPoll.settled();
      sampledActivity = driver.activityPoll.peek();
      mux.broadcastSessionList();

      expect(activityMethodCalls).toBe(1);
      expect(tmuxCalls.filter((call) => call[1] === "list-windows")).toHaveLength(1);

      const count = ws.sessionListFrames().length;
      await Bun.sleep(0);
      mux.broadcastSessionList();
      expect(ws.sessionListFrames()).toHaveLength(count); // age diagnostics must not break dedupe
      const frame = ws.sessionListFrames().at(-1)!;
      const items = JSON.parse(frame.data) as Array<{ name: string; activityAt?: unknown }>;
      expect(items).toHaveLength(sampledActivity.size);
      expect(items.every((item) => typeof item.activityAt === "number")).toBe(true);
      for (const item of items) {
        expect(item.activityAt).toBe(sampledActivity.get(item.name));
      }
    } finally {
      driver.activityPoll.stop();
      mux.stop();
      Bun.spawn = originalSpawn;
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
  // Isolate the per-tick activity wiring from the separate inventory provider.
  mux.setSessionListProvider(() => []);
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
    expect([...driver.getSessionActivity()]).toEqual([["new", 2]]);
    pending[2]!.finish(1);
    await poll.settled();
    expect([...poll.peek()]).toEqual([["new", 2]]);
    expect(poll.status().error).toContain("sample failed");
    expect(driver.getSessionActivity().size).toBe(0); // unknown forces safe capture
    const stopped = poll.settled();
    poll.stop();
    await stopped;
    expect(pending[3]!.killed).toBe(true);
    pending[3]!.finish(0);
    await Bun.sleep(0);
    expect([...poll.peek()]).toEqual([["new", 2]]);
    driver.getSessionActivity();
    expect(pending).toHaveLength(4);
  } finally {
    driver.activityPoll?.stop();
    Bun.spawn = originalSpawn;
  }
});


test("H2 stale success and rejection cannot cross an invalidated generation", async () => {
  const { createActivityPoll } = await import("../src/bun-driver");
  const pending: Array<{ resolve: (value: string) => void; reject: (cause: Error) => void }> = [];
  const poll = createActivityPoll(() => "", () => new Promise<string>((resolve, reject) => {
    pending.push({ resolve, reject }); // deliberately ignores abort
  }));
  poll.refresh();
  const first = poll.settled();
  poll.invalidate();
  await first;
  poll.refresh();
  pending[1]!.resolve("renamed");
  await poll.settled();
  pending[0]!.resolve("old-name");
  await Bun.sleep(0);
  expect(poll.peek()).toBe("renamed");
  poll.refresh();
  poll.invalidate();
  poll.refresh();
  pending[2]!.reject(new Error("old failure"));
  await Bun.sleep(0);
  expect(poll.status().pending).toBe(true);
  expect(poll.status().error).toBeNull();
  pending[3]!.resolve("replacement");
  await poll.settled();
  expect(poll.peek()).toBe("replacement");
  poll.stop();
});


test("H2 mux publishes a frame while its tmux activity child is still pending", async () => {
  const originalSpawn = Bun.spawn;
  let calls = 0;
  Bun.spawn = (() => {
    calls++;
    return { stdout: new Blob(["alpha|10"]).stream(), stderr: new Blob([]).stream(),
      exited: new Promise<number>(() => {}), kill() {} };
  }) as any;
  const driver = createBunTmuxDriver();
  driver.getHistoryLimit = () => 2000;
  driver.captureWithCursor = async () => ({ content: "H2-FRAME\n", cursor: null, trailingBlanks: 0 });
  const mux = new TmuxWsMux({ driver, profile: () => ({ resize: false, archive: false, currentPaneOnly: true }) });
  const ws = new FakeWS();
  mux.setSessionListProvider(() => []);
  try {
    driver.getSessionActivity();
    mux.subscribe("alpha", ws);
    await (mux as any).poll();
    expect(driver.activityPoll.status().pending).toBe(true);
    const frames = ws.sent.map((value) => JSON.parse(value)).filter((frame) => frame.type === "output");
    expect(frames.some((frame) => frame.data.includes("H2-FRAME"))).toBe(true);
    expect(calls).toBe(1);
    console.log(`H2_PUBLISH framesWhilePending=${frames.length} activityChildren=${calls}`);
  } finally {
    mux.stop();
    driver.activityPoll.stop();
    Bun.spawn = originalSpawn;
  }
});


test("H2 a failed pipe read kills the child before releasing the activity slot", async () => {
  const originalSpawn = Bun.spawn;
  let killed = false;
  Bun.spawn = (() => ({
    stdout: new ReadableStream({ start(controller) { controller.error(new Error("broken output pipe")); } }),
    stderr: new Blob([]).stream(), exited: new Promise<number>(() => {}),
    kill() { killed = true; },
  })) as any;
  const driver = createBunTmuxDriver();
  try {
    driver.getSessionActivity();
    await driver.activityPoll.settled();
    expect(killed).toBe(true);
    expect(driver.activityPoll.status().pending).toBe(false);
    expect(driver.activityPoll.status().error).toContain("broken output pipe");
  } finally {
    driver.activityPoll.stop();
    Bun.spawn = originalSpawn;
  }
});

// ── NEWARCH D2a: "attached" counts only real (non-control-mode) clients ──
// `#{session_attached}` is a client count that includes the S2 watcher's
// `tmux -C` control client. listSessions chains `list-clients` onto the same
// tmux call and subtracts only rows that are provably control clients.
function withListSessionsOutput(
  stdout: string,
  run: (driver: ReturnType<typeof createBunTmuxDriver>, calls: string[][]) => void,
  create: typeof createBunTmuxDriver = createBunTmuxDriver,
) {
  const originalSpawnSync = Bun.spawnSync;
  const calls: string[][] = [];
  Bun.spawnSync = ((command: string[]) => {
    calls.push(command);
    if (command[1] === "list-sessions") return successfulProcess(stdout);
    throw new Error(`unexpected tmux call: ${command.join(" ")}`);
  }) as typeof Bun.spawnSync;
  const driver = create();
  try {
    run(driver, calls);
  } finally {
    driver.activityPoll.stop();
    Bun.spawnSync = originalSpawnSync;
  }
}

function expectD2aDriverClientMix(create: typeof createBunTmuxDriver = createBunTmuxDriver) {
  withListSessionsOutput([
    "two-real|1700000000|1|2",
    "watch-only|1700000001|1|1",
    "both|1700000002|2|2",
    "nobody|1700000003|1|0",
    "client:0|two-real",
    "client:0|two-real",
    "client:1|watch-only",
    "client:0|both",
    "client:1|both",
    "",
  ].join("\n"), (driver, calls) => {
    const rows = driver.listSessions();
    console.log("D2A_DRIVER_SPAWNS_PER_LIST", calls.length, JSON.stringify(calls[0]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "tmux", "list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}",
      ";", "list-clients", "-F", "client:#{client_control_mode}|#{client_session}",
    ]);
    expect(rows.map((row) => [row.name, row.attached])).toEqual([
      ["two-real", true],
      ["watch-only", false],
      ["both", true],
      ["nobody", false],
    ]);
  }, create);
}

function expectD2aDriverUnreadableRows(create: typeof createBunTmuxDriver = createBunTmuxDriver) {
  withListSessionsOutput([
    "kept|1700000000|1|1",
    "over|1700000001|1|1",
    "client:",
    "client:1",
    "client:1|",
    "client:x|kept",
    "client:|kept",
    "client:1|ghost",
    "client:1|over",
    "client:1|over",
  ].join("\n"), (driver) => {
    expect(driver.listSessions().map((row) => [row.name, row.attached])).toEqual([
      ["kept", true],
      ["over", false],
    ]);
  }, create);
}

describe("D2a bun driver listSessions attachment", () => {
  test("two real clients, real+control, control-only and none — one tmux call", () => {
    expectD2aDriverClientMix();
  });

  test("with no client rows the rows keep their shape and every field", () => {
    withListSessionsOutput("alpha|1700000000|2|1\nbeta|1700000001|1|0\n", (driver) => {
      expect(driver.listSessions()).toEqual([
        { name: "alpha", created: "1700000000", windows: 2, attached: true, activityAt: 0 },
        { name: "beta", created: "1700000001", windows: 1, attached: false, activityAt: 0 },
      ]);
    });
  });

  test("unreadable, empty and foreign client rows never fail the list", () => {
    expectD2aDriverUnreadableRows();
  });

  // Each mutant removes one control-mode condition in a copy of bun-driver.ts
  // written next to the source inside the cage's own checkout, deleted in `finally`.
  test("mutation: every control-mode condition in listSessions is load-bearing", async () => {
    const source = join(import.meta.dir, "../src/bun-driver.ts");
    const original = readFileSync(source, "utf8");
    const mutants = [
      { name: "no-subtract", from: " - (controlClients.get(name!) ?? 0) > 0,", to: " > 0," },
      { name: "every-client-is-control", from: ' || rest.slice(0, separator) !== "1"', to: "" },
      { name: "client-rows-as-sessions", from: "rows.filter((line) => !line.startsWith(clientPrefix)).map(", to: "rows.map(" },
      { name: "no-list-clients", from: '          ";", "list-clients", "-F", `${clientPrefix}#{client_control_mode}|#{client_session}`,\n', to: "" },
      { name: "pre-d2a-equals-one", from: "(Number(attached) || 0) - (controlClients.get(name!) ?? 0) > 0,", to: 'attached === "1",' },
    ];
    const results: Array<{ mutant: string; killedBy: string[] }> = [];
    for (const mutant of mutants) {
      expect(original.split(mutant.from)).toHaveLength(2);
      const copy = join(import.meta.dir, `../src/bun-driver.d2a-mutant-${mutant.name}.ts`);
      writeFileSync(copy, original.replace(mutant.from, mutant.to));
      try {
        const mod = await import(copy) as typeof import("../src/bun-driver");
        const killedBy: string[] = [];
        const checks: Array<[string, () => void]> = [
          ["client-mix", () => expectD2aDriverClientMix(mod.createBunTmuxDriver)],
          ["unreadable-rows", () => expectD2aDriverUnreadableRows(mod.createBunTmuxDriver)],
        ];
        for (const [label, check] of checks) {
          try { check(); } catch { killedBy.push(label); }
        }
        results.push({ mutant: mutant.name, killedBy });
      } finally {
        rmSync(copy, { force: true });
      }
    }
    console.log("D2A_DRIVER_MUTANTS", JSON.stringify(results));
    expect(results.filter((result) => result.killedBy.length === 0)).toEqual([]);
  });
});

test("D2a real tmux: the driver reads a control-mode watcher alone as detached, a real client beside it as attached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d2a-driver-"));
  const socket = join(dir, "d2a-driver.sock");
  const env: Record<string, string> = { TERM: "xterm-256color" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "TMUX" && key !== "TMUX_PANE") env[key] = value;
  const nativeSpawn = Bun.spawn;
  const nativeSpawnSync = Bun.spawnSync;
  const t = (args: string[]) => {
    const result = nativeSpawnSync(["tmux", "-S", socket, "-f", "/dev/null", ...args], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const name = "d2a-watch";
  const children: Array<{ kill(signal?: number): void; exited: Promise<number> }> = [];
  const clientModes = () => t(["list-clients", "-t", `=${name}`, "-F", "#{client_control_mode}"])
    .trim().split("\n").filter(Boolean).sort().join(",");
  const rawAttached = () => t(["list-sessions", "-F", "#{session_name}|#{session_attached}"])
    .split("\n").find((row) => row.startsWith(`${name}|`))?.slice(name.length + 1);
  const waitForModes = async (want: string) => {
    const started = Date.now();
    while (clientModes() !== want) {
      if (Date.now() - started > 10_000) throw new Error(`clients never reached ${want}: ${clientModes()}`);
      await Bun.sleep(50);
    }
  };
  const driver = createBunTmuxDriver();
  try {
    t(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "env -i HOME=/tmp TERM=xterm-256color PS1='$ ' bash --norc --noprofile"]);
    // Route only the driver's list-sessions call to the private server.
    Bun.spawnSync = ((command: string[], options?: any) => command[1] === "list-sessions"
      ? nativeSpawnSync(["tmux", "-S", socket, ...command.slice(1)], { ...options, env })
      : nativeSpawnSync(command, options)) as typeof Bun.spawnSync;

    const watcher = nativeSpawn([
      "tmux", "-S", socket, "-C", "attach-session", "-t", `=${name}`, "-f", "ignore-size,read-only,no-output",
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    children.push(watcher);
    void new Response(watcher.stdout).arrayBuffer().catch(() => {});
    await waitForModes("1");
    const rawControlOnly = rawAttached();
    const controlOnly = driver.listSessions().find((row) => row.name === name);
    console.log("D2A_DRIVER_REAL_CONTROL_ONLY", JSON.stringify({ sessionAttached: rawControlOnly, row: controlOnly }));
    expect(rawControlOnly).toBe("1");
    expect(controlOnly?.attached).toBe(false);

    const viewer = nativeSpawn([
      "script", "-qfec", `tmux -S '${socket}' attach-session -t '=${name}'`, "/dev/null",
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    children.push(viewer);
    void new Response(viewer.stdout).arrayBuffer().catch(() => {});
    await waitForModes("0,1");
    const raw = rawAttached();
    const withViewer = driver.listSessions().find((row) => row.name === name);
    console.log("D2A_DRIVER_REAL_CONTROL_PLUS_REAL", JSON.stringify({ sessionAttached: raw, row: withViewer }));
    expect(raw).toBe("2");
    expect(withViewer?.attached).toBe(true);
  } finally {
    Bun.spawnSync = nativeSpawnSync;
    driver.activityPoll.stop();
    for (const child of children) {
      try { child.kill(9); } catch { /* already exited */ }
      await child.exited.catch(() => {});
    }
    nativeSpawnSync(["tmux", "-S", socket, "kill-server"], { env });
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// ── D2a debt: a session name containing "|" ──
// The trailing created/windows/attached fields are numeric, so they are taken
// off the END of the row and the rest is the name — the same rule as
// parseMuxSampleLine in tmux-mux.ts and the window-activity poll above.
function expectPipeNameDriverRows(create: typeof createBunTmuxDriver = createBunTmuxDriver) {
  withListSessionsOutput([
    "a|b|1700000000|2|1",
    "a|1700000001|1|1",
    "x||y|1700000002|3|0",
    "client:0|a|b",
    "client:1|a",
    "",
  ].join("\n"), (driver) => {
    expect(driver.listSessions()).toEqual([
      { name: "a|b", created: "1700000000", windows: 2, attached: true, activityAt: 0 },
      { name: "a", created: "1700000001", windows: 1, attached: false, activityAt: 0 },
      { name: "x||y", created: "1700000002", windows: 3, attached: false, activityAt: 0 },
    ]);
  }, create);
}

describe("D2a debt: bun driver listSessions with '|' in a session name", () => {
  test("name, created, windows and attached are read whole; a control client of 'a|b' never detaches 'a'", () => {
    expectPipeNameDriverRows();
  });

  test("activityAt is looked up under the whole name", async () => {
    const originalSpawnSync = Bun.spawnSync;
    const originalSpawn = Bun.spawn;
    Bun.spawnSync = ((command: string[]) => {
      if (command[1] === "list-sessions") {
        return successfulProcess("a|b|1700000000|1|1\na|1700000001|1|0\nclient:0|a|b\n");
      }
      throw new Error(`unexpected tmux call: ${command.join(" ")}`);
    }) as typeof Bun.spawnSync;
    Bun.spawn = ((command: string[]) => {
      if (command[1] !== "list-windows") throw new Error(`unexpected tmux call: ${command.join(" ")}`);
      return { stdout: new Blob(["a|b|1700000500\na|1700000400\n"]).stream(), stderr: new Blob([]).stream(),
        exited: Promise.resolve(0), kill() {} };
    }) as any;
    const driver = createBunTmuxDriver();
    try {
      driver.getSessionActivity();
      await driver.activityPoll.settled();
      expect(driver.listSessions().map((row) => [row.name, row.created, row.attached, row.activityAt])).toEqual([
        ["a|b", "1700000000", true, 1700000500],
        ["a", "1700000001", false, 1700000400],
      ]);
    } finally {
      driver.activityPoll.stop();
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
    }
  });
});

// Each mutant removes one part of the "|" fix in a copy of bun-driver.ts
// written next to the source inside the cage's own checkout, deleted in `finally`.
test("D2a debt mutation: every part of the '|' name fix in listSessions is load-bearing", async () => {
  const source = join(import.meta.dir, "../src/bun-driver.ts");
  const original = readFileSync(source, "utf8");
  const mutants = [
    { name: "naive-split", from: "            if (fields.length >= 4) {", to: "            if (false) {" },
    { name: "name-is-first-field", from: '              name = fields.join("|");', to: "              name = fields[0];" },
  ];
  const results: Array<{ mutant: string; killedBy: string[] }> = [];
  for (const mutant of mutants) {
    expect(original.split(mutant.from)).toHaveLength(2);
    const copy = join(import.meta.dir, `../src/bun-driver.d2a-debt-mutant-${mutant.name}.ts`);
    writeFileSync(copy, original.replace(mutant.from, mutant.to));
    try {
      const mod = await import(copy) as typeof import("../src/bun-driver");
      const killedBy: string[] = [];
      try { expectPipeNameDriverRows(mod.createBunTmuxDriver); } catch { killedBy.push("pipe-names"); }
      results.push({ mutant: mutant.name, killedBy });
    } finally {
      rmSync(copy, { force: true });
    }
  }
  console.log("D2A_DEBT_DRIVER_MUTANTS", JSON.stringify(results));
  expect(results.filter((result) => result.killedBy.length === 0)).toEqual([]);
});
