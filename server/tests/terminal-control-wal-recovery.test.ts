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
} from "../src/integrations/terminal-control-wal-recorder";

class FakeControlProcess extends EventEmitter implements TerminalControlProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean { this.emit("exit", null, "SIGTERM"); return true; }
}

const roots: string[] = [];
const recorders: TerminalControlWalRecorder[] = [];

afterEach(async () => {
  for (const recorder of recorders.splice(0).reverse()) await recorder.stop();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

async function makeReady(reconcilePause: (request: TerminalControlPauseReconcileRequest) => Promise<void>) {
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
  return { fake, recorder };
}

test("starts one reconcile after the matching continue acknowledgement and remains degraded", async () => {
  const reconciles: TerminalControlPauseReconcileRequest[] = [];
  const { fake, recorder } = await makeReady(async (request) => { reconciles.push(request); });

  fake.stdout.write("%pause %42\n");
  expect(reconciles).toHaveLength(0);
  fake.stdout.write("%begin 2 2 1\n%continue %42\n%end 2 2 1\n");
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(reconciles).toHaveLength(1);
  expect(reconciles[0]).toMatchObject({ paneId: "%42" });
  expect(reconciles[0]!.gapId).not.toBe("");
  expect(recorder.status).toMatchObject({ state: "ready", degraded: true });
});
