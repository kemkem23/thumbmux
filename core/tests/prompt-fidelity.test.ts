import { describe, expect, test } from "bun:test";

import { extractRecentPrompts, extractRecentPromptsFromPane } from "../src/prompt-scan";

/**
 * Data-boundary fixtures for recall. These must fail on the preimage that
 * truncates payloads to 500 UTF-16 units and appends "...".
 */
export function paneForSubmittedPrompt(payload: string): string {
  return [`❯ ${payload}`, "● response body here enough", ""].join("\n");
}

export function extractExact(payload: string): string[] {
  return extractRecentPromptsFromPane(paneForSubmittedPrompt(payload), 5);
}

function filled(length: number, seed = "ab"): string {
  const units: string[] = [];
  while (units.join("").length < length) units.push(seed);
  return units.join("").slice(0, length);
}

describe("prompt recall data fidelity — 500-unit producer must not invent an ellipsis", () => {
  test.each([
    [499, filled(499, "a")],
    [500, filled(500, "b")],
    [501, filled(501, "c")],
    [4096, filled(4096, "de")],
  ] as const)("keeps a %s-unit payload exact through pane → extractor", (length, payload) => {
    expect(payload.length).toBe(length);
    const extracted = extractExact(payload);
    expect(extracted).toEqual([payload]);
    expect(extracted[0]).toBe(payload);
    expect(extracted[0]!.endsWith("...")).toBe(payload.endsWith("..."));
  });

  test("keeps Thai, emoji ZWJ, combining marks, and a lone 😀 that used to sit on the 500-unit cut", () => {
    const longThai = `${"ก้ำ".repeat(80)}ฐญ${"ปั่น".repeat(40)}`;
    const emojiZwj = "ครอบครัว👨‍👩‍👧และธง🇹🇭จบ";
    const onTheOldCut = `${"a".repeat(496)}😀tail`;
    const combining = "e\u0301e\u0301 cafe\u0301";

    for (const payload of [longThai, emojiZwj, onTheOldCut, combining]) {
      const extracted = extractExact(payload);
      expect(extracted).toEqual([payload]);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(extracted[0]!)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(extracted[0]!)).toBe(false);
    }
  });

  test("extractRecentPrompts matches extractRecentPromptsFromPane for a 501-unit prompt", () => {
    const payload = filled(501, "xy");
    const lines = paneForSubmittedPrompt(payload).split("\n");
    expect(extractRecentPrompts(lines)).toEqual([payload]);
    expect(extractRecentPromptsFromPane(lines.join("\n"))).toEqual([payload]);
  });
});
