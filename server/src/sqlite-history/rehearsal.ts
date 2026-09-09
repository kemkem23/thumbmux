import { basename } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseReplayJournal } from '@thumbmux/core';
import { rowsDigest, safe, sha } from './codec';
import type { HistoryStore } from './store';
import { importHistorySnapshot, readSeal } from './transfer';
import type {
  ClosedHistoryImportOptions, ClosedHistoryImportResult, HistoryImportOptions,
  HistoryRow, LegacyFormat, MigrationUnresolvedEntry, MigrationVerification,
} from './types';
import type { FrameJournalRecordV1 } from '../frame-journal';

type Oracle = { rows: HistoryRow[]; frames: FrameJournalRecordV1[]; screen: string[] };

function decode(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function jsonLines(bytes: Buffer): unknown[] {
  const values: unknown[] = []; let start = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) {
    values.push(JSON.parse(decode(bytes.subarray(start, index)))); start = index + 1;
  }
  if (start !== bytes.length) throw new Error('oracle-partial-record');
  return values;
}
function textLines(bytes: Buffer): string[] {
  const values: string[] = []; let start = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) {
    values.push(decode(bytes.subarray(start, index))); start = index + 1;
  }
  if (start !== bytes.length) throw new Error('oracle-partial-record');
  return values;
}

/** This parser is deliberately separate from the importer parser. It reads every
 * sealed physical record again and never allocates replacement line numbers. */
export function readSealedHistoryOracle(directory: string, format: LegacyFormat): Oracle {
  const { files } = readSeal(directory);
  const required = (name: string): Buffer => { const value = files.get(name); if (!value) throw new Error(`oracle-missing-${name}`); return value; };
  const rows: HistoryRow[] = [], frames: FrameJournalRecordV1[] = []; let screen: string[] = [];
  const add = (line_no: number, text: unknown) => {
    safe(line_no); if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('oracle-invalid-text');
    if (rows.length && line_no !== rows.at(-1)!.line_no + 1) throw new Error('oracle-coordinate-hole');
    rows.push({ line_no, kind: 'terminal', text });
  };
  if (format === 'file-jsonl') {
    const candidates = [...files.keys()].filter(name => /^history-[a-f0-9]+\.jsonl$/.test(name));
    const dataName = files.has('history.jsonl') ? 'history.jsonl' : candidates.length === 1 ? candidates[0] : 'history.jsonl';
    const metaName = dataName === 'history.jsonl' ? 'meta.json' : dataName.slice(0, -1);
    const meta = JSON.parse(decode(required(metaName)));
    if (!Array.isArray(meta.live) || meta.live.some((value: unknown) => typeof value !== 'string')) throw new Error('oracle-invalid-screen');
    screen = meta.live;
    for (const value of jsonLines(required(dataName)) as Array<{ line: number; text: string }>) add(value.line, value.text);
  } else if (format === 'durable-log') {
    const chunks = [...files.keys()].filter(name => /^\d+\.log$/.test(name)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
    if (!chunks.length) throw new Error('oracle-no-log-chunks');
    for (const name of chunks) {
      const start = safe(Number(name.slice(0, -4)));
      textLines(required(name)).forEach((text, index) => add(start + index, text));
    }
  } else if (format === 'host-chunks') {
    const manifest = JSON.parse(decode(required('manifest.json')));
    if (manifest.version !== 1 || !Array.isArray(manifest.chunks)) throw new Error('oracle-invalid-manifest');
    const listed = new Set<string>();
    for (const chunk of manifest.chunks) {
      if (typeof chunk.file !== 'string' || chunk.file !== basename(chunk.file) || listed.has(chunk.file)) throw new Error('oracle-invalid-chunk');
      listed.add(chunk.file); const values = JSON.parse(decode(required(chunk.file)));
      if (!Array.isArray(values) || values.length !== chunk.lineCount) throw new Error('oracle-chunk-count');
      values.forEach((text, index) => add(chunk.startLine + index, text));
    }
    if ([...files.keys()].some(name => name.endsWith('.json') && name !== 'manifest.json' && !listed.has(name))) throw new Error('oracle-orphan-chunk');
  } else {
    const journals = [...files.keys()].filter(name => name.endsWith('.ndjson'));
    const name = files.has('journal.ndjson') ? 'journal.ndjson' : journals.length === 1 ? journals[0] : 'journal.ndjson';
    frames.push(...jsonLines(required(name)) as FrameJournalRecordV1[]);
    parseReplayJournal(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
  }
  return { rows, frames, screen };
}

function digestFrames(frames: readonly FrameJournalRecordV1[]): string { return sha(JSON.stringify(frames)); }
function digestScreen(screen: readonly string[]): string { return sha(JSON.stringify(screen)); }

export function inspectImportedSnapshot(store: HistoryStore, input: HistoryImportOptions): MigrationVerification {
  const source = readSeal(input.snapshotDirectory), oracle = readSealedHistoryOracle(input.snapshotDirectory, input.format);
  const imp = store.db.query('SELECT * FROM history_import WHERE source_id=?').get(input.sourceId) as {
    source_id:string;session_id:string|null;snapshot_sha256:string;snapshot_bytes:number;byte_cursor:number;record_cursor:number;state:string;evidence_json:string
  } | null;
  if (!imp?.session_id) throw new Error('verification-unmapped-import');
  if (imp.snapshot_sha256 !== source.digest || imp.snapshot_bytes !== source.bytes) throw new Error('verification-source-identity');
  const observedRows = store.db.query('SELECT line_no,kind,text FROM history_line WHERE session_id=? ORDER BY line_no').all(imp.session_id) as HistoryRow[];
  const observedFrames = (store.db.query('SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq').all(imp.session_id) as Array<{record_json:string}>)
    .map(row => JSON.parse(row.record_json) as FrameJournalRecordV1);
  const latest = store.db.query('SELECT screen_json FROM history_capture WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(imp.session_id) as {screen_json:string}|null;
  const observedScreen = latest ? JSON.parse(latest.screen_json) as string[] : [];
  const evidence = JSON.parse(imp.evidence_json) as {error?:string|null;totalRecords?:number};
  const expectedRecords = oracle.rows.length + oracle.frames.length;
  const unresolved: MigrationUnresolvedEntry[] = [];
  if (imp.state !== 'verified') unresolved.push({kind:'import-state',expected:'verified',observed:imp.state});
  if (imp.byte_cursor !== source.bytes) unresolved.push({kind:'byte-cursor',expected:source.bytes,observed:imp.byte_cursor});
  if (imp.record_cursor !== expectedRecords || evidence.totalRecords !== expectedRecords) unresolved.push({kind:'record-cursor',expected:expectedRecords,observed:imp.record_cursor});
  if (evidence.error) unresolved.push({kind:'source-error',expected:'none',observed:'present'});
  if (rowsDigest(oracle.rows) !== rowsDigest(observedRows)) unresolved.push({kind:'row-diff',expected:oracle.rows.length,observed:observedRows.length});
  if (digestFrames(oracle.frames) !== digestFrames(observedFrames)) unresolved.push({kind:'frame-diff',expected:oracle.frames.length,observed:observedFrames.length});
  if (digestScreen(oracle.screen) !== digestScreen(observedScreen)) unresolved.push({kind:'screen-diff',expected:oracle.screen.length,observed:observedScreen.length});
  const raw = store.db.query('SELECT count(*) AS count FROM history_capture WHERE session_id=? AND unresolved_capture IS NOT NULL').get(imp.session_id) as {count:number};
  if (raw.count) unresolved.push({kind:'unresolved-capture',expected:0,observed:raw.count});
  return {sourceId:input.sourceId,sessionId:imp.session_id,manifest:{files:source.seal.files.length,bytes:source.bytes,sha256:source.digest},
    rows:{expected:oracle.rows.length,observed:observedRows.length,sha256:rowsDigest(observedRows)},
    frames:{expected:oracle.frames.length,observed:observedFrames.length,sha256:digestFrames(observedFrames)},
    screen:{expected:oracle.screen.length,observed:observedScreen.length,sha256:digestScreen(observedScreen)},
    unresolved,ready:unresolved.length===0};
}

export function assertMigrationReady(report: MigrationVerification): void {
  if (!report.manifest.files) throw new Error('migration-empty-manifest');
  if (report.unresolved.length || !report.ready) throw new Error(`migration-unresolved:${report.unresolved.map(item => item.kind).join(',')}`);
}

export function verifyImportedSnapshot(store: HistoryStore, input: HistoryImportOptions): MigrationVerification {
  const report = inspectImportedSnapshot(store, input);
  try { assertMigrationReady(report); return report; }
  catch (error) { store.persistFault(report.sessionId, 'migration-rehearsal', 'full row/frame/screen diff and zero unresolved entries', String(error)); throw error; }
}

export async function importClosedHistorySession(store: HistoryStore, input: ClosedHistoryImportOptions): Promise<ClosedHistoryImportResult> {
  const old = store.db.query('SELECT session_id FROM history_import WHERE source_id=?').get(input.sourceId) as {session_id:string|null}|null;
  const oracle = readSealedHistoryOracle(input.snapshotDirectory, input.format);
  const sessionId = old?.session_id ?? await store.register({name:input.name,lifecycleKey:input.lifecycleKey,group:input.group,
    firstLine:oracle.rows[0]?.line_no ?? 0});
  if (!sessionId) throw new Error('closed-import-unmapped');
  const options:HistoryImportOptions={sourceId:input.sourceId,sessionId,snapshotDirectory:input.snapshotDirectory,format:input.format,onProgress:input.onProgress};
  const imported = await importHistorySnapshot(store, options);
  if (imported.state !== 'verified') return {sessionId,state:imported.state,records:imported.records,verification:null};
  const verification = verifyImportedSnapshot(store, options);
  if (store.session(sessionId).active) await store.closeSession(sessionId);
  return {sessionId,state:imported.state,records:imported.records,verification};
}
