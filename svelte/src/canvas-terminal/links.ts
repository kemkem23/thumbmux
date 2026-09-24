import { collectTerminalUrlSegments, type LineLinkRange } from '@thumbmux/core';

export type CanvasLinkHit = Readonly<{ row: number; startCol: number; endCol: number; href: string }>;

export function canvasLinkHits(lines: readonly string[], cols: number): CanvasLinkHit[] {
  const hits: CanvasLinkHit[] = [];
  for (const match of collectTerminalUrlSegments([...lines], 0, lines.length, cols)) {
    for (const segment of match.segments) {
      hits.push({ row: segment.lineIdx, startCol: segment.startCol, endCol: segment.endCol, href: match.url });
    }
  }
  return hits;
}

export function osc8LinkHits(linksByRow: readonly (readonly LineLinkRange[] | undefined)[]): CanvasLinkHit[] {
  const hits: CanvasLinkHit[] = [];
  linksByRow.forEach((links, row) => links?.forEach((link) => {
    if (link.href.startsWith('http://') || link.href.startsWith('https://') || link.href.startsWith('file://')) {
      hits.push({ row, startCol: link.start, endCol: link.end, href: link.href });
    }
  }));
  return hits;
}
