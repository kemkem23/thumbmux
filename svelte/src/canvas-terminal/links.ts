import { collectTerminalUrlSegments, createSgrState, lineToHtml, stringCells, stripAnsi, charCellWidth, type SgrState, type LineLinkRange, type AnsiPalette } from '@thumbmux/core';

export type CanvasLinkHit = Readonly<{ row: number; startCol: number; endCol: number; href: string }>;

// Consume ONLY the trusted HTML emitted by lineToHtml. OSC8 parsing, precedence
// and isSafeHref remain in that one parser; this is not another ANSI parser.
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, key: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: '\u00a0' })[key]!);
}

export function canvasHtmlLinkHits(htmlRows: readonly string[]): CanvasLinkHit[] {
  const hits: CanvasLinkHit[] = [];
  htmlRows.forEach((html, row) => {
    let text = '';
    let active: { href: string; startCol: number } | null = null;
    for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
      if (token.startsWith('<a ')) {
        const href = token.match(/\bhref="([^"]*)"/);
        active = href ? { href: decode(href[1]!), startCol: stringCells(text) } : null;
      } else if (token === '</a>') {
        if (active) {
          const endCol = stringCells(text);
          const previous = hits.at(-1);
          if (previous && previous.row === row && previous.href === active.href && previous.endCol === active.startCol) {
            hits[hits.length - 1] = { ...previous, endCol };
          } else if (endCol > active.startCol) hits.push({ row, ...active, endCol });
        }
        active = null;
      } else if (!token.startsWith('<')) text += decode(token);
    }
  });
  return hits;
}

/** Invert the URL collector's partial-prefix accounting (charCellWidth sum).
 * Its full-line end can include VS16 promotion; clamping at text.length handles
 * that boundary. Actual canvas positions below always use stringCells. */
function urlColumnToOffset(text: string, column: number): number {
  if (column <= 0) return 0;
  let cells = 0;
  let offset = 0;
  for (const ch of text) {
    const width = charCellWidth(ch.codePointAt(0)!);
    if (width > 0 && cells >= column) break;
    cells += width;
    offset += ch.length;
  }
  return offset;
}

/** Convert collector coordinates only; lineToHtml owns OSC8 and isSafeHref. */
export function canvasLineHtml(raw: string, state: SgrState, palette: AnsiPalette, links: readonly LineLinkRange[] = []): string {
  const text = stripAnsi(raw);
  const ranges = links.map(link => ({
    href: link.href,
    start: urlColumnToOffset(text, link.start),
    end: urlColumnToOffset(text, link.end),
  }));
  return lineToHtml(raw, state, palette, ranges);
}

/** Standalone fixture path uses the same parser as the production HTML cache. */
export function canvasLinkHits(lines: readonly string[], cols: number): CanvasLinkHit[] {
  const links = lines.map(() => [] as { start: number; end: number; href: string }[]);
  for (const match of collectTerminalUrlSegments([...lines], 0, lines.length, cols)) {
    for (const segment of match.segments) {
      // Keep cell coordinates until the common parser boundary.
      links[segment.lineIdx]!.push({ start: segment.startCol, end: segment.endCol, href: match.url });
    }
  }
  const palette: AnsiPalette = { defaultFg: '#fff', defaultBg: '#000', base: Array(16).fill('#fff') };
  const state = createSgrState();
  return canvasHtmlLinkHits(lines.map((line, i) => canvasLineHtml(line, state, palette, links[i])));
}
