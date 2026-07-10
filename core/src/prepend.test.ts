import { describe, expect, test } from 'bun:test';
import {
  cloneSgrState,
  createSgrState,
  lineToHtml,
  sgrStateKey,
  type AnsiPalette,
  type SgrState,
} from './ansi-html';
import { planPrepend } from './prepend';

const pal: AnsiPalette = {
  base: [
    '#000', '#f00', '#0f0', '#ff0',
    '#00f', '#f0f', '#0ff', '#fff',
    '#111', '#f11', '#1f1', '#ff1',
    '#11f', '#f1f', '#1ff', '#eee',
  ],
  defaultFg: '#eee',
  defaultBg: '#111',
};

function stateAfter(lines: string[]): SgrState {
  const st = createSgrState();
  for (const line of lines) lineToHtml(line, st, pal);
  return cloneSgrState(st);
}

function keyOf(lines: string[]): string {
  return sgrStateKey(stateAfter(lines));
}

describe('planPrepend', () => {
  test('empty batch converges with an existing default chain', () => {
    const plan = planPrepend([], 'first', createSgrState());
    expect(plan.batchStates).toEqual([]);
    expect(sgrStateKey(plan.endState)).toBe(sgrStateKey(createSgrState()));
    expect(plan.existingCacheValid).toBe(true);
  });

  test('empty batch does not converge with an existing colored chain', () => {
    const existing = stateAfter(['\x1b[31mred']);
    expect(planPrepend([], 'first', existing).existingCacheValid).toBe(false);
  });

  test('plain lines end at default and keep existing default caches valid', () => {
    const plan = planPrepend(['a', 'b', 'c'], 'first', createSgrState());
    expect(plan.batchStates.map(sgrStateKey)).toEqual([
      sgrStateKey(createSgrState()),
      sgrStateKey(createSgrState()),
      sgrStateKey(createSgrState()),
    ]);
    expect(plan.existingCacheValid).toBe(true);
  });

  test('a colored tail without reset invalidates a default existing cache', () => {
    const plan = planPrepend(['\x1b[32mgreen'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(false);
    expect(sgrStateKey(plan.endState)).toBe(keyOf(['\x1b[32mgreen']));
  });

  test('a colored tail converges with an existing chain that already starts green', () => {
    const existing = stateAfter(['\x1b[32m']);
    const plan = planPrepend(['\x1b[32mgreen'], 'first', existing);
    expect(plan.existingCacheValid).toBe(true);
  });

  test('mid-batch reset restores default convergence', () => {
    const plan = planPrepend(['\x1b[31mred', 'still red\x1b[0m', 'plain'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(true);
    expect(sgrStateKey(plan.endState)).toBe(sgrStateKey(createSgrState()));
  });

  test('batch states are state-after snapshots for each parsed line', () => {
    const plan = planPrepend(['\x1b[31mred', 'carry', '\x1b[0mreset', 'plain'], 'first', createSgrState());
    expect(plan.batchStates.map(sgrStateKey)).toEqual([
      keyOf(['\x1b[31mred']),
      keyOf(['\x1b[31mred', 'carry']),
      sgrStateKey(createSgrState()),
      sgrStateKey(createSgrState()),
    ]);
  });

  test('truecolor foreground participates in convergence', () => {
    const plan = planPrepend(['\x1b[38;2;10;20;30mtrue'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(false);
    expect(plan.endState.fg).toBe('#0a141e');
  });

  test('256-color background reset can converge back to default', () => {
    const plan = planPrepend(['\x1b[48;5;34mbg', '\x1b[49mno bg', 'plain'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(true);
    expect(plan.endState.bg).toBeNull();
  });

  test('bold and dim reset with SGR 22 before the seam', () => {
    const plan = planPrepend(['\x1b[1;2mbold dim', '\x1b[22mnormal', 'plain'], 'first', createSgrState());
    expect(plan.endState.bold).toBe(false);
    expect(plan.endState.dim).toBe(false);
    expect(plan.existingCacheValid).toBe(true);
  });

  test('underline, inverse, and strike persist when not reset', () => {
    const plan = planPrepend(['\x1b[4;7;9mstyled'], 'first', createSgrState());
    expect(plan.endState.underline).toBe(true);
    expect(plan.endState.inverse).toBe(true);
    expect(plan.endState.strike).toBe(true);
    expect(plan.existingCacheValid).toBe(false);
  });

  test('style-specific resets can converge', () => {
    const plan = planPrepend(['\x1b[3;4;7;9mstyled', '\x1b[23;24;27;29mplain', 'first'], 'next', createSgrState());
    expect(plan.existingCacheValid).toBe(true);
    expect(sgrStateKey(plan.endState)).toBe(sgrStateKey(createSgrState()));
  });

  test('non-SGR escapes use lineToHtml semantics and do not affect state', () => {
    const plan = planPrepend(['\x1b]0;title\x07plain', '\x1b[2Jstill plain'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(true);
  });

  test('malformed or truncated SGR bytes do not leak a false color state', () => {
    const plan = planPrepend(['\x1b[31', 'plain'], 'first', createSgrState());
    expect(plan.existingCacheValid).toBe(true);
    expect(sgrStateKey(plan.endState)).toBe(sgrStateKey(createSgrState()));
  });

  test('the existing first state is compared by value and not mutated', () => {
    const existing = stateAfter(['\x1b[35mmagenta']);
    const before = sgrStateKey(existing);
    const plan = planPrepend(['plain'], 'first', existing);
    expect(plan.existingCacheValid).toBe(false);
    expect(sgrStateKey(existing)).toBe(before);
  });

  test('returned states are independent clones', () => {
    const plan = planPrepend(['\x1b[31mred', '\x1b[32mgreen', 'carry'], 'first', createSgrState());
    const beforeSecond = sgrStateKey(plan.batchStates[1]);
    plan.batchStates[0].fg = null;
    plan.endState.fg = null;
    expect(sgrStateKey(plan.batchStates[1])).toBe(beforeSecond);
  });

  test('huge batch timing sanity remains linear', () => {
    const batch = Array.from({ length: 5000 }, (_, i) => (
      i % 250 === 0 ? `\x1b[3${i % 8}mline ${i}` : `line ${i}\x1b[0m`
    ));
    const started = performance.now();
    const plan = planPrepend(batch, 'first', createSgrState());
    const elapsed = performance.now() - started;
    expect(plan.batchStates).toHaveLength(5000);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});
