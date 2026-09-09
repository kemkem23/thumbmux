/**
 * Wave 4: the opt-in SQLite reader canary.
 *
 * Nothing in the shipping viewer/REST path imports this file. It is reachable
 * only through `createSqliteHistoryStore(...).createReaderCanary(...)`, which
 * itself is an opt-in entry, so the default server keeps reading the legacy
 * projection exactly as it did in wave 3.
 *
 * The property this wave adds on top of wave 1's `page()` is that **every
 * range handed to a caller is re-checked against digests the writer committed
 * earlier** (`history_capture.rows_sha256`), inside the same read snapshot that
 * produced the rows. A range that cannot be checked is reported as
 * `unverifiable` with a named reason; a range that is legitimately empty is
 * reported as `empty` with a named reason. Neither is ever a bare `[]`, and a
 * digest that disagrees is a loud fault, not a quiet downgrade.
 */
import { rowsDigest } from './codec';
import type { HistoryStore } from './store';
import type { CaptureReceipt, HistoryContext, HistoryPageV1, HistoryRow } from './types';

export type ReaderUnverifiableReason =
  /** The range starts below the oldest capture receipt (retention/import floor). */
  | 'range-below-verified-floor'
  /** Receipts exist on both sides but do not tile the range. */
  | 'covering-receipt-gap'
  /** The range runs past the newest receipt of the pinned revision. */
  | 'range-above-verified-receipt';

export type ReaderEmptyReason = 'at-floor' | 'at-live-start';

export type ReaderVerification =
  | { status: 'verified'; coveringCaptures: number[]; verifiedRows: number; digests: number }
  | { status: 'empty'; reason: ReaderEmptyReason; coveringCaptures: [] }
  | { status: 'unverifiable'; reason: ReaderUnverifiableReason; coveringCaptures: number[]; detail: Record<string, number> };

export interface ReaderPageResult { page: HistoryPageV1; verification: ReaderVerification }
export interface ReaderSnapshotResult {
  receipt: CaptureReceipt; live: HistoryRow[]; verification: ReaderVerification;
}

type CoverRow = { seq: number; row_start: number; row_end: number; expected_rows: number; rows_sha256: string };

/**
 * Read-only facade. It holds a `HistoryStore` but exposes no writer, no ticket
 * and no SQL handle, so a canary wired to this object cannot mutate history.
 */
export class HistoryReaderCanary {
  constructor(private store: HistoryStore) {}

  /** Locate the receipt whose batch contains `line`, walking back at most one step. */
  private coverAt(sid: string, revision: number, line: number): CoverRow | null {
    return this.store.db.query(
      'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq<=? AND row_start<=? ORDER BY seq DESC LIMIT 1',
    ).get(sid, revision, line) as CoverRow | null;
  }

  private coverFrom(sid: string, revision: number, seq: number): CoverRow[] {
    return this.store.db.query(
      'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq',
    ).all(sid, seq, revision) as CoverRow[];
  }

  /**
   * Compare `rows` (already served for `[start,end)`) with the committed
   * receipts covering that range. Runs inside the caller's read transaction.
   */
  private verify(sid: string, revision: number, rows: readonly HistoryRow[], start: number, end: number): ReaderVerification {
    if (start === end) throw new Error('verify-empty-range');
    const head = this.coverAt(sid, revision, start);
    if (!head || head.row_end <= start) {
      return { status: 'unverifiable', reason: 'range-below-verified-floor', coveringCaptures: [],
        detail: { start, end, oldestReceiptRowStart: head ? head.row_start : -1 } };
    }
    const covering: number[] = [];
    const verified: HistoryRow[] = [];
    let cursor = head.row_start;
    for (const cover of this.coverFrom(sid, revision, head.seq)) {
      if (cover.row_start !== cursor) {
        return { status: 'unverifiable', reason: 'covering-receipt-gap', coveringCaptures: covering,
          detail: { start, end, expectedRowStart: cursor, observedRowStart: cover.row_start } };
      }
      cursor = cover.row_end;
      if (cover.row_end === cover.row_start) continue;
      // Independent re-read of the batch the writer hashed, then the writer's
      // own committed digest. A count-only check cannot pass this.
      const batch = this.store.rows(sid, cover.row_start, cover.row_end);
      this.store.checkRange(sid, batch, cover.row_start, cover.row_end);
      if (batch.length !== cover.expected_rows || rowsDigest(batch) !== cover.rows_sha256) {
        this.store.persistFault(sid, 'reader-batch-digest',
          { seq: cover.seq, expected_rows: cover.expected_rows, rows_sha256: cover.rows_sha256 },
          { rows: batch.length, rows_sha256: rowsDigest(batch) });
        throw new Error('history-unavailable:reader-batch-digest');
      }
      covering.push(cover.seq);
      verified.push(...batch);
      if (cursor >= end) break;
    }
    if (cursor < end) {
      return { status: 'unverifiable', reason: 'range-above-verified-receipt', coveringCaptures: covering,
        detail: { start, end, verifiedThrough: cursor } };
    }
    const offset = start - head.row_start;
    const slice = verified.slice(offset, offset + (end - start));
    const rangeMatches = slice.length === rows.length
      && slice.every((r, i) => r.line_no === rows[i]?.line_no && r.kind === rows[i]?.kind && r.text === rows[i]?.text);
    if (!rangeMatches) {
      this.store.persistFault(sid, 'reader-range-digest',
        { start, end, rows: slice.length, digest: rowsDigest(slice) },
        { rows: rows.length, digest: rowsDigest(rows) });
      throw new Error('history-unavailable:reader-range-digest');
    }
    return { status: 'verified', coveringCaptures: covering, verifiedRows: verified.length, digests: covering.length };
  }

  page(sid: string, direction: 'before' | 'after', anchor: number | null, limit: number, context?: HistoryContext): ReaderPageResult {
    return this.store.db.transaction(() => {
      const page = this.store.page(sid, direction, anchor, limit, context);
      if (!page.rows.length) {
        return { page, verification: { status: 'empty' as const,
          reason: (direction === 'before' ? 'at-floor' : 'at-live-start') as ReaderEmptyReason, coveringCaptures: [] as [] } };
      }
      return { page, verification: this.verify(sid, page.context.revision, page.rows, page.startLine, page.endLine) };
    })();
  }

  snapshot(sid: string): ReaderSnapshotResult {
    return this.store.db.transaction(() => {
      const snapshot = this.store.snapshot(sid);
      const { live, ...receipt } = snapshot;
      const { liveStart, nextLine, revision } = receipt.context;
      const verification: ReaderVerification = live.length
        ? this.verify(sid, revision, live, liveStart, nextLine)
        : { status: 'empty', reason: 'at-live-start', coveringCaptures: [] };
      return { receipt, live, verification };
    })();
  }
}

/**
 * The canary REST surface, as a pure `Request` -> `Response` function. It owns
 * no port and no server: a canary host mounts it, the wave-4 browser proof
 * mounts it on an ephemeral 127.0.0.1 listener, and nothing mounts it by
 * default. Failures answer with a status and a named error, never 200-with-[].
 */
export async function historyReaderRequest(reader: HistoryReaderCanary, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' });
  const sid = url.searchParams.get('session');
  if (!sid) return json(400, { error: 'session-required' });
  try {
    if (url.pathname === '/history/snapshot') return json(200, reader.snapshot(sid));
    if (url.pathname === '/history/page') {
      const direction = url.searchParams.get('direction');
      if (direction !== 'before' && direction !== 'after') return json(400, { error: 'direction-required' });
      const rawAnchor = url.searchParams.get('anchor');
      const anchor = rawAnchor === null || rawAnchor === '' ? null : Number(rawAnchor);
      if (anchor !== null && !Number.isSafeInteger(anchor)) return json(400, { error: 'anchor-invalid' });
      const limit = Number(url.searchParams.get('limit'));
      const rawContext = url.searchParams.get('context');
      let context: HistoryContext | undefined;
      if (rawContext) {
        try { context = JSON.parse(rawContext) as HistoryContext; }
        catch { return json(400, { error: 'context-invalid' }); }
      }
      return json(200, reader.page(sid, direction, anchor, limit, context));
    }
    return json(404, { error: 'not-found' });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // A pinned viewer that fell behind is a retryable 409; a storage/digest
    // fault is a 503. Neither is ever flattened into an empty success.
    return json(message.includes('context-mismatch') ? 409 : 503, { error: message });
  }
}
