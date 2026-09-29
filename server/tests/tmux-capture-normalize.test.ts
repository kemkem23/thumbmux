import { describe, expect, test } from 'bun:test';
import { normalizeTmuxCaptureCells, TmuxCaptureDecoder, TMUX_STYLE_BITS } from '../src/tmux-capture-normalize';

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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
        // A-M3 row isolation: the strict oracle refuses, the capture path keeps
        // the whole 24-row screen and marks only this row uncertain.
        expect(() => decodeTmuxCaptureRows(raw, 80)).toThrow('ambiguous tmux emoji cell boundary');
        const screen = decodeTmuxCaptureScreen(raw, 80);
        console.log('NEWARCH_FIX1_AMBIGUOUS', JSON.stringify({ input: cases[i], raw: raw.split('\n')[0], cursor, rows: screen.rows.length, uncertainRows: screen.uncertainRows, disposition: 'screen drawn; row uncertain, never certified' }));
        expect(screen.rows).toHaveLength(24);
        expect(screen.uncertainRows).toEqual([0]);
        expect(screen.rows.every(row => row.length === 80)).toBe(true);
        expect(screen.rows[0]![0]!.grapheme).not.toBe(' ');
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
    const isolated = decodeTmuxCaptureScreen('ok\nx\u{1f1f9}\u{1f1ed}\u{1f1f9}y\nnext\n', 12);
    expect(isolated.uncertainRows).toEqual([1]);
    expect(isolated.rows.map(row => row.length)).toEqual([12, 12, 12]);
    expect(isolated.rows[2]!.slice(0, 4).map(c => c.grapheme).join('')).toBe('next');
    // Clipped at the pane edge: a wide cell cut in half becomes a blank.
    const clipped = decodeTmuxCaptureScreen('\u{1f1f9}\u{1f1ed}\u{1f1f9}\u{1f1ed}\u{1f1f9}\n', 5).rows[0]!;
    expect(clipped).toHaveLength(5);
    expect(clipped[4]).toMatchObject({ grapheme: ' ', width: 1, continuation: false });
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
      // The memo decoder is the capture path: it isolates ambiguous rows.
      const expected = outcome(() => decodeTmuxCaptureScreen(raw, 30));
      const memo = new TmuxCaptureDecoder(30, 3);
      const viaMemo = () => ({ rows: memo.decode(raw), uncertainRows: memo.uncertainRows });
      expect(outcome(viaMemo)).toBe(expected);
      expect(outcome(viaMemo)).toBe(expected);
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

import { decodeTmuxCaptureEvidence, decodeTmuxCaptureScreen } from '../src/tmux-capture-normalize';
test('I3 uncertainty stays on the ambiguous row and preserves following ANSI state', () => {
  // A-M3: the ambiguous row keeps drawable Unicode-width cells, flagged
  // uncertain; the screen stays complete instead of refusing calibration.
  const evidence = decodeTmuxCaptureEvidence('plain\n\x1b[31m🏳️ ‍🌈x\nnext\n', 20);
  expect(evidence.complete).toBe(true);
  expect(evidence.uncertainRows).toEqual([1]);
  expect(evidence.rows).toHaveLength(3);
  expect(evidence.rows[0]!.cells![0]!.grapheme).toBe('p');
  expect(evidence.rows[0]!.certain).toBe(true);
  expect(evidence.rows[1]!.reason).toBe('ambiguous-cell-boundary');
  expect(evidence.rows[1]!.certain).toBe(false);
  expect(evidence.rows[1]!.cells).toHaveLength(20);
  expect(evidence.rows[1]!.cells![0]!.fg).toBe('index:1');
  expect(evidence.rows[2]!.cells![0]!.fg).toBe('index:1');
  expect(() => decodeTmuxCaptureRows('plain\n🏳️ ‍🌈x\nnext\n', 20)).toThrow();
  const screen = decodeTmuxCaptureScreen('plain\n\x1b[31m🏳️ ‍🌈x\nnext\n', 20);
  expect(screen.uncertainRows).toEqual([1]);
  expect(JSON.stringify(screen.rows)).toBe(JSON.stringify(evidence.rows.map(row => row.cells)));
});
test('I3 unsupported escape poisons style until an explicit reset without inventing blank rows', () => {
  const evidence = decodeTmuxCaptureEvidence('ok\n\x1b[38;2;300;0;0mX\nunknown\n\x1b[0mrecovered\n\n', 12);
  expect(evidence.rows.map(row => row.reason)).toEqual(['observed', 'unsupported-row', 'unknown-style-state', 'observed', 'observed']);
  expect(evidence.rows[2]!.cells).toBeNull();
  expect(evidence.rows[3]!.cells![0]!.fg).toBe('default');
  expect(evidence.rows[4]!.cells).toHaveLength(12);
  expect(decodeTmuxCaptureEvidence('a\n\n', 12).complete).toBe(true);
  expect(decodeTmuxCaptureEvidence('ok\n\x1b[38;2;300;0;0mX\n', 12).complete).toBe(false);
});

test('I3 mutation control: certifying ambiguous cells fails and original stays intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'i3-decoder-mutation-'));
  try {
    const original = readFileSync(new URL('../src/tmux-capture-normalize.ts', import.meta.url), 'utf8')
      .replace("from '@thumbmux/core'", `from ${JSON.stringify(import.meta.resolve('@thumbmux/core'))}`);
    const from = "certain: false, reason: 'ambiguous-cell-boundary' }";
    expect(original.split(from)).toHaveLength(2);
    writeFileSync(join(root, 'runner.ts'), `import assert from 'node:assert/strict';
import {decodeTmuxCaptureEvidence} from './subject.ts';
const result=decodeTmuxCaptureEvidence('ok\\n🏳️ ‍🌈x\\nnext\\n',20);
assert.equal(result.rows[1].certain,false,'MUTATION ambiguous cells certified');
assert.deepEqual(result.uncertainRows,[1],'MUTATION uncertain row lost');`);
    for (const mutated of [false, true]) {
      writeFileSync(join(root, 'subject.ts'), mutated ? original.replace(from, "certain: true, reason: 'ambiguous-cell-boundary' }") : original);
      const result = spawnSync(process.execPath, [join(root, 'runner.ts')], { encoding: 'utf8', timeout: 10000 });
      console.log('I3_MUTATION', JSON.stringify({ name: 'ambiguous-cells', mutated, exit: result.status, stderr: result.stderr }));
      expect(result.status).toBe(mutated ? 1 : 0);
      if (mutated) expect(result.stderr).toContain('MUTATION');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('I4-FIX1 lot C decoder fidelity and retention', () => {
  test('M9 dim, blink, rapid blink, hidden, strike and double underline survive decode as distinct bits', () => {
    const cases: Array<[string, number]> = [
      ['1', TMUX_STYLE_BITS.BOLD], ['2', TMUX_STYLE_BITS.DIM], ['3', TMUX_STYLE_BITS.ITALIC], ['4', TMUX_STYLE_BITS.UNDERLINE],
      ['5', TMUX_STYLE_BITS.BLINK], ['6', TMUX_STYLE_BITS.RAPID_BLINK], ['7', TMUX_STYLE_BITS.REVERSE], ['8', TMUX_STYLE_BITS.HIDDEN],
      ['9', TMUX_STYLE_BITS.STRIKE], ['21', TMUX_STYLE_BITS.DOUBLE_UNDERLINE], ['2;6;8', 2 | 32 | 128],
    ];
    for (const [sgr, bits] of cases) {
      const warm = new TmuxCaptureDecoder(4);
      const raw = `\x1b[${sgr}mab\x1b[0mc\n`;
      for (const rows of [decodeTmuxCaptureRows(raw, 4), warm.decode(raw), warm.decode(raw)]) {
        expect(rows[0]!.map(cell => cell.style)).toEqual([bits, bits, 0, 0]);
      }
    }
    // Resets clear exactly their own bits.
    expect(decodeTmuxCaptureRows('\x1b[1;2;6;8mA\x1b[22mB\x1b[25mC\x1b[28mD\n', 4)[0]!.map(c => c.style)).toEqual([1 | 2 | 32 | 128, 32 | 128, 128, 0]);
  });

  test('F11 retention follows the capture in use: a steady tail keeps <=1024 rows, consecutive full captures stay warm', () => {
    const line = (i: number) => `\x1b[${31 + i % 7}mrow-${String(i).padStart(8, '0')} ไทย 你\x1b[0m`;
    const body = (from: number, count: number) => Array.from({ length: count }, (_, k) => line(from + k)).join('\n') + '\n';
    const adaptive = new TmuxCaptureDecoder(80), fixed = new TmuxCaptureDecoder(80, 9000, 9000);
    let end = 4540;
    for (const d of [adaptive, fixed]) d.decode(body(0, 4540));
    expect(adaptive.size).toBe(4540);
    for (let t = 0; t < 300; t++) { end += 20; for (const d of [adaptive, fixed]) d.decode(body(end - 188, 188)); }
    console.log('NEWARCH_I4C_DECODER_RETENTION', JSON.stringify({ adaptive: { size: adaptive.size, hits: adaptive.hits, misses: adaptive.misses }, fixed9000: { size: fixed.size, hits: fixed.hits, misses: fixed.misses } }));
    expect(adaptive.size).toBeLessThanOrEqual(1024);
    expect(fixed.size).toBe(9000);
    // Same memo effect in steady flow.
    expect(adaptive.hits).toBe(fixed.hits); expect(adaptive.misses).toBe(fixed.misses);
    // A full capture regrows it; the next full capture is all hits.
    const full = body(end - 4540, 4540);
    adaptive.decode(full);
    const hits = adaptive.hits, misses = adaptive.misses;
    adaptive.decode(full);
    expect(adaptive.hits - hits).toBe(4540); expect(adaptive.misses).toBe(misses);
    expect(() => new TmuxCaptureDecoder(80, 9000, 0)).toThrow('invalid decoder cache size');
  });
});

test('CANARY-FIX M: a slowly growing pane keeps only the rows of its last two captures, with the same hits', () => {
  // The R-CANARY soak shape: one new row per capture, tail = 128 rows + 40 screen rows.
  // Rows that left every recent capture are never looked up again; a floor of 1024
  // kept them anyway (21 panes: ~4 KB per row with the canonical/frame side tables).
  const line = (i: number) => `P${String(i % 21).padStart(2, '0')} ${String(i).padStart(6, '0')} \x1b[${31 + i % 7}mcolor${i % 10}\x1b[0m ไทย漢字😀 ${'x'.repeat(i % 13)}`;
  const capture = (end: number) => { const from = Math.max(0, end - 168); return { body: Array.from({ length: end - from }, (_, k) => line(from + k)).join('\n') + '\n', lines: end - from }; };
  const memo = new TmuxCaptureDecoder(120), reference = new TmuxCaptureDecoder(120, 9000, 9000);
  let worst = 0;
  for (let end = 1; end <= 1500; end++) {
    const { body, lines } = capture(end);
    const rows = memo.decode(body);
    expect(rows).toEqual(reference.decode(body));
    worst = Math.max(worst, memo.size / Math.max(lines, 1));
    expect(memo.size).toBeLessThanOrEqual(2 * lines);
  }
  console.log('CANARY_FIX_M_DECODER', JSON.stringify({ size: memo.size, worstRatio: +worst.toFixed(3), hits: memo.hits, misses: memo.misses, referenceSize: reference.size }));
  expect(memo.hits).toBe(reference.hits);
  expect(memo.misses).toBe(reference.misses);
});

test('I4-FIX1 C mutation control: a memo that never trims keeps 9000 rows and fails the retention bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'i4c-decoder-mutation-'));
  try {
    const original = readFileSync(new URL('../src/tmux-capture-normalize.ts', import.meta.url), 'utf8')
      .replace("from '@thumbmux/core'", `from ${JSON.stringify(import.meta.resolve('@thumbmux/core'))}`);
    const from = 'if (this.cache.size <= keep) return;';
    expect(original.split(from)).toHaveLength(2);
    writeFileSync(join(root, 'runner.ts'), `import assert from 'node:assert/strict';
import {TmuxCaptureDecoder} from './subject.ts';
const body=(a,n)=>Array.from({length:n},(_,k)=>'row-'+String(a+k).padStart(8,'0')).join('\\n')+'\\n';
const d=new TmuxCaptureDecoder(40); d.decode(body(0,4540));
let end=4540; for(let t=0;t<100;t++){end+=40; d.decode(body(end-188,188));}
assert.ok(d.size<=1024,'MUTATION memo kept '+d.size+' rows');`);
    for (const mutated of [false, true]) {
      writeFileSync(join(root, 'subject.ts'), mutated ? original.replace(from, 'return;') : original);
      const result = spawnSync(process.execPath, [join(root, 'runner.ts')], { encoding: 'utf8', timeout: 10000 });
      console.log('I4C_MUTATION', JSON.stringify({ name: 'decoder-retention', mutated, exit: result.status, stderr: result.stderr.slice(0, 300) }));
      expect(result.status).toBe(mutated ? 1 : 0);
      if (mutated) expect(result.stderr).toContain('MUTATION');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
