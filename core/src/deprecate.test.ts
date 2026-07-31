import { beforeEach, describe, expect, test } from 'bun:test';

import { resetDeprecationWarnings, warnDeprecated } from './deprecate';

const WARNING_FORMAT = /^\[thumbmux\] [^\n]+ is deprecated since v\d+\.\d+\.\d+ — [^\n]+; removal no earlier than v\d+\.\d+\.\d+$/;

function messageFor(key: string, replacement: string): string {
  return `[thumbmux] ${key} is deprecated since v0.8.0 — use ${replacement}; removal no earlier than v0.9.0`;
}

beforeEach(resetDeprecationWarnings);

describe('warnDeprecated', () => {
  test('warns once when the same key is called three times', () => {
    const warnings: string[] = [];
    const key = 'LegacyThing';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      warnDeprecated(key, messageFor(key, 'CurrentThing'), (message) => warnings.push(message));
    }

    expect(warnings).toHaveLength(1);
  });

  test('warns separately for distinct keys', () => {
    const warnings: string[] = [];

    warnDeprecated('LegacyOne', messageFor('LegacyOne', 'CurrentOne'), (message) => warnings.push(message));
    warnDeprecated('LegacyTwo', messageFor('LegacyTwo', 'CurrentTwo'), (message) => warnings.push(message));

    expect(warnings).toHaveLength(2);
  });

  test('warns again after warning state is reset', () => {
    const warnings: string[] = [];
    const key = 'LegacyThing';
    const message = messageFor(key, 'CurrentThing');
    const log = (warning: string): void => {
      warnings.push(warning);
    };

    warnDeprecated(key, message, log);
    resetDeprecationWarnings();
    warnDeprecated(key, message, log);

    expect(warnings).toHaveLength(2);
  });

  test('emits the required deprecation message format', () => {
    const warnings: string[] = [];

    warnDeprecated(
      'JournalRecordV1',
      messageFor('JournalRecordV1', 'FrameJournalRecordV1'),
      (message) => warnings.push(message),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(WARNING_FORMAT);
  });
});
