export interface TerminalLinkSegment {
  lineIdx: number;
  startCol: number;
  endCol: number;
}

export interface TerminalLinkMatch {
  url: string;
  segments: TerminalLinkSegment[];
}

const urlStartRe = /https?:\/\//g;
const terminalTokenRe = /^[^\s<>"')\]}{]+/;

export function collectTerminalUrlSegments(rawLines: string[], startLine: number, endLine: number, cols: number): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (let wi = startLine; wi < endLine; wi++) {
    const stripped = stripAnsi(rawLines[wi]).trimEnd();
    urlStartRe.lastIndex = 0;
    let match;
    while ((match = urlStartRe.exec(stripped)) !== null) {
      const urlOnLine = stripped.slice(match.index).match(/^https?:\/\/[^\s<>"')\]}{]+/);
      if (!urlOnLine) continue;

      let fullUrl = urlOnLine[0];
      const segments: TerminalLinkSegment[] = [{
        lineIdx: wi,
        startCol: match.index,
        endCol: match.index + urlOnLine[0].length,
      }];

      let curIdx = wi;
      let curEndPos = segments[0].endCol;
      while (
        curEndPos >= cols - 2 &&
        curEndPos > 10 &&
        curIdx + 1 < rawLines.length
      ) {
        const nextStripped = stripAnsi(rawLines[curIdx + 1]).trimEnd();
        const trimmed = nextStripped.trimStart();
        if (trimmed.length === 0) break;
        const cont = trimmed.match(terminalTokenRe);
        if (!cont) break;

        fullUrl += cont[0];
        curIdx++;
        const indent = nextStripped.length - trimmed.length;
        segments.push({
          lineIdx: curIdx,
          startCol: indent,
          endCol: indent + cont[0].length,
        });
        curEndPos = segments[segments.length - 1].endCol;
      }

      let trailingTrim = 0;
      while (fullUrl.length > 1 && /[.,;:!?)}\]>]$/.test(fullUrl)) {
        if (fullUrl.endsWith(')') && fullUrl.includes('(')) break;
        fullUrl = fullUrl.slice(0, -1);
        trailingTrim += 1;
      }

      let remainingTrim = trailingTrim;
      while (remainingTrim > 0 && segments.length > 0) {
        const last = segments[segments.length - 1];
        const segmentLen = last.endCol - last.startCol;
        if (segmentLen > remainingTrim) {
          last.endCol -= remainingTrim;
          remainingTrim = 0;
        } else {
          segments.pop();
          remainingTrim -= segmentLen;
        }
      }

      if (segments.length === 0 || !segments.some((segment) => segment.endCol > segment.startCol)) {
        continue;
      }

      matches.push({
        url: fullUrl,
        segments,
      });
    }
  }

  return matches;
}

export function findTerminalUrlAtCell(rawLines: string[], lineIdx: number, col: number, cols: number): string | null {
  if (!Number.isFinite(lineIdx) || !Number.isFinite(col) || !Number.isFinite(cols)) return null;
  const targetLine = Math.floor(lineIdx);
  const targetCol = Math.floor(col);
  if (targetLine < 0 || targetLine >= rawLines.length || targetCol < 0 || cols <= 0) return null;

  const windowStart = Math.max(0, targetLine - 10);
  const windowEnd = Math.min(rawLines.length, targetLine + 11);
  for (const match of collectTerminalUrlSegments(rawLines, windowStart, windowEnd, cols)) {
    for (const segment of match.segments) {
      if (
        segment.lineIdx === targetLine &&
        targetCol >= segment.startCol &&
        targetCol < segment.endCol
      ) {
        return match.url;
      }
    }
  }

  return null;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '');
}
