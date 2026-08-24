import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalReplayWorkerClient } from "thumbmux/server";

const MAGIC = Buffer.from("THMWAL01", "ascii");
const HEADER_BYTES = 40;
const CHECKSUM_INPUT_BYTES = 24;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? (0xedb88320 ^ (value >>> 1))
        : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32Parts(parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function walRecord(kind, payload, sequence, at) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(1, 8);
  header.writeUInt8(kind, 9);
  header.writeUInt32LE(payload.byteLength, 12);
  header.writeBigUInt64LE(BigInt(sequence), 16);
  header.writeBigUInt64LE(BigInt(at), 24);
  header.writeUInt32LE(
    crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]),
    32,
  );
  return Buffer.concat([header, payload]);
}

function writeSmokeWal(path) {
  const lifecycle = Buffer.from(JSON.stringify({
    event: "start",
    identity: {
      session: "git-dist-node18-lock",
      instanceId: "01GITDISTNODE18LOCK00000000",
      paneTarget: "=git-dist-node18-lock:0.0",
      tmuxServerPid: 12345,
      sessionCreated: 1_787_500_000,
      sessionId: "$1",
      windowId: "@2",
      paneId: "%3",
      generation: "generation-1",
    },
    geometry: { cols: 24, rows: 5 },
  }), "utf8");
  const output = Buffer.from("NODE18-PORTABLE-LEASE\r\n", "utf8");
  writeFileSync(path, Buffer.concat([
    walRecord(1, lifecycle, 1, 1),
    walRecord(2, output, 2, 2),
  ]), { mode: 0o600 });
}

async function waitForExit(client, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!client.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!client.closed) throw new Error("SIGKILLed replay worker did not exit in time");
}

async function openReplacement(options, milliseconds) {
  const deadline = Date.now() + milliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await createTerminalReplayWorkerClient(options);
    } catch (error) {
      lastError = error;
      if (error?.code !== "OPEN_FAILED" || !String(error.message).includes("active writer")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`replacement did not acquire the portable lease: ${String(lastError)}`);
}

const started = Date.now();
const root = mkdtempSync(join(tmpdir(), "thumbmux-node18-packed-lock-"));
const walPath = join(root, "output.wal");
const stateDir = join(root, "materialized");
writeSmokeWal(walPath);
const options = {
  materializer: { walPath, stateDir },
  requestTimeoutMs: 30_000,
  shutdownGraceMs: 2_000,
};

let holder = null;
let replacement = null;
try {
  const attempts = await Promise.allSettled([
    createTerminalReplayWorkerClient(options),
    createTerminalReplayWorkerClient(options),
  ]);
  const winners = attempts.flatMap((attempt) => (
    attempt.status === "fulfilled" ? [attempt.value] : []
  ));
  const losers = attempts.filter((attempt) => attempt.status === "rejected");
  if (winners.length !== 1 || losers.length !== 1) {
    throw new Error(`portable lease race admitted ${winners.length} winners`);
  }
  const loserReason = losers[0].reason;
  if (loserReason?.code !== "OPEN_FAILED"
    || !String(loserReason.message).includes("active writer")) {
    throw new Error(`portable lease contender failed unexpectedly: ${String(loserReason)}`);
  }
  holder = winners[0];
  if (!holder.lastResult.verified || holder.lastResult.sequence !== 2n) {
    throw new Error("portable lease winner did not materialize the packed WAL");
  }
  if (!existsSync(join(stateDir, "replay-writer-lock.json"))
    || !existsSync(join(stateDir, "replay-writer-lock.flock"))) {
    throw new Error("Node 18 did not exercise the portable replay writer lease");
  }

  const killedPid = holder.pid;
  process.kill(killedPid, "SIGKILL");
  await waitForExit(holder, 5_000);
  await holder.close();
  holder = null;

  replacement = await openReplacement(options, 5_000);
  if (!replacement.lastResult.verified
    || replacement.lastResult.sequence !== 2n
    || replacement.lastResult.recoveredFromCheckpoint !== true) {
    throw new Error("replacement did not recover the packed WAL checkpoint after SIGKILL");
  }
  console.log(JSON.stringify({
    runtime: process.version,
    contenders: 2,
    winners: 1,
    killedPid,
    replacementPid: replacement.pid,
    recovered: true,
    elapsedMs: Date.now() - started,
  }));
} finally {
  await replacement?.close();
  await holder?.close();
  rmSync(root, { recursive: true, force: true });
}
