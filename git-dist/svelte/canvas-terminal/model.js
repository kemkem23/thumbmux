import { charCellWidth, stripAnsi } from '../../core/index.js';
/** Code-point accounting mirrors stringCells, including VS16 promotion.
 * Keep graphemes together for shaping, but sum their terminal advances. */
export function lineToCanvasCells(raw) {
    const text = stripAnsi(raw).replace(/\u00a0/g, ' ');
    const bases = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let col = 0;
    let pending = '';
    let prevWidth = 0;
    for (const { segment } of segmenter.segment(text)) {
        let width = 0;
        for (const ch of segment) {
            const cp = ch.codePointAt(0);
            const w = charCellWidth(cp);
            if (cp === 0xfe0f && prevWidth === 1) {
                width++;
                prevWidth = 2;
            }
            else {
                width += w;
                if (w > 0)
                    prevWidth = w;
            }
        }
        if (width === 0) {
            if (bases.length)
                bases[bases.length - 1].text += segment;
            else
                pending += segment;
            continue;
        }
        bases.push({ text: pending + segment, col, width, continuation: false });
        pending = '';
        col += width;
    }
    // An orphan-only line must not silently discard canonical bytes.
    if (pending)
        bases.push({ text: pending, col, width: 0, continuation: false });
    return bases.flatMap((base) => [base,
        ...Array.from({ length: Math.max(0, base.width - 1) }, (_, i) => ({ text: '', col: base.col + i + 1, width: 0, continuation: true })),
    ]);
}
export function createCanvasModelRows(rawLines, firstId = 0) {
    return rawLines.map((raw, index) => ({
        id: firstId + index,
        raw,
        text: stripAnsi(raw).replace(/\u00a0/g, ' '),
        cells: lineToCanvasCells(raw),
    }));
}
function ordered(selection) {
    const { anchor, focus } = selection;
    return anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)
        ? [anchor, focus]
        : [focus, anchor];
}
/** Byte source for copy. Continuation cells never contribute text. */
export function selectedModelText(rows, selection) {
    const [start, end] = ordered(selection);
    const chunks = [];
    for (let rowIndex = start.row; rowIndex <= end.row; rowIndex += 1) {
        const row = rows[rowIndex];
        if (!row)
            continue;
        const from = rowIndex === start.row ? start.col : 0;
        const to = rowIndex === end.row ? end.col : Number.POSITIVE_INFINITY;
        chunks.push(row.cells
            .filter((cell) => !cell.continuation && cell.col < to && cell.col + cell.width > from)
            .map((cell) => cell.text)
            .join('')
            .replace(/\s+$/, ''));
    }
    return chunks.join('\n');
}
export function modelPointFromPixel(x, y, cellWidth, lineHeight, rowOffset = 0) {
    return {
        row: rowOffset + Math.max(0, Math.floor(y / lineHeight)),
        col: Math.max(0, Math.floor(x / cellWidth)),
    };
}
