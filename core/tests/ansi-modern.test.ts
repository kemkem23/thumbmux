import { describe, expect, test } from "bun:test";

import {
  cloneSgrState,
  createSgrState,
  lineToHtml,
  sgrStateKey,
  type AnsiPalette,
} from "../src/ansi-html";

const palette: AnsiPalette = {
  base: [
    "#000",
    "#f00",
    "#0f0",
    "#ff0",
    "#00f",
    "#f0f",
    "#0ff",
    "#fff",
    "#111",
    "#f11",
    "#1f1",
    "#ff1",
    "#11f",
    "#f1f",
    "#1ff",
    "#eee",
  ],
  defaultFg: "#e6e6e6",
  defaultBg: "#101014",
};

describe("ansi-modern seam", () => {
  test("OSC 8 opens/closes with BEL and ST across lines, preserving cloned state keying", () => {
    const belState = createSgrState();

    expect(lineToHtml("\x1b]8;;https://bel.example\x07left", belState, palette)).toBe(
      '<a href="https://bel.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">left</a>',
    );
    const openKey = sgrStateKey(belState);
    const belClone = cloneSgrState(belState);
    expect(sgrStateKey(belClone)).toBe(openKey);

    expect(lineToHtml("cross", belClone, palette)).toBe(
      '<a href="https://bel.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">cross</a>',
    );
    lineToHtml("\x1b]8;;\x07", belState, palette);
    expect(sgrStateKey(belState)).toBe(sgrStateKey(createSgrState()));
    expect(lineToHtml("closed", belState, palette)).toBe("closed");
    expect(lineToHtml("still-open", belClone, palette)).toContain('href="https://bel.example"');

    const stState = createSgrState();
    expect(lineToHtml("\x1b]8;;https://st.example\x1b\\open", stState, palette)).toBe(
      '<a href="https://st.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">open</a>',
    );
    expect(lineToHtml("across", stState, palette)).toContain('href="https://st.example"');
    lineToHtml("\x1b]8;;\x1b\\", stState, palette);
    expect(lineToHtml("ended", stState, palette)).toBe("ended");
  });

  test("safe http/https/mailto ranges become hardened anchors with escaped attrs and rel", () => {
    const hrefs = [
      "http://safe.example/path?x=1&y=2",
      "https://safe.example/path?x=1&y=2",
      "mailto:test@example.com?subject=Hi&body=one",
    ];

    for (const href of hrefs) {
      const html = lineToHtml(href, createSgrState(), palette, [{ start: 0, end: href.length, href }]);
      const escaped = href.replace(/&/g, "&amp;");

      expect(html).toContain(
        `<a href="${escaped}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">${escaped}</a>`,
      );
      expect(html).not.toContain("\x1b");
    }

    const attrHref = 'https://safe.example/path?quote="yes"&tag=<safe>';
    const escapedAttrHref = "https://safe.example/path?quote=&quot;yes&quot;&amp;tag=&lt;safe&gt;";
    expect(lineToHtml("attrs", createSgrState(), palette, [{ start: 0, end: 5, href: attrHref }])).toContain(
      `href="${escapedAttrHref}"`,
    );
  });

  test("unsafe URL schemes stay plain and do not inject attributes or include raw escapes", () => {
    expect(lineToHtml("javascript:alert(1)", createSgrState(), palette, [{ start: 0, end: 18, href: "javascript:alert(1)" }])).toBe(
      "javascript:alert(1)",
    );

    const html = lineToHtml(
      "\x1b]8;;javascript:alert(1)\x07<bad & text>\x1b]8;;\x07",
      createSgrState(),
      palette,
    );

    expect(html).toBe("&lt;bad &amp; text&gt;");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("\x1b");
  });

  test("explicit safe OSC 8 takes precedence over detected 4-argument URL ranges", () => {
    const detected = "https://range.example";
    const html = lineToHtml(
      `\x1b]8;;https://osc.example\x07${detected}\x1b]8;;\x07`,
      createSgrState(),
      palette,
      [{ start: 0, end: detected.length, href: "https://fallback.example" }],
    );

    expect(html).toContain('href="https://osc.example"');
    expect(html).not.toContain('href="https://fallback.example"');
    expect(html).toContain(">https://range.example</a>");
  });

  test("SGR underline modes cover 4, 4:0..5, 21, 24 and carry across lines", () => {
    const state = createSgrState();

    expect(lineToHtml("\x1b[4msingle", state, palette)).toContain("text-decoration:underline");
    expect(lineToHtml("\x1b[4:0mclear", state, palette)).toBe("clear");
    expect(lineToHtml("\x1b[4:1msingle-variant", state, palette)).toContain("text-decoration:underline");
    expect(state.underlineStyle).toBe("single");
    expect(lineToHtml("\x1b[4:2mdouble-variant", state, palette)).toContain("text-decoration-style:double");
    expect(state.underlineStyle).toBe("double");
    expect(lineToHtml("\x1b[4:3mwavy", state, palette)).toContain("text-decoration-style:wavy");
    expect(lineToHtml("\x1b[4:4mdotted", state, palette)).toContain("text-decoration-style:dotted");
    expect(lineToHtml("\x1b[4:5mdashed", state, palette)).toContain("text-decoration-style:dashed");
    expect(lineToHtml("\x1b[21mdouble", state, palette)).toContain("text-decoration-style:double");

    expect(lineToHtml("\x1b[4mcarry", state, palette)).toContain("text-decoration:underline");
    expect(lineToHtml("across", state, palette)).toContain("text-decoration:underline");
    expect(lineToHtml("\x1b[24mplain", state, palette)).toBe("plain");
  });

  test("SGR 58/59 supports indexed and RGB semicolon plus colon forms, and 59 resets underline color", () => {
    const state = createSgrState();

    expect(lineToHtml("\x1b[4;58;5;1msemicolon-index", state, palette)).toContain("text-decoration-color:#f00");
    expect(lineToHtml("\x1b[4;58;2;0;128;255msemicolon-rgb", state, palette)).toContain("text-decoration-color:#0080ff");
    expect(lineToHtml("\x1b[4;58:5:3mcolon-index", state, palette)).toContain("text-decoration-color:#ff0");
    expect(lineToHtml("\x1b[4;58:2::10:20:30mcolon-rgb", state, palette)).toContain("text-decoration-color:#0a141e");

    expect(lineToHtml("carry", state, palette)).toContain("text-decoration-color:#0a141e");
    const reset = lineToHtml("\x1b[59mafter-reset", state, palette);
    expect(reset).toContain("text-decoration:underline");
    expect(reset).not.toContain("text-decoration-color");

    lineToHtml("\x1b[4:5;58:2::1:2:3mset-modern-state", state, palette);
    lineToHtml("\x1b[0m", state, palette);
    expect(state.underline).toBe(false);
    expect(state.underlineStyle).toBeNull();
    expect(state.underlineColor).toBeNull();
    expect(sgrStateKey(state)).toBe(sgrStateKey(createSgrState()));
  });

  test("SGR reset with \\x1b[0m preserves OSC links until OSC close", () => {
    const state = createSgrState();

    expect(lineToHtml("\x1b]8;;https://persist.example\x07\x1b[4;58;5;4mlinked", state, palette)).toContain(
      'href="https://persist.example"',
    );
    expect(lineToHtml("\x1b[0mstill-linked", state, palette)).toContain(
      'style="color:inherit;text-decoration:underline">still-linked</a>',
    );
    lineToHtml("\x1b]8;;\x07", state, palette);
    expect(lineToHtml("done", state, palette)).toBe("done");
  });

  test("fifth-argument search overlays are renderer-owned, nest with link/SGR, and active beats match", () => {
    const state = createSgrState();
    const anchorStyle = 'color:#e6e6e6;font-weight:700;text-decoration:underline';
    const html = lineToHtml(
      "\x1b[1msearch",
      state,
      palette,
      [{ start: 0, end: 6, href: "https://overlay.example" }],
      [
        { start: 0, end: 6, kind: "search-match" },
        { start: 2, end: 4, kind: "search-active" },
      ],
    );

    expect(html).toContain('font-weight:700');
    expect(html).toContain(`<a href="https://overlay.example" target="_blank" rel="noopener noreferrer" style="${anchorStyle}"><span class="search-match">se</span></a>`);
    expect(html).toContain(`<a href="https://overlay.example" target="_blank" rel="noopener noreferrer" style="${anchorStyle}"><span class="search-active">ar</span></a>`);
    expect(html).toContain(`<a href="https://overlay.example" target="_blank" rel="noopener noreferrer" style="${anchorStyle}"><span class="search-match">ch</span></a>`);
  });

  test("invalid/out-of-range ranges emit only safe escaped text", () => {
    const html = lineToHtml(
      "<bad>",
      createSgrState(),
      palette,
      [{ start: 0, end: 5, href: "javascript:alert(1)" }],
      [
        { start: -1, end: 2, kind: "search-match" },
        { start: 2, end: 2, kind: "search-match" },
        { start: 10, end: 12, kind: "search-active" },
        { start: 0, end: 5, kind: 'search-match" onclick="alert(1)' as never },
      ],
    );

    expect(html).toBe("&lt;bad&gt;");
    expect(html).not.toContain("onclick");
  });

  test("UTF-16 offsets around astral symbols are applied to link ranges", () => {
    const emoji = "\ud83d\ude03";
    const html = lineToHtml(
      `x${emoji}y`,
      createSgrState(),
      palette,
      [{ start: 1, end: 3, href: "https://astral.example" }],
    );

    // Wide glyphs (emoji = 2 cells) are pinned in .mtv-w2 so the render grid
    // matches tmux columns regardless of host font advance.
    expect(html).toBe(
      `x<a href="https://astral.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline"><span class="mtv-w2">${emoji}</span></a>y`,
    );

    expect(lineToHtml(
      `x${emoji}y`,
      createSgrState(),
      palette,
      undefined,
      [{ start: 1, end: 3, kind: "search-match" }],
    )).toBe(`x<span class="search-match"><span class="mtv-w2">${emoji}</span></span>y`);
  });

  test("a malformed OSC 8 replacement clears an earlier OSC 8 link", () => {
    const state = createSgrState();
    lineToHtml("\x1b]8;;https://prior.example\x07", state, palette);
    expect(lineToHtml("\x1b]8;malformed", state, palette)).toBe("\u00a0");
    expect(state.osc8Href).toBeNull();
    expect(lineToHtml("plain", state, palette)).toBe("plain");
  });

  test("existing four-argument lineToHtml calls remain valid", () => {
    const href = "https://legacy.example?x=1&y=2";
    const prefix = "legacy ";
    const html = lineToHtml(
      `${prefix}${href}`,
      createSgrState(),
      palette,
      [{ start: prefix.length, end: prefix.length + href.length, href }],
    );
    const escapedHref = href.replace(/&/g, "&amp;");

    expect(html).toBe(
      `${prefix}<a href="${escapedHref}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">${escapedHref}</a>`,
    );
  });
});

describe("ansi-modern hardening", () => {
  test("a range boundary must never split a surrogate pair", () => {
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    const overlayHtml = lineToHtml(
      "ok 😃 done",
      createSgrState(),
      palette,
      undefined,
      [
        { start: 3, end: 4, kind: "search-match" },
        { start: 4, end: 5, kind: "search-match" },
      ],
    );
    expect(loneSurrogate.test(overlayHtml)).toBe(false);
    expect(overlayHtml).toContain('<span class="search-match"><span class="mtv-w2">\u{1F603}</span></span>');

    const linkHtml = lineToHtml(
      "a😃b",
      createSgrState(),
      palette,
      [{ start: 2, end: 3, href: "https://x.example" }],
    );
    expect(loneSurrogate.test(linkHtml)).toBe(false);
    expect(linkHtml).toContain('><span class="mtv-w2">\u{1F603}</span></a>');
    expect(linkHtml.startsWith("a")).toBe(true);
    expect(linkHtml.endsWith("b")).toBe(true);
  });

  test("ESC aborts an unterminated CSI instead of swallowing the next sequence", () => {
    const aborted = lineToHtml("before\x1b[31\x1b[0mafter", createSgrState(), palette);
    expect(aborted).toBe("beforeafter");

    const boldOnly = lineToHtml("x\x1b[31\x1b[1my", createSgrState(), palette);
    expect(boldOnly).toBe(
      'x<span style="color:#e6e6e6;font-weight:700">y</span>',
    );

    const oscLeak = lineToHtml(
      "\x1b[38;2;\x1b]8;;https://leak.example\x07TEXT\x1b]8;;\x07",
      createSgrState(),
      palette,
    );
    expect(oscLeak).toBe(
      '<a href="https://leak.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">TEXT</a>',
    );

    for (const html of [aborted, boldOnly, oscLeak]) {
      expect(html).not.toContain("\x1b");
    }
  });

  test("an unknown two-byte escape emits no visible text", () => {
    expect(lineToHtml("A\x1bcB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1bMB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1bDB", createSgrState(), palette)).toBe("AB");

    expect(
      lineToHtml(
        "a\x1bMbc",
        createSgrState(),
        palette,
        undefined,
        [{ start: 1, end: 2, kind: "search-match" }],
      ),
    ).toBe('a<span class="search-match">b</span>c');

    expect(lineToHtml("A\x1b7B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b=B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b(BB", createSgrState(), palette)).toBe("AB");
  });

  test("href validation is per-call, not per-character", () => {
    function countUrlConstructions(run: () => void): number {
      const RealURL = globalThis.URL;
      let calls = 0;
      class CountingURL extends RealURL {
        constructor(input: string | URL, base?: string | URL) {
          calls += 1;
          super(input as never, base as never);
        }
      }
      (globalThis as { URL: typeof URL }).URL = CountingURL as unknown as typeof URL;
      try {
        run();
      } finally {
        (globalThis as { URL: typeof URL }).URL = RealURL;
      }
      return calls;
    }

    const line = "x".repeat(80);
    const links = Array.from({ length: 40 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 2,
      href: `https://hot.example/l${i}`,
    }));
    const denseCalls = countUrlConstructions(() => {
      lineToHtml(line, createSgrState(), palette, links);
    });
    expect(denseCalls).toBeLessThanOrEqual(42);

    const openOsc =
      "\x1b]8;;https://hot.example\x07" + "\x1b[31mx\x1b[32my".repeat(20);
    const oscCalls = countUrlConstructions(() => {
      lineToHtml(openOsc, createSgrState(), palette);
    });
    expect(oscCalls).toBeLessThanOrEqual(3);
  });

  test("dense link + overlay rendering stays inside the frame budget", () => {
    const line = "x".repeat(160);
    const links = Array.from({ length: 40 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 4,
      href: `https://budget.example/l${i}`,
    }));
    const overlays = Array.from({ length: 40 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 2,
      kind: "search-match" as const,
    }));

    // Warm up once so JIT/caches settle before the timed pass.
    {
      const warm = createSgrState();
      lineToHtml(line, warm, palette, links, overlays);
    }

    const state = createSgrState();
    const t0 = performance.now();
    for (let row = 0; row < 60; row++) {
      lineToHtml(line, state, palette, links, overlays);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(40);
  });

  test("plain SGR rendering is byte-for-byte unchanged", () => {
    expect(lineToHtml("hello <world> & co", createSgrState(), palette)).toBe(
      "hello &lt;world&gt; &amp; co",
    );
    expect(lineToHtml("\x1b[31mred\x1b[0m plain", createSgrState(), palette)).toBe(
      '<span style="color:#f00">red</span> plain',
    );
    expect(lineToHtml("\x1b[1;32mgo", createSgrState(), palette)).toBe(
      '<span style="color:#1f1;font-weight:700">go</span>',
    );
    expect(lineToHtml("\x1b[7minverse\x1b[27m", createSgrState(), palette)).toBe(
      '<span style="color:#101014;background-color:#e6e6e6">inverse</span>',
    );
    expect(lineToHtml("\x1b[4;9mboth", createSgrState(), palette)).toBe(
      '<span style="color:#e6e6e6;text-decoration:underline line-through">both</span>',
    );
    expect(lineToHtml("\x1b[38;5;215mx", createSgrState(), palette)).toBe(
      '<span style="color:#ffaf5f">x</span>',
    );
    expect(
      lineToHtml("\x1b[2;3;48;5;17mdim italic bg", createSgrState(), palette),
    ).toBe(
      '<span style="color:#e6e6e6;background-color:#00005f;opacity:.6;font-style:italic">dim italic bg</span>',
    );
    expect(lineToHtml("\x1b[38;2;10;20;30my", createSgrState(), palette)).toBe(
      '<span style="color:#0a141e">y</span>',
    );
    expect(lineToHtml("", createSgrState(), palette)).toBe("\u00a0");
    expect(
      lineToHtml("a\x1b[?25lb\x1b]2;title\x07c\x1b[?25hd", createSgrState(), palette),
    ).toBe("abcd");
  });

  test("an escape skip never orphans half of a surrogate pair", () => {
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    const w2 = (s: string) => `<span class="mtv-w2">${s}</span>`;
    const cases = [
      { input: "\x1b😃", expected: w2("😃") },
      { input: "a\x1b😃b", expected: `a${w2("😃")}b` },
      { input: "\x1b(😃", expected: w2("😃") },
    ];
    for (const { input, expected } of cases) {
      const html = lineToHtml(input, createSgrState(), palette);
      expect(html).toBe(expected);
      expect(loneSurrogate.test(html)).toBe(false);
    }

    // Must not regress fixed-width escape consumption of BMP seconds/thirds.
    expect(lineToHtml("A\x1bcB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1bMB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1bDB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b7B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b=B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b(BB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("\x1b7😃", createSgrState(), palette)).toBe(w2("😃"));
    expect(lineToHtml("a\x1b[31m😃b", createSgrState(), palette)).toBe(
      `a<span style="color:#f00">${w2("😃")}b</span>`,
    );
  });

  test("ESC restarts the parser in fixed-width escape skips", () => {
    // Four cases found by fuzzing: fixed-width skips must not swallow a
    // following ESC (and therefore the sequence it starts).
    const red = lineToHtml("\x1b\x1b[31mred", createSgrState(), palette);
    expect(red).toBe('<span style="color:#f00">red</span>');

    const bold = lineToHtml("a\x1b\x1b[1mb", createSgrState(), palette);
    expect(bold).toBe(
      'a<span style="color:#e6e6e6;font-weight:700">b</span>',
    );

    const charset = lineToHtml("\x1b(\x1b[31mred", createSgrState(), palette);
    expect(charset).toBe('<span style="color:#f00">red</span>');

    const osc = lineToHtml(
      "\x1b\x1b]8;;https://x.example\x07T\x1b]8;;\x07",
      createSgrState(),
      palette,
    );
    expect(osc).toBe(
      '<a href="https://x.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">T</a>',
    );

    for (const html of [red, bold, charset, osc]) {
      expect(html).not.toContain("\x1b");
      expect(html).not.toContain("\x07");
    }

    // Must not regress ordinary fixed-width skips / CSI abort / OSC skip.
    expect(lineToHtml("A\x1bcB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1bMB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b7B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b=B", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("A\x1b(BB", createSgrState(), palette)).toBe("AB");
    expect(lineToHtml("\x1b😃", createSgrState(), palette)).toBe(
      '<span class="mtv-w2">😃</span>',
    );
    expect(lineToHtml("\x1b(😃", createSgrState(), palette)).toBe(
      '<span class="mtv-w2">😃</span>',
    );
    expect(lineToHtml("before\x1b[31\x1b[0mafter", createSgrState(), palette)).toBe(
      "beforeafter",
    );
    expect(
      lineToHtml("a\x1b[?25lb\x1b]2;title\x07c\x1b[?25hd", createSgrState(), palette),
    ).toBe("abcd");
  });
});

describe("dense search overlay complexity", () => {
  /**
   * Dense non-overlapping matches (search "a" in "aaa…") used to rescan every
   * overlay at every segment boundary → ~O(N²). Measured before the fix
   * (2026-07-27, this host): 1k≈19ms · 5k≈126ms · 10k≈483ms.
   * Bound the 10k case well below the old half-second stall so a regression
   * reintroducing linear rescan fails the suite.
   */
  test("10_000 unit overlays stay linear-time and byte-identical to sparse path", () => {
    const sizes = [1_000, 5_000, 10_000] as const;
    const timings: Record<number, number> = {};

    for (const n of sizes) {
      const line = "a".repeat(n);
      const overlays = Array.from({ length: n }, (_, i) => ({
        start: i,
        end: i + 1,
        kind: "search-match" as const,
      }));

      // Warm one small call so first-time JIT cost does not dominate 1k.
      lineToHtml("a", createSgrState(), palette, undefined, [
        { start: 0, end: 1, kind: "search-match" },
      ]);

      const t0 = performance.now();
      const html = lineToHtml(line, createSgrState(), palette, undefined, overlays);
      timings[n] = performance.now() - t0;

      // One span per character — exact shape, not just length.
      expect(html).toBe('<span class="search-match">a</span>'.repeat(n));
    }

    // Publish measured numbers into the assertion message on failure.
    const summary = sizes.map((n) => `${n}=${timings[n]!.toFixed(2)}ms`).join(" ");
    // Old quadratic 10k was ~480–520ms. Allow headroom for CI load, but keep
    // the ceiling far below the pre-fix stall (and require sub-quadratic growth).
    expect(timings[10_000]!, `dense overlay timings: ${summary}`).toBeLessThan(80);
    // 10k must not be ~25× slower than 1k (quadratic would be ~100×).
    expect(timings[10_000]! / Math.max(timings[1_000]!, 0.01)).toBeLessThan(25);

    // Overlapping active-vs-match priority + first-link-wins stay correct under
    // the advancing-index path (not just the unit non-overlap case).
    // links: [0,3) first + [1,4) second → positions 0..2 prefer first; pos 3 is second only.
    // overlays: match [0,2) + active [1,3) → pos0 match, pos1-2 active.
    const overlapHtml = lineToHtml(
      "abcd",
      createSgrState(),
      palette,
      [
        { start: 0, end: 3, href: "https://first.example" },
        { start: 1, end: 4, href: "https://second.example" },
      ],
      [
        { start: 0, end: 2, kind: "search-match" },
        { start: 1, end: 3, kind: "search-active" },
      ],
    );
    expect(overlapHtml).toBe(
      '<a href="https://first.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline"><span class="search-match">a</span></a>' +
        '<a href="https://first.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline"><span class="search-active">b</span></a>' +
        '<a href="https://first.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline"><span class="search-active">c</span></a>' +
        '<a href="https://second.example" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">d</a>',
    );
  });
});
