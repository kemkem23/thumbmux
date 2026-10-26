import { collectTerminalUrlSegments, createSgrState, lineToHtml, stringCells, stripAnsi, charCellWidth } from '../../core/index.js';
// Consume ONLY the trusted HTML emitted by lineToHtml. OSC8 parsing, precedence
// and isSafeHref remain in that one parser; this is not another ANSI parser.
function decode(text) {
    return text.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: '\u00a0' })[key]);
}
export function canvasHtmlLinkHits(htmlRows) {
    const hits = [];
    htmlRows.forEach((html, row) => {
        let text = '';
        let active = null;
        for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
            if (token.startsWith('<a ')) {
                const href = token.match(/\bhref="([^"]*)"/);
                active = href ? { href: decode(href[1]), startCol: stringCells(text) } : null;
            }
            else if (token === '</a>') {
                if (active) {
                    const endCol = stringCells(text);
                    const previous = hits.at(-1);
                    if (previous && previous.row === row && previous.href === active.href && previous.endCol === active.startCol) {
                        hits[hits.length - 1] = { ...previous, endCol };
                    }
                    else if (endCol > active.startCol)
                        hits.push({ row, ...active, endCol });
                }
                active = null;
            }
            else if (!token.startsWith('<'))
                text += decode(token);
        }
    });
    return hits;
}
/** Invert the URL collector's partial-prefix accounting (charCellWidth sum).
 * Its full-line end can include VS16 promotion; clamping at text.length handles
 * that boundary. Actual canvas positions below always use stringCells. */
function urlColumnToOffset(text, column) {
    if (column <= 0)
        return 0;
    let cells = 0;
    let offset = 0;
    for (const ch of text) {
        const width = charCellWidth(ch.codePointAt(0));
        if (width > 0 && cells >= column)
            break;
        cells += width;
        offset += ch.length;
    }
    return offset;
}
/** Convert collector coordinates only; lineToHtml owns OSC8 and isSafeHref. */
export function canvasLineHtml(raw, state, palette, links = []) {
    const text = stripAnsi(raw);
    const ranges = links.map(link => ({
        href: link.href,
        start: urlColumnToOffset(text, link.start),
        end: urlColumnToOffset(text, link.end),
    }));
    return lineToHtml(raw, state, palette, ranges);
}
/** Standalone fixture path uses the same parser as the production HTML cache. */
export function canvasLinkHits(lines, cols) {
    const links = lines.map(() => []);
    for (const match of collectTerminalUrlSegments([...lines], 0, lines.length, cols)) {
        for (const segment of match.segments) {
            // Keep cell coordinates until the common parser boundary.
            links[segment.lineIdx].push({ start: segment.startCol, end: segment.endCol, href: match.url });
        }
    }
    const palette = { defaultFg: '#fff', defaultBg: '#000', base: Array(16).fill('#fff') };
    const state = createSgrState();
    return canvasHtmlLinkHits(lines.map((line, i) => canvasLineHtml(line, state, palette, links[i])));
}
