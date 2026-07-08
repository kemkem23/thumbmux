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

describe('keyboardEventToSequence AltGr and Option handling', () => {
  const altGrCases: Array<[string, string]> = [
    ['[', '['],
    [']', ']'],
    ['\\', '\\'],
    ['@', '@'],
    ['{', '{'],
    ['}', '}'],
    ['~', '~'],
    ['|', '|'],
  ];

  for (const [key, expected] of altGrCases) {
    test(`returns AltGr printable ${JSON.stringify(key)} verbatim`, () => {
      expect(keyboardEventToSequence({ key, ctrlKey: true, altKey: true })).toBe(expected);
    });
  }

  const optionPrintableCases: Array<[string, KeyLike, { altIsMeta?: boolean } | undefined, string]> = [
    ['default Alt printable prefixes escape', { key: 'a', altKey: true }, undefined, '\x1ba'],
    ['explicit altIsMeta=true prefixes escape', { key: 'å', altKey: true }, { altIsMeta: true }, '\x1bå'],
    ['altIsMeta=false sends composed character verbatim', { key: 'å', altKey: true }, { altIsMeta: false }, 'å'],
    [
      'altIsMeta=false keeps shifted composed character verbatim',
      { key: 'Í', altKey: true, shiftKey: true },
      { altIsMeta: false },
      'Í',
    ],
  ];

  for (const [name, event, opts, expected] of optionPrintableCases) {
    test(name, () => {
      expect(keyboardEventToSequence(event, opts)).toBe(expected);
    });
  }

  const optionNamedCases: Array<[string, KeyLike, string | null]> = [
    ['Alt+Delete keeps Alt modifier when altIsMeta=false', { key: 'Delete', altKey: true }, '\x1b[3;3~'],
    ['Alt+F2 keeps Alt modifier when altIsMeta=false', { key: 'F2', altKey: true }, '\x1b[1;3Q'],
    ['Alt+ArrowLeft keeps Alt modifier when altIsMeta=false', { key: 'ArrowLeft', altKey: true }, '\x1b[1;3D'],
    ['Alt+Backspace keeps Alt prefix when altIsMeta=false', { key: 'Backspace', altKey: true }, '\x1b\x7f'],
    ['Alt+Enter keeps Alt prefix when altIsMeta=false', { key: 'Enter', altKey: true }, '\x1b\r'],
    ['Alt+Tab stays browser-handled when altIsMeta=false', { key: 'Tab', altKey: true }, null],
  ];

  for (const [name, event, expected] of optionNamedCases) {
    test(name, () => {
      expect(keyboardEventToSequence(event, { altIsMeta: false })).toBe(expected);
    });
  }
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

describe('keyboardEventToSequence modified named keys', () => {
  const cases: Array<[string, KeyLike, string | null]> = [
    ['Shift+Backspace', { key: 'Backspace', shiftKey: true }, '\x7f'],
    ['Alt+Backspace', { key: 'Backspace', altKey: true }, '\x1b\x7f'],
    ['Ctrl+Backspace', { key: 'Backspace', ctrlKey: true }, '\x08'],
    ['Alt+Ctrl+Backspace', { key: 'Backspace', altKey: true, ctrlKey: true }, '\x1b\x08'],
    ['Alt+Escape', { key: 'Escape', altKey: true }, '\x1b'],
    ['Ctrl+Escape', { key: 'Escape', ctrlKey: true }, '\x1b'],
    ['Shift+Delete', { key: 'Delete', shiftKey: true }, '\x1b[3;2~'],
    ['Alt+Delete', { key: 'Delete', altKey: true }, '\x1b[3;3~'],
    ['Ctrl+Delete', { key: 'Delete', ctrlKey: true }, '\x1b[3;5~'],
    [
      'Shift+Alt+Ctrl+Delete',
      { key: 'Delete', shiftKey: true, altKey: true, ctrlKey: true },
      '\x1b[3;8~',
    ],
    ['Alt+PageUp', { key: 'PageUp', altKey: true }, '\x1b[5;3~'],
    ['Ctrl+PageUp', { key: 'PageUp', ctrlKey: true }, '\x1b[5;5~'],
    ['Shift+PageUp', { key: 'PageUp', shiftKey: true }, '\x1b[5;2~'],
    ['Alt+PageDown', { key: 'PageDown', altKey: true }, '\x1b[6;3~'],
    ['Ctrl+PageDown', { key: 'PageDown', ctrlKey: true }, '\x1b[6;5~'],
    ['Shift+Alt+PageDown', { key: 'PageDown', shiftKey: true, altKey: true }, '\x1b[6;4~'],
    ['Alt+Insert', { key: 'Insert', altKey: true }, '\x1b[2;3~'],
    ['Ctrl+Insert', { key: 'Insert', ctrlKey: true }, null],
    ['Shift+Insert', { key: 'Insert', shiftKey: true }, null],
    ['Shift+Alt+Insert', { key: 'Insert', shiftKey: true, altKey: true }, null],
    ['Ctrl+Alt+Insert', { key: 'Insert', ctrlKey: true, altKey: true }, null],
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

describe('keyboardEventToSequence modified function keys', () => {
  const cases: Array<[string, KeyLike, string]> = [
    ['Shift+F1', { key: 'F1', shiftKey: true }, '\x1b[1;2P'],
    ['Alt+F2', { key: 'F2', altKey: true }, '\x1b[1;3Q'],
    ['Ctrl+F3', { key: 'F3', ctrlKey: true }, '\x1b[1;5R'],
    ['Shift+Alt+Ctrl+F4', { key: 'F4', shiftKey: true, altKey: true, ctrlKey: true }, '\x1b[1;8S'],
    ['Shift+F5', { key: 'F5', shiftKey: true }, '\x1b[15;2~'],
    ['Alt+F6', { key: 'F6', altKey: true }, '\x1b[17;3~'],
    ['Ctrl+F7', { key: 'F7', ctrlKey: true }, '\x1b[18;5~'],
    ['Shift+Alt+Ctrl+F8', { key: 'F8', shiftKey: true, altKey: true, ctrlKey: true }, '\x1b[19;8~'],
    ['Shift+F9', { key: 'F9', shiftKey: true }, '\x1b[20;2~'],
    ['Alt+F10', { key: 'F10', altKey: true }, '\x1b[21;3~'],
    ['Ctrl+F11', { key: 'F11', ctrlKey: true }, '\x1b[23;5~'],
    ['Shift+Alt+F12', { key: 'F12', shiftKey: true, altKey: true }, '\x1b[24;4~'],
  ];

  for (const [name, event, expected] of cases) {
    test(`maps ${name}`, () => {
      expect(keyboardEventToSequence(event)).toBe(expected);
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

  const ctrlShiftLetterCases: Array<[string, KeyLike, string]> = [
    ['Ctrl+Shift+A', { key: 'A', ctrlKey: true, shiftKey: true }, '\x01'],
    ['Ctrl+Shift+M', { key: 'M', ctrlKey: true, shiftKey: true }, '\r'],
    ['Ctrl+Shift+Z', { key: 'Z', ctrlKey: true, shiftKey: true }, '\x1a'],
  ];

  for (const [name, event, expected] of ctrlShiftLetterCases) {
    test(`maps ${name} to the same C0 byte as Ctrl+letter`, () => {
      expect(keyboardEventToSequence(event)).toBe(expected);
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

  const digitCases: Array<[string, string | null]> = [
    ['0', null],
    ['1', null],
    ['2', '\x00'],
    ['3', '\x1b'],
    ['4', '\x1c'],
    ['5', '\x1d'],
    ['6', '\x1e'],
    ['7', '\x1f'],
    ['8', '\x7f'],
    ['9', null],
  ];

  for (const [key, expected] of digitCases) {
    test(`maps Ctrl+${key} with the xterm digit table`, () => {
      expect(keyboardEventToSequence({ key, ctrlKey: true })).toBe(expected);
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
