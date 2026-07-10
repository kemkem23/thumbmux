import { describe, expect, test } from "bun:test";
import {
  applyMuxDelta,
  chooseMuxOutputFrame,
  createMuxDeltaFrame,
  fnv1a32,
  muxPrefixHash,
  serializedMuxFrameSize,
  shouldUseMuxDelta,
  splitMuxOutputData,
  validateMuxDeltaFrame,
  type MuxDeltaFrame,
  type MuxFullOutputFrame,
} from "../src/protocol";

describe("mux delta protocol", () => {
  test("hashes JSON line arrays as UTF-8 with stable lowercase vectors", () => {
    expect(fnv1a32("[]")).toBe("741638a5");
    expect(fnv1a32('["a"]')).toBe("ca0f9962");
    expect(muxPrefixHash(["ไทย", "😀", ""])).toBe("fa3c1882");
  });

  test("keeps Unicode and a final empty line in the raw base", () => {
    const base = splitMuxOutputData("ไทย\n😀\n");
    const next = splitMuxOutputData("ไทย\n😀\nใหม่\n");
    const delta = createMuxDeltaFrame("terminal", base, next, { row: 1, col: 3 });

    expect(base).toEqual(["ไทย", "😀", ""]);
    expect(splitMuxOutputData("one\r\ntwo\r\n")).toEqual(["one\r", "two\r", ""]);
    expect(delta).toMatchObject({
      channel: "terminal",
      type: "delta",
      baseLength: 3,
      prefix: 2,
      prefixHash: muxPrefixHash(["ไทย", "😀"]),
      lines: ["ใหม่", ""],
      cursor: { row: 1, col: 3 },
    });
    expect(applyMuxDelta(base, delta)).toEqual(next);
  });

  test("uses a replacement suffix for edits and truncation", () => {
    const base = ["keep", "replace", "remove", "also-remove"];
    const replacement = createMuxDeltaFrame("terminal", base, ["keep", "new"]);
    const truncation = createMuxDeltaFrame("terminal", base, ["keep"]);

    expect(replacement.prefix).toBe(1);
    expect(replacement.lines).toEqual(["new"]);
    expect(applyMuxDelta(base, replacement)).toEqual(["keep", "new"]);
    expect(truncation.prefix).toBe(1);
    expect(truncation.lines).toEqual([]);
    expect(applyMuxDelta(base, truncation)).toEqual(["keep"]);
  });

  test("rejects every stale or malformed base condition without reconstructing", () => {
    const base = ["one", "two"];
    const delta = createMuxDeltaFrame("terminal", base, ["one", "three"]);
    const invalid: unknown[] = [
      { ...delta, baseLength: 1 },
      { ...delta, baseLength: 2.5 },
      { ...delta, prefix: -1 },
      { ...delta, prefix: 3 },
      { ...delta, prefix: 1.25 },
      { ...delta, prefixHash: "00000000" },
      { ...delta, lines: ["three", 4] },
      { ...delta, cursor: { row: 0.5, col: 1 } },
    ];

    for (const frame of invalid) {
      expect(validateMuxDeltaFrame(frame, base)).toBeNull();
      expect(applyMuxDelta(base, frame)).toBeNull();
    }
  });

  test("chooses only a strict smaller delta and never turns reset output into one", () => {
    const base = Array.from({ length: 30 }, (_, index) => `stable-${index}`);
    const next = [...base.slice(0, -1), "changed"];
    const full: MuxFullOutputFrame = {
      channel: "terminal",
      type: "output",
      data: next.join("\n"),
      cursor: { row: 0, col: 0 },
    };
    const delta = createMuxDeltaFrame("terminal", base, next, full.cursor);
    const chosen = chooseMuxOutputFrame(full, base);

    expect(delta.prefix).toBe(29);
    expect(serializedMuxFrameSize(delta)).toBeLessThan(serializedMuxFrameSize(full));
    expect(chosen).toEqual(delta);
    expect(applyMuxDelta(base, chosen)).toEqual(next);

    const equalDelta: MuxDeltaFrame = {
      channel: "terminal",
      type: "delta",
      baseLength: 1,
      prefix: 1,
      prefixHash: muxPrefixHash(["base"]),
      lines: [],
    };
    const emptyFull: MuxFullOutputFrame = { channel: "terminal", type: "output", data: "" };
    const equalFull: MuxFullOutputFrame = {
      ...emptyFull,
      data: "x".repeat(serializedMuxFrameSize(equalDelta) - serializedMuxFrameSize(emptyFull)),
    };

    expect(serializedMuxFrameSize(equalFull)).toBe(serializedMuxFrameSize(equalDelta));
    expect(shouldUseMuxDelta(equalFull, equalDelta)).toBe(false);
    expect(shouldUseMuxDelta({ ...full, reset: "resize" }, delta)).toBe(false);
  });
});
