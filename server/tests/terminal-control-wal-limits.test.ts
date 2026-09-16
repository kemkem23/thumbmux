import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "bun:test";
import {
  TerminalControlWalRecorder,
  type TerminalControlPauseReconcileRequest,
  type TerminalControlProcess,
  type TerminalControlRecoveryCapture,
} from "../src/integrations/terminal-control-wal-recorder";

class FakeControlProcess extends EventEmitter implements TerminalControlProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

const roots: string[] = [];
const recorders: TerminalControlWalRecorder[] = [];
const realDateNow = Date.now.bind(Date);
let clockMs: number | null = null;

afterEach(async () => {
  Date.now = realDateNow;
  clockMs = null;
  for (const recorder of recorders.splice(0).reverse()) {
    if (recorder.status.state !== "disconnected") await recorder.stop();
  }
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function installClock(startMs = 1_700_000_000_000): void {
  clockMs = startMs;
  Date.now = () => clockMs ?? realDateNow();
}

function advanceClock(ms: number): void {
  if (clockMs === null) throw new Error("clock is not installed");
  clockMs += ms;
}

async function eventually(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = realDateNow() + timeoutMs;
  while (realDateNow() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function emptyCapture(request: TerminalControlPauseReconcileRequest): TerminalControlRecoveryCapture {
  return {
    recoveredBytes: Buffer.alloc(0),
    recoveredRows: 0,
    truncated: false,
    identity: request.source,
    geometry: request.source.geometry,
    boundary: "ambiguous",
  };
}

async function makeReady(options: {
  reconcilePause?: (
    request: TerminalControlPauseReconcileRequest,
  ) => Promise<TerminalControlRecoveryCapture | void>;
  onAlert?: (message: string) => void;
  onFatal?: (error: Error) => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "tmctlwal-limits-"));
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
    readyTimeoutMs: 10_000,
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
    reconcilePause: options.reconcilePause ?? (async (request) => emptyCapture(request)),
    ...(options.onAlert === undefined ? {} : { onAlert: options.onAlert }),
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  });
  recorders.push(recorder);
  const starting = recorder.start();
  fake.stdout.write("%begin 1 1 0\n%end 1 1 0\n%session-changed $9 durable-agent-1\n");
  await starting;
  return { directory: join(root, "lane"), fake, recorder };
}

test("case 3 control: acknowledged %continue does not fatal on the 2000ms timer", async () => {
  const fatals: Error[] = [];
  const alerts: string[] = [];
  const reconciles: string[] = [];
  const { fake, recorder } = await makeReady({
    onFatal: (error) => fatals.push(error),
    onAlert: (message) => alerts.push(message),
    reconcilePause: async (request) => {
      reconciles.push(request.gapId);
      return emptyCapture(request);
    },
  });

  fake.stdout.write("%pause %42\n%continue %42\n");
  await eventually(() => reconciles.length === 1, "reconcile after continue ack");
  await new Promise((resolve) => setTimeout(resolve, 2_200));

  expect(fatals.filter((error) => error.message.includes("not acknowledged within 2000ms"))).toHaveLength(0);
  expect(alerts).toHaveLength(0);
  expect(recorder.status.state).not.toBe("fatal");
  expect(reconciles).toHaveLength(1);
});

test("case 3: missing %continue fatals after 2000ms with the ack timeout message", async () => {
  const fatals: Error[] = [];
  const alerts: string[] = [];
  const reconciles: string[] = [];
  const { fake, recorder } = await makeReady({
    onFatal: (error) => fatals.push(error),
    onAlert: (message) => alerts.push(message),
    reconcilePause: async (request) => {
      reconciles.push(request.gapId);
      return emptyCapture(request);
    },
  });

  fake.stdout.write("%pause %42\n");
  expect(recorder.status.state).toBe("ready");
  expect(fatals).toHaveLength(0);

  await eventually(
    () => fatals.some((error) => error.message.includes("not acknowledged within 2000ms")),
    "continue-ack timeout fatal",
    3_500,
  );

  expect(fatals).toHaveLength(1);
  expect(fatals[0]!.message).toContain("not acknowledged within 2000ms");
  expect(fatals[0]!.message).toContain("%42");
  expect(recorder.status.state).toBe("fatal");
  expect(recorder.status.fatalMessage).toContain("not acknowledged within 2000ms");
  expect(reconciles).toHaveLength(0);
  expect(alerts).toHaveLength(0);
  expect(fake.killed).toBe(true);
}, 10_000);
