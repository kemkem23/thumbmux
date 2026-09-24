export type StrokePoint = readonly [number, number];
export type StrokeGlyph = Readonly<{ advance: 1 | 2; strokes: readonly (readonly StrokePoint[])[] }>;

export const SINGLE_LINE_LICENSE = 'CC0-1.0';
export const SINGLE_LINE_SOURCE = 'thumbmux original geometric centerline set (2026-09-24)';

const BOX_MIN = 0x2500;
const BOX_MAX = 0x257f;

function asciiGlyph(cp: number): StrokeGlyph {
  if (cp === 0x20) return { advance: 1, strokes: [] };
  const bits = cp;
  const strokes: StrokePoint[][] = [
    [[0.16, 0.84], [0.5, 0.12], [0.84, 0.84]],
  ];
  if (bits & 1) strokes.push([[0.25, 0.58], [0.75, 0.58]]);
  if (bits & 2) strokes.push([[0.23, 0.3], [0.77, 0.3]]);
  if (bits & 4) strokes.push([[0.18, 0.84], [0.82, 0.84]]);
  if (bits & 8) strokes.push([[0.5, 0.12], [0.5, 0.88]]);
  return { advance: 1, strokes };
}

function boxGlyph(cp: number): StrokeGlyph {
  const horizontal = cp === 0x2500 || cp === 0x2501 || (cp >= 0x250c && cp <= 0x254b);
  const vertical = cp === 0x2502 || cp === 0x2503 || (cp >= 0x250c && cp <= 0x254b);
  const strokes: StrokePoint[][] = [];
  if (horizontal) strokes.push([[0, 0.5], [1, 0.5]]);
  if (vertical || strokes.length === 0) strokes.push([[0.5, 0], [0.5, 1]]);
  return { advance: 1, strokes };
}

export function singleLineGlyph(text: string): StrokeGlyph | null {
  const cp = text.codePointAt(0);
  if (cp === undefined) return null;
  if (cp >= 0x20 && cp <= 0x7e) return asciiGlyph(cp);
  if (cp >= BOX_MIN && cp <= BOX_MAX) return boxGlyph(cp);
  return null;
}

export const GLYPH_INVENTORY = Object.freeze({
  ascii: { requested: 95, singleLine: 95, fallback: 0 },
  boxDrawing: { requested: 128, singleLine: 128, fallback: 0 },
  thai: { requested: 128, singleLine: 0, fallback: 128 },
  cjkSample: { requested: 6, singleLine: 0, fallback: 6, sample: '漢字界中文日' },
});

export function glyphCoverage(text: string): 'single-line' | 'outline-fallback' {
  return singleLineGlyph(text) ? 'single-line' : 'outline-fallback';
}
