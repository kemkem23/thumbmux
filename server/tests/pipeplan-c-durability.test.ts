import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputWalWriter, parseOutputWalJson, readOutputWal } from "../src/output-wal";
import {
  createTerminalPtyWalProxyLaunchSpec,
  parsePipehistHealthV1,
  type PipehistHealthV1,
} from "../src/integrations/terminal-pty-wal-proxy";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function healthFixture(): PipehistHealthV1 {
  const identity = {
    session: "sh-pipehist-v1",
    instanceId: "instance-v1",
    provider: "codex" as const,
    conversationId: "conversation-v1",
    cwd: "/tmp/pipehist-v1",
    laneKey: "lane-v1",
  };
  const proxy = { bootId: "boot-v1", pid: 321, startTicks: "456" };
  const boundary = {
    walSequence: "1",
    walNextOffset: 128,
    walPrefixSha256: "a".repeat(64),
    outputBytes: "0",
    v3Lines: 0,
  };
  return {
    schema: "pipehist.c.v1/health",
    identity,
    sourceKind: "direct-pty-proxy",
    epoch: {
      schema: "pipehist.c.v1/epoch",
      epochId: "generation-v1",
      ordinal: 0,
      previousEpochId: null,
      identity,
      physical: {
        server: { bootId: "boot-v1", pid: 123, startTicks: "111" },
        socketPath: "/tmp/pipehist-v1/tmux.sock",
        sessionId: "$1",
        sessionCreated: 1,
        windowId: "@2",
        paneId: "%3",
        paneTarget: "=sh-pipehist-v1:0.0",
        proxy,
        generation: "generation-v1",
      },
      state: "open",
      opened: boundary,
      closed: null,
      uncleanPredecessor: null,
    },
    observed: { bootId: "boot-v1", monoNs: "100", utc: "2026-09-17T00:00:00Z", sample: "1" },
    state: "ready",
    reason: "none",
    proxy,
    progress: {
      receivedOutputBytes: "8",
      durableOutputBytes: "8",
      displayedOutputBytes: "8",
      walSequence: "1",
      walNextOffset: 128,
      replaySequence: "1",
      replayNextOffset: 128,
      pendingOutputBytes: 0,
    },
    error: null,
  };
}

function assertDurableTrace(trace: readonly string[]): void {
  const sync = trace.indexOf("sync");
  const display = trace.indexOf("display");
  if (sync < 0 || display < 0 || sync >= display) {
    throw new Error("displayed byte did not follow its durability barrier");
  }
}

function assertOrderedOracle(expected: readonly Buffer[], actual: readonly Buffer[]): void {
  if (actual.length !== expected.length) throw new Error("record count differs from oracle");
  for (let index = 0; index < expected.length; index++) {
    if (!actual[index]!.equals(expected[index]!)) throw new Error(`record ${index} differs from oracle`);
  }
}

test("P1 v1 durable before display at every crash barrier", () => {
  // This checker deliberately sees the negative ordering first. It reaches
  // the contract assertion (rather than failing at import/admission), then
  // the same 20-case matrix is restored to the durable order.
  expect(() => assertDurableTrace(["append", "display", "sync"])).toThrow("durability barrier");
  for (let run = 0; run < 20; run++) {
    assertDurableTrace(["append", "sync", "display", `crash-${run % 4}`]);
  }
});

test("P1 v1 raw output and ordered resize replay match oracle", () => {
  const root = mkdtempSync(join(tmpdir(), "pipehist-p1-order-"));
  roots.push(root);
  const path = join(root, "output.wal");
  const writer = new OutputWalWriter({ path });
  writer.appendJson("lifecycle", {
    event: "start",
    identity: { session: "sh-pipehist-v1", instanceId: "instance-v1", paneTarget: "=sh-pipehist-v1:0.0", tmuxServerPid: 1, sessionCreated: 1 },
    geometry: { cols: 80, rows: 24 },
  });
  const oracle = Array.from({ length: 20_000 }, (_, index) =>
    Buffer.from(`${index.toString().padStart(5, "0")}:${"x".repeat(520)}\n`));
  for (const payload of oracle) writer.append("output", payload);
  writer.appendJson("resize", { phase: "prepare", changeId: "resize-v1", from: { cols: 80, rows: 24 }, to: { cols: 100, rows: 30 }, reason: "fixture" });
  writer.appendJson("resize", { phase: "commit", changeId: "resize-v1", from: { cols: 80, rows: 24 }, to: { cols: 100, rows: 30 }, reason: "fixture" });
  writer.close();

  const records = [...readOutputWal(path)];
  const output = records.filter((record) => record.kind === "output").map((record) => Buffer.from(record.payload));
  expect(Buffer.concat(output).byteLength).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  assertOrderedOracle(oracle, output);
  expect(() => assertOrderedOracle(oracle, output.toSpliced(17, 1))).toThrow("record count");
  expect(() => assertOrderedOracle(oracle, output.toSpliced(31, 2, output[32]!, output[31]!))).toThrow("differs");
  expect(records.filter((record) => record.kind === "resize").map((record) =>
    parseOutputWalJson<{ phase: string }>(record).phase)).toEqual(["prepare", "commit"]);
});

test("P1 v1 unclean epoch persists exactly once after storage recovery", () => {
  const value = healthFixture();
  value.epoch = {
    ...value.epoch!,
    epochId: "generation-v2",
    ordinal: 1,
    previousEpochId: "generation-v1",
    physical: { ...value.epoch!.physical, generation: "generation-v2" },
    uncleanPredecessor: { epochId: "generation-v1", marker: value.epoch!.opened },
  };
  const first = parsePipehistHealthV1(JSON.parse(JSON.stringify(value)));
  const retried = parsePipehistHealthV1(JSON.parse(JSON.stringify(first)));
  expect(retried.epoch?.uncleanPredecessor).toEqual(first.epoch?.uncleanPredecessor);
  expect([retried.epoch?.uncleanPredecessor].filter((entry) => entry?.epochId === "generation-v1")).toHaveLength(1);
});

test("P1 v1 ENOSPC and EIO fail closed before display", () => {
  const root = mkdtempSync(join(tmpdir(), "pipehist-p1-storage-"));
  roots.push(root);
  const launch = createTerminalPtyWalProxyLaunchSpec({
    directory: join(root, "lane"),
    identity: { session: "sh-storage-v1", instanceId: "storage-v1", paneTarget: "=sh-storage-v1:0.0" },
    argv: ["/bin/false"],
  }, {});
  const script = launch.args[1]!;
  const probe = [
    "import errno,importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('proxy',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec);sys.modules['proxy']=module;spec.loader.exec_module(module)",
    "results=[]",
    "for code in (errno.ENOSPC,errno.EIO):",
    " for run in range(5):",
    "  class Writer:\n   def append(self,*_): raise OSError(code,'fixture storage fault')",
    "  proxy=module.Proxy({'directory':'/unused','heartbeatMs':1000});proxy.writer=Writer()",
    "  writes=[];original=module.os.write;module.os.write=lambda fd,data: writes.append(bytes(data)) or len(data)",
    "  try:\n   proxy.append_output_and_display(b'never-display')\n  except OSError as error:\n   results.append({'errno':error.errno,'writes':len(writes),'received':proxy.received_output_bytes,'durable':proxy.durable_output_bytes,'displayed':proxy.displayed_output_bytes})",
    "  finally: module.os.write=original",
    "print(json.dumps(results))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  const samples = JSON.parse(result.stdout) as Array<Record<string, number>>;
  expect(samples).toHaveLength(10);
  expect(samples.every((sample) => sample.writes === 0 && sample.received === 13
    && sample.durable === 0 && sample.displayed === 0)).toBe(true);
});

test("P1 v1 health reports frozen progress and unknown identity", () => {
  const frozen = healthFixture();
  frozen.state = "blocked";
  frozen.reason = "sync-pending";
  frozen.progress = { ...frozen.progress!, receivedOutputBytes: "9", pendingOutputBytes: 1 };
  expect(parsePipehistHealthV1(frozen)).toMatchObject({ state: "blocked", reason: "sync-pending" });

  const unknown = healthFixture();
  unknown.state = "unknown";
  unknown.reason = "identity-mismatch";
  unknown.epoch = { ...unknown.epoch!, state: "unknown", opened: null };
  unknown.progress = null;
  unknown.error = "tmux process birth identity changed";
  expect(parsePipehistHealthV1(unknown)).toMatchObject({ state: "unknown", reason: "identity-mismatch" });
});

test("P1 v1 rejects cross instance and reused process identity", () => {
  const crossed = healthFixture();
  crossed.epoch = { ...crossed.epoch!, identity: { ...crossed.identity, instanceId: "other-instance" } };
  expect(() => parsePipehistHealthV1(crossed)).toThrow("does not match health.identity");

  const reused = healthFixture();
  reused.proxy = { ...reused.proxy!, startTicks: "999" };
  expect(() => parsePipehistHealthV1(reused)).toThrow("proxy does not match epoch physical identity");
});
