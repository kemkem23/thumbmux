import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createOutputWalTailCursor,
  OutputWalWriter,
  parseOutputWalJson,
  readOutputWalTail,
  readOutputWal,
  scanOutputWal,
  type OutputWalRecoverySnapshot,
} from "../src/output-wal";

let root = "";
let path = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thumbmux-output-wal-"));
  path = join(root, "nested", "output.wal");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lossless output WAL", () => {
  test("round-trips arbitrary bytes and ordered resize/lifecycle records", () => {
    const times = [20, 10, 30];
    const writer = new OutputWalWriter({ path, clock: () => times.shift() ?? 30 });
    writer.appendJson("lifecycle", { event: "start", cols: 80, rows: 24 });
    const binary = Uint8Array.from([0, 255, 27, 91, 49, 109, 10, 0xc3, 0x28]);
    writer.appendOutput(binary);
    writer.appendJson("resize", { cols: 197, rows: 60 });
    writer.close();

    const records = [...readOutputWal(path)];
    expect(records.map((record) => record.sequence)).toEqual([1n, 2n, 3n]);
    expect(records.map((record) => record.at)).toEqual([20, 20, 30]);
    expect(records.map((record) => record.kind)).toEqual(["lifecycle", "output", "resize"]);
    expect([...records[1]!.payload]).toEqual([...binary]);
    expect(parseOutputWalJson<Record<string, unknown>>(records[0]!)).toEqual({ event: "start", cols: 80, rows: 24 });
    expect(parseOutputWalJson<Record<string, unknown>>(records[2]!)).toEqual({ cols: 197, rows: 60 });
    expect(records[0]!.offset).toBe(0);
    expect(records[1]!.offset).toBe(records[0]!.nextOffset);
    expect(scanOutputWal(path)).toMatchObject({ records: 3, problem: null });
  });

  test("quarantines and repairs only an EOF-torn tail before resuming", () => {
    const writer = new OutputWalWriter({ path, clock: () => 1 });
    writer.appendOutput(Buffer.from("complete"));
    writer.close();
    const validBytes = statSync(path).size;
    appendFileSync(path, Buffer.from("THMW", "ascii"));

    const scan = scanOutputWal(path);
    expect(scan.problem?.kind).toBe("torn");
    expect(scan.validBytes).toBe(validBytes);

    const resumed = new OutputWalWriter({ path, clock: () => 2 });
    expect(resumed.repair.repaired).toBe(true);
    expect(resumed.repair.quarantinedPath).not.toBeNull();
    expect(readFileSync(resumed.repair.quarantinedPath!)).toEqual(Buffer.from("THMW", "ascii"));
    resumed.appendOutput(Buffer.from("after"));
    resumed.close();

    const records = [...readOutputWal(path)];
    expect(records.map((record) => Buffer.from(record.payload).toString())).toEqual(["complete", "after"]);
    expect(records.map((record) => record.sequence)).toEqual([1n, 2n]);
  });

  test("fails closed on checksum corruption and preserves every source byte", () => {
    const writer = new OutputWalWriter({ path, clock: () => 1 });
    writer.appendOutput(Buffer.from("one"));
    writer.appendOutput(Buffer.from("two"));
    writer.close();
    const before = readFileSync(path);
    const damaged = Buffer.from(before);
    damaged[damaged.length - 1] ^= 0xff;
    writeFileSync(path, damaged);

    const scan = scanOutputWal(path);
    expect(scan.problem?.kind).toBe("corrupt");
    expect(() => new OutputWalWriter({ path })).toThrow("refusing to append after corrupt bytes");
    expect(readFileSync(path)).toEqual(damaged);
  });

  test("rejects a cursor in the middle of a record", () => {
    const writer = new OutputWalWriter({ path });
    const first = writer.appendOutput(Buffer.from("abc"));
    writer.close();
    expect(() => [...readOutputWal(path, { fromOffset: first.offset + 1 })]).toThrow(
      "is not a record boundary",
    );
  });

  test("keeps directory and WAL private", () => {
    chmodSync(root, 0o755);
    const writer = new OutputWalWriter({ path });
    writer.appendOutput(Buffer.from("secret terminal bytes"));
    writer.close();
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects payloads above the configured frame bound without changing disk", () => {
    const writer = new OutputWalWriter({ path, maxPayloadBytes: 4 });
    expect(() => writer.appendOutput(Buffer.from("12345"))).toThrow("exceeds 4 bytes");
    writer.close();
    expect(statSync(path).size).toBe(0);
  });

  test("tails only appended records from a verified inode/sequence cursor", () => {
    const writer = new OutputWalWriter({ path, clock: () => 10 });
    writer.appendOutput(Buffer.from("old"));
    writer.close();
    const cursor = createOutputWalTailCursor(path);

    const resumed = new OutputWalWriter({ path, clock: () => 20 });
    resumed.appendOutput(Buffer.from("new-1"));
    resumed.appendJson("checkpoint", { event: "barrier", requestId: "tail" });
    resumed.close();

    const first = readOutputWalTail(path, cursor, { maxRecords: 1 });
    expect(first.records).toHaveLength(1);
    expect(Buffer.from(first.records[0]!.payload).toString()).toBe("new-1");
    expect(first.hasMore).toBe(true);
    const second = readOutputWalTail(path, first.cursor);
    expect(second.records.map((record) => record.kind)).toEqual(["checkpoint"]);
    expect(second.cursor.lastSequence).toBe(3n);
    expect(second.hasMore).toBe(false);
    expect(second.incompleteTail).toBe(false);
  });

  test("treats a concurrent torn tail as retryable but rejects file replacement", () => {
    const writer = new OutputWalWriter({ path, clock: () => 10 });
    writer.appendOutput(Buffer.from("base"));
    writer.close();
    const cursor = createOutputWalTailCursor(path);

    appendFileSync(path, Buffer.from("THMW"));
    const partial = readOutputWalTail(path, cursor);
    expect(partial.records).toEqual([]);
    expect(partial.incompleteTail).toBe(true);
    expect(partial.cursor).toEqual(cursor);

    const replacement = `${path}.replacement`;
    writeFileSync(replacement, readFileSync(path));
    renameSync(replacement, path);
    expect(() => readOutputWalTail(path, cursor)).toThrow(/replaced/);
  });
});

describe("format 2 durable pause gaps", () => {
  const gap = { gapId: "gap-1", sourceEpoch: "epoch-1", paneId: "%42",
    reason: "tmux-pause" as const, detectedAt: 100, missingBytes: null, coverage: "unknown" as const };

  test("preserves unknown loss and the latest durable boundary in full and tail reads", () => {
    const writer = new OutputWalWriter({ path, format: 2, clock: () => 1 });
    writer.appendOutput(Buffer.from("prefix"));
    const cursor = createOutputWalTailCursor(path);
    writer.appendGap(gap);
    writer.close();
    const tail = readOutputWalTail(path, cursor).records;
    expect(tail[0]!.kind).toBe("gap");
    expect(parseOutputWalJson<Record<string, unknown>>(tail[0]!)).toEqual({ ...gap, lastDurableSeq: "1" });
    expect([...readOutputWal(path)]).toHaveLength(2);
    const resumed = new OutputWalWriter({ path, format: 2 });
    expect(resumed.lastDurableSequence).toBe(2n);
    resumed.close();
  });

  test("cannot upgrade an existing format 1 or downgrade/repair a format 2", () => {
    const old = new OutputWalWriter({ path });
    old.appendOutput(Buffer.from("original"));
    expect(() => old.appendGap(gap)).toThrow("format 2");
    old.close();
    const before = readFileSync(path);
    expect(() => new OutputWalWriter({ path, format: 2 })).toThrow("refusing rewrite");
    expect(readFileSync(path)).toEqual(before);
    const second = join(root, "v2.wal");
    const modern = new OutputWalWriter({ path: second, format: 2 });
    modern.appendGap(gap);
    modern.close();
    appendFileSync(second, "torn");
    const torn = readFileSync(second);
    expect(() => new OutputWalWriter({ path: second })).toThrow("refusing rewrite");
    expect(readFileSync(second)).toEqual(torn);
  });

  test("rejects false zero loss and foreign durable boundary before writing", () => {
    const writer = new OutputWalWriter({ path, format: 2 });
    expect(() => writer.appendJson("gap", { ...gap, lastDurableSeq: "0", missingBytes: 0 })).toThrow("null/unknown");
    expect(() => writer.appendJson("gap", { ...gap, lastDurableSeq: "99" })).toThrow("boundary");
    expect(statSync(path).size).toBe(0);
    writer.close();
  });
});

function ringRecovery(status: "success" | "ambiguous" | "failed" = "success"): OutputWalRecoverySnapshot {
  return {
    gapId: "gap-1", sourceEpoch: "epoch-1", paneId: "%42", provenance: "recovered-from-ring", status,
    recoveredBytesBase64: status === "failed" ? "" : Buffer.from("ring\n").toString("base64"),
    recoveredRows: status === "failed" ? null : 1, truncated: status === "failed" ? null : false,
    identity: { session: "test", sessionId: "$1", windowId: "@1", paneId: "%42", paneTarget: "=test:0.0", tmuxServerPid: 123, sessionCreated: 100 },
    geometry: { cols: 80, rows: 24 }, capturedSeqBefore: "0", capturedSeqAfter: "1",
    boundary: status === "failed" ? null : status === "success" ? "matched" : "ambiguous",
    ...(status === "failed" ? { error: "capture failed" } : {}),
  };
}

test("appendRecovery round-trips every status and resumes as recovery, never raw output", () => {
  const writer = new OutputWalWriter({ path, format: 2 });
  for (const status of ["success", "ambiguous", "failed"] as const) writer.appendRecovery(ringRecovery(status));
  writer.close();
  const resumed = new OutputWalWriter({ path, format: 2 });
  resumed.appendRecovery(ringRecovery());
  resumed.close();
  const records = [...readOutputWal(path)];
  expect(records.map((record) => record.kind)).toEqual(["recovery", "recovery", "recovery", "recovery"]);
  expect(records.map((record) => parseOutputWalJson(record))).toEqual([
    ringRecovery("success"), ringRecovery("ambiguous"), ringRecovery("failed"), ringRecovery(),
  ]);
  expect(scanOutputWal(path)).toMatchObject({ records: 4, lastSequence: 4n, problem: null });
});

test("appendRecovery rejects format 1 and malformed provenance before touching disk", () => {
  const legacy = new OutputWalWriter({ path });
  expect(() => legacy.appendRecovery(ringRecovery())).toThrow("format 2");
  legacy.close();
  const writer = new OutputWalWriter({ path, format: 2 });
  try {
    for (const invalid of [
      { ...ringRecovery(), provenance: "output" },
      { ...ringRecovery(), boundary: "ambiguous" },
      { ...ringRecovery(), recoveredBytesBase64: "***" },
      { ...ringRecovery("failed"), recoveredRows: 0 },
    ]) expect(() => writer.appendRecovery(invalid as OutputWalRecoverySnapshot)).toThrow("invalid WAL recovery");
    expect(statSync(path).size).toBe(0);
  } finally { writer.close(); }
});

test("scan reports a checksum-valid malformed recovery as corrupt without throwing", () => {
  const writer = new OutputWalWriter({ path, format: 2 });
  writer.appendRecovery(ringRecovery());
  writer.close();
  const bytes = readFileSync(path);
  const payload = Buffer.from(bytes.subarray(40).toString().replace("recovered-from-ring", "xxxxxxxxxxxxxxxxxxx"));
  expect(payload.byteLength).toBe(bytes.length - 40);
  payload.copy(bytes, 40);
  // Independent CRC32 fixture encoding, so malformed JSON semantics (not a
  // broken checksum) exercise the recovery scanner's failure return path.
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([bytes.subarray(8, 32), payload])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  bytes.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 32);
  writeFileSync(path, bytes);
  const scan = scanOutputWal(path);
  expect(scan).toMatchObject({ validBytes: 0, records: 0, problem: { kind: "corrupt" } });
  expect(scan.problem!.message).toContain("invalid WAL recovery");
  expect(readFileSync(path)).toEqual(bytes);
});
