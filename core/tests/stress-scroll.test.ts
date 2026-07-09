import { describe, expect, test } from "bun:test";

import {
  MAX_WHEEL_LINES_PER_FRAME,
  consumeWholeWheelLines,
  mergeCapturedLinesForStableScroll,
  wheelDeltaToLines,
  type WheelDeltaInput,
} from "../src/terminal-scroll";

function numberedLines(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, idx) => `line-${start + idx}`);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drainWholeLines(remainder: number): { wholeLines: number; remainder: number } {
  let wholeLines = 0;
  let current = remainder;
  let frames = 0;

  while (Math.abs(current) >= 1) {
    const consumed = consumeWholeWheelLines(current);
    expect(Math.abs(consumed.wholeLines)).toBeLessThanOrEqual(MAX_WHEEL_LINES_PER_FRAME);
    expect(consumed.wholeLines).not.toBe(0);
    wholeLines += consumed.wholeLines;
    current = consumed.remainder;
    frames++;
    expect(frames).toBeLessThan(100);
  }

  return { wholeLines, remainder: current };
}

function runWheelInvariant(seed: number, sequences: number, makeEvent: (rand: () => number) => WheelDeltaInput): void {
  const rand = mulberry32(seed);

  for (let sequence = 0; sequence < sequences; sequence++) {
    let expectedTotal = 0;
    let emittedTotal = 0;
    let remainder = 0;
    const steps = 20 + Math.floor(rand() * 40);

    for (let i = 0; i < steps; i++) {
      const event = makeEvent(rand);
      const lines = wheelDeltaToLines(event, 17 + (sequence % 9), 24 + (sequence % 40));
      expectedTotal += lines;
      remainder += lines;

      const drained = drainWholeLines(remainder);
      emittedTotal += drained.wholeLines;
      remainder = drained.remainder;

      expect(Math.abs(remainder)).toBeLessThan(1);
    }

    expect(Math.abs(emittedTotal + remainder - expectedTotal)).toBeLessThan(1e-7);
  }
}

describe("stable scroll merging under stress", () => {
  test("accepts a cold 10,000-line capture", () => {
    const next = numberedLines(0, 10_000);

    const merged = mergeCapturedLinesForStableScroll([], next);

    expect(merged.lines).toBe(next);
    expect(merged.appendedLineCount).toBe(10_000);
    expect(merged.preservedPrefix).toBe(false);
  });

  test("preserves the prefix when a 10,000-line capture advances by one line", () => {
    const previous = numberedLines(0, 10_000);
    const next = numberedLines(1, 10_000);

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(1);
    expect(merged.lines.length).toBe(10_001);
    expect(merged.lines[0]).toBe("line-0");
    expect(merged.lines.at(-1)).toBe("line-10000");
  });

  test("preserves old scrollback when the overlap window shifts by 250 lines", () => {
    const previous = numberedLines(0, 10_000);
    const next = numberedLines(250, 10_000);

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(250);
    expect(merged.lines.slice(0, 3)).toEqual(["line-0", "line-1", "line-2"]);
    expect(merged.lines.slice(-3)).toEqual(["line-10247", "line-10248", "line-10249"]);
  });

  test("keeps a stable prefix through 500 successive polling merges under two seconds", () => {
    let history = numberedLines(0, 10_000);
    let mergedLines = history;
    let nextLine = history.length;
    const start = performance.now();

    for (let poll = 0; poll < 500; poll++) {
      const appended = 1 + (poll % 5);
      const newLines = numberedLines(nextLine, appended);
      nextLine += appended;
      history = [...history, ...newLines];

      const merged = mergeCapturedLinesForStableScroll(mergedLines, history.slice(-10_000));
      expect(merged.preservedPrefix).toBe(true);
      expect(merged.appendedLineCount).toBe(appended);
      mergedLines = merged.lines;
    }

    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(2_000);
    expect(mergedLines.length).toBe(11_500);
    expect(mergedLines.slice(0, 3)).toEqual(["line-0", "line-1", "line-2"]);
    expect(mergedLines.at(-1)).toBe("line-11499");
  });

  test("matches the exact final suffix after variable 1-5 line appends", () => {
    let history = numberedLines(0, 10_000);
    let mergedLines = history;
    let nextLine = history.length;

    for (let poll = 0; poll < 500; poll++) {
      const appended = 1 + ((poll * 3) % 5);
      const newLines = numberedLines(nextLine, appended);
      nextLine += appended;
      history = [...history, ...newLines];
      mergedLines = mergeCapturedLinesForStableScroll(mergedLines, history.slice(-10_000)).lines;
    }

    expect(mergedLines.slice(-10)).toEqual(history.slice(-10));
    expect(mergedLines.length).toBe(history.length);
  });

  test("uses the full repaint path when content mutates mid-buffer", () => {
    const previous = numberedLines(0, 10_000);
    const next = numberedLines(0, 10_000);
    next[5_000] = "line-5000-repainted";

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(false);
    expect(merged.lines).toBe(next);
    expect(merged.lines[5_000]).toBe("line-5000-repainted");
  });

  test("replaces a capture whose only overlap is below the stable threshold", () => {
    const previous = numberedLines(0, 20);
    const next = [...numberedLines(13, 7), ...numberedLines(100, 13)];

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(false);
    expect(merged.lines).toEqual(next);
  });

  test("does not duplicate an all-identical unchanged capture", () => {
    const previous = Array.from({ length: 10_000 }, () => "same");
    const next = Array.from({ length: 10_000 }, () => "same");

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(0);
    expect(merged.lines).toBe(previous);
  });

  test("appends only the extra tail for all-identical lines", () => {
    const previous = Array.from({ length: 10_000 }, () => "same");
    const next = Array.from({ length: 10_005 }, () => "same");

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(5);
    expect(merged.lines.length).toBe(10_005);
  });

  test("merges alternating blank and text lines across a shifted window", () => {
    const make = (start: number, count: number) =>
      Array.from({ length: count }, (_, idx) => ((start + idx) % 2 === 0 ? "" : "none"));

    const merged = mergeCapturedLinesForStableScroll(make(0, 10_000), make(3, 10_000));

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(1);
    expect(merged.lines.length).toBe(10_001);
  });

  test("handles a single 50,000-character line with an appended tail", () => {
    const longLine = "x".repeat(50_000);

    const merged = mergeCapturedLinesForStableScroll([longLine], [longLine, "tail"]);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.appendedLineCount).toBe(1);
    expect(merged.lines[0].length).toBe(50_000);
    expect(merged.lines[1]).toBe("tail");
  });

  test("repaints a changed single 50,000-character line", () => {
    const previous = ["x".repeat(50_000)];
    const next = ["x".repeat(49_999) + "y"];

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(false);
    expect(merged.lines).toEqual(next);
  });

  test("does not preserve unrelated repeated noise", () => {
    const previous = Array.from({ length: 10_000 }, (_, idx) => `old-${idx % 3}`);
    const next = Array.from({ length: 10_000 }, (_, idx) => `new-${idx % 3}`);

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(false);
    expect(merged.lines).toEqual(next);
  });

  test("keeps old prefix lines that are no longer present in the shifted capture", () => {
    const previous = numberedLines(0, 10_000);
    const next = numberedLines(9_500, 10_000);

    const merged = mergeCapturedLinesForStableScroll(previous, next);

    expect(merged.preservedPrefix).toBe(true);
    expect(merged.lines[0]).toBe("line-0");
    expect(merged.lines[9_499]).toBe("line-9499");
    expect(merged.lines[9_500]).toBe("line-9500");
    expect(merged.lines.at(-1)).toBe("line-19499");
  });
});

describe("wheel line math fuzz", () => {
  test("preserves the wheel invariant for 1,000 pixel-delta sequences", () => {
    runWheelInvariant(0x5141, 1_000, (rand) => ({
      deltaMode: 0,
      deltaY: (rand() - 0.5) * 180,
    }));
  });

  test("preserves the wheel invariant for 1,000 line-delta sequences", () => {
    runWheelInvariant(0x5142, 1_000, (rand) => ({
      deltaMode: 1,
      deltaY: Math.trunc((rand() - 0.5) * 9),
    }));
  });

  test("preserves the wheel invariant for 1,000 page-delta sequences", () => {
    runWheelInvariant(0x5143, 1_000, (rand) => ({
      deltaMode: 2,
      deltaY: Math.trunc((rand() - 0.5) * 5),
    }));
  });

  test("preserves the wheel invariant for 1,000 mixed-mode sequences", () => {
    runWheelInvariant(0x5144, 1_000, (rand) => {
      const deltaMode = Math.floor(rand() * 3);
      const magnitude = deltaMode === 0 ? 240 : deltaMode === 1 ? 7 : 3;
      return {
        deltaMode,
        deltaY: (rand() - 0.5) * magnitude,
      };
    });
  });

  test("keeps sub-line pixel deltas as bounded remainder", () => {
    let remainder = 0;
    for (let i = 0; i < 999; i++) {
      remainder += wheelDeltaToLines({ deltaMode: 0, deltaY: 0.25 }, 20, 40);
      const drained = drainWholeLines(remainder);
      remainder = drained.remainder;
      expect(Math.abs(remainder)).toBeLessThan(1);
    }
  });

  test("returns zero lines for non-finite and zero input", () => {
    expect(wheelDeltaToLines({ deltaMode: 0, deltaY: 0 }, 20, 40)).toBe(0);
    expect(wheelDeltaToLines({ deltaMode: 0, deltaY: Number.NaN }, 20, 40)).toBe(0);
    expect(wheelDeltaToLines({ deltaMode: 1, deltaY: Number.POSITIVE_INFINITY }, 20, 40)).toBe(0);
  });

  test("draining a large page delta respects the per-frame clamp", () => {
    const lines = wheelDeltaToLines({ deltaMode: 2, deltaY: 4 }, 20, 80);
    const drained = drainWholeLines(lines);

    expect(lines).toBe(320);
    expect(drained.wholeLines).toBe(320);
    expect(drained.remainder).toBe(0);
  });
});
