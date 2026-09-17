import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { TerminalControlWalRecorder, type TerminalControlProcess } from "../src/integrations/terminal-control-wal-recorder";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import {
  OutputWalWriter,
  parseOutputWalGapPayload,
  parseOutputWalJson,
  readOutputWal,
} from "../src/output-wal";
import {
  TerminalWalWorker,
  parseTerminalWalWorkerConfig,
  type TerminalWalWorkerConfig,
} from "../src/integrations/terminal-wal-worker";
import {
  TerminalWalController,
  resolveTerminalWalPaths,
  type TerminalWalIdentity,
} from "../src/integrations/terminal-wal";

let roots: string[] = [];
let workers: TerminalWalWorker[] = [];
let controllers: TerminalWalController[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tmwal-"));
  roots.push(root);
  return join(root, "lane");
}

function identity(overrides: Partial<TerminalWalIdentity> = {}): TerminalWalIdentity {
  return {
    session: "durable-agent-1",
    instanceId: "terminal-incarnation-1",
    paneTarget: "=durable-agent-1:0.0",
    tmuxServerPid: 1234,
    sessionCreated: 1_700_000_000,
    ...overrides,
  };
}

function config(
  directory: string,
  overrides: Partial<TerminalWalWorkerConfig> = {},
): TerminalWalWorkerConfig {
  return {
    directory,
    identity: identity(),
    geometry: { cols: 80, rows: 24 },
    ...overrides,
  };
}

async function startWorker(
  workerConfig: TerminalWalWorkerConfig,
  input = new PassThrough(),
  walFormat: 1 | 2 = 1,
): Promise<{ worker: TerminalWalWorker; input: PassThrough; controller: TerminalWalController }> {
  const worker = new TerminalWalWorker(workerConfig, {
    input,
    clock: () => 1_700_000_000_000,
    walFormat,
  });
  await worker.start();
  workers.push(worker);
  const controller = new TerminalWalController({ directory: workerConfig.directory });
  await controller.connect();
  controllers.push(controller);
  return { worker, input, controller };
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
  for (const controller of controllers.splice(0).reverse()) controller.close();
  for (const worker of workers.splice(0).reverse()) {
    if (worker.status.started) await worker.stop({ writeLifecycleEnd: false });
  }
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("terminal WAL stdin worker and controller", () => {
  test("writes START, arbitrary stdin bytes, then a durable barrier in exact order", async () => {
    const directory = makeRoot();
    const { input, controller } = await startWorker(config(directory));
    const binary = Buffer.from([0, 255, 0x1b, 0x5b, 0x31, 0x6d, 10, 0xc3, 0x28]);
    input.write(binary);

    const ack = await controller.barrier("barrier:byte-exact");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];

    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "output", "checkpoint"]);
    expect(parseOutputWalJson(records[0]!)).toEqual({
      event: "start",
      identity: identity(),
      geometry: { cols: 80, rows: 24 },
    });
    expect(Buffer.from(records[1]!.payload)).toEqual(binary);
    expect(parseOutputWalJson(records[2]!)).toEqual({
      event: "barrier",
      requestId: "barrier:byte-exact",
    });
    expect(ack.sequence).toBe(records[2]!.sequence.toString());
    expect(ack.nextOffset).toBe(records[2]!.nextOffset);
  });

  test("buffers OUTPUT between PREPARE and durable COMMIT, then preserves byte order", async () => {
    const directory = makeRoot();
    const { worker, input, controller } = await startWorker(config(directory));
    const from = { cols: 80, rows: 24 };
    const to = { cols: 197, rows: 54 };

    await controller.prepareResize({
      requestId: "prepare:resize-1",
      changeId: "resize-1",
      from,
      to,
      reason: "viewer geometry",
    });
    input.write(Buffer.from("during-resize"));
    await eventually(() => worker.status.bufferedOutputBytes === 13, "prepared output buffer");

    const beforeCommit = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(beforeCommit.map((record) => record.kind)).toEqual(["lifecycle", "resize"]);
    expect(parseOutputWalJson(beforeCommit[1]!)).toEqual({
      phase: "prepare",
      changeId: "resize-1",
      from,
      to,
      reason: "viewer geometry",
    });

    const ack = await controller.commitResize("resize-1", "commit:resize-1");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual([
      "lifecycle",
      "resize",
      "resize",
      "output",
    ]);
    expect(parseOutputWalJson(records[2]!)).toEqual({
      phase: "commit",
      changeId: "resize-1",
      from,
      to,
      reason: "viewer geometry",
    });
    expect(ack.sequence).toBe(records[2]!.sequence.toString());
    expect(Buffer.from(records[3]!.payload).toString()).toBe("during-resize");
    expect(worker.status).toMatchObject({
      geometry: to,
      pendingChangeId: null,
      bufferedOutputBytes: 0,
      inputBackpressured: false,
    });
  });

  test("caps the resize buffer and lets the stream/OS backpressure without dropping bytes", async () => {
    const directory = makeRoot();
    const input = new PassThrough({ highWaterMark: 2 });
    const { worker, controller } = await startWorker(
      config(directory, { maxBufferedOutputBytes: 4, maxOutputRecordBytes: 4 }),
      input,
    );
    await controller.prepareResize({
      changeId: "resize-cap",
      from: { cols: 80, rows: 24 },
      to: { cols: 81, rows: 24 },
    });
    input.write(Buffer.from("0123456789"));
    await eventually(
      () => worker.status.bufferedOutputBytes === 4 && worker.status.inputBackpressured,
      "bounded resize backpressure",
    );

    await controller.abortResize("resize-cap");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    const bytes = Buffer.concat(
      records.filter((record) => record.kind === "output").map((record) => Buffer.from(record.payload)),
    );
    expect(bytes.toString()).toBe("0123456789");
    expect(parseOutputWalJson(records.findLast((record) => record.kind === "resize")!)).toMatchObject({
      phase: "abort",
      changeId: "resize-cap",
    });
    expect(worker.status).toMatchObject({
      geometry: { cols: 80, rows: 24 },
      bufferedOutputBytes: 0,
      inputBackpressured: false,
    });
  });

  test("rejects an invalid resize state without appending a resize record", async () => {
    const directory = makeRoot();
    const { controller } = await startWorker(config(directory));

    await expect(controller.prepareResize({
      changeId: "wrong-source",
      from: { cols: 79, rows: 24 },
      to: { cols: 100, rows: 30 },
    })).rejects.toThrow("INVALID_STATE");
    await controller.barrier("barrier:after-reject");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint"]);
  });

  test("enforces one live writer for each derived WAL/socket directory", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory));
    const second = new TerminalWalWorker(config(directory), { input: new PassThrough() });

    await expect(second.start()).rejects.toThrow(/already (served|has a live writer)/);
    await first.controller.barrier("barrier:single-writer");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint"]);
  });

  test("clean stop resumes a new source epoch without a gap", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory), new PassThrough(), 2);
    first.input.write(Buffer.from("BEFORE"));
    await first.controller.barrier("barrier:before");
    first.controller.close();
    await first.worker.stop();
    const stopped = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    const detached = stopped.at(-1)!;
    expect(parseOutputWalJson(detached)).toEqual({
      event: "source-detached", version: 1,
      lastDurableSeq: stopped.at(-2)!.sequence.toString(),
    });
    const secondIdentity = identity({ tmuxServerPid: 5678, sessionCreated: 1_700_000_999 });
    const second = await startWorker(config(directory, { identity: secondIdentity }), new PassThrough(), 2);
    second.input.write(Buffer.from("AFTER"));
    await second.controller.barrier("barrier:after");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.filter((record) => record.kind === "gap")).toHaveLength(0);
    expect(records.filter((record) => record.kind === "lifecycle").map(parseOutputWalJson)).toEqual([
      { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } },
      { event: "resume", identity: secondIdentity, geometry: { cols: 80, rows: 24 } },
    ]);
    expect(records.filter((record) => record.kind === "output").map((r) => Buffer.from(r.payload).toString())).toEqual(["BEFORE", "AFTER"]);
  });

  test("interrupted tracked source records gap before resume and output", async () => {
    const directory = makeRoot();
    const path = resolveTerminalWalPaths(directory).walPath;
    // Model a killed worker: durable records exist, but no source-detached record.
    // Closing the raw file descriptor is harness cleanup, not a worker stop.
    const writer = new OutputWalWriter({ path, format: 2 });
    writer.appendJson("lifecycle", { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } });
    writer.appendJson("checkpoint", { event: "source-tracking", version: 1 });
    writer.appendOutput(Buffer.from("BEFORE"));
    writer.close();
    const resumed = await startWorker(config(directory), new PassThrough(), 2);
    resumed.worker.appendOrderedOutput(Buffer.from("AFTER"));
    const records = [...readOutputWal(path)];
    expect(records.map((r) => r.kind)).toEqual(["lifecycle", "checkpoint", "output", "gap", "lifecycle", "output"]);
    expect(parseOutputWalGapPayload(records[3]!.payload)).toMatchObject({
      reason: "unclean-source", lastDurableSeq: "3", missingBytes: null, coverage: "unknown",
    });
    expect(parseOutputWalJson(records[4]!)).toMatchObject({ event: "resume" });
    expect(Buffer.from(records[5]!.payload).toString()).toBe("AFTER");
  });

  test("prebuffered stdin stays after gap and resume on an interrupted source", async () => {
    const directory = makeRoot();
    const path = resolveTerminalWalPaths(directory).walPath;
    const writer = new OutputWalWriter({ path, format: 2 });
    writer.appendJson("lifecycle", { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } });
    writer.appendJson("checkpoint", { event: "source-tracking", version: 1 });
    writer.appendOutput(Buffer.from("OLD"));
    writer.close();
    const input = new PassThrough();
    input.write(Buffer.from("NEW-FIRST-BYTE"));
    await startWorker(config(directory), input, 2);
    const records = [...readOutputWal(path)];
    expect(records.slice(3).map((r) => r.kind)).toEqual(["gap", "lifecycle", "output"]);
    expect(parseOutputWalJson(records[4]!)).toMatchObject({ event: "resume" });
    expect(Buffer.from(records[5]!.payload).toString()).toBe("NEW-FIRST-BYTE");
  });

  test("recorder failure followed by reopen keeps one failure gap", async () => {
    class FakeProcess extends EventEmitter implements TerminalControlProcess {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      kill(): boolean { this.emit("exit", null, "SIGTERM"); return true; }
    }
    const directory = makeRoot();
    const fake = new FakeProcess();
    const recorder = new TerminalControlWalRecorder({ worker: config(directory), readyTimeoutMs: 2_000 }, {
      spawnControl: () => fake,
      resolveIdentity: async () => ({ ...identity(), sessionId: "$9", windowId: "@42", paneId: "%42", geometry: { cols: 80, rows: 24 } }),
    });
    try {
      const starting = recorder.start();
      fake.stdout.write("%begin 1700000000 1 0\n%end 1700000000 1 0\n%session-changed $9 durable-agent-1\n");
      await starting;
      fake.stdout.write("%output %42 bad\\x\n");
      await eventually(() => recorder.status.state === "fatal", "recorder failure");
      await eventually(() => !existsSync(resolveTerminalWalPaths(directory).lockPath), "failed recorder writer release");
      await startWorker(config(directory), new PassThrough(), 2);
      const gaps = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)].filter((r) => r.kind === "gap");
      expect(gaps.map((r) => parseOutputWalGapPayload(r.payload).reason)).toEqual(["recorder-failure"]);
    } finally {
      await recorder.stop();
    }
  });

  test("detached closer can start and write official END without a gap", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory), new PassThrough(), 2);
    first.worker.appendOrderedOutput(Buffer.from("DONE"));
    first.controller.close();
    await first.worker.stop();
    const closer = await startWorker(config(directory), new PassThrough(), 2);
    closer.controller.close();
    await closer.worker.closeLogicalLifecycle();
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.filter((r) => r.kind === "gap")).toHaveLength(0);
    expect(records.filter((r) => r.kind === "lifecycle").map((r) => parseOutputWalJson<{ event: string }>(r).event)).toEqual(["start", "resume", "end"]);
    expect(records.at(-1)!.kind).toBe("lifecycle");
  });

  test("legacy format 2 enrolls without a retrospective gap then detects interruption", async () => {
    const directory = makeRoot();
    const path = resolveTerminalWalPaths(directory).walPath;
    const writer = new OutputWalWriter({ path, format: 2 });
    writer.appendJson("lifecycle", { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } });
    writer.appendOutput(Buffer.from("LEGACY"));
    writer.close();
    const first = await startWorker(config(directory), new PassThrough(), 2);
    expect([...readOutputWal(path)].filter((r) => r.kind === "gap")).toHaveLength(0);
    // Input failure closes the fd without the clean-detach certificate.
    first.input.emit("error", new Error("simulated source interruption"));
    await first.worker.stop();
    await startWorker(config(directory), new PassThrough(), 2);
    expect([...readOutputWal(path)].filter((r) => r.kind === "gap").map((r) => parseOutputWalGapPayload(r.payload).reason)).toEqual(["unclean-source"]);
  });

  test("only explicit logical close writes END and an ended lifecycle cannot resume", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory), new PassThrough(), 2);
    first.controller.close();
    controllers = controllers.filter((value) => value !== first.controller);
    await first.worker.closeLogicalLifecycle();

    const next = new TerminalWalWorker(config(directory), { input: new PassThrough(), walFormat: 2 });
    await expect(next.start()).rejects.toThrow("logical lifecycle already ended");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint", "lifecycle"]);
    const lifecycle = records
      .filter((record) => record.kind === "lifecycle")
      .map((record) => parseOutputWalJson(record));
    expect(lifecycle).toEqual([
      { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } },
      { event: "end", identity: identity(), geometry: { cols: 80, rows: 24 } },
    ]);
  });

  test("fails closed on a forged RESUME after irreversible END", async () => {
    const directory = makeRoot();
    const path = resolveTerminalWalPaths(directory).walPath;
    const writer = new OutputWalWriter({ path });
    const lifecycle = { identity: identity(), geometry: { cols: 80, rows: 24 } };
    writer.appendJson("lifecycle", { event: "start", ...lifecycle });
    writer.appendJson("lifecycle", { event: "end", ...lifecycle });
    writer.appendJson("lifecycle", { event: "resume", ...lifecycle });
    writer.close();
    const before = readFileSync(path);

    const worker = new TerminalWalWorker(config(directory), { input: new PassThrough() });
    await expect(worker.start()).rejects.toThrow("resume after logical lifecycle end");
    expect(readFileSync(path)).toEqual(before);
  });

  test("fails closed when an existing WAL has the wrong logical identity", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory));
    first.controller.close();
    controllers = controllers.filter((value) => value !== first.controller);
    await first.worker.stop();
    const path = resolveTerminalWalPaths(directory).walPath;
    const before = readFileSync(path);

    const wrong = new TerminalWalWorker(config(directory, {
      identity: identity({ instanceId: "different-incarnation" }),
    }), { input: new PassThrough() });
    await expect(wrong.start()).rejects.toThrow("logical identity does not match");
    expect(readFileSync(path)).toEqual(before);
  });

  test("fails closed without appending when an existing WAL has no initial START", async () => {
    const directory = makeRoot();
    const path = resolveTerminalWalPaths(directory).walPath;
    const writer = new OutputWalWriter({ path });
    writer.appendOutput(Buffer.from("orphan output"));
    writer.close();
    const before = readFileSync(path);

    const worker = new TerminalWalWorker(config(directory), { input: new PassThrough() });
    await expect(worker.start()).rejects.toThrow("first record must be lifecycle start");
    expect(readFileSync(path)).toEqual(before);
  });

  test("closes an EOF-pending resize with ABORT before durable RESUME", async () => {
    const directory = makeRoot();
    const paths = resolveTerminalWalPaths(directory);
    const pending = {
      changeId: "crashed-resize",
      from: { cols: 80, rows: 24 },
      to: { cols: 90, rows: 30 },
    };
    const writer = new OutputWalWriter({ path: paths.walPath });
    writer.appendJson("lifecycle", {
      event: "start",
      identity: identity(),
      geometry: { cols: 80, rows: 24 },
    });
    writer.appendJson("resize", { phase: "prepare", ...pending });
    writer.close();

    const resumed = await startWorker(config(directory, { geometry: { cols: 80, rows: 24 } }));
    await resumed.controller.barrier("barrier:recovered");
    const records = [...readOutputWal(paths.walPath)];
    expect(records.map((record) => record.kind)).toEqual([
      "lifecycle",
      "resize",
      "resize",
      "lifecycle",
      "checkpoint",
    ]);
    expect(parseOutputWalJson(records[2]!)).toEqual({ phase: "abort", ...pending });
    expect(parseOutputWalJson(records[3]!)).toMatchObject({ event: "resume" });
  });

  test("validates config and refuses symlinked storage before opening a writer", async () => {
    expect(() => parseTerminalWalWorkerConfig({
      directory: "relative/path",
      identity: identity(),
      geometry: { cols: 80, rows: 24 },
    })).toThrow("absolute normalized path");
    expect(() => parseTerminalWalWorkerConfig({
      directory: makeRoot(),
      identity: identity(),
      geometry: { cols: 80, rows: 24 },
      typoThatWouldDisableDurability: true,
    })).toThrow("is not allowed");

    const root = mkdtempSync(join(tmpdir(), "tmwal-link-"));
    roots.push(root);
    const real = join(root, "real");
    const linked = join(root, "linked");
    const realWorker = new TerminalWalWorker(config(real), { input: new PassThrough() });
    await realWorker.start();
    workers.push(realWorker);
    await realWorker.stop({ writeLifecycleEnd: false });
    symlinkSync(real, linked);
    const linkedWorker = new TerminalWalWorker(config(linked), { input: new PassThrough() });
    await expect(linkedWorker.start()).rejects.toThrow("must not resolve through a symlink");
  });
});
