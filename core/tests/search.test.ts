import { describe, expect, test } from "bun:test";
import { createSgrState, lineToHtml, type AnsiPalette } from "../src/ansi-html";
import { searchLines, type SearchMatch, type SearchOptions } from "../src/search";

const runPlain = (rawLines: string[], query: string, options?: SearchOptions) =>
  searchLines(rawLines, query, options);

const runRegex = (rawLines: string[], query: string, options?: SearchOptions) =>
  searchLines(rawLines, query, { mode: "regex-lite", ...options });

const TEST_PALETTE: AnsiPalette = {
  base: Array.from({ length: 16 }, () => "#000000"),
  defaultFg: "#ffffff",
  defaultBg: "#000000",
};

/** Extract the full text inside the first search-match span from lineToHtml output. */
function highlightedSubstring(html: string): string | null {
  const open = '<span class="search-match">';
  const start = html.indexOf(open);
  if (start < 0) return null;
  const contentStart = start + open.length;
  const end = html.indexOf("</span>", contentStart);
  if (end < 0) return null;
  return html.slice(contentStart, end);
}

/** Assert no match span starts or ends mid-surrogate-pair. */
function assertNoSurrogateSplit(matches: SearchMatch[], line: string) {
  for (const m of matches) {
    if (m.start > 0) {
      const prev = line.charCodeAt(m.start - 1);
      const at = line.charCodeAt(m.start);
      // high surrogate followed by low = valid pair; start must not land on low half alone
      expect(at >= 0xdc00 && at <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff).toBe(false);
    }
    if (m.end > 0 && m.end <= line.length) {
      const beforeEnd = line.charCodeAt(m.end - 1);
      const atEnd = m.end < line.length ? line.charCodeAt(m.end) : -1;
      // end must not fall between high and low surrogate
      expect(
        beforeEnd >= 0xd800 && beforeEnd <= 0xdbff && atEnd >= 0xdc00 && atEnd <= 0xdfff,
      ).toBe(false);
    }
  }
}

describe("searchLines plain mode", () => {
  test("defaults to case-insensitive matching, honors caseSensitive: true, and orders line-major", () => {
    const insensitive = runPlain(["Alpha alpha", "alpha"], "alpha");

    expect(insensitive.error).toBeNull();
    expect(insensitive.matches).toEqual<SearchMatch[]>([
      { line: 0, start: 0, end: 5 },
      { line: 0, start: 6, end: 11 },
      { line: 1, start: 0, end: 5 },
    ]);

    const sensitive = runPlain(["Alpha alpha", "alpha ALPHA"], "AL", { caseSensitive: true });
    expect(sensitive.error).toBeNull();
    expect(sensitive.matches).toEqual<SearchMatch[]>([
      { line: 1, start: 6, end: 8 },
    ]);
  });

  test("yields overlapping literal spans for plain search", () => {
    const result = runPlain(["aaaa"], "aa");

    expect(result.error).toBeNull();
    expect(result.matches).toEqual<SearchMatch[]>([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 1, end: 3 },
      { line: 0, start: 2, end: 4 },
    ]);
  });

  test("uses visible UTF-16 spans through emoji, combining marks, ANSI, OSC, and legacy controls", () => {
    const emojiLine = "xx\ud83d\ude00yy";
    const combiningLine = "Cafe\u0301 tea";
    const sgrLine = "\x1b[31mxx\x1b[0mmatch";
    const csiLine = "\x1b[?25hxxmatch";
    const oscBelLine = "\x1b]8;;https://example.com\x07xxmatch\x1b]8;;\x07";
    const oscStLine = "\x1b]8;;https://example.com\x1b\\xxmatch\x1b]8;;\x1b\\";
    const legacyLine = "visible\x1b(";

    const controlMatches = runPlain([
      emojiLine,
      combiningLine,
      sgrLine,
      csiLine,
      oscBelLine,
      oscStLine,
      legacyLine,
    ], "match");

    expect(controlMatches.error).toBeNull();
    expect(controlMatches.matches).toEqual<SearchMatch[]>([
      { line: 2, start: 2, end: 7 },
      { line: 3, start: 2, end: 7 },
      { line: 4, start: 2, end: 7 },
      { line: 5, start: 2, end: 7 },
    ]);

    const emojiMatch = runPlain([emojiLine], "\ud83d\ude00");
    expect(emojiMatch.matches).toEqual<SearchMatch[]>([{ line: 0, start: 2, end: 4 }]);

    const combiningMatch = runPlain([combiningLine], "e\u0301");
    expect(combiningMatch.matches).toEqual<SearchMatch[]>([{ line: 0, start: 3, end: 5 }]);

    const legacyMatch = runPlain([legacyLine], "visible");
    expect(legacyMatch.matches).toEqual<SearchMatch[]>([{ line: 0, start: 0, end: 7 }]);
    expect(runPlain([legacyLine], "(").matches).toEqual([]);
  });
});

describe("searchLines regex-lite mode", () => {
  // DEFECT 1 (MEDIUM): case-sensitive character ranges must not fold.
  // Reproduced by hand: searchLines(["b"], "[A-Z]", { mode: "regex-lite", caseSensitive: true })
  // wrongly returned a match because the folded-range branch ran unconditionally.
  test("case-sensitive [A-Z] does not match lowercase (DEFECT 1 repro)", () => {
    const lower = runRegex(["b"], "[A-Z]", { caseSensitive: true });
    expect(lower.error).toBeNull();
    expect(lower.matches).toEqual([]);

    const upper = runRegex(["B"], "[A-Z]", { caseSensitive: true });
    expect(upper.error).toBeNull();
    expect(upper.matches).toEqual([{ line: 0, start: 0, end: 1 }]);
  });

  test("case-sensitive ranges still respect combined class members and stay sensitive", () => {
    // Range + singles: [A-Z0-9_] — lowercase letters must not match under caseSensitive.
    const mixedLower = runRegex(["b"], "[A-Z0-9_]", { caseSensitive: true });
    expect(mixedLower.error).toBeNull();
    expect(mixedLower.matches).toEqual([]);

    const mixedUpper = runRegex(["B"], "[A-Z0-9_]", { caseSensitive: true });
    expect(mixedUpper.matches).toEqual([{ line: 0, start: 0, end: 1 }]);

    const digit = runRegex(["5"], "[A-Z0-9_]", { caseSensitive: true });
    expect(digit.matches).toEqual([{ line: 0, start: 0, end: 1 }]);

    const underscore = runRegex(["_"], "[A-Z0-9_]", { caseSensitive: true });
    expect(underscore.matches).toEqual([{ line: 0, start: 0, end: 1 }]);

    // Characters outside the class (the "negated" case for this class) still miss.
    const outside = runRegex(["!"], "[A-Z0-9_]", { caseSensitive: true });
    expect(outside.matches).toEqual([]);

    // Case-insensitive default still folds ranges.
    const folded = runRegex(["b"], "[A-Z]");
    expect(folded.error).toBeNull();
    expect(folded.matches).toEqual([{ line: 0, start: 0, end: 1 }]);
  });

  test("handles literal escaping, dot, class/range, anchors, and quantifiers", () => {
    const escaped = runRegex(["+*?.[]{}()"], "\\+\\*\\?\\.\\[\\]\\{\\}\\(\\)");
    expect(escaped.error).toBeNull();
    expect(escaped.matches).toEqual([{ line: 0, start: 0, end: 10 }]);

    const dot = runRegex(["abc", "aQc", "a9c"], "a.c");
    expect(dot.matches).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 1, start: 0, end: 3 },
      { line: 2, start: 0, end: 3 },
    ]);

    const cls = runRegex(["zzabccq"], "[a-c]+5?", { caseSensitive: true });
    expect(cls.error).toBeNull();
    expect(cls.matches).toEqual([{ line: 0, start: 2, end: 6 }]);

    const anchors = runRegex(["foobar", "xxfoo", "afoo", "bar", "1bar", "foo"], "^foo");
    expect(anchors.matches).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 5, start: 0, end: 3 },
    ]);

    const endAnchor = runRegex(["mybar", "bar", "barx"], "bar$");
    expect(endAnchor.matches).toEqual([
      { line: 0, start: 2, end: 5 },
      { line: 1, start: 0, end: 3 },
    ]);

    const optional = runRegex(["ac", "abc", "abbc", "abbbc"], "ab?c");
    expect(optional.matches).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 1, start: 0, end: 3 },
    ]);

    const plusGreedy = runRegex(["baaaac"], "a+");
    expect(plusGreedy.matches).toEqual([{ line: 0, start: 1, end: 5 }]);

    const range = runRegex(["aaaaa"], "a{2,4}");
    expect(range.matches).toEqual([{ line: 0, start: 0, end: 4 }]);

    const finite = runRegex(["aaaa"], "a{3}");
    expect(finite.matches).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  test("keeps default case-insensitivity and never emits zero-width-only regex matches", () => {
    const insensitive = runRegex(["AbC"], "ABC");
    expect(insensitive.matches).toEqual([{ line: 0, start: 0, end: 3 }]);

    const sensitive = runRegex(["AbC"], "ABC", { caseSensitive: true });
    expect(sensitive.matches).toEqual([]);

    const zeroWidth = runRegex(["bbb"], "a*");
    expect(zeroWidth.matches).toEqual([]);
  });

  test("rejects unsupported or malformed regex-lite inputs with exact error codes", () => {
    expect(searchLines(["x"], "").error?.code).toBe("empty-query");
    expect(searchLines(["x"], "a".repeat(257)).error?.code).toBe("pattern-too-long");

    expect(runRegex(["x"], "(abc)").error?.code).toBe("unsupported-syntax");
    expect(runRegex(["x"], "a|b").error?.code).toBe("unsupported-syntax");
    expect(runRegex(["x"], "(?=a)").error?.code).toBe("unsupported-syntax");
    expect(runRegex(["x"], "\\1").error?.code).toBe("unsupported-syntax");
    expect(runRegex(["x"], "a**").error?.code).toBe("unsupported-syntax");
    expect(runRegex(["x"], "a{2}{2}").error?.code).toBe("malformed-pattern");

    expect(runRegex(["x"], "[a-z").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "[]").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "[z-a]").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "\\").error?.code).toBe("malformed-pattern");

    expect(runRegex(["x"], "a{").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "a{,}").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "a{,").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "a{1,").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "a{1,}").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "{1}").error?.code).toBe("malformed-pattern");
    expect(runRegex(["x"], "a{").error?.code).toBe("malformed-pattern");

    expect(runRegex(["x"], "a{101}").error?.code).toBe("invalid-bound");
    expect(runRegex(["x"], "a{99,101}").error?.code).toBe("invalid-bound");
    expect(runRegex(["x"], "a{9,3}").error?.code).toBe("invalid-bound");

    const rejected = runRegex(["x"], "(x)");
    expect(rejected.matches).toEqual([]);
  });

  test("returns bounded no-match result on an adversarial long quantified input without hangs", () => {
    const line = "a".repeat(25_000);
    const result = runRegex([line], "a{100,100}b");

    expect(result.error).toBeNull();
    expect(result.matches).toEqual([]);
  });

  test("enforces the 10,000-match cap with stable ordering in regex-lite mode", () => {
    const lines = Array.from({ length: 10_001 }, () => "match");
    const result = runRegex(lines, "match");

    expect(result.error?.code).toBe("result-limit");
    expect(result.matches).toHaveLength(10_000);
    expect(result.matches[0]).toEqual({ line: 0, start: 0, end: 5 });
    expect(result.matches[9_999]).toEqual({ line: 9_999, start: 0, end: 5 });
    expect(result.matches.every((match, index) => match.line === index)).toBe(true);
    expect(result.matches.some((match) => match.line === 10_000)).toBe(false);
  });
});

// Contract between core/src/search.ts (visible-offset producer) and
// core/src/ansi-html.ts (visible-offset consumer). If either side changes
// its escape dispatch without the other, this test fails — and that
// divergence is exactly the bug it exists to catch.
describe("visible-text contract with lineToHtml", () => {
  const cases: Array<{ name: string; raw: string; query?: string }> = [
    { name: "plain no-escape line", raw: "hello match world" },
    { name: "normal SGR (regression)", raw: "\x1b[31mred\x1b[0m match" },
    { name: "OSC 8 hyperlink", raw: "\x1b]8;;https://example.com\x07link match\x1b]8;;\x07" },
    { name: "charset selector ESC ( B", raw: "\x1b(Bmatch" },
    { name: "unknown ESC M before text", raw: "\x1bMxx match here" },
    { name: "unknown ESC D before match", raw: "\x1bDmatch" },
    { name: "torn CSI then SGR", raw: "\x1b[3\x1b[31mHELLO match" },
    { name: "SGR mixed with unknown ESC M", raw: "\x1b[32mok\x1b[0m \x1bMmatch tail" },
    { name: "combining mark before query", raw: "Cafe\u0301 match" },
    // Unterminated CSI (no final 0x40..0x7e): escape is invisible; leading text remains.
    { name: "unterminated CSI after text", raw: "visible \x1b[38;2;", query: "visible" },
  ];

  for (const { name, raw, query = "match" } of cases) {
    test(`highlighted span is exactly "${query}" for ${name}`, () => {
      const result = runPlain([raw], query);
      expect(result.error).toBeNull();
      expect(result.matches.length).toBeGreaterThan(0);

      const m = result.matches[0]!;
      expect(m.line).toBe(0);

      const html = lineToHtml(
        raw,
        createSgrState(),
        TEST_PALETTE,
        undefined,
        [{ start: m.start, end: m.end, kind: "search-match" }],
      );
      expect(highlightedSubstring(html)).toBe(query);
    });
  }

  // DEFECT 2 (MEDIUM): ESC interrupting a charset selector must be re-dispatched.
  // stripTerminalControls used to always skip 3 units for ESC (, so
  // "\x1b(\x1b[31mX" searched for "X" reported visible offset 4..5 while
  // lineToHtml re-dispatches the second ESC and paints X at offset 0 —
  // producing HTML with no search-match span at all.
  test('ESC aborts charset selector: "\\x1b(\\x1b[31mX" match at visible 0 (DEFECT 2 repro)', () => {
    const raw = "\x1b(\x1b[31mX";
    const result = runPlain([raw], "X");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 1 }]);

    const html = lineToHtml(
      raw,
      createSgrState(),
      TEST_PALETTE,
      undefined,
      [{ start: 0, end: 1, kind: "search-match" }],
    );
    expect(highlightedSubstring(html)).toBe("X");
  });
});

/**
 * Pin search ↔ renderer visible-offset agreement on adversarial control
 * sequences. This class of divergence has caused three separate bugs in the
 * same release; every case here must paint a search-match span whose text
 * equals the query at the offsets searchLines reports.
 */
describe("search/renderer visible-offset agreement (adversarial controls)", () => {
  const adversarial: Array<{ name: string; raw: string; query: string }> = [
    {
      name: "ESC aborts pending charset selector then CSI paints X",
      raw: "\x1b(\x1b[31mX",
      query: "X",
    },
    {
      name: "ESC aborts charset ESC ) then OSC hyperlink text",
      raw: "\x1b)\x1b]8;;https://ex.ample\x07HIT\x1b]8;;\x07",
      query: "HIT",
    },
    {
      name: "charset third-byte is high surrogate of emoji (do not swallow half)",
      raw: "\x1b(\u{1F600}Y",
      query: "\u{1F600}Y",
    },
    {
      name: "complete charset then SGR then text",
      raw: "\x1b(B\x1b[32mok",
      query: "ok",
    },
    {
      name: "ESC aborts unfinished CSI then charset then text",
      raw: "\x1b[38;2;\x1b(Bmatch",
      query: "match",
    },
    {
      name: "double ESC-abort chain: charset then CSI then text",
      raw: "\x1b*\x1b[1m\x1b[0mZ",
      query: "Z",
    },
    {
      name: "unknown two-byte ESC M then match",
      raw: "\x1bMbefore match after",
      query: "match",
    },
    {
      name: "torn CSI + charset + OSC body",
      raw: "\x1b[3\x1b(B\x1b]8;;u\x07T\x1b]8;;\x07",
      query: "T",
    },
  ];

  for (const { name, raw, query } of adversarial) {
    test(name, () => {
      const result = runPlain([raw], query);
      expect(result.error).toBeNull();
      expect(result.matches.length).toBeGreaterThan(0);

      const m = result.matches[0]!;
      expect(m.line).toBe(0);

      const html = lineToHtml(
        raw,
        createSgrState(),
        TEST_PALETTE,
        undefined,
        [{ start: m.start, end: m.end, kind: "search-match" }],
      );
      expect(highlightedSubstring(html)).toBe(query);
    });
  }
});

/**
 * Escape-dispatch visibility contract for searchLines output ONLY.
 * The renderer half of the same contract is pinned by the
 * `core/tests/ansi-modern.test.ts` cases:
 *   - "an unknown two-byte escape emits no visible text"
 *   - "ESC aborts an unterminated CSI instead of swallowing the next sequence"
 * Spans are UTF-16 offsets into the VISIBLE text (after stripTerminalControls).
 */
describe("terminal control visibility contract", () => {
  test("unknown ESC M is invisible: \"a\\x1bMbc\" searching \"abc\"", () => {
    const result = runPlain(["a\x1bMbc"], "abc");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  test("unknown ESC c is invisible: \"A\\x1bcB\" searching \"AB\"", () => {
    const result = runPlain(["A\x1bcB"], "AB");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 2 }]);
  });

  test("known two-byte ESC 7 / ESC = and charset ESC ( B leave no text", () => {
    for (const raw of ["A\x1b7B", "A\x1b=B", "A\x1b(BB"] as const) {
      const result = runPlain([raw], "AB");
      expect(result.error).toBeNull();
      expect(result.matches).toEqual([{ line: 0, start: 0, end: 2 }]);
    }
  });

  test("ESC inside CSI aborts and re-dispatches: \"before\\x1b[31\\x1b[0mafter\"", () => {
    // visible text is "beforeafter"; "after" at visible offsets 6..11
    const result = runPlain(["before\x1b[31\x1b[0mafter"], "after");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 6, end: 11 }]);
  });

  test("ESC-abort CSI then applied SGR: \"x\\x1b[31\\x1b[1my\" searching \"xy\"", () => {
    const result = runPlain(["x\x1b[31\x1b[1my"], "xy");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 2 }]);
  });

  test("aborted CSI must not eat the following OSC hyperlink", () => {
    const raw = "\x1b[38;2;\x1b]8;;https://leak.example\x07TEXT\x1b]8;;\x07";
    const result = runPlain([raw], "TEXT");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 4 }]);
  });

  test('a final byte inside the CSI ends it: \\x1b[3n is complete, only "ope" is visible', () => {
    // `n` (0x6e) is a CSI final byte (DSR). Sequence is `\x1b[3n`, remainder is "ope".
    const raw = "\x1b[3nope";
    expect(runPlain([raw], "nope").matches).toEqual([]);
    const ope = runPlain([raw], "ope");
    expect(ope.error).toBeNull();
    expect(ope.matches).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  test("unterminated CSI to end of line hides only the escape: \"visible \\x1b[38;2;\"", () => {
    // No final byte (0x40..0x7e) — CSI runs to EOL; preceding text stays visible.
    const raw = "visible \x1b[38;2;";
    const visible = runPlain([raw], "visible");
    expect(visible.error).toBeNull();
    expect(visible.matches).toEqual([{ line: 0, start: 0, end: 7 }]);
    expect(runPlain([raw], "38").matches).toEqual([]);
  });

  test("unterminated CSI alone leaves no visible text: \"\\x1b[3;5\"", () => {
    const result = runPlain(["\x1b[3;5"], "3");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([]);
  });
});

describe("regex-lite code-point atomicity", () => {
  const emojiLine = "a\u{1F600}b"; // a + 😀 + b  (UTF-16: 0, 1-2, 3)

  test('"a." matches a + full emoji, not a + high surrogate', () => {
    const result = runRegex([emojiLine], "a.");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 3 }]);
    assertNoSurrogateSplit(result.matches, emojiLine);
  });

  test('".b" matches full emoji + b, not low surrogate + b', () => {
    const result = runRegex([emojiLine], ".b");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 1, end: 4 }]);
    assertNoSurrogateSplit(result.matches, emojiLine);
  });

  test('"." matches three code points, never surrogate halves', () => {
    const result = runRegex([emojiLine], ".");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([
      { line: 0, start: 0, end: 1 },
      { line: 0, start: 1, end: 3 },
      { line: 0, start: 3, end: 4 },
    ]);
    assertNoSurrogateSplit(result.matches, emojiLine);
  });

  test("emoji literal in pattern finds the emoji as one atom", () => {
    const result = runRegex([emojiLine], "\u{1F600}");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 1, end: 3 }]);
    assertNoSurrogateSplit(result.matches, emojiLine);
  });

  test("character class with astral endpoints matches emoji as one atom", () => {
    const result = runRegex([emojiLine], "[\u{1F600}\u{1F601}]");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 1, end: 3 }]);
    assertNoSurrogateSplit(result.matches, emojiLine);
  });

  test("CJK code units (BMP) still match one-unit-at-a-time", () => {
    const line = "あい match";
    const result = runRegex([line], "あ.");
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([{ line: 0, start: 0, end: 2 }]);
    assertNoSurrogateSplit(result.matches, line);
  });
});
