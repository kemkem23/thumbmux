// src/integrations/terminal-replay-worker.ts
import {
  spawn as spawn2
} from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/terminal-replay-materializer.ts
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  constants as constants2,
  existsSync as existsSync2,
  fdatasyncSync as fdatasyncSync2,
  fchmodSync,
  fstatSync as fstatSync2,
  fsyncSync as fsyncSync2,
  lstatSync,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  openSync as openSync2,
  readFileSync,
  readSync as readSync2,
  realpathSync,
  renameSync,
  rmSync,
  statSync as statSync2,
  truncateSync as truncateSync2,
  unlinkSync,
  writeSync as writeSync2
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// src/output-wal.ts
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync
} from "node:fs";
var MAGIC = Buffer.from("THMWAL01", "ascii");
var VERSION = 1;
var HEADER_BYTES = 40;
var CHECKSUM_INPUT_BYTES = 24;
var DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
var KIND_TO_CODE = {
  lifecycle: 1,
  output: 2,
  resize: 3,
  checkpoint: 4
};
var CODE_TO_KIND = new Map(Object.entries(KIND_TO_CODE).map(([kind, code]) => [code, kind]));
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0;n < 256; n++) {
    let value = n;
    for (let bit = 0;bit < 8; bit++) {
      value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}
var CRC_TABLE = makeCrcTable();
function crc32Parts(parts) {
  let crc = 4294967295;
  for (const part of parts) {
    for (let index = 0;index < part.byteLength; index++) {
      crc = CRC_TABLE[(crc ^ part[index]) & 255] ^ crc >>> 8;
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
function readExact(fd, buffer, offset, length, position) {
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, offset + read, length - read, position + read);
    if (count === 0)
      break;
    read += count;
  }
  return read;
}
function positivePayloadLimit(value) {
  const limit = value ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("thumbmux output WAL maxPayloadBytes must be a positive safe integer");
  }
  return limit;
}
function safeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`thumbmux output WAL ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}
function parseHeader(header, offset, previousSequence, previousAt, maxPayloadBytes) {
  if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    return { kind: "corrupt", offset, message: `invalid WAL magic at byte ${offset}` };
  }
  if (header.readUInt8(8) !== VERSION) {
    return { kind: "corrupt", offset, message: `unsupported WAL version at byte ${offset}` };
  }
  const kind = CODE_TO_KIND.get(header.readUInt8(9));
  if (!kind) {
    return { kind: "corrupt", offset, message: `unknown WAL record kind at byte ${offset}` };
  }
  if (header.readUInt16LE(10) !== 0 || header.readUInt32LE(36) !== 0) {
    return { kind: "corrupt", offset, message: `non-zero reserved WAL header field at byte ${offset}` };
  }
  const payloadLength = header.readUInt32LE(12);
  if (payloadLength > maxPayloadBytes) {
    return {
      kind: "corrupt",
      offset,
      message: `WAL payload at byte ${offset} exceeds ${maxPayloadBytes} bytes`
    };
  }
  const sequence = header.readBigUInt64LE(16);
  if (sequence !== previousSequence + 1n) {
    return {
      kind: "corrupt",
      offset,
      message: `non-contiguous WAL sequence at byte ${offset}: ${sequence} after ${previousSequence}`
    };
  }
  const at = safeNumber(header.readBigUInt64LE(24), "timestamp");
  if (at < previousAt) {
    return {
      kind: "corrupt",
      offset,
      message: `decreasing WAL timestamp at byte ${offset}: ${at} after ${previousAt}`
    };
  }
  return {
    kind,
    payloadLength,
    sequence,
    at,
    checksum: header.readUInt32LE(32)
  };
}
function fileIdentity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}
function createOutputWalStartCursor(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    return {
      offset: 0,
      lastSequence: 0n,
      lastAt: 0,
      ...fileIdentity(fstatSync(fd))
    };
  } finally {
    closeSync(fd);
  }
}
function positiveBatchLimit(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`thumbmux output WAL ${label} must be a positive safe integer`);
  }
  return selected;
}
function readOutputWalTail(path, cursor, options = {}) {
  const maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
  const maxRecords = positiveBatchLimit(options.maxRecords, 1024, "maxRecords");
  const maxFrameBytes = positiveBatchLimit(options.maxFrameBytes, 64 * 1024 * 1024, "maxFrameBytes");
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.lastSequence < 0n || !Number.isSafeInteger(cursor.lastAt) || cursor.lastAt < 0 || !/^\d+$/.test(cursor.device) || !/^\d+$/.test(cursor.inode)) {
    throw new Error("thumbmux output WAL tail cursor is invalid");
  }
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    const identity = fileIdentity(stat);
    if (identity.device !== cursor.device || identity.inode !== cursor.inode) {
      throw new Error("thumbmux output WAL was replaced after the trusted tail cursor");
    }
    if (stat.size < cursor.offset) {
      throw new Error("thumbmux output WAL was truncated behind the trusted tail cursor");
    }
    let offset = cursor.offset;
    let lastSequence = cursor.lastSequence;
    let lastAt = cursor.lastAt;
    let frameBytes = 0;
    let incompleteTail = false;
    const records = [];
    while (offset < stat.size && records.length < maxRecords) {
      const remaining = stat.size - offset;
      if (remaining < HEADER_BYTES) {
        incompleteTail = true;
        break;
      }
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      if (readExact(fd, header, 0, HEADER_BYTES, offset) !== HEADER_BYTES) {
        incompleteTail = true;
        break;
      }
      const parsed = parseHeader(header, offset, lastSequence, lastAt, maxPayloadBytes);
      if ("message" in parsed)
        throw new Error(parsed.message);
      const recordBytes = HEADER_BYTES + parsed.payloadLength;
      if (remaining < recordBytes) {
        incompleteTail = true;
        break;
      }
      if (records.length > 0 && frameBytes + recordBytes > maxFrameBytes)
        break;
      const payload = Buffer.allocUnsafe(parsed.payloadLength);
      if (parsed.payloadLength > 0 && readExact(fd, payload, 0, parsed.payloadLength, offset + HEADER_BYTES) !== parsed.payloadLength) {
        incompleteTail = true;
        break;
      }
      const checksum = crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]);
      if (checksum !== parsed.checksum) {
        throw new Error(`WAL checksum mismatch at byte ${offset}`);
      }
      const nextOffset = offset + recordBytes;
      records.push({
        offset,
        nextOffset,
        sequence: parsed.sequence,
        at: parsed.at,
        kind: parsed.kind,
        payload
      });
      offset = nextOffset;
      lastSequence = parsed.sequence;
      lastAt = parsed.at;
      frameBytes += recordBytes;
    }
    return {
      records,
      cursor: { offset, lastSequence, lastAt, ...identity },
      incompleteTail,
      hasMore: !incompleteTail && offset < stat.size
    };
  } finally {
    closeSync(fd);
  }
}
function parseOutputWalJson(record) {
  if (record.kind === "output") {
    throw new Error("thumbmux output WAL output records are binary, not JSON");
  }
  return JSON.parse(Buffer.from(record.payload).toString("utf8"));
}

// src/terminal-replay-materializer.ts
var CHECKPOINT_VERSION = 1;
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var DEFAULT_REPLAY_CHUNK_BYTES = 16 * 1024;
var DEFAULT_HISTORY_CAPTURE_ROWS = 256;
var DEFAULT_COMMAND_TIMEOUT_MS = 1e4;
var DEFAULT_HISTORY_LIMIT = 65536;
var DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH = 1024 * 1024;
var COMMAND_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
var MAX_COLS = 4096;
var MAX_ROWS = 4096;
var MAX_CELLS = 4194304;
var REPLAY_WRITER_LOCK_FILE = "replay-writer-lock.sqlite";
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}
function positiveInteger(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return selected;
}
function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function parseGeometry(value, label) {
  if (!isObject(value))
    throw new Error(`${label} must be an object`);
  const cols = safeInteger(value.cols, `${label}.cols`, 1);
  const rows = safeInteger(value.rows, `${label}.rows`, 1);
  if (cols > MAX_COLS || rows > MAX_ROWS || cols * rows > MAX_CELLS) {
    throw new Error(`${label} exceeds the replay geometry bound`);
  }
  return { cols, rows };
}
function parseIdentity(value, label) {
  if (!isObject(value))
    throw new Error(`${label} must be an object`);
  const optional = (field) => value[field] === undefined ? undefined : nonEmptyString(value[field], `${label}.${field}`);
  return {
    session: nonEmptyString(value.session, `${label}.session`),
    instanceId: nonEmptyString(value.instanceId, `${label}.instanceId`),
    paneTarget: nonEmptyString(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: safeInteger(value.tmuxServerPid, `${label}.tmuxServerPid`, 1),
    sessionCreated: safeInteger(value.sessionCreated, `${label}.sessionCreated`, 0),
    ...optional("sessionId") === undefined ? {} : { sessionId: optional("sessionId") },
    ...optional("windowId") === undefined ? {} : { windowId: optional("windowId") },
    ...optional("paneId") === undefined ? {} : { paneId: optional("paneId") },
    ...optional("generation") === undefined ? {} : { generation: optional("generation") }
  };
}
function parseLifecycle(value) {
  if (!isObject(value))
    throw new Error("lifecycle WAL payload must be an object");
  if (value.event !== "start" && value.event !== "resume" && value.event !== "end") {
    throw new Error("lifecycle.event must be start, resume, or end");
  }
  return {
    event: value.event,
    identity: parseIdentity(value.identity, "lifecycle.identity"),
    geometry: parseGeometry(value.geometry, "lifecycle.geometry")
  };
}
function parseResize(value) {
  if (!isObject(value))
    throw new Error("resize WAL payload must be an object");
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error("resize.phase must be prepare, commit, or abort");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("resize.reason must be a string when present");
  }
  return {
    phase: value.phase,
    changeId: nonEmptyString(value.changeId, "resize.changeId"),
    from: parseGeometry(value.from, "resize.from"),
    to: parseGeometry(value.to, "resize.to"),
    ...value.reason === undefined ? {} : { reason: value.reason }
  };
}
function parseBarrier(value) {
  if (!isObject(value) || value.event !== "barrier") {
    throw new Error("checkpoint WAL payload must be a barrier object");
  }
  return {
    event: "barrier",
    requestId: nonEmptyString(value.requestId, "checkpoint.requestId")
  };
}
function sameGeometry(a, b) {
  return a.cols === b.cols && a.rows === b.rows;
}
function sameIdentity(a, b) {
  return a.session === b.session && a.instanceId === b.instanceId && a.paneTarget === b.paneTarget && a.tmuxServerPid === b.tmuxServerPid && a.sessionCreated === b.sessionCreated && a.sessionId === b.sessionId && a.windowId === b.windowId && a.paneId === b.paneId && a.generation === b.generation;
}
function sameResize(a, b) {
  return a.changeId === b.changeId && sameGeometry(a.from, b.from) && sameGeometry(a.to, b.to);
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function writeAll(fd, bytes, position) {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync2(fd, bytes, written, bytes.byteLength - written, position === undefined ? null : position + written);
    if (count <= 0)
      throw new Error("terminal replay write made no progress");
    written += count;
  }
}
function readExact2(fd, length, position) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync2(fd, bytes, read, length - read, position + read);
    if (count === 0)
      break;
    read += count;
  }
  if (read !== length) {
    throw new Error(`terminal replay expected ${length} bytes at ${position}, got ${read}`);
  }
  return bytes;
}
function fsyncDirectory(path) {
  const fd = openSync2(path, constants2.O_RDONLY | (constants2.O_DIRECTORY ?? 0));
  try {
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
}
function ensurePrivateDirectory(path) {
  const absolute = resolve(path);
  const missing = [];
  let cursor = absolute;
  while (!existsSync2(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`cannot find an existing ancestor for terminal replay directory ${absolute}`);
    }
    cursor = parent;
  }
  const requireRealDirectory = (directory) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
      throw new Error(`terminal replay path is not a real directory: ${directory}`);
    }
  };
  requireRealDirectory(cursor);
  for (const directory of missing.reverse()) {
    try {
      mkdirSync2(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
    }
    requireRealDirectory(directory);
    chmodSync2(directory, PRIVATE_DIRECTORY_MODE);
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
  }
  requireRealDirectory(absolute);
  chmodSync2(absolute, PRIVATE_DIRECTORY_MODE);
  fsyncDirectory(absolute);
  fsyncDirectory(dirname(absolute));
}
var PORTABLE_REPLAY_WRITER_LOCK_FILE = "replay-writer-lock.json";
var PORTABLE_REPLAY_KERNEL_LOCK_FILE = "replay-writer-lock.flock";
var FRESH_PORTABLE_LOCK_MS = 2000;
var PORTABLE_LOCK_HELPER_TIMEOUT_MS = 3000;
var PORTABLE_LOCK_HELPER = String.raw`
import fcntl, os, sys

lock_path, ready_path, contended_path, released_path, token = sys.argv[1:]
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        marker = os.open(contended_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(marker, token.encode("utf-8"))
        os.fsync(marker)
        os.close(marker)
        sys.exit(73)
    marker = os.open(ready_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(marker, token.encode("utf-8"))
    os.fsync(marker)
    os.close(marker)
    graceful_release = sys.stdin.buffer.read(1)
    fcntl.flock(fd, fcntl.LOCK_UN)
    if graceful_release:
        marker = os.open(released_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(marker, token.encode("utf-8"))
        os.fsync(marker)
        os.close(marker)
finally:
    os.close(fd)
`;
function waitForMarker(path, token, deadline) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, "utf8") === token)
        return true;
    } catch {}
    Atomics.wait(sleeper, 0, 0, 5);
  }
  return false;
}

class PortableReplayKernelLease {
  helper;
  readyPath;
  contendedPath;
  releasedPath;
  token;
  released = false;
  constructor(helper, readyPath, contendedPath, releasedPath, token) {
    this.helper = helper;
    this.readyPath = readyPath;
    this.contendedPath = contendedPath;
    this.releasedPath = releasedPath;
    this.token = token;
  }
  static acquire(stateDir) {
    const token = crypto.randomUUID();
    const lockPath = join(stateDir, PORTABLE_REPLAY_KERNEL_LOCK_FILE);
    const readyPath = join(stateDir, `.replay-writer-flock-ready-${token}`);
    const contendedPath = join(stateDir, `.replay-writer-flock-contended-${token}`);
    const releasedPath = join(stateDir, `.replay-writer-flock-released-${token}`);
    const helper = spawn("python3", ["-c", PORTABLE_LOCK_HELPER, lockPath, readyPath, contendedPath, releasedPath, token], { stdio: ["pipe", "ignore", "ignore"] });
    helper.on("error", () => {});
    helper.stdin?.on("error", () => {});
    if (!helper.pid) {
      helper.kill("SIGKILL");
      throw new Error("terminal replay portable writer lock helper did not start");
    }
    const deadline = Date.now() + PORTABLE_LOCK_HELPER_TIMEOUT_MS;
    for (;; ) {
      if (waitForMarker(readyPath, token, Math.min(deadline, Date.now() + 10))) {
        try {
          unlinkSync(readyPath);
        } catch {}
        return new PortableReplayKernelLease(helper, readyPath, contendedPath, releasedPath, token);
      }
      if (waitForMarker(contendedPath, token, Math.min(deadline, Date.now() + 10))) {
        try {
          unlinkSync(contendedPath);
        } catch {}
        helper.kill("SIGKILL");
        throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
      }
      if (Date.now() >= deadline) {
        helper.kill("SIGKILL");
        for (const path of [readyPath, contendedPath, releasedPath]) {
          try {
            unlinkSync(path);
          } catch {}
        }
        throw new Error("terminal replay portable writer lock helper timed out");
      }
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    this.helper.stdin?.write(Buffer.from([0]));
    const unlocked = waitForMarker(this.releasedPath, this.token, Date.now() + PORTABLE_LOCK_HELPER_TIMEOUT_MS);
    this.helper.stdin?.destroy();
    if (!unlocked)
      this.helper.kill("SIGKILL");
    for (const path of [this.readyPath, this.contendedPath, this.releasedPath]) {
      try {
        unlinkSync(path);
      } catch {}
    }
    if (!unlocked)
      throw new Error("terminal replay portable writer lock helper did not release");
  }
}
function isMissingSqliteRuntime(error) {
  return isObject(error) && (error.code === "MODULE_NOT_FOUND" || error.code === "ERR_UNKNOWN_BUILTIN_MODULE");
}
function openReplayWriterLockDatabase(path) {
  const runtimeRequire = createRequire(import.meta.url);
  let bunLoadError;
  try {
    const sqlite = runtimeRequire("bun:sqlite");
    return new sqlite.Database(path, { create: true, readwrite: true, strict: true });
  } catch (error) {
    if (!isMissingSqliteRuntime(error))
      throw error;
    bunLoadError = error;
  }
  try {
    const sqlite = runtimeRequire("node:sqlite");
    return new sqlite.DatabaseSync(path);
  } catch (nodeError) {
    if (!isMissingSqliteRuntime(nodeError))
      throw nodeError;
    return null;
  }
}
function currentBootId() {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!value)
    throw new Error("portable terminal replay lock cannot read the Linux boot id");
  return value;
}
function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0)
      return null;
    return stat.slice(close + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}
function readPortableClaim(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || typeof value.bootId !== "string" || typeof value.processStartTicks !== "string")
      return null;
    return value;
  } catch {
    return null;
  }
}
function portableClaimIsAlive(claim, bootId) {
  return claim.bootId === bootId && processStartTicks(claim.pid) === claim.processStartTicks;
}

class PortableReplayWriterLease {
  path;
  directory;
  fd;
  claim;
  kernelLease;
  released = false;
  constructor(path, directory, fd, claim, kernelLease) {
    this.path = path;
    this.directory = directory;
    this.fd = fd;
    this.claim = claim;
    this.kernelLease = kernelLease;
  }
  static acquire(stateDir) {
    const kernelLease = PortableReplayKernelLease.acquire(stateDir);
    try {
      const path = join(stateDir, PORTABLE_REPLAY_WRITER_LOCK_FILE);
      const stalePath = `${path}.stale`;
      const bootId = currentBootId();
      const startTicks = processStartTicks(process.pid);
      if (!startTicks)
        throw new Error("portable terminal replay lock cannot read its process start time");
      const claim = {
        token: crypto.randomUUID(),
        pid: process.pid,
        bootId,
        processStartTicks: startTicks
      };
      const body = Buffer.from(`${JSON.stringify(claim)}
`, "utf8");
      const create = () => {
        let fd;
        try {
          fd = openSync2(path, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
        } catch (error) {
          if (error.code === "EEXIST")
            return null;
          throw error;
        }
        try {
          writeAll(fd, body);
          fdatasyncSync2(fd);
          fsyncDirectory(stateDir);
          return new PortableReplayWriterLease(path, stateDir, fd, claim, kernelLease);
        } catch (error) {
          closeSync2(fd);
          try {
            unlinkSync(path);
          } catch {}
          throw error;
        }
      };
      for (let attempt = 0;attempt < 8; attempt += 1) {
        const created = create();
        if (created)
          return created;
        const existing = readPortableClaim(path);
        if (!existing) {
          try {
            const age = Date.now() - statSync2(path).mtimeMs;
            if (age >= 0 && age < FRESH_PORTABLE_LOCK_MS) {
              throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes("active writer"))
              throw error;
          }
        }
        if (existing && portableClaimIsAlive(existing, bootId)) {
          throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
        }
        try {
          unlinkSync(stalePath);
        } catch {}
        try {
          renameSync(path, stalePath);
        } catch (error) {
          if (error.code === "ENOENT")
            continue;
          throw error;
        }
        const quarantined = readPortableClaim(stalePath);
        if (quarantined && portableClaimIsAlive(quarantined, bootId)) {
          try {
            if (!existsSync2(path))
              renameSync(stalePath, path);
            else
              unlinkSync(stalePath);
          } catch {}
          throw new Error(`terminal replay state already has an active writer: ${stateDir}`);
        }
        try {
          unlinkSync(stalePath);
        } catch {}
        fsyncDirectory(stateDir);
      }
      throw new Error(`terminal replay portable writer lock is contended: ${stateDir}`);
    } catch (error) {
      kernelLease.release();
      throw error;
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    try {
      closeSync2(this.fd);
    } catch {}
    try {
      const current = readPortableClaim(this.path);
      if (current?.token === this.claim.token) {
        try {
          unlinkSync(this.path);
          fsyncDirectory(this.directory);
        } catch {}
      }
    } finally {
      this.kernelLease.release();
    }
  }
}
function isSqliteLockContention(error) {
  if (!isObject(error))
    return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" || error.code === "ERR_SQLITE_ERROR" && typeof error.message === "string" && /\b(?:database|database table) is locked\b/i.test(error.message);
}

class TerminalReplayWriterLease {
  database;
  released = false;
  constructor(database) {
    this.database = database;
  }
  static acquire(stateDir) {
    ensurePrivateDirectory(stateDir);
    const lockPath = join(stateDir, REPLAY_WRITER_LOCK_FILE);
    const existed = existsSync2(lockPath);
    const lockFd = openSync2(lockPath, constants2.O_CREAT | constants2.O_RDWR | constants2.O_DSYNC | (constants2.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
    try {
      if (!fstatSync2(lockFd).isFile()) {
        throw new Error(`terminal replay writer lock is not a regular file: ${lockPath}`);
      }
      fchmodSync(lockFd, PRIVATE_FILE_MODE);
      fdatasyncSync2(lockFd);
    } finally {
      closeSync2(lockFd);
    }
    if (!existed)
      fsyncDirectory(stateDir);
    let database = null;
    try {
      database = openReplayWriterLockDatabase(lockPath);
      if (!database)
        return PortableReplayWriterLease.acquire(stateDir);
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec(`
        CREATE TABLE IF NOT EXISTS replay_writer_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
        )
      `);
      database.exec("BEGIN IMMEDIATE");
      return new TerminalReplayWriterLease(database);
    } catch (error) {
      if (database) {
        try {
          database.close();
        } catch {}
      }
      if (isSqliteLockContention(error)) {
        throw new Error(`terminal replay state already has an active writer: ${stateDir}`, { cause: error });
      }
      throw error;
    }
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    try {
      this.database.exec("ROLLBACK");
    } catch {}
    try {
      this.database.close();
    } catch {}
  }
}
function writeAtomicJson(path, value) {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  const body = Buffer.from(`${JSON.stringify(value)}
`, "utf8");
  const fd = openSync2(temporary, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
  try {
    writeAll(fd, body);
    fdatasyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
  try {
    renameSync(temporary, path);
    chmodSync2(path, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
function validBase64(value, label) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}
function parseScreen(value) {
  if (!isObject(value))
    throw new Error("checkpoint.screen must be an object");
  const geometry = parseGeometry(value, "checkpoint.screen");
  const cursorX = safeInteger(value.cursorX, "checkpoint.screen.cursorX", 0);
  const cursorY = safeInteger(value.cursorY, "checkpoint.screen.cursorY", 0);
  if (cursorX >= geometry.cols || cursorY >= geometry.rows) {
    throw new Error("checkpoint screen cursor lies outside its geometry");
  }
  for (const field of ["cursorVisible", "alternateOn", "mouseSgr", "mouseAny"]) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`checkpoint.screen.${field} must be boolean`);
    }
  }
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: value.cursorVisible,
    alternateOn: value.alternateOn,
    mouseSgr: value.mouseSgr,
    mouseAny: value.mouseAny,
    cellsBase64: validBase64(value.cellsBase64, "checkpoint.screen.cellsBase64"),
    pendingEscapeBase64: validBase64(value.pendingEscapeBase64, "checkpoint.screen.pendingEscapeBase64")
  };
}
function parseCheckpoint(value) {
  if (!isObject(value) || value.version !== CHECKPOINT_VERSION) {
    throw new Error(`unsupported terminal replay checkpoint version`);
  }
  if (!isObject(value.cursor))
    throw new Error("checkpoint.cursor must be an object");
  const sequence = nonEmptyString(value.cursor.sequence, "checkpoint.cursor.sequence");
  if (!/^(0|[1-9][0-9]*)$/.test(sequence)) {
    throw new Error("checkpoint.cursor.sequence must be an unsigned decimal bigint");
  }
  if (value.lifecycle !== "none" && value.lifecycle !== "active" && value.lifecycle !== "ended") {
    throw new Error("checkpoint.lifecycle is invalid");
  }
  const identity = value.identity === null ? null : parseIdentity(value.identity, "checkpoint.identity");
  const geometry = value.geometry === null ? null : parseGeometry(value.geometry, "checkpoint.geometry");
  const pendingResize = value.pendingResize === null ? null : parseResize(value.pendingResize);
  const screen = value.screen === null ? null : parseScreen(value.screen);
  if (value.lifecycle === "none" && (identity || geometry || screen || pendingResize)) {
    throw new Error("empty checkpoint must not carry terminal state");
  }
  if (value.lifecycle !== "none" && (!identity || !geometry || !screen)) {
    throw new Error("active/ended checkpoint is missing terminal state");
  }
  if (geometry && screen && !sameGeometry(geometry, screen)) {
    throw new Error("checkpoint geometry and screen geometry differ");
  }
  if (pendingResize && pendingResize.phase !== "prepare") {
    throw new Error("checkpoint.pendingResize must be a prepare record");
  }
  if (value.lifecycle !== "active" && pendingResize) {
    throw new Error("only an active checkpoint may carry a pending resize");
  }
  return {
    version: 1,
    walPath: nonEmptyString(value.walPath, "checkpoint.walPath"),
    cursor: {
      walOffset: safeInteger(value.cursor.walOffset, "checkpoint.cursor.walOffset", 0),
      sequence
    },
    historyBytes: safeInteger(value.historyBytes, "checkpoint.historyBytes", 0),
    lifecycle: value.lifecycle,
    identity,
    geometry,
    pendingResize,
    screen
  };
}
function readTerminalReplayCheckpoint(path) {
  if (!existsSync2(path))
    return null;
  let decoded;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse terminal replay checkpoint ${path}: ${String(error)}`);
  }
  return parseCheckpoint(decoded);
}
function sameScreen(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameNullableIdentity(a, b) {
  return a === null ? b === null : b !== null && sameIdentity(a, b);
}
function sameNullableGeometry(a, b) {
  return a === null ? b === null : b !== null && sameGeometry(a, b);
}
function sameNullableResize(a, b) {
  return a === null ? b === null : b !== null && a.phase === b.phase && sameResize(a, b);
}

class MaterializedHistoryFile {
  path;
  fd;
  committedBytes;
  derivedBytes = 0;
  writePosition;
  constructor(path, checkpoint) {
    this.path = path;
    const directory = dirname(path);
    ensurePrivateDirectory(directory);
    const existed = existsSync2(path);
    this.fd = openSync2(path, constants2.O_CREAT | constants2.O_RDWR | constants2.O_DSYNC, PRIVATE_FILE_MODE);
    chmodSync2(path, PRIVATE_FILE_MODE);
    if (!existed)
      fsyncDirectory(directory);
    this.committedBytes = checkpoint?.historyBytes ?? 0;
    const currentBytes = fstatSync2(this.fd).size;
    if (currentBytes < this.committedBytes) {
      this.close();
      throw new Error(`materialized history is ${currentBytes} bytes, below committed ${this.committedBytes}`);
    }
    if (currentBytes > this.committedBytes) {
      truncateSync2(path, this.committedBytes);
      fdatasyncSync2(this.fd);
    }
    this.writePosition = this.committedBytes;
  }
  accept(bytes, mode) {
    if (bytes.byteLength === 0)
      return;
    if (mode === "verify") {
      if (this.derivedBytes + bytes.byteLength > this.committedBytes) {
        throw new Error("replayed history exceeds the committed checkpoint length");
      }
      const expected = readExact2(this.fd, bytes.byteLength, this.derivedBytes);
      if (!expected.equals(Buffer.from(bytes))) {
        throw new Error(`replayed history differs at byte ${this.derivedBytes}`);
      }
    } else {
      if (this.derivedBytes !== this.writePosition) {
        throw new Error(`materialized history cursor diverged: ${this.derivedBytes}/${this.writePosition}`);
      }
      writeAll(this.fd, bytes, this.writePosition);
      this.writePosition += bytes.byteLength;
    }
    this.derivedBytes += bytes.byteLength;
  }
  finishVerification() {
    if (this.derivedBytes !== this.committedBytes) {
      throw new Error(`replayed history length ${this.derivedBytes} differs from committed ${this.committedBytes}`);
    }
  }
  flush() {
    fdatasyncSync2(this.fd);
  }
  get bytes() {
    return this.writePosition;
  }
  close() {
    if (this.fd < 0)
      return;
    fdatasyncSync2(this.fd);
    closeSync2(this.fd);
    this.fd = -1;
  }
}

class StatefulVtReplayChunker {
  maxBatchBytes;
  rowEffectBudget;
  batchParts = [];
  batchBytes = 0;
  batchRowEffect = 0;
  pendingParts = [];
  pendingLength = 0;
  pendingIsCsi = false;
  pendingUtf8Expected = 0;
  constructor(maxBatchBytes, rowEffectBudget) {
    this.maxBatchBytes = maxBatchBytes;
    this.rowEffectBudget = rowEffectBudget;
  }
  flush(emit) {
    if (this.batchBytes === 0)
      return;
    emit(Buffer.concat(this.batchParts, this.batchBytes));
    this.batchParts.length = 0;
    this.batchBytes = 0;
    this.batchRowEffect = 0;
  }
  addAtomic(token, rowEffect, emit) {
    if (this.batchBytes > 0 && (this.batchBytes + token.byteLength > this.maxBatchBytes || this.batchRowEffect + rowEffect > this.rowEffectBudget)) {
      this.flush(emit);
    }
    this.batchParts.push(token);
    this.batchBytes += token.byteLength;
    this.batchRowEffect += rowEffect;
    if (this.batchBytes >= this.maxBatchBytes || this.batchRowEffect >= this.rowEffectBudget) {
      this.flush(emit);
    }
  }
  addOrdinary(bytes, emit) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.batchBytes >= this.maxBatchBytes || this.batchRowEffect >= this.rowEffectBudget) {
        this.flush(emit);
      }
      const availableBytes = this.maxBatchBytes - this.batchBytes;
      const availableRows = this.rowEffectBudget - this.batchRowEffect;
      const take = Math.min(bytes.byteLength - offset, availableBytes, availableRows);
      if (take <= 0) {
        this.flush(emit);
        continue;
      }
      this.batchParts.push(Buffer.from(bytes.subarray(offset, offset + take)));
      this.batchBytes += take;
      this.batchRowEffect += take;
      offset += take;
    }
  }
  appendPending(bytes) {
    if (bytes.byteLength === 0)
      return;
    this.pendingParts.push(Buffer.from(bytes));
    this.pendingLength += bytes.byteLength;
  }
  takePending() {
    const pending = Buffer.concat(this.pendingParts, this.pendingLength);
    this.pendingParts = [];
    this.pendingLength = 0;
    this.pendingIsCsi = false;
    this.pendingUtf8Expected = 0;
    return pending;
  }
  utf8Length(first) {
    if (first >= 194 && first <= 223)
      return 2;
    if (first >= 224 && first <= 239)
      return 3;
    if (first >= 240 && first <= 244)
      return 4;
    return 1;
  }
  csiRowEffect(token, rows) {
    const final = token[token.byteLength - 1];
    if (final !== 83)
      return token.byteLength;
    const parameter = token.subarray(2, -1).toString("ascii");
    if (!/^[0-9]*$/.test(parameter))
      return rows;
    const requested = parameter === "" || parameter === "0" ? 1 : Math.min(Number(parameter), rows);
    return Math.max(1, Math.min(requested, rows));
  }
  accept(bytes, rows, emit) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.pendingLength > 0) {
        if (this.pendingUtf8Expected > 0) {
          const needed = this.pendingUtf8Expected - this.pendingLength;
          const take = Math.min(needed, bytes.byteLength - offset);
          this.appendPending(bytes.subarray(offset, offset + take));
          offset += take;
          if (this.pendingLength === this.pendingUtf8Expected) {
            const token2 = this.takePending();
            this.addAtomic(token2, token2.byteLength, emit);
          }
          continue;
        }
        if (!this.pendingIsCsi) {
          const next = bytes[offset];
          this.appendPending(bytes.subarray(offset, offset + 1));
          offset += 1;
          if (next === 91) {
            this.pendingIsCsi = true;
          } else {
            const token2 = this.takePending();
            this.addAtomic(token2, token2.byteLength, emit);
          }
          continue;
        }
        let end = offset;
        while (end < bytes.byteLength && !(bytes[end] >= 64 && bytes[end] <= 126)) {
          end += 1;
        }
        if (end === bytes.byteLength) {
          this.appendPending(bytes.subarray(offset));
          offset = bytes.byteLength;
          break;
        }
        this.appendPending(bytes.subarray(offset, end + 1));
        offset = end + 1;
        const token = this.takePending();
        this.addAtomic(token, this.csiRowEffect(token, rows), emit);
        continue;
      }
      let special = offset;
      while (special < bytes.byteLength && bytes[special] !== 27 && bytes[special] < 128) {
        special += 1;
      }
      if (special > offset) {
        this.addOrdinary(bytes.subarray(offset, special), emit);
        offset = special;
      }
      if (offset < bytes.byteLength && bytes[offset] === 27) {
        this.appendPending(bytes.subarray(offset, offset + 1));
        this.pendingIsCsi = false;
        offset += 1;
      } else if (offset < bytes.byteLength) {
        const expected = this.utf8Length(bytes[offset]);
        if (expected === 1) {
          this.addOrdinary(bytes.subarray(offset, offset + 1), emit);
          offset += 1;
        } else if (offset + expected <= bytes.byteLength) {
          const token = Buffer.from(bytes.subarray(offset, offset + expected));
          this.addAtomic(token, token.byteLength, emit);
          offset += expected;
        } else {
          this.appendPending(bytes.subarray(offset));
          this.pendingUtf8Expected = expected;
          offset = bytes.byteLength;
        }
      }
    }
    this.flush(emit);
  }
  get pendingBytes() {
    return Buffer.concat(this.pendingParts, this.pendingLength);
  }
  reset() {
    this.batchParts.length = 0;
    this.batchBytes = 0;
    this.batchRowEffect = 0;
    this.pendingParts = [];
    this.pendingLength = 0;
    this.pendingIsCsi = false;
    this.pendingUtf8Expected = 0;
  }
}

class PrivateTmuxReplay {
  command;
  replayChunkBytes;
  historyCaptureRows;
  historyLimit;
  commandTimeoutMs;
  temporaryRoot;
  mirrorPath;
  inputFifoPath;
  configPath;
  session;
  target;
  socketPath;
  started = false;
  inputFd = -1;
  peakMirrorBytes = 0;
  chunker;
  constructor(options) {
    this.command = options.command;
    this.replayChunkBytes = options.replayChunkBytes;
    this.historyCaptureRows = options.historyCaptureRows;
    this.historyLimit = options.historyLimit;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.chunker = new StatefulVtReplayChunker(this.replayChunkBytes, Math.max(1, this.historyLimit - MAX_ROWS));
    if (options.socketPath && !isAbsolute(options.socketPath)) {
      throw new Error("terminal replay socketPath must be absolute");
    }
    if (options.socketPath && existsSync2(options.socketPath)) {
      throw new Error(`terminal replay socket already exists: ${options.socketPath}`);
    }
    this.temporaryRoot = mkdtempSync(join(tmpdir(), "thumbmux-terminal-replay-"));
    chmodSync2(this.temporaryRoot, PRIVATE_DIRECTORY_MODE);
    this.mirrorPath = join(this.temporaryRoot, "raw-output.mirror");
    const mirrorFd = openSync2(this.mirrorPath, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY, PRIVATE_FILE_MODE);
    closeSync2(mirrorFd);
    this.inputFifoPath = join(this.temporaryRoot, "replay-input.fifo");
    const fifo = spawnSync("mkfifo", ["-m", "600", this.inputFifoPath], {
      encoding: null,
      timeout: this.commandTimeoutMs,
      windowsHide: true
    });
    if (fifo.error || fifo.status !== 0 || !statSync2(this.inputFifoPath).isFIFO()) {
      const detail = Buffer.from(fifo.stderr ?? []).toString("utf8").trim();
      rmSync(this.temporaryRoot, { recursive: true, force: true });
      throw new Error(`cannot create private replay FIFO${detail ? `: ${detail}` : ""}`);
    }
    this.configPath = join(this.temporaryRoot, "tmux.conf");
    const configFd = openSync2(this.configPath, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_DSYNC, PRIVATE_FILE_MODE);
    try {
      writeAll(configFd, Buffer.from(`set-option -g history-limit ${this.historyLimit}
set-option -g status off
`, "utf8"));
      fdatasyncSync2(configFd);
    } finally {
      closeSync2(configFd);
    }
    fsyncDirectory(this.temporaryRoot);
    this.socketPath = options.socketPath ?? join(this.temporaryRoot, "tmux.sock");
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    this.session = `sh-thumbmux-replay-${suffix}`;
    this.target = `=${this.session}:0.0`;
  }
  run(args, input) {
    const result = spawnSync(this.command, ["-S", this.socketPath, ...args], {
      input,
      encoding: null,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      timeout: this.commandTimeoutMs,
      windowsHide: true
    });
    if (result.error) {
      throw new Error(`private tmux ${args[0] ?? "command"} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim();
      throw new Error(`private tmux ${args[0] ?? "command"} exited ${String(result.status)}` + (detail ? `: ${detail}` : ""));
    }
    return Buffer.from(result.stdout ?? []);
  }
  format(format) {
    return this.run(["display-message", "-p", "-t", this.target, format]).toString("utf8").replace(/\n$/, "");
  }
  waitFor(description, predicate) {
    const deadline = Date.now() + this.commandTimeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        if (predicate())
          return;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      sleepSync(2);
    }
    throw new Error(`timed out waiting for private tmux ${description}` + (lastError ? `: ${String(lastError)}` : ""));
  }
  replayCommand() {
    const quotedFifo = `'${this.inputFifoPath.replaceAll("'", "'\\''")}'`;
    return `stty raw -echo; exec cat -- ${quotedFifo}`;
  }
  attachMirror() {
    truncateSync2(this.mirrorPath, 0);
    const quotedMirror = `'${this.mirrorPath.replaceAll("'", "'\\''")}'`;
    this.run([
      "pipe-pane",
      "-O",
      "-t",
      this.target,
      `exec cat >> ${quotedMirror}`
    ]);
    this.waitFor("pipe attachment", () => this.format("#{pane_pipe}") === "1");
  }
  waitForCat() {
    this.waitFor("cat startup", () => {
      const [command, dead] = this.format("#{pane_current_command}|#{pane_dead}").split("|");
      if (dead === "1")
        throw new Error("private replay pane died during startup");
      return command === "cat";
    });
  }
  start(geometry) {
    if (this.started)
      throw new Error("private terminal replay pane already exists");
    this.run([
      "-f",
      this.configPath,
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows),
      this.replayCommand()
    ]);
    this.started = true;
    this.waitForCat();
    const configuredLimit = safeInteger(Number(this.run(["show-options", "-gv", "history-limit"]).toString("utf8").trim()), "private replay history-limit", 1);
    if (configuredLimit !== this.historyLimit) {
      throw new Error(`private replay history-limit is ${configuredLimit}, expected ${this.historyLimit}`);
    }
    this.run(["clear-history", "-t", this.target]);
    this.attachMirror();
    this.inputFd = openSync2(this.inputFifoPath, constants2.O_WRONLY);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay pane started at ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
  }
  ensureAlive() {
    if (!this.started)
      throw new Error("private terminal replay pane is not started");
    if (this.format("#{pane_dead}") === "1") {
      throw new Error("private terminal replay pane died");
    }
  }
  waitForMirroredBytes(expected) {
    this.waitFor(`${expected.byteLength} mirrored output bytes`, () => {
      const size = statSync2(this.mirrorPath).size;
      this.peakMirrorBytes = Math.max(this.peakMirrorBytes, size);
      if (size > expected.byteLength) {
        throw new Error(`private replay emitted unexpected bytes: ${size} > ${expected.byteLength}`);
      }
      return size === expected.byteLength;
    });
    const mirrorFd = openSync2(this.mirrorPath, constants2.O_RDONLY);
    let actual;
    try {
      actual = readExact2(mirrorFd, expected.byteLength, 0);
    } finally {
      closeSync2(mirrorFd);
    }
    if (!actual.equals(Buffer.from(expected))) {
      throw new Error("private replay changed output bytes in the current replay batch");
    }
    truncateSync2(this.mirrorPath, 0);
    this.ensureAlive();
  }
  feedChunk(bytes) {
    if (bytes.byteLength === 0)
      return;
    if (this.inputFd < 0) {
      throw new Error("private replay FIFO writer is not open");
    }
    if (statSync2(this.mirrorPath).size !== 0) {
      throw new Error("private replay mirror was not empty at batch start");
    }
    writeAll(this.inputFd, bytes);
    this.waitForMirroredBytes(bytes);
  }
  feed(bytes, onHistory) {
    this.chunker.accept(bytes, this.currentGeometry().rows, (chunk) => {
      this.feedChunk(chunk);
      this.drainHistory(onHistory);
    });
    if (bytes.byteLength === 0)
      this.drainHistory(onHistory);
  }
  currentGeometry() {
    const [colsText, rowsText] = this.format("#{pane_width}|#{pane_height}").split("|");
    return {
      cols: safeInteger(Number(colsText), "private replay pane width", 1),
      rows: safeInteger(Number(rowsText), "private replay pane height", 1)
    };
  }
  resize(geometry, onHistory) {
    this.drainHistory(onHistory);
    this.run([
      "resize-window",
      "-t",
      this.target,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows)
    ]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay resize produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
    this.drainHistory(onHistory);
  }
  resizeUnseen(geometry) {
    this.discardHistory();
    this.run([
      "resize-window",
      "-t",
      this.target,
      "-x",
      String(geometry.cols),
      "-y",
      String(geometry.rows)
    ]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay resize produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
    this.discardHistory();
  }
  sealVisibleAndReset(geometry, onHistory) {
    this.drainHistory(onHistory);
    const oldScreen = this.captureScreen();
    onHistory(Buffer.from(oldScreen.cellsBase64, "base64"));
    this.resetGeneration(geometry);
  }
  discardUnseenAndReset(geometry) {
    this.resetGeneration(geometry);
  }
  resetGeneration(geometry) {
    if (this.inputFd < 0)
      throw new Error("private replay FIFO writer is not open");
    const previousWriter = this.inputFd;
    truncateSync2(this.mirrorPath, 0);
    this.run([
      "respawn-pane",
      "-k",
      "-t",
      this.target,
      this.replayCommand()
    ]);
    this.waitForCat();
    if (this.format("#{pane_pipe}") !== "1")
      this.attachMirror();
    const replacementWriter = openSync2(this.inputFifoPath, constants2.O_WRONLY);
    this.inputFd = replacementWriter;
    closeSync2(previousWriter);
    this.chunker.reset();
    this.run(["clear-history", "-t", this.target]);
    const current = this.currentGeometry();
    if (!sameGeometry(current, geometry)) {
      this.run([
        "resize-window",
        "-t",
        this.target,
        "-x",
        String(geometry.cols),
        "-y",
        String(geometry.rows)
      ]);
    }
    this.run(["clear-history", "-t", this.target]);
    const actual = this.currentGeometry();
    if (!sameGeometry(actual, geometry)) {
      throw new Error(`private replay generation reset produced ${actual.cols}x${actual.rows}, expected ${geometry.cols}x${geometry.rows}`);
    }
  }
  discardHistory() {
    this.run(["clear-history", "-t", this.target]);
    const remaining = this.historySize();
    if (remaining !== 0) {
      throw new Error(`private replay clear-history left ${remaining} rows`);
    }
  }
  historySize() {
    const text = this.format("#{history_size}");
    return safeInteger(Number(text), "private replay history_size", 0);
  }
  drainHistory(onHistory) {
    const historySize = this.historySize();
    if (historySize === 0)
      return;
    for (let start = -historySize;start <= -1; start += this.historyCaptureRows) {
      const end = Math.min(-1, start + this.historyCaptureRows - 1);
      const expectedRows = end - start + 1;
      const captured = this.run([
        "capture-pane",
        "-p",
        "-e",
        "-N",
        "-t",
        this.target,
        "-S",
        String(start),
        "-E",
        String(end)
      ]);
      let terminators = 0;
      for (const byte of captured)
        if (byte === 10)
          terminators += 1;
      if (terminators !== expectedRows) {
        throw new Error(`capture-pane returned ${terminators} rows, expected ${expectedRows}`);
      }
      onHistory(captured);
    }
    this.run(["clear-history", "-t", this.target]);
    const remaining = this.historySize();
    if (remaining !== 0) {
      throw new Error(`private replay clear-history left ${remaining} rows`);
    }
  }
  captureScreen() {
    const historySize = this.historySize();
    if (historySize !== 0) {
      throw new Error(`cannot checkpoint with ${historySize} undrained history rows`);
    }
    const statusFormat = [
      "#{cursor_x}",
      "#{cursor_y}",
      "#{pane_width}",
      "#{pane_height}",
      "#{history_size}",
      "#{cursor_flag}",
      "#{alternate_on}",
      "#{mouse_sgr_flag}",
      "#{mouse_any_flag}"
    ].join("|");
    const output = this.run([
      "display-message",
      "-p",
      "-t",
      this.target,
      statusFormat,
      ";",
      "capture-pane",
      "-p",
      "-e",
      "-N",
      "-t",
      this.target,
      "-S",
      "0",
      "-E",
      "-",
      ";",
      "capture-pane",
      "-p",
      "-P",
      "-t",
      this.target
    ]);
    const statusEnd = output.indexOf(10);
    if (statusEnd < 0)
      throw new Error("private replay screen status has no terminator");
    const status = output.subarray(0, statusEnd).toString("utf8").split("|");
    if (status.length !== 9)
      throw new Error("private replay screen status is malformed");
    const [x, y, cols, rows, history, cursor, alternate, mouseSgr, mouseAny] = status.map(Number);
    if (history !== 0)
      throw new Error("private replay history changed during checkpoint capture");
    const geometry = parseGeometry({ cols, rows }, "private replay checkpoint geometry");
    let screenEnd = statusEnd + 1;
    for (let row = 0;row < geometry.rows; row += 1) {
      screenEnd = output.indexOf(10, screenEnd);
      if (screenEnd < 0)
        throw new Error("private replay screen capture is truncated");
      screenEnd += 1;
    }
    const cells = output.subarray(statusEnd + 1, screenEnd);
    const pendingWithTerminator = output.subarray(screenEnd);
    if (pendingWithTerminator.byteLength === 0 || pendingWithTerminator[pendingWithTerminator.byteLength - 1] !== 10) {
      throw new Error("private replay pending-sequence capture has no terminator");
    }
    const tmuxPending = pendingWithTerminator.subarray(0, -1);
    const pending = Buffer.concat([tmuxPending, this.chunker.pendingBytes]);
    const cursorX = safeInteger(x, "private replay cursor_x", 0);
    const cursorY = safeInteger(y, "private replay cursor_y", 0);
    if (cursorX >= geometry.cols || cursorY >= geometry.rows) {
      throw new Error("private replay cursor lies outside pane geometry");
    }
    return {
      ...geometry,
      cursorX,
      cursorY,
      cursorVisible: cursor === 1,
      alternateOn: alternate === 1,
      mouseSgr: mouseSgr === 1,
      mouseAny: mouseAny === 1,
      cellsBase64: cells.toString("base64"),
      pendingEscapeBase64: pending.toString("base64")
    };
  }
  close() {
    if (this.started) {
      try {
        this.run(["pipe-pane", "-t", this.target]);
      } catch {}
      try {
        this.run(["kill-server"]);
      } catch {}
      this.started = false;
    }
    if (this.inputFd >= 0) {
      try {
        closeSync2(this.inputFd);
      } catch {}
      this.inputFd = -1;
    }
    if (existsSync2(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    rmSync(this.temporaryRoot, { recursive: true, force: true });
  }
  get boundedMirrorPath() {
    return this.mirrorPath;
  }
  get peakBoundedMirrorBytes() {
    return this.peakMirrorBytes;
  }
}

class ReplayEngine {
  tmux;
  lifecycle = "none";
  identity = null;
  geometry = null;
  pendingResize = null;
  recordsSeen = 0;
  hasOutputInGeneration = false;
  constructor(tmux) {
    this.tmux = tmux;
  }
  requireActive(record) {
    if (this.lifecycle !== "active" || !this.identity || !this.geometry) {
      throw new Error(`WAL ${record.kind} record ${record.sequence} appears outside an active lifecycle`);
    }
  }
  requireLogicalIdentity(next, label) {
    if (!this.identity || next.session !== this.identity.session || next.instanceId !== this.identity.instanceId) {
      throw new Error(`${label} changes the WAL logical session identity`);
    }
  }
  processLifecycle(record, value, onHistory) {
    if (value.event === "start") {
      if (this.recordsSeen !== 0 || this.lifecycle !== "none") {
        throw new Error("lifecycle start must be the first WAL record and may appear only once");
      }
      this.tmux.start(value.geometry);
      this.lifecycle = "active";
      this.identity = value.identity;
      this.geometry = value.geometry;
      this.hasOutputInGeneration = false;
      return;
    }
    this.requireActive(record);
    this.requireLogicalIdentity(value.identity, `lifecycle ${value.event}`);
    if (this.pendingResize) {
      throw new Error(`lifecycle ${value.event} appears during prepared resize ${this.pendingResize.changeId}`);
    }
    if (value.event === "resume") {
      const generationChanged = value.identity.generation !== undefined && value.identity.generation !== this.identity.generation;
      if (generationChanged) {
        if (this.hasOutputInGeneration) {
          this.tmux.sealVisibleAndReset(value.geometry, onHistory);
        } else {
          this.tmux.discardUnseenAndReset(value.geometry);
        }
        this.hasOutputInGeneration = false;
      } else {
        if (this.hasOutputInGeneration) {
          this.tmux.drainHistory(onHistory);
        } else {
          this.tmux.discardHistory();
        }
        if (!sameGeometry(this.geometry, value.geometry)) {
          if (this.hasOutputInGeneration) {
            this.tmux.resize(value.geometry, onHistory);
          } else {
            this.tmux.resizeUnseen(value.geometry);
          }
        }
      }
      this.identity = value.identity;
      this.geometry = value.geometry;
      return;
    }
    if (!sameGeometry(this.geometry, value.geometry)) {
      throw new Error(`lifecycle end geometry ${value.geometry.cols}x${value.geometry.rows} differs from replay ${this.geometry.cols}x${this.geometry.rows}`);
    }
    if (this.hasOutputInGeneration) {
      this.tmux.drainHistory(onHistory);
    } else {
      this.tmux.discardHistory();
    }
    this.identity = value.identity;
    this.lifecycle = "ended";
  }
  processResize(record, value, onHistory) {
    this.requireActive(record);
    if (value.phase === "prepare") {
      if (this.pendingResize) {
        throw new Error(`resize prepare ${value.changeId} overlaps prepared ${this.pendingResize.changeId}`);
      }
      if (!sameGeometry(this.geometry, value.from)) {
        throw new Error(`resize prepare ${value.changeId} starts at ${value.from.cols}x${value.from.rows}, replay is ${this.geometry.cols}x${this.geometry.rows}`);
      }
      if (this.hasOutputInGeneration) {
        this.tmux.drainHistory(onHistory);
      } else {
        this.tmux.discardHistory();
      }
      this.pendingResize = value;
      return;
    }
    if (!this.pendingResize) {
      if (value.phase === "commit" && value.reason === "tmux-control-layout") {
        if (!sameGeometry(this.geometry, value.from)) {
          throw new Error(`authoritative resize ${value.changeId} source geometry changed`);
        }
        if (this.hasOutputInGeneration) {
          this.tmux.resize(value.to, onHistory);
        } else {
          this.tmux.resizeUnseen(value.to);
        }
        this.geometry = value.to;
        return;
      }
      throw new Error(`resize ${value.phase} ${value.changeId} has no matching prepare`);
    }
    if (!sameResize(this.pendingResize, value)) {
      throw new Error(`resize ${value.phase} ${value.changeId} does not match its prepare`);
    }
    if (!sameGeometry(this.geometry, value.from)) {
      throw new Error(`resize ${value.phase} ${value.changeId} source geometry changed`);
    }
    if (value.phase === "commit") {
      if (this.hasOutputInGeneration) {
        this.tmux.resize(value.to, onHistory);
      } else {
        this.tmux.resizeUnseen(value.to);
      }
      this.geometry = value.to;
    }
    this.pendingResize = null;
  }
  process(record, onHistory) {
    try {
      switch (record.kind) {
        case "lifecycle":
          this.processLifecycle(record, parseLifecycle(parseOutputWalJson(record)), onHistory);
          break;
        case "output":
          this.requireActive(record);
          if (this.pendingResize) {
            throw new Error(`output appears during prepared resize ${this.pendingResize.changeId}`);
          }
          if (record.payload.byteLength > 0) {
            this.tmux.feed(record.payload, onHistory);
            this.hasOutputInGeneration = true;
          }
          break;
        case "resize":
          this.processResize(record, parseResize(parseOutputWalJson(record)), onHistory);
          break;
        case "checkpoint":
          parseBarrier(parseOutputWalJson(record));
          break;
        default: {
          const exhaustive = record.kind;
          throw new Error(`unknown WAL record kind ${String(exhaustive)}`);
        }
      }
      this.recordsSeen += 1;
    } catch (error) {
      throw new Error(`terminal replay failed at WAL record ${record.sequence}: ${String(error)}`);
    }
  }
  snapshot() {
    return {
      lifecycle: this.lifecycle,
      identity: this.identity ? { ...this.identity } : null,
      geometry: this.geometry ? { ...this.geometry } : null,
      pendingResize: this.pendingResize ? {
        ...this.pendingResize,
        from: { ...this.pendingResize.from },
        to: { ...this.pendingResize.to }
      } : null,
      screen: this.lifecycle === "none" ? null : this.tmux.captureScreen()
    };
  }
  get hasPendingResize() {
    return this.pendingResize !== null;
  }
}
function assertCheckpointSnapshot(checkpoint, snapshot) {
  if (checkpoint.lifecycle !== snapshot.lifecycle) {
    throw new Error(`replayed lifecycle ${snapshot.lifecycle} differs from checkpoint ${checkpoint.lifecycle}`);
  }
  if (!sameNullableIdentity(checkpoint.identity, snapshot.identity)) {
    throw new Error("replayed lifecycle identity differs from checkpoint");
  }
  if (!sameNullableGeometry(checkpoint.geometry, snapshot.geometry)) {
    throw new Error("replayed geometry differs from checkpoint");
  }
  if (!sameNullableResize(checkpoint.pendingResize, snapshot.pendingResize)) {
    throw new Error("replayed pending resize differs from checkpoint");
  }
  if (!sameScreen(checkpoint.screen, snapshot.screen)) {
    throw new Error("replayed terminal screen/cursor differs from checkpoint");
  }
}

class TerminalReplayMaterializer {
  walPath;
  stateDir;
  historyPath;
  checkpointPath;
  tmuxCommand;
  socketPath;
  replayChunkBytes;
  historyCaptureRows;
  historyLimit;
  commandTimeoutMs;
  maxWalFrameBytesPerRefresh;
  recoveryTarget;
  constructor(options) {
    this.walPath = resolve(nonEmptyString(options.walPath, "walPath"));
    this.stateDir = resolve(nonEmptyString(options.stateDir, "stateDir"));
    this.historyPath = resolve(options.historyPath ?? join(this.stateDir, "history.ansi"));
    this.checkpointPath = resolve(options.checkpointPath ?? join(this.stateDir, "checkpoint.json"));
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    nonEmptyString(this.tmuxCommand, "tmuxCommand");
    this.socketPath = options.socketPath;
    this.replayChunkBytes = positiveInteger(options.replayChunkBytes, DEFAULT_REPLAY_CHUNK_BYTES, "replayChunkBytes");
    this.historyCaptureRows = positiveInteger(options.historyCaptureRows, DEFAULT_HISTORY_CAPTURE_ROWS, "historyCaptureRows");
    this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, "historyLimit");
    this.commandTimeoutMs = positiveInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
    this.maxWalFrameBytesPerRefresh = positiveInteger(options.maxWalFrameBytesPerRefresh, DEFAULT_MAX_WAL_FRAME_BYTES_PER_REFRESH, "maxWalFrameBytesPerRefresh");
    if (options.recoverySequence === undefined !== (options.recoveryWalOffset === undefined)) {
      throw new Error("recoverySequence and recoveryWalOffset must be supplied together");
    }
    if (options.recoverySequence !== undefined && options.recoveryWalOffset !== undefined) {
      if (!/^[1-9]\d*$/.test(options.recoverySequence)) {
        throw new Error("recoverySequence must be a positive decimal bigint");
      }
      const sequence = BigInt(options.recoverySequence);
      if (sequence > (1n << 64n) - 1n)
        throw new Error("recoverySequence exceeds uint64");
      if (!Number.isSafeInteger(options.recoveryWalOffset) || options.recoveryWalOffset <= 0) {
        throw new Error("recoveryWalOffset must be a positive safe integer");
      }
      this.recoveryTarget = { sequence, walOffset: options.recoveryWalOffset };
    } else {
      this.recoveryTarget = null;
    }
    if (this.historyLimit <= MAX_ROWS) {
      throw new Error(`historyLimit must be greater than the maximum replay pane height ${MAX_ROWS}`);
    }
    if (this.walPath === this.historyPath || this.walPath === this.checkpointPath) {
      throw new Error("terminal replay output paths must not overwrite the raw WAL");
    }
    if (this.historyPath === this.checkpointPath) {
      throw new Error("terminal replay historyPath and checkpointPath must differ");
    }
    ensurePrivateDirectory(this.stateDir);
  }
  open() {
    return new TerminalReplaySession({
      walPath: this.walPath,
      stateDir: this.stateDir,
      historyPath: this.historyPath,
      checkpointPath: this.checkpointPath,
      tmuxCommand: this.tmuxCommand,
      socketPath: this.socketPath,
      replayChunkBytes: this.replayChunkBytes,
      historyCaptureRows: this.historyCaptureRows,
      historyLimit: this.historyLimit,
      commandTimeoutMs: this.commandTimeoutMs,
      maxWalFrameBytesPerRefresh: this.maxWalFrameBytesPerRefresh,
      recoveryTarget: this.recoveryTarget
    });
  }
  materialize() {
    const session = this.open();
    try {
      let result = session.current;
      while (result.hasMoreWal)
        result = session.refresh();
      return result;
    } finally {
      session.close();
    }
  }
}

class TerminalReplaySession {
  walPath;
  historyPath;
  checkpointPath;
  writerLease;
  recoveredFromCheckpoint;
  maxWalFrameBytesPerRefresh;
  recoveryTarget;
  history;
  tmux;
  engine;
  lastOffset = 0;
  lastSequence = 0n;
  lastAt = 0;
  tailCursor = null;
  hasMoreWal = false;
  closed = false;
  result;
  constructor(options) {
    this.walPath = options.walPath;
    this.historyPath = options.historyPath;
    this.checkpointPath = options.checkpointPath;
    this.maxWalFrameBytesPerRefresh = options.maxWalFrameBytesPerRefresh;
    this.recoveryTarget = options.recoveryTarget;
    const writerLease = TerminalReplayWriterLease.acquire(options.stateDir);
    this.writerLease = writerLease;
    let checkpoint;
    try {
      checkpoint = readTerminalReplayCheckpoint(this.checkpointPath);
      if (checkpoint && resolve(checkpoint.walPath) !== this.walPath) {
        throw new Error(`checkpoint belongs to ${checkpoint.walPath}, not ${this.walPath}`);
      }
      if (checkpoint && this.recoveryTarget) {
        const checkpointSequence = BigInt(checkpoint.cursor.sequence);
        if (checkpoint.cursor.walOffset === this.recoveryTarget.walOffset && checkpointSequence !== this.recoveryTarget.sequence)
          throw new Error("terminal replay checkpoint target offset has a different sequence");
        if (checkpoint.cursor.walOffset > this.recoveryTarget.walOffset) {
          unlinkSync(this.checkpointPath);
          fsyncDirectory(dirname(this.checkpointPath));
          checkpoint = null;
        } else if (checkpoint.cursor.walOffset === this.recoveryTarget.walOffset) {
          this.recoveryTarget = null;
        }
      }
    } catch (error) {
      writerLease.release();
      throw error;
    }
    this.recoveredFromCheckpoint = checkpoint !== null;
    let history;
    try {
      history = new MaterializedHistoryFile(this.historyPath, checkpoint);
    } catch (error) {
      writerLease.release();
      throw error;
    }
    let tmux;
    try {
      tmux = new PrivateTmuxReplay({
        command: options.tmuxCommand,
        socketPath: options.socketPath,
        replayChunkBytes: options.replayChunkBytes,
        historyCaptureRows: options.historyCaptureRows,
        historyLimit: options.historyLimit,
        commandTimeoutMs: options.commandTimeoutMs
      });
    } catch (error) {
      try {
        history.close();
      } finally {
        writerLease.release();
      }
      throw error;
    }
    this.history = history;
    this.tmux = tmux;
    this.engine = new ReplayEngine(this.tmux);
    try {
      if (existsSync2(this.walPath)) {
        this.tailCursor = createOutputWalStartCursor(this.walPath);
      }
      const checkpointOffset = checkpoint?.cursor.walOffset ?? 0;
      let checkpointVerified = checkpoint === null;
      const verifyBoundary = () => {
        if (!checkpoint || checkpointVerified)
          return;
        if (this.lastOffset !== checkpointOffset)
          return;
        if (this.lastSequence !== BigInt(checkpoint.cursor.sequence)) {
          throw new Error(`replayed sequence ${this.lastSequence} differs from checkpoint ${checkpoint.cursor.sequence}`);
        }
        this.history.finishVerification();
        assertCheckpointSnapshot(checkpoint, this.engine.snapshot());
        checkpointVerified = true;
      };
      verifyBoundary();
      while (!checkpointVerified) {
        if (!this.tailCursor) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        const remaining = checkpointOffset - this.lastOffset;
        if (remaining <= 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
        }
        const batch = readOutputWalTail(this.walPath, this.tailCursor, {
          maxFrameBytes: Math.min(this.maxWalFrameBytesPerRefresh, remaining)
        });
        if (batch.records.length === 0) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
        for (const record of batch.records) {
          if (record.offset !== this.lastOffset) {
            throw new Error(`recovery WAL record begins at ${record.offset}, expected ${this.lastOffset}`);
          }
          if (record.nextOffset > checkpointOffset) {
            throw new Error(`checkpoint WAL cursor ${checkpointOffset} is not a record boundary`);
          }
          this.engine.process(record, (captured) => this.history.accept(captured, "verify"));
          this.lastOffset = record.nextOffset;
          this.lastSequence = record.sequence;
          this.lastAt = record.at;
        }
        if (batch.cursor.offset !== this.lastOffset || batch.cursor.lastSequence !== this.lastSequence || batch.cursor.lastAt !== this.lastAt) {
          throw new Error("recovery WAL cursor diverged from processed records");
        }
        this.tailCursor = batch.cursor;
        verifyBoundary();
        if (!checkpointVerified && !batch.hasMore) {
          throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
        }
      }
      if (!checkpointVerified) {
        throw new Error(`checkpoint WAL cursor ${checkpointOffset} is beyond the readable WAL`);
      }
      if (checkpoint) {
        this.hasMoreWal = this.peekTailHasMore();
      } else {
        this.consumeTail();
      }
      this.result = this.commitCheckpoint();
    } catch (error) {
      try {
        this.history.close();
      } finally {
        try {
          this.tmux.close();
        } finally {
          this.writerLease.release();
        }
      }
      this.closed = true;
      throw error;
    }
  }
  commitCheckpoint() {
    const snapshot = this.engine.snapshot();
    this.history.flush();
    const nextCheckpoint = {
      version: 1,
      walPath: this.walPath,
      cursor: {
        walOffset: this.lastOffset,
        sequence: this.lastSequence.toString()
      },
      historyBytes: this.history.bytes,
      lifecycle: snapshot.lifecycle,
      identity: snapshot.identity,
      geometry: snapshot.geometry,
      pendingResize: snapshot.pendingResize,
      screen: snapshot.screen
    };
    writeAtomicJson(this.checkpointPath, nextCheckpoint);
    const complete = snapshot.pendingResize === null;
    return {
      complete,
      verified: complete,
      recoveredFromCheckpoint: this.recoveredFromCheckpoint,
      ended: snapshot.lifecycle === "ended",
      walOffset: this.lastOffset,
      sequence: this.lastSequence,
      hasMoreWal: this.hasMoreWal,
      historyBytes: this.history.bytes,
      identity: snapshot.identity,
      geometry: snapshot.geometry,
      pendingResize: snapshot.pendingResize,
      screen: snapshot.screen,
      historyPath: this.historyPath,
      checkpointPath: this.checkpointPath
    };
  }
  get current() {
    return this.result;
  }
  get privateSocketPath() {
    return this.tmux.socketPath;
  }
  get privateMirrorPath() {
    return this.tmux.boundedMirrorPath;
  }
  get privatePeakMirrorBytes() {
    return this.tmux.peakBoundedMirrorBytes;
  }
  peekTailHasMore() {
    if (!this.tailCursor || !existsSync2(this.walPath))
      return false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxRecords: 1,
      maxFrameBytes: this.maxWalFrameBytesPerRefresh
    });
    return batch.records.length > 0 || batch.hasMore;
  }
  consumeTail() {
    if (!this.tailCursor) {
      if (!existsSync2(this.walPath)) {
        this.hasMoreWal = false;
        return false;
      }
      this.tailCursor = createOutputWalStartCursor(this.walPath);
    }
    const targetRemaining = this.recoveryTarget ? this.recoveryTarget.walOffset - this.lastOffset : null;
    if (targetRemaining !== null && targetRemaining <= 0) {
      if (this.lastOffset !== this.recoveryTarget.walOffset || this.lastSequence !== this.recoveryTarget.sequence)
        throw new Error("terminal replay recovery target is not an exact WAL cursor");
      this.recoveryTarget = null;
      this.hasMoreWal = this.peekTailHasMore();
      return false;
    }
    let changed = false;
    const batch = readOutputWalTail(this.walPath, this.tailCursor, {
      maxFrameBytes: targetRemaining === null ? this.maxWalFrameBytesPerRefresh : Math.min(this.maxWalFrameBytesPerRefresh, targetRemaining),
      ...this.engine.hasPendingResize ? { maxRecords: 1 } : {}
    });
    for (const record of batch.records) {
      if (record.offset !== this.lastOffset) {
        throw new Error(`incremental WAL record begins at ${record.offset}, expected ${this.lastOffset}`);
      }
      if (this.recoveryTarget && record.nextOffset > this.recoveryTarget.walOffset) {
        throw new Error("terminal replay recovery target is not a record boundary");
      }
      this.engine.process(record, (captured) => this.history.accept(captured, "append"));
      this.lastOffset = record.nextOffset;
      this.lastSequence = record.sequence;
      this.lastAt = record.at;
      changed = true;
    }
    if (batch.cursor.offset !== this.lastOffset || batch.cursor.lastSequence !== this.lastSequence || batch.cursor.lastAt !== this.lastAt) {
      throw new Error("incremental WAL cursor diverged from processed records");
    }
    this.tailCursor = batch.cursor;
    if (this.recoveryTarget && this.lastOffset === this.recoveryTarget.walOffset) {
      if (this.lastSequence !== this.recoveryTarget.sequence) {
        throw new Error("terminal replay recovery target sequence does not match its WAL offset");
      }
      this.recoveryTarget = null;
    }
    if (this.recoveryTarget && batch.records.length === 0) {
      throw new Error("terminal replay recovery target is beyond the readable WAL");
    }
    this.hasMoreWal = batch.hasMore || this.peekTailHasMore();
    return changed;
  }
  refresh() {
    if (this.closed)
      throw new Error("terminal replay session is closed");
    try {
      const previousHasMoreWal = this.hasMoreWal;
      const changed = this.consumeTail();
      if (changed || previousHasMoreWal !== this.hasMoreWal) {
        this.result = this.commitCheckpoint();
      }
      return this.result;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    try {
      this.history.close();
    } finally {
      try {
        this.tmux.close();
      } finally {
        this.writerLease.release();
      }
    }
  }
}

// src/integrations/terminal-replay-worker.ts
var TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION = 1;
var DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60000;
var DEFAULT_SHUTDOWN_GRACE_MS = 5000;
var DEFAULT_MAX_RESPONSE_FRAME_BYTES = 64 * 1024 * 1024;
var MAX_RESPONSE_FRAME_BYTES = 512 * 1024 * 1024;
var MAX_REQUEST_FRAME_BYTES = 1024 * 1024;
var MAX_REQUEST_TIMEOUT_MS = 30 * 60000;
var MAX_SHUTDOWN_GRACE_MS = 60000;
var MAX_PATH_BYTES = 4096;
var MAX_STRING_BYTES = 16384;
var MAX_ERROR_BYTES = 8192;
var MAX_STDERR_TAIL_BYTES = 16384;
var MAX_UINT64 = (1n << 64n) - 1n;

class TerminalReplayWorkerError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "TerminalReplayWorkerError";
    this.code = code;
  }
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label}.${key} is not allowed`);
  }
}
function boundedString(value, label, maximumBytes = MAX_STRING_BYTES, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes || value.includes("\x00")) {
    throw new Error(`${label} exceeds its byte bound or contains NUL`);
  }
  return value;
}
function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}
function booleanValue(value, label) {
  if (typeof value !== "boolean")
    throw new Error(`${label} must be boolean`);
  return value;
}
function parseGeometry2(value, label) {
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  exactKeys(value, ["cols", "rows"], [], label);
  const cols = boundedInteger(value.cols, `${label}.cols`, 1, 4096);
  const rows = boundedInteger(value.rows, `${label}.rows`, 1, 4096);
  if (cols * rows > 4194304)
    throw new Error(`${label} exceeds the cell bound`);
  return { cols, rows };
}
function parseIdentity2(value, label) {
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  const required = [
    "session",
    "instanceId",
    "paneTarget",
    "tmuxServerPid",
    "sessionCreated"
  ];
  const optional = ["sessionId", "windowId", "paneId", "generation"];
  exactKeys(value, required, optional, label);
  const result = {
    session: boundedString(value.session, `${label}.session`),
    instanceId: boundedString(value.instanceId, `${label}.instanceId`),
    paneTarget: boundedString(value.paneTarget, `${label}.paneTarget`),
    tmuxServerPid: boundedInteger(value.tmuxServerPid, `${label}.tmuxServerPid`, 1, Number.MAX_SAFE_INTEGER),
    sessionCreated: boundedInteger(value.sessionCreated, `${label}.sessionCreated`, 0, Number.MAX_SAFE_INTEGER)
  };
  for (const key of optional) {
    if (value[key] !== undefined)
      result[key] = boundedString(value[key], `${label}.${key}`);
  }
  return result;
}
function parseResize2(value, label) {
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  exactKeys(value, ["phase", "changeId", "from", "to"], ["reason"], label);
  if (value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "abort") {
    throw new Error(`${label}.phase is invalid`);
  }
  return {
    phase: value.phase,
    changeId: boundedString(value.changeId, `${label}.changeId`),
    from: parseGeometry2(value.from, `${label}.from`),
    to: parseGeometry2(value.to, `${label}.to`),
    ...value.reason === undefined ? {} : { reason: boundedString(value.reason, `${label}.reason`, MAX_STRING_BYTES, true) }
  };
}
function parseBase64(value, label) {
  const encoded = boundedString(value, label, MAX_RESPONSE_FRAME_BYTES, true);
  if (encoded.length % 4 !== 0 || encoded.length > 0 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${label} must be canonical base64`);
  }
  return encoded;
}
function parseScreen2(value, label) {
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  exactKeys(value, [
    "cols",
    "rows",
    "cursorX",
    "cursorY",
    "cursorVisible",
    "alternateOn",
    "mouseSgr",
    "mouseAny",
    "cellsBase64",
    "pendingEscapeBase64"
  ], [], label);
  const geometry = parseGeometry2({ cols: value.cols, rows: value.rows }, label);
  const cursorX = boundedInteger(value.cursorX, `${label}.cursorX`, 0, geometry.cols - 1);
  const cursorY = boundedInteger(value.cursorY, `${label}.cursorY`, 0, geometry.rows - 1);
  return {
    ...geometry,
    cursorX,
    cursorY,
    cursorVisible: booleanValue(value.cursorVisible, `${label}.cursorVisible`),
    alternateOn: booleanValue(value.alternateOn, `${label}.alternateOn`),
    mouseSgr: booleanValue(value.mouseSgr, `${label}.mouseSgr`),
    mouseAny: booleanValue(value.mouseAny, `${label}.mouseAny`),
    cellsBase64: parseBase64(value.cellsBase64, `${label}.cellsBase64`),
    pendingEscapeBase64: parseBase64(value.pendingEscapeBase64, `${label}.pendingEscapeBase64`)
  };
}
function parseNullable(value, parser, label) {
  return value === null ? null : parser(value, label);
}
function parseUint64Decimal(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal uint64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64)
    throw new Error(`${label} exceeds uint64`);
  return parsed;
}
function terminalReplayResultToWire(result) {
  return {
    complete: result.complete,
    verified: result.verified,
    recoveredFromCheckpoint: result.recoveredFromCheckpoint,
    ended: result.ended,
    walOffset: result.walOffset,
    sequence: result.sequence.toString(),
    hasMoreWal: result.hasMoreWal,
    historyBytes: result.historyBytes,
    identity: result.identity,
    geometry: result.geometry,
    pendingResize: result.pendingResize,
    screen: result.screen,
    historyPath: result.historyPath,
    checkpointPath: result.checkpointPath
  };
}
function terminalReplayResultFromWire(value) {
  const label = "terminal replay worker result";
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  exactKeys(value, [
    "complete",
    "verified",
    "recoveredFromCheckpoint",
    "ended",
    "walOffset",
    "sequence",
    "hasMoreWal",
    "historyBytes",
    "identity",
    "geometry",
    "pendingResize",
    "screen",
    "historyPath",
    "checkpointPath"
  ], [], label);
  const geometry = parseNullable(value.geometry, parseGeometry2, `${label}.geometry`);
  const screen = parseNullable(value.screen, parseScreen2, `${label}.screen`);
  if (geometry && screen && (geometry.cols !== screen.cols || geometry.rows !== screen.rows)) {
    throw new Error(`${label}.screen geometry differs from result geometry`);
  }
  return {
    complete: booleanValue(value.complete, `${label}.complete`),
    verified: booleanValue(value.verified, `${label}.verified`),
    recoveredFromCheckpoint: booleanValue(value.recoveredFromCheckpoint, `${label}.recoveredFromCheckpoint`),
    ended: booleanValue(value.ended, `${label}.ended`),
    walOffset: boundedInteger(value.walOffset, `${label}.walOffset`, 0, Number.MAX_SAFE_INTEGER),
    sequence: parseUint64Decimal(value.sequence, `${label}.sequence`),
    hasMoreWal: booleanValue(value.hasMoreWal, `${label}.hasMoreWal`),
    historyBytes: boundedInteger(value.historyBytes, `${label}.historyBytes`, 0, Number.MAX_SAFE_INTEGER),
    identity: parseNullable(value.identity, parseIdentity2, `${label}.identity`),
    geometry,
    pendingResize: parseNullable(value.pendingResize, parseResize2, `${label}.pendingResize`),
    screen,
    historyPath: boundedString(value.historyPath, `${label}.historyPath`, MAX_PATH_BYTES),
    checkpointPath: boundedString(value.checkpointPath, `${label}.checkpointPath`, MAX_PATH_BYTES)
  };
}
function normalizeMaterializerOptions(value) {
  const label = "terminal replay materializer options";
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  const optional = [
    "historyPath",
    "checkpointPath",
    "tmuxCommand",
    "socketPath",
    "replayChunkBytes",
    "historyCaptureRows",
    "historyLimit",
    "commandTimeoutMs",
    "maxWalFrameBytesPerRefresh",
    "recoverySequence",
    "recoveryWalOffset"
  ];
  exactKeys(value, ["walPath", "stateDir"], optional, label);
  const path = (key) => resolve2(boundedString(value[key], `${label}.${key}`, MAX_PATH_BYTES));
  const normalized = {
    walPath: path("walPath"),
    stateDir: path("stateDir")
  };
  if (value.historyPath !== undefined)
    normalized.historyPath = path("historyPath");
  if (value.checkpointPath !== undefined)
    normalized.checkpointPath = path("checkpointPath");
  if (value.tmuxCommand !== undefined) {
    normalized.tmuxCommand = boundedString(value.tmuxCommand, `${label}.tmuxCommand`, MAX_PATH_BYTES);
  }
  if (value.socketPath !== undefined) {
    const socketPath = boundedString(value.socketPath, `${label}.socketPath`, MAX_PATH_BYTES);
    if (!isAbsolute2(socketPath))
      throw new Error(`${label}.socketPath must be absolute`);
    normalized.socketPath = resolve2(socketPath);
  }
  if (value.replayChunkBytes !== undefined) {
    normalized.replayChunkBytes = boundedInteger(value.replayChunkBytes, `${label}.replayChunkBytes`, 1, 16 * 1024 * 1024);
  }
  if (value.historyCaptureRows !== undefined) {
    normalized.historyCaptureRows = boundedInteger(value.historyCaptureRows, `${label}.historyCaptureRows`, 1, 1e6);
  }
  if (value.historyLimit !== undefined) {
    normalized.historyLimit = boundedInteger(value.historyLimit, `${label}.historyLimit`, 4097, 1e7);
  }
  if (value.commandTimeoutMs !== undefined) {
    normalized.commandTimeoutMs = boundedInteger(value.commandTimeoutMs, `${label}.commandTimeoutMs`, 1, MAX_REQUEST_TIMEOUT_MS);
  }
  if (value.maxWalFrameBytesPerRefresh !== undefined) {
    normalized.maxWalFrameBytesPerRefresh = boundedInteger(value.maxWalFrameBytesPerRefresh, `${label}.maxWalFrameBytesPerRefresh`, 1, 256 * 1024 * 1024);
  }
  if (value.recoverySequence === undefined !== (value.recoveryWalOffset === undefined)) {
    throw new Error(`${label}.recoverySequence and recoveryWalOffset must be supplied together`);
  }
  if (value.recoverySequence !== undefined && value.recoveryWalOffset !== undefined) {
    const recoverySequence = boundedString(value.recoverySequence, `${label}.recoverySequence`, 20);
    if (!/^[1-9]\d*$/.test(recoverySequence) || BigInt(recoverySequence) > MAX_UINT64) {
      throw new Error(`${label}.recoverySequence must be a positive uint64 decimal`);
    }
    normalized.recoverySequence = recoverySequence;
    normalized.recoveryWalOffset = boundedInteger(value.recoveryWalOffset, `${label}.recoveryWalOffset`, 1, Number.MAX_SAFE_INTEGER);
  }
  return normalized;
}
function resolveTerminalReplayWorkerPath(value) {
  let workerPath;
  if (value instanceof URL) {
    if (value.protocol !== "file:")
      throw new Error("workerPath URL must use file:");
    workerPath = fileURLToPath(value);
  } else if (value !== undefined) {
    workerPath = resolve2(boundedString(value, "workerPath", MAX_PATH_BYTES));
  } else {
    const candidates = [
      fileURLToPath(new URL("./terminal-replay-worker-entry.js", import.meta.url)),
      fileURLToPath(new URL("../terminal-replay-worker-entry.ts", import.meta.url))
    ];
    workerPath = candidates.find((candidate) => existsSync3(candidate)) ?? candidates[0];
  }
  if (!existsSync3(workerPath)) {
    throw new Error(`terminal replay worker does not exist: ${workerPath}`);
  }
  return workerPath;
}
function normalizeClientOptions(value) {
  if (!isPlainObject(value))
    throw new Error("terminal replay worker client options must be an object");
  exactKeys(value, ["materializer"], [
    "runtimePath",
    "workerPath",
    "requestTimeoutMs",
    "shutdownGraceMs",
    "maxResponseFrameBytes"
  ], "terminal replay worker client options");
  const runtimePath = resolve2(boundedString(value.runtimePath ?? process.execPath, "runtimePath", MAX_PATH_BYTES));
  const workerPath = resolveTerminalReplayWorkerPath(value.workerPath);
  if (!existsSync3(runtimePath))
    throw new Error(`terminal replay runtime does not exist: ${runtimePath}`);
  return {
    materializer: normalizeMaterializerOptions(value.materializer),
    runtimePath,
    workerPath,
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 10, MAX_REQUEST_TIMEOUT_MS),
    shutdownGraceMs: boundedInteger(value.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs", 10, MAX_SHUTDOWN_GRACE_MS),
    maxResponseFrameBytes: boundedInteger(value.maxResponseFrameBytes ?? DEFAULT_MAX_RESPONSE_FRAME_BYTES, "maxResponseFrameBytes", 1024, MAX_RESPONSE_FRAME_BYTES)
  };
}
function encodeJsonFrame(value, maximumBytes, label) {
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable`, { cause: error });
  }
  if (encoded.byteLength === 0 || encoded.byteLength > maximumBytes) {
    throw new Error(`${label} is ${encoded.byteLength} bytes; limit is ${maximumBytes}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(encoded.byteLength, 0);
  return Buffer.concat([header, encoded], encoded.byteLength + 4);
}

class JsonFrameDecoder {
  maximumBytes;
  header = Buffer.allocUnsafe(4);
  headerBytes = 0;
  frameBytes = -1;
  received = 0;
  chunks = [];
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
  }
  push(chunkValue, onFrame) {
    const chunk = Buffer.from(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength);
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.frameBytes < 0) {
        const take2 = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + take2);
        this.headerBytes += take2;
        offset += take2;
        if (this.headerBytes < 4)
          continue;
        this.frameBytes = this.header.readUInt32BE(0);
        this.headerBytes = 0;
        if (this.frameBytes === 0 || this.frameBytes > this.maximumBytes) {
          throw new Error(`IPC frame length ${this.frameBytes} is outside 1..${this.maximumBytes}`);
        }
      }
      const take = Math.min(this.frameBytes - this.received, chunk.byteLength - offset);
      this.chunks.push(chunk.subarray(offset, offset + take));
      this.received += take;
      offset += take;
      if (this.received !== this.frameBytes)
        continue;
      const frame = this.chunks.length === 1 ? Buffer.from(this.chunks[0]) : Buffer.concat(this.chunks, this.frameBytes);
      this.frameBytes = -1;
      this.received = 0;
      this.chunks = [];
      onFrame(frame);
    }
  }
  finish() {
    if (this.headerBytes !== 0 || this.frameBytes >= 0) {
      throw new Error("IPC stream ended in the middle of a frame");
    }
  }
}
var fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
function decodeJson(frame, label) {
  try {
    return JSON.parse(fatalUtf8Decoder.decode(frame));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}
function parseRequest(value) {
  const label = "terminal replay worker request";
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`${label}.id has invalid characters`);
  if (value.command === "open") {
    exactKeys(value, [
      "protocol",
      "id",
      "command",
      "materializer",
      "maxResponseFrameBytes"
    ], [], label);
    return {
      protocol: 1,
      id,
      command: "open",
      materializer: normalizeMaterializerOptions(value.materializer),
      maxResponseFrameBytes: boundedInteger(value.maxResponseFrameBytes, `${label}.maxResponseFrameBytes`, 1024, MAX_RESPONSE_FRAME_BYTES)
    };
  }
  if (value.command !== "current" && value.command !== "refresh" && value.command !== "close") {
    throw new Error(`${label}.command is invalid`);
  }
  exactKeys(value, ["protocol", "id", "command"], [], label);
  return { protocol: 1, id, command: value.command };
}
function parseResponse(value) {
  const label = "terminal replay worker response";
  if (!isPlainObject(value))
    throw new Error(`${label} must be an object`);
  if (value.protocol !== TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION) {
    throw new Error(`${label}.protocol is unsupported`);
  }
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`${label}.id has invalid characters`);
  if (value.ok === true) {
    exactKeys(value, ["protocol", "id", "ok"], ["result"], label);
    return {
      protocol: 1,
      id,
      ok: true,
      ...value.result === undefined ? {} : { result: terminalReplayResultToWire(terminalReplayResultFromWire(value.result)) }
    };
  }
  if (value.ok !== false)
    throw new Error(`${label}.ok must be boolean`);
  exactKeys(value, ["protocol", "id", "ok", "error"], [], label);
  if (!isPlainObject(value.error))
    throw new Error(`${label}.error must be an object`);
  exactKeys(value.error, ["code", "message"], [], `${label}.error`);
  const code = boundedString(value.error.code, `${label}.error.code`, 64);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code))
    throw new Error(`${label}.error.code is invalid`);
  return {
    protocol: 1,
    id,
    ok: false,
    error: {
      code,
      message: boundedString(value.error.message, `${label}.error.message`, MAX_ERROR_BYTES, true)
    }
  };
}
function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message, "utf8");
  return encoded.byteLength <= MAX_ERROR_BYTES ? message : encoded.subarray(0, MAX_ERROR_BYTES).toString("utf8");
}
async function writeJsonFrame(stream, value, maximumBytes, label) {
  const frame = encodeJsonFrame(value, maximumBytes, label);
  await new Promise((resolveWrite, rejectWrite) => {
    stream.write(frame, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}
async function runTerminalReplayWorkerStdio(input = process.stdin, output = process.stdout) {
  const decoder = new JsonFrameDecoder(MAX_REQUEST_FRAME_BYTES);
  let session = null;
  let opened = false;
  let maxResponseFrameBytes = DEFAULT_MAX_RESPONSE_FRAME_BYTES;
  let signalReceived = false;
  const onSignal = () => {
    signalReceived = true;
    input.destroy();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    for await (const chunk of input) {
      const frames = [];
      decoder.push(chunk, (frame) => frames.push(frame));
      for (const frame of frames) {
        const request = parseRequest(decodeJson(frame, "terminal replay worker request"));
        if (request.command === "open") {
          if (opened) {
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "INVALID_STATE", message: "replay worker is already open" }
            }, maxResponseFrameBytes, "terminal replay worker response");
            continue;
          }
          maxResponseFrameBytes = request.maxResponseFrameBytes;
          try {
            session = new TerminalReplayMaterializer(request.materializer).open();
            opened = true;
            const response = {
              protocol: 1,
              id: request.id,
              ok: true,
              result: terminalReplayResultToWire(session.current)
            };
            await writeJsonFrame(output, response, maxResponseFrameBytes, "terminal replay worker response");
          } catch (error) {
            if (session)
              session.close();
            session = null;
            await writeJsonFrame(output, {
              protocol: 1,
              id: request.id,
              ok: false,
              error: { code: "OPEN_FAILED", message: errorMessage(error) }
            }, maxResponseFrameBytes, "terminal replay worker response");
            return 1;
          }
          continue;
        }
        if (!opened || !session) {
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "INVALID_STATE", message: "replay worker is not open" }
          }, maxResponseFrameBytes, "terminal replay worker response");
          continue;
        }
        if (request.command === "close") {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true
          }, maxResponseFrameBytes, "terminal replay worker response");
          return 0;
        }
        try {
          const result = request.command === "refresh" ? session.refresh() : session.current;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: true,
            result: terminalReplayResultToWire(result)
          }, maxResponseFrameBytes, "terminal replay worker response");
        } catch (error) {
          session.close();
          session = null;
          await writeJsonFrame(output, {
            protocol: 1,
            id: request.id,
            ok: false,
            error: { code: "MATERIALIZER_FAILED", message: errorMessage(error) }
          }, maxResponseFrameBytes, "terminal replay worker response");
          return 1;
        }
      }
    }
    if (!signalReceived)
      decoder.finish();
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (session)
      session.close();
  }
}

class ProcessTerminalReplayWorkerClient {
  child;
  options;
  decoder;
  pending = new Map;
  nextId = 1n;
  latestResult = null;
  terminalError = null;
  stdoutEnded = false;
  exited = false;
  terminating = false;
  closing = false;
  closePromise = null;
  queue = Promise.resolve();
  stderrTail = Buffer.alloc(0);
  exitPromise;
  resolveExit;
  constructor(options) {
    this.options = options;
    this.decoder = new JsonFrameDecoder(options.maxResponseFrameBytes);
    this.child = spawn2(options.runtimePath, [options.workerPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false
    });
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    this.attachProcessListeners();
  }
  get pid() {
    if (this.child.pid === undefined)
      throw new Error("terminal replay worker has no PID");
    return this.child.pid;
  }
  get closed() {
    return this.closing || this.exited;
  }
  get lastResult() {
    if (!this.latestResult)
      throw new Error("terminal replay worker has not opened");
    return this.latestResult;
  }
  diagnosticSuffix() {
    const stderr = this.stderrTail.toString("utf8").trim();
    return stderr.length === 0 ? "" : `; stderr: ${stderr}`;
  }
  attachProcessListeners() {
    this.child.stdout.on("data", (chunk) => {
      if (this.terminalError)
        return;
      try {
        this.decoder.push(chunk, (frame) => this.handleResponseFrame(frame));
      } catch (error) {
        this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `invalid replay worker stdout: ${errorMessage(error)}`, { cause: error }));
      }
    });
    this.child.stdout.on("end", () => {
      this.stdoutEnded = true;
      try {
        this.decoder.finish();
      } catch (error) {
        this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `replay worker stdout ended mid-frame: ${errorMessage(error)}`, { cause: error }));
        return;
      }
      if (!this.closing && !this.exited) {
        this.fail(new TerminalReplayWorkerError("UNEXPECTED_EOF", `replay worker stdout closed unexpectedly${this.diagnosticSuffix()}`));
      }
    });
    this.child.stderr.on("data", (chunk) => {
      const combined = Buffer.concat([this.stderrTail, chunk]);
      this.stderrTail = combined.byteLength <= MAX_STDERR_TAIL_BYTES ? combined : combined.subarray(combined.byteLength - MAX_STDERR_TAIL_BYTES);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) {
        this.fail(new TerminalReplayWorkerError("IPC_WRITE_FAILED", `cannot write to replay worker: ${error.message}`, { cause: error }));
      }
    });
    this.child.on("error", (error) => {
      this.fail(new TerminalReplayWorkerError("SPAWN_FAILED", `cannot start replay worker: ${error.message}`, { cause: error }));
    });
    const markExited = (code, signal) => {
      if (this.exited)
        return;
      this.exited = true;
      this.resolveExit();
      if (!this.closing && !this.terminalError) {
        this.fail(new TerminalReplayWorkerError("WORKER_EXITED", `replay worker exited with code ${String(code)} signal ${String(signal)}${this.diagnosticSuffix()}`));
      }
    };
    this.child.on("exit", markExited);
    this.child.on("close", markExited);
  }
  handleResponseFrame(frame) {
    let response;
    try {
      response = parseResponse(decodeJson(frame, "terminal replay worker response"));
    } catch (error) {
      throw new Error(errorMessage(error), { cause: error });
    }
    const pending = this.pending.get(response.id);
    if (!pending)
      throw new Error(`response has unknown or duplicate id ${response.id}`);
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (!response.ok) {
      pending.reject(new TerminalReplayWorkerError(response.error.code, response.error.message));
      return;
    }
    const expectsResult = pending.command !== "close";
    if (expectsResult !== (response.result !== undefined)) {
      pending.reject(new TerminalReplayWorkerError("PROTOCOL_ERROR", `response for ${pending.command} ${expectsResult ? "has no result" : "has an unexpected result"}`));
      this.fail(new TerminalReplayWorkerError("PROTOCOL_ERROR", `response shape does not match ${pending.command}`));
      return;
    }
    const result = response.result === undefined ? undefined : terminalReplayResultFromWire(response.result);
    if (result)
      this.latestResult = result;
    pending.resolve(result);
  }
  fail(error) {
    if (this.terminalError)
      return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.beginTerminate();
  }
  beginTerminate() {
    if (this.exited || this.terminating)
      return;
    this.terminating = true;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
    }, this.options.shutdownGraceMs);
    timer.unref?.();
  }
  send(command) {
    if (this.terminalError)
      return Promise.reject(this.terminalError);
    if (this.exited || this.stdoutEnded) {
      return Promise.reject(new TerminalReplayWorkerError("WORKER_EXITED", `replay worker is not running${this.diagnosticSuffix()}`));
    }
    const id = `r${this.nextId.toString(36)}`;
    this.nextId += 1n;
    const request = command === "open" ? {
      protocol: 1,
      id,
      command,
      materializer: this.options.materializer,
      maxResponseFrameBytes: this.options.maxResponseFrameBytes
    } : { protocol: 1, id, command };
    const frame = encodeJsonFrame(request, MAX_REQUEST_FRAME_BYTES, "terminal replay worker request");
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id))
          return;
        const error = new TerminalReplayWorkerError("REQUEST_TIMEOUT", `replay worker ${command} timed out after ${this.options.requestTimeoutMs}ms`);
        rejectRequest(error);
        this.fail(error);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        command,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest
      });
      this.child.stdin.write(frame, (error) => {
        if (!error)
          return;
        const failure = new TerminalReplayWorkerError("IPC_WRITE_FAILED", `cannot write ${command} to replay worker: ${error.message}`, { cause: error });
        this.fail(failure);
      });
    });
  }
  enqueue(command) {
    if (this.closing) {
      return Promise.reject(new TerminalReplayWorkerError("CLIENT_CLOSED", "replay worker is closed"));
    }
    const operation = this.queue.then(async () => {
      const result = await this.send(command);
      if (!result)
        throw new Error(`replay worker ${command} returned no result`);
      return result;
    });
    this.queue = operation.then(() => {
      return;
    }, () => {
      return;
    });
    return operation;
  }
  async open() {
    try {
      const result = await this.send("open");
      if (!result) {
        throw new TerminalReplayWorkerError("PROTOCOL_ERROR", "open returned no result");
      }
      this.latestResult = result;
    } catch (error) {
      this.fail(error instanceof TerminalReplayWorkerError ? error : new TerminalReplayWorkerError("OPEN_FAILED", errorMessage(error), { cause: error }));
      throw error;
    }
  }
  current() {
    return this.enqueue("current");
  }
  refresh() {
    return this.enqueue("refresh");
  }
  close() {
    if (this.closePromise)
      return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.then(async () => {
      if (!this.exited && !this.terminalError && !this.stdoutEnded) {
        try {
          await this.send("close");
          this.child.stdin.end();
        } catch {
          this.beginTerminate();
        }
      } else if (!this.exited) {
        this.beginTerminate();
      }
      if (!this.exited) {
        const timeout = new Promise((resolveTimeout) => {
          const timer = setTimeout(() => {
            this.beginTerminate();
            resolveTimeout();
          }, this.options.shutdownGraceMs);
          timer.unref?.();
        });
        await Promise.race([this.exitPromise, timeout]);
        if (!this.exited) {
          try {
            this.child.kill("SIGKILL");
          } catch {}
          await this.exitPromise;
        }
      }
    }, async () => {
      this.beginTerminate();
      await this.exitPromise;
    });
    return this.closePromise;
  }
}
async function createTerminalReplayWorkerClient(options) {
  const client = new ProcessTerminalReplayWorkerClient(normalizeClientOptions(options));
  try {
    await client.open();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

// src/terminal-replay-worker-entry.ts
try {
  const exitCode = await runTerminalReplayWorkerStdio();
  process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`thumbmux terminal replay worker failed: ${message}
`);
  process.exitCode = 1;
}
