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
import type { AppendFinalized, InputEvent, Result, VtCheckpoint, RecoveryChunk } from '../src/stream-contract';
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
    const rows = Array.from({ length: 257 }, (_, n) => ({ ...base.rows[0]!, id: { pane: shPane, lineId: n }, source:{...base.eventId,scrollOrdinal:n} }));
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

test('contract final repair rows stay fenced until repaired checkpoint commits atomically', async () => {
  const f = shFixture();
  try {
    shOk(await f.engine.journalInput(shInput())); shOk(await f.engine.appendFinalized(shAppend()));
    shOk(await shCheckpoint(f.engine));
    const recovery = f.engine.recover(shPane,null,shCancel)[Symbol.asyncIterator]();
    const first = shOk<RecoveryChunk>((await recovery.next()).value!);
    if(first.kind !== 'checkpoint') throw Error('checkpoint expected');
    await recovery.return?.();
    const gap = {episodeId:'atomic-close',pane:shPane,epochBefore:1,epochAfter:null,
      lastDurableInput:shInput().position,lastAdmittedRow:0,firstObservedAtMonoMs:0,
      reason:'eof' as const,status:'suspected' as const,missingCount:null};
    shOk(f.engine.beginGap(gap));
    const inputFence = shOk(await f.engine.journalInput(shInput(2)));
    const body={episode:gap,chunkId:'final',expectedRevision:1,rows:shAppend(2).rows,final:true};
    const receipt=shOk(await f.engine.commitRepair({...body,digest:streamDigest('repair',body)}));
    expect(receipt.complete).toBe(false);
    expect(f.engine.beginGap(gap).status).toBe('ok');
    f.reopen();
    expect(await f.engine.appendFinalized(shAppend(2))).toMatchObject({status:'stale',reason:'late-gap'});
    const checkpoint={...first.checkpoint,checkpointId:'repaired',previousCheckpointId:first.checkpoint.checkpointId,
      revision:2,head:2,inputFence};
    const commit={checkpoint,expectedRevision:2,commitId:'repaired',closeGap:gap.episodeId};
    const durable=shOk(await f.engine.commitCheckpoint({...commit,digest:streamDigest('checkpoint',commit)}));
    expect(durable.checkpointId).toBe('repaired');
    f.reopen();
    const restored=f.engine.recover(shPane,null,shCancel)[Symbol.asyncIterator]();
    expect(shOk<RecoveryChunk>((await restored.next()).value!)).toEqual({kind:'checkpoint',checkpoint});
    await restored.return?.();
    shOk(await f.engine.journalInput(shInput(3)));
    expect((await f.engine.appendFinalized(shAppend(3))).status).toBe('ok');
  } finally { f.cleanup(); }
});

// Lot H: the flag-on store is exercised only with disposable synthetic roots.
import { existsSync, symlinkSync, statSync } from 'node:fs';
import { FlagOnHistoryStore, type FlagOnHistoryOptions } from '../src/history-engine';
import type { SpoolRecord, SpoolAck, PaneKey, RowsAndGapsCommit, CommittedStreamRow, Gap, SealedExport, RemoteIndexReceipt } from '../src/stream-contract';

const hp: PaneKey = {serverIdentity:'synthetic-H',paneId:'%0',birthGeneration:1};
function hvalue<T>(r: Result<T>): T { if (r.status !== 'ok') throw Error(JSON.stringify(r)); return r.value; }
function hrecord(op = 'raw-0', previous: SpoolRecord | null = null, text = 'same\nsame\n'): SpoolRecord {
  const start = previous?.range.end ?? 0;
  const value = {version:1 as const,operationId:op,range:{epoch:previous?.range.epoch ?? {pane:hp,attachId:'attach-H',collectorIncarnation:'collector-H'},start,end:start+Buffer.byteLength(text)},sequence:previous ? previous.sequence+1 : 0,previousDigest:previous?.digest ?? null,payload:{kind:'bytes' as const,bytes:[...Buffer.from(text)]}};
  return {...value,digest:streamDigest('spool',value)};
}
function hrows(ack: SpoolAck, op = 'rows-0', start = 0, texts = ['same','same']): RowsAndGapsCommit {
  const rows: CommittedStreamRow[] = texts.map((text,i) => ({id:{pane:hp,segmentId:ack.segmentId,rowOrdinal:start+i},origin:{kind:'pipe',range:{epoch:ack.through.epoch,start:0,end:ack.through.byteOffset},ordinal:i},cells:[{text,width:1,style:[]}],geometry:{columns:80,rows:24},buffer:'normal',wrapStatus:'unwrapped',wrapPad:0,finalized:true,uncertainFields:[],cellOrigins:[]}));
  const gap: Gap = {version:1,episodeId:op+'-gap',parentEpisodeId:null,pane:hp,leftRowId:null,rightSegmentId:ack.segmentId,reason:'pipe-eof',countKind:'unknown',missingCount:null,withheldRows:3,lowerBound:0,openedAt:1,closedAt:null,clockEpoch:'test',quality:'degraded'};
  const value = {operationId:op,pane:hp,expectedGeneration:0,rows,coverage:[{kind:'gap' as const,gap,digest:streamDigest('gap',gap)},...(rows.length ? [{kind:'rows' as const,range:{pane:hp,segmentId:ack.segmentId,start,end:start+rows.length},digest:streamDigest('rows',rows)}] : [])],decision:{decisionId:op,acceptedRowMap:rows.map(row=>({source:row.origin,target:row.id})),withheldRanges:[],gaps:[gap]},inputAck:ack,checkpointId:null};
  return {...value,digest:streamDigest('rows-gaps',value)};
}
function hfixture(options: Partial<FlagOnHistoryOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(),'flagon-H-'));
  let store = new FlagOnHistoryStore({root,mode:'create',codecVersions:['test-v1'],...options}); store.setGeneration(hp,null,0);
  return {root,get store(){return store;},reopen(){store.close();store=new FlagOnHistoryStore({root,mode:'recover',codecVersions:['test-v1'],...options});return store;},cleanup(){store.close();rmSync(root,{recursive:true,force:true});}};
}
async function hreplay(store: FlagOnHistoryStore, after: SpoolAck['through'] | null = null) {
  const result = []; for await (const chunk of store.recover(hp,after,{isCancelled:()=>false})) result.push(hvalue(chunk)); return result;
}
function hremote(sealed: SealedExport): RemoteIndexReceipt {
  const object = {objectKey:'synthetic/bundle',bytes:sealed.files[0]!.bytes,sha256:sealed.files[0]!.sha256};
  return {kind:'remote-index-committed',catalogVersion:3,commitId:'catalog-commit',generation:0,coverage:sealed.coverage,verified:{kind:'verified-remote',bundle:{version:1,bundleId:'bundle',storeUUID:sealed.storeUUID,pane:hp,segmentId:sealed.segmentId,coverage:sealed.coverage,schemaVersions:{history:1,spool:1},objects:[object],manifest:object,members:[...sealed.files,sealed.manifest],compression:'tar.zst',encryption:'none',checkpointIds:[],rawRanges:[]},verificationId:'verify',method:'download-sha256',verifiedAtMonoMs:2,clockEpoch:'test',inventoryDigest:'synthetic-inventory',evidence:[sealed.manifest],toolVersion:'synthetic',command:['synthetic-check'],stdout:sealed.manifest,stderr:sealed.manifest,exitCode:0}};
}

describe('flag-on H durable rows gaps and sealed reclaim', () => {
  test('ACK then reopen preserves every input, repeated row, gap and decision without duplicate retry', async () => {
    const f = hfixture();
    try {
      const input=hrecord(),ack=hvalue(await f.store.appendInput(input)),request=hrows(ack),receipt=hvalue(await f.store.commitRowsAndGaps(request));
      f.reopen(); expect(hvalue(await f.store.appendInput(input))).toEqual(ack); expect(hvalue(await f.store.commitRowsAndGaps(request))).toEqual(receipt);
      const chunks=await hreplay(f.store); expect(chunks.length).toBe(2);
      expect(chunks[0]).toEqual({kind:'input',record:input,ack});
      expect(chunks[1]).toEqual({kind:'committed',rows:request.rows,gaps:request.decision.gaps,receipt});
      expect((await hreplay(f.store,ack.through)).map(x=>x.kind)).toEqual(['committed']);
      expect(f.store.setGeneration.bind(f.store,hp,4,5)).toThrow();
      f.store.setGeneration(hp,0,1);
      expect((await f.store.commitRowsAndGaps(hrows(ack,'stale'))).status).toBe('error');
    } finally {f.cleanup();}
  });
  test('rollback at write/commit boundaries and lost ACK recover atomically', async () => {
    for (const kind of ['input','rows']) for (const phase of ['before-write','before-commit','after-commit']) {
      let armed=false; const f=hfixture({boundary(at){if(armed && at===kind+'-'+phase) throw Error('injected '+at);}});
      try {
        const input=hrecord(); let ack:SpoolAck;
        if(kind==='rows') ack=hvalue(await f.store.appendInput(input));
        armed=true;
        const result=kind==='input' ? await f.store.appendInput(input) : await f.store.commitRowsAndGaps(hrows(ack!));
        expect(result.status).toBe('error'); armed=false;f.reopen();
        expect((await hreplay(f.store)).length).toBe((kind==='rows'?1:0)+(phase==='after-commit'?1:0));
        ack=hvalue(await f.store.appendInput(input));hvalue(await f.store.commitRowsAndGaps(hrows(ack)));
        expect((await hreplay(f.store)).length).toBe(2);
      } finally {f.cleanup();}
    }
  });
  test('rejects forged ACK, discontinuous raw, unknown-zero and omitted gaps', async () => {
    const f=hfixture();
    try {
      const record=hrecord(),ack=hvalue(await f.store.appendInput(record));
      const next=hrecord('next',record),{digest:_,...broken}=next;
      expect((await f.store.appendInput({...broken,range:{...broken.range,start:0},digest:streamDigest('spool',{...broken,range:{...broken.range,start:0}})})).status).toBe('error');
      const request=hrows(ack),{digest:__,...body}=request;
      for (const changed of [
        {...body,inputAck:{...ack,commitId:'fake'}},
        {...body,coverage:body.coverage.filter(c=>c.kind!=='gap')},
        {...body,decision:{...body.decision,gaps:[]}},
        {...body,expectedGeneration:8},
      ]) expect((await f.store.commitRowsAndGaps({...changed,digest:streamDigest('rows-gaps',changed)})).status).toBe('error');
      const badgap={...request.decision.gaps[0]!,missingCount:0};
      const changed={...body,coverage:[{kind:'gap',gap:badgap,digest:streamDigest('gap',badgap)},body.coverage[1]],decision:{...body.decision,gaps:[badgap]}};
      expect((await f.store.commitRowsAndGaps({...changed,digest:streamDigest('rows-gaps',changed)} as RowsAndGapsCommit)).status).toBe('error');
      expect((await hreplay(f.store)).length).toBe(1);
    } finally {f.cleanup();}
  });
  test('corrupt durable payload is an error, never empty EOF', async () => {
    const f=hfixture();
    try {
      hvalue(await f.store.appendInput(hrecord()));f.store.close();
      const db=new Database(join(f.root,'flag-on-v1.sqlite'));db.exec("UPDATE fh_event SET payload='{}'");db.close();f.reopen();
      const chunks=[];for await(const x of f.store.recover(hp,null,{isCancelled:()=>false}))chunks.push(x);
      expect(chunks.length).toBe(1);expect(chunks[0]!.status).toBe('error');
    } finally {f.cleanup();}
  });
  test('pins survive restart, reject forged release and block seal and reclaim', async () => {
    const f=hfixture({validateRemoteIndex:()=>true});
    try {
      const ack=hvalue(await f.store.appendInput(hrecord()));hvalue(await f.store.commitRowsAndGaps(hrows(ack)));
      const request={operationId:'seal',pane:hp,expectedGeneration:0,segmentId:ack.segmentId};
      const pin=hvalue(await f.store.pinSegment({...request,operationId:'pin',reason:'handoff'}));f.reopen();
      expect((await f.store.sealExport(request)).status).toBe('error');
      expect((await f.store.releasePin({...pin,durableCommitId:'forged'})).status).toBe('error');hvalue(await f.store.releasePin(pin));
      const sealed=hvalue(await f.store.sealExport(request));
      const reader=hvalue(await f.store.pinSegment({...request,operationId:'reader',reason:'reader'}));
      expect((await f.store.reclaimVerified({...request,sealed,remote:hremote(sealed)})).status).toBe('error');
      expect(existsSync(sealed.files[0]!.path)).toBe(true);hvalue(await f.store.releasePin(reader));
    } finally {f.cleanup();}
  });
  test('upload exit zero and unvalidated catalog never permit early unlink', async () => {
    const f=hfixture();
    try {
      const ack=hvalue(await f.store.appendInput(hrecord())),request={operationId:'seal',pane:hp,expectedGeneration:0,segmentId:ack.segmentId};
      const sealed=hvalue(await f.store.sealExport(request));
      expect((await f.store.reclaimVerified({...request,sealed,remote:hremote(sealed)})).status).toBe('error');
      expect(existsSync(sealed.files[0]!.path)).toBe(true);expect((await hreplay(f.store)).length).toBe(1);
    } finally {f.cleanup();}
  });
  test('sealed inventory retains all rows gaps raw; verified reclaim really reduces allocated blocks', async () => {
    const f=hfixture({validateRemoteIndex:(r)=>r.commitId==='catalog-commit'});
    try {
      let record:SpoolRecord|null=null,ack:SpoolAck|undefined;
      for(let i=0;i<8;i++){record=hrecord('raw-'+i,record,'x'.repeat(32000));ack=hvalue(await f.store.appendInput(record));}
      const request=hrows(ack!);hvalue(await f.store.commitRowsAndGaps(request));
      const fence={operationId:'seal',pane:hp,expectedGeneration:0,segmentId:ack!.segmentId},sealed=hvalue(await f.store.sealExport(fence));
      const inventory=readFileSync(sealed.files[0]!.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      expect(inventory.length).toBe(9);expect(JSON.parse(inventory[8].payload).rows).toEqual(request.rows);expect(JSON.parse(inventory[8].payload).decision.gaps[0].missingCount).toBe(null);
      expect(hvalue(await f.store.sealExport(fence))).toEqual(sealed);
      const corrupt=hremote(sealed);const bad={...corrupt,coverage:[]};
      expect((await f.store.reclaimVerified({...fence,sealed,remote:bad})).status).toBe('error');
      // Measure the source DB separately: deleting the export copy alone must
      // not masquerade as SQLite page reclamation.
      const disk=new Database(join(f.root,'flag-on-v1.sqlite'));
      disk.exec('PRAGMA wal_checkpoint(TRUNCATE)');disk.close();
      const sourceBlocksBefore=statSync(join(f.root,'flag-on-v1.sqlite')).blocks;
      const result=hvalue(await f.store.reclaimVerified({...fence,sealed,remote:hremote(sealed)}));
      const sourceBlocksAfter=statSync(join(f.root,'flag-on-v1.sqlite')).blocks;
      console.log('FLAGON_H_SOURCE_DB_BLOCKS',JSON.stringify({sourceBlocksBefore,sourceBlocksAfter,blockBytes:512}));
      expect(sourceBlocksAfter).toBeLessThan(sourceBlocksBefore);
      expect(result.freeBlocksAfter).toBeGreaterThan(result.freeBlocksBefore);
      console.log('FLAGON_H_RECLAIM_BLOCKS',JSON.stringify(result));
      expect(result.allocatedBytesAfter).toBeLessThan(result.allocatedBytesBefore);expect(result.blockBytes).toBeGreaterThan(0);
      expect(existsSync(sealed.files[0]!.path)).toBe(false);expect(existsSync(sealed.manifest.path)).toBe(false);
      f.reopen();const replay=[];for await(const x of f.store.recover(hp,null,{isCancelled:()=>false}))replay.push(x);
      expect(replay).toHaveLength(1);expect(replay[0]!.status).toBe('error');expect(JSON.stringify(replay)).toContain('remote-required');
      const next=hrecord('after-seal',record,'suffix\n');expect(hvalue(await f.store.appendInput(next)).segmentId).not.toBe(ack!.segmentId);
    } finally {f.cleanup();}
  });
  test('seal and reclaim interrupted boundaries retry without early loss', async () => {
    for(const phase of ['seal-before-fsync','seal-before-rename','seal-before-commit','seal-after-commit','reclaim-before-commit','reclaim-after-commit','reclaim-before-unlink','reclaim-after-unlink','reclaim-rows-before-commit','reclaim-rows-after-commit']) {
      let armed=false,hit=false;const f=hfixture({validateRemoteIndex:()=>true,boundary(at){if(armed&&!hit&&at===phase){hit=true;throw Error('injected '+at);}}});
      try {
        const ack=hvalue(await f.store.appendInput(hrecord()));hvalue(await f.store.commitRowsAndGaps(hrows(ack)));
        const request={operationId:'seal',pane:hp,expectedGeneration:0,segmentId:ack.segmentId};
        let sealed:SealedExport;
        if(phase.startsWith('seal')){armed=true;expect((await f.store.sealExport(request)).status).toBe('error');armed=false;f.reopen();sealed=hvalue(await f.store.sealExport(request));}
        else {sealed=hvalue(await f.store.sealExport(request));armed=true;expect((await f.store.reclaimVerified({...request,sealed,remote:hremote(sealed)})).status).toBe('error');armed=false;f.reopen();}
        expect(hit).toBe(true);hvalue(await f.store.reclaimVerified({...request,sealed,remote:hremote(sealed)}));expect(existsSync(sealed.files[0]!.path)).toBe(false);
      } finally {f.cleanup();}
    }
  });
  test('raw bound, row batch bound, traversal/symlink and cancellation are fail closed', async () => {
    const f=hfixture();
    try {
      expect((await f.store.appendInput(hrecord('huge',null,'x'.repeat(256*1024+1)))).status).toBe('error');
      const ack=hvalue(await f.store.appendInput(hrecord()));
      expect((await f.store.commitRowsAndGaps(hrows(ack,'many',0,Array(257).fill('row')))).status).toBe('error');
      const cancelled=[];for await(const c of f.store.recover(hp,null,{isCancelled:()=>true}))cancelled.push(c);expect(cancelled[0]!.status).toBe('cancelled');
      const path=join(f.root,'alias');symlinkSync(f.root,path);expect(()=>new FlagOnHistoryStore({root:path,mode:'recover',codecVersions:[]})).toThrow();
      expect((await f.store.sealExport({operationId:'escape',pane:hp,expectedGeneration:0,segmentId:'../../escape'})).status).toBe('error');
    } finally {f.cleanup();}
  });
});

test('flag-on H process SIGKILL on real transaction boundaries preserves ACK and atomic gaps', async () => {
  for (const phase of ['input-before-write','input-before-commit','input-after-commit','rows-before-write','rows-before-commit','rows-after-commit']) {
    const f=hfixture();
    try {
      const record=hrecord();let request:RowsAndGapsCommit|undefined;
      if(phase.startsWith('rows'))request=hrows(hvalue(await f.store.appendInput(record)));
      f.store.close();
      const script=`import {FlagOnHistoryStore} from ${JSON.stringify(join(import.meta.dir,'../src/history-engine.ts'))};
        const store=new FlagOnHistoryStore({root:${JSON.stringify(f.root)},mode:'recover',codecVersions:['test-v1'],boundary(at){if(at===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});
        const answer=await store.${request?'commitRowsAndGaps':'appendInput'}(${JSON.stringify(request??record)});
        console.log(JSON.stringify(answer));store.close();`;
      const child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe'});
      const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(child.signalCode).toBe('SIGKILL');expect(exit).not.toBe(0);expect(stdout).not.toContain('"status":"ok"');expect(stderr).not.toMatch(/SyntaxError|ReferenceError|Cannot find/);
      f.reopen();const chunks=await hreplay(f.store);expect(chunks.length).toBe((request?1:0)+(phase.endsWith('after-commit')?1:0));
      const ack=hvalue(await f.store.appendInput(record));hvalue(await f.store.commitRowsAndGaps(request??hrows(ack)));expect((await hreplay(f.store)).length).toBe(2);
    }finally{f.cleanup();}
  }
});

test('flag-on H checkpoint is durable and its reference cannot point at a missing checkpoint', async () => {
  const f=hfixture();
  try {
    const ack=hvalue(await f.store.appendInput(hrecord())),identity={pane:hp,sourceEpoch:0,geometryGeneration:0};
    const cursor={x:0,y:0,visible:true},buffer={rows:[],cursor,savedCursor:cursor,savedAttributes:[],savedModes:{},wrapPending:false};
    const state={codecVersion:'test-v1',geometry:{columns:80,rows:24},normal:buffer,alternate:buffer,active:'normal' as const,modes:{},margins:{top:0,bottom:23,left:0,right:79},tabStops:[],pendingUtf8:[224],pendingEscape:[27],attributes:[],wrapPending:false,extensionState:'{}'};
    const checkpoint:VtCheckpoint={kind:'vt-recovery',checkpointId:'cp-H',previousCheckpointId:null,identity,inputFence:{kind:'durable-input',pane:hp,through:{sourceEpoch:0,packetSeq:0},digest:ack.recordDigest,segmentId:ack.segmentId},revision:0,head:0,state,stateDigest:streamDigest('vt-state',{identity,state})};
    const {digest:_,...request}=hrows(ack),body={...request,checkpointId:'cp-H'};
    expect((await f.store.commitRowsAndGaps({...body,digest:streamDigest('rows-gaps',body)})).status).toBe('error');
    hvalue(f.store.persistCheckpoint({operationId:'checkpoint',pane:hp,expectedGeneration:0,inputAck:ack,checkpoint}));
    hvalue(await f.store.commitRowsAndGaps({...body,digest:streamDigest('rows-gaps',body)}));f.reopen();
    const chunks=await hreplay(f.store);expect(chunks.map(x=>x.kind)).toEqual(['input','checkpoint','committed']);expect(chunks[1]).toEqual({kind:'checkpoint',checkpoint});
  }finally{f.cleanup();}
});

test('flag-on H stale epoch cannot append after rebind and readers have a fixed global budget', async () => {
  const f=hfixture();
  try {
    const old=hrecord(),ack=hvalue(await f.store.appendInput(old));
    const {digest:_,...value}=hrecord('new-epoch');const next={...value,range:{...value.range,epoch:{...value.range.epoch,attachId:'new-attach'}}};
    hvalue(await f.store.appendInput({...next,digest:streamDigest('spool',next)}));
    expect((await f.store.appendInput(hrecord('late-callback',old))).status).toBe('error');
    expect(hvalue(await f.store.appendInput(old))).toEqual(ack);
    const read=f.store.recover(hp,null,{isCancelled:()=>false})[Symbol.asyncIterator]();expect((await read.next()).done).toBe(false);
    const concurrent=f.store.recover(hp,null,{isCancelled:()=>false})[Symbol.asyncIterator]();expect((await concurrent.next()).value).toMatchObject({status:'busy'});await concurrent.return?.();
    f.reopen();await read.return?.();expect((await hreplay(f.store)).length).toBe(2);
  }finally{f.cleanup();}
});

test('flag-on H SIGKILL during seal and reclaim retains verifiable inventory and retry state', async () => {
  for (const phase of ['seal-before-write','seal-before-fsync','seal-before-rename','seal-before-commit','seal-after-commit',
    'reclaim-before-write','reclaim-before-commit','reclaim-after-commit','reclaim-before-unlink','reclaim-after-unlink',
    'reclaim-rows-before-write','reclaim-rows-before-commit','reclaim-rows-after-commit']) {
    const f=hfixture({validateRemoteIndex:()=>true});
    try {
      const ack=hvalue(await f.store.appendInput(hrecord()));hvalue(await f.store.commitRowsAndGaps(hrows(ack)));
      const request={operationId:'seal',pane:hp,expectedGeneration:0,segmentId:ack.segmentId};
      const sealed=phase.startsWith('reclaim')?hvalue(await f.store.sealExport(request)):null;
      const argument=sealed?{...request,sealed,remote:hremote(sealed)}:request;f.store.close();
      const script=`import {FlagOnHistoryStore} from ${JSON.stringify(join(import.meta.dir,'../src/history-engine.ts'))};
        const store=new FlagOnHistoryStore({root:${JSON.stringify(f.root)},mode:'recover',codecVersions:['test-v1'],validateRemoteIndex:()=>true,boundary(at){if(at===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});
        console.log(JSON.stringify(await store.${sealed?'reclaimVerified':'sealExport'}(${JSON.stringify(argument)})));store.close();`;
      const child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe'});
      const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(child.signalCode).toBe('SIGKILL');expect(exit).not.toBe(0);expect(stdout).not.toContain('"status":"ok"');expect(stderr).not.toMatch(/SyntaxError|ReferenceError|Cannot find/);
      f.reopen();const recoveredSeal=sealed??hvalue(await f.store.sealExport(request));
      if(!sealed){const data=readFileSync(recoveredSeal.files[0]!.path,'utf8');expect(data).toContain('rows-0');expect(data).toContain('missingCount');}
      hvalue(await f.store.reclaimVerified({...request,sealed:recoveredSeal,remote:hremote(recoveredSeal)}));expect(existsSync(recoveredSeal.files[0]!.path)).toBe(false);
    }finally{f.cleanup();}
  }
});


test('flag-on H interrupted seals do not accumulate unbounded staging across epochs', async () => {
  let armed=true;const f=hfixture({boundary(at){if(armed && at==='seal-before-commit')throw Error('lost seal');}});
  try {
    const ack=hvalue(await f.store.appendInput(hrecord()));
    const fence={operationId:'seal-old',pane:hp,expectedGeneration:0,segmentId:ack.segmentId};
    expect((await f.store.sealExport(fence)).status).toBe('error');
    expect(existsSync(join(f.root,ack.segmentId+'.jsonl'))).toBe(true);
    const {digest:_,...body}=hrecord('new');const changed={...body,range:{...body.range,epoch:{...body.range.epoch,attachId:'next'}}};
    const next=hvalue(await f.store.appendInput({...changed,digest:streamDigest('spool',changed)}));armed=false;
    hvalue(await f.store.sealExport({...fence,operationId:'seal-next',segmentId:next.segmentId}));
    expect(existsSync(join(f.root,ack.segmentId+'.jsonl'))).toBe(false);
    expect((await hreplay(f.store)).length).toBe(2);
    expect(readdirSync(f.root).filter(p=>p.endsWith('.jsonl')).length).toBe(1);
  }finally{f.cleanup();}
});


test('flag-on H replay from current durable cursor ignores older remote history and retains same-offset controls', async () => {
  const f=hfixture({validateRemoteIndex:()=>true});
  try {
    const old=hrecord(),first=hvalue(await f.store.appendInput(old));hvalue(await f.store.commitRowsAndGaps(hrows(first)));
    const fence={operationId:'seal-old',pane:hp,expectedGeneration:0,segmentId:first.segmentId};
    const sealed=hvalue(await f.store.sealExport(fence));hvalue(await f.store.reclaimVerified({...fence,sealed,remote:hremote(sealed)}));
    const next=hrecord('local-suffix',old,'new suffix\n'),ack=hvalue(await f.store.appendInput(next));
    const rawControl={version:1 as const,operationId:'resize',sequence:next.sequence+1,previousDigest:next.digest,range:{...next.range,start:next.range.end},payload:{kind:'resize' as const,geometry:{columns:100,rows:24}}};
    hvalue(await f.store.appendInput({...rawControl,digest:streamDigest('spool',rawControl)}));
    const request=hrows(ack,'suffix-rows',0,['new suffix']);hvalue(await f.store.commitRowsAndGaps(request));f.reopen();
    const replay=await hreplay(f.store,ack.through);expect(replay.map(x=>x.kind)).toEqual(['input','committed']);
    expect(replay[0]).toMatchObject({kind:'input',record:{payload:{kind:'resize'}}});
    expect(replay[1]).toMatchObject({kind:'committed',rows:request.rows});
    const full=[];for await(const item of f.store.recover(hp,null,{isCancelled:()=>false}))full.push(item);expect(full).toHaveLength(1);expect(full[0]!.status).toBe('error');
  }finally{f.cleanup();}
});

test('flag-on H kernel writer lock refuses another process and releases orphan replay pins after SIGKILL', async () => {
  const f=hfixture();
  try {
    const ack=hvalue(await f.store.appendInput(hrecord()));
    const source=JSON.stringify(join(import.meta.dir,'../src/history-engine.ts'));
    const script=`import {FlagOnHistoryStore} from ${source};
      try{const s=new FlagOnHistoryStore({root:${JSON.stringify(f.root)},mode:'recover',codecVersions:['test-v1']});s.close();process.exit(0);}
      catch(e){console.error(String(e));process.exit(42);}`;
    const child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe'});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit).toBe(42);expect(err).toMatch(/locked|busy/i);expect(out).toBe('');
    f.store.close();
    const kill=`import {FlagOnHistoryStore} from ${source};const s=new FlagOnHistoryStore({root:${JSON.stringify(f.root)},mode:'recover',codecVersions:['test-v1'],boundary(at){if(at==='replay-pin-after-commit')process.kill(process.pid,'SIGKILL');}});await s.recover(${JSON.stringify(hp)},null,{isCancelled:()=>false})[Symbol.asyncIterator]().next();`;
    const killed=Bun.spawn([process.execPath,'-e',kill],{stdout:'pipe',stderr:'pipe'});
    const [,ko,ke]=await Promise.all([killed.exited,new Response(killed.stdout).text(),new Response(killed.stderr).text()]);expect(killed.signalCode).toBe('SIGKILL');expect(ko).toBe('');expect(ke).toBe('');
    f.reopen();expect((await hreplay(f.store)).length).toBe(1);
    hvalue(await f.store.sealExport({operationId:'after-kill',pane:hp,expectedGeneration:0,segmentId:ack.segmentId}));
  }finally{f.cleanup();}
});

test('flag-on H SIGKILL covers checkpoint pin release and generation transaction boundaries', async () => {
  for(const kind of ['checkpoint','pin','release','generation'])for(const when of ['before-write','before-commit','after-commit']){
    const f=hfixture();
    try{
      const ack=hvalue(await f.store.appendInput(hrecord())),identity={pane:hp,sourceEpoch:0,geometryGeneration:0};
      const cursor={x:0,y:0,visible:true},buffer={rows:[],cursor,savedCursor:cursor,savedAttributes:[],savedModes:{},wrapPending:false};
      const state={codecVersion:'test-v1',geometry:{columns:80,rows:24},normal:buffer,alternate:buffer,active:'normal' as const,modes:{},margins:{top:0,bottom:23,left:0,right:79},tabStops:[],pendingUtf8:[],pendingEscape:[],attributes:[],wrapPending:false,extensionState:'{}'};
      const checkpoint:VtCheckpoint={kind:'vt-recovery',checkpointId:'cp-kill',previousCheckpointId:null,identity,inputFence:{kind:'durable-input',pane:hp,through:{sourceEpoch:0,packetSeq:0},digest:ack.recordDigest,segmentId:ack.segmentId},revision:0,head:0,state,stateDigest:streamDigest('vt-state',{identity,state})};
      const pinRequest={operationId:'pin-kill',pane:hp,expectedGeneration:0,segmentId:ack.segmentId,reason:'handoff' as const};
      const pin=kind==='release'?hvalue(await f.store.pinSegment(pinRequest)):null;
      const action=kind==='checkpoint'?`store.persistCheckpoint(${JSON.stringify({operationId:'cp-kill',pane:hp,expectedGeneration:0,inputAck:ack,checkpoint})})`
        :kind==='pin'?`await store.pinSegment(${JSON.stringify(pinRequest)})`
        :kind==='release'?`await store.releasePin(${JSON.stringify(pin)})`
        :`store.setGeneration(${JSON.stringify(hp)},0,1)`;
      f.store.close();
      const script=`import {FlagOnHistoryStore} from ${JSON.stringify(join(import.meta.dir,'../src/history-engine.ts'))};
        const store=new FlagOnHistoryStore({root:${JSON.stringify(f.root)},mode:'recover',codecVersions:['test-v1'],boundary(at){if(at===${JSON.stringify(kind+'-'+when)})process.kill(process.pid,'SIGKILL');}});${action};store.close();`;
      const child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe'});
      const [,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(child.signalCode).toBe('SIGKILL');expect(out).toBe('');expect(err).toBe('');
      f.reopen();const db=new Database(join(f.root,'flag-on-v1.sqlite'),{readonly:true});
      try{
        const sql=kind==='checkpoint'?'SELECT count(*) AS n FROM fh_checkpoint':kind==='pin'?'SELECT count(*) AS n FROM fh_pin':kind==='release'?'SELECT released AS n FROM fh_pin':'SELECT generation AS n FROM fh_pane';
        expect((db.query(sql).get() as {n:number}).n).toBe(when==='after-commit'?1:0);
        expect((db.query("SELECT count(*) AS n FROM fh_event WHERE kind='input'").get() as {n:number}).n).toBe(1);
      }finally{db.close();}
    }finally{f.cleanup();}
  }
});

// Repair H-r2: missing methods are reported as contract-conformance assertions,
// never an import failure masquerading as a behavioral red.
import type { FlagOnHistoryR2 } from '../src/stream-contract';
function hr2(store: FlagOnHistoryStore): FlagOnHistoryR2 {
  expect(typeof (store as unknown as FlagOnHistoryR2).rotateSegment).toBe('function');
  return store as unknown as FlagOnHistoryR2;
}
function hplain(ack: SpoolAck, op: string, start = 0, texts = ['row']): RowsAndGapsCommit {
  const {digest:_,...value}=hrows(ack,op,start,texts);
  const body={...value,coverage:value.coverage.filter(c=>c.kind==='rows'),decision:{...value.decision,gaps:[]}};
  return {...body,digest:streamDigest('rows-gaps',body)};
}
test('H-r2 rejects a gap whose left row never committed and accepts earlier same-transaction rows', async()=>{
  const f=hfixture();try{
    const ack=hvalue(await f.store.appendInput(hrecord()));
    const {digest:_,...request}=hrows(ack,'dangling',0,[]);
    const gap={...request.decision.gaps[0]!,leftRowId:{pane:hp,segmentId:ack.segmentId,rowOrdinal:42}};
    const body={...request,coverage:[{kind:'gap' as const,gap,digest:streamDigest('gap',gap)}],decision:{...request.decision,gaps:[gap]}};
    expect((await f.store.commitRowsAndGaps({...body,digest:streamDigest('rows-gaps',body)})).status).toBe('error');
    const {digest:__,...positive}=hrows(ack,'same-tx');
    const good={...gap,episodeId:'same-tx-gap',leftRowId:positive.rows[1]!.id};
    const valid={...positive,coverage:[positive.coverage[1]!,{kind:'gap' as const,gap:good,digest:streamDigest('gap',good)}],decision:{...positive.decision,gaps:[good]}};
    expect((await f.store.commitRowsAndGaps({...valid,digest:streamDigest('rows-gaps',valid)})).status).toBe('ok');
  }finally{f.cleanup();}
});
test('H-r2 full 4501-row capture rotates without new input or a fabricated gap while remote is offline',async()=>{
  const f=hfixture();try{
    const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord()));let segment=ack.segmentId,start=0;
    for(let n=0;n<4501;n+=128){
      if(n && n%512===0){
        const seam=hvalue(await port.rotateSegment({operationId:'rotate-'+n,pane:hp,expectedGeneration:0,segmentId:segment,boundary:ack.through}));
        expect(seam.predecessor).toBe(segment);expect(seam.epoch).toEqual(ack.through.epoch);
        segment=seam.successor;start=0;
      }
      const count=Math.min(128,4501-n),request=hplain(ack,'capture-'+n,start,Array.from({length:count},(_,i)=>'capture-'+(n+i)));
      const {digest:_,...base}=request;
      const rows=base.rows.map((row,i)=>({...row,id:{...row.id,segmentId:segment},origin:{kind:'capture' as const,snapshotId:'one-capture',rowIndex:n+i}}));
      const coverage=[{kind:'rows' as const,range:{pane:hp,segmentId:segment,start,end:start+count},digest:streamDigest('rows',rows)}];
      const body={...base,rows,coverage,decision:{...base.decision,acceptedRowMap:rows.map(row=>({source:row.origin,target:row.id}))}};
      hvalue(await port.commitRowsAndGaps({...body,digest:streamDigest('rows-gaps',body)}));start+=count;
    }
    expect(hvalue(port.authority.head(hp)).rowCount).toBe(4501);
    expect(hvalue(port.listSealed(null,256)).seals).toHaveLength(8);
    f.reopen();const reopened=hr2(f.store);expect(hvalue(reopened.authority.head(hp)).entryCount).toBe(4501);
    let cursor=null as import('../../core/src/protocol').NewarchHistoryCursor|null;const texts:string[]=[];
    for(;;){const page=hvalue(reopened.authority.page({pane:hp,cursor,direction:'after',maxEntries:256,maxBytes:1024*1024}));
      texts.push(...page.entries.map(e=>'cells' in e?e.cells.map(c=>c.text).join(''):'GAP'));
      if(page.after.kind==='end')break;expect(page.after.kind).toBe('more');cursor=page.after.cursor;
    }
    expect(texts).toEqual(Array.from({length:4501},(_,i)=>'capture-'+i));
  }finally{f.cleanup();}
});
test('H-r2 backlog larger than a segment rotates with continuous source offsets',async()=>{
  const f=hfixture();try{const port=hr2(f.store);let previous:SpoolRecord|null=null;const segments=new Set<string>();
    for(let i=0;i<37;i++){previous=hrecord('backlog-'+i,previous,'x'.repeat(60000));segments.add(hvalue(await port.appendInput(previous)).segmentId);}
    expect(segments.size).toBeGreaterThan(1);
    const records=(await hreplay(f.store)).filter(c=>c.kind==='input');expect(records).toHaveLength(37);
    expect(records.map(c=>c.kind==='input'?c.record.range.start:-1)).toEqual(Array.from({length:37},(_,i)=>i*60000));
  }finally{f.cleanup();}
});
test('H-r2 exposes bounded durable read checkpoint attach and reclaim ports',()=>{
 const f=hfixture();try{const port=hr2(f.store);
 for(const method of ['stageRows','sealAttachSet','publishAttach','discardAttach','journalControl','commitReplayCheckpoint','commitReplayDecision','sealSegment','materializeExport','reclaimR2','appendVerifiedInput'])expect(typeof (port as any)[method]).toBe('function');
 for(const method of ['head','tail','page','watermark','decisions','receipt','staged','attachSet','generation','pin','seal','continuity'])expect(typeof (port.authority as any)[method]).toBe('function');
 }finally{f.cleanup();}
});

import { streamCanonical, attachReceiptSetDigest, orderedControlDigest, archiveInventoryDigest, inputProvenanceDigest, sourceRecordsDigest, sourceSpoolDigest } from '../src/stream-contract';
import type { AttachDecisionR2, AttachReceiptSetR2, StagedRowsR2, CatalogAuthorityR2, ReplayWatermarkR2, ArchiveInventoryR2, RemoteIndexR2, CoalescedInputR2, OrderedControlR2, NewarchHistoryCursor } from '../src/stream-contract';
const hcatalog=(attach:()=>AttachDecisionR2|null=()=>null,remote:()=>RemoteIndexR2|null=()=>null):CatalogAuthorityR2=>({attach:()=>({status:'ok',value:attach()}),remote:()=>({status:'ok',value:remote()}),switchDecision:()=>({status:'ok',value:null})});
function hstage(ack:SpoolAck,n:number):StagedRowsR2 {
  const {digest:_,...base}=hplain(ack,'stage-'+n,n*2,['candidate-'+n+'a','candidate-'+n+'b']);
  const body={...base,decision:{...base.decision,decisionId:'attach-decision'}};
  return {...body,digest:streamDigest('rows-gaps',body),repair:{revision:2,transactionId:'transaction-H',epoch:ack.through.epoch,decisionId:'attach-decision',chunkOrdinal:n,visibility:'candidate'}};
}
function hset(requests:StagedRowsR2[]):AttachReceiptSetR2 {
 const entries=requests.map(({repair,...r},ordinal)=>({ordinal,operationId:r.operationId,commitId:r.operationId,digest:r.digest,rows:r.rows.length,payloadBytes:Buffer.byteLength(streamCanonical(r))}));
 return {revision:2,transactionId:'transaction-H',pane:hp,epoch:requests[0]!.repair.epoch,decisionId:'attach-decision',expectedGeneration:0,entries,terminalCommitId:entries.at(-1)!.commitId,aggregateDigest:attachReceiptSetDigest(entries)};
}
test('H-r2 staged attach stays invisible until catalog decision and lost publish ACK reconciles on restart',async()=>{
 let decision:AttachDecisionR2|null=null;const f=hfixture({catalogAuthority:hcatalog(()=>decision)});
 try{const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord())),requests=[hstage(ack,0),hstage(ack,1)];
   for(const r of requests)hvalue(await port.stageRows(r));
   expect(hvalue(port.authority.head(hp)).entryCount).toBe(0);
   expect(hvalue(port.authority.receipt(requests[0]!.operationId))).toBe(null);
   expect((await hreplay(f.store)).filter(c=>c.kind==='committed')).toHaveLength(0);
   expect((await port.sealAttachSet({pane:hp,expectedGeneration:0,operationId:'seal-incomplete',manifest:hset([requests[0]!])})).status).toBe('error');
   const manifest=hset(requests);hvalue(await port.sealAttachSet({pane:hp,expectedGeneration:0,operationId:'attach-seal',manifest}));
   expect((await port.stageRows(hstage(ack,2))).status).toBe('error');
   const committed:AttachDecisionR2={revision:2,transactionId:manifest.transactionId,receiptSetDigest:manifest.aggregateDigest,attachId:ack.through.epoch.attachId,generation:1,commitId:'catalog-attach',state:'COMMITTED',admission:'active-exact'};
   expect((await port.publishAttach(committed)).status).toBe('error');
   decision=committed;f.reopen();const resumed=hr2(f.store);
   expect(hvalue(resumed.authority.head(hp)).rowCount).toBe(4);
   expect(hvalue(await resumed.publishAttach(committed)).rowCount).toBe(4);
   expect((await resumed.discardAttach(committed)).status).toBe('error');
   const page=hvalue(resumed.authority.page({pane:hp,cursor:null,direction:'after',maxEntries:256,maxBytes:1024*1024}));
   expect(page.entries.map(e=>'cells' in e?e.cells[0]!.text:'gap')).toEqual(['candidate-0a','candidate-0b','candidate-1a','candidate-1b']);
   expect(hvalue(resumed.authority.staged(manifest.transactionId,0))!.projection.sourceDigest).toBe(requests[0]!.digest);
 }finally{f.cleanup();}
});
function hcheckpoint(ack:SpoolAck,id:string,previous:string|null=null):VtCheckpoint {
 const identity={pane:hp,sourceEpoch:0,geometryGeneration:1},cursor={x:0,y:0,visible:true},buffer={rows:[],cursor,savedCursor:cursor,savedAttributes:[],savedModes:{},wrapPending:false};
 const state={codecVersion:'test-v1',geometry:{columns:41,rows:30},normal:buffer,alternate:buffer,active:'normal' as const,modes:{},margins:{top:0,bottom:29,left:0,right:40},tabStops:[],pendingUtf8:[224],pendingEscape:[27],attributes:[],wrapPending:false,extensionState:JSON.stringify({known:{geometry:true,attributes:false}})};
 return {kind:'vt-recovery',checkpointId:id,previousCheckpointId:previous,identity,inputFence:{kind:'durable-input',pane:hp,through:{sourceEpoch:0,packetSeq:0},digest:ack.recordDigest,segmentId:ack.segmentId},revision:0,head:0,state,stateDigest:streamDigest('vt-state',{identity,state})};
}
function hwatermark(f:ReturnType<typeof hfixture>,ack:SpoolAck,checkpoint:VtCheckpoint,index?:string):ReplayWatermarkR2 {
 return {revision:2,pane:hp,checkpointId:checkpoint.checkpointId,through:ack.through,controlOrder:1,decoderVersion:'test-v1',stateDigest:checkpoint.stateDigest,known:{geometry:true,attributes:false},decisionIndexCommitId:index??'empty:'+f.store.storeUUID,snapshotDependencies:[],durableCommitId:'cp-'+checkpoint.checkpointId};
}
function hrremote(sealed:SealedExport,seal:import('../src/stream-contract').LogicalSealR2):{remote:RemoteIndexR2;inventory:ArchiveInventoryR2}{
 const old=hremote(sealed),members=[...sealed.files,sealed.manifest].map(f=>({...f,path:f.path.split('/').at(-1)!}));
 const inventory:ArchiveInventoryR2={revision:2,sealGeneration:sealed.generation,sealCommitId:sealed.sealCommitId,sealManifestSha256:sealed.manifest.sha256,bundleManifestSha256:old.verified.bundle.manifest.sha256,members:[...sealed.files,sealed.manifest].map((f,i)=>({sourcePath:f.path,relativePath:members[i]!.path,bytes:f.bytes,sha256:f.sha256}))};
 return {inventory,remote:{...old,verified:{...old.verified,bundle:{...old.verified.bundle,members,rawRanges:seal.rawRanges,checkpointIds:seal.checkpointIds,...{repair:{revision:2,inventory,timelineIndex:members.find(f=>f.path.endsWith('.timeline.jsonl'))!,replayIndex:members.find(f=>f.path.endsWith('.replay.jsonl'))!}}}},repair:{revision:2,sealCommitId:sealed.sealCommitId,sealGeneration:sealed.generation,inventoryDigest:archiveInventoryDigest(inventory),authorizationGeneration:0}}};
}
test('H-r2 checkpoint pins block reclaim; successor preserves resize state decisions and stable remote timeline',async()=>{
 let remote:RemoteIndexR2|null=null;const f=hfixture({catalogAuthority:hcatalog(undefined,()=>remote)});
 try{const port=hr2(f.store),input=hrecord('large',null,'x'.repeat(60000)),ack=hvalue(await port.appendInput(input));
   hvalue(await port.commitRowsAndGaps(hplain(ack,'durable-prefix')));
   const before=hvalue(port.authority.head(hp));
   const controlBody={revision:2 as const,eventId:'resize',position:ack.through,order:1,decoderVersion:'test-v1',payload:{kind:'geometry' as const,before:{columns:80,rows:24},after:{columns:41,rows:30}}};
   const event={...controlBody,digest:orderedControlDigest(controlBody)};
   hvalue(await port.journalControl({pane:hp,expectedGeneration:0,operationId:'control',event}));
   const bad={...controlBody,eventId:'resize-out-of-order',order:0};expect((await port.journalControl({pane:hp,expectedGeneration:0,operationId:'bad-control',event:{...bad,digest:orderedControlDigest(bad)}})).status).toBe('error');
   const cp=hcheckpoint(ack,'first'),watermark=hwatermark(f,ack,cp);
   hvalue(await port.commitReplayCheckpoint({pane:hp,expectedGeneration:0,operationId:'cp-first',checkpoint:cp,watermark}));
   const decision={decisionId:'consumed-prefix',raw:input.range,controlStart:0,controlEnd:1,disposition:'consumed' as const,coverage:hplain(ack,'durable-prefix').coverage,checkpointId:cp.checkpointId,decoderVersion:'test-v1'};
   hvalue(await port.commitReplayDecision({pane:hp,expectedGeneration:0,operationId:'decision-commit',decision}));
   const seam=hvalue(await port.rotateSegment({pane:hp,expectedGeneration:0,operationId:'rotate-pinned',segmentId:ack.segmentId,boundary:ack.through}));
   expect((await port.materializeExport({pane:hp,expectedGeneration:0,operationId:'pinned-export',sealCommitId:seam.sealCommitId})).status).toBe('error');
   const next=hvalue(await port.appendInput(hrecord('successor',input,'suffix'))),cp2=hcheckpoint(next,'second','first'),watermark2=hwatermark(f,next,cp2,'decision-commit');
   hvalue(await port.commitReplayCheckpoint({pane:hp,expectedGeneration:0,operationId:'cp-second',checkpoint:cp2,watermark:watermark2}));
   const logical=hvalue(port.listSealed(null,256)).seals[0]!,sealed=hvalue(await port.materializeExport({pane:hp,expectedGeneration:0,operationId:'export',sealCommitId:seam.sealCommitId}));
   expect(logical.checkpointIds).toContain('first');
   const replayFile=sealed.files.find(f=>f.path.endsWith('.replay.jsonl'))!;
   const exported=readFileSync(replayFile.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
   expect(exported.find(e=>e.kind==='control').value).toEqual(event);
   expect(exported.find(e=>e.kind==='replay-checkpoint').value).toEqual(cp);
   expect(exported.find(e=>e.kind==='decision').value).toEqual(decision);
   const candidate=hrremote(sealed,logical),request={pane:hp,expectedGeneration:0,operationId:'reclaim',sealed,...candidate};
   expect((await port.reclaimR2(request)).status).toBe('error');expect(existsSync(sealed.files[0]!.path)).toBe(true);
   remote=candidate.remote;const reclaimed=hvalue(await port.reclaimR2(request));expect(reclaimed.allocatedBytesAfter).toBeLessThan(reclaimed.allocatedBytesBefore);
   f.reopen();const recovered=hr2(f.store);expect(hvalue(recovered.authority.head(hp))).toEqual(before);
   expect(hvalue(recovered.authority.watermark(hp))).toEqual(watermark2);
   expect(hvalue(recovered.authority.decisions({pane:hp,cursor:null,direction:'after',maxEntries:256,maxBytes:1024*1024})).entries).toEqual([decision]);
   const page=hvalue(recovered.authority.page({pane:hp,cursor:null,direction:'after',maxEntries:256,maxBytes:1024*1024}));expect(page.after.kind).toBe('blocked');if(page.after.kind==='blocked')expect(page.after.state.kind).toBe('remote-required');
   expect(hvalue(recovered.authority.tail(hp,512,1024*1024)).kind).toBe('blocked');
 }finally{f.cleanup();}
});
test('H-r2 authority.controls reads journaled controls after reopen inside the watermark bound',async()=>{
  const f=hfixture();
  try{
    const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord())),at=ack.through;
    const journal=async(operationId:string,eventId:string,order:number,payload:OrderedControlR2['payload'])=>{
      const body={revision:2 as const,eventId,position:at,order,decoderVersion:'test-v1',payload};
      const event={...body,digest:orderedControlDigest(body)};
      hvalue(await port.journalControl({pane:hp,expectedGeneration:0,operationId,event}));
      return event;
    };
    const atWatermark=await journal('control-at','resize-at-watermark',1,{kind:'geometry',before:{columns:80,rows:24},after:{columns:41,rows:30}});
    const afterA=await journal('control-a','mode-after',2,{kind:'control',name:'DECSET',data:'?1049'});
    const afterB=await journal('control-b','resize-after',3,{kind:'geometry',before:{columns:41,rows:30},after:{columns:100,rows:40}});
    const cp=hcheckpoint(ack,'controls-cp'),watermark=hwatermark(f,ack,cp);
    expect(watermark.controlOrder).toBe(1);
    hvalue(await port.commitReplayCheckpoint({pane:hp,expectedGeneration:0,operationId:watermark.durableCommitId,checkpoint:cp,watermark}));
    f.reopen();
    const resumed=hr2(f.store),stored=hvalue(resumed.authority.watermark(hp));
    expect(stored).toEqual(watermark);
    expect(typeof resumed.authority.controls).toBe('function');
    const read=(cursor:NewarchHistoryCursor|null,maxEntries=1,maxBytes=1024*1024)=>resumed.authority.controls({pane:hp,after:stored!,cursor,maxEntries,maxBytes});
    const first=hvalue(read(null));
    expect(first.revision).toBe(2);expect(first.checkpointId).toBe(cp.checkpointId);
    expect(first.entries.map(entry=>entry.event)).toEqual([afterA]);
    expect(first.entries.map(entry=>entry.commitId)).toEqual([afterA.eventId]);
    expect(first.entries.some(entry=>entry.event.eventId===atWatermark.eventId)).toBe(false);
    expect(first.payloadBytes).toBe(Buffer.byteLength(streamCanonical(first.entries)));
    expect(first.atDurableHead).toBe(false);expect(first.next).not.toBeNull();
    const second=hvalue(read(first.next));
    expect(second.entries.map(entry=>entry.event)).toEqual([afterB]);
    expect(second.atDurableHead).toBe(true);expect(second.next).toBeNull();
    expect(second.payloadBytes).toBe(Buffer.byteLength(streamCanonical(second.entries)));
    expect(hvalue(read(null))).toEqual(first);
    expect(read(null,1,1).status).toBe('error');
    expect(resumed.authority.controls({pane:hp,after:{...stored!,controlOrder:0},cursor:null,maxEntries:1,maxBytes:1024*1024}).status).toBe('error');
    expect(hvalue(resumed.authority.head(hp)).rowCount).toBe(0);
  }finally{f.cleanup();}
});
test('H-r2 authority.controls starts at the watermark when older controls exceed the scan bound',async()=>{
  const f=hfixture();
  try{
    const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord())),at=ack.through,older=1100;
    const journal=async(order:number,payload:OrderedControlR2['payload'])=>{
      const body={revision:2 as const,eventId:'bulk-'+String(order).padStart(5,'0'),position:at,order,decoderVersion:'test-v1',payload};
      const event={...body,digest:orderedControlDigest(body)};
      hvalue(await port.journalControl({pane:hp,expectedGeneration:0,operationId:'bulk-op-'+order,event}));
      return event;
    };
    for(let order=1;order<=older;order++)await journal(order,{kind:'control',name:'DECSET',data:'?25'});
    const afterA=await journal(older+1,{kind:'control',name:'DECSET',data:'?1049'});
    const afterB=await journal(older+2,{kind:'geometry',before:{columns:41,rows:30},after:{columns:100,rows:40}});
    const cp=hcheckpoint(ack,'bulk-cp'),watermark={...hwatermark(f,ack,cp),controlOrder:older};
    hvalue(await port.commitReplayCheckpoint({pane:hp,expectedGeneration:0,operationId:watermark.durableCommitId,checkpoint:cp,watermark}));
    f.reopen();
    const resumed=hr2(f.store),stored=hvalue(resumed.authority.watermark(hp))!;
    const read=(cursor:NewarchHistoryCursor|null)=>resumed.authority.controls({pane:hp,after:stored,cursor,maxEntries:1,maxBytes:1024*1024});
    const first=read(null);
    expect(first.status).toBe('ok');
    const page=hvalue(first);
    expect(page.entries.map(entry=>entry.event)).toEqual([afterA]);
    expect(page.atDurableHead).toBe(false);
    const second=hvalue(read(page.next));
    expect(second.entries.map(entry=>entry.event)).toEqual([afterB]);
    expect(second.atDurableHead).toBe(true);expect(second.next).toBeNull();
  }finally{f.cleanup();}
},60000);
test('H-r2 canonical SGR survives durable reopen and rejects semantic tuples; source bytes require readback',async()=>{
 const base=hrecord(),{digest:_,...body}=base,source={...body,digest:sourceSpoolDigest(body)};
 const f=hfixture({readSourceRecords:()=>({status:'ok',value:[source]})});
 try{const port=hr2(f.store),value={revision:2 as const,record:base,historyDomain:'spool' as const,source:[{range:source.range,firstSequence:0,lastSequence:0,previousDigest:null,terminalDigest:source.digest,sourceDomain:'spool-record' as const,recordsDigest:sourceRecordsDigest([source])}]};
   const request:CoalescedInputR2={...value,provenanceDigest:inputProvenanceDigest(value)};
   const changed={...value,record:hrecord('forged',null,'DIFF\nDIFF\n')};expect((await port.appendVerifiedInput({...changed,provenanceDigest:inputProvenanceDigest(changed)})).status).toBe('error');
   const ack=hvalue(await port.appendVerifiedInput(request));
   const {digest:__,...rows}=hplain(ack,'styled');
   const cells=[{text:'e\u0301',width:1 as const,style:[1,31,48,5,200]},{text:'界',width:2 as const,style:[38,2,17,34,51]},{text:'',width:0 as const,style:[]}];
   const styled=rows.rows.map(row=>({...row,cells})),coverage=[{...rows.coverage[0]!,digest:streamDigest('rows',styled)}];
   const good={...rows,rows:styled,coverage,decision:{...rows.decision,acceptedRowMap:styled.map(row=>({source:row.origin,target:row.id}))}};
   hvalue(await port.commitRowsAndGaps({...good,digest:streamDigest('rows-gaps',good)}));f.reopen();expect((await hreplay(f.store)).find(c=>c.kind==='committed')).toMatchObject({rows:[{cells}]});
   const invalidRows=hplain(ack,'invalid',1).rows.map(row=>({...row,cells:[{text:'bad',width:1 as const,style:[0,-1,-1]}]}));
   const invalid={...hplain(ack,'invalid',1),rows:invalidRows};const {digest:___,...bad}=invalid;expect((await f.store.commitRowsAndGaps({...bad,digest:streamDigest('rows-gaps',bad)})).status).toBe('error');
 }finally{f.cleanup();}
});

test('H-r2 tail pins every local segment and releases all with its visible token',async()=>{
 const f=hfixture();try{const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord()));hvalue(await port.commitRowsAndGaps(hplain(ack,'left')));
 const seam=hvalue(await port.rotateSegment({pane:hp,expectedGeneration:0,operationId:'tail-rotate',segmentId:ack.segmentId,boundary:ack.through}));
 const {digest:_,...body}=hplain(ack,'right');const rows=body.rows.map(row=>({...row,id:{...row.id,segmentId:seam.successor}}));const value={...body,rows,coverage:[{kind:'rows' as const,range:{pane:hp,segmentId:seam.successor,start:0,end:1},digest:streamDigest('rows',rows)}],decision:{...body.decision,acceptedRowMap:rows.map(row=>({source:row.origin,target:row.id}))}};
 hvalue(await port.commitRowsAndGaps({...value,digest:streamDigest('rows-gaps',value)}));
 const tail=hvalue(port.authority.tail(hp,512,1024*1024));expect(tail.kind).toBe('local');if(tail.kind!=='local')throw Error('local tail required');expect(tail.rows).toHaveLength(2);
 expect((await port.materializeExport({pane:hp,expectedGeneration:0,operationId:'pinned-export',sealCommitId:seam.sealCommitId})).status).toBe('error');
 hvalue(await port.releasePin(tail.pin));expect((await port.materializeExport({pane:hp,expectedGeneration:0,operationId:'released-export',sealCommitId:seam.sealCommitId})).status).toBe('ok');
 }finally{f.cleanup();}
});
test('H-r2 distinct gaps in one episode retain positions across durable close updates',async()=>{
 const f=hfixture();try{const port=hr2(f.store),ack=hvalue(await port.appendInput(hrecord()));
 const base=hrows(ack,'gaps',0,[]).decision.gaps[0]!;
 const a={...base,episodeId:'one-episode',repair:{revision:2 as const,gapId:'a',sequence:0,update:0,state:'open' as const}},b={...a,repair:{...a.repair,gapId:'b',sequence:1}};
 const commit=async(op:string,gaps:readonly import('../src/stream-contract').GapR2[])=>{const {digest:_,...body}=hrows(ack,op,0,[]),value={...body,coverage:gaps.map(gap=>({kind:'gap' as const,gap,digest:streamDigest('gap',gap)})),decision:{...body.decision,gaps}};return port.commitRowsAndGaps({...value,digest:streamDigest('rows-gaps',value)});};
 hvalue(await commit('two-gaps',[a,b]));const closed={...a,closedAt:2,repair:{...a.repair,update:1,state:'closed' as const}};hvalue(await commit('close-first',[closed]));
 expect(hvalue(port.authority.head(hp)).entryCount).toBe(2);
 expect((await commit('reopen-closed',[{...a,repair:{...a.repair,update:2}}])).status).toBe('error');
 f.reopen();const page=hvalue(hr2(f.store).authority.page({pane:hp,cursor:null,direction:'after',maxEntries:256,maxBytes:1024*1024}));expect(page.entries).toEqual([closed,b]);
 }finally{f.cleanup();}
});

// H/Q22: real transactions on synthetic roots. New API, so mutation barriers
// below prove behavioral red; a missing export/import is never the red oracle.
import { writeFileSync } from 'node:fs';
import { createV2HistoryFactory } from '../src/history-engine';
import * as H2 from '../src/stream-contract';
import type { NewarchV2Incident, NewarchV2PaneDescriptor } from '@thumbmux/core';
function h2value<T>(r: H2.Result<T>): T { if (r.status !== 'ok') throw Error(JSON.stringify(r)); return r.value; }
async function h2fixture(hooks: Parameters<typeof createV2HistoryFactory>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'newarch-h2-'));
  const factory = createV2HistoryFactory({ inputReceipt: ack => ({ status: 'ok', value: ack }), ...hooks });
  const open = () => factory.openForCapture({ rootId: root, engineId: 'test-capture', config: H2.NEWARCH_V2_DEFAULT_CONFIG });
  let port = h2value(await open());
  const pane = { serverIdentity: 'private-server', paneId: '%1', birthGeneration: 1 };
  const session = { serverIdentity: pane.serverIdentity, sessionId: 'stable-1' };
  const geometry = H2.v2BirthGeometry(H2.NEWARCH_V2_DEFAULT_CONFIG);
  const epoch = { pane, attachId: 'birth-1', collectorIncarnation: 'collector-1' };
  const descriptor: NewarchV2PaneDescriptor = { schema: 'newarch-v2', session, pane, windowId: '@1', owner: 'capture-engine', birthOperationId: 'birth-1', geometry, state: 'active' };
  const cursor = { x: 0, y: 0, visible: true };
  const buffer = { rows: [], cursor, savedCursor: cursor, savedAttributes: [], savedModes: {}, wrapPending: false };
  const state: H2.VtState = { codecVersion: 'test-v2', geometry: { columns: 100, rows: 40 }, normal: buffer, alternate: buffer,
    active: 'normal', modes: {}, margins: { top: 0, bottom: 40, left: 0, right: 100 }, tabStops: [], pendingUtf8: [224], pendingEscape: [27, 91], attributes: [], wrapPending: false, extensionState: '{}' };
  const cp = (revision: number, offset = 0, frontier: H2.SegmentRowId | null = null): H2.V2LiveCheckpoint => ({ schema: 'newarch-v2', checkpointId: 'cp-' + revision, pane, geometry,
    through: { epoch, byteOffset: offset }, replayFloor: { epoch, byteOffset: Math.max(0, offset - 1) }, revision, frontier,
    rule: { ruleId: 'ordered-scroll', version: '1', configVersion: 'q22-default-1' }, state, stateDigest: H2.v2Digest('vt-state', state), pending: { rows: [], bytes: 0, deadlineMonoMs: null } });
  const request = (command: H2.V2WriteCommand, operationId: string, revision?: number): H2.V2WriteRequest => {
    const fence = { pane, operationId, expectedGeneration: port.capability.generation,
      expectedRevision: revision ?? h2value(port.reader.owner(pane))?.durableRevision ?? 0 };
    return { fence: { ...fence, digest: H2.v2WriteDigest({ fence, command }) }, command };
  };
  const commit = async (command: H2.V2WriteCommand, id: string) => h2value(await port.writer.commit(port.capability, request(command, id)));
  const intent: H2.V2BirthIntent = { schema: 'newarch-v2', operationId: 'birth-1', session, geometry, command: 'new-session', owner: 'capture-engine' };
  const reserve = async () => h2value(await port.writer.reserveBirth(port.capability, { intent, expectedGeneration: port.capability.generation, digest: H2.v2Digest('birth-reservation', { intent }) }));
  const ready: H2.V2BirthReady = { intent, pane: descriptor,
    binding: { kind: 'collector-binding', epoch, attachId: epoch.attachId, rootUUID: 'root-1', bootNonce: 'boot', ownerGeneration: 1,
      process: { pid: 123, startTime: '1234', bootId: 'private-boot' }, peerUid: 1000, fifoId: 'fifo-1', handshakeId: 'h1', artifactSha256: 'a'.repeat(64) },
    byte0: { epoch, byteOffset: 0 }, journal: { path: '/synthetic/birth', bytes: 12, sha256: 'a'.repeat(64) }, geometryReadback: { columns: 100, rows: 40 }, paneCountInWindow: 1, programHeld: true };
  const activate = async () => { await reserve(); return commit({ kind: 'activate', ready, checkpoint: cp(1) }, 'activate-1'); };
  const incident = (id: string, revision: number, frontier: H2.SegmentRowId | null = null): NewarchV2Incident => ({ schema: 'newarch-v2', incidentId: id, pane, reason: 'storage-outage', frontier,
    affected: { after: null, through: frontier }, openedAtWallMs: 100, openedAtMonoMs: 10, clockEpoch: 'test-clock', collecting: false,
    missing: { countKind: 'unknown', missingCount: null }, ruleVersion: '1', configVersion: 'q22-default-1', geometry, revision,
    sourceEpoch: null, sourceOffset: null, expectedDigest: null, actualDigest: null, action: 'gap-and-stop', evidence: null });
  const row = (n: number, text = 'ซ้ำ'): H2.CommittedStreamRow => ({ id: { pane, segmentId: 'segment-1', rowOrdinal: n },
    origin: { kind: 'pipe', range: { epoch, start: n, end: n + 1 }, ordinal: n }, cells: [{ text, width: 1, style: [] }],
    geometry: { columns: 100, rows: 40 }, buffer: 'normal', wrapStatus: 'unwrapped', wrapPad: 0, finalized: true, uncertainFields: [], cellOrigins: [] });
  const batch = (rows: readonly H2.CommittedStreamRow[], revision = 2): H2.V2WriteCommand => {
    const checkpoint = cp(revision, rows.length, rows.at(-1)?.id ?? null);
    return { kind: 'batch', batch: { rows, decisions: [], incidents: [], checkpoint,
      input: { kind: 'synced-spool', version: 1, through: checkpoint.through, recordDigest: 'b'.repeat(64), commitId: 'input-1', segmentId: 'raw-1' } } };
  };
  const page = (maxEntries = 256, cursor: H2.NewarchV2HistoryCursor | null = null, direction: 'after' | 'before' = 'after', maxBytes = 2 * 1024 * 1024) =>
    port.reader.page({ schema: 'newarch-v2', pane, cursor, direction, maxEntries, maxBytes });
  return { root, pane, session, geometry, descriptor, cp, request, commit, ready, reserve, activate, incident, row, batch, page, open,
    get port() { return port; },
    async reopen() { h2value(await port.writer.close(port.capability)); port = h2value(await open()); return port; },
    async reload() { port = h2value(await open()); return port; },
    async cleanup() { await port.writer.close(port.capability); rmSync(root, { recursive: true, force: true }); } };
}

describe('H v2 capture-only storage', () => {
  test('capability cannot be copied; same root has one OS writer and legacy cannot reopen', async () => {
    const f = await h2fixture();
    try {
      await f.activate();
      expect((await f.port.writer.commit({ ...f.port.capability }, f.request({ kind: 'close' }, 'forged'))).status).toBe('error');
      expect(h2value(f.port.reader.owner(f.pane))!.durableRevision).toBe(1);
      expect((await f.open()).status).not.toBe('ok');
      const child = Bun.spawn([process.execPath, '-e', `import {createV2HistoryFactory} from ${JSON.stringify(join(import.meta.dir, '../src/history-engine.ts'))}; import {NEWARCH_V2_DEFAULT_CONFIG as config} from ${JSON.stringify(join(import.meta.dir, '../src/stream-contract.ts'))}; const r=await createV2HistoryFactory().openForCapture({rootId:process.argv[1],engineId:'second',config}); console.log(JSON.stringify(r.status)); if(r.status==='ok'){await r.value.writer.close(r.value.capability);process.exit(3);}` , f.root], { stdout: 'pipe', stderr: 'pipe' });
      const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, errors }).toEqual({ exit: 0, errors: '' }); expect(output).not.toContain('"ok"');
      h2value(await f.port.writer.close(f.port.capability));
      expect(() => new FlagOnHistoryStore({ root: f.root, mode: 'recover', codecVersions: ['test-v2'] })).toThrow('v2 owner excludes legacy');
    } finally { await f.cleanup(); }
  });
  test('incident before first ACK is durable, idempotent, owner never becomes legacy', async () => {
    const f = await h2fixture();
    try {
      await f.reserve();
      const gap = { ...f.incident('unrecorded', 1), reason: 'unrecorded-birth' as const };
      const command: H2.V2WriteCommand = { kind: 'unrecorded-birth', pane: f.descriptor, incident: gap };
      const request = f.request(command, 'unrecorded');
      const first = h2value(await f.port.writer.commit(f.port.capability, request));
      expect(first.frontier).toBeNull(); expect(first.checkpointId).toBeNull();
      expect(h2value(await f.port.writer.commit(f.port.capability, request))).toEqual(first);
      await f.reopen();
      const retry = f.request(command, 'unrecorded', 0);
      expect(h2value(await f.port.writer.commit(f.port.capability, retry))).toEqual(first);
      expect(h2value(await f.page()).entries).toEqual([{ kind: 'incident', incident: gap }]);
      expect(h2value(f.port.reader.owner(f.pane))!.pane.state).toBe('unrecorded');
      expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'activate', ready: f.ready, checkpoint: f.cp(2) }, 'adoption'))).status).toBe('error');
      expect(h2value(f.port.reader.sessionOwner(f.session))!.owner).toBe('capture-engine');
    } finally { await f.cleanup(); }
  });
  test('rows checkpoint and receipt commit together; lost ACK retry never duplicates', async () => {
    let fault = '';
    const f = await h2fixture({ boundary: at => { if (at === fault) throw Error('injected boundary'); } });
    try {
      await f.activate(); const command = f.batch([f.row(0), f.row(1)]), req = f.request(command, 'rows-1');
      fault = 'v2-batch-before-commit';
      expect((await f.port.writer.commit(f.port.capability, req)).status).toBe('error');
      expect(h2value(await f.page()).entries).toHaveLength(0);
      expect(h2value(f.port.reader.receipt(f.pane, 'rows-1'))).toBeNull();
      expect(h2value(f.port.reader.checkpoint(f.pane))!.revision).toBe(1);
      fault = 'v2-batch-after-commit';
      expect((await f.port.writer.commit(f.port.capability, req)).status).toBe('error');
      fault = ''; await f.reopen();
      const retry = { ...req, fence: { ...req.fence, expectedGeneration: f.port.capability.generation } };
      const receipt = h2value(await f.port.writer.commit(f.port.capability, retry));
      expect(receipt).toEqual(h2value(f.port.reader.receipt(f.pane, 'rows-1'))!);
      expect(h2value(await f.page()).entries.map(e => e.kind === 'row' && e.row.id.rowOrdinal)).toEqual([0, 1]);
      const checkpoint = h2value(f.port.reader.checkpoint(f.pane))!;
      expect(checkpoint.state.pendingUtf8).toEqual([224]); expect(checkpoint.state.pendingEscape).toEqual([27, 91]);
      expect(checkpoint.revision).toBe(receipt.revision); expect(checkpoint.frontier).toEqual(receipt.frontier);
      const stale = { ...retry, fence: { ...retry.fence, expectedGeneration: 1 } };
      expect((await f.port.writer.commit(f.port.capability, stale)).status).toBe('error');
      expect((await f.port.writer.commit(f.port.capability, f.request(f.batch([f.row(0, 'changed')]), 'rows-1'))).status).toBe('error');
    } finally { await f.cleanup(); }
  });
  test('candidate rows stay invisible and stopped pane cannot publish', async () => {
    const f = await h2fixture();
    try {
      await f.activate(); await f.commit({ kind: 'stage', transactionId: 'candidate', ordinal: 0, rows: [f.row(0)] }, 'stage');
      expect(h2value(await f.page()).entries).toEqual([]);
      await f.commit({ kind: 'stop', incident: f.incident('stop-before-rows', 3) }, 'stop');
      expect((await f.port.writer.commit(f.port.capability, f.request(f.batch([f.row(0)], 4), 'late-pump'))).status).toBe('error');
      await f.reopen(); expect(h2value(f.port.reader.owner(f.pane))!.pane.state).toBe('stopped');
      expect(h2value(await f.page()).entries).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  test('stale audit cannot repair live checkpoint; inconclusive replaces bounded latest status', async () => {
    const f = await h2fixture();
    try {
      await f.activate(); const cp = f.cp(1);
      const watermark = { pane: f.pane, through: cp.through, revision: 0, geometry: f.geometry, checkpointId: cp.checkpointId };
      const evidence: H2.V2AuditEvidence = { before: watermark, after: watermark, snapshot: watermark,
        ordering: { kind: 'certified-source-fence', certificateId: 'test-cert', proof: { path: 'synthetic-proof', bytes: 10, sha256: 'a'.repeat(64) } },
        expectedDigest: 'a'.repeat(64), actualDigest: 'b'.repeat(64), captureBytes: 40, elapsedMs: 1 };
      const result: H2.V2AuditResult = { kind: 'repair-pending', evidence, rule: cp.rule, expectedRevision: 1, checkpoint: f.cp(2),
        incident: { ...f.incident('repair', 2), collecting: true, action: 'repair-pending', reason: 'audit-mismatch' } };
      expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'audit', result }, 'stale-audit'))).status).toBe('error');
      expect(h2value(f.port.reader.checkpoint(f.pane))).toEqual(cp);
      await f.commit({ kind: 'audit', result: { kind: 'inconclusive', reason: 'timeout', retry: true } }, 'audit-timeout');
      await f.commit({ kind: 'audit', result: { kind: 'inconclusive', reason: 'racing', retry: false } }, 'audit-race');
      await f.reopen(); expect(h2value(f.port.reader.lastAudit(f.pane))).toEqual({ kind: 'inconclusive', reason: 'racing', retry: false });
      expect(h2value(f.port.reader.checkpoint(f.pane))).toEqual(cp);
    } finally { await f.cleanup(); }
  });
  test('bounded cursor is authenticated, restart stable and revision pinned', async () => {
    const f = await h2fixture();
    try {
      await f.activate(); await f.commit(f.batch([f.row(0), f.row(1), f.row(2)]), 'rows');
      const first = h2value(await f.page(1)); expect(first.entries).toHaveLength(1); expect(first.after.kind).toBe('more');
      if (first.after.kind !== 'more') throw Error('missing cursor'); const cursor = first.after.cursor;
      await f.reopen(); const second = h2value(await f.page(1, cursor));
      expect(second.entries[0]!.kind === 'row' && second.entries[0]!.row.id.rowOrdinal).toBe(1);
      expect((await f.page(1, { ...cursor, token: cursor.token + '0' })).status).toBe('error');
      expect((await f.page(1, { ...cursor, timelineRevision: 9000 })).status).toBe('error');
      expect((await f.page(1, null, 'after', 3)).status).toBe('error');
      const back = h2value(await f.page(2, null, 'before'));
      expect(back.entries.map(e => e.kind === 'row' && e.row.id.rowOrdinal)).toEqual([1, 2]);
      expect(h2value(f.port.reader.panes(f.session, null)).panes).toEqual([f.descriptor]);
    } finally { await f.cleanup(); }
  });
  test('missing source authority and mismatched geometry fail before publication', async () => {
    const f = await h2fixture({ inputReceipt: () => ({ status: 'ok', value: null }) });
    try {
      await f.reserve();
      expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'activate', ready: { ...f.ready, geometryReadback: { columns: 99, rows: 40 } }, checkpoint: f.cp(1) }, 'bad-geometry'))).status).toBe('error');
      await f.commit({ kind: 'activate', ready: f.ready, checkpoint: f.cp(1) }, 'activate');
      expect((await f.port.writer.commit(f.port.capability, f.request(f.batch([f.row(0)]), 'forged-ack'))).status).toBe('error');
      expect(h2value(await f.page()).entries).toEqual([]);
    } finally { await f.cleanup(); }
  });
  test('cancelled birth keeps session exclusion and cannot activate', async () => {
    const f = await h2fixture();
    try {
      await f.reserve();
      const body = { session: f.session, birthOperationId: 'birth-1', operationId: 'cancel-1', reason: 'binding' as const };
      const req = { ...body, expectedGeneration: f.port.capability.generation, digest: H2.v2Digest('birth-cancel', body) };
      const receipt = h2value(await f.port.writer.cancelBirth(f.port.capability, req));
      expect(h2value(await f.port.writer.cancelBirth(f.port.capability, req))).toEqual(receipt);
      expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'activate', ready: f.ready, checkpoint: f.cp(1) }, 'bad-activate'))).status).toBe('error');
      await f.reopen(); expect(h2value(f.port.reader.sessionOwner(f.session))!.owner).toBe('capture-engine');
    } finally { await f.cleanup(); }
  });
});


test('H v2 SIGKILL before and after transaction keeps rows checkpoint receipt in one boundary', async () => {
  for (const phase of ['v2-batch-before-write', 'v2-batch-before-commit', 'v2-batch-after-commit']) {
    const f = await h2fixture();
    try {
      await f.activate(); const command = f.batch([f.row(0)]);
      h2value(await f.port.writer.close(f.port.capability));
      const script = `import {createV2HistoryFactory} from ${JSON.stringify(join(import.meta.dir, '../src/history-engine.ts'))};
        import {NEWARCH_V2_DEFAULT_CONFIG as config,v2WriteDigest} from ${JSON.stringify(join(import.meta.dir, '../src/stream-contract.ts'))};
        const r=await createV2HistoryFactory({inputReceipt:ack=>({status:'ok',value:ack}),boundary:at=>{if(at===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL')}}).openForCapture({rootId:process.argv[1],engineId:'kill-capture',config});
        if(r.status!=='ok')throw Error(JSON.stringify(r)); const {writer,capability}=r.value;
        const command=${JSON.stringify(command)},fence={pane:${JSON.stringify(f.pane)},operationId:'kill-batch',expectedGeneration:capability.generation,expectedRevision:1};
        const result=await writer.commit(capability,{fence:{...fence,digest:v2WriteDigest({fence,command})},command}); console.error(JSON.stringify(result));process.exit(9);`;
      const child = Bun.spawn([process.execPath, '-e', script, f.root], { stdout: 'pipe', stderr: 'pipe' });
      const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(output).toBe(''); expect(exit).not.toBe(0); expect(exit).not.toBe(9);
      await f.reload();
      const committed = phase.endsWith('after-commit');
      expect(h2value(await f.page()).entries.length).toBe(committed ? 1 : 0);
      expect(h2value(f.port.reader.checkpoint(f.pane))!.revision).toBe(committed ? 2 : 1);
      expect(h2value(f.port.reader.receipt(f.pane, 'kill-batch')) !== null).toBe(committed);
      await f.commit(command, 'kill-batch');
      expect(h2value(await f.page()).entries.length).toBe(1);
      console.log('H_V2_KILL_BARRIER', JSON.stringify({ phase, committed, rowsAfterRetry: 1 }));
    } finally { await f.cleanup(); }
  }
});

test('H v2 quality annotation covers published rows even through an older cursor', async () => {
  const f = await h2fixture();
  try {
    await f.activate(); await f.commit(f.batch([f.row(0), f.row(1)]), 'rows');
    const first = h2value(await f.page(1)); if (first.after.kind !== 'more') throw Error('cursor missing');
    const incident = { ...f.incident('geometry-quality', 3, f.row(1).id), reason: 'geometry-violation' as const };
    await f.commit({ kind: 'stop', incident }, 'geometry-stop');
    await f.reopen(); const page = h2value(await f.page(1, first.after.cursor));
    expect(page.entries).toHaveLength(1);
    expect(page.states).toContainEqual({ kind: 'incident', incident });
    expect(page.states.some(s => s.kind === 'exact')).toBe(false);
  } finally { await f.cleanup(); }
});

test('H v2 seal locator pin reclaim use one writer and interrupted cleanup retries safely', async () => {
  let verified = false, killCleanup = false, restore: H2.CommittedStreamRow | null = null;
  const f = await h2fixture({ remoteReadback: () => verified, remoteRow: () => ({ status: 'ok', value: restore }), boundary: at => {
    if (killCleanup && at === 'v2-reclaim-after-unlink') throw Error('injected cleanup interruption');
  } });
  try {
    await f.activate(); await f.commit(f.batch([f.row(0), f.row(1)]), 'rows');
    const cursorPage = h2value(await f.page(1)); if (cursorPage.after.kind !== 'more') throw Error('cursor missing');
    const sealReceipt = await f.commit({ kind: 'seal', segmentId: 'segment-1' }, 'seal');
    const seal = h2value(f.port.reader.sealed(f.pane, sealReceipt.commitId))!;
    await f.commit({ kind: 'materialize-export', sealCommitId: sealReceipt.commitId }, 'export');
    const exported = h2value(f.port.reader.export(f.pane, 'export'))!;
    const sources = [...exported.files, exported.manifest];
    const members = sources.map((file, i) => ({ ...file, path: 'member-' + i }));
    const manifest = { objectKey: 'synthetic/manifest', bytes: 20, sha256: 'a'.repeat(64) };
    const inventory: H2.ArchiveInventoryR2 = { revision: 2, sealGeneration: seal.sealGeneration, sealCommitId: seal.sealCommitId,
      sealManifestSha256: exported.manifest.sha256, bundleManifestSha256: manifest.sha256,
      members: sources.map((file, i) => ({ sourcePath: file.path, relativePath: members[i]!.path, bytes: file.bytes, sha256: file.sha256 })) };
    const bundle: H2.ArchiveBundle = { version: 1, bundleId: 'remote-test', storeUUID: exported.storeUUID, pane: f.pane,
      segmentId: 'segment-1', coverage: seal.coverage, schemaVersions: { newarch: 2 }, objects: [manifest], manifest, members,
      compression: 'tar.zst', encryption: 'none', checkpointIds: seal.checkpointIds, rawRanges: seal.rawRanges };
    const locator: H2.V2RemoteLocator = { pane: f.pane, segmentId: 'segment-1', sealed: seal, inventory,
      readerProof: { digest: seal.coverage[0]!.digest, verifiedAtWallMs: 123, first: f.row(0).id, last: f.row(1).id },
      verified: { kind: 'verified-remote', bundle, verificationId: 'verified-1', method: 'download-sha256', verifiedAtMonoMs: 100,
        clockEpoch: 'test', inventoryDigest: H2.archiveInventoryDigest(inventory), evidence: [exported.manifest], toolVersion: 'test',
        command: ['simulated-readback'], stdout: exported.manifest, stderr: exported.manifest, exitCode: 0 } };
    expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'locator', locator }, 'unverified'))).status).toBe('error');
    expect(h2value(await f.page()).entries).toHaveLength(2);
    verified = true; const located = await f.commit({ kind: 'locator', locator }, 'locator');
    await f.commit({ kind: 'pin', pinId: 'reader-pin', segmentId: 'segment-1' }, 'pin');
    const reclaim: H2.V2WriteCommand = { kind: 'reclaim', locatorCommitId: located.commitId, segmentId: 'segment-1' };
    expect((await f.port.writer.commit(f.port.capability, f.request(reclaim, 'reclaim'))).status).toBe('error');
    expect(h2value(await f.page()).entries).toHaveLength(2);
    await f.commit({ kind: 'release-pin', pinId: 'reader-pin' }, 'release');
    killCleanup = true;
    expect((await f.port.writer.commit(f.port.capability, f.request(reclaim, 'reclaim'))).status).toBe('error');
    expect(h2value(f.port.reader.receipt(f.pane, 'reclaim'))).not.toBeNull();
    killCleanup = false; await f.reopen(); await f.commit(reclaim, 'reclaim');
    expect(sources.every(file => !existsSync(file.path))).toBe(true);
    const remote = h2value(await f.page(1, cursorPage.after.cursor));
    expect(remote.entries).toEqual([]); expect(remote.after.kind).toBe('blocked');
    expect(remote.states[0]!.kind).toBe('remote-unavailable');
    expect(h2value(f.port.reader.locator(f.pane, located.commitId))).toEqual(locator);
    restore = f.row(1); const restored = h2value(await f.page(1, cursorPage.after.cursor));
    expect(restored.entries).toEqual([{ kind: 'row', row: restore }]); expect(restored.after.kind).toBe('end');
    restore = f.row(1, 'corrupt'); const corrupt = h2value(await f.page(1, cursorPage.after.cursor));
    expect(corrupt.after.kind).toBe('blocked'); expect(corrupt.states).toContainEqual({ kind: 'remote-unavailable', bundleId: 'remote-test', reason: 'corrupt', retryAfterMs: 1000 });
  } finally { await f.cleanup(); }
});

test('H v2 two windows in one session have distinct owners, checkpoints and timelines', async () => {
  const f = await h2fixture();
  try {
    await f.activate();
    const remap = <T>(x: T): T => JSON.parse(JSON.stringify(x).replaceAll('%1', '%2').replaceAll('@1', '@2').replaceAll('birth-1', 'birth-2'));
    const ready = remap(f.ready), cp = remap(f.cp(1));
    const intent = { ...ready.intent, command: 'new-window' as const };
    h2value(await f.port.writer.reserveBirth(f.port.capability, { intent, expectedGeneration: f.port.capability.generation, digest: H2.v2Digest('birth-reservation', { intent }) }));
    const command: H2.V2WriteCommand = { kind: 'activate', ready: { ...ready, intent }, checkpoint: cp };
    const fence = { pane: ready.pane.pane, operationId: 'activate-2', expectedGeneration: f.port.capability.generation, expectedRevision: 0 };
    h2value(await f.port.writer.commit(f.port.capability, { fence: { ...fence, digest: H2.v2WriteDigest({ fence, command }) }, command }));
    await f.commit({ kind: 'stop', incident: f.incident('pane-one-stopped', 2) }, 'stop-1');
    await f.reopen();
    const panes = h2value(f.port.reader.panes(f.session, null)).panes;
    expect(panes.map(p => [p.pane.paneId, p.state])).toEqual([['%1', 'stopped'], ['%2', 'active']]);
    expect(h2value(f.port.reader.checkpoint(ready.pane.pane))!.pane).toEqual(ready.pane.pane);
    expect(h2value(await f.port.reader.page({ schema: 'newarch-v2', pane: ready.pane.pane, cursor: null, direction: 'after', maxEntries: 10, maxBytes: 10240 })).entries).toEqual([]);
    expect(h2value(await f.page()).entries).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('H v2 new-window cannot adopt a legacy session and activation binds the exact source epoch', async () => {
  const f = await h2fixture();
  try {
    const intent = { ...f.ready.intent, command: 'new-window' as const };
    expect((await f.port.writer.reserveBirth(f.port.capability, { intent, expectedGeneration: f.port.capability.generation, digest: H2.v2Digest('birth-reservation', { intent }) })).status).toBe('error');
    expect(h2value(f.port.reader.sessionOwner(f.session))).toBeNull();
    await f.reserve(); const cp = f.cp(1), epoch = { ...cp.through.epoch, collectorIncarnation: 'foreign-collector' };
    const bad = { ...cp, through: { epoch, byteOffset: 0 }, replayFloor: { epoch, byteOffset: 0 } };
    expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'activate', ready: f.ready, checkpoint: bad }, 'wrong-epoch'))).status).toBe('error');
    expect(h2value(f.port.reader.owner(f.pane))).toBeNull();
    await f.commit({ kind: 'activate', ready: f.ready, checkpoint: cp }, 'right-epoch');
    expect(h2value(f.port.reader.checkpoint(f.pane))).toEqual(cp);
  } finally { await f.cleanup(); }
});

test('H v2 ordered audit repairs only pending and disabled or stale evidence never writes', async () => {
  const f = await h2fixture();
  try {
    await f.activate(); const old = f.cp(1), cp = f.cp(2);
    const watermark = { pane: f.pane, through: old.through, revision: 1, geometry: f.geometry, checkpointId: old.checkpointId };
    const evidence: H2.V2AuditEvidence = { before: watermark, after: watermark, snapshot: watermark,
      ordering: { kind: 'certified-source-fence', certificateId: 'ordered', proof: { path: '/synthetic/proof', bytes: 1, sha256: 'a'.repeat(64) } },
      expectedDigest: 'a'.repeat(64), actualDigest: 'b'.repeat(64), captureBytes: 1, elapsedMs: 1 };
    const incident = { ...f.incident('pending-repair', 2), action: 'repair-pending' as const, collecting: true, reason: 'audit-mismatch' as const };
    const result: H2.V2AuditResult = { kind: 'repair-pending', evidence, rule: old.rule, expectedRevision: 1, checkpoint: cp, incident };
    await f.commit({ kind: 'audit', result }, 'repair');
    expect(h2value(f.port.reader.checkpoint(f.pane))).toEqual(cp);
    expect(h2value(await f.page()).entries).toEqual([{ kind: 'incident', incident }]);
    expect((await f.port.writer.commit(f.port.capability, f.request({ kind: 'audit', result }, 'late-repair'))).status).toBe('error');
    await f.commit({ kind: 'audit', result: { kind: 'inconclusive', reason: 'disabled', retry: false } }, 'disabled');
    expect(h2value(f.port.reader.checkpoint(f.pane))).toEqual(cp);
  } finally { await f.cleanup(); }
});
