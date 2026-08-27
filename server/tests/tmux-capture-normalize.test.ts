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
  });

  test('resets promotion state at each captured row', () => {
    expect(normalizeTmuxCaptureCells('A❤️ \n B\nC⚠️ D')).toBe('A❤️\n B\nC⚠️D');
  });
});
