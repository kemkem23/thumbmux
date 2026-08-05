import { describe, expect, test } from "bun:test";
import {
  createMuxDeltaFrame,
  shouldUseMuxDelta,
  type MuxCursor,
  type MuxFullOutputFrame,
} from "../src/protocol";
import { parseReplayJournal, type JournalRecordV1 } from "../src/replay";

function toSource(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function fullRecord(
  session: string,
  at: number,
  data: string,
  opts?: {
    cursor?: MuxCursor | null;
    reset?: "resize" | "resync";
  },
): JournalRecordV1 {
  const frame: MuxFullOutputFrame = {
    channel: session,
    type: "output",
    data,
  };
  if (opts?.cursor !== undefined) {
    frame.cursor = opts.cursor;
  }
  if (opts?.reset !== undefined) {
    frame.reset = opts.reset;
  }
  return {
    v: 1,
    session,
    at,
    frame,
  };
}

function deltaRecord(
  session: string,
  at: number,
  base: readonly string[],
  next: readonly string[],
  cursor?: MuxCursor | null,
): JournalRecordV1 {
  return {
    v: 1,
    session,
    at,
    frame: createMuxDeltaFrame(session, base, next, cursor),
  };
}

function longLine(seed: string): string {
  return `${seed}-${"x".repeat(96)}`;
}

describe("ReplayJournal", () => {
  test("reconstructs full/delta output for Unicode and CR lines with timeline clamping", () => {
    const session = "unicode-cr";
    const base = [
      `${"ไทย".repeat(64)}\r`,
      `${"😀".repeat(64)}\r`,
      `${"x".repeat(120)}\r`,
      `${"y".repeat(120)}\r`,
      `${"z".repeat(120)}\r`,
      `${"w".repeat(120)}\r`,
      "",
    ];
    const next = [
      `${"ไทย".repeat(64)}\r`,
      `${"😀".repeat(64)}\r`,
      `${"x".repeat(120)}\r`,
      `${"y".repeat(120)}\r`,
      `${"z".repeat(120)}`,
      `${"w".repeat(120)}-update`,
      "",
    ];
    const baseData = base.join("\n");
    const nextData = next.join("\n");
    const records: JournalRecordV1[] = [
      fullRecord(session, 100, baseData),
      deltaRecord(session, 200, base, next, { row: 2, col: 1 }),
    ];

    const journal = parseReplayJournal(toSource(records));

    expect(journal.sessionName).toBe(session);
    expect(journal.count).toBe(2);
    expect(journal.checkpointCount).toBe(1);
    expect(journal.startAt).toBe(100);
    expect(journal.endAt).toBe(200);
    expect(journal.durationMs).toBe(100);

    expect(journal.getLinesAt(0)).toEqual(base);
    expect(journal.getFrameAt(0).data).toBe(baseData);
    expect(journal.getFrameAt(100).data).toBe(baseData);
    expect(journal.getLinesAt(150)).toEqual(base);
    expect(journal.getLinesAt(200)).toEqual(next);
    expect(journal.getFrameAt(200).data).toBe(nextData);
    expect(journal.getFrameAt(200).cursor).toEqual({ row: 2, col: 1 });
    expect(journal.getLinesAt(250)).toEqual(next);
    expect(journal.getFrameAt(250).data).toBe(nextData);
    expect(journal.getFrameAt(250).data.endsWith("\n")).toBe(true);
  });

  test("equal timestamps: seek(endAt) returns the last record, not the first (A2-3)", () => {
    // Recorder wall-clock ms can stamp two full frames with the same `at`.
    // durationMs becomes 0 and startAt === endAt; a player clamped to the
    // timeline must still be able to display the final state at endAt.
    const session = "equal-ts";
    const records: JournalRecordV1[] = [
      fullRecord(session, 100, "first"),
      fullRecord(session, 100, "second"),
    ];
    const journal = parseReplayJournal(toSource(records));

    expect(journal.startAt).toBe(100);
    expect(journal.endAt).toBe(100);
    expect(journal.durationMs).toBe(0);
    expect(journal.count).toBe(2);

    // Before the timeline: still clamps to the first record.
    expect(journal.seek(99).recordIndex).toBe(0);
    expect(journal.getLinesAt(99)).toEqual(["first"]);

    // At endAt (and startAt): latest record with at <= time — the final state.
    const atEnd = journal.seek(journal.endAt);
    expect(atEnd.recordIndex).toBe(1);
    expect(atEnd.lines).toEqual(["second"]);
    expect(journal.getLinesAt(100)).toEqual(["second"]);

    // Past endAt: still the last record.
    expect(journal.seek(101).recordIndex).toBe(1);
    expect(journal.getLinesAt(101)).toEqual(["second"]);
  });

  test("uses later full frames as checkpoints and preserves reset semantics in seeks", () => {
    const session = "checkpoint-reset";
    const firstBase = [
      ...Array.from({ length: 8 }, (_, index) => longLine(`checkpoint-a-${index}`)),
      "",
    ];
    const firstNext = [...firstBase];
    firstNext[6] = `${firstNext[6]}-delta`;

    const checkpoint = [
      ...Array.from({ length: 8 }, (_, index) => longLine(`checkpoint-full-${index}`)),
      "",
    ];
    const checkpointNext = [...checkpoint];
    checkpointNext[6] = `${checkpointNext[6]}-after`;

    const records: JournalRecordV1[] = [
      fullRecord(session, 1, firstBase.join("\n")),
      deltaRecord(session, 2, firstBase, firstNext),
      fullRecord(session, 3, checkpoint.join("\n"), { reset: "resync" }),
      deltaRecord(session, 4, checkpoint, checkpointNext),
    ];

    const journal = parseReplayJournal(toSource(records));

    expect(journal.checkpointCount).toBe(2);
    expect(journal.getFrameAt(2).data).toBe(firstNext.join("\n"));
    expect(journal.getFrameAt(2.5).data).toBe(firstNext.join("\n"));
    expect(journal.getFrameAt(3).reset).toBe("resync");
    expect(journal.getFrameAt(3).data).toBe(checkpoint.join("\n"));
    expect(journal.getFrameAt(3.9).data).toBe(checkpoint.join("\n"));
    expect(journal.getFrameAt(4).data).toBe(checkpointNext.join("\n"));
  });

  test("returns checkpoint snapshots by value so callers cannot mutate seekable state", () => {
    const session = "immutable-checkpoint";
    const pre = [
      `${longLine("immutable-pre")}-0`,
      `${longLine("immutable-pre")}-1`,
      "",
    ];
    const checkpoint = [
      `${longLine("immutable-full")}-0`,
      `${longLine("immutable-full")}-1`,
      "",
    ];
    const after = [...checkpoint];
    after[1] = `${after[1]}-delta`;

    const journal = parseReplayJournal(toSource([
      fullRecord(session, 10, pre.join("\n")),
      fullRecord(session, 20, checkpoint.join("\n")),
      deltaRecord(session, 30, checkpoint, after),
    ]));

    const snapshots = journal.fullCheckpoints;
    snapshots[1].frame.data = "tampered";
    (snapshots[1].lines as string[])[1] = "tampered";

    expect(journal.getFrameAt(30).data).toBe(after.join("\n"));
    expect(journal.fullCheckpoints[1].frame.data).toBe(checkpoint.join("\n"));
    expect(journal.fullCheckpoints[1].lines[1]).toBe(checkpoint[1]);
  });

  test("rejects a first record that is not a full frame", () => {
    const session = "first-delta";
    const base = ["base", "", ""];
    const next = [...base, "next"];

    expect(() => {
      parseReplayJournal(`${JSON.stringify({
        v: 1,
        session,
        at: 0,
        frame: createMuxDeltaFrame(session, base, next),
      })}\n`);
    }).toThrow();
  });

  test("rejects session mismatch and session/channel mismatch conditions", () => {
    const session = "session-mismatch";
    const base = ["alpha", ""];

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, base.join("\n")),
        fullRecord("other", 2, base.join("\n")),
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, base.join("\n")),
        {
          v: 1,
          session,
          at: 2,
          frame: {
            channel: "other",
            type: "output",
            data: base.join("\n"),
          },
        },
      ]));
    }).toThrow();
  });

  test("rejects malformed, unknown, and malformed-field records/frames", () => {
    const session = "bad-frames";

    expect(() => {
      parseReplayJournal("{ not json\n");
    }).toThrow();

    expect(() => {
      parseReplayJournal(`{"v":1,"session":"${session}","at":1}\n`);
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, "seed"),
        {
          v: 1,
          session,
          at: 2,
          frame: {
            channel: session,
            type: "unsupported",
            data: "seed",
          },
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, "seed"),
        {
          v: 1,
          session,
          at: 2,
          frame: {
            channel: session,
            type: "output",
            data: "seed",
            unknown: 42,
          },
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        {
          v: 1,
          session,
          at: 1,
          frame: {
            channel: session,
            type: "output",
            data: "seed",
            cursor: { row: "1", col: 2 },
          },
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        {
          v: 1,
          session,
          at: 1,
          frame: {
            channel: session,
            type: "output",
            data: "seed",
            cursor: { row: 1, col: 2, extra: true },
          },
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        {
          v: 1,
          session,
          at: 1,
          frame: {
            channel: session,
            type: "output",
            data: "seed",
            reset: "unknown",
          },
        },
      ]));
    }).toThrow();
  });

  test("rejects out-of-order, non-finite timestamps", () => {
    const session = "bad-time";

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 2, "one"),
        fullRecord(session, 1, "two"),
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, NaN, "one"),
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, Number.POSITIVE_INFINITY, "one"),
      ]));
    }).toThrow();
  });

  test("rejects stale baseLength, bad prefix/hash, and strict-size-ineligible deltas", () => {
    const session = "delta-validation";
    const base = [
      longLine("delta-base"),
      longLine("delta-base-2"),
      longLine("delta-base-3"),
      longLine("delta-base-4"),
      longLine("delta-base-5"),
      longLine("delta-base-6"),
      longLine("delta-base-7"),
      longLine("delta-base-8"),
      "",
    ];
    const next = [...base];
    next[4] = `${next[4]}-changed`;

    const validDelta = createMuxDeltaFrame(session, base, next);
    const strictSession = "strict-size";
    const strictBase = ["strict-size", "base"];
    const strictNext = ["strict-size", "next"];
    const strictDelta = createMuxDeltaFrame(strictSession, strictBase, strictNext);
    expect(shouldUseMuxDelta({ channel: strictSession, type: "output", data: strictNext.join("\n") }, strictDelta)).toBe(false);

    const staleBaseLength = {
      ...validDelta,
      baseLength: validDelta.baseLength + 1,
    };

    const badPrefix = {
      ...validDelta,
      prefix: -1,
    };

    const badPrefixHash = {
      ...validDelta,
      prefixHash: validDelta.prefixHash === "00000000" ? "ffffffff" : "00000000",
    };

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, base.join("\n")),
        {
          v: 1,
          session,
          at: 2,
          frame: staleBaseLength,
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, base.join("\n")),
        {
          v: 1,
          session,
          at: 2,
          frame: badPrefix,
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(session, 1, base.join("\n")),
        {
          v: 1,
          session,
          at: 2,
          frame: badPrefixHash,
        },
      ]));
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([
        fullRecord(strictSession, 1, strictBase.join("\n")),
        {
          v: 1,
          session: strictSession,
          at: 2,
          frame: strictDelta,
        },
      ]));
    }).toThrow();
  });

  test("keeps recovery deterministic for truncated final physical lines and rejects complete trailing/bad records", () => {
    const session = "recovery";
    const base = ["line", ""];

    const journal = parseReplayJournal(
      toSource([fullRecord(session, 1, base.join("\n"))]) +
        JSON.stringify(fullRecord(session, 2, "must-not-be-read")),
    );
    expect(journal.count).toBe(1);
    expect(journal.getFrameAt(999).data).toBe(base.join("\n"));

    expect(() => {
      parseReplayJournal(toSource([fullRecord(session, 1, base.join("\n"))]) + "\n");
    }).toThrow();

    expect(() => {
      parseReplayJournal(toSource([fullRecord(session, 1, base.join("\n"))]) + "{\n");
    }).toThrow();

    expect(() => {
      parseReplayJournal(
        toSource([fullRecord(session, 1, base.join("\n"))]) + "{\"v\": 1\n" + "{\"v\":1",
      );
    }).toThrow();

    expect(() => {
      parseReplayJournal(
        toSource([fullRecord(session, 1, base.join("\n"))]) +
          `{"v":1,"session":"${session}","at":"bad","frame":{"channel":"${session}","type":"output","data":"seed"}}\n` +
          "{\"v\":1",
      );
    }).toThrow();
  });

  // ---------------------------------------------------------------------------
  // v0.4.0 B3 defect pins (these MUST fail until seek memoization/checkpoints land)
  // ---------------------------------------------------------------------------

  test("reconstructs bounded-cost seeks on a long delta run", () => {
    // Pre-fix measured cost (2026-07): ~158–169 ms per seek on a journal of
    // 1 full + 4000–6000 last-line deltas, with NO memoization and reconstruction
    // always restarting from the sole full-frame checkpoint. 80 seeks therefore
    // take well over 10 s. Budget below is ~4× headroom over a fixed implementation.
    const session = "long-delta-seek-cost";
    const lineWidth = 200;
    let current = Array.from(
      { length: 12 },
      (_, index) => `${"x".repeat(lineWidth)}-base-${index}`,
    );
    const records: JournalRecordV1[] = [
      fullRecord(session, 0, current.join("\n")),
    ];

    for (let i = 1; i <= 6000; i += 1) {
      const next = current.slice();
      next[next.length - 1] = `${"y".repeat(lineWidth)}-delta-${i}`;
      records.push(deltaRecord(session, i, current, next));
      current = next;
    }

    const journal = parseReplayJournal(toSource(records));
    expect(journal.count).toBe(6001);

    const started = performance.now();
    for (let i = 0; i < 40; i += 1) {
      // Alternating end / middle exercises both the repeat-path and a backwards seek.
      journal.getFrameAt(6000);
      journal.getFrameAt(3000);
    }
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2000);
  }, 120_000);

  test("returns ground-truth state for every index regardless of seek order", () => {
    const session = "seek-order-correctness";
    const lineWidth = 80;
    let current = Array.from(
      { length: 8 },
      (_, index) => `${"a".repeat(lineWidth)}-base-${index}`,
    );
    const expected: string[][] = [current.slice()];
    const records: JournalRecordV1[] = [
      fullRecord(session, 0, current.join("\n")),
    ];

    for (let i = 1; i <= 200; i += 1) {
      const next = current.slice();
      next[next.length - 1] = `${"b".repeat(lineWidth)}-delta-${i}`;
      records.push(deltaRecord(session, i, current, next));
      current = next;
      expected.push(current.slice());
    }

    const journal = parseReplayJournal(toSource(records));
    expect(journal.count).toBe(201);

    const indices = Array.from({ length: 201 }, (_, index) => index);

    // Ascending
    for (const i of indices) {
      expect(journal.getLinesAt(i)).toEqual(expected[i]);
    }

    // Descending
    for (let i = indices.length - 1; i >= 0; i -= 1) {
      expect(journal.getLinesAt(i)).toEqual(expected[i]);
    }

    // Shuffled-but-deterministic (stride 37 modulo 201 covers every index).
    for (let step = 0; step < 201; step += 1) {
      const i = (step * 37) % 201;
      expect(journal.getLinesAt(i)).toEqual(expected[i]);
    }

    for (const i of [0, 1, 50, 100, 150, 200]) {
      expect(journal.getFrameAt(i).data).toBe(expected[i].join("\n"));
    }
  });
});
