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
    expect(parseOutputWalJson(records[0]!)).toEqual({ event: "start", cols: 80, rows: 24 });
    expect(parseOutputWalJson(records[2]!)).toEqual({ cols: 197, rows: 60 });
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
