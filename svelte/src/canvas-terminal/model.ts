import { charCellWidth, stripAnsi } from '@thumbmux/core';

export type CanvasCell = Readonly<{
  text: string;
  col: number;
  width: number;
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

/** Code-point accounting mirrors stringCells, including VS16 promotion.
 * Keep graphemes together for shaping, but sum their terminal advances. */
export function lineToCanvasCells(raw: string): CanvasTerminalCell[] {
  const text = stripAnsi(raw).replace(/\u00a0/g, ' ');
  const bases: { text: string; col: number; width: number; continuation: false }[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let col = 0;
  let pending = '';
  let prevWidth = 0;
  for (const { segment } of segmenter.segment(text)) {
    let width = 0;
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      const w = charCellWidth(cp);
      if (cp === 0xfe0f && prevWidth === 1) { width++; prevWidth = 2; }
      else { width += w; if (w > 0) prevWidth = w; }
    }
    if (width === 0) {
      if (bases.length) bases[bases.length - 1]!.text += segment;
      else pending += segment;
      continue;
    }
    bases.push({ text: pending + segment, col, width, continuation: false });
    pending = '';
    col += width;
  }
  // An orphan-only line must not silently discard canonical bytes.
  if (pending) bases.push({ text: pending, col, width: 0, continuation: false });
  return bases.flatMap((base): CanvasTerminalCell[] => [base,
    ...Array.from({ length: Math.max(0, base.width - 1) }, (_, i): CanvasContinuationCell =>
      ({ text: '', col: base.col + i + 1, width: 0, continuation: true })),
  ]);
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
