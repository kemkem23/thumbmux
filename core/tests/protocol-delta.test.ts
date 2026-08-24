import { describe, expect, test } from "bun:test";
import {
  applyMuxDelta,
  chooseMuxOutputFrame,
  createMuxDeltaFrame,
  fnv1a32,
  muxPrefixHash,
  muxHistoryBoundaryTransition,
  serializedMuxFrameSize,
  shouldUseMuxDelta,
  splitMuxOutputData,
  validateMuxDeltaFrame,
  validateMuxHistoryBoundary,
  type MuxDeltaFrame,
  type MuxFullOutputFrame,
} from "../src/protocol";

describe("mux delta protocol", () => {
  test("hashes JSON line arrays as UTF-8 with stable lowercase vectors", () => {
    expect(fnv1a32("[]")).toBe("741638a5");
    expect(fnv1a32('["a"]')).toBe("ca0f9962");
    expect(muxPrefixHash(["ไทย", "😀", ""])).toBe("fa3c1882");
  });

  /**
   * Wire-stable: client and server both call fnv1a32 on the same UTF-8 bytes
   * and compare hex digests across the wire. A one-byte algorithm drift causes
   * either a resync storm (always mismatch) or a false match (silent corruption).
   * Vectors were captured from the pre-optimization iterator implementation
   * (`for (const byte of new TextEncoder().encode(value))`) at HEAD so the
   * indexed-loop rewrite must remain byte-identical on this corpus.
   */
  test("fnv1a32 is byte-identical to the pre-optimization iterator corpus", () => {
    const corpus: Array<{ label: string; value: string; expected: string }> = [
      { label: "empty", value: "", expected: "811c9dc5" },
      { label: "ascii", value: "hello world", expected: "d58b3fa7" },
      { label: "ascii_json", value: "[]", expected: "741638a5" },
      { label: "ascii_json_a", value: '["a"]', expected: "ca0f9962" },
      { label: "multiline", value: "line1\nline2\nline3", expected: "fb3c2175" },
      { label: "thai multi-byte UTF-8", value: "ไทย", expected: "1426044f" },
      { label: "emoji", value: "😀", expected: "33a29608" },
      {
        label: "mixed thai+emoji+empty via muxPrefixHash input",
        value: JSON.stringify(["ไทย", "😀", ""]),
        expected: "fa3c1882",
      },
      {
        label: "astral / ZWJ skin-tone sequence",
        value: "𝄞 music 🚀 and 👍🏽",
        expected: "d1fc168f",
      },
      { label: "control bytes", value: "a\u0000b\u0007c", expected: "e67ec544" },
      {
        label: "large ~348 KB (real delta-base size)",
        value: "x".repeat(348 * 1024),
        expected: "d9db5dc5",
      },
    ];

    for (const { label, value, expected } of corpus) {
      expect(fnv1a32(value), label).toBe(expected);
    }

    // Cross-check against a frozen reference of the old iterator walk so a
    // future "optimization" that changes the digest fails loudly here.
    function fnv1a32IteratorReference(value: string): string {
      let hash = 0x811c9dc5;
      for (const byte of new TextEncoder().encode(value)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
    for (const { label, value } of corpus) {
      expect(fnv1a32(value), `${label} vs iterator reference`).toBe(
        fnv1a32IteratorReference(value),
      );
    }
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
      // Negative col is 0-based-cells contract violation (A1-12).
      { ...delta, cursor: { row: 0, col: -1 } },
    ];

    for (const frame of invalid) {
      expect(validateMuxDeltaFrame(frame, base)).toBeNull();
      expect(applyMuxDelta(base, frame)).toBeNull();
    }
  });

  test("accepts a valid non-negative cursor on a delta", () => {
    const base = ["one", "two"];
    const delta = createMuxDeltaFrame("terminal", base, ["one", "three"], { row: -2, col: 0 });
    expect(validateMuxDeltaFrame(delta, base)).not.toBeNull();
    expect(applyMuxDelta(base, delta)).toEqual(["one", "three"]);
  });

  test("accepts a valid MuxPaneScreen on a delta and rejects a malformed one", () => {
    const base = ["one", "two"];
    const good = createMuxDeltaFrame("terminal", base, ["one", "three"], { row: 0, col: 1 });
    good.screen = { alt: true, mouseSgr: true, mouseAny: false };
    expect(good.screen).toEqual({ alt: true, mouseSgr: true, mouseAny: false });
    expect(validateMuxDeltaFrame(good, base)).not.toBeNull();
    expect(applyMuxDelta(base, good)).toEqual(["one", "three"]);

    const badScreen: unknown[] = [
      { ...good, screen: { alt: 1, mouseSgr: true, mouseAny: false } },
      { ...good, screen: { alt: true, mouseSgr: true } },
      { ...good, screen: "alt" },
    ];
    for (const frame of badScreen) {
      expect(validateMuxDeltaFrame(frame, base)).toBeNull();
      expect(applyMuxDelta(base, frame)).toBeNull();
    }

    // null screen is authoritative "unknown / hidden" (same as cursor).
    const withNull = { ...good, screen: null };
    expect(validateMuxDeltaFrame(withNull, base)).not.toBeNull();
  });

  test("chooseMuxOutputFrame carries screen onto a chosen delta", () => {
    const base = Array.from({ length: 30 }, (_, index) => `stable-${index}`);
    const next = [...base.slice(0, -1), "changed"];
    const screen = { alt: true, mouseSgr: true, mouseAny: true };
    const full: MuxFullOutputFrame = {
      channel: "terminal",
      type: "output",
      data: next.join("\n"),
      cursor: { row: 0, col: 0 },
      screen,
    };
    const chosen = chooseMuxOutputFrame(full, base);
    expect(chosen.type).toBe("delta");
    expect(chosen.screen).toEqual(screen);
  });

  test("carries a validated durable history boundary on full and delta frames", () => {
    const boundary = {
      generation: "wal-generation-1",
      liveStartLine: 42_000,
      walSequence: "18446744073709551615",
      walOffset: 9_000_000,
    };
    expect(validateMuxHistoryBoundary(boundary)).toEqual(boundary);
    expect(validateMuxHistoryBoundary({ ...boundary, walSequence: "01" })).toBeNull();
    expect(validateMuxHistoryBoundary({ ...boundary, liveStartLine: -1 })).toBeNull();

    const base = Array.from({ length: 30 }, (_, index) => `stable-${index}`);
    const full: MuxFullOutputFrame = {
      channel: "terminal",
      type: "output",
      data: [...base.slice(0, -1), "changed"].join("\n"),
      boundary,
    };
    const chosen = chooseMuxOutputFrame(full, base);
    expect(chosen.type).toBe("delta");
    expect(chosen.boundary).toEqual(boundary);
    expect(validateMuxDeltaFrame(chosen, base)).not.toBeNull();
    expect(validateMuxDeltaFrame({ ...chosen, boundary: { ...boundary, walOffset: -1 } }, base)).toBeNull();
  });

  test("classifies durable seam advance, regression, and generation reset", () => {
    const previous = {
      generation: "g1",
      liveStartLine: 100,
      walSequence: "99",
      walOffset: 1_000,
    };
    expect(muxHistoryBoundaryTransition(previous, { ...previous })).toBe("same");
    expect(muxHistoryBoundaryTransition(previous, {
      ...previous,
      liveStartLine: 101,
      walSequence: "100",
      walOffset: 1_100,
    })).toBe("advance");
    expect(muxHistoryBoundaryTransition(previous, {
      ...previous,
      liveStartLine: 99,
    })).toBe("regression");
    expect(muxHistoryBoundaryTransition(previous, {
      ...previous,
      generation: "g2",
      liveStartLine: 0,
      walSequence: "1",
      walOffset: 64,
    })).toBe("generation-mismatch");
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
