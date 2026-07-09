import { describe, expect, test } from "bun:test";

import { prefixForCells, stringCells } from "../src/cells";
import { stripAnsi } from "../src/prompt-scan";

function mixedWidthLine(units = 2_000): string {
  const tokens = ["a", "ส", "วั", "ดี", "你", "界", "👩‍💻", "한", "🙂", "e\u0301"];
  return Array.from({ length: units }, (_, idx) => tokens[idx % tokens.length]).join("");
}

describe("terminal cell prefix stress coverage", () => {
  test("counts a 2,000-unit mixed-width line with zero-width and wide characters", () => {
    const line = mixedWidthLine();

    expect(Array.from(line).length).toBeGreaterThanOrEqual(2_000);
    expect(stringCells(line)).toBeGreaterThan(2_000);
  });

  test("prefixForCells is monotonic across a long mixed-width line", () => {
    const line = mixedWidthLine();
    const totalCells = stringCells(line);
    let previousLength = 0;
    let previousCells = 0;

    for (let cells = 0; cells <= totalCells; cells += 7) {
      const result = prefixForCells(line, cells);

      expect(result.prefix.length).toBeGreaterThanOrEqual(previousLength);
      expect(result.cells).toBeGreaterThanOrEqual(previousCells);
      expect(result.prefix.length).toBeLessThanOrEqual(line.length);
      expect(result.cells).toBeLessThanOrEqual(cells);
      expect(stringCells(result.prefix)).toBe(result.cells);

      previousLength = result.prefix.length;
      previousCells = result.cells;
    }
  });

  test("prefixes never exceed the source string length near every wide boundary", () => {
    const line = mixedWidthLine();
    const totalCells = stringCells(line);

    for (let cells = 1; cells < totalCells; cells += 5) {
      const { prefix } = prefixForCells(line, cells);
      expect(prefix.length).toBeLessThanOrEqual(line.length);
      expect(/[\ud800-\udbff]$/.test(prefix)).toBe(false);
    }
  });

  test("round-trips cell counts after ANSI is stripped", () => {
    const line = mixedWidthLine();
    const plain = stripAnsi(`\x1b[38;5;45m${line}\x1b[0m`);
    const result = prefixForCells(plain, 1_337);

    expect(plain).toBe(line);
    expect(stringCells(stripAnsi(result.prefix))).toBe(result.cells);
    expect(result.prefix.length).toBeLessThanOrEqual(plain.length);
  });

  test("absorbs Thai combining marks at an exact cell boundary in a long line", () => {
    const line = "ก่".repeat(2_000);
    const result = prefixForCells(line, 1_000);

    expect(result.cells).toBe(1_000);
    expect(result.prefix).toBe("ก่".repeat(1_000));
  });

  test("returns the full line and consumed cells when the requested column is beyond the end", () => {
    const line = mixedWidthLine();
    const totalCells = stringCells(line);

    expect(prefixForCells(line, totalCells + 500)).toEqual({ prefix: line, cells: totalCells });
  });

  test("returns an empty prefix for zero or negative columns on a long line", () => {
    const line = mixedWidthLine();

    expect(prefixForCells(line, 0)).toEqual({ prefix: "", cells: 0 });
    expect(prefixForCells(line, -100)).toEqual({ prefix: "", cells: 0 });
  });

  test("does not split surrogate pairs around ZWJ emoji while scanning mixed text", () => {
    const line = "a👩‍💻b".repeat(500);
    const prefixes = [
      prefixForCells(line, 1).prefix,
      prefixForCells(line, 2).prefix,
      prefixForCells(line, 3).prefix,
      prefixForCells(line, 4).prefix,
    ];

    expect(prefixes[0]).toBe("a");
    expect(prefixes[1]).toBe("a");
    expect(prefixes[2]).toBe("a👩‍");
    expect(prefixes[3]).toBe("a👩‍");
  });
});
