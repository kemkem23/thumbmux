import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FONT_PX,
  DEFAULT_FONT_PX_MAX,
  DEFAULT_FONT_PX_MIN,
  clampFontPx,
  resolveFontBounds,
  stepFontPx,
} from '../src/font-range';

describe('resolveFontBounds', () => {
  test('omitted bounds yield the stock 4–40 band', () => {
    expect(resolveFontBounds()).toEqual({
      min: DEFAULT_FONT_PX_MIN,
      max: DEFAULT_FONT_PX_MAX,
    });
    expect(resolveFontBounds(undefined, undefined)).toEqual({ min: 4, max: 40 });
  });

  test('host can widen or narrow either end', () => {
    expect(resolveFontBounds(6, 20)).toEqual({ min: 6, max: 20 });
    expect(resolveFontBounds(2, 64)).toEqual({ min: 2, max: 64 });
  });

  test('non-finite / inverted / sub-1 inputs are sanitised', () => {
    expect(resolveFontBounds(Number.NaN, 18)).toEqual({ min: 4, max: 18 });
    expect(resolveFontBounds(10, Number.POSITIVE_INFINITY)).toEqual({ min: 10, max: 40 });
    expect(resolveFontBounds(30, 10)).toEqual({ min: 10, max: 30 });
    expect(resolveFontBounds(0, 12)).toEqual({ min: 1, max: 12 });
    expect(resolveFontBounds(8.7, 22.2)).toEqual({ min: 8, max: 22 });
  });
});

describe('clampFontPx', () => {
  const band = { min: 4, max: 40 };

  test('in-range values pass through (rounded)', () => {
    expect(clampFontPx(13, band)).toBe(13);
    expect(clampFontPx(4, band)).toBe(4);
    expect(clampFontPx(40, band)).toBe(40);
    expect(clampFontPx(15.6, band)).toBe(16);
  });

  test('out-of-range values clamp — never vanish', () => {
    // The 0.15.2 defect: a stored 40 under an 11–18 gate was ignored and the
    // previous default stayed on screen. Clamp is the honest behaviour.
    expect(clampFontPx(40, { min: 11, max: 18 })).toBe(18);
    expect(clampFontPx(3, band)).toBe(4);
    expect(clampFontPx(99, band)).toBe(40);
    expect(clampFontPx(-5, band)).toBe(4);
  });

  test('non-finite falls back to the stock default, then clamps', () => {
    expect(clampFontPx(Number.NaN, band)).toBe(DEFAULT_FONT_PX);
    // Host whose max is below the stock default still wins.
    expect(clampFontPx(Number.NaN, { min: 4, max: 10 })).toBe(10);
  });
});

describe('stepFontPx', () => {
  test('1px steps below 20', () => {
    expect(stepFontPx(13, 1)).toBe(14);
    expect(stepFontPx(19, 1)).toBe(20);
    expect(stepFontPx(14, -1)).toBe(13);
    expect(stepFontPx(20, -1)).toBe(19);
  });

  test('2px steps from 20 through 32', () => {
    expect(stepFontPx(20, 1)).toBe(22);
    expect(stepFontPx(30, 1)).toBe(32);
    expect(stepFontPx(22, -1)).toBe(20);
    expect(stepFontPx(32, -1)).toBe(30);
  });

  test('4px steps above 32', () => {
    expect(stepFontPx(32, 1)).toBe(36);
    expect(stepFontPx(36, 1)).toBe(40);
    expect(stepFontPx(36, -1)).toBe(32);
    expect(stepFontPx(40, -1)).toBe(36);
  });

  test('up then down walks the same ladder', () => {
    const up: number[] = [];
    let n = 4;
    while (n < 40) {
      n = stepFontPx(n, 1);
      up.push(n);
    }
    const down: number[] = [];
    n = 40;
    while (n > 4) {
      n = stepFontPx(n, -1);
      down.push(n);
    }
    expect(up).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      22, 24, 26, 28, 30, 32, 36, 40,
    ]);
    // Same values in reverse order (excluding the starting 40, including the floor 4).
    expect(down).toEqual([...up].reverse().slice(1).concat(4));
  });
});
