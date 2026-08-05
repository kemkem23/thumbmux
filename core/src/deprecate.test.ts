import { beforeEach, describe, expect, test } from 'bun:test';

import { resetDeprecationWarnings, warnDeprecated } from './deprecate';

const WARNING_FORMAT = /^\[thumbmux\] [^\r\n]+ is deprecated since v\d+\.\d+\.\d+ — use [^\r\n]+; removal no earlier than v\d+\.\d+\.\d+$/;

function detailsFor(replacement: string) {
  return {
    since: '0.8.0',
    replacement,
    removeNoEarlierThan: '0.9.0',
  } as const;
}

beforeEach(resetDeprecationWarnings);

describe('warnDeprecated', () => {
  test('warns once when the same key is called three times', () => {
    const warnings: string[] = [];
    const key = 'LegacyThing';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      warnDeprecated(key, detailsFor('CurrentThing'), (message) => warnings.push(message));
    }

    expect(warnings).toHaveLength(1);
  });

  test('warns separately for distinct keys', () => {
    const warnings: string[] = [];

    warnDeprecated('LegacyOne', detailsFor('CurrentOne'), (message) => warnings.push(message));
    warnDeprecated('LegacyTwo', detailsFor('CurrentTwo'), (message) => warnings.push(message));

    expect(warnings).toHaveLength(2);
  });

  test('warns again after warning state is reset', () => {
    const warnings: string[] = [];
    const key = 'LegacyThing';
    const details = detailsFor('CurrentThing');
    const log = (warning: string): void => {
      warnings.push(warning);
    };

    warnDeprecated(key, details, log);
    resetDeprecationWarnings();
    warnDeprecated(key, details, log);

    expect(warnings).toHaveLength(2);
  });

  test('emits the required deprecation message format', () => {
    const warnings: string[] = [];

    warnDeprecated(
      'JournalRecordV1',
      detailsFor('FrameJournalRecordV1'),
      (message) => warnings.push(message),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[thumbmux] JournalRecordV1 is deprecated since v0.8.0 — use FrameJournalRecordV1; removal no earlier than v0.9.0',
    );
    expect(warnings[0]).toMatch(WARNING_FORMAT);
  });

  test('V1 attack: rejects an unstructured warning message', () => {
    const warnings: string[] = [];

    expect(() => {
      warnDeprecated(
        'LegacyThing',
        'migrate whenever' as never,
        (message) => warnings.push(message),
      );
    }).toThrow('warnDeprecated details must be an object');
    expect(warnings).toHaveLength(0);
  });

  test('a throwing logger does not permanently suppress the warning (A2-9)', () => {
    const key = 'ThrowThenRetry';
    const details = detailsFor('CurrentThing');

    expect(() => {
      warnDeprecated(key, details, () => {
        throw new Error('log transport failed');
      });
    }).toThrow('log transport failed');

    const warnings: string[] = [];
    warnDeprecated(key, details, (message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(WARNING_FORMAT);
  });
});
