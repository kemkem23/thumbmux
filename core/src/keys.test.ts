import { describe, expect, test } from 'bun:test';

import { bracketedPaste, keyboardEventToSequence, type KeyLike } from './keys';

describe('keyboardEventToSequence guards', () => {
  test('returns null while text composition is active', () => {
    expect(keyboardEventToSequence({ key: 'a', isComposing: true })).toBeNull();
  });

  test('returns null for Meta with a printable key', () => {
    expect(keyboardEventToSequence({ key: 'v', metaKey: true })).toBeNull();
  });

  test('returns null for Meta with a control key', () => {
    expect(keyboardEventToSequence({ key: 'c', ctrlKey: true, metaKey: true })).toBeNull();
  });

  test('returns null for Meta with Enter', () => {
    expect(keyboardEventToSequence({ key: 'Enter', metaKey: true })).toBeNull();
  });
});

describe('keyboardEventToSequence printable keys', () => {
  const cases: Array<[string, string]> = [
    ['a', 'a'],
    ['A', 'A'],
    ['!', '!'],
    ['ส', 'ส'],
    [' ', ' '],
  ];

  for (const [key, expected] of cases) {
    test(`returns ${JSON.stringify(expected)} for printable key ${JSON.stringify(key)}`, () => {
      expect(keyboardEventToSequence({ key })).toBe(expected);
    });
  }

  const altCases: Array<[string, string]> = [
    ['a', '\x1ba'],
    ['A', '\x1bA'],
    ['?', '\x1b?'],
    ['ส', '\x1bส'],
  ];

  for (const [key, expected] of altCases) {
    test(`prefixes Alt printable key ${JSON.stringify(key)} with escape`, () => {
      expect(keyboardEventToSequence({ key, altKey: true })).toBe(expected);
    });
  }

  test('prefixes Alt+Enter with escape', () => {
    expect(keyboardEventToSequence({ key: 'Enter', altKey: true })).toBe('\x1b\r');
  });
});

describe('keyboardEventToSequence named keys', () => {
  const cases: Array<[string, KeyLike, string | null]> = [
    ['Enter', { key: 'Enter' }, '\r'],
    ['Tab', { key: 'Tab' }, '\t'],
    ['Shift+Tab', { key: 'Tab', shiftKey: true }, '\x1b[Z'],
    ['Ctrl+Tab', { key: 'Tab', ctrlKey: true }, null],
    ['Alt+Tab', { key: 'Tab', altKey: true }, null],
    ['Backspace', { key: 'Backspace' }, '\x7f'],
    ['Escape', { key: 'Escape' }, '\x1b'],
    ['Delete', { key: 'Delete' }, '\x1b[3~'],
    ['Insert', { key: 'Insert' }, '\x1b[2~'],
    ['Home', { key: 'Home' }, '\x1b[H'],
    ['End', { key: 'End' }, '\x1b[F'],
    ['PageUp', { key: 'PageUp' }, '\x1b[5~'],
    ['PageDown', { key: 'PageDown' }, '\x1b[6~'],
  ];

  for (const [name, event, expected] of cases) {
    test(`maps ${name}`, () => {
      expect(keyboardEventToSequence(event)).toBe(expected);
    });
  }
});

describe('keyboardEventToSequence arrows and modified navigation', () => {
  const plainCases: Array<[string, string]> = [
    ['ArrowUp', '\x1b[A'],
    ['ArrowDown', '\x1b[B'],
    ['ArrowRight', '\x1b[C'],
    ['ArrowLeft', '\x1b[D'],
  ];

  for (const [key, expected] of plainCases) {
    test(`maps ${key}`, () => {
      expect(keyboardEventToSequence({ key })).toBe(expected);
    });
  }

  const modifiedCases: Array<[string, KeyLike, string]> = [
    ['Ctrl+Right', { key: 'ArrowRight', ctrlKey: true }, '\x1b[1;5C'],
    ['Shift+Up', { key: 'ArrowUp', shiftKey: true }, '\x1b[1;2A'],
    ['Alt+Left', { key: 'ArrowLeft', altKey: true }, '\x1b[1;3D'],
    ['Shift+Alt+Ctrl+Down', { key: 'ArrowDown', shiftKey: true, altKey: true, ctrlKey: true }, '\x1b[1;8B'],
    ['Shift+Home', { key: 'Home', shiftKey: true }, '\x1b[1;2H'],
    ['Alt+Ctrl+End', { key: 'End', altKey: true, ctrlKey: true }, '\x1b[1;7F'],
  ];

  for (const [name, event, expected] of modifiedCases) {
    test(`maps ${name} with xterm modifiers`, () => {
      expect(keyboardEventToSequence(event)).toBe(expected);
    });
  }
});

describe('keyboardEventToSequence function keys', () => {
  const cases: Array<[string, string]> = [
    ['F1', '\x1bOP'],
    ['F2', '\x1bOQ'],
    ['F3', '\x1bOR'],
    ['F4', '\x1bOS'],
    ['F5', '\x1b[15~'],
    ['F6', '\x1b[17~'],
    ['F7', '\x1b[18~'],
    ['F8', '\x1b[19~'],
    ['F9', '\x1b[20~'],
    ['F10', '\x1b[21~'],
    ['F11', '\x1b[23~'],
    ['F12', '\x1b[24~'],
  ];

  for (const [key, expected] of cases) {
    test(`maps ${key}`, () => {
      expect(keyboardEventToSequence({ key })).toBe(expected);
    });
  }
});

describe('keyboardEventToSequence control keys', () => {
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    const key = i % 2 === 0 ? letter : letter.toUpperCase();
    const expected = String.fromCharCode(i + 1);

    test(`maps Ctrl+${letter.toUpperCase()} to control byte ${i + 1}`, () => {
      expect(keyboardEventToSequence({ key, ctrlKey: true })).toBe(expected);
    });
  }

  const punctuationCases: Array<[string, KeyLike, string]> = [
    ['Ctrl+Space by key', { key: ' ', ctrlKey: true }, '\x00'],
    ['Ctrl+Space by code', { key: '', code: 'Space', ctrlKey: true }, '\x00'],
    ['Ctrl+[', { key: '[', ctrlKey: true }, '\x1b'],
    ['Ctrl+\\', { key: '\\', ctrlKey: true }, '\x1c'],
    ['Ctrl+]', { key: ']', ctrlKey: true }, '\x1d'],
  ];

  for (const [name, event, expected] of punctuationCases) {
    test(`maps ${name}`, () => {
      expect(keyboardEventToSequence(event)).toBe(expected);
    });
  }

  const nullCases: KeyLike[] = [
    { key: '1', ctrlKey: true },
    { key: '0', ctrlKey: true },
    { key: '=', ctrlKey: true },
    { key: '-', ctrlKey: true },
    { key: '/', ctrlKey: true },
  ];

  for (const event of nullCases) {
    test(`returns null for Ctrl+${event.key}`, () => {
      expect(keyboardEventToSequence(event)).toBeNull();
    });
  }
});

describe('keyboardEventToSequence unlisted keys', () => {
  const cases: KeyLike[] = [
    { key: 'Shift' },
    { key: 'CapsLock' },
    { key: 'Dead' },
    { key: 'ContextMenu' },
  ];

  for (const event of cases) {
    test(`returns null for ${event.key}`, () => {
      expect(keyboardEventToSequence(event)).toBeNull();
    });
  }
});

describe('bracketedPaste', () => {
  test('wraps text with bracketed paste markers and normalizes newlines', () => {
    expect(bracketedPaste('a\r\nb\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~');
  });

  test('preserves existing carriage returns', () => {
    expect(bracketedPaste('a\rb')).toBe('\x1b[200~a\rb\x1b[201~');
  });
});
