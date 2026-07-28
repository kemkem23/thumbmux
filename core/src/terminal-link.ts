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
// Sticky token match at a known scheme start — avoids slicing the rest of the line.
const urlTokenStickyRe = /https?:\/\/[^\s<>"')\]}{]+/y;
// Anchored scheme detector for continuation rows; never shares lastIndex with urlStartRe.
const urlSchemeAtStartRe = /^https?:\/\//;
// Trailing query/form context: the next token is a parameter value (or the next
// parameter), not a brand-new top-level URL. Used to allow embedded schemes
// like `redirect_uri=https://…` that wrap exactly at the value's scheme.
const midParameterContextRe = /[?&=]$/;

// Callers pass a window narrower than rawLines with a seam appended so a link that
// starts in the window can finish outside it — allow continuations that far past endLine.
const CONTINUATION_SEAM_LINES = 32;
// Backstop against adversarial/stale-width input; 128 rows is far beyond any real URL
// (>2,500 chars even at a 20-column pane).
const MAX_CONTINUATION_ROWS = 128;

/**
 * True when `urlSoFar` ends mid-parameter, so a scheme-leading next row is the
 * value tail of this URL (OAuth redirect_uri=, ?u=, &next=) rather than a new link.
 *
 * Discriminator is the accumulated URL only — never the continuation row. A
 * complete-looking tail (host/path/fragment char) means the next scheme is
 * unrelated and must break; only `?`, `&`, `=` open parameter context at a wrap.
 */
function isMidParameterContext(urlSoFar: string): boolean {
  return midParameterContextRe.test(urlSoFar);
}

export function collectTerminalUrlSegments(rawLines: string[], startLine: number, endLine: number, cols: number): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  // Lazily filled stripAnsi(rawLines[i]).trimEnd() — at most once per row per call.
  // Out-of-range indices still throw via the rawLines access (no clamping).
  // Indexed by offset from startLine and sized to the window + seam: the walk only moves
  // forward, so a tap that scans 21 rows must not allocate for the whole scrollback.
  const cacheBase = startLine;
  const cacheSize = Math.max(0, endLine - startLine) + CONTINUATION_SEAM_LINES;
  const strippedCache: (string | undefined)[] = new Array(cacheSize);
  const getStripped = (i: number): string => {
    const slot = i - cacheBase;
    let cached = strippedCache[slot];
    if (cached === undefined) {
      cached = stripAnsi(rawLines[i]).trimEnd();
      strippedCache[slot] = cached;
    }
    return cached;
  };
  // Exclusive end column already absorbed into an earlier link on this row.
  const consumedEndCol = new Map<number, number>();
  const continuationLimit = Math.min(rawLines.length, endLine + CONTINUATION_SEAM_LINES);

  for (let wi = startLine; wi < endLine; wi++) {
    const stripped = getStripped(wi);
    const rowConsumed = consumedEndCol.get(wi) ?? 0;
    urlStartRe.lastIndex = 0;
    let match;
    while ((match = urlStartRe.exec(stripped)) !== null) {
      // Skip starts already absorbed by a prior link's continuation on this row.
      if (match.index < rowConsumed) continue;

      urlTokenStickyRe.lastIndex = match.index;
      const urlOnLine = urlTokenStickyRe.exec(stripped);
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
        curIdx + 1 < continuationLimit &&
        segments.length - 1 < MAX_CONTINUATION_ROWS
      ) {
        const nextStripped = getStripped(curIdx + 1);
        const trimmed = nextStripped.trimStart();
        if (trimmed.length === 0) break;
        // A row that starts a scheme is a new logical link — unless the URL so
        // far is mid-parameter and this scheme is its value (wrap at `=` / `?` / `&`).
        if (urlSchemeAtStartRe.test(trimmed) && !isMidParameterContext(fullUrl)) break;
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

      // Mark absorbed continuation rows (not the origin) after trim; only survivors count.
      for (let si = 1; si < segments.length; si++) {
        const seg = segments[si];
        const prev = consumedEndCol.get(seg.lineIdx) ?? 0;
        consumedEndCol.set(seg.lineIdx, Math.max(prev, seg.endCol));
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
  // Every pattern below needs an ESC byte; skip three regex passes when there is none.
  if (text.indexOf('\x1b') < 0) return text;
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '');
}
