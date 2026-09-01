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
