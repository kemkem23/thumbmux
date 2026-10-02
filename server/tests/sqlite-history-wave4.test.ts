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
import { rowsDigest, encodeBlock, decodeBlock, encodeCaptureArchive, decodeCaptureArchive, LEGACY_INFLATE_MAX_BYTES } from '../src/sqlite-history/codec';
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

  test('the canary path never plans a full table scan or a temporary sort', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'plan', lifecycleKey: 'wave4-plan' });
      await seed(f.store, sid, 20_000, 500);
      const reader = new HistoryReaderCanary(f.store);
      const ctx = reader.snapshot(sid).receipt.context;
      f.db.exec('ANALYZE');
      const statements: Array<[string, string, unknown[]]> = [
        ['page-before', 'SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no DESC LIMIT ?', [sid, 0, 12_000, 2000]],
        ['page-after', 'SELECT line_no,kind,text FROM history_line WHERE session_id=? AND line_no>=? AND line_no<? ORDER BY line_no', [sid, 8000, 10_000]],
        ['coverAt', 'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq<=? AND row_start<=? ORDER BY seq DESC LIMIT 1', [sid, ctx.revision, 8000]],
        ['coverFrom', 'SELECT seq,row_start,row_end,expected_rows,rows_sha256 FROM history_capture WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq', [sid, 16, ctx.revision]],
      ];
      for (const [name, sql, args] of statements) {
        const plan = (f.db.query('EXPLAIN QUERY PLAN ' + sql).all(...args as never[]) as { detail: string }[]).map(p => p.detail);
        expect(plan.filter(d => /^SEARCH .+ USING PRIMARY KEY/.test(d)).length,
          `${name}: ${JSON.stringify(plan)}`).toBeGreaterThan(0);
        expect(plan.filter(d => /\bSCAN\b/.test(d)), name).toEqual([]);
        expect(plan.filter(d => /TEMP B-TREE|USE TEMP/.test(d)), name).toEqual([]);
      }
    } finally { await f.cleanup(); }
  });

  test('only explicit history entry points import the SQLite history package', () => {
    const src = join(import.meta.dir, '../src');
    // v0.20.3 intentionally ships I4's pipe-history-runtime adapter. Keep the
    // existing opt-in sqlite-history entry, but do not exempt callers of either
    // entry or arbitrary files with the same basename in a nested directory.
    // Internal sqlite-history modules remain free to import their dependencies.
    const entries = new Set([join(src, 'sqlite-history.ts'), join(src, 'pipe-history-runtime.ts')]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (path !== join(src, 'sqlite-history')) walk(path); continue; }
        if (!entry.name.endsWith('.ts') || entries.has(path)) continue;
        if (/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"][^'"]*sqlite-history/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

// Stream-first K v1: separate opt-in database; never mounts a production route.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { StreamHistoryEngine, streamDigest } from '../src/history-engine';
import type { AppendFinalized, InputEvent, Result, VtCheckpoint } from '../src/stream-contract';
const shPane = { serverIdentity: 'stream-fixture', paneId: '%1', birthGeneration: 1 };
const shIdentity = { pane: shPane, sourceEpoch: 1, geometryGeneration: 1 };
function shOk<T>(result: Result<T>): T {
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}
function shInput(seq = 1): InputEvent {
  const data = { identity: shIdentity, position: { sourceEpoch: 1, packetSeq: seq }, receivedAtMonoMs: 0,
    payload: { kind: 'bytes' as const, bytes: [65, 10] } };
  return { ...data, digest: streamDigest('input', data) };
}
function shAppend(seq = 1, text = 'ก'): AppendFinalized {
  const eventId = { pane: shPane, sourceEpoch: 1, packetSeq: seq, scrollOrdinal: 0 };
  const geometry = { columns: 80, rows: 24 };
  const row = { id: { pane: shPane, lineId: seq - 1 }, source: eventId, revision: seq,
    geometryGeneration: 1, geometry, cells: [{ text, width: 1 as const, style: [] }],
    softWrap: false, wrapPad: 0, uncertainFields: [] };
  const data = { identity: shIdentity, eventId, expectedRevision: seq - 1, rows: [row], receivedAtMonoMs: 0,
    frameDelta: { identity: shIdentity, screenRevision: seq, buffer: 'normal' as const, geometry,
      changedRows: [], cursor: { x: 0, y: 0, visible: true }, overlap: null } };
  return { ...data, digest: streamDigest('append', data) };
}
async function shCheckpoint(engine: StreamHistoryEngine, seq = 1, previous: string | null = null) {
  const inputFence = shOk(await engine.journalInput(shInput(seq)));
  const cursor = { x: 0, y: 0, visible: true };
  const buffer = { rows: [], cursor, savedCursor: cursor, savedAttributes: [], savedModes: {}, wrapPending: false };
  const state = { codecVersion: 'fixture-v1', geometry: { columns: 80, rows: 24 }, normal: buffer,
    alternate: buffer, active: 'normal' as const, modes: {}, margins: { top: 0, bottom: 23, left: 0, right: 79 },
    tabStops: [], pendingUtf8: [224], pendingEscape: [27], attributes: [], wrapPending: false, extensionState: '{}' };
  const checkpoint: VtCheckpoint = { kind: 'vt-recovery', checkpointId: `cp-${seq}`, previousCheckpointId: previous,
    identity: shIdentity, inputFence, revision: seq, head: seq, state,
    stateDigest: streamDigest('vt-state', { identity: shIdentity, state }) };
  const data = { checkpoint, expectedRevision: seq, commitId: `commit-${seq}` };
  return engine.commitCheckpoint({ ...data, digest: streamDigest('checkpoint', data) });
}
function shFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'stream-h-'));
  const path = join(dir, 'stream.sqlite');
  let engine = new StreamHistoryEngine({ path, codecVersions: ['fixture-v1'] });
  return { get engine() { return engine; }, path,
    reopen() { engine.close(); engine = new StreamHistoryEngine({ path, codecVersions: ['fixture-v1'] }); },
    cleanup() { engine.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const shCancel = { isCancelled: () => false };
async function shView(engine: StreamHistoryEngine, end = 1, requestId = 'view') {
  return shOk(await engine.grantReadView({ requestId, identity: shIdentity, routeGeneration: 1,
    range: { start: 0, end }, deadlineMonoMs: performance.now() + 1000 }));
}
describe('stream-first H frozen contract', () => {
  test('durable ACK survives reopen; input and append retries remain exact and unique', async () => {
    const f = shFixture();
    try {
      const input = shOk(await f.engine.journalInput(shInput()));
      const ram = shOk(await f.engine.appendFinalized(shAppend()));
      const durable = shOk(await shCheckpoint(f.engine));
      expect(f.engine.stats().pendingBytes).toBe(0);
      f.reopen();
      expect(shOk(await f.engine.journalInput(shInput()))).toEqual(input);
      expect(shOk(await f.engine.appendFinalized(shAppend()))).toEqual(ram);
      expect(shOk(await shCheckpoint(f.engine))).toEqual(durable);
      const view = await shView(f.engine);
      const ack = shOk(await f.engine.openReadView(view));
      const page = shOk(await f.engine.readPage(ack, null, 500, shCancel));
      expect(page.fragments.map(x => x.row.cells.map(c => c.text).join(''))).toEqual(['ก']);
      await f.engine.releaseReadView(view, 'read-complete');
      const recovered = [];
      for await (const item of f.engine.recover(shPane, null, shCancel)) recovered.push(shOk(item));
      expect(recovered[0]?.kind).toBe('checkpoint');
      if (recovered[0]?.kind === 'checkpoint') expect(recovered[0].checkpoint.state.pendingUtf8).toEqual([224]);
      expect(f.engine.stats().diskCacheConfigBytes).toBeLessThanOrEqual(12582912);
    } finally { f.cleanup(); }
  });
  test('same key with changed content is integrity failure without changing head', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      expect((await f.engine.appendFinalized(shAppend(1, 'wrong'))).status).toBe('error');
      expect((await shView(f.engine)).headAtGrant).toBe(1);
    } finally { f.cleanup(); }
  });
  test('grant freezes RAM overlay across later durable commits; forged ACK rejected', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      const view = await shView(f.engine);
      const ack = shOk(await f.engine.openReadView(view));
      shOk(await shCheckpoint(f.engine));
      shOk(await f.engine.journalInput(shInput(2)));
      shOk(await f.engine.appendFinalized(shAppend(2, 'new')));
      shOk(await shCheckpoint(f.engine, 2, 'cp-1'));
      const page = shOk(await f.engine.readPage(ack, null, 500, shCancel));
      expect(page.fragments).toHaveLength(1);
      expect(page.view.headAtGrant).toBe(1);
      expect((await f.engine.readPage({ ...ack, diskSnapshotRevision: 999 }, null, 500, shCancel)).status).toBe('stale');
    } finally { f.cleanup(); }
  });
  test('cancel releases pins immediately and busy never masquerades as EOF', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      const view = await shView(f.engine);
      expect((await f.engine.grantReadView({ ...view, requestId: 'second' })).status).toBe('busy');
      const ack = shOk(await f.engine.openReadView(view));
      expect((await f.engine.readPage(ack, null, 500, { isCancelled: () => true })).status).toBe('cancelled');
      expect(f.engine.stats().pins).toBe(0);
    } finally { f.cleanup(); }
  });
});

describe('stream-first H quantitative gates', () => {
  test('journal writes cannot persist a RAM-only row head across reopen', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      shOk(await f.engine.journalInput(shInput(2)));
      f.reopen();
      const view = await shView(f.engine, 0);
      expect(view.headAtGrant).toBe(0);
      await f.engine.releaseReadView(view, 'done');
      const inputs = [];
      for await (const result of f.engine.recover(shPane, null, shCancel)) inputs.push(shOk(result));
      expect(inputs.map(x => x.kind)).toEqual(['input', 'input']);
    } finally { f.cleanup(); }
  });
  test('256-row chunks and 1 MiB pages continue forward and backward without duplicates', async () => {
    const f = shFixture();
    try {
      for (let seq = 1; seq <= 3; seq++) {
        shOk(await f.engine.journalInput(shInput(seq)));
        shOk(await f.engine.appendFinalized(shAppend(seq, 'x'.repeat(120000))));
      }
      const view = await shView(f.engine, 3);
      const ack = shOk(await f.engine.openReadView(view));
      const first = shOk(await f.engine.readPage(ack, null, 2, shCancel));
      expect(first.fragments).toHaveLength(2);
      expect(first.payloadBytes).toBeLessThanOrEqual(1048576);
      const next = shOk(await f.engine.readPage(ack, first.nextAfter, 2, shCancel));
      expect(next.fragments.map(f => f.row.id.lineId)).toEqual([2]);
      const back = shOk(await f.engine.readPage(ack, next.nextBefore, 2, shCancel));
      expect(back.fragments.map(f => f.row.id.lineId)).toEqual([0, 1]);
      expect(first.hasMoreAfter).toBe(true);
      expect(next.hasMoreAfter).toBe(false);
    } finally { f.cleanup(); }
  });
  test('global pending refuses before mutation at 16 MiB, retries succeed after checkpoint', async () => {
    const f = shFixture();
    try {
      let refused = 0;
      for (let seq = 1; seq <= 100; seq++) {
        shOk(await f.engine.journalInput(shInput(seq)));
        const result = await f.engine.appendFinalized(shAppend(seq, 'x'.repeat(100000)));
        expect(f.engine.stats().pendingBytes).toBeLessThanOrEqual(16777216);
        if (result.status === 'busy') { refused = seq; break; }
        shOk(result);
      }
      expect(refused).toBeGreaterThan(1);
      shOk(await shCheckpoint(f.engine, refused - 1));
      shOk(await f.engine.appendFinalized(shAppend(refused, 'x'.repeat(100000))));
      expect(f.engine.stats().pendingBytes).toBeLessThanOrEqual(16777216);
    } finally { f.cleanup(); }
  });
  test('global active readers never exceeds 2 and each pane has at most one', async () => {
    const f = shFixture();
    try {
      const inputs = [1, 2, 3].map(n => {
        const { digest: _, ...base } = shInput();
        const data = { ...base, identity: { ...shIdentity, pane: { ...shPane, paneId: `%${n}` } } };
        return { ...data, digest: streamDigest('input', data) };
      });
      for (const input of inputs) shOk(await f.engine.journalInput(input));
      const grants = [];
      for (const [n, input] of inputs.entries()) grants.push(await f.engine.grantReadView({ requestId: `g${n}`, identity: input.identity,
        routeGeneration: 1, range: { start: 0, end: 0 }, deadlineMonoMs: performance.now() + 1000 }));
      expect(grants.map(g => g.status)).toEqual(['ok', 'ok', 'busy']);
      expect(f.engine.stats().activeReads).toBe(2);
      expect(f.engine.stats().diskCacheConfigBytes).toBeLessThanOrEqual(12582912);
      for (const grant of grants) if (grant.status === 'ok') await f.engine.releaseReadView(grant.value, 'done');
      expect(f.engine.stats().pins).toBe(0);
    } finally { f.cleanup(); }
  });
  test('forgotten view and paused cancelled recovery release pins within 1000ms', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      shOk(await shCheckpoint(f.engine));
      shOk(await f.engine.grantReadView({ requestId: 'expires', identity: shIdentity, routeGeneration: 1,
        range: { start: 0, end: 1 }, deadlineMonoMs: performance.now() + 50 }));
      await Bun.sleep(100);
      expect(f.engine.stats().pins).toBe(0);
      let cancelled = false;
      const recovery = f.engine.recover(shPane, null, { isCancelled: () => cancelled })[Symbol.asyncIterator]();
      await recovery.next();
      expect(f.engine.stats().pins).toBe(1);
      cancelled = true;
      await Bun.sleep(100);
      expect(f.engine.stats().pins).toBe(0);
      await recovery.return?.();
    } finally { f.cleanup(); }
  });
  test('gap commits each prefix; later chunk failure cannot erase it; late gap blocks suffix IDs', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend()));
      shOk(await shCheckpoint(f.engine));
      const episode = { episodeId: 'gap', pane: shPane, epochBefore: 1, epochAfter: 1, lastDurableInput: shInput().position,
        lastAdmittedRow: 0, firstObservedAtMonoMs: 0, reason: 'eof' as const, status: 'repairing' as const, missingCount: null };
      shOk(f.engine.beginGap(episode));
      shOk(await f.engine.journalInput(shInput(2)));
      expect((await f.engine.appendFinalized(shAppend(2))).status).toBe('stale');
      const data = { episode, chunkId: 'chunk-1', expectedRevision: 1, rows: shAppend(2).rows, final: false };
      const chunk = { ...data, digest: streamDigest('repair', data) };
      const committed = shOk(await f.engine.commitRepair(chunk));
      const bad = { ...data, chunkId: 'chunk-2', expectedRevision: 2, rows: shAppend(3).rows, digest: '0'.repeat(64) };
      expect((await f.engine.commitRepair(bad)).status).toBe('error');
      f.reopen();
      expect(shOk(await f.engine.commitRepair(chunk))).toEqual(committed);
      const view = await shView(f.engine, 2);
      const page = shOk(await f.engine.readPage(shOk(await f.engine.openReadView(view)), null, 500, shCancel));
      expect(page.fragments.map(x => x.row.id.lineId)).toEqual([0, 1]);
      expect(f.engine.beginGap({ ...episode, episodeId: 'late', reason: 'late-gap' }).status).toBe('stale');
      expect((await f.engine.appendFinalized(shAppend(3))).status).toBe('stale');
    } finally { f.cleanup(); }
  });
});

describe('stream-first H crash and continuation', () => {
  test('large physical row crosses disk blocks and page bytes with a real cell cursor', async () => {
    const f = shFixture();
    try {
      shOk(await f.engine.journalInput(shInput()));
      shOk(await f.engine.appendFinalized(shAppend(1, 'prefix'.repeat(16000))));
      shOk(await f.engine.journalInput(shInput(2)));
      const { digest: _, ...base } = shAppend(2);
      const data = { ...base, rows: [{ ...base.rows[0]!, cells: Array.from({ length: 8 }, (_, n) => ({ text: String(n).repeat(120000), width: 1 as const, style: [] })) }] };
      shOk(await f.engine.appendFinalized({ ...data, digest: streamDigest('append', data) }));
      shOk(await shCheckpoint(f.engine, 2));
      f.reopen();
      const view = await shView(f.engine, 2);
      const ack = shOk(await f.engine.openReadView(view));
      const first = shOk(await f.engine.readPage(ack, null, 500, shCancel));
      expect(first.nextAfter?.cellOffset).toBeGreaterThan(0);
      expect(first.fragments.at(-1)?.complete).toBe(false);
      const second = shOk(await f.engine.readPage(ack, first.nextAfter, 500, shCancel));
      expect(second.hasMoreAfter).toBe(false);
      const cells = [...first.fragments.filter(x => x.row.id.lineId === 1), ...second.fragments]
        .flatMap(x => x.row.cells.map(c => c.text));
      expect(cells).toEqual(data.rows[0]!.cells.map(c => c.text));
      for (const page of [first, second]) {
        expect(page.payloadBytes).toBeLessThanOrEqual(1048576);
        expect(page.fragments.length).toBeLessThanOrEqual(256);
      }
      const raw = new Database(f.path, { readonly: true });
      try { expect((raw.query('SELECT max(length(CAST(payload AS BLOB))) AS n FROM sh_fragment').get() as { n: number }).n).toBeLessThanOrEqual(262144); }
      finally { raw.close(); }
    } finally { f.cleanup(); }
  });
  test('process SIGKILL around input and checkpoint transactions preserves every durable acknowledgement', async () => {
    for (const phase of ['input-before-write', 'input-before-commit', 'input-after-commit',
      'checkpoint-before-write', 'checkpoint-before-commit', 'checkpoint-after-commit']) {
      const dir = mkdtempSync(join(tmpdir(), 'stream-kill-'));
      const path = join(dir, 'stream.sqlite');
      const source = join(import.meta.dir, '../src/history-engine.ts');
      const script = `import { StreamHistoryEngine, streamDigest } from ${JSON.stringify(source)};
        const shPane=${JSON.stringify(shPane)}, shIdentity=${JSON.stringify(shIdentity)};
        const shOk=${shOk.toString()}, shInput=${shInput.toString()}, shAppend=${shAppend.toString()}, shCheckpoint=${shCheckpoint.toString()};
        const engine = new StreamHistoryEngine({path:${JSON.stringify(path)},codecVersions:['fixture-v1'],
          boundary(at) { if(at===${JSON.stringify(phase)}) process.kill(process.pid,'SIGKILL'); }});
        shOk(await engine.journalInput(shInput()));
        console.log('INPUT_ACK');
        shOk(await engine.appendFinalized(shAppend()));
        shOk(await shCheckpoint(engine));
        console.log('CHECKPOINT_ACK');`;
      try {
        const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
        const [exit, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit).not.toBe(0);
        expect(child.signalCode).toBe('SIGKILL');
        expect(stderr).not.toMatch(/SyntaxError|ReferenceError|Cannot find/);
        const engine = new StreamHistoryEngine({ path, codecVersions: ['fixture-v1'] });
        try {
          const recovered = [];
          for await (const result of engine.recover(shPane, null, shCancel)) recovered.push(result);
          const raw = new Database(path, { readonly: true });
          try {
            const inputs = (raw.query('SELECT count(*) AS n FROM sh_input').get() as { n: number }).n;
            const rows = (raw.query('SELECT count(*) AS n FROM sh_row').get() as { n: number }).n;
            expect(inputs).toBe(phase.startsWith('input-before') ? 0 : 1);
            expect(rows).toBe(phase === 'checkpoint-after-commit' ? 1 : 0);
            if (output.includes('INPUT_ACK')) expect(inputs).toBe(1);
          } finally { raw.close(); }
          shOk(await engine.journalInput(shInput()));
          const retry = shOk(await engine.appendFinalized(shAppend()));
          expect(retry.head).toBe(1);
          shOk(await shCheckpoint(engine));
          const rawAfter = new Database(path, { readonly: true });
          try { expect((rawAfter.query('SELECT count(*) AS n FROM sh_row').get() as { n: number }).n).toBe(1); }
          finally { rawAfter.close(); }
        } finally { engine.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 30000);
});


describe('stream-first H legacy decode admission', () => {
  test('legacy blocks and archives fail loudly on inflate pressure, never return false EOF', () => {
    const rows = [['x'.repeat(LEGACY_INFLATE_MAX_BYTES + 1)]];
    expect(() => decodeBlock(encodeBlock(rows))).toThrow();
    expect(() => decodeCaptureArchive(encodeCaptureArchive(rows))).toThrow('scratch-pressure');
    expect(decodeBlock(encodeBlock([['old', 1], ['old', 2]]))).toEqual([['old', 1], ['old', 2]]);
  });
});

test('stream-first H repair SIGKILL keeps committed prefix exactly once at every transaction boundary', async () => {
  for (const phase of ['repair-before-write', 'repair-before-commit', 'repair-after-commit']) {
    const dir = mkdtempSync(join(tmpdir(), 'stream-repair-kill-')), path = join(dir, 'stream.sqlite');
    const episode = { episodeId: 'gap', pane: shPane, epochBefore: 1, epochAfter: 1, lastDurableInput: shInput().position,
      lastAdmittedRow: 0, firstObservedAtMonoMs: 0, reason: 'eof' as const, status: 'repairing' as const, missingCount: null };
    const data = { episode, chunkId: 'repair-1', expectedRevision: 1, rows: shAppend(2).rows, final: false };
    const chunk = { ...data, digest: streamDigest('repair', data) };
    const script = `import { StreamHistoryEngine, streamDigest } from ${JSON.stringify(join(import.meta.dir, '../src/history-engine.ts'))};
      const shPane=${JSON.stringify(shPane)}, shIdentity=${JSON.stringify(shIdentity)};
      const shOk=${shOk.toString()}, shInput=${shInput.toString()}, shAppend=${shAppend.toString()}, shCheckpoint=${shCheckpoint.toString()};
      const engine = new StreamHistoryEngine({path:${JSON.stringify(path)},codecVersions:['fixture-v1'],
        boundary(at) { if(at===${JSON.stringify(phase)}) process.kill(process.pid,'SIGKILL'); }});
      shOk(await engine.journalInput(shInput())); shOk(await engine.appendFinalized(shAppend()));
      shOk(await shCheckpoint(engine)); console.log('CHECKPOINT_ACK');
      shOk(await engine.journalInput(shInput(2))); shOk(engine.beginGap(${JSON.stringify(episode)}));
      shOk(await engine.commitRepair(${JSON.stringify(chunk)}));`;
    try {
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).not.toBe(0); expect(child.signalCode).toBe('SIGKILL');
      expect(stdout).toContain('CHECKPOINT_ACK'); expect(stderr).not.toMatch(/SyntaxError|ReferenceError|Cannot find/);
      const engine = new StreamHistoryEngine({ path, codecVersions: ['fixture-v1'] });
      try {
        const raw = new Database(path, { readonly: true });
        try { expect((raw.query('SELECT count(*) AS n FROM sh_row').get() as { n: number }).n).toBe(phase === 'repair-after-commit' ? 2 : 1); }
        finally { raw.close(); }
        const first = shOk(await engine.commitRepair(chunk));
        expect(shOk(await engine.commitRepair(chunk))).toEqual(first);
        const view = await shView(engine, 2);
        const page = shOk(await engine.readPage(shOk(await engine.openReadView(view)), null, 500, shCancel));
        expect(page.fragments.map(f => f.row.id.lineId)).toEqual([0, 1]);
      } finally { engine.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}, 30000);

test('stream-first H admits at most 256 decoded rows and rejects alternate scroll before mutation', async () => {
  const f = shFixture();
  try {
    shOk(await f.engine.journalInput(shInput()));
    const { digest: _, ...base } = shAppend();
    const rows = Array.from({ length: 257 }, (_, n) => ({ ...base.rows[0]!, id: { pane: shPane, lineId: n } }));
    const oversize = { ...base, rows };
    expect((await f.engine.appendFinalized({ ...oversize, digest: streamDigest('append', oversize) })).status).toBe('error');
    const alt = { ...base, frameDelta: { ...base.frameDelta, buffer: 'alternate' as const } };
    expect((await f.engine.appendFinalized({ ...alt, digest: streamDigest('append', alt) })).status).toBe('error');
    const admitted = { ...base, rows: rows.slice(0, 256) };
    expect(shOk(await f.engine.appendFinalized({ ...admitted, digest: streamDigest('append', admitted) })).head).toBe(256);
    const view = await shView(f.engine, 256);
    const page = shOk(await f.engine.readPage(shOk(await f.engine.openReadView(view)), null, 2000, shCancel));
    expect(page.fragments).toHaveLength(256);
    expect(page.fragments.map(f => f.row.id.lineId)).toEqual(Array.from({ length: 256 }, (_, n) => n));
  } finally { f.cleanup(); }
});

test('stream-first H owns input copies and exposes frozen nested cells', async () => {
  const f = shFixture();
  try {
    shOk(await f.engine.journalInput(shInput()));
    const request = structuredClone(shAppend());
    shOk(await f.engine.appendFinalized(request));
    (request.rows[0]!.cells[0]! as { text: string }).text = 'caller mutation';
    const view = await shView(f.engine);
    const ack = shOk(await f.engine.openReadView(view));
    const page = shOk(await f.engine.readPage(ack, null, 500, shCancel));
    expect(page.fragments[0]!.row.cells[0]!.text).toBe('ก');
    expect(Object.isFrozen(page.fragments[0]!.row.cells[0])).toBe(true);
  } finally { f.cleanup(); }
});


test('stream-first H canonical digest matches independent UTF-8 SHA-256 fixture', () => {
  expect(shInput().digest).toBe('3620115c0091b2fc9bd3c875d8070092ed69affd6cee4529ffcc80942efef1aa');
  const { digest: _, ...input } = shInput();
  expect(streamDigest('input', { payload: input.payload, receivedAtMonoMs: input.receivedAtMonoMs,
    position: input.position, identity: input.identity })).toBe(shInput().digest);
});

// Repair regressions use the real SQLite transaction, including reopen.
test('contract gap fences pending rows and persists them before repair', async () => {
  const f = shFixture();
  try {
    shOk(await f.engine.journalInput(shInput()));
    shOk(await f.engine.appendFinalized(shAppend()));
    const gap = { episodeId: 'pending-gap', pane: shPane, epochBefore: 1, epochAfter: null,
      lastDurableInput: shInput().position, lastAdmittedRow: 0, firstObservedAtMonoMs: 0,
      reason: 'eof' as const, status: 'suspected' as const, missingCount: null };
    expect(f.engine.beginGap(gap).status).toBe('ok');
    shOk(await f.engine.journalInput(shInput(2)));
    expect(await f.engine.appendFinalized(shAppend(2))).toMatchObject({ status: 'stale', reason: 'late-gap' });
    f.reopen();
    expect(await f.engine.appendFinalized(shAppend(2))).toMatchObject({ status: 'stale', reason: 'late-gap' });
  } finally { f.cleanup(); }
});

test('contract abandoned recovery cancels its own timer without iterator return', async () => {
  const f = shFixture(); let cancelled = false;
  try {
    shOk(await f.engine.journalInput(shInput())); shOk(await f.engine.appendFinalized(shAppend()));
    shOk(await shCheckpoint(f.engine));
    const recovery = f.engine.recover(shPane, null, { isCancelled: () => cancelled })[Symbol.asyncIterator]();
    await recovery.next(); cancelled = true;
    await Bun.sleep(120);
    expect(f.engine.stats().recoveryTimers).toBe(0);
    expect(f.engine.stats().pins).toBe(0);
  } finally { f.cleanup(); }
});
