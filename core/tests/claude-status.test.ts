import { describe, expect, test } from 'bun:test';

import {
  isClaudeActivityStatusLine,
  isStyledClaudeActivityStatusLine,
  terminalPaintSnapshot,
} from '../src/claude-status';

function paintedActivity(frame: string, verb = 'Thinking'): string {
  return `\x1b[38;5;174m${frame}\x1b[39m \x1b[38;5;174m${verb}…\x1b[39m `
    + '\x1b[38;5;246m(1m · ↓ 2k tokens · thinking with xhigh effort)\x1b[39m';
}

describe('Claude activity status grammar', () => {
  test('recognises every fully painted Claude thinking-animation frame', () => {
    for (const frame of ['·', '✻', '✽', '✶', '✳', '✢']) {
      expect(isClaudeActivityStatusLine(`${frame} Thinking… (thinking with xhigh effort)`), frame)
        .toBe(true);
      expect(isClaudeActivityStatusLine(
        `${frame} Considering… (10m 53s · ↓ 38.3k tokens · thinking with max effort)`,
      ), frame)
        .toBe(true);
      expect(isStyledClaudeActivityStatusLine(
        paintedActivity(frame),
      ), frame).toBe(true);
    }

    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m●\x1b[39m \x1b[38;5;174mSpinning…\x1b[39m '
        + '\x1b[38;5;246m(7m 9s · ↓ 38.3k tokens · thinking with max effort)\x1b[39m   ',
    )).toBe(true);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38:5:174m● \x1b[38:5:174mSprouting… \x1b[38:5:246m'
        + '(8m 2s · ↑ 1.2k tokens · thinking with max effort)\x1b[39m',
    )).toBe(true);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;246m✢\x1b[39m Thinking… '
        + '(1m · ↓ 2k tokens · thinking with xhigh effort)',
    )).toBe(true);
    expect(isClaudeActivityStatusLine(
      '* Ruminating… (1m 1s · ↓ 3.2k tokens · thought for 3s)',
    )).toBe(true);
  });

  test('recognises the live Newspapering family captured from a working Claude pane', () => {
    // Visible text from cc-kem-cortex-orchestrator-11 on 2026-09-10 (90s poll).
    // Markers rotate; the verb stays one word; the parenthetical cycles three
    // shapes. None of these names are hardcoded — the grammar is a word +
    // activity detail, not a verb allow-list.
    for (const line of [
      '· Newspapering… (17m 38s · ↓ 46.7k tokens)',
      '✽ Newspapering… (17m 29s · ↓ 46.5k tokens)',
      '✢ Newspapering… (18m 22s · ↓ 49.6k tokens)',
      '✻ Newspapering… (18m 21s · ↓ 49.5k tokens)',
      '✶ Newspapering… (18m 42s · ↓ 50.8k tokens)',
      '* Newspapering… (18m 47s · ↓ 51.1k tokens)',
      '· Newspapering… (18m 12s · ↓ 49.0k tokens · thinking with max effort)',
      '✢ Newspapering… (18m 18s · ↓ 49.0k tokens · thinking with max effort)',
      '* Newspapering… (18m 43s · ↓ 50.9k tokens · thinking with max effort)',
      '✻ Newspapering… (18m 19s · ↓ 49.1k tokens · thought for 7s)',
      '✶ Newspapering… (18m 40s · ↓ 50.6k tokens · thought for 4s)',
      '* Newspapering… (18m 45s · ↓ 51.0k tokens · thought for 2s)',
    ]) expect(isClaudeActivityStatusLine(line), line).toBe(true);

    // Exact SGR from the live pane (no personal content). Metadata may reset
    // to default on spaces; the paint checker skips whitespace.
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m\xb7\x1b[39m \x1b[38;5;174mNewspapering\u2026 '
        + '\x1b[38;5;246m(17m 38s \xb7 \u2193\x1b[39m \x1b[38;5;246m46.7k tokens)\x1b[39m',
    )).toBe(true);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m\u2736\x1b[39m \x1b[38;5;174mNewspapering\u2026 '
        + '\x1b[38;5;246m(18m\x1b[39m \x1b[38;5;246m59s\x1b[39m \x1b[38;5;246m\xb7\x1b[39m '
        + '\x1b[38;5;246m\u2193\x1b[39m \x1b[38;5;246m51.9k\x1b[39m '
        + '\x1b[38;5;246mtokens \xb7 thought for 9s)\x1b[39m',
    )).toBe(true);
  });

  test('accepts the measured 216 sparkle Claude paints across the animated verb', () => {
    // Live frames from the same pane: a three-cell 216 highlight travels
    // through Newspapering while marker 174 and metadata 246 stay put.
    // Without this, hide-mode Bash collapse drops every sparkle frame.
    const sparkleFrames = [
      '\x1b[38;5;174m\xb7\x1b[39m \x1b[38;5;174mNewspap\x1b[38;5;216meri\x1b[38;5;174mng\u2026 '
        + '\x1b[38;5;246m(18m 8s \xb7 \u2193\x1b[39m \x1b[38;5;246m47.1k tokens)\x1b[39m',
      '\x1b[38;5;174m*\x1b[39m \x1b[38;5;174mNew\x1b[38;5;216mspa\x1b[38;5;174mpering\u2026 '
        + '\x1b[38;5;246m(18m\x1b[39m \x1b[38;5;246m49s\x1b[39m \x1b[38;5;246m\xb7\x1b[39m '
        + '\x1b[38;5;246m\u2193\x1b[39m \x1b[38;5;246m51.3k\x1b[39m '
        + '\x1b[38;5;246mtokens \xb7 thinking with max effort)\x1b[39m',
      '\x1b[38;5;174m\u2722\x1b[39m \x1b[38;5;174mNewsp\x1b[38;5;216mape\x1b[38;5;174mring\u2026 '
        + '\x1b[38;5;246m(18m 29s \xb7 \u2193\x1b[39m '
        + '\x1b[38;5;246m49.8k tokens \xb7 thinking with max effort)\x1b[39m',
    ];
    for (const raw of sparkleFrames) {
      const visible = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\xa0/g, ' ').trim();
      expect(isClaudeActivityStatusLine(visible), visible).toBe(true);
      expect(isStyledClaudeActivityStatusLine(raw), visible).toBe(true);
    }

    // A foreign highlight on the verb is still not Claude chrome.
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m\xb7\x1b[39m \x1b[38;5;174mNewspap\x1b[38;5;196meri\x1b[38;5;174mng\u2026 '
        + '\x1b[38;5;246m(18m 8s \xb7 \u2193 47.1k tokens)\x1b[39m',
    )).toBe(false);
    // Sparkle colour on the metadata is not the measured layout.
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m\xb7\x1b[39m \x1b[38;5;174mNewspapering\u2026 '
        + '\x1b[38;5;216m(18m 8s \xb7 \u2193 47.1k tokens)\x1b[39m',
    )).toBe(false);
  });

  test('recognises the elapsed-only detail frames current Claude paints early in a turn', () => {
    for (const line of [
      '✢ Beaming… (3s)',
      '✻ Beaming… (12s)',
      '· Simmering… (1m 5s)',
      '✶ Percolating… (1h 2m 3s)',
      '* Beaming… (59s)',
    ]) expect(isClaudeActivityStatusLine(line), line).toBe(true);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m✢\x1b[39m \x1b[38;5;174mBeaming…\x1b[39m '
        + '\x1b[38;5;246m(3s)\x1b[39m',
    )).toBe(true);

    // Elapsed time must be the whole detail: partial matches stay shell text.
    for (const line of [
      '✢ Beaming… (3s · esc to interrupt)',
      '* Downloading… (3s remaining)',
      '✢ Beaming… (about 3s)',
      '✢ Beaming… (3)',
      '✢ Beaming… (3 s)',
      '✢ Beaming… ()',
      '⠴ Beaming… (3s)',
    ]) expect(isClaudeActivityStatusLine(line), line).toBe(false);
  });

  test('rejects status-shaped shell text, partial paints, and cross-agent spinners', () => {
    const ordinary = [
      '✢ shell spinner-shaped output',
      '✽ Reading app.log',
      '✳ Writing a report',
      '· Done for 3m',
      '✢ Thinking…',
      '✢ Thinking… (rethinking the plan)',
      '✢ Thinking… (effortless progress)',
      '✢ Thinking… (tokenizer ready)',
      '* Downloading… (↓ 12 MB/s)',
      '* Thinking…',
      'echo ✶ Thinking… (with effort)',
      '⏵⏵ bypass permissions on · 1 shell',
      'gpt-5.5 xhigh · 5h 92% · weekly 94%',
      '• Thinking (3s · esc to interrupt)',
      '◦ Working (29m 41s • esc to interrupt)',
      '⠴ Thinking… 10s',
      '◆ Thought for 16.2s',
    ];
    for (const line of ordinary) expect(isClaudeActivityStatusLine(line), line).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;246m✽\x1b[39m Reading app.log',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;246m*\x1b[39m shell spinner-shaped output',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;196m✢\x1b[39m Thinking… (thinking with xhigh effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      'prefix \x1b[38;5;174m●\x1b[39m Spinning… (thinking with max effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[48;2;38;5;174m✢ Thinking… (thinking with xhigh effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174;48;5;31;58;5;32m✢ Thinking… '
        + '\x1b[38;5;246;48;5;31;58;5;32m(thinking with xhigh effort)',
    )).toBe(true);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174m✢ Thinking… \x1b[38;5;196m(thinking with xhigh effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;246m✢ Thinking… \x1b[38;5;246m(thinking with xhigh effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174;48;5;31;7m✢ Thinking… '
        + '\x1b[38;5;246;48;5;32;7m(thinking with xhigh effort)',
    )).toBe(false);
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;174;8m✢ Thinking… '
        + '\x1b[28;38;5;246m(thinking with xhigh effort)',
    )).toBe(false);
    for (const invalid174 of ['174 ', '+174', '174.0']) {
      expect(isStyledClaudeActivityStatusLine(
        `\x1b[38;5;${invalid174}m✢ Thinking… `
          + '\x1b[38;5;246m(thinking with xhigh effort)',
      ), invalid174).toBe(false);
    }
    expect(isStyledClaudeActivityStatusLine(
      '\x1b[38;5;0174m✢ Thinking… '
        + '\x1b[38;5;0246m(thinking with xhigh effort)',
    )).toBe(true);
  });

  test('rejects paint carry after nested ESC aborts the current control sequence', () => {
    expect(terminalPaintSnapshot('\x1b[38;5;174mX\x1b[1\x1b[0m')).toBeNull();
    expect(terminalPaintSnapshot('\x1b[38;5;174mX\x1b\x1b[0m')).toBeNull();
  });
});
