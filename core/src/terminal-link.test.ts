import { describe, expect, test } from 'bun:test';

import { collectTerminalUrlSegments, findTerminalUrlAtCell } from './terminal-link';

describe('collectTerminalUrlSegments', () => {
  test('returns single-line url segment', () => {
    const rawLines = ['open https://example.com/path/to/resource'];
    const matches = collectTerminalUrlSegments(rawLines, 0, rawLines.length, 80);

    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://example.com/path/to/resource');
    expect(matches[0].segments).toEqual([
      {
        lineIdx: 0,
        startCol: 5,
        endCol: 'open https://example.com/path/to/resource'.length,
      },
    ]);
  });

  test('reconstructs and segments wrapped urls across lines', () => {
    const rawLines = [
      'https://example.com/very',
      'longsegmentthatcontinues',
    ];

    const matches = collectTerminalUrlSegments(rawLines, 0, rawLines.length, 20);

    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://example.com/verylongsegmentthatcontinues');
    expect(matches[0].segments).toEqual([
      {
        lineIdx: 0,
        startCol: 0,
        endCol: 24,
      },
      {
        lineIdx: 1,
        startCol: 0,
        endCol: 24,
      },
    ]);
  });

  test('trims trailing punctuation from matched url', () => {
    const rawLines = ['check https://example.com/path.'];
    const matches = collectTerminalUrlSegments(rawLines, 0, 1, 80);

    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://example.com/path');
    expect(matches[0].segments).toEqual([
      {
        lineIdx: 0,
        startCol: 6,
        endCol: 6 + 'https://example.com/path'.length,
      },
    ]);
  });
});

describe('findTerminalUrlAtCell', () => {
  test('returns the url when the cell is inside a single-line match', () => {
    const rawLines = ['open https://example.com/path/to/resource'];

    expect(findTerminalUrlAtCell(rawLines, 0, 8, 80)).toBe('https://example.com/path/to/resource');
    expect(findTerminalUrlAtCell(rawLines, 0, 4, 80)).toBeNull();
  });

  test('hits wrapped continuation segments', () => {
    const rawLines = [
      'https://example.com/very',
      'longsegmentthatcontinues',
    ];

    expect(findTerminalUrlAtCell(rawLines, 1, 5, 20)).toBe('https://example.com/verylongsegmentthatcontinues');
    expect(findTerminalUrlAtCell(rawLines, 1, 24, 20)).toBeNull();
  });

  test('excludes trailing punctuation from hit testing', () => {
    const rawLines = ['check https://example.com/path.'];

    expect(findTerminalUrlAtCell(rawLines, 0, 10, 80)).toBe('https://example.com/path');
    expect(findTerminalUrlAtCell(rawLines, 0, 30, 80)).toBeNull();
  });
});
