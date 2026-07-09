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

  test('preserves bulk text exactly', () => {
    const text = 'first line\r\nsecond\tline\n';
    expect(submitPlan(text)[0]).toEqual({ keys: text, delayBeforeMs: 0 });
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
