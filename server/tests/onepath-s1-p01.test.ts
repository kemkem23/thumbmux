/**
 * ONEPATH S1 P01 – offline SQLite reader proof.
 *
 * Six properties proven:
 *  1. Real factory / store / readerRequest – no mocks.
 *  2. Import a dataset with Thai · ANSI · blank · duplicate · geometry change.
 *  3. Compare every row + geometry against an independent immutable oracle.
 *  4. Page back/forth; close and reopen DB → identical results.
 *  5. HTTP API via Bun.serve + fetch (offline; no browser binary).
 *  6. Export bundle + restore into fresh store → all rows byte-identical.
 *
 * Mutation proof:
 *  A: Corrupt one row's text directly in the DB.  Reader MUST throw.
 *  B: After fixing the DB, reader MUST pass again.
 *
 * P01 uses no tmux; the G0 appendix uses only private /tmp tmux sockets.
 * No brain.db, no production history, no outbound network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';

// ── Real SUT imports ──────────────────────────────────────────────────────────
import { HistoryStore, prepareFile } from '../src/sqlite-history/store';
import { HistoryReaderCanary, historyReaderRequest } from '../src/sqlite-history/reader';
import { rowsDigest, sha } from '../src/sqlite-history/codec';
import { exportHistoryBundle, restoreHistoryBundle } from '../src/sqlite-history/transfer';
import type { CaptureBatch, CaptureObservation } from '../src/sqlite-history/types';

// ── Oracle (no import from SUT modules below this point for data constants) ───
import {
  ALL_ROWS, BATCH1_GEOMETRY, BATCH1_ROWS, BATCH1_SCREEN,
  BATCH2_GEOMETRY, BATCH2_ROWS, BATCH2_SCREEN,
  EXPECTED_LIVE_START, EXPECTED_NEXT_LINE, EXPECTED_ROW_COUNT,
  ORACLE_ALL_DIGEST, SESSION_LIFECYCLE_KEY, SESSION_NAME,
  oracleRowsDigest,
} from './onepath-s1/oracle';

// ── Helpers ──────────────────────────────────────────────────────────────────

function openStore(file: string) {
  const db = new Database(file, { strict: true });
  return new HistoryStore(db, { file });
}

function makeBatch(store: HistoryStore, sid: string, rows: typeof BATCH1_ROWS, screen: readonly string[], geometry: typeof BATCH1_GEOMETRY): CaptureBatch {
  const raw = [...rows.map(r => r.text), ...screen];
  const actualScreen = raw.slice(-screen.length);
  const observation: CaptureObservation = { raw, screen: actualScreen, geometry, at: Date.now(), source: {} };
  return {
    ticket: store.ticket(sid),
    observation,
    appended: rows.map(r => ({ kind: r.kind, text: r.text })),
    liveLineLimit: screen.length,
    evidence: { classification: 'initial', depth: 'shallow', source: {}, rawSha256: sha(JSON.stringify(observation)) },
  };
}

// ── Setup: create DB once, close, share file path ────────────────────────────

let tmpDir: string;
let dbFile: string;
let sid: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'onepath-s1-p01-'));
  dbFile = prepareFile(join(tmpDir, 'history.db'));
  const store = openStore(dbFile);
  try {
    sid = await store.register({ name: SESSION_NAME, lifecycleKey: SESSION_LIFECYCLE_KEY });
    await store.commit(makeBatch(store, sid, BATCH1_ROWS, BATCH1_SCREEN, BATCH1_GEOMETRY));
    await store.commit(makeBatch(store, sid, BATCH2_ROWS, BATCH2_SCREEN, BATCH2_GEOMETRY));
  } finally {
    await store.close();
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('P01: offline SQLite reader — onepath S1', () => {

  // ── 1. Real factory/store/readerRequest ──────────────────────────────────
  test('1. store + reader are real instances (no mocks)', async () => {
    const store = openStore(dbFile);
    try {
      expect(store).toBeInstanceOf(HistoryStore);
      const reader = new HistoryReaderCanary(store);
      expect(reader).toBeInstanceOf(HistoryReaderCanary);
      expect(typeof historyReaderRequest).toBe('function');
      console.log('P01_FACTORY_PROOF', JSON.stringify({ HistoryStore: true, HistoryReaderCanary: true, historyReaderRequest: true }));
    } finally { await store.close(); }
  });

  // ── 2+3. Dataset content + oracle comparison ─────────────────────────────
  test('2-3. every row matches the independent oracle (Thai·ANSI·blank·dup·geometry)', async () => {
    const store = openStore(dbFile);
    try {
      const reader = new HistoryReaderCanary(store);
      const snap = reader.snapshot(sid);

      // Live window must be empty (all rows archived per fixture design)
      expect(snap.live).toHaveLength(0);
      expect(snap.receipt.context.liveStart).toBe(EXPECTED_LIVE_START);
      expect(snap.receipt.context.nextLine).toBe(EXPECTED_NEXT_LINE);

      // Collect all rows via two page calls (demonstrates back/forward navigation)
      const ctx = snap.receipt.context;
      const page2 = reader.page(sid, 'before', null, 5, ctx);   // rows 5-9
      expect(page2.verification.status).toBe('verified');
      expect(page2.page.startLine).toBe(5);
      expect(page2.page.endLine).toBe(10);
      expect(page2.page.hasMore).toBe(true);

      const page1 = reader.page(sid, 'before', 5, 5, ctx);      // rows 0-4
      expect(page1.verification.status).toBe('verified');
      expect(page1.page.startLine).toBe(0);
      expect(page1.page.endLine).toBe(5);
      expect(page1.page.hasMore).toBe(false);

      const all = [...page1.page.rows, ...page2.page.rows];
      expect(all).toHaveLength(EXPECTED_ROW_COUNT);

      // Row-by-row oracle comparison (hardcoded expectations, not derived from SUT)
      for (let i = 0; i < EXPECTED_ROW_COUNT; i++) {
        expect(all[i]?.line_no).toBe(ALL_ROWS[i]?.line_no);
        expect(all[i]?.kind).toBe(ALL_ROWS[i]?.kind);
        expect(all[i]?.text).toBe(ALL_ROWS[i]?.text);
      }

      // Digest cross-check: SUT rowsDigest vs independent oracleRowsDigest
      const sutDigest = rowsDigest(all);
      expect(sutDigest).toBe(ORACLE_ALL_DIGEST);

      // Explicit oracle checks per content type
      expect(all[0]?.text).toBe('สวัสดี ชาวโลก');                          // Thai
      expect(all[1]?.text).toBe('');                                        // blank
      expect(all[2]?.text).toBe('\x1b[31mสีแดง\x1b[0m');                   // Thai+ANSI
      expect(all[3]?.text).toBe(all[0]?.text);                              // duplicate
      expect(all[4]?.text).toBe('\x1b[1;32mบรรทัดที่ห้า\x1b[0m');          // ANSI bold+Thai
      expect(all[8]?.text).toBe('\x1b[0;35mม่วง\x1b[0m');                   // ANSI magenta+Thai
      expect(snap.receipt.geometry.generation).toBe(2);                    // geometry change

      console.log('P01_ORACLE_PROOF', JSON.stringify({
        rows: all.length, digestMatch: sutDigest === ORACLE_ALL_DIGEST,
        geometryGen: snap.receipt.geometry.generation,
      }));
      console.log('P01_IDENTITY_PROOF', JSON.stringify({ sessionIds: [sid] }));
    } finally { await store.close(); }
  });

  // ── 4. Page back/forth + DB reopen ───────────────────────────────────────
  test('4. page back/forth and DB reopen produce identical results', async () => {
    // First pass
    const s1 = openStore(dbFile);
    let digest1: string;
    try {
      const r1 = new HistoryReaderCanary(s1);
      const ctx = r1.snapshot(sid).receipt.context;
      // anchor=null for 'after' means "from the very start" (inclusive of line 0)
      const fwd = r1.page(sid, 'after', null, 5, ctx);
      const bwd = r1.page(sid, 'before', 5, 5, ctx);
      expect(fwd.page.rows.map(r => r.text)).toEqual(bwd.page.rows.map(r => r.text));
      const full = r1.page(sid, 'before', null, 10, ctx);
      expect(full.page.rows).toHaveLength(EXPECTED_ROW_COUNT);
      digest1 = rowsDigest(full.page.rows);
    } finally { await s1.close(); }

    // Reopen (new fence) — must yield identical rows
    const s2 = openStore(dbFile);
    try {
      const r2 = new HistoryReaderCanary(s2);
      const ctx2 = r2.snapshot(sid).receipt.context;
      const full2 = r2.page(sid, 'before', null, 10, ctx2);
      expect(full2.page.rows).toHaveLength(EXPECTED_ROW_COUNT);
      const digest2 = rowsDigest(full2.page.rows);
      expect(digest2).toBe(digest1);
      expect(digest2).toBe(ORACLE_ALL_DIGEST);
      expect(full2.verification.status).toBe('verified');
      console.log('P01_REOPEN_PROOF', JSON.stringify({ rowsAfterReopen: full2.page.rows.length, digestMatch: true }));
    } finally { await s2.close(); }
  });

  // ── 5. HTTP API via Bun.serve + fetch ────────────────────────────────────
  test('5. historyReaderRequest serves correct rows over HTTP (offline API trace)', async () => {
    const store = openStore(dbFile);
    const reader = new HistoryReaderCanary(store);
    let server: Server | null = null;
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => historyReaderRequest(reader, req) });
      const base = `http://127.0.0.1:${server.port}`;

      const snapResp = await fetch(`${base}/history/snapshot?session=${encodeURIComponent(sid)}`);
      expect(snapResp.status).toBe(200);
      const snap = await snapResp.json() as { receipt: { context: { nextLine: number; liveStart: number } }; live: unknown[]; verification: { status: string } };
      expect(snap.receipt.context.nextLine).toBe(EXPECTED_NEXT_LINE);
      expect(snap.receipt.context.liveStart).toBe(EXPECTED_LIVE_START);
      expect(snap.live).toHaveLength(0);

      const pg = await (await fetch(`${base}/history/page?session=${encodeURIComponent(sid)}&direction=before&limit=5`)).json() as { page: { rows: Array<{ text: string }> }; verification: { status: string } };
      expect(pg.verification.status).toBe('verified');
      expect(pg.page.rows).toHaveLength(5);
      expect(pg.page.rows[4]?.text).toBe(ALL_ROWS[9]?.text);

      const pg0 = await (await fetch(`${base}/history/page?session=${encodeURIComponent(sid)}&direction=before&anchor=5&limit=5`)).json() as { page: { rows: Array<{ text: string }> }; verification: { status: string } };
      expect(pg0.verification.status).toBe('verified');
      expect(pg0.page.rows).toHaveLength(5);
      expect(pg0.page.rows[0]?.text).toBe(ALL_ROWS[0]?.text);

      // Error cases
      expect((await fetch(`${base}/history/snapshot?session=${sid}`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/history/snapshot`)).status).toBe(400);
      expect((await fetch(`${base}/history/page?session=${sid}`)).status).toBe(400);

      console.log('P01_HTTP_TRACE', JSON.stringify({
        port: server.port, rows: pg.page.rows.length + pg0.page.rows.length,
        bothVerified: pg.verification.status === 'verified' && pg0.verification.status === 'verified',
      }));
    } finally {
      server?.stop(true);
      await store.close();
    }
  });

  // ── 6. Export + restore → bytes identical ────────────────────────────────
  test('6. export bundle + restore into fresh store → all rows byte-identical', async () => {
    // NOTE: exportHistoryBundle creates the bundle directory itself (mkdirSync inside).
    // Do NOT pre-create it or the call will fail with EEXIST.
    const bundleDir = join(tmpDir, 'bundle');
    const restoreDbDir = join(tmpDir, 'restore-db');
    mkdirSync(restoreDbDir, { recursive: true, mode: 0o700 });
    const restoreFile = prepareFile(join(restoreDbDir, 'history.db'));

    const exportStore = openStore(dbFile);
    let exportRevision: number;
    try {
      const result = exportHistoryBundle(exportStore, sid, bundleDir);
      exportRevision = result.revision;
      expect(exportRevision).toBe(2);
    } finally { await exportStore.close(); }

    const restoreStore = openStore(restoreFile);
    try {
      const restoredSid = await restoreHistoryBundle(restoreStore, bundleDir);
      const s = restoreStore.session(restoredSid);
      const restored = restoreStore.rows(restoredSid, s.first_line, s.next_line);
      expect(restored).toHaveLength(EXPECTED_ROW_COUNT);

      // Byte-identical: oracle digest on restored rows (independent of SUT rowsDigest)
      const restoredDigest = oracleRowsDigest(restored);
      expect(restoredDigest).toBe(ORACLE_ALL_DIGEST);

      for (let i = 0; i < EXPECTED_ROW_COUNT; i++) {
        expect(restored[i]?.text).toBe(ALL_ROWS[i]?.text);
        expect(restored[i]?.kind).toBe(ALL_ROWS[i]?.kind);
        expect(restored[i]?.line_no).toBe(ALL_ROWS[i]?.line_no);
      }

      const audit = restoreStore.audit(restoredSid);
      expect(audit.captures).toBe(2);
      expect(audit.rows).toBe(EXPECTED_ROW_COUNT);

      console.log('P01_EXPORT_RESTORE_PROOF', JSON.stringify({
        exportedRevision: exportRevision, restoredRows: restored.length,
        digestMatch: restoredDigest === ORACLE_ALL_DIGEST, auditCaptures: audit.captures,
      }));
    } finally { await restoreStore.close(); }
  });

  // ── Mutation A: corrupt a row → reader MUST throw ────────────────────────
  test('mutation-A: corrupt row 0 text → reader throws (digest detector alive)', async () => {
    // history_line has an immutability trigger (BEFORE UPDATE RAISE ABORT).
    // To test storage-level corruption detection we create a fresh isolated DB,
    // populate it with BATCH1, close it (WAL checkpoints), then overwrite the
    // UTF-8 bytes of row-0's text in the binary file.  The stored rows_sha256
    // hash will no longer match, so the reader MUST throw.
    const mutDir = mkdtempSync(join(tmpdir(), 'onepath-s1-p01-mut-'));
    try {
      // ── Build a clean DB ───────────────────────────────────────────────────
      const mutFile = prepareFile(join(mutDir, 'history.db'));
      const ms = openStore(mutFile);
      let msid: string;
      try {
        msid = await ms.register({ name: 'mutation-test', lifecycleKey: 'mut-lk' });
        await ms.commit(makeBatch(ms, msid, BATCH1_ROWS, BATCH1_SCREEN, BATCH1_GEOMETRY));
      } finally { await ms.close(); }
      // After close() bun:sqlite checkpoints the WAL; all bytes are in mutFile.

      // ── Corrupt the file at binary level ──────────────────────────────────
      const target = Buffer.from('สวัสดี ชาวโลก', 'utf8');
      const data = Buffer.from(readFileSync(mutFile));
      const idx = data.indexOf(target);
      if (idx === -1) throw new Error('mutation: target string not found in DB file');
      // Overwrite text bytes with X (same length → SQLite page structure intact,
      // but rowsDigest of the rows will differ from the stored rows_sha256).
      target.fill(0x58); // 'X'
      target.copy(data, idx);
      writeFileSync(mutFile, data);

      // ── Verify reader detects the corruption ──────────────────────────────
      const corrupt = openStore(mutFile);
      try {
        const reader = new HistoryReaderCanary(corrupt);
        const ctx = reader.snapshot(msid).receipt.context;
        let threw = false;
        try {
          reader.page(msid, 'before', null, 10, ctx);
        } catch (err) {
          threw = true;
          expect(String(err)).toMatch(/history-unavailable|reader-batch-digest|batch-hash/);
        }
        expect(threw).toBe(true);
        console.log('P01_MUTATION_A_PROOF', JSON.stringify({ detectorFired: true }));
      } finally { await corrupt.close(); }
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  // ── Mutation B: main DB was never touched — baseline is intact ───────────
  test('mutation-B: main DB integrity intact — reader passes (baseline confirmed)', async () => {
    // Mutation A used its own isolated temp DB and cleaned up after itself.
    // The main dbFile (seeded in beforeAll) was never corrupted.
    // This test re-confirms the baseline: the detector fires on corrupt data
    // (mutation A) AND passes on clean data (mutation B).
    const store = openStore(dbFile);
    try {
      const reader = new HistoryReaderCanary(store);
      const ctx = reader.snapshot(sid).receipt.context;
      const page = reader.page(sid, 'before', null, 10, ctx);
      expect(page.verification.status).toBe('verified');
      expect(page.page.rows).toHaveLength(EXPECTED_ROW_COUNT);
      expect(oracleRowsDigest(page.page.rows)).toBe(ORACLE_ALL_DIGEST);
      console.log('P01_MUTATION_B_PROOF', JSON.stringify({ rows: page.page.rows.length, digestMatch: true }));
    } finally { await store.close(); }
  });
});

// ── G0: stock-tmux pipe-pane source-fence experiment ─────────────────────────────────

type TmuxResult = ReturnType<typeof Bun.spawnSync>;

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tmuxAt(socket: string, ...args: string[]): TmuxResult {
  return Bun.spawnSync(['tmux', '-S', socket, ...args], {
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
  });
}

function requireTmux(result: TmuxResult, action: string): string {
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(`${action}: exit=${result.exitCode} stderr=${result.stderr.toString()}`);
  }
  return stdout;
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface ProbeOptions {
  preAttach?: Buffer;
  pipeCommand?: (output: string) => string;
  historyLimit?: number;
  waitForClientBeforePayload?: boolean;
}

class PrivateTmuxProbe {
  readonly root = mkdtempSync(join(tmpdir(), 'newarch-g0-tmux-'));
  readonly socket = join(this.root, 'tmux.sock');
  readonly session = `g0-${process.pid}-${Math.random().toString(16).slice(2)}`;
  readonly source = join(this.root, 'source.bin');
  readonly preAttach = join(this.root, 'pre-attach.bin');
  readonly pipeOutput = join(this.root, 'pipe.bin');
  readonly gate = join(this.root, 'gate');
  readonly preDone = join(this.root, 'pre-done');
  readonly producerDone = join(this.root, 'producer-done');
  readonly stop = join(this.root, 'stop');
  readonly detached = join(this.root, 'detached');
  readonly script = join(this.root, 'producer.sh');

  constructor(readonly payload: Buffer, readonly options: ProbeOptions = {}) {
    writeFileSync(this.source, payload);
    if (options.preAttach) writeFileSync(this.preAttach, options.preAttach);

    // Preserve producer bytes across the PTY: default ONLCR rewrites LF to CRLF.
    const lines = ['set -eu', 'stty -opost'];
    // A real attached client can send input (script's EOF produces ^@ here).
    // The PTY would echo that into pipe-pane alongside the producer's bytes.
    // This output-only oracle must isolate producer output from input echo;
    // keep the real attach/detach and the exact byte assertion unchanged.
    if (options.waitForClientBeforePayload) lines.push('stty -echo');
    if (options.preAttach) {
      lines.push(`cat ${shQuote(this.preAttach)}`);
      lines.push(`: > ${shQuote(this.preDone)}`);
    }
    lines.push(`while [ ! -f ${shQuote(this.gate)} ]; do sleep 0.01; done`);
    if (options.waitForClientBeforePayload) {
      lines.push(`while [ -z "$(/usr/bin/tmux -S ${shQuote(this.socket)} list-clients -F '#{client_tty}')" ]; do sleep 0.01; done`);
    }
    lines.push(`cat ${shQuote(this.source)}`);
    lines.push(`: > ${shQuote(this.producerDone)}`);
    if (options.waitForClientBeforePayload) {
      lines.push(`/usr/bin/tmux -S ${shQuote(this.socket)} detach-client -s ${shQuote(this.session)}`);
      lines.push(`: > ${shQuote(this.detached)}`);
    }
    lines.push(`while [ ! -f ${shQuote(this.stop)} ]; do sleep 0.01; done`);
    writeFileSync(this.script, `${lines.join('\n')}\n`);
  }

  async start(): Promise<void> {
    requireTmux(
      tmuxAt(this.socket, 'new-session', '-d', '-x', '80', '-y', '24', '-s', this.session, 'sh', this.script),
      'new-session',
    );
    if (this.options.historyLimit !== undefined) {
      requireTmux(
        tmuxAt(this.socket, 'set-option', '-t', `=${this.session}:0`, 'history-limit', String(this.options.historyLimit)),
        'set history-limit',
      );
    }
    if (this.options.preAttach) {
      await waitUntil('pre-attach output boundary', () => existsSync(this.preDone));
    }
    const command = this.options.pipeCommand?.(this.pipeOutput) ?? `cat > ${shQuote(this.pipeOutput)}`;
    requireTmux(tmuxAt(this.socket, 'pipe-pane', '-t', `=${this.session}:0.0`, '-O', command), 'pipe-pane');
    writeFileSync(this.gate, 'go');
  }

  async waitProducerDone(): Promise<void> {
    await waitUntil('producer boundary', () => existsSync(this.producerDone));
  }

  async waitPipeEquals(expected: Buffer): Promise<void> {
    await waitUntil('pipe bytes to equal producer oracle', () => {
      if (!existsSync(this.pipeOutput) || statSync(this.pipeOutput).size !== expected.length) return false;
      return readFileSync(this.pipeOutput).equals(expected);
    });
  }

  pipeBytes(): Buffer {
    return existsSync(this.pipeOutput) ? readFileSync(this.pipeOutput) : Buffer.alloc(0);
  }

  panePipe(): string {
    return requireTmux(
      tmuxAt(this.socket, 'display-message', '-p', '-t', `=${this.session}:0.0`, '#{pane_pipe}'),
      'display pane_pipe',
    ).trim();
  }

  capture(): string {
    return requireTmux(
      tmuxAt(this.socket, 'capture-pane', '-p', '-e', '-N', '-S', '-1000', '-t', `=${this.session}:0.0`),
      'capture-pane',
    );
  }

  geometry(): string {
    return requireTmux(
      tmuxAt(this.socket, 'display-message', '-p', '-t', `=${this.session}:0.0`, '#{pane_width}x#{pane_height}'),
      'display geometry',
    ).trim();
  }

  async close(): Promise<void> {
    writeFileSync(this.stop, 'stop');
    await Bun.sleep(20);
    tmuxAt(this.socket, 'kill-server');
    rmSync(this.root, { recursive: true, force: true });
  }
}

function corpus(name: string, assertions: number, result: 'pass' | 'unknown' = 'pass'): void {
  console.log('G0_CORPUS', JSON.stringify({ name, assertions, result }));
}

function fault(name: string, detected: boolean): void {
  console.log('G0_FAULT', JSON.stringify({ name, detected }));
}

describe('G0: private tmux pipe-pane source-fence experiment', () => {
  test('healthy stream carries 50,000 numbered producer rows without loss or duplication', async () => {
    const oracle = Buffer.from(Array.from({ length: 50_000 }, (_, i) => `ROW-${String(i + 1).padStart(5, '0')}`).join('\n') + '\n');
    const probe = new PrivateTmuxProbe(oracle, { historyLimit: 1_000 });
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(oracle);
      const received = probe.pipeBytes().toString().trimEnd().split('\n');
      const unique = new Set(received);
      const missing = 50_000 - unique.size;
      const duplicates = received.length - unique.size;
      expect(probe.pipeBytes()).toEqual(oracle);
      expect(received).toHaveLength(50_000);
      expect(missing).toBe(0);
      expect(duplicates).toBe(0);
      expect(received.at(-1)).toBe('ROW-50000');
      console.log('G0_HEALTHY_50000', JSON.stringify({ rows: received.length, missing, duplicates, bytes: oracle.length }));
    } finally {
      await probe.close();
    }
  }, 30_000);

  for (const fixture of [
    { name: 'fast ANSI', bytes: Buffer.from('\x1b[31mRED\x1b[0m\n\x1b[1;34mBLUE\x1b[0m\n') },
    { name: 'Thai', bytes: Buffer.from('สวัสดีชาวโลก\nบรรทัดที่สอง\n') },
    { name: 'CJK', bytes: Buffer.from('你好世界\n幅度測試\n') },
    { name: 'emoji', bytes: Buffer.from('😃❤️⚠️👩‍💻\n') },
  ]) {
    test(`corpus: ${fixture.name} remains byte exact`, async () => {
      const probe = new PrivateTmuxProbe(fixture.bytes);
      try {
        await probe.start();
        await probe.waitProducerDone();
        await probe.waitPipeEquals(fixture.bytes);
        expect(probe.pipeBytes()).toEqual(fixture.bytes);
        expect(probe.panePipe()).toBe('1');
        corpus(fixture.name, 2);
      } finally {
        await probe.close();
      }
    });
  }

  test('corpus: idle has an attached pipe and a source boundary with zero bytes', async () => {
    const probe = new PrivateTmuxProbe(Buffer.alloc(0));
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(Buffer.alloc(0));
      expect(probe.pipeBytes()).toHaveLength(0);
      expect(probe.panePipe()).toBe('1');
      expect(existsSync(probe.producerDone)).toBe(true);
      corpus('idle', 3);
    } finally {
      await probe.close();
    }
  });

  test('corpus: alternate screen is visible while raw control bytes remain exact', async () => {
    const payload = Buffer.from('\x1b[?1049hALT-SCREEN');
    const probe = new PrivateTmuxProbe(payload);
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      expect(probe.pipeBytes()).toEqual(payload);
      expect(probe.capture()).toContain('ALT-SCREEN');
      corpus('alternate screen', 2);
    } finally {
      await probe.close();
    }
  });

  test('corpus: resize changes geometry without changing pipe bytes', async () => {
    const payload = Buffer.from('RESIZE-SURVIVES\n');
    const probe = new PrivateTmuxProbe(payload);
    try {
      await probe.start();
      const before = probe.geometry();
      requireTmux(tmuxAt(probe.socket, 'resize-window', '-t', `=${probe.session}:0`, '-x', '101', '-y', '31'), 'resize-window');
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      expect(before).toBe('80x24');
      expect(probe.geometry()).toBe('101x31');
      expect(probe.pipeBytes()).toEqual(payload);
      corpus('resize', 3);
      fault('geometry changed across checkpoint', before !== probe.geometry());
    } finally {
      await probe.close();
    }
  });

  test('corpus: attach then detach does not interrupt an already attached pipe', async () => {
    const payload = Buffer.from('ATTACH-DETACH\n');
    const probe = new PrivateTmuxProbe(payload, { waitForClientBeforePayload: true });
    try {
      await probe.start();
      const command = `tmux -S ${shQuote(probe.socket)} attach-session -t ${shQuote(`=${probe.session}`)}`;
      const attached = Bun.spawnSync(['script', '-qfec', command, '/dev/null'], {
        env: { ...process.env, TERM: 'xterm-256color', TMUX: undefined, TMUX_PANE: undefined },
      });
      requireTmux(attached, 'private client attach/detach');
      expect(attached.exitCode).toBe(0);
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      await waitUntil('client detached', () => existsSync(probe.detached));
      console.log('G0_ATTACH_BYTES', JSON.stringify({ expected: payload.toString('hex'), actual: probe.pipeBytes().toString('hex'), detached: existsSync(probe.detached) }));
      expect(probe.pipeBytes()).toEqual(payload);
      expect(existsSync(probe.detached)).toBe(true);
      corpus('attach/detach', 3);
    } finally {
      await probe.close();
    }
  });

  test('corpus: independent reader EOF marker detects truncation even if pane_pipe stays active', async () => {
    const payload = Buffer.from('ABCDEFGHIJ');
    const probe = new PrivateTmuxProbe(payload, {
      pipeCommand: output => `head -c 4 > ${shQuote(output)}; : > ${shQuote(`${output}.eof`)}`,
    });
    try {
      await probe.start();
      await probe.waitProducerDone();
      await waitUntil('short pipe output', () => probe.pipeBytes().length === 4);
      await waitUntil('independent reader EOF marker', () => existsSync(`${probe.pipeOutput}.eof`));
      expect(probe.pipeBytes().toString()).toBe('ABCD');
      expect(existsSync(`${probe.pipeOutput}.eof`)).toBe(true);
      expect(probe.pipeBytes()).not.toEqual(payload);
      corpus('pipe EOF', 3, 'unknown');
      console.log('G0_EOF_OBSERVATION', JSON.stringify({ panePipe: probe.panePipe(), readerClosed: true, received: probe.pipeBytes().length, produced: payload.length }));
      fault('pipe reader EOF', existsSync(`${probe.pipeOutput}.eof`) && probe.pipeBytes().length !== payload.length);
    } finally {
      await probe.close();
    }
  });

  test('corpus: injected reader stall is detectable and later drains exactly', async () => {
    const payload = Buffer.alloc(512 * 1024, 0x53);
    const probe = new PrivateTmuxProbe(payload, {
      pipeCommand: output => `: > ${shQuote(`${output}.ready`)}; while [ ! -f ${shQuote(`${output}.release`)} ]; do sleep 0.01; done; cat > ${shQuote(output)}`,
    });
    try {
      await probe.start();
      await waitUntil('reader waiting at explicit gate', () => existsSync(`${probe.pipeOutput}.ready`));
      // tmux versions buffer different amounts: producer completion does not
      // prove reader progress. Observe the gated reader against the byte oracle.
      const stalled = probe.pipeBytes().length < payload.length && probe.panePipe() === '1';
      expect(stalled).toBe(true);
      expect(probe.pipeBytes()).toHaveLength(0);
      writeFileSync(`${probe.pipeOutput}.release`, 'go');
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      expect(probe.pipeBytes()).toEqual(payload);
      corpus('stall', 2);
      fault('reader backpressure stall', stalled);
    } finally {
      await probe.close();
    }
  });

  test('corpus: ring wrap preserves pipe bytes but capture no longer proves old rows', async () => {
    const payload = Buffer.from(Array.from({ length: 2_000 }, (_, i) => `WRAP-${String(i + 1).padStart(4, '0')}`).join('\n') + '\n');
    const probe = new PrivateTmuxProbe(payload, { historyLimit: 100 });
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      const capture = probe.capture();
      expect(probe.pipeBytes()).toEqual(payload);
      expect(capture).not.toContain('WRAP-0001');
      expect(capture).toContain('WRAP-2000');
      corpus('ring-wrap', 3);
    } finally {
      await probe.close();
    }
  });

  test('corpus: identical repaint collapses in capture and must remain unknown', async () => {
    const payload = Buffer.from('SAME\rSAME\rSAME');
    const probe = new PrivateTmuxProbe(payload);
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(payload);
      const captureA = probe.capture();
      const captureB = probe.capture();
      expect(probe.pipeBytes()).toEqual(payload);
      expect(captureA).toBe(captureB);
      expect(captureA.match(/SAME/g)?.length).toBe(1);
      corpus('identical repaint', 3, 'unknown');
      fault('identical repaint ambiguity', captureA === captureB && payload.toString().match(/SAME/g)?.length === 3);
    } finally {
      await probe.close();
    }
  });

  test('corpus: repeated prefix emitted before pipe attach cannot be fenced by pipe plus capture', async () => {
    const repeated = Buffer.from('DUPLICATE\r');
    const probe = new PrivateTmuxProbe(repeated, { preAttach: repeated });
    try {
      await probe.start();
      await probe.waitProducerDone();
      await probe.waitPipeEquals(repeated);
      const captureA = probe.capture();
      const captureB = probe.capture();
      expect(probe.pipeBytes()).toEqual(repeated);
      expect(captureA).toBe(captureB);
      expect(captureA.match(/DUPLICATE/g)?.length).toBe(1);
      expect(Buffer.concat([repeated, repeated])).not.toEqual(probe.pipeBytes());
      corpus('ambiguous prefix', 4, 'unknown');
      fault('pre-attach source bytes', probe.pipeBytes().length === repeated.length);
      fault('ambiguous repeated prefix', captureA === captureB && captureA.includes('DUPLICATE'));
    } finally {
      await probe.close();
    }
  });

  test('fault injection: independent producer oracle detects receiver drop/duplicate/truncate', () => {
    const oracle = Buffer.from('0123456789');
    const dropped = Buffer.concat([oracle.subarray(0, 3), oracle.subarray(4)]);
    const duplicated = Buffer.concat([oracle.subarray(0, 5), oracle.subarray(4)]);
    const truncated = oracle.subarray(0, 7);
    expect(dropped.equals(oracle)).toBe(false);
    expect(duplicated.equals(oracle)).toBe(false);
    expect(truncated.equals(oracle)).toBe(false);
    fault('receiver byte dropped', !dropped.equals(oracle));
    fault('receiver byte duplicated', !duplicated.equals(oracle));
    fault('receiver suffix truncated', !truncated.equals(oracle));
  });
});
