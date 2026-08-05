import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  buildLaunchCommand,
  buildLaunchSpec,
  type LaunchPreset,
} from "../../core/src/launch";
import {
  createBunTmuxDriver,
  killTmuxSession,
  spawnTmuxSession,
} from "../src/bun-driver";
import { createSpawnHandler, SpawnHandlerError } from "../src/spawn-handler";

let sequence = 0;
const driver = createBunTmuxDriver();

function sessionName(label: string): string {
  sequence += 1;
  return `sh-spawn-handler-${label}-${process.pid}-${Date.now()}-${sequence}`;
}

function launchPreset(id: string, worktree = false): LaunchPreset {
  return {
    id,
    label: id,
    color: "#000000",
    agent: "sh",
    worktree,
    baseCommand: "printf '%s\\n'",
    permissionOptions: [
      { value: "safe", label: "safe", flag: '"$((271 * 313))"' },
      { value: "other", label: "other", flag: '"$((11 * 17))"' },
    ],
    modelOptions: [
      { value: "default", label: "default", flag: "" },
      { value: "tagged", label: "tagged", flag: "'model-ok\\n'" },
    ],
  };
}

function post(body: unknown): Request {
  return new Request("http://thumbmux.test/api/spawn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hasSession(name: string): boolean {
  return driver.listSessions().some((session) => session.name === name);
}

async function captureUntil(name: string, expected: string): Promise<string> {
  let content = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    content = await driver.capturePane(name, { currentPaneOnly: true });
    if (content.includes(expected)) return content;
    await Bun.sleep(25);
  }
  return content;
}

function killQuietly(name: string | null): void {
  if (!name) return;
  try {
    killTmuxSession(name);
  } catch {
    // The assertion should report the original failure, not cleanup races.
  }
}

describe("createSpawnHandler", () => {
  test("POSTs a real LaunchSpec, rebuilds its command, and creates the tmux session", async () => {
    const name = sessionName("launch-spec");
    const preset = launchPreset("spawn-handler-test");
    const spec = buildLaunchSpec(preset, "safe", "default");
    const handle = createSpawnHandler({ driver, cwd: "/tmp", presets: [preset] });

    try {
      const response = await handle(post({ ...spec, name }));
      expect(response.status).toBe(201);
      expect(hasSession(name)).toBe(true);
      expect(await captureUntil(name, "84823")).toContain("84823");
    } finally {
      killQuietly(name);
    }
  });

  test("returns 409 for an explicit duplicate name without auto-name", async () => {
    const name = sessionName("duplicate");
    const preset = launchPreset("spawn-handler-duplicate");
    const handle = createSpawnHandler({ driver, cwd: "/tmp", presets: [preset] });
    spawnTmuxSession(name, "/tmp");

    try {
      const response = await handle(post({
        ...buildLaunchSpec(preset, "safe", "default"),
        name,
      }));
      expect(response.status).toBe(409);
      expect(driver.listSessions().filter((session) => session.name === name).length).toBe(1);
    } finally {
      killQuietly(name);
    }
  });

  test("auto-names an explicit collision when the caller opts in", async () => {
    const requestedName = sessionName("auto-name");
    const preset = launchPreset("spawn-handler-auto-name");
    const handle = createSpawnHandler({ driver, cwd: "/tmp", presets: [preset] });
    let generatedName: string | null = null;
    spawnTmuxSession(requestedName, "/tmp");

    try {
      const response = await handle(post({
        ...buildLaunchSpec(preset, "safe", "default"),
        name: requestedName,
        autoName: true,
      }));
      const body = await response.json() as { name?: string };
      generatedName = body.name ?? null;
      expect(response.status).toBe(201);
      expect(generatedName).not.toBe(requestedName);
      expect(generatedName?.startsWith(`${requestedName}-`)).toBe(true);
      expect(driver.listSessions().filter((session) =>
        session.name === requestedName || session.name === generatedName
      ).length).toBe(2);
    } finally {
      killQuietly(generatedName);
      killQuietly(requestedName);
    }
  });

  test("retries a late duplicate from tmux when auto-name is enabled", async () => {
    const requestedName = sessionName("late-duplicate");
    const spawnNames: string[] = [];
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      spawn: (name) => {
        spawnNames.push(name);
        if (spawnNames.length === 1) throw new Error(`duplicate session: ${name}`);
      },
    });

    const response = await handle(post({
      name: requestedName,
      autoName: true,
      command: "printf must-not-matter",
    }));
    const body = await response.json() as { name?: string };

    expect(response.status).toBe(201);
    expect(spawnNames.length).toBe(2);
    expect(new Set(spawnNames).size).toBe(2);
    expect(body.name).toBe(spawnNames[1]);
  });

  test("rejects NUL command text before spawning a session", async () => {
    let spawnCalls = 0;
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      spawn: (_name, _cwd, command) => {
        spawnCalls += 1;
        throw new Error(`command delivery failed: ${command}`);
      },
    });

    const response = await handle(post({
      command: "already exists\0x",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "command must not contain NUL" });
    expect(spawnCalls).toBe(0);
  });

  test("rejects NUL in a host preset command before spawning a session", async () => {
    let spawnCalls = 0;
    const preset = {
      ...launchPreset("spawn-handler-nul-preset"),
      baseCommand: "already exists\0x",
    };
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      presets: [preset],
      spawn: (_name, _cwd, command) => {
        spawnCalls += 1;
        throw new Error(`command delivery failed: ${command}`);
      },
    });

    const response = await handle(post({ presetId: preset.id }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "launch preset command must not contain NUL" });
    expect(spawnCalls).toBe(0);
  });

  test("does not retry arbitrary failures that merely mention an existing resource", async () => {
    let spawnCalls = 0;
    const message = "backend workspace already exists but session was created";
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      spawn: () => {
        spawnCalls += 1;
        throw new Error(message);
      },
    });

    const response = await handle(post({ command: "printf must-not-run" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: message });
    expect(spawnCalls).toBe(1);
  });

  test("preserves SpawnHandlerError status when its message resembles a duplicate", async () => {
    let prepareCalls = 0;
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      prepareWorktree: () => {
        prepareCalls += 1;
        throw new SpawnHandlerError(422, "worktree already exists");
      },
      cleanupWorktree: () => {},
      spawn: () => { throw new Error("must not spawn"); },
    });

    const response = await handle(post({
      command: "printf must-not-run",
      worktree: true,
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "worktree already exists" });
    expect(prepareCalls).toBe(1);
  });

  test("rolls back a prepared worktree before retrying a late duplicate", async () => {
    const events: string[] = [];
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      prepareWorktree: ({ name }) => {
        events.push(`prepare:${name}`);
        return "/tmp";
      },
      cleanupWorktree: ({ name }) => { events.push(`cleanup:${name}`); },
      spawn: (name) => {
        events.push(`spawn:${name}`);
        if (events.filter((event) => event.startsWith("spawn:")).length === 1) {
          throw new Error(`duplicate session: ${name}`);
        }
      },
    });

    const response = await handle(post({
      name: sessionName("worktree-late-duplicate"),
      autoName: true,
      command: "printf must-not-matter",
      worktree: true,
    }));

    expect(response.status).toBe(201);
    expect(events.filter((event) => event.startsWith("prepare:")).length).toBe(2);
    expect(events.filter((event) => event.startsWith("spawn:")).length).toBe(2);
    expect(events.filter((event) => event.startsWith("cleanup:")).length).toBe(1);
    expect(events.findIndex((event) => event.startsWith("cleanup:")))
      .toBeLessThan(events.findLastIndex((event) => event.startsWith("prepare:")));
  });

  test("rejects a worktree before side effects when no cleanup hook is configured", async () => {
    let prepareCalls = 0;
    let spawnCalls = 0;
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      prepareWorktree: () => {
        prepareCalls += 1;
        return "/tmp";
      },
      spawn: (name) => {
        spawnCalls += 1;
        throw new Error(`duplicate session: ${name}`);
      },
    });

    const response = await handle(post({
      name: sessionName("worktree-no-cleanup"),
      autoName: true,
      command: "printf must-not-matter",
      worktree: true,
    }));

    expect(response.status).toBe(400);
    expect(prepareCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  test("rejects a cwd that does not exist without spawning", async () => {
    const name = sessionName("bad-cwd");
    const missing = `/tmp/thumbmux-missing-cwd-${process.pid}-${Date.now()}`;
    const handle = createSpawnHandler({ driver, cwd: "/tmp" });

    const response = await handle(post({ name, cwd: missing, command: "printf nope" }));
    expect(response.status).toBe(400);
    expect(hasSession(name)).toBe(false);
  });

  test("rebuilds known presets server-side instead of trusting submitted command", async () => {
    const preset = launchPreset("spawn-handler-rebuild");
    const expectedCommand = buildLaunchCommand(preset, "safe", "tagged");
    const spawned: Array<{ name: string; cwd: string; command?: string }> = [];
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      presets: [preset],
      spawn: (name, cwd, command) => { spawned.push({ name, cwd, command }); },
    });

    const response = await handle(post({
      ...buildLaunchSpec(preset, "safe", "tagged"),
      name: sessionName("rebuild"),
      command: "printf caller-tampered-command",
    }));

    expect(response.status).toBe(201);
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.command).toBe(expectedCommand);
    expect(spawned[0]?.command).not.toContain("caller-tampered-command");
  });

  test("keeps the demo's direct command payload compatible", async () => {
    const generated = sessionName("demo-payload");
    const handle = createSpawnHandler({
      driver,
      cwd: "/tmp",
      generateName: () => generated,
    });

    try {
      const response = await handle(post({
        command: "printf '%s\\n' \"$((379 * 421))\"",
        worktree: false,
      }));
      expect(response.status).toBe(201);
      expect(hasSession(generated)).toBe(true);
      expect(await captureUntil(generated, "159559")).toContain("159559");
    } finally {
      killQuietly(generated);
    }
  });

  test("worktree creation is opt-in and its returned cwd is validated", async () => {
    const nameWithoutHook = sessionName("worktree-no-hook");
    const withoutHook = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      spawn: () => { throw new Error("must not spawn"); },
    });
    const missingHookResponse = await withoutHook(post({
      name: nameWithoutHook,
      command: "printf nope",
      worktree: true,
    }));
    expect(missingHookResponse.status).toBe(400);

    let spawnCalls = 0;
    let hookCalls = 0;
    let cleanupCalls = 0;
    const withBadHook = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      prepareWorktree: () => {
        hookCalls += 1;
        return `/tmp/thumbmux-missing-worktree-${process.pid}-${Date.now()}`;
      },
      cleanupWorktree: () => { cleanupCalls += 1; },
      spawn: () => { spawnCalls += 1; },
    });
    const badHookResponse = await withBadHook(post({
      name: sessionName("worktree-bad-hook"),
      command: "printf nope",
      worktree: true,
    }));
    expect(badHookResponse.status).toBe(400);
    expect(hookCalls).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(spawnCalls).toBe(0);
  });

  test("rolls back a prepared worktree when spawn fails for another reason", async () => {
    let cleanupCalls = 0;
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      prepareWorktree: () => "/tmp",
      cleanupWorktree: () => { cleanupCalls += 1; },
      spawn: () => { throw new Error("spawn exploded"); },
    });

    const response = await handle(post({
      name: sessionName("worktree-spawn-failure"),
      command: "printf must-not-matter",
      worktree: true,
    }));

    expect(response.status).toBe(500);
    expect(cleanupCalls).toBe(1);
  });

  test("spawns in the cwd returned by a successful worktree hook", async () => {
    const name = sessionName("worktree-success");
    const baseCwd = await mkdtemp("/tmp/thumbmux-spawn-base-");
    const worktreeCwd = await mkdtemp("/tmp/thumbmux-spawn-worktree-");
    const handle = createSpawnHandler({
      driver,
      cwd: baseCwd,
      prepareWorktree: () => worktreeCwd,
      cleanupWorktree: () => {},
    });

    try {
      const response = await handle(post({
        name,
        command: "printf '%s\\n' \"$PWD\"",
        worktree: true,
      }));
      expect(response.status).toBe(201);
      expect(hasSession(name)).toBe(true);
      expect(await captureUntil(name, worktreeCwd)).toContain(worktreeCwd);
    } finally {
      killQuietly(name);
      await rm(baseCwd, { recursive: true, force: true });
      await rm(worktreeCwd, { recursive: true, force: true });
    }
  });

  test("rejects unknown preset IDs and malformed JSON", async () => {
    const handle = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: "/tmp",
      spawn: () => { throw new Error("must not spawn"); },
    });
    const unknown = await handle(post({
      name: sessionName("unknown-preset"),
      presetId: "not-a-real-preset",
      command: "printf must-not-run",
    }));
    expect(unknown.status).toBe(400);

    const malformed = await handle(new Request("http://thumbmux.test/api/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }));
    expect(malformed.status).toBe(400);
  });
});
