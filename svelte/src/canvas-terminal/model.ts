import { charCellWidth, stripAnsi } from '@thumbmux/core';

export type CanvasCell = Readonly<{
  text: string;
  col: number;
  width: 1 | 2;
  continuation: false;
}>;

export type CanvasContinuationCell = Readonly<{
  text: '';
  col: number;
  width: 0;
  continuation: true;
}>;

export type CanvasTerminalCell = CanvasCell | CanvasContinuationCell;

export type CanvasModelRow = Readonly<{
  id: number;
  raw: string;
  text: string;
  cells: readonly CanvasTerminalCell[];
}>;

export type ModelPoint = Readonly<{ row: number; col: number }>;
export type ModelSelection = Readonly<{ anchor: ModelPoint; focus: ModelPoint }>;

const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function graphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map((entry) => entry.segment);
  }
  return Array.from(text);
}

/**
 * Build terminal cells from the canonical text model. Zero-width code points
 * are attached to the previous base cell because Thai marks such as U+0E34
 * are not reliably identified by Unicode combining-class tables alone.
 */
export function lineToCanvasCells(raw: string): CanvasTerminalCell[] {
  const text = stripAnsi(raw).replace(/\u00a0/g, ' ');
  const cells: CanvasTerminalCell[] = [];
  let col = 0;
  for (const cluster of graphemes(text)) {
    let width = 0;
    for (const cp of Array.from(cluster)) width = Math.max(width, charCellWidth(cp.codePointAt(0)!));
    if (width === 0) {
      const previous = cells.findLast((cell) => !cell.continuation);
      if (previous) {
        const index = cells.indexOf(previous);
        cells[index] = { ...previous, text: previous.text + cluster };
      }
      continue;
    }
    const cellWidth = width >= 2 ? 2 : 1;
    cells.push({ text: cluster, col, width: cellWidth, continuation: false });
    if (cellWidth === 2) {
      cells.push({ text: '', col: col + 1, width: 0, continuation: true });
    }
    col += cellWidth;
  }
  return cells;
}

export function createCanvasModelRows(rawLines: readonly string[], firstId = 0): CanvasModelRow[] {
  return rawLines.map((raw, index) => ({
    id: firstId + index,
    raw,
    text: stripAnsi(raw).replace(/\u00a0/g, ' '),
    cells: lineToCanvasCells(raw),
  }));
}

function ordered(selection: ModelSelection): [ModelPoint, ModelPoint] {
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)
    ? [anchor, focus]
    : [focus, anchor];
}

/** Byte source for copy. Continuation cells never contribute text. */
export function selectedModelText(rows: readonly CanvasModelRow[], selection: ModelSelection): string {
  const [start, end] = ordered(selection);
  const chunks: string[] = [];
  for (let rowIndex = start.row; rowIndex <= end.row; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    const from = rowIndex === start.row ? start.col : 0;
    const to = rowIndex === end.row ? end.col : Number.POSITIVE_INFINITY;
    chunks.push(row.cells
      .filter((cell): cell is CanvasCell => !cell.continuation && cell.col < to && cell.col + cell.width > from)
      .map((cell) => cell.text)
      .join('')
      .replace(/\s+$/, ''));
  }
  return chunks.join('\n');
}

export function modelPointFromPixel(
  x: number,
  y: number,
  cellWidth: number,
  lineHeight: number,
  rowOffset = 0,
): ModelPoint {
  return {
    row: rowOffset + Math.max(0, Math.floor(y / lineHeight)),
    col: Math.max(0, Math.floor(x / cellWidth)),
  };
}
