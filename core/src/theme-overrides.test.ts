import { describe, expect, test } from 'bun:test';
import {
  THEME_MODES,
  emptyThemeBackgrounds,
  isThemeBackground,
  isThemeMode,
  parseThemeBackgrounds,
  parseThemeBackgroundsJson,
  readThemeBackground,
  writeThemeBackground,
} from './theme-overrides';

describe('isThemeMode / THEME_MODES', () => {
  test('only the two modes are modes', () => {
    expect(THEME_MODES).toEqual(['dark', 'light']);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    for (const other of ['Dark', 'auto', '', null, undefined, 0]) {
      expect(isThemeMode(other)).toBe(false);
    }
  });
});

describe('isThemeBackground', () => {
  test('six-digit hex in either case is renderable', () => {
    expect(isThemeBackground('#B05606')).toBe(true);
    expect(isThemeBackground('#b05606')).toBe(true);
  });

  test('forms the renderer cannot read are rejected', () => {
    for (const value of [
      '#fff', '#FFFF', '#12345', '#1234567', 'B05606', 'rebeccapurple',
      'rgb(1,2,3)', '', ' #b05606', '#b05606 ', null, undefined, 0xb05606, {},
    ]) {
      expect(isThemeBackground(value)).toBe(false);
    }
  });
});

describe('parseThemeBackgrounds', () => {
  test('a well-formed blob round-trips both modes', () => {
    const parsed = parseThemeBackgrounds({
      dark: { cc: '#B05606', codex: '#0709BD' },
      light: { cc: '#FFD6A1' },
    });
    expect(parsed).toEqual({
      dark: { cc: '#B05606', codex: '#0709BD' },
      light: { cc: '#FFD6A1' },
    });
  });

  test('garbage yields empty sides instead of throwing', () => {
    for (const raw of [null, undefined, 'nope', 42, [], [{ dark: {} }]]) {
      expect(parseThemeBackgrounds(raw)).toEqual(emptyThemeBackgrounds());
    }
  });

  test('one usable mode survives while the broken one goes empty', () => {
    expect(parseThemeBackgrounds({ dark: { cc: '#B05606' }, light: 'broken' })).toEqual({
      dark: { cc: '#B05606' },
      light: {},
    });
    expect(parseThemeBackgrounds({ light: { sh: '#F0F2F4' } })).toEqual({
      dark: {},
      light: { sh: '#F0F2F4' },
    });
  });

  test('non-string entries are dropped, unknown-but-string entries are kept', () => {
    const parsed = parseThemeBackgrounds({
      dark: { good: '#B05606', numeric: 11, nested: { a: 1 }, future: 'oklch(0.5 0.1 20)' },
      light: {},
    });
    expect(parsed.dark).toEqual({ good: '#B05606', future: 'oklch(0.5 0.1 20)' });
  });

  test('a kept-but-unrenderable entry reads as no override', () => {
    const parsed = parseThemeBackgrounds({ dark: { cc: 'oklch(0.5 0.1 20)' }, light: {} });
    expect(readThemeBackground(parsed, 'dark', 'cc')).toBeNull();
  });

  test('__proto__ in the blob does not become this object prototype', () => {
    const parsed = parseThemeBackgrounds(
      JSON.parse('{"dark":{"__proto__":{"polluted":true},"cc":"#B05606"}}'),
    );
    expect(readThemeBackground(parsed, 'dark', 'cc')).toBe('#B05606');
    expect(Object.getPrototypeOf(parsed.dark)).toBe(Object.prototype);
    expect((parsed.dark as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('the input object is not aliased into the result', () => {
    const source = { dark: { cc: '#B05606' }, light: {} };
    const parsed = parseThemeBackgrounds(source);
    expect(parsed.dark).not.toBe(source.dark);
    source.dark.cc = '#000000';
    expect(readThemeBackground(parsed, 'dark', 'cc')).toBe('#B05606');
  });
});

describe('parseThemeBackgroundsJson', () => {
  test('reads the string a localStorage-backed host stored', () => {
    const stored = JSON.stringify({ dark: { cc: '#B05606' }, light: { cc: '#FFD6A1' } });
    expect(readThemeBackground(parseThemeBackgroundsJson(stored), 'light', 'cc')).toBe('#FFD6A1');
  });

  test('a missing key or torn JSON is empty, not an exception', () => {
    for (const raw of [null, undefined, '', '{oops', '[1,2']) {
      expect(parseThemeBackgroundsJson(raw)).toEqual(emptyThemeBackgrounds());
    }
  });
});

describe('readThemeBackground', () => {
  test('absent keys and unrenderable values both read as null', () => {
    const map = parseThemeBackgrounds({ dark: { cc: '#fff' }, light: {} });
    expect(readThemeBackground(map, 'dark', 'cc')).toBeNull();
    expect(readThemeBackground(map, 'dark', 'never-set')).toBeNull();
    expect(readThemeBackground(map, 'light', 'cc')).toBeNull();
  });
});

describe('writeThemeBackground', () => {
  test('setting one mode leaves the other memory untouched', () => {
    const start = emptyThemeBackgrounds();
    const next = writeThemeBackground(start, 'dark', 'cc', '#B05606');
    expect(readThemeBackground(next, 'dark', 'cc')).toBe('#B05606');
    expect(readThemeBackground(next, 'light', 'cc')).toBeNull();
    // The untouched side keeps its identity so a per-mode memo stays valid.
    expect(next.light).toBe(start.light);
  });

  test('the input map is never mutated', () => {
    const start = parseThemeBackgrounds({ dark: { cc: '#B05606' }, light: {} });
    const next = writeThemeBackground(start, 'dark', 'cc', '#000000');
    expect(readThemeBackground(start, 'dark', 'cc')).toBe('#B05606');
    expect(readThemeBackground(next, 'dark', 'cc')).toBe('#000000');
    expect(next).not.toBe(start);
    expect(next.dark).not.toBe(start.dark);
  });

  test('null clears exactly one key', () => {
    let map = emptyThemeBackgrounds();
    map = writeThemeBackground(map, 'dark', 'cc', '#B05606');
    map = writeThemeBackground(map, 'dark', 'codex', '#0709BD');
    map = writeThemeBackground(map, 'dark', 'cc', null);
    expect(readThemeBackground(map, 'dark', 'cc')).toBeNull();
    expect(readThemeBackground(map, 'dark', 'codex')).toBe('#0709BD');
    expect(Object.keys(map.dark)).toEqual(['codex']);
  });

  test('an unrenderable hex clears rather than persisting a value that cannot come back', () => {
    let map = writeThemeBackground(emptyThemeBackgrounds(), 'dark', 'cc', '#B05606');
    map = writeThemeBackground(map, 'dark', 'cc', '#fff');
    expect(readThemeBackground(map, 'dark', 'cc')).toBeNull();
    expect(Object.keys(map.dark)).toEqual([]);
  });

  test('clearing something never set is a no-op, not a crash', () => {
    const map = writeThemeBackground(emptyThemeBackgrounds(), 'light', 'ghost', null);
    expect(map).toEqual(emptyThemeBackgrounds());
  });

  test('a full pick/clear cycle survives a JSON round trip', () => {
    let map = emptyThemeBackgrounds();
    map = writeThemeBackground(map, 'dark', 'cc', '#B05606');
    map = writeThemeBackground(map, 'light', 'cc', '#FFD6A1');
    const reloaded = parseThemeBackgroundsJson(JSON.stringify(map));
    expect(readThemeBackground(reloaded, 'dark', 'cc')).toBe('#B05606');
    expect(readThemeBackground(reloaded, 'light', 'cc')).toBe('#FFD6A1');
  });
});
