import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  extractRecentPrompts,
  extractRecentPromptsFromPane,
  stripAnsi,
} from "../src/prompt-scan";

// Vendored into the package: this test used to read the private monorepo's corpus
// via ../../../../, which does not exist in the split tree the public tag is built
// from. A skip-when-absent guard was rejected — it would make this vacuous in exactly
// the environment that ships. The host keeps its own copy, so the two can drift.
const HOST_PANE_FIXTURES = join(import.meta.dir, "fixtures/panes");

const CUSTOM_PROMPT_MATCHERS = {
  promptPayload(line: string): string | null {
    return /^\s*::\s*(.+)$/.exec(line)?.[1]?.trim() ?? null;
  },
  isFaintPayload(rawLine: string): boolean {
    return rawLine.includes("[ghost]");
  },
  isStatusLine(trimmedLine: string): boolean {
    return trimmedLine === "READY";
  },
  isPromptTerminator(line: string): boolean {
    return line.trim() === "END";
  },
};

describe("terminal prompt extraction", () => {
  test("replaces the complete default matcher set through both scanning APIs", () => {
    const lines = [
      "› default-only prompt",
      "• default response",
      ":: custom prompt",
      "  continued on the next line",
      "END",
      ":: [ghost] custom composer suggestion",
      "END",
      ":: unsent custom composer text",
      "READY",
    ];
    const expected = ["custom prompt continued on the next line"];

    expect({
      lines: extractRecentPrompts(lines, { matchers: CUSTOM_PROMPT_MATCHERS }),
      pane: extractRecentPromptsFromPane(lines.join("\n"), 5, {
        matchers: CUSTOM_PROMPT_MATCHERS,
      }),
    }).toEqual({ lines: expected, pane: expected });
  });

  test("exports the named default matcher set from the public core entry point", async () => {
    const core = await import("../src/index");

    expect({
      promptPayload: typeof core.DEFAULT_PROMPT_MATCHERS.promptPayload,
      isFaintPayload: typeof core.DEFAULT_PROMPT_MATCHERS.isFaintPayload,
      isStatusLine: typeof core.DEFAULT_PROMPT_MATCHERS.isStatusLine,
      isPromptTerminator: typeof core.DEFAULT_PROMPT_MATCHERS.isPromptTerminator,
      isGrokStatusLine: typeof core.isGrokStatusLine,
      frozen: Object.isFrozen(core.DEFAULT_PROMPT_MATCHERS),
    }).toEqual({
      promptPayload: "function",
      isFaintPayload: "function",
      isStatusLine: "function",
      isPromptTerminator: "function",
      isGrokStatusLine: "function",
      frozen: true,
    });
  });

  test("keeps byte-exact default outputs for the host pane fixture corpus", async () => {
    const expectedByFixture = {
      "cc-approval.txt": [],
      "cc-idle.txt": [],
      "cc-thinking.txt": [],
      "codex-approval.txt": [],
      "codex-idle.txt": [],
      "codex-working.txt": [],
      "grok-idle.txt": ["Reply with exactly GROK_SMOKE_OK and nothing else."],
      "grok-welcome.txt": [],
      "grok-working.txt": ["Reply with exactly GROK_SMOKE_OK and nothing else."],
    } satisfies Record<string, string[]>;

    const outputs = Object.fromEntries(await Promise.all(
      Object.entries(expectedByFixture).map(async ([fixture]) => {
        const content = await readFile(join(HOST_PANE_FIXTURES, fixture), "utf8");
        return [fixture, {
          lines: extractRecentPrompts(content.split("\n")),
          pane: extractRecentPromptsFromPane(content),
        }];
      }),
    ));

    expect(outputs).toEqual(Object.fromEntries(
      Object.entries(expectedByFixture).map(([fixture, prompts]) => [
        fixture,
        { lines: prompts, pane: prompts },
      ]),
    ));
  });

  test("extracts codex auto-fix user report instead of the generic wrapper heading", () => {
    const prompts = extractRecentPrompts([
      "output before",
      "› # AUTO-FIX TASK · user report (autonomous mode)",
      "",
      "  You are an auto-fix agent dispatched by the host orchestrator.",
      "",
      "  ## User report",
      "  codex recent prompt header is wrong, investigate and fix",
      "",
      "  ## Source",
      "  Telegram /fix",
      "",
      "• Explored",
      "  └ List ls",
      "",
      "› Follow-up prompt",
      "• Explored",
      "",
      "  gpt-5.5 xhigh · 5h 100% · weekly 34% · Context 21% used",
    ]);

    expect(prompts).toEqual([
      "codex recent prompt header is wrong, investigate and fix",
      "Follow-up prompt",
    ]);
  });

  test("keeps normal claude and codex prompts in recency order without status chrome", () => {
    // Realistic pane order: each submitted prompt is followed by its response;
    // the empty composer + status chrome sit at the very bottom.
    const prompts = extractRecentPrompts([
      "\x1b[1;2m› \x1b[0mRun /review on current changes",
      "• Explored the diff",
      "",
      "❯ Ship the mobile terminal fix",
      "✻ Baked for 3m 14s",
      "",
      "❯ ",
      "  gpt-5.5 xhigh · 5h 100% · weekly 34% · Context 21% used",
    ]);

    expect(prompts).toEqual([
      "Run /review on current changes",
      "Ship the mobile terminal fix",
    ]);
  });

  test("keeps status-shaped prose inside a submitted multi-line prompt", () => {
    expect(extractRecentPrompts([
      '❯ document these literal examples',
      '✳ Writing a report',
      '✽ Reading app.log',
      '\x1b[38;5;246m✳\x1b[39m Writing a report',
      '\x1b[38;5;246m✽\x1b[39m Reading app.log',
      'and keep both lines verbatim',
      '● response body starts here',
    ])).toEqual([
      'document these literal examples ✳ Writing a report ✽ Reading app.log '
        + '✳ Writing a report ✽ Reading app.log and keep both lines verbatim',
    ]);
  });

  test("preserves an exact Claude activity capture pasted into a submitted prompt", () => {
    const plainStatus = '✢ Thinking… (thinking with xhigh effort)';
    const expected = [
      'preserve this capture ✢ Thinking… (thinking with xhigh effort) '
        + 'and explain why it flickers',
    ];
    for (const status of [plainStatus, `\x1b[38;5;174m${plainStatus}\x1b[39m`]) {
      const lines = [
        '❯ preserve this capture',
        status,
        'and explain why it flickers',
        '● response',
      ];
      expect({
        lines: extractRecentPrompts(lines),
        pane: extractRecentPromptsFromPane(lines.join('\n')),
      }, status).toEqual({ lines: expected, pane: expected });
    }
  });

  test("strips ansi escape codes used by tmux captures", () => {
    expect(stripAnsi("\x1b[1m›\x1b[0m prompt")).toBe("› prompt");
  });

  // Grok Build TUI (v0.2.22) — pane shapes from the real snapshot corpus at
  // .claude/grok-snapshots/run1 (2026-06-05).
  test("extracts grok echoed prompts: indent ~5, trailing clock stripped, response not glued", () => {
    const prompts = extractRecentPrompts([
      "   main ~/work/orchestrator-app                        │ 33K / 512K │",
      "",
      "     ❯ Reply with exactly GROK_SMOKE_OK and nothing else.            1:43 PM",
      "",
      "     ◆ Thought for 1.0s",
      "",
      "     GROK_SMOKE_OK                                                   1:43 PM",
      "",
      "     Turn completed in 4.1s.",
      "",
      "  ╭──────────────────────────────────────────────────────────────────────────╮",
      "  │ ❯                                                                        │",
      "  ╰──────────────────────────────────────────── Grok Build · always-approve ─╯",
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ]);

    expect(prompts).toEqual(["Reply with exactly GROK_SMOKE_OK and nothing else."]);
  });

  test("keeps multi-line grok thai prompt together and stops at the thought marker", () => {
    const prompts = extractRecentPrompts([
      "     ❯ สวัสดีครับ ช่วยเขียนกลอนสั้นๆ ภาษาไทย 4 บรรทัดเกี่ยวกับ terminal สีดำ     1:44 PM",
      "       แล้วอธิบายความหมายสั้นๆ หนึ่งประโยค",
      "  ❙  ◆ Thought for 16.2s",
      "     พิมพ์รหัสลับเพื่อปลุกพลังลึกซึ้ง",
      "     Turn completed in 19s.",
      "  ╰──────────────────────────────────────────── Grok Build · always-approve ─╯",
    ]);

    expect(prompts).toEqual([
      "สวัสดีครับ ช่วยเขียนกลอนสั้นๆ ภาษาไทย 4 บรรทัดเกี่ยวกับ terminal สีดำ แล้วอธิบายความหมายสั้นๆ หนึ่งประโยค",
    ]);
  });

  test("ignores the grok composer line inside the box and keeps a time-like prompt ending intact", () => {
    expect(extractRecentPrompts([
      "  │ ❯ typed but unsent text                                                 │",
      "  ╰──────────────────────────────────────────── Grok Build · always-approve ─╯",
    ])).toEqual([]);

    expect(extractRecentPrompts([
      "     ❯ remind me at 1:43 PM",
      "     ◆ Thought for 1.0s",
    ])).toEqual(["remind me at 1:43 PM"]);
  });

  // The cc/codex composer renders its empty-state placeholder, ghost/autocomplete
  // suggestion, and hint text FAINT (SGR 2) behind the same ❯/› marker a real
  // echoed prompt uses. Stripping ANSI first made them indistinguishable, so the
  // composer's non-submitted text leaked into recent-prompts. Reject faint payloads.
  describe("faint composer placeholder / ghost text rejection", () => {
    test("drops the codex empty-composer placeholder but keeps the real echoed prompt", () => {
      expect(extractRecentPrompts([
        "\x1b[1;2m› \x1b[0mReal submitted codex prompt",
        "─ Worked for 26m 55s ─",
        "\x1b[0;1m›\x1b[0m \x1b[2mSummarize recent commits\x1b[0m",
        "  gpt-5.5 xhigh · 5h 98% left · weekly 80% left · Context 29% used",
      ])).toEqual(["Real submitted codex prompt"]);
    });

    test("drops a claude ghost/autocomplete suggestion in the composer", () => {
      expect(extractRecentPrompts([
        "\x1b[39m❯ \x1b[2mghost suggestion text\x1b[0m",
        "  Opus 4.8(Max effort) · bypass permissions on",
      ])).toEqual([]);
    });

    // The case above puts the status line directly under the marker, which is the
    // shape the terminator guard was written against. Current Claude draws a rule
    // between them, and the walk stops at that rule because a box-drawing character
    // is a response terminator — so the guard reads the border instead of the
    // chrome, and the block is admitted.
    //
    // Text the user typed but has not sent is not faint, so the faint check cannot
    // help here. This is a real draft, and the only thing that distinguishes it
    // from a submitted prompt is that nothing but composer chrome sits below it.
    test("drops a typed-but-unsent draft separated from the status line by the composer border", () => {
      expect(extractRecentPrompts([
        "\x1b[39m❯ half-written thought",
        "\x1b[38;5;244m────────────────────────────────\x1b[39m",
        "  opus5·max|ctx:63%|5h-Wk 15%(4H)-96%(2D)                629719 tokens",
        "  ⏵⏵ bypass permissions on · 1 shell",
      ])).toEqual([]);
    });

    test("keeps a submitted prompt that has real output under it in the same pane", () => {
      expect(extractRecentPrompts([
        "\x1b[39m❯ actually submitted prompt",
        "● Done in 4s",
        "\x1b[39m❯ half-written thought",
        "\x1b[38;5;244m────────────────\x1b[39m",
        "  opus5·max|ctx:63%|5h-Wk 15%(4H)-96%(2D)                629719 tokens",
      ])).toEqual(["actually submitted prompt"]);
    });

    test("keeps bright 256-color prompts and does not misread color-index-2 as faint", () => {
      expect(extractRecentPrompts([
        "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231mReal bright prompt\x1b[39m",
        "✻ Baked for 3m",
        "\x1b[38;5;2m❯ \x1b[38;5;2mreal green prompt\x1b[0m",
        "● Done",
      ])).toEqual(["Real bright prompt", "real green prompt"]);
    });

    test("drops a stale plain-text composer placeholder frozen above a status line", () => {
      // Empty-composer example text can freeze into scrollback rendered plain (no
      // faint), but it still sits directly above the status line — so the block-
      // terminator guard catches it even though the faint check cannot.
      expect(extractRecentPrompts([
        "─ Worked for 2m 41s ─",
        "",
        "     › Write tests for @filename",
        "",
        "       gpt-5.5 xhigh · 5h 99% left · weekly 80% left · Context 52% used",
      ])).toEqual([]);
    });

    test("private CSI before the marker does not defeat faint-ghost rejection (A2-8)", () => {
      // ESC[?25l is a private-mode CSI (hide cursor). Skipping only ESC+[ leaves
      // "?25l" as fake text and returns isFaint=false for a faint ghost payload.
      const ghost = "\x1b[?25l❯ \x1b[2mghost suggestion\x1b[0m";
      expect(extractRecentPromptsFromPane(`${ghost}\n● real response body here\n`)).toEqual([]);
    });
  });

  test("initialScanLines: 0 does not hang the event loop (A2-5)", () => {
    // Sync infinite loop would freeze bun test itself — probe in a subprocess
    // with a hard timeout so a regression fails as exit 124, not a stuck suite.
    const script = [
      'import { extractRecentPrompts } from "./core/src/prompt-scan.ts";',
      'const r = extractRecentPrompts(',
      '  ["❯ one xx","r","❯ two yy","m"],',
      '  { targetCount: 1, initialScanLines: 0, maxScanLines: 2 },',
      ");",
      "console.log(JSON.stringify(r));",
    ].join("");
    const proc = Bun.spawnSync({
      cmd: ["timeout", "1", "bun", "-e", script],
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(124);
    expect(proc.exitCode).toBe(0);
    const out = new TextDecoder().decode(proc.stdout).trim();
    // With initial 0, progressive deepen must still reach the recent prompt.
    expect(JSON.parse(out)).toEqual(["two yy m"]);
  });

  test("progressive deepen uses post-dedupe count so repeats do not underfill (A2-6)", () => {
    const lines = [
      "❯ older unique xx",
      "● response to older",
      "❯ repeat ok here",
      "● response A",
      "❯ repeat ok here",
      "● response B",
    ];
    // Initial window of 4 lines sees two raw "repeat ok here" matches; stopping
    // on pre-dedupe count freezes at one unique entry and never deepens to
    // "older unique xx" even though maxScanLines still has room.
    expect(
      extractRecentPrompts(lines, {
        targetCount: 2,
        initialScanLines: 4,
        maxScanLines: 6,
      }),
    ).toEqual(["older unique xx", "repeat ok here"]);
  });

  test("targetCount: 0 returns no prompts from either API (A2-7)", () => {
    const lines = [
      "❯ aaa one",
      "● r1",
      "❯ bbb two",
      "● r2",
      "❯ ccc three",
      "● r3",
    ];
    expect(extractRecentPrompts(lines, { targetCount: 0 })).toEqual([]);
    expect(extractRecentPromptsFromPane(lines.join("\n"), 0)).toEqual([]);
  });

  test("a payload that used to sit on the 500-unit cut is kept exact, including the emoji", () => {
    // 496 ASCII + emoji (2 UTF-16 units) + "tail" used to be sliced mid-emoji
    // and then padded with "...". Recall must send the original payload.
    const long = `${"a".repeat(496)}😀tail`;
    const prompts = extractRecentPromptsFromPane(`❯ ${long}\n● response body here enough\n`);
    expect(prompts).toEqual([long]);
    const text = prompts[0]!;
    expect(text.endsWith("...")).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  });
});
