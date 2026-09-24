import { HERSHEY_SIMPLEX } from './hershey-simplex';
import { BOX_DRAWING } from './box-drawing';

export type StrokePoint = readonly [number, number];
export type StrokeGlyph = Readonly<{
  advance: 1 | 2;
  strokes: readonly (readonly StrokePoint[])[];
  weights?: readonly number[];
}>;

export const SINGLE_LINE_LICENSE = 'Hershey distribution notice; box geometry CC0-1.0';
export const SINGLE_LINE_SOURCE = 'Hershey Roman Simplex centerline data (see LICENSE.md)';

export function singleLineGlyph(text: string): StrokeGlyph | null {
  // Never drop a combining mark by drawing just the first character.
  if (Array.from(text).length !== 1) return null;
  const cp = text.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return { advance: 1, strokes: HERSHEY_SIMPLEX[cp - 0x20]! };
  if (cp >= 0x2500 && cp <= 0x257f) return { advance: 1, ...BOX_DRAWING[cp - 0x2500]! };
  return null;
}

/** Canonical geometry signature ignores path order/direction, includes weight. */
export function glyphShapeKey(glyph: StrokeGlyph): string {
  return glyph.strokes.map((stroke, i) => {
    const forward = JSON.stringify(stroke);
    const reverse = JSON.stringify([...stroke].reverse());
    return `${glyph.weights?.[i] ?? 1}:${forward < reverse ? forward : reverse}`;
  }).sort().join('|');
}

function inventory(characters: string) {
  const glyphs = Array.from(characters).map(singleLineGlyph);
  const shapes = new Set(glyphs.filter((g): g is StrokeGlyph => g !== null).map(glyphShapeKey));
  const covered = glyphs.filter(Boolean).length;
  return { requested: glyphs.length, singleLine: covered, uniqueShapes: shapes.size, fallback: glyphs.length - covered };
}
const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => String.fromCodePoint(start + i)).join('');
export const GLYPH_INVENTORY = Object.freeze({
  ascii: inventory(range(0x20, 95)),
  boxDrawing: inventory(range(0x2500, 128)),
  thai: inventory(range(0x0e00, 128)),
  cjkSample: { ...inventory('漢字界中文日'), sample: '漢字界中文日' },
});

export function glyphCoverage(text: string): 'single-line' | 'outline-fallback' {
  return singleLineGlyph(text) ? 'single-line' : 'outline-fallback';
}
