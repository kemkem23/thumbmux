import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './sqlite-history/helpers';
import { HistoryStore } from '../src/sqlite-history/store';
import { importHistorySnapshot, sealHistorySnapshot } from '../src/sqlite-history/transfer';
import { verifyImportedSnapshot } from '../src/sqlite-history/rehearsal';

const LINES = Array.from({ length: 40 }, (_, i) => (i === 0 ? '' : `row:${i}:histd-fixture ไทย漢字\x1b[31m`));

function hostChunks(lines: string[], extra?: Record<string, string>): Record<string, string> {
  return {
    '000000000000.json': JSON.stringify(lines),
    'manifest.json': JSON.stringify({
      version: 1,
      session: 'histd-fixture',
      totalLines: lines.length,
      chunks: [{ file: '000000000000.json', startLine: 0, lineCount: lines.length }],
      updatedAt: '2026-09-10T00:00:00.000Z',
    }),
    ...extra,
  };
}

function sealFiles(dir: string, name: string, files: Record<string, string>): string {
  const raw = join(dir, `${name}-raw`);
  mkdirSync(raw, { mode: 0o700 });
  for (const [path, data] of Object.entries(files)) writeFileSync(join(raw, path), data);
  const sealed = join(dir, `${name}-sealed`);
  sealHistorySnapshot(raw, sealed);
  return sealed;
}

function importError(store: HistoryStore, sourceId: string): string | null {
  const row = store.db.query('SELECT evidence_json FROM history_import WHERE source_id=?').get(sourceId) as { evidence_json: string } | null;
  if (!row) return null;
  return (JSON.parse(row.evidence_json) as { error?: string | null }).error ?? null;
}

async function importHostChunks(store: HistoryStore, sourceId: string, snapshotDirectory: string, name: string) {
  const sid = await store.register({ name, lifecycleKey: sourceId, firstLine: 0 });
  const opts = { sourceId, sessionId: sid, snapshotDirectory, format: 'host-chunks' as const };
  const imported = await importHistorySnapshot(store, opts);
  return { sid, opts, imported };
}

test('histd host-chunks green import verifies 40 synthetic rows', async () => {
  const f = fixture();
  try {
    const directory = sealFiles(f.dir, 'green', hostChunks(LINES));
    const { sid, opts, imported } = await importHostChunks(f.store, 'histd-green', directory, 'green');
    expect(imported.state).toBe('verified');
    expect(imported.records).toBe(40);
    const report = verifyImportedSnapshot(f.store, opts);
    expect(report.ready).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.rows).toEqual({ expected: 40, observed: 40, sha256: report.rows.sha256 });
    expect(f.store.rows(sid, 0, 40).map(row => row.text)).toEqual(LINES);
    console.log('HISTD_GREEN', JSON.stringify({
      state: imported.state, records: imported.records, unresolved: report.unresolved.length,
      files: report.manifest.files, bytes: report.manifest.bytes, sha256: report.manifest.sha256,
    }));
  } finally { await f.cleanup(); }
});

test('histd cut-row copy fails at manifest-count', async () => {
  const f = fixture();
  try {
    const cut = LINES.slice(0, -1);
    const files = hostChunks(LINES);
    files['000000000000.json'] = JSON.stringify(cut);
    const manifest = JSON.parse(files['manifest.json']) as {
      version: 1; totalLines: number; chunks: Array<{ file: string; startLine: number; lineCount: number }>;
    };
    manifest.chunks[0].lineCount = cut.length;
    files['manifest.json'] = JSON.stringify(manifest);
    const directory = sealFiles(f.dir, 'cut', files);
    const { opts, imported } = await importHostChunks(f.store, 'histd-cut', directory, 'cut');
    expect(imported.state).toBe('quarantined');
    expect(importError(f.store, 'histd-cut')).toContain('manifest-count');
    expect(() => verifyImportedSnapshot(f.store, opts)).toThrow(/migration-unresolved/);
    console.log('HISTD_RED_MANIFEST_COUNT', JSON.stringify({
      state: imported.state, records: imported.records, error: importError(f.store, 'histd-cut'),
    }));
  } finally { await f.cleanup(); }
});

test('histd orphan json fails at orphan-chunk', async () => {
  const f = fixture();
  try {
    const directory = sealFiles(f.dir, 'orphan', hostChunks(LINES, { 'orphan.json': JSON.stringify(['lost']) }));
    const { opts, imported } = await importHostChunks(f.store, 'histd-orphan', directory, 'orphan');
    expect(imported.state).toBe('quarantined');
    expect(importError(f.store, 'histd-orphan')).toContain('orphan-chunk');
    expect(() => verifyImportedSnapshot(f.store, opts)).toThrow();
    console.log('HISTD_RED_ORPHAN_CHUNK', JSON.stringify({
      state: imported.state, records: imported.records, error: importError(f.store, 'histd-orphan'),
    }));
  } finally { await f.cleanup(); }
});

test('histd restore after mutations is green again', async () => {
  const f = fixture();
  try {
    const directory = sealFiles(f.dir, 'restore', hostChunks(LINES));
    const { sid, opts, imported } = await importHostChunks(f.store, 'histd-restore', directory, 'restore');
    expect(imported.state).toBe('verified');
    const report = verifyImportedSnapshot(f.store, opts);
    expect(report.ready).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(f.store.rows(sid, 0, 40)).toHaveLength(40);
    console.log('HISTD_RESTORE_GREEN', JSON.stringify({
      state: imported.state, records: imported.records, unresolved: report.unresolved.length,
    }));
  } finally { await f.cleanup(); }
});
