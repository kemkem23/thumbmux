import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import {
  OutputWalWriter,
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
): Promise<{ worker: TerminalWalWorker; input: PassThrough; controller: TerminalWalController }> {
  const worker = new TerminalWalWorker(workerConfig, { input, clock: () => 1_700_000_000_000 });
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

  test("writes RESUME for the same logical identity while allowing a new tmux source epoch", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory));
    first.controller.close();
    controllers = controllers.filter((value) => value !== first.controller);
    await first.worker.stop();

    const secondIdentity = identity({
      paneTarget: "=durable-agent-1:2.1",
      tmuxServerPid: 5678,
      sessionCreated: 1_700_000_999,
    });
    const second = await startWorker(config(directory, {
      identity: secondIdentity,
      geometry: { cols: 120, rows: 40 },
    }));
    await second.controller.barrier("barrier:resumed");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    const lifecycle = records
      .filter((record) => record.kind === "lifecycle")
      .map((record) => parseOutputWalJson(record));
    expect(lifecycle).toEqual([
      { event: "start", identity: identity(), geometry: { cols: 80, rows: 24 } },
      { event: "resume", identity: secondIdentity, geometry: { cols: 120, rows: 40 } },
    ]);
  });

  test("only explicit logical close writes END and an ended lifecycle cannot resume", async () => {
    const directory = makeRoot();
    const first = await startWorker(config(directory));
    first.controller.close();
    controllers = controllers.filter((value) => value !== first.controller);
    await first.worker.closeLogicalLifecycle();

    const next = new TerminalWalWorker(config(directory), { input: new PassThrough() });
    await expect(next.start()).rejects.toThrow("logical lifecycle already ended");
    const lifecycle = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)]
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
