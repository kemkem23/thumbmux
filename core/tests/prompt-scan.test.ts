import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  extractRecentPrompts,
  extractRecentPromptsFromPane,
  stripAnsi,
} from "../src/prompt-scan";

const HOST_PANE_FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/panes");

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
      frozen: Object.isFrozen(core.DEFAULT_PROMPT_MATCHERS),
    }).toEqual({
      promptPayload: "function",
      isFaintPayload: "function",
      isStatusLine: "function",
      isPromptTerminator: "function",
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
  });
});
