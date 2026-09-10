import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './sqlite-history/helpers';
import { HistoryStore } from '../src/sqlite-history/store';
import { importHistorySnapshot, sealHistorySnapshot } from '../src/sqlite-history/transfer';
import { verifyImportedSnapshot } from '../src/sqlite-history/rehearsal';

const LINES = Array.from({ length: 40 }, (_, i) => (i === 0 ? '' : `row:${i}:orphan-sidecar ไทย漢字\x1b[31m`));

/** Fake host metadata. Checksum is not verified by the importer; this is not a live room. */
const LIFECYCLE_BINDING = JSON.stringify({
  version: 2,
  kind: 'terminal-history-lifecycle-binding',
  session: 'orphan-sidecar-fixture',
  ownerKind: 'instance',
  ownerId: 'fake-instance-id',
  bindingId: '00000000-0000-4000-8000-000000000001',
  boundAt: '2026-09-10T00:00:00.000Z',
  recordSha256: '0'.repeat(64),
});

function hostChunks(lines: string[], extra?: Record<string, string>): Record<string, string> {
  return {
    '000000000000.json': JSON.stringify(lines),
    'manifest.json': JSON.stringify({
      version: 1,
      session: 'orphan-sidecar-fixture',
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

test('orphan sidecar lifecycle-binding.json imports green', async () => {
  const f = fixture();
  try {
    const directory = sealFiles(f.dir, 'sidecar', hostChunks(LINES, { 'lifecycle-binding.json': LIFECYCLE_BINDING }));
    const { sid, opts, imported } = await importHostChunks(f.store, 'orphan-sidecar-green', directory, 'sidecar');
    expect(imported.state).toBe('verified');
    expect(imported.records).toBe(40);
    const report = verifyImportedSnapshot(f.store, opts);
    expect(report.ready).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(f.store.rows(sid, 0, 40).map(row => row.text)).toEqual(LINES);
    console.log('ORPHAN_SIDECAR_GREEN', JSON.stringify({
      state: imported.state, records: imported.records, unresolved: report.unresolved.length,
    }));
  } finally { await f.cleanup(); }
});

test('orphan real garbage json still fails at orphan-chunk', async () => {
  const f = fixture();
  try {
    const withSidecar = sealFiles(f.dir, 'orphan-with-sidecar', hostChunks(LINES, {
      'lifecycle-binding.json': LIFECYCLE_BINDING,
      'orphan.json': JSON.stringify(['lost']),
    }));
    const withSidecarImport = await importHostChunks(f.store, 'orphan-sidecar-garbage', withSidecar, 'garbage');
    expect(withSidecarImport.imported.state).toBe('quarantined');
    expect(importError(f.store, 'orphan-sidecar-garbage')).toContain('orphan-chunk');
    expect(() => verifyImportedSnapshot(f.store, withSidecarImport.opts)).toThrow();

    const leftoverChunk = sealFiles(f.dir, 'orphan-leftover', hostChunks(LINES, {
      '000000000500.json': JSON.stringify(['not-in-manifest']),
    }));
    const leftoverSid = await f.store.register({ name: 'leftover', lifecycleKey: 'orphan-sidecar-leftover', firstLine: 0 });
    const leftoverOpts = { sourceId: 'orphan-sidecar-leftover', sessionId: leftoverSid, snapshotDirectory: leftoverChunk, format: 'host-chunks' as const };
    const leftoverImported = await importHistorySnapshot(f.store, leftoverOpts);
    expect(leftoverImported.state).toBe('quarantined');
    expect(importError(f.store, 'orphan-sidecar-leftover')).toContain('orphan-chunk');
    console.log('ORPHAN_SIDECAR_RED_GARBAGE', JSON.stringify({
      withSidecar: withSidecarImport.imported.state,
      leftover: leftoverImported.state,
      error: importError(f.store, 'orphan-sidecar-garbage'),
    }));
  } finally { await f.cleanup(); }
});

test('orphan cut-row still fails at manifest-count', async () => {
  const f = fixture();
  try {
    const cut = LINES.slice(0, -1);
    const files = hostChunks(LINES, { 'lifecycle-binding.json': LIFECYCLE_BINDING });
    files['000000000000.json'] = JSON.stringify(cut);
    const manifest = JSON.parse(files['manifest.json']) as {
      version: 1; totalLines: number; chunks: Array<{ file: string; startLine: number; lineCount: number }>;
    };
    manifest.chunks[0].lineCount = cut.length;
    files['manifest.json'] = JSON.stringify(manifest);
    const directory = sealFiles(f.dir, 'cut', files);
    const { opts, imported } = await importHostChunks(f.store, 'orphan-sidecar-cut', directory, 'cut');
    expect(imported.state).toBe('quarantined');
    expect(importError(f.store, 'orphan-sidecar-cut')).toContain('manifest-count');
    expect(() => verifyImportedSnapshot(f.store, opts)).toThrow(/migration-unresolved/);
    console.log('ORPHAN_SIDECAR_RED_MANIFEST_COUNT', JSON.stringify({
      state: imported.state, records: imported.records, error: importError(f.store, 'orphan-sidecar-cut'),
    }));
  } finally { await f.cleanup(); }
});
