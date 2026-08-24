import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { OutputWalWriter, parseOutputWalJson, readOutputWal, type OutputWalRecord } from "../src/output-wal";
import {
  createTerminalPtyWalProxyLaunchSpec,
  parseTerminalPtyWalProxyConfig,
  readTerminalPtyWalProxyHealth,
  TERMINAL_PTY_WAL_CONFIG_ENV,
  TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV,
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

function offlineIdentity(session: string, instanceId: string, generation: string) {
  return {
    session,
    instanceId,
    paneTarget: `=${session}:0.0`,
    tmuxServerPid: 44_001,
    sessionCreated: 1_787_500_000,
    sessionId: "$401",
    windowId: "@402",
    paneId: "%403",
    generation,
  };
}

function seedOfflineActiveWal(directory: string, session: string, instanceId: string): void {
  const writer = new OutputWalWriter({ path: join(directory, "output.wal") });
  writer.appendJson("lifecycle", {
    event: "start",
    identity: offlineIdentity(session, instanceId, "offline-generation-a"),
    geometry: { cols: 80, rows: 24 },
  });
  const committed = {
    changeId: "offline-resize-committed",
    from: { cols: 80, rows: 24 },
    to: { cols: 100, rows: 30 },
    reason: "test-commit",
  };
  writer.appendJson("resize", { phase: "prepare", ...committed });
  writer.appendJson("resize", { phase: "commit", ...committed });
  writer.appendJson("lifecycle", {
    event: "resume",
    identity: offlineIdentity(session, instanceId, "offline-generation-b"),
    geometry: { cols: 100, rows: 30 },
  });
  writer.appendJson("resize", {
    phase: "prepare",
    changeId: "offline-resize-pending",
    from: { cols: 100, rows: 30 },
    to: { cols: 120, rows: 40 },
    reason: "test-pending",
  });
  writer.close();
}

function runOfflineFinalizer(
  launch: ReturnType<typeof createTerminalPtyWalProxyLaunchSpec>,
): ReturnType<typeof spawnSync> {
  return spawnSync(launch.executable, [...launch.args, "--finalize-logical-end"], {
    env: launch.env,
    encoding: "utf8",
  });
}

describe("direct child PTY durable WAL proxy", () => {
  test("binds and self-verifies the exact Python asset before WAL access", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-asset-"));
    roots.push(root);
    const launch = createTerminalPtyWalProxyLaunchSpec({
      directory: join(root, "lane"),
      identity: { session: "sh-asset", instanceId: "asset-proof", paneTarget: "=sh-asset:0.0" },
      argv: ["/bin/true"],
    }, {});
    const asset = launch.args[1]!;
    const expected = createHash("sha256").update(readFileSync(asset)).digest("hex");
    expect(launch.env[TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV]).toBe(expected);
    const probe = [
      "import importlib.util,sys",
      "spec=importlib.util.spec_from_file_location('thumbmux_asset',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "sys.modules['thumbmux_asset']=module",
      "spec.loader.exec_module(module)",
      "print(module.verify_running_proxy_asset())",
    ].join("\n");
    const verified = spawnSync("python3", ["-c", probe, asset], {
      env: launch.env,
      encoding: "utf8",
    });
    expect({ status: verified.status, stdout: verified.stdout.trim(), stderr: verified.stderr })
      .toEqual({ status: 0, stdout: expected, stderr: "" });
    const rejected = spawnSync("python3", ["-c", probe, asset], {
      env: { ...launch.env, [TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV]: "0".repeat(64) },
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
  });

  test("retries outer PTY EAGAIN after one WAL append without duplicating delivered bytes", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-eagain-"));
    roots.push(root);
    const scriptPath = createTerminalPtyWalProxyLaunchSpec({
      directory: join(root, "lane"),
      identity: { session: "sh-eagain", instanceId: "eagain-proof", paneTarget: "=sh-eagain:0.0" },
      argv: ["/bin/true"],
    }, {}).args[1]!;
    const probe = [
      "import errno,importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('thumbmux_proxy',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "sys.modules['thumbmux_proxy']=module",
      "spec.loader.exec_module(module)",
      "payload=b'outer-pty-bytes'",
      "class Writer:\n def __init__(self): self.calls=0\n def append(self,kind,data):\n  self.calls+=1\n  assert kind=='output' and data==payload\n  return module.WalRecord(7,123,kind,bytes(data),99)",
      "writer=Writer()",
      "proxy=module.Proxy({'directory':'/not-used','heartbeatMs':1000})",
      "proxy.writer=writer",
      "accepted=bytearray()",
      "attempts=[]",
      "waits=0",
      "steps=iter(('partial','again','interrupt','finish'))",
      "original_write=module.os.write",
      "original_select=module.select.select",
      "def fake_write(fd,data):\n assert fd==1\n chunk=bytes(data)\n attempts.append(chunk.hex())\n step=next(steps)\n if step=='partial':\n  accepted.extend(chunk[:3]);return 3\n if step=='again': raise BlockingIOError(errno.EAGAIN,'outer PTY full')\n if step=='interrupt': raise InterruptedError(errno.EINTR,'signal')\n accepted.extend(chunk);return len(chunk)",
      "def fake_select(readable,writable,exceptional):\n global waits\n assert readable==[] and writable==[1] and exceptional==[]\n waits+=1\n return [],[1],[]",
      "module.os.write=fake_write",
      "module.select.select=fake_select",
      "try: proxy.append_output_and_display(payload)\nfinally:\n module.os.write=original_write\n module.select.select=original_select",
      "print(json.dumps({'writerCalls':writer.calls,'accepted':accepted.hex(),'attempts':attempts,'waits':waits,'walSequence':proxy.wal_sequence,'walNextOffset':proxy.wal_next_offset,'deliveredSequence':proxy.delivered_sequence,'deliveredNextOffset':proxy.delivered_next_offset}))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", probe, scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      writerCalls: 1,
      accepted: Buffer.from("outer-pty-bytes").toString("hex"),
      attempts: [
        Buffer.from("outer-pty-bytes").toString("hex"),
        Buffer.from("er-pty-bytes").toString("hex"),
        Buffer.from("er-pty-bytes").toString("hex"),
        Buffer.from("er-pty-bytes").toString("hex"),
      ],
      waits: 1,
      walSequence: 7,
      walNextOffset: 123,
      deliveredSequence: 7,
      deliveredNextOffset: 123,
    });
  });

  test("fsyncs every first-created WAL directory and its parent before startup", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-dirs-"));
    roots.push(root);
    const target = join(root, "durable", "wal", "lane");
    const scriptPath = createTerminalPtyWalProxyLaunchSpec({
      directory: target,
      identity: { session: "sh-dir-proof", instanceId: "dir-proof", paneTarget: "=sh-dir-proof:0.0" },
      argv: ["/bin/true"],
    }, {}).args[1]!;
    const probe = [
      "import importlib.util,json,os,sys",
      "spec=importlib.util.spec_from_file_location('thumbmux_proxy',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "sys.modules['thumbmux_proxy']=module",
      "spec.loader.exec_module(module)",
      "calls=[]",
      "original=module.fsync_directory",
      "def traced(path):\n calls.append(os.path.realpath(path));original(path)",
      "module.fsync_directory=traced",
      "module.ensure_durable_directory(sys.argv[2])",
      "print(json.dumps(calls))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", probe, scriptPath, target], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      join(root, "durable"), root,
      join(root, "durable", "wal"), join(root, "durable"),
      target, join(root, "durable", "wal"),
      target, join(root, "durable", "wal"),
    ]);
    for (const directory of [join(root, "durable"), join(root, "durable", "wal"), target]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  test("offline END repairs a torn tail, aborts resize, keeps latest source geometry, and is idempotent", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-offline-end-"));
    roots.push(root);
    const directory = join(root, "lane");
    const session = "sh-offline-end";
    const instanceId = "offline-end-instance";
    seedOfflineActiveWal(directory, session, instanceId);
    const paths = resolveTerminalWalPaths(directory);
    appendFileSync(paths.walPath, Buffer.from("THMW", "ascii"));

    const tmuxMarker = join(root, "tmux-was-queried");
    const tmuxProbe = join(root, "tmux-probe.sh");
    writeFileSync(
      tmuxProbe,
      `#!/bin/sh\nprintf queried > ${JSON.stringify(tmuxMarker)}\nexit 1\n`,
      { mode: 0o700 },
    );
    const childMarker = join(root, "child-was-executed");
    const launch = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: { session, instanceId, paneTarget: `=${session}:0.0` },
      argv: [
        "python3",
        "-c",
        `open(${JSON.stringify(childMarker)},'w',encoding='utf-8').write('ran')`,
      ],
      tmux: { executable: tmuxProbe },
    }, {});

    const first = runOfflineFinalizer(launch);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe("");
    expect(first.stderr).toBe("");
    expect(existsSync(tmuxMarker)).toBe(false);
    expect(existsSync(childMarker)).toBe(false);

    let records = [...readOutputWal(paths.walPath)];
    expect(records.map((record) => record.kind)).toEqual([
      "lifecycle",
      "resize",
      "resize",
      "lifecycle",
      "resize",
      "resize",
      "lifecycle",
    ]);
    const resizeRecords = records
      .filter((record) => record.kind === "resize")
      .map((record) => parseOutputWalJson<{ phase: string; changeId: string }>(record));
    expect(resizeRecords.at(-1)).toMatchObject({
      phase: "abort",
      changeId: "offline-resize-pending",
    });
    const end = lifecycle(records.at(-1)!);
    expect(end.event).toBe("end");
    expect(end.identity).toEqual(offlineIdentity(session, instanceId, "offline-generation-b"));
    expect(end.geometry).toEqual({ cols: 100, rows: 30 });
    const quarantined = readdirSync(directory).filter((name) => name.startsWith("output.wal.torn-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(directory, quarantined[0]!))).toEqual(Buffer.from("THMW", "ascii"));

    const finalSequence = records.at(-1)!.sequence;
    const finalSize = statSync(paths.walPath).size;
    const repeat = runOfflineFinalizer(launch);
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toBe("");
    expect(repeat.stderr).toBe("");
    records = [...readOutputWal(paths.walPath)];
    expect(records.at(-1)!.sequence).toBe(finalSequence);
    expect(statSync(paths.walPath).size).toBe(finalSize);
    expect(records.filter((record) => record.kind === "lifecycle" && lifecycle(record).event === "end"))
      .toHaveLength(1);
    expect(existsSync(tmuxMarker)).toBe(false);
    expect(existsSync(childMarker)).toBe(false);
  });

  test("offline END rejects a different logical identity without appending", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-offline-identity-"));
    roots.push(root);
    const directory = join(root, "lane");
    seedOfflineActiveWal(directory, "sh-original-lane", "offline-identity-instance");
    const paths = resolveTerminalWalPaths(directory);
    const before = [...readOutputWal(paths.walPath)];
    const launch = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: {
        session: "sh-different-lane",
        instanceId: "offline-identity-instance",
        paneTarget: "=sh-different-lane:0.0",
      },
      argv: ["/bin/false"],
    }, {});

    const result = runOfflineFinalizer(launch);
    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const after = [...readOutputWal(paths.walPath)];
    expect(after.map((record) => record.sequence)).toEqual(before.map((record) => record.sequence));
    expect(after.some((record) => record.kind === "lifecycle" && lifecycle(record).event === "end"))
      .toBe(false);
  });

  test("offline END fails closed while the direct writer lock is live", async () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-offline-live-"));
    roots.push(root);
    const directory = join(root, "lane");
    const session = "sh-offline-live";
    const instanceId = "offline-live-instance";
    seedOfflineActiveWal(directory, session, instanceId);
    const paths = resolveTerminalWalPaths(directory);
    const before = [...readOutputWal(paths.walPath)];
    const launch = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: { session, instanceId, paneTarget: `=${session}:0.0` },
      argv: ["/bin/false"],
    }, {});
    const scriptPath = launch.args[1]!;
    const holderCode = [
      "import importlib.util,sys,time",
      "spec=importlib.util.spec_from_file_location('thumbmux_proxy',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "sys.modules['thumbmux_proxy']=module",
      "spec.loader.exec_module(module)",
      "lock=module.WriterLock(sys.argv[2],sys.argv[3],'live-holder-generation')",
      "lock.acquire()",
      "print('READY',flush=True)",
      "time.sleep(30)",
    ].join("\n");
    const holder = spawn("python3", ["-u", "-c", holderCode, scriptPath, directory, instanceId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let holderError = "";
    holder.stderr!.setEncoding("utf8");
    holder.stderr!.on("data", (chunk) => { holderError += String(chunk); });
    const exited = once(holder, "exit");
    try {
      const ready = await Promise.race([
        once(holder.stdout!, "data").then(([chunk]) => String(chunk)),
        exited.then(([code, signal]) => {
          throw new Error(`lock holder exited before READY: ${String(code)}/${String(signal)} ${holderError}`);
        }),
        Bun.sleep(5_000).then(() => {
          throw new Error(`timed out waiting for lock holder: ${holderError}`);
        }),
      ]);
      expect(ready).toContain("READY");
      const result = runOfflineFinalizer(launch);
      expect(result.status).toBe(125);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      const after = [...readOutputWal(paths.walPath)];
      expect(after.map((record) => record.sequence)).toEqual(before.map((record) => record.sequence));
      expect(after.some((record) => record.kind === "lifecycle" && lifecycle(record).event === "end"))
        .toBe(false);
    } finally {
      holder.kill("SIGKILL");
      await exited;
    }
  });

  test("streams a large WAL with bounded memory and preserves offline END state", () => {
    if (spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "tmptywal-streaming-scan-"));
    roots.push(root);
    const directory = join(root, "lane");
    const launch = createTerminalPtyWalProxyLaunchSpec({
      directory,
      identity: {
        session: "sh-streaming-scan",
        instanceId: "streaming-scan-instance",
        paneTarget: "=sh-streaming-scan:0.0",
      },
      argv: ["/bin/false"],
    }, {});
    const scriptPath = launch.args[1]!;
    const probe = [
      "import importlib.util,json,os,struct,sys,tracemalloc,zlib",
      "spec=importlib.util.spec_from_file_location('thumbmux_proxy',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "sys.modules['thumbmux_proxy']=module",
      "spec.loader.exec_module(module)",
      "directory=sys.argv[2]",
      "os.mkdir(directory,0o700)",
      "path=os.path.join(directory,module.WAL_FILE)",
      "fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)",
      "state={'sequence':0,'at':1000}",
      "def append(kind,value):\n payload=(json.dumps(value,separators=(',',':')).encode() if isinstance(value,dict) else value)\n state['sequence']+=1\n state['at']+=1\n prefix=struct.pack('<BBHIQQ',module.VERSION,module.KIND_TO_CODE[kind],0,len(payload),state['sequence'],state['at'])\n checksum=zlib.crc32(prefix)\n checksum=zlib.crc32(payload,checksum)&0xffffffff\n module.write_all(fd,module.MAGIC+prefix+struct.pack('<II',checksum,0)+payload)",
      "session='sh-streaming-scan'",
      "instance_id='streaming-scan-instance'",
      "identity_a={'session':session,'instanceId':instance_id,'generation':'generation-a'}",
      "identity_b={'session':session,'instanceId':instance_id,'generation':'generation-b'}",
      "append('lifecycle',{'event':'start','identity':identity_a,'geometry':{'cols':80,'rows':24}})",
      "corrupt_offset=os.lseek(fd,0,os.SEEK_CUR)+module.HEADER_BYTES",
      "large_payload=b'x'*(64*1024)",
      "for _ in range(768): append('output',large_payload)",
      "committed={'changeId':'large-commit','from':{'cols':80,'rows':24},'to':{'cols':100,'rows':30},'reason':'stress'}",
      "append('resize',{'phase':'prepare',**committed})",
      "append('resize',{'phase':'commit',**committed})",
      "append('lifecycle',{'event':'resume','identity':identity_b,'geometry':{'cols':100,'rows':30}})",
      "pending={'changeId':'large-pending','from':{'cols':100,'rows':30},'to':{'cols':120,'rows':40},'reason':'stress'}",
      "append('resize',{'phase':'prepare',**pending})",
      "os.fsync(fd)",
      "os.close(fd)",
      "source_bytes=os.stat(path).st_size",
      "tracemalloc.start()",
      "module.finalize_logical_end({'directory':directory,'identity':{'session':session,'instanceId':instance_id}})",
      "writer=module.WalWriter(path,directory)",
      "existing=writer.existing",
      "peak_bytes=tracemalloc.get_traced_memory()[1]",
      "next_offset=writer.next_offset",
      "last_at=writer.last_at",
      "writer.close()",
      "corrupt_fd=os.open(path,os.O_RDWR)",
      "original=os.pread(corrupt_fd,1,corrupt_offset)",
      "os.pwrite(corrupt_fd,bytes([original[0]^1]),corrupt_offset)",
      "os.fsync(corrupt_fd)",
      "os.close(corrupt_fd)",
      "checksum_rejected=False",
      "try:\n module.WalWriter(path,directory)\nexcept module.WalCorruption as error:\n checksum_rejected='checksum mismatch' in str(error)",
      "print(json.dumps({'sourceBytes':source_bytes,'peakBytes':peak_bytes,'active':existing.active,'sequence':existing.sequence,'validBytes':existing.valid_bytes,'nextOffset':next_offset,'lastAt':last_at,'identity':existing.identity,'geometry':existing.geometry,'pending':existing.pending_resize,'checksumRejected':checksum_rejected,'corruptSize':os.stat(path).st_size}))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", probe, scriptPath, directory], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const measured = JSON.parse(result.stdout) as {
      sourceBytes: number;
      peakBytes: number;
      active: boolean;
      sequence: number;
      validBytes: number;
      nextOffset: number;
      lastAt: number;
      identity: { generation: string };
      geometry: { cols: number; rows: number };
      pending: unknown;
      checksumRejected: boolean;
      corruptSize: number;
    };
    // The source is over 48 MiB, while Python allocations during both the
    // offline finalizer scan and a second resume scan stay under 8 MiB. The
    // former list-based implementation retained every 64 KiB payload and
    // exceeded this bound by more than six times.
    expect(measured.sourceBytes).toBeGreaterThan(48 * 1024 * 1024);
    expect(measured.peakBytes).toBeLessThan(8 * 1024 * 1024);
    expect(measured.active).toBe(false);
    expect(measured.sequence).toBe(775);
    expect(measured.validBytes).toBe(statSync(join(directory, "output.wal")).size);
    expect(measured.nextOffset).toBe(measured.validBytes);
    expect(measured.lastAt).toBeGreaterThan(1000);
    expect(measured.identity.generation).toBe("generation-b");
    expect(measured.geometry).toEqual({ cols: 100, rows: 30 });
    expect(measured.pending).toBeNull();
    expect(measured.checksumRejected).toBe(true);
    expect(measured.corruptSize).toBe(measured.validBytes);
  });

  test("validates a direct argv launch and retains all physical source fields", () => {
    const parsed = parseTerminalPtyWalProxyConfig({
      directory: "/tmp/thumbmux-pty-schema",
      identity: {
        session: "durable-agent-1",
        instanceId: "instance-1",
        paneTarget: "=durable-agent-1:0.0",
      },
      argv: ["bash", "--noprofile"],
      env: { EMPTY_IS_VALID: "" },
    });
    expect(parsed.argv).toEqual(["bash", "--noprofile"]);
    expect(parsed.env.EMPTY_IS_VALID).toBe("");

    expect(parseTerminalWalIdentity({
      session: "durable-agent-1",
      instanceId: "instance-1",
      paneTarget: "=durable-agent-1:0.0",
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
      session: "durable-agent-1",
      instanceId: "instance-1",
      paneTarget: "=durable-agent-1:0.0",
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
    const firstAsset = first.env[TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV];
    if (!firstConfig || !firstAsset) throw new Error("launch spec omitted proxy config or asset digest");
    const firstSpawn = tmux(
      socket,
      "new-session", "-d", "-x", "80", "-y", "24", "-s", session,
      "-e", `${TERMINAL_PTY_WAL_CONFIG_ENV}=${firstConfig}`,
      "-e", `${TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV}=${firstAsset}`,
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
    const secondAsset = second.env[TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV];
    if (!secondConfig || !secondAsset) throw new Error("launch spec omitted proxy config or asset digest");
    expect(tmux(
      socket,
      "new-session", "-d", "-x", "80", "-y", "24", "-s", session,
      "-e", `${TERMINAL_PTY_WAL_CONFIG_ENV}=${secondConfig}`,
      "-e", `${TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV}=${secondAsset}`,
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
      "-e", `${TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV}=${contender.env[TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV]}`,
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
