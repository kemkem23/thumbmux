import { createHash } from 'node:crypto';
import type { CaptureObservation, HistoryRow } from './types';
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
