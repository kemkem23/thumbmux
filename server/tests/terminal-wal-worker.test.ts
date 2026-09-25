import {
  constants, closeSync, openSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
import {
  PipeHistoryCollector,
  pumpBinaryStream,
  type PipeFaultEvent,
  type PipeFrameEvent,
  type PipeHistoryCollectorOptions,
  type PipeScrollEvent,
} from "../src/pipe-history-collector";
import {
  PipeVtWorker,
  PIPE_VT_ATTR,
  PIPE_VT_VENDOR_SHA256,
  pipeVtAssets,
  pipeVtRunCells,
  verifyPipeVtAssets,
  type PipeVtRow,
} from "../src/pipe-vt-worker";

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

// ---------------------------------------------------------------------------
// NEWARCH L2-P: pipe-pane bytes -> pyte VT worker -> collector ports.
// The oracle in every case is the literal input the test wrote, never the
// worker's own output shape or the old source-fence definitions.
// ---------------------------------------------------------------------------

type CollectedPane = {
  collector: PipeHistoryCollector;
  scrolls: PipeScrollEvent[];
  frames: PipeFrameEvent[];
  faults: PipeFaultEvent[];
  evictedBeforeSeen: number;
  screen: Map<number, { row: PipeVtRow; wrap: boolean; pad: boolean }>;
  last: PipeFrameEvent | null;
};

const collectedPanes: CollectedPane[] = [];

afterEach(async () => {
  for (const pane of collectedPanes.splice(0)) await pane.collector.close();
});

async function collectPane(cols = 80, rows = 24, extra: Partial<PipeHistoryCollectorOptions> = {}): Promise<CollectedPane> {
  const seen = new Set<PipeScrollEvent>();
  const pane: CollectedPane = {
    collector: undefined as unknown as PipeHistoryCollector,
    scrolls: [],
    frames: [],
    faults: [],
    evictedBeforeSeen: 0,
    screen: new Map(),
    last: null,
  };
  pane.collector = new PipeHistoryCollector({
    paneKey: { serverIdentity: "private-test", paneId: "%0", birthGeneration: 1 },
    sourceEpoch: 1,
    scrollOnClear: true,
    cols,
    rows,
    ports: {
      onScroll: (event) => {
        seen.add(event);
        pane.scrolls.push(event);
      },
      onFrame: (event) => {
        pane.frames.push(event);
        pane.last = event;
        if (event.cells.full) pane.screen.clear();
        else if (event.cells.shift > 0) {
          const moved = new Map<number, { row: PipeVtRow; wrap: boolean; pad: boolean }>();
          for (const [y, entry] of pane.screen) if (y - event.cells.shift >= 0) moved.set(y - event.cells.shift, entry);
          pane.screen = moved;
        }
        for (const [y, row] of Object.entries(event.cells.dirty)) {
          const index = Number(y);
          pane.screen.set(index, {
            row,
            wrap: event.cells.softWrap[index] ?? false,
            pad: event.cells.wrapPad.includes(index),
          });
        }
      },
      onFault: (event) => pane.faults.push(event),
    },
    onEvict: (event) => {
      if (!seen.has(event)) pane.evictedBeforeSeen += 1;
    },
    ...extra,
  });
  await pane.collector.start();
  collectedPanes.push(pane);
  return pane;
}

async function settle(pane: CollectedPane, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = pane.collector.stats();
    if (stats.ackedSeq === stats.receiveSeq && stats.inflightBytes === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`collector did not settle: ${JSON.stringify(pane.collector.stats())}`);
}

function feedSplit(pane: CollectedPane, bytes: Uint8Array, size: number): void {
  for (let i = 0; i < bytes.length; i += size) pane.collector.ingest(bytes.subarray(i, i + size));
}

function cellsOf(row: PipeVtRow): string[] {
  return row.flatMap((run) => pipeVtRunCells(run));
}

function rowText(row: PipeVtRow, pad = false): string {
  const cells = cellsOf(row);
  return (pad ? cells.slice(0, -1) : cells).join("");
}

function screenRows(pane: CollectedPane): Array<{ text: string; wrap: boolean; pad: boolean }> {
  return [...pane.screen.keys()].sort((a, b) => a - b).map((y) => {
    const entry = pane.screen.get(y)!;
    return { text: rowText(entry.row, entry.pad), wrap: entry.wrap, pad: entry.pad };
  });
}

/** Join soft-wrapped physical rows (history then screen) into logical lines. */
function logicalLines(pane: CollectedPane): string[] {
  const physical = [
    ...pane.scrolls.map((s) => ({ text: rowText(s.physicalRow, s.wrapPad), wrap: s.softWrap })),
    ...screenRows(pane),
  ];
  const lines: string[] = [];
  let current = "";
  for (const row of physical) {
    if (row.wrap) {
      current += row.text;
      continue;
    }
    lines.push((current + row.text).replace(/ +$/, ""));
    current = "";
  }
  if (current) lines.push(current.replace(/ +$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function fingerprint(pane: CollectedPane): string {
  return JSON.stringify({
    scrolls: pane.scrolls.map((s) => [s.physicalRow, s.softWrap, s.wrapPad, s.geometryGeneration]),
    screen: [...pane.screen.entries()].sort((a, b) => a[0] - b[0]),
    cursor: pane.last?.cursor,
    kind: pane.last?.kind,
  });
}

const encoder = new TextEncoder();
const MIXED_CORPUS_LINES = [
  "plain ascii line",
  "ภาษาไทย ที่มีสระ ั ิ ี ่ ้ ๊ ๋ และ ำ",
  "中文字符 漢字 かなカナ 한국어",
  "family 👨‍👩‍👧‍👦 flag 🇹🇭🇯🇵 skin 👍🏽 vs16 ❤️",
  "tab\tseparated\tcells",
  "",
  "",
  "combining é ä ñ",
  "x".repeat(200),
  "ก".repeat(90) + "中".repeat(50),
];

function mixedCorpus(): Uint8Array {
  const parts: string[] = [];
  for (let round = 0; round < 6; round++) {
    for (const line of MIXED_CORPUS_LINES) parts.push(`${round}:${line}\r\n`);
    parts.push(`\x1b[31;1mred bold ${round}\x1b[0m \x1b[44m on blue \x1b[0m\r\n`);
  }
  return encoder.encode(parts.join(""));
}

/** Standard 8-column tab stops, computed from the input text alone. */
function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(8 - (out.length % 8)) : ch;
  return out;
}

function expectedMixedLogical(): string[] {
  const lines: string[] = [];
  for (let round = 0; round < 6; round++) {
    for (const line of MIXED_CORPUS_LINES) lines.push(line.includes("\t") ? expandTabs(`${round}:${line}`) : `${round}:${line}`);
    lines.push(`red bold ${round}  on blue`);
  }
  return lines;
}

describe("L2-P pipe VT worker (vendored pyte) and collector", () => {
  test("pins the vendor archive by hash, ships its licences, and refuses a tampered copy", async () => {
    const assets = pipeVtAssets(join(import.meta.dir, "../src"));
    expect(verifyPipeVtAssets(assets)).toBe(PIPE_VT_VENDOR_SHA256);
    const license = readFileSync(assets.license, "utf8");
    expect(license).toContain("pyte 0.8.2");
    expect(license).toContain("wcwidth 0.2.13");
    expect(license).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(license).toContain("The MIT License (MIT)");
    const worker = readFileSync(assets.worker, "utf8");
    expect(worker).toContain(`VENDOR_SHA256 = "${PIPE_VT_VENDOR_SHA256}"`);
    expect(worker).not.toMatch(/docs\/tasks/);

    const root = mkdtempSync(join(tmpdir(), "pipevt-tamper-"));
    roots.push(root);
    const vendor = Buffer.from(readFileSync(assets.vendor));
    vendor[vendor.length - 1] ^= 0xff;
    writeFileSync(join(root, "pipe-vt-vendor.zip"), vendor);
    writeFileSync(join(root, "pipe-vt-LICENSE.txt"), license);
    writeFileSync(join(root, "pipe-vt-worker.py"), worker);
    const tampered = pipeVtAssets(root);
    expect(() => verifyPipeVtAssets(tampered)).toThrow("vendor hash mismatch");
    // The Python side refuses on its own too, before importing anything.
    const python = spawnSync("python3", ["-B", tampered.worker], { input: Buffer.alloc(0) });
    expect(python.status).toBe(3);
    expect(python.stdout.subarray(5).toString("utf8")).toContain("vendor-hash");
    const faults: PipeFaultEvent[] = [];
    const collector = new PipeHistoryCollector({
      paneKey: { serverIdentity: "t", paneId: "%1", birthGeneration: 1 },
      sourceEpoch: 1,
      cols: 80,
      rows: 24,
      assets: tampered,
      ports: { onScroll: () => {}, onFrame: () => {}, onFault: (f) => faults.push(f) },
    });
    await expect(collector.start()).rejects.toThrow("vendor hash mismatch");
    expect(faults.map((f) => f.kind)).toEqual(["vendor-hash"]);
  });

  test("chunk splits 1/2/3/7/37/4096 give byte-for-byte the same rows, frame and cursor", async () => {
    const corpus = mixedCorpus();
    const whole = await collectPane();
    whole.collector.ingest(corpus);
    await settle(whole);
    const reference = fingerprint(whole);
    expect(whole.scrolls.length).toBeGreaterThan(50);
    for (const size of [1, 2, 3, 7, 37, 4096]) {
      const pane = await collectPane();
      feedSplit(pane, corpus, size);
      await settle(pane);
      expect(fingerprint(pane)).toBe(reference);
      expect(pane.faults).toEqual([]);
    }
  }, 60_000);

  test("Thai, CJK, ZWJ, flags and combining marks survive as the exact input text", async () => {
    const pane = await collectPane();
    feedSplit(pane, mixedCorpus(), 3);
    await settle(pane);
    expect(logicalLines(pane)).toEqual(expectedMixedLogical());
    // Every physical row carries every cell, trailing blanks included.
    for (const scroll of pane.scrolls) expect(cellsOf(scroll.physicalRow).length).toBe(80);
    // A wide glyph stays in one cell plus its "" stub; marks join their base.
    const cjk = pane.scrolls.map((s) => cellsOf(s.physicalRow)).find((cells) => cells.join("").startsWith("0:中文"))!;
    expect(cjk.slice(2, 6)).toEqual(["中", "", "文", ""]);
    const thai = pane.scrolls.map((s) => cellsOf(s.physicalRow)).find((cells) => cells.join("").startsWith("0:ภาษา"))!;
    expect(thai).toContain("ที่");
    const family = pane.scrolls.map((s) => cellsOf(s.physicalRow)).find((cells) => cells.join("").startsWith("0:family"))!;
    expect(family).toContain("👨‍");
    expect(family.join("")).toContain("👨‍👩‍👧‍👦");
  }, 30_000);

  test("SGR colours, attributes and coloured trailing blanks are kept per cell", async () => {
    const pane = await collectPane(20, 5);
    pane.collector.ingest(encoder.encode(
      "\x1b[31;1mR\x1b[0m\x1b[4;42mU\x1b[0m\x1b[7mV\x1b[0m \x1b[44m\x1b[K\x1b[0m\r\n",
    ));
    await settle(pane);
    const row = pane.screen.get(0)!.row;
    expect(cellsOf(row).length).toBe(20);
    expect(row[0]).toEqual(["red", "default", PIPE_VT_ATTR.bold, "R"]);
    expect(row[1]).toEqual(["default", "green", PIPE_VT_ATTR.underscore, "U"]);
    expect(row[2]).toEqual(["default", "default", PIPE_VT_ATTR.reverse, "V"]);
    expect(row[3]).toEqual(["default", "default", 0, " "]);
    // EL with a blue background paints the rest of the line, blanks and all.
    expect(row[4]).toEqual(["default", "blue", 0, " ".repeat(16)]);
    expect(pane.last!.cursor).toEqual({ x: 0, y: 1, visible: true });
    pane.collector.ingest(encoder.encode("\x1b[?25l"));
    await settle(pane);
    expect(pane.last!.cursor.visible).toBe(false);
    // A run with a wide glyph or a combining mark keeps one entry per cell.
    pane.collector.ingest(encoder.encode("中e\u0301x\r\n"));
    await settle(pane);
    expect(pane.screen.get(1)!.row[0]![3]).toEqual(["中", "", "e\u0301", "x", ...Array(16).fill(" ")]);
  });

  test("DECSTBM region and full-screen upward scrolls both enter tmux history", async () => {
    const pane = await collectPane(40, 10);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`base ${i}`);
    pane.collector.ingest(encoder.encode(lines.join("\r\n")));
    await settle(pane);
    expect(pane.scrolls.length).toBe(0);
    // Region rows 3..8 (1-based); 50 lines scrolled inside it.
    let region = "\x1b[3;8r\x1b[8;1H";
    for (let i = 0; i < 50; i++) region += `\r\nregion ${i}`;
    pane.collector.ingest(encoder.encode(region));
    await settle(pane);
    expect(pane.scrolls.length).toBe(50);
    expect(pane.scrolls.slice(0, 6).map(s => rowText(s.physicalRow).trimEnd())).toEqual(["base 2", "base 3", "base 4", "base 5", "base 6", "base 7"]);
    expect(screenRows(pane)[0]!.text.trimEnd()).toBe("base 0");
    expect(screenRows(pane)[7]!.text.trimEnd()).toBe("region 49");
    // Reset the region: the next full-screen scrolls are history again.
    pane.collector.ingest(encoder.encode("\x1b[r\x1b[10;1H\r\nafter 0\r\nafter 1"));
    await settle(pane);
    expect(pane.scrolls.slice(50).map((s) => rowText(s.physicalRow).trimEnd())).toEqual(["base 0", "base 1"]);
  });

  for (const mode of [47, 1047, 1049]) {
    test(`alternate screen ?${mode} keeps normal history and screen apart`, async () => {
      const pane = await collectPane(30, 6);
      pane.collector.ingest(encoder.encode("n0\r\nn1\r\nn2\r\nn3\r\nn4\r\nn5\r\nn6\r\nn7"));
      await settle(pane);
      const before = screenRows(pane).map((r) => r.text);
      const scrollsBefore = pane.scrolls.length;
      const cursorBefore = pane.last!.cursor;
      expect(scrollsBefore).toBe(2);
      let alt = `\x1b[?${mode}h\x1b[H`;
      for (let i = 0; i < 40; i++) alt += `alt repaint ${i}\r\n`;
      pane.collector.ingest(encoder.encode(alt));
      await settle(pane);
      expect(pane.last!.kind).toBe("alternate");
      expect(pane.scrolls.length).toBe(scrollsBefore);
      expect(screenRows(pane).map((r) => r.text.trimEnd())).toContain("alt repaint 39");
      pane.collector.ingest(encoder.encode(`\x1b[?${mode}l`));
      await settle(pane);
      expect(pane.last!.kind).toBe("normal");
      expect(screenRows(pane).map((r) => r.text)).toEqual(before);
      if (mode === 1049) expect(pane.last!.cursor).toEqual(cursorBefore);
      pane.collector.ingest(encoder.encode("\r\nback"));
      await settle(pane);
      expect(pane.scrolls.map((s) => rowText(s.physicalRow).trimEnd())).toEqual(["n0", "n1", "n2"]);
      expect(pane.scrolls.every((s) => !rowText(s.physicalRow).includes("alt"))).toBe(true);
    });
  }

  test("long lines reflow 80 -> 37 -> 120 without losing or duplicating content", async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const alphabet = ["a", "b", "c", "d", "e", "中", "文", "ก", "ข", "่", "1", "2"];
    const lines: string[] = [];
    for (let i = 0; i < 90; i++) {
      const length = Math.floor(random() * 170);
      let line = `L${i}:`;
      for (let j = 0; j < length; j++) line += alphabet[Math.floor(random() * alphabet.length)];
      lines.push(line);
    }
    const pane = await collectPane(80, 24);
    const write = (from: number, to: number) => {
      for (const line of lines.slice(from, to)) feedSplit(pane, encoder.encode(`${line}\r\n`), 5);
    };
    write(0, 30);
    await settle(pane);
    expect(pane.collector.resize(37, 24)).toBe(1);
    write(30, 60);
    await settle(pane);
    expect(pane.collector.resize(120, 24)).toBe(2);
    write(60, 90);
    await settle(pane);
    expect(logicalLines(pane)).toEqual(lines);
    const generations = new Set(pane.scrolls.map((s) => s.geometryGeneration));
    expect([...generations].sort()).toEqual([0, 1, 2]);
    // Rows pushed out by the shrink are 37 cells wide; none are repeated.
    expect(pane.scrolls.filter((s) => s.geometryGeneration === 1).every((s) => cellsOf(s.physicalRow).length === 37)).toBe(true);
    expect(pane.scrolls.some((s) => s.softWrap && s.wrapPad)).toBe(true);
    expect(pane.scrolls.filter((s) => s.geometryGeneration === 2).every((s) => cellsOf(s.physicalRow).length === 120)).toBe(true);
    expect(pane.last!.cells.cols).toBe(120);
    expect(pane.last!.cells.rows).toBe(24);
  }, 30_000);

  test("a 20,000-row burst reaches onScroll in order, each row before the ring evicts it", async () => {
    const pane = await collectPane(80, 24);
    const rows = 20_000;
    let burst = "";
    for (let i = 0; i < rows; i++) burst += `burst ${String(i).padStart(5, "0")} \x1b[32mok\x1b[0m ไทย 中\r\n`;
    feedSplit(pane, encoder.encode(burst), 4096);
    await settle(pane, 120_000);
    // 20,000 lines + the empty cursor line = 20,001 rows; 24 stay on screen.
    expect(pane.scrolls.length).toBe(rows + 1 - 24);
    pane.scrolls.forEach((s, i) => {
      expect(rowText(s.physicalRow).startsWith(`burst ${String(i).padStart(5, "0")} `)).toBe(true);
    });
    expect(pane.evictedBeforeSeen).toBe(0);
    const ring = pane.collector.ringSnapshot();
    expect(ring.length).toBe(500);
    expect(ring[0]).toBe(pane.scrolls[pane.scrolls.length - 500]!);
    expect(pane.faults).toEqual([]);
    expect(pane.collector.stats().scrolls).toBe(pane.scrolls.length);
  }, 180_000);

  test("a 3-row ring never evicts a row the port has not seen, even in one 1,000-row update", async () => {
    const pane = await collectPane(80, 24, { ringRows: 3 });
    let text = "";
    for (let i = 0; i < 1000; i++) text += `tiny ring ${String(i).padStart(4, "0")}\r\n`;
    pane.collector.ingest(encoder.encode(text));
    await settle(pane);
    expect(pane.scrolls.length).toBe(1001 - 24);
    expect(pane.evictedBeforeSeen).toBe(0);
    expect(pane.collector.ringSnapshot().map((e) => rowText(e.physicalRow).trimEnd())).toEqual([
      "tiny ring 0974", "tiny ring 0975", "tiny ring 0976",
    ]);
  });

  test("parser backlog over its limit reports degraded, drops nothing, and recovers", async () => {
    const pane = await collectPane(80, 24, { queueLimitBytes: 64 * 1024 });
    let accepted = true;
    let text = "";
    for (let i = 0; i < 5000; i++) text += `backlog ${String(i).padStart(5, "0")}\r\n`;
    const bytes = encoder.encode(text);
    accepted = pane.collector.ingest(bytes);
    expect(accepted).toBe(false);
    expect(pane.collector.health()).toBe("degraded");
    expect(pane.faults.map((f) => f.kind)).toEqual(["parser-backlog"]);
    await pane.collector.drained();
    await settle(pane);
    expect(pane.collector.health()).toBe("ok");
    expect(pane.scrolls.length).toBe(5001 - 24);
  }, 30_000);

  test("a dead worker is a fault and health=broken immediately, not silence", async () => {
    const pane = await collectPane();
    pane.collector.ingest(encoder.encode("before\r\n"));
    await settle(pane);
    pane.collector.killWorker();
    const deadline = Date.now() + 5_000;
    while (pane.faults.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(pane.faults.some((f) => f.kind === "worker-exit")).toBe(true);
    await untilFix1(() => pane.faults.some((f) => f.kind === "worker-restarted"));
    expect(pane.collector.health()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// L2-P real pipe: private tmux socket only (never the default server), the
// pipe opened in the same tmux command as new-session, a producer whose
// sequence ids are the independent oracle (missing/extra/wrong must be 0),
// and PLAN §6 receive->frame latency and CPU per pane of the real worker.
//
// L2P_MEASURE picks the load. The committed default "smoke" (1 pane, 10 s)
// keeps this suite short; the §6 evidence runs set "steady-1" (80x24),
// "steady-21" (21 panes, 120x40) or "burst" (20,000 rows) in a separate
// commit, because one 60 s x3 set per invocation is what fits the cage and
// the runner's wall clock. The commit of every evidence run is in REPORT.md.
// Numbers are printed as `L2P-MEASURE {json}`; §6 targets are reported, not
// asserted, so a miss is visible instead of turning into a lowered load.
// ---------------------------------------------------------------------------

const L2P_MEASURE = "smoke" as "smoke" | "steady-1" | "steady-21" | "burst";
const LIVE_TMUX = process.env.GITHUB_ACTIONS !== "true";

type MeasureConfig = {
  name: string;
  panes: number;
  cols: number;
  rows: number;
  rate: number;
  seconds: number;
  rounds: number;
  baseline: boolean;
  idleSeconds: number;
  count?: number;
  warmupSeconds?: number;
};

const MEASURE_CONFIGS: Record<typeof L2P_MEASURE, MeasureConfig> = {
  smoke: { name: "smoke", panes: 1, cols: 80, rows: 24, rate: 100, seconds: 10, rounds: 1, baseline: false, idleSeconds: 0 },
  "steady-1": { name: "steady-1", panes: 1, cols: 80, rows: 24, rate: 100, seconds: 60, rounds: 3, baseline: true, idleSeconds: 15 },
  "steady-21": { name: "steady-21", panes: 21, cols: 120, rows: 40, rate: 100, seconds: 60, rounds: 3, baseline: true, idleSeconds: 15 },
  burst: { name: "burst", panes: 1, cols: 80, rows: 24, rate: 0, seconds: 0, rounds: 1, baseline: false, idleSeconds: 0, count: 20_000 },
};

/** [raw bytes the producer writes, text the screen must show]. */
const PRODUCER_SAMPLES: Array<[string, string]> = [
  ["\x1b[31mred\x1b[0m plain ascii", "red plain ascii"],
  ["ภาษาไทย สระ ที่ น้ำ", "ภาษาไทย สระ ที่ น้ำ"],
  ["中文 漢字 かな 한국어", "中文 漢字 かな 한국어"],
  ["emoji 👨‍👩‍👧 🇹🇭 👍🏽", "emoji 👨‍👩‍👧 🇹🇭 👍🏽"],
  ["\x1b[1;44m bold on blue \x1b[0m end", " bold on blue  end"],
  ["combining é ä", "combining é ä"],
];

const PRODUCER_SCRIPT = `
import json, sys, time, os
pane, rate, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
samples = [raw for raw, _ in json.loads(sys.argv[4])]
out = sys.stdout.buffer
if len(sys.argv) > 5:
    while not os.path.exists(sys.argv[5]):
        time.sleep(.005)
start = time.monotonic()
for i in range(count):
    if rate > 0:
        delay = start + i / rate - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    if i % 50 == 25:
        # TUI-style status: save cursor, paint at row 1 col 60, restore.
        out.write(b"\\x1b7\\x1b[1;60H\\x1b[7mstatus\\x1b[0m\\x1b8")
    out.write(f"{pane} {i:06d} {samples[i % len(samples)]}\\r\\n".encode())
    if rate > 0:
        out.flush()
out.write(f"{pane} DONE\\r\\n".encode())
out.flush()
time.sleep(3600)
`;

let clockTicks = 0;
function cpuSeconds(pid: number | null | undefined): number {
  if (!pid) return 0;
  if (!clockTicks) clockTicks = Number(spawnSync("getconf", ["CLK_TCK"]).stdout.toString().trim()) || 100;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / clockTicks;
  } catch {
    return 0;
  }
}

function hostCpuSeconds(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1e6;
}

/** tmux's `exec cat > fifo` writer: argv `cat`, stdout on our FIFO. */
function writerPid(fifo: string): number | null {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (argv.length === 1 && /(?:^|\/)cat$/.test(argv[0]!) && readlinkSync(`/proc/${name}/fd/1`) === fifo) return Number(name);
    } catch {}
  }
  return null;
}

function privateTmux(socket: string, args: string[]) {
  const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RoundResult = Record<string, unknown>;

/**
 * Measurement pane: keeps only row text for the oracle, so the harness's own
 * retained heap does not inflate the host GC cost being measured.
 */
type LightPane = {
  collector: PipeHistoryCollector;
  history: Array<{ text: string; wrap: boolean }>;
  screen: Map<number, { text: string; wrap: boolean }>;
  faults: PipeFaultEvent[];
};

async function lightPane(cols: number, rows: number, paneKey: PaneKeyLike): Promise<LightPane> {
  const pane: LightPane = { collector: undefined as unknown as PipeHistoryCollector, history: [], screen: new Map(), faults: [] };
  pane.collector = new PipeHistoryCollector({
    paneKey,
    sourceEpoch: 1,
    cols,
    rows,
    latencySampleLimit: 2_000_000,
    ports: {
      onScroll: (event) => pane.history.push({ text: rowText(event.physicalRow, event.wrapPad), wrap: event.softWrap }),
      onFrame: (event) => {
        if (event.cells.full) pane.screen.clear();
        else if (event.cells.shift > 0) {
          const moved = new Map<number, { text: string; wrap: boolean }>();
          for (const [y, entry] of pane.screen) if (y - event.cells.shift >= 0) moved.set(y - event.cells.shift, entry);
          pane.screen = moved;
        }
        for (const [y, row] of Object.entries(event.cells.dirty)) {
          const index = Number(y);
          pane.screen.set(index, { text: rowText(row, event.cells.wrapPad.includes(index)), wrap: event.cells.softWrap[index] ?? false });
        }
      },
      onFault: (event) => pane.faults.push(event),
    },
  });
  await pane.collector.start();
  return pane;
}

function lightLogical(pane: LightPane): string[] {
  const physical = [...pane.history, ...[...pane.screen.keys()].sort((a, b) => a - b).map((y) => pane.screen.get(y)!)];
  const lines: string[] = [];
  let current = "";
  for (const row of physical) {
    if (row.wrap) {
      current += row.text;
      continue;
    }
    lines.push((current + row.text).replace(/ +$/, ""));
    current = "";
  }
  if (current) lines.push(current.replace(/ +$/, ""));
  return lines;
}

type PaneKeyLike = { serverIdentity: string; paneId: string; birthGeneration: number };

async function measureRound(cfg: MeasureConfig, round: number, withPipe: boolean): Promise<RoundResult> {
  const dir = mkdtempSync(join(tmpdir(), "l2p-"));
  roots.push(dir);
  const socket = join(dir, "x.sock");
  const producer = join(dir, "producer.py");
  writeFileSync(producer, PRODUCER_SCRIPT);
  const count = cfg.count ?? cfg.rate * (cfg.seconds + (cfg.warmupSeconds ?? 0) + 3);
  const panes: Array<{ name: string; fifo: string; pane?: LightPane; reader?: ReturnType<typeof Bun.spawn>; pump?: Promise<number>; writer?: number | null }> = [];
  const samples = JSON.stringify(PRODUCER_SAMPLES);
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  try {
    for (let p = 0; p < cfg.panes; p++) {
      const name = `p${p}`;
      const fifo = join(dir, `${name}.fifo`);
      const entry: (typeof panes)[number] = { name, fifo };
      const barrier = cfg.warmupSeconds ? ` ${shellQuote(join(dir, "start"))}` : "";
      const command = `exec python3 -B ${shellQuote(producer)} ${name} ${cfg.rate} ${count} ${shellQuote(samples)}${barrier}`;
      const birth = [
        ...(p === 0 ? ["-f", "/dev/null"] : []),
        "new-session", "-d", "-s", name, "-x", String(cfg.cols), "-y", String(cfg.rows), command,
      ];
      if (withPipe) {
        expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
        entry.pane = await lightPane(cfg.cols, cfg.rows, { serverIdentity: socket, paneId: name, birthGeneration: 1 });
        entry.reader = Bun.spawn(["cat", fifo], { stdout: "pipe", stderr: "ignore" });
        entry.pump = pumpBinaryStream(entry.reader.stdout as ReadableStream<Uint8Array>, entry.pane.collector);
        // Same tmux command as the birth: the reader sees byte 0.
        privateTmux(socket, [...birth, ";", "pipe-pane", "-O", `exec cat > ${shellQuote(fifo)}`]);
      } else {
        privateTmux(socket, birth);
      }
      panes.push(entry);
    }
    const serverPid = Number(privateTmux(socket, ["display-message", "-p", "#{pid}"]).trim());
    if (cfg.warmupSeconds) writeFileSync(join(dir, "start"), "start");
    await sleep(200); // let tmux's `sh -c exec cat` writers finish their exec
    for (const entry of panes) if (withPipe) entry.writer = writerPid(entry.fifo);
    if (cfg.warmupSeconds) await sleep(cfg.warmupSeconds * 1000);
    const components = () => ({
      worker: panes.reduce((sum, e) => sum + cpuSeconds(e.pane?.collector.workerPid), 0),
      reader: panes.reduce((sum, e) => sum + cpuSeconds(e.reader?.pid), 0),
      writer: panes.reduce((sum, e) => sum + cpuSeconds(e.writer), 0),
      tmux: cpuSeconds(serverPid),
      host: hostCpuSeconds(),
    });
    const diff = (a: ReturnType<typeof components>, b: ReturnType<typeof components>) => ({
      worker: b.worker - a.worker,
      reader: b.reader - a.reader,
      writer: b.writer - a.writer,
      tmux: b.tmux - a.tmux,
      host: b.host - a.host,
    });
    for (const entry of panes) entry.pane?.collector.resetLatency();
    const started = performance.now();
    const t0 = components();
    const allDone = () => panes.every((e) => e.pane && [
      ...[...e.pane.screen.values()].map((r) => r.text),
      ...e.pane.history.slice(-50).map((r) => r.text),
    ].some((text) => text.startsWith(`${e.name} DONE`)));
    if (cfg.seconds > 0) {
      await sleep(cfg.seconds * 1000);
    } else {
      const deadline = Date.now() + 240_000;
      while (!allDone() && Date.now() < deadline) await sleep(20);
    }
    const t1 = components();
    const activeSeconds = (performance.now() - started) / 1000;
    const result: RoundResult = { config: cfg.name, round, withPipe, panes: cfg.panes, geometry: `${cfg.cols}x${cfg.rows}`, ratePerPane: cfg.rate, activeSeconds, active: diff(t0, t1) };
    if (!withPipe) return result;

    const deadline = Date.now() + 60_000;
    while (!allDone() && Date.now() < deadline) await sleep(50);
    for (const entry of panes) {
      const settleBy = Date.now() + 30_000;
      while (Date.now() < settleBy) {
        const stats = entry.pane!.collector.stats();
        if (stats.ackedSeq === stats.receiveSeq && stats.inflightBytes === 0) break;
        await sleep(5);
      }
    }
    if (cfg.idleSeconds > 0) {
      const i0 = components();
      await sleep(cfg.idleSeconds * 1000);
      result.idleSeconds = cfg.idleSeconds;
      result.idle = diff(i0, components());
    }

    // Oracle: every producer id exactly once, in order, with its exact text.
    let missing = 0;
    let extra = 0;
    let wrong = 0;
    for (const entry of panes) {
      const pane = entry.pane!;
      const ids: number[] = [];
      for (const line of lightLogical(pane)) {
        const match = new RegExp(`^${entry.name} (\\d{6}) (.*)$`).exec(line);
        if (!match) continue;
        const id = Number(match[1]);
        ids.push(id);
        const expected = PRODUCER_SAMPLES[id % PRODUCER_SAMPLES.length]![1];
        const shown = match[2]!.replace(/ +status$/, "").replace(/ +$/, "");
        if (shown !== expected.replace(/ +$/, "")) wrong += 1;
      }
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id) || id >= count) extra += 1;
        seen.add(id);
      }
      for (let id = 0; id < count; id++) if (!seen.has(id)) missing += 1;
      expect(ids[0]).toBe(0); // byte 0: the pipe opened with the pane
      expect(pane.faults).toEqual([]);
    }
    const latencies = panes.flatMap((e) => [...e.pane!.collector.latencySamples()]).sort((a, b) => a - b);
    const pick = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))]! : null;
    const stats = panes.map((e) => e.pane!.collector.stats());
    result.rowsPerPane = count;
    result.latencyMs = { samples: latencies.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: latencies.at(-1) ?? null };
    result.worstPaneP95Ms = Math.max(...stats.map((s) => s.latency.p95Ms ?? 0));
    result.timeSplitMs = {
      workerParse: stats.reduce((sum, s) => sum + s.workerParseMs, 0),
      workerEncode: stats.reduce((sum, s) => sum + s.workerEncodeMs, 0),
      hostHandle: stats.reduce((sum, s) => sum + s.hostHandleMs, 0),
    };
    result.scrolls = stats.reduce((sum, s) => sum + s.scrolls, 0);
    result.frames = stats.reduce((sum, s) => sum + s.frames, 0);
    result.admission = { acceptedBytes: stats.reduce((sum, s) => sum + s.acceptedBytes, 0),
      refusedBytes: stats.reduce((sum, s) => sum + s.refusedBytes, 0) };
    result.oracle = { missing, extra, wrong };
    expect({ missing, extra, wrong }).toEqual({ missing: 0, extra: 0, wrong: 0 });
    return result;
  } finally {
    for (const entry of panes) entry.reader?.kill();
    spawnSync("tmux", ["-S", socket, "kill-server"]);
    for (const entry of panes) await entry.pane?.collector.close();
  }
}

for (const panes of [1, 21]) for (const [cols, rows] of [[80, 24], [120, 40]] as const) {
  test(`I1 CPU profile ${panes} panes ${cols}x${rows} 60s x3 after 10s warmup`, async () => {
    const cfg: MeasureConfig = { name: `I1-${panes}-${cols}x${rows}`, panes, cols, rows,
      rate: 100, seconds: 60, rounds: 3, baseline: true, idleSeconds: 0, warmupSeconds: 10 };
    const base = await measureRound(cfg, 0, false);
    console.log(`I1 CPU ${JSON.stringify(base)}`);
    for (let round = 1; round <= 3; round++) {
      const result = await measureRound(cfg, round, true);
      const active = result.active as Record<string, number>;
      const baseline = base.active as Record<string, number>;
      const seconds = result.activeSeconds as number;
      const cores = (active.worker! + active.reader! + active.writer! + active.host!) / seconds;
      const tmuxDeltaPercent = 100 * (active.tmux! / seconds - baseline.tmux! / (base.activeSeconds as number));
      console.log(`I1 CPU ${JSON.stringify({ ...result, cores, tmuxDeltaPercent,
        parserTargetLe1Core: cores <= 1, tmuxDeltaLe10Percent: tmuxDeltaPercent <= 10,
        aggregateIncludesCaptureAndDisk: false })}`);
      expect((result.oracle as { missing: number }).missing).toBe(0);
    }
  }, 900_000);
}

describe("L2-P real pipe-pane on a private tmux socket", () => {
  test.skipIf(!LIVE_TMUX)(`measure ${L2P_MEASURE}: birth pipe, oracle 0 missing/extra/wrong, latency and CPU`, async () => {
    const cfg = MEASURE_CONFIGS[L2P_MEASURE];
    const results: RoundResult[] = [];
    let base: RoundResult | null = null;
    if (cfg.baseline) {
      base = await measureRound(cfg, 0, false);
      console.log(`L2P-MEASURE ${JSON.stringify(base)}`);
    }
    for (let round = 1; round <= cfg.rounds; round++) {
      const result = await measureRound(cfg, round, true);
      const active = result.active as Record<string, number>;
      const baseActive = base?.active as Record<string, number> | undefined;
      const seconds = result.activeSeconds as number;
      const tmuxExtra = active.tmux! - (baseActive ? baseActive.tmux! * (seconds / (base!.activeSeconds as number)) : 0);
      const hostExtra = active.host! - (baseActive ? baseActive.host! * (seconds / (base!.activeSeconds as number)) : 0);
      const ownCpu = active.worker! + active.reader! + active.writer!;
      result.cpuPercentPerPane = {
        workerReaderWriter: (ownCpu / seconds / cfg.panes) * 100,
        withTmuxAndHostOverBaseline: ((ownCpu + tmuxExtra + hostExtra) / seconds / cfg.panes) * 100,
        workerOnly: (active.worker! / seconds / cfg.panes) * 100,
        totalCores: (ownCpu + tmuxExtra + hostExtra) / seconds,
      };
      if (result.idle) {
        const idle = result.idle as Record<string, number>;
        result.idleCpuPercentPerPane = ((idle.worker! + idle.reader! + idle.writer!) / cfg.idleSeconds / cfg.panes) * 100;
      }
      const latency = result.latencyMs as { p95: number; p99: number };
      result.targets = {
        latencyP95le16: latency.p95 <= 16,
        latencyP99le33: latency.p99 <= 33,
        activeCpuLe5pct: (result.cpuPercentPerPane as { withTmuxAndHostOverBaseline: number }).withTmuxAndHostOverBaseline <= 5,
        idleCpuLe05pct: result.idleCpuPercentPerPane === undefined ? null : (result.idleCpuPercentPerPane as number) <= 0.5,
        totalLe1Core: (result.cpuPercentPerPane as { totalCores: number }).totalCores <= 1,
      };
      console.log(`L2P-MEASURE ${JSON.stringify(result)}`);
      results.push(result);
    }
    expect(results.length).toBe(cfg.rounds);
    for (const result of results) expect((result.latencyMs as { samples: number }).samples).toBeGreaterThan(0);
  }, 900_000);
});


async function untilFix1(predicate: () => boolean, timeout = 30_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("FIX2 condition timed out");
    await sleep(10);
  }
}

describe("L2-P FIX2 recovery regressions", () => {
  test("throwing onFault cannot prevent respawn or recovery after successive upstream breaks", async () => {
    const faults: PipeFaultEvent[] = [];
    const pane = await collectPane(80, 24, { ports: {
      onScroll: () => {}, onFrame: () => {},
      onFault: (event) => { faults.push(event); throw new Error("consumer fault injection"); },
    } });
    const c = pane.collector;
    c.killWorker();
    await untilFix1(() => faults.some((f) => f.kind === "worker-restarted"));
    expect(c.currentSourceEpoch()).toBe(2);
    c.beginSourceEpoch(2);
    expect(c.currentSourceEpoch()).toBe(3);
    expect(() => c.beginSourceEpoch(2)).toThrow();
    c.killWorker();
    await untilFix1(() => faults.filter((f) => f.kind === "worker-restarted").length === 2);
    expect(c.currentSourceEpoch()).toBe(4);
    c.beginSourceEpoch(3);
    expect(c.currentSourceEpoch()).toBe(5);
    c.ingest(encoder.encode("recovered\r\n"));
    await settle(pane);
    expect(c.health()).toBe("ok");
    expect(c.stats().inflightBytes).toBe(0);
  }, 30_000);

  for (const code of ["EPIPE", "EBADF"]) test(`timer flush ${code} releases input and survives a throwing fault callback`, async () => {
    const faults: string[] = [];
    const worker = new PipeVtWorker({ cols: 80, rows: 24, onUpdate: () => {},
      onFault: (f) => { faults.push(f.message); throw new Error("consumer fault injection"); },
    });
    await worker.start();
    const internals = worker as unknown as { inputFd: number | null; queue: Buffer[]; flushTimer: ReturnType<typeof setTimeout> | null; flush(): void };
    const dir = mkdtempSync(join(tmpdir(), "l2p-epipe-"));
    roots.push(dir);
    const fifo = join(dir, "fault.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const writeFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(readFd);
    if (internals.inputFd !== null) closeSync(internals.inputFd);
    internals.inputFd = writeFd;
    if (code === "EBADF") closeSync(writeFd);
    internals.queue.push(Buffer.from("fault"));
    internals.flushTimer = setTimeout(() => internals.flush(), 1);
    try {
      await untilFix1(() => faults.some((f) => f.includes(code)));
      expect(internals.inputFd).toBeNull();
      expect(internals.queue).toEqual([]);
      expect(internals.flushTimer).toBeNull();
      await worker.close();
      console.log(`FIX2 injected ${code}: timer survived, input released, worker reaped`);
    } finally { await worker.close(); }
  }, 15_000);
});


test("I1 scroll receipts precede frame publication and rejected receipts release waiters", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let block = true;
  let scrollStarted = false;
  let frameAfterInput = false;
  const faults: PipeFaultEvent[] = [];
  const pane = await collectPane(80, 3, { ports: {
    onScroll: async () => { scrollStarted = true; if (block) await held; throw new Error("I1 disk rejection"); },
    onFrame: event => { if (event.receiveSeq > 0) frameAfterInput = true; },
    onFault: event => { faults.push(event); },
  } });
  pane.collector.ingest(encoder.encode("A\r\nB\r\nC\r\nD\r\n"));
  await untilFix1(() => scrollStarted);
  expect(frameAfterInput).toBe(false);
  expect(pane.collector.stats().inflightBytes).toBeGreaterThan(0);
  block = false;
  release();
  await untilFix1(() => faults.some(f => f.kind === "consumer-rejected"));
  expect(frameAfterInput).toBe(false);
  expect(pane.collector.stats().inflightBytes).toBe(0);
  const fault = faults.find(f => f.kind === "consumer-rejected")!;
  expect(fault.missingCount).toBeNull();
  expect(fault.paneKey).toEqual(pane.collector.paneKey);
  expect(fault.receiveSeqFrom).toBe(1);
  expect(fault.receiveSeqTo).toBe(1);
  await pane.collector.drained();
});

test("I1 frame Promise rejection becomes a contextual issue without an unhandled rejection", async () => {
  const faults: PipeFaultEvent[] = [];
  const pane = await collectPane(80, 3, { ports: {
    onScroll: () => {},
    onFrame: async e => { if (e.receiveSeq > 0) throw new Error("frame publish rejected"); },
    onFault: e => { faults.push(e); },
  } });
  pane.collector.ingest(encoder.encode("frame"));
  await untilFix1(() => faults.some(f => f.kind === "consumer-rejected"));
  expect(faults.find(f => f.kind === "consumer-rejected")?.missingCount).toBeNull();
  expect(pane.collector.stats().inflightBytes).toBe(0);
  await pane.collector.drained();
});

test("I1 owner reset discards alternate and partial UTF8/ESC state before next epoch", async () => {
  const pane = await collectPane(80, 3);
  pane.collector.ingest(encoder.encode("\x1b[?1049hALT\x1b[31"));
  await settle(pane);
  expect(pane.last?.kind).toBe("alternate");
  pane.collector.beginSourceEpoch(2);
  pane.collector.ingest(encoder.encode("mNORMAL\r\nA\r\nB\r\nC\r\n"));
  await settle(pane);
  expect(pane.last?.kind).toBe("normal");
  expect(pane.last?.sourceEpoch).toBe(2);
  expect(pane.scrolls.some(s => rowText(s.physicalRow).startsWith("mNORMAL") && s.sourceEpoch === 2)).toBe(true);
  expect(pane.faults.some(f => f.kind === "source-reset" && f.missingCount === null)).toBe(true);
  pane.collector.ingest(Uint8Array.of(0xe0, 0xb8));
  await settle(pane);
  pane.collector.beginSourceEpoch(3);
  pane.collector.ingest(encoder.encode("plain"));
  await settle(pane);
  expect(screenRows(pane).map(r => r.text).join("")).toContain("plain");
  expect(screenRows(pane).map(r => r.text).join("")).not.toContain("�");
});

test("I1 oversized admission is bounded and marks the exact rejected sequence", async () => {
  const pane = await collectPane(80, 3, { queueLimitBytes: 64 });
  const seq = pane.collector.stats().receiveSeq + 1;
  expect(pane.collector.ingest(new Uint8Array(64 * 1024 + 65))).toBe(false);
  expect(pane.collector.stats().inflightBytes).toBe(0);
  const fault = pane.faults.at(-1)!;
  expect(pane.collector.stats().refusedBytes).toBe(64 * 1024 + 65);
  expect(fault.kind).toBe("parser-backlog");
  expect(fault.receiveSeqFrom).toBe(seq);
  expect(fault.receiveSeqTo).toBe(seq);
  expect(fault.missingCount).toBeNull();
  pane.collector.ingest(encoder.encode("recovered"));
  await settle(pane);
  expect(pane.collector.health()).toBe("ok");
});

describe("L2-P DEBT recovery", () => {
  test("55 five separated recoveries keep the first resized row in the collector epoch", async () => {
    const pane = await collectPane(80, 24, { sourceEpoch: 7 });
    const c = pane.collector;
    for (let round = 1; round <= 5; round++) {
      c.killWorker();
      c.resize(80, 23 + round);
      await untilFix1(() => pane.faults.filter(f => f.kind === "worker-restarted").length === round);
      c.resize(80, 24);
      const firstSeq = c.stats().receiveSeq + 1;
      const first = pane.scrolls.length;
      c.ingest(encoder.encode(Array.from({ length: 40 }, (_, i) => `R${round}-${i}`).join("\r\n")));
      await settle(pane);
      const added = pane.scrolls.slice(first);
      expect(added.length).toBeGreaterThan(0);
      expect(rowText(added[0]!.physicalRow).trimEnd()).toBe(`R${round}-0`);
      for (const row of added) {
        expect(row.sourceEpoch).toBe(7 + round);
        expect(row.receiveSeq).toBe(firstSeq);
      }
      expect(c.currentSourceEpoch()).toBe(7 + round);
      expect(c.health()).toBe("ok");
      await sleep(100);
    }
    console.log("DEBT five recoveries: first row epoch/receiveSeq correct, health ok");
  }, 30_000);

  test("E3 marker orders earlier and later scrolls within one input without discarding the screen", async () => {
    const events: string[] = [];
    const pane = await collectPane(80, 3, { ports: {
      onScroll: e => events.push(rowText(e.physicalRow).trimEnd()),
      onFrame: () => {},
      onFault: f => events.push(f.kind),
    } });
    pane.collector.ingest(encoder.encode("A\r\nB\r\nC\r\nD\x1b[3J\r\nE\r\nF"));
    await settle(pane);
    expect(events).toEqual(["A", "history-cleared", "B", "C"]);
    expect(pane.collector.ringSnapshot().map(e => rowText(e.physicalRow).trimEnd())).toEqual(["B", "C"]);
    expect(pane.collector.health()).toBe("ok");
  });
});


test("51 five clears with unknown policy remain explicit faults and recover", async () => {
  const pane = await collectPane(80, 24, { scrollOnClear: undefined });
  const pid = pane.collector.workerPid;
  for (let round = 1; round <= 5; round++) {
    pane.collector.ingest(encoder.encode(`before-${round}\r\n`));
    await settle(pane);
    pane.collector.ingest(encoder.encode("\x1b[H\x1b[2J"));
    await settle(pane);
    expect(pane.faults.filter(f => f.kind === "clear-policy-unknown").length).toBe(round);
    expect(pane.collector.health()).toBe("degraded");
    expect(pane.collector.workerPid).toBe(pid);
  }
  pane.collector.setScrollOnClear(true);
  expect(pane.collector.health()).toBe("degraded"); // only a parser receipt restores health
  pane.collector.ingest(encoder.encode("after-five-clears"));
  await settle(pane);
  expect(screenRows(pane).map(row => row.text).join("\n")).toContain("after-five-clears");
  expect(pane.collector.health()).toBe("ok");
  expect(pane.faults.filter(f => f.kind === "worker-restarted").length).toBe(0);
  expect(pane.faults.filter(f => f.missingCount === null).length).toBe(5);
  console.log("I1 unknown policy: 5 explicit faults, zero respawns, ordered known policy restores health");
}, 30_000);

// Negative controls mutate only a private copy of the Python worker assets.
for (const kind of ["RIS", "E3"] as const) test(`DEBT mutation ${kind} reproduces ten silently lost rows`, async () => {
  const assets = pipeVtAssets();
  const root = mkdtempSync(join(tmpdir(), "l2p-debt-mutation-"));
  roots.push(root);
  let source = readFileSync(assets.worker, "utf8");
  if (kind === "RIS") {
    const original = "self.preserve_on_clear()\n        super().reset()";
    expect(source).toContain(original);
    source = source.replace(original, "super().reset()");
  } else {
    expect(source).toContain("if how == 3:");
    source = source.replace("if how == 3:", "if how == -999:");
  }
  writeFileSync(join(root, "pipe-vt-worker.py"), source);
  writeFileSync(join(root, "pipe-vt-vendor.zip"), readFileSync(assets.vendor));
  writeFileSync(join(root, "pipe-vt-LICENSE.txt"), readFileSync(assets.license));
  const pane = await collectPane(80, 24, { assets: pipeVtAssets(root) });
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `L${String(from + i).padStart(6, "0")}\r\n`).join("");
  pane.collector.ingest(encoder.encode(lines(1, 10)));
  await settle(pane);
  pane.collector.ingest(encoder.encode(kind === "RIS" ? "\x1bc" : "\x1b[3J"));
  pane.collector.ingest(encoder.encode(lines(11, 60)));
  await settle(pane);
  const seen = (pane.scrolls.map(e => rowText(e.physicalRow)).join("\n") + screenRows(pane).map(row => row.text).join("\n")).match(/L\d{6}/g) ?? [];
  expect(seen.length).toBe(50);
  expect(seen).not.toContain("L000001");
  expect(seen).toContain("L000060");
  expect(pane.faults).toEqual([]);
  console.log(`DEBT mutation ${kind}: missing=10 extra=0 duplicate=0 faults=0 (negative control detected)`);
});

for (const mutation of [false, true]) test(`DEBT2 ED0 split-byte regression mutation=${mutation}`, async () => {
  const assets = pipeVtAssets();
  let selected = assets;
  if (mutation) {
    const root = mkdtempSync(join(tmpdir(), "l2p-debt2-mutation-"));
    roots.push(root);
    const source = readFileSync(assets.worker, "utf8");
    const clause = "how == 2 or (how == 0 and self.cursor.x == 0 and self.cursor.y == 0)";
    expect(source).toContain(clause);
    writeFileSync(join(root, "pipe-vt-worker.py"), source.replace(clause, "how == 2"));
    writeFileSync(join(root, "pipe-vt-vendor.zip"), readFileSync(assets.vendor));
    writeFileSync(join(root, "pipe-vt-LICENSE.txt"), readFileSync(assets.license));
    selected = pipeVtAssets(root);
  }
  const pane = await collectPane(80, 24, { assets: selected });
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `L${String(from + i).padStart(6, "0")}\r\n`).join("");
  feedSplit(pane, encoder.encode(lines(1, 10) + "\x1b[H\x1b[J" + lines(11, 60)), 1);
  await settle(pane);
  const ids = (pane.scrolls.map(e => rowText(e.physicalRow)).join("\n") + screenRows(pane).map(row => row.text).join("\n")).match(/L\d{6}/g) ?? [];
  expect(ids).toEqual(Array.from({ length: mutation ? 50 : 60 }, (_, i) => `L${String(i + (mutation ? 11 : 1)).padStart(6, "0")}`));
  expect(pane.faults).toEqual([]);
  console.log(`DEBT2 ED0 mutation=${mutation} missing=${mutation ? 10 : 0} extra=0 duplicate=0 faults=0`);
});


for (const size of [1, 7, 65536]) test(`DEBT3 DCS queries, embedded escapes and cancellation chunk=${size}`, async () => {
  const pane = await collectPane();
  const ignored = [
    "\x1bP+q544e\x1b\\", "\x1bP$qm\x1b\\",
    "\x1bPtmux;\x1b\x1b[2J\x1b\\", "\x1bPzdata\x1bPqignored\x1b\\",
    "\x1bP12:bad\x1b\\", "\x1bP12\x18", "\x1bP$\x1a",
  ];
  const body = Array.from({ length: 140 }, (_, i) => `L${String(i + 1).padStart(6, "0")}\r\n${ignored[i % ignored.length]}`).join("");
  feedSplit(pane, encoder.encode(body), size);
  await settle(pane);
  const ids = (pane.scrolls.map(e => rowText(e.physicalRow)).join("\n") + screenRows(pane).map(r => r.text).join("\n")).match(/L\d{6}/g) ?? [];
  expect(ids).toEqual(Array.from({ length: 140 }, (_, i) => `L${String(i + 1).padStart(6, "0")}`));
  expect(pane.faults).toEqual([]);
  expect(pane.collector.currentSourceEpoch()).toBe(1);
  expect(pane.collector.health()).toBe("ok");
});

for (const header of ["q", "0;1;0q"]) test(`DEBT3 split SIXEL ${header} faults only after ST and recovers`, async () => {
  const pane = await collectPane();
  feedSplit(pane, encoder.encode(`\x1bP${header}\"1;1;10;60~`), 1);
  await settle(pane);
  expect(pane.faults).toEqual([]);
  feedSplit(pane, encoder.encode("\x1b\\"), 1);
  await untilFix1(() => pane.faults.some(f => f.kind === "worker-restarted"));
  expect(pane.faults.filter(f => f.kind === "worker-error").length).toBe(1);
  expect(pane.faults.find(f => f.kind === "worker-error")?.message).toContain("DCS/SIXEL");
  pane.collector.ingest(encoder.encode("after-sixel\r\n"));
  await settle(pane);
  expect(screenRows(pane).map(r => r.text).join("\n")).toContain("after-sixel");
  expect(pane.collector.currentSourceEpoch()).toBe(2);
});
