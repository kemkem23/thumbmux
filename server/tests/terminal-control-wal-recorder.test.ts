import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
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

import { HistoryCalibrator, equalCalibrationFrames, type CalibrationCapture, type CalibrationFrame, type CalibrationPorts } from '../src/history-calibrator';
import { rowKey, matchHistoryRows, IncrementalHistoryMatcher, equalHistoryRows, type HistoryRow, type CapturedRow } from '../src/history-row-matcher';
import { HistoryWatchdog } from '../src/history-watchdog';

const naRow = (text: string): CapturedRow => ({ softWrap: false, cells: Array.from(text, grapheme => ({ grapheme, width: 1 as const, continuation: false, fg: 'default', bg: 'default', style: 0 })) });
const naRows = (texts: string[]): HistoryRow[] => texts.map((text, i) => ({ ...naRow(text), lineId: i + 1, sourceEpoch: 1, geometryGeneration: 1 }));
const naScope = { sourceEpoch: 1, geometryGeneration: 1, completeRetainedTail: true };
function naHarness(incremental = false) {
  let time = 0, revision = 1;
  const paneKey = { serverIdentity: 'private', paneId: '%0', birthGeneration: 1 };
  const frame: CalibrationFrame = { cells: [naRow('abc ').cells], cursor: { x: 0, y: 0, visible: true }, kind: 'normal', geometryGeneration: 1, receiveSeq: 0 };
  const history = naRows(['a', 'b', 'c']);
  let parser = structuredClone(frame);
  const limits: number[] = [], scheduled: number[] = [], published: number[] = [], faults: string[] = [], writes: Parameters<CalibrationPorts['calibrate']>[0][] = [];
  let conflict = false, stale = false;
  const ports: CalibrationPorts = {
    now: () => time,
    read: () => ({ revision, sourceEpoch: 1, geometryGeneration: 1, recentHistory: history, parserFrame: parser }),
    schedule: at => { scheduled.push(at); },
    capture: async (_, limit) => {
      limits.push(limit);
      const meta = { sourceEpoch: 1, geometryGeneration: 1, cols: 4, rows: 1, kind: 'normal' as const, cursor: frame.cursor };
      return { paneKey, captureId: `capture-${limits.length}`, requestedAt: time, completedAt: time, before: meta, after: stale ? { ...meta, cols: 5 } : meta, frame, history, completeRetainedTail: limit >= history.length, observedFields: ['cells', 'cursor'] };
    },
    calibrate: async input => { writes.push(input); if (conflict || input.expectedRevision !== revision) { conflict = false; revision++; return null; } return { revision: ++revision, durableRevision: 0, nextLineId: 4 }; },
    publish: commit => { published.push(commit.revision); },
    fault: fault => { faults.push(fault.kind); },
  };
  const calibrator = new HistoryCalibrator(paneKey, ports, { incremental });
  return { calibrator, ports, frame, history, limits, scheduled, published, faults, writes,
    time: (at: number) => { time = at; },
    parser: (value: CalibrationFrame) => { parser = value; },
    conflict: () => { conflict = true; }, stale: () => { stale = true; },
  };
}

describe('NEWARCH L2-C matcher and calibration ports', () => {
  test('unique suffix checks exact cells and repairs only bounded equal-length mismatch', () => {
    const rows = naRows(['L1', 'L2', 'L3', 'bad', 'R1', 'R2', 'R3']);
    const capture = ['L1', 'L2', 'L3', 'good', 'R1', 'R2', 'R3'].map(naRow);
    const match = matchHistoryRows(rows, capture, naScope);
    expect(match.checks).toHaveLength(6);
    expect(match.repairs).toEqual([{ lineId: 4, capturedRow: 3, row: capture[3]! }]);
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
    expect(match.checks.map(c => c.lineId)).toEqual([5, 6, 7]);
  });
  test('20,000-row fixture remains unchanged when only the retained tail can be checked', () => {
    const rows = naRows(Array.from({ length: 20000 }, (_, i) => `row-${i}`));
    const retained = rows.slice(-4500);
    const match = matchHistoryRows(rows, retained, naScope);
    expect(rows).toHaveLength(20000);
    expect(match.checks).toHaveLength(4500);
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
    expect(h.history.map(r => r.lineId)).toEqual([1, 2, 3]);
    expect(h.calibrator.acceptsPipeFrame).toBe(false);
  });
  test('CAPTURE latch prevents parser overwrite, keeps scroll ingestion and returns only on equality', async () => {
    const h = naHarness();
    const wrong = structuredClone(h.frame); wrong.cells = [naRow('bad ').cells]; h.parser(wrong);
    await h.calibrator.runDue();
    expect(h.calibrator.mode).toBe('CAPTURE');
    let pipePublishes = 0;
    h.calibrator.output(() => pipePublishes++); h.calibrator.scroll(20000);
    h.time(50); await h.calibrator.runDue();
    expect(h.limits).toEqual([4500, 0]);
    expect(pipePublishes).toBe(0);
    h.time(1051); await h.calibrator.runDue();
    expect(h.faults).toContain('capture-latch-degraded');
    h.parser(structuredClone(h.frame)); h.time(1101); await h.calibrator.runDue();
    expect(h.calibrator.mode).toBe('PIPE');
    h.calibrator.output(() => pipePublishes++); h.time(1117); await h.calibrator.runDue();
    expect(pipePublishes).toBe(1);
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
  let contentFalse = 0, identityFalse = 0, repairNotTmux = 0, repairWrongLine = 0, repairDestroysCorrect = 0;
  for (const c of m.checks) {
    if (rowKey(recent[c.lineId]!) !== rowKey(captured[c.capturedRow]!)) contentFalse++;
    if (parser[c.lineId]!.id !== tmux[c.capturedRow]!.id) identityFalse++;
  }
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
  return { lostByRepair, dupByRepair, name, reason: m.reason, checks: m.checks.length, repairs: m.repairs.length, contentFalse, identityFalse, repairNotTmux, repairWrongLine, repairDestroysCorrect };
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
const agg = { lostByRepair: 0, dupByRepair: 0, lossCases: [] as any[], cases: 0, checks: 0, repairs: 0, contentFalse: 0, identityFalse: 0, repairNotTmux: 0, repairWrongLine: 0, repairDestroysCorrect: 0, destroyCases: [] as any[], identityFalseCases: [] as any[] };
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
  agg.cases++; agg.checks += res.checks; agg.repairs += res.repairs; agg.contentFalse += res.contentFalse; agg.identityFalse += res.identityFalse; agg.lostByRepair += res.lostByRepair; agg.dupByRepair += res.dupByRepair; if ((res.lostByRepair||res.dupByRepair) && agg.lossCases.length < 3) agg.lossCases.push({k, vocab, parser: parser.map(l=>l.text+'#'+l.id).join(' '), tmux: ring.slice(0, ring.length - behind || undefined).map(l=>l.text+'#'+l.id).join(' '), ...res}); agg.repairNotTmux += res.repairNotTmux; agg.repairWrongLine += res.repairWrongLine; agg.repairDestroysCorrect += res.repairDestroysCorrect; if (res.repairDestroysCorrect && agg.destroyCases.length < 5) agg.destroyCases.push({ k, vocab, ...res });
  if (res.identityFalse && agg.identityFalseCases.length < 5) agg.identityFalseCases.push({ k, vocab, parser: parser.map(l=>l.text+'#'+l.id).join(' '), tmux: ring.slice(0, ring.length - behind || undefined).map(l=>l.text+'#'+l.id).join(' '), ...res });
}
for (const o of out) { expect(o.contentFalse).toBe(0); expect(o.repairNotTmux).toBe(0); }
console.log('NEWARCH_FIX1_FUZZ', JSON.stringify({ cases: agg.cases, checks: agg.checks, falseChecked: agg.contentFalse, repairs: agg.repairs, repairNotTmux: agg.repairNotTmux, identityFalse: agg.identityFalse }));
expect(agg.cases).toBe(3000); expect(agg.checks).toBeGreaterThan(0); expect(agg.contentFalse).toBe(0); expect(agg.repairNotTmux).toBe(0);
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
      expect(result.checks).toHaveLength(4499);
      expect(result.repairs).toHaveLength(1);
    }
    times.sort((a, b) => a - b);
    console.log('NEWARCH_FIX1_MATCHER', JSON.stringify({ cols, rows: 4500, samples: times.length, p95: times[28], max: times[29], cadenceMs: 200, driftedRows: 1 }));
    expect(times[28]!).toBeLessThanOrEqual(20);
    // Same sampled prefix, different final cells: never trust the bucket key.
    captured[2200]!.cells[cols - 1]!.fg = 'index:9';
    const result = matchHistoryRows(recent, captured, naScope);
    expect(result.checks.some(c => c.lineId === 2201)).toBe(false);
    expect(result.repairs.some(c => c.lineId === 2201)).toBe(true);
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
    const captured = recent.slice(-23);
    const result = matcher.match(recent, captured, { ...naScope, completeRetainedTail: false });
    for (const c of result.checks) {
      expect(equalHistoryRows(all[c.lineId - 1]!, captured[c.capturedRow]!)).toBe(true);
      if (c.lineId > 4500) checked.add(c.lineId);
    }
    matcher.remember(recent, captured, result);
  }
  console.log('NEWARCH_FIX1_INCREMENTAL', JSON.stringify({ scrolled: 3000, checked: checked.size, ratio: checked.size / 3000 }));
  expect(checked.size).toBe(3000);
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
  let revision = 1, commits = 0, pipe = 0;
  h.ports.read = () => ({ ...read(), revision });
  h.ports.calibrate = async input => {
    expect(input.expectedRevision).toBe(revision);
    commits++; return { revision: ++revision, durableRevision: 0, nextLineId: 4 };
  };
  h.ports.capture = async (key, limit) => {
    for (let n = 0; n < 10; n++) {
      await new Promise(resolve => setTimeout(resolve, 10)); revision++;
      h.time(n * 10); h.calibrator.output(() => pipe++);
      await h.calibrator.runDue();
    }
    return capture(key, limit);
  };
  await h.calibrator.runDue();
  expect(commits).toBe(1); expect(pipe).toBeGreaterThan(0);
  console.log('NEWARCH_FIX1_CAS', JSON.stringify({ rowsPerSecond: 100, commits, pipe }));
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
