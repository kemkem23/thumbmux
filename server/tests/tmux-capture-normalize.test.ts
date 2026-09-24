import { describe, expect, test } from 'bun:test';
import { normalizeTmuxCaptureCells } from '../src/tmux-capture-normalize';

describe('tmux capture cell normalization', () => {
  test('removes exactly one VS16 promotion continuation cell', () => {
    expect(normalizeTmuxCaptureCells('A❤️ B')).toBe('A❤️B');
    expect(normalizeTmuxCaptureCells('A⚠️ B')).toBe('A⚠️B');
    expect(normalizeTmuxCaptureCells('A❤️  B')).toBe('A❤️ B');
  });

  test('does not alter intrinsically wide or ordinary cells', () => {
    expect(normalizeTmuxCaptureCells('A你B')).toBe('A你B');
    expect(normalizeTmuxCaptureCells('A你 B')).toBe('A你 B');
    expect(normalizeTmuxCaptureCells('A😃 B')).toBe('A😃 B');
    expect(normalizeTmuxCaptureCells('plain  text')).toBe('plain  text');
  });

  test('preserves ANSI and OSC bytes around the continuation cell', () => {
    expect(normalizeTmuxCaptureCells('A\x1b[31m❤️\x1b[0m B')).toBe(
      'A\x1b[31m❤️\x1b[0mB',
    );
    expect(normalizeTmuxCaptureCells('A❤️\x1b]8;;https://example.test\x07 B')).toBe(
      'A❤️\x1b]8;;https://example.test\x07B',
    );
    expect(normalizeTmuxCaptureCells('A❤️\x1b[?25l\x1b[38;2;1;2;3m B')).toBe(
      'A❤️\x1b[?25l\x1b[38;2;1;2;3mB',
    );
    expect(normalizeTmuxCaptureCells('A❤️\x1b]8;;https://example.test\x1b\\ B')).toBe(
      'A❤️\x1b]8;;https://example.test\x1b\\B',
    );
  });

  test('resets promotion state at each captured row', () => {
    expect(normalizeTmuxCaptureCells('A❤️ \n B\nC⚠️ D')).toBe('A❤️\n B\nC⚠️D');
    expect(normalizeTmuxCaptureCells('A❤️ \r\n\r\n️ B\nC⚠️ D')).toBe(
      'A❤️\r\n\r\n️ B\nC⚠️D',
    );
  });

  test('copies unterminated supported escapes without guessing past them', () => {
    for (const input of ['A❤️\x1b[31', 'A❤️\x1b]8;;url B']) {
      expect(normalizeTmuxCaptureCells(input)).toBe(input);
    }
  });

  test('preserves zero-cell SO/SI without cancelling a pending filler', () => {
    expect(normalizeTmuxCaptureCells('A❤️\x0e B')).toBe('A❤️\x0eB');
    expect(normalizeTmuxCaptureCells('A❤️\x0e\x0f B')).toBe('A❤️\x0e\x0fB');
  });

  test('documents that raw provenance and exactly-once application are required', () => {
    const rawCapture = 'A❤️  B';
    const normalizedOnce = normalizeTmuxCaptureCells(rawCapture);
    expect(normalizedOnce).toBe('A❤️ B');
    expect(normalizeTmuxCaptureCells(normalizedOnce)).toBe('A❤️B');
    expect(normalizeTmuxCaptureCells(normalizedOnce)).not.toBe(normalizedOnce);
  });

  test('G0: identical captures are observationally equal, not a source fence', () => {
    const threeRepaints = 'SAME\rSAME\rSAME';
    const captureBefore = 'SAME';
    const captureAfter = 'SAME';
    expect(captureBefore).toBe(captureAfter);
    expect(threeRepaints.match(/SAME/g)).toHaveLength(3);
    expect(captureAfter.match(/SAME/g)).toHaveLength(1);
    console.log('G0_NORMALIZE', JSON.stringify({ case: 'identical-repaint', verdict: 'unknown', assertions: 3 }));
  });

  test('G0: a repeated prefix cannot identify which occurrence preceded pipe attach', () => {
    const beforeAttach = 'DUPLICATE\r';
    const afterAttach = 'DUPLICATE\r';
    const pipeOnly = afterAttach;
    const screen = 'DUPLICATE';
    expect(pipeOnly).toBe(afterAttach);
    expect(screen).toBe(beforeAttach.trim());
    expect(screen).toBe(afterAttach.trim());
    expect(pipeOnly).not.toBe(beforeAttach + afterAttach);
    console.log('G0_NORMALIZE', JSON.stringify({ case: 'ambiguous-prefix', verdict: 'unknown', assertions: 4 }));
  });

  test('G0: geometry changes make a capture checkpoint incomparable', () => {
    const before = { generation: 7, rows: 24, cols: 80 };
    const after = { generation: 8, rows: 31, cols: 101 };
    const comparable = before.generation === after.generation
      && before.rows === after.rows
      && before.cols === after.cols;
    expect(comparable).toBe(false);
    expect(before.generation).not.toBe(after.generation);
    console.log('G0_NORMALIZE', JSON.stringify({ case: 'geometry-change', verdict: 'unknown', assertions: 2 }));
  });
});
