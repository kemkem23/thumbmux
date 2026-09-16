import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TerminalReplayMaterializer } from "../src/terminal-replay-materializer";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "bun:test";
import { parseOutputWalJson, readOutputWal } from "../src/output-wal";
import { resolveTerminalWalPaths } from "../src/integrations/terminal-wal";
import {
  TerminalControlWalRecorder,
  TerminalControlWalRetrySupervisor,
  type TerminalControlRecoveryCapture,
  type TerminalControlPauseReconcileRequest,
  type TerminalControlProcess,
} from "../src/integrations/terminal-control-wal-recorder";

class FakeControlProcess extends EventEmitter implements TerminalControlProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; this.emit("exit", null, "SIGTERM"); return true; }
}

const roots: string[] = [];
const recorders: TerminalControlWalRecorder[] = [];

afterEach(async () => {
  for (const recorder of recorders.splice(0).reverse()) await recorder.stop();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

async function makeReady(
  reconcilePause: (
    request: TerminalControlPauseReconcileRequest,
  ) => Promise<TerminalControlRecoveryCapture | void>,
) {
  const root = mkdtempSync(join(tmpdir(), "tmctlwal-recovery-"));
  roots.push(root);
  const fake = new FakeControlProcess();
  const recorder = new TerminalControlWalRecorder({
    worker: {
      directory: join(root, "lane"),
      identity: {
        session: "durable-agent-1",
        instanceId: "terminal-control-incarnation",
        paneTarget: "=durable-agent-1:0.0",
        tmuxServerPid: 4321,
        sessionCreated: 1_700_000_000,
      },
      geometry: { cols: 80, rows: 24 },
    },
  }, {
    spawnControl: () => fake,
    resolveIdentity: async () => ({
      session: "durable-agent-1",
      sessionId: "$9",
      windowId: "@42",
      paneId: "%42",
      paneTarget: "=durable-agent-1:0.0",
      tmuxServerPid: 4321,
      sessionCreated: 1_700_000_000,
      geometry: { cols: 80, rows: 24 },
    }),
    reconcilePause,
  });
  recorders.push(recorder);
  const starting = recorder.start();
  fake.stdout.write("%begin 1 1 0\n%end 1 1 0\n%session-changed $9 durable-agent-1\n");
  await starting;
  return { directory: join(root, "lane"), fake, recorder };
}

test("starts one reconcile after the matching continue acknowledgement and remains degraded", async () => {
  const reconciles: TerminalControlPauseReconcileRequest[] = [];
  const { fake, recorder } = await makeReady(async (request) => {
    reconciles.push(request);
    return {
      recoveredBytes: Buffer.alloc(0), recoveredRows: 0, truncated: false,
      identity: request.source, geometry: request.source.geometry, boundary: "ambiguous",
    };
  });

  fake.stdout.write("%pause %42\n");
  expect(reconciles).toHaveLength(0);
  fake.stdout.write("%begin 2 2 1\n%continue %42\n%end 2 2 1\n");
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(reconciles).toHaveLength(1);
  expect(reconciles[0]).toMatchObject({ paneId: "%42" });
  expect(reconciles[0]!.gapId).not.toBe("");
  expect(recorder.status).toMatchObject({ state: "ready", degraded: true });
});

test("stores a bounded capture as recovered-from-ring provenance instead of raw output", async () => {
  const { directory, fake } = await makeReady(async (request) => ({
    gapId: request.gapId,
    recoveredBytes: Buffer.from("older\ncurrent\n"),
    recoveredRows: 2,
    truncated: false,
    identity: request.source,
    geometry: request.source.geometry,
    boundary: "matched",
  }) as never);

  fake.stdout.write("%pause %42\n%continue %42\n");
  await new Promise((resolve) => setTimeout(resolve, 10));

  const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
  expect(records.map((record) => record.kind)).toEqual(["lifecycle", "gap", "recovery"]);
  expect(parseOutputWalJson(records[2]!)).toMatchObject({
    provenance: "recovered-from-ring",
    recoveredRows: 2,
    truncated: false,
    capturedSeqBefore: "1",
    capturedSeqAfter: "2",
    boundary: "matched",
    identity: { paneId: "%42", windowId: "@42" },
    geometry: { cols: 80, rows: 24 },
  });
});

test("serializes repeated pauses and writes a reconcile result for every gapId", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const calls: TerminalControlPauseReconcileRequest[] = [];
  const { directory, fake, recorder } = await makeReady(async (request) => {
    calls.push(request);
    if (calls.length === 1) await firstBlocked;
    if (calls.length === 2) throw new Error("capture failed");
    return {
      recoveredBytes: Buffer.from("ring\n"),
      recoveredRows: 1,
      truncated: false,
      identity: request.source,
      geometry: request.source.geometry,
      boundary: "matched" as const,
    };
  });

  fake.stdout.write("%pause %42\n%continue %42\n%pause %42\n%continue %42\n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toHaveLength(1);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(calls).toHaveLength(2);
  const recoveries = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)]
    .filter((record) => record.kind === "recovery")
    .map((record) => parseOutputWalJson<{ gapId: string; status: string }>(record));
  expect(recoveries.map((recovery) => recovery.status)).toEqual(["success", "failed"]);
  expect(new Set(recoveries.map((recovery) => recovery.gapId)).size).toBe(2);
  expect(recorder.status.state).toBe("fatal");
  expect(fake.killed).toBe(true);
});

test("supervisor retries failed recorder epochs after 5, 15, and 60 seconds then alerts", async () => {
  const delays: number[] = [];
  const scheduled: Array<() => void> = [];
  const fatals: Array<(error: Error) => void> = [];
  const alerts: string[] = [];
  const supervisor = new TerminalControlWalRetrySupervisor({
    factory: (onFatal) => {
      fatals.push(onFatal);
      return {
        start: async () => undefined,
        stop: async () => undefined,
        armLogicalEndOnSourceExit: () => undefined,
        cancelLogicalEndOnSourceExit: () => undefined,
      };
    },
    schedule: (callback, delay) => { delays.push(delay); scheduled.push(callback); return callback; },
    cancel: () => undefined,
    now: () => 1_000,
    onAlert: (message) => alerts.push(message),
  });
  await supervisor.start();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    fatals[attempt]!(new Error(`failed-${attempt}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled[attempt]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  fatals[3]!(new Error("failed-final"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(delays).toEqual([5_000, 15_000, 60_000]);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("3 retries within 5 minutes");
});

test("command response payload cannot manufacture output or pause notifications", async () => {
  const calls: string[] = [];
  const { directory, fake, recorder } = await makeReady(async (request) => { calls.push(request.gapId); });
  fake.stdout.write("%begin 3 3 1\n%output %42 FALSE_OUTPUT\n%pause %42\n");
  fake.stdout.write(Buffer.from("ตัวอักษรในผลคำสั่ง\n"));
  fake.stdout.write("%end 3 3 1\n%output %42 REAL_OUTPUT\n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
  expect(records.map((record) => record.kind)).toEqual(["lifecycle", "output"]);
  expect(Buffer.from(records[1]!.payload).toString()).toBe("REAL_OUTPUT");
  expect(recorder.status.state).toBe("ready");
  expect(calls).toEqual([]);
});

test("default reconcile captures a real private pane and ambiguous recovery stays readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "default-recovery-"));
  roots.push(root);
  const socket = join(root, "source.sock");
  const env = { ...process.env };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8" }).trimEnd();
  let recorder: TerminalControlWalRecorder | undefined;
  try {
    tmux("new-session", "-d", "-s", "default-proof", "-x", "80", "-y", "24", "sh -c 'printf RING_FROM_REAL_PANE; sleep 60'");
    expect(tmux("display-message", "-p", "#{socket_path}")).toBe(socket);
    const [sessionId, paneId, pid, created] = tmux("display-message", "-p", "-t", "=default-proof:0.0",
      "#{session_id}|#{pane_id}|#{pid}|#{session_created}").split("|");
    const directory = join(root, "lane");
    const fake = new FakeControlProcess();
    recorder = new TerminalControlWalRecorder({
      tmux: { socketPath: socket },
      worker: { directory, identity: { session: "default-proof", instanceId: "default-proof-instance",
        paneTarget: "=default-proof:0.0", tmuxServerPid: Number(pid), sessionCreated: Number(created) },
        geometry: { cols: 80, rows: 24 } },
    }, { spawnControl: () => fake }); // No reconcilePause or resolveIdentity replacement.
    const starting = recorder.start();
    fake.stdout.write(`%begin 1 1 0\n%end 1 1 0\n%session-changed ${sessionId} default-proof\n`);
    await starting;
    fake.stdout.write(`%output ${paneId} BEFORE_DEFAULT\\015\\012\n%pause ${paneId}\n%continue ${paneId}\n%output ${paneId} SUFFIX_DURING_CAPTURE\\015\\012\n`);
    const walPath = resolveTerminalWalPaths(directory).walPath;
    const deadline = Date.now() + 5_000;
    while (![...readOutputWal(walPath)].some((record) => record.kind === "recovery") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const recoveryRecord = [...readOutputWal(walPath)].find((record) => record.kind === "recovery");
    expect(recoveryRecord).toBeDefined();
    const recovery = parseOutputWalJson<{ status: string; recoveredBytesBase64: string }>(recoveryRecord!);
    expect(recovery.status).toBe("ambiguous");
    expect(Buffer.from(recovery.recoveredBytesBase64, "base64").toString()).toContain("RING_FROM_REAL_PANE");
    fake.stdout.write(`%output ${paneId} AFTER_DEFAULT\\015\\012\n`);
    await recorder.stop();
    const result = new TerminalReplayMaterializer({ walPath, stateDir: join(root, "view") }).materialize();
    const rendered = readFileSync(result.historyPath, "utf8") + Buffer.from(result.screen!.cellsBase64, "base64").toString();
    for (const text of ["BEFORE_DEFAULT", "SUFFIX_DURING_CAPTURE", "AFTER_DEFAULT", "ประวัติขาดช่วง", "recovered-from-ring", "RING_FROM_REAL_PANE"]) expect(rendered).toContain(text);
  } finally {
    await recorder?.stop();
    tmux("kill-server");
  }
}, 30_000);
