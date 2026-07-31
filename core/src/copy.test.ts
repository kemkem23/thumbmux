import { describe, expect, test } from "bun:test";
import { paneTextForCopy } from "./copy";
import { mergePrefs } from "./prefs";

describe("paneTextForCopy", () => {
  test("strips ANSI, trims line tails, drops trailing blanks", () => {
    const lines = [
      "\x1b[32m$ ls\x1b[0m   ",
      "file-a  file-b",
      "",
      "   ",
      "",
    ];
    expect(paneTextForCopy(lines)).toBe("$ ls\nfile-a  file-b");
  });
  test("keeps interior blank lines", () => {
    expect(paneTextForCopy(["a", "", "b", ""])).toBe("a\n\nb");
  });
  test("empty input → empty string", () => {
    expect(paneTextForCopy([])).toBe("");
    expect(paneTextForCopy(["", "  "])).toBe("");
  });
});

describe("mergePrefs", () => {
  test("top-level keys replace; undefined OR null deletes; others untouched", () => {
    const base = { fontPx: 13, theme: { bg: "#000" }, custom: 1, other: 2 };
    const next = mergePrefs(base, { fontPx: 15, custom: undefined, other: null as any });
    expect(next).toEqual({ fontPx: 15, theme: { bg: "#000" } });
    expect(base.fontPx).toBe(13); // no mutation
  });

  test("a __proto__ key in the patch cannot reach the result's prototype", () => {
    // JSON.parse produces "__proto__" as a real own key, so a hostile PUT body
    // reaches the merge. Assigning it used to swap the result's prototype: the
    // host could read a preference it never stored, and stringify dropped it.
    const hostile = JSON.parse(String.raw`{"__proto__":{"hostFlag":"inherited"}}`);
    const merged = mergePrefs({ fontPx: 13 }, hostile);

    expect((merged as Record<string, unknown>).hostFlag).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(merged))).toEqual({ fontPx: 13 });
    expect(({} as Record<string, unknown>).hostFlag).toBeUndefined();
  });
});
