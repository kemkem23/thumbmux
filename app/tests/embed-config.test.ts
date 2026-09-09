/**
 * Parity fixtures come from the geometry kemcortex's /embed/terminal page has
 * been computing inline. The numbers below are written out literally instead
 * of recomputed from the module's own constants, so a changed default breaks
 * a test rather than moving both sides at once.
 */
import { describe, expect, test } from 'bun:test';
import {
  EMBED_FONT_PX_MAX,
  EMBED_FONT_PX_MIN,
  defaultEmbedFontPx,
  fitEmbedRows,
  resolveEmbedGeometry,
} from '../src/embed-config';

const PHONE = { viewportWidth: 390, viewportHeight: 844 };
const LAPTOP = { viewportWidth: 1440, viewportHeight: 900 };

describe('defaultEmbedFontPx', () => {
  test('phone widths read larger than laptop widths', () => {
    expect(defaultEmbedFontPx(390)).toBe(15);
    expect(defaultEmbedFontPx(768)).toBe(15);
    expect(defaultEmbedFontPx(769)).toBe(13);
    expect(defaultEmbedFontPx(1440)).toBe(13);
  });
});

describe('fitEmbedRows', () => {
  test('fits the height left after the embedding chrome', () => {
    // (844 - 160) / (15 * 1.4) = 32.57 -> 32
    expect(fitEmbedRows(844, 15)).toBe(32);
    // (900 - 160) / (13 * 1.4) = 40.65 -> 40
    expect(fitEmbedRows(900, 13)).toBe(40);
  });

  test('a tiny iframe still gets the floor, not zero rows', () => {
    expect(fitEmbedRows(0, 20)).toBe(14);
    expect(fitEmbedRows(100, 20)).toBe(14);
  });

  test('a very tall iframe is capped rather than asking for hundreds of rows', () => {
    expect(fitEmbedRows(20000, 8)).toBe(60);
  });
});

describe('resolveEmbedGeometry', () => {
  test('no query: the device decides the font and the viewport fits the rows', () => {
    expect(resolveEmbedGeometry({ search: '', ...PHONE })).toEqual({
      fontPx: 15,
      minRows: 32,
      fontFromQuery: false,
      rowsFromQuery: false,
    });
    expect(resolveEmbedGeometry({ search: null, ...LAPTOP })).toEqual({
      fontPx: 13,
      minRows: 40,
      fontFromQuery: false,
      rowsFromQuery: false,
    });
  });

  test('the session parameter the page also reads is ignored here', () => {
    expect(resolveEmbedGeometry({ search: '?session=cc-demo', ...PHONE }).fontPx).toBe(15);
  });

  test('?font= inside the band wins, and the fit follows the new font', () => {
    const out = resolveEmbedGeometry({ search: '?session=x&font=10', ...PHONE });
    // (844 - 160) / (10 * 1.4) = 48.85 -> 48
    expect(out).toEqual({ fontPx: 10, minRows: 48, fontFromQuery: true, rowsFromQuery: false });
  });

  test('the band is inclusive at both ends', () => {
    expect(resolveEmbedGeometry({ search: `?font=${EMBED_FONT_PX_MIN}`, ...PHONE }).fontPx).toBe(8);
    expect(resolveEmbedGeometry({ search: `?font=${EMBED_FONT_PX_MAX}`, ...PHONE }).fontPx).toBe(20);
  });

  test('?font= outside the band falls back to the device default — it is not clamped', () => {
    for (const font of [7, 21, 200, -3, 0]) {
      const out = resolveEmbedGeometry({ search: `?font=${font}`, ...PHONE });
      expect(out.fontPx).toBe(15);
      expect(out.fontFromQuery).toBe(false);
    }
  });

  test('an unparseable ?font= falls back rather than rendering NaN pixels', () => {
    for (const raw of ['', 'big', 'null', 'undefined']) {
      const out = resolveEmbedGeometry({ search: `?font=${raw}`, ...LAPTOP });
      expect(out.fontPx).toBe(13);
      expect(out.fontFromQuery).toBe(false);
    }
  });

  test('a trailing-unit ?font= reads its leading integer, as the URL contract always did', () => {
    expect(resolveEmbedGeometry({ search: '?font=16px', ...PHONE }).fontPx).toBe(16);
  });

  test('?lines= overrides the fit and is NOT held to the fit bounds', () => {
    expect(resolveEmbedGeometry({ search: '?lines=3', ...PHONE })).toEqual({
      fontPx: 15,
      minRows: 3,
      fontFromQuery: false,
      rowsFromQuery: true,
    });
    expect(resolveEmbedGeometry({ search: '?lines=500', ...PHONE }).minRows).toBe(500);
  });

  test('a non-positive or unparseable ?lines= falls back to the fit', () => {
    for (const raw of ['0', '-4', 'lots', '']) {
      const out = resolveEmbedGeometry({ search: `?lines=${raw}`, ...PHONE });
      expect(out.minRows).toBe(32);
      expect(out.rowsFromQuery).toBe(false);
    }
  });

  test('both knobs together, and neither reinterprets the other', () => {
    expect(resolveEmbedGeometry({ search: '?font=9&lines=7', ...LAPTOP })).toEqual({
      fontPx: 9,
      minRows: 7,
      fontFromQuery: true,
      rowsFromQuery: true,
    });
  });

  test('a whole href and a bare query string parse the same', () => {
    const fromHref = resolveEmbedGeometry({
      search: 'https://example.test/embed/terminal?font=12&lines=21',
      ...LAPTOP,
    });
    const fromSearch = resolveEmbedGeometry({ search: 'font=12&lines=21', ...LAPTOP });
    expect(fromHref).toEqual(fromSearch);
    expect(fromHref).toEqual({
      fontPx: 12,
      minRows: 21,
      fontFromQuery: true,
      rowsFromQuery: true,
    });
  });
});
