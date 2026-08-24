import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { OutputWalWriter } from "../src/output-wal";
import type { TerminalReplayResult } from "../src/terminal-replay-materializer";
import {
  createTerminalReplayWorkerClient,
  terminalReplayResultFromWire,
  terminalReplayResultToWire,
  TerminalReplayWorkerError,
  type TerminalReplayWorkerClient,
} from "../src/integrations/terminal-replay-worker";

const workerEntry = fileURLToPath(
  new URL("../src/terminal-replay-worker-entry.ts", import.meta.url),
);
const crashWorker = fileURLToPath(
  new URL("./fixtures/terminal-replay-ipc-crash-worker.ts", import.meta.url),
);
const malformedWorker = fileURLToPath(
  new URL("./fixtures/terminal-replay-ipc-malformed-worker.ts", import.meta.url),
);
const timeoutWorker = fileURLToPath(
  new URL("./fixtures/terminal-replay-ipc-timeout-worker.ts", import.meta.url),
);

let roots: string[] = [];
let clients: TerminalReplayWorkerClient[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-replay-ipc-test-"));
  roots.push(root);
  return root;
}

function materializerOptions(root: string) {
  return {
    walPath: join(root, "output.wal"),
    stateDir: join(root, "derived"),
  };
}

function lifecycle(event: "start" | "end") {
  return {
    event,
    identity: {
      session: "cc-replay-ipc-test",
      instanceId: "01MREPLAYIPC00000000000000",
      paneTarget: "=cc-replay-ipc-test:0.0",
      tmuxServerPid: 12345,
      sessionCreated: 1_787_500_000,
      sessionId: "$123",
      windowId: "@456",
      paneId: "%789",
      generation: "generation-1",
    },
    geometry: { cols: 24, rows: 5 },
  };
}

function numbered(from: number, to: number): Buffer {
  return Buffer.from(
    Array.from({ length: to - from + 1 }, (_, index) => `IPC ${from + index}\r\n`).join(""),
    "utf8",
  );
}

function renderedPlain(result: TerminalReplayResult): string {
  const history = readFileSync(result.historyPath);
  const screen = result.screen
    ? Buffer.from(result.screen.cellsBase64, "base64")
    : Buffer.alloc(0);
  return Buffer.concat([history, screen])
    .toString("utf8")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderedNumbers(result: TerminalReplayResult): number[] {
  return [...renderedPlain(result).matchAll(/^IPC (\d+)\s*$/gm)].map((match) => Number(match[1]));
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const client of clients.splice(0).reverse()) await client.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("out-of-process terminal replay worker", () => {
  test("opens once, refreshes only the durable WAL suffix, and reaps idempotently", async () => {
    const root = makeRoot();
    const options = materializerOptions(root);
    const first = new OutputWalWriter({ path: options.walPath, clock: () => 1 });
    first.appendJson("lifecycle", lifecycle("start"));
    first.appendOutput(numbered(1, 12));
    first.close();

    const client = await createTerminalReplayWorkerClient({
      materializer: options,
      workerPath: workerEntry,
      requestTimeoutMs: 30_000,
      shutdownGraceMs: 2_000,
    });
    clients.push(client);
    const pid = client.pid;
    expect(client.lastResult.sequence).toBe(2n);
    expect(renderedPlain(client.lastResult)).toContain("IPC 12");
    expect((await client.current()).sequence).toBe(2n);

    const appended = new OutputWalWriter({ path: options.walPath, clock: () => 2 });
    appended.appendOutput(numbered(13, 30));
    appended.close();

    const refreshed = await client.refresh();
    expect(refreshed.sequence).toBe(3n);
    for (let number = 1; number <= 30; number += 1) {
      expect(renderedPlain(refreshed)).toContain(`IPC ${number}`);
    }

    await Promise.all([client.close(), client.close()]);
    expect(client.closed).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    clients = clients.filter((selected) => selected !== client);
  }, 40_000);

  test("carries the bounded progress option and hasMoreWal across IPC", async () => {
    const root = makeRoot();
    const options = materializerOptions(root);
    const writer = new OutputWalWriter({ path: options.walPath, clock: () => 3 });
    writer.appendJson("lifecycle", lifecycle("start"));
    for (let index = 0; index < 12; index += 1) {
      writer.appendOutput(Buffer.alloc(128, 0));
    }
    writer.close();

    const client = await createTerminalReplayWorkerClient({
      materializer: { ...options, maxWalFrameBytesPerRefresh: 300 },
      workerPath: workerEntry,
      requestTimeoutMs: 30_000,
      shutdownGraceMs: 2_000,
    });
    clients.push(client);
    expect(client.lastResult.hasMoreWal).toBe(true);

    let result = client.lastResult;
    let batches = 0;
    while (result.hasMoreWal) {
      const before = result.walOffset;
      result = await client.refresh();
      expect(result.walOffset - before).toBeLessThanOrEqual(300);
      batches += 1;
      if (batches > 20) throw new Error("IPC replay did not make bounded progress");
    }
    expect(result.sequence).toBe(13n);
    expect(batches).toBeGreaterThan(3);
  }, 40_000);

  test("round-trips uint64 WAL sequences without a JSON number", () => {
    const sequence = 9_007_199_254_740_993n;
    const source: TerminalReplayResult = {
      complete: true,
      verified: true,
      recoveredFromCheckpoint: false,
      ended: false,
      walOffset: 123,
      sequence,
      hasMoreWal: false,
      historyBytes: 0,
      identity: null,
      geometry: null,
      pendingResize: null,
      screen: null,
      historyPath: "/tmp/history.ansi",
      checkpointPath: "/tmp/checkpoint.json",
    };

    const wire = terminalReplayResultToWire(source);
    expect(wire.sequence).toBe("9007199254740993");
    expect(JSON.stringify(wire)).not.toContain("9007199254740993n");
    expect(terminalReplayResultFromWire(JSON.parse(JSON.stringify(wire))).sequence).toBe(sequence);
  });

  test("a replacement worker recovers the checkpoint after its predecessor exits", async () => {
    const root = makeRoot();
    const options = materializerOptions(root);
    const firstWriter = new OutputWalWriter({ path: options.walPath, clock: () => 10 });
    firstWriter.appendJson("lifecycle", lifecycle("start"));
    firstWriter.appendOutput(numbered(1, 15));
    firstWriter.close();

    const firstClient = await createTerminalReplayWorkerClient({
      materializer: options,
      workerPath: workerEntry,
      requestTimeoutMs: 30_000,
      shutdownGraceMs: 2_000,
    });
    clients.push(firstClient);
    process.kill(firstClient.pid, "SIGTERM");
    await eventually(() => firstClient.closed, "terminated replay worker exit");
    await expect(firstClient.current()).rejects.toBeInstanceOf(TerminalReplayWorkerError);
    await firstClient.close();
    clients = clients.filter((selected) => selected !== firstClient);

    const appended = new OutputWalWriter({ path: options.walPath, clock: () => 11 });
    appended.appendOutput(numbered(16, 30));
    appended.close();

    const replacement = await createTerminalReplayWorkerClient({
      materializer: options,
      workerPath: workerEntry,
      requestTimeoutMs: 30_000,
      shutdownGraceMs: 2_000,
    });
    clients.push(replacement);
    expect(replacement.lastResult.recoveredFromCheckpoint).toBe(true);
    expect(replacement.lastResult.sequence).toBe(2n);
    expect(replacement.lastResult.hasMoreWal).toBe(true);
    const recovered = await replacement.refresh();
    expect(recovered.sequence).toBe(3n);
    expect(renderedNumbers(recovered)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  }, 40_000);

  test("detects a worker crash/EOF while opening and reaps it", async () => {
    const root = makeRoot();
    try {
      await createTerminalReplayWorkerClient({
        materializer: materializerOptions(root),
        workerPath: crashWorker,
        requestTimeoutMs: 2_000,
        shutdownGraceMs: 500,
      });
      throw new Error("expected worker open to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalReplayWorkerError);
      expect((error as TerminalReplayWorkerError).code).toMatch(
        /^(?:UNEXPECTED_EOF|WORKER_EXITED|IPC_WRITE_FAILED)$/,
      );
    }
  });

  test("rejects malformed worker stdout as a protocol failure", async () => {
    const root = makeRoot();
    try {
      await createTerminalReplayWorkerClient({
        materializer: materializerOptions(root),
        workerPath: malformedWorker,
        requestTimeoutMs: 2_000,
        shutdownGraceMs: 500,
      });
      throw new Error("expected malformed worker response to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalReplayWorkerError);
      expect((error as TerminalReplayWorkerError).code).toBe("PROTOCOL_ERROR");
    }
  });

  test("times out an unresponsive worker, terminates it, and does not hang factory cleanup", async () => {
    const root = makeRoot();
    const started = Date.now();
    try {
      await createTerminalReplayWorkerClient({
        materializer: materializerOptions(root),
        workerPath: timeoutWorker,
        requestTimeoutMs: 100,
        shutdownGraceMs: 500,
      });
      throw new Error("expected replay worker timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalReplayWorkerError);
      expect((error as TerminalReplayWorkerError).code).toBe("REQUEST_TIMEOUT");
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
