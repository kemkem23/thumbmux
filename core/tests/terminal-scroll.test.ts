import { describe, expect, test } from "bun:test";
import {
  consumeWholeWheelLines,
  findLineOverlap,
  mergeCapturedLinesForStableScroll,
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
