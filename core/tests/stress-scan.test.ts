import { describe, expect, test } from "bun:test";

import { extractRecentPrompts, extractRecentPromptsFromPane } from "../src/prompt-scan";

function buildLargeTranscript(): string[] {
  const lines: string[] = [];

  for (let prompt = 0; prompt < 200; prompt++) {
    while (lines.length < prompt * 99) {
      lines.push(`background output ${lines.length}`);
    }

    lines.push(`› submitted prompt ${prompt.toString().padStart(3, "0")}`);
    if (prompt % 50 === 0) {
      lines.push(`  continuation ${prompt.toString().padStart(3, "0")}`);
    }
    lines.push(`• processed ${prompt.toString().padStart(3, "0")}`);
  }

  while (lines.length < 19_998) {
    lines.push(`tail output ${lines.length}`);
  }

  lines.push("\x1b[1m›\x1b[0m \x1b[2mghost text that was not submitted\x1b[0m");
  lines.push("  weekly 80% left · Context 12% used");
  return lines;
}

describe("prompt scanning stress coverage", () => {
  test("extracts the most recent prompts from a 20,000-line transcript with 200 embedded prompts under one second", () => {
    const transcript = buildLargeTranscript();
    const start = performance.now();

    const prompts = extractRecentPrompts(transcript, {
      targetCount: 10,
      initialScanLines: 256,
      maxScanLines: 20_000,
    });

    const elapsedMs = performance.now() - start;
    expect(transcript.length).toBe(20_000);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(prompts).toEqual([
      "submitted prompt 190",
      "submitted prompt 191",
      "submitted prompt 192",
      "submitted prompt 193",
      "submitted prompt 194",
      "submitted prompt 195",
      "submitted prompt 196",
      "submitted prompt 197",
      "submitted prompt 198",
      "submitted prompt 199",
    ]);
  });

  test("excludes faint composer payloads from the bottom of a large transcript", () => {
    const prompts = extractRecentPrompts(buildLargeTranscript(), {
      targetCount: 3,
      initialScanLines: 128,
      maxScanLines: 20_000,
    });

    expect(prompts).toEqual([
      "submitted prompt 197",
      "submitted prompt 198",
      "submitted prompt 199",
    ]);
    expect(prompts.join(" ")).not.toContain("ghost text");
  });

  test("progressively scans backward when the requested count is outside the initial window", () => {
    const transcript = buildLargeTranscript();

    const prompts = extractRecentPrompts(transcript, {
      targetCount: 25,
      initialScanLines: 64,
      maxScanLines: 20_000,
    });

    expect(prompts.length).toBe(25);
    expect(prompts[0]).toBe("submitted prompt 175");
    expect(prompts.at(-1)).toBe("submitted prompt 199");
  });

  test("keeps multi-line prompt blocks normalized inside large transcripts", () => {
    const transcript = buildLargeTranscript();

    const prompts = extractRecentPrompts(transcript, {
      targetCount: 4,
      initialScanLines: 20_000,
      maxScanLines: 20_000,
    });

    expect(prompts).toEqual([
      "submitted prompt 196",
      "submitted prompt 197",
      "submitted prompt 198",
      "submitted prompt 199",
    ]);
  });

  test("returns a multi-line embedded prompt when it is among the most recent results", () => {
    const transcript = buildLargeTranscript();

    const prompts = extractRecentPrompts(transcript, {
      targetCount: 52,
      initialScanLines: 20_000,
      maxScanLines: 20_000,
    });

    expect(prompts).toContain("submitted prompt 150 continuation 150");
    expect(prompts.at(-1)).toBe("submitted prompt 199");
  });

  test("deduplicates repeated prompts while keeping the latest occurrence", () => {
    const lines = [
      "› repeat me",
      "• processed",
      "› unique one",
      "• processed",
      "› repeat me",
      "• processed",
      "› unique two",
      "• processed",
    ];

    expect(extractRecentPrompts(lines, { targetCount: 4, initialScanLines: 20 })).toEqual([
      "unique one",
      "repeat me",
      "unique two",
    ]);
  });

  test("rejects plain composer text immediately above a status line", () => {
    const lines = [
      "› submitted",
      "• processed",
      "› unsent composer text",
      "  weekly 70% left · Context 30% used",
    ];

    expect(extractRecentPrompts(lines, { targetCount: 5, initialScanLines: 20 })).toEqual(["submitted"]);
  });

  test("extracts recent prompts from a joined pane string at scale", () => {
    const transcript = buildLargeTranscript();
    const prompts = extractRecentPromptsFromPane(transcript.join("\n"), 6);

    expect(prompts).toEqual([
      "submitted prompt 194",
      "submitted prompt 195",
      "submitted prompt 196",
      "submitted prompt 197",
      "submitted prompt 198",
      "submitted prompt 199",
    ]);
  });
});
