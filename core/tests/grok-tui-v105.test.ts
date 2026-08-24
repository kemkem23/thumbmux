import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  extractRecentPrompts,
  extractRecentPromptsFromPane,
  isGrokStatusLine,
} from "../src/prompt-scan";

/**
 * Grok Build TUI v1.0.x (Grok 4.6, measured 2026-08-21) no longer echoes
 * submitted prompts at indent ~5 with a trailing clock, and no longer wraps
 * the composer in a box. The live chrome is:
 *
 *   ❯ <submitted text>
 *   ┃◆ Thought for N.Ns
 *   ...
 *   ❯
 *   Grok 4.6 (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript
 *
 * The June 2026 boxed fixtures in prompt-scan.test.ts stay as the legacy rail.
 * This file is the v1.0.5 rail — one row per case, 100 cases, both scan APIs.
 */

type Case = {
  id: string;
  title: string;
  pane: string;
  expected: string[];
};

function grokStatus(opts: {
  model?: string;
  effort?: string;
  approve?: string;
  used?: string;
  max?: string;
  pct?: string;
  queued?: number;
  ansi?: boolean;
} = {}): string {
  const model = opts.model ?? "Grok 4.6";
  const effort = opts.effort ?? "high";
  const approve = opts.approve ?? "always-approve";
  const used = opts.used ?? "86K";
  const max = opts.max ?? "500K";
  const pct = opts.pct ?? "17%";
  const queued = opts.queued;
  const queueBit = queued == null ? "" : ` · ${queued} queued · /queue`;
  const plain = `${model} (${effort}) · ${approve} · ${used} / ${max} (${pct})${queueBit} · ctrl+o transcript`;
  if (!opts.ansi) return plain;
  return `${model} (${effort})\x1b[2m · \x1b[0m\x1b[38;5;3m${approve}\x1b[2m\x1b[39m · \x1b[0m${used} / ${max} (${pct})\x1b[2m · \x1b[0m${
    queued == null ? "" : `${queued} queued\x1b[2m · \x1b[0m/queue\x1b[2m · \x1b[0m`
  }ctrl+o transcript`;
}

function echo(text: string): string {
  return `❯ ${text}`;
}

function thought(seconds = "4.8s"): string {
  return `┃◆ Thought for ${seconds}`;
}

function pane(rows: string[]): string {
  return rows.join("\n");
}

function submitted(text: string, extra: string[] = []): string[] {
  return [echo(text), thought(), ...extra, "GROK_REPLY", "Turn completed in 4.1s."];
}

const SYNTHETIC_QUERY =
  "thumbmux's recent prompt display engine should preserve submitted prompts while excluding changing status chrome";

const CASES: Case[] = [
  // ── A. empty composer + status chrome must never become a prompt (1–20)
  { id: "A01", title: "empty composer + status → []", pane: pane(["❯", grokStatus()]), expected: [] },
  { id: "A02", title: "ANSI status under empty composer", pane: pane(["❯", grokStatus({ ansi: true })]), expected: [] },
  { id: "A03", title: "queued status under empty composer", pane: pane(["❯", grokStatus({ queued: 23, used: "209K", pct: "42%" })]), expected: [] },
  { id: "A04", title: "1 queued variant", pane: pane(["❯", grokStatus({ queued: 1, used: "157K", pct: "32%" })]), expected: [] },
  { id: "A05", title: "xhigh effort status", pane: pane(["❯", grokStatus({ effort: "xhigh" })]), expected: [] },
  { id: "A06", title: "low effort status", pane: pane(["❯", grokStatus({ effort: "low" })]), expected: [] },
  { id: "A07", title: "medium effort status", pane: pane(["❯", grokStatus({ effort: "medium" })]), expected: [] },
  { id: "A08", title: "Grok 4.5 status", pane: pane(["❯", grokStatus({ model: "Grok 4.5", effort: "high" })]), expected: [] },
  { id: "A09", title: "Grok 4.7 future status", pane: pane(["❯", grokStatus({ model: "Grok 4.7" })]), expected: [] },
  { id: "A10", title: "fractional token 7.5K", pane: pane(["❯", grokStatus({ used: "7.5K", pct: "1%" })]), expected: [] },
  { id: "A11", title: "megatoken 1.2M / 2M", pane: pane(["❯", grokStatus({ used: "1.2M", max: "2M", pct: "60%" })]), expected: [] },
  { id: "A12", title: "0% tokens", pane: pane(["❯", grokStatus({ used: "500", pct: "0%" })]), expected: [] },
  { id: "A13", title: "100% tokens", pane: pane(["❯", grokStatus({ used: "500K", pct: "100%" })]), expected: [] },
  { id: "A14", title: "default permission wording still chrome", pane: pane(["❯", "Grok 4.6 (high) · default · 12K / 500K (2%) · ctrl+o transcript"]), expected: [] },
  { id: "A15", title: "status with leading spaces", pane: pane(["❯", `  ${grokStatus()}`]), expected: [] },
  { id: "A16", title: "blank lines between empty composer and status", pane: pane(["❯", "", "", grokStatus()]), expected: [] },
  { id: "A17", title: "nbsp after marker", pane: pane(["❯\u00a0", grokStatus()]), expected: [] },
  { id: "A18", title: "spaces-only payload", pane: pane(["❯    ", grokStatus()]), expected: [] },
  { id: "A19", title: "two different status snapshots are not two prompts", pane: pane(["❯", grokStatus({ used: "7.5K", pct: "1%" }), "❯", grokStatus({ used: "107K", pct: "21%" })]), expected: [] },
  { id: "A20", title: "status alone with no composer", pane: pane([grokStatus()]), expected: [] },

  // ── B. submitted prompts must survive (21–40)
  { id: "B01", title: "short english submitted", pane: pane([...submitted("fix the scanner"), "❯", grokStatus()]), expected: ["fix the scanner"] },
  { id: "B02", title: "synthetic user query", pane: pane([...submitted(SYNTHETIC_QUERY), "❯", grokStatus()]), expected: [SYNTHETIC_QUERY] },
  { id: "B03", title: "thai submitted", pane: pane([...submitted("แก้ให้ recent prompt แสดงถูกต้อง"), "❯", grokStatus()]), expected: ["แก้ให้ recent prompt แสดงถูกต้อง"] },
  { id: "B04", title: "mixed thai+english", pane: pane([...submitted("ใช้ skill exec ยิง grok 10 ตัวไปช่วยกันวิเคราะห์ได้นะ"), "❯", grokStatus()]), expected: ["ใช้ skill exec ยิง grok 10 ตัวไปช่วยกันวิเคราะห์ได้นะ"] },
  { id: "B05", title: "emoji in prompt", pane: pane([...submitted("ship it 🚀 then deploy"), "❯", grokStatus()]), expected: ["ship it 🚀 then deploy"] },
  { id: "B06", title: "url in prompt", pane: pane([...submitted("open https://terminal.example.test/m/t/grok-1"), "❯", grokStatus()]), expected: ["open https://terminal.example.test/m/t/grok-1"] },
  { id: "B07", title: "two submitted keep recency", pane: pane([
    ...submitted("first task here"),
    ...submitted("second task here"),
    "❯", grokStatus(),
  ]), expected: ["first task here", "second task here"] },
  { id: "B08", title: "five submitted keep last five", pane: pane([
    ...submitted("alpha one xx"),
    ...submitted("bravo two yy"),
    ...submitted("charlie three zz"),
    ...submitted("delta four ww"),
    ...submitted("echo five vv"),
    "❯", grokStatus(),
  ]), expected: ["alpha one xx", "bravo two yy", "charlie three zz", "delta four ww", "echo five vv"] },
  { id: "B09", title: "duplicate echoes keep one", pane: pane([
    ...submitted("repeat ok here"),
    ...submitted("repeat ok here"),
    "❯", grokStatus(),
  ]), expected: ["repeat ok here"] },
  { id: "B10", title: "thought marker terminates so reply is not glued", pane: pane([
    echo("keep me only"),
    thought("1.0s"),
    "     GROK_SMOKE_OK",
    "❯", grokStatus(),
  ]), expected: ["keep me only"] },
  { id: "B11", title: "stream bar terminates", pane: pane([
    echo("streamed answer prompt"),
    "┃Looking at the engine",
    "❯", grokStatus(),
  ]), expected: ["streamed answer prompt"] },
  { id: "B12", title: "braille spinner terminates", pane: pane([
    echo("spinner prompt xx"),
    "⠋ Working…",
    "❯", grokStatus(),
  ]), expected: ["spinner prompt xx"] },
  { id: "B13", title: "Turn completed terminates", pane: pane([
    echo("turn done prompt"),
    "Turn completed in 4.1s.",
    "❯", grokStatus(),
  ]), expected: ["turn done prompt"] },
  { id: "B14", title: "welcome box is not a prompt", pane: pane([
    "╭──────────────────────────────────────────────╮",
    "│ Grok Build  v1.0.5                           │",
    "│ Model · Grok 4.6                             │",
    "│ /help for commands                           │",
    "╰──────────────────────────────────────────────╯",
    "❯", grokStatus(),
  ]), expected: [] },
  { id: "B15", title: "prompt that mentions Grok 4.6 as text stays a prompt", pane: pane([
    ...submitted("Grok 4.6 is the model on this pane"),
    "❯", grokStatus(),
  ]), expected: ["Grok 4.6 is the model on this pane"] },
  { id: "B16", title: "time-like ending without double space is kept", pane: pane([
    ...submitted("remind me at 1:43 PM"),
    "❯", grokStatus(),
  ]), expected: ["remind me at 1:43 PM"] },
  { id: "B17", title: "3-char minimum kept", pane: pane([...submitted("yes"), "❯", grokStatus()]), expected: ["yes"] },
  { id: "B18", title: "2-char dropped", pane: pane([...submitted("no"), "❯", grokStatus()]), expected: [] },
  { id: "B19", title: "slash command dropped", pane: pane([...submitted("/help"), "❯", grokStatus()]), expected: [] },
  { id: "B20", title: "exec-status system prompt still extracted (it was submitted)", pane: pane([
    ...submitted("[from:cortex exec-status/v1 id=01M0GZ1XGXCE4XSC6MEXDCV7M0] งาน exec ที่เรียกไว้จบแล้ว: สำเร็จ กรุณาทำงานต่อ"),
    "❯", grokStatus(),
  ]), expected: ["[from:cortex exec-status/v1 id=01M0GZ1XGXCE4XSC6MEXDCV7M0] งาน exec ที่เรียกไว้จบแล้ว: สำเร็จ กรุณาทำงานต่อ"] },

  // ── C. typed-but-unsent drafts (41–55)
  { id: "C01", title: "unsent english draft above status", pane: pane(["❯ please fix the scanner", grokStatus()]), expected: [] },
  { id: "C02", title: "unsent thai draft", pane: pane(["❯ แก้ให้แสดงถูกต้อง", grokStatus()]), expected: [] },
  { id: "C03", title: "unsent draft + ANSI status", pane: pane(["❯ half-written thought", grokStatus({ ansi: true })]), expected: [] },
  { id: "C04", title: "older submitted + unsent draft", pane: pane([
    ...submitted("already sent prompt"),
    "❯ typing but not sent yet",
    grokStatus(),
  ]), expected: ["already sent prompt"] },
  { id: "C05", title: "draft separated by blanks from status", pane: pane(["❯ still a draft here", "", "", grokStatus()]), expected: [] },
  { id: "C06", title: "draft then box-drawing then status", pane: pane([
    "❯ still a draft here",
    "────────────────────────────────",
    grokStatus(),
  ]), expected: [] },
  { id: "C07", title: "legacy boxed composer still ignored", pane: pane([
    "  │ ❯ typed but unsent text                                                 │",
    "  ╰──────────────────────────────────────────── Grok Build · always-approve ─╯",
  ]), expected: [] },
  { id: "C08", title: "legacy indent-5 echo still extracted", pane: pane([
    "     ❯ Reply with exactly GROK_SMOKE_OK and nothing else.            1:43 PM",
    "     ◆ Thought for 1.0s",
    "     GROK_SMOKE_OK                                                   1:43 PM",
    "  ╭──────────────────────────────────────────────────────────────────────────╮",
    "  │ ❯                                                                        │",
    "  ╰──────────────────────────────────────────── Grok Build · always-approve ─╯",
  ]), expected: ["Reply with exactly GROK_SMOKE_OK and nothing else."] },
  { id: "C09", title: "legacy clock stripped, time-like prompt kept", pane: pane([
    "     ❯ remind me at 1:43 PM",
    "     ◆ Thought for 1.0s",
  ]), expected: ["remind me at 1:43 PM"] },
  { id: "C10", title: "legacy multi-line thai", pane: pane([
    "     ❯ สวัสดีครับ ช่วยเขียนกลอนสั้นๆ ภาษาไทย 4 บรรทัดเกี่ยวกับ terminal สีดำ     1:44 PM",
    "       แล้วอธิบายความหมายสั้นๆ หนึ่งประโยค",
    "  ❙  ◆ Thought for 16.2s",
  ]), expected: [
    "สวัสดีครับ ช่วยเขียนกลอนสั้นๆ ภาษาไทย 4 บรรทัดเกี่ยวกับ terminal สีดำ แล้วอธิบายความหมายสั้นๆ หนึ่งประโยค",
  ] },
  { id: "C11", title: "unsent draft with queued chrome", pane: pane(["❯ draft against queue chrome", grokStatus({ queued: 3 })]), expected: [] },
  { id: "C12", title: "unsent draft mentioning always-approve still dropped", pane: pane(["❯ enable always-approve on grok", grokStatus()]), expected: [] },
  { id: "C13", title: "faint grok ghost if ever rendered", pane: pane([
    "❯ \x1b[2mghost suggestion text\x1b[0m",
    grokStatus(),
  ]), expected: [] },
  { id: "C14", title: "submitted then faint ghost", pane: pane([
    ...submitted("real sent prompt"),
    "❯ \x1b[2mghost suggestion text\x1b[0m",
    grokStatus(),
  ]), expected: ["real sent prompt"] },
  { id: "C15", title: "empty composer between two status snapshots", pane: pane([
    grokStatus({ used: "10K", pct: "2%" }),
    "❯",
    grokStatus({ used: "20K", pct: "4%" }),
  ]), expected: [] },

  // ── D. wrapping, unicode, length (56–75)
  { id: "D01", title: "wrapped continuation joins with space", pane: pane([
    echo("hello there this is a long prompt that"),
    "wraps onto the next row of the pane",
    thought(),
    "❯", grokStatus(),
  ]), expected: ["hello there this is a long prompt that wraps onto the next row of the pane"] },
  { id: "D02", title: "499-unit payload exact", pane: pane([...submitted("a".repeat(499)), "❯", grokStatus()]), expected: ["a".repeat(499)] },
  { id: "D03", title: "500-unit payload exact", pane: pane([...submitted("b".repeat(500)), "❯", grokStatus()]), expected: ["b".repeat(500)] },
  { id: "D04", title: "501-unit payload exact no ellipsis", pane: pane([...submitted("c".repeat(501)), "❯", grokStatus()]), expected: ["c".repeat(501)] },
  { id: "D05", title: "4096-unit payload exact", pane: pane([...submitted("de".repeat(2048)), "❯", grokStatus()]), expected: ["de".repeat(2048)] },
  { id: "D06", title: "emoji on old 500-unit cut", pane: pane([...submitted(`${"a".repeat(496)}😀tail`), "❯", grokStatus()]), expected: [`${"a".repeat(496)}😀tail`] },
  { id: "D07", title: "thai stacking marks", pane: pane([...submitted("ก้ำปั่นฐญ"), "❯", grokStatus()]), expected: ["ก้ำปั่นฐญ"] },
  { id: "D08", title: "ZWJ family emoji", pane: pane([...submitted("ครอบครัว👨‍👩‍👧และธง🇹🇭จบ"), "❯", grokStatus()]), expected: ["ครอบครัว👨‍👩‍👧และธง🇹🇭จบ"] },
  { id: "D09", title: "combining acute", pane: pane([...submitted("e\u0301e\u0301 cafe\u0301"), "❯", grokStatus()]), expected: ["e\u0301e\u0301 cafe\u0301"] },
  { id: "D10", title: "intentional ... ending is kept", pane: pane([...submitted("wait for it..."), "❯", grokStatus()]), expected: ["wait for it..."] },
  { id: "D11", title: "newline in pane becomes space", pane: pane([
    echo("line one"),
    "line two",
    thought(),
    "❯", grokStatus(),
  ]), expected: ["line one line two"] },
  { id: "D12", title: "nbsp in payload normalized", pane: pane([...submitted("hello\u00a0world ok"), "❯", grokStatus()]), expected: ["hello world ok"] },
  { id: "D13", title: "leading indent 0 grok echo", pane: pane([...submitted("indent zero echo"), "❯", grokStatus()]), expected: ["indent zero echo"] },
  { id: "D14", title: "indent 2 still a prompt", pane: pane(["  ❯ indented two spaces", thought(), "❯", grokStatus()]), expected: ["indented two spaces"] },
  { id: "D15", title: "indent 5 legacy still a prompt", pane: pane(["     ❯ grok indent five xx", thought()]), expected: ["grok indent five xx"] },
  { id: "D16", title: "indent 7 rejected", pane: pane(["       ❯ too far indented xx", thought()]), expected: [] },
  { id: "D17", title: "codex › marker still works beside grok chrome", pane: pane([
    "› codex style prompt xx",
    "• Explored",
    "❯", grokStatus(),
  ]), expected: ["codex style prompt xx"] },
  { id: "D18", title: "claude ❯ beside grok chrome", pane: pane([
    "❯ claude style prompt xx",
    "✻ Baked for 3m",
    "❯", grokStatus(),
  ]), expected: ["claude style prompt xx"] },
  { id: "D19", title: "blank pane", pane: "", expected: [] },
  { id: "D20", title: "only newlines", pane: "\n\n\n", expected: [] },

  // ── E. isGrokStatusLine itself + mixed agents (76–90)
  { id: "E01", title: "user prompt that is only 'Grok 4.6' is too short? kept if >=3 with response", pane: pane([
    echo("Grok 4.6"),
    thought(),
    "❯", grokStatus(),
  ]), expected: ["Grok 4.6"] },
  { id: "E02", title: "response line starting with Grok is not a prompt", pane: pane([
    ...submitted("ask about grok"),
    "Grok is a model from xAI",
    "❯", grokStatus(),
  ]), expected: ["ask about grok"] },
  { id: "E03", title: "ctrl+o transcript without Grok prefix is not chrome-as-prompt", pane: pane(["ctrl+o transcript", "❯", grokStatus()]), expected: [] },
  { id: "E04", title: "always-approve alone is not a prompt", pane: pane(["always-approve", "❯", grokStatus()]), expected: [] },
  { id: "E05", title: "queued line without Grok prefix", pane: pane(["23 queued · /queue", "❯", grokStatus()]), expected: [] },
  { id: "E06", title: "claude status still drops drafts", pane: pane([
    "❯ half-written thought",
    "────────────────────────────────",
    "  opus5·max|ctx:63%|5h-Wk 15%(4H)-96%(2D)                629719 tokens",
  ]), expected: [] },
  { id: "E07", title: "codex status still drops drafts", pane: pane([
    "     › Write tests for @filename",
    "       gpt-5.5 xhigh · 5h 99% left · weekly 80% left · Context 52% used",
  ]), expected: [] },
  { id: "E08", title: "targetCount 1 returns newest grok prompt", pane: pane([
    ...submitted("older unique xx"),
    ...submitted("newer unique yy"),
    "❯", grokStatus(),
  ]), expected: ["older unique xx", "newer unique yy"] },
  { id: "E09", title: "spinner then empty composer", pane: pane([
    ...submitted("before spinner"),
    "⠸ Thinking… 4.4s",
    "❯", grokStatus(),
  ]), expected: ["before spinner"] },
  { id: "E10", title: "todo checkbox rows are not prompts", pane: pane([
    "▶ อ่าน exec skill",
    "□ วิเคราะห์บัก",
    "❯", grokStatus(),
  ]), expected: [] },
  { id: "E11", title: "tool call rows starting with ◆ are terminators", pane: pane([
    echo("run the scan"),
    "◆ Read prompt-scan.ts",
    "❯", grokStatus(),
  ]), expected: ["run the scan"] },
  { id: "E12", title: "shell launch banner is not a prompt", pane: pane([
    "dev@example-host:~/workspace/project$ systemd-run --user grok",
    "Signing in… starting your session.",
    "❯", grokStatus(),
  ]), expected: [] },
  { id: "E13", title: "percent-only table is not a prompt", pane: pane([
    "         22.5% |  1101 |   153",
    "❯", grokStatus(),
  ]), expected: [] },
  { id: "E14", title: "status with both /queue and ctrl+o", pane: pane(["❯", grokStatus({ queued: 11, used: "176K", pct: "35%" })]), expected: [] },
  { id: "E15", title: "model line inside welcome is not a prompt", pane: pane(["│ Model · Grok 4.6                                                             │", "❯", grokStatus()]), expected: [] },

  // ── F. recency / API-shaped order / both extractors (91–100)
  { id: "F01", title: "oldest to newest order", pane: pane([
    ...submitted("aaa one xx"),
    ...submitted("bbb two yy"),
    ...submitted("ccc three zz"),
    "❯", grokStatus(),
  ]), expected: ["aaa one xx", "bbb two yy", "ccc three zz"] },
  { id: "F02", title: "more than five keeps last five", pane: pane([
    ...submitted("p1 one xxx"),
    ...submitted("p2 two xxx"),
    ...submitted("p3 three xxx"),
    ...submitted("p4 four xxx"),
    ...submitted("p5 five xxx"),
    ...submitted("p6 six xxx"),
    "❯", grokStatus(),
  ]), expected: ["p2 two xxx", "p3 three xxx", "p4 four xxx", "p5 five xxx", "p6 six xxx"] },
  { id: "F03", title: "status must not occupy one of the five slots", pane: pane([
    ...submitted("keep-a xxx"),
    ...submitted("keep-b xxx"),
    ...submitted("keep-c xxx"),
    ...submitted("keep-d xxx"),
    ...submitted("keep-e xxx"),
    "❯", grokStatus({ used: "99K", pct: "19%" }),
  ]), expected: ["keep-a xxx", "keep-b xxx", "keep-c xxx", "keep-d xxx", "keep-e xxx"] },
  { id: "F04", title: "changing token count does not create a new prompt", pane: pane([
    ...submitted("only real prompt"),
    "❯", grokStatus({ used: "10K", pct: "2%" }),
    "❯", grokStatus({ used: "80K", pct: "16%" }),
  ]), expected: ["only real prompt"] },
  { id: "F05", title: "private CSI before marker still drops faint ghost", pane: pane([
    "\x1b[?25l❯ \x1b[2mghost suggestion\x1b[0m",
    grokStatus(),
  ]), expected: [] },
  { id: "F06", title: "bright 256-color grok echo kept", pane: pane([
    "\x1b[38;5;231m❯ bright grok prompt\x1b[39m",
    thought(),
    "❯", grokStatus(),
  ]), expected: ["bright grok prompt"] },
  { id: "F07", title: "color-index-2 is not faint", pane: pane([
    "\x1b[38;5;2m❯ green but real prompt\x1b[0m",
    thought(),
    "❯", grokStatus(),
  ]), expected: ["green but real prompt"] },
  { id: "F08", title: "empty firstLine does not swallow a following real echo", pane: pane([
    "❯",
    echo("later real prompt"),
    thought(),
    "❯", grokStatus(),
  ]), expected: ["later real prompt"] },
  { id: "F09", title: "trailing clock on indent-0 grok is stripped when present", pane: pane([
    "❯ indent0 with clock xx            1:43 PM",
    thought(),
    "❯", grokStatus(),
  ]), expected: ["indent0 with clock xx"] },
  { id: "F10", title: "live mixed: query kept, status dropped", pane: pane([
    echo(SYNTHETIC_QUERY),
    thought("4.8s"),
    "┃Looking at SessionView",
    "❯", grokStatus({ ansi: true, used: "86K", pct: "17%" }),
  ]), expected: [SYNTHETIC_QUERY] },
];

describe("isGrokStatusLine", () => {
  test("wrapped chrome without the model prefix still drops an unsent draft", () => {
    expect(extractRecentPromptsFromPane([
      "❯ please fix the scanner",
      "always-approve · 86K / 500K (17%) · ctrl+o transcript",
    ].join("\n"))).toEqual([]);
  });

  test("Grok Code Fast, hyphenated 4.6, SuperGrok, and 1 queued still drop drafts", () => {
    const drafts = [
      "Grok Code Fast (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript",
      "Grok-4.6 (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript",
      "SuperGrok Heavy (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript",
      "Grok 4.6 (high) · 1 queued",
      "Grok 4.6 (high) · 86k / 500k (17%)",
    ];
    for (const status of drafts) {
      expect({ status, prompts: extractRecentPromptsFromPane(`❯ unsent draft xx\n${status}`) }).toEqual({
        status,
        prompts: [],
      });
    }
  });

  test("a submitted prompt that mentions Grok Code Fast is kept when thought follows", () => {
    expect(extractRecentPromptsFromPane([
      "❯ Grok Code Fast is the model on this pane",
      "┃◆ Thought for 1.0s",
      "❯",
      grokStatus(),
    ].join("\n"))).toEqual(["Grok Code Fast is the model on this pane"]);
  });

  test("accepts the measured live chrome and rejects ordinary sentences", () => {
    expect(isGrokStatusLine(grokStatus())).toBe(true);
    expect(isGrokStatusLine(grokStatus({ queued: 23, used: "209K", pct: "42%" }))).toBe(true);
    expect(isGrokStatusLine("Grok 4.6 is the model on this pane")).toBe(false);
    expect(isGrokStatusLine("always-approve please")).toBe(false);
    expect(isGrokStatusLine("86K / 500K (17%)")).toBe(false);
    expect(isGrokStatusLine("always-approve · 86K / 500K (17%) · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("Grok 4.6 · always-approve · 86K / 500K (17%) · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("Grok-4.6 (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("Grok Code Fast (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("SuperGrok Heavy (high) · always-approve · 86K / 500K (17%) · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("Grok 4.6 (high) · 86k / 500k (17%)")).toBe(true);
    expect(isGrokStatusLine("Grok 4.6 (high) · 23 queued · /queue · ctrl+o transcript")).toBe(true);
    expect(isGrokStatusLine("Grok 4.6 (high) · 1 queued")).toBe(true);
  });
});

describe("Grok Build TUI v1.0.5 — 100 pane cases through both scan APIs", () => {
  test("case table has 100 unique ids", () => {
    expect(CASES).toHaveLength(100);
    expect(new Set(CASES.map((row) => row.id)).size).toBe(100);
  });

  test.each(CASES.map((row) => [row.id, row.title, row] as const))("%s — %s", (_id, _title, row) => {
    const fromPane = extractRecentPromptsFromPane(row.pane, 5);
    const fromLines = extractRecentPrompts(row.pane.split("\n"));
    expect({ id: row.id, fromPane, fromLines }).toEqual({
      id: row.id,
      fromPane: row.expected,
      fromLines: row.expected,
    });
    expect(fromPane.some((text) => isGrokStatusLine(text))).toBe(false);
    expect(fromPane.some((text) => text.endsWith("...") && !row.expected.some((want) => want.endsWith("...")))).toBe(false);
  });
});

describe("synthetic Grok 4.6 pane with the measured v1.0.5 shape", () => {
  test("keeps the submitted user query and drops every status snapshot", async () => {
    const content = await readFile(
      join(import.meta.dir, "fixtures/panes/grok-tui-v105-live.txt"),
      "utf8",
    );
    const prompts = extractRecentPromptsFromPane(content, 5);
    expect(prompts.some((text) => isGrokStatusLine(text))).toBe(false);
    expect(prompts.some((text) => /always-approve|ctrl\+o transcript/i.test(text))).toBe(false);
    expect(prompts.some((text) => /recent prompt display engine/i.test(text))).toBe(true);
  });
});
