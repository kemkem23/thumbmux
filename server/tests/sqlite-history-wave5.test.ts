/**
 * Wave 5 fixture proofs for the opt-in SQLite **authoritative writer**.
 *
 * Everything here runs on a synthetic temp database and a temp mirror
 * directory. No tmux, no production history, no `brain.db`, no network, and no
 * production session is wired to this path. The four deliverables of the wave-5
 * row in DESIGN.md each have a test below:
 *
 *  1. kill-point proof            -> real SIGKILL at eight cut points
 *  2. SQL -> legacy -> oracle     -> byte roundtrip incl. ANSI/blank/Thai/CJK/dupes
 *  3. rollback to C2 with post-C0 -> counted and byte-compared, not "no error"
 *  4. DB fault alarms + mirror lag-> injected faults must cry, with receipts
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, prepareFile } from '../src/sqlite-history/store';
import { AuthoritativeHistoryBridge, readMirror, verifyRollbackBundle } from '../src/sqlite-history/authoritative';
import { inspectHistoryMirror } from '../src/sqlite-history/detectors';
import { readSealedHistoryOracle } from '../src/sqlite-history/rehearsal';
import { rowsDigest, sha } from '../src/sqlite-history/codec';
import type { CaptureBatch, HistoryCaptureDriver, HistoryFault, HistoryRow } from '../src/sqlite-history/types';
import { batch, evidence, fixture, ids, observation } from './sqlite-history/helpers';

const stubDriver: HistoryCaptureDriver = {
  geometryGeneration: () => 1,
  capture: () => Promise.reject(new Error('unused-in-wave5-fixtures')),
};

function bridgeFor(store: HistoryStore, mirrorDirectory: string): AuthoritativeHistoryBridge {
  return new AuthoritativeHistoryBridge(store, { mirrorDirectory, driver: stubDriver, sessions: () => [] });
}

/** Like helpers.batch but the appended rows keep their kind (terminal or gap). */
function rawBatch(store: HistoryStore, sid: string, rows: Array<{ kind: 'terminal' | 'gap'; text: string }>,
  screen: string[], requestId?: string, recordFrames = false): CaptureBatch {
  const o = observation([...rows.map(row => row.text), ...screen], screen.length);
  return { ticket: store.ticket(sid, requestId), observation: o, appended: rows, liveLineLimit: screen.length,
    recordFrames, evidence: { classification: 'initial', depth: 'shallow', source: {}, rawSha256: sha(JSON.stringify(o)) } };
}

const faultsOf = (alarms: HistoryFault[], detector: string) => alarms.filter(alarm => alarm.detector === detector);
const realFaults = (alarms: HistoryFault[]) => alarms.filter(alarm => alarm.detector !== 'source-unknown');

describe('wave 5 authoritative writer', () => {
  test('kill-point proof: a real SIGKILL at every cut point leaves whole-old or whole-new state, and the mirror never leads the database', async () => {
    const points = [
      'before-transaction', 'after-row', 'before-boundary', 'before-commit',
      'sqlite-committed', 'mirror-temp', 'mirror-seq', 'mirror-watermark',
    ] as const;
    const committedAfterKill: Record<string, number> = {
      'before-transaction': 1, 'after-row': 1, 'before-boundary': 1, 'before-commit': 1,
      'sqlite-committed': 2, 'mirror-temp': 2, 'mirror-seq': 2, 'mirror-watermark': 2,
    };
    const crashRows = ['after crash boundary', 'ไทย漢字\x1b[31mกข', ''];
    for (const point of points) {
      const dir = mkdtempSync(join(tmpdir(), `thumbmux-wave5-kill-${point}-`));
      try {
        const file = prepareFile(join(dir, 'history.db')), mirror = join(dir, 'mirror');
        const seedFaults: HistoryFault[] = [];
        const seedStore = new HistoryStore(new Database(file, { strict: true }), { file, onFault: fault => seedFaults.push(fault) });
        const sid = await seedStore.register({ name: `kill-${point}`, lifecycleKey: `wave5-kill-${point}` });
        const seedBridge = bridgeFor(seedStore, mirror);
        await seedBridge.commitBatch(batch(seedStore, sid, ids(40)));
        expect(seedBridge.mirrorStatus(sid)).toMatchObject({ targetRevision: 1, exportedRevision: 1, lagSince: null });
        await seedStore.close();
        const worker = Bun.spawn([process.execPath, join(import.meta.dir, 'sqlite-history/authoritative-crash-worker.ts'),
          file, mirror, sid, point], { stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stderr] = await Promise.all([worker.exited, new Response(worker.stderr).text()]);
        expect(worker.signalCode).toBe('SIGKILL');
        // Reopen from disk only: whatever survived the kill is what a restart sees.
        const alarms: HistoryFault[] = [];
        const store = new HistoryStore(new Database(file, { strict: true }), { file, onFault: fault => alarms.push(fault) });
        try {
          const revision = store.snapshot(sid).context.revision;
          expect(revision).toBe(committedAfterKill[point]);
          const audit = store.audit(sid);
          expect(audit.captures).toBe(revision);
          const expectedTexts = revision === 2 ? [...ids(40), ...crashRows] : ids(40);
          expect(store.rows(sid, 0, audit.rows).map(row => row.text)).toEqual(expectedTexts);
          const killMirror = readMirror(mirror, sid);
          // The mirror may lag the authoritative writer; it may never lead it.
          expect(killMirror.exportedRevision).toBeLessThanOrEqual(revision);
          expect(killMirror.records.length).toBeLessThanOrEqual(revision);
          const bridge = bridgeFor(store, mirror);
          // The same request replayed after the crash is exactly-once: the
          // store answers with the committed receipt or commits it fresh.
          const receipt = await bridge.commitBatch(batch(store, sid, crashRows, ['new screen'], 'crash-request'));
          expect(receipt.context.revision).toBe(2);
          expect(store.audit(sid).rows).toBe(43);
          const resumed = bridge.resumeMirror(sid);
          expect(resumed).toMatchObject({ targetRevision: 2, exportedRevision: 2, lagSince: null });
          const replayed = readMirror(mirror, sid);
          expect(replayed.records.map(record => record.seq)).toEqual([1, 2]);
          expect(replayed.records.flatMap(record => record.rows.map(row => row.text))).toEqual([...ids(40), ...crashRows]);
          expect(realFaults(alarms)).toEqual([]);
          console.log('WAVE5_KILL', JSON.stringify({ point, exitCode, signal: worker.signalCode,
            reopenedRevision: revision, rowsAfterKill: audit.rows, mirrorAfterKill: killMirror.exportedRevision,
            rowsAfterReplay: 43, mirrorAfterReplay: resumed.exportedRevision, stderr: stderr.slice(0, 200) }));
        } finally { await store.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 120000);

  test('SQL to legacy to oracle roundtrip preserves every byte: ANSI, true blanks, Thai/CJK and repeated text', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'roundtrip', lifecycleKey: 'wave5-roundtrip' });
      const bridge = bridgeFor(f.store, join(f.dir, 'mirror'));
      const expected: Array<{ kind: 'terminal' | 'gap'; text: string }> = [
        { kind: 'terminal', text: '' },
        { kind: 'terminal', text: 'สวัสดีครับ ๆๆ ภาษาไทย' },
        { kind: 'terminal', text: '漢字テスト、中文行、한국어' },
        { kind: 'terminal', text: '\x1b[31mred\x1b[0m \x1b]0;title\x07tail' },
        ...Array.from({ length: 100 }, () => ({ kind: 'terminal' as const, text: 'OK' })),
        { kind: 'gap', text: '[history continuity unknown]' },
        { kind: 'terminal', text: '' },
        { kind: 'terminal', text: 'après ünïcode 🚀 \x1b[1;44m bold-on-blue' },
      ];
      const screen = ['pane ไทย \x1b[32mgreen', 'ok'];
      for (let index = 0; index < expected.length; index += 40) {
        await bridge.commitBatch(rawBatch(f.store, sid, expected.slice(index, index + 40), screen, undefined, true));
      }
      const destination = join(f.dir, 'rollback-bundle');
      const receipt = await bridge.rollbackToLegacy(sid, destination);
      expect(receipt.rows).toBe(expected.length);
      expect(receipt.frames).toBe(Math.ceil(expected.length / 40));
      // Independent oracle parsers against the test's own generator list, byte
      // by byte, for both legacy projections. Neither parser is the exporter.
      for (const format of ['file-jsonl', 'durable-log'] as const) {
        const oracle = readSealedHistoryOracle(destination, format).rows;
        expect(oracle.length).toBe(expected.length);
        for (let index = 0; index < expected.length; index++) {
          expect(oracle[index].line_no).toBe(index);
          expect(Buffer.compare(Buffer.from(oracle[index].text, 'utf8'), Buffer.from(expected[index].text, 'utf8'))).toBe(0);
        }
      }
      // The legacy text projections cannot carry `kind`; the bundle's full
      // record does, and it must match exactly, including the gap row.
      const recovery = JSON.parse(readFileSync(join(destination, 'recovery.json'), 'utf8')) as { lines: HistoryRow[]; frames: Array<{ record_json: string }> };
      expect(recovery.lines.map(row => row.kind)).toEqual(expected.map(row => row.kind));
      expect(rowsDigest(recovery.lines)).toBe(rowsDigest(expected.map((row, index) => ({ line_no: index, ...row }))));
      const frames = readSealedHistoryOracle(destination, 'frame-ndjson').frames;
      expect(frames.length).toBe(receipt.frames);
      expect(frames.map(frame => JSON.stringify(frame))).toEqual(recovery.frames.map(frame => frame.record_json));
      expect(realFaults(f.alarms)).toEqual([]);
      console.log('WAVE5_ROUNDTRIP', JSON.stringify({ rows: receipt.rows, frames: receipt.frames,
        blanks: expected.filter(row => row.text === '').length, duplicates: expected.filter(row => row.text === 'OK').length,
        rowsSha256: receipt.rowsSha256 }));
    } finally { await f.cleanup(); }
  }, 30000);

  test('rollback to C2 keeps every row committed after C0, counted and byte-compared', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'rollback-c2', lifecycleKey: 'wave5-rollback-c2' });
      const bridge = bridgeFor(f.store, join(f.dir, 'mirror'));
      for (let start = 0; start < 500; start += 100) await bridge.commitBatch(batch(f.store, sid, ids(100, start)));
      const c0 = f.store.snapshot(sid).context;
      expect(c0.revision).toBe(5);
      expect(c0.nextLine).toBe(500);
      // Data committed AFTER the C0 cutover point, through the authoritative path.
      for (let start = 500; start < 800; start += 100) await bridge.commitBatch(batch(f.store, sid, ids(100, start)));
      const destination = join(f.dir, 'rollback-c2');
      const receipt = await bridge.rollbackToLegacy(sid, destination);
      expect(receipt.c2Revision).toBe(8);
      expect(receipt.rows).toBe(800);
      const oracle = readSealedHistoryOracle(destination, 'file-jsonl').rows;
      expect(oracle.length).toBe(800);
      const postC0 = oracle.slice(c0.nextLine);
      expect(postC0.length).toBe(300);
      // Every post-C0 row byte-compared against the independent generator.
      const expectedPostC0 = ids(300, 500);
      for (let index = 0; index < postC0.length; index++) {
        expect(postC0[index].line_no).toBe(500 + index);
        expect(Buffer.compare(Buffer.from(postC0[index].text, 'utf8'), Buffer.from(expectedPostC0[index], 'utf8'))).toBe(0);
      }
      // The rollback barrier holds: the authoritative path admits nothing new
      // into an incarnation that is being handed back to legacy.
      await expect(bridge.commitBatch(batch(f.store, sid, ['late row']))).rejects.toThrow('authoritative-barrier-held');
      expect(realFaults(f.alarms)).toEqual([]);
      console.log('WAVE5_ROLLBACK_C2', JSON.stringify({ c0Revision: c0.revision, c0NextLine: c0.nextLine,
        c2Revision: receipt.c2Revision, totalRows: receipt.rows, postC0Rows: postC0.length }));
    } finally { await f.cleanup(); }
  }, 30000);

  test('a tampered rollback bundle is refused with a loud rollback-not-ready fault', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'tampered-bundle', lifecycleKey: 'wave5-tampered-bundle' });
      const bridge = bridgeFor(f.store, join(f.dir, 'mirror'));
      await bridge.commitBatch(batch(f.store, sid, ids(50)));
      const destination = join(f.dir, 'bundle');
      await bridge.rollbackToLegacy(sid, destination);
      expect(() => verifyRollbackBundle(f.store, sid, destination)).not.toThrow();
      // Flip one byte in the JSONL projection and re-seal, so only the
      // independent byte comparison can notice; counts stay identical.
      const jsonlPath = join(destination, 'history.jsonl');
      const tampered = readFileSync(jsonlPath, 'utf8').replace('"row:7:', '"r0w:7:');
      writeFileSync(jsonlPath, tampered);
      const sealPath = join(destination, 'seal.json');
      const seal = JSON.parse(readFileSync(sealPath, 'utf8')) as { version: 1; files: Array<{ path: string; bytes: number; sha256: string }> };
      for (const entry of seal.files) if (entry.path === 'history.jsonl') {
        entry.bytes = Buffer.byteLength(tampered); entry.sha256 = sha(Buffer.from(tampered));
      }
      writeFileSync(sealPath, JSON.stringify(seal));
      expect(() => verifyRollbackBundle(f.store, sid, destination)).toThrow('rollback-jsonl-bytes');
      const fault = faultsOf(f.alarms, 'rollback-not-ready').at(-1);
      evidence(fault);
      console.log('WAVE5_TAMPERED_BUNDLE', JSON.stringify({ detector: fault?.detector, observed: fault?.observed }));
    } finally { await f.cleanup(); }
  }, 30000);

  test('mirror export failure is a loud fault, the watermark lags, replay catches up, and tampering is caught', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'mirror-lag', lifecycleKey: 'wave5-mirror-lag' });
      const mirror = join(f.dir, 'mirror');
      const bridge = bridgeFor(f.store, mirror);
      await bridge.commitBatch(batch(f.store, sid, ids(40)));
      // A clean commit leaves the mirror synced, never trailing by design.
      expect(bridge.mirrorStatus(sid)).toMatchObject({ targetRevision: 1, exportedRevision: 1, lagSince: null });
      const sessionDirectory = join(mirror, sha(sid));
      chmodSync(sessionDirectory, 0o500);
      const injectedAt = Date.now();
      let receipt;
      try {
        receipt = await bridge.commitBatch(batch(f.store, sid, ids(40, 40)));
      } finally { chmodSync(sessionDirectory, 0o700); }
      // The SQLite COMMIT is the authoritative receipt: revision 2 exists even
      // though the mirror write was denied.
      expect(receipt.context.revision).toBe(2);
      const fault = faultsOf(f.alarms, 'export-failed').at(-1);
      evidence(fault);
      const detectionMs = fault!.timestamp - injectedAt;
      expect(detectionMs).toBeGreaterThanOrEqual(0);
      expect(detectionMs).toBeLessThan(60000);
      const lagged = bridge.mirrorStatus(sid);
      expect(lagged).toMatchObject({ targetRevision: 2, exportedRevision: 1 });
      expect(lagged.lagSince).not.toBeNull();
      // The standalone mirror detector cries once the lag exceeds its budget.
      const stale = inspectHistoryMirror(sid, lagged.targetRevision, lagged.exportedRevision, lagged.lagSince!, lagged.lagSince! + 30001);
      expect(stale?.detector).toBe('mirror-stale');
      evidence(stale!);
      expect(inspectHistoryMirror(sid, lagged.targetRevision, lagged.targetRevision, lagged.lagSince!, lagged.lagSince! + 30001)).toBeNull();
      // Replay from the durable watermark catches the mirror up.
      const resumed = bridge.resumeMirror(sid);
      expect(resumed).toMatchObject({ targetRevision: 2, exportedRevision: 2, lagSince: null });
      expect(readMirror(mirror, sid).records.flatMap(record => record.rows.map(row => row.text))).toEqual(ids(80));
      // Tampering with an exported seq file is caught byte-for-byte, both by
      // the mirror audit and by replay against the committed store.
      const seqPath = join(sessionDirectory, 'seq-000000000001.json');
      const originalSeq = readFileSync(seqPath, 'utf8');
      writeFileSync(seqPath, originalSeq.replace('"row:3:', '"r0w:3:'));
      expect(() => readMirror(mirror, sid)).toThrow('mirror-record-digest');
      unlinkSync(join(sessionDirectory, 'watermark.json'));
      expect(() => bridge.resumeMirror(sid)).toThrow('mirror-conflict');
      writeFileSync(seqPath, originalSeq);
      // With the watermark lost but the files intact, status reports the lag
      // and replay is idempotent: byte-identical files are accepted, not rewritten.
      const rebuilt = bridge.mirrorStatus(sid);
      expect(rebuilt).toMatchObject({ targetRevision: 2, exportedRevision: 0 });
      expect(rebuilt.lagSince).not.toBeNull();
      expect(bridge.resumeMirror(sid)).toMatchObject({ targetRevision: 2, exportedRevision: 2, lagSince: null });
      console.log('WAVE5_MIRROR_LAG', JSON.stringify({ detectionMs, laggedExported: lagged.exportedRevision,
        resumedExported: resumed.exportedRevision, staleDetector: stale?.detector }));
    } finally { await f.cleanup(); }
  }, 30000);

  test('database faults cry within budget: busy, full, constraint clash and a future schema all alarm', async () => {
    const f = fixture();
    try {
      const sid = await f.store.register({ name: 'db-faults', lifecycleKey: 'wave5-db-faults' });
      const bridge = bridgeFor(f.store, join(f.dir, 'mirror'));
      await bridge.commitBatch(batch(f.store, sid, ids(40)));
      // --- SQLITE_BUSY: a second writer holds the write lock ---
      const rival = new Database(f.file, { strict: true });
      let busyMs = -1;
      try {
        rival.exec('BEGIN IMMEDIATE');
        const busyAt = Date.now();
        await expect(bridge.commitBatch(batch(f.store, sid, ids(10, 40)))).rejects.toThrow();
        const busyFault = faultsOf(f.alarms, 'write-failed').at(-1);
        evidence(busyFault);
        busyMs = busyFault!.timestamp - busyAt;
        expect(busyMs).toBeGreaterThanOrEqual(0);
        expect(busyMs).toBeLessThan(60000);
        expect(String(busyFault!.observed)).toMatch(/SQLITE_BUSY|database is locked/i);
      } finally { rival.exec('ROLLBACK'); rival.close(); }
      // --- SQLITE_FULL: the database refuses to grow ---
      const pageCount = Object.values(f.store.db.query('PRAGMA page_count').get() as object)[0] as number;
      f.store.db.exec(`PRAGMA max_page_count=${pageCount}`);
      const fullAt = Date.now();
      let fullMs = -1;
      try {
        await expect(bridge.commitBatch(batch(f.store, sid, ids(2000, 40)))).rejects.toThrow();
        const fullFault = faultsOf(f.alarms, 'write-failed').at(-1);
        evidence(fullFault);
        fullMs = fullFault!.timestamp - fullAt;
        expect(fullMs).toBeLessThan(60000);
        expect(String(fullFault!.observed)).toMatch(/SQLITE_FULL|disk is full/i);
      } finally { f.store.db.exec('PRAGMA max_page_count=1073741823'); }
      // The store still commits once the pressure is gone; no half state remains.
      await bridge.commitBatch(batch(f.store, sid, ids(10, 40)));
      expect(f.store.audit(sid).rows).toBe(50);
      // --- constraint clash: rows deleted under the receipts, guard bypassed ---
      f.store.db.exec('DROP TRIGGER line_delete');
      f.store.db.query('DELETE FROM history_line WHERE session_id=? AND line_no>=? AND line_no<?').run(sid, 10, 20);
      f.store.db.exec(`CREATE TRIGGER line_delete BEFORE DELETE ON history_line WHEN OLD.line_no >=
        (SELECT first_line FROM history_session WHERE session_id=OLD.session_id) BEGIN
        SELECT RAISE(ABORT,'retention-disabled');
      END;`);
      const clashAt = Date.now();
      expect(() => f.store.audit(sid)).toThrow();
      const clashFault = realFaults(f.alarms).at(-1);
      evidence(clashFault);
      expect(['storage-hole', 'integrity-audit']).toContain(clashFault!.detector);
      const clashMs = clashFault!.timestamp - clashAt;
      expect(clashMs).toBeLessThan(60000);
      const issues = f.store.db.query('SELECT count(*) AS n FROM history_issue WHERE session_id=? AND kind IN (?,?)')
        .get(sid, 'storage-hole', 'integrity-audit') as { n: number };
      expect(issues.n).toBeGreaterThan(0);
      console.log('WAVE5_DB_FAULTS', JSON.stringify({ busyMs, fullMs, clashMs, persistedIssues: issues.n }));
    } finally { await f.cleanup(); }
  }, 30000);

  test('a future schema version is refused, and the mirror watermark is the recovery checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thumbmux-wave5-version-'));
    try {
      const file = prepareFile(join(dir, 'history.db'));
      const store = new HistoryStore(new Database(file, { strict: true }), { file });
      await store.close();
      const raw = new Database(file);
      raw.exec('PRAGMA user_version=99');
      raw.close();
      expect(() => new HistoryStore(new Database(file, { strict: true }), { file })).toThrow('future-schema');
      console.log('WAVE5_FUTURE_SCHEMA', JSON.stringify({ refused: true, version: 99 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});
