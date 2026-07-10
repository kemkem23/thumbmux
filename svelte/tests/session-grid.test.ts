import { describe, expect, test } from 'bun:test';
import type { AnsiPalette } from '@thumbmux/core';
import {
  activityDatetime,
  buildSessionGridModel,
  contrastRatio,
  deriveThumbnailPalette,
  displayStateLabel,
  readableColorOn,
  splitSessionName,
  type GridSession,
} from '../src/session-grid';

const palette: AnsiPalette = {
  base: [
    '#111111', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999',
    '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#f0f0f0', '#fafafa', '#ffffff',
  ],
  defaultFg: '#777777',
  defaultBg: '#666666',
};

const rows: GridSession[] = [
  {
    name: 'alpha-build-long-shared-prefix-left-tail-a19z',
    chip: 'CC',
    filterValue: 'cc',
    groupKey: 'build',
    groupLabel: 'Build',
    state: 'working',
    stateLabel: 'WORKING',
    lastActivityAt: 1_700_000_030_000,
    lastActivityLabel: 'just now',
  },
  {
    name: 'beta-review',
    chip: 'CDX',
    filterValue: 'codex',
    groupKey: 'review',
    groupLabel: 'Review',
    state: 'idle',
    stateLabel: 'IDLE',
    lastActivityAt: 1_700_000_010_000,
    lastActivityLabel: '1 min ago',
  },
  {
    name: 'alpha-build-long-shared-prefix-left-tail-z83q',
    chip: 'GROK',
    filterValue: 'grok',
    groupKey: 'build',
    groupLabel: 'Build',
    state: 'working',
    stateLabel: 'WORKING',
    lastActivityAt: 1_700_000_020_000,
    lastActivityLabel: '30 sec ago',
  },
  {
    name: 'plain-shell',
    chip: 'SH',
    filterValue: 'sh',
    state: 'idle',
  },
];

describe('buildSessionGridModel', () => {
  test('filters by exact filterValue before case-insensitive search', () => {
    const model = buildSessionGridModel(rows, { filterValue: 'grok', search: 'build' });
    expect(model.items.map((item) => item.session.name)).toEqual([
      'alpha-build-long-shared-prefix-left-tail-z83q',
    ]);

    const noPartialFilter = buildSessionGridModel(rows, { filterValue: 'co' });
    expect(noPartialFilter.items).toHaveLength(0);
  });

  test('searches name, chip, and groupLabel', () => {
    expect(buildSessionGridModel(rows, { search: 'review' }).items.map((item) => item.session.name)).toEqual([
      'beta-review',
    ]);
    expect(buildSessionGridModel(rows, { search: 'cdx' }).items.map((item) => item.session.name)).toEqual([
      'beta-review',
    ]);
  });

  test('orders recent sessions before missing activity and preserves input ties', () => {
    const model = buildSessionGridModel(rows, { order: 'recent' });
    expect(model.items.map((item) => item.session.name)).toEqual([
      'alpha-build-long-shared-prefix-left-tail-a19z',
      'alpha-build-long-shared-prefix-left-tail-z83q',
      'beta-review',
      'plain-shell',
    ]);
  });

  test('groups after sorting and orders recent groups by newest member', () => {
    const model = buildSessionGridModel(rows, { grouped: true, order: 'recent', ungroupedLabel: 'Other' });
    expect(model.grouped).toBe(true);
    expect(model.groups.map((group) => [group.key, group.label, group.items.map((item) => item.session.name)])).toEqual([
      ['build', 'Build', [
        'alpha-build-long-shared-prefix-left-tail-a19z',
        'alpha-build-long-shared-prefix-left-tail-z83q',
      ]],
      ['review', 'Review', ['beta-review']],
      ['', 'Other', ['plain-shell']],
    ]);
  });
});

describe('display helpers', () => {
  test('derives accessible datetime and state label defaults', () => {
    expect(activityDatetime(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(activityDatetime(Number.NaN)).toBeNull();
    expect(displayStateLabel({ name: 'x', state: 'working' })).toBe('WORKING');
    expect(displayStateLabel({ name: 'x' })).toBeNull();
  });

  test('preserves distinguishing tails for long session names', () => {
    const left = splitSessionName('alpha-build-long-shared-prefix-left-tail-a19z');
    const right = splitSessionName('alpha-build-long-shared-prefix-left-tail-z83q');
    expect(left.truncated).toBe(true);
    expect(right.truncated).toBe(true);
    expect(left.tail).toContain('tail-a19z');
    expect(right.tail).toContain('tail-z83q');
    expect(`${left.head}…${left.tail}`).not.toBe(`${right.head}…${right.tail}`);
  });

  test('tail reaches past a shared launcher stamp to the differing character', () => {
    // Real launcher shape: sibling names differ just BEFORE a shared
    // "<worker>-<timestamp>" stamp. The stamp alone is 10 chars, so a
    // 10-char tail rendered both cards identically.
    const stamp = '0-mrelqu8j';
    const left = splitSessionName(`sim-cc-shared-prefix-tail-a19z-${stamp}`);
    const right = splitSessionName(`sim-cc-shared-prefix-tail-z83q-${stamp}`);
    expect(left.truncated).toBe(true);
    expect(left.tail).toBe(`z-${stamp}`);
    expect(right.tail).toBe(`q-${stamp}`);
    expect(`${left.head}…${left.tail}`).not.toBe(`${right.head}…${right.tail}`);
  });
});

describe('thumbnail contrast palette', () => {
  test('returns a new palette and keeps the input unchanged', () => {
    const before = structuredClone(palette);
    const derived = deriveThumbnailPalette(palette);
    expect(derived).not.toBe(palette);
    expect(derived.base).not.toBe(palette.base);
    expect(palette).toEqual(before);
  });

  test('raises default and ansi foreground contrast against the miniature background', () => {
    const derived = deriveThumbnailPalette(palette);
    expect(contrastRatio(derived.defaultFg, derived.defaultBg)).toBeGreaterThanOrEqual(4.5);
    for (const color of derived.base) {
      expect(contrastRatio(color, derived.defaultBg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('readableColorOn chooses a compliant fallback for invalid or low contrast colors', () => {
    const readable = readableColorOn('#ffffff', '#eeeeee');
    expect(contrastRatio(readable, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableColorOn('#000000', 'not-a-color'), '#000000')).toBeGreaterThanOrEqual(4.5);
  });
});
