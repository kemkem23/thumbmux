import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, openSync, readSync, closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import { parseOutputWalJson, readOutputWal } from "../src/output-wal";
import {
  installTerminalControlWalSignalHandlers,
  readTerminalControlWalHealth,
  terminalControlWalStatusPath,
  TerminalControlWalRecorder,
  type TerminalControlProcess,
  type TerminalControlSourceIdentity,
} from "../src/integrations/terminal-control-wal-recorder";
import { TerminalReplayMaterializer } from "../src/terminal-replay-materializer";
import {
  parseTmuxControlWalBytesLine,
  resolveTerminalWalPaths,
  type TerminalWalIdentity,
} from "../src/integrations/terminal-wal";
import { TmuxControlStreamBuffer } from "../src/integrations/tmux-control-stream";

class FakeControlProcess extends EventEmitter implements TerminalControlProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed = true;
    this.emit("exit", null, typeof signal === "string" ? signal : null);
    return true;
  }
}

let roots: string[] = [];
let recorders: TerminalControlWalRecorder[] = [];

function makeDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "tmctlwal-"));
  roots.push(root);
  return join(root, "lane");
}

function identity(overrides: Partial<TerminalWalIdentity> = {}): TerminalWalIdentity {
  return {
    session: "durable-agent-1",
    instanceId: "terminal-control-incarnation",
    paneTarget: "=durable-agent-1:0.0",
    tmuxServerPid: 4321,
    sessionCreated: 1_700_000_000,
    ...overrides,
  };
}

function source(overrides: Partial<TerminalControlSourceIdentity> = {}): TerminalControlSourceIdentity {
  return {
    session: "durable-agent-1",
    sessionId: "$9",
    windowId: "@42",
    paneId: "%42",
    paneTarget: "=durable-agent-1:0.0",
    tmuxServerPid: 4321,
    sessionCreated: 1_700_000_000,
    geometry: { cols: 80, rows: 24 },
    ...overrides,
  };
}

function makeRecorder(options: {
  directory?: string;
  fake?: FakeControlProcess;
  resolved?: TerminalControlSourceIdentity;
  onFatal?: (error: Error) => void;
  onAlert?: (message: string) => void;
} = {}): {
  directory: string;
  fake: FakeControlProcess;
  recorder: TerminalControlWalRecorder;
  spawnArgs: string[][];
} {
  const directory = options.directory ?? makeDirectory();
  const fake = options.fake ?? new FakeControlProcess();
  const spawnArgs: string[][] = [];
  const recorder = new TerminalControlWalRecorder({
    worker: {
      directory,
      identity: identity(),
      geometry: { cols: 80, rows: 24 },
    },
    readyTimeoutMs: 2_000,
  }, {
    spawnControl: (_executable, args) => {
      spawnArgs.push(args);
      return fake;
    },
    resolveIdentity: async () => options.resolved ?? source(),
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
    ...(options.onAlert === undefined ? {} : { onAlert: options.onAlert }),
  });
  recorders.push(recorder);
  return { directory, fake, recorder, spawnArgs };
}

async function ready(recorder: TerminalControlWalRecorder, fake: FakeControlProcess): Promise<void> {
  const starting = recorder.start();
  fake.stdout.write("%begin 1700000000 1 0\n%end 1700000000 1 0\n");
  fake.stdout.write("%session-changed $9 durable-agent-1\n");
  await starting;
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const GAPHOLE_RECORD_BYTES = 512;

function gapholeRecord(epoch: string, index: number): Buffer {
  const prefix = `PB1|${epoch}|${String(index).padStart(8, "0")}|`;
  const suffix = `|${String(index).padStart(8, "0")}:END\n`;
  const fillLength = GAPHOLE_RECORD_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  return Buffer.from(prefix + String(index % 10).repeat(fillLength) + suffix, "ascii");
}

function gapholeSource(epoch: string, count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, (_, index) => gapholeRecord(epoch, index)));
}

function encodeTmuxControlOutput(paneId: string, bytes: Uint8Array): string {
  let encoded = `%output ${paneId} `;
  for (const byte of bytes) {
    if (byte === 0x5c) encoded += "\\\\";
    else if (byte < 0x20 || byte >= 0x7f) encoded += `\\${byte.toString(8).padStart(3, "0")}`;
    else encoded += String.fromCharCode(byte);
  }
  return `${encoded}\n`;
}

function gapholeMissingRanges(source: Uint8Array, observed: Uint8Array): Array<{ start: number; end: number }> {
  const left = Buffer.from(source);
  const right = Buffer.from(observed);
  const missing: Array<{ start: number; end: number }> = [];
  let sourceOffset = 0;
  let observedOffset = 0;
  while (sourceOffset < left.length && observedOffset < right.length) {
    if (left[sourceOffset] === right[observedOffset]) {
      sourceOffset += 1;
      observedOffset += 1;
      continue;
    }
    const anchor = right.subarray(observedOffset, Math.min(right.length, observedOffset + 32));
    const next = anchor.byteLength >= 8 ? left.indexOf(anchor, sourceOffset + 1) : -1;
    if (next >= 0) {
      missing.push({ start: sourceOffset, end: next });
      sourceOffset = next;
      continue;
    }
    const marker = right.subarray(observedOffset).toString("latin1").match(/^PB1\|[^|]+\|\d{8}\|/);
    observedOffset += marker ? GAPHOLE_RECORD_BYTES : 1;
  }
  if (sourceOffset < left.length) missing.push({ start: sourceOffset, end: left.length });
  return missing;
}

function gapholeCoverage(
  records: ReturnType<typeof readOutputWal> extends Iterable<infer R> ? R[] : never,
  source: Buffer,
): Array<{ start: number; end: number }> {
  const segments: Buffer[] = [];
  let current: Buffer[] = [];
  let gaps = 0;
  for (const record of records) {
    if (record.kind === "output") current.push(Buffer.from(record.payload));
    if (record.kind === "gap") {
      segments.push(Buffer.concat(current));
      current = [];
      gaps += 1;
    }
  }
  segments.push(Buffer.concat(current));
  if (gaps === 0) return [];
  const positions: Array<{ start: number; end: number } | null> = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.byteLength === 0) {
      positions.push(null);
      continue;
    }
    const anchor = segment.subarray(0, Math.min(segment.byteLength, 2_048));
    const start = source.indexOf(anchor, cursor);
    if (start < 0) throw new Error("cannot map WAL segment into source");
    positions.push({ start, end: start + segment.byteLength });
    cursor = start + segment.byteLength;
  }
  return Array.from({ length: gaps }, (_, index) => {
    let start = 0;
    let end = source.byteLength;
    for (let probe = index; probe >= 0; probe -= 1) {
      if (positions[probe]) { start = positions[probe]!.end; break; }
    }
    for (let probe = index + 1; probe < positions.length; probe += 1) {
      if (positions[probe]) { end = positions[probe]!.start; break; }
    }
    return { start, end };
  });
}

function gapholeUncovered(
  missing: Array<{ start: number; end: number }>,
  coverage: Array<{ start: number; end: number }>,
): number {
  let total = 0;
  for (const range of missing) {
    let spans = [{ start: range.start, end: range.end }];
    for (const cover of coverage) {
      spans = spans.flatMap((span) => {
        if (cover.end <= span.start || cover.start >= span.end) return [span];
        return [
          ...(cover.start > span.start ? [{ start: span.start, end: cover.start }] : []),
          ...(cover.end < span.end ? [{ start: cover.end, end: span.end }] : []),
        ];
      });
    }
    total += spans.reduce((sum, span) => sum + span.end - span.start, 0);
  }
  return total;
}

afterEach(async () => {
  for (const recorder of recorders.splice(0).reverse()) {
    if (recorder.status.state !== "disconnected") await recorder.stop();
  }
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("tmux control byte stream", () => {
  test("retains delivered bytes until each complete byte line is consumed", () => {
    const stream = new TmuxControlStreamBuffer({ maxLineBytes: 64, maxBufferedBytes: 128 });
    stream.append(Buffer.from("%output %1 hi\\012\n%pause %1\n"));
    expect(Buffer.from(stream.nextLine()!).toString("ascii")).toBe("%output %1 hi\\012");
    expect(stream.bufferedBytes).toBeGreaterThan(0);
    expect(Buffer.from(stream.nextLine()!).toString("ascii")).toBe("%pause %1");
    expect(stream.nextLine()).toBeNull();
    stream.finish();
  });

  test("does not discard a malformed delivered line before reporting fatal input", () => {
    const stream = new TmuxControlStreamBuffer({ maxLineBytes: 64, maxBufferedBytes: 128 });
    stream.append(Buffer.from("%output %1 bad\\x\n", "ascii"));
    const line = stream.peekLine();
    expect(line).not.toBeNull();
    expect(() => parseTmuxControlWalBytesLine(line!)).toThrow("invalid tmux control-mode escape");
    expect(stream.bufferedBytes).toBe(Buffer.byteLength("%output %1 bad\\x\n"));
  });
});

describe("ordered tmux control WAL recorder", () => {
  test("maps TERM/INT to disconnect, USR2 to END arm, and USR1 to cancel", async () => {
    const target = new EventEmitter();
    let disconnects = 0;
    let arms = 0;
    let cancels = 0;
    installTerminalControlWalSignalHandlers({
      stop: async () => { disconnects += 1; },
      armLogicalEndOnSourceExit: () => { arms += 1; },
      cancelLogicalEndOnSourceExit: () => { cancels += 1; },
    }, { target });

    target.emit("SIGTERM");
    target.emit("SIGINT");
    target.emit("SIGUSR2");
    target.emit("SIGUSR1");
    target.emit("SIGUSR2");
    await eventually(
      () => disconnects === 2 && arms === 2 && cancels === 1,
      "signal actions",
    );
    expect({ disconnects, arms, cancels }).toEqual({ disconnects: 2, arms: 2, cancels: 1 });
  });

  test("attaches read-only to the exact pane and durably orders OUTPUT, layout, redraw OUTPUT", async () => {
    const { directory, fake, recorder, spawnArgs } = makeRecorder();
    await ready(recorder, fake);
    expect(readTerminalControlWalHealth(directory)).toMatchObject({
      version: 1,
      state: "ready",
      pid: process.pid,
      source: { sessionId: "$9", windowId: "@42", paneId: "%42" },
    });
    expect(spawnArgs).toEqual([[
      "-C",
      "attach-session",
      "-f",
      "read-only,ignore-size,pause-after=1",
      "-t",
      "=durable-agent-1:0.0",
    ]]);

    fake.stdout.write("%extended-output %42 0 : before\\015\\012\n");
    fake.stdout.write("%layout-change @42 abcd,90x30,0,0,42 abcd,90x30,0,0,42 *\n");
    fake.stdout.write("%extended-output %42 0 : after\\015\\012\n");
    recorder.armLogicalEndOnSourceExit();
    expect(readTerminalControlWalHealth(directory)).toMatchObject({ state: "end-armed" });
    fake.stdout.write("%output %42 tail-before-exit\\012\n%exit\n%window-renamed @42 after-exit\n");
    await eventually(() => recorder.status.state === "disconnected", "ordered logical END");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual([
      "lifecycle",
      "checkpoint",
      "output",
      "resize",
      "resize",
      "output",
      "output",
      "lifecycle",
    ]);
    expect(parseOutputWalJson(records[1]!)).toEqual({ event: "source-tracking", version: 1 });
    expect(Buffer.from(records[2]!.payload).toString()).toBe("before\r\n");
    expect(parseOutputWalJson(records[3]!)).toEqual({
      phase: "prepare",
      changeId: "layout:1",
      from: { cols: 80, rows: 24 },
      to: { cols: 90, rows: 30 },
      reason: "tmux-control-layout",
    });
    expect(parseOutputWalJson(records[4]!)).toMatchObject({ phase: "commit", changeId: "layout:1" });
    expect(Buffer.from(records[5]!.payload).toString()).toBe("after\r\n");
    expect(Buffer.from(records[6]!.payload).toString()).toBe("tail-before-exit\n");
    expect(parseOutputWalJson(records[7]!)).toMatchObject({
      event: "end",
      geometry: { cols: 90, rows: 30 },
    });
  });

  test("cancelled END arm leaves a source disconnect resumable", async () => {
    const { directory, fake, recorder } = makeRecorder();
    await ready(recorder, fake);
    recorder.armLogicalEndOnSourceExit();
    expect(recorder.status.state).toBe("end-armed");
    recorder.cancelLogicalEndOnSourceExit();
    expect(readTerminalControlWalHealth(directory)).toMatchObject({ state: "ready" });
    fake.stdout.write("%output %42 still-resumable\\012\n%exit\n");
    await eventually(() => recorder.status.state === "disconnected", "cancelled END disconnect");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint", "output", "checkpoint"]);
    expect(parseOutputWalJson(records[0]!)).toMatchObject({ event: "start" });
    expect(parseOutputWalJson(records[1]!)).toEqual({ event: "source-tracking", version: 1 });
    expect(parseOutputWalJson(records[3]!)).toEqual({
      event: "source-detached", version: 1, lastDurableSeq: "3",
    });
  });

  test("durably records pause and accepts its continue acknowledgement inside the command block", async () => {
    const { directory, fake, recorder } = makeRecorder();
    let commands = "";
    fake.stdin.on("data", (chunk) => {
      commands += Buffer.from(chunk).toString();
    });
    await ready(recorder, fake);

    fake.stdout.write("%pause %42\n");
    // tmux 3.4 requires the pane-action to be quoted; unquoted %<id>:continue
    // returns %error and crashes the recorder. Verify the quoted form is sent.
    await eventually(() => commands.includes('refresh-client -A "%42:continue"\n'), "continue command");
    // Only the pending continue acknowledgement is accepted within the
    // command response. Output notifications resume outside its delimiter.
    fake.stdout.write("%begin 1700000001 2 1\n%continue %42\n%end 1700000001 2 1\n%output %42 resumed\\012\n");
    expect(recorder.status.state).toBe("ready");
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint", "gap", "output"]);
    expect(parseOutputWalJson(records[1]!)).toEqual({ event: "source-tracking", version: 1 });
    expect(parseOutputWalJson(records[2]!)).toMatchObject({
      paneId: "%42",
      reason: "tmux-pause",
      lastDurableSeq: "2",
      missingBytes: null,
      coverage: "unknown",
    });
    expect(Buffer.from(records[3]!.payload).toString()).toBe("resumed\n");
  });

  test("pauses on malformed output and retains later lines instead of consuming them", async () => {
    const fatals: Error[] = [];
    const { directory, fake, recorder } = makeRecorder({ onFatal: (error) => fatals.push(error) });
    await ready(recorder, fake);

    fake.stdout.write("%output %42 good\\012\n%output %42 bad\\x\n%output %42 later\\012\n");
    expect(recorder.status.state).toBe("fatal");
    expect(fake.stdout.isPaused()).toBe(true);
    expect(recorder.status.bufferedControlBytes).toBeGreaterThan(0);
    expect(fatals[0]?.message).toContain("invalid tmux control-mode escape");
    expect(readTerminalControlWalHealth(directory)).toMatchObject({
      state: "fatal",
      error: expect.stringContaining("invalid tmux control-mode escape"),
    });
    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    const outputs = records.filter((record) => record.kind === "output");
    expect(Buffer.concat(outputs.map((record) => Buffer.from(record.payload))).toString()).toBe("good\n");
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint", "output", "gap", "checkpoint"]);
    expect(parseOutputWalJson(records[1]!)).toEqual({ event: "source-tracking", version: 1 });
    expect(parseOutputWalJson(records[3]!)).toMatchObject({
      paneId: "%42",
      reason: "recorder-failure",
      lastDurableSeq: "3",
      missingBytes: null,
      coverage: "unknown",
    });
    expect(parseOutputWalJson(records[4]!)).toEqual({
      event: "source-detached", version: 1, lastDurableSeq: "4",
    });
  });

  test("fails identity validation before creating a WAL lifecycle", async () => {
    const directory = makeDirectory();
    const { fake, recorder } = makeRecorder({
      directory,
      resolved: source({ paneId: "%99", paneTarget: "=durable-agent-1:0.1" }),
    });
    const starting = recorder.start();
    fake.stdout.write("%begin 1 1 0\n%end 1 1 0\n%session-changed $9 durable-agent-1\n");
    await expect(starting).rejects.toThrow("exact WAL pane target");
    expect(fake.stdout.isPaused()).toBe(true);
    expect(existsSync(resolveTerminalWalPaths(directory).walPath)).toBe(false);
  });

  test("alerts out of band when fatal health cannot be persisted", async () => {
    const alerts: string[] = [];
    const { directory, fake, recorder } = makeRecorder({ onAlert: (message) => alerts.push(message) });
    await ready(recorder, fake);
    const healthPath = terminalControlWalStatusPath(directory);
    unlinkSync(healthPath);
    mkdirSync(healthPath);

    fake.stdout.write("%output %42 bad\\x\n");

    expect(recorder.status.state).toBe("fatal");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("fatal health could not be persisted");
    expect(alerts[0]).not.toContain("gap was persisted");
    rmSync(healthPath, { recursive: true });
  });

  test("treats %exit as source disconnect without ending the logical lifecycle", async () => {
    const { directory, fake, recorder } = makeRecorder();
    await ready(recorder, fake);
    fake.stdout.write("%output %42 final\\012\n%exit\n");
    await eventually(() => recorder.status.state === "disconnected", "source disconnect");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "checkpoint", "output", "checkpoint"]);
    expect(parseOutputWalJson(records[1]!)).toEqual({ event: "source-tracking", version: 1 });
    expect(parseOutputWalJson(records[3]!)).toEqual({
      event: "source-detached", version: 1, lastDurableSeq: "3",
    });
    expect(readTerminalControlWalHealth(directory)).toMatchObject({
      state: "disconnected",
      pid: process.pid,
      source: { paneId: "%42", windowId: "@42" },
    });
  });

  test("disconnect then same logical recorder RESUME is accepted by replay", async () => {
    const directory = makeDirectory();
    const first = makeRecorder({ directory });
    await ready(first.recorder, first.fake);
    first.fake.stdout.write("%output %42 first\\015\\012\n%exit\n");
    await eventually(() => first.recorder.status.state === "disconnected", "first disconnect");

    const second = makeRecorder({ directory });
    await ready(second.recorder, second.fake);
    second.fake.stdout.write("%output %42 second\\015\\012\n%exit\n");
    await eventually(() => second.recorder.status.state === "disconnected", "second disconnect");

    const walPath = resolveTerminalWalPaths(directory).walPath;
    const lifecycle = [...readOutputWal(walPath)]
      .filter((record) => record.kind === "lifecycle")
      .map((record) => parseOutputWalJson<{ event: string }>(record).event);
    expect(lifecycle).toEqual(["start", "resume"]);
    const replay = new TerminalReplayMaterializer({
      walPath,
      stateDir: join(directory, "replay-state"),
    }).materialize();
    expect(replay.complete).toBe(true);
    expect(replay.ended).toBe(false);
  });

  test("marks every pause-resume hole so greedy missing bytes stay inside the gap", async () => {
    const epoch = "gaphole1";
    const source = gapholeSource(epoch, 40);
    const pre = source.subarray(0, 10 * GAPHOLE_RECORD_BYTES + 100);
    const post = source.subarray(20 * GAPHOLE_RECORD_BYTES + 26 + 80);
    const { directory, fake, recorder } = makeRecorder();
    await ready(recorder, fake);
    fake.stdout.write(encodeTmuxControlOutput("%42", pre));
    fake.stdout.write("%pause %42\n%continue %42\n");
    fake.stdout.write(encodeTmuxControlOutput("%42", post));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.some((record) => record.kind === "gap")).toBe(true);
    const durable = Buffer.concat(
      records.filter((record) => record.kind === "output").map((record) => Buffer.from(record.payload)),
    );
    const uncovered = gapholeUncovered(gapholeMissingRanges(source, durable), gapholeCoverage(records, source));
    expect(uncovered).toBe(0);
  });
});

describe("ordered tmux control WAL recorder with a disposable private tmux server", () => {
  test("captures live bytes and a real layout change without touching the production socket", async () => {
    const tmuxVersion = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    if (tmuxVersion.status !== 0) return;

    const session = `tmwal${process.pid}${Date.now()}`;
    const directory = makeDirectory();
    const socketPath = resolve(directory, "..", "private-tmux.sock");
    let recorder: TerminalControlWalRecorder | null = null;
    try {
      const created = spawnSync("tmux", [
        "-S",
        socketPath,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "80",
        "-y",
        "24",
        "sh",
        "-c",
        "sleep 0.8; printf 'tmwal-ไทย🙂-'; printf '\\000'; printf '%s\\n' '-tail'; i=0; while [ $i -lt 30 ]; do printf 'tmwal-tick-%s\\n' \"$i\"; i=$((i+1)); sleep 0.1; done; sleep 2",
      ], { encoding: "utf8" });
      expect(created.status).toBe(0);

      const format = [
        "#{session_name}",
        "#{session_id}",
        "#{window_id}",
        "#{pane_id}",
        "#{window_index}",
        "#{pane_index}",
        "#{pane_width}",
        "#{pane_height}",
        "#{pid}",
        "#{session_created}",
      ].join("|");
      const queried = spawnSync("tmux", [
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        `=${session}:0.0`,
        format,
      ], { encoding: "utf8" });
      expect(queried.status).toBe(0);
      const [
        queriedSession,
        _sessionId,
        _windowId,
        _paneId,
        windowIndex,
        paneIndex,
        cols,
        rows,
        serverPid,
        sessionCreated,
      ] = queried.stdout.trim().split("|");

      recorder = new TerminalControlWalRecorder({
        worker: {
          directory,
          identity: {
            session: queriedSession!,
            instanceId: "private-tmux-integration",
            paneTarget: `=${queriedSession}:${windowIndex}.${paneIndex}`,
            tmuxServerPid: Number(serverPid),
            sessionCreated: Number(sessionCreated),
          },
          geometry: { cols: Number(cols), rows: Number(rows) },
        },
        tmux: { socketPath },
        readyTimeoutMs: 5_000,
      });
      recorders.push(recorder);
      await recorder.start();
      const walPath = resolveTerminalWalPaths(directory).walPath;
      const byteExactMarker = Buffer.concat([
        Buffer.from("tmwal-ไทย🙂-", "utf8"),
        Buffer.from([0x00]),
        Buffer.from("-tail\r\n", "ascii"),
      ]);
      await eventually(() => {
        const output = Buffer.concat(
          [...readOutputWal(walPath)]
            .filter((record) => record.kind === "output")
            .map((record) => Buffer.from(record.payload)),
        );
        return output.includes(byteExactMarker);
      }, "real tmux raw UTF-8, emoji, and NUL output");

      const resized = spawnSync("tmux", [
        "-S",
        socketPath,
        "resize-window",
        "-t",
        `=${session}:0`,
        "-x",
        "90",
        "-y",
        "30",
      ], { encoding: "utf8" });
      expect(resized.status).toBe(0);
      await eventually(() => {
        return [...readOutputWal(walPath)].some((record) => {
          if (record.kind !== "resize") return false;
          const value = parseOutputWalJson<{ phase?: string; to?: { cols?: number; rows?: number } }>(record);
          return value.phase === "commit" && value.to?.cols === 90 && value.to.rows === 30;
        });
      }, "real tmux layout boundary");

      recorder.armLogicalEndOnSourceExit();
      expect(readTerminalControlWalHealth(directory)).toMatchObject({ state: "end-armed" });
      const killed = spawnSync("tmux", ["-S", socketPath, "kill-server"], { encoding: "utf8" });
      expect(killed.status).toBe(0);
      await eventually(() => recorder!.status.state === "disconnected", "real tmux ordered END");
      const records = [...readOutputWal(walPath)];
      expect(records[0]?.kind).toBe("lifecycle");
      expect(parseOutputWalJson(records[0]!)).toMatchObject({ event: "start" });
      expect(parseOutputWalJson(records.at(-1)!)).toMatchObject({ event: "end" });
    } finally {
      if (recorder && recorder.status.state !== "disconnected") {
        await recorder.stop();
      }
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { encoding: "utf8" });
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  }, 15_000);
});

import { HistoryCalibrator, equalCalibrationFrames, CAPTURE_CADENCE, type CalibrationCapture, type CalibrationFrame, type CalibrationPorts, type CalibratorOptions } from '../src/history-calibrator';
import { rowKey, matchHistoryRows, IncrementalHistoryMatcher, equalHistoryRows, type HistoryRow, type CapturedRow } from '../src/history-row-matcher';
import { HistoryWatchdog } from '../src/history-watchdog';

const naRow = (text: string): CapturedRow => ({ softWrap: false, cells: Array.from(text, grapheme => ({ grapheme, width: 1 as const, continuation: false, fg: 'default', bg: 'default', style: 0 })) });
const naRows = (texts: string[]): HistoryRow[] => texts.map((text, i) => ({ ...naRow(text), lineId: i + 1, sourceEpoch: 1, geometryGeneration: 1 }));
const naScope = { sourceEpoch: 1, geometryGeneration: 1, completeRetainedTail: true };
function naHarness(incremental = false, options: CalibratorOptions = {}) {
  let time = 0, revision = 1;
  const paneKey = { serverIdentity: 'private', paneId: '%0', birthGeneration: 1 };
  const frame: CalibrationFrame = { cells: [naRow('abc ').cells], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 };
  // Five rows: FIX1-PLAN §2 checks b..d (two unique triples bracket them); a
  // three-row ring has one triple and can only be content-matched.
  const history = naRows(['a', 'b', 'c', 'd', 'e']);
  let parser = structuredClone(frame);
  const limits: number[] = [], scheduled: number[] = [], published: number[] = [], faults: string[] = [], writes: Parameters<CalibrationPorts['calibrate']>[0][] = [];
  let conflict = false, stale = false;
  const ports: CalibrationPorts = {
    now: () => time,
    read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory: history, parserFrame: parser }),
    schedule: at => { scheduled.push(at); },
    capture: async (_, limit) => {
      limits.push(limit);
      const meta = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 1, cols: 4, rows: 1, kind: 'normal' as const, cursor: frame.cursor };
      return { paneKey, captureId: `capture-${limits.length}`, requestedAt: time, completedAt: time, before: meta, after: stale ? { ...meta, cols: 5 } : meta, frame, history, completeRetainedTail: limit >= history.length, observedFields: ['cells', 'cursor'] };
    },
    calibrate: async input => { writes.push(input); if (conflict || input.expectedRevision !== revision) { conflict = false; revision++; return null; } return { revision: ++revision, durableRevision: 0, nextLineId: 4 }; },
    publish: commit => { published.push(commit.revision); },
    fault: fault => { faults.push(fault.kind); },
  };
  const calibrator = new HistoryCalibrator(paneKey, ports, { incremental, ...options });
  return { calibrator, ports, frame, history, limits, scheduled, published, faults, writes,
    time: (at: number) => { time = at; },
    parser: (value: CalibrationFrame) => { parser = value; },
    conflict: () => { conflict = true; }, stale: () => { stale = true; },
  };
}

describe('NEWARCH L2-C matcher and calibration ports', () => {
  test('unique suffix checks exact cells and leaves bounded mismatch untouched', () => {
    const rows = naRows(['L1', 'L2', 'L3', 'bad', 'R1', 'R2', 'R3']);
    const capture = ['L1', 'L2', 'L3', 'good', 'R1', 'R2', 'R3'].map(naRow);
    const match = matchHistoryRows(rows, capture, naScope);
    // FIX1-PLAN §2: each side of the mismatch holds one triple, so no row has
    // anchors above and below it. Content is proven, identity is not.
    expect(match.checks).toHaveLength(0);
    expect(match.contentMatches.map(c => c.lineId)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(match.repairs).toHaveLength(0);
    const longer = naRows(['L0', 'L1', 'L2', 'L3', 'bad', 'R1', 'R2', 'R3', 'R4']);
    const longerCapture = ['L0', 'L1', 'L2', 'L3', 'good', 'R1', 'R2', 'R3', 'R4'].map(naRow);
    const bracketed = matchHistoryRows(longer, longerCapture, naScope);
    expect(bracketed.checks.map(c => c.lineId)).toEqual([2, 3, 7, 8]);
    expect(bracketed.contentMatches.map(c => c.lineId)).toEqual([1, 4, 6, 9]);
    expect(matchHistoryRows(rows, capture, { ...naScope, completeRetainedTail: false }).checks).toHaveLength(0);
    expect(matchHistoryRows(rows, capture, { ...naScope, geometryGeneration: 2 }).checks).toHaveLength(0);
  });
  test('constant, repeated, deleted and partial tails never acquire false checks', () => {
    for (const values of [['', '', '', ''], ['a', 'b', 'c', 'a', 'b', 'c']]) {
      const match = matchHistoryRows(naRows(values.slice(-3)), values.map(naRow), naScope);
      expect(match.checks).toHaveLength(0);
      expect(match.repairs).toHaveLength(0);
    }
    const rows = naRows(['a', 'b', 'c', 'missing', 'd', 'e', 'f']);
    const match = matchHistoryRows(rows, ['a', 'b', 'c', 'd', 'e', 'f'].map(naRow), naScope);
    expect(match.repairs).toHaveLength(0);
    // The unique suffix fixes the offset; one triple cannot bracket a row.
    expect(match.checks).toHaveLength(0);
    expect(match.contentMatches.map(c => c.lineId)).toEqual([5, 6, 7]);
  });
  test('20,000-row fixture remains unchanged when only the retained tail can be checked', () => {
    const rows = naRows(Array.from({ length: 20000 }, (_, i) => `row-${i}`));
    const retained = rows.slice(-4500);
    const match = matchHistoryRows(rows, retained, naScope);
    expect(rows).toHaveLength(20000);
    // Oldest and newest retained rows have no anchor on one side.
    expect(match.checks).toHaveLength(4498);
    expect(match.contentMatches.map(c => c.lineId)).toEqual([15501, 20000]);
    for (const check of match.checks) expect(rows[check.lineId - 1]).toEqual(retained[check.capturedRow]);
    console.log('NEWARCH_C_OVERFLOW', JSON.stringify({ denominator: rows.length, checked: match.checks.length, unchecked: rows.length - match.checks.length, reason: 'evicted-before-check', falseChecked: match.checks.filter(c => !equalHistoryRows(rows[c.lineId - 1]!, retained[c.capturedRow]!)).length, scope: 'fake scroll store; not real collector' }));
  });
  test('all screen/check/repair mutations share one CAS and conflict recaptures', async () => {
    const h = naHarness(); h.conflict();
    await h.calibrator.runDue();
    expect(h.published).toHaveLength(0);
    expect(h.writes[0]!.expectedRevision).toBe(1);
    h.time(50); await h.calibrator.runDue();
    expect(h.writes[1]!.expectedRevision).toBe(2);
    expect(h.published).toEqual([3]);
  });
  test('geometry transition discards capture and lifecycle events append no phantom rows', async () => {
    const h = naHarness(); h.stale();
    await h.calibrator.runDue();
    expect(h.writes).toHaveLength(0);
    for (const event of ['clear', 'alt', 'resize', 'reconnect', 'fault'] as const) h.calibrator.event(event);
    expect(h.history.map(r => r.lineId)).toEqual([1, 2, 3, 4, 5]);
    expect(h.calibrator.acceptsPipeFrame).toBe(false);
  });
  test('FIX1-PLAN §1.2 a wrong parser screen is drawn over by the committed capture and the pipe stays live', async () => {
    // Replaces the CAPTURE latch: pipe publishes were frozen for up to 1s
    // while parser and capture differed (never blank the screen, §1.3).
    const h = naHarness();
    const wrong = structuredClone(h.frame); wrong.cells = [naRow('bad ').cells]; h.parser(wrong);
    await h.calibrator.runDue();
    expect(h.writes[0]!.captureEvidence).toEqual({ kind: 'quiescent', sourceEpoch: 1, geometryGeneration: 1, receiveSeqBefore: 0, receiveSeqAfter: 0, uncertainRows: [] });
    expect(h.published).toEqual([2]);
    expect(h.calibrator.mode).toBe('PIPE');
    // Divergence re-arms 50ms: the next pipe byte redraws the parser cells.
    expect(h.calibrator.dueAt).toBe(50);
    let pipePublishes = 0;
    h.calibrator.output(() => pipePublishes++); h.calibrator.scroll(20000);
    h.time(16); await h.calibrator.runDue();
    expect(pipePublishes).toBe(1);
    h.time(50); await h.calibrator.runDue();
    expect(h.limits).toEqual([4500, 0]);
    expect(h.published).toEqual([2, 3]);
    h.parser(structuredClone(h.frame)); h.time(100); await h.calibrator.runDue();
    expect(h.published).toEqual([2, 3, 4]);
    expect(h.calibrator.dueAt).toBe(300);
    expect(h.faults).toEqual([]);
  });
  test('incremental capture reads new scrolls plus anchor, full only on lifecycle/fault', async () => {
    const h = naHarness(true);
    await h.calibrator.runDue();
    h.time(10); h.calibrator.scroll(20); h.time(200); await h.calibrator.runDue();
    expect(h.limits).toEqual([4500, 148]);
    h.time(201); h.calibrator.event('clear'); h.time(250); await h.calibrator.runDue();
    expect(h.limits.at(-1)).toBe(4500);
  });
  test('output cannot debounce calibration forever and inactive panes settle to 1s', async () => {
    const h = naHarness(); await h.calibrator.runDue();
    for (let t = 1; t <= 199; t++) { h.time(t); h.calibrator.output(); }
    expect(h.calibrator.dueAt).toBe(200);
    h.time(200); await h.calibrator.runDue();
    expect(h.limits).toHaveLength(2);
    h.time(400); await h.calibrator.runDue();
    expect(h.calibrator.dueAt).toBe(1400);
  });
  test('an event whose timer fires during capture is re-armed after completion', async () => {
    const h = naHarness();
    const capture = h.ports.capture;
    let release!: () => void;
    h.ports.capture = async (...args) => {
      const result = await capture(...args);
      return new Promise(resolve => { release = resolve.bind(null, result); });
    };
    const running = h.calibrator.runDue();
    await Promise.resolve(); await Promise.resolve();
    h.time(10); h.calibrator.event('resize');
    await h.calibrator.runDue(); // The host dequeued the event, but capture owns the lane.
    release();
    await running;
    expect(h.published).toHaveLength(0);
    expect(h.calibrator.dueAt).toBe(50);
    expect(h.scheduled.at(-1)).toBe(50);
    h.ports.capture = capture;
    h.time(50); await h.calibrator.runDue();
    expect(h.published).toHaveLength(1);
  });
  test('a capture commit cancels the older queued pipe publish even when parser matches', async () => {
    const h = naHarness();
    let stalePublishes = 0;
    h.calibrator.output(() => stalePublishes++);
    await h.calibrator.runDue();
    h.time(16); await h.calibrator.runDue();
    expect(stalePublishes).toBe(0);
    expect(h.published).toHaveLength(1);
  });
  test('dead reader and independent heartbeat detect failure even when pane_pipe would remain 1', () => {
    let at = 0; const faults: string[] = [];
    const wd = new HistoryWatchdog(() => at, f => { expect(f.missingCount).toBeNull(); faults.push(f.kind); });
    wd.capture('a'); wd.capture('b');
    at = 1000; wd.tick(); expect(faults).toEqual(['reader-stalled']);
    wd.receive(1); wd.heartbeat();
    at = 3999; wd.tick(); expect(faults).toHaveLength(1);
    at = 4000; wd.tick(); expect(faults).toContain('heartbeat-timeout');
    wd.dead('reader-eof'); expect(faults).toContain('reader-eof');
    wd.dead('reader-eof'); expect(faults.filter(f => f === 'reader-eof')).toHaveLength(1);
  });
  test('independently timed glyph/color/blank/cursor faults correct at next scheduled publish', async () => {
    // Real monotonic wall time and timers; fake parser/store/capture ports. This
    // measures the C lane only and cannot certify the later integrated path.
    const results: Record<string, number[]> = {};
    for (const kind of ['glyph', 'color', 'blank', 'cursor']) {
      const samples: number[] = [];
      const h = naHarness();
      const started = performance.now();
      h.ports.now = () => performance.now() - started;
      let injected = 0, corrected = 0;
      h.ports.publish = (_, frame) => {
        expect(equalCalibrationFrames(frame, h.frame)).toBe(true);
        corrected = performance.now();
      };
      for (let n = 0; n < 25; n++) {
        const wrong = structuredClone(h.frame);
        if (kind === 'cursor') wrong.cursor!.x = 2;
        else {
          const cells = wrong.cells.map(row => row.map(c => ({ ...c })));
          if (kind === 'color') cells[0]![0]!.fg = 'index:1';
          else cells[0]![0]!.grapheme = kind === 'blank' ? ' ' : 'X';
          wrong.cells = cells;
        }
        // Offset injection from calibration; include all waiting and publish.
        await new Promise(resolve => setTimeout(resolve, 7 + (n * 17) % 37));
        injected = performance.now(); h.parser(wrong); h.calibrator.output();
        // Timers can wake before a fractional monotonic deadline. The host
        // re-arms in that case; model that wait instead of reading an old publish.
        while (h.ports.now() < h.calibrator.dueAt) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.ceil(h.calibrator.dueAt - h.ports.now()))));
        }
        await h.calibrator.runDue();
        samples.push(corrected - injected);
        expect(corrected).toBeGreaterThanOrEqual(injected);
        h.parser(structuredClone(h.frame));
        await new Promise(resolve => setTimeout(resolve, 51));
        await h.calibrator.runDue();
      }
      samples.sort((a, b) => a - b); results[kind] = samples;
      console.log('NEWARCH_C_CORRECTION', JSON.stringify({ kind, n: samples.length, p50: samples[12], p95: samples[23], p99: samples[24], max: samples[24], correctedCellDifference: 0, scope: 'C fake ports, real timers' }));
      expect(samples[23]!).toBeLessThanOrEqual(300);
      expect(samples[24]!).toBeLessThanOrEqual(500);
    }
  });
});

// Reviewer seed, operations and all 3,000 cases preserved verbatim.
test('FIX1 reviewer adversarial corpus', () => {
// Adversarial probe for matchHistoryRows. Each row carries a hidden true id
// (oracle) that the matcher never sees. A check is "false" if content differs
// (content-false) or if the parser row and the captured row are different
// true lines (identity-false). Repairs must copy tmux content exactly.
type L = { id: number; text: string; fg?: string };
const cell = (g: string, fg = 'default') => ({ grapheme: g, width: 1 as const, continuation: false, fg, bg: 'default', style: 0 });
const cap = (l: L): CapturedRow => ({ softWrap: false, cells: Array.from(l.text.padEnd(8), g => cell(g, l.fg)) });
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const scope = { sourceEpoch: 1, geometryGeneration: 1, completeRetainedTail: true };
function run(name: string, parser: L[], tmux: L[]) {
  const recent: HistoryRow[] = parser.map((l, i) => ({ ...cap(l), lineId: i, sourceEpoch: 1, geometryGeneration: 1 }));
  const captured = tmux.map(cap);
  const m = matchHistoryRows(recent, captured, scope);
  let contentFalse = 0, identityFalse = 0, repairNotTmux = 0, repairWrongLine = 0, repairDestroysCorrect = 0, matchedContentFalse = 0;
  for (const c of m.checks) {
    if (rowKey(recent[c.lineId]!) !== rowKey(captured[c.capturedRow]!)) contentFalse++;
    if (parser[c.lineId]!.id !== tmux[c.capturedRow]!.id) identityFalse++;
  }
  // FIX1-PLAN §2 content-matched rows claim content only (contentFalse).
  for (const c of m.contentMatches) if (rowKey(recent[c.lineId]!) !== rowKey(captured[c.capturedRow]!)) matchedContentFalse++;
  for (const r of m.repairs) {
    if (rowKey(r.row) !== rowKey(captured[r.capturedRow]!)) repairNotTmux++;
    if (parser[r.lineId]!.id !== tmux[r.capturedRow]!.id) repairWrongLine++;
    // parser row was already a correct copy of its true line and the repair replaces it with another line's content
    const own = tmux.find(t => t.id === parser[r.lineId]!.id);
    if (own && rowKey(cap(own)) === rowKey(recent[r.lineId]!) && rowKey(r.row) !== rowKey(recent[r.lineId]!)) repairDestroysCorrect++;
  }
  const before = parser.map(l => l.id); const after = before.slice();
  for (const r of m.repairs) after[r.lineId] = tmux[r.capturedRow]!.id;
  const cnt = (xs: number[]) => xs.reduce((mp, x) => mp.set(x, (mp.get(x) ?? 0) + 1), new Map<number, number>());
  const cb = cnt(before), ca = cnt(after); let lostByRepair = 0, dupByRepair = 0;
  const lostIds: number[] = []; for (const [id] of cb) if (id >= 0 && !ca.has(id)) { lostByRepair++; lostIds.push(id); }
  if (lostIds.length && (globalThis as any).dumped !== true && name.startsWith('fuzz')) { (globalThis as any).dumped = true; const ringStart = tmux[0]!.id; console.log('LOSS-DUMP', JSON.stringify({ name, lostIds: lostIds.slice(0,10), ringIds: [tmux[0]!.id, tmux.at(-1)!.id], repairsOnLost: m.repairs.filter(r => lostIds.includes(parser[r.lineId]!.id)).slice(0,5).map(r => ({ lineId: r.lineId, parserId: parser[r.lineId]!.id, parserText: parser[r.lineId]!.text, parserFg: parser[r.lineId]!.fg, tmuxId: tmux[r.capturedRow]!.id, tmuxText: tmux[r.capturedRow]!.text })) })); }
  for (const [id, n] of ca) if (n > 1 && n > (cb.get(id) ?? 0)) dupByRepair++;
  return { lostByRepair, dupByRepair, name, reason: m.reason, checks: m.checks.length, contentMatches: m.contentMatches.length, matchedContentFalse, repairs: m.repairs.length, contentFalse, identityFalse, repairNotTmux, repairWrongLine, repairDestroysCorrect };
}
const stream = (n: number, vocab: number, start = 0) => Array.from({ length: n }, (_, i) => ({ id: start + i, text: vocab ? `v${Math.floor(rnd() * vocab)}` : `row-${start + i}` }));
const out: any[] = [];
// 1 long run of identical rows at the tail
{ const s = [...stream(50, 0), ...Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, text: '' }))]; out.push(run('long-identical-tail', s, s)); }
// 1b identical run with parser behind by 5 blank rows
{ const s = [...stream(50, 0), ...Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, text: '' }))]; out.push(run('identical-run-parser-behind', s.slice(0, -5), s)); }
// 2 clear mid-way: tmux ring cleared (clear-history) then new output
{ const s = stream(300, 0); const after = stream(100, 0, 300); out.push(run('clear-history-midway', [...s, ...after], after)); }
// 2b clear-screen that pushes the same visible rows into history twice (scroll-on-clear)
{ const s = stream(100, 0); const dup = s.slice(-24).map(l => ({ id: l.id + 10000, text: l.text })); out.push(run('scroll-on-clear-duplicate', s, [...s, ...dup])); }
// 3 overflow beyond history-limit between two rounds
{ const s = stream(20000, 0); out.push(run('overflow-20000-limit-4500', s, s.slice(-4500))); }
// 3b overflow while parser lost 7 rows in the middle of the retained part
{ const s = stream(20000, 0); const p = [...s.slice(0, 17000), ...s.slice(17007)]; out.push(run('overflow-with-lost-rows', p, s.slice(-4500))); }
// 4 color-only change inside the tail
{ const s = stream(100, 0); const t = s.map(l => ({ ...l })); t[60]!.fg = 'index:1'; t[99]!.fg = 'index:2'; out.push(run('color-only-change', s, t)); }
{ const s = stream(100, 0); const t = s.map(l => ({ ...l })); t[60]!.fg = 'index:1'; out.push(run('color-only-change-mid', s, t)); }
// 5 periodic content (a b c a b c ...)
{ const s = Array.from({ length: 300 }, (_, i) => ({ id: i, text: 'abc'[i % 3]! })); out.push(run('periodic-abc', s, s)); }
// 6 shift inside a bounded gap (delete one row at gap start, insert one at gap end)
{ const s: L[] = ['A1','A2','A3','P','Q','Q','B1','B2','B3'].map((t, i) => ({ id: i, text: t }));
  const t: L[] = [s[0]!, s[1]!, s[2]!, s[4]!, s[5]!, { id: 99, text: 'R' }, s[6]!, s[7]!, s[8]!];
  out.push(run('equal-length-shift-in-gap', s, t)); }
// 7 randomized fuzz: small vocab, random drops/dups/phantoms/colour edits, ring truncation
const agg = { contentMatches: 0, matchedContentFalse: 0, lostByRepair: 0, dupByRepair: 0, lossCases: [] as any[], cases: 0, checks: 0, repairs: 0, contentFalse: 0, identityFalse: 0, repairNotTmux: 0, repairWrongLine: 0, repairDestroysCorrect: 0, destroyCases: [] as any[], identityFalseCases: [] as any[] };
for (let k = 0; k < 3000; k++) {
  const vocab = [0, 2, 3, 5, 20][k % 5]!;
  const truth = stream(40 + Math.floor(rnd() * 200), vocab);
  const ring = truth.slice(-Math.max(3, Math.floor(truth.length * (0.3 + rnd() * 0.7))));
  const parser: L[] = [];
  for (const l of truth) {
    const r = rnd();
    if (r < 0.03) continue; // lost row
    if (r < 0.05) { parser.push(l, { ...l }); continue; } // duplicated row
    if (r < 0.07) { parser.push({ id: -1 - k, text: 'phantom' }, l); continue; }
    if (r < 0.10) { parser.push({ ...l, fg: 'index:9' }); continue; } // colour drift
    parser.push(l);
  }
  const behind = Math.floor(rnd() * 3);
  const res = run(`fuzz-${k}`, parser, ring.slice(0, ring.length - behind || undefined));
  agg.contentMatches += res.contentMatches; agg.matchedContentFalse += res.matchedContentFalse;
  agg.cases++; agg.checks += res.checks; agg.repairs += res.repairs; agg.contentFalse += res.contentFalse; agg.identityFalse += res.identityFalse; agg.lostByRepair += res.lostByRepair; agg.dupByRepair += res.dupByRepair; if ((res.lostByRepair||res.dupByRepair) && agg.lossCases.length < 3) agg.lossCases.push({k, vocab, parser: parser.map(l=>l.text+'#'+l.id).join(' '), tmux: ring.slice(0, ring.length - behind || undefined).map(l=>l.text+'#'+l.id).join(' '), ...res}); agg.repairNotTmux += res.repairNotTmux; agg.repairWrongLine += res.repairWrongLine; agg.repairDestroysCorrect += res.repairDestroysCorrect; if (res.repairDestroysCorrect && agg.destroyCases.length < 5) agg.destroyCases.push({ k, vocab, ...res });
  if (res.identityFalse && agg.identityFalseCases.length < 5) agg.identityFalseCases.push({ k, vocab, parser: parser.map(l=>l.text+'#'+l.id).join(' '), tmux: ring.slice(0, ring.length - behind || undefined).map(l=>l.text+'#'+l.id).join(' '), ...res });
}
for (const o of out) { expect(o.contentFalse).toBe(0); expect(o.repairNotTmux).toBe(0); expect(o.identityFalse).toBe(0); expect(o.matchedContentFalse).toBe(0); }
console.log('NEWARCH_FIX1_FUZZ', JSON.stringify({ cases: agg.cases, checks: agg.checks, falseChecked: agg.contentFalse, repairs: agg.repairs, repairNotTmux: agg.repairNotTmux, identityFalse: agg.identityFalse, contentMatches: agg.contentMatches, matchedContentFalse: agg.matchedContentFalse, identityFalseCases: agg.identityFalseCases.slice(0, 2) }));
expect(agg.cases).toBe(3000); expect(agg.checks).toBeGreaterThan(0); expect(agg.contentFalse).toBe(0); expect(agg.repairNotTmux).toBe(0);
// C-F20 / A-B3 (FIX1-PLAN §2): D16 identityFalse = 0 on checked rows. Round 1
// certified 832 identity-false rows here while every one was content-equal.
expect(agg.identityFalse).toBe(0);
expect(agg.contentMatches).toBeGreaterThan(0); expect(agg.matchedContentFalse).toBe(0);
});

test('FIX1 full matcher p95 at 4500 rows, independent cells and collision buckets', async () => {
  for (const cols of [80, 120]) {
    const recent = naRows(Array.from({ length: 4500 }, (_, i) => `row-${String(i).padStart(8, '0')}`.padEnd(cols, 'x')));
    const captured = recent.map(r => ({ softWrap: r.softWrap, cells: r.cells.map(c => ({ ...c })) }));
    captured[2200]!.cells[cols - 1]!.fg = 'index:9';
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Match the specified per-pane 200ms cadence; do not time the sleep.
      await new Promise(resolve => setTimeout(resolve, 200));
      const started = performance.now();
      const result = matchHistoryRows(recent, captured, naScope);
      times.push(performance.now() - started);
      // FIX1-PLAN §2: the first/last ring rows and the drift's neighbours lack
      // an anchor on one side; they are content-matched, not checked.
      expect(result.checks).toHaveLength(4495);
      expect(result.contentMatches.map(c => c.lineId)).toEqual([1, 2200, 2202, 4500]);
      expect(result.repairs).toHaveLength(0);
    }
    times.sort((a, b) => a - b);
    console.log('NEWARCH_FIX1_MATCHER', JSON.stringify({ cols, rows: 4500, samples: times.length, p95: times[28], max: times[29], cadenceMs: 200, driftedRows: 1 }));
    expect(times[28]!).toBeLessThanOrEqual(20);
    // Same sampled prefix, different final cells: never trust the bucket key.
    captured[2200]!.cells[cols - 1]!.fg = 'index:9';
    const result = matchHistoryRows(recent, captured, naScope);
    expect(result.checks.some(c => c.lineId === 2201)).toBe(false);
    expect(result.repairs).toHaveLength(0);
    // Two drifts force the general interning path, not the single-row fast path.
    captured[2202]!.cells[cols - 1]!.fg = 'index:8';
    const general = matchHistoryRows(recent, captured, naScope);
    expect(general.checks.some(c => c.lineId === 2201 || c.lineId === 2203)).toBe(false);
    expect(general.repairs).toHaveLength(0);
  }
});

test('FIX1 incremental checked coverage and fail-closed anchor loss', () => {
  const matcher = new IncrementalHistoryMatcher();
  const all = naRows(Array.from({ length: 8000 }, (_, i) => `line-${i}`));
  let recent = all.slice(0, 4500);
  const initial = matcher.match(recent, recent, naScope);
  matcher.remember(recent, recent, initial);
  const checked = new Set<number>();
  for (let end = 4520; end <= 7500; end += 20) {
    recent = all.slice(end - 4500, end);
    // The calibrator's partial tail is scrolls + 128 rows.
    const captured = recent.slice(-(20 + 128));
    const result = matcher.match(recent, captured, { ...naScope, completeRetainedTail: false });
    for (const c of result.checks) {
      expect(equalHistoryRows(all[c.lineId - 1]!, captured[c.capturedRow]!)).toBe(true);
      if (c.lineId > 4500) checked.add(c.lineId);
    }
    matcher.remember(recent, captured, result);
  }
  console.log('NEWARCH_FIX1_INCREMENTAL', JSON.stringify({ scrolled: 3000, checked: checked.size, ratio: checked.size / 3000 }));
  // The newest row (7500) has no anchor below it yet: content-matched only.
  expect(checked.size).toBe(2999);
  expect(checked.has(7500)).toBe(false);
  matcher.reset();
  expect(matcher.match(recent, recent.slice(-23), { ...naScope, completeRetainedTail: false }).checks).toHaveLength(0);
});

test('FIX1 capture errors, unstable metadata and CAS do not freeze pipe', async () => {
  for (const kind of ['throw', 'unstable', 'cas']) {
    const h = naHarness();
    if (kind === 'throw') h.ports.capture = async () => { throw new Error('fixture capture fault'); };
    if (kind === 'unstable') h.stale();
    if (kind === 'cas') h.conflict();
    let published = 0;
    h.calibrator.output(() => published++);
    await h.calibrator.runDue();
    h.time(16); await h.calibrator.runDue();
    expect(h.calibrator.acceptsPipeFrame).toBe(true);
    expect(published).toBe(1);
  }
});

test('FIX1 pipe publishes during capture and revision is read after 100 rows/s output', async () => {
  const h = naHarness();
  const capture = h.ports.capture;
  const read = h.ports.read;
  let revision = 1, commits = 0, pipe = 0, updates = 0, flowingMs = 0;
  const started = performance.now();
  h.ports.now = () => performance.now() - started;
  h.ports.read = () => ({ ...read(), revision });
  h.ports.calibrate = async input => {
    expect(input.expectedRevision).toBe(revision);
    commits++; return { revision: ++revision, durableRevision: 0, nextLineId: 4 };
  };
  h.ports.capture = async (key, limit) => {
    const flowStarted = performance.now();
    for (let n = 0; n < 10; n++) {
      const deadline = flowStarted + (n + 1) * 10;
      while (performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - performance.now())));
      revision++; updates++; h.calibrator.output(() => pipe++);
      await h.calibrator.runDue();
    }
    flowingMs = performance.now() - flowStarted;
    return capture(key, limit);
  };
  await h.calibrator.runDue();
  expect(commits).toBe(1); expect(pipe).toBeGreaterThan(0);
  console.log('NEWARCH_FIX1_CAS', JSON.stringify({ targetRowsPerSecond: 100, revisionUpdates: updates, elapsedMs: flowingMs, observedUpdatesPerSecond: updates * 1000 / flowingMs, commits, pipe, scope: 'revision-per-row simulation during capture; fake writer' }));
});

test('FIX1 hung capture has a deadline and heartbeat can alert after recovery', async () => {
  const h = naHarness(); let aborted = false;
  h.ports.capture = (_, __, signal) => new Promise(() => { signal?.addEventListener('abort', () => { aborted = true; }); });
  const at = performance.now(); await h.calibrator.runDue();
  expect(performance.now() - at).toBeLessThan(1500);
  expect(aborted).toBe(true); expect(h.calibrator.acceptsPipeFrame).toBe(true);
  let now = 0; const faults: string[] = [];
  const watchdog = new HistoryWatchdog(() => now, f => faults.push(f.kind));
  now = 3000; watchdog.tick(); watchdog.heartbeat();
  now = 6000; watchdog.tick();
  expect(faults).toEqual(['heartbeat-timeout', 'heartbeat-timeout']);
});

test('FIX1 reviewer 16000 repair-distance cases never worsen history', () => {
// Does applying the matcher's repairs ever move the recorded window FURTHER from
// the truth? Metric: edit distance (insert/delete/substitute) between the DB
// window content and the true content of the same line range, before vs after
// repairs. Parser faults: dropped rows, duplicated rows, phantom rows, colour drift.
const key = (t: string, fg: string) => `${t}|${fg}`;
const row = (t: string, fg = 'default'): CapturedRow => ({ softWrap: false, cells: Array.from(t.padEnd(5), g => ({ grapheme: g, width: 1 as const, continuation: false, fg, bg: 'default', style: 0 })) });
const scope = { sourceEpoch: 1, geometryGeneration: 1, completeRetainedTail: true };
function ed(a: string[], b: string[]) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0]![j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length]![b.length]!; }
let seed = 4242; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const out: Record<string, any> = {}; let example: any;
for (const vocab of [0, 3, 8, 50]) {
  const t = { cases: 0, matched: 0, repairs: 0, better: 0, same: 0, worse: 0, worseBy: 0 };
  for (let k = 0; k < 4000; k++) {
    const R = 80 + Math.floor(rnd() * 80), W = 20 + Math.floor(rnd() * 50);
    const truth = Array.from({ length: R }, (_, i) => vocab ? String.fromCharCode(97 + Math.floor(rnd() * vocab)) : `r${i}`);
    const p: { t: string; fg: string }[] = [];
    for (let i = R - W; i < R; i++) { const r = rnd(); if (r < 0.03) continue; if (r < 0.06) { p.push({ t: truth[i]!, fg: 'default' }, { t: truth[i]!, fg: 'default' }); continue; } if (r < 0.08) p.push({ t: 'PH', fg: 'default' }); if (r > 0.95) { p.push({ t: truth[i]!, fg: 'red' }); continue; } p.push({ t: truth[i]!, fg: 'default' }); }
    const behind = Math.floor(rnd() * 3); const ring = truth.slice(0, R - behind);
    const m = matchHistoryRows(p.map((x, i) => ({ ...row(x.t, x.fg), lineId: i, sourceEpoch: 1, geometryGeneration: 1 }) as HistoryRow), ring.map(x => row(x)), scope);
    t.cases++; if (m.reason === 'matched') t.matched++; t.repairs += m.repairs.length;
    if (!m.repairs.length) continue;
    const before = p.map(x => key(x.t, x.fg)); const after = before.slice();
    for (const r of m.repairs) after[r.lineId] = key(ring[r.capturedRow]!, 'default');
    const target = truth.slice(R - W).map(x => key(x, 'default'));
    const eb = ed(before, target), ea = ed(after, target);
    if (ea < eb) t.better++; else if (ea === eb) t.same++; else { t.worse++; t.worseBy += ea - eb; if (!example || before.length < example.before.length) example = { vocab, before: before.map(s => s.replace('|default', '').replace('|red', '(red)')), after: after.map(s => s.replace('|default', '').replace('|red', '(red)')), truthWindow: truth.slice(R - W), ringTail: ring.slice(-W - 5), repairs: m.repairs.map(r => `${r.lineId}:=ring[${r.capturedRow}]`), checks: m.checks.length, eb, ea }; }
  }
  out[`vocab=${vocab || 'unique'}`] = t;
}
console.log('NEWARCH_FIX1_REPAIR_DISTANCE', JSON.stringify(out));
for (const result of Object.values(out)) { expect(result.cases).toBe(4000); expect(result.worse).toBe(0); }
expect(example).toBeUndefined();
});


test('FIX1 partial capture certifies separate exact runs around an unchecked changed row', () => {
  const rows = naRows(Array.from({ length: 100 }, (_, i) => `row-${i}`));
  const matcher = new IncrementalHistoryMatcher();
  const initial = matcher.match(rows.slice(0, 80), rows.slice(0, 80), naScope);
  matcher.remember(rows.slice(0, 80), rows.slice(0, 80), initial);
  const captured = rows.slice(60).map(row => ({ ...row })); captured[25] = naRow('changed');
  const result = matcher.match(rows, captured, { ...naScope, completeRetainedTail: false });
  expect(result.reason).toBe('matched'); expect(result.repairs).toHaveLength(0);
  expect(result.checks.some(c => c.lineId === 86)).toBe(false);
  expect(result.checks.some(c => c.lineId === 99)).toBe(true);
  expect(result.contentMatches.map(c => c.lineId)).toContain(100);
  for (const c of result.checks) expect(equalHistoryRows(rows[c.lineId - 1]!, captured[c.capturedRow]!)).toBe(true);
});

test('FIX2 remember seeds the terminal triple after a general full match', () => {
  // Two drifted rows force the general path, whose checks list the suffix
  // before interior anchors. The seed must still be the last three rows, so
  // a scrolls+overlap tail continues without a full recapture.
  const all = naRows(Array.from({ length: 4700 }, (_, i) => `line-${i}`));
  let recent = all.slice(0, 4500);
  const captured = recent.map(r => ({ softWrap: r.softWrap, cells: r.cells.map(c => ({ ...c })) }));
  captured[1000]!.cells[0]!.fg = 'index:1';
  captured[3000]!.cells[0]!.fg = 'index:2';
  const matcher = new IncrementalHistoryMatcher();
  const full = matcher.match(recent, captured, naScope);
  expect(full.reason).toBe('matched');
  // Checks are ordered by row; the newest row has no anchor below it.
  expect(full.checks.every((c, k) => k === 0 || full.checks[k - 1]!.capturedRow < c.capturedRow)).toBe(true);
  expect(full.checks.at(-1)!.lineId).toBe(4499);
  matcher.remember(recent, captured, full);
  recent = all.slice(200, 4700);
  const tail = recent.slice(-(200 + 16));
  const next = matcher.match(recent, tail, { ...naScope, completeRetainedTail: false });
  expect(next.reason).toBe('matched');
  expect(next.checks.at(-1)!.lineId).toBe(4699);
  for (const c of next.checks) expect(equalHistoryRows(all[c.lineId - 1]!, tail[c.capturedRow]!)).toBe(true);
});

// DEBT items 1/2/6 through the real HistoryCalibrator: tmux keeps producing
// while capture runs, the parser trails the pipe by `lagMs` and is therefore
// AHEAD of the capture snapshot when read after it. Fake clock, true ids hidden.
async function debtFlow(o: { incremental: boolean; seconds: number; rate: number; lagMs: number; captureMs: number; text?: (i: number) => string; wrongScreen?: boolean; lateMs?: number }) {
  const text = o.text ?? ((i: number) => `row-${i}`);
  const rows = new Map<string, CapturedRow>();
  const rowOf = (t: string) => { let r = rows.get(t); if (!r) { r = naRow(t.padEnd(12)); rows.set(t, r); } return r; };
  const frame: CalibrationFrame = { cells: [naRow('scr ').cells], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 };
  const meta = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 1, cols: 4, rows: 1, kind: 'normal' as const, cursor: frame.cursor };
  const paneKey = { serverIdentity: 'private', paneId: '%9', birthGeneration: 1 };
  // A comparable parser screen that never matches keeps the calibrator in
  // CAPTURE mode: screen-only captures every 50ms between history captures.
  const parserFrame: CalibrationFrame = o.wrongScreen ? { ...frame, cells: [naRow('bad ').cells] } : frame;
  let now = 0, revision = 1, produced = 0, applied = 0, inFlight = false;
  const tmuxRing: number[] = [], parser: Array<{ id: number; lineId: number }> = [], producedAt: number[] = [];
  let pending: { at: number; resolve: (c: CalibrationCapture) => void; value: CalibrationCapture; snap: number[] } | undefined;
  const st = { checks: 0, checksWhileFlowing: 0, falseChecked: 0, identityFalse: 0, contentMatches: 0, contentFalse: 0, commits: 0, staleRevision: 0, limits: [] as number[], verified: new Set<number>(), contentVerified: new Set<number>() };
  const end = o.seconds * 1000;
  const ports: CalibrationPorts = {
    now: () => now, schedule: () => {},
    read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 1, parserFrame,
      recentHistory: parser.map(p => ({ ...rowOf(text(p.id)), lineId: p.lineId, sourceEpoch: 1, geometryGeneration: 1 })) }),
    capture: (_, tail) => {
      st.limits.push(tail); inFlight = true;
      const snap = tmuxRing.slice(Math.max(0, tmuxRing.length - tail));
      const value = { paneKey, captureId: String(st.limits.length), requestedAt: now, completedAt: now + o.captureMs, before: meta, after: meta, frame,
        history: snap.map(id => rowOf(text(id))), completeRetainedTail: tail >= tmuxRing.length, observedFields: [] } as CalibrationCapture;
      return new Promise(resolve => { pending = { at: now + o.captureMs, resolve, value, snap }; });
    },
    calibrate: async input => {
      if (input.expectedRevision !== revision) { st.staleRevision++; return null; }
      const snap = (st as any).snap as number[];
      const byLine = new Map(parser.map(p => [p.lineId, p.id]));
      for (const c of input.checks) {
        const id = byLine.get(c.lineId)!, tmuxId = snap[c.capturedRow]!;
        st.checks++; if (now < end) st.checksWhileFlowing++;
        if (!equalHistoryRows(rowOf(text(id)), rowOf(text(tmuxId)))) st.falseChecked++;
        if (id !== tmuxId) st.identityFalse++; else st.verified.add(id);
      }
      // FIX1-PLAN §2 content-matched rows: content is the only claim.
      for (const c of input.contentMatches) {
        const id = byLine.get(c.lineId)!, tmuxId = snap[c.capturedRow]!;
        st.contentMatches++;
        if (!equalHistoryRows(rowOf(text(id)), rowOf(text(tmuxId)))) st.contentFalse++; else st.contentVerified.add(id);
      }
      st.commits++; return { revision: ++revision, durableRevision: 0, nextLineId: parser.length };
    },
    publish: () => {}, fault: () => {},
  };
  const calibrator = new HistoryCalibrator(paneKey, ports, { incremental: o.incremental });
  const step = 1000 / o.rate;
  for (now = 0; now <= end + 2000; now++) {
    while (now < end && produced * step <= now) { producedAt.push(now); tmuxRing.push(produced++); if (tmuxRing.length > 4500) tmuxRing.shift(); }
    let n = 0;
    while (applied < produced && producedAt[applied]! + o.lagMs <= now) {
      parser.push({ id: applied, lineId: applied }); applied++; n++; revision++;
      if (parser.length > 4500) parser.shift();
    }
    if (n) calibrator.scroll(n);
    if (pending && now >= pending.at) { const p = pending; pending = undefined; (st as any).snap = p.snap; p.resolve(p.value); inFlight = false; await new Promise(r => setImmediate(r)); }
    if (!inFlight && now >= calibrator.dueAt + (o.lateMs ?? 0)) { void calibrator.runDue(); await new Promise(r => setImmediate(r)); }
  }
  // Coverage over every produced row except the final 128 still in overlap.
  const eligible = Math.max(0, produced - 128);
  // coverage = checked or content-matched (history shown complete, §2.3);
  // checkedCoverage = rows carrying an identity claim.
  let covered = 0, checkedCovered = 0;
  for (let id = 0; id < eligible; id++) {
    if (st.verified.has(id)) checkedCovered++;
    if (st.verified.has(id) || st.contentVerified.has(id)) covered++;
  }
  return { produced, coverage: eligible ? covered / eligible : 0, checkedCoverage: eligible ? checkedCovered / eligible : 0, checks: st.checks, checksWhileFlowing: st.checksWhileFlowing, falseChecked: st.falseChecked,
    identityFalse: st.identityFalse, contentMatches: st.contentMatches, contentFalse: st.contentFalse, commits: st.commits, staleRevision: st.staleRevision, fullCaptures: st.limits.filter(l => l === 4500).length, screenOnly: st.limits.filter(l => l === 0).length, captures: st.limits.length };
}

test('DEBT 1 calibrator checks while output flows at 100 rows/s with the parser ahead of the capture', async () => {
  for (const incremental of [false, true]) {
    for (const lagMs of [5, 300]) {
      const r = await debtFlow({ incremental, seconds: 60, rate: 100, lagMs, captureMs: 40 });
      console.log('NEWARCH_DEBT1_FLOW', JSON.stringify({ incremental, lagMs, ...r, scope: 'real HistoryCalibrator; fake clock/ports; parser trails tmux, read after capture' }));
      expect(r.produced).toBe(6000);
      // Round 2 measured 0 checks while flowing and 49.3% coverage here.
      expect(r.checksWhileFlowing).toBeGreaterThan(r.produced);
      expect(r.coverage).toBeGreaterThanOrEqual(0.99);
      expect(r.falseChecked).toBe(0);
      expect(r.identityFalse).toBe(0);
      expect(r.contentFalse).toBe(0);
      // Unique rows: every eligible row carries an identity claim.
      expect(r.checkedCoverage).toBeGreaterThanOrEqual(0.99);
      // agy round 1: the CAS revision is the post-capture one, so revision
      // bumps during capture never starve the commit.
      expect(r.staleRevision).toBe(0);
      expect(r.commits).toBe(r.captures);
      // PIPE mode: one history capture per 200ms, no screen-only capture in
      // between (output during a capture used to re-arm it 50ms later).
      expect(r.screenOnly).toBe(0);
      expect(r.captures).toBeGreaterThanOrEqual(290);
    }
  }
});

test('DEBT 3 host lateness below one period does not stretch the 200ms cadence', async () => {
  // The benchmark host starts captures ~20ms late (shared event loop). Each
  // late start used to become the next anchor: 230ms cycles, 260/min.
  const r = await debtFlow({ incremental: true, seconds: 60, rate: 100, lagMs: 5, captureMs: 40, lateMs: 30 });
  console.log('NEWARCH_DEBT3_LATE_HOST', JSON.stringify(r));
  expect(r.captures).toBeGreaterThanOrEqual(295);
  expect(r.screenOnly).toBe(0);
  expect(r.coverage).toBeGreaterThanOrEqual(0.99);
  expect(r.falseChecked).toBe(0);
});

test('DEBT 1 periodic output after the fence never pairs a row with an older copy', async () => {
  // Text repeats every 3000 rows, so a parser row newer than the capture has
  // an exact older copy in tmux; the fence plus tail bound must not use it.
  const r = await debtFlow({ incremental: false, seconds: 60, rate: 100, lagMs: 5, captureMs: 40, text: i => `file-line-${i % 3000}` });
  console.log('NEWARCH_DEBT1_PERIODIC', JSON.stringify(r));
  expect(r.identityFalse).toBe(0); expect(r.falseChecked).toBe(0); expect(r.contentFalse).toBe(0);
  // Repeated text is content-matched, not checked (FIX1-PLAN §2): shown
  // complete, without claiming which copy it is.
  expect(r.coverage).toBeGreaterThanOrEqual(0.99);
  expect(r.checkedCoverage).toBeLessThan(r.coverage);
  // FIX2 m5 floor: coverage alone stays 1 if the matcher stops checking.
  // Measured 4500/5872 = 0.76635 in both round-1 runs (fake clock, one
  // input, so deterministic): rows are checked until their text repeats
  // (row 3000 onwards has an older copy in the 4500-row ring). 0.75 leaves
  // ~95 rows of slack for scheduling changes, not for a matcher that stops.
  expect(r.checkedCoverage).toBeGreaterThanOrEqual(0.75);
});

test('DEBT 2 a screen-only capture does not erase the incremental seed', async () => {
  const r = await debtFlow({ incremental: true, seconds: 60, rate: 100, lagMs: 5, captureMs: 40, wrongScreen: true });
  console.log('NEWARCH_DEBT2_CAPTURE_MODE', JSON.stringify(r));
  // A diverged screen re-arms 50ms: screen-only captures between history ones.
  expect(r.screenOnly).toBeGreaterThan(300);
  // Seed survives them: only the birth capture (and the first no-history
  // capture after it) is full; round 2 alternated full/partial ~300 times.
  expect(r.fullCaptures).toBeLessThanOrEqual(3);
  expect(r.coverage).toBeGreaterThanOrEqual(0.99);
  // Direct: history (full) -> screen-only -> incremental history still matched.
  // A wrong parser screen re-arms the lane 50ms later, before the 200ms
  // history interval: that capture has no history.
  const all = naRows(Array.from({ length: 400 }, (_, i) => `line-${i}`));
  let recent = all.slice(0, 300), time = 0, revision = 1;
  const tails: number[] = [], checks: number[] = [];
  const frame: CalibrationFrame = { cells: [naRow('abc ').cells], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 };
  const meta = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 1, cols: 4, rows: 1, kind: 'normal' as const, cursor: frame.cursor };
  const paneKey = { serverIdentity: 'private', paneId: '%0', birthGeneration: 1 };
  let parserFrame: CalibrationFrame = { ...frame, cells: [naRow('bad ').cells] };
  const calibrator = new HistoryCalibrator(paneKey, {
    now: () => time, schedule: () => {},
    read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory: recent, parserFrame }),
    capture: async (_, tail) => {
      tails.push(tail);
      const history = recent.slice(Math.max(0, recent.length - tail));
      return { paneKey, captureId: String(tails.length), requestedAt: time, completedAt: time, before: meta, after: meta, frame, history, completeRetainedTail: tail >= recent.length, observedFields: [] };
    },
    calibrate: async input => { checks.push(input.checks.length); return { revision: ++revision, durableRevision: 0, nextLineId: 0 }; },
    publish: () => {}, fault: () => {},
  }, { incremental: true });
  await calibrator.runDue();
  expect(calibrator.dueAt).toBe(50);
  expect(calibrator.mode).toBe('PIPE');
  parserFrame = frame;
  time = 50; await calibrator.runDue();
  expect(tails).toEqual([4500, 0]);
  expect(calibrator.mode).toBe('PIPE');
  recent = all.slice(0, 320); calibrator.scroll(20);
  time = 250; await calibrator.runDue();
  // Round 2: the empty screen-only match erased the seed -> partial-tail, 0 checks, then full.
  // 148 captured rows: the oldest and newest have no anchor on one side.
  expect(tails).toEqual([4500, 0, 148]);
  expect(checks.at(-1)).toBe(146);
});

test('DEBT 3 a failed capture keeps the incremental seed instead of forcing a full capture', async () => {
  // Under ptrace a 21-pane batch passed the 1s capture deadline; each fault
  // forced a 4500-row capture, which timed out again (cage: 230 faults, 7
  // history captures per pane per minute). The seed stays exact after a fault.
  const all = naRows(Array.from({ length: 400 }, (_, i) => `line-${i}`));
  let recent = all.slice(0, 300), time = 0, revision = 1, fail = false;
  const tails: number[] = [], checks: number[] = [], faults: string[] = [];
  const frame: CalibrationFrame = { cells: [naRow('abc ').cells], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 };
  const meta = { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 1, cols: 4, rows: 1, kind: 'normal' as const, cursor: frame.cursor };
  const paneKey = { serverIdentity: 'private', paneId: '%0', birthGeneration: 1 };
  const calibrator = new HistoryCalibrator(paneKey, {
    now: () => time, schedule: () => {},
    read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory: recent, parserFrame: frame }),
    capture: async (_, tail) => {
      tails.push(tail);
      if (fail) { fail = false; throw new Error('capture deadline exceeded'); }
      return { paneKey, captureId: String(tails.length), requestedAt: time, completedAt: time, before: meta, after: meta, frame, history: recent.slice(Math.max(0, recent.length - tail)), completeRetainedTail: tail >= recent.length, observedFields: [] };
    },
    calibrate: async input => { checks.push(input.checks.length); return { revision: ++revision, durableRevision: 0, nextLineId: 0 }; },
    publish: () => {}, fault: f => { faults.push(f.kind); },
  }, { incremental: true });
  await calibrator.runDue();
  recent = all.slice(0, 320); calibrator.scroll(20);
  fail = true; time = 200; await calibrator.runDue();
  expect(faults).toEqual(['capture-fault']);
  expect(calibrator.dueAt).toBe(250);
  time = 250; await calibrator.runDue();
  expect(tails).toEqual([4500, 148, 148]);
  expect(checks.at(-1)).toBe(146);
});

test('DEBT 4/6 far anchor is refused and no-anchor forces the next capture full', async () => {
  // A plain copy 700 rows back is the only exact match of the parser tail
  // (the parser lost the colour of the re-print). The bound refuses it.
  const plain = (k: number) => naRow(`result ${k}`);
  const red = (k: number) => { const r = naRow(`result ${k}`); return { ...r, cells: r.cells.map(c => ({ ...c, fg: 'index:1' })) }; };
  const pre = [...Array.from({ length: 300 }, (_, k) => naRow(`pre-${k}`)), ...Array.from({ length: 200 }, (_, k) => plain(k))];
  const post = [...Array.from({ length: 500 }, (_, k) => naRow(`post-${k}`)), ...Array.from({ length: 200 }, (_, k) => red(k))];
  const parser = [...post.slice(0, 500), ...Array.from({ length: 200 }, (_, k) => plain(k))].map((r, i) => ({ ...r, lineId: i, sourceEpoch: 1, geometryGeneration: 1 }));
  expect(matchHistoryRows(parser, [...pre, ...post], naScope).checks).toHaveLength(198); // unbounded: wrong 198 (200 minus the unanchored ends)
  const bounded = matchHistoryRows(parser, [...pre, ...post], { ...naScope, maxTailGap: 256 });
  expect(bounded.reason).toBe('no-anchor'); expect(bounded.checks).toHaveLength(0);
  // The correct print is still accepted with the same bound.
  expect(matchHistoryRows(post.map((r, i) => ({ ...r, lineId: i, sourceEpoch: 1, geometryGeneration: 1 })), [...pre, ...post], { ...naScope, maxTailGap: 256 }).checks).toHaveLength(698);
  // Item 6: an incremental calibrator whose full capture finds no anchor
  // requests a full capture next time instead of an unseeded partial one.
  const h = naHarness(true);
  h.ports.read = () => ({ revision: 1, sourceEpoch: 1, geometryGeneration: 1, recentHistory: naRows(['x', 'y', 'z']), parserFrame: h.frame });
  h.ports.calibrate = async () => ({ revision: 2, durableRevision: 0, nextLineId: 4 });
  await h.calibrator.runDue();
  h.time(10); h.calibrator.scroll(5); h.time(250); await h.calibrator.runDue();
  expect(h.limits).toEqual([4500, 4500]);
});

// DEBT2: independent reproduction from the round-3 grok review.
import { decodeTmuxCaptureRows, TmuxCaptureDecoder } from "../src/tmux-capture-normalize";
import type { CaptureMetadata } from "../src/history-calibrator";
const privateEnv = { ...process.env };
delete privateEnv.TMUX;
delete privateEnv.TMUX_PANE;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const tmux = (socket: string, args: string[]) => {
  const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: privateEnv });
  if (result.status !== 0) throw new Error(`tmux ${args[0]} exit=${result.status}: ${result.stderr}`);
  return result.stdout;
};

type Disrupt =
  | 'none'
  | 'resize-before'
  | 'resize-between'
  | 'resize-event'
  | 'clear-before'
  | 'clear-between'
  | 'alt-before'
  | 'alt-sandwich'
  | 'pipe-before'
  | 'pipe-between'
  | 'clear-reprint-before'
  | 'clear-event'
  | 'flow-during'
  | 'evict-during'
  | 'reflow-before';

const producerPy = [
  'import sys, os, time',
  'cmd, ack, dump = sys.argv[1:]',
  'def note(s):',
  '    open(ack, "w").write(s); sys.stdout.flush()',
  'end = time.monotonic() + 40',
  'while time.monotonic() < end:',
  '    if os.path.exists(cmd):',
  '        c = open(cmd).read().strip(); os.remove(cmd)',
  '        if c == "alt":',
  '            sys.stdout.write("\\033[?1049h"); note("alt")',
  '        elif c == "alt-off":',
  '            sys.stdout.write("\\033[?1049l"); note("alt-off")',
  '        elif c == "dump":',
  '            sys.stdout.write(open(dump).read()); note("dump")',
  '        elif c == "quit":',
  '            note("quit"); break',
  '        else:',
  '            note("bad:"+c)',
  '    else:',
  '        time.sleep(0.01)',
].join('\n');

function cellsOf(text: string, cols: number): HistoryRow['cells'] {
  return decodeTmuxCaptureRows(text, cols)[0]!;
}

async function runScenario(name: string, disrupt: Disrupt, opts: { cols: number; rows: number; historyLimit: number; seed: string[]; reprint?: string[]; resizeTo?: [number, number]; freezeWidth?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'l2cr3g-'));
  const socket = join(root, 'tmux.sock');
  const pipe = join(root, 'pane.pipe');
  const cmd = join(root, 'cmd');
  const ack = join(root, 'ack');
  const dump = join(root, 'dump');
  writeFileSync(pipe, '');
  writeFileSync(join(root, 'tmux.conf'), `set -g history-limit ${opts.historyLimit}\nset -g status off\n`);
  writeFileSync(join(root, 'producer.py'), producerPy);
  writeFileSync(dump, '');
  const signal = (c: string) => {
    writeFileSync(cmd, c);
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (existsSync(ack) && readFileSync(ack, 'utf8').trim() === c) return;
      spawnSync('sleep', ['0.01']);
    }
    throw new Error(`producer did not ack ${c}`);
  };
  let paneId = '';
  let fd = -1;
  const stats = {
    name, disrupt, contentFalse: 0, checks: 0, repairs: 0, reason: '', commits: 0, unstable: 0,
    fenceRows: 0, fenceMissing: 0, historyRows: 0, samples: [] as unknown[],
    certifiedCleared: 0, clearedLineIds: 0, faults: [] as string[],
    altEngaged: undefined as boolean | undefined, altReleased: undefined as boolean | undefined,
  };
  const clearedIds = new Set<number>();
  try {
    const py = join(root, 'producer.py');
    paneId = tmux(socket, ['-f', join(root, 'tmux.conf'), 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'p0', '-x', String(opts.cols), '-y', String(opts.rows), `exec python3 -u ${quote(py)} ${quote(cmd)} ${quote(ack)} ${quote(dump)}`]).trim();
    tmux(socket, ['set-option', '-p', '-t', paneId, '@l2c-history-epoch', '1']);
    tmux(socket, ['pipe-pane', '-t', paneId, `exec cat >> ${quote(pipe)}`]);
    const seed = opts.seed.join('\n') + '\n';
    writeFileSync(dump, seed);
    signal('dump');
    spawnSync('sleep', ['0.15']);
    fd = openSync(pipe, 'r');
    const lines: string[] = [];
    let offset = 0, partial = '';
    const buffer = Buffer.alloc(1 << 20);
    const poll = () => {
      let text = '';
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, offset);
        if (n <= 0) break;
        offset += n; text += buffer.toString('latin1', 0, n);
        if (n < buffer.length) break;
      }
      if (!text) return;
      text = partial + text;
      const cut = text.lastIndexOf('\n');
      partial = text.slice(cut + 1);
      for (const raw of text.slice(0, cut + 1).split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.length) lines.push(line);
      }
    };
    poll();
    const pane = { cols: opts.cols, rows: opts.rows, revision: 1 };
    let fenceIds: number[] = [];
    let sawClear = false;
    const modelCols = () => opts.freezeWidth ? opts.cols : pane.cols;
    const modelRow = (id: number): HistoryRow => ({
      lineId: id, sourceEpoch: 1, geometryGeneration: 1, softWrap: false,
      cells: cellsOf(lines[id]!, modelCols()),
    });
    // Same screen exclusion as the benchmark host: last history id is count-rows.
    const recentOf = (): HistoryRow[] => {
      const end = lines.length - pane.rows + 1;
      const start = Math.max(0, end - opts.historyLimit);
      const out: HistoryRow[] = [];
      for (let id = start; id < end; id++) out.push(modelRow(id));
      return out;
    };
    const label = (text: string) => text.replace(/\s+$/, '').slice(0, 40);
    let disrupted = false;

    let calibrator!: HistoryCalibrator;
    const resize = () => {
      const [x, y] = opts.resizeTo ?? [40, 12];
      tmux(socket, ['resize-window', '-t', 'p0', '-x', String(x), '-y', String(y)]);
      pane.cols = x; pane.rows = y;
    };
    const altOn = () => tmux(socket, ['display-message', '-p', '-t', paneId, '#{alternate_on}']).trim() === '1';
    const waitAlt = (want: boolean) => {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        if (altOn() === want) return true;
        spawnSync('sleep', ['0.02']);
      }
      return false;
    };
    const doDisrupt = (where: 'before' | 'between') => {
      const want = !disrupted && (disrupt.endsWith(where) || (disrupt === 'resize-event' && where === 'before') || (disrupt === 'clear-reprint-before' && where === 'before') || (disrupt === 'alt-sandwich' && where === 'between') || (disrupt === 'flow-during' && where === 'before') || (disrupt === 'evict-during' && where === 'before') || (disrupt === 'reflow-before' && where === 'before') || (disrupt === 'clear-event' && where === 'before'));
      if (!want) return;
      disrupted = true;
      if (disrupt.startsWith('resize') || disrupt === 'reflow-before') resize();
      if (disrupt === 'resize-event') calibrator.event('resize');
      if (disrupt.startsWith('clear') || disrupt === 'clear-event') {
        const end = lines.length - pane.rows + 1;
        for (let id = 0; id < end; id++) clearedIds.add(id);
        sawClear = true;
        // The private history owner rotates its epoch in the same command queue.
        // tmux 3.4 has no after-clear-history hook: production must mediate
        // resets or leave the authoritative epoch unavailable (fail closed).
        tmux(socket, ['set-option', '-p', '-t', paneId, '@l2c-history-epoch', '2', ';', 'clear-history', '-t', paneId]);
      }
      if (disrupt === 'clear-event') calibrator.event('clear');
      if ((disrupt === 'clear-reprint-before' || disrupt === 'clear-event' || disrupt === 'flow-during' || disrupt === 'evict-during') && opts.reprint) {
        writeFileSync(dump, opts.reprint.join('\n') + '\n');
        signal('dump');
        spawnSync('sleep', ['0.15']);
        poll();
      }
      if (disrupt === 'alt-before' || disrupt === 'alt-sandwich') {
        signal('alt');
        stats.altEngaged = waitAlt(true);
      }
      if (disrupt.startsWith('pipe')) tmux(socket, ['pipe-pane', '-t', paneId]);
    };
    const metaOf = (fields: string): CaptureMetadata => {
      const [w, h, x, y, alt, historyEpoch] = fields.split(' ').map(Number);
      return { historyEpoch: historyEpoch!, sourceEpoch: 1, geometryGeneration: 1, cols: w!, rows: h!, kind: alt ? 'alternate' : 'normal', cursor: { x: x!, y: y!, visible: true } };
    };
    const ports: CalibrationPorts = {
      now: () => performance.now(),
      schedule: () => {},
      read: () => {
        poll();
        const recentHistory = recentOf();
        fenceIds = recentHistory.map(r => r.lineId);
        return {
          revision: pane.revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory,
          parserFrame: { cells: [], cursor: { x: 0, y: pane.rows - 1, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: -1 },
        };
      },
      capture: () => {
        doDisrupt('before');
        const format = '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{@l2c-history-epoch}';
        const beforeText = tmux(socket, ['display-message', '-p', '-t', paneId, format]).trim();
        doDisrupt('between');
        const body = tmux(socket, ['capture-pane', '-p', '-e', '-N', '-t', paneId, '-S', '-4500']);
        if (disrupt === 'alt-sandwich') { signal('alt-off'); stats.altReleased = waitAlt(false); }
        const afterText = tmux(socket, ['display-message', '-p', '-t', paneId, format]).trim();
        const before = metaOf(beforeText), after = metaOf(afterText);
        const decoded = decodeTmuxCaptureRows(body, after.cols);
        const screen = decoded.slice(Math.max(0, decoded.length - after.rows));
        const history = decoded.slice(0, decoded.length - screen.length).map(cells => ({ cells, softWrap: false as const }));
        const rawLines = body.split('\n');
        if (rawLines.at(-1) === '') rawLines.pop();
        const histText = rawLines.slice(0, Math.max(0, rawLines.length - after.rows));
        const frame: CalibrationFrame = { cells: screen, cursor: after.cursor, kind: after.kind, geometryGeneration: 1, receiveSeq: -1 };
        const capture: CalibrationCapture = {
          paneKey: { serverIdentity: socket, paneId, birthGeneration: 1 }, captureId: name, requestedAt: performance.now(), completedAt: performance.now(),
          before, after, frame, history, completeRetainedTail: history.length < 4500, observedFields: ['cells'],
        };
        const recent = recentOf();
        const capLabels = new Set(histText.map(label));
        stats.fenceRows = fenceIds.length;
        stats.historyRows = history.length;
        stats.fenceMissing = fenceIds.filter(id => lines[id] && !capLabels.has(label(lines[id]!))).length;
        (capture as CalibrationCapture & { histText: string[] }).histText = histText;
        stats.clearedLineIds = clearedIds.size;
        (stats as { histTail?: string[] }).histTail = histText.slice(-6);
        void recent;
        return Promise.resolve(capture);
      },
      calibrate: async input => {
        const cap = input.capture as CalibrationCapture & { histText?: string[] };
        let contentFalse = 0, certifiedCleared = 0;
        for (const check of input.checks) {
          const captured = input.capture.history[check.capturedRow];
          const model = lines[check.lineId] ? { softWrap: false, cells: cellsOf(lines[check.lineId]!, modelCols()) } : undefined;
          const same = !!captured && !!model && equalHistoryRows(model, captured);
          if (!same) contentFalse++;
          if (clearedIds.has(check.lineId)) certifiedCleared++;
          if (stats.samples.length < 4 && (!same || clearedIds.has(check.lineId))) {
            stats.samples.push({
              lineId: check.lineId, capturedRow: check.capturedRow, same,
              model: lines[check.lineId]?.slice(0, 40),
              captured: cap.histText?.[check.capturedRow]?.slice(0, 40),
              cleared: clearedIds.has(check.lineId),
            });
          }
        }
        stats.contentFalse += contentFalse;
        stats.certifiedCleared += certifiedCleared;
        stats.checks += input.checks.length;
        stats.repairs += input.repairs.length;
        stats.commits++;
        pane.revision++;
        return { revision: pane.revision, durableRevision: 0, nextLineId: lines.length };
      },
      publish: () => {},
      fault: issue => { stats.faults.push(issue.kind); },
    };
    calibrator = new HistoryCalibrator({ serverIdentity: socket, paneId, birthGeneration: 1 }, ports, { incremental: true, historyLimit: 4500 });
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline && performance.now() + 1 < calibrator.dueAt) spawnSync('sleep', ['0.02']);
    await calibrator.runDue();
    if (stats.commits < 1) stats.unstable++;
    if (disrupt === 'clear-reprint-before' && stats.commits) {
      (stats as any).first = { checks: stats.checks, contentFalse: stats.contentFalse, certifiedCleared: stats.certifiedCleared, fenceRows: stats.fenceRows, fenceMissing: stats.fenceMissing, historyRows: stats.historyRows, commits: stats.commits };
      const mark = { checks: stats.checks, contentFalse: stats.contentFalse, commits: stats.commits, certifiedCleared: stats.certifiedCleared };
      const follow = Array.from({ length: 36 }, (_, i) => `after-${String(i).padStart(4, '0')}-NOT-THE-OLD-ROW`);
      writeFileSync(dump, follow.join('\n') + '\n');
      signal('dump');
      spawnSync('sleep', ['0.15']);
      poll();
      calibrator.scroll(follow.length);
      const until = performance.now() + 3000;
      while (performance.now() < until && performance.now() + 1 < calibrator.dueAt) spawnSync('sleep', ['0.02']);
      await calibrator.runDue();
      (stats as any).followup = {
        commits: stats.commits - mark.commits,
        checks: stats.checks - mark.checks,
        contentFalse: stats.contentFalse - mark.contentFalse,
        certifiedCleared: stats.certifiedCleared - mark.certifiedCleared,
      };
    }
    // reason is not returned; recover it by looking at whether checks happened
    stats.reason = stats.commits ? (stats.checks ? 'committed-with-checks' : 'committed-no-checks') : (stats.faults.length ? 'fault' : 'no-commit');
    void sawClear;
    return stats;
  } finally {
    try { if (fd >= 0) closeSync(fd); } catch {}
    spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8', env: privateEnv });
    rmSync(root, { recursive: true, force: true });
  }
}


test('DEBT2 clear-history then reprint the same tail must certify no deleted identities', async () => {
  const sig = Array.from({ length: 8 }, (_, i) => `sig-${i}-UNIQUE-TAIL`);
  const screen = Array.from({ length: 24 }, (_, i) => `screen-A-${i}`);
  const result = await runScenario('clear-reprint', 'clear-reprint-before', {
    cols: 80, rows: 24, historyLimit: 2000,
    seed: [...Array.from({ length: 40 }, (_, i) => `fill-${i}`), ...sig, ...screen],
    reprint: [...sig, ...screen],
  });
  console.log('DEBT2_REAL_CLEAR', JSON.stringify(result));
  expect(result.faults).toEqual([]);
  expect(result.clearedLineIds).toBe(49);
  expect(result.certifiedCleared).toBe(0);
  expect(result.commits).toBe(0);
}, 15000);

test('DEBT2 missing, changed and invalid history epochs fail closed; valid epoch recovers', async () => {
  for (const epoch of [undefined, NaN, Infinity, -1, 1.5, 2]) {
    const h = naHarness(true);
    const capture = h.ports.capture;
    h.ports.capture = async (...args) => {
      const c = await capture(...args);
      return { ...c, before: { ...c.before, historyEpoch: epoch as number }, after: { ...c.after, historyEpoch: epoch as number } };
    };
    await h.calibrator.runDue();
    expect(h.writes).toHaveLength(0);
    h.ports.capture = capture;
    h.time(1000); await h.calibrator.runDue();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.checks).toHaveLength(3);
    expect(h.limits).toEqual([4500, 4500]);
  }
  const h = naHarness(true);
  const capture = h.ports.capture;
  h.ports.capture = async (...args) => {
    const c = await capture(...args);
    return { ...c, after: { ...c.after, historyEpoch: 2 } };
  };
  await h.calibrator.runDue();
  expect(h.writes).toHaveLength(0);
});

test('DEBT2 source reset across the fence discards capture then resumes in the new epoch', async () => {
  const h = naHarness(true);
  const read = h.ports.read, capture = h.ports.capture;
  let epoch = 1;
  h.ports.read = () => {
    const snapshot = read();
    return { ...snapshot, sourceEpoch: epoch,
      recentHistory: snapshot.recentHistory.map(row => ({ ...row, sourceEpoch: epoch })) };
  };
  h.ports.capture = async (...args) => {
    const c = await capture(...args);
    epoch = 2;
    const meta = { ...c.after, sourceEpoch: epoch, historyEpoch: epoch };
    return { ...c, before: meta, after: meta };
  };
  await h.calibrator.runDue();
  expect(h.writes).toHaveLength(0);
  h.time(1000); await h.calibrator.runDue();
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]!.checks).toHaveLength(3);
  expect(h.limits).toEqual([4500, 4500]);
});


test('I3 PROBE compensated insert/delete exposes hidden identity uncertainty in 3000 cases', () => {
  let falseIdentity = 0;
  for (let n = 0; n < 3000; n++) {
    const text = ['A1', 'A2', 'A3', 'P', 'Q', 'Q', 'B1', 'B2', 'B3'].map(s => `${n}:${s}`);
    const hidden = [0, 1, 2, 4, 5, 99, 6, 7, 8];
    const captured = hidden.map(id => naRow(id === 99 ? `${n}:R` : text[id]!));
    const result = matchHistoryRows(naRows(text), captured, naScope);
    falseIdentity += result.checks.filter(c => c.lineId - 1 !== hidden[c.capturedRow]).length;
    falseIdentity += result.repairs.filter(c => c.lineId - 1 !== hidden[c.capturedRow]).length;
  }
  console.log('I3_PROBE_IDENTITY', JSON.stringify({ cases: 3000, falseIdentity, verdict: 'content anchors do not prove row identity' }));
  expect(falseIdentity).toBe(0);
});

test('I3 PROBE private tmux identical snapshots hide split ESC and UTF8 parser state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'i3-fence-'));
  const socket = join(root, 'x.sock');
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env });
    expect(result.status).toBe(0); return result.stdout;
  };
  const script = join(root, 'producer.py');
  writeFileSync(script, `import os,time,pathlib
r=pathlib.Path(${JSON.stringify(root)})
def phase(n,b):
 while not (r/str(n)).exists(): time.sleep(.005)
 os.write(1,b)
 (r/(str(n)+'done')).touch()
phase(1,b'X')
phase(2,bytes([27,91]))
phase(3,b'31m')
phase(4,bytes([0xe4,0xbd]))
phase(5,bytes([0xa0]))
time.sleep(30)
`);
  try {
    const pane = tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '80', '-y', '24', `python3 '${script}'`).trim();
    const captures: string[] = [];
    for (let phase = 1; phase <= 5; phase++) {
      writeFileSync(join(root, String(phase)), '');
      await eventually(() => existsSync(join(root, `${phase}done`)), 'producer phase');
      await new Promise(resolve => setTimeout(resolve, 30));
      captures.push(tmux('capture-pane', '-p', '-e', '-t', pane));
    }
    expect(captures[1]).toBe(captures[0]);
    expect(captures[2]).toBe(captures[0]);
    expect(captures[3]).toBe(captures[0]);
    expect(captures[4]).toContain('你');
    console.log('I3_PROBE_FENCE', JSON.stringify({ phases: 5, indistinguishableStates: 4, byteFence: false, socket: 'private' }));
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env });
    rmSync(root, { recursive: true, force: true });
  }
});

test('I3 injected timeout cancels at exactly 1s and late capture never commits', async () => {
  const h = naHarness();
  let deadline = Infinity, fire: (() => void) | undefined, cancelled = 0, aborted = false;
  let complete!: (capture: CalibrationCapture) => void;
  const original = await h.ports.capture(h.calibrator.paneKey, 4500);
  h.ports.timeout = (callback, delay) => {
    deadline = delay; fire = callback;
    return () => { cancelled++; fire = undefined; };
  };
  h.ports.capture = (_, __, signal) => new Promise(resolve => {
    complete = resolve;
    signal!.addEventListener('abort', () => { aborted = true; });
  });
  const running = h.calibrator.runDue();
  expect(deadline).toBe(1000);
  h.time(999); expect(aborted).toBe(false); expect(h.writes).toHaveLength(0);
  h.time(1000); fire!(); await running;
  expect(aborted).toBe(true); expect(cancelled).toBe(1);
  complete(original); await Promise.resolve();
  expect(h.writes).toHaveLength(0); expect(h.published).toHaveLength(0);
  expect(h.faults).toEqual(['capture-fault']);
  h.ports.capture = async () => original;
  h.time(1050); await h.calibrator.runDue();
  expect(cancelled).toBe(2); expect(fire).toBeUndefined();
  expect(h.writes).toHaveLength(1);
});

test('I3 resize resets image comparison without suppressing dead-reader or heartbeat faults', () => {
  let now = 0; const faults: string[] = [];
  const wd = new HistoryWatchdog(() => now, issue => faults.push(issue.kind));
  const before = { sourceEpoch: 1, geometryGeneration: 1, kind: 'normal' as const };
  const after = { ...before, geometryGeneration: 2 };
  wd.capture('old', before);
  now = 100; wd.capture('reflow', after);
  now = 1100; wd.tick(); expect(faults).toEqual([]);
  wd.capture('new output with reader dead', after);
  now = 2100; wd.tick(); expect(faults).toEqual(['reader-stalled']);
  wd.dead('reader-dead'); expect(faults).toContain('reader-dead');
  now = 3100; wd.capture('another reflow', { ...after, geometryGeneration: 3 }); wd.tick();
  expect(faults).toContain('heartbeat-timeout');
  wd.receive(1); wd.heartbeat();
  wd.capture('post-recovery', { ...after, geometryGeneration: 3 });
  now = 3200; wd.capture('stalled again', { ...after, geometryGeneration: 3 });
  now = 4200; wd.tick();
  expect(faults.filter(kind => kind === 'reader-stalled')).toHaveLength(2);
});

test('I3 20k and 200k backlog cannot certify an evicted pre-capture fence', () => {
  for (const burst of [20000, 200000]) {
    const retained = naRows(Array.from({ length: 4500 }, (_, i) => `new-${burst - 4500 + i}`));
    const old = naRows(['old-a', 'old-b', 'old-c']);
    const result = matchHistoryRows(old, retained, { ...naScope, maxTailGap: 0 });
    expect(result.checks).toHaveLength(0); expect(result.repairs).toHaveLength(0);
    expect(old.map(row => row.lineId)).toEqual([1, 2, 3]);
    console.log('I3_BACKLOG', JSON.stringify({ burst, retained: retained.length, checked: result.checks.length, reason: result.reason, scope: 'matcher fixture, not pipe-loss proof' }));
  }
});

test('I3 real reflow 80 to 37 and 37 to 120 does not certify across geometry', async () => {
  for (const [cols, next] of [[80, 37], [37, 120]] as const) {
    const result = await runScenario(`I3-reflow-${cols}-${next}`, 'reflow-before', {
      cols, rows: 24, historyLimit: 4500,
      seed: Array.from({ length: 100 }, (_, i) => `row-${i}-` + 'long-line-'.repeat(20)),
      resizeTo: [next, 24],
    });
    console.log('I3_REFLOW', JSON.stringify(result));
    expect(result.contentFalse).toBe(0);
    expect(result.repairs).toBe(0);
    expect(result.checks).toBe(0);
  }
}, 15000);

test('I3 mutation controls: timeout abort and resize comparison guards fail independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'i3-mutation-'));
  const cases = [
    {
      name: 'timeout-abort', file: 'history-calibrator.ts', from: 'controller.abort();', to: '',
      body: `const {HistoryCalibrator}=await import('./subject.ts');
let fire, signal;
const c=new HistoryCalibrator({serverIdentity:'fixture',paneId:'%0',birthGeneration:1}, {
 now:()=>0,schedule:()=>{},read:()=>({}),
 timeout:(f)=>{fire=f;return ()=>{}},
 capture:(_,__,s)=>{signal=s;return new Promise(()=>{})},fault:()=>{},
 calibrate:()=>{throw Error('unexpected commit')},publish:()=>{throw Error('unexpected publish')}
});
const running=c.runDue();fire();await running;
assert.equal(signal.aborted,true,'MUTATION timeout abort');`,
    },
    {
      name: 'resize-comparison', file: 'history-watchdog.ts', from: 'this.image = undefined;', to: '',
      body: `const {HistoryWatchdog}=await import('./subject.ts');
let now=0;const faults=[];const wd=new HistoryWatchdog(()=>now,f=>faults.push(f.kind));
wd.capture('old',{sourceEpoch:1,geometryGeneration:1,kind:'normal'});
now=100;wd.capture('reflow',{sourceEpoch:1,geometryGeneration:2,kind:'normal'});
now=1100;wd.tick();assert.deepEqual(faults,[],'MUTATION resize comparison');`,
    },
  ];
  try {
    writeFileSync(join(root, 'history-row-matcher.ts'), readFileSync(new URL('../src/history-row-matcher.ts', import.meta.url)));
    for (const item of cases) {
      const original = readFileSync(new URL(`../src/${item.file}`, import.meta.url), 'utf8');
      expect(original.split(item.from)).toHaveLength(2);
      writeFileSync(join(root, 'runner.ts'), `import assert from 'node:assert/strict';\n${item.body}`);
      for (const mutated of [false, true]) {
        writeFileSync(join(root, 'subject.ts'), mutated ? original.replace(item.from, item.to) : original);
        const result = spawnSync(process.execPath, [join(root, 'runner.ts')], { encoding: 'utf8', timeout: 10000 });
        console.log('I3_MUTATION', JSON.stringify({ name: item.name, mutated, exit: result.status, stderr: result.stderr }));
        expect(result.status).toBe(mutated ? 1 : 0);
        if (mutated) expect(result.stderr).toContain('MUTATION');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('FIX1 I3 last-screen contract (FIX1-PLAN §1) and row identity (§2)', () => {
  test('A-M4 / C-F19 a capture frame receiveSeq is never a fence: a quiescent capture is committed with evidence, then published', async () => {
    const h = naHarness();
    // tmux capture-pane has no byte position; any value here must be ignored.
    const capture = h.ports.capture;
    h.ports.capture = async (...args) => ({ ...(await capture(...args)), frame: { ...h.frame, receiveSeq: 987654 } });
    let publishedFrame: CalibrationFrame | undefined;
    h.ports.publish = (commit, frame) => { h.published.push(commit.revision); publishedFrame = frame; };
    await h.calibrator.runDue();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.captureEvidence).toEqual({ kind: 'quiescent', sourceEpoch: 1, geometryGeneration: 1, receiveSeqBefore: 0, receiveSeqAfter: 0, uncertainRows: [] });
    expect(h.published).toEqual([2]);
    expect(equalCalibrationFrames(publishedFrame!, h.frame)).toBe(true);
  });
  test('C-F19 bytes received during the capture: history is committed without screen evidence and nothing is published', async () => {
    const h = naHarness();
    const capture = h.ports.capture;
    h.ports.capture = async (...args) => {
      const result = await capture(...args);
      h.parser({ ...structuredClone(h.frame), receiveSeq: 7 }); // a pipe byte arrived meanwhile
      return result;
    };
    let pipe = 0;
    h.calibrator.output(() => pipe++);
    await h.calibrator.runDue();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.captureEvidence).toEqual({ kind: 'unfenced', reason: 'received-during-capture' });
    expect(h.writes[0]!.checks.map(c => c.lineId)).toEqual([2, 3, 4]);
    expect(h.published).toEqual([]);
    // The queued pipe frame is not cancelled: the pipe owns the screen.
    h.time(16); await h.calibrator.runDue();
    expect(pipe).toBe(1);
  });
  test('C-F19 a byte after the commit supersedes the committed capture: no stale publish', async () => {
    const h = naHarness();
    const calibrate = h.ports.calibrate;
    h.ports.calibrate = async input => {
      const commit = await calibrate(input);
      h.parser({ ...structuredClone(h.frame), receiveSeq: 1 });
      return commit;
    };
    await h.calibrator.runDue();
    expect(h.writes[0]!.captureEvidence.kind).toBe('quiescent');
    expect(h.published).toEqual([]);
    expect(h.calibrator.acceptsPipeFrame).toBe(true);
  });
  test('C-F19 a CAS conflict publishes nothing even with quiescent evidence', async () => {
    const h = naHarness(); h.conflict();
    await h.calibrator.runDue();
    expect(h.writes[0]!.captureEvidence.kind).toBe('quiescent');
    expect(h.published).toEqual([]);
  });
  test('FIX2 B1 the evidence is the store port field for field: an I2-rule store draws the quiescent capture and never throws on an unfenced one', async () => {
    // Store rule copied from lot I2 `sqlite-history/ram-store.ts` calibrate()
    // at FIX2 4ea4fb585: `evidence?.kind==='quiescent'`, integer seqs, epoch and
    // geometry equal to the capture, before === after, else 'capture-not-quiescent';
    // uncertainRows deduped, sorted, each an integer row of the screen.
    // Round 1 sent kind 'quiescent-capture' with one `receiveSeq`: this store
    // skipped it silently and never drew the tmux screen.
    const i2Store = (drawn: string[], commit: CalibrationPorts['calibrate']): CalibrationPorts['calibrate'] => async input => {
      const evidence = input.captureEvidence, c = input.capture.after;
      if (evidence?.kind === 'quiescent') {
        if (!Number.isSafeInteger(evidence.receiveSeqBefore) || !Number.isSafeInteger(evidence.receiveSeqAfter)) throw new Error('invalid-integer');
        if (evidence.sourceEpoch !== c.sourceEpoch || evidence.geometryGeneration !== c.geometryGeneration
          || evidence.receiveSeqBefore !== evidence.receiveSeqAfter) throw new Error('capture-not-quiescent');
        const uncertain = [...new Set(evidence.uncertainRows ?? [])].sort((a, b) => a - b);
        if (uncertain.some(r => !Number.isSafeInteger(r) || r < 0 || r >= c.rows)) throw new Error('invalid-uncertain-rows');
        drawn.push(`${input.capture.captureId} uncertain=${uncertain.join(',')}`);
      }
      return commit(input);
    };
    const quiet = naHarness(), drawn: string[] = [];
    quiet.ports.calibrate = i2Store(drawn, quiet.ports.calibrate);
    await quiet.calibrator.runDue();
    expect(Object.keys(quiet.writes[0]!.captureEvidence).sort()).toEqual(['geometryGeneration', 'kind', 'receiveSeqAfter', 'receiveSeqBefore', 'sourceEpoch', 'uncertainRows']);
    expect(drawn).toEqual(['capture-1 uncertain=']);
    expect(quiet.published).toEqual([2]);
    expect(quiet.faults).toEqual([]);
    // Bytes during the capture: history still commits (checks reach the
    // store), the screen is not drawn, and the store has nothing to reject.
    const busy = naHarness(), busyDrawn: string[] = [];
    const capture = busy.ports.capture;
    busy.ports.capture = async (...args) => { const r = await capture(...args); busy.parser({ ...structuredClone(busy.frame), receiveSeq: 3 }); return r; };
    busy.ports.calibrate = i2Store(busyDrawn, busy.ports.calibrate);
    await busy.calibrator.runDue();
    expect(busy.writes[0]!.captureEvidence).toEqual({ kind: 'unfenced', reason: 'received-during-capture' });
    expect(busy.writes[0]!.checks.map(c => c.lineId)).toEqual([2, 3, 4]);
    expect(busyDrawn).toEqual([]);
    expect(busy.faults).toEqual([]);
    expect(busy.published).toEqual([]);
    // Emoji rows the decoder could not settle reach the store with the screen.
    const emoji = naHarness(), emojiDrawn: string[] = [];
    const plain = emoji.ports.capture;
    emoji.ports.capture = async (...args) => ({ ...(await plain(...args)), uncertainScreenRows: [0] });
    emoji.ports.calibrate = i2Store(emojiDrawn, emoji.ports.calibrate);
    await emoji.calibrator.runDue();
    expect(emojiDrawn).toEqual(['capture-1 uncertain=0']);
    expect(emoji.faults).toEqual([]);
  });
  test('A-M3 uncertain captured rows are never checked or content-matched, and screen uncertainty reaches the evidence', async () => {
    const rows = naRows(Array.from({ length: 12 }, (_, i) => `row-${i}`));
    const captured = rows.map(r => ({ softWrap: r.softWrap, cells: r.cells }));
    const plain = matchHistoryRows(rows, captured, naScope);
    expect(plain.checks.map(c => c.capturedRow)).toContain(6);
    const isolated = matchHistoryRows(rows, captured, { ...naScope, uncertainCapturedRows: new Set([6]) });
    expect([...isolated.checks, ...isolated.contentMatches].some(c => c.capturedRow === 6)).toBe(false);
    for (const c of isolated.checks) expect(Math.abs(c.capturedRow - 6)).toBeGreaterThan(1);
    const h = naHarness();
    const capture = h.ports.capture;
    h.ports.capture = async (...args) => ({ ...(await capture(...args)), uncertainScreenRows: [0], uncertainHistoryRows: [2] });
    await h.calibrator.runDue();
    expect(h.writes[0]!.captureEvidence).toMatchObject({ kind: 'quiescent', uncertainRows: [0] });
    expect([...h.writes[0]!.checks, ...h.writes[0]!.contentMatches].some(c => c.capturedRow === 2)).toBe(false);
    expect(h.published).toEqual([2]);
  });
  test('C-F20 a duplicated row inside identical text and an isolated coincidental anchor are content-matched, never checked', () => {
    // Hidden identities: parser duplicated #83 inside a run of v13 (round 1
    // certified the shifted copy as checked).
    // Fuzz case k=59 of the reviewer corpus, reduced.
    const parser = ['v5', 'v18', 'v5', 'v11', 'v13', 'v13', 'v13', 'v13', 'v5', 'v5', 'v13', 'v4'];
    const parserIds = [79, 80, 81, 82, 83, 83, 84, 85, 86, 87, 88, 89];
    const tmux = ['v5', 'v18', 'v5', 'v11', 'v13', 'v13', 'v13', 'v5', 'v5', 'v13', 'v4'];
    const tmuxIds = [79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89];
    const recent = naRows(parser);
    const m = matchHistoryRows(recent, tmux.map(naRow), naScope);
    expect(m.checks.length).toBeGreaterThan(0);
    for (const c of m.checks) expect(parserIds[c.lineId - 1]).toBe(tmuxIds[c.capturedRow]);
    // The run of v13 (parser rows 6..8) is content-matched: equal text,
    // identity unproven. Round 1 checked the shifted copy.
    expect(m.checks.some(c => c.lineId >= 5 && c.lineId <= 8)).toBe(false);
    expect(m.contentMatches.filter(c => c.lineId >= 6 && c.lineId <= 8)).toHaveLength(3);
    for (const c of [...m.checks, ...m.contentMatches]) expect(rowKey(recent[c.lineId - 1]!)).toBe(rowKey(naRow(tmux[c.capturedRow]!)));
    // Isolated coincidence (fuzz k=203): the parser's newest rows match an
    // older print once; a single anchor cannot certify the wrong offset.
    const olderPrint = matchHistoryRows(naRows(['v3', 'v4', 'v0', 'v1', 'v4']), ['v1', 'v2', 'v4', 'v0', 'v0', 'v1', 'v4', 'v1', 'v2', 'v4', 'v0', 'v2', 'v3'].map(naRow), naScope);
    expect(olderPrint.checks).toHaveLength(0);
  });
  test('C-F22 a capture without context keeps the previous context and still detects a stalled reader', () => {
    let at = 0; const faults: string[] = [];
    const wd = new HistoryWatchdog(() => at, f => faults.push(f.kind));
    wd.capture('a', { sourceEpoch: 1, geometryGeneration: 1, kind: 'normal' });
    wd.capture('b');
    at = 1000; wd.tick();
    expect(faults).toEqual(['reader-stalled']);
    // A real context change still resets the comparison.
    wd.receive(1);
    wd.capture('c', { sourceEpoch: 2, geometryGeneration: 1, kind: 'normal' }); wd.capture('d', { sourceEpoch: 3, geometryGeneration: 1, kind: 'normal' });
    at = 3000; wd.heartbeat(); wd.tick();
    expect(faults).toEqual(['reader-stalled']);
  });
});

describe('I4-FIX1 lot C: capture deadline, viewer cadence, full-fidelity capture, forced correction', () => {
  // The bits pyte observes (runtime OBSERVED_STYLE_MASK): no dim/rapid blink/hidden.
  const PARSER_BITS = 1 | 4 | 8 | 16 | 64 | 256;
  const styled = (row: CapturedRow, style: number): CapturedRow => ({ softWrap: row.softWrap, cells: row.cells.map(cell => ({ ...cell, style })) });

  test('M5 close() aborts a capture that ignores its signal; nothing it returns later is committed or published', async () => {
    const h = naHarness();
    const original = await h.ports.capture(h.calibrator.paneKey, 4500);
    let complete!: (capture: CalibrationCapture) => void; let aborted = 0;
    h.ports.timeout = () => () => {}; // the deadline never fires: only close() can end this capture
    h.ports.capture = (_, __, signal) => new Promise(resolve => { complete = resolve; signal!.addEventListener('abort', () => { aborted++; }); });
    const running = h.calibrator.runDue();
    expect(h.calibrator.capturing).toBe(true);
    const scheduled = h.scheduled.length;
    h.calibrator.close();
    await running;
    expect(aborted).toBe(1);
    expect(h.calibrator.capturing).toBe(false);
    complete(original); await Promise.resolve(); await Promise.resolve();
    expect(h.writes).toHaveLength(0); expect(h.published).toHaveLength(0); expect(h.faults).toEqual([]);
    h.calibrator.output(() => { throw new Error('closed pane published'); });
    h.calibrator.scroll(5); h.calibrator.event('resize'); h.calibrator.setViewers(1);
    expect(h.calibrator.dueAt).toBe(Infinity);
    expect(h.scheduled.length).toBe(scheduled);
    h.time(5000); await h.calibrator.runDue();
    expect(h.writes).toHaveLength(0); expect(h.limits).toHaveLength(1);
  });

  test('M5 close() during the store commit publishes nothing', async () => {
    const h = naHarness();
    const calibrate = h.ports.calibrate;
    let release!: () => void;
    h.ports.calibrate = input => new Promise(resolve => { release = () => resolve(calibrate(input)); });
    const running = h.calibrator.runDue();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    h.calibrator.close(); release(); await running;
    expect(h.writes).toHaveLength(1); expect(h.published).toHaveLength(0); expect(h.calibrator.dueAt).toBe(Infinity);
  });

  test('M5 a capture that never settles and ignores abort cannot hold the pane: the next capture runs after the 1s deadline', async () => {
    const h = naHarness();
    let fire: (() => void) | undefined, delay = 0, aborted = 0;
    h.ports.timeout = (callback, ms) => { fire = callback; delay = ms; return () => { fire = undefined; }; };
    const good = h.ports.capture;
    h.ports.capture = (_, __, signal) => { signal!.addEventListener('abort', () => { aborted++; }); return new Promise(() => {}); };
    const running = h.calibrator.runDue();
    expect(delay).toBe(CAPTURE_CADENCE.deadlineMs);
    h.time(1000); fire!(); await running;
    expect(aborted).toBe(1); expect(h.calibrator.capturing).toBe(false);
    expect(h.faults).toEqual(['capture-fault']);
    expect(h.calibrator.dueAt).toBe(1000);
    h.ports.capture = good;
    await h.calibrator.runDue();
    expect(h.writes).toHaveLength(1); expect(h.published).toHaveLength(1);
  });

  test('§5.4 cadence: viewed 200ms under output, unviewed 5s, events 50ms, a first viewer is captured at once with history', async () => {
    const run = async (options: CalibratorOptions) => {
      const h = naHarness(true, options);
      let captures = 0;
      for (let t = 0; t <= 60000; t += 10) {
        h.time(t); if (t > 0) h.calibrator.scroll(1);
        if (h.calibrator.dueAt <= t) { await h.calibrator.runDue(); captures++; }
      }
      return { h, captures };
    };
    const viewed = await run({ viewers: 1 }), legacy = await run({}), unviewed = await run({ viewers: 0 });
    console.log('NEWARCH_I4C_CADENCE', JSON.stringify({ window: '60s fake clock, 100 rows/s', viewed: viewed.captures, unreported: legacy.captures, unviewed: unviewed.captures }));
    expect(viewed.captures).toBeGreaterThanOrEqual(250);
    expect(legacy.captures).toBe(viewed.captures);
    expect(unviewed.captures).toBeGreaterThanOrEqual(10);
    expect(unviewed.captures).toBeLessThanOrEqual(13);
    const h = unviewed.h;
    expect(h.calibrator.dueAt).toBe(65000);
    // Lifecycle event: 50ms even without a viewer.
    h.time(60010); h.calibrator.event('resize');
    expect(h.calibrator.dueAt).toBe(60050);
    h.time(60050); await h.calibrator.runDue();
    expect(h.limits.at(-1)).toBe(4500);
    // Unviewed and idle: 5s, not 1s.
    h.time(60100); expect(h.calibrator.dueAt).toBe(65050);
    // First viewer: captured now (50ms spacing), history included.
    const before = h.limits.length;
    h.time(61000); h.calibrator.setViewers(1);
    expect(h.calibrator.dueAt).toBe(61000);
    await h.calibrator.runDue();
    expect(h.limits.length).toBe(before + 1); expect(h.limits.at(-1)).toBeGreaterThan(0);
    expect(h.calibrator.dueAt).toBe(62000);
    // Losing the last viewer: the following period is 5s again.
    h.calibrator.setViewers(0); h.time(62000); await h.calibrator.runDue();
    expect(h.calibrator.dueAt).toBe(67000);
    expect(() => h.calibrator.setViewers(-1)).toThrow('invalid viewer count');
  });

  test('§5.4 an unviewed divergence is not recaptured every 50ms; a viewed one is', async () => {
    for (const viewers of [0, 1]) {
      const h = naHarness(false, { viewers });
      const wrong = structuredClone(h.frame); wrong.cells = [naRow('bad ').cells]; h.parser(wrong);
      await h.calibrator.runDue();
      expect(h.published).toEqual([2]);
      expect(h.calibrator.dueAt).toBe(viewers ? 50 : 5000);
    }
  });

  test('M9 dim, rapid blink and hidden stay in the drawn capture; only the parser comparison is limited to certified bits', async () => {
    const results: Record<string, unknown> = {};
    for (const mask of [PARSER_BITS, undefined]) {
      const h = naHarness(false, mask === undefined ? {} : { certifiedStyleMask: mask });
      const frame = structuredClone(h.frame); frame.cells = [styled(naRow('abc '), 1 | 2 | 32 | 128).cells];
      const history = h.history.map((row, i) => i === 2 ? styled(row, 2) : { cells: row.cells, softWrap: row.softWrap });
      const original = h.ports.capture;
      let drawn: CalibrationFrame | undefined;
      h.ports.capture = async (...args) => ({ ...(await original(...args)), frame, history });
      h.ports.publish = (commit, published) => { h.published.push(commit.revision); drawn = published; };
      // The parser saw bold only: the bit it can observe.
      const parser = structuredClone(h.frame); parser.cells = [styled(naRow('abc '), 1).cells]; h.parser(parser);
      await h.calibrator.runDue();
      expect(drawn).toBe(frame);
      expect(drawn!.cells[0]!.map(cell => cell.style)).toEqual([163, 163, 163, 163]);
      const write = h.writes[0]!;
      expect(write.capture.history[2]!.cells[0]!.style).toBe(2);
      results[String(mask)] = { dueAt: h.calibrator.dueAt, checks: write.checks.map(c => c.lineId), uncertified: write.uncertifiedStyle ?? null };
      if (mask !== undefined) {
        expect(h.calibrator.dueAt).toBe(1000);
        expect(write.checks.map(c => c.lineId)).toContain(3);
        expect(write.uncertifiedStyle).toEqual({ mask, historyRows: [2], screenRows: [0] });
      } else {
        expect(h.calibrator.dueAt).toBe(50);
        expect(write.checks.map(c => c.lineId)).not.toContain(3);
        expect(write.uncertifiedStyle).toBeUndefined();
      }
    }
    console.log('NEWARCH_I4C_M9', JSON.stringify(results));
    // The comparator restriction never leaks into equality of drawn cells.
    const a = { ...h0Frame(), cells: [styled(naRow('x'), 2).cells] }, b = { ...h0Frame(), cells: [styled(naRow('x'), 0).cells] };
    expect(equalCalibrationFrames(a, b)).toBe(false);
    expect(equalCalibrationFrames(a, b, PARSER_BITS)).toBe(true);
    expect(equalCalibrationFrames(a, { ...b, cells: [styled(naRow('x'), 1).cells] }, PARSER_BITS)).toBe(false);
  });
  const h0Frame = (): CalibrationFrame => ({ cells: [], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 });

  test('F9 21 private panes: a parser screen made wrong by a taller resize is corrected by a quiescent capture within 1s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'i4c-f9-'));
    const socket = join(root, 'f9.sock');
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    const tmux = (...args: string[]) => {
      const r = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`private tmux ${args[0]} exit=${r.status}: ${r.stderr}`);
      return r.stdout;
    };
    // Independent oracle: plain capture-pane text (no -e, no decoder) and the
    // fixture's own colour rule; the decoder under test is never consulted.
    const plain = (id: string) => tmux('capture-pane', '-p', '-t', id).replace(/\n$/, '').split('\n').map(line => line.trimEnd());
    const cursorOf = (id: string) => { const [x, y] = tmux('display-message', '-p', '-t', id, '#{cursor_x} #{cursor_y}').trim().split(' ').map(Number); return { x: x!, y: y! }; };
    const text = (cells: readonly { grapheme: string; continuation: boolean }[]) => cells.filter(c => !c.continuation).map(c => c.grapheme).join('').trimEnd();
    const mismatch = (frame: CalibrationFrame, id: string) => {
      const oracle = plain(id), cursor = cursorOf(id);
      let rows = 0;
      for (let y = 0; y < Math.max(oracle.length, frame.cells.length); y++) if ((oracle[y] ?? '') !== (frame.cells[y] ? text(frame.cells[y]!) : '')) rows++;
      return { rows, cursor: frame.cursor?.x === cursor.x && frame.cursor?.y === cursor.y ? 0 : 1 };
    };
    const report: unknown[] = [];
    try {
      writeFileSync(join(root, 'tmux.conf'), 'set -g status off\nset -g history-limit 2000\n');
      const panes: string[] = [];
      for (let p = 0; p < 21; p++) {
        const script = join(root, `p${p}.sh`);
        // Line i is printed in colour 31+i%7; line 25 is dim (SGR 2).
        writeFileSync(script, "for i in $(seq 1 30); do if [ $i = 25 ]; then printf '\\033[2mdim-%02d-p" + p + "\\033[0m\\n' $i; else printf '\\033[%dmrow-%02d-p" + p + "\\033[0m\\n' $((31 + i % 7)) $i; fi; done; exec sleep 600\n");
        panes.push(tmux('-f', join(root, 'tmux.conf'), 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `f${p}`, '-x', '40', '-y', '10', `sh ${script}`).trim());
      }
      const readyBy = performance.now() + 10000;
      while (!panes.every(id => plain(id).some(line => line.startsWith('row-30-')))) {
        if (performance.now() > readyBy) throw new Error('fixture panes not ready');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      for (const [p, id] of panes.entries()) {
        const decoder = new TmuxCaptureDecoder(40);
        const screenAt = (rows: number) => decoder.decode(tmux('capture-pane', '-p', '-e', '-N', '-t', id)).slice(-rows);
        // Parser model before the resize, then the classic D-RESIZE error: the
        // parser grows at the bottom while tmux pulls history rows down.
        const old = screenAt(10);
        tmux('resize-window', '-t', `f${p}`, '-y', '14');
        const blank = Array.from({ length: 40 }, () => ({ grapheme: ' ', width: 1 as const, continuation: false, fg: 'default', bg: 'default', style: 0 }));
        const parser: CalibrationFrame = { cells: [...old, blank, blank, blank, blank], cursor: { x: 0, y: 9, visible: true }, kind: 'normal', geometryGeneration: 2, receiveSeq: 7 };
        const before = mismatch(parser, id);
        let revision = 1, commits = 0, drawn: CalibrationFrame | undefined, drawnAt = 0;
        const meta = (): CaptureMetadata => {
          const [w, hh, x, y, alt] = tmux('display-message', '-p', '-t', id, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on}').trim().split(' ').map(Number);
          return { historyEpoch: 1, sourceEpoch: 1, geometryGeneration: 2, cols: w!, rows: hh!, kind: alt ? 'alternate' : 'normal', cursor: { x: x!, y: y!, visible: true } };
        };
        const paneKey = { serverIdentity: socket, paneId: id, birthGeneration: 1 };
        const calibrator = new HistoryCalibrator(paneKey, {
          now: () => performance.now(), schedule: () => {},
          read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 2, recentHistory: [], parserFrame: parser }),
          capture: async (_key, tail) => {
            const m0 = meta(), requestedAt = performance.now();
            const body = tmux('capture-pane', '-p', '-e', '-N', '-t', id, ...(tail > 0 ? ['-S', `-${tail}`] : []));
            const m1 = meta();
            const rows = decoder.decode(body), screen = rows.slice(-m1.rows);
            return { paneKey, captureId: `f9-${p}`, requestedAt, completedAt: performance.now(), before: m0, after: m1,
              frame: { cells: screen, cursor: m1.cursor, kind: m1.kind, geometryGeneration: 2, receiveSeq: -1 },
              history: rows.slice(0, rows.length - screen.length).map(cells => ({ cells, softWrap: false })), completeRetainedTail: true, observedFields: ['cells', 'cursor'] };
          },
          calibrate: async input => { if (input.expectedRevision !== revision) return null; commits++; return { revision: ++revision, durableRevision: 0, nextLineId: 0 }; },
          publish: (_commit, frame) => { drawn ??= frame; drawnAt ||= performance.now(); },
          fault: issue => { throw new Error(`unexpected fault ${issue.kind}`); },
        }, { viewers: 1, certifiedStyleMask: PARSER_BITS });
        const quiescentAt = performance.now();
        calibrator.event('resize');
        while (!drawn && performance.now() - quiescentAt < 1000) {
          if (calibrator.dueAt <= performance.now()) await calibrator.runDue();
          else await new Promise(resolve => setTimeout(resolve, 5));
        }
        calibrator.close();
        expect(drawn).toBeDefined();
        const after = mismatch(drawn!, id);
        // Fixture colours and the dim row, read from the drawn cells.
        let colours = 0, dim = 0;
        for (const row of drawn!.cells) {
          const label = /^(row|dim)-(\d\d)-/.exec(text(row));
          if (!label) continue;
          if (label[1] === 'dim') { expect(row[0]!.style & 2).toBe(2); dim++; continue; }
          expect(row[0]!.fg).toBe(`index:${1 + Number(label[2]) % 7}`); colours++;
        }
        const latency = drawnAt - quiescentAt;
        report.push({ pane: id, before, after, commits, latencyMs: Math.round(latency), displaySource: drawn!.receiveSeq === -1 ? 'tmux-calibrated' : 'pipe', colours, dim });
        expect(before.rows).toBeGreaterThan(0); expect(before.cursor).toBe(1);
        expect(commits).toBeGreaterThanOrEqual(1);
        expect(after).toEqual({ rows: 0, cursor: 0 });
        expect(drawn!.receiveSeq).toBe(-1);
        expect(dim).toBe(1); expect(colours).toBe(12);
        expect(latency).toBeLessThanOrEqual(1000);
      }
      console.log('NEWARCH_I4C_F9', JSON.stringify({ panes: report.length, scope: 'private tmux 3.4 socket; real HistoryCalibrator + TmuxCaptureDecoder; oracle = plain capture-pane text + fixture colour rule', report }));
    } finally {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8', env });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
