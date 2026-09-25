import { describe, expect, test } from 'bun:test';
import { normalizeTmuxCaptureCells, TmuxCaptureDecoder } from '../src/tmux-capture-normalize';

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

import { decodeTmuxCaptureRows } from '../src/tmux-capture-normalize';
describe('NEWARCH L2-C observed snapshot cells', () => {
  test('preserves trailing spaces, blank color, style and default resets', () => {
    const [row] = decodeTmuxCaptureRows('\x1b[31;44;1mA  \x1b[0m \n', 4);
    expect(row).toHaveLength(4);
    expect(row![1]).toEqual({ grapheme: ' ', width: 1, continuation: false, fg: 'index:1', bg: 'index:4', style: 1 });
    expect(row![3]!.fg).toBe('default');
    expect(row![3]!.style).toBe(0);
    expect(decodeTmuxCaptureRows('A  \n\n', 3)).toHaveLength(2);
  });
  test('decodes truecolor and wide/Thai cells without Unicode normalization', () => {
    const [row] = decodeTmuxCaptureRows('\x1b[38;2;1;2;3mก้你❤️ B\n', 6);
    expect(row!.map(c => c.grapheme)).toEqual(['ก้', '你', '', '❤️', '', 'B']);
    expect(row![0]!.fg).toBe('rgb:1,2,3');
    expect(row![2]!.continuation).toBe(true);
    expect(decodeTmuxCaptureRows('e\u0301\n', 1)[0]![0]!.grapheme).toBe('e\u0301');
  });
  test('rejects unsupported escapes, invalid color, and geometry overflow', () => {
    expect(() => decodeTmuxCaptureRows('\x1b[2J', 8)).toThrow();
    expect(() => decodeTmuxCaptureRows('\x1b[38;2;300;0;0mX', 8)).toThrow();
    expect(() => decodeTmuxCaptureRows('你', 1)).toThrow();
    expect(() => decodeTmuxCaptureRows('X', 0)).toThrow();
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('FIX1 real private tmux OSC8, underline variants, overline and Thai spacing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l2c-decoder-'));
  const socket = join(root, 'x.sock');
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => {
    const r = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', env });
    expect(r.status).toBe(0); return r.stdout;
  };
  try {
    const cases = ['ไทย น้ำ ที่', '\x1b]8;;https://example.test\x1b\\LINK\x1b]8;;\x1b\\', '\x1b[4:3mCURL', '\x1b[58;2;1;2;3m\x1b[4mUNDER', '\x1b[53mOVER', '👩‍💻x', '🇹🇭x', '👍🏽x', '❤️x', '👩‍💻🇹🇭👍🏽❤️',
      // DEBT item 5: tmux 3.4 cell counts differ from Unicode for these (review2 probe-emoji).
      '\u{1f1f9}\u{1f1ed}\u{1f1fa}x', '\u{1f3f3}\ufe0f\u200d\u{1f308}x', '\u{1f9d1}\u{1f3fb}\u200d\u{1f91d}\u200d\u{1f9d1}\u{1f3ff}x', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u{1f3fd}x',
      // Same raw shape as the rainbow flag (VS16, pad, ZWJ) but tmux agrees: must still decode.
      '\u2764\ufe0f\u200d\u{1f525}x'];
    const ambiguous = new Set(['👩‍💻🇹🇭👍🏽❤️', '\u{1f1f9}\u{1f1ed}\u{1f1fa}x', '\u{1f3f3}\ufe0f\u200d\u{1f308}x', '\u{1f9d1}\u{1f3fb}\u200d\u{1f91d}\u200d\u{1f9d1}\u{1f3ff}x', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u{1f3fd}x']);
    for (let i = 0; i < cases.length; i++) {
      const path = join(root, `text-${i}`); writeFileSync(path, cases[i]!);
      const pane = tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `p${i}`, '-x', '80', '-y', '24', `cat '${path}'; sleep 5`).trim();
      await new Promise(resolve => setTimeout(resolve, 100));
      const raw = tmux('capture-pane', '-p', '-e', '-N', '-t', pane);
      const cursor = Number(tmux('display-message', '-p', '-t', pane, '#{cursor_x}').trim());
      if (ambiguous.has(cases[i]!)) {
        console.log('NEWARCH_FIX1_AMBIGUOUS', JSON.stringify({ input: cases[i], raw: raw.split('\n')[0], cursor, disposition: 'reject certification; pipe remains live' }));
        expect(() => decodeTmuxCaptureRows(raw, 80)).toThrow('ambiguous tmux emoji cell boundary');
        continue;
      }
      const row = decodeTmuxCaptureRows(raw, 80)[0]!;
      let end = row.length; while (end > 0 && row[end - 1]!.grapheme === ' ') end--;
      console.log('NEWARCH_FIX1_WIDTH', JSON.stringify({ input: cases[i], raw: raw.split('\n')[0], cursor, end }));
      expect(end).toBe(cursor);
      if (i === 0) { expect(cursor).toBe(8); expect(row.slice(0, end).map(c => c.grapheme).join('')).toBe(cases[i]!); }
      console.log('NEWARCH_FIX1_DECODER', JSON.stringify({ case: i, cursor, decodedWidth: end, raw: raw.split('\n')[0] }));
    }
  } finally {
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env });
    rmSync(root, { recursive: true, force: true });
  }
});

describe('FIX2 decoder fast paths keep the FIX1 projection', () => {
  // Expected cells were produced by the FIX1 decoder (Segmenter over every
  // run). They pin the ASCII/non-ASCII island boundary: combining marks,
  // Prepend, ZWJ and regional indicators must join the ASCII unit beside them.
  const pinned: Array<[string, Array<[string, number]>]> = [
    ['ae\u0301b', [['a', 1], ['e\u0301', 1], ['b', 1]]],
    ['\u0600ab', [['\u0600a', 2], ['', 0], ['b', 1]]],
    // A third regional indicator is refused since DEBT item 5 (tmux 3.4 draws
    // 🇹🇭🇺 in 2 cells, this projection in 4); the island boundary is pinned
    // with a pair instead.
    ['x\u{1f1f9}\u{1f1ed}y', [['x', 1], ['\u{1f1f9}\u{1f1ed}', 2], ['', 0], ['y', 1]]],
    ['a\u200db', [['a\u200d', 1], ['b', 1]]],
    ['ไทย น้ำ', [['ไ', 1], ['ท', 1], ['ย', 1], [' ', 1], ['น้', 1], ['ำ', 1]]],
    ['A❤️ B', [['A', 1], ['❤️', 2], ['', 0], ['B', 1]]],
    ['row-1 你 😀', [['r', 1], ['o', 1], ['w', 1], ['-', 1], ['1', 1], [' ', 1], ['你', 2], ['', 0], [' ', 1], ['😀', 2], ['', 0], [' ', 1]]],
    ['\u1100\u1161\u11a8z', [['\u1100\u1161\u11a8', 2], ['', 0], ['z', 1]]],
  ];
  test('island segmentation matches whole-run segmentation on boundary cases', () => {
    for (const [text, cells] of pinned) {
      const row = decodeTmuxCaptureRows(text + '\n', 12)[0]!;
      expect(row.slice(0, cells.length).map(c => [c.grapheme, c.width])).toEqual(cells);
      expect(row.slice(cells.length).every(c => c.grapheme === ' ' && c.width === 1)).toBe(true);
    }
    expect(() => decodeTmuxCaptureRows('x\u{1f1f9}\u{1f1ed}\u{1f1f9}y\n', 12)).toThrow('ambiguous tmux emoji cell boundary');
  });
  test('memo decoder equals the uncached decoder, cold and warm, and falls back on open escapes', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const atoms = ['a', ' ', '-', '9', 'ก', 'ั', '่', 'ำ', '你', '😀', '\u200d', '\ufe0f', '❤', 'e', '\u0301', '\u0600', '\u{1f1f9}', '\x1b[31m', '\x1b[0m', '\x1b[4:3m', '\x1b]8;;u\x1b\\', '\x1b[1', '\x1b'];
    const outcome = (f: () => unknown) => { try { return JSON.stringify(f()); } catch (error) { return `ERR ${(error as Error).message}`; } };
    let decoded = 0;
    for (let n = 0; n < 2000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        Array.from({ length: Math.floor(rnd() * 12) }, () => atoms[Math.floor(rnd() * atoms.length)]!).join(''));
      const raw = lines.join('\n') + '\n';
      const expected = outcome(() => decodeTmuxCaptureRows(raw, 30));
      const memo = new TmuxCaptureDecoder(30, 3);
      expect(outcome(() => memo.decode(raw))).toBe(expected);
      expect(outcome(() => memo.decode(raw))).toBe(expected);
      if (!expected.startsWith('ERR')) decoded++;
    }
    expect(decoded).toBeGreaterThan(200);
    // An SGR carried across a row boundary is part of the memo key.
    const memo = new TmuxCaptureDecoder(4);
    const plain = memo.decode('ab\n');
    const red = memo.decode('\x1b[31mx\nab\n');
    expect(plain[0]![0]!.fg).toBe('default');
    expect(red[1]![0]!.fg).toBe('index:1');
    expect(memo.decode('ab\n')[0]).toBe(plain[0]!);
    expect(memo.hits).toBe(1);
    // Cached rows share frozen cells: 9000 distinct 120-column rows over a
    // small alphabet must not hold a fresh object per cell (FIX2 cage stall).
    const wideRaw = (n: number) => Array.from({ length: n }, (_, i) => `\x1b[${31 + i % 7}mrow-${String(i).padStart(8, '0')} ไทย 你 😀\x1b[0m`).join('\n') + '\n';
    const rows = new TmuxCaptureDecoder(120).decode(wideRaw(9000));
    const objects = new Set(rows.flat());
    expect(rows.length).toBe(9000);
    expect(objects.size).toBeLessThan(200);
    expect([...objects].every(cell => Object.isFrozen(cell))).toBe(true);
    expect(JSON.stringify(rows.slice(0, 50))).toBe(JSON.stringify(decodeTmuxCaptureRows(wideRaw(50), 120)));
  });
});
