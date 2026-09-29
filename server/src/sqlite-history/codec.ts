import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { CaptureObservation, HistoryRow, PhysicalRow, ProjectionCell } from './types';
export function safe(value: number, label = 'integer'): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`unsafe-${label}`);
  return value;
}
export function sha(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function rowsDigest(rows: readonly HistoryRow[]): string {
  const h = createHash('sha256');
  for (const row of rows) {
    for (const part of [String(row.line_no), row.kind, row.text]) {
      const data = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(data.length));
      h.update(length); h.update(data);
    }
  }
  return h.digest('hex');
}
export function validateObservation(o: CaptureObservation): void {
  if (!Number.isFinite(o.at)) throw new Error('invalid-time');
  for (const rows of [o.raw, o.screen]) {
    if (!Array.isArray(rows) || rows.some(r => typeof r !== 'string' || !r.isWellFormed())) throw new Error('invalid-rows');
  }
  const g = o.geometry;
  if (!g || !['pane', 'legacy-window'].includes(g.kind) || typeof g.alternate !== 'boolean') throw new Error('invalid-geometry');
  safe(g.rows); safe(g.cols); safe(g.generation);
  if (g.kind === 'pane' && (!g.rows || !g.cols || o.screen.length !== Math.min(g.rows, o.raw.length)
    || JSON.stringify(o.raw.slice(-o.screen.length || o.raw.length)) !== JSON.stringify(o.screen))) throw new Error('screen-seam');
  if (g.cursor !== undefined && g.cursor !== null) {
    safe(g.cursor.row); safe(g.cursor.col);
    if (Object.keys(g.cursor).sort().join(',') !== 'col,row') throw new Error('invalid-cursor');
  }
  if (!o.source || Object.keys(o.source).some(k => !['ringFull','activity','reset'].includes(k)
    || typeof (o.source as Record<string, unknown>)[k] !== 'boolean')) throw new Error('invalid-source');
}

// ── NEWARCH v4 (migration 004-newarch-compact-rows): compact projection rows ──
// A row is stored as its text plus a short `cells` string; only what the text
// cannot say is written. The format is frozen: a change needs a new schema version.
type Cell = ProjectionCell;
type CellRun = [string, number, boolean, string | number | null, string | number | null, number, number];
/** Legacy (v2/v3) run-length JSON: one run per repeated identical cell. Kept for frames, fallback rows and v3 archives. */
export function encodeCellRuns(cells: readonly Cell[]): string {
  const runs: CellRun[] = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last[0] === c.grapheme && last[1] === c.width && last[2] === c.continuation
      && last[3] === c.fg && last[4] === c.bg && last[5] === c.style) last[6]++;
    else runs.push([c.grapheme, c.width, c.continuation, c.fg, c.bg, c.style, 1]);
  }
  return JSON.stringify(runs);
}
export function decodeCellRuns(encoded: string | readonly unknown[]): Cell[] {
  const runs = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  // Earlier v2 files used [cell,count]; both encodings are lossless/readable.
  return (runs as any[]).flatMap(run => {
    if (typeof run[0] === 'object') return Array.from({ length: run[1] }, () => ({ ...run[0] }));
    const [grapheme, width, continuation, fg, bg, style, n] = run;
    return Array.from({ length: n }, () => ({ grapheme, width, continuation, fg, bg, style }));
  });
}

// Colour tokens: '' default · '~' null · 'N' index:N · 'R,G,B' rgb:R,G,B · '#N' the number N.
const INDEX = /^index:(0|[1-9]\d*)$/, RGB = /^rgb:((?:0|[1-9]\d*),(?:0|[1-9]\d*),(?:0|[1-9]\d*))$/;
function colourToken(v: string | number | null): string | null {
  if (v === 'default') return '';
  if (v === null) return '~';
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? '#' + v : null;
  return INDEX.exec(v)?.[1] ?? RGB.exec(v)?.[1] ?? null;
}
function colourValue(t: string): string | number | null {
  if (t === '') return 'default';
  if (t === '~') return null;
  if (t[0] === '#') return Number(t.slice(1));
  return t.includes(',') ? 'rgb:' + t : 'index:' + t;
}
const units = (g: string) => g.length === 1 || (g.length === 2 && g.codePointAt(0)! > 0xffff);
/**
 * `text` and `cells` of a physical row → the stored pair. Compact when the text
 * is exactly the row's non-continuation graphemes (the runtime's rowText):
 *   cells = `<n>|<layout>|<runs>`, text = the row text without its trailing blank cells.
 * layout tokens (optional decimal count first): `a` one code point, width 1 ·
 * `w` one code point, width 2 · `c` continuation (''/0) · `(u,w,c)` anything else,
 * u = UTF-16 units taken from the text. Cells past the last token are `a`, and
 * `a` past the end of the stored text is ' ' (the trimmed blanks).
 * runs: space-separated `<count>` (default colours, style 0) or
 * `<count>:<fg>:<bg>:<style>`; cells past the last run are default.
 * Anything else (text that is not the cells, a continuation with a grapheme,
 * a colour outside the tokens) is stored verbatim with the legacy JSON runs.
 */
export function encodeRow(text: string, cells: readonly Cell[]): { text: string; cells: string } {
  let layout = '', runs = '', pos = 0, token = '', repeat = 0, blank = 0;
  let fg: string | number | null = 'default', bg: string | number | null = 'default', style = 0, count = 0;
  const flush = () => { if (repeat) { layout += (repeat > 1 ? repeat : '') + token; repeat = 0; } };
  const run = () => { if (count) runs += (runs ? ' ' : '') + runToken(count, fg, bg, style); };
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!, g = c.grapheme;
    let t: string;
    if (c.continuation) {
      if (g !== '') return legacy(text, cells);
      t = c.width === 0 ? 'c' : `(0,${c.width},1)`;
    } else {
      if (!text.startsWith(g, pos)) return legacy(text, cells);
      pos += g.length;
      t = units(g) && c.width === 1 ? 'a' : units(g) && c.width === 2 ? 'w' : `(${g.length},${c.width},0)`;
    }
    if (t === token) repeat++; else { flush(); token = t; repeat = 1; }
    blank = t === 'a' && g === ' ' ? blank + 1 : 0;
    if (c.fg !== fg || c.bg !== bg || c.style !== style) {
      if (colourToken(c.fg) === null || colourToken(c.bg) === null || !Number.isSafeInteger(c.style) || c.style < 0) return legacy(text, cells);
      run(); fg = c.fg; bg = c.bg; style = c.style; count = 0;
    }
    count++;
  }
  if (pos !== text.length) return legacy(text, cells);
  // A trailing `a` token and a trailing default run stay implicit; the blanks
  // at the end of the row are `a` spaces, so the text drops them.
  if (token !== 'a') flush();
  if (!(fg === 'default' && bg === 'default' && style === 0)) run();
  return { text: blank ? text.slice(0, text.length - blank) : text, cells: `${cells.length}|${layout}|${runs}` };
}
function runToken(count: number, fg: string | number | null, bg: string | number | null, style: number): string {
  return fg === 'default' && bg === 'default' && style === 0 ? String(count) : `${count}:${colourToken(fg)}:${colourToken(bg)}:${style || ''}`;
}
function legacy(text: string, cells: readonly Cell[]) { return { text, cells: encodeCellRuns(cells) }; }

/** The stored pair → the physical row, exactly as it was offered. */
export function decodeRow(stored: string, encoded: string): PhysicalRow {
  if (encoded[0] === '[') return { text: stored, cells: decodeCellRuns(encoded) };
  const bar = encoded.indexOf('|'), bar2 = encoded.indexOf('|', bar + 1);
  const n = Number(encoded.slice(0, bar)), layout = encoded.slice(bar + 1, bar2), runs = encoded.slice(bar2 + 1);
  if (!Number.isSafeInteger(n) || n < 0 || bar2 < 0) throw new Error('row-codec-corrupt');
  const cells: Cell[] = new Array(n);
  let at = 0, pos = 0, pad = 0;
  const take = (k: number) => { const g = stored.slice(pos, pos + k); if (g.length !== k) throw new Error('row-codec-corrupt'); pos += k; return g; };
  const point = () => { if (pos >= stored.length) { pad++; return ' '; } return take(stored.codePointAt(pos)! > 0xffff ? 2 : 1); };
  const cell = (grapheme: string, width: number, continuation: boolean) => {
    if (at >= n) throw new Error('row-codec-corrupt');
    cells[at++] = { grapheme, width, continuation, fg: 'default', bg: 'default', style: 0 };
  };
  for (let i = 0; i < layout.length;) {
    let k = 0; while (layout.charCodeAt(i) >= 48 && layout.charCodeAt(i) <= 57) k = k * 10 + layout.charCodeAt(i++) - 48;
    const t = layout[i++];
    let make: () => void;
    if (t === 'a') make = () => cell(point(), 1, false);
    else if (t === 'w') make = () => cell(point(), 2, false);
    else if (t === 'c') make = () => cell('', 0, true);
    else if (t === '(') {
      const end = layout.indexOf(')', i); const [u, w, c] = layout.slice(i, end).split(',').map(Number); i = end + 1;
      if (end < 0 || ![0, 1, 2].includes(w!) || (c !== 0 && c !== 1)) throw new Error('row-codec-corrupt');
      make = () => cell(c ? '' : take(u!), w!, c === 1);
    } else throw new Error('row-codec-corrupt');
    for (let r = k || 1; r > 0; r--) make();
  }
  while (at < n) cell(point(), 1, false);
  if (pos !== stored.length) throw new Error('row-codec-corrupt');
  if (runs) {
    let x = 0;
    for (const run of runs.split(' ')) {
      const parts = run.split(':'), count = Number(parts[0]);
      if (!Number.isSafeInteger(count) || count < 1 || x + count > n || (parts.length !== 1 && parts.length !== 4)) throw new Error('row-codec-corrupt');
      if (parts.length === 4) {
        const fg = colourValue(parts[1]!), bg = colourValue(parts[2]!), style = parts[3] ? Number(parts[3]) : 0;
        for (let j = x; j < x + count; j++) { const c = cells[j]!; c.fg = fg; c.bg = bg; c.style = style; }
      }
      x += count;
    }
  }
  return { text: pad ? stored + ' '.repeat(pad) : stored, cells };
}

/** Sealed history block: deflated JSON of consecutive stored lines of one pane. */
export const BLOCK_FORMAT = 1;
export function encodeBlock(lines: readonly unknown[][]): Uint8Array {
  const body = deflateRawSync(Buffer.from(JSON.stringify(lines)));
  const out = new Uint8Array(body.length + 1); out[0] = BLOCK_FORMAT; out.set(body, 1);
  return out;
}
export function decodeBlock(data: Uint8Array): unknown[][] {
  if (data[0] !== BLOCK_FORMAT) throw new Error('block-format-unknown');
  return JSON.parse(inflateRawSync(data.subarray(1)).toString('utf8'));
}

// Capture archives need corruption detection independent of SQLite's page
// checks. The hash covers the exact inflated bytes and the length prevents a
// truncated/oversized inflate from being accepted as another valid corpus.
export const CAPTURE_ARCHIVE_FORMAT = 1;
export function encodeCaptureArchive(rows:readonly unknown[][]):Uint8Array {
  const raw=Buffer.from(JSON.stringify(rows)),body=deflateRawSync(raw),out=Buffer.alloc(37+body.length);
  out[0]=CAPTURE_ARCHIVE_FORMAT;out.writeUInt32BE(raw.length,1);
  createHash('sha256').update(raw).digest().copy(out,5);body.copy(out,37);return out;
}
export function decodeCaptureArchive(data:Uint8Array):unknown[][] {
  const input=Buffer.from(data);
  if(input.length<37 || input[0]!==CAPTURE_ARCHIVE_FORMAT)throw new Error('capture-archive-format-unknown');
  const expected=input.readUInt32BE(1),raw=inflateRawSync(input.subarray(37));
  if(raw.length!==expected)throw new Error('capture-archive-size');
  const digest=createHash('sha256').update(raw).digest();
  if(!digest.equals(input.subarray(5,37)))throw new Error('capture-archive-checksum');
  const rows=JSON.parse(raw.toString('utf8'));
  if(!Array.isArray(rows))throw new Error('capture-archive-corrupt');
  return rows;
}
