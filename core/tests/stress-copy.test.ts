import { describe, expect, test } from "bun:test";

import { paneTextForCopy } from "../src/copy";

const encoder = new TextEncoder();

describe("paneTextForCopy stress coverage", () => {
  test("copies a 5,000-line padded grid while trimming grid-only tails", () => {
    const lines = Array.from({ length: 5_000 }, (_, idx) => {
      if (idx === 4998 || idx === 4999) return " ".repeat(96);
      if (idx % 777 === 0) return " ".repeat(96);
      const label = `row-${idx.toString().padStart(4, "0")} value-${(idx * 17).toString(36)}`;
      return label.padEnd(96, " ");
    });

    const copied = paneTextForCopy(lines);
    const copiedLines = copied.split("\n");

    expect(copiedLines.length).toBe(4_998);
    expect(copiedLines[1]).toBe("row-0001 value-h");
    expect(copiedLines[777]).toBe("");
    expect(copiedLines.at(-1)).toBe(`row-4997 value-${(4_997 * 17).toString(36)}`);
    expect(copiedLines.every((line) => !/[ \t]+$/.test(line))).toBe(true);
  });

  test("strips ANSI from every line in a large copied grid", () => {
    const lines = Array.from({ length: 5_000 }, (_, idx) =>
      `\x1b[38;5;${idx % 256}mcell-${idx}\x1b[0m`.padEnd(72, " ")
    );

    const copied = paneTextForCopy(lines);

    expect(copied).not.toContain("\x1b");
    expect(copied.split("\n")[4_321]).toBe("cell-4321");
  });

  test("preserves intentional blank lines inside a large selection", () => {
    const lines = [
      "alpha      ",
      "          ",
      "\t\t",
      "beta       ",
      "",
      "          ",
    ];

    expect(paneTextForCopy(lines)).toBe("alpha\n\n\nbeta");
  });

  test("preserves Thai emoji and CJK text byte-exact after trimming padding", () => {
    const source = "สวัสดี🙂漢字한글 e\u0301";

    const copied = paneTextForCopy([`\x1b[1;32m${source}\x1b[0m        `]);

    expect(copied).toBe(source);
    expect(Array.from(encoder.encode(copied))).toEqual(Array.from(encoder.encode(source)));
  });

  test("keeps mixed Unicode lines distinct across thousands of rows", () => {
    const samples = ["ไทย", "🙂", "漢字", "한글", "e\u0301"];
    const lines = Array.from({ length: 5_000 }, (_, idx) =>
      `${idx}:${samples[idx % samples.length]}   `
    );

    const copiedLines = paneTextForCopy(lines).split("\n");

    expect(copiedLines[0]).toBe("0:ไทย");
    expect(copiedLines[1]).toBe("1:🙂");
    expect(copiedLines[2]).toBe("2:漢字");
    expect(copiedLines[3]).toBe("3:한글");
    expect(copiedLines[4]).toBe("4:e\u0301");
    expect(copiedLines.at(-1)).toBe("4999:e\u0301");
  });

  test("drops thousands of trailing blank padded rows", () => {
    const lines = [
      "kept     ",
      ...Array.from({ length: 4_999 }, () => " ".repeat(80)),
    ];

    expect(paneTextForCopy(lines)).toBe("kept");
  });

  test("trims tab padding as grid whitespace", () => {
    expect(paneTextForCopy(["one\t\t", "two  \t  ", ""])).toBe("one\ntwo");
  });

  test("keeps interior leading spaces while removing only trailing padding", () => {
    const copied = paneTextForCopy(["  indented command      ", "    child output    ", ""]);

    expect(copied).toBe("  indented command\n    child output");
  });
});
