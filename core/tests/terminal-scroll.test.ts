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

// v0.3.5 shipped algorithm — definition of correct for findLineOverlap.
function referenceFindLineOverlap(previousLines: string[], nextLines: string[]): number {
  const max = Math.min(previousLines.length, nextLines.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (previousLines[previousStart + i] !== nextLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors the fast-path comparison budget in findLineOverlap. Used only to prove the
// fuzz corpus actually reaches the linear fallback — if the budget formula in src
// changes, this must change with it or the coverage assertion below will fail loudly.
function exercisesLinearFallback(previousLines: string[], nextLines: string[]): boolean {
  let budget = 2 * (previousLines.length + nextLines.length) + 64;
  const max = Math.min(previousLines.length, nextLines.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    const previousStart = previousLines.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (--budget < 0) return true;
      if (previousLines[previousStart + i] !== nextLines[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return false;
  }
  return false;
}

/** Compact JSON for failure messages on long arrays (first 40 rows + lengths). */
function summarizeLines(lines: string[]): string {
  return JSON.stringify({
    length: lines.length,
    head: lines.slice(0, 40),
  });
}

describe("findLineOverlap contract pins", () => {
  test("corpus: hard-coded expected overlaps match shipped oracle", () => {
    const same7 = Array.from({ length: 7 }, () => "same");
    const same9 = Array.from({ length: 9 }, () => "same");
    const same12 = Array.from({ length: 12 }, () => "same");

    const corpus: Array<{
      name: string;
      previousLines: string[];
      nextLines: string[];
      expected: number;
    }> = [
      { name: "empty prev and next", previousLines: [], nextLines: [], expected: 0 },
      { name: "empty prev", previousLines: [], nextLines: ["a", "b"], expected: 0 },
      { name: "empty next", previousLines: ["a", "b"], nextLines: [], expected: 0 },
      { name: "single row equal", previousLines: ["a"], nextLines: ["a"], expected: 1 },
      { name: "single row differing", previousLines: ["a"], nextLines: ["b"], expected: 0 },
      { name: "no overlap", previousLines: ["a", "b", "c"], nextLines: ["x", "y", "z"], expected: 0 },
      {
        name: "prev is prefix of next",
        previousLines: ["a", "b"],
        nextLines: ["a", "b", "c", "d"],
        expected: 2,
      },
      {
        name: "next is suffix of prev",
        previousLines: ["a", "b", "c", "d"],
        nextLines: ["c", "d"],
        expected: 2,
      },
      {
        name: "repeated lines, differing tail",
        previousLines: [...same7, "old-tail"],
        nextLines: [...same7, "new-tail"],
        expected: 0,
      },
      {
        name: "all identical, same length 9",
        previousLines: same9,
        nextLines: same9,
        expected: 9,
      },
      {
        name: "all identical, next longer 12",
        previousLines: same9,
        nextLines: same12,
        expected: 9,
      },
      {
        name: "all identical, next shorter 9",
        previousLines: same12,
        nextLines: same9,
        expected: 9,
      },
      {
        name: "empty-string rows",
        previousLines: ["", "", "a"],
        nextLines: ["", "a", ""],
        expected: 2,
      },
      {
        name: "alternating blank/text",
        previousLines: ["", "x", "", "x", "", "x"],
        nextLines: ["x", "", "x", "", "x", ""],
        expected: 5,
      },
      {
        name: "ambiguous aab",
        previousLines: ["a", "a", "b", "a", "a"],
        nextLines: ["a", "a", "b", "a", "a", "c"],
        expected: 5,
      },
      {
        name: "periodic abab",
        previousLines: ["a", "b", "a", "b", "a", "b"],
        nextLines: ["a", "b", "a", "b", "c"],
        expected: 4,
      },
      {
        name: "overlap only at last row",
        previousLines: ["q", "r", "s"],
        nextLines: ["s", "t", "u"],
        expected: 1,
      },
      {
        name: "prefix match but not suffix",
        previousLines: ["a", "b", "c"],
        nextLines: ["a", "b", "x"],
        expected: 0,
      },
      {
        name: "unicode and astral rows",
        previousLines: ["ก", "ข", "😀"],
        nextLines: ["ข", "😀", "ค"],
        expected: 2,
      },
    ];

    for (const row of corpus) {
      const actual = findLineOverlap(row.previousLines, row.nextLines);
      const oracle = referenceFindLineOverlap(row.previousLines, row.nextLines);
      expect(oracle, `oracle honesty: ${row.name}`).toBe(row.expected);
      expect(actual, `findLineOverlap: ${row.name}`).toBe(row.expected);
    }
  });

  test("period-2 sliding window under-appends without capture identity (A2-4 documented)", () => {
    // String-only max-overlap cannot distinguish a chronological shift of 2 (or
    // 3) rows when the fixed capture window is a period-2 blank/text pattern:
    // slide-by-2 is byte-identical (appended 0); slide-by-3 finds max overlap
    // N-1 (appended 1) even though three rows arrived. A generation/sequence
    // seam would fix this; pure content merge cannot. This test pins the
    // limitation so a future API change has a red to drive.
    const make = (start: number, count: number) =>
      Array.from({ length: count }, (_, idx) => ((start + idx) % 2 === 0 ? "" : "none"));

    const slide2 = mergeCapturedLinesForStableScroll(make(0, 100), make(2, 100));
    expect(slide2.preservedPrefix).toBe(true);
    expect(slide2.appendedLineCount).toBe(0);

    const slide3 = mergeCapturedLinesForStableScroll(make(0, 100), make(3, 100));
    expect(slide3.preservedPrefix).toBe(true);
    expect(slide3.appendedLineCount).toBe(1);
    // Chronological truth would be 3; content-only algorithm yields 1.
    expect(slide3.appendedLineCount).not.toBe(3);
  });

  test("merge-level contract pins (shipped quirky arithmetic)", () => {
    expect(mergeCapturedLinesForStableScroll(["a", "b"], [])).toEqual({
      appendedLineCount: 0,
      preservedPrefix: true,
      lines: ["a", "b"],
    });

    const ambiguous = mergeCapturedLinesForStableScroll(
      ["a", "a", "b", "a", "a"],
      ["a", "a", "b", "a", "a", "c"],
    );
    expect(ambiguous.preservedPrefix).toBe(true);
    expect(ambiguous.appendedLineCount).toBe(1);
    expect(ambiguous.lines).toEqual(["a", "a", "b", "a", "a", "c"]);

    const periodic = mergeCapturedLinesForStableScroll(
      ["a", "b", "a", "b", "a", "b"],
      ["a", "b", "a", "b", "c"],
    );
    expect(periodic.preservedPrefix).toBe(false);
    expect(periodic.appendedLineCount).toBe(-1);

    const shortShift = mergeCapturedLinesForStableScroll(
      numberedLines(0, 19),
      numberedLines(18, 20),
    );
    expect(shortShift.preservedPrefix).toBe(false);
    expect(shortShift.appendedLineCount).toBe(-17);
  });

  test("deterministic differential fuzz, short arrays / fast path (20000 pairs)", () => {
    const rand = mulberry32(0xc0ffee42);
    const alphabets = [
      ["a"],
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
      ["", "x"],
      ["same", "old", "new", "tail"],
    ];

    const randomLines = (len: number, alphabet: string[]): string[] => {
      const out = new Array<string>(len);
      for (let i = 0; i < len; i++) {
        out[i] = alphabet[(rand() * alphabet.length) | 0]!;
      }
      return out;
    };

    let fallbackCount = 0;
    for (let n = 0; n < 20_000; n++) {
      const alphabet = alphabets[(rand() * alphabets.length) | 0]!;
      const prevLen = (rand() * 15) | 0; // 0..14
      const previousLines = randomLines(prevLen, alphabet);

      let nextLines: string[];
      if (rand() < 0.5 && prevLen > 0) {
        // Genuine shifted-window continuation → real overlaps are common.
        const shift = (rand() * prevLen) | 0;
        const extra = (rand() * 8) | 0; // 0..7 appended rows
        nextLines = [
          ...previousLines.slice(shift),
          ...randomLines(extra, alphabet),
        ];
      } else {
        const nextLen = (rand() * 15) | 0;
        nextLines = randomLines(nextLen, alphabet);
      }

      if (exercisesLinearFallback(previousLines, nextLines)) fallbackCount++;

      const actual = findLineOverlap(previousLines, nextLines);
      const expected = referenceFindLineOverlap(previousLines, nextLines);
      if (actual !== expected) {
        throw new Error(
          `fuzz mismatch #${n}: actual=${actual} expected=${expected}\n` +
            `prev=${JSON.stringify(previousLines)}\n` +
            `next=${JSON.stringify(nextLines)}`,
        );
      }
    }
    // Short arrays (0..14) never exhaust the fast-path budget — that is why the
    // adversarial long-run fuzz below has to exist. If the budget is ever lowered
    // enough that this corpus starts hitting the linear path, this guard fails.
    expect(fallbackCount).toBe(0);
  });

  test("adversarial differential fuzz, long repeated runs / linear fallback (≥8000 pairs)", () => {
    // Different seed from the short-array fuzz. Shape engineered to exhaust the
    // fast-path comparison budget: long runs of IDENTICAL adjacent rows from a
    // tiny alphabet (1–4 symbols), lightly perturbed at the tail/head. iid
    // multi-symbol noise fails candidates on the first row and never trips the
    // budget — stretches of the same row are the point.
    const rand = mulberry32(0xdeadbeef);
    const PAIR_COUNT = 8_000;

    const buildAlphabet = (): string[] => {
      const size = 1 + ((rand() * 4) | 0); // 1..4
      const alphabet: string[] = [];
      for (let i = 0; i < size; i++) {
        if (i === 0 && rand() < 0.3) alphabet.push("");
        else if (i === 0) alphabet.push("same");
        else alphabet.push(`same${i}`);
      }
      const unique = [...new Set(alphabet)];
      return unique.length > 0 ? unique : ["same"];
    };

    /** Long stretches of identical rows (RLE), not iid — that is what burns budget. */
    const buildRepeatedRun = (len: number, alphabet: string[]): string[] => {
      const out: string[] = [];
      // Solid monochrome fill is the classic budget-blower; sometimes RLE a few
      // long stretches so multi-symbol alphabets still produce near-matches.
      if (alphabet.length === 1 || rand() < 0.65) {
        const fill = alphabet[(rand() * alphabet.length) | 0]!;
        for (let i = 0; i < len; i++) out.push(fill);
        return out;
      }
      while (out.length < len) {
        const sym = alphabet[(rand() * alphabet.length) | 0]!;
        const stretch = Math.min(len - out.length, 8 + ((rand() * 120) | 0));
        for (let s = 0; s < stretch; s++) out.push(sym);
      }
      return out;
    };

    let fallbackCount = 0;
    for (let n = 0; n < PAIR_COUNT; n++) {
      const alphabet = buildAlphabet();
      const runLen = 40 + ((rand() * 220) | 0); // 40..259
      const run = buildRepeatedRun(runLen, alphabet);

      let previousLines = run.slice();
      let nextLines = run.slice();

      // Overwrite 0-3 rows near the tail of one or both with distinct markers.
      // Prefer at least one side marked so max-overlap fails and the scan keeps
      // chewing near-matches (otherwise monochrome equal arrays return early).
      const perturbTail = (lines: string[], marker: string) => {
        const count = (rand() * 4) | 0; // 0..3
        for (let k = 0; k < count && lines.length > 0; k++) {
          const idx = lines.length - 1 - k;
          if (idx >= 0) lines[idx] = `${marker}-${k}`;
        }
      };
      const markPrev = rand() < 0.85;
      const markNext = rand() < 0.85;
      if (markPrev) perturbTail(previousLines, "old");
      if (markNext) perturbTail(nextLines, "new");
      // Force a differing tail when neither side was marked, so equal monochrome
      // pairs do not short-circuit the descending scan at max overlap.
      if (!markPrev && !markNext && previousLines.length > 0) {
        previousLines[previousLines.length - 1] = "old-forced";
        nextLines[nextLines.length - 1] = "new-forced";
      }

      // Sometimes unshift 1-3 rows onto nextLines (same alphabet — unique heads
      // would fail every candidate on row 0 and never exhaust the budget).
      if (rand() < 0.35) {
        const extra = 1 + ((rand() * 3) | 0);
        nextLines = [
          ...Array.from({ length: extra }, () => alphabet[(rand() * alphabet.length) | 0]!),
          ...nextLines,
        ];
      }

      // Sometimes push 1-3 rows onto previousLines.
      if (rand() < 0.35) {
        const extra = 1 + ((rand() * 3) | 0);
        if (rand() < 0.5) {
          previousLines = [
            ...previousLines,
            ...Array.from({ length: extra }, () => alphabet[(rand() * alphabet.length) | 0]!),
          ];
        } else {
          previousLines = [
            ...previousLines,
            ...Array.from({ length: extra }, (_, i) => `prev-extra-${i}`),
          ];
        }
      }

      // Sometimes truncate either by up to 5 rows.
      if (rand() < 0.3 && previousLines.length > 10) {
        const cut = 1 + ((rand() * 5) | 0);
        previousLines = previousLines.slice(0, previousLines.length - cut);
      }
      if (rand() < 0.3 && nextLines.length > 10) {
        const cut = 1 + ((rand() * 5) | 0);
        nextLines = nextLines.slice(0, nextLines.length - cut);
      }

      if (exercisesLinearFallback(previousLines, nextLines)) fallbackCount++;

      const actual = findLineOverlap(previousLines, nextLines);
      const expected = referenceFindLineOverlap(previousLines, nextLines);
      if (actual !== expected) {
        throw new Error(
          `adversarial fuzz mismatch #${n}: actual=${actual} expected=${expected}\n` +
            `prev=${summarizeLines(previousLines)}\n` +
            `next=${summarizeLines(nextLines)}`,
        );
      }
    }

    // Corpus must actually exercise the linear KMP fallback, not just the
    // descending fast path that short-array fuzz already covers.
    expect(fallbackCount).toBeGreaterThan(2_000);
  });

  test("worst-case shape at scale: repeated lines + all-identical 5000", () => {
    const repeated = Array.from({ length: 4999 }, () => "same");
    const previousLines = [...repeated, "old-tail"];
    const nextLines = [...repeated, "new-tail"];
    expect(findLineOverlap(previousLines, nextLines)).toBe(0);
    expect(referenceFindLineOverlap(previousLines, nextLines)).toBe(0);

    const identical = Array.from({ length: 5000 }, () => "same");
    expect(findLineOverlap(identical, identical)).toBe(5000);
    expect(referenceFindLineOverlap(identical, identical)).toBe(5000);
  });

  test("complexity-regression guard: n=20000 degenerate shape finishes <100ms", () => {
    // Shipped v0.3.5 quadratic scan took ~500 ms on this shape; current
    // implementation (fast-path budget + linear KMP fallback) takes ~0.8 ms.
    // Do NOT call referenceFindLineOverlap here — the oracle is quadratic and
    // would take ~half a second, defeating the point of the guard.
    const repeated = Array.from({ length: 19_999 }, () => "same");
    const previousLines = [...repeated, "old-tail"];
    const nextLines = [...repeated, "new-tail"];

    const started = performance.now();
    expect(findLineOverlap(previousLines, nextLines)).toBe(0);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(100);
  });
});
