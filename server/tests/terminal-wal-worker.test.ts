import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  type PipeFaultEvent,
  type PipeFrameEvent,
  type PipeHistoryCollectorOptions,
  type PipeScrollEvent,
} from "../src/pipe-history-collector";
import {
  PIPE_VT_ATTR,
  PIPE_VT_VENDOR_SHA256,
  pipeVtAssets,
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
  return row.flatMap((run) => run[3]);
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
    expect(row[0]).toEqual(["red", "default", PIPE_VT_ATTR.bold, ["R"]]);
    expect(row[1]).toEqual(["default", "green", PIPE_VT_ATTR.underscore, ["U"]]);
    expect(row[2]).toEqual(["default", "default", PIPE_VT_ATTR.reverse, ["V"]]);
    expect(row[3]).toEqual(["default", "default", 0, [" "]]);
    // EL with a blue background paints the rest of the line, blanks and all.
    expect(row[4]).toEqual(["default", "blue", 0, Array(16).fill(" ")]);
    expect(pane.last!.cursor).toEqual({ x: 0, y: 1, visible: true });
    pane.collector.ingest(encoder.encode("\x1b[?25l"));
    await settle(pane);
    expect(pane.last!.cursor.visible).toBe(false);
  });

  test("scrolling inside a DECSTBM region never becomes history; full-screen scrolls do", async () => {
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
    expect(pane.scrolls.length).toBe(0);
    expect(screenRows(pane)[0]!.text.trimEnd()).toBe("base 0");
    expect(screenRows(pane)[7]!.text.trimEnd()).toBe("region 49");
    // Reset the region: the next full-screen scrolls are history again.
    pane.collector.ingest(encoder.encode("\x1b[r\x1b[10;1H\r\nafter 0\r\nafter 1"));
    await settle(pane);
    expect(pane.scrolls.map((s) => rowText(s.physicalRow).trimEnd())).toEqual(["base 0", "base 1"]);
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
    for (let i = 0; i < 60; i++) {
      const length = Math.floor(random() * 170);
      let line = `L${i}:`;
      for (let j = 0; j < length; j++) line += alphabet[Math.floor(random() * alphabet.length)];
      lines.push(line);
    }
    const pane = await collectPane(80, 24);
    const write = (from: number, to: number) => {
      for (const line of lines.slice(from, to)) feedSplit(pane, encoder.encode(`${line}\r\n`), 5);
    };
    write(0, 20);
    await settle(pane);
    expect(pane.collector.resize(37, 24)).toBe(1);
    write(20, 40);
    await settle(pane);
    expect(pane.collector.resize(120, 40)).toBe(2);
    write(40, 60);
    await settle(pane);
    expect(logicalLines(pane)).toEqual(lines);
    const generations = new Set(pane.scrolls.map((s) => s.geometryGeneration));
    expect([...generations].sort()).toEqual([0, 1, 2]);
    // Rows pushed out by the shrink are 37 cells wide; none are repeated.
    expect(pane.scrolls.filter((s) => s.geometryGeneration === 1).every((s) => cellsOf(s.physicalRow).length === 37)).toBe(true);
    expect(pane.scrolls.some((s) => s.softWrap && s.wrapPad)).toBe(true);
    expect(pane.last!.cells.cols).toBe(120);
    expect(pane.last!.cells.rows).toBe(40);
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
    expect(pane.faults.map((f) => f.kind)).toEqual(["worker-exit"]);
    expect(pane.collector.health()).toBe("broken");
  });
});
