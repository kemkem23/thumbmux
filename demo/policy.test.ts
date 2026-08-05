import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { createSpawnHandler } from "@thumbmux/server";
import {
  createDemoSessionsMux,
  createDemoSessionPolicy,
  demoSessionMetadataFromName,
  demoSpawnPayload,
  sessionMetadataFromRows,
  validateDemoSpawnCwd,
} from "./policy";
import { demoDistPath } from "./server-policy";

const row = (name: string) => ({
  name,
  created: "1",
  windows: 1,
  attached: false,
  activityAt: 1,
});

describe("demo run policy", () => {
  test("projects launch semantics for a reload or second browser", () => {
    const policy = createDemoSessionPolicy("aaaabbbbccccdddd");
    const name = policy.allocate({
      payload: { agent: "codex", demoPresetId: "alt-screen-mouse" },
      existing: new Set(),
    });
    const projected = policy.project([row(name)]);

    expect(projected).toEqual([{
      ...row(name),
      demoSubmitAgent: "codex",
      demoAltScreenMouse: true,
    }]);
    expect(sessionMetadataFromRows(projected)).toEqual({
      agents: { [name]: "codex" },
      altScreens: { [name]: true },
    });
  });

  test("session names carry launch semantics across demo server restarts", () => {
    const firstRun = createDemoSessionPolicy("aaaabbbbccccdddd");
    const name = firstRun.allocate({
      payload: { agent: "cc", demoPresetId: "alt-screen-mouse" },
      existing: new Set(),
    });
    const restarted = createDemoSessionPolicy("eeeeffffgggghhhh");

    expect(demoSessionMetadataFromName(name)).toEqual({
      submitAgent: "claude",
      altScreenMouse: true,
    });
    expect(restarted.project([row(name)])).toEqual([{
      ...row(name),
      demoSubmitAgent: "claude",
      demoAltScreenMouse: true,
    }]);
  });

  test("keeps the host-built command authoritative for a custom demo preset", async () => {
    const policy = createDemoSessionPolicy("aaaabbbbccccdddd");
    let launched: { name: string; command?: string } | undefined;
    const handler = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: import.meta.dir,
      generateName: policy.allocate,
      spawn: (name, _cwd, command) => { launched = { name, command }; },
    });
    const command = "printf custom-demo-command";
    const payload = demoSpawnPayload({
      presetId: "alt-screen-mouse",
      agent: "alt-screen",
      worktree: false,
      permission: "none",
      model: "none",
      command,
    });

    const response = await handler(new Request("http://localhost/api/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));

    expect(response.status).toBe(201);
    expect(launched?.command).toBe(command);
  });

  test("rejects caller-selected names before the demo allocator can be bypassed", async () => {
    const policy = createDemoSessionPolicy("aaaabbbbccccdddd");
    let launched = false;
    const handler = createSpawnHandler({
      driver: { listSessions: () => [] },
      cwd: import.meta.dir,
      validateCwd: validateDemoSpawnCwd,
      generateName: policy.allocate,
      spawn: () => { launched = true; },
    });

    const response = await handler(new Request("http://localhost/api/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo-spoofed", command: "true" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "demo session names are assigned by the server",
    });
    expect(launched).toBe(false);
  });

  test("first session and note identity differ across server runs", () => {
    const first = createDemoSessionPolicy("111111111111aaaa").allocate({
      payload: { agent: "cc" },
      existing: new Set(),
    });
    const second = createDemoSessionPolicy("222222222222bbbb").allocate({
      payload: { agent: "cc" },
      existing: new Set(),
    });
    const notes = { [first]: "private note from the prior run" };

    expect(first).not.toBe(second);
    expect(notes[second]).toBeUndefined();
  });

  test("hydrates every mux session subscription and replaces dead-session metadata", async () => {
    const callbacks = new Set<(rows: unknown[]) => void>();
    const source = {
      marker: "source",
      onSessions(callback: (rows: unknown[]) => void) {
        callbacks.add(callback);
        return () => { callbacks.delete(callback); };
      },
      receiver() { return this; },
    };
    let metadata = sessionMetadataFromRows([]);
    const delivered: unknown[][][] = [[], []];
    const mux = createDemoSessionsMux(source, {
      delayMs: 5,
      hydrate(rows) { metadata = sessionMetadataFromRows(rows); },
    });
    const unsubscribeFirst = mux.onSessions((rows) => { delivered[0]!.push(rows); });
    const unsubscribeSecond = mux.onSessions((rows) => { delivered[1]!.push(rows); });
    const live = [{
      name: "demo-run-codex-0-1",
      demoSubmitAgent: "codex",
      demoAltScreenMouse: false,
    }];

    for (const callback of callbacks) callback(live);
    expect(delivered).toEqual([[], []]);
    await Bun.sleep(15);
    expect(delivered).toEqual([[live], [live]]);
    expect(metadata).toEqual({
      agents: { "demo-run-codex-0-1": "codex" },
      altScreens: { "demo-run-codex-0-1": false },
    });

    for (const callback of callbacks) callback([]);
    expect(delivered).toEqual([[live, []], [live, []]]);
    expect(metadata).toEqual({ agents: {}, altScreens: {} });
    expect(mux.receiver()).toBe(source);

    unsubscribeFirst();
    unsubscribeSecond();
    expect(callbacks.size).toBe(0);
  });

  test("decodes spaces, hashes, and non-ASCII filesystem paths", () => {
    const modulePath = "/tmp/My Project/#ทดลอง/demo/policy.ts";
    expect(demoDistPath(pathToFileURL(modulePath).href)).toBe(
      "/tmp/My Project/#ทดลอง/demo/dist/",
    );
  });
});
