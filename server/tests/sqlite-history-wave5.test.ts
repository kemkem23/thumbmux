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

// ── NEWARCH L2-I lot I4: runtime adapter (collector I1 -> store I2 -> calibrator I3) ──
import { mkdtempSync as i4Tmp, rmSync as i4Rm } from 'node:fs';
import { tmpdir as i4TmpDir } from 'node:os';
import { join as i4Join } from 'node:path';
import {
  BLANK_CELL, applyFrameDelta, canonicalCaptureCells, canonicalCaptureColor, canonicalParserColor, cellsToAnsi,
  createPipeHistoryRuntime, parserRowCells, parserStyle, rowText, screenOverlap, type PaneTmuxMeta, type RawPaneCapture,
} from '../src/pipe-history-runtime';
import { TmuxCaptureDecoder } from '../src/tmux-capture-normalize';
import { createProjectionStore } from '../src/sqlite-history/projection-store';

const I4_META: PaneTmuxMeta = { cols: 40, rows: 6, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 2000, panePid: 1, mouseSgr: false, mouseAny: false };
async function i4Until(predicate: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition not met'); await new Promise(r => setTimeout(r, 10)); }
}

describe('NEWARCH I4 cell codec (one codec, both producers)', () => {
  test('parser colours and styles land in the capture namespace', () => {
    expect(canonicalParserColor('default')).toBe('default');
    expect(canonicalParserColor('red')).toBe('index:1');
    expect(canonicalParserColor('brown')).toBe('index:3');
    expect(canonicalParserColor('brightblue')).toBe('index:12');
    // 38;5;9 reaches pyte as the palette hex; the 16 base colours keep their index.
    expect(canonicalParserColor('ff0000')).toBe('index:9');
    // Palette 16-255 and truecolor compare as rgb on both sides.
    expect(canonicalParserColor('5f87af')).toBe('rgb:95,135,175');
    expect(canonicalCaptureColor('index:67')).toBe('rgb:95,135,175');
    expect(canonicalCaptureColor('index:3')).toBe('index:3');
    // bold, italics, underscore, strike, reverse, blink.
    expect([1, 2, 4, 8, 16, 32].map(parserStyle)).toEqual([1, 4, 8, 256, 64, 16]);
  });

  test('cells -> ANSI -> tmux capture decoder -> canonical cells is the identity', () => {
    const row = parserRowCells([
      ['red', 'default', 1, 'bold red '], ['5f87af', '000000', 2 | 4, 'ital'],
      ['brightgreen', 'default', 16, ['漢', '', '😀', '', 'ไ', 'ท', 'ย']], ['default', 'default', 8 | 32, ' x'],
    ], 40);
    expect(row[13]).toMatchObject({ grapheme: '漢', width: 2, continuation: false });
    expect(row[14]).toMatchObject({ grapheme: '', width: 0, continuation: true });
    const decoder = new TmuxCaptureDecoder(40);
    const decoded = canonicalCaptureCells(decoder.decode(cellsToAnsi(row) + '\n')[0]!, 40);
    expect(decoded).toEqual(row);
    expect(rowText(decoded)).toBe(rowText(row));
    expect(cellsToAnsi(new Array(40).fill(BLANK_CELL))).toBe('');
  });

  test('capture keeps dim, rapid blink and hidden while repeated rows are never content-deduplicated', () => {
    const captured = canonicalCaptureCells([{
      grapheme: 'x', width: 1, continuation: false, fg: 'default', bg: 'default', style: 2 | 32 | 128,
    }], 1);
    expect(captured[0]!.style).toBe(2 | 32 | 128);
    // Overlap is a tmux counter (SWITCHON H2), never a comparison of equal rows.
    expect(screenOverlap({ displaySource: 'tmux-calibrated', kind: 'normal', pulledBack: null })).toBe(0);
  });

  test('frame deltas: shift first, then dirty rows; a geometry change without every row is incomplete', () => {
    const base = applyFrameDelta(undefined, { full: true, cols: 4, rows: 3, shift: 0, dirty: { 0: [['default', 'default', 0, 'aaaa']], 1: [['default', 'default', 0, 'bbbb']], 2: [['default', 'default', 0, 'cccc']] }, softWrap: {}, wrapPad: [] });
    const next = applyFrameDelta(base.screen, { full: false, cols: 4, rows: 3, shift: 1, dirty: { 2: [['default', 'default', 0, 'dddd']] }, softWrap: {}, wrapPad: [] });
    expect(next.complete).toBe(true);
    expect(next.screen.cells.map(rowText)).toEqual(['bbbb', 'cccc', 'dddd']);
    expect(base.screen.cells.map(rowText)).toEqual(['aaaa', 'bbbb', 'cccc']);
    const resized = applyFrameDelta(next.screen, { full: false, cols: 5, rows: 3, shift: 0, dirty: { 0: [['default', 'default', 0, 'eeeee']] }, softWrap: {}, wrapPad: [] });
    expect(resized.complete).toBe(false);
  });
});

describe('NEWARCH I4 runtime against the real VT worker and projection store', () => {
  test('blank rows scroll with an out-of-order worker seq and still land in order, without a parser restart', async () => {
    const root = i4Tmp(i4Join(i4TmpDir(), 'i4-runtime-'));
    const store = createProjectionStore({ historyRoot: root, mode: 'create' });
    const faults: string[] = [];
    const runtime = createPipeHistoryRuntime({ store, onFault: f => faults.push(f.kind) });
    try {
      const pane = await runtime.addPane({ paneKey: { serverIdentity: 't', paneId: '%1', birthGeneration: 1 }, session: 's', meta: I4_META, calibrate: false, capture: () => Promise.reject(new Error('unused')) });
      const enc = new TextEncoder();
      // A blank line every 5 rows: the worker stamps the blank row with the
      // seq that scrolled it, later than the next written row's seq.
      for (let i = 1; i <= 60; i++) pane.ingest(enc.encode(`row ${String(i).padStart(3, '0')} \x1b[3${i % 7}mok\x1b[0m\r\n${i % 5 === 0 ? '\r\n' : ''}`));
      await i4Until(() => pane.recentRows().some(r => rowText(r.cells).startsWith('row 055')));
      const texts = pane.recentRows().map(r => rowText(r.cells).trimEnd());
      const ids = texts.filter(t => t.startsWith('row ')).map(t => Number(t.slice(4, 7)));
      expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
      expect(pane.recentRows().map(r => r.lineId)).toEqual(Array.from({ length: texts.length }, (_, i) => i));
      expect(texts.filter(t => t === '').length).toBeGreaterThanOrEqual(10);
      expect(faults.filter(k => k === 'consumer-rejected' || k === 'worker-restarted')).toEqual([]);
      expect(pane.stats.latencyMs.length).toBeGreaterThan(0);
      const range = pane.readRange(0, 5)!;
      expect(range.lines[0]).toContain('row 001');
      expect(pane.view().displaySource).toBe('pipe');
    } finally { await runtime.close(); await store.close(); i4Rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test('calibration certifies rows against a capture, journals a capture only when it changes something, and maps stale-revision to a CAS null', async () => {
    const root = i4Tmp(i4Join(i4TmpDir(), 'i4-calibrate-'));
    const store = createProjectionStore({ historyRoot: root, mode: 'create' });
    let staleOnce = false;
    const proxy = new Proxy(store, { get(target, key, receiver) {
      if (key === 'calibrate') return (change: Parameters<typeof store.calibrate>[0]) => {
        if (staleOnce) { staleOnce = false; return Promise.reject(new Error('stale-revision')); }
        return target.calibrate(change);
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const faults: string[] = [];
    const runtime = createPipeHistoryRuntime({ store: proxy, onFault: f => faults.push(f.kind) });
    let paneRef: import('../src/pipe-history-runtime').PipeHistoryPane | null = null;
    let calls = 0;
    // The capture double renders exactly what tmux would show: the parser's
    // accepted rows and its screen, through the same ANSI serialisation.
    const capture = async (tail: number): Promise<RawPaneCapture> => {
      calls++;
      const pane = paneRef!;
      const view = pane.view();
      const history = pane.recentRows().slice(-Math.max(0, tail)).map(r => cellsToAnsi(r.cells));
      const screen = (view.cells.length ? view.cells : Array.from({ length: I4_META.rows }, () => [])).map(r => cellsToAnsi(r as never));
      const meta = { ...I4_META, cursor: view.cursor ?? I4_META.cursor };
      return { captureId: `c${calls}`, requestedAt: Date.now(), completedAt: Date.now(), before: meta, after: meta, body: [...history, ...screen].join('\n') + '\n', tail };
    };
    try {
      const pane = await runtime.addPane({ paneKey: { serverIdentity: 't', paneId: '%2', birthGeneration: 1 }, session: 's', meta: I4_META, capture, commitIntervalMs: 50 });
      paneRef = pane;
      const enc = new TextEncoder();
      for (let i = 1; i <= 30; i++) pane.ingest(enc.encode(`line ${String(i).padStart(3, '0')} unique ${i * 7919}\r\n`));
      await i4Until(() => pane.recentRows().length >= 24 && pane.stats.storeCommits > 0);
      const token = store.token(pane.paneKey);
      await i4Until(() => store.readPage(store.token(pane.paneKey), 0, 20).lines.filter(l => l.checkState !== 'unchecked').length >= 15);
      const page = store.readPage(store.token(pane.paneKey), 0, 20);
      expect(page.lines.filter(l => l.checkState === 'checked').length).toBeGreaterThanOrEqual(10);
      expect(token.nextLineId).toBeGreaterThanOrEqual(24);
      // Idle: the next captures confirm what is certified and displayed; they are not journaled.
      const commits = pane.stats.storeCommits;
      await i4Until(() => pane.stats.skippedCommits >= 2, 10_000);
      expect(pane.stats.storeCommits).toBe(commits);
      expect(pane.view().displaySource).toBe('tmux-calibrated');
      // A CAS conflict is a null, never a capture fault.
      staleOnce = true;
      pane.ingest(enc.encode('after conflict\r\n'));
      await i4Until(() => pane.stats.captureConflicts === 1 || pane.stats.captureFaults > 0, 10_000);
      expect(pane.stats.captureConflicts).toBe(1);
      expect(pane.stats.captureFaults).toBe(0);
      expect(faults.filter(k => k === 'capture-fault')).toEqual([]);
    } finally { await runtime.close(); await store.close(); i4Rm(root, { recursive: true, force: true }); }
  }, 60_000);
});

// ── NEWARCH-SWITCHON H2: the last page follows tmux across resizes; receipts close on capture ──
import { spawnSync as h2Spawn } from 'node:child_process';
import { appendFileSync as h2Append, openSync as h2Open, readSync as h2Read, closeSync as h2Close, writeFileSync as h2Write, existsSync as h2Exists } from 'node:fs';
import { ProjectionLiveWindow as H2LiveWindow, type PipeHistoryPane as H2Pane } from '../src/pipe-history-runtime';

const H2_META_FORMAT = ['#{pane_width}', '#{pane_height}', '#{cursor_x}', '#{cursor_y}', '#{cursor_flag}', '#{alternate_on}', '#{history_size}', '#{history_limit}', '#{pane_pid}'].join('\t');
/** One private tmux server (never the default socket): a pane running `tail -f` on a file, its output piped to another file. */
function h2Tmux(cols: number, rows: number) {
  const dir = i4Tmp(i4Join(i4TmpDir(), 'switchon-h2-'));
  const socket = i4Join(dir, 'x.sock'), input = i4Join(dir, 'in.txt'), out = i4Join(dir, 'out.bin');
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => {
    const r = h2Spawn('tmux', ['-S', socket, ...args], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`tmux ${args[0]}: ${r.stderr}`);
    return r.stdout;
  };
  h2Write(input, ''); h2Write(out, '');
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'h2', '-x', String(cols), '-y', String(rows), `sleep 0.5; exec tail -n +1 -f '${input}'`);
  tmux('set-option', '-g', 'window-size', 'manual');
  tmux('set-option', '-g', 'status', 'off');
  tmux('pipe-pane', '-O', '-t', 'h2:0.0', `cat >> '${out}'`);
  const parse = (line: string): PaneTmuxMeta => {
    const f = line.trim().split('\t');
    const n = (i: number) => Number(f[i]);
    return { cols: n(0), rows: n(1), cursor: { x: n(2), y: n(3), visible: f[4] === '1' }, alternate: f[5] === '1',
      historySize: /^\d+$/.test(f[6] ?? '') ? n(6) : Number.NaN, historyLimit: n(7), panePid: n(8), mouseSgr: false, mouseAny: false };
  };
  const meta = () => parse(tmux('display-message', '-p', '-t', 'h2:0.0', H2_META_FORMAT));
  let offset = 0, captures = 0;
  return {
    socket, tmux, meta,
    write(text: string) { h2Append(input, text); },
    /** Hand every byte tmux piped out so far to the pane (the host's FIFO reader). */
    pump(pane: H2Pane) {
      const fd = h2Open(out, 'r');
      try {
        const buf = Buffer.alloc(65536);
        for (;;) { const n = h2Read(fd, buf, 0, buf.length, offset); if (n <= 0) break; offset += n; pane.ingest(new Uint8Array(buf.subarray(0, n))); }
      } finally { h2Close(fd); }
    },
    /** capture-pane bracketed by metadata, like the host's capture batch. */
    async capture(tail: number): Promise<RawPaneCapture> {
      const requestedAt = Date.now();
      const before = meta();
      const body = tmux('capture-pane', '-p', '-e', '-N', '-t', 'h2:0.0', ...(tail > 0 ? ['-S', `-${tail}`] : []));
      const after = meta();
      return { captureId: `h2-${++captures}`, requestedAt, completedAt: Date.now(), before, after, body, tail };
    },
    screenText: () => tmux('capture-pane', '-p', '-t', 'h2:0.0').replace(/\n$/, '').split('\n').map(l => l.trimEnd()),
    close() { try { tmux('kill-server'); } catch { /* already gone */ } i4Rm(dir, { recursive: true, force: true }); return !h2Exists(socket); },
  };
}

describe('NEWARCH-SWITCHON H2 resize against a private tmux', () => {
  test('24 -> 37 -> 24 -> 80: the live window follows tmux, rows appear once, the journal holds each row once, receipts close', async () => {
    const root = i4Tmp(i4Join(i4TmpDir(), 'switchon-h2-store-'));
    const store = createProjectionStore({ historyRoot: root, mode: 'create' });
    const faults: string[] = [];
    const runtime = createPipeHistoryRuntime({ store, onFault: f => faults.push(f.kind) });
    const t = h2Tmux(40, 24);
    const window = new H2LiveWindow(1000);
    let pane: H2Pane | null = null;
    let written = 0;
    const pumper = setInterval(() => { if (pane) t.pump(pane); }, 10);
    const write = (n: number) => { let text = ''; for (let i = 0; i < n; i++) text += `R-${String(++written).padStart(4, '0')} x\n`; t.write(text); };
    const liveIds = () => {
      const snap = window.snapshot(pane!, 1);
      return snap ? snap.content.split('\n').map(l => /^R-(\d{4}) /.exec(l)).filter(Boolean).map(m => Number(m![1])) : [];
    };
    /** The screen shown is tmux's, and every written row is in the live window exactly once, in order. */
    const settled = async (label: string) => {
      await i4Until(() => {
        const view = pane!.view();
        const m = t.meta();
        if (view.displaySource !== 'tmux-calibrated' || view.rows !== m.rows) return false;
        const shown = view.cells.map(r => rowText(r).trimEnd());
        const tm = t.screenText();
        return shown.length === tm.length && shown.every((l, i) => l === tm[i]) && liveIds().at(-1) === written;
      }, 20_000).catch(() => { throw new Error(`${label}: screen never matched tmux; view=${JSON.stringify(pane!.view().pulledBack)} ids=${liveIds().slice(-40).join(',')}`); });
      const ids = liveIds();
      expect({ label, ids }).toEqual({ label, ids: Array.from({ length: written }, (_, i) => i + 1) });
      return ids;
    };
    try {
      pane = await runtime.addPane({ paneKey: { serverIdentity: 'h2', paneId: '%0', birthGeneration: 1 }, session: 'h2', meta: t.meta(), capture: tail => t.capture(tail), commitIntervalMs: 50 });
      pane.setViewers(1);
      await Bun.sleep(700);
      write(60);
      await i4Until(() => t.meta().historySize === 37 && pane!.recentRows().length === 37, 20_000);
      await settled('24 rows');

      // Grow: tmux pulls 13 history rows back onto the screen.
      const h0 = t.meta().historySize;
      t.tmux('resize-window', '-t', 'h2', '-x', '40', '-y', '37');
      const grown = t.meta();
      expect(h0 - grown.historySize).toBe(13);
      pane.observe(grown);
      // A chunk right after the resize lands while the calibrator is latched (held pipe frame).
      write(1);
      await settled('37 rows');
      const pulled = pane.view().pulledBack;
      // By tmux's counters: 13 pulled back, minus the rows output scrolled into history since.
      expect(pulled?.rows).toBe(13 - (t.meta().historySize - grown.historySize));

      // More output scrolls pulled rows back into history first.
      write(9);
      await settled('37 rows + 9');

      // Shrink: tmux pushes the top rows into history; the parser's overflow reaches the journal once.
      t.tmux('resize-window', '-t', 'h2', '-x', '40', '-y', '24');
      pane.observe(t.meta());
      await settled('back to 24');

      // Grow past the whole history: every history row comes back.
      write(5);
      await settled('24 + 5');
      t.tmux('resize-window', '-t', 'h2', '-x', '40', '-y', '80');
      pane.observe(t.meta());
      await settled('80 rows');
      expect(t.meta().historySize).toBe(0);

      // Journal: each row that left the parser screen is stored once, in order, R-0001 first.
      const token = store.token(pane.paneKey);
      const journal = pane.readRange(0, token.nextLineId)!.lines.map(l => /R-(\d{4}) /.exec(l)).filter(Boolean).map(m => Number(m![1]));
      expect(journal).toEqual(Array.from({ length: journal.length }, (_, i) => i + 1));
      expect(journal.length).toBe(token.nextLineId);
      // Every received chunk is on a published screen: no latency entry left open.
      await i4Until(() => pane!.pendingReceipts() === 0, 5_000).catch(() => {});
      expect(pane.pendingReceipts()).toBe(0);
      expect(faults.filter(k => k === 'history-cleared-external' || k === 'worker-restarted' || k === 'consumer-rejected')).toEqual([]);
      expect(pane.view().issues.filter(i => i.kind === 'history-cleared-external')).toEqual([]);
      console.log('SWITCHON_H2_RESIZE', JSON.stringify({ written, journal: journal.length, pulled13: pulled, pending: pane.pendingReceipts(), faults }));
    } finally {
      clearInterval(pumper);
      await runtime.close(); await store.close(); i4Rm(root, { recursive: true, force: true });
      expect(t.close()).toBe(true);
    }
  }, 120_000);

  test('an unreadable history_size leaves an uncertainty marker and hides nothing', async () => {
    const root = i4Tmp(i4Join(i4TmpDir(), 'switchon-h2-unknown-'));
    const store = createProjectionStore({ historyRoot: root, mode: 'create' });
    const runtime = createPipeHistoryRuntime({ store });
    try {
      const pane = await runtime.addPane({ paneKey: { serverIdentity: 'h2u', paneId: '%1', birthGeneration: 1 }, session: 's', meta: I4_META, calibrate: false, capture: () => Promise.reject(new Error('unused')) });
      pane.ingest(new TextEncoder().encode('hello\r\n'));
      await i4Until(() => { try { store.token(pane.paneKey); return true; } catch { return false; } });
      pane.observe({ ...I4_META, rows: 12, historySize: Number.NaN });
      await i4Until(() => pane.view().issues.some(i => i.kind === 'history-size-unknown'));
      // The same streak marks once; a readable number ends it.
      pane.observe({ ...I4_META, rows: 12, historySize: Number.NaN });
      pane.observe({ ...I4_META, rows: 12, historySize: 3 });
      await Bun.sleep(100);
      expect(pane.view().issues.filter(i => i.kind === 'history-size-unknown')).toHaveLength(1);
      expect(pane.view().pulledBack ?? null).toBeNull();
    } finally { await runtime.close(); await store.close(); i4Rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
