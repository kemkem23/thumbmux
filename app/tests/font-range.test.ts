import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FONT_PX,
  DEFAULT_FONT_PX_MAX,
  DEFAULT_FONT_PX_MIN,
  FONT_FIT_GUTTER_PX,
  clampFontPx,
  clampFontPxExact,
  fitFontPxToColumns,
  resolveFontBounds,
  resolveFontFitMode,
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

describe('clampFontPxExact', () => {
  const band = { min: 4, max: 40 };

  test('keeps the fraction that clampFontPx rounds away', () => {
    expect(clampFontPxExact(8.29, band)).toBe(8.29);
    expect(clampFontPxExact(8.05, band)).toBe(8.05);
    expect(clampFontPx(8.29, band)).toBe(8);
  });

  test('still clamps, and non-finite still falls back to the stock default', () => {
    expect(clampFontPxExact(3.5, band)).toBe(4);
    expect(clampFontPxExact(40.5, band)).toBe(40);
    expect(clampFontPxExact(Number.NaN, band)).toBe(DEFAULT_FONT_PX);
    expect(clampFontPxExact(Number.NaN, { min: 4, max: 10 })).toBe(10);
  });
});

describe('resolveFontFitMode', () => {
  test('only the literal "manual" opts out; anything else is auto', () => {
    expect(resolveFontFitMode('manual')).toBe('manual');
    expect(resolveFontFitMode('auto')).toBe('auto');
    expect(resolveFontFitMode(undefined)).toBe('auto');
    expect(resolveFontFitMode(null)).toBe('auto');
    expect(resolveFontFitMode('MANUAL')).toBe('auto');
    expect(resolveFontFitMode(13)).toBe('auto');
  });
});

/**
 * NEWARCH fit-font (plan §2 / §6). The width sweep measured a cell of
 * 0.6 × font on Chromium with hinting none; the formula never hard-codes that
 * ratio, it is only the fake measure these cases hand in.
 */
describe('fitFontPxToColumns', () => {
  const band = { min: 4, max: 40 };
  const sweepCell = (px: number) => px * 0.6;
  /** 390px phone box = 378px of usable line after the 6+6 gutter. */
  const PHONE = 390;
  const fit = (columns: number, containerWidthPx: number, extra: Record<string, unknown> = {}) =>
    fitFontPxToColumns({
      columns,
      containerWidthPx,
      ceilingPx: 13,
      bounds: band,
      measureCellPx: sweepCell,
      ...extra,
    });

  test('the gutter is 12px — the 6px padding on each side of the line', () => {
    expect(FONT_FIT_GUTTER_PX).toBe(12);
  });

  test('a wide box keeps the ceiling exactly — never grows past the user size', () => {
    const out = fit(76, 1280);
    expect(out).toEqual({ fontPx: 13, fits: true });
  });

  test('70 columns at 378px land on 9px (sweep table: fills exactly)', () => {
    const out = fit(70, PHONE);
    expect(out.fontPx).toBe(9);
    expect(out.fits).toBe(true);
  });

  test('76 columns at 378px land between 8.2 and 8.4 — not the integer 8', () => {
    const out = fit(76, PHONE);
    expect(out.fits).toBe(true);
    expect(out.fontPx).toBeGreaterThanOrEqual(8.2);
    expect(out.fontPx).toBeLessThanOrEqual(8.4);
    expect(out.fontPx).not.toBe(8);
    // It really fits, and the next 0.05px step would not.
    expect(76 * sweepCell(out.fontPx)).toBeLessThanOrEqual(378);
    expect(76 * sweepCell(out.fontPx + 0.05)).toBeGreaterThan(378);
  });

  test('78 columns at 378px land just above 8px', () => {
    const out = fit(78, PHONE);
    expect(out.fits).toBe(true);
    expect(out.fontPx).toBeGreaterThanOrEqual(8);
    expect(out.fontPx).toBeLessThan(8.1);
    expect(78 * sweepCell(out.fontPx)).toBeLessThanOrEqual(378);
  });

  test('every width from 378 to 390 gives ~9 / ~8 / ~8 for 70 / 76 / 78', () => {
    for (let w = 378; w <= 390; w++) {
      const usable = w - 12;
      for (const [cols, lo, hi] of [[70, 8.6, 9], [76, 7.9, 8.4], [78, 7.7, 8.1]] as const) {
        const out = fit(cols, w);
        expect(out.fits).toBe(true);
        expect(out.fontPx).toBeGreaterThanOrEqual(lo);
        expect(out.fontPx).toBeLessThanOrEqual(hi);
        expect(cols * sweepCell(out.fontPx)).toBeLessThanOrEqual(usable + 1e-9);
      }
    }
  });

  test('the gutter is subtracted: 378px of box is only 366px of line', () => {
    const withGutter = fit(70, 378);
    expect(70 * sweepCell(withGutter.fontPx)).toBeLessThanOrEqual(366 + 1e-9);
    expect(withGutter.fontPx).toBeLessThan(9);
    const noGutter = fit(70, 378, { gutterPx: 0 });
    expect(noGutter.fontPx).toBe(9);
  });

  test('never drops below the lower bound; when the floor still overflows it says so', () => {
    const out = fit(200, PHONE);
    expect(out.fontPx).toBe(4);
    expect(out.fits).toBe(false);
  });

  test('a host floor above 4 is the floor', () => {
    const out = fit(200, PHONE, { bounds: { min: 6, max: 40 } });
    expect(out).toEqual({ fontPx: 6, fits: false });
  });

  test('the ceiling is clamped into bounds before anything else', () => {
    expect(fit(10, 1280, { ceilingPx: 99 })).toEqual({ fontPx: 40, fits: true });
  });

  test('result carries at most two decimals', () => {
    for (const w of [380, 383, 387, 389]) {
      const out = fit(76, w);
      expect(Math.round(out.fontPx * 100) / 100).toBe(out.fontPx);
    }
  });

  test('a measure that is not proportional still converges within the probe budget', () => {
    // Cell width snaps to a 0.25px grid — what a hinted renderer does.
    const hinted = (px: number) => Math.round(px * 0.6 * 4) / 4;
    const out = fit(76, PHONE, { measureCellPx: hinted });
    expect(out.fits).toBe(true);
    expect(76 * hinted(out.fontPx)).toBeLessThanOrEqual(378);
    expect(out.fontPx).toBeGreaterThan(7.5);
  });

  test('manual mode shows the ceiling and reports whether it overflows', () => {
    expect(fit(76, PHONE, { mode: 'manual' })).toEqual({ fontPx: 13, fits: false });
    expect(fit(76, 1280, { mode: 'manual' })).toEqual({ fontPx: 13, fits: true });
  });

  test('no geometry or an unlaid box (width 0) does not shrink', () => {
    expect(fit(0, PHONE)).toEqual({ fontPx: 13, fits: false });
    expect(fit(Number.NaN, PHONE)).toEqual({ fontPx: 13, fits: false });
    expect(fit(76, 0)).toEqual({ fontPx: 13, fits: false });
  });

  test('a measure that returns nothing usable falls back to 0.6 × font', () => {
    const out = fit(70, PHONE, { measureCellPx: () => Number.NaN });
    expect(out).toEqual({ fontPx: 9, fits: true });
  });

  test('the result is font and fit only — it never carries a resize', () => {
    const out = fit(76, PHONE) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['fits', 'fontPx']);
  });
});
