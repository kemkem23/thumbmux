import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OutputWalWriter } from "../src/output-wal";
import {
  readTerminalReplayCheckpoint,
  TerminalReplayMaterializer,
  type TerminalReplayGeometry,
  type TerminalReplayIdentity,
  type TerminalReplayResult,
} from "../src/terminal-replay-materializer";

let root = "";
let walPath = "";
let stateDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thumbmux-terminal-materializer-test-"));
  walPath = join(root, "output.wal");
  stateDir = join(root, "materialized");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const geometry = (cols: number, rows: number): TerminalReplayGeometry => ({ cols, rows });

const identity = (overrides: Partial<TerminalReplayIdentity> = {}): TerminalReplayIdentity => ({
  session: "cc-history-test",
  instanceId: "01KREPLAYTEST00000000000000",
  paneTarget: "=cc-history-test:0.0",
  tmuxServerPid: 12345,
  sessionCreated: 1_787_500_000,
  ...overrides,
});

function lifecycle(
  event: "start" | "resume" | "end",
  size: TerminalReplayGeometry,
  source = identity(),
) {
  return { event, identity: source, geometry: size };
}

function numbered(from: number, to: number): Buffer {
  return Buffer.from(
    Array.from({ length: to - from + 1 }, (_, index) => `N ${String(from + index).padStart(3, "0")}\r\n`).join(""),
    "utf8",
  );
}

function materialize(): TerminalReplayResult {
  return new TerminalReplayMaterializer({ walPath, stateDir }).materialize();
}

function renderedBytes(result: TerminalReplayResult): Buffer {
  const history = readFileSync(result.historyPath);
  const screen = result.screen ? Buffer.from(result.screen.cellsBase64, "base64") : Buffer.alloc(0);
  return Buffer.concat([history, screen]);
}

function plainRendered(result: TerminalReplayResult): string {
  return renderedBytes(result)
    .toString("utf8")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function numberedRows(result: TerminalReplayResult): number[] {
  const found: number[] = [];
  for (const line of plainRendered(result).split("\n")) {
    const match = /^N (\d+)\s*$/.exec(line);
    if (match) found.push(Number(match[1]));
  }
  return found;
}

describe("raw WAL terminal replay materializer (private tmux)", () => {
  test("keeps numbered output once, materializes repaint state, and applies authoritative resize commits", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 100 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(32, 5)));
    writer.appendOutput(numbered(1, 20));
    writer.appendOutput(Buffer.from("PROGRESS 000\rPROGRESS 050\rPROGRESS 100\r\n"));
    writer.appendJson("resize", {
      phase: "commit",
      changeId: "layout-1",
      from: geometry(32, 5),
      to: geometry(16, 6),
      reason: "tmux-control-layout",
    });
    // Includes NUL and invalid UTF-8.  They are not printable terminal cells,
    // but the private pipe fence proves the paste/cat round-trip stayed exact.
    writer.appendOutput(Buffer.concat([
      Buffer.from([0x00, 0xff]),
      numbered(21, 40),
    ]));
    writer.appendJson("checkpoint", { event: "barrier", requestId: "barrier-1" });
    writer.appendJson("lifecycle", lifecycle("end", geometry(16, 6)));
    writer.close();

    const result = materialize();

    expect(result.complete).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.ended).toBe(true);
    expect(result.geometry).toEqual(geometry(16, 6));
    expect(numberedRows(result)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const plain = plainRendered(result);
    expect(plain).toContain("PROGRESS 100");
    expect(plain).not.toContain("PROGRESS 000");
    expect(plain).not.toContain("PROGRESS 050");

    const checkpoint = readTerminalReplayCheckpoint(result.checkpointPath);
    expect(checkpoint?.cursor.walOffset).toBe(result.walOffset);
    expect(checkpoint?.historyBytes).toBe(readFileSync(result.historyPath).byteLength);
    expect(checkpoint?.screen).toEqual(result.screen);
  }, 30_000);

  test("restart rebuilds VT state from WAL, verifies the checkpoint, and appends without duplicates", () => {
    const firstWriter = new OutputWalWriter({ path: walPath, clock: () => 200 });
    firstWriter.appendJson("lifecycle", lifecycle("start", geometry(30, 5)));
    firstWriter.appendOutput(numbered(1, 15));
    // Stop at an incomplete CSI.  Recovery must preserve parser state, not
    // merely repaint visible characters from a screenshot.
    firstWriter.appendOutput(Buffer.from("\x1b[31"));
    firstWriter.close();

    const first = materialize();
    const committedHistory = readFileSync(first.historyPath);
    expect(first.screen?.pendingEscapeBase64).not.toBe("");

    // Simulate a crash after derived bytes were appended but before the atomic
    // checkpoint rename.  Recovery may trim this suffix because the WAL, not
    // this file, is the durable source of truth.
    appendFileSync(first.historyPath, Buffer.from("UNCOMMITTED-CRASH-TAIL"));

    const secondWriter = new OutputWalWriter({ path: walPath, clock: () => 300 });
    secondWriter.appendOutput(Buffer.from("mRED\x1b[0m\r\n"));
    secondWriter.appendJson("lifecycle", lifecycle(
      "resume",
      geometry(24, 6),
      identity({
        paneTarget: "=cc-history-test:1.0",
        tmuxServerPid: 54321,
        sessionCreated: 1_787_500_999,
      }),
    ));
    secondWriter.appendOutput(numbered(16, 30));
    secondWriter.close();

    const second = materialize();

    expect(second.recoveredFromCheckpoint).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.geometry).toEqual(geometry(24, 6));
    expect(readFileSync(second.historyPath).subarray(0, committedHistory.byteLength))
      .toEqual(committedHistory);
    expect(readFileSync(second.historyPath).includes(Buffer.from("UNCOMMITTED-CRASH-TAIL")))
      .toBe(false);
    expect(numberedRows(second)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(plainRendered(second)).toContain("RED");
    expect(second.screen?.pendingEscapeBase64).toBe("");
  }, 30_000);

  test("a dangling prepare is fail-closed until its matching commit arrives", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 400 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(28, 5)));
    writer.appendOutput(numbered(1, 12));
    writer.appendJson("resize", {
      phase: "prepare",
      changeId: "browser-resize-1",
      from: geometry(28, 5),
      to: geometry(18, 7),
      reason: "browser",
    });
    writer.close();

    const pending = materialize();
    expect(pending.complete).toBe(false);
    expect(pending.verified).toBe(false);
    expect(pending.geometry).toEqual(geometry(28, 5));
    expect(pending.pendingResize?.changeId).toBe("browser-resize-1");

    const resumed = new OutputWalWriter({ path: walPath, clock: () => 500 });
    resumed.appendJson("resize", {
      phase: "commit",
      changeId: "browser-resize-1",
      from: geometry(28, 5),
      to: geometry(18, 7),
      reason: "browser",
    });
    resumed.appendOutput(numbered(13, 24));
    resumed.close();

    const recovery = new TerminalReplayMaterializer({ walPath, stateDir }).open();
    try {
      expect(recovery.current.recoveredFromCheckpoint).toBe(true);
      expect(recovery.current.verified).toBe(false);
      expect(recovery.current.hasMoreWal).toBe(true);

      // The matching boundary is published alone, before post-resize output,
      // so a host store that skipped the pending checkpoint can catch up.
      const boundary = recovery.refresh();
      expect(boundary.sequence).toBe(4n);
      expect(boundary.complete).toBe(true);
      expect(boundary.verified).toBe(true);
      expect(boundary.pendingResize).toBeNull();
      expect(boundary.hasMoreWal).toBe(true);

      const committed = recovery.refresh();
      expect(committed.sequence).toBe(5n);
      expect(committed.hasMoreWal).toBe(false);
      expect(committed.geometry).toEqual(geometry(18, 7));
      expect(numberedRows(committed)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      );
    } finally {
      recovery.close();
    }
  }, 30_000);

  test("a long-lived session keeps one private emulator and refreshes only the WAL suffix", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 550 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(22, 5)));
    writer.appendOutput(numbered(1, 10));
    writer.close();

    const session = new TerminalReplayMaterializer({ walPath, stateDir }).open();
    const socketPath = session.privateSocketPath;
    try {
      expect(existsSync(socketPath)).toBe(true);
      expect(numberedRows(session.current)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      );

      const appended = new OutputWalWriter({ path: walPath, clock: () => 560 });
      appended.appendOutput(numbered(11, 25));
      appended.close();

      const refreshed = session.refresh();
      expect(session.privateSocketPath).toBe(socketPath);
      expect(existsSync(socketPath)).toBe(true);
      expect(refreshed.sequence).toBe(3n);
      expect(numberedRows(refreshed)).toEqual(
        Array.from({ length: 25 }, (_, index) => index + 1),
      );
      expect(session.refresh()).toEqual(refreshed);
    } finally {
      session.close();
    }
    expect(existsSync(socketPath)).toBe(false);
  }, 30_000);

  test("opens and recovers a multi-megabyte backlog one bounded WAL batch at a time", () => {
    const budget = 128 * 1024;
    const writer = new OutputWalWriter({ path: walPath, clock: () => 570 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(24, 5)));
    // NUL is intentionally terminal-inert but still crosses the raw pipe and
    // checksum fence byte-for-byte. Forty records make a >1 MiB cold backlog.
    for (let index = 0; index < 40; index += 1) {
      writer.appendOutput(Buffer.alloc(32 * 1024, 0));
    }
    writer.appendOutput(Buffer.from("BACKLOG-DONE\r\n", "ascii"));
    writer.close();

    const first = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      maxWalFrameBytesPerRefresh: budget,
    }).open();
    const firstResult = first.current;
    expect(firstResult.hasMoreWal).toBe(true);
    expect(firstResult.walOffset).toBeLessThan(statSync(walPath).size);
    expect(firstResult.walOffset).toBeLessThanOrEqual(budget);
    first.close();

    // A replacement must replay/verify the old checkpoint, then expose only
    // one further bounded suffix. It must not jump straight to WAL EOF.
    const replacement = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      maxWalFrameBytesPerRefresh: budget,
    }).open();
    try {
      expect(replacement.current.recoveredFromCheckpoint).toBe(true);
      expect(replacement.current.hasMoreWal).toBe(true);
      // Recovery hands the exact prior materializer checkpoint to the host
      // first, so a host store that crashed one commit behind can catch up
      // before this derived file advances again.
      expect(replacement.current.walOffset).toBe(firstResult.walOffset);
      expect(replacement.current.sequence).toBe(firstResult.sequence);

      let result = replacement.current;
      let refreshes = 0;
      while (result.hasMoreWal) {
        const beforeOffset = result.walOffset;
        const beforeSequence = result.sequence;
        result = replacement.refresh();
        expect(result.walOffset).toBeGreaterThan(beforeOffset);
        // Every record is below the budget, so the preferred bound is hard in
        // this producer-shaped backlog (the one-large-record exception is
        // covered by the CSI expansion test below).
        expect(result.walOffset - beforeOffset).toBeLessThanOrEqual(budget);
        expect(result.sequence).toBeGreaterThan(beforeSequence);
        refreshes += 1;
        if (refreshes > 100) throw new Error("bounded replay made no progress");
      }
      expect(result.sequence).toBe(42n);
      expect(result.walOffset).toBe(statSync(walPath).size);
      expect(plainRendered(result)).toContain("BACKLOG-DONE");
      expect(refreshes).toBeGreaterThan(5);
    } finally {
      replacement.close();
    }
  }, 40_000);

  /**
   * Many small output records around the inputs a coalesced recovery must
   * not reorder: a control record, a CSI split across records, and a Claude
   * Code style full redraw (`CSI 2 J CSI 3 J`) after rows already scrolled.
   * The checkpoint is produced one record at a time, as production does.
   */
  function produceSmallRecordLane(records: number): TerminalReplayResult {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 580 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(24, 5)));
    const resizeAt = Math.floor(records / 2);
    const redrawAt = Math.floor(records / 3);
    const splitAt = Math.floor((records * 3) / 4);
    for (let index = 1; index <= records; index += 1) {
      if (index === resizeAt) {
        writer.appendJson("resize", {
          phase: "commit",
          changeId: "layout-mid",
          from: geometry(24, 5),
          to: geometry(20, 6),
          reason: "tmux-control-layout",
        });
      }
      if (index === redrawAt) writer.appendOutput(Buffer.from("\x1b[2J\x1b[3J\x1b[HREDRAW\r\n", "ascii"));
      else if (index === splitAt) writer.appendOutput(Buffer.from("\x1b[3", "ascii"));
      else if (index === splitAt + 1) writer.appendOutput(Buffer.from("2mG\x1b[0m\r\n", "ascii"));
      else writer.appendOutput(numbered(index, index));
    }
    writer.close();

    const producer = new TerminalReplayMaterializer({ walPath, stateDir }).open();
    let produced = producer.current;
    while (produced.hasMoreWal) produced = producer.refresh();
    producer.close();
    expect(produced.sequence).toBe(BigInt(records + 2)); // start + resize + outputs
    return produced;
  }

  test("checkpoint recovery costs private tmux commands per batch, not per WAL record", () => {
    // HP7-OPEN: a real lane with 66,754 small records needed ~12 ms of tmux
    // round-trips per record to re-verify its checkpoint, so open() exceeded
    // the worker's 600 s request timeout and the lane never came back.
    const records = 600;
    const produced = produceSmallRecordLane(records);
    const committedHistory = readFileSync(produced.historyPath);
    // Rows scrolled before the redraw were drained per record, so they are
    // committed history that recovery has to reproduce, not lose to ED3.
    expect(numberedRows(produced)).toContain(150);

    const counter = join(root, "tmux-count");
    const wrapper = join(root, "tmux-counting.sh");
    const realTmux = Bun.which("tmux");
    if (!realTmux) throw new Error("tmux is required");
    writeFileSync(wrapper, `#!/bin/sh\necho x >> '${counter}'\nexec '${realTmux}' "$@"\n`, { mode: 0o700 });

    const recovered = new TerminalReplayMaterializer({ walPath, stateDir, tmuxCommand: wrapper }).open();
    try {
      expect(recovered.current.recoveredFromCheckpoint).toBe(true);
      expect(recovered.current.verified).toBe(true);
      expect(recovered.current.sequence).toBe(produced.sequence);
      expect(readFileSync(produced.historyPath)).toEqual(committedHistory);
    } finally {
      recovered.close();
    }
    const invocations = readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
    // Per-record replay makes >= 3 tmux calls for each of 600 records.
    expect(invocations).toBeLessThan(records / 4);
  }, 120_000);

  test("coalesced recovery still rejects a committed history row whose text changed", () => {
    const produced = produceSmallRecordLane(60);
    const history = readFileSync(produced.historyPath);
    const target = history.indexOf(Buffer.from("N 007"));
    expect(target).toBeGreaterThanOrEqual(0);
    history[target + 4] = "8".charCodeAt(0);
    writeFileSync(produced.historyPath, history);

    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow(`replayed history differs at byte ${history.lastIndexOf(0x0a, target) + 1}`);
  }, 60_000);

  test("coalesced recovery still rejects a checkpoint screen whose text changed", () => {
    const produced = produceSmallRecordLane(60);
    const checkpoint = JSON.parse(readFileSync(produced.checkpointPath, "utf8"));
    const cells = Buffer.from(checkpoint.screen.cellsBase64, "base64");
    const target = cells.indexOf(Buffer.from("N 0"));
    expect(target).toBeGreaterThanOrEqual(0);
    cells[target] = "M".charCodeAt(0);
    checkpoint.screen.cellsBase64 = cells.toString("base64");
    writeFileSync(produced.checkpointPath, JSON.stringify(checkpoint));

    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow("replayed terminal screen/cursor differs from checkpoint");
  }, 60_000);

  /**
   * HP7-FIX1: output whose presentation depends on state carried across rows
   * and records — colour set in one record and reset rows later, a coloured
   * row that wraps at the pane width, background runs and OSC 8 hyperlinks.
   * Produced one record at a time, then recovered as coalesced runs, so the
   * committed bytes and the recovery captures group rows differently.
   */
  function produceStyledLane(records: number): TerminalReplayResult {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 580 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(24, 5)));
    for (let index = 1; index <= records; index += 1) {
      const n = String(index).padStart(3, "0");
      let text: string;
      if (index % 9 === 0) text = `\x1b[31mRED ${n} opens\r\n`; // colour stays on
      else if (index % 9 === 3) text = `\x1b[0mOFF ${n}\r\n`;
      else if (index % 9 === 5) text = `\x1b]8;;http://x.test/${n}\x1b\\LINK ${n}\x1b]8;;\x1b\\ tail\r\n`;
      else if (index % 9 === 6) text = `\x1b[1;44mBG ${n}\x1b[0m  x\r\n`;
      else if (index % 9 === 7) text = `\x1b[32m${"W".repeat(30)}${n}\x1b[39m\r\n`; // wraps
      else text = `N ${n}\r\n`;
      writer.appendOutput(Buffer.from(text, "utf8"));
    }
    writer.close();
    const producer = new TerminalReplayMaterializer({ walPath, stateDir }).open();
    let produced = producer.current;
    while (produced.hasMoreWal) produced = producer.refresh();
    producer.close();
    return produced;
  }

  function rewriteHistory(produced: TerminalReplayResult, from: string, to: string): number {
    const history = readFileSync(produced.historyPath);
    const target = history.indexOf(Buffer.from(from, "utf8"));
    expect(target).toBeGreaterThanOrEqual(0);
    writeFileSync(produced.historyPath, Buffer.concat([
      history.subarray(0, target),
      Buffer.from(to, "utf8"),
      history.subarray(target + Buffer.byteLength(from)),
    ]));
    return history.lastIndexOf(0x0a, target) + 1;
  }

  test("coalesced recovery accepts styled rows whose escapes are grouped differently", () => {
    const produced = produceStyledLane(120);
    const committed = readFileSync(produced.historyPath);
    expect(committed.includes(Buffer.from("\x1b[31m"))).toBe(true);
    expect(committed.includes(Buffer.from("\x1b]8;;http://x.test/005"))).toBe(true);
    const recovered = new TerminalReplayMaterializer({ walPath, stateDir }).open();
    try {
      expect(recovered.current.recoveredFromCheckpoint).toBe(true);
      expect(recovered.current.verified).toBe(true);
    } finally {
      recovered.close();
    }
  }, 60_000);

  test("coalesced recovery rejects a committed row whose colour changed (31m -> 32m)", () => {
    // Codex HP7 review probe CORRUPT_SGR_ACCEPTED: same text, different colour.
    const produced = produceStyledLane(60);
    const rowStart = rewriteHistory(produced, "\x1b[31mRED 009", "\x1b[32mRED 009");
    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow(`replayed history differs at byte ${rowStart}`);
  }, 60_000);

  test("coalesced recovery rejects a committed row whose bold became dim", () => {
    const produced = produceStyledLane(60);
    const rowStart = rewriteHistory(produced, "\x1b[1m\x1b[44mBG 006", "\x1b[2m\x1b[44mBG 006");
    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow(`replayed history differs at byte ${rowStart}`);
  }, 60_000);

  test("coalesced recovery rejects a committed hyperlink whose target changed", () => {
    const produced = produceStyledLane(60);
    const rowStart = rewriteHistory(produced, "http://x.test/005", "http://y.test/005");
    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow(`replayed history differs at byte ${rowStart}`);
  }, 60_000);

  test("coalesced recovery rejects a committed history with one row missing", () => {
    const produced = produceStyledLane(60);
    const history = readFileSync(produced.historyPath);
    const target = history.indexOf(Buffer.from("N 010"));
    expect(target).toBeGreaterThanOrEqual(0);
    const rowStart = history.lastIndexOf(0x0a, target) + 1;
    const rowEnd = history.indexOf(0x0a, target) + 1;
    writeFileSync(produced.historyPath, Buffer.concat([history.subarray(0, rowStart), history.subarray(rowEnd)]));
    const checkpoint = JSON.parse(readFileSync(produced.checkpointPath, "utf8"));
    checkpoint.historyBytes -= rowEnd - rowStart;
    writeFileSync(produced.checkpointPath, JSON.stringify(checkpoint));
    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow(`replayed history differs at byte ${rowStart}`);
  }, 60_000);

  test("coalesced recovery rejects a checkpoint screen whose colour changed", () => {
    const produced = produceStyledLane(58); // screen ends on coloured rows
    const checkpoint = JSON.parse(readFileSync(produced.checkpointPath, "utf8"));
    const cells = Buffer.from(checkpoint.screen.cellsBase64, "base64");
    const target = cells.indexOf(Buffer.from("\x1b[31m"));
    expect(target).toBeGreaterThanOrEqual(0);
    cells[target + 3] = "2".charCodeAt(0);
    checkpoint.screen.cellsBase64 = cells.toString("base64");
    writeFileSync(produced.checkpointPath, JSON.stringify(checkpoint));
    expect(() => new TerminalReplayMaterializer({ walPath, stateDir }).open())
      .toThrow("replayed terminal screen/cursor differs from checkpoint");
  }, 60_000);

  test("a coalesced recovery leaves bytes a per-record runtime (0.20.2) can still verify", () => {
    // HP7-FIX1 rollback: runtimes before the fix verify history and the
    // checkpoint screen byte-exact. Recovery must republish the checkpoint
    // unchanged, and refreshes after it must write what per-record replay
    // writes, or a rollback to 0.20.2 would reject the lane.
    const writer = new OutputWalWriter({ path: walPath, clock: () => 580 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(24, 5)));
    for (let index = 1; index <= 240; index += 1) {
      const n = String(index).padStart(3, "0");
      const text = index % 9 === 0 ? `\x1b[31mRED ${n}\r\n`
        : index % 9 === 3 ? `\x1b[0mOFF ${n}\r\n`
        : index % 9 === 5 ? `\x1b]8;;http://x.test/${n}\x1b\\LINK ${n}\x1b]8;;\x1b\\ t\r\n`
        : index % 9 === 7 ? `\x1b[32m${"W".repeat(30)}${n}\x1b[39m\r\n`
        : `N ${n}\r\n`;
      writer.appendOutput(Buffer.from(text, "utf8"));
    }
    writer.close();
    const copyDir = join(root, "materialized-copy");
    mkdirSync(copyDir, { mode: 0o700 });
    const frame = { maxWalFrameBytesPerRefresh: 512 };
    const producer = new TerminalReplayMaterializer({ walPath, stateDir, ...frame }).open();
    let produced = producer.current;
    for (let step = 0; step < 6 && produced.hasMoreWal; step += 1) produced = producer.refresh();
    expect(produced.hasMoreWal).toBe(true);
    // Re-encode the handed-off screen the way a different capture grouping
    // would: same cells, extra escape bytes. The new verifier accepts it; a
    // per-record runtime only accepts these exact bytes back.
    const handoff = JSON.parse(readFileSync(produced.checkpointPath, "utf8"));
    handoff.screen.cellsBase64 = Buffer.concat([
      Buffer.from("\x1b[0m"),
      Buffer.from(handoff.screen.cellsBase64, "base64"),
    ]).toString("base64");
    const handoffCheckpoint = Buffer.from(JSON.stringify(handoff));
    writeFileSync(join(copyDir, "checkpoint.json"), handoffCheckpoint);
    writeFileSync(join(copyDir, "history.ansi"), readFileSync(produced.historyPath));
    while (produced.hasMoreWal) produced = producer.refresh(); // never reopened: per record
    producer.close();

    const reopened = new TerminalReplayMaterializer({ walPath, stateDir: copyDir, ...frame }).open();
    try {
      expect(reopened.current.recoveredFromCheckpoint).toBe(true);
      const republished = JSON.parse(readFileSync(join(copyDir, "checkpoint.json"), "utf8"));
      expect(JSON.stringify(republished.screen)).toBe(JSON.stringify(handoff.screen));
      expect(republished.historyBytes).toBe(handoff.historyBytes);
      let continued = reopened.current;
      while (continued.hasMoreWal) continued = reopened.refresh();
    } finally {
      reopened.close();
    }
    expect(readFileSync(join(copyDir, "history.ansi"))).toEqual(readFileSync(produced.historyPath));
    const perRecord = JSON.parse(readFileSync(produced.checkpointPath, "utf8"));
    const afterRecovery = JSON.parse(readFileSync(join(copyDir, "checkpoint.json"), "utf8"));
    expect(afterRecovery.screen).toEqual(perRecord.screen);
    expect(afterRecovery.historyBytes).toBe(perRecord.historyBytes);
  }, 90_000);

  test("drains a single burst larger than the private tmux history ring without losing a row", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 580 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(20, 4)));
    writer.appendOutput(numbered(1, 45_000));
    writer.close();

    // The output contains more physical lines than this ring can retain at
    // once. Small raw-byte replay chunks force immutable rows to disk and
    // clear-history before the finite ring can wrap.
    const result = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      // One chunk contains ~4,000 rows: above tmux's default 2,000-row ring,
      // below the private 40,000-row ring configured before pane creation.
      replayChunkBytes: 32_768,
      historyLimit: 40_000,
    }).materialize();

    expect(numberedRows(result)).toEqual(
      Array.from({ length: 45_000 }, (_, index) => index + 1),
    );
  }, 30_000);

  test("bounds row effect for repeated CSI S tokens before the finite tmux ring can wrap", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 590 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(20, 24)));
    // 3,276 complete five-byte tokens fit in one old 16 KiB byte batch, but
    // each token scrolls 24 rows: 78,624 rows, beyond a 65,536-row ring.
    writer.appendOutput(Buffer.from("\x1b[99S".repeat(3_276), "ascii"));
    writer.close();

    const session = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      replayChunkBytes: 16 * 1024,
      historyLimit: 65_536,
      historyCaptureRows: 1_024,
      // The output record is intentionally larger than this preferred budget.
      // WAL checkpoints are record-aligned, so one complete record is accepted
      // to make progress; producers must keep their individual frames capped.
      maxWalFrameBytesPerRefresh: 1_024,
    }).open();
    try {
      const before = session.current;
      expect(before.sequence).toBe(1n);
      expect(before.hasMoreWal).toBe(true);
      const result = session.refresh();
      expect(result.walOffset - before.walOffset).toBeGreaterThan(1_024);
      expect(result.hasMoreWal).toBe(false);

      const history = readFileSync(result.historyPath);
      expect(history.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0))
        .toBe(78_624);
      // A tiny escape sequence can expand into far more derived rows than raw
      // bytes. Host indexers therefore also need a streaming/row cap; the raw
      // WAL budget alone is deliberately not claimed as a derived-byte bound.
      expect(history.byteLength).toBeGreaterThan(result.walOffset - before.walOffset);
      expect(Buffer.from(result.screen!.cellsBase64, "base64")
        .reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)).toBe(24);
    } finally {
      session.close();
    }
  }, 30_000);

  test("uses one-way FIFO replay so a DSR query cannot loop its reply back into output", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 595 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(30, 4)));
    // ป ends in byte 0x9b; that UTF-8 continuation must never be mistaken for
    // the legacy 8-bit CSI introducer.
    writer.appendOutput(Buffer.from("ABC\x1b[6nDEF ไทยป🙂\r\n", "utf8"));
    writer.close();

    const session = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      replayChunkBytes: 8,
    }).open();
    try {
      expect(plainRendered(session.current)).toContain("ABCDEF");
      expect(plainRendered(session.current)).toContain("ไทยป🙂");
      expect(session.current.screen?.pendingEscapeBase64).toBe("");
      // The completion mirror is reused and truncated after every batch.
      expect(statSync(session.privateMirrorPath).size).toBe(0);
      expect(session.privatePeakMirrorBytes).toBeLessThanOrEqual(8);
      expect(session.current.identity).toEqual(identity());
    } finally {
      session.close();
    }
  }, 30_000);

  test("keeps a CSI split across WAL records pending and replays it deterministically", () => {
    const firstWriter = new OutputWalWriter({ path: walPath, clock: () => 596 });
    firstWriter.appendJson("lifecycle", lifecycle("start", geometry(20, 4)));
    firstWriter.appendOutput(Buffer.from("BEFORE\x1b[9", "ascii"));
    firstWriter.close();

    const first = materialize();
    expect(Buffer.from(first.screen!.pendingEscapeBase64, "base64"))
      .toEqual(Buffer.from("\x1b[9", "ascii"));

    const secondWriter = new OutputWalWriter({ path: walPath, clock: () => 597 });
    secondWriter.appendOutput(Buffer.from("9SAFTER\r\n", "ascii"));
    secondWriter.close();
    const second = materialize();
    expect(second.screen?.pendingEscapeBase64).toBe("");
    expect(plainRendered(second)).toContain("AFTER");

    const checkpointBytes = readFileSync(second.checkpointPath);
    const historyBytes = readFileSync(second.historyPath);
    const rebuilt = materialize();
    expect(readFileSync(rebuilt.historyPath)).toEqual(historyBytes);
    expect(readFileSync(rebuilt.checkpointPath)).toEqual(checkpointBytes);
    expect(rebuilt.screen).toEqual(second.screen);
  }, 30_000);

  test("a new PTY generation seals the old screen once and starts blank; END keeps its final screen live", () => {
    const physical = (generation: string, paneId: string): TerminalReplayIdentity => identity({
      sessionId: "$10",
      windowId: "@20",
      paneId,
      generation,
  });

    const writer = new OutputWalWriter({ path: walPath, clock: () => 598 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(18, 4), physical("gen-a", "%30")));
    writer.appendOutput(Buffer.from("OLD\r\n"));
    writer.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-a", "%30")));
    writer.appendOutput(Buffer.from("SAME\r\n"));
    writer.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-b", "%31")));
    writer.appendOutput(Buffer.from("NEW\r\n"));
    writer.appendJson("lifecycle", lifecycle("end", geometry(18, 4), physical("gen-b", "%31")));
    writer.close();

    const result = materialize();
    const history = readFileSync(result.historyPath).toString("utf8");
    const screen = Buffer.from(result.screen!.cellsBase64, "base64").toString("utf8");
    expect((history.match(/OLD/g) ?? []).length).toBe(1);
    expect((history.match(/SAME/g) ?? []).length).toBe(1);
    expect(history).not.toContain("NEW");
    expect(screen).toContain("NEW");
    expect(screen).not.toContain("OLD");
    expect(result.identity?.generation).toBe("gen-b");

    const rebuilt = materialize();
    expect(readFileSync(rebuilt.historyPath).toString("utf8")).toBe(history);
    expect(rebuilt.screen).toEqual(result.screen);
  }, 30_000);

  test("exposes an exact independently durable recovery target before a larger suffix", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 250 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(30, 5)));
    const target = writer.appendOutput(numbered(1, 8));
    for (let index = 0; index < 20; index += 1) {
      writer.appendOutput(Buffer.from(`later-${index}-${"x".repeat(900)}\r\n`, "utf8"));
    }
    writer.close();

    const session = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      recoverySequence: target.sequence.toString(),
      recoveryWalOffset: target.nextOffset,
      maxWalFrameBytesPerRefresh: 64 * 1024,
    }).open();
    try {
      expect(session.current.sequence).toBe(target.sequence);
      expect(session.current.walOffset).toBe(target.nextOffset);
      expect(session.current.hasMoreWal).toBeTrue();
      const next = session.refresh();
      expect(next.sequence).toBeGreaterThan(target.sequence);
    } finally {
      session.close();
    }
  });

  test("rebuilds a checkpoint ahead of the recovery target before exposing its screen", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 251 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(20, 2)));
    const target = writer.appendOutput(Buffer.from("TARGET\r\n", "utf8"));
    writer.appendOutput(Buffer.from("LATER\r\n", "utf8"));
    writer.close();

    const ahead = materialize();
    expect(ahead.sequence).toBeGreaterThan(target.sequence);
    expect(plainRendered(ahead)).toContain("LATER");

    const recovered = new TerminalReplayMaterializer({
      walPath,
      stateDir,
      recoverySequence: target.sequence.toString(),
      recoveryWalOffset: target.nextOffset,
    }).open();
    try {
      expect(recovered.current.recoveredFromCheckpoint).toBeFalse();
      expect(recovered.current.sequence).toBe(target.sequence);
      expect(recovered.current.walOffset).toBe(target.nextOffset);
      expect(plainRendered(recovered.current)).toContain("TARGET");
      expect(plainRendered(recovered.current)).not.toContain("LATER");
      expect(recovered.current.hasMoreWal).toBeTrue();
    } finally {
      recovered.close();
    }
  });

  test("repeated generations that die before emitting output add no phantom history rows", () => {
    const physical = (generation: string, paneId: string): TerminalReplayIdentity => identity({
      sessionId: "$10",
      windowId: "@20",
      paneId,
      generation,
    });
    const firstWriter = new OutputWalWriter({ path: walPath, clock: () => 598 });
    firstWriter.appendJson("lifecycle", lifecycle("start", geometry(18, 4), physical("gen-a", "%30")));
    firstWriter.close();
    const first = materialize();
    expect(readFileSync(first.historyPath)).toEqual(Buffer.alloc(0));

    const secondWriter = new OutputWalWriter({ path: walPath, clock: () => 599 });
    secondWriter.appendJson("lifecycle", lifecycle("resume", geometry(22, 5), physical("gen-b", "%31")));
    secondWriter.appendJson("resize", {
      phase: "commit",
      changeId: "unseen-layout",
      from: geometry(22, 5),
      to: geometry(16, 3),
      reason: "tmux-control-layout",
    });
    secondWriter.appendOutput(Buffer.alloc(0));
    secondWriter.close();
    const second = materialize();
    expect(readFileSync(second.historyPath)).toEqual(Buffer.alloc(0));

    const finalWriter = new OutputWalWriter({ path: walPath, clock: () => 600 });
    finalWriter.appendJson("lifecycle", lifecycle("resume", geometry(20, 6), physical("gen-c", "%32")));
    finalWriter.appendJson("lifecycle", lifecycle("end", geometry(20, 6), physical("gen-c", "%32")));
    finalWriter.close();

    const result = materialize();
    expect(readFileSync(result.historyPath)).toEqual(Buffer.alloc(0));
    expect(result.identity?.generation).toBe("gen-c");
    expect(result.screen?.rows).toBe(6);

    const rebuilt = materialize();
    expect(readFileSync(rebuilt.historyPath)).toEqual(Buffer.alloc(0));
    expect(rebuilt.screen).toEqual(result.screen);
  }, 30_000);

  test("seals each output-producing generation once while discarding unseen generations", () => {
    const physical = (generation: string, paneId: string): TerminalReplayIdentity => identity({
      sessionId: "$10",
      windowId: "@20",
      paneId,
      generation,
    });
    const firstWriter = new OutputWalWriter({ path: walPath, clock: () => 598 });
    firstWriter.appendJson("lifecycle", lifecycle("start", geometry(18, 4), physical("gen-a", "%30")));
    firstWriter.appendOutput(Buffer.from("VISIBLE-A\r\n"));
    firstWriter.close();
    const first = materialize();
    expect(readFileSync(first.historyPath)).toEqual(Buffer.alloc(0));

    const secondWriter = new OutputWalWriter({ path: walPath, clock: () => 599 });
    secondWriter.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-b", "%31")));
    secondWriter.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-c", "%32")));
    secondWriter.appendOutput(Buffer.from("VISIBLE-C\r\n"));
    secondWriter.close();
    const second = materialize();
    expect((readFileSync(second.historyPath).toString("utf8").match(/VISIBLE-A/g) ?? []).length)
      .toBe(1);

    const finalWriter = new OutputWalWriter({ path: walPath, clock: () => 600 });
    finalWriter.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-d", "%33")));
    finalWriter.appendJson("lifecycle", lifecycle("resume", geometry(18, 4), physical("gen-e", "%34")));
    finalWriter.appendJson("lifecycle", lifecycle("end", geometry(18, 4), physical("gen-e", "%34")));
    finalWriter.close();

    const result = materialize();
    const history = readFileSync(result.historyPath);
    const text = history.toString("utf8");
    expect((text.match(/VISIBLE-A/g) ?? []).length).toBe(1);
    expect((text.match(/VISIBLE-C/g) ?? []).length).toBe(1);
    expect(history.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)).toBe(8);
    expect(result.identity?.generation).toBe("gen-e");

    const rebuilt = materialize();
    expect(readFileSync(rebuilt.historyPath)).toEqual(history);
    expect(rebuilt.screen).toEqual(result.screen);
  }, 30_000);

  test("growing after source history was drained leaves blank rows instead of reflowing archive", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 599 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(14, 3)));
    writer.appendOutput(numbered(1, 6));
    writer.appendJson("resize", {
      phase: "commit",
      changeId: "grow-after-drain",
      from: geometry(14, 3),
      to: geometry(14, 6),
      reason: "tmux-control-layout",
    });
    writer.close();

    const result = materialize();
    const screen = Buffer.from(result.screen!.cellsBase64, "base64").toString("utf8");
    expect(screen).toContain("N 005");
    expect(screen).toContain("N 006");
    expect(screen).not.toContain("N 001");
    expect(screen).not.toContain("N 004");
    expect(screen.split("\n").length - 1).toBe(6);
    expect(numberedRows(result)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 30_000);

  test("rejects output between prepare and commit without advancing the durable checkpoint", () => {
    const writer = new OutputWalWriter({ path: walPath, clock: () => 600 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(20, 4)));
    writer.appendJson("resize", {
      phase: "prepare",
      changeId: "bad-boundary",
      from: geometry(20, 4),
      to: geometry(10, 4),
    });
    writer.appendOutput(Buffer.from("must-not-pass\r\n"));
    writer.close();

    expect(() => materialize()).toThrow(/output appears during prepared resize/);
    expect(readTerminalReplayCheckpoint(join(stateDir, "checkpoint.json"))).toBeNull();
  }, 30_000);
});

// WAL fixtures reproduce the reviewer's success-splice / ambiguous-hold /
// overlap-gaps probes without bypassing the private tmux cage.
function pauseGap(writer: OutputWalWriter, gapId: string) {
  writer.appendGap({ gapId, sourceEpoch: "epoch-1", paneId: "%42", reason: "tmux-pause",
    detectedAt: 100, missingBytes: null, coverage: "unknown" });
}
function pauseRecovery(writer: OutputWalWriter, gapId: string, status: "success" | "ambiguous" | "failed") {
  writer.appendRecovery({ gapId, sourceEpoch: "epoch-1", paneId: "%42", provenance: "recovered-from-ring", status,
    recoveredBytesBase64: status === "failed" ? "" : Buffer.from("RING_ROW\n\u001b[2J\u001b[HRECOVERED_ROW\n").toString("base64"),
    recoveredRows: status === "failed" ? null : 2, truncated: status === "failed" ? null : false,
    identity: { ...identity(), sessionId: "$9", windowId: "@42", paneId: "%42" }, geometry: geometry(80, 8),
    capturedSeqBefore: "2", capturedSeqAfter: "3", boundary: status === "failed" ? null : status === "success" ? "matched" : "ambiguous",
    ...(status === "failed" ? { error: "capture unavailable" } : {}),
  });
}
function pauseWriter() {
  const writer = new OutputWalWriter({ path: walPath, format: 2, clock: () => 100 });
  writer.appendJson("lifecycle", lifecycle("start", geometry(80, 8)));
  writer.appendOutput(Buffer.from("BEFORE_GAP\r\n"));
  return writer;
}

const gapReasonMessages = {
  "tmux-pause": "การส่งข้อมูลถูกพักชั่วคราว ช่วงนั้นอาจเก็บไม่ครบ",
  "recorder-failure": "ระบบบันทึกประวัติขัดข้อง ช่วงนั้นอาจเก็บไม่ครบ",
  "unclean-source": "รอบก่อนจบโดยไม่ได้ยืนยันว่าเก็บประวัติครบ ช่วงท้ายอาจเก็บไม่ครบ",
} as const;

for (const [reason, expectedMessage] of Object.entries(gapReasonMessages)) {
  test(`labels ${reason} gaps with their actual cause`, () => {
    const writer = new OutputWalWriter({ path: walPath, format: 2, clock: () => 100 });
    writer.appendJson("lifecycle", lifecycle("start", geometry(80, 8)));
    writer.appendGap({
      gapId: `gap-${reason}`,
      sourceEpoch: "epoch-1",
      paneId: "%42",
      reason: reason as keyof typeof gapReasonMessages,
      detectedAt: 100,
      missingBytes: null,
      coverage: "unknown",
    });
    writer.appendOutput(Buffer.from("AFTER_GAP\r\n"));
    writer.close();

    const rendered = plainRendered(materialize());
    expect(rendered).toContain(expectedMessage);
    expect(rendered).not.toContain(`gap-${reason}`);
    expect(rendered).not.toContain("เครื่องดับ");
    expect(rendered).not.toContain("ไบต์");
    expect(rendered).not.toContain("tmux");
    for (const otherMessage of Object.values(gapReasonMessages)) {
      if (otherMessage !== expectedMessage) expect(rendered).not.toContain(otherMessage);
    }
    expect(rendered).toContain("AFTER_GAP");
  }, 30_000);
}

for (const status of ["ambiguous", "failed"] as const) {
  test(`pause ${status} is local: live suffix and pre-gap screen survive restart`, () => {
    const writer = pauseWriter();
    pauseGap(writer, "gap-one");
    writer.appendOutput(Buffer.from("LIVE_SUFFIX\r\n"));
    pauseRecovery(writer, "gap-one", status);
    writer.appendOutput(Buffer.from("AFTER_CONTINUE\r\n"));
    writer.close();
    const first = plainRendered(materialize());
    for (const text of ["BEFORE_GAP", "LIVE_SUFFIX", "AFTER_CONTINUE", "ประวัติขาดช่วง", `สถานะ: ${status}`]) {
      expect(first).toContain(text);
    }
    expect(plainRendered(materialize())).toBe(first);
  }, 30_000);
}

test("pause success archives the old screen and labels ring rows without VT execution", () => {
  const writer = pauseWriter();
  pauseGap(writer, "gap-one");
  writer.appendOutput(Buffer.from("LIVE_SUFFIX\r\n"));
  pauseRecovery(writer, "gap-one", "success");
  writer.appendOutput(Buffer.from("AFTER_CONTINUE\r\n"));
  writer.close();
  const result = materialize();
  const history = readFileSync(result.historyPath, "utf8");
  const screen = Buffer.from(result.screen!.cellsBase64, "base64").toString();
  for (const text of ["BEFORE_GAP", "ประวัติขาดช่วง", "recovered-from-ring", "RING_ROW", "RECOVERED_ROW"]) expect(history).toContain(text);
  expect(history).not.toContain("\u001b[2J");
  expect(screen).not.toContain("RECOVERED_ROW");
  expect(plainRendered(result)).toContain("LIVE_SUFFIX");
  expect(plainRendered(result)).toContain("AFTER_CONTINUE");
  expect(plainRendered(materialize())).toBe(plainRendered(result));
}, 30_000);

test("overlapping gaps settle independently across an open checkpoint", () => {
  const writer = pauseWriter();
  pauseGap(writer, "gap-one");
  pauseGap(writer, "gap-two");
  writer.appendOutput(Buffer.from("WHILE_PENDING\r\n"));
  const pending = plainRendered(materialize());
  expect(pending).toContain("WHILE_PENDING");
  expect(pending.match(/ประวัติขาดช่วง/g)).toHaveLength(2);
  expect(pending).not.toContain("gap-one");
  expect(pending).not.toContain("gap-two");
  pauseRecovery(writer, "gap-one", "success");
  pauseRecovery(writer, "gap-two", "ambiguous");
  writer.appendOutput(Buffer.from("AFTER_BOTH\r\n"));
  writer.close();
  const settled = plainRendered(materialize());
  expect(settled).toContain("AFTER_BOTH");
  expect(settled.match(/recovered-from-ring/g)).toHaveLength(2);
  expect(plainRendered(materialize())).toBe(settled);
}, 30_000);

test("source checkpoints preserve materialized output and logical lifecycle", () => {
  const writer = new OutputWalWriter({ path: walPath, format: 2 });
  writer.appendJson("lifecycle", lifecycle("start", geometry(80, 8)));
  writer.appendJson("checkpoint", { event: "source-tracking", version: 1 });
  writer.appendOutput(Buffer.from("BEFORE_DETACH\r\n"));
  writer.appendJson("checkpoint", { event: "source-detached", version: 1, lastDurableSeq: writer.lastDurableSequence.toString() });
  writer.appendJson("lifecycle", lifecycle("resume", geometry(80, 8)));
  writer.appendOutput(Buffer.from("AFTER_RESUME\r\n"));
  writer.close();
  const rendered = plainRendered(materialize());
  expect(rendered).toContain("BEFORE_DETACH");
  expect(rendered).toContain("AFTER_RESUME");
  expect(rendered).not.toContain("ประวัติขาดช่วง");
  expect(plainRendered(materialize())).toBe(rendered);
}, 30_000);
