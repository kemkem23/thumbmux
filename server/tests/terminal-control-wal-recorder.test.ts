import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import { parseOutputWalJson, readOutputWal } from "../src/output-wal";
import {
  installTerminalControlWalSignalHandlers,
  readTerminalControlWalHealth,
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
      "output",
      "resize",
      "resize",
      "output",
      "output",
      "lifecycle",
    ]);
    expect(Buffer.from(records[1]!.payload).toString()).toBe("before\r\n");
    expect(parseOutputWalJson(records[2]!)).toEqual({
      phase: "prepare",
      changeId: "layout:1",
      from: { cols: 80, rows: 24 },
      to: { cols: 90, rows: 30 },
      reason: "tmux-control-layout",
    });
    expect(parseOutputWalJson(records[3]!)).toMatchObject({ phase: "commit", changeId: "layout:1" });
    expect(Buffer.from(records[4]!.payload).toString()).toBe("after\r\n");
    expect(Buffer.from(records[5]!.payload).toString()).toBe("tail-before-exit\n");
    expect(parseOutputWalJson(records[6]!)).toMatchObject({
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
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "output"]);
    expect(parseOutputWalJson(records[0]!)).toMatchObject({ event: "start" });
  });

  test("answers %pause with refresh-client continue and resumes ordered capture", async () => {
    const { fake, recorder } = makeRecorder();
    let commands = "";
    fake.stdin.on("data", (chunk) => {
      commands += Buffer.from(chunk).toString();
    });
    await ready(recorder, fake);

    fake.stdout.write("%pause %42\n");
    await eventually(() => commands.includes("refresh-client -A %42:continue\n"), "continue command");
    fake.stdout.write("%begin 1700000001 2 1\n%end 1700000001 2 1\n");
    fake.stdout.write("%continue %42\n%output %42 resumed\\012\n");
    expect(recorder.status.state).toBe("ready");
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
    const outputs = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)]
      .filter((record) => record.kind === "output");
    expect(Buffer.concat(outputs.map((record) => Buffer.from(record.payload))).toString()).toBe("good\n");
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

  test("treats %exit as source disconnect without ending the logical lifecycle", async () => {
    const { directory, fake, recorder } = makeRecorder();
    await ready(recorder, fake);
    fake.stdout.write("%output %42 final\\012\n%exit\n");
    await eventually(() => recorder.status.state === "disconnected", "source disconnect");

    const records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "output"]);
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
