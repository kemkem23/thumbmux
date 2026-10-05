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
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
    const panes = cases.map((text, i) => {
      const path = join(root, `text-${i}`); writeFileSync(path, text);
      const pane = tmux('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `p${i}`, '-x', '80', '-y', '24', `cat '${path}'; touch '${path}.ready'; read hold`).trim();
      return pane;
    });
    for (let i = 0; i < cases.length; i++) {
      while (!existsSync(join(root, `text-${i}.ready`))) await Bun.sleep(5);
      const pane = panes[i]!;
      const captured = tmux('display-message', '-p', '-t', pane, '#{cursor_x}', ';', 'capture-pane', '-p', '-e', '-N', '-t', pane);
      const firstNewline = captured.indexOf('\n');
      const cursor = Number(captured.slice(0, firstNewline));
      const raw = captured.slice(firstNewline + 1);
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
      .replace("from '@thumbmux/core'", `from ${JSON.stringify(import.meta.resolve('@thumbmux/core'))}`)
      .replace("from './stream-contract'", `from ${JSON.stringify(new URL('../src/stream-contract.ts', import.meta.url).pathname)}`);
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
      .replace("from '@thumbmux/core'", `from ${JSON.stringify(import.meta.resolve('@thumbmux/core'))}`)
      .replace("from './stream-contract'", `from ${JSON.stringify(new URL('../src/stream-contract.ts', import.meta.url).pathname)}`);
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
import { CaptureChunkDecoder } from './fixtures/spike2/decoder';
import { ExactRowTokens, FullPermit, matchTokens, repairPrefix, withFrozenView, type ViewPorts } from './fixtures/spike2/prototype';
import { matchHistoryRows as originalMatch, type CapturedRow } from '../src/history-row-matcher';

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
import { coordinator as p0Coordinator, lifetime as p0Lifetime, matchCapture as p0Match, commitChunks as p0Commit } from './fixtures/spike2/adapter';

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
import { ScratchLedger, SCRATCH_CAPS } from './fixtures/spike2/scratch';
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
    expect(captureDigest('input', { a: 1, b: 2 })).toBe(captureDigest('input', { b: 2, a: 1 }));
    expect(captureDigest('input', cIdentity)).not.toBe(captureDigest('input', { ...cIdentity, sourceEpoch: 2 }));
    expect(() => captureDigest('input', { a: NaN })).toThrow();
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
    beginGap: () => ({status: 'ok', value: null}),
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
    repairedCheckpoint: async () => ({status:'error',code:'unsupported',message:'fixture has no repair checkpoint'}),
  };
  return { engine: new StreamCaptureEngine(ports), ports,
    counts: () => ({ installs, appends, journals }), pressure: (value: boolean) => { denyAppend = value; } };
}
function cInput(seq: number): InputEvent {
  const body = { identity: cIdentity, position: { sourceEpoch: 1, packetSeq: seq },
    receivedAtMonoMs: 1, payload: { kind: 'bytes' as const, bytes: [65] } };
  return { ...body, digest: captureDigest('input', body) };
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

// Round 2: run only through the isolated command gate after L3e closes.
test('NEWARCH C native checkpoint resumes every byte boundary including alt, CSI and UTF8', () => {
  const script = String.raw`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
data=('hello\r\n\x1b[31m你\x1b7\x1b[?1049hALT\x1b[2;3H!\x1b[?1049l\x1b8\x1b[0m\r\nend').encode()
def finish(w, suffix):
    w.feed(2,1,suffix)
    return w.export_checkpoint(), w.scrolls
for cut in range(len(data)+1):
    a=m.Worker(12,3); a.screen.scroll_on_clear=False; a.feed(1,1,data[:cut]); a.scrolls=[]
    state=a.export_checkpoint(); b=m.Worker.from_checkpoint(json.loads(json.dumps(state)))
    assert finish(a,data[cut:])==finish(b,data[cut:]), cut
try: m.Worker.from_checkpoint({'codecVersion':'wrong'})
except ValueError: pass
else: raise AssertionError('unsupported codec accepted')
# Hidden decoder, DCS filter, margins, tab stops and resize after restore.
for prefix in [b'\x1b[2;3r\x1bH\x1b7\x1b[31;', b'\x1bP$qignored\x1b', b'\xe4\xbd', b'\x1b[?1049hALT']:
    a=m.Worker(12,3); a.screen.scroll_on_clear=False; a.feed(1,1,prefix); a.scrolls=[]
    b=m.Worker.from_checkpoint(a.export_checkpoint())
    a.resize(8,4,1); b.resize(8,4,1)
    assert finish(a,b'!\x1b[?1049l\r\nEND')==finish(b,b'!\x1b[?1049l\r\nEND')
identity={'pane':{'serverIdentity':'fixture','paneId':'%1','birthGeneration':1},'sourceEpoch':1,'geometryGeneration':0}
r=m.checkpoint_transaction({'state':None,'identity':identity,'geometry':{'columns':12,'rows':3},'scrollOnClear':False,'screenRevision':0})
again=m.checkpoint_transaction({'state':r['state'],'identity':identity,'geometry':r['state']['geometry'],'scrollOnClear':False,'screenRevision':0})
assert again==r
print('bytecut/resize/alt/contract roundtrip oracle=0')
`;
  const r = Bun.spawnSync(['python3', '-B', '-c', script, new URL('../src/pipe-vt-worker.py', import.meta.url).pathname]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
});

test('NEWARCH C first packet with 600 finalized rows commits before bounded tail installation', async () => {
  const f = cEngineFixture(); let commits = 0;
  const state = {} as import('../src/stream-contract').VtState;
  f.ports.vt.prepare = async event => ({ status: 'ok', value: {
    frame: { ...cFrame(), identity: event.identity }, scrolls: Array.from({length:600}, (_,i)=>cRow(i)),
    snapshot: async () => ({status:'ok',value:state}), install() {}, discard() {},
  }});
  f.ports.history.commitCheckpoint = async req => {
    commits++;
    return {status:'ok',value:{kind:'durable',pane:cPane,commitId:req.commitId,digest:req.digest,
      durableRevision:req.expectedRevision,checkpointId:req.checkpoint.checkpointId}};
  };
  const frames: LiveFrame[]=[]; f.engine.subscribe(cPane, frame=>frames.push(frame));
  expect((await f.engine.acceptInput(cInput(1))).status).toBe('ok');
  expect(commits).toBe(1); expect(frames.at(-1)?.head).toBe(600);
  expect(frames.at(-1)?.durableRevision).toBe(3);
  expect(f.ports.admission.heldBytes).toBe(0);
});

import { CaptureSourceContinuity, TargetedCaptureRepair, bootstrapCapture,
  type CaptureRecoveryView } from '../src/capture-engine';
const cEpisode = (): import('../src/stream-contract').GapEpisode => ({episodeId:'repair-fixture',pane:cPane,
  epochBefore:1,epochAfter:null,lastDurableInput:{sourceEpoch:1,packetSeq:1},lastAdmittedRow:0,
  firstObservedAtMonoMs:0,reason:'sequence',status:'suspected',missingCount:null});
function cRecoveryView(rows: readonly import('../src/stream-contract').RowContent[]) {
  let closed=0, reads=0;
  const view:CaptureRecoveryView={identity:cIdentity,geometry:cFrame().geometry,rowCount:rows.length,
    recoveryPosition:{sourceEpoch:1,packetSeq:2},
    async read(start,count) {reads++; expect(count).toBeLessThanOrEqual(256);
      return {status:'ok',value:rows.slice(start,start+count)};},
    async verify(){return true;},async close(){closed++;}};
  return {view,counts:()=>({closed,reads})};
}
test('NEWARCH C source tap detects silent drop even with identical screens', () => {
  const faults:string[]=[]; const tap=new CaptureSourceContinuity(reason=>faults.push(reason));
  expect(tap.observe({identity:cIdentity,sourcePacket:1,byteStart:0,byteEnd:10}).status).toBe('ok');
  expect(tap.observe({identity:cIdentity,sourcePacket:3,byteStart:20,byteEnd:30}).status).toBe('error');
  expect(faults).toEqual(['sequence']);
});
test('NEWARCH C targeted repair preserves all 600 missing rows in bounded chunks and rejects repeated anchors',async()=>{
  const contents=Array.from({length:602},(_,i)=>({cells:cRow(i,`row-${i}`).cells,softWrap:false,wrapPad:0,uncertainFields:[]}));
  const f=cRecoveryView(contents),scratch=new CaptureAdmission(33554432);
  const horizons:number[]=[];
  const repair=new TargetedCaptureRepair({open:async(_episode,horizon)=>{horizons.push(horizon);
    return {status:'ok',value:horizon>=contents.length ? f.view : cRecoveryView(contents.slice(-horizon)).view};}},cIdentity,scratch);
  const chunks=[];
  for await(const r of repair.chunks(cEpisode(),[contents[0]!],[contents[601]!],1,new AbortController().signal)) {
    expect(r.status).toBe('ok'); if(r.status==='ok')chunks.push(r.value);
  }
  expect(horizons).toEqual([256,512,1024]);
  expect(chunks.map(c=>c.rows.length)).toEqual([256,256,88]);
  expect(chunks.flatMap(c=>c.rows).map(r=>r.cells)).toEqual(contents.slice(1,601).map(r=>r.cells));
  expect(chunks.at(-1)?.final).toBe(true); expect(scratch.heldBytes).toBe(0);expect(f.counts().closed).toBe(1);
  const repeated=cRecoveryView([contents[0]!,contents[0]!,contents[601]!]);
  const bad=new TargetedCaptureRepair({open:async()=>({status:'ok',value:repeated.view})},cIdentity,scratch);
  const results=[];for await(const r of bad.chunks(cEpisode(),[contents[0]!],[contents[601]!],1,new AbortController().signal))results.push(r);
  expect(results).toMatchObject([{status:'error',code:'unresolved-gap'}]);expect(scratch.heldBytes).toBe(0);
});
test('NEWARCH C bootstrap emits committed prefix before second chunk fails',async()=>{
  const f=cRecoveryView(Array.from({length:600},(_,i)=>cRow(i))),scratch=new CaptureAdmission(33554432);
  let commits=0,synced=0;
  const history={commitRepair:async(chunk:import('../src/stream-contract').RepairChunk)=>{
    if(++commits===2)throw Error('disk fixture failed');
    return {status:'ok',value:{committedIds:chunk.rows.map(r=>r.id),committedRevision:2,complete:false,
      durable:{kind:'durable',pane:cPane,commitId:'r1',digest:chunk.digest,durableRevision:2,checkpointId:'cp1'}}};
  }} as unknown as HistoryEngine;
  const results=[];for await(const r of bootstrapCapture(f.view,cEpisode(),history,scratch,1,async()=>{synced++;},new AbortController().signal))results.push(r);
  expect(results.map(r=>r.status)).toEqual(['ok','error']);expect(synced).toBe(1);expect(scratch.heldBytes).toBe(0);
});

import { CaptureCadence } from '../src/capture-engine';
test('NEWARCH C cadence retains 50ms event and 200/1000/5000ms visible intervals',async()=>{
  let now=0; const calls:number[]=[];
  const engine={checkVisible:async()=>{calls.push(now);return {status:'ok',value:{verdict:'equal'}};},checkpointDue:null} as unknown as StreamCaptureEngine;
  const cadence=new CaptureCadence(engine,()=>cIdentity,()=>now);
  await cadence.tick();now=4999;await cadence.tick();expect(calls).toEqual([0]);
  now=5000;await cadence.tick();expect(calls).toEqual([0,5000]);
  cadence.activity(1,true);now=5025;cadence.event();now=5050;await cadence.tick();
  expect(calls.at(-1)).toBe(5050);now=5250;await cadence.tick();expect(calls.at(-1)).toBe(5250);
  cadence.activity(1,false);now=5300;await cadence.tick();now=6299;await cadence.tick();expect(calls.at(-1)).toBe(5300);
  now=6300;await cadence.tick();expect(calls.at(-1)).toBe(6300);
});

test('NEWARCH C retrying a committed repair prefix cannot duplicate hot rows',()=>{
  const tail=new CaptureTail();tail.durable(1000);
  const rows=Array.from({length:256},(_,i)=>cRow(i));
  expect(tail.reconcile(rows)).toBe(true);expect(tail.reconcile(rows)).toBe(true);
  expect(tail.rows.map(r=>r.id.lineId)).toEqual(rows.map(r=>r.id.lineId));
  expect(tail.rows.length).toBeLessThanOrEqual(256);expect(tail.heldBytes).toBeLessThanOrEqual(1048576);
});

// Round 3: source packetization happens BEFORE journal IDs/ACKs are assigned.
import { CaptureTaskScope } from '../src/capture-engine';
test('NEWARCH C oversized source read is packetized before durable admission', async () => {
  const f=cEngineFixture(); const lengths:number[]=[];
  const prepare=f.ports.vt.prepare;
  f.ports.vt.prepare=async event=>{
    if(event.payload.kind==='bytes' && event.payload.bytes.length>32)
      return {status:'busy',reason:'pressure',retryAfterMs:10};
    return prepare(event);
  };
  const journal=f.ports.history.journalInput;
  f.ports.history.journalInput=async event=>{
    if(event.payload.kind==='bytes') lengths.push(event.payload.bytes.length);
    return journal(event);
  };
  let offset=0,seq=1;
  const bytes=new Uint8Array(4097).fill(65);
  while(offset<bytes.length) {
    const r=await f.engine.acceptSourceBytes(bytes.subarray(offset),seq,1);
    expect(r.status).toBe('ok');
    if(r.status!=='ok')throw Error('packetization');
    offset+=r.value.consumed; seq++;
  }
  expect(lengths.reduce((a,b)=>a+b,0)).toBe(4097);
  expect(Math.max(...lengths)).toBeLessThanOrEqual(32);
  expect(f.counts().installs).toBe(lengths.length);
  expect(f.ports.admission.heldBytes).toBe(0);
});
test('NEWARCH C hard cancellation returns while a port hangs, retains charge until kill ACK', async()=>{
  const controller=new AbortController(); let ack!:()=>void, released=0;
  const scope=new CaptureTaskScope(controller.signal,()=>new Promise<void>(r=>{ack=r;}));
  const waited=scope.wait(new Promise<void>(()=>{}));
  controller.abort();
  await expect(waited).rejects.toThrow('capture operation cancelled');
  scope.finish(()=>{released++;});
  expect(released).toBe(0);
  ack(); await new Promise(r=>setTimeout(r,0));
  expect(released).toBe(1);
});
test('NEWARCH C rejected kill acknowledgement quarantines reservation until actual completion',async()=>{
  const controller=new AbortController(); let settle!:()=>void,released=0;
  const scope=new CaptureTaskScope(controller.signal,async()=>{throw Error('kill failed');});
  const waited=scope.wait(new Promise<void>(r=>{settle=r;}));
  controller.abort(); await expect(waited).rejects.toThrow();
  scope.finish(()=>{released++;}); await new Promise(r=>setTimeout(r,0));
  expect(released).toBe(0);
  settle(); await new Promise(r=>setTimeout(r,0)); expect(released).toBe(1);
});

test('NEWARCH C visible hang hits deadline and keeps one slot until retirement ACK',async()=>{
  const f=cEngineFixture(); let ack!:()=>void;
  f.ports.visible=()=>new Promise(()=>{});
  f.ports.cancelOperation=()=>new Promise<void>(r=>{ack=r;});
  const result=await f.engine.checkVisible(cIdentity);
  expect(result).toMatchObject({status:'error',code:'deadline'});
  expect(f.ports.scratch.heldBytes).toBe(1048576);
  expect((await f.engine.checkVisible(cIdentity)).status).toBe('busy');
  ack(); await new Promise(r=>setTimeout(r,0));
  expect(f.ports.scratch.heldBytes).toBe(0);
},3000);
test('NEWARCH C cancelled hung repair next does not await generator return',async()=>{
  const f=cEngineFixture(); let cancelled=false,retired=0;
  f.ports.repairChunks=()=>({[Symbol.asyncIterator]:()=>({
    next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})
  })});
  f.ports.cancelOperation=async()=>{retired++;};
  const episode=f.engine.fault('sequence');
  const iterator=f.engine.repair(episode,{isCancelled:()=>cancelled})[Symbol.asyncIterator]();
  const pending=iterator.next(); cancelled=true;
  expect((await pending).value).toMatchObject({status:'cancelled'});
  await iterator.next();
  expect(retired).toBe(1);
},1000);
test('NEWARCH C native wide-row expansion is bounded before source admission',()=>{
  const script=String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
identity={'pane':{'serverIdentity':'fixture','paneId':'%1','birthGeneration':1},'sourceEpoch':1,'geometryGeneration':0}
base={'identity':identity,'geometry':{'columns':240,'rows':3},'scrollOnClear':False,'screenRevision':0}
r=m.checkpoint_transaction(dict(base,state=None)); state=r['state']
# Fill wide rows, then repeatedly clear (large expansion from few source bytes).
data=(b'x'*240+b'\r\n')*600+b'\r\n'*512
oracle=m.Worker(240,3);oracle.screen.scroll_on_clear=False;oracle.feed(1,1,data)
expected=[m.contract_row(x['row'],x['wrap'],x['pad']) for x in oracle.scrolls]
actual=[];offset=0;seq=1;high=0;pressures=0
while offset<len(data):
    count=min(512,len(data)-offset)
    while True:
        event={'identity':identity,'position':{'sourceEpoch':1,'packetSeq':seq},'payload':{'kind':'bytes','bytes':list(data[offset:offset+count])}}
        try: candidate=m.checkpoint_transaction(dict(base,state=state,event=event));break
        except m.CaptureExpansionPressure:
            pressures+=1;assert count>1;count//=2
    charge=len(json.dumps(candidate['scrolls']).encode())*4
    high=max(high,charge);assert charge<=524288
    actual.extend(candidate['scrolls']);state=candidate['state'];offset+=count;seq+=1
assert actual==expected
assert pressures>0
print('wide rows oracle=0, source bytes=%d, peak expanded charge=%d'%(offset,high))
`;
  const r=Bun.spawnSync(['python3','-B','-c',script,new URL('../src/pipe-vt-worker.py',import.meta.url).pathname]);
  expect(r.exitCode,r.stderr.toString()).toBe(0);
},30000);

test('NEWARCH C atomic expansion failure is explicit and never durably admitted',async()=>{
  const f=cEngineFixture();
  f.ports.vt.prepare=async()=>({status:'error',code:'unsupported',message:'VT expansion budget'});
  const result=await f.engine.acceptSourceBytes(new Uint8Array([65]),1,1);
  expect(result).toEqual({status:'error',code:'unsupported',message:'VT expansion budget'});
  expect(f.counts().journals).toBe(0);
  expect(f.ports.admission.heldBytes).toBe(0);
  expect(f.ports.scratch.heldBytes).toBe(0);
});

// Round 4: atomic VT output pages, independent of source-byte packetization.
test('NEWARCH C atomic clear streams exact rows with a byte cap and replayable continuation', () => {
  const script=String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
identity={'pane':{'serverIdentity':'fixture','paneId':'%1','birthGeneration':1},'sourceEpoch':1,'geometryGeneration':0}
w=m.Worker(80,80);w.screen.scroll_on_clear=True
w.feed(1,1,b'\r\n'.join(bytes([65+y%26])*80 for y in range(80)));w.scrolls=[]
state=w.contract_state()
for data in [b'\x1b[2J',b'\x1b[80S',b'\x1bc']:
    oracle=m.Worker.from_checkpoint(m.decode_extension(state['extensionState']))
    oracle.feed(2,1,data)
    expected=[m.contract_row(x['row'],x['wrap'],x['pad']) for x in oracle.scrolls]
    request={'state':state,'identity':identity,'geometry':state['geometry'],'scrollOnClear':True,'screenRevision':1,
      'event':{'identity':identity,'position':{'sourceEpoch':1,'packetSeq':2},'payload':{'kind':'bytes','bytes':list(data)}},
      'rowStream':{'startOrdinal':0,'maxBytes':262144}}
    actual=[];pages=0
    while True:
        page=m.checkpoint_transaction(request)
        assert page==m.checkpoint_transaction(request), 'retry must reproduce the same page'
        assert page['startOrdinal']==len(actual)
        assert page['nextOrdinal']==len(actual)+len(page['scrolls'])
        assert len(page['scrolls'])<=256
        assert page['chargedBytes']<=page['peakBytes']<=262144
        assert len(json.dumps(page['scrolls'],ensure_ascii=False,separators=(',',':')).encode())*4<=262144
        actual.extend(page['scrolls']);pages+=1
        if page['complete']:
            assert page['state']==oracle.contract_state()
            break
        assert 'state' not in page and 'frame' not in page
        assert page['nextOrdinal']>request['rowStream']['startOrdinal']
        request['rowStream']['startOrdinal']=page['nextOrdinal']
    assert actual==expected and pages>1, (len(actual),len(expected),pages)
    assert state==w.contract_state(), 'source checkpoint mutated'
# The collector must bypass Worker.scrolls altogether, even inside one CSI.
original=m.Worker._on_scroll
m.Worker._on_scroll=lambda *args: (_ for _ in ()).throw(AssertionError('whole-packet collector called'))
request['rowStream']['startOrdinal']=0
assert not m.checkpoint_transaction(request)['complete']
m.Worker._on_scroll=original
for cap in [0,8,524289]:
    request['rowStream']={'startOrdinal':0,'maxBytes':cap}
    try: m.checkpoint_transaction(request)
    except (ValueError,m.CaptureExpansionPressure): pass
    else: raise AssertionError('invalid/undersized cap accepted')
print('atomic clear/scroll/reset: exact rows, replay, no whole-packet collector, per-page cap=262144')
`;
  const r=Bun.spawnSync(['python3','-B','-c',script,new URL('../src/pipe-vt-worker.py',import.meta.url).pathname]);
  expect(r.exitCode,r.stderr.toString()).toBe(0);
},30000);

test('NEWARCH C stream adapter pulls one page at a time and installs only the completed candidate', async () => {
  const {CheckpointCaptureVt}=await import('../src/pipe-vt-worker');
  const state={geometry:cFrame().geometry} as import('../src/stream-contract').VtState;
  const frame=cFrame();let calls=0;
  const rpc: import('../src/pipe-vt-worker').CaptureVtRpc={transaction:async request=>{
    if (!request.rowStream) return {status:'ok',value:{state,frame,scrolls:[]}};
    calls++;
    const start=request.rowStream.startOrdinal;
    const scrolls=[cRow(start)];const page={startOrdinal:start,nextOrdinal:start+1,scrolls,
      chargedBytes:Buffer.byteLength(JSON.stringify(scrolls))*4};
    return {status:'ok',value:start===0 ? {...page,complete:false} : {...page,complete:true,state,
      frame:{...frame,screenRevision:2}}};
  }};
  const created=await CheckpointCaptureVt.create(rpc,cIdentity,state.geometry,false);
  if(created.status!=='ok')throw Error('create');
  const vt=created.value;const stream=vt.prepareStream(cInput(1));
  expect(calls).toBe(0);
  const first=(await stream.next()).value;
  if(!first || first.status!=='ok')throw Error('first page');
  expect(first.value.candidate).toBeUndefined();expect(calls).toBe(1);
  expect(vt.screen().screenRevision).toBe(1);
  const last=(await stream.next()).value;
  if(!last || last.status!=='ok' || !last.value.candidate)throw Error('last page');
  expect(last.value.startOrdinal).toBe(1);expect(calls).toBe(2);
  last.value.candidate.install();expect(vt.screen().screenRevision).toBe(2);
  expect(()=>last.value.candidate!.install()).toThrow();
  await stream.return();
  const dropped=vt.prepareStream(cInput(2));await dropped.next();
  const end=(await dropped.next()).value;
  if(!end || end.status!=='ok' || !end.value.candidate)throw Error('drop candidate');
  await dropped.return();expect(()=>end.value.candidate!.install()).toThrow();
  expect(vt.screen().screenRevision).toBe(2);
});

test('NEWARCH C stream adapter rejects a nonadvancing or over-budget continuation', async () => {
  const {CheckpointCaptureVt}=await import('../src/pipe-vt-worker');
  for(const fault of ['cursor','bytes']){
    const state={geometry:cFrame().geometry} as import('../src/stream-contract').VtState;
    const rpc: import('../src/pipe-vt-worker').CaptureVtRpc={transaction:async request=>({status:'ok',value:
      !request.rowStream ? {state,frame:cFrame(),scrolls:[]} : {complete:false,startOrdinal:0,
        nextOrdinal:fault==='cursor'?0:1,scrolls:fault==='cursor'?[]:[cRow(0)],chargedBytes:fault==='bytes'?524289:8}})};
    const made=await CheckpointCaptureVt.create(rpc,cIdentity,state.geometry,false);
    if(made.status!=='ok')throw Error('create');
    const stream=made.value.prepareStream(cInput(1));
    expect((await stream.next()).value).toMatchObject({status:'error',code:'integrity'});
    expect((await stream.next()).done).toBe(true);
    expect(made.value.screen()).toEqual(cFrame());
  }
});

// Contract repair: exercise the actual C -> SQLite H boundary, never an echo H.
import { StreamHistoryEngine, streamDigest } from '../src/history-engine';
for (const count of [1, 2, 600]) test(`NEWARCH contract real C-H ${count} rows survives checkpoint and reopen`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-seam-'));
  const path = join(dir, 'history.sqlite');
  let history = new StreamHistoryEngine({ path, codecVersions: ['seam-v1'] });
  try {
    const f = cEngineFixture();
    const geometry = cFrame().geometry, cursor = cFrame().cursor;
    const buffer = { rows: [], cursor, savedCursor: cursor, savedAttributes: [], savedModes: {}, wrapPending: false };
    const state = { codecVersion: 'seam-v1', geometry, normal: buffer, alternate: buffer,
      active: 'normal' as const, modes: {}, margins: { top: 0, bottom: geometry.rows - 1, left: 0, right: geometry.columns - 1 },
      tabStops: [], pendingUtf8: [], pendingEscape: [], attributes: [], wrapPending: false, extensionState: '{}' };
    const rows = Array.from({ length: count }, (_, i) => ({ cells: [{ text: `row-${i}`, width: 1 as const, style: [31] }],
      softWrap: false, wrapPad: 0, uncertainFields: [] }));
    f.ports.vt.prepare = async event => ({ status: 'ok', value: { frame: { ...cFrame(), identity: event.identity },
      scrolls: rows, snapshot: async () => ({ status: 'ok', value: state }), install() {}, discard() {} } });
    f.ports.vt.snapshot = async () => ({ status: 'ok', value: state });
    const engine = new StreamCaptureEngine({ ...f.ports, history });
    const frames: LiveFrame[] = []; engine.subscribe(cPane, frame => frames.push(frame));
    expect((await engine.acceptInput(cInput(1))).status).toBe('ok');
    expect(frames.at(-1)?.head).toBe(count);
    expect((await engine.checkpoint(cPane, 'handoff')).status).toBe('ok');
    history.close(); history = new StreamHistoryEngine({ path, codecVersions: ['seam-v1'] });
    const grant = await history.grantReadView({ requestId: `rows-${count}`, identity: cIdentity,
      routeGeneration: 1, range: { start: 0, end: count }, deadlineMonoMs: performance.now() + 1000 });
    if (grant.status !== 'ok') throw Error(JSON.stringify(grant));
    const ack = await history.openReadView(grant.value);
    if (ack.status !== 'ok') throw Error(JSON.stringify(ack));
    const seen: string[] = []; let cursorPage = null;
    do {
      const page = await history.readPage(ack.value, cursorPage, 256, { isCancelled: () => false });
      if (page.status !== 'ok') throw Error(JSON.stringify(page));
      seen.push(...page.value.fragments.map(fragment => fragment.row.cells[0]!.text));
      cursorPage = page.value.nextAfter;
    } while (cursorPage);
    expect(seen).toEqual(rows.map(row => row.cells[0]!.text));
    await history.releaseReadView(grant.value, 'done');
    if (count === 1) {
      const recovery = history.recover(cPane,null,{isCancelled:()=>false})[Symbol.asyncIterator]();
      const recovered = (await recovery.next()).value;
      if(recovered?.status!=='ok' || recovered.value.kind!=='checkpoint') throw Error('missing checkpoint');
      const oldCp = recovered.value.checkpoint; await recovery.return?.();
      // C uses the reopened real H; no digest/receipt echo mock at this seam.
      const metrics: any[] = [];
      let episode: import('../src/stream-contract').GapEpisode;
      let inputFence: import('../src/stream-contract').DurableInputReceipt;
      const restoredFrame = {...cFrame(),head:count,revision:oldCp.revision,durableRevision:oldCp.revision};
      const repairPorts: CapturePorts = {...f.ports,history,initial:restoredFrame,observer:{record:m=>metrics.push(m)},
        repairChunks:async function* () {
          const row={...rows[0]!,id:{pane:cPane,lineId:1},revision:oldCp.revision+1,
            source:{pane:cPane,sourceEpoch:1,packetSeq:2,scrollOrdinal:0},geometry,geometryGeneration:cIdentity.geometryGeneration};
          const body={episode,chunkId:'real-final',expectedRevision:oldCp.revision,rows:[row],final:true};
          yield {status:'ok',value:{...body,digest:streamDigest('repair',body)}};
        },
        syncRepair:async (_chunk,r)=>({...cFrame(),head:2,revision:r.committedRevision,durableRevision:r.durable.durableRevision}),
        verifyRepair:async()=>true,
        repairedCheckpoint:async()=>({status:'ok',value:{...oldCp,checkpointId:'real-repaired',
          previousCheckpointId:oldCp.checkpointId,revision:oldCp.revision+1,head:2,inputFence}}),
      };
      repairPorts.vt.restore=async()=>({status:'ok',value:{frame:cFrame(),scrolls:[],install(){},discard(){}}});
      const repaired=new StreamCaptureEngine(repairPorts);
      episode=repaired.fault('eof');
      const input=await history.journalInput(cInput(2));
      if(input.status!=='ok')throw Error(JSON.stringify(input)); inputFence=input.value;
      const suffix={identity:cIdentity,eventId:{pane:cPane,sourceEpoch:1,packetSeq:2,scrollOrdinal:0},
        expectedRevision:oldCp.revision,rows:[],frameDelta:cFrame(),receivedAtMonoMs:1};
      expect(await history.appendFinalized({...suffix,digest:streamDigest('append',suffix)}))
        .toMatchObject({status:'stale',reason:'late-gap'});
      const results=[];for await(const r of repaired.repair(episode,{isCancelled:()=>false}))results.push(r);
      expect(results).toHaveLength(1);expect(results[0]).toMatchObject({status:'ok',value:{complete:true}});
      expect(metrics.find(m=>m.kind==='gap' && m.episode.status==='repaired')?.episode.missingCount).toBeNull();
      history.close();history=new StreamHistoryEngine({path,codecVersions:['seam-v1']});
      const replay=history.recover(cPane,null,{isCancelled:()=>false})[Symbol.asyncIterator]();
      expect((await replay.next()).value).toMatchObject({status:'ok',value:{kind:'checkpoint',checkpoint:{checkpointId:'real-repaired',head:2}}});
      await replay.return?.();
    }
  } finally { history.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('contract collector retains oversize rows until sink accepts the exact event', async () => {
  const { PipeHistoryCollector } = await import('../src/pipe-history-collector');
  const offered: unknown[] = [];
  let allow = false;
  // Drive the real collector admission path without opening a live parser.
  const collector = new PipeHistoryCollector({ paneKey: cPane, sourceEpoch: 1, cols: 80, rows: 24, retainOversize: true,
    ports: { onScroll(event: unknown) { offered.push(event); return allow ? undefined : {accepted:false,reason:'ingest-oversize'}; }, onFrame() {}, onFault() {} },
  } as any);
  const event = {receiveSeq:1};
  const waiting = (collector as any).offerScrolls([event],0);
  await Bun.sleep(15); expect(offered.length).toBeGreaterThan(1);
  expect(offered.every(x => x === event)).toBe(true);
  allow = true; await waiting;
  expect((collector as any).scrollCount).toBe(1);
  expect((collector as any).oversizeDrops).toBe(0);
});

test('contract maximum geometry checkpoint uses compact full buffers and reuses scratch Worker', async () => {
  const script = String.raw`
import importlib.util,sys,json
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
w=m.Worker(240,80); w.screen.scroll_on_clear=False
w.feed(1,1,b'X'*(240*80)); w.feed(2,1,b'\x1b[?1049h'+b'Y'*(240*80)); w.scrolls=[]
state=w.contract_state()
assert len(json.dumps(state,separators=(',',':')).encode())*2 < 2*1024*1024
identity={'pane':{'serverIdentity':'test','paneId':'%1','birthGeneration':1},'sourceEpoch':1,'geometryGeneration':0}
request={'state':state,'identity':identity,'geometry':state['geometry'],'scrollOnClear':False,'screenRevision':1}
r=m.checkpoint_transaction(request); scratch=m._transaction_scratch
assert r['state']==state
assert len(r['frame']['changedRows'])==80
assert all(len(row['content']['cells'])==240 for row in r['frame']['changedRows'])
for _ in range(10):
    assert m.checkpoint_transaction(request)==r
    assert m._transaction_scratch is scratch
assert m.Worker.from_checkpoint(m.decode_extension(state['extensionState'])).export_checkpoint()==w.export_checkpoint()
print(json.dumps({'state':state,'frame':r['frame']}))
`;
  const r = Bun.spawnSync(['python3','-B','-c',script,new URL('../src/pipe-vt-worker.py',import.meta.url).pathname]);
  expect(r.exitCode,r.stderr.toString()).toBe(0);
  const native=JSON.parse(r.stdout.toString());
  const dir=mkdtempSync(join(tmpdir(),'native-max-contract-'));
  const path=join(dir,'history.sqlite');
  let history=new StreamHistoryEngine({path,codecVersions:[native.state.codecVersion]});
  try {
    const f=cEngineFixture(), frame={...native.frame,identity:cIdentity};
    f.ports.vt.prepare=async()=>({status:'ok',value:{frame,scrolls:[],install(){},discard(){}}});
    f.ports.vt.snapshot=async()=>({status:'ok',value:native.state});
    const engine=new StreamCaptureEngine({...f.ports,history,initial:{...frame,head:0,revision:0,durableRevision:0}});
    expect((await engine.acceptInput(cInput(1))).status).toBe('ok');
    const cp=await engine.checkpoint(cPane,'handoff');
    expect(cp.status).toBe('ok');
    history.close();history=new StreamHistoryEngine({path,codecVersions:[native.state.codecVersion]});
    const recovery=history.recover(cPane,null,{isCancelled:()=>false})[Symbol.asyncIterator]();
    expect((await recovery.next()).value).toMatchObject({status:'ok',value:{kind:'checkpoint',checkpoint:{state:native.state}}});
    await recovery.return?.();
  } finally {history.close();rmSync(dir,{recursive:true,force:true});}
});

test('contract RPC allocation reuses a Worker across distinct packets', () => {
  const script=String.raw`
import importlib.util,sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
identity={'pane':{'serverIdentity':'fixture','paneId':'%1','birthGeneration':1},'sourceEpoch':1,'geometryGeneration':0}
request={'state':None,'identity':identity,'geometry':{'columns':12,'rows':3},'scrollOnClear':False,'screenRevision':0}
r=m.checkpoint_transaction(request); scratch=m._transaction_scratch
for seq in range(1,11):
    request['state']=r['state'];request['screenRevision']=seq
    request['event']={'identity':identity,'position':{'sourceEpoch':1,'packetSeq':seq},'payload':{'kind':'bytes','bytes':[65]}}
    r=m.checkpoint_transaction(request)
    assert m._transaction_scratch is scratch, 'Worker allocated for a subsequent packet'
assert r['frame']['changedRows'][0]['content']['cells'][0]['text']=='A'
`;
  const r=Bun.spawnSync(['python3','-B','-c',script,new URL('../src/pipe-vt-worker.py',import.meta.url).pathname]);
  expect(r.exitCode,r.stderr.toString()).toBe(0);
});

test('repair r2 oversized OSC checkpoint resumes discard until split ST then normal text', () => {
  const script = String.raw`
import importlib.util,sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
w=m.Worker(80,3);w.screen.scroll_on_clear=False
w.feed(1,1,b'before\r\n\x1b]52;c;'+b'A'*(70*1024))
assert w.stream.discard_sequence=='osc'
assert w.stream.pending_bytes==0
w=m.Worker.from_checkpoint(w.export_checkpoint())
w.feed(2,1,b'A'*(30*1024)+b'\x1b')
w=m.Worker.from_checkpoint(w.export_checkpoint())
w.feed(3,1,b'\\after')
assert w.stream.discard_sequence==''
assert w.stream.discarded_sequences==1
assert w.screen.display[0].strip()=='before'
assert w.screen.display[1].strip()=='after'
`;
  const r = Bun.spawnSync(['python3','-B','-c',script,new URL('../src/pipe-vt-worker.py',import.meta.url).pathname]);
  expect(r.exitCode,r.stderr.toString()).toBe(0);
});

// ---------------------------------------------------------------------------
// NEWARCH flag-on C: stitch v1 (ST-01 / ST-02). Expected decisions are written
// by hand from the synthetic producer events below, never computed by the
// stitcher. Rows are separate events even when their cells repeat.
import {
  StreamStitcher, KnownStateTracker, captureStitchRows, stitchRowKey, baselineCellOrigins,
} from '../src/stream-stitch';
import type * as SC from '../src/stream-contract';
import { cellToSemanticCell, gapIdentity, semanticStyleToSgr } from '../src/stream-contract';
import { STITCH_ORACLE_VECTORS } from './fixtures/stitch-oracle-vectors';

const stPane: SC.PaneKey = { serverIdentity: 'st-server', paneId: '%7', birthGeneration: 3 };
const stEpoch: SC.PipeEpoch = { pane: stPane, attachId: 'attach-st', collectorIncarnation: 'collector-st' };
const stHex = 'a'.repeat(64);
const stFile: SC.EvidenceFile = { path: 'synthetic/st.bin', bytes: 1, sha256: stHex };
const stGeometry = { columns: 80, rows: 24 } as const;
const stPolicy: SC.StitchPolicy = { version: 1, minAnchorRows: 8, minDistinctKeys: 4, minNonblankRows: 2, maxCandidates: 4096, deadlineMs: 100 };
const CAPTURE_START = 100; const CAPTURE_END = 140;
const certified: SC.BoundaryEvidence = {
  kind: 'certified-same-turn', pane: stPane, epoch: stEpoch, geometry: stGeometry, binarySha256: stHex, hookConfigSha256: stHex,
  transcript: stFile, eventCoverage: stFile, pipeOpenEvent: 'e1', captureStartEvent: 'e2', captureEndEvent: 'e3',
  rawStart: { epoch: stEpoch, byteOffset: CAPTURE_START }, certificateId: 'cert-st',
};
const unknownBoundary: SC.BoundaryEvidence = { kind: 'overlap-unknown', reason: 'split-command' };
const genesis = { kind: 'vt-recovery' } as unknown as SC.VtCheckpoint;
const birthBoundary: SC.BoundaryEvidence = { kind: 'birth', pane: stPane, epoch: stEpoch, genesis, firstByteOffset: 0, transcript: stFile };
function stPacket(over: Partial<SC.CapturePacket> = {}): SC.CapturePacket {
  return {
    version: 1, snapshotId: 'snap-st', episodeId: 'ep-st', captureCount: 1, complete: true, pane: stPane,
    geometry: stGeometry, geometryGeneration: 1, historySize: 4500, historyLimit: 4500,
    cursor: { x: 0, y: 0, visible: true }, activeBuffer: 'normal', mainHistory: 'available',
    snapshot: stFile, commandTranscript: stFile, rawRange: { epoch: stEpoch, start: CAPTURE_START, end: CAPTURE_END },
    boundary: certified, startedAtMonoMs: 10, endedAtMonoMs: 11, clockEpoch: 'clock-st', stateKnown: {}, ...over,
  };
}
type RowOpts = { finalized?: boolean; wrap?: SC.StitchRow['wrapStatus']; style?: number[]; uncertain?: string[]; columns?: number; cellOrigins?: SC.RowOrigin[] };
function stRow(text: string, origin: SC.RowOrigin, o: RowOpts = {}): SC.StitchRow {
  const cells = Array.from(text, ch => ({ text: ch, width: 1 as const, style: o.style ?? [] }));
  return {
    origin, cells, geometry: { columns: o.columns ?? 80, rows: 24 }, buffer: 'normal', wrapStatus: o.wrap ?? 'unwrapped',
    wrapPad: 0, finalized: o.finalized ?? true, uncertainFields: o.uncertain ?? [], cellOrigins: o.cellOrigins ?? cells.map(() => origin),
  };
}
const durableId = (i: number): SC.SegmentRowId => ({ pane: stPane, segmentId: 'seg-old', rowOrdinal: i });
const tailOf = (texts: readonly string[], o: RowOpts = {}): SC.StitchWindow =>
  ({ pane: stPane, rows: texts.map((t, i) => stRow(t, { kind: 'durable', rowId: durableId(i) }, o)) });
const capOrigin = (i: number): SC.RowOrigin => ({ kind: 'capture', snapshotId: 'snap-st', rowIndex: i });
function captureOf(texts: readonly string[], packet = stPacket(), screen = 0): SC.CaptureWindow {
  return { pane: stPane, packet, rows: texts.map((t, i) => stRow(t, capOrigin(i), { finalized: i < texts.length - screen })) };
}
const pipeOrigin = (start: number, end = start + 1, ordinal = 0): SC.RowOrigin => ({ kind: 'pipe', range: { epoch: stEpoch, start, end }, ordinal });
function pipeOf(rows: readonly SC.StitchRow[], start = CAPTURE_START): SC.PipeWindow {
  return { pane: stPane, rawRange: { epoch: stEpoch, start, end: 10_000 }, rows };
}
const pipeRow = (text: string, offset: number, o: RowOpts = {}) => stRow(text, pipeOrigin(offset, offset + text.length + 1), o);
const mapping = (tailLen: number): SC.SeamProof => ({
  kind: 'recorded-mapping', range: { epoch: stEpoch, start: 0, end: CAPTURE_START }, checkpointId: 'ck-st', mapping: stFile,
  coverage: [{ kind: 'rows', range: { pane: stPane, segmentId: 'seg-old', start: 0, end: tailLen }, digest: stHex }],
});
const pipeMapping: SC.SeamProof = { kind: 'recorded-mapping', range: { epoch: stEpoch, start: 0, end: CAPTURE_END + 10 }, checkpointId: 'ck-p', mapping: stFile, coverage: [] };
function stProofs(tailToCapture: SC.SeamProof[], captureToPipe: SC.SeamProof[] = [{ kind: 'independent-boundary', boundary: certified as Exclude<SC.BoundaryEvidence, { kind: 'overlap-unknown' }> }]): SC.StitchProofs {
  return { policy: stPolicy, episodeId: 'ep-st', tailToCapture, captureToPipe };
}
const sources = (r: SC.StitchResult) => r.status === 'error' ? [] : r.acceptedRowMap.map(a =>
  a.source.kind === 'capture' ? `C${a.source.rowIndex}` : a.source.kind === 'pipe' ? `P${a.source.range.start}` : 'T');
const letters = 'abcdefghijklmnop'.split('');

describe('NEWARCH C stitch v1 ST-01 content candidates and proof gate', () => {
  test('K literal oracle vectors give the K literal decisions', async () => {
    const stitcher = new StreamStitcher();
    const seen: Record<string, string> = {};
    for (const v of STITCH_ORACLE_VECTORS) {
      let result: SC.StitchResult;
      if (v.proof === 'genesis-byte-zero') {
        const packet = stPacket({ boundary: birthBoundary, rawRange: { epoch: stEpoch, start: 0, end: 0 }, historySize: 0 });
        result = await stitcher.stitch(tailOf(v.tail), captureOf(v.capture, packet), pipeOf([pipeRow('first', 0)], 0),
          stProofs([], [{ kind: 'independent-boundary', boundary: birthBoundary as Exclude<SC.BoundaryEvidence, { kind: 'overlap-unknown' }> }]));
      } else {
        const proofs = v.proof === 'recorded-mapping-and-boundary' ? [mapping(v.tail.length)] : [];
        result = await stitcher.stitch(tailOf(v.tail), captureOf(v.capture), pipeOf([]), stProofs(proofs));
      }
      seen[v.id] = result.status;
    }
    expect(seen).toEqual({
      'ST-short-7': 'unproven', 'ST-unique-reprinted-8': 'unproven', 'ST-multiple': 'ambiguous',
      'ST-blank': 'unproven', 'ST-proven-8': 'matched', 'ST-zero-birth': 'matched',
    });
  });

  test('7 proven rows are a short anchor; 8 proven rows stitch and keep only the new capture row', async () => {
    const s = new StreamStitcher();
    const seven = await s.stitch(tailOf(letters.slice(0, 7)), captureOf([...letters.slice(0, 7), 'x']), pipeOf([]), stProofs([mapping(7)]));
    expect(seven.status === 'unproven' && seven.reason).toBe('short-anchor');
    expect(sources(seven)).toEqual([]);
    const eight = await s.stitch(tailOf(letters.slice(0, 8)), captureOf([...letters.slice(0, 8), 'x']), pipeOf([]), stProofs([mapping(8)]));
    expect(eight.status).toBe('matched');
    expect(sources(eight)).toEqual(['C8']);
    expect(eight.status !== 'error' && eight.gaps).toEqual([]);
    expect(eight.status !== 'error' && eight.acceptedRowMap[0]!.target.rowOrdinal).toBe(0);
  });

  test('unique reprinted block without proof is a gap after T, never matched', async () => {
    const r = await new StreamStitcher().stitch(tailOf(letters.slice(0, 8)), captureOf(letters.slice(0, 10)), pipeOf([]), stProofs([]));
    expect(r.status === 'unproven' && r.reason).toBe('content-only');
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.acceptedRowMap).toEqual([]);
    expect(r.withheldRanges).toEqual([{ source: 'capture', start: 0, end: 10, reason: 'unproven' }]);
    expect(r.gaps.length).toBe(1);
    expect(r.gaps[0]).toMatchObject({ leftRowId: durableId(7), reason: 'unproven-overlap', countKind: 'unknown', missingCount: null, withheldRows: 10 });
  });

  test('fewer than 4 distinct keys or fewer than 2 nonblank rows never anchor, even with a proof', async () => {
    const s = new StreamStitcher();
    const three = ['x', 'a', 'a', 'a', 'a', 'a', 'a', 'b'];
    const lowDistinct = await s.stitch(tailOf(three), captureOf([...three, 'n']), pipeOf([]), stProofs([mapping(8)]));
    expect(lowDistinct.status === 'unproven' && lowDistinct.reason).toBe('content-only');
    const blanks = ['', ' ', '  ', '   ', '    ', '     ', '      ', 'a'];
    const oneNonblank = await s.stitch(tailOf(blanks), captureOf([...blanks, 'z']), pipeOf([]), stProofs([mapping(8)]));
    expect(oneNonblank.status === 'unproven' && oneNonblank.reason).toBe('content-only');
  });

  test('ABAB and spinner screens have several alignments: ambiguous even with a valid proof', async () => {
    const s = new StreamStitcher();
    const abab = await s.stitch(tailOf('abababab'.split('')), captureOf('ababababab'.split('')), pipeOf([]), stProofs([mapping(8)]));
    expect(abab.status).toBe('ambiguous');
    expect(abab.status === 'ambiguous' && [abab.reason, abab.candidateCount]).toEqual(['multiple-alignments', 5]);
    expect(sources(abab)).toEqual([]);
    expect(abab.status !== 'error' && abab.gaps[0]!.reason).toBe('ambiguous-overlap');
    const spin = ['|', '/', '-', '\\', '|', '/', '-', '\\'];
    const spinner = await s.stitch(tailOf(spin), captureOf([...spin, ...spin.slice(0, 4)]), pipeOf([]), stProofs([mapping(8)]));
    expect(spinner.status === 'ambiguous' && spinner.candidateCount).toBe(3); // ends 4, 8, 12
  });

  test('blank full screen offers no candidate at all', async () => {
    const blank = Array(8).fill('');
    const r = await new StreamStitcher().stitch(tailOf(blank), captureOf([...blank, ...blank]), pipeOf([]), stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('content-only');
  });

  test('a constant hash cannot make different rows equal, nor equal rows ambiguous', async () => {
    const s = new StreamStitcher({ hash: () => 'collide' });
    const proven = await s.stitch(tailOf(letters.slice(0, 8)), captureOf([...letters.slice(0, 8), 'x']), pipeOf([]), stProofs([mapping(8)]));
    expect(proven.status).toBe('matched');
    expect(sources(proven)).toEqual(['C8']);
    const changed = await s.stitch(tailOf(letters.slice(0, 8)), captureOf([...letters.slice(0, 7), 'H', 'x']), pipeOf([]), stProofs([mapping(8)]));
    expect(changed.status === 'unproven' && changed.reason).toBe('content-only');
  });

  test('row keys keep spaces, combining marks, CJK width, style and wrap; nothing is normalized', () => {
    const o = capOrigin(0);
    const key = (r: SC.StitchRow) => stitchRowKey(r);
    const base = stRow('h', o);
    expect(key(stRow('h ', o))).not.toBe(key(base));
    expect(key(stRow('é', o))).not.toBe(key({ ...stRow('e', o), cells: [{ text: 'é', width: 1, style: [] }] }));
    expect(key({ ...base, cells: [{ text: '你', width: 2, style: [] }] })).not.toBe(key({ ...base, cells: [{ text: '你', width: 1, style: [] }] }));
    expect(key(stRow('h', o, { style: [1] }))).not.toBe(key(base));
    expect(key(stRow('h', o, { wrap: 'wrapped' }))).not.toBe(key(base));
    expect(key(stRow('h', o, { columns: 81 }))).not.toBe(key(base));
    expect(key(stRow('ก่', o))).toBe(key(stRow('ก่', capOrigin(5))));
    expect(key(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('trailing-space difference breaks the overlap; unknown wrap still finds the candidate', async () => {
    const s = new StreamStitcher();
    const t = tailOf(letters.slice(0, 8));
    const spaced = await s.stitch(t, captureOf([...letters.slice(0, 7), 'h ', 'x']), pipeOf([]), stProofs([mapping(8)]));
    expect(spaced.status === 'unproven' && spaced.reason).toBe('content-only');
    const cap = captureOf([...letters.slice(0, 8), 'x']);
    const unknownWrap = { ...cap, rows: cap.rows.map(r => ({ ...r, wrapStatus: 'unknown' as const })) };
    const r = await s.stitch(t, unknownWrap, pipeOf([]), stProofs([mapping(8)]));
    expect(r.status).toBe('matched');
    expect(sources(r)).toEqual(['C8']);
  });

  test('more than 4096 candidates stops the search as ambiguity', async () => {
    const r = await new StreamStitcher().stitch(tailOf(['a']), captureOf(Array(5000).fill('a')), pipeOf([]), stProofs([mapping(1)]));
    expect(r.status === 'ambiguous' && [r.reason, r.candidateCount]).toEqual(['candidate-limit', 4097]);
  });

  test('time budget exhaustion returns unproven deadline, not a guess', async () => {
    let t = 0;
    const r = await new StreamStitcher({ now: () => (t += 200) }).stitch(tailOf(letters.slice(0, 8)), captureOf([...letters.slice(0, 8), 'x']), pipeOf([]), stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('deadline');
    expect(sources(r)).toEqual([]);
  });

  test('a mapping from another epoch or not covering the last durable row is not a proof', async () => {
    const s = new StreamStitcher();
    const other = { ...mapping(8), range: { epoch: { ...stEpoch, collectorIncarnation: 'old' }, start: 0, end: CAPTURE_START } } as SC.SeamProof;
    const short = mapping(7);
    for (const proof of [other, short]) {
      const r = await s.stitch(tailOf(letters.slice(0, 8)), captureOf([...letters.slice(0, 8), 'x']), pipeOf([]), stProofs([proof]));
      expect(r.status === 'unproven' && r.reason).toBe('content-only');
    }
  });

  test('a weakened runtime policy is rejected as integrity error', async () => {
    const weak = { ...stProofs([mapping(8)]), policy: { ...stPolicy, minAnchorRows: 1 } as unknown as SC.StitchPolicy };
    const r = await new StreamStitcher().stitch(tailOf(letters.slice(0, 8)), captureOf(letters.slice(0, 9)), pipeOf([]), weak);
    expect(r.status === 'error' && r.code).toBe('integrity');
  });
});

describe('NEWARCH C stitch v1 ST-02 seams, origin tags and known state', () => {
  const T8 = tailOf(letters.slice(0, 8));
  const C12 = () => captureOf([...letters.slice(0, 8), 'i', 'j', 'k', 'l'], stPacket(), 2); // k,l are screen rows

  test('certified same-turn boundary: zero byte overlap, baseline cells finalize once', async () => {
    const P = pipeOf([
      stRow('k', pipeOrigin(100), { cellOrigins: baselineCellOrigins('snap-st', 10, 1) }), // screen row k scrolls
      stRow('k', pipeOrigin(101), { cellOrigins: baselineCellOrigins('snap-st', 10, 1) }), // same baseline row again
      stRow('l!', pipeOrigin(102, 104), { cellOrigins: [capOrigin(11), pipeOrigin(102, 104)] }), // edited screen row
      stRow('j', pipeOrigin(104), { cellOrigins: baselineCellOrigins('snap-st', 9, 1) }), // already accepted history row
      pipeRow('new', 105),
      pipeRow('tail', 109, { finalized: false }),
    ]);
    const r = await new StreamStitcher().stitch(T8, C12(), P, stProofs([mapping(8)]));
    expect(r.status).toBe('matched');
    expect(sources(r)).toEqual(['C8', 'C9', 'P100', 'P102', 'P105']);
    expect(r.status !== 'error' && r.acceptedRowMap.map(a => a.target.rowOrdinal)).toEqual([0, 1, 2, 3, 4]);
    expect(r.status !== 'error' && [r.gaps, r.withheldRanges]).toEqual([[], []]);
  });

  test('normal repeated rows keep their real count', async () => {
    const P = pipeOf([pipeRow('ok', 100), pipeRow('ok', 103), pipeRow('ok', 106)]);
    const cap = captureOf([...letters.slice(0, 8), 'ok', 'ok']);
    const r = await new StreamStitcher().stitch(T8, cap, P, stProofs([mapping(8)]));
    expect(r.status).toBe('matched');
    expect(sources(r)).toEqual(['C8', 'C9', 'P100', 'P103', 'P106']);
  });

  test('split attach without proof withholds the pipe prefix and resumes on the verified suffix', async () => {
    const packet = stPacket({ boundary: unknownBoundary });
    const P = pipeOf([pipeRow('i', 100), pipeRow('j', 120), pipeRow('m', CAPTURE_END), pipeRow('n', CAPTURE_END + 2)]);
    const r = await new StreamStitcher().stitch(T8, captureOf([...letters.slice(0, 8), 'i', 'j'], packet), P, stProofs([mapping(8)], []));
    expect(r.status === 'unproven' && r.reason).toBe('content-only');
    if (r.status === 'error') throw new Error('unexpected');
    expect(sources(r)).toEqual(['C8', 'C9', `P${CAPTURE_END}`, `P${CAPTURE_END + 2}`]);
    expect(r.withheldRanges).toEqual([{ source: 'pipe', start: 0, end: 2, reason: 'unproven' }]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ leftRowId: r.acceptedRowMap[1]!.target, withheldRows: 2, countKind: 'unknown', missingCount: null });
  });

  test('split attach with a mapping proof removes exactly the proven overlap', async () => {
    const packet = stPacket({ boundary: unknownBoundary });
    const hist = [...letters.slice(0, 8), ...'qrstuvwx'.split('')];
    const P = pipeOf([...'qrstuvwx'.split('').map((c, i) => pipeRow(c, 100 + i * 2)), pipeRow('y', 130), pipeRow('z', 132)]);
    const r = await new StreamStitcher().stitch(T8, captureOf(hist, packet), P, stProofs([mapping(8)], [pipeMapping]));
    expect(r.status).toBe('matched');
    expect(sources(r)).toEqual(['C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'P130', 'P132']);
  });

  test('split attach with a periodic overlap is ambiguous and keeps the prefix withheld', async () => {
    const packet = stPacket({ boundary: unknownBoundary });
    const hist = [...letters.slice(0, 8), ...'abababab'.split('')];
    const P = pipeOf([...'ababababab'.split('').map((c, i) => pipeRow(c, 100 + i * 2)), pipeRow('z', CAPTURE_END)]);
    const r = await new StreamStitcher().stitch(T8, captureOf(hist, packet), P, stProofs([mapping(8)], [pipeMapping]));
    expect(r.status === 'ambiguous' && r.reason).toBe('multiple-alignments');
    expect(sources(r).slice(-1)).toEqual([`P${CAPTURE_END}`]);
    expect(r.status !== 'error' && r.withheldRanges).toEqual([{ source: 'pipe', start: 0, end: 10, reason: 'unproven' }]);
  });

  test('rows depending on unknown VT state are withheld under a gap; later certain rows resume', async () => {
    const P = pipeOf([pipeRow('x', 100, { uncertain: ['sgr'] }), pipeRow('y', 102, { uncertain: ['savedCursor'] }), pipeRow('z', 104)]);
    const r = await new StreamStitcher().stitch(T8, captureOf(letters.slice(0, 9)), P, stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('unknown-state');
    if (r.status === 'error') throw new Error('unexpected');
    expect(sources(r)).toEqual(['C8', 'P104']);
    expect(r.withheldRanges).toEqual([{ source: 'pipe', start: 0, end: 2, reason: 'unknown-state' }]);
    expect(r.gaps.map(g => [g.reason, g.withheldRows, g.leftRowId?.rowOrdinal])).toEqual([['unknown-vt-state', 2, 0]]);
  });

  test('alternate screen capture cannot seam history; baseline-tainted pipe rows are quarantined', async () => {
    const packet = stPacket({ activeBuffer: 'alternate' });
    const P = pipeOf([stRow('k', pipeOrigin(100), { cellOrigins: baselineCellOrigins('snap-st', 9, 1) }), pipeRow('fresh', 102)]);
    const r = await new StreamStitcher().stitch(T8, captureOf(letters.slice(0, 10), packet, 1), P, stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('unknown-state');
    if (r.status === 'error') throw new Error('unexpected');
    expect(sources(r)).toEqual(['P102']);
    expect(r.withheldRanges).toEqual([{ source: 'capture', start: 0, end: 10, reason: 'unknown-state' }, { source: 'pipe', start: 0, end: 1, reason: 'unknown-state' }]);
    expect(r.gaps.map(g => [g.reason, g.withheldRows, g.leftRowId])).toEqual([['unknown-vt-state', 11, durableId(7)]]);
  });

  test('geometry change without mapping rejects the overlap with a geometry gap', async () => {
    const r = await new StreamStitcher().stitch(tailOf(letters.slice(0, 8), { columns: 100 }), captureOf(letters.slice(0, 9)), pipeOf([]), stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('geometry');
    expect(r.status !== 'error' && r.gaps[0]!.reason).toBe('geometry-change');
  });

  test('empty durable tail without birth proof starts with an unknown leading gap', async () => {
    const r = await new StreamStitcher().stitch({ pane: stPane, rows: [] }, captureOf(['a', 'b']), pipeOf([pipeRow('c', 100)]), stProofs([]));
    expect(r.status === 'unproven' && r.reason).toBe('content-only');
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.gaps[0]).toMatchObject({ leftRowId: null, countKind: 'unknown', missingCount: null });
    expect(sources(r)).toEqual(['C0', 'C1', 'P100']);
  });

  test('identity and origin violations are errors, not decisions', async () => {
    const s = new StreamStitcher();
    const otherEpoch = { ...pipeOf([]), rawRange: { epoch: { ...stEpoch, attachId: 'x' }, start: 100, end: 200 } };
    expect((await s.stitch(T8, C12(), otherEpoch, stProofs([mapping(8)]))).status === 'error').toBe(true);
    const cap = C12();
    const badIndex = { ...cap, rows: [stRow('a', capOrigin(3)), ...cap.rows.slice(1)] };
    const bad = await s.stitch(T8, badIndex, pipeOf([]), stProofs([mapping(8)]));
    expect(bad.status === 'error' && bad.code).toBe('integrity');
    const foreign = pipeOf([stRow('k', pipeOrigin(100), { cellOrigins: [{ kind: 'capture', snapshotId: 'other', rowIndex: 10 }] })]);
    const f = await s.stitch(T8, C12(), foreign, stProofs([mapping(8)]));
    expect(f.status === 'error' && f.code).toBe('integrity');
  });

  test('known state: partial UTF-8/CSI stay unknown until a sync byte; SGR only via explicit reset', () => {
    const k = new KnownStateTracker({});
    expect(k.unknownFields()).toEqual(['sgr', 'cursor', 'savedCursor', 'margins', 'charset', 'pendingUtf8', 'pendingEscape', 'wrap']);
    k.feed([0x80, 0x80]);
    expect(k.uncertainFor(['pendingUtf8'])).toEqual(['pendingUtf8']);
    k.feed([0x41]);
    expect(k.uncertainFor(['pendingUtf8', 'pendingEscape'])).toEqual(['pendingEscape']);
    k.feed([0x0a]);
    expect(k.uncertainFor(['pendingEscape'])).toEqual([]);
    k.feed([...Buffer.from('\x1b[1m')]);
    expect(k.uncertainFor(['sgr'])).toEqual(['sgr']);
    k.feed([...Buffer.from('\x1b[0m')]);
    expect(k.uncertainFor(['sgr'])).toEqual([]);
  });

  test('known state: restoring a cursor saved while unknown makes the cursor unknown again', () => {
    const k = new KnownStateTracker({ pendingUtf8: true, pendingEscape: true });
    k.feed([...Buffer.from('\x1b[5;5H')]);
    expect(k.uncertainFor(['cursor', 'savedCursor'])).toEqual(['savedCursor']);
    k.feed([...Buffer.from('\x1b8')]);
    expect(k.uncertainFor(['cursor'])).toEqual(['cursor']);
    k.feed([...Buffer.from('\x1b[H\x1b7\x1b[9;9H\x1b8')]);
    expect(k.uncertainFor(['cursor', 'savedCursor'])).toEqual([]);
    k.feed([...Buffer.from('\n\n\n')]);
    expect(k.uncertainFor(['sgr', 'margins'])).toEqual(['sgr', 'margins']);
    k.feed([...Buffer.from('\x1bc')]);
    expect(k.unknownFields()).toEqual([]);
  });

  test('capture rows: history finalized, screen open, wrap unknown, styled cells, baseline origins', () => {
    const packet = stPacket({ historySize: 2, geometry: { columns: 10, rows: 2 } });
    const rows = captureStitchRows(packet, 'h1\n\x1b[1;31mX\x1b[0m\nscr\n');
    expect(rows.map(r => [r.finalized, r.wrapStatus, r.cells.map(c => c.text).join('')])).toEqual([
      [true, 'unknown', 'h1        '], [true, 'unknown', 'X         '], [false, 'unknown', 'scr       '],
    ]);
    expect(rows[1]!.cells[0]!.style).toEqual([1, 31]);
    expect(rows[0]!.cells[0]!.style).toEqual([]);
    expect(rows[2]!.origin).toEqual(capOrigin(2));
    expect(rows[2]!.cellOrigins).toEqual(Array(10).fill(capOrigin(2)));
  });
});

describe('NEWARCH C-fix codec, gap identity and quiet recovery', () => {
  test('canonical colors, default and SGR round-trip; wide text is not trimmed', () => {
    const packet = stPacket({ historySize: 4, geometry: { columns: 4, rows: 1 } });
    const rows = captureStitchRows(packet, '    \n\x1b[1;31mX\x1b[0m\n\x1b[38;2;1;2;3mA\x1b[0m\n界\n');
    const cells = rows.map(row => row.cells[0]!);
    expect(cells[0]!.style).toEqual([]);
    expect(cellToSemanticCell(cells[0]!).style).toEqual({ attrs: 0, fg: -1, bg: -1 });
    expect(cells[1]!.text).toBe('X');
    expect(cells[1]!.style).toEqual(semanticStyleToSgr({ attrs: 1, fg: 1, bg: -1 }));
    expect(cellToSemanticCell(cells[1]!)).toEqual({ text: 'X', width: 1, style: { attrs: 1, fg: 1, bg: -1 } });
    expect(cells[2]!.style).toEqual([38, 2, 1, 2, 3]);
    expect(cellToSemanticCell(cells[2]!).style).toEqual({ attrs: 0, fg: 256 + 0x010203, bg: -1 });
    expect(cells[3]).toMatchObject({ text: '界', width: 2, style: [] });
    expect(cellToSemanticCell(cells[3]!).text).toBe('界');
  });

  test('quiet recovery: rows in T and empty C/P get one positioned gap and accept nothing', async () => {
    const r = await new StreamStitcher().stitch(tailOf(letters.slice(0, 8)), captureOf([]), pipeOf([]), stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('content-only');
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.acceptedRowMap).toEqual([]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({
      episodeId: 'ep-st', leftRowId: durableId(7), reason: 'unproven-overlap',
      countKind: 'unknown', missingCount: null, withheldRows: 0,
    });
    expect(r.gaps[0]!.missingCount).toBeNull();
    expect('repair' in r.gaps[0]!).toBe(true);
    expect(gapIdentity(r.gaps[0]!)).toContain('gap-r2');
  });

  test('two withheld intervals in one episode have distinct gap identities', async () => {
    const cap = captureOf([...letters.slice(0, 8), 'n']);
    const P = pipeOf([
      pipeRow('x', 100, { uncertain: ['sgr'] }),
      pipeRow('y', CAPTURE_END),
      pipeRow('z', CAPTURE_END + 4, { uncertain: ['cursor'] }),
    ]);
    const r = await new StreamStitcher().stitch(tailOf(letters.slice(0, 8)), cap, P, stProofs([mapping(8)]));
    expect(r.status === 'unproven' && r.reason).toBe('unknown-state');
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.gaps).toHaveLength(2);
    expect(r.gaps.every(gap => gap.episodeId === 'ep-st')).toBe(true);
    expect(gapIdentity(r.gaps[0]!)).not.toBe(gapIdentity(r.gaps[1]!));
    const repairs = r.gaps.map(gap => 'repair' in gap ? (gap as SC.GapR2).repair : null);
    expect(repairs.map(repair => repair?.sequence)).toEqual([0, 1]);
    expect(repairs[0]?.gapId).not.toBe(repairs[1]?.gapId);
    expect(repairs.every(repair => repair?.revision === 2 && repair.update === 0 && repair.state === 'open')).toBe(true);
    expect(r.gaps.every(gap => gap.missingCount === null && gap.countKind === 'unknown')).toBe(true);
  });

  test('quiet source shorter than the horizon is opened once', async () => {
    const short = [0, 1].map(i => ({ cells: [{ text: `q${i}`, width: 1 as const, style: [] as number[] }], softWrap: false, wrapPad: 0, uncertainFields: [] as string[] }));
    const missing = { cells: [{ text: 'missing', width: 1 as const, style: [] as number[] }], softWrap: false, wrapPad: 0, uncertainFields: [] as string[] };
    let opens = 0;
    const repair = new TargetedCaptureRepair({
      open: async (_episode, horizon) => {
        opens += 1;
        expect(horizon).toBeGreaterThan(short.length);
        return { status: 'ok', value: cRecoveryView(short).view };
      },
    }, cIdentity, new CaptureAdmission(33554432));
    const results = [];
    for await (const result of repair.chunks(cEpisode(), [missing], [missing], 1, new AbortController().signal)) results.push(result);
    expect(opens).toBe(1);
    expect(results).toMatchObject([{ status: 'error', code: 'unresolved-gap', message: 'quiet source has no further rows' }]);
  });

  test('VT worker emits canonical SGR: default is empty, attrs precede colors, no reset', () => {
    const script = String.raw`
import importlib.util,sys
spec=importlib.util.spec_from_file_location('vt',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
w=m.Worker(4,1)
assert w.contract_state()['attributes']==[], w.contract_state()['attributes']
w.feed(1,1,b'\x1b[1;31mX')
assert w.contract_state()['attributes']==[1,31], w.contract_state()['attributes']
row=m.contract_row(m.encode_row(w.screen.buffer[0], w.screen.columns, w.screen.default_char), False, False)
assert row['cells'][0]=={'text':'X','width':1,'style':[1,31]}, row['cells'][0]
w.feed(2,1,b'\x1b[0m\x1b[48;2;1;2;3m ')
assert w.contract_state()['attributes']==[48,2,1,2,3], w.contract_state()['attributes']
`;
    const r = Bun.spawnSync(['python3', '-B', '-c', script, new URL('../src/pipe-vt-worker.py', import.meta.url).pathname]);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
  });
});

import { v2BirthCheckpoint, evaluateV2Prefix, evaluateV2Rules, v2RuleTable, v2DecisionIncident } from '../src/capture-engine';
import { V2Jigsaw } from '../src/stream-runtime';
import { evaluateV2Audit, normalizeV2Capture, v2ScreenDigest } from '../src/tmux-capture-normalize';
import { NEWARCH_V2_DEFAULT_CONFIG as v2Config, NEWARCH_V2_PREFIX_LIMITS, streamCanonical,
  v2BirthGeometry, v2DecodePrefixValid, v2Digest, v2RowsSerializedBytes, validateV2Incident,
  type NewarchV2PaneDescriptor, type V2AuditEvidence, type V2LiveCheckpoint } from '../src/stream-contract';
const v2Pane:NewarchV2PaneDescriptor={schema:'newarch-v2',session:{serverIdentity:'c-private',sessionId:'s'},
  pane:{serverIdentity:'c-private',paneId:'%1',birthGeneration:1},windowId:'@1',owner:'capture-engine',
  birthOperationId:'birth-C',geometry:{...v2BirthGeometry(v2Config),columns:10,rows:3},state:'active'};
const v2Epoch={pane:v2Pane.pane,attachId:'byte0',collectorIncarnation:'collector-C'};
const v2Genesis=()=>v2BirthCheckpoint(v2Pane,{epoch:v2Epoch,byteOffset:0});
const v2Clock={wallMs:123,clockEpoch:'test-clock'};
function v2Replay(text:string,cuts:number[]=[]){
  const bytes=[...Buffer.from(text)],engine=new V2Jigsaw(v2Genesis(),v2Pane);
  const rows:SC.CommittedStreamRow[]=[];let start=0;
  for(const end of [...cuts,bytes.length]){
    const result=engine.evaluate({epoch:v2Epoch,start,end},bytes.slice(start,end),10,v2Clock);
    expect(result.kind).not.toBe('gap');
    if(result.kind==='accept'){rows.push(...result.rows);engine.committed(result.checkpoint.checkpointId);}
    start=end;
  }
  expect(engine.pendingBytes).toBe(0);
  return {rows,cp:engine.liveCheckpoint};
}
const v2Text=(row:SC.RowContent)=>row.cells.map(c=>c.text).join('');
describe('Q22 V2-13 byte-zero jigsaw (anomaly fixtures C-001..C-008)',()=>{
  test('C-001 every UTF8/escape partition has identical VT, row IDs and ordered scroll provenance',()=>{
    const text='ซ้ำ😃\r\nซ้ำ😃\r\n\x1b[31m界\x1b[0m\r\nprogress 1\r\x1b[Kdone\r\n1234567890X\r\nก้❤️\r\n';
    const full=v2Replay(text);
    expect(full.rows.slice(0,2).map(v2Text)).toEqual(['ซ้ำ😃      ','ซ้ำ😃      ']);
    for(let cut=1;cut<Buffer.byteLength(text);cut++){
      const split=v2Replay(text,[cut]);
      expect(split.rows).toEqual(full.rows);expect(split.cp.state).toEqual(full.cp.state);
    }
    const bytewise=v2Replay(text,Array.from({length:Buffer.byteLength(text)-1},(_,i)=>i+1));
    expect(bytewise.rows).toEqual(full.rows);expect(bytewise.cp.state).toEqual(full.cp.state);
  });
  test('C-002 CR/backspace/erase/cursor redraw and alternate screen do not invent history',()=>{
    const r=v2Replay('wrong\rOK\x1b[K\b!\x1b[2;1Hlower\x1b[?1049hALT\r\nX\r\nY\r\nZ\x1b[?1049l');
    expect(r.rows).toEqual([]);expect(r.cp.state.active).toBe('normal');
    expect(r.cp.state.normal.rows.map(v2Text)).toEqual(['O!        ','lower     ','          ']);
    expect(r.cp.state.normal.cursor).toMatchObject({x:5,y:1});
  });
  test('C-003 soft wrap, scroll regions and wide overwrite retain physical boundaries',()=>{
    const r=v2Replay('1234567890X\r\nZ\r\n');
    expect(r.rows.map(v2Text)).toEqual(['1234567890']);expect(r.rows[0]!.wrapStatus).toBe('wrapped');
    const wide=v2Replay('界X\rA');expect(v2Text(wide.cp.state.normal.rows[0]!)).toBe('A X       ');
    const region=v2Replay('top\x1b[2;3r\x1b[3;1Ha\n\n');expect(region.rows).toEqual([]);
    expect(v2Text(region.cp.state.normal.rows[0]!)).toBe('top       ');
  });
  test('C-004 partial sequence deadline is fixed, durable state not advanced, incident repeatable',()=>{
    const engine=new V2Jigsaw(v2Genesis(),v2Pane);
    expect(engine.evaluate({epoch:v2Epoch,start:0,end:2},[27,91],10,v2Clock).kind).toBe('defer');
    expect(engine.deadlineMonoMs).toBe(1010);expect(engine.liveCheckpoint.through.byteOffset).toBe(0);
    expect(engine.evaluate({epoch:v2Epoch,start:2,end:3},[51],500,v2Clock).kind).toBe('defer');
    expect(engine.deadlineMonoMs).toBe(1010);
    const result=engine.expire(1010,v2Clock);expect(result?.kind).toBe('gap');
    if(result?.kind==='gap'){validateV2Incident(result.incident);expect(result.incident.frontier).toBeNull();}
    expect(engine.pendingBytes).toBe(0);expect(()=>engine.evaluate({epoch:v2Epoch,start:3,end:3},[],1011,v2Clock)).toThrow();
    const cp=v2Genesis(),input={pane:v2Pane,checkpoint:cp,raw:{epoch:v2Epoch,start:0,end:1},bytes:[255],observedAtMonoMs:10,pendingSinceMonoMs:null};
    expect(evaluateV2Rules(input)).toEqual(evaluateV2Rules(input));
  });
  test('C-005 epoch/identity/geometry/offset/unknown control fail closed; no guessed acceptance',()=>{
    const cp=v2Genesis(),input={pane:v2Pane,checkpoint:cp,raw:{epoch:v2Epoch,start:0,end:1},bytes:[65],observedAtMonoMs:10,pendingSinceMonoMs:null};
    for(const change of [
      {raw:{...input.raw,start:1,end:2}},
      {raw:{...input.raw,epoch:{...v2Epoch,collectorIncarnation:'next'}}},
      {pane:{...v2Pane,geometry:{...v2Pane.geometry,columns:11}}},
      {bytes:[255]},
    ])expect(evaluateV2Rules({...input,...change}).kind).toBe('gap');
    const bytes=[...Buffer.from('\x1bPunknown')];
    expect(evaluateV2Rules({...input,bytes,raw:{...input.raw,end:bytes.length}}).kind).toBe('gap');
    expect(()=>v2RuleTable({...v2Config,rules:[{ruleId:'eval(log)',version:'1'}]})).toThrow();
  });
  test('C-006 checkpoint restart and rule version only at committed boundary',()=>{
    const first=v2Replay('A\x1b[31mB');const e=new V2Jigsaw(first.cp,v2Pane);
    e.configure({...v2Config,configVersion:'rules-next'});
    const start=first.cp.through.byteOffset,bytes=[...Buffer.from('C\r\nD\r\nE\r\n')];
    const r=e.evaluate({epoch:v2Epoch,start,end:start+bytes.length},bytes,20,v2Clock);
    expect(r.kind).toBe('accept');if(r.kind!=='accept')return;
    expect(r.stamp.configVersion).toBe('rules-next');expect(first.cp.rule.configVersion).toBe(v2Config.configVersion);
    expect(()=>e.configure(v2Config)).toThrow();expect(()=>e.committed('wrong')).toThrow();
    e.committed(r.checkpoint.checkpointId);
    expect(r.checkpoint.state).toEqual(v2Replay('A\x1b[31mBC\r\nD\r\nE\r\n').cp.state);
  });
  test('C-007 bounds: candidate rows, raw bytes and combining sequence are finite',()=>{
    const cp=v2Genesis();
    for(const text of ['X\r\n'.repeat(270),'A'+'\u0301'.repeat(2100),'\x1b['+'1'.repeat(4100)]){
      const bytes=[...Buffer.from(text)];expect(evaluateV2Rules({pane:v2Pane,checkpoint:cp,raw:{epoch:v2Epoch,start:0,end:bytes.length},bytes,observedAtMonoMs:0,pendingSinceMonoMs:null}).kind).toBe('gap');
    }
  });
});
function v2AuditFixture(){
  const cp=v2Replay('A\x1b[31mB').cp;
  const current={pane:cp.pane,through:cp.through,revision:cp.revision,geometry:cp.geometry,checkpointId:cp.checkpointId};
  const rawCapture='A\x1b[31mB\x1b[0m        \n          \n          \n';
  const evidence:V2AuditEvidence={before:current,after:current,snapshot:current,
    ordering:{kind:'certified-source-fence',certificateId:'C-proof',proof:{path:'redacted-proof',bytes:1,sha256:'a'.repeat(64)}},
    expectedDigest:v2ScreenDigest(cp.state.normal.rows),actualDigest:v2ScreenDigest(normalizeV2Capture(rawCapture,cp.geometry)),
    captureBytes:Buffer.byteLength(rawCapture),elapsedMs:1};
  const incident=v2DecisionIncident({pane:v2Pane,checkpoint:cp,raw:{epoch:v2Epoch,start:cp.through.byteOffset,end:cp.through.byteOffset},bytes:[],observedAtMonoMs:10,pendingSinceMonoMs:null},cp.rule,v2Clock,'audit-mismatch','C-008');
  return {checkpoint:cp,current,rawCapture,evidence,paneAlive:true,attempt:0,incident,
    verifiedCertificate:{certificateId:'C-proof',sha256:'a'.repeat(64)}};
}
describe('Q22 V2-14/15 pure auditor (C-008)',()=>{
  test('same revision compares actual live cells and mismatch annotates without repairing history',()=>{
    const f=v2AuditFixture();expect(evaluateV2Audit(f).kind).toBe('match');
    const rawCapture=f.rawCapture.replace('A','Z'),actualDigest=v2ScreenDigest(normalizeV2Capture(rawCapture,f.checkpoint.geometry));
    const r=evaluateV2Audit({...f,rawCapture,evidence:{...f.evidence,actualDigest}});
    expect(r.kind).toBe('annotate');if(r.kind==='annotate')validateV2Incident(r.incident);
    expect(f.checkpoint.state.normal.rows[0]!.cells[0]!.text).toBe('A');
  });
  test('disabled, timeout, dead pane, stale revision, changed identity and unproven fence cannot apply',()=>{
    const f=v2AuditFixture();
    expect(evaluateV2Audit({...f,config:{...v2Config,audit:{...v2Config.audit,enabled:false}}})).toMatchObject({kind:'inconclusive',reason:'disabled',retry:false});
    expect(evaluateV2Audit({...f,evidence:{...f.evidence,elapsedMs:3000}})).toMatchObject({kind:'inconclusive',reason:'timeout'});
    expect(evaluateV2Audit({...f,paneAlive:false})).toMatchObject({kind:'inconclusive',reason:'pane-dead'});
    expect(evaluateV2Audit({...f,current:{...f.current,revision:99}})).toMatchObject({kind:'inconclusive',reason:'stale'});
    expect(evaluateV2Audit({...f,current:{...f.current,pane:{...f.current.pane,birthGeneration:2}}})).toMatchObject({kind:'inconclusive',reason:'identity'});
    expect(evaluateV2Audit({...f,verifiedCertificate:null})).toMatchObject({kind:'inconclusive',reason:'racing'});
    expect(evaluateV2Audit({...f,evidence:{...f.evidence,ordering:{kind:'unproven'}}})).toMatchObject({kind:'inconclusive',reason:'racing'});
    expect(evaluateV2Audit({...f,attempt:1,evidence:{...f.evidence,elapsedMs:3000}})).toMatchObject({retry:false});
  });
  test('100 repeated mismatches reuse incident identity; snapshot row count and digest are checked',()=>{
    const f=v2AuditFixture(),rawCapture=f.rawCapture.replace('A','Z');
    const evidence={...f.evidence,actualDigest:v2ScreenDigest(normalizeV2Capture(rawCapture,f.checkpoint.geometry))};
    for(let n=0;n<100;n++){const r=evaluateV2Audit({...f,rawCapture,evidence});expect(r.kind).toBe('annotate');if(r.kind==='annotate')expect(r.incident.incidentId).toBe(f.incident.incidentId);}
    expect(evaluateV2Audit({...f,evidence:{...f.evidence,actualDigest:'0'.repeat(64)}}).kind).toBe('inconclusive');
    expect(()=>normalizeV2Capture('A\n',f.checkpoint.geometry)).toThrow();
  });
});

test('Q22 C-009 terminal modes, cell edits, cursor visibility and reset',()=>{
  const r=v2Replay('\x1b[?2004h\x1b[?1004h\x1b[?2026h\x1b[?25l\x1b[?1049hX');
  expect(r.cp.state.alternate.cursor.visible).toBe(false);
  const edited=v2Replay('abcd\x1b[1;2H\x1b[@Z\x1b[P');
  expect(v2Text(edited.cp.state.normal.rows[0]!)).toBe('aZcd      ');
  const reset=v2Replay('abc\x1bcZ');expect(v2Text(reset.cp.state.normal.rows[0]!)).toBe('Z         ');
  expect(reset.rows).toEqual([]);
});

test('Q22 mutation controls: stale audit, content dedupe and renewed deadline are behavioral failures',()=>{
  const root=mkdtempSync(join(tmpdir(),'q22-c-mutants-'));
  const input=(text:string,now=10,since:number|null=null)=>({pane:v2Pane,checkpoint:v2Genesis(),
    raw:{epoch:v2Epoch,start:0,end:Buffer.byteLength(text)},bytes:[...Buffer.from(text)],observedAtMonoMs:now,pendingSinceMonoMs:since});
  const f=v2AuditFixture();
  const cases=[
    {name:'stale-audit',file:'tmux-capture-normalize.ts',
      from:"if(e.snapshot.revision!==input.current.revision||e.snapshot.checkpointId!==input.current.checkpointId)return inconclusive('stale');",
      to:"if(e.snapshot.revision!==input.current.revision||e.snapshot.checkpointId!==input.current.checkpointId)return {kind:'match',evidence:e,rule:input.checkpoint.rule};",
      code:`import {evaluateV2Audit} from './subject.ts'; const result=evaluateV2Audit(${JSON.stringify({...f,current:{...f.current,revision:99}})}); assert.equal(result.kind,'inconclusive','MUTATION stale audit accepted');`},
    {name:'content-dedupe',file:'capture-engine.ts',from:'out.push(removed);offsets.push(offset);',
      to:'if(!out.length || JSON.stringify(out.at(-1))!==JSON.stringify(removed)){out.push(removed);offsets.push(offset);}',
      code:`import {evaluateV2Rules} from './subject.ts'; const result=evaluateV2Rules(${JSON.stringify(input('same\r\nsame\r\nx\r\ny\r\n'))}); assert.equal(result.kind,'accept'); assert.equal(result.rows.length,2,'MUTATION actual repeated row deleted');`},
    {name:'renewed-deadline',file:'capture-engine.ts',from:'(input.pendingSinceMonoMs??input.observedAtMonoMs)+V2L.pendingDeadlineMs',
      to:'input.observedAtMonoMs+V2L.pendingDeadlineMs',
      code:`import {evaluateV2Rules} from './subject.ts'; const result=evaluateV2Rules(${JSON.stringify(input('\x1b[',1010,10))}); assert.equal(result.kind,'gap','MUTATION pending deadline extended');`},
  ];
  try{
    for(const c of cases){
      const source=new URL(`../src/${c.file}`,import.meta.url);
      const original=readFileSync(source,'utf8').replace(/from '(\.\/[^']+)'/g,(_,path)=>`from ${JSON.stringify(new URL(path+'.ts',source).pathname)}`)
        .replace("from '@thumbmux/core'",`from ${JSON.stringify(import.meta.resolve('@thumbmux/core'))}`);
      expect(original.split(c.from)).toHaveLength(2);
      const importEnd=c.code.indexOf(';')+1;
      // Bun's uncaught formatter can lose pipe output while printing a huge
      // single-line JSON fixture. Emit the actual assertion synchronously,
      // below PIPE_BUF, instead of depending on the formatted source/caret.
      writeFileSync(join(root,'runner.ts'),`import assert from 'node:assert/strict';
import {writeSync} from 'node:fs';
${c.code.slice(0,importEnd)}
try { ${c.code.slice(importEnd)} }
catch(cause) { writeSync(2,String(cause)+'\\n'); process.exit(1); }`);
      for(const mutated of [false,true]){
        writeFileSync(join(root,'subject.ts'),mutated?original.replace(c.from,c.to):original);
        const r=spawnSync(process.execPath,[join(root,'runner.ts')],{encoding:'utf8',timeout:10000});
        console.log('Q22_C_MUTATION',JSON.stringify({name:c.name,mutated,exit:r.status,stderr:r.stderr.slice(-1800)}));
        expect(r.status).toBe(mutated?1:0);
        if(mutated)expect(r.stderr).toContain('MUTATION');
      }
      // Restore before the next mutation; never install a mutant in the repo.
      writeFileSync(join(root,'subject.ts'),original);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Q22 V2-13 physical 100x40 oracle on a private tmux socket',async()=>{
  const root=mkdtempSync(join(tmpdir(),'q22-c-oracle-')),socket=join(root,'x.sock');
  const env={...process.env};delete env.TMUX;delete env.TMUX_PANE;
  const tmux=(...args:string[])=>{const r=spawnSync('tmux',['-S',socket,...args],{env,encoding:'utf8'});expect(r.status,r.stderr).toBe(0);return r.stdout;};
  const cases=[
    'ไทย น้ำ 😃 ❤️\r\n'+'same\r\n'.repeat(42)+'\x1b[31mred\x1b[0m',
    'wrong\rOK\x1b[K\b!\x1b[3;4H界\x1b[3;4HX',
    'N'.repeat(100)+'\x1b[?25lX',
    '\x1b[1;31;44m\x1b[2J\x1b[3;1HZ',
    'N'.repeat(101)+'\r\nZ\x1b[?25l\x1b[?1049hALT\r\nsecond\x1b[?1049l',
    '\x1b[2;4r\x1b[4;1Hbottom\n\n\x1b[r\x1b[1;1Htop',
    '\x1b[1;38;2;1;2;3mcolor\x1b[0m\r\nabc\x1b[2;2H\x1b[@Z\x1b[P',
  ];
  try{
    for(let index=0;index<cases.length;index++){
      const body=cases[index]!,path=join(root,`body-${index}`);writeFileSync(path,body);
      const paneId=tmux('-f','/dev/null','new-session','-d','-P','-F','#{pane_id}','-s',`oracle${index}`,'-x','100','-y','40',`stty -onlcr; cat '${path}'; touch '${path}.ready'; read hold`).trim();
      const deadline=Date.now()+3000;
      while(!existsSync(path+'.ready')&&Date.now()<deadline)await Bun.sleep(5);
      expect(existsSync(path+'.ready')).toBe(true);
      const captured=tmux('capture-pane','-p','-e','-N','-t',paneId);
      // The cases are cut for 100 columns x 40 rows, so the oracle runs on that geometry,
      // not on the default config (78x120 since 2026-10-04).
      const config100={...v2Config,configVersion:'oracle-100x40',geometry:{columns:100,rows:40}};
      const pane={...v2Pane,geometry:v2BirthGeometry(config100)};
      const cp=v2BirthCheckpoint(pane,{epoch:v2Epoch,byteOffset:0},config100),bytes=[...Buffer.from(body)];
      const result=evaluateV2Rules({pane,checkpoint:cp,bytes,raw:{epoch:v2Epoch,start:0,end:bytes.length},observedAtMonoMs:1,pendingSinceMonoMs:null},config100);
      expect(result.kind).toBe('accept');if(result.kind!=='accept')throw Error(JSON.stringify(result));
      const state=result.checkpoint.state;
      expect(v2ScreenDigest(state[state.active].rows)).toBe(v2ScreenDigest(normalizeV2Capture(captured,pane.geometry)));
      const cursor=tmux('display-message','-p','-t',paneId,'#{cursor_x} #{cursor_y} #{cursor_flag}').trim().split(' ').map(Number);
      expect([state[state.active].cursor.x,state[state.active].cursor.y,Number(state[state.active].cursor.visible)]).toEqual(cursor);
      console.log('Q22_PRIVATE_ORACLE',JSON.stringify({caseId:index,geometry:pane.geometry,rows:result.rows.length,cursor}));
    }
  }finally{spawnSync('tmux',['-S',socket,'kill-server'],{env});rmSync(root,{recursive:true,force:true});}
});

test('Q22 audit rejects geometry and grapheme allocations before decode',()=>{
  expect(()=>normalizeV2Capture('x\n',{columns:1000000000,rows:1})).toThrow();
  expect(()=>normalizeV2Capture('A'+'\u0301'.repeat(2100)+'\n',{columns:10,rows:1})).toThrow();
});

describe('Q22 C/H durable revision and segment seams (C-010..016)',()=>{
  const nextInput=(cp:V2LiveCheckpoint,text:string)=>({pane:v2Pane,checkpoint:cp,
    raw:{epoch:v2Epoch,start:cp.through.byteOffset,end:cp.through.byteOffset+Buffer.byteLength(text)},
    bytes:[...Buffer.from(text)],observedAtMonoMs:20,pendingSinceMonoMs:null});
  test('C-010 activation checkpoint uses the first durable pane revision',()=>{
    expect(v2Genesis().revision).toBe(1);
  });
  test('C-011 metadata-only H commits advance revision without replacing the live checkpoint',()=>{
    const context={...v2Clock,durableRevision:7};
    const r=evaluateV2Rules(nextInput(v2Genesis(),'A'),v2Config,context);
    expect(r.kind).toBe('accept');if(r.kind!=='accept')return;
    expect(r.checkpoint.revision).toBe(8);
  });
  test('C-012 rows after a seal target a fresh segment and restart its ordinal at zero',()=>{
    const first=v2Replay('a\r\nb\r\nc\r\nd\r\n');
    const context={...v2Clock,durableRevision:first.cp.revision+1,rowTarget:{segmentId:'C-after-seal',nextRowOrdinal:0}};
    const r=evaluateV2Rules(nextInput(first.cp,'e\r\n'),v2Config,context);
    expect(r.kind).toBe('accept');if(r.kind!=='accept')return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.id).toEqual({pane:v2Pane.pane,segmentId:'C-after-seal',rowOrdinal:0});
    expect(r.checkpoint.frontier).toEqual(r.rows[0]!.id);
    const next=evaluateV2Rules(nextInput(r.checkpoint,'f\r\n'),v2Config,{...v2Clock,durableRevision:r.checkpoint.revision});
    expect(next.kind).toBe('accept');if(next.kind==='accept')expect(next.rows[0]!.id).toEqual({pane:v2Pane.pane,segmentId:'C-after-seal',rowOrdinal:1});
  });
  test('C-013 an older durable revision is rejected instead of minting a stale write',()=>{
    const cp=v2Replay('A').cp,context={...v2Clock,durableRevision:cp.revision-1};
    expect(evaluateV2Rules(nextInput(cp,'B'),v2Config,context).kind).toBe('gap');
  });
  test('C-014 checkpoints without new raw still have distinct commit identities',()=>{
    const first=evaluateV2Rules(nextInput(v2Genesis(),''));
    expect(first.kind).toBe('accept');if(first.kind!=='accept')return;
    const second=evaluateV2Rules(nextInput(first.checkpoint,''));
    expect(second.kind).toBe('accept');if(second.kind!=='accept')return;
    expect(second.checkpoint.checkpointId).not.toBe(first.checkpoint.checkpointId);
  });
  test('C-015 audit pairs a retained live checkpoint with the current metadata revision',()=>{
    const f=v2AuditFixture(),current={...f.current,revision:f.current.revision+2};
    const evidence={...f.evidence,before:current,after:current,snapshot:current};
    expect(evaluateV2Audit({...f,current,evidence}).kind).toBe('match');
    const rawCapture=f.rawCapture.replace('A','Z');
    const mismatch=evaluateV2Audit({...f,current,rawCapture,evidence:{...evidence,actualDigest:v2ScreenDigest(normalizeV2Capture(rawCapture,f.checkpoint.geometry))}});
    expect(mismatch.kind).toBe('annotate');if(mismatch.kind==='annotate')expect(mismatch.incident.revision).toBe(current.revision);
    expect(evaluateV2Audit({...f,current,evidence,checkpoint:{...f.checkpoint,revision:current.revision+1}}).kind).toBe('inconclusive');
  });
  test('C-016 serialized row provenance fits H batch bytes, not only decoded cell bytes',()=>{
    const pane={...v2Pane,geometry:v2BirthGeometry(v2Config)},cp=v2BirthCheckpoint(pane,{epoch:v2Epoch,byteOffset:0});
    const bytes=[...Buffer.from('\r\n'.repeat(v2Config.geometry.rows+160))];
    const r=evaluateV2Rules({pane,checkpoint:cp,raw:{epoch:v2Epoch,start:0,end:bytes.length},bytes,observedAtMonoMs:1,pendingSinceMonoMs:null});
    expect(r.kind).toBe('gap');if(r.kind==='gap')expect(r.incident.reason).toBe('budget-exhausted');
  });
});

describe('Q22 C definite rejection and proposal isolation',()=>{
  test('only a definitively rejected proposal can be replanned from the durable raw frontier',()=>{
    const cp=v2Genesis(),engine=new V2Jigsaw(cp,v2Pane),bytes=[...Buffer.from('a\r\nb\r\nc\r\nd\r\n')];
    const raw={epoch:structuredClone(v2Epoch),start:0,end:bytes.length};
    const first=engine.evaluate(raw,bytes,1,{...v2Clock,rowTarget:{segmentId:'rejected-A',nextRowOrdinal:0}});
    expect(first.kind).toBe('accept');if(first.kind!=='accept')return;
    expect(()=>engine.rejected('wrong')).toThrow();
    expect(engine.rejected(first.checkpoint.checkpointId)).toEqual(cp.through);
    const second=engine.evaluate(raw,bytes,2,{...v2Clock,rowTarget:{segmentId:'accepted-B',nextRowOrdinal:0}});
    expect(second.kind).toBe('accept');if(second.kind!=='accept')return;
    engine.committed(second.checkpoint.checkpointId);
    expect(engine.liveCheckpoint.frontier?.segmentId).toBe('accepted-B');
    expect(()=>engine.rejected(second.checkpoint.checkpointId)).toThrow();
  });
  test('caller mutation cannot alter a pending durable proposal',()=>{
    const engine=new V2Jigsaw(v2Genesis(),v2Pane),epoch=structuredClone(v2Epoch);
    const result=engine.evaluate({epoch,start:0,end:1},[65],1,v2Clock);
    expect(result.kind).toBe('accept');if(result.kind!=='accept')return;
    epoch.attachId='caller-mutated';
    engine.committed(result.checkpoint.checkpointId);
    expect(engine.liveCheckpoint.through.epoch.attachId).toBe(v2Epoch.attachId);
  });
});

describe('NEWARCH flag-on B1 bounded burst prefixes',()=>{
  const config78={...v2Config,geometry:{columns:78,rows:120}};
  const geometry=v2BirthGeometry(config78);
  const pane={...v2Pane,geometry};
  const birth=()=>v2BirthCheckpoint(pane,{epoch:v2Epoch,byteOffset:0},config78);
  const rowText=(row:SC.CommittedStreamRow)=>row.cells.map(cell=>cell.text).join('');
  function decodePackets(raw:Buffer, packetEnds:readonly number[]=[raw.length]) {
    let cp=birth(), offeredStart=0;
    const rows:SC.CommittedStreamRow[]=[];
    const prefixes:SC.V2DecodePrefix[]=[];
    for(const packetEnd of packetEnds) {
      expect(packetEnd).toBeGreaterThanOrEqual(offeredStart);
      while(offeredStart<packetEnd) {
        const input={pane,checkpoint:cp,raw:{epoch:v2Epoch,start:offeredStart,end:packetEnd},
          bytes:[...raw.subarray(offeredStart,packetEnd)],observedAtMonoMs:1,pendingSinceMonoMs:null};
        const result=evaluateV2Prefix(input,config78,v2Clock);
        if('kind' in result) throw Error(`unexpected ${result.kind}: ${result.incident.reason}`);
        expect(v2DecodePrefixValid(result,cp)).toBe(true);
        expect(result.rows.length).toBeLessThanOrEqual(NEWARCH_V2_PREFIX_LIMITS.maxRows);
        expect(result.serializedBytes).toBeLessThanOrEqual(NEWARCH_V2_PREFIX_LIMITS.maxSerializedBytes);
        expect(result.consumed.end-result.consumed.start).toBeLessThanOrEqual(NEWARCH_V2_PREFIX_LIMITS.maxRawBytes);
        expect(Buffer.byteLength(streamCanonical(result.checkpoint))).toBeLessThanOrEqual(NEWARCH_V2_PREFIX_LIMITS.checkpointBytes);
        for(const row of result.rows) expect(row.cellOrigins).toHaveLength(row.cells.length);
        prefixes.push(result);rows.push(...result.rows);cp=result.checkpoint;offeredStart=result.consumed.end;
      }
    }
    return {rows,prefixes,checkpoint:cp};
  }
  function numbered(count:number,body?: (i:number)=>string): Buffer {
    const make=body??((i:number)=>`row-${i.toString().padStart(5,'0')}`);
    return Buffer.from(Array.from({length:count},(_,i)=>make(i)+'\r\n').join('')+'SENTINEL-B1\r\n');
  }

  for(const count of [80,256,1024,10000]) test(`78x120 burst ${count} rows is lossless and sentinel remains reachable`,()=>{
    const raw=numbered(count),decoded=decodePackets(raw);
    const visible=decoded.checkpoint.state[decoded.checkpoint.state.active].rows.map(row=>row.cells.map(cell=>cell.text).join('').trimEnd());
    const all=[...decoded.rows.map(row=>rowText(row).trimEnd()),...visible];
    expect(all.filter(text=>text==='SENTINEL-B1')).toHaveLength(1);
    expect(all.filter(text=>text.startsWith('row-'))).toEqual(Array.from({length:count},(_,i)=>`row-${i.toString().padStart(5,'0')}`));
    expect(decoded.prefixes.some(prefix=>prefix.stop!=='complete')).toBe(count>=1024);
  });

  test('newline-only, full-width and repeated content use canonical size without losing provenance',()=>{
    for(const raw of [Buffer.from('\n'.repeat(1024)+'SENTINEL-B1\r\n'),numbered(1024,()=> '界'.repeat(39)),numbered(1024,()=> 'same')]) {
      const decoded=decodePackets(raw);
      expect(decoded.prefixes.every(prefix=>prefix.serializedBytes===v2RowsSerializedBytes(prefix.rows))).toBe(true);
      expect(decoded.prefixes.flatMap(prefix=>prefix.rows).every(row=>row.cellOrigins.every(origin=>origin.kind==='pipe'))).toBe(true);
    }
  });

  test('Thai, emoji, ANSI and CR agree for one packet and every split boundary',()=>{
    const lead='lead\r\n'.repeat(120);
    const tail='ไทยก้😃\r\n\x1b[31mแดง界\x1b[0m\rprogress\rDONE\x1b[K\r\nSENTINEL-B1\r\n';
    const raw=Buffer.from(lead+tail),one=decodePackets(raw);
    const start=Buffer.byteLength(lead),want=one.rows.map(row=>({id:row.id,text:rowText(row),origins:row.cellOrigins}));
    for(let cut=start+1;cut<raw.length;cut++) {
      const split=decodePackets(raw,[cut,raw.length]);
      expect(split.rows.map(row=>({id:row.id,text:rowText(row),origins:row.cellOrigins}))).toEqual(want);
    }
  });
});
