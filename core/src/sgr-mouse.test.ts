import { describe, expect, test } from 'bun:test';

import {
  centerContentCell,
  contentCellFromPoint,
  DEFAULT_WHEEL_MAX_PER_CALL,
  sgrClick,
  sgrSnapToBottom,
  sgrWheel,
  SNAP_BOTTOM_EVENTS,
  wheelEventToLines,
} from './sgr-mouse';

const rect = { left: 10, top: 20, width: 100, height: 50 };
const geom = { cols: 10, rows: 5 };

function wheelDir(lines: number): 'up' | 'down' {
  return lines > 0 ? 'up' : 'down';
}

describe('sgrWheel', () => {
  test('emits wheel-up code 64', () => {
    expect(sgrWheel('up', 4, 7)).toBe('\x1b[<64;4;7M');
  });

  test('emits wheel-down code 65', () => {
    expect(sgrWheel('down', 4, 7)).toBe('\x1b[<65;4;7M');
  });

  test('repeats floor(count) events', () => {
    expect(sgrWheel('up', 2, 3, 3.9)).toBe('\x1b[<64;2;3M'.repeat(3));
  });

  test('uses at least one event for zero or negative counts', () => {
    expect(sgrWheel('down', 2, 3, 0)).toBe('\x1b[<65;2;3M');
    expect(sgrWheel('down', 2, 3, -4)).toBe('\x1b[<65;2;3M');
  });

  test('uses one event for non-finite counts', () => {
    expect(sgrWheel('down', 2, 3, Number.NaN)).toBe('\x1b[<65;2;3M');
  });

  test('floors coordinates and never emits cells below one', () => {
    expect(sgrWheel('up', 0, -2, 2)).toBe('\x1b[<64;1;1M\x1b[<64;1;1M');
    expect(sgrWheel('down', 6.8, 9.2)).toBe('\x1b[<65;6;9M');
  });

  test('replaces non-finite coordinates with cell one', () => {
    expect(sgrWheel('up', Number.POSITIVE_INFINITY, Number.NaN)).toBe('\x1b[<64;1;1M');
  });
});

describe('sgrClick', () => {
  test('emits press and release at the same cell', () => {
    expect(sgrClick(12, 34)).toBe('\x1b[<0;12;34M\x1b[<0;12;34m');
  });

  test('uses capital M for press and lowercase m for release', () => {
    const click = sgrClick(1, 2);
    expect(click.endsWith('M\x1b[<0;1;2m')).toBe(true);
  });

  test('floors coordinates and never emits cells below one', () => {
    expect(sgrClick(-1, 4.7)).toBe('\x1b[<0;1;4M\x1b[<0;1;4m');
  });
});

describe('sgrSnapToBottom', () => {
  test('exports the snap and burst constants', () => {
    expect(SNAP_BOTTOM_EVENTS).toBe(24);
    expect(DEFAULT_WHEEL_MAX_PER_CALL).toBe(6);
  });

  test('emits exactly 24 wheel-down events', () => {
    expect(sgrSnapToBottom(8, 9)).toBe('\x1b[<65;8;9M'.repeat(24));
  });

  test('clamps snap coordinates to 1-based cells', () => {
    expect(sgrSnapToBottom(0, 0)).toBe('\x1b[<65;1;1M'.repeat(24));
  });
});

describe('wheelEventToLines', () => {
  test('converts positive pixel delta to negative lines', () => {
    expect(wheelEventToLines(36, 0, 18)).toBe(-2);
  });

  test('converts negative pixel delta to positive lines', () => {
    expect(wheelEventToLines(-36, 0, 18)).toBe(2);
  });

  test('converts positive line-mode delta to negative lines', () => {
    expect(wheelEventToLines(3, 1, 18)).toBe(-3);
  });

  test('converts negative line-mode delta to positive lines', () => {
    expect(wheelEventToLines(-3, 1, 18)).toBe(3);
  });

  test('converts page-mode delta using the supplied page line count', () => {
    expect(wheelEventToLines(2, 2, 18, 40)).toBe(-80);
  });

  test('uses 50 lines as the default page height', () => {
    expect(wheelEventToLines(-1, 2, 18)).toBe(50);
  });

  test('returns zero for zero and non-finite deltas', () => {
    expect(wheelEventToLines(0, 0, 18)).toBe(0);
    expect(wheelEventToLines(Number.NaN, 0, 18)).toBe(0);
  });

  test('uses a minimum pixel line height of one', () => {
    expect(wheelEventToLines(5, 0, 0)).toBe(-5);
  });

  test('composes positive browser delta into wheel-down SGR events', () => {
    const lines = wheelEventToLines(40, 0, 20);
    expect(sgrWheel(wheelDir(lines), 5, 6, Math.abs(lines))).toBe('\x1b[<65;5;6M'.repeat(2));
  });

  test('composes negative browser delta into wheel-up SGR events', () => {
    const lines = wheelEventToLines(-40, 0, 20);
    expect(sgrWheel(wheelDir(lines), 5, 6, Math.abs(lines))).toBe('\x1b[<64;5;6M'.repeat(2));
  });
});

describe('centerContentCell', () => {
  test('returns the center for a tall pane', () => {
    expect(centerContentCell({ cols: 80, rows: 45 })).toEqual({ cx: 40, cy: 22 });
  });

  test('stays above the default bottom composer area', () => {
    expect(centerContentCell({ cols: 80, rows: 12 })).toEqual({ cx: 40, cy: 4 });
  });

  test('clamps degenerate rows below the composer to one', () => {
    expect(centerContentCell({ cols: 3, rows: 5 })).toEqual({ cx: 1, cy: 1 });
  });

  test('accepts a custom composer row count', () => {
    expect(centerContentCell({ cols: 9, rows: 12 }, { composerRows: 2 })).toEqual({ cx: 4, cy: 6 });
  });

  test('never returns cells below one for non-positive geometry', () => {
    expect(centerContentCell({ cols: 0, rows: 0 })).toEqual({ cx: 1, cy: 1 });
  });
});

describe('contentCellFromPoint', () => {
  test('maps the top-left pixel to the first cell', () => {
    expect(contentCellFromPoint(10, 20, rect, geom)).toEqual({ cx: 1, cy: 1, col0: 0, row0: 0 });
  });

  test('maps an interior pixel with proportional floor math', () => {
    expect(contentCellFromPoint(35, 42, rect, geom)).toEqual({ cx: 3, cy: 3, col0: 2, row0: 2 });
  });

  test('maps exact cell boundaries to the next cell', () => {
    expect(contentCellFromPoint(20, 30, rect, geom)).toEqual({ cx: 2, cy: 2, col0: 1, row0: 1 });
  });

  test('keeps the right and bottom edges inside the last cell', () => {
    expect(contentCellFromPoint(110, 70, rect, geom)).toEqual({ cx: 10, cy: 5, col0: 9, row0: 4 });
  });

  test('returns null left of the rect', () => {
    expect(contentCellFromPoint(9.99, 30, rect, geom)).toBeNull();
  });

  test('returns null right of the rect', () => {
    expect(contentCellFromPoint(110.01, 30, rect, geom)).toBeNull();
  });

  test('returns null above the rect', () => {
    expect(contentCellFromPoint(30, 19.99, rect, geom)).toBeNull();
  });

  test('returns null below the rect', () => {
    expect(contentCellFromPoint(30, 70.01, rect, geom)).toBeNull();
  });

  test('returns null for zero or negative rect width', () => {
    expect(contentCellFromPoint(10, 20, { ...rect, width: 0 }, geom)).toBeNull();
    expect(contentCellFromPoint(10, 20, { ...rect, width: -1 }, geom)).toBeNull();
  });

  test('returns null for zero or negative rect height', () => {
    expect(contentCellFromPoint(10, 20, { ...rect, height: 0 }, geom)).toBeNull();
    expect(contentCellFromPoint(10, 20, { ...rect, height: -1 }, geom)).toBeNull();
  });

  test('returns null for zero or negative columns', () => {
    expect(contentCellFromPoint(10, 20, rect, { cols: 0, rows: 5 })).toBeNull();
    expect(contentCellFromPoint(10, 20, rect, { cols: -1, rows: 5 })).toBeNull();
  });

  test('returns null for zero or negative rows', () => {
    expect(contentCellFromPoint(10, 20, rect, { cols: 10, rows: 0 })).toBeNull();
    expect(contentCellFromPoint(10, 20, rect, { cols: 10, rows: -1 })).toBeNull();
  });

  test('returns null for non-finite point or rect values', () => {
    expect(contentCellFromPoint(Number.NaN, 20, rect, geom)).toBeNull();
    expect(contentCellFromPoint(10, 20, { ...rect, left: Number.POSITIVE_INFINITY }, geom)).toBeNull();
  });

  test('returns null for non-finite geometry', () => {
    expect(contentCellFromPoint(10, 20, rect, { cols: Number.NaN, rows: 5 })).toBeNull();
    expect(contentCellFromPoint(10, 20, rect, { cols: 10, rows: Number.NaN })).toBeNull();
  });
});
