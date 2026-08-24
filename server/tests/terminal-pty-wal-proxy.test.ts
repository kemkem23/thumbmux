import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseOutputWalJson, readOutputWal, type OutputWalRecord } from "../src/output-wal";
import {
  createTerminalPtyWalProxyLaunchSpec,
  parseTerminalPtyWalProxyConfig,
  readTerminalPtyWalProxyHealth,
  TERMINAL_PTY_WAL_CONFIG_ENV,
} from "../src/integrations/terminal-pty-wal-proxy";
import {
  parseTerminalWalIdentity,
  resolveTerminalWalPaths,
  TerminalWalController,
  type TerminalWalLifecycleRecord,
} from "../src/integrations/terminal-wal";

const roots: string[] = [];
const sockets: string[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function eventually(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

function tmux(socket: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
}

function lifecycle(record: OutputWalRecord): TerminalWalLifecycleRecord {
  return parseOutputWalJson<TerminalWalLifecycleRecord>(record);
}

describe("direct child PTY durable WAL proxy", () => {
  test("validates a direct argv launch and retains all physical source fields", () => {
    const parsed = parseTerminalPtyWalProxyConfig({
      directory: "/tmp/thumbmux-pty-schema",
      identity: {
        session: "cc-hs-server-1",
        instanceId: "instance-1",
        paneTarget: "=cc-hs-server-1:0.0",
      },
      argv: ["bash", "--noprofile"],
      env: { EMPTY_IS_VALID: "" },
    });
    expect(parsed.argv).toEqual(["bash", "--noprofile"]);
    expect(parsed.env.EMPTY_IS_VALID).toBe("");

    expect(parseTerminalWalIdentity({
      session: "cc-hs-server-1",
      instanceId: "instance-1",
      paneTarget: "=cc-hs-server-1:0.0",
      tmuxServerPid: 123,
      sessionCreated: 456,
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
      generation: "0123456789abcdef",
    })).toMatchObject({
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
      generation: "0123456789abcdef",
    });
    expect(() => parseTerminalWalIdentity({
      session: "cc-hs-server-1",
      instanceId: "instance-1",
      paneTarget: "=cc-hs-server-1:0.0",
      tmuxServerPid: 123,
      sessionCreated: 456,
      generation: "missing-physical-ids",
    })).toThrow("must be supplied together");
  });

  test("real tmux preserves bytes, resumes with a new generation, orders resize, and ACKs END after EOF", async () => {
    if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0
      || spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;

    const root = mkdtempSync(join(tmpdir(), "tmptywal-"));
    roots.push(root);
    const socket = join(root, "tmux.sock");
    sockets.push(socket);
    const directory = join(root, "lane");
    const session = "sh-pty-wal";
    const instanceId = "pty-generation-chain";

    expect(tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", "sh-keeper", "sleep", "120").status).toBe(0);

    const raw = Buffer.from([0x54, 0x30, 0x3a, 0xe0, 0xb9, 0x84, 0xe0, 0xb8, 0x97, 0xe0, 0xb8, 0xa2, 0xf0, 0x9f, 0x99, 0x82, 0x00, 0xff]);
    const firstCode = [
      "import os,tty",
      "tty.setraw(0)",
      `os.write(1,bytes.fromhex('${raw.toString("hex")}'))`,
      "os.read(0,1)",
      "raise SystemExit(7)",
    ].join(";");
    const first = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: { session, instanceId, paneTarget: `=${session}:0.0` },
      argv: ["python3", "-c", firstCode],
      tmux: { socketPath: socket },
      heartbeatMs: 50,
      terminateGraceMs: 500,
    }, {});
    const firstConfig = first.env[TERMINAL_PTY_WAL_CONFIG_ENV];
    if (!firstConfig) throw new Error("launch spec omitted proxy config");
    const firstSpawn = tmux(
      socket,
      "new-session", "-d", "-x", "80", "-y", "24", "-s", session,
      "-e", `${TERMINAL_PTY_WAL_CONFIG_ENV}=${firstConfig}`,
      first.executable, ...first.args,
    );
    expect(firstSpawn.status).toBe(0);
    await eventually(
      () => existsSync(join(directory, "pty-proxy-status.json"))
        && readTerminalPtyWalProxyHealth(directory).state === "armed",
      "first source armed",
    );
    let armedRecords = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(armedRecords.filter((record) => record.kind === "output")).toHaveLength(0);
    const firstController = new TerminalWalController({ directory, requestTimeoutMs: 10_000 });
    const firstGeneration = readTerminalPtyWalProxyHealth(directory).generation;
    await expect(firstController.activate("wrong-generation", "wrong-activate"))
      .rejects.toThrow("generation does not match");
    await firstController.activate(firstGeneration, "first-activate");
    firstController.close();
    await eventually(() => {
      if (!existsSync(join(directory, "pty-proxy-status.json"))) return false;
      const current = readTerminalPtyWalProxyHealth(directory);
      if (current.state !== "ready") return false;
      const currentRecords = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
      return Buffer.concat(currentRecords.filter((record) => record.kind === "output")
        .map((record) => Buffer.from(record.payload))).equals(raw);
    }, "first child output before exit");
    expect(tmux(socket, "set-window-option", "-t", `=${session}:0`, "remain-on-exit", "on").status).toBe(0);
    expect(tmux(socket, "send-keys", "-t", `=${session}:0.0`, "-l", "x").status).toBe(0);
    await eventually(
      () => existsSync(join(directory, "pty-proxy-status.json"))
        && readTerminalPtyWalProxyHealth(directory).state === "disconnected",
      "first source disconnect",
    );
    const firstHealth = readTerminalPtyWalProxyHealth(directory);
    expect(firstHealth.childExitCode).toBe(7);
    expect(firstHealth.source?.generation).toMatch(/^[0-9a-f]{32}$/);
    expect(firstHealth.generation).toBe(firstHealth.source?.generation);
    expect(existsSync(resolveTerminalWalPaths(directory).lockPath)).toBe(true);
    expect(tmux(socket, "display-message", "-p", "-t", `=${session}:0.0`, "#{pane_dead}").stdout.trim()).toBe("0");

    let records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    expect(records[0]!.kind).toBe("lifecycle");
    expect(lifecycle(records[0]!).event).toBe("start");
    expect(Buffer.concat(records.filter((record) => record.kind === "output").map((record) => Buffer.from(record.payload)))).toEqual(raw);
    expect(records.some((record) => record.kind === "lifecycle" && lifecycle(record).event === "end")).toBe(false);
    expect(tmux(socket, "kill-session", "-t", `=${session}`).status).toBe(0);
    await eventually(() => !existsSync(resolveTerminalWalPaths(directory).lockPath), "first writer release after physical kill");

    // A live PID with a different Linux birth tick is a reused PID, not the
    // lock owner. The resumed proxy must safely reclaim this stale marker.
    writeFileSync(resolveTerminalWalPaths(directory).lockPath, `${JSON.stringify({
      version: 2,
      pid: process.pid,
      pidStartTicks: "0",
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      instanceId,
      generation: "stale-generation",
      createdAt: 1,
    })}\n`, { mode: 0o600 });

    const resizeProgram = [
      "import fcntl,os,signal,struct,termios,time,tty",
      "tty.setraw(0)",
      "emit=lambda b: os.write(1,b)",
      "def resized(*_):\n r,c,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8));emit(f'GEOM:{c}x{r}'.encode())",
      "signal.signal(signal.SIGWINCH,resized)",
      "emit(b'READY2')",
      "while True: time.sleep(1)",
    ].join("\n");
    const second = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: { session, instanceId, paneTarget: `=${session}:0.0` },
      argv: ["python3", "-c", resizeProgram],
      tmux: { socketPath: socket },
      heartbeatMs: 50,
      terminateGraceMs: 500,
    }, {});
    const secondConfig = second.env[TERMINAL_PTY_WAL_CONFIG_ENV];
    if (!secondConfig) throw new Error("launch spec omitted proxy config");
    expect(tmux(
      socket,
      "new-session", "-d", "-x", "80", "-y", "24", "-s", session,
      "-e", `${TERMINAL_PTY_WAL_CONFIG_ENV}=${secondConfig}`,
      second.executable, ...second.args,
    ).status).toBe(0);
    await eventually(
      () => readTerminalPtyWalProxyHealth(directory).state === "armed"
        && readTerminalPtyWalProxyHealth(directory).source?.generation !== firstHealth.source?.generation,
      "resumed source armed",
    );
    const secondGeneration = readTerminalPtyWalProxyHealth(directory).source!.generation;
    const controller = new TerminalWalController({ directory, requestTimeoutMs: 10_000 });
    await controller.activate(secondGeneration, "second-activate");
    await eventually(
      () => readTerminalPtyWalProxyHealth(directory).state === "ready",
      "resumed source ready",
    );

    // A second physical pane cannot become another writer and, because it did
    // not acquire the lock, cannot overwrite the active owner's health file.
    const contenderSession = "sh-pty-contender";
    const contender = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: { session: contenderSession, instanceId, paneTarget: `=${contenderSession}:0.0` },
      argv: ["python3", "-c", "import os;os.write(1,b'SHOULD-NOT-RUN')"],
      tmux: { socketPath: socket },
      heartbeatMs: 50,
    }, {});
    expect(tmux(
      socket,
      "new-session", "-d", "-x", "80", "-y", "24", "-s", contenderSession,
      "-e", `${TERMINAL_PTY_WAL_CONFIG_ENV}=${contender.env[TERMINAL_PTY_WAL_CONFIG_ENV]}`,
      contender.executable, ...contender.args,
    ).status).toBe(0);
    await eventually(() => tmux(socket, "has-session", "-t", `=${contenderSession}`).status !== 0, "contending pane exit");
    expect(readTerminalPtyWalProxyHealth(directory).generation).toBe(secondGeneration);
    expect(readTerminalPtyWalProxyHealth(directory).state).toBe("ready");

    const barrier = await controller.barrier("real-pty-barrier");
    expect(Number(barrier.sequence)).toBeGreaterThan(0);
    expect(barrier.generation).toBe(secondGeneration);
    await eventually(() => Buffer.concat(
      [...readOutputWal(resolveTerminalWalPaths(directory).walPath)]
        .filter((record) => record.kind === "output")
        .map((record) => Buffer.from(record.payload)),
    ).includes(Buffer.from("READY2")), "second child signal handler ready");

    expect(tmux(socket, "set-window-option", "-t", `=${session}:0`, "window-size", "manual").status).toBe(0);
    expect(tmux(socket, "resize-window", "-t", `=${session}:0`, "-x", "100", "-y", "30").status).toBe(0);
    await eventually(() => {
      const health = readTerminalPtyWalProxyHealth(directory);
      if (health.state === "fatal" || health.state === "disconnected") {
        const diagnostics = existsSync(join(directory, "pty-proxy-diagnostics.log"))
          ? readFileSync(join(directory, "pty-proxy-diagnostics.log"), "utf8")
          : "";
        throw new Error(`${JSON.stringify(health)} ${diagnostics}`);
      }
      const next = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
      const commits = next.filter((record) => record.kind === "resize")
        .map((record) => parseOutputWalJson<{ phase: string }>(record));
      const output = Buffer.concat(next.filter((record) => record.kind === "output").map((record) => Buffer.from(record.payload)));
      return commits.some((record) => record.phase === "commit") && output.includes(Buffer.from("GEOM:100x30"));
    }, "ordered resize and child redraw");

    const endAck = await controller.endLogicalLifecycle("real-pty-end");
    expect(endAck.generation).toBe(secondGeneration);
    controller.close();
    await eventually(() => readTerminalPtyWalProxyHealth(directory).state === "ended", "durable logical end");
    const finalHealth = readTerminalPtyWalProxyHealth(directory);
    expect(finalHealth.deliveredSequence).toBe(endAck.sequence);
    expect(finalHealth.deliveredNextOffset).toBe(endAck.nextOffset);
    expect(finalHealth.source?.generation).toBe(secondGeneration);

    records = [...readOutputWal(resolveTerminalWalPaths(directory).walPath)];
    const lifecycles = records.filter((record) => record.kind === "lifecycle").map(lifecycle);
    expect(lifecycles.map((record) => record.event)).toEqual(["start", "resume", "end"]);
    expect(new Set(lifecycles.map((record) => record.identity.generation)).size).toBe(2);
    const commitIndex = records.findIndex((record) => record.kind === "resize"
      && parseOutputWalJson<{ phase: string }>(record).phase === "commit");
    const redrawIndex = records.findIndex((record, index) => index > commitIndex
      && record.kind === "output"
      && Buffer.from(record.payload).includes(Buffer.from("GEOM:100x30")));
    expect(commitIndex).toBeGreaterThan(0);
    expect(redrawIndex).toBeGreaterThan(commitIndex);
    expect(lifecycle(records.at(-1)!).event).toBe("end");
    expect(finalHealth.walSequence).toBe(String(records.at(-1)!.sequence));
    expect(finalHealth.walNextOffset).toBe(records.at(-1)!.nextOffset);
    if (existsSync(join(directory, "pty-proxy-diagnostics.log"))) {
      expect(readFileSync(join(directory, "pty-proxy-diagnostics.log"), "utf8")).not.toContain("fatal");
    }
  }, 30_000);
});
