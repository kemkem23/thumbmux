import { describe, expect, test } from 'bun:test';
import {
  CLEAR_CONTEXT_CONTROL_BYTES,
  DEFAULT_CLEAR_COMMAND,
  clearContextPlan,
  clearContextStrategy,
  type ClearContextStep,
} from './clear-context';

/**
 * The plan these tests pin is the sequence kemcortex's server has been sending
 * since the CLEAR CONTEXT button existed. It is transcribed here as literal
 * expected arrays rather than rebuilt from the same constants the module uses,
 * so a changed default fails instead of moving both sides together.
 */
const GENERIC: ClearContextStep[] = [
  { kind: 'control', control: 'C-u', delayBeforeMs: 0 },
  { kind: 'submit', text: '/clear', delayBeforeMs: 120 },
];

const CODEX: ClearContextStep[] = [
  { kind: 'control', control: 'C-u', delayBeforeMs: 0 },
  { kind: 'control', control: 'Escape', delayBeforeMs: 0 },
  { kind: 'submit', text: '/clear', delayBeforeMs: 1000 },
  { kind: 'enter', delayBeforeMs: 1000 },
];

describe('clearContextPlan', () => {
  test('an unnamed agent gets the single-submit plan', () => {
    expect(clearContextPlan()).toEqual(GENERIC);
  });

  test('generic, claude and grok all take the single-submit plan', () => {
    for (const agent of ['generic', 'claude', 'grok'] as const) {
      expect(clearContextPlan({ agent })).toEqual(GENERIC);
      expect(clearContextStrategy(agent)).toBe('single-submit');
    }
  });

  test('codex cancels its input mode and gets a second, separately timed Enter', () => {
    expect(clearContextPlan({ agent: 'codex' })).toEqual(CODEX);
    expect(clearContextStrategy('codex')).toBe('codex-double-enter');
  });

  test('every plan discards the composer before it types anything', () => {
    for (const agent of ['generic', 'claude', 'grok', 'codex'] as const) {
      const [first] = clearContextPlan({ agent });
      expect(first).toEqual({ kind: 'control', control: 'C-u', delayBeforeMs: 0 });
    }
  });

  test('only the codex plan submits twice', () => {
    const submits = (agent: 'generic' | 'codex') =>
      clearContextPlan({ agent }).filter((s) => s.kind === 'submit' || s.kind === 'enter').length;
    expect(submits('generic')).toBe(1);
    expect(submits('codex')).toBe(2);
  });

  test('the command is overridable and is the only text ever typed', () => {
    const plan = clearContextPlan({ agent: 'codex', command: '/new' });
    expect(plan.filter((s) => s.kind === 'submit')).toEqual([
      { kind: 'submit', text: '/new', delayBeforeMs: 1000 },
    ]);
    expect(DEFAULT_CLEAR_COMMAND).toBe('/clear');
  });

  test('host timings replace the defaults on the path that uses them', () => {
    expect(clearContextPlan({ settleMs: 0 })).toEqual([
      { kind: 'control', control: 'C-u', delayBeforeMs: 0 },
      { kind: 'submit', text: '/clear', delayBeforeMs: 0 },
    ]);
    expect(clearContextPlan({ agent: 'codex', codexSecondEnterMs: 250 })).toEqual([
      { kind: 'control', control: 'C-u', delayBeforeMs: 0 },
      { kind: 'control', control: 'Escape', delayBeforeMs: 0 },
      { kind: 'submit', text: '/clear', delayBeforeMs: 250 },
      { kind: 'enter', delayBeforeMs: 250 },
    ]);
  });

  test('a negative delay is floored, never sent as a negative wait', () => {
    expect(clearContextPlan({ settleMs: -50 })[1]).toEqual({
      kind: 'submit',
      text: '/clear',
      delayBeforeMs: 0,
    });
    const codex = clearContextPlan({ agent: 'codex', codexSecondEnterMs: -1 });
    expect(codex.map((s) => s.delayBeforeMs)).toEqual([0, 0, 0, 0]);
  });

  test('settleMs does not leak into the codex path, nor codexSecondEnterMs into the other', () => {
    expect(clearContextPlan({ agent: 'codex', settleMs: 7 })).toEqual(CODEX);
    expect(clearContextPlan({ agent: 'generic', codexSecondEnterMs: 7 })).toEqual(GENERIC);
  });

  test('a fresh array is returned each call — a host may mutate its own copy', () => {
    const a = clearContextPlan();
    const b = clearContextPlan();
    expect(a).not.toBe(b);
    a.push({ kind: 'enter', delayBeforeMs: 0 });
    expect(clearContextPlan()).toEqual(GENERIC);
  });

  test('control bytes are the raw input a non-symbolic transport must write', () => {
    expect(CLEAR_CONTEXT_CONTROL_BYTES['C-u']).toBe(String.fromCharCode(0x15));
    expect(CLEAR_CONTEXT_CONTROL_BYTES.Escape).toBe(String.fromCharCode(0x1b));
    // Every control the plan can emit has a byte; a transport can be total.
    for (const step of [...GENERIC, ...CODEX]) {
      if (step.kind === 'control') {
        expect(CLEAR_CONTEXT_CONTROL_BYTES[step.control]).toHaveLength(1);
      }
    }
  });

  test('no step carries a bare carriage return — Enter is its own step kind', () => {
    for (const agent of ['generic', 'claude', 'grok', 'codex'] as const) {
      for (const step of clearContextPlan({ agent })) {
        if (step.kind === 'submit') expect(step.text).not.toMatch(/[\r\n]/);
      }
    }
  });
});
