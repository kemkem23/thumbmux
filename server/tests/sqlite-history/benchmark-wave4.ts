/**
 * Wave 4 query-plan and latency measurement for the reader canary path.
 *
 * Wave 1 measured hand-written SQL against a read-only copy. What a canary
 * actually pays is `HistoryReaderCanary.page()`: the page query plus the
 * covering-receipt lookups and the batch re-reads its digest check needs. That
 * whole path is measured here, on a synthetic one-million-row fixture, with
 * `EXPLAIN QUERY PLAN` captured for every statement the path issues.
 *
 * Offline and synthetic: temp SQLite only. No tmux, no host paths, no
 * production database.
 */
import { fixture, batch, ids } from './helpers';
import { HistoryReaderCanary } from '../../src/sqlite-history/reader';

const ROWS = 1_000_000, PER_BATCH = 500;

/** Every statement the canary path issues, with the bindings it issues them with. */
const STATEMENTS = (sid: string, revision: number) => [
  { name: 'page-before (DESC)', sql: 'SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no DESC LIMIT ?', args: [sid, 0, 600_000, 2000] },
  { name: 'page-after / batch re-read (ASC)', sql: 'SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no', args: [sid, 400_000, 402_000] },
  { name: 'coverAt (newest receipt at or below a line)', sql: 'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq<=? AND row_start<=? ORDER BY seq DESC LIMIT 1', args: [sid, revision, 400_000] },
  { name: 'coverFrom (receipts tiling the range)', sql: 'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq', args: [sid, 800, revision] },
];

const f = fixture();
try {
  const sid = await f.store.register({ name: 'wave4-million', lifecycleKey: 'wave4-synthetic-million' });
  const commits: number[] = [];
  for (let start = 0; start < ROWS; start += PER_BATCH) {
    const t = performance.now();
    await f.store.commit(batch(f.store, sid, ids(PER_BATCH, start)));
    commits.push(performance.now() - t);
  }
  const audit = f.store.audit(sid);
  if (audit.rows !== ROWS) throw new Error('million-fixture-incomplete');
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  f.db.exec('ANALYZE');

  const reader = new HistoryReaderCanary(f.store);
  const context = reader.snapshot(sid).receipt.context;

  const plans = STATEMENTS(sid, context.revision).map(({ name, sql, args }) => {
    const plan = (f.db.query('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[]).map(p => p.detail);
    const searches = plan.filter(d => /^SEARCH .* USING (PRIMARY KEY|INDEX)/.test(d));
    const scans = plan.filter(d => /\bSCAN\b/.test(d));
    const sorts = plan.filter(d => /TEMP B-TREE|USE TEMP/.test(d));
    if (!searches.length || scans.length || sorts.length) {
      throw new Error(`query-plan-regression: ${name} -> ${JSON.stringify(plan)}`);
    }
    return { name, plan, searches: searches.length, fullTableScans: scans.length, temporarySorts: sorts.length };
  });

  const measure = (limit: number, direction: 'before' | 'after') => {
    const samples: number[] = [];
    let covering = 0, verified = 0;
    for (let trial = 0; trial < 30; trial++) {
      const anchor = direction === 'before' ? 600_000 : 400_000;
      const t = performance.now();
      const result = reader.page(sid, direction, anchor, limit, context);
      samples.push(performance.now() - t);
      if (result.verification.status !== 'verified') throw new Error('benchmark-not-verified');
      if (result.page.rows.length !== limit) throw new Error('benchmark-short-page');
      // Independent of the canary: the text the generator says belongs at each
      // absolute line. `ids()` numbers its suffix inside one batch, and batches
      // are 500 rows, so the suffix of absolute line n is n % 5.
      if (result.page.rows.some((r, i) => r.line_no !== result.page.startLine + i
        || r.text !== `row:${r.line_no}:ไทย漢字\x1b[31m${r.line_no % 5 === 0 ? '' : 'OK'}`)) {
        throw new Error('benchmark-oracle');
      }
      covering = result.verification.coveringCaptures.length;
      verified = result.verification.verifiedRows;
    }
    samples.sort((a, b) => a - b);
    return { direction, limit, coveringReceipts: covering, rowsRedigested: verified,
      p50ms: samples[15], p95ms: samples[28], maxMs: samples[29] };
  };

  commits.sort((a, b) => a - b);
  console.log(JSON.stringify({
    fixture: { rows: audit.rows, captures: audit.captures, perBatch: PER_BATCH,
      note: 'writer open, WAL checkpointed and ANALYZEd; reader canary path measured end to end' },
    commit500: { p50ms: commits[1000], p95ms: commits[1900], maxMs: commits.at(-1) },
    plans,
    reads: [measure(500, 'before'), measure(2000, 'before'), measure(500, 'after'), measure(2000, 'after')],
  }, null, 2));
} finally { await f.cleanup(); }
