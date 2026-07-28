import { describe, expect, test } from 'bun:test';

import { collectTerminalUrlSegments, findTerminalUrlAtCell } from '../src/terminal-link';

interface GoldenCase {
  name: string;
  cols: number;
  lines: string[];
  expected: { url: string; segments: { lineIdx: number; startCol: number; endCol: number }[] }[];
}

const GOLDEN: GoldenCase[] = [
  {
    name: "empty",
    cols: 80,
    lines: [],
    expected: [],
  },
  {
    name: "no urls",
    cols: 80,
    lines: ["hello world","nothing here"],
    expected: [],
  },
  {
    name: "single line url",
    cols: 80,
    lines: ["open https://example.com/path/to/resource"],
    expected: [{"url":"https://example.com/path/to/resource","segments":[{"lineIdx":0,"startCol":5,"endCol":41}]}],
  },
  {
    name: "url at col 0",
    cols: 80,
    lines: ["https://example.com/x"],
    expected: [{"url":"https://example.com/x","segments":[{"lineIdx":0,"startCol":0,"endCol":21}]}],
  },
  {
    name: "two urls same line",
    cols: 80,
    lines: ["a https://a.example.com/1 b https://b.example.com/2"],
    expected: [{"url":"https://a.example.com/1","segments":[{"lineIdx":0,"startCol":2,"endCol":25}]},{"url":"https://b.example.com/2","segments":[{"lineIdx":0,"startCol":28,"endCol":51}]}],
  },
  {
    name: "wrapped 2 rows",
    cols: 20,
    lines: ["https://example.com/very","longsegmentthatcontinues"],
    expected: [{"url":"https://example.com/verylongsegmentthatcontinues","segments":[{"lineIdx":0,"startCol":0,"endCol":24},{"lineIdx":1,"startCol":0,"endCol":24}]}],
  },
  {
    name: "wrapped 3 rows",
    cols: 36,
    lines: ["https://example.com/aaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cccccc end"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccc","segments":[{"lineIdx":0,"startCol":0,"endCol":36},{"lineIdx":1,"startCol":0,"endCol":36},{"lineIdx":2,"startCol":0,"endCol":6}]}],
  },
  {
    name: "wrapped then blank",
    cols: 36,
    lines: ["https://example.com/aaaaaaaaaaaaaaaa","","ignored"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaa","segments":[{"lineIdx":0,"startCol":0,"endCol":36}]}],
  },
  {
    name: "wrapped then indented cont",
    cols: 36,
    lines: ["https://example.com/aaaaaaaaaaaaaaaa","   indent-part rest"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaaindent-part","segments":[{"lineIdx":0,"startCol":0,"endCol":36},{"lineIdx":1,"startCol":3,"endCol":14}]}],
  },
  {
    name: "trailing period",
    cols: 80,
    lines: ["check https://example.com/path."],
    expected: [{"url":"https://example.com/path","segments":[{"lineIdx":0,"startCol":6,"endCol":30}]}],
  },
  {
    name: "trailing paren no open",
    cols: 80,
    lines: ["see https://example.com/path)"],
    expected: [{"url":"https://example.com/path","segments":[{"lineIdx":0,"startCol":4,"endCol":28}]}],
  },
  {
    name: "paren balanced kept",
    cols: 80,
    lines: ["see https://example.com/wiki/Foo_(bar)"],
    expected: [{"url":"https://example.com/wiki/Foo_(bar","segments":[{"lineIdx":0,"startCol":4,"endCol":37}]}],
  },
  {
    name: "trailing multi punct",
    cols: 80,
    lines: ["what https://example.com/path?!,"],
    expected: [{"url":"https://example.com/path","segments":[{"lineIdx":0,"startCol":5,"endCol":29}]}],
  },
  {
    name: "url is only punctuation tail",
    cols: 80,
    lines: ["https://."],
    expected: [{"url":"https://","segments":[{"lineIdx":0,"startCol":0,"endCol":8}]}],
  },
  {
    name: "very short cols",
    cols: 8,
    lines: ["https://a.co/1","abcd","efgh"],
    expected: [{"url":"https://a.co/1abcd","segments":[{"lineIdx":0,"startCol":0,"endCol":14},{"lineIdx":1,"startCol":0,"endCol":4}]}],
  },
  {
    name: "cols zero",
    cols: 0,
    lines: ["https://example.com/x"],
    expected: [{"url":"https://example.com/x","segments":[{"lineIdx":0,"startCol":0,"endCol":21}]}],
  },
  {
    name: "cols one",
    cols: 1,
    lines: ["https://example.com/x"],
    expected: [{"url":"https://example.com/x","segments":[{"lineIdx":0,"startCol":0,"endCol":21}]}],
  },
  {
    name: "url shorter than 10 chars trigger",
    cols: 10,
    lines: ["https://a","bbbb"],
    expected: [{"url":"https://a","segments":[{"lineIdx":0,"startCol":0,"endCol":9}]}],
  },
  {
    name: "ansi wrapped",
    cols: 36,
    lines: ["\u001b[32mhttps://example.com/aaaaaaaaaaaaaaaa\u001b[0m","bbbbbbbb rest"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaabbbbbbbb","segments":[{"lineIdx":0,"startCol":0,"endCol":36},{"lineIdx":1,"startCol":0,"endCol":8}]}],
  },
  {
    name: "osc sequence",
    cols: 80,
    lines: ["\u001b]0;title\u0007https://example.com/after"],
    expected: [{"url":"https://example.com/after","segments":[{"lineIdx":0,"startCol":0,"endCol":25}]}],
  },
  {
    name: "trailing spaces trimmed",
    cols: 80,
    lines: ["https://example.com/x     "],
    expected: [{"url":"https://example.com/x","segments":[{"lineIdx":0,"startCol":0,"endCol":21}]}],
  },
  {
    name: "http not https",
    cols: 80,
    lines: ["go http://example.com/plain"],
    expected: [{"url":"http://example.com/plain","segments":[{"lineIdx":0,"startCol":3,"endCol":27}]}],
  },
  {
    name: "scheme inside token",
    cols: 80,
    lines: ["prefix=https://example.com/inner suffix"],
    expected: [{"url":"https://example.com/inner","segments":[{"lineIdx":0,"startCol":7,"endCol":32}]}],
  },
  {
    name: "scheme inside long token then wrap",
    cols: 80,
    lines: ["qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhttps://example.com/inner","ccccccccccccccc"],
    expected: [{"url":"https://example.com/innerccccccccccccccc","segments":[{"lineIdx":0,"startCol":70,"endCol":95},{"lineIdx":1,"startCol":0,"endCol":15}]}],
  },
  {
    name: "many rows all wrap",
    cols: 80,
    lines: ["https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","d end"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccd","segments":[{"lineIdx":0,"startCol":0,"endCol":80},{"lineIdx":1,"startCol":0,"endCol":78},{"lineIdx":2,"startCol":0,"endCol":78},{"lineIdx":3,"startCol":0,"endCol":1}]}],
  },
  {
    name: "last row wraps off the end",
    cols: 80,
    lines: ["https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    expected: [{"url":"https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","segments":[{"lineIdx":0,"startCol":0,"endCol":80}]}],
  },
  {
    name: "unicode",
    cols: 80,
    lines: ["ดูที่ https://example.com/ไทย/path","ต่อ"],
    expected: [{"url":"https://example.com/ไทย/path","segments":[{"lineIdx":0,"startCol":6,"endCol":34}]}],
  },
  {
    name: "tab separated",
    cols: 80,
    lines: ["a\thttps://example.com/t\tb"],
    expected: [{"url":"https://example.com/t","segments":[{"lineIdx":0,"startCol":2,"endCol":23}]}],
  },
  {
    name: "url with query and hash",
    cols: 80,
    lines: ["https://example.com/p?a=1&b=2#frag more"],
    expected: [{"url":"https://example.com/p?a=1&b=2#frag","segments":[{"lineIdx":0,"startCol":0,"endCol":34}]}],
  },
  {
    name: "bracketed url",
    cols: 80,
    lines: ["<https://example.com/p>"],
    expected: [{"url":"https://example.com/p","segments":[{"lineIdx":0,"startCol":1,"endCol":22}]}],
  },
  {
    name: "quoted url",
    cols: 80,
    lines: ["\"https://example.com/p\""],
    expected: [{"url":"https://example.com/p","segments":[{"lineIdx":0,"startCol":1,"endCol":22}]}],
  },
  {
    name: "markdown link",
    cols: 80,
    lines: ["[docs](https://example.com/p)"],
    expected: [{"url":"https://example.com/p","segments":[{"lineIdx":0,"startCol":7,"endCol":28}]}],
  },
];

describe('collectTerminalUrlSegments — pinned contract', () => {
  for (const g of GOLDEN) {
    test(g.name, () => {
      expect(collectTerminalUrlSegments(g.lines, 0, g.lines.length, g.cols)).toEqual(g.expected);
    });
  }

  test('sub-windows behave the same as the reference', () => {
    for (const g of GOLDEN) {
      const full = collectTerminalUrlSegments(g.lines, 0, g.lines.length, g.cols);
      const fullKeys = new Set(full.map((m) => JSON.stringify(m)));

      for (let start = 0; start <= g.lines.length; start++) {
        for (let end = start; end <= g.lines.length; end++) {
          const out = collectTerminalUrlSegments(g.lines, start, end, g.cols);

          // Restricted full-range result: matches whose first segment lies in [start, end).
          const restricted = full.filter((m) => {
            const first = m.segments[0];
            return first != null && first.lineIdx >= start && first.lineIdx < end;
          });
          const restrictedKeys = new Set(restricted.map((m) => JSON.stringify(m)));

          for (const m of out) {
            const first = m.segments[0];
            expect(first).toBeDefined();
            expect(first!.lineIdx >= start && first!.lineIdx < end).toBe(true);
            expect(fullKeys.has(JSON.stringify(m))).toBe(true);
            expect(restrictedKeys.has(JSON.stringify(m))).toBe(true);
          }

          // Result is a subset of the restricted full-range result (by JSON string).
          expect(out.length).toBeLessThanOrEqual(restricted.length);
          for (const m of out) {
            expect(restrictedKeys.has(JSON.stringify(m))).toBe(true);
          }
        }
      }
    }
  });
});

describe('deterministic corpus digest', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const WORDS = [
    'building', 'module', 'ok', 'warn', 'error', 'fetch', 'GET', 'POST', '200', '404',
    'src/index.ts', 'node_modules', '=>', '|', 'done', 'ready', 'listening', 'on',
    'commit', 'abc1234', 'test', 'pass', 'fail', 'skip', '(3ms)', 'thumbmux',
  ];

  function realisticRows(n: number, seed: number, cols: number): string[] {
    const rand = rng(seed);
    const out: string[] = [];
    while (out.length < n) {
      const r = rand();
      if (r < 0.06) {
        const parts = 2 + Math.floor(rand() * 3);
        let url = 'https://registry.example.org/packages/' + 'seg'.repeat(4);
        for (let p = 0; p < parts; p++) url += '/' + 'q'.repeat(cols - 2);
        for (let off = 0; off < url.length; off += cols) out.push(url.slice(off, off + cols));
      } else if (r < 0.14) {
        out.push('  \x1b[32minfo\x1b[0m fetched https://example.com/api/v1/items/' + Math.floor(rand() * 99999));
      } else if (r < 0.18) {
        out.push('');
      } else {
        const wc = 3 + Math.floor(rand() * 8);
        const w: string[] = [];
        for (let k = 0; k < wc; k++) w.push(WORDS[Math.floor(rand() * WORDS.length)]);
        out.push('\x1b[90m' + w.join(' ') + '\x1b[0m');
      }
    }
    return out.slice(0, n);
  }

  function digest(s: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      h1 = ((h1 ^ s.charCodeAt(i)) * 16777619) >>> 0;
      h2 = ((h2 + s.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  const CORPUS: { seed: number; cols: number; matches: number; segments: number; digest: string }[] = [
    { seed: 1, cols: 80, matches: 22, segments: 60, digest: '0123e95c181b7400' },
    { seed: 2, cols: 40, matches: 30, segments: 96, digest: '39e275b881229000' },
    { seed: 3, cols: 120, matches: 25, segments: 56, digest: '9332c7d0d2a9dc00' },
  ];

  for (const c of CORPUS) {
    test(`seed=${c.seed} cols=${c.cols}`, () => {
      const lines = realisticRows(200, c.seed, c.cols);
      const out = collectTerminalUrlSegments(lines, 0, lines.length, c.cols);
      const segCount = out.reduce((n, m) => n + m.segments.length, 0);
      expect(out.length).toBe(c.matches);
      expect(segCount).toBe(c.segments);
      expect(digest(JSON.stringify(out))).toBe(c.digest);
    });
  }
});

/**
 * Scheme-break both directions — kept outside GOLDEN so the sub-window
 * exhaustiveness check is not polluted by absorbed continuation asymmetry
 * (a scheme-leading tail row is part of the parent match in the full window,
 * but a window that starts on that row still sees it as its own origin).
 */
describe('scheme-break: embedded value vs new link', () => {
  function wrapFixedWidth(text: string, cols: number): string[] {
    const rows: string[] = [];
    for (let i = 0; i < text.length; i += cols) rows.push(text.slice(i, i + cols));
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(cols);
    return rows;
  }

  function mainUrl(matches: { url: string }[]): string | undefined {
    return matches.map((m) => m.url).sort((a, b) => b.length - a.length)[0];
  }

  const OAUTH_LINE =
    'open https://auth.example.com/authorize?redirect_uri=https://app.example.com/cb&state=xyz';
  const OAUTH_URL =
    'https://auth.example.com/authorize?redirect_uri=https://app.example.com/cb&state=xyz';

  test('wrap-sweep cols 20-120: embedded-scheme OAuth URL fully reconstructed', () => {
    let widthsTested = 0;
    let schemeLeading = 0;
    for (let cols = 20; cols <= 120; cols++) {
      const lines = wrapFixedWidth(OAUTH_LINE, cols);
      if (lines.length < 2) continue;
      widthsTested++;
      for (let i = 1; i < lines.length; i++) {
        if (/^https?:\/\//.test(lines[i].trimStart())) schemeLeading++;
      }
      expect(mainUrl(collectTerminalUrlSegments(lines, 0, lines.length, cols))).toBe(OAUTH_URL);
    }
    expect(widthsTested).toBeGreaterThan(0);
    expect(schemeLeading).toBeGreaterThan(0);
    // Measured regression width: row 2 begins with the embedded app scheme.
    const at53 = wrapFixedWidth(OAUTH_LINE, 53);
    expect(at53[0]).toBe('open https://auth.example.com/authorize?redirect_uri=');
    expect(at53[1]?.startsWith('https://app.example.com/')).toBe(true);
    expect(mainUrl(collectTerminalUrlSegments(at53, 0, at53.length, 53))).toBe(OAUTH_URL);
  });

  test('unrelated scheme-leading rows are not glued', () => {
    const matches = collectTerminalUrlSegments(
      ['https://a.example.com/xxxxxxxxxxxxxxxx', 'https://b.example.com/y'],
      0,
      2,
      36,
    );
    expect(matches.map((m) => m.url)).toEqual([
      'https://a.example.com/xxxxxxxxxxxxxxxx',
      'https://b.example.com/y',
    ]);
    expect(matches.some((m) => m.url.includes('a.example.com') && m.url.includes('b.example.com'))).toBe(false);
  });
});

describe('findTerminalUrlAtCell — pinned contract', () => {
  const CELL_CASES = new Set([
    'single line url',
    'wrapped 2 rows',
    'wrapped 3 rows',
    'trailing period',
    'markdown link',
    'paren balanced kept',
  ]);

  for (const g of GOLDEN) {
    if (!CELL_CASES.has(g.name)) continue;

    test(g.name, () => {
      // Build cell → url map from golden expected segments.
      const cover = new Map<string, string>();
      for (const m of g.expected) {
        for (const seg of m.segments) {
          for (let col = seg.startCol; col < seg.endCol; col++) {
            cover.set(`${seg.lineIdx},${col}`, m.url);
          }
        }
      }

      for (let lineIdx = 0; lineIdx < g.lines.length; lineIdx++) {
        for (let col = 0; col <= g.cols + 8; col++) {
          const got = findTerminalUrlAtCell(g.lines, lineIdx, col, g.cols);
          const want = cover.get(`${lineIdx},${col}`) ?? null;
          expect(got).toBe(want);
        }
      }
    });
  }
});
