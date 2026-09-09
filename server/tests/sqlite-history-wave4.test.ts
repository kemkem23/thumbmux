/**
 * Wave 4 fixture proofs for the opt-in SQLite reader canary.
 *
 * Everything here runs on a synthetic temp database. No tmux, no production
 * history, no `brain.db`, no network. The canary is never mounted on the
 * shipping viewer/REST path; these tests mount it themselves.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HistoryReaderCanary, historyReaderRequest } from '../src/sqlite-history/reader';
import { rowsDigest } from '../src/sqlite-history/codec';
import { validateHistoryPage } from '../src/sqlite-history/detectors';
import type { HistoryContext, HistoryRow } from '../src/sqlite-history/types';
import { batch, fixture, ids } from './sqlite-history/helpers';

type Verifier = { verify(sid: string, revision: number, rows: HistoryRow[], start: number, end: number): { status: string; reason?: string } };
const verifier = (reader: HistoryReaderCanary) => reader as unknown as Verifier;

async function seed(store: ReturnType<typeof fixture>['store'], sid: string, total: number, per = 100) {
  for (let start = 0; start < total; start += per) await store.commit(batch(store, sid, ids(per, start)));
}

/** A commit that leaves `liveImmutable` numbered rows inside the live window. */
async function seedLive(store: ReturnType<typeof fixture>['store'], sid: string, from: number, count: number, liveImmutable: number) {
  const b = batch(store, sid, ids(count, from));
  await store.commit({ ...b, liveLineLimit: liveImmutable + b.observation.screen.length });
}

describe('wave 4 reader canary', () => {
  test('a served range is checked against the digests the writer committed', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'verify', lifecycleKey: 'wave4-verify' });
      await seed(f.store, sid, 1000);
      const reader = new HistoryReaderCanary(f.store);
      const snapshot = reader.snapshot(sid);
      // Nothing is parked in the live window here, and the canary says exactly
      // that rather than inventing a verified empty range.
      expect(snapshot.verification).toEqual({ status: 'empty', reason: 'at-live-start', coveringCaptures: [] });
      const result = reader.page(sid, 'before', null, 500, snapshot.receipt.context);
      expect(result.verification.status).toBe('verified');
      if (result.verification.status !== 'verified') throw new Error('unreachable');
      // Independent of the canary: the expected rows recomputed from the raw
      // ids() generator, not from anything the reader returned.
      const expected: HistoryRow[] = ids(500, result.page.startLine)
        .map((text, i) => ({ line_no: result.page.startLine + i, kind: 'terminal' as const, text }));
      expect(rowsDigest(result.page.rows)).toBe(rowsDigest(expected));
      expect(result.verification.digests).toBeGreaterThan(0);
      // `source-unknown` is wave 1's honest answer for a synthetic driver with
      // no source evidence; no reader/storage detector may fire here.
      expect(f.alarms.filter(a => a.detector !== 'source-unknown')).toEqual([]);
    } finally { await f.cleanup(); }
  });

  test('the live window a reopened viewer renders is checked against its receipts', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'live', lifecycleKey: 'wave4-live' });
      await seed(f.store, sid, 700);
      await seedLive(f.store, sid, 700, 300, 290);
      const reader = new HistoryReaderCanary(f.store);
      const snapshot = reader.snapshot(sid);
      expect(snapshot.receipt.context.liveStart).toBe(710);
      expect(snapshot.live).toHaveLength(290);
      expect(snapshot.verification.status).toBe('verified');
      expect(snapshot.live.map(r => r.text)).toEqual(ids(290, 710));
    } finally { await f.cleanup(); }
  });

  test('an empty page is reported as empty with a reason, never as a bare []', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'empty', lifecycleKey: 'wave4-empty' });
      await seed(f.store, sid, 200);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      const atFloor = reader.page(sid, 'before', ctx.firstLine, 100, ctx);
      expect(atFloor.page.rows).toHaveLength(0);
      expect(atFloor.verification).toEqual({ status: 'empty', reason: 'at-floor', coveringCaptures: [] });
      const atLive = reader.page(sid, 'after', ctx.liveStart, 100, ctx);
      expect(atLive.page.rows).toHaveLength(0);
      expect(atLive.verification).toEqual({ status: 'empty', reason: 'at-live-start', coveringCaptures: [] });
    } finally { await f.cleanup(); }
  });

  test('a range under the oldest receipt answers unverifiable, not verified', async () => {
    const f = fixture();
    try {
      // An import floor above zero: rows exist from 5,000 up, so nothing below
      // 5,000 has a receipt that could ever certify it.
      const sid = await f.store.register({ name: 'floor', lifecycleKey: 'wave4-floor', firstLine: 5000 });
      await seed(f.store, sid, 300);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      expect(ctx.firstLine).toBe(5000);
      const ok = reader.page(sid, 'before', null, 100, ctx);
      expect(ok.verification.status).toBe('verified');
      // Ask the verifier directly about a range below the first receipt.
      const below = verifier(reader).verify(sid, ctx.revision, [], 4000, 4100);
      expect(below.status).toBe('unverifiable');
      expect(below.reason).toBe('range-below-verified-floor');
    } finally { await f.cleanup(); }
  });

  test('a tampered row is a loud fault with a receipt, not a downgraded status', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'tamper', lifecycleKey: 'wave4-tamper' });
      await seed(f.store, sid, 300);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      expect(reader.page(sid, 'before', null, 200, ctx).verification.status).toBe('verified');
      // The immutability trigger is doing its job, so tamper the way a corrupt
      // file or a direct editor would: a separate connection with the guard
      // dropped. This is the "bypass the trigger in a copy" fault the design
      // asks for, and it proves the reader does not trust its own storage.
      const saboteur = new Database(f.file, { strict: true });
      saboteur.exec('DROP TRIGGER line_immutable');
      saboteur.query("UPDATE history_line SET text='tampered' WHERE session_id=? AND line_no=?").run(sid, 150);
      saboteur.close();
      expect(() => reader.page(sid, 'before', null, 200, ctx)).toThrow(/reader-batch-digest/);
      // Scope stated honestly: a range read certifies the receipts it covers.
      // The page that ends before the tampered batch still answers `verified`,
      // and `audit()` is what sweeps the batches no reader asked for.
      expect(reader.page(sid, 'before', 100, 50, ctx).verification.status).toBe('verified');
      expect(() => f.store.audit(sid)).toThrow(/batch-hash/);
      const fault = f.alarms.find(a => a.detector === 'reader-batch-digest');
      expect(fault).toBeDefined();
      expect(fault!.issue_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof fault!.timestamp).toBe('number');
    } finally { await f.cleanup(); }
  });

  test('backward paging tiles the archive with no hole and no duplicate', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'range', lifecycleKey: 'wave4-range' });
      await seed(f.store, sid, 1000);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      const seen: HistoryRow[] = [];
      let anchor: number | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const { page, verification } = reader.page(sid, 'before', anchor, 137, ctx);
        if (verification.status === 'empty') break;
        expect(verification.status).toBe('verified');
        validateHistoryPage(ctx, page);
        seen.unshift(...page.rows);
        if (!page.hasMore) break;
        anchor = page.startLine;
      }
      expect(seen).toHaveLength(ctx.liveStart - ctx.firstLine);
      expect(seen.map(r => r.line_no)).toEqual(
        Array.from({ length: seen.length }, (_, i) => ctx.firstLine + i));
    } finally { await f.cleanup(); }
  });

  test('forward paging reaches live start and stops there', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'forward', lifecycleKey: 'wave4-forward' });
      await seed(f.store, sid, 1000);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      const seen: HistoryRow[] = [];
      let anchor: number | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const { page, verification } = reader.page(sid, 'after', anchor, 137, ctx);
        if (verification.status === 'empty') break;
        expect(verification.status).toBe('verified');
        seen.push(...page.rows);
        if (!page.hasMore) break;
        anchor = page.endLine - 1;
      }
      expect(seen).toHaveLength(ctx.liveStart - ctx.firstLine);
      expect(seen.at(-1)!.line_no).toBe(ctx.liveStart - 1);
    } finally { await f.cleanup(); }
  });

  test('a page pinned to a stale revision is refused, not silently re-anchored', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'race', lifecycleKey: 'wave4-race' });
      await seed(f.store, sid, 300);
      const reader = new HistoryReaderCanary(f.store);
      const stale = reader.snapshot(sid).receipt.context;
      await seed(f.store, sid, 300);
      const fresh = reader.snapshot(sid).receipt.context;
      expect(fresh.revision).toBeGreaterThan(stale.revision);
      // The old pin still answers its own coordinates ...
      const pinned = reader.page(sid, 'before', null, 100, stale);
      expect(pinned.verification.status).toBe('verified');
      expect(pinned.page.context.revision).toBe(stale.revision);
      // The pin's own boundary, not the writer's newer one.
      validateHistoryPage(stale, pinned.page);
      expect(pinned.page.endLine).toBeLessThanOrEqual(stale.liveStart);
      // ... and a forged context is refused outright.
      const forged: HistoryContext = { ...stale, revision: fresh.revision + 5 };
      expect(() => reader.page(sid, 'before', null, 100, forged)).toThrow(/context-mismatch/);
    } finally { await f.cleanup(); }
  });

  test('the REST surface answers with a status, never 200-with-empty on failure', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'rest', lifecycleKey: 'wave4-rest' });
      await seed(f.store, sid, 300);
      const reader = new HistoryReaderCanary(f.store);
      const call = (path: string) => historyReaderRequest(reader, new Request('http://127.0.0.1' + path));
      const snapshot = await call(`/history/snapshot?session=${sid}`);
      expect(snapshot.status).toBe(200);
      const ctx = (await snapshot.json() as { receipt: { context: HistoryContext } }).receipt.context;
      const ok = await call(`/history/page?session=${sid}&direction=before&limit=100&context=${encodeURIComponent(JSON.stringify(ctx))}`);
      expect(ok.status).toBe(200);
      expect((await ok.json() as { verification: { status: string } }).verification.status).toBe('verified');
      const forged = encodeURIComponent(JSON.stringify({ ...ctx, revision: ctx.revision + 9 }));
      const conflict = await call(`/history/page?session=${sid}&direction=before&limit=100&context=${forged}`);
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as { error: string }).error).toMatch(/context-mismatch/);
      const missing = await call('/history/page?session=nope&direction=before&limit=100');
      expect(missing.status).toBe(503);
      expect((await missing.json() as { error: string }).error).toMatch(/unknown-session/);
      const bad = await call(`/history/page?session=${sid}&direction=sideways&limit=100`);
      expect(bad.status).toBe(400);
    } finally { await f.cleanup(); }
  });

  test('rows that disagree with the covering receipt are rejected byte for byte', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'bytes', lifecycleKey: 'wave4-bytes' });
      await seed(f.store, sid, 300);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      const honest = reader.page(sid, 'before', null, 100, ctx);
      expect(honest.verification.status).toBe('verified');
      const rows = honest.page.rows;
      const start = honest.page.startLine, end = honest.page.endLine;
      // Same count, same line numbers, one byte different: a length-only check
      // would wave this through.
      const swapped = rows.map((r, i) => i === 7 ? { ...r, text: r.text.replace(/.$/, 'X') } : r);
      expect(swapped[7]!.text.length).toBe(rows[7]!.text.length);
      expect(() => verifier(reader).verify(sid, ctx.revision, swapped, start, end)).toThrow(/reader-range-digest/);
      // A dropped row must not be papered over either.
      expect(() => verifier(reader).verify(sid, ctx.revision, rows.slice(1), start, end)).toThrow(/reader-range-digest/);
      // And a kind flipped to `gap` is a different row, not a presentation detail.
      const flipped = rows.map((r, i) => i === 3 ? { ...r, kind: 'gap' as const } : r);
      expect(() => verifier(reader).verify(sid, ctx.revision, flipped, start, end)).toThrow(/reader-range-digest/);
      expect(f.alarms.filter(a => a.detector === 'reader-range-digest')).toHaveLength(3);
    } finally { await f.cleanup(); }
  });

  test('a range running past the newest receipt says so instead of claiming coverage', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'above', lifecycleKey: 'wave4-above' });
      await seed(f.store, sid, 200);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      const beyond = verifier(reader).verify(sid, ctx.revision, [], ctx.nextLine - 10, ctx.nextLine + 50);
      expect(beyond.status).toBe('unverifiable');
      expect(beyond.reason).toBe('range-above-verified-receipt');
    } finally { await f.cleanup(); }
  });

  test('the shipping server still does not import the SQLite history package', () => {
    const src = join(import.meta.dir, '../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'sqlite-history') walk(path); continue; }
        if (!entry.name.endsWith('.ts') || path.endsWith('/sqlite-history.ts')) continue;
        if (/from\s*['"][^'"]*sqlite-history/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
