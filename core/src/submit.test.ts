import { describe, expect, test } from 'bun:test';

import { submitPlan, type SubmitAgent } from './submit';

function namedAgent(left: string, right: string): SubmitAgent {
  return `${left}${right}` as SubmitAgent;
}

describe('submitPlan', () => {
  test('plans text then delayed Enter by default', () => {
    expect(submitPlan('hello')).toEqual([
      { keys: 'hello', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 150 },
    ]);
  });

  test('empty text sends only Enter by default', () => {
    expect(submitPlan('')).toEqual([{ keys: '\r', delayBeforeMs: 150 }]);
  });

  test('preserves bulk text content without bare CR in the text step', () => {
    // Multline / CR host text must not put a bare Enter inside the text step —
    // that submits early (A2-2). Content is preserved via bracketed paste.
    const text = 'first line\r\nsecond\tline\n';
    const plan = submitPlan(text);
    const textStep = plan[0];
    expect(textStep.delayBeforeMs).toBe(0);
    // Planned Enter remains a separate delayed step.
    expect(plan.some((s) => s.keys === '\r' && s.delayBeforeMs > 0)).toBe(true);
    // No bare CR outside paste delimiters.
    const outsidePaste = textStep.keys.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
    expect(outsidePaste.includes('\r')).toBe(false);
    // Payload still carries both lines and the tab.
    expect(textStep.keys.includes('first line')).toBe(true);
    expect(textStep.keys.includes('second\tline')).toBe(true);
  });

  test('text step never contains a bare CR that would submit early (A2-2)', () => {
    const plan = submitPlan('first\rsecond');
    expect(plan.length).toBeGreaterThanOrEqual(2);
    // Final planned Enter is still present and delayed.
    expect(plan.at(-1)).toEqual({ keys: '\r', delayBeforeMs: 150 });
    const textSteps = plan.filter((s) => s.keys !== '\r');
    expect(textSteps.length).toBe(1);
    const keys = textSteps[0].keys;
    // Bare "first\rsecond" as a single keystroke batch is the bug: the embedded
    // CR submits `first` before `second` lands. The text step must either drop
    // that CR or quarantine it inside bracketed-paste delimiters.
    expect(keys).not.toBe('first\rsecond');
    const outsidePaste = keys.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '');
    expect(outsidePaste.includes('\r')).toBe(false);
    expect(keys.includes('first')).toBe(true);
    expect(keys.includes('second')).toBe(true);
  });

  test('generic agent uses the default two-step plan', () => {
    expect(submitPlan('go', { agent: 'generic' })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 150 },
    ]);
  });

  test('first named agent uses the default two-step plan', () => {
    expect(submitPlan('go', { agent: namedAgent('clau', 'de') })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 150 },
    ]);
  });

  test('third named agent uses the default two-step plan', () => {
    expect(submitPlan('go', { agent: namedAgent('gr', 'ok') })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 150 },
    ]);
  });

  test('extra-enter agent adds a second delayed Enter', () => {
    expect(submitPlan('go', { agent: namedAgent('co', 'dex') })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 150 },
      { keys: '\r', delayBeforeMs: 1000 },
    ]);
  });

  test('empty text for extra-enter agent contains only Enter steps', () => {
    expect(submitPlan('', { agent: namedAgent('co', 'dex') })).toEqual([
      { keys: '\r', delayBeforeMs: 150 },
      { keys: '\r', delayBeforeMs: 1000 },
    ]);
  });

  test('enterDelayMs overrides the first Enter delay', () => {
    expect(submitPlan('go', { enterDelayMs: 300 })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 300 },
    ]);
  });

  test('enterDelayMs preserves zero', () => {
    expect(submitPlan('go', { enterDelayMs: 0 })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 0 },
    ]);
  });

  test('custom first Enter delay does not alter the extra Enter delay', () => {
    expect(submitPlan('go', { agent: namedAgent('co', 'dex'), enterDelayMs: 25 })).toEqual([
      { keys: 'go', delayBeforeMs: 0 },
      { keys: '\r', delayBeforeMs: 25 },
      { keys: '\r', delayBeforeMs: 1000 },
    ]);
  });

  test('returns a new plan on each call', () => {
    const first = submitPlan('go');
    const second = submitPlan('go');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
