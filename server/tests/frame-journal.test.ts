import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  chooseMuxOutputFrame,
  fnv1a32,
  muxPrefixHash,
  parseReplayJournal,
  splitMuxOutputData,
} from "@thumbmux/core";
import { FrameJournal, type FrameJournalErrorReport, type FrameJournalStorage } from "../src/frame-journal";

interface TestRecord {
  frame: {
    channel?: string;
    type: "output" | "delta";
    data?: string;
    baseLength?: number;
    prefix?: number;
    prefixHash?: string;
    lines?: string[];
    reset?: "resize" | "resync";
    cursor?: { row: number; col: number } | null;
  };
  session: string;
  at: number;
  v: 1;
}

async function withTempRoot<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "frame-journal-test-"));
  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

function makeOutputFrame(session: string, data: string, reset?: "resize" | "resync") {
  return {
    channel: session,
    type: "output",
    data,
    ...(reset ? { reset } : {}),
  } as const;
}

function parseNdjson(source: string) {
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TestRecord);
}

async function readNdjsonLines(path: string): Promise<TestRecord[]> {
  return parseNdjson(await readFile(path, "utf8"));
}

function linesText(lines: readonly string[]) {
  return lines.join("\n");
}

function recoverableDeltaCandidates(session: string, base: string[], data: string) {
  return chooseMuxOutputFrame(
    { channel: session, type: "output", data },
    base,
  );
}

function makeRecord(session: string, at: number, frame: TestRecord["frame"]): TestRecord {
  return { v: 1 as const, session, at, frame };
}

function makeInvalidDelta(session: string, at: number, baseLines: readonly string[], overrides: Record<string, unknown>) {
  const canonical = recoverableDeltaCandidates(session, baseLines, linesText(baseLines.concat(["replacement"])));
  const invalid = {
    ...canonical,
    ...overrides,
  };
  return makeRecord(session, at, invalid as TestRecord["frame"]);
}

function withDeterministicClock(times: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = times[index];
    index += 1;
    return value ?? times[times.length - 1] ?? Date.now();
  };
}

function makeLargeContent(prefix: string, lines = 80) {
  return Array.from({ length: lines }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}-${"x".repeat(120)}`).join("\n");
}

describe("server frame journal", () => {
  test("preserves capture order for concurrent non-awaited calls to one session", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({
        rootDir,
        clock: withDeterministicClock([10, 20, 30, 40, 50]),
      });
      const session = "order-session";
      const path = journal.getSessionPath(session);

      for (let i = 0; i < 5; i += 1) {
        journal.capture(session, makeOutputFrame(session, `frame-${i}`));
      }

      await journal.flushSession(session);
      const lines = await readNdjsonLines(path);

      expect(lines).toHaveLength(5);
      expect(lines.map((record) => record.at)).toEqual([10, 20, 30, 40, 50]);
      expect(lines.map((record) => record.frame.data)).toEqual([
        "frame-0",
        "frame-1",
        "frame-2",
        "frame-3",
        "frame-4",
      ]);
      expect(lines[0].frame.type).toBe("output");
    });
  });

  test("normalizes queued backwards timestamps into a recoverable nondecreasing timeline", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const session = "monotonic-queue";
      journal.capture(session, makeOutputFrame(session, "first"), 20);
      journal.capture(session, makeOutputFrame(session, "second"), 10);
      await journal.flushSession(session);

      const records = await readNdjsonLines(journal.getSessionPath(session));
      expect(records.map((record) => record.at)).toEqual([20, 20]);
      expect((await journal.recoverSession(session)).lastAt).toBe(20);
    });
  });

  test("uses full first and per-session canonical state without cross-session leakage", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const sessionA = "sessionA";
      const sessionB = "sessionB";
      const baseA = makeLargeContent("session-a");
      const baseB = makeLargeContent("session-b");
      const updateA = `${baseA}\nA`;
      const updateB = `${baseB}\nB`;

      journal.capture(sessionA, makeOutputFrame(sessionA, baseA));
      journal.capture(sessionB, makeOutputFrame(sessionB, baseB));
      journal.capture(sessionA, makeOutputFrame(sessionA, updateA));
      journal.capture(sessionB, makeOutputFrame(sessionB, updateB));
      await Promise.all([journal.flushSession(sessionA), journal.flushSession(sessionB)]);

      const pathA = journal.getSessionPath(sessionA);
      const pathB = journal.getSessionPath(sessionB);
      const recordsA = await readNdjsonLines(pathA);
      const recordsB = await readNdjsonLines(pathB);

      expect(recordsA[0].frame.type).toBe("output");
      expect(recordsB[0].frame.type).toBe("output");

      const recoveredA = await journal.recoverSession(sessionA);
      const recoveredB = await journal.recoverSession(sessionB);
      expect(recoveredA.recordCount).toBe(2);
      expect(recoveredB.recordCount).toBe(2);
      expect(recoveredA.base).toEqual(splitMuxOutputData(updateA));
      expect(recoveredB.base).toEqual(splitMuxOutputData(updateB));
      expect(recoveredA.base).not.toEqual(recoveredB.base);
    });
  });

  test("preserves Unicode and trailing empty lines through recovery", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const session = "unicodé-😀";
      const frameData = "🙂\nΩmega\n";
      journal.capture(session, makeOutputFrame(session, frameData));
      await journal.flushSession(session);

      const recovered = await journal.recoverSession(session);
      const fileText = await readFile(journal.getSessionPath(session), "utf8");
      const parsed = parseNdjson(fileText);
      expect(parsed[0].frame.type).toBe("output");
      expect(parsed[0].frame.data).toBe(frameData);
      expect(recovered.base).toEqual(splitMuxOutputData(frameData));
      expect(recovered.base.at(-1)).toBe("");
    });
  });

  test("selects strict-smaller delta when eligible and uses full when prefix is zero", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const session = "delta-choice";
      const base = makeLargeContent("shared", 120);
      const next = `${base}\nappend`;
      const badPrefix = `different-head\n${base}`;

      journal.capture(session, makeOutputFrame(session, base));
      journal.capture(session, makeOutputFrame(session, next));
      journal.capture(session, makeOutputFrame(session, badPrefix));
      await journal.flushSession(session);

      const records = await readNdjsonLines(journal.getSessionPath(session));
      expect(records[1].frame.type).toBe("delta");
      expect(records[2].frame.type).toBe("output");
      expect(records[2].frame.data).toBe(badPrefix);
      expect(chooseMuxOutputFrame(makeOutputFrame(session, next), splitMuxOutputData(base)).type).toBe("delta");
      expect(
        chooseMuxOutputFrame(makeOutputFrame(session, "x\na"), splitMuxOutputData("z\na")).type,
      ).toBe("output");
    });
  });

  test("forces full frame on explicit reset and after checkpoint cadence", async () => {
    const checkpointCadence = 2;
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir, checkpointCadence });
      const session = "checkpoint-reset";
      const base = makeLargeContent("checkpoint", 120);
      const captures = [
        `${base}\none`,
        `${base}\none\ntwo`,
        `${base}\none\ntwo\nthree`,
        `${base}\none\ntwo\nthree\nfour`,
        `${base}\none\ntwo\nthree\nfour\nfive`,
      ];

      journal.capture(session, makeOutputFrame(session, base));
      journal.capture(session, makeOutputFrame(session, captures[0]), 10);
      journal.capture(session, makeOutputFrame(session, captures[1]), 11);
      journal.capture(session, makeOutputFrame(session, captures[2]), 12);
      journal.capture(session, makeOutputFrame(session, captures[3], "resync"), 13);
      journal.capture(session, makeOutputFrame(session, captures[4]), 14);
      await journal.flushSession(session);

      const records = await readNdjsonLines(journal.getSessionPath(session));
      expect(records).toHaveLength(6);
      expect(records[1].frame.type).toBe("delta");
      expect(records[2].frame.type).toBe("delta");
      expect(records[3].frame.type).toBe("output");
      expect(records[3].frame.reset).toBeUndefined();
      expect(records[4].frame.type).toBe("output");
      expect(records[4].frame.reset).toBe("resync");
      expect(records[5].frame.type).toBe("delta");
    });
  });

  test("creates safe deterministic session paths and avoids raw session leakage", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const candidates = [
        "../traversal/../escape",
        "/absolute/session/name",
        "dir\\with\\windows\\separators",
        "ユニコード-セッション-😀",
        "mixed/./path\\segments/..",
        "same-session",
        " same-session ",
      ];

      const paths = candidates.map((session) => ({
        session,
        path: journal.getSessionPath(session),
      }));
      const uniquePaths = new Set(paths.map((entry) => entry.path));
      expect(uniquePaths.size).toBe(paths.length);

      for (const { session, path } of paths) {
        const base = basename(path);
        expect(base).toMatch(/^[0-9a-f]{64}\.ndjson$/);
        expect(path.startsWith(rootDir)).toBe(true);
        expect(path).not.toContain("..");
        expect(path).not.toContain(session);
        expect(journal.getSessionPath(session)).toBe(path);
      }
    });
  });

  test("reports append failures via callback and keeps a later full boundary recoverable", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "append-failure";
      const path = new FrameJournal({ rootDir }).getSessionPath(session);
      await mkdir(rootDir, { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify(makeRecord(session, 1, makeOutputFrame(session, "seed-line")))}\n`,
        "utf8",
      );

      const errors: FrameJournalErrorReport[] = [];
      let firstAppend = true;
      const storage: FrameJournalStorage = {
        ensureDirectory: async () => undefined,
        readText: async () => readFile(path, "utf8"),
        appendText: async (_target: string, source: string) => {
          if (firstAppend) {
            firstAppend = false;
            throw new Error("simulated append failure");
          }
          await writeFile(path, source, { flag: "a" });
        },
        // Truncate must be available so a failed append can roll back to the
        // known-good offset and the session can keep accepting safely.
        truncate: async (_target, byteLength) => {
          const current = await readFile(path);
          await writeFile(path, current.subarray(0, byteLength));
        },
      };

      const journal = new FrameJournal({
        rootDir,
        storage,
        onError: (report) => errors.push(report),
      });

      expect(journal.capture(session, makeOutputFrame(session, "post-fail-full"))).toBe(true);
      await journal.flushSession(session);
      expect(errors).toHaveLength(1);
      expect(errors[0].phase).toBe("write");
      expect(errors[0].session).toBe(session);

      expect(journal.capture(session, makeOutputFrame(session, "post-recovery-full"))).toBe(true);
      await journal.flushSession(session);
      const recovered = await journal.recoverSession(session);

      expect(recovered.recordCount).toBe(2);
      expect(recovered.base).toEqual(splitMuxOutputData("post-recovery-full"));
    });
  });

  test("reports read failures and keeps capture rejection deterministic", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "recover-read-fail";
      const errors: FrameJournalErrorReport[] = [];
      const storage: FrameJournalStorage = {
        ensureDirectory: async () => undefined,
        readText: async () => {
          const error = new Error("simulated read failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        },
        appendText: async () => undefined,
      };
      const journal = new FrameJournal({ rootDir, storage, onError: (report) => errors.push(report) });
      await expect(journal.recoverSession(session)).rejects.toBeDefined();
      expect(errors).toHaveLength(1);
      expect(errors[0].phase).toBe("recover");
      expect(journal.capture(session, makeOutputFrame(session, "ignored"))).toBe(false);
    });
  });

  test("stop flushes all admitted work, blocks later captures, and can be repeated", async () => {
    await withTempRoot(async (rootDir) => {
      const journal = new FrameJournal({ rootDir });
      const sessionA = "stop-A";
      const sessionB = "stop-B";

      for (const session of [sessionA, sessionB]) {
        journal.capture(session, makeOutputFrame(session, `first-${session}`));
        journal.capture(session, makeOutputFrame(session, `second-${session}`));
      }

      await journal.stop();
      const pathA = journal.getSessionPath(sessionA);
      const pathB = journal.getSessionPath(sessionB);
      const recordsA = await readNdjsonLines(pathA);
      const recordsB = await readNdjsonLines(pathB);

      expect(recordsA).toHaveLength(2);
      expect(recordsB).toHaveLength(2);
      expect(journal.capture(sessionA, makeOutputFrame(sessionA, "late"))).toBe(false);
      expect(journal.capture(sessionB, makeOutputFrame(sessionB, "late"))).toBe(false);

      await journal.stop();
      const recordsAAfterStop = await readNdjsonLines(pathA);
      const recordsBAfterStop = await readNdjsonLines(pathB);
      expect(recordsAAfterStop).toHaveLength(2);
      expect(recordsBAfterStop).toHaveLength(2);
      await journal.stopSession(sessionA);
      await journal.flushSession(sessionA);

      const isolatedA = "per-session-A";
      const isolatedB = "per-session-B";
      const perSession = new FrameJournal({ rootDir });
      perSession.capture(isolatedA, makeOutputFrame(isolatedA, "one"));
      perSession.capture(isolatedB, makeOutputFrame(isolatedB, "one"));
      await perSession.stopSession(isolatedA);
      expect(perSession.capture(isolatedA, makeOutputFrame(isolatedA, "late"))).toBe(false);
      expect(perSession.capture(isolatedB, makeOutputFrame(isolatedB, "two"))).toBe(true);
      await perSession.flushAll();
      expect(await readNdjsonLines(perSession.getSessionPath(isolatedA))).toHaveLength(1);
      expect(await readNdjsonLines(perSession.getSessionPath(isolatedB))).toHaveLength(2);
    });
  });

  test("recovers valid files and ignores trailing partial lines", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "valid-recovery";
      const path = new FrameJournal({ rootDir }).getSessionPath(session);
      const base = "line1\nline2";
      const full1 = JSON.stringify(makeRecord(session, 1, makeOutputFrame(session, base)));
      const full2 = JSON.stringify(makeRecord(session, 2, makeOutputFrame(session, `${base}\nline3`)));
      await writeFile(path, `${full1}\n${full2}\n{"v":1,"session":"${session}","at":3`, "utf8");

      const journal = new FrameJournal({ rootDir });
      const recovered = await journal.recoverSession(session);

      expect(recovered.recordCount).toBe(2);
      expect(recovered.base).toEqual(splitMuxOutputData(`${base}\nline3`));
      expect(recovered.lastAt).toBe(2);
    });
  });

  test("rejects malformed middle JSON and malformed complete middle records while still using public recover paths", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "recovery-middle-failures";
      const path = new FrameJournal({ rootDir }).getSessionPath(session);
      const full1 = makeRecord(session, 1, makeOutputFrame(session, "base"));
      const full2 = makeRecord(session, 3, makeOutputFrame(session, "after"));

      const malformed = `${JSON.stringify(full1)}\n{not-json}\n${JSON.stringify(full2)}\n`;
      await writeFile(path, malformed, "utf8");

      const errors: FrameJournalErrorReport[] = [];
      const journal = new FrameJournal({ rootDir, onError: (report) => errors.push(report) });
      await expect(journal.recoverSession(session)).rejects.toBeDefined();
      expect(errors).toHaveLength(1);
      expect(errors[0].phase).toBe("recover");
    });
  });

  test("rejects first-delta, out-of-order time, and session/channel mismatch in recovery", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "recovery-structural";
      const journalBase = new FrameJournal({ rootDir });
      const sessionPath = journalBase.getSessionPath(session);

      const fullA = makeRecord(session, 1, makeOutputFrame(session, "alpha"));
      const fullB = makeRecord(session, 2, makeOutputFrame(session, "beta"));
      const fullC = makeRecord("other", 3, makeOutputFrame("other", "other"));
      const channelMismatch = { ...fullB, frame: { ...fullB.frame, channel: "other" } };
      const firstDelta = makeRecord(session, 4, makeOutputFrame(session, "oops").type === "output"
        ? {
            channel: session,
            type: "delta",
            baseLength: 0,
            prefix: 0,
            prefixHash: fnv1a32("[]"),
            lines: ["oops"],
          }
        : null);

      const cases: Array<{ label: string; source: string }> = [
        {
          label: "first-delta",
          source: `${JSON.stringify(firstDelta)}\n`,
        },
        {
          label: "out-of-order",
          source: `${JSON.stringify(fullB)}\n${JSON.stringify(fullA)}\n`,
        },
        {
          label: "session-mismatch",
          source: `${JSON.stringify(fullA)}\n${JSON.stringify(fullC)}\n`,
        },
        {
          label: "channel-mismatch",
          source: `${JSON.stringify(fullA)}\n${JSON.stringify(channelMismatch)}\n`,
        },
      ];

      for (const item of cases) {
        await writeFile(sessionPath, item.source, "utf8");
        const errors: FrameJournalErrorReport[] = [];
        const journal = new FrameJournal({ rootDir, onError: (report) => errors.push(report) });
        await expect(journal.recoverSession(session)).rejects.toBeDefined();
        expect(errors).toHaveLength(1);
        expect(errors[0].phase).toBe("recover");
      }
    });
  });

  test("rejects invalid delta records by base/hash/strict-size semantics", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "recovery-delta-invalid";
      const path = new FrameJournal({ rootDir }).getSessionPath(session);
      const base = makeLargeContent("base");
      const badBaseLines = splitMuxOutputData(base);
      const baseRecord = makeRecord(session, 1, makeOutputFrame(session, base));
      const goodTail = makeRecord(session, 4, makeOutputFrame(session, base));
      const invalidBaseLength = makeInvalidDelta(session, 2, badBaseLines, {
        baseLength: badBaseLines.length + 1,
      });
      const invalidHash = makeInvalidDelta(session, 2, badBaseLines, {
        prefixHash: "00000000",
      });
      const invalidStrict = makeInvalidDelta(session, 2, badBaseLines, {
        prefix: 0,
        prefixHash: muxPrefixHash([]),
      });

      const cases = [invalidBaseLength, invalidHash, invalidStrict].map((record) =>
        `${JSON.stringify(baseRecord)}\n${JSON.stringify(record)}\n${JSON.stringify(goodTail)}\n`,
      );

      for (const source of cases) {
        await writeFile(path, source, "utf8");
        const errors: FrameJournalErrorReport[] = [];
        const journal = new FrameJournal({ rootDir, onError: (report) => errors.push(report) });
        await expect(journal.recoverSession(session)).rejects.toBeDefined();
        expect(errors).toHaveLength(1);
        expect(errors[0].phase).toBe("recover");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // v0.4.0 B3 defect pins (these MUST fail until the corresponding fixes land)
  // ---------------------------------------------------------------------------

  test("repairs a crash-torn trailing line so later appends stay recoverable and replayable", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "crash-torn-tail";
      const journal = new FrameJournal({ rootDir });
      const path = journal.getSessionPath(session);
      const frame1 = "torn-line-1\nsecond";
      const frame2 = "torn-line-1\nsecond\nthird";
      const frame3 = "torn-line-1\nsecond\nthird\nfourth";

      expect(journal.capture(session, makeOutputFrame(session, frame1), 1)).toBe(true);
      expect(journal.capture(session, makeOutputFrame(session, frame2), 2)).toBe(true);
      await journal.flushSession(session);

      // Simulate a crash mid-append: an unterminated partial record at EOF.
      const fileText = await readFile(path, "utf8");
      await writeFile(
        path,
        `${fileText}{"v":1,"session":"${session}","at":3,"frame":{"chan`,
        "utf8",
      );

      const recoverErrors: FrameJournalErrorReport[] = [];
      const recovered = await new FrameJournal({
        rootDir,
        onError: (report) => recoverErrors.push(report),
      }).recoverSession(session);
      expect(recovered.recordCount).toBe(2);
      expect(recoverErrors).toHaveLength(0);

      // Next capture must append after a repaired (truncated) tail — not onto the partial bytes.
      const writerErrors: FrameJournalErrorReport[] = [];
      const writer = new FrameJournal({
        rootDir,
        onError: (report) => writerErrors.push(report),
      });
      expect(writer.capture(session, makeOutputFrame(session, frame3), 3)).toBe(true);
      await writer.flushSession(session);
      expect(writerErrors).toHaveLength(0);

      const postErrors: FrameJournalErrorReport[] = [];
      const post = await new FrameJournal({
        rootDir,
        onError: (report) => postErrors.push(report),
      }).recoverSession(session);
      expect(postErrors).toHaveLength(0);
      expect(post.recordCount).toBe(3);
      expect(post.base).toEqual(splitMuxOutputData(frame3));

      const finalText = await readFile(path, "utf8");
      const parsed = parseReplayJournal(finalText);
      expect(parsed.count).toBe(3);

      // Every complete physical line must be valid JSON (no partial-record garbage).
      for (const line of finalText.split("\n").filter((entry) => entry.length > 0)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  test("stops recording at maxBytes instead of growing the journal without bound", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "max-bytes-cap";
      const errors: FrameJournalErrorReport[] = [];
      const journal = new FrameJournal({
        rootDir,
        // Future option: per-session hard byte cap (default 64 MiB; Infinity = unlimited).
        maxBytes: 8192,
        onError: (report) => errors.push(report),
      } as ConstructorParameters<typeof FrameJournal>[0] & { maxBytes?: number });

      const path = journal.getSessionPath(session);
      const admitted: boolean[] = [];
      // ~1 KB payloads, forced full frames via resync so size growth is predictable.
      for (let i = 0; i < 60; i += 1) {
        const data = `frame-${String(i).padStart(3, "0")}-${"x".repeat(1000)}`;
        admitted.push(journal.capture(session, makeOutputFrame(session, data, "resync"), i + 1));
      }
      await journal.flushSession(session);

      expect(admitted.some((ok) => ok === false)).toBe(true);
      expect((await stat(path)).size).toBeLessThanOrEqual(8192);

      const limitReports = errors.filter((report) => report.phase === "limit");
      expect(limitReports).toHaveLength(1);
      expect(limitReports[0].session).toBe(session);

      // Once the cap is hit the session stays closed for further captures.
      expect(journal.capture(session, makeOutputFrame(session, "after-cap"), 1000)).toBe(false);

      // Truncated-but-valid journal must still recover and replay.
      const recovered = await new FrameJournal({
        rootDir,
        maxBytes: 8192,
      } as ConstructorParameters<typeof FrameJournal>[0] & { maxBytes?: number }).recoverSession(session);
      expect(recovered.recordCount).toBeGreaterThan(0);
      const fileText = await readFile(path, "utf8");
      expect(() => parseReplayJournal(fileText)).not.toThrow();
    });
  });

  test("drops captures instead of buffering without bound when storage stalls", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "write-backpressure";
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let appendCalls = 0;
      const storage: FrameJournalStorage = {
        ensureDirectory: async (target) => {
          await mkdir(target, { recursive: true });
        },
        readText: async () => {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        appendText: async (target, source) => {
          appendCalls += 1;
          await gate;
          await writeFile(target, source, { flag: "a" });
        },
      };

      const errors: FrameJournalErrorReport[] = [];
      const journal = new FrameJournal({
        rootDir,
        storage,
        // Future option: max in-flight admitted captures per session (default 128).
        maxPendingWrites: 16,
        onError: (report) => errors.push(report),
      } as ConstructorParameters<typeof FrameJournal>[0] & { maxPendingWrites?: number });

      let admitted = 0;
      for (let i = 0; i < 500; i += 1) {
        if (journal.capture(session, makeOutputFrame(session, `stall-frame-${i}`), i + 1)) {
          admitted += 1;
        }
      }

      // Cap + the one currently in flight; never buffer unbounded.
      expect(admitted).toBeGreaterThanOrEqual(1);
      expect(admitted).toBeLessThanOrEqual(17);
      expect(errors.some((report) => report.phase === "drop")).toBe(true);

      releaseGate();
      await journal.flushSession(session);

      expect(appendCalls).toBe(admitted);
      const records = await readNdjsonLines(journal.getSessionPath(session));
      expect(records).toHaveLength(admitted);
      for (let i = 1; i < records.length; i += 1) {
        expect(records[i].at).toBeGreaterThan(records[i - 1].at);
      }
    });
  });

  test("keeps a stopped session stopped even when a recovery was still in flight", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "stop-vs-recover-race";

      // Seed a durable 1-record journal.
      const seeder = new FrameJournal({ rootDir });
      expect(seeder.capture(session, makeOutputFrame(session, "seed-only"), 1)).toBe(true);
      await seeder.flushSession(session);
      expect(await readNdjsonLines(seeder.getSessionPath(session))).toHaveLength(1);

      const journal = new FrameJournal({ rootDir });
      // Kick off recovery but do not await — stop must win the race.
      const recovery = journal.recoverSession(session);
      await journal.stopSession(session);

      expect(journal.capture(session, makeOutputFrame(session, "must-not-write"), 2)).toBe(false);

      // Recovery may resolve or reject depending on scheduling; either is fine.
      await recovery.then(
        () => undefined,
        () => undefined,
      );
      await journal.flushSession(session);

      expect(await readNdjsonLines(journal.getSessionPath(session))).toHaveLength(1);
    });
  });

  test("releases per-session state on closeSession so long-lived hosts do not leak", async () => {
    await withTempRoot(async (rootDir) => {
      type FrameJournalWithClose = FrameJournal & {
        closeSession(session: string): Promise<void>;
        readonly sessionCount: number;
      };

      const journal = new FrameJournal({ rootDir }) as FrameJournalWithClose;
      const sessions = ["leak-a", "leak-b", "leak-c"] as const;

      for (const session of sessions) {
        expect(journal.capture(session, makeOutputFrame(session, `base-${session}`), 1)).toBe(true);
      }
      await journal.flushAll();
      expect(journal.sessionCount).toBe(3);

      for (const session of sessions) {
        await journal.closeSession(session);
      }
      expect(journal.sessionCount).toBe(0);

      // After close, a new capture for the same name is a fresh in-memory session:
      // admitted again, appends one more record, and that record must be a full frame
      // because the prior base was dropped from memory.
      const reopen = sessions[0];
      const path = journal.getSessionPath(reopen);
      const beforeCount = (await readNdjsonLines(path)).length;
      expect(journal.capture(reopen, makeOutputFrame(reopen, `after-close-${reopen}`), 2)).toBe(true);
      await journal.flushSession(reopen);

      const afterRecords = await readNdjsonLines(path);
      expect(afterRecords).toHaveLength(beforeCount + 1);
      expect(afterRecords[afterRecords.length - 1].frame.type).toBe("output");

      const recovered = await journal.recoverSession(reopen);
      expect(recovered.recordCount).toBe(beforeCount + 1);

      // stop() must also drop in-memory session tracking.
      const journal2 = new FrameJournal({ rootDir }) as FrameJournalWithClose;
      expect(journal2.capture("stop-evict", makeOutputFrame("stop-evict", "payload"), 1)).toBe(true);
      await journal2.flushAll();
      expect(journal2.sessionCount).toBe(1);
      await journal2.stop();
      expect(journal2.sessionCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // v0.4.0 durability defects (torn-write fail-closed, reopen maxBytes, root quota)
  // ---------------------------------------------------------------------------

  test("fails closed when torn-write rollback is unavailable so the next write cannot poison prior bytes", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "torn-rollback-unavailable";
      const errors: FrameJournalErrorReport[] = [];
      let file = "";
      let appendCount = 0;
      const storage: FrameJournalStorage = {
        ensureDirectory: async () => undefined,
        readText: async () => {
          if (file.length === 0) {
            const error = new Error("ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return file;
        },
        appendText: async (_path, source) => {
          appendCount += 1;
          if (appendCount === 1) {
            // Torn write: only a few bytes land, then the append rejects.
            // No storage.truncate — rollback is unavailable.
            file += source.slice(0, 5);
            throw new Error("simulated ENOSPC after partial append");
          }
          file += source;
        },
      };

      const journal = new FrameJournal({
        rootDir,
        storage,
        onError: (report) => errors.push(report),
      });
      journal.startSession(session);

      expect(journal.capture(session, makeOutputFrame(session, "first-frame"), 1)).toBe(true);
      await journal.flushSession(session);
      expect(errors.some((report) => report.phase === "write")).toBe(true);

      // Without fail-closed, the next capture appends a complete record after the
      // torn prefix and produces one malformed physical line that dooms recovery.
      const secondAdmitted = journal.capture(session, makeOutputFrame(session, "second-frame"), 2);
      await journal.flushSession(session);

      expect(secondAdmitted).toBe(false);
      expect(appendCount).toBe(1);
      expect(file).toBe('{"v":');
      // Future captures stay rejected until an explicit successful recovery/repair path.
      expect(journal.capture(session, makeOutputFrame(session, "third-frame"), 3)).toBe(false);
    });
  });

  test("fails closed when torn-write truncate itself fails", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "torn-truncate-fails";
      const errors: FrameJournalErrorReport[] = [];
      let file = "";
      let appendCount = 0;
      const storage: FrameJournalStorage = {
        ensureDirectory: async () => undefined,
        readText: async () => {
          if (file.length === 0) {
            const error = new Error("ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return file;
        },
        appendText: async (_path, source) => {
          appendCount += 1;
          if (appendCount === 1) {
            file += source.slice(0, 5);
            throw new Error("simulated ENOSPC after partial append");
          }
          file += source;
        },
        truncate: async () => {
          throw new Error("simulated truncate failure");
        },
      };

      const journal = new FrameJournal({
        rootDir,
        storage,
        onError: (report) => errors.push(report),
      });
      journal.startSession(session);

      expect(journal.capture(session, makeOutputFrame(session, "first-frame"), 1)).toBe(true);
      await journal.flushSession(session);

      expect(journal.capture(session, makeOutputFrame(session, "second-frame"), 2)).toBe(false);
      await journal.flushSession(session);
      expect(appendCount).toBe(1);
      expect(file).toBe('{"v":');
      expect(errors.some((report) => report.phase === "write")).toBe(true);
    });
  });

  test("enforces maxBytes against existing durable file length when reopening a journal", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "reopen-max-bytes";
      const seeder = new FrameJournal({ rootDir });
      const path = seeder.getSessionPath(session);
      // Large first record so durable length dominates; second capture is tiny so
      // the sync admission estimate alone still fits under maxBytes when bytes===0
      // (the reopen bypass: admission never sees the durable length).
      const payload = `seed-${"x".repeat(800)}`;
      expect(seeder.capture(session, makeOutputFrame(session, payload), 1)).toBe(true);
      await seeder.flushSession(session);
      const existingSize = (await stat(path)).size;
      expect(existingSize).toBeGreaterThan(800);

      // Headroom fits a tiny record's admission estimate but not existing+record.
      const maxBytes = existingSize + 40;
      const errors: FrameJournalErrorReport[] = [];
      const journal = new FrameJournal({
        rootDir,
        maxBytes,
        onError: (report) => errors.push(report),
      });

      // Tiny payload: estimate << existingSize, so a bytes===0 admission would allow it.
      const tiny = "n";
      const admitted = journal.capture(session, makeOutputFrame(session, tiny), 2);
      await journal.flushSession(session);

      const finalSize = (await stat(path)).size;
      // DEFECT: without fix, admitted===true and finalSize > maxBytes (and > existingSize).
      expect(finalSize).toBe(existingSize);
      expect(finalSize).toBeLessThanOrEqual(maxBytes);
      expect(errors.some((report) => report.phase === "limit")).toBe(true);
      // Whether admission returned true provisionally or false, the durable file must not grow
      // and further captures must stay rejected after the limit is observed.
      expect(journal.capture(session, makeOutputFrame(session, "after-limit"), 3)).toBe(false);
      void admitted;

      // Prior valid record must still recover/replay.
      const recovered = await new FrameJournal({ rootDir, maxBytes }).recoverSession(session);
      expect(recovered.recordCount).toBe(1);
      expect(recovered.base).toEqual(splitMuxOutputData(payload));
    });
  });

  test("enforces aggregate maxRootBytes and deletes closed session journals to reclaim quota", async () => {
    await withTempRoot(async (rootDir) => {
      const errors: FrameJournalErrorReport[] = [];
      const maxRootBytes = 2500;
      const journal = new FrameJournal({
        rootDir,
        // Per-session unlimited so the root quota is the binding constraint.
        maxBytes: Infinity,
        maxRootBytes,
        onError: (report) => errors.push(report),
      });

      let admitted = 0;
      for (let i = 0; i < 80; i += 1) {
        const data = `A-${String(i).padStart(3, "0")}-${"x".repeat(120)}`;
        if (journal.capture("sess-a", makeOutputFrame("sess-a", data, "resync"), i + 1)) {
          admitted += 1;
        }
      }
      await journal.flushSession("sess-a");

      const pathA = journal.getSessionPath("sess-a");
      const sizeA = (await stat(pathA)).size;
      expect(admitted).toBeGreaterThan(0);
      expect(sizeA).toBeLessThanOrEqual(maxRootBytes);
      expect(errors.some((report) => report.phase === "limit")).toBe(true);

      // Root quota is aggregate: a distinct session whose record cannot fit the
      // remaining headroom must be refused (not only the session that filled the root).
      const tooBigForRoot = `B-${"y".repeat(maxRootBytes)}`;
      expect(journal.capture("sess-b", makeOutputFrame("sess-b", tooBigForRoot), 1)).toBe(false);
      await journal.flushSession("sess-b");
      await expect(stat(journal.getSessionPath("sess-b"))).rejects.toBeDefined();

      // closeSession drops memory but leaves the durable file counted against the root.
      // (A refused capture still creates an in-memory handle — close both.)
      await journal.closeSession("sess-a");
      await journal.closeSession("sess-b");
      expect(journal.sessionCount).toBe(0);

      const journal2 = new FrameJournal({
        rootDir,
        maxBytes: Infinity,
        maxRootBytes,
        onError: (report) => errors.push(report),
      });
      // Rescanned root still holds sess-a — a record larger than remaining headroom is refused.
      expect(journal2.capture("sess-c", makeOutputFrame("sess-c", `C-${"z".repeat(maxRootBytes)}`), 1)).toBe(false);
      await journal2.flushSession("sess-c");

      const deleted = await journal2.deleteSessionJournal("sess-a");
      expect(deleted).toBe(true);
      await expect(stat(pathA)).rejects.toBeDefined();

      // Quota reclaimed: a new session can record again.
      expect(journal2.capture("sess-c", makeOutputFrame("sess-c", "C-ok"), 1)).toBe(true);
      await journal2.flushSession("sess-c");
      expect((await stat(journal2.getSessionPath("sess-c"))).size).toBeGreaterThan(0);
      const recovered = await journal2.recoverSession("sess-c");
      expect(recovered.recordCount).toBe(1);
      expect(recovered.base).toEqual(splitMuxOutputData("C-ok"));
    });
  });

  test("default maxRootBytes is a finite safe bound for unconfigured integrators", () => {
    // Import-time constant: integrators who pass nothing must not get unbounded root growth.
    expect(Number.isFinite(FrameJournal.DEFAULT_MAX_ROOT_BYTES)).toBe(true);
    expect(FrameJournal.DEFAULT_MAX_ROOT_BYTES).toBeGreaterThan(0);
    expect(FrameJournal.DEFAULT_MAX_ROOT_BYTES).toBeGreaterThanOrEqual(FrameJournal.DEFAULT_MAX_BYTES);
  });

  test("round-trips recorder output through the core replay parser", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "round-trip-session";
      const journal = new FrameJournal({ rootDir, checkpointCadence: 4 });

      // Shared spine so successive appends stay delta-eligible (strict-smaller).
      const spine = [
        "สวัสดี-😀 base line",
        "line ending with CR\r",
        ...Array.from({ length: 40 }, (_, index) => `spine-${String(index).padStart(2, "0")}-xxxxxxxxxx`),
      ];

      type Captured = {
        at: number;
        data: string;
        /** Expected reconstructed cursor after protocol delta inheritance. */
        expectedCursor: { row: number; col: number } | null | undefined;
        reset?: "resize";
      };

      const captures: Captured[] = [];
      let lastCursor: { row: number; col: number } | null | undefined = undefined;

      for (let i = 0; i < 25; i += 1) {
        const at = (i + 1) * 10;
        // Grow by appending so chooseMuxOutputFrame prefers deltas; trailing empty line preserved.
        const data = [...spine, ...Array.from({ length: i + 1 }, (_, j) => `extra-${j}-เพิ่ม`), ""].join("\n");

        if (i === 10) {
          // Explicit resize mid-stream forces a full checkpoint.
          const cursor = { row: i, col: 1 };
          const frame = {
            channel: session,
            type: "output" as const,
            data,
            cursor,
            reset: "resize" as const,
          };
          expect(journal.capture(session, frame, at)).toBe(true);
          lastCursor = cursor;
          captures.push({ at, data, expectedCursor: cursor, reset: "resize" });
        } else if (i === 7) {
          // Explicit null cursor.
          const frame = {
            channel: session,
            type: "output" as const,
            data,
            cursor: null,
          };
          expect(journal.capture(session, frame, at)).toBe(true);
          lastCursor = null;
          captures.push({ at, data, expectedCursor: null });
        } else if (i === 12) {
          // No cursor property — delta semantics inherit the previous cursor.
          // i=10 was resize (full), i=11 is delta #1, i=12 is delta #2 (not a cadence boundary).
          const frame = {
            channel: session,
            type: "output" as const,
            data,
          };
          expect(journal.capture(session, frame, at)).toBe(true);
          captures.push({ at, data, expectedCursor: lastCursor });
        } else {
          const cursor = { row: i, col: i % 5 };
          const frame = {
            channel: session,
            type: "output" as const,
            data,
            cursor,
          };
          expect(journal.capture(session, frame, at)).toBe(true);
          lastCursor = cursor;
          captures.push({ at, data, expectedCursor: cursor });
        }
      }

      await journal.flushSession(session);
      const fileText = await readFile(journal.getSessionPath(session), "utf8");
      const parsed = parseReplayJournal(fileText);
      expect(parsed.count).toBe(25);

      for (const captured of captures) {
        const frame = parsed.getFrameAt(captured.at);
        expect(frame.data).toBe(captured.data);
        if (captured.expectedCursor === undefined) {
          expect(frame.cursor).toBeUndefined();
        } else {
          expect(frame.cursor).toEqual(captured.expectedCursor);
        }
        if (captured.reset) {
          expect(frame.reset).toBe(captured.reset);
        }
      }

      // File must exercise both full and delta write paths.
      const rawRecords = parseNdjson(fileText);
      expect(rawRecords.some((record) => record.frame.type === "delta")).toBe(true);
      expect(rawRecords.filter((record) => record.frame.type === "output").length).toBeGreaterThan(1);
    });
  });

  test("rejects non-finite / non-integer cursor at admission (does not poison the journal)", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "cursor-poison";
      const journal = new FrameJournal({ rootDir });
      const path = journal.getSessionPath(session);

      // Seed one good full frame so we can prove invalid admission leaves the file intact.
      expect(
        journal.capture(session, {
          channel: session,
          type: "output",
          data: "seed",
          cursor: { row: 1, col: 2 },
        }, 1),
      ).toBe(true);
      await journal.flushSession(session);

      // Shape poison cases (cursor present but invalid):
      const poisonFrames: Array<{ cursor: unknown }> = [
        { cursor: { row: Number.NaN, col: 0 } },
        { cursor: { row: 0, col: Number.NaN } },
        { cursor: { row: Number.POSITIVE_INFINITY, col: 0 } },
        { cursor: { row: 0, col: Number.NEGATIVE_INFINITY } },
        { cursor: { row: 1.5, col: 0 } },
        { cursor: { row: 0, col: 2.7 } },
        { cursor: { row: "1", col: 0 } },
        { cursor: { row: 0, col: null } },
        { cursor: { row: 1 } },
        { cursor: { row: 1, col: 2, extra: 3 } },
        { cursor: [] },
        { cursor: "1,2" },
        { cursor: 42 },
      ];

      for (const poison of poisonFrames) {
        const frame = {
          channel: session,
          type: "output" as const,
          data: "poison",
          ...poison,
        };
        // Inadmissible shape: throw (same convention as bad type/channel/data) OR return false.
        // Either way, nothing new may land on disk.
        let admitted = false;
        try {
          admitted = journal.capture(session, frame as Parameters<FrameJournal["capture"]>[1], 2);
        } catch {
          admitted = false;
        }
        expect(admitted).toBe(false);
      }

      await journal.flushSession(session);
      const fileText = await readFile(path, "utf8");
      const records = parseNdjson(fileText);
      expect(records).toHaveLength(1);
      expect(records[0]?.frame.data).toBe("seed");
      // Must remain replayable — the whole point of fail-closed admission.
      expect(() => parseReplayJournal(fileText)).not.toThrow();
      const replayed = parseReplayJournal(fileText);
      expect(replayed.count).toBe(1);
      expect(replayed.getFrameAt(1).cursor).toEqual({ row: 1, col: 2 });
    });
  });

  test("rejects invalid reset at admission (does not poison the journal)", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "reset-poison";
      const journal = new FrameJournal({ rootDir });
      const path = journal.getSessionPath(session);

      expect(
        journal.capture(session, {
          channel: session,
          type: "output",
          data: "seed",
          reset: "resize",
        }, 1),
      ).toBe(true);
      await journal.flushSession(session);

      const poisonResets: unknown[] = ["bogus", "re-sync", "RESIZE", "", 1, null, true, {}];
      for (const reset of poisonResets) {
        const frame = {
          channel: session,
          type: "output" as const,
          data: "poison",
          reset,
        };
        let admitted = false;
        try {
          admitted = journal.capture(session, frame as Parameters<FrameJournal["capture"]>[1], 2);
        } catch {
          admitted = false;
        }
        expect(admitted).toBe(false);
      }

      await journal.flushSession(session);
      const fileText = await readFile(path, "utf8");
      const records = parseNdjson(fileText);
      expect(records).toHaveLength(1);
      expect(records[0]?.frame.reset).toBe("resize");
      expect(() => parseReplayJournal(fileText)).not.toThrow();
    });
  });

  test("admits valid cursor/reset and round-trips through parseReplayJournal", async () => {
    await withTempRoot(async (rootDir) => {
      const session = "cursor-reset-ok";
      const journal = new FrameJournal({ rootDir });

      const cases: Array<{
        at: number;
        data: string;
        cursor?: { row: number; col: number } | null;
        reset?: "resize" | "resync";
      }> = [
        { at: 1, data: "full-0", cursor: { row: 0, col: 0 } },
        { at: 2, data: "full-null", cursor: null },
        { at: 3, data: "full-neg", cursor: { row: -3, col: 9 }, reset: "resync" },
        { at: 4, data: "full-resize", cursor: { row: 10, col: 20 }, reset: "resize" },
        { at: 5, data: "full-plain" }, // no cursor, no reset
      ];

      for (const c of cases) {
        const frame = {
          channel: session,
          type: "output" as const,
          data: c.data,
          ...(c.cursor !== undefined ? { cursor: c.cursor } : {}),
          ...(c.reset !== undefined ? { reset: c.reset } : {}),
        };
        expect(journal.capture(session, frame, c.at)).toBe(true);
      }

      await journal.flushSession(session);
      const fileText = await readFile(journal.getSessionPath(session), "utf8");
      const parsed = parseReplayJournal(fileText);
      expect(parsed.count).toBe(cases.length);

      for (const c of cases) {
        const frame = parsed.getFrameAt(c.at);
        expect(frame.data).toBe(c.data);
        if (c.cursor === undefined) {
          expect(frame.cursor).toBeUndefined();
        } else {
          expect(frame.cursor).toEqual(c.cursor);
        }
        if (c.reset !== undefined) {
          expect(frame.reset).toBe(c.reset);
        }
      }
    });
  });
});
