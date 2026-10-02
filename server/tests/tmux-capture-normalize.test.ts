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

// Namespace read: without the M3 surface only this test fails, not the whole file.
import * as N3 from '../src/tmux-capture-normalize';
test('NEWARCH2 M3: a mapping decoder maps each decoded row once into its memo, equal to mapping afterwards; stats count memo bytes', () => {
  const cols = 16;
  const tag = (cell: Readonly<{ grapheme: string; width: 0 | 1 | 2; continuation: boolean; fg: string; bg: string; style: number }>) =>
    Object.freeze({ ...cell, fg: cell.fg === 'index:196' ? 'rgb:255,0,0' : cell.fg });
  let calls = 0;
  const counted = (cell: Parameters<typeof tag>[0]) => { calls++; return tag(cell); };
  const body = ['\x1b[38;5;196mpal\x1b[0m 漢字', '', '\x1b[1;2mbd\x1b[0m ไทย', 'flag 🇹🇭🇯🇵', 'é x'].join('\n') + '\n';
  const plain = new TmuxCaptureDecoder(cols), mapped = new (TmuxCaptureDecoder as any)(cols, 9000, 1, counted) as TmuxCaptureDecoder & { mapsCells: boolean; stats(): Record<string, number> };
  expect((plain as any).mapsCells).toBe(false); expect(mapped.mapsCells).toBe(true);
  const want = plain.decode(body).map(row => row.map(tag));
  const first = mapped.decode(body);
  const coldCalls = calls;
  const second = mapped.decode(body);
  expect(JSON.stringify(first)).toBe(JSON.stringify(want));
  expect(JSON.stringify(second)).toBe(JSON.stringify(want));
  expect(mapped.uncertainRows).toEqual(plain.uncertainRows);
  // Memo rows are mapped once (cold); a warm decode maps only the uncertain row, which is never cached.
  expect(coldCalls).toBe(5 * cols);
  expect(calls - coldCalls).toBe(plain.uncertainRows.length * cols);
  expect(second[0]).toBe(first[0]);
  expect(first[0]![0]!.fg).toBe('rgb:255,0,0');
  const stats = mapped.stats();
  expect(stats).toMatchObject({ entries: 4, cellSlots: 4 * cols, generation: 2, hits: 4, misses: 4 });
  const m = (N3 as any).CACHE_BYTE_MODEL as Record<'mapEntry' | 'object' | 'arrayHeader' | 'stringHeader' | 'slot' | 'char', number>;
  expect(stats.bytes).toBe(4 * (m.mapEntry + m.object + m.arrayHeader + m.stringHeader) + 4 * cols * m.slot + stats.keyChars * m.char);
  expect((new TmuxCaptureDecoder(cols) as any).stats()).toMatchObject({ entries: 0, cellSlots: 0, keyChars: 0, bytes: 0 });
});

// SPIKE2: disposable prototype modules; production imports remain unchanged.
import { CaptureChunkDecoder } from '../../../../docs/tasks/newarch-spike2/bundle/decoder';
import { ExactRowTokens, FullPermit, matchTokens, repairPrefix, withFrozenView, type ViewPorts } from '../../../../docs/tasks/newarch-spike2/bundle/prototype';
import { matchHistoryRows as originalMatch, type CapturedRow } from '../src/history-row-matcher';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SPIKE2 bounded prototype fixtures', () => {
  const fixtures = ['', '\n', '\n\n', 'a', 'a\n', 'a\n\n', '12345678\nabcdefgh\n',
    '\x1b[31mred\ncarry\n\x1b[0mreset\n', 'A❤️ B\nไทย你😃\n',
    '\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x07\n',
    '\x1b[38;2;12;23;34m👩‍💻\n🇹🇭\n', '👍🏽❤️ \nplain\n',
    '\x1b]8;;url\ncontinued\x07text\n', 'A❤️\x1b]8;;url\n B\x07x\n'];
  const streamed = (raw: string, cut: number) => {
    const d = new CaptureChunkDecoder(40), bytes = Buffer.from(raw), all: any[] = [];
    for (const part of [bytes.subarray(0, cut), bytes.subarray(cut)]) for (const chunk of d.write(part)) all.push(...chunk);
    for (const chunk of d.end()) all.push(...chunk);
    return { rows: all.map(r => r.cells), uncertain: all.filter(r => r.uncertain).map(r => r.index) };
  };
  test('byte-exact legacy parity at EVERY UTF-8/SGR/OSC/LF cut; uncertain rows retain global indexes', () => {
    for (const raw of fixtures) {
      const d = new TmuxCaptureDecoder(40); let expected: unknown, error = false;
      try { expected = JSON.stringify({ rows: d.decode(raw), uncertain: d.uncertainRows }); } catch { error = true; }
      for (let cut = 0; cut <= Buffer.byteLength(raw); cut++) {
        if (error) expect(() => streamed(raw, cut)).toThrow();
        else expect(JSON.stringify(streamed(raw, cut))).toBe(expected);
      }
    }
  });
  test('256-row batches carry SGR, preserve row ownership, and leave hot memo identity intact', () => {
    const hot = new TmuxCaptureDecoder(40, 1024), raw = '\x1b[31mhot\n';
    const prior = hot.decode(raw)[0]; const stats = hot.stats();
    const d = new CaptureChunkDecoder(40); const rows = '\x1b[31m' + Array.from({ length: 777 }, (_, i) => `row-${i}\n`).join('');
    const chunks = [...d.write(Buffer.from(rows)), ...d.end()];
    expect(chunks.map(c => c.length)).toEqual([256, 256, 256, 9]);
    expect(chunks.flat().map(r => r.cells)).toEqual(new TmuxCaptureDecoder(40).decode(rows));
    expect(chunks[0]![0]!.cells).not.toBe(chunks[1]![0]!.cells);
    expect(hot.stats()).toEqual(stats); expect(hot.decode(raw)[0]).toBe(prior);
  });
  test('unsupported controls and invalid input fail, never truncate', () => {
    for (const raw of ['\x1b[?25l', '\r', 'x'.repeat(41), '\x1b[31']) {
      expect(() => streamed(raw, 1)).toThrow();
    }
    expect(() => [...new CaptureChunkDecoder(40).write(new Uint8Array(65537))]).toThrow();
  });
  test('compact exact matcher equals original across cold duplicates, all blanks, collisions, soft-wrap and false-full', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike2-exact-'));
    const registry = new ExactRowTokens(join(dir, 'rows'), undefined, () => 'forced-collision');
    const row = (s: string, softWrap = false): CapturedRow => ({ cells: new TmuxCaptureDecoder(8).decode(s + '\n')[0]!, softWrap });
    try {
      const a = [row('a'), row('b'), row('c'), row('d'), row('e'), row('f'), row('g')];
      for (const [history, captured] of [[a, a], [[...a, ...a], a], [a, [...a, ...a]],
        [Array(8).fill(row('')), Array(8).fill(row(''))], [a, [row('a', true), ...a.slice(1)]],
        [a, [row('wrong'), ...a.slice(1)]], [a, a.slice(-3)]] as [CapturedRow[], CapturedRow[]][]) {
        const recent = history.map((r, i) => ({ ...r, lineId: i, sourceEpoch: 1, geometryGeneration: 2 }));
        for (const completeRetainedTail of [true, false]) for (const uncertainCapturedRows of [new Set<number>(), new Set([2])]) {
          const scope = { sourceEpoch: 1, geometryGeneration: 2, completeRetainedTail, uncertainCapturedRows, maxTailGap: 256 };
          expect(matchTokens(recent.map(r => ({ ...r, token: registry.intern(r) })), captured.map(r => registry.intern(r)), scope))
            .toEqual(originalMatch(recent, captured, scope));
        }
      }
      expect(registry.intern(row('a'))).not.toBe(registry.intern(row('a', true)));
      expect(registry.intern(row('a'))).not.toBe(registry.intern(row('b')));
    } finally { registry.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('one permit covers the complete job including commit/hot sync, and waiting timeout does not start capture', async () => {
    const p = new FullPermit(), signal = new AbortController().signal, events: string[] = [];
    let release!: () => void;
    const first = p.run('one', signal, performance.now() + 2000, async () => {
      events.push('capture1'); await new Promise<void>(r => release = r); events.push('commit1', 'sync1');
    });
    await Promise.resolve();
    const expired = p.run('expired', signal, performance.now() + 10, async () => { events.push('BAD'); }).catch(e => e);
    const second = p.run('two', signal, performance.now() + 2000, async () => { events.push('capture2'); });
    expect((await expired).message).toContain('deadline');
    release(); await Promise.all([first, second]);
    expect(events).toEqual(['capture1', 'commit1', 'sync1', 'capture2']); expect(p.highWater).toBe(1); expect(p.active).toBe(0);
  });
  test('committed prefix sync survives chunk2 throw and generation change; finish never runs on failure', async () => {
    for (const fault of ['throw', 'epoch', 'resize']) {
      let identity = 'pane/epoch1/geo1', finished = false;
      const store = new Map([[0, 'old']]), hot = new Map(store), snapshot = new Map(hot);
      const ansi = new Map(hot), live = new Map(hot);
      const ports = { identity: () => identity, expectedIdentity: identity,
        commit: async (chunk: readonly number[], i: number) => {
          if (i === 1) { if (fault === 'throw') throw new Error('chunk2'); identity = fault; }
          store.set(chunk[0]!, 'new'); return { revision: i + 1, ids: chunk };
        },
        sync: async (_: readonly number[], receipt: { ids: readonly number[] }) => { for (const id of receipt.ids) { hot.set(id, store.get(id)!); ansi.set(id, store.get(id)!); live.set(id, store.get(id)!); } },
        onSyncFailure: () => { throw new Error('unexpected'); }, finish: async () => { finished = true; } };
      await expect(repairPrefix([[0], [1]], ports)).rejects.toThrow();
      expect(hot.get(0)).toBe('new'); expect(ansi.get(0)).toBe('new'); expect(live.get(0)).toBe('new');
      expect(snapshot.get(0)).toBe('old'); expect(finished).toBe(false);
    }
  });
  test('frozen overlay, range fence, fixed head, busy propagation and release on errors', async () => {
    let released = 0; const overlay = [{ lineId: 0, revision: 3, exact: 'frozen', identity: 'pane' }];
    const token = Object.freeze({ identity: 'pane', revision: 3, durable: 1, head: 1, start: 0, end: 1, deadline: performance.now() + 2000 });
    const ports: ViewPorts = { grant: async () => ({ token, overlay }), readerOpen: async () => ({ identity: 'pane', fence: 2 }),
      openAck: async () => { overlay[0]!.exact = 'later'; }, diskPage: async () => [{ lineId: 0, revision: 1, exact: 'disk', identity: 'pane' }],
      release: async () => { released++; } };
    await withFrozenView(ports, 0, 1, async (t, page) => { expect((await page(0, 1))[0]!.exact).toBe('frozen'); expect(t.head).toBe(1); });
    expect(released).toBe(1);
    await expect(withFrozenView({ ...ports, readerOpen: async () => ({ identity: 'pane', fence: 4 }) }, 0, 1, async () => {})).rejects.toThrow('fence');
    await expect(withFrozenView({ ...ports, diskPage: async () => { throw new Error('busy'); } }, 0, 1, async (_t, page) => page(0, 1))).rejects.toThrow('busy');
    expect(released).toBe(3);
  });
});

import { createProjectionStore } from '../src/sqlite-history/projection-store';
import { prepared as p0Prepared } from '../src/sqlite-history/ram-store';
import { coordinator as p0Coordinator, lifetime as p0Lifetime, matchCapture as p0Match, commitChunks as p0Commit } from '../../../../docs/tasks/newarch-spike2/bundle/adapter';

describe('SPIKE2 real SQLite ReadView and committed prefix', () => {
  const key = { serverIdentity: 'spike2-fixture', paneId: '%1', birthGeneration: 1 };
  const cell = (grapheme: string) => ({ grapheme, width: 1, continuation: false, fg: 'default', bg: 'default', style: 0 });
  const row = (text: string) => ({ text, cells: [...text].map(cell) });
  test('WAL snapshot keeps grant head and overlay while writer advances; cancel releases gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spike2-view-'));
    const store:any = createProjectionStore({historyRoot:root,mode:'create'}), c=p0Coordinator(store);
    try {
      await store.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,physicalRow:row('old'),softWrap:false,receiveSeq:1});
      store.flush();
      await store.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,physicalRow:row('ram'),softWrap:false,receiveSeq:2});
      const controller=new AbortController();
      const view=await c.open(key,performance.now()+1000,controller.signal);
      await store.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,physicalRow:row('new'),softWrap:false,receiveSeq:3});
      store.flush();
      expect(view.token.end).toBe(2);
      expect((await view.page(0,2)).map((r:any)=>r.physical.text)).toEqual(['old','ram']);
      await expect(view.page(0,3)).rejects.toThrow('range');
      controller.abort(); await view.release();
      const next=await c.open(key,performance.now()+1000);
      expect((await next.page(0,3)).map((r:any)=>r.physical.text)).toEqual(['old','ram','new']);
      await next.release();
      expect(c.stats.grants).toBe(c.stats.releases);
    } finally {await store.close();rmSync(root,{recursive:true,force:true});}
  });
  test('real chunk1 commit survives chunk2 failure, COW hot cells/ANSI and reopen agree', async () => {
    const root=mkdtempSync(join(tmpdir(),'spike2-prefix-'));
    let store:any=createProjectionStore({historyRoot:root,mode:'create'});
    const c=p0Coordinator(store);
    try {
      for(let i=0;i<257;i++)await store.appendScroll({paneKey:key,sourceEpoch:1,geometryGeneration:1,physicalRow:row('old'),softWrap:false,receiveSeq:i+1});
      store.flush();
      const oldRing=Array.from({length:257},(_,lineId)=>Object.freeze({lineId,cells:row('old').cells,ansiCache:{text:'old'}}));
      const pane:any={paneKey:key,runtime:{store,now:()=>Date.now()},ring:oldRing,ringRepairs:0,certified:new Set(),received:257,
        stats:{storeCommits:0},countCapture(){}};
      const capture:any={captureId:'fixture-capture',requestedAt:1,completedAt:2,after:{sourceEpoch:1,geometryGeneration:1,kind:'normal',cols:3,rows:1,cursor:{x:0,y:0,visible:true}},
        frame:{cells:[row('new').cells]},observedFields:['grapheme','width','continuation','fg','bg','style'],completeRetainedTail:true};
      await p0Lifetime(pane,new AbortController().signal,performance.now()+1000,async()=>{
        await c.rpc('begin',{path:join(root,'capture.spool'),cols:3});
        await c.rpc('bytes',{bytes:Buffer.from('new\n'.repeat(258))});
        await c.rpc('end',{rows:1});
        const token=store.token(key);
        await p0Match(pane,capture,{recentLastLineId:256},token);
        const enqueue=store.enqueue.bind(store);let chunks=0;
        store.enqueue=(...args:any[])=>{if(++chunks===2)return Promise.reject(new Error('chunk2 injected'));return enqueue(...args);};
        await expect(p0Commit(pane,{capture,expectedRevision:token.revision,captureEvidence:{kind:'unfenced',reason:'fixture'},checks:[],contentMatches:[],
          repairs:Array.from({length:257},(_,i)=>({lineId:i,capturedRow:i}))})).rejects.toThrow('chunk2 injected');
        store.enqueue=enqueue;
      });
      expect(pane.ring[0].cells).toEqual(row('new').cells);
      expect(pane.ring[0].ansiCache).toEqual({});
      expect(pane.ring[256].cells).toEqual(row('old').cells);
      expect(oldRing[0]!.cells).toEqual(row('old').cells);
      expect(pane.certified.size).toBe(256);
      expect(store.readPage(store.token(key),0,257).lines.map((l:any)=>l.text)).toEqual([...Array(256).fill('new'),'old']);
      await store.close();store=createProjectionStore({historyRoot:root,mode:'recover'});
      expect(store.readPage(store.token(key),0,257).lines.map((l:any)=>l.text)).toEqual([...Array(256).fill('new'),'old']);
    } finally {await store.close();rmSync(root,{recursive:true,force:true});}
  },10000);
});

// SPIKE2 round 4: admission safety is independent of performance acceptance.
import { ScratchLedger, SCRATCH_CAPS } from '../../../../docs/tasks/newarch-spike2/bundle/scratch';
describe('SPIKE2 shared scratch admission', () => {
  test('worker/main share caps, reject overflow without corrupting charge, and release', () => {
    const a=new ScratchLedger(), b=new ScratchLedger(a.shared);
    SCRATCH_CAPS.forEach((cap,i)=>a.set(i,cap));
    expect(b.stats.charged.reduce((a,b)=>a+b,0)).toBe(32*1024*1024);
    expect(()=>b.set(1,SCRATCH_CAPS[1]!+1)).toThrow('scratch-budget');
    expect(a.stats.refusals).toBe(1);expect(a.stats.charged[1]).toBe(SCRATCH_CAPS[1]);
    SCRATCH_CAPS.forEach((_,i)=>b.set(i,0));expect(a.stats.charged.reduce((a,b)=>a+b,0)).toBe(0);
  });
  test('wide Unicode/SGR inventory yields bounded chunks with exact rows and releases decode charge', () => {
    const ledger=new ScratchLedger();
    for(const cols of [80,120,240]) {
      const raw=('\x1b[38;2;128;64;32m'+'漢'.repeat(cols/2)+'\x1b[0m\n').repeat(520);
      const decoder=new CaptureChunkDecoder(cols,65536,n=>ledger.set(1,n));
      const rows:any[]=[];const bytes=Buffer.from(raw);
      for(let i=0;i<bytes.length;i+=65536)for(const chunk of decoder.write(bytes.subarray(i,i+65536))){expect(chunk.length).toBeLessThanOrEqual(256);rows.push(...chunk.map(r=>r.cells));}
      for(const chunk of decoder.end())rows.push(...chunk.map(r=>r.cells));
      expect(rows).toEqual(new TmuxCaptureDecoder(cols).decode(raw));expect(ledger.stats.charged[1]).toBe(0);
    }
    expect(ledger.stats.high[1]).toBeLessThanOrEqual(SCRATCH_CAPS[1]);
  });
});


// Lot C: these tests are committed before the implementation. Execute only
// after the exclusive host lease ends; lease-deferred is NOT a red result.
import { CaptureAdmission, CaptureTail, exactVisibleVerdict, uniqueCaptureSeam,
  captureDigest } from '../src/capture-engine';
import { StreamCaptureChunkDecoder } from '../src/tmux-capture-normalize';
import type { FinalizedRow, FrameDelta } from '../src/stream-contract';

const cPane = { serverIdentity: 'lot-c', paneId: '%1', birthGeneration: 1 };
const cIdentity = { pane: cPane, sourceEpoch: 1, geometryGeneration: 1 };
const cRow = (lineId: number, text = `row-${lineId}`): FinalizedRow => ({
  id: { pane: cPane, lineId }, revision: lineId + 1,
  source: { pane: cPane, sourceEpoch: 1, packetSeq: lineId + 1, scrollOrdinal: 0 },
  geometryGeneration: 1, geometry: { columns: 80, rows: 24 },
  cells: [{ text, width: 1, style: [] }], softWrap: false, wrapPad: 0, uncertainFields: [],
});
const cFrame = (): FrameDelta => ({ identity: cIdentity, screenRevision: 1,
  buffer: 'normal', geometry: { columns: 80, rows: 24 }, cursor: { x: 0, y: 0, visible: true },
  overlap: null, changedRows: [{ y: 0, content: cRow(0) }],
});

describe('NEWARCH C admission, immutable tail and exact evidence', () => {
  test('reservation refuses before mutation and is released exactly once', () => {
    const budget = new CaptureAdmission(10);
    const release = budget.reserve(7)!;
    expect(budget.reserve(4)).toBeNull(); expect(budget.heldBytes).toBe(7);
    release(); release(); expect(budget.heldBytes).toBe(0);
    expect(() => budget.reserve(NaN)).toThrow();
  });
  test('tail never evicts undurable rows; 257th row waits for durable ACK', () => {
    const tail = new CaptureTail();
    expect(tail.append(Array.from({ length: 256 }, (_, i) => cRow(i)))).toBe(true);
    expect(tail.append([cRow(256)])).toBe(false);
    expect(tail.rows.length).toBe(256);
    tail.durable(256);
    expect(tail.append([cRow(256)])).toBe(true);
    expect(tail.rows[0]!.id.lineId).toBe(1);
    expect(tail.heldBytes).toBeLessThanOrEqual(1048576);
    const copy = tail.rows;
    expect(Object.isFrozen(copy[0]!.cells)).toBe(true);
    expect(() => { (copy[0]!.cells[0] as any).text = 'mutated'; }).toThrow();
  });
  test('byte cap is independent of row cap and refusal is atomic', () => {
    const tail = new CaptureTail();
    expect(tail.append([cRow(0)])).toBe(true);
    expect(tail.append([cRow(1, 'x'.repeat(1048576))])).toBe(false);
    expect(tail.rows.map(r => r.id.lineId)).toEqual([0]);
    expect(() => tail.durable(-1)).toThrow();
  });
  test('exact screen check rejects uncertainty, movement, identity and wrap mismatches', () => {
    const frame = cFrame();
    expect(exactVisibleVerdict(frame, frame, 4, 4)).toBe('equal');
    expect(exactVisibleVerdict(frame, frame, 4, 5)).toBe('unfenced');
    const other = structuredClone(frame) as any;
    other.changedRows[0].content.softWrap = true;
    expect(exactVisibleVerdict(frame, other, 4, 4)).toBe('different');
    other.changedRows[0].content.uncertainFields = ['wrap'];
    expect(exactVisibleVerdict(frame, other, 4, 4)).toBe('unfenced');
    other.identity.sourceEpoch = 2;
    expect(exactVisibleVerdict(frame, other, 4, 4)).toBe('unfenced');
  });
  test('ordered anchors must be unique, never guessed from repeated rows', () => {
    expect(uniqueCaptureSeam(['a', 'b'], ['x', 'a', 'b', 'c'])).toBe(3);
    expect(() => uniqueCaptureSeam(['a'], ['a', 'a'])).toThrow('ambiguous');
    expect(() => uniqueCaptureSeam(['a'], ['b'])).toThrow();
    expect(() => uniqueCaptureSeam(['a'], Array(5013).fill('b'))).toThrow();
  });
  test('canonical digest includes identity and is independent of object key order', () => {
    expect(captureDigest({ a: 1, b: 2 })).toBe(captureDigest({ b: 2, a: 1 }));
    expect(captureDigest(cIdentity)).not.toBe(captureDigest({ ...cIdentity, sourceEpoch: 2 }));
    expect(() => captureDigest({ a: NaN })).toThrow();
  });
});

describe('NEWARCH C bounded repair decoder', () => {
  test('every byte cut of UTF8/SGR matches whole capture with no missing rows', () => {
    const raw = Buffer.from('\x1b[31mไทย 漢\nsecond\n');
    const oracle = decodeTmuxCaptureRows(raw.toString(), 20);
    for (let cut = 0; cut <= raw.length; cut++) {
      const decoder = new StreamCaptureChunkDecoder(20);
      const chunks = [...decoder.write(raw.subarray(0, cut)), ...decoder.write(raw.subarray(cut)), ...decoder.end()];
      expect(chunks.flat().map(r => r.cells)).toEqual(oracle);
    }
  });
  test('777 rows preserve order and chunks never exceed 256 rows / 1 MiB', () => {
    const decoder = new StreamCaptureChunkDecoder(80);
    const chunks = [...decoder.write(Buffer.from('line\n'.repeat(777))), ...decoder.end()];
    expect(chunks.flat()).toHaveLength(777);
    expect(chunks.flat().map(r => r.index)).toEqual(Array.from({ length: 777 }, (_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(1048576);
    }
  });
  test('unsupported/incomplete escape and oversized input do not become EOF', () => {
    expect(() => [...new StreamCaptureChunkDecoder(80).write(new Uint8Array(65537))]).toThrow();
    const decoder = new StreamCaptureChunkDecoder(80);
    expect(() => [...decoder.write(Buffer.from('\x1b[31')), ...decoder.end()]).toThrow();
    const invalid = new StreamCaptureChunkDecoder(80);
    expect(() => [...invalid.write(new Uint8Array([0xff])), ...invalid.end()]).toThrow();
  });
});

import { StreamCaptureWatchdog } from '../src/history-watchdog';
import { PipeVtWorker, type PipeVtUpdate } from '../src/pipe-vt-worker';
import { StreamCaptureEngine, type CapturePorts, type CaptureVtTransaction } from '../src/capture-engine';
import type { HistoryEngine, InputEvent, LiveFrame } from '../src/stream-contract';

describe('NEWARCH C watchdog and packet ordinals', () => {
  test('quiet source stays healthy; pending ACK/source stall fires at 500ms, once', () => {
    let now = 0; const reasons: string[] = [];
    const watchdog = new StreamCaptureWatchdog(() => now, reason => reasons.push(reason));
    now = 10000; watchdog.tick(); expect(reasons).toEqual([]);
    watchdog.submitted(1); now += 499; watchdog.tick(); expect(reasons).toEqual([]);
    now++; watchdog.tick(); watchdog.tick(); expect(reasons).toEqual(['ack-timeout']);
    watchdog.ack(1); watchdog.sourceProgress(1); watchdog.sourceProgress(2);
    now += 500; watchdog.tick(); expect(reasons).toEqual(['ack-timeout', 'stalled-input']);
    watchdog.receive(10); watchdog.reset(); watchdog.submitted(2);
    expect(reasons.at(-1)).toBe('sequence');
  });
  test('real VT worker keeps per-packet scroll ordinal across coalesced output', async () => {
    const updates: PipeVtUpdate[] = []; const faults: string[] = [];
    const worker = new PipeVtWorker({ cols: 8, rows: 2,
      onUpdate: update => { updates.push(update); }, onFault: fault => faults.push(fault.message) });
    try {
      await worker.start(); expect(worker.setScrollOnClear(false)).toBe(true);
      expect(worker.feed(1, Buffer.from('a\r\nb\r\nc\r\nd\r\n'))).toBe(true);
      expect(worker.feed(2, Buffer.from('e\r\nf\r\n'))).toBe(true);
      const drained = await worker.close(); expect(drained.unknownTail).toBe(false);
      const scrolls = updates.flatMap(update => update.scrolls);
      expect(scrolls.length).toBeGreaterThan(0);
      for (const seq of [1, 2]) {
        const rows = scrolls.filter(row => row.packetSeq === seq);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map(row => row.scrollOrdinal)).toEqual(rows.map((_, i) => i));
        expect(rows.every(row => row.packetEpoch === 1)).toBe(true);
      }
      expect(faults).toEqual([]);
    } finally { await worker.close(); }
  }, 10000);
});

// State-machine fixture only: this fake VT is NOT a bytecut/alt/reflow oracle
// and fake H is NOT evidence for durable storage. Real adapters remain required.
function cEngineFixture() {
  let installs = 0, appends = 0, journals = 0, denyAppend = false;
  const initial: LiveFrame = { ...cFrame(), head: 0, revision: 0, durableRevision: 0 };
  const history = {
    async journalInput(event: InputEvent) {
      journals++;
      return { status: 'ok', value: { kind: 'durable-input', pane: cPane, through: event.position,
        digest: event.digest, segmentId: `input-${event.position.packetSeq}` } };
    },
    async appendFinalized(request: any) {
      if (denyAppend) return { status: 'busy', reason: 'pressure', retryAfterMs: 10 };
      appends++;
      return { status: 'ok', value: { kind: 'ram', eventId: request.eventId, digest: request.digest,
        revision: request.expectedRevision + 1, head: request.rows.at(-1).id.lineId + 1 } };
    },
  } as unknown as HistoryEngine;
  const ports: CapturePorts = {
    identity: cIdentity, initial, history, now: () => 100,
    admission: new CaptureAdmission(), scratch: new CaptureAdmission(33554432),
    vt: {
      prepare: async event => ({ status: 'ok', value: {
        frame: { ...cFrame(), identity: event.identity }, scrolls: [cRow(0)],
        install: () => { installs++; }, discard: () => {},
      } satisfies CaptureVtTransaction }),
      snapshot: async () => ({ status: 'error', code: 'unsupported', message: 'fixture has no VT codec' }),
      restore: async () => ({ status: 'error', code: 'unsupported', message: 'fixture has no VT codec' }),
      screen: cFrame,
    },
    visible: async (_identity, tail) => { expect(tail).toBe(0); return { status: 'ok', value: cFrame() }; },
    repairChunks: async function* () {},
    syncRepair: async () => { throw new Error('fixture repair not implemented'); }, verifyRepair: async () => false,
  };
  return { engine: new StreamCaptureEngine(ports), ports,
    counts: () => ({ installs, appends, journals }), pressure: (value: boolean) => { denyAppend = value; } };
}
function cInput(seq: number): InputEvent {
  const body = { identity: cIdentity, position: { sourceEpoch: 1, packetSeq: seq },
    receivedAtMonoMs: 1, payload: { kind: 'bytes' as const, bytes: [65] } };
  return { ...body, digest: captureDigest(body) };
}
describe('NEWARCH C capture state machine (adapter fixture)', () => {
  test('accepted input publishes once and retry does not replay VT', async () => {
    const f = cEngineFixture(); const frames: LiveFrame[] = [];
    f.engine.subscribe(cPane, frame => frames.push(frame));
    expect((await f.engine.acceptInput(cInput(1))).status).toBe('ok');
    expect((await f.engine.acceptInput(cInput(1))).status).toBe('ok');
    expect(f.counts()).toEqual({ installs: 1, appends: 1, journals: 2 });
    expect(frames).toHaveLength(1); expect(frames[0]!.head).toBe(1);
    expect(frames[0]!.durableRevision).toBe(0);
    expect(f.ports.admission.heldBytes).toBe(0);
  });
  test('append pressure retains journaled input; next packet is refused before journal', async () => {
    const f = cEngineFixture(); f.pressure(true);
    expect((await f.engine.acceptInput(cInput(1))).status).toBe('ok');
    expect(f.counts()).toEqual({ installs: 0, appends: 0, journals: 1 });
    expect((await f.engine.acceptInput(cInput(2))).status).toBe('busy');
    expect(f.counts().journals).toBe(1);
    expect(f.ports.admission.heldBytes).toBe(262144);
    f.pressure(false); expect((await f.engine.acceptInput(cInput(1))).status).toBe('ok');
    expect(f.counts()).toEqual({ installs: 1, appends: 1, journals: 1 });
    expect(f.ports.admission.heldBytes).toBe(0);
  });
  test('gap and bad digest prevent append; unsupported checkpoint never becomes a screen seed', async () => {
    const f = cEngineFixture();
    expect((await f.engine.acceptInput({ ...cInput(1), digest: 'bad' })).status).toBe('error');
    expect(f.counts().journals).toBe(0);
    await f.engine.acceptInput(cInput(1));
    const checkpoint = await f.engine.checkpoint(cPane, 'handoff');
    expect(checkpoint).toEqual({ status: 'error', code: 'unsupported', message: 'fixture has no VT codec' });
    const episode = f.engine.fault('eof'); expect(episode.missingCount).toBeNull();
    expect((await f.engine.acceptInput(cInput(2))).status).toBe('error');
    expect(f.counts().appends).toBe(1);
  });
});
