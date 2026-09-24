import type { AnsiPalette } from '@thumbmux/core';
import type { CanvasModelRow } from './model';
import { singleLineGlyph } from './glyphs';

export type CanvasPaintOptions = Readonly<{
  fontFamily: string;
  rowGeometry?: readonly { top: number; height: number }[];
  fontSize: number;
  lineHeight: number;
  cellWidth: number;
  strokeWidth: number;
  vectorFont: boolean;
  dpr: number;
  palette: AnsiPalette;
}>;

function paintStrokeGlyph(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: CanvasPaintOptions,
): boolean {
  const glyph = singleLineGlyph(text);
  if (!glyph) return false;
  for (const [strokeIndex, stroke] of glyph.strokes.entries()) {
    context.beginPath();
    context.lineWidth = effectiveStrokeWidth(options.strokeWidth) * (glyph.weights?.[strokeIndex] ?? 1);
    stroke.forEach(([px, py], index) => {
      const gx = x + px * options.cellWidth;
      const gy = y + py * options.lineHeight;
      if (index === 0) context.moveTo(gx, gy);
      else context.lineTo(gx, gy);
    });
    context.stroke();
  }
  return true;
}

export function effectiveStrokeWidth(value: number): number {
  return Number.isFinite(value) ? Math.min(3, Math.max(0.5, value)) : 1;
}

export function paintCanvasRows(
  context: CanvasRenderingContext2D,
  rows: readonly CanvasModelRow[],
  options: CanvasPaintOptions,
): void {
  const width = context.canvas.width / options.dpr;
  const height = context.canvas.height / options.dpr;
  context.setTransform(options.dpr, 0, 0, options.dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = options.palette.defaultBg;
  context.fillRect(0, 0, width, height);
  context.fillStyle = options.palette.defaultFg;
  context.strokeStyle = options.palette.defaultFg;
  context.lineWidth = effectiveStrokeWidth(options.strokeWidth);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.font = `${options.fontSize}px ${options.fontFamily}`;
  context.textBaseline = 'alphabetic';
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const top = options.rowGeometry?.[rowIndex]?.top ?? rowIndex * options.lineHeight;
    const rowHeight = options.rowGeometry?.[rowIndex]?.height ?? options.lineHeight;
    context.save();
    context.beginPath();
    context.rect(0, top, width, rowHeight);
    context.clip();
    if (top > height) { context.restore(); break; }
    for (const cell of rows[rowIndex]!.cells) {
      if (cell.continuation) continue;
      const x = cell.col * options.cellWidth;
      const painted = options.vectorFont && paintStrokeGlyph(context, cell.text, x, top, options);
      if (!painted) context.fillText(cell.text, x, top + options.lineHeight * 0.82);
    }
    context.restore();
  }
}
