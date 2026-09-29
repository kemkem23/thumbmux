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
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OutputWalWriter, readOutputWal } from "../src/output-wal";
import {
  readTerminalReplayCheckpoint,
  TerminalReplayMaterializer,
  type TerminalReplayCheckpoint,
  type TerminalReplayGeometry,
  type TerminalReplayIdentity,
  type TerminalReplayResult,
} from "../src/terminal-replay-materializer";

// Immutable per-record producer outputs captured in the private cage at
// 2440aa78e. Normalized walPath is the only relocated field. The fixed digest
// covers WAL checksums, checkpoint state, and history, independently of replay.
// Compressed inline to keep this fixture inside the existing owned test file.
const RECOVERY_FIXTURES = Object.freeze([
  Object.freeze({ records: 60, sha256: "52581af2936768f4041679fa30dbd3fead497e459603966b7122279aa326bfff",
    deflateBase64:
      "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" +
      "Qi/azF4F5Dj4jFwnMy/+mE+PPnz/8BYAeM+Q=="
  }),
  Object.freeze({ records: 600, sha256: "dc94dd96b0c33122c93b2c29123050365e5483589b929fd831b73f80b06ad581",
    deflateBase64:
      "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"
  }),
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ROLLBACK_FIXTURE = Object.freeze({ sha256: "b588293d04f7b834e0903a805f6f2cd45dd330570a0d7556b668e1b3870aa43b",
  deflateBase64:
    "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"
});

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

  describe("immutable checkpoint recovery boundary", () => {
    let prepared: ReturnType<typeof installRecoveryFixture>[];

    beforeEach(() => {
      // Decode, hash and copy the archived producer output before the
      // recovery measurement. Bun may include hooks in its reported test
      // wall time; no fixture producer runs here or in the timed test.
      prepared = RECOVERY_FIXTURES.map(installRecoveryFixture);
    });

    function installRecoveryFixture(fixture: (typeof RECOVERY_FIXTURES)[number]) {
      const start = performance.now();
      const bytes = inflateSync(Buffer.from(fixture.deflateBase64, "base64"));
      expect(sha256(bytes)).toBe(fixture.sha256);
      const archived = JSON.parse(bytes.toString("utf8")) as {
        wal: string; history: string; checkpoint: TerminalReplayCheckpoint;
      };
      const dir = join(root, `immutable-${fixture.records}`);
      const fixtureWal = join(dir, "output.wal");
      const fixtureState = join(dir, "materialized");
      mkdirSync(fixtureState, { recursive: true, mode: 0o700 });
      const wal = Buffer.from(archived.wal, "base64");
      const history = Buffer.from(archived.history, "base64");
      // Only the absolute location changes. Cursor, cells, controls and
      // history come from the per-record reference, never today's replay.
      const checkpoint = { ...archived.checkpoint, walPath: fixtureWal };
      writeFileSync(fixtureWal, wal, { mode: 0o400 });
      writeFileSync(join(fixtureState, "history.ansi"), history);
      writeFileSync(join(fixtureState, "checkpoint.json"), JSON.stringify(checkpoint));
      const records = [...readOutputWal(fixtureWal)];
      expect(records.filter((record) => record.kind === "output")).toHaveLength(fixture.records);
      expect(records.filter((record) => record.kind !== "output")).toHaveLength(2);
      expect(checkpoint.cursor.sequence).toBe(String(fixture.records + 2));
      expect(checkpoint.cursor.walOffset).toBe(wal.length);
      expect(checkpoint.historyBytes).toBe(history.length);
      const counter = join(dir, "tmux-count");
      const wrapper = join(dir, "tmux-counting.sh");
      const realTmux = Bun.which("tmux");
      if (!realTmux) throw new Error("tmux is required");
      writeFileSync(counter, "");
      writeFileSync(wrapper, `#!/bin/sh\necho x >> '${counter}'\nexec '${realTmux}' "$@"\n`, { mode: 0o700 });
      return Object.freeze({
        fixture, options: { walPath: fixtureWal, stateDir: fixtureState, tmuxCommand: wrapper },
        walHash: sha256(wal), historyHash: sha256(history),
        checkpointJson: JSON.stringify(checkpoint), counter,
        fixtureSetupMs: performance.now() - start,
      });
    }

    function recover(prepared: ReturnType<typeof installRecoveryFixture>) {
      const count = () => readFileSync(prepared.counter, "utf8").split("\n").filter(Boolean).length;
      // A producer accidentally moved into the timed boundary must be visible
      // as extra calls; fixture preparation itself never invokes tmux.
      expect(count()).toBe(0);
      const openStart = performance.now();
      const session = new TerminalReplayMaterializer(prepared.options).open();
      const openVerifyMs = performance.now() - openStart;
      const openCalls = count();
      const current = session.current;
      let oracleMs = 0;
      let refreshMs = 0;
      let closeMs = 0;
      let refreshCalls = 0;
      try {
        const oracleStart = performance.now();
        expect(current.recoveredFromCheckpoint).toBe(true);
        expect(current.verified).toBe(true);
        expect(current.complete).toBe(true);
        expect(current.hasMoreWal).toBe(false);
        expect(current.sequence).toBe(BigInt(prepared.fixture.records + 2));
        expect(sha256(readFileSync(prepared.options.walPath))).toBe(prepared.walHash);
        expect(sha256(readFileSync(current.historyPath))).toBe(prepared.historyHash);
        expect(JSON.parse(readFileSync(current.checkpointPath, "utf8")))
          .toEqual(JSON.parse(prepared.checkpointJson));
        oracleMs = performance.now() - oracleStart;
        const refreshStart = performance.now();
        expect(session.refresh()).toEqual(current);
        refreshMs = performance.now() - refreshStart;
        refreshCalls = count() - openCalls;
      } finally {
        const closeStart = performance.now();
        session.close();
        closeMs = performance.now() - closeStart;
      }
      const calls = count();
      const metrics = {
        outputRecords: prepared.fixture.records, controlRecords: 2,
        walBytes: statSync(prepared.options.walPath).size,
        fixtureSha256: prepared.fixture.sha256, fixtureSetupMs: prepared.fixtureSetupMs,
        openVerifyMs, oracleMs, refreshMs, closeMs,
        openCalls, refreshCalls, closeCalls: calls - openCalls - refreshCalls, calls,
      };
      console.log("R2_RECOVERY", JSON.stringify(metrics));
      return { current, metrics };
    }

    test("600-record control corpus preserves committed ED3 rows, resize and split CSI", () => {
      const fixture = prepared[1]!;
      const { current } = recover(fixture);
      // The old 600-record test's pre-ED3 oracle remains; extend it to the
      // final geometry and carried SGR state from the split escape sequence.
      expect(numberedRows(current)).toContain(150);
      expect(current.geometry).toEqual(geometry(20, 6));
      expect(current.screen?.pendingEscapeBase64).toBe("");
      expect(renderedBytes(current).includes(Buffer.from("\x1b[32m"))).toBe(true);
    }, 120_000);

    test("recovery performance budget scales with output batches and controls, not record count", () => {
      const small = recover(prepared[0]!).metrics;
      const large = recover(prepared[1]!).metrics;
      expect(large.outputRecords / small.outputRecords).toBe(10);
      expect(large.controlRecords).toBe(small.controlRecords);
      // Keep the original 600/4 call ceiling. Also enforce the scaling law:
      // a tenfold record increase with the same control boundaries may add
      // at most one six-command feed/drain cycle, not hundreds of round trips.
      expect(small.calls).toBeGreaterThan(0);
      expect(large.calls).toBeLessThan(600 / 4);
      expect(large.calls).toBeLessThanOrEqual(small.calls + 6);
      expect(small.refreshCalls).toBe(0);
      expect(large.refreshCalls).toBe(0);
    }, 120_000);
  });

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
      // Exactly full width: no -N padding, so a capture ending on this row
      // ends red and the next capture's first (default) row has no codes.
      else if (index % 9 === 4) text = `\x1b[31m${"R".repeat(21)}${n}\x1b[0m\r\n`;
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

  describe("immutable old-reader reference", () => {
    let archived: {
      wal: string; history: string; checkpoint: TerminalReplayCheckpoint;
      handoffHistory: string; handoffCheckpoint: TerminalReplayCheckpoint;
    };
    let copyDir: string;
    let handoff: TerminalReplayCheckpoint;
    let fixtureSetupMs: number;

    beforeEach(() => {
      const start = performance.now();
      const bytes = inflateSync(Buffer.from(ROLLBACK_FIXTURE.deflateBase64, "base64"));
      expect(sha256(bytes)).toBe(ROLLBACK_FIXTURE.sha256);
      archived = JSON.parse(bytes.toString("utf8"));
      writeFileSync(walPath, Buffer.from(archived.wal, "base64"), { mode: 0o400 });
      copyDir = join(root, "materialized-copy");
      mkdirSync(copyDir, { mode: 0o700 });
      handoff = { ...archived.handoffCheckpoint, walPath };
      writeFileSync(join(copyDir, "checkpoint.json"), JSON.stringify(handoff));
      writeFileSync(join(copyDir, "history.ansi"), Buffer.from(archived.handoffHistory, "base64"));
      fixtureSetupMs = performance.now() - start;
    });

    test("a coalesced recovery leaves bytes a per-record runtime (0.20.2) can still verify", () => {
      // This archived producer used 240 styled/OSC8/wrapped records, a 512 B
      // frame budget, and six refreshes before handoff. Its final reference
      // was produced without reopening (per-record throughout), then hashed.
      // The handoff deliberately contains an extra SGR reset: a byte-exact
      // old reader must receive those exact screen bytes after recovery.
      expect([...readOutputWal(walPath)]).toHaveLength(241);
      expect(handoff.cursor.walOffset).toBeLessThan(statSync(walPath).size);
      expect(Buffer.from(handoff.screen!.cellsBase64, "base64").subarray(0, 4))
        .toEqual(Buffer.from("\x1b[0m"));
      const start = performance.now();
      const reopened = new TerminalReplayMaterializer({
        walPath, stateDir: copyDir, maxWalFrameBytesPerRefresh: 512,
      }).open();
      const openVerifyMs = performance.now() - start;
      let refreshMs = 0;
      let closeMs = 0;
      let refreshes = 0;
      try {
        expect(reopened.current.recoveredFromCheckpoint).toBe(true);
        expect(reopened.current.verified).toBe(true);
        expect(reopened.current.hasMoreWal).toBe(true);
        const republished = JSON.parse(readFileSync(join(copyDir, "checkpoint.json"), "utf8"));
        expect(JSON.stringify(republished.screen)).toBe(JSON.stringify(handoff.screen));
        expect(republished.historyBytes).toBe(handoff.historyBytes);
        expect(republished.cursor).toEqual(handoff.cursor);
        const refreshStart = performance.now();
        let continued = reopened.current;
        while (continued.hasMoreWal) {
          const before = continued;
          continued = reopened.refresh();
          expect(continued.sequence).toBeGreaterThan(before.sequence);
          expect(continued.walOffset - before.walOffset).toBeLessThanOrEqual(512);
          refreshes += 1;
        }
        expect(continued.sequence).toBe(241n);
        refreshMs = performance.now() - refreshStart;
      } finally {
        const closeStart = performance.now();
        reopened.close();
        closeMs = performance.now() - closeStart;
      }
      expect(refreshes).toBeGreaterThan(0);
      expect(readFileSync(join(copyDir, "history.ansi")))
        .toEqual(Buffer.from(archived.history, "base64"));
      const afterRecovery = JSON.parse(readFileSync(join(copyDir, "checkpoint.json"), "utf8"));
      expect(afterRecovery).toEqual({ ...archived.checkpoint, walPath });
      expect(readFileSync(walPath)).toEqual(Buffer.from(archived.wal, "base64"));
      console.log("R2_ROLLBACK", JSON.stringify({
        fixtureSha256: ROLLBACK_FIXTURE.sha256, fixtureSetupMs,
        openVerifyMs, refreshMs, refreshes, closeMs,
      }));
    }, 90_000);
  });

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
