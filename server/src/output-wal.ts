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
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Lossless terminal-output write-ahead log.
 *
 * Snapshot archives are a derived view: tmux may reflow them on resize and its
 * finite history ring may overflow during a burst. This WAL records the bytes
 * before either operation can discard information. Records are binary (not
 * UTF-8 text), checksummed, monotonically sequenced and forced to stable
 * storage before append returns.
 */

const MAGIC = Buffer.from("THMWAL01", "ascii");
const VERSION = 1;
export type OutputWalFormat = 1 | 2;
const HEADER_BYTES = 40;
const CHECKSUM_INPUT_BYTES = 24;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const KIND_TO_CODE = {
  lifecycle: 1,
  output: 2,
  resize: 3,
  checkpoint: 4,
  gap: 5,
  recovery: 6,
} as const;

const CODE_TO_KIND = new Map<number, OutputWalKind>(
  Object.entries(KIND_TO_CODE).map(([kind, code]) => [code, kind as OutputWalKind]),
);

export type OutputWalKind = keyof typeof KIND_TO_CODE;

export type OutputWalRecord = {
  /** Byte position of this record's header in the WAL. */
  offset: number;
  /** Byte position immediately after this record. Safe as a replay cursor. */
  nextOffset: number;
  sequence: bigint;
  at: number;
  kind: OutputWalKind;
  payload: Uint8Array;
};

export type OutputWalProblem = {
  kind: "torn" | "corrupt" | "unavailable";
  offset: number;
  message: string;
};

export type OutputWalScan = {
  validBytes: number;
  records: number;
  lastSequence: bigint;
  lastAt: number;
  problem: OutputWalProblem | null;
};

export type OutputWalRepair = {
  repaired: boolean;
  validBytes: number;
  quarantinedPath: string | null;
};

/** Stable identity and verified prefix position for incremental tail readers. */
export type OutputWalTailCursor = Readonly<{
  offset: number;
  lastSequence: bigint;
  lastAt: number;
  device: string;
  inode: string;
}>;

export type OutputWalTailRead = Readonly<{
  records: readonly OutputWalRecord[];
  cursor: OutputWalTailCursor;
  /** A concurrent writer had not completed its final frame yet; retry later. */
  incompleteTail: boolean;
  /** More complete records may remain after the configured batch bound. */
  hasMore: boolean;
}>;

export type OutputWalTailOptions = Readonly<{
  maxPayloadBytes?: number;
  maxRecords?: number;
  maxFrameBytes?: number;
}>;

export type OutputWalWriterOptions = {
  path: string;
  /** Must match an existing WAL; never upgrades or rewrites format 1. */
  format?: OutputWalFormat;
  clock?: () => number;
  maxPayloadBytes?: number;
  /** Tests can disable the automatic repair of an EOF-torn final record. */
  repairTornTail?: boolean;
};

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0
        ? (0xedb88320 ^ (value >>> 1))
        : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32Parts(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let index = 0; index < part.byteLength; index++) {
      crc = CRC_TABLE[(crc ^ part[index]!) & 0xff]! ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readExact(fd: number, buffer: Buffer, offset: number, length: number, position: number): number {
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, offset + read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return read;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(fd, bytes, written, bytes.byteLength - written);
    if (count <= 0) throw new Error("thumbmux output WAL write made no progress");
    written += count;
  }
}

function finiteTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("thumbmux output WAL timestamp must be a non-negative finite number");
  }
  return Math.floor(value);
}

function positivePayloadLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("thumbmux output WAL maxPayloadBytes must be a positive safe integer");
  }
  return limit;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`thumbmux output WAL ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function parseHeader(
  header: Buffer,
  offset: number,
  previousSequence: bigint,
  previousAt: number,
  maxPayloadBytes: number,
  expectedVersion?: number,
): {
  kind: OutputWalKind;
  payloadLength: number;
  sequence: bigint;
  at: number;
  checksum: number;
} | OutputWalProblem {
  if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    return { kind: "corrupt", offset, message: `invalid WAL magic at byte ${offset}` };
  }
  const version = header.readUInt8(8);
  if (version !== 1 && version !== 2) {
    return { kind: "unavailable", offset, message: `unavailable: unsupported WAL version at byte ${offset}` };
  }
  if (expectedVersion !== undefined && version !== expectedVersion) {
    return { kind: "corrupt", offset, message: `mixed WAL formats at byte ${offset}` };
  }
  const kind = CODE_TO_KIND.get(header.readUInt8(9));
  if (!kind || (version === 1 && (kind === "gap" || kind === "recovery"))) {
    return { kind: "unavailable", offset, message: `unavailable: unknown WAL record kind at byte ${offset}` };
  }
  if (header.readUInt16LE(10) !== 0 || header.readUInt32LE(36) !== 0) {
    return { kind: "corrupt", offset, message: `non-zero reserved WAL header field at byte ${offset}` };
  }

  const payloadLength = header.readUInt32LE(12);
  if (payloadLength > maxPayloadBytes) {
    return {
      kind: "corrupt",
      offset,
      message: `WAL payload at byte ${offset} exceeds ${maxPayloadBytes} bytes`,
    };
  }
  const sequence = header.readBigUInt64LE(16);
  if (sequence !== previousSequence + 1n) {
    return {
      kind: "corrupt",
      offset,
      message: `non-contiguous WAL sequence at byte ${offset}: ${sequence} after ${previousSequence}`,
    };
  }
  const at = safeNumber(header.readBigUInt64LE(24), "timestamp");
  if (at < previousAt) {
    return {
      kind: "corrupt",
      offset,
      message: `decreasing WAL timestamp at byte ${offset}: ${at} after ${previousAt}`,
    };
  }
  return {
    kind,
    payloadLength,
    sequence,
    at,
    checksum: header.readUInt32LE(32),
  };
}

/** Scan without loading the whole WAL into memory. */
export function scanOutputWal(path: string, options: { maxPayloadBytes?: number } = {}): OutputWalScan {
  const maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
  if (!existsSync(path)) {
    return { validBytes: 0, records: 0, lastSequence: 0n, lastAt: 0, problem: null };
  }

  const fd = openSync(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    const first = Buffer.alloc(HEADER_BYTES);
    readExact(fd, first, 0, HEADER_BYTES, 0);
    const expectedVersion = size >= HEADER_BYTES ? first.readUInt8(8) : undefined;
    let offset = 0;
    let records = 0;
    let lastSequence = 0n;
    let lastAt = 0;

    while (offset < size) {
      const remaining = size - offset;
      if (remaining < HEADER_BYTES) {
        return {
          validBytes: offset,
          records,
          lastSequence,
          lastAt,
          problem: { kind: "torn", offset, message: `torn WAL header at byte ${offset}` },
        };
      }

      const header = Buffer.allocUnsafe(HEADER_BYTES);
      if (readExact(fd, header, 0, HEADER_BYTES, offset) !== HEADER_BYTES) {
        return {
          validBytes: offset,
          records,
          lastSequence,
          lastAt,
          problem: { kind: "torn", offset, message: `torn WAL header at byte ${offset}` },
        };
      }
      const parsed = parseHeader(header, offset, lastSequence, lastAt, maxPayloadBytes, expectedVersion);
      if ("message" in parsed) {
        return { validBytes: offset, records, lastSequence, lastAt, problem: parsed };
      }
      if (remaining - HEADER_BYTES < parsed.payloadLength) {
        return {
          validBytes: offset,
          records,
          lastSequence,
          lastAt,
          problem: { kind: "torn", offset, message: `torn WAL payload at byte ${offset}` },
        };
      }

      const payload = Buffer.allocUnsafe(parsed.payloadLength);
      if (parsed.payloadLength > 0
        && readExact(fd, payload, 0, parsed.payloadLength, offset + HEADER_BYTES) !== parsed.payloadLength) {
        return {
          validBytes: offset,
          records,
          lastSequence,
          lastAt,
          problem: { kind: "torn", offset, message: `torn WAL payload at byte ${offset}` },
        };
      }
      const checksum = crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]);
      if (checksum !== parsed.checksum) {
        return {
          validBytes: offset,
          records,
          lastSequence,
          lastAt,
          problem: { kind: "corrupt", offset, message: `WAL checksum mismatch at byte ${offset}` },
        };
      }

      if (parsed.kind === "gap") {
        try {
          const gap = parseOutputWalGapPayload(payload);
          if (BigInt(gap.lastDurableSeq) !== parsed.sequence - 1n) throw new Error("invalid gap boundary");
        } catch (error) {
          return { validBytes: offset, records, lastSequence, lastAt,
            problem: { kind: "corrupt", offset, message: String(error) } };
        }
      }
      if (parsed.kind === "recovery") {
        try {
          parseOutputWalRecoveryPayload(payload);
        } catch (error) {
          return { validBytes: offset, records, lastSequence, lastAt,
            problem: { kind: "corrupt", offset, message: String(error) } };
        }
      }
      offset += HEADER_BYTES + parsed.payloadLength;
      records += 1;
      lastSequence = parsed.sequence;
      lastAt = parsed.at;
    }
    return { validBytes: offset, records, lastSequence, lastAt, problem: null };
  } finally {
    closeSync(fd);
  }
}

function fileIdentity(stat: ReturnType<typeof fstatSync>): { device: string; inode: string } {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

/**
 * Establish an inode-bound cursor at byte zero without scanning the backlog.
 * Each later `readOutputWalTail()` call still validates checksums, sequence,
 * timestamps, replacement, and truncation as it advances. This is the cursor
 * to use when recovery itself must make bounded progress.
 */
export function createOutputWalStartCursor(path: string): OutputWalTailCursor {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    return {
      offset: 0,
      lastSequence: 0n,
      lastAt: 0,
      ...fileIdentity(fstatSync(fd)),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Verify the complete current WAL once and return a trusted append cursor.
 * Long-running consumers persist this alongside their own atomic checkpoint,
 * then use `readOutputWalTail` so each refresh is O(new bytes), not O(all time).
 */
export function createOutputWalTailCursor(
  path: string,
  options: { maxPayloadBytes?: number } = {},
): OutputWalTailCursor {
  const beforeFd = openSync(path, constants.O_RDONLY);
  let before: ReturnType<typeof fstatSync>;
  try {
    before = fstatSync(beforeFd);
  } finally {
    closeSync(beforeFd);
  }
  const scan = scanOutputWal(path, options);
  if (scan.problem) throw new Error(scan.problem.message);
  const afterFd = openSync(path, constants.O_RDONLY);
  try {
    const after = fstatSync(afterFd);
    const left = fileIdentity(before);
    const right = fileIdentity(after);
    if (
      left.device !== right.device
      || left.inode !== right.inode
      || before.size !== after.size
      || after.size !== scan.validBytes
    ) {
      throw new Error("thumbmux output WAL changed while establishing a verified tail cursor");
    }
    return {
      offset: scan.validBytes,
      lastSequence: scan.lastSequence,
      lastAt: scan.lastAt,
      ...right,
    };
  } finally {
    closeSync(afterFd);
  }
}

function positiveBatchLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`thumbmux output WAL ${label} must be a positive safe integer`);
  }
  return selected;
}

/**
 * Read and validate only records appended after a trusted cursor. A short EOF
 * frame is normal while the sole writer is between bytes; it is never repaired
 * by a reader and will be retried. Complete corruption, replacement, sequence
 * discontinuity and truncation all fail closed.
 */
export function readOutputWalTail(
  path: string,
  cursor: OutputWalTailCursor,
  options: OutputWalTailOptions = {},
): OutputWalTailRead {
  const maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
  const maxRecords = positiveBatchLimit(options.maxRecords, 1_024, "maxRecords");
  const maxFrameBytes = positiveBatchLimit(options.maxFrameBytes, 64 * 1024 * 1024, "maxFrameBytes");
  if (
    !Number.isSafeInteger(cursor.offset)
    || cursor.offset < 0
    || cursor.lastSequence < 0n
    || !Number.isSafeInteger(cursor.lastAt)
    || cursor.lastAt < 0
    || !/^\d+$/.test(cursor.device)
    || !/^\d+$/.test(cursor.inode)
  ) {
    throw new Error("thumbmux output WAL tail cursor is invalid");
  }

  const fd = openSync(path, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    const first = Buffer.alloc(HEADER_BYTES);
    readExact(fd, first, 0, HEADER_BYTES, 0);
    const expectedVersion = stat.size >= HEADER_BYTES ? first.readUInt8(8) : undefined;
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
    const records: OutputWalRecord[] = [];

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
      const parsed = parseHeader(header, offset, lastSequence, lastAt, maxPayloadBytes, expectedVersion);
      if ("message" in parsed) throw new Error(parsed.message);
      const recordBytes = HEADER_BYTES + parsed.payloadLength;
      if (remaining < recordBytes) {
        incompleteTail = true;
        break;
      }
      // Always make progress by accepting one complete record, even when it is
      // larger than the caller's preferred batch byte budget.
      if (records.length > 0 && frameBytes + recordBytes > maxFrameBytes) break;
      const payload = Buffer.allocUnsafe(parsed.payloadLength);
      if (parsed.payloadLength > 0
        && readExact(fd, payload, 0, parsed.payloadLength, offset + HEADER_BYTES) !== parsed.payloadLength) {
        incompleteTail = true;
        break;
      }
      const checksum = crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]);
      if (checksum !== parsed.checksum) {
        throw new Error(`WAL checksum mismatch at byte ${offset}`);
      }
      if (parsed.kind === "gap") {
        const gap = parseOutputWalGapPayload(payload);
        if (BigInt(gap.lastDurableSeq) !== parsed.sequence - 1n) throw new Error("invalid gap boundary");
      }
      const nextOffset = offset + recordBytes;
      records.push({
        offset,
        nextOffset,
        sequence: parsed.sequence,
        at: parsed.at,
        kind: parsed.kind,
        payload,
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
      hasMore: !incompleteTail && offset < stat.size,
    };
  } finally {
    closeSync(fd);
  }
}

/** Iterate valid records from a known record boundary. */
export function* readOutputWal(
  path: string,
  options: { fromOffset?: number; maxPayloadBytes?: number } = {},
): Generator<OutputWalRecord> {
  const maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
  const fromOffset = options.fromOffset ?? 0;
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
    throw new Error("thumbmux output WAL fromOffset must be a non-negative safe integer");
  }
  if (!existsSync(path)) return;

  const scan = scanOutputWal(path, { maxPayloadBytes });
  if (scan.problem) throw new Error(scan.problem.message);
  if (fromOffset > scan.validBytes) {
    throw new Error(`thumbmux output WAL cursor ${fromOffset} is beyond byte ${scan.validBytes}`);
  }

  const fd = openSync(path, constants.O_RDONLY);
  try {
    let offset = 0;
    let previousSequence = 0n;
    let previousAt = 0;
    while (offset < scan.validBytes) {
      const header = Buffer.allocUnsafe(HEADER_BYTES);
      readExact(fd, header, 0, HEADER_BYTES, offset);
      const parsed = parseHeader(header, offset, previousSequence, previousAt, maxPayloadBytes);
      if ("message" in parsed) throw new Error(parsed.message);
      const payload = Buffer.allocUnsafe(parsed.payloadLength);
      if (parsed.payloadLength > 0) {
        readExact(fd, payload, 0, parsed.payloadLength, offset + HEADER_BYTES);
      }
      const nextOffset = offset + HEADER_BYTES + parsed.payloadLength;
      if (offset >= fromOffset) {
        yield {
          offset,
          nextOffset,
          sequence: parsed.sequence,
          at: parsed.at,
          kind: parsed.kind,
          payload,
        };
      } else if (nextOffset > fromOffset) {
        throw new Error(`thumbmux output WAL cursor ${fromOffset} is not a record boundary`);
      }
      offset = nextOffset;
      previousSequence = parsed.sequence;
      previousAt = parsed.at;
    }
  } finally {
    closeSync(fd);
  }
}

function quarantineTornTail(path: string, validBytes: number): string {
  const source = openSync(path, constants.O_RDONLY);
  let destinationPath = `${path}.torn-${Date.now()}-${process.pid}`;
  let suffix = 0;
  while (existsSync(destinationPath)) {
    suffix += 1;
    destinationPath = `${path}.torn-${Date.now()}-${process.pid}-${suffix}`;
  }
  const destination = openSync(
    destinationPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_DSYNC,
    PRIVATE_FILE_MODE,
  );
  try {
    const size = statSync(path).size;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = validBytes;
    while (offset < size) {
      const wanted = Math.min(chunk.byteLength, size - offset);
      const count = readExact(source, chunk, 0, wanted, offset);
      if (count === 0) break;
      writeAll(destination, chunk.subarray(0, count));
      offset += count;
    }
    fdatasyncSync(destination);
  } finally {
    closeSync(destination);
    closeSync(source);
  }
  // The sidecar is the only byte-exact copy of the rejected tail. Persist its
  // directory entry before truncating the source WAL.
  fsyncDirectory(dirname(path));
  return destinationPath;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class OutputWalWriter {
  private readonly path: string;
  readonly format: OutputWalFormat;
  private readonly clock: () => number;
  private readonly maxPayloadBytes: number;
  private fd: number;
  private sequence: bigint;
  private lastAt: number;
  readonly repair: OutputWalRepair;

  constructor(options: OutputWalWriterOptions) {
    this.path = options.path;
    this.format = options.format ?? VERSION;
    if (this.format !== 1 && this.format !== 2) throw new Error("unsupported WAL writer format");
    this.clock = options.clock ?? (() => Date.now());
    this.maxPayloadBytes = positivePayloadLimit(options.maxPayloadBytes);
    mkdirSync(dirname(this.path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(dirname(this.path), PRIVATE_DIRECTORY_MODE);

    const existed = existsSync(this.path);
    const scan = scanOutputWal(this.path, { maxPayloadBytes: this.maxPayloadBytes });
    if (scan.problem?.kind === "corrupt") {
      throw new Error(`${scan.problem.message}; refusing to append after corrupt bytes`);
    }
    if (scan.problem?.kind === "unavailable") throw new Error(scan.problem.message);
    // Check before repair: a caller with the wrong capability must not mutate
    // even a torn tail in another format's file.
    if (existed && statSync(this.path).size >= HEADER_BYTES) {
      const fd = openSync(this.path, constants.O_RDONLY);
      try {
        const header = Buffer.alloc(HEADER_BYTES);
        readExact(fd, header, 0, HEADER_BYTES, 0);
        if (header.readUInt8(8) !== this.format) {
          throw new Error("unavailable: WAL format differs from writer capability; refusing rewrite");
        }
      } finally { closeSync(fd); }
    }
    let quarantinedPath: string | null = null;
    if (scan.problem?.kind === "torn") {
      if (options.repairTornTail === false) {
        throw new Error(`${scan.problem.message}; repairTornTail is disabled`);
      }
      quarantinedPath = quarantineTornTail(this.path, scan.validBytes);
      truncateSync(this.path, scan.validBytes);
      const repairFd = openSync(this.path, constants.O_WRONLY);
      try {
        fdatasyncSync(repairFd);
      } finally {
        closeSync(repairFd);
      }
    }

    this.fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_DSYNC,
      PRIVATE_FILE_MODE,
    );
    chmodSync(this.path, PRIVATE_FILE_MODE);
    if (!existed) fsyncDirectory(dirname(this.path));
    this.sequence = scan.lastSequence;
    this.lastAt = scan.lastAt;
    this.repair = {
      repaired: quarantinedPath !== null,
      validBytes: scan.validBytes,
      quarantinedPath,
    };
  }

  get filePath(): string {
    return this.path;
  }

  append(kind: OutputWalKind, payload: Uint8Array, at = this.clock()): OutputWalRecord {
    if (this.fd < 0) throw new Error("thumbmux output WAL writer is closed");
    if (kind === "gap") {
      if (this.format !== 2) throw new Error("unavailable: gap requires a new format 2 WAL");
      const gap = parseOutputWalGapPayload(payload);
      if (BigInt(gap.lastDurableSeq) !== this.sequence) throw new Error("invalid gap boundary");
    }
    if (kind === "recovery") {
      if (this.format !== 2) throw new Error("unavailable: recovery requires a new format 2 WAL");
      parseOutputWalRecoveryPayload(payload);
    }
    if (payload.byteLength > this.maxPayloadBytes) {
      throw new Error(`thumbmux output WAL payload exceeds ${this.maxPayloadBytes} bytes`);
    }
    const timestamp = Math.max(this.lastAt, finiteTimestamp(at));
    const sequence = this.sequence + 1n;
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt8(this.format, 8);
    header.writeUInt8(KIND_TO_CODE[kind], 9);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(payload.byteLength, 12);
    header.writeBigUInt64LE(sequence, 16);
    header.writeBigUInt64LE(BigInt(timestamp), 24);
    header.writeUInt32LE(0, 36);
    header.writeUInt32LE(
      crc32Parts([header.subarray(8, 8 + CHECKSUM_INPUT_BYTES), payload]),
      32,
    );
    const frame = Buffer.concat([header, Buffer.from(payload)]);
    const offset = fstatSync(this.fd).size;
    writeAll(this.fd, frame);
    // O_DSYNC covers each write; fdatasync is deliberate belt-and-suspenders
    // for runtimes/filesystems that accept the flag but defer metadata updates.
    if (kind === "gap") fsyncSync(this.fd);
    else fdatasyncSync(this.fd);
    this.sequence = sequence;
    this.lastAt = timestamp;
    return {
      offset,
      nextOffset: offset + frame.byteLength,
      sequence,
      at: timestamp,
      kind,
      payload: Buffer.from(payload),
    };
  }

  /** Latest append that completed the durability barrier, not an observed tmux seq. */
  get lastDurableSequence(): bigint { return this.sequence; }

  appendGap(value: Omit<OutputWalGap, "lastDurableSeq">): OutputWalRecord {
    return this.appendJson("gap", { ...value, lastDurableSeq: this.sequence.toString() }, value.detectedAt);
  }

  appendRecovery(value: OutputWalRecoverySnapshot): OutputWalRecord {
    return this.appendJson("recovery", value);
  }

  appendOutput(payload: Uint8Array, at?: number): OutputWalRecord {
    return this.append("output", payload, at);
  }

  appendJson(
    kind: Exclude<OutputWalKind, "output">,
    value: unknown,
    at?: number,
  ): OutputWalRecord {
    return this.append(kind, Buffer.from(JSON.stringify(value), "utf8"), at);
  }

  flush(): void {
    if (this.fd >= 0) fdatasyncSync(this.fd);
  }

  close(): void {
    if (this.fd < 0) return;
    fdatasyncSync(this.fd);
    closeSync(this.fd);
    this.fd = -1;
  }
}

export function parseOutputWalJson<T = unknown>(record: OutputWalRecord): T {
  if (record.kind === "output") {
    throw new Error("thumbmux output WAL output records are binary, not JSON");
  }
  return JSON.parse(Buffer.from(record.payload).toString("utf8")) as T;
}

/** Unknown loss stays null; zero would falsely assert complete coverage. */
export type OutputWalGap = {
  gapId: string;
  sourceEpoch: string;
  paneId: string;
  lastDurableSeq: string;
  reason: "tmux-pause";
  detectedAt: number;
  missingBytes: null;
  coverage: "unknown";
};

export function parseOutputWalGapPayload(payload: Uint8Array): OutputWalGap {
  const value: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
  if (typeof value !== "object" || value === null) throw new Error("invalid WAL gap");
  const gap = value as Record<string, unknown>;
  if (typeof gap.gapId !== "string" || !gap.gapId
    || typeof gap.sourceEpoch !== "string" || !gap.sourceEpoch
    || typeof gap.paneId !== "string" || !/^%[0-9]+$/.test(gap.paneId)
    || typeof gap.lastDurableSeq !== "string" || !/^(0|[1-9][0-9]*)$/.test(gap.lastDurableSeq)
    || gap.reason !== "tmux-pause" || gap.missingBytes !== null || gap.coverage !== "unknown"
    || typeof gap.detectedAt !== "number" || !Number.isSafeInteger(gap.detectedAt) || gap.detectedAt < 0) {
    throw new Error("invalid WAL gap: unknown loss must remain null/unknown");
  }
  return gap as OutputWalGap;
}

export type OutputWalRecoverySnapshot = {
  gapId: string;
  sourceEpoch: string;
  paneId: string;
  provenance: "recovered-from-ring";
  status: "success" | "failed" | "ambiguous";
  recoveredBytesBase64: string;
  recoveredRows: number | null;
  truncated: boolean | null;
  identity: {
    session: string;
    sessionId: string;
    windowId: string;
    paneId: string;
    paneTarget: string;
    tmuxServerPid: number;
    sessionCreated: number;
  };
  geometry: { cols: number; rows: number };
  capturedSeqBefore: string;
  capturedSeqAfter: string;
  boundary: "matched" | "ambiguous" | null;
  error?: string;
};

export function parseOutputWalRecoveryPayload(payload: Uint8Array): OutputWalRecoverySnapshot {
  const value: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
  if (typeof value !== "object" || value === null) throw new Error("invalid WAL recovery snapshot");
  const recovery = value as Record<string, unknown>;
  const identity = recovery.identity as Record<string, unknown> | null;
  const geometry = recovery.geometry as Record<string, unknown> | null;
  if (typeof recovery.gapId !== "string" || !recovery.gapId
    || typeof recovery.sourceEpoch !== "string" || !recovery.sourceEpoch
    || typeof recovery.paneId !== "string" || !/^%[0-9]+$/.test(recovery.paneId)
    || recovery.provenance !== "recovered-from-ring"
    || (recovery.status !== "success" && recovery.status !== "failed" && recovery.status !== "ambiguous")
    || typeof recovery.recoveredBytesBase64 !== "string"
    || (recovery.recoveredRows !== null && (!Number.isSafeInteger(recovery.recoveredRows)
      || (recovery.recoveredRows as number) < 0 || (recovery.recoveredRows as number) > 10_000))
    || (recovery.truncated !== null && typeof recovery.truncated !== "boolean")
    || (recovery.boundary !== null && recovery.boundary !== "matched" && recovery.boundary !== "ambiguous")
    || (recovery.error !== undefined && typeof recovery.error !== "string")
    || typeof recovery.capturedSeqBefore !== "string" || !/^(0|[1-9][0-9]*)$/.test(recovery.capturedSeqBefore)
    || typeof recovery.capturedSeqAfter !== "string" || !/^(0|[1-9][0-9]*)$/.test(recovery.capturedSeqAfter)
    || BigInt(recovery.capturedSeqAfter) < BigInt(recovery.capturedSeqBefore)
    || !identity || typeof identity.session !== "string" || typeof identity.sessionId !== "string"
    || typeof identity.windowId !== "string" || identity.paneId !== recovery.paneId
    || typeof identity.paneTarget !== "string" || !Number.isSafeInteger(identity.tmuxServerPid)
    || !Number.isSafeInteger(identity.sessionCreated)
    || !geometry || !Number.isSafeInteger(geometry.cols) || (geometry.cols as number) <= 0
    || !Number.isSafeInteger(geometry.rows) || (geometry.rows as number) <= 0) {
    throw new Error("invalid WAL recovery snapshot provenance or boundary");
  }
  if ((recovery.status === "success" && (recovery.boundary !== "matched" || recovery.truncated !== false
      || recovery.recoveredRows === null || recovery.error !== undefined))
    || (recovery.status === "ambiguous" && (recovery.recoveredRows === null || recovery.truncated === null
      || recovery.boundary === null || recovery.error !== undefined))
    || (recovery.status === "failed" && (recovery.recoveredRows !== null || recovery.truncated !== null
      || recovery.boundary !== null || recovery.recoveredBytesBase64 !== "" || typeof recovery.error !== "string"))) {
    throw new Error("invalid WAL recovery result status fields");
  }
  const recovered = Buffer.from(recovery.recoveredBytesBase64, "base64");
  if (recovered.byteLength > 8 * 1024 * 1024
    || recovered.toString("base64") !== recovery.recoveredBytesBase64) {
    throw new Error("invalid WAL recovery snapshot byte budget or encoding");
  }
  return recovery as OutputWalRecoverySnapshot;
}
