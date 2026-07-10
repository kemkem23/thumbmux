import { describe, expect, test } from "bun:test";
import {
  consumeWholeWheelLines,
  findLineOverlap,
  mergeCapturedLinesForStableScroll,
  readerAnchorLineDelta,
  wheelDeltaToLines,
} from "../src/terminal-scroll";

function numberedLines(start: number, end: number): string[] {
  return Array.from({ length: end - start + 1 }, (_, idx) => `line-${start + idx}`);
}

describe("terminal scroll helpers", () => {
  test("detects overlap when live capture shifts forward", () => {
    expect(findLineOverlap(numberedLines(1, 10), numberedLines(4, 13))).toBe(7);
  });

  test("merges shifted live capture while preserving old lines for a scrolled reader", () => {
    const previous = numberedLines(1, 1000);
    const next = numberedLines(2, 1001);

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(1);
    expect(merged.lines.length).toBe(1001);
    expect(merged.lines[0]).toBe("line-1");
    expect(merged.lines.at(-1)).toBe("line-1001");
  });

  test("replaces unrelated captures instead of merging repeated noise", () => {
    const merged = mergeCapturedLinesForStableScroll(
      ["ready", "", "prompt"],
      ["ready", "", "other"],
    );

    expect(merged.preservedPrefix).toBe(false);
    expect(merged.lines).toEqual(["ready", "", "other"]);
  });

  test("compensates a live append that rewrites at most two tail rows", () => {
    const stable = numberedLines(1, 100);
    const previous = [...stable, "progress 10%", "prompt old"];
    const next = [...stable, "progress 20%", "prompt new", "result", "prompt newest"];

    expect(readerAnchorLineDelta(previous, next)).toBe(2);
  });

  test("compensates a tail trim but rejects a rewrite beyond the safe tail", () => {
    const stable = numberedLines(1, 100);
    expect(readerAnchorLineDelta(
      [...stable, "tail one", "tail two"],
      [...stable, "tail one"],
    )).toBe(-1);

    expect(readerAnchorLineDelta(
      [...stable, "old one", "old two", "old three"],
      [...stable, "new one", "new two", "new three", "append"],
    )).toBe(0);
  });

  test("uses the two-tail common-prefix rule for short captures", () => {
    expect(readerAnchorLineDelta(
      ["ready", "", "prompt"],
      ["ready", "", "other", "new"],
    )).toBe(1);
    expect(readerAnchorLineDelta(
      ["ready", "old", "prompt"],
      ["other", "new", "prompt", "tail"],
    )).toBe(0);
  });

  test("converts pixel wheel deltas into fractional line movement", () => {
    const lines = wheelDeltaToLines({ deltaY: 1, deltaMode: 0 }, 18, 50);
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThan(1);
  });

  test("consumes wheel remainder gradually and clamps large frames", () => {
    expect(consumeWholeWheelLines(0.8)).toEqual({ wholeLines: 0, remainder: 0.8 });
    expect(consumeWholeWheelLines(20)).toEqual({ wholeLines: 12, remainder: 8 });
    expect(consumeWholeWheelLines(-20)).toEqual({ wholeLines: -12, remainder: -8 });
  });
});
