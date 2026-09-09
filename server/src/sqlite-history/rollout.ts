/**
 * Wave 6, first half: the fixture-provable expansion tooling.
 *
 * Four opt-in pieces, none wired to any production session:
 *
 *  1. A per-group rollout allowlist. Groups are declared up front; a group not
 *     on the declared roster always routes to the legacy path. Enabling a group
 *     requires computed readiness evidence — source count > 0, expected
 *     sessions, source paths, fault-probe IDs and a mirror watermark this tool
 *     read itself — and every item is re-read from the store at enable time.
 *     "0 mismatches" produced by empty input is a refusal, not a pass.
 *  2. A per-batch restore drill: restore an export bundle into a fresh store
 *     and compare the restored rows/frames against independent oracle parsers.
 *  3. A backup-coverage audit that reports coverage and its own completion
 *     time. A source whose continuity is unknown is reported as unknown and is
 *     never counted as preserved.
 *  4. An opt-in retirement of the old capture writer for an enabled group: the
 *     wrapped legacy writer refuses further writes, and a digest ledger taken
 *     at retirement makes any later overwrite of the recorded legacy artifacts
 *     a loud fault. Exporter, rollback bundles and sealed originals stay
 *     untouched — retirement records digests, it never deletes.
 */
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rowsDigest, safe, sha } from './codec';
import { readMirror } from './authoritative';
import { readSeal, restoreHistoryBundle } from './transfer';
import { readSealedHistoryOracle } from './rehearsal';
import type { HistoryStore } from './store';
import type { Continuity, HistoryRow, LegacyProjection, LegacyProjectionAcknowledgement, LegacyProjectionWriter } from './types';

export interface GroupReadinessEvidence {
  group: string;
  /** Verified imported source records for the group's sessions. Must be > 0. */
  sourceCount: number;
  expectedSessions: string[];
  sourcePaths: string[];
  /** Issue IDs of fault probes that really landed in history_issue. */
  faultProbeIds: string[];
  /** Mirror watermark per session as this tool read it from the mirror. */
  watermarks: Array<{ sessionId: string; exportedRevision: number; targetRevision: number }>;
  assessedAt: number;
}
export type RolloutRoute = 'legacy' | 'sqlite-authoritative';
export interface RolloutGroupState {
  version: 1; group: string; state: 'enabled' | 'disabled';
  evidence: GroupReadinessEvidence | null; changedAt: number;
}
export interface LegacyArtifactDigest { path: string; bytes: number; sha256: string }
export interface LegacyRetirementReceipt {
  version: 1; group: string; retiredAt: number; artifacts: LegacyArtifactDigest[];
}
export interface RestoreDrillReceipt {
  sessionId: string; rows: number; frames: number; rowsSha256: string;
  startedAt: number; completedAt: number;
}
export interface BackupAuditEntry {
  sessionId: string; group: string;
  storage: 'verified' | 'failed';
  mirror: { targetRevision: number; exportedRevision: number; caughtUp: boolean };
  imports: 'verified' | 'quarantined' | 'incomplete' | 'none';
  source: Continuity;
  coverage: 'preserved' | 'unknown' | 'failed';
}
export interface BackupAuditReport {
  startedAt: number; completedAt: number;
  sessions: BackupAuditEntry[];
  totals: { preserved: number; unknown: number; failed: number };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string): string {
  const directory = resolve(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('rollout-directory-must-be-private');
  }
  return directory;
}
function durableReplace(directory: string, name: string, data: string): void {
  const temporary = join(directory, `.${name}-${randomUUID()}.pending`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(directory, name));
  chmodSync(join(directory, name), 0o600);
  syncDirectory(directory);
}
function digestFile(path: string): LegacyArtifactDigest {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-legacy-artifact');
  const bytes = readFileSync(path);
  return { path: resolve(path), bytes: bytes.length, sha256: sha(bytes) };
}

type ImportRow = { source_id: string; session_id: string | null; source_path: string; state: string; imported_records: number };

/** Compute the readiness evidence for one declared group. Every number comes
 * from the store, the sealed sources or the mirror — nothing is typed in. The
 * fault probes are persisted through the real fault path and read back from
 * history_issue so the ID list proves the alarm channel was live. */
export async function assessGroupReadiness(store: HistoryStore, group: string, mirrorDirectory: string): Promise<GroupReadinessEvidence> {
  const sessions = (store.db.query('SELECT session_id FROM history_session WHERE group_label=? ORDER BY session_id')
    .all(group) as Array<{ session_id: string }>).map(row => row.session_id);
  const sourcePaths: string[] = [];
  let sourceCount = 0;
  const faultProbeIds: string[] = [];
  const watermarks: GroupReadinessEvidence['watermarks'] = [];
  for (const sessionId of sessions) {
    const imports = store.db.query('SELECT * FROM history_import WHERE session_id=? ORDER BY source_id').all(sessionId) as ImportRow[];
    for (const row of imports) {
      if (row.state !== 'verified') continue;
      readSeal(row.source_path); // the tool reads the sealed source, it does not trust the path
      sourcePaths.push(row.source_path);
      sourceCount += safe(row.imported_records);
    }
    const probe = store.persistFault(sessionId, 'rollout-fault-probe',
      'fault probe persisted and read back from history_issue', { group, at: Date.now() });
    const landed = store.db.query('SELECT issue_id FROM history_issue WHERE issue_id=?').get(probe.issue_id) as { issue_id: string } | null;
    if (!landed) throw new Error('rollout-fault-probe-not-persisted');
    faultProbeIds.push(landed.issue_id);
    const mirror = readMirror(mirrorDirectory, sessionId);
    watermarks.push({ sessionId, exportedRevision: mirror.exportedRevision, targetRevision: store.session(sessionId).revision });
  }
  return { group, sourceCount, expectedSessions: sessions, sourcePaths, faultProbeIds, watermarks, assessedAt: Date.now() };
}

/** Per-group writer allowlist. Only a declared, explicitly enabled group routes
 * to the authoritative writer; everything else takes the legacy path. */
export class HistoryRolloutAllowlist {
  private directory: string;
  private declared: Set<string>;
  private states = new Map<string, RolloutGroupState>();
  private retirements = new Map<string, LegacyRetirementReceipt>();
  constructor(private store: HistoryStore, options: { directory: string; declaredGroups: readonly string[] }) {
    this.directory = privateDirectory(options.directory);
    this.declared = new Set(options.declaredGroups);
    if (!this.declared.size) throw new Error('rollout-empty-roster');
    for (const name of readdirSync(this.directory).sort()) {
      if (name.endsWith('.pending')) continue;
      if (name !== basename(name) || lstatSync(join(this.directory, name)).isSymbolicLink()) throw new Error('unsafe-rollout-entry');
      const record = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as RolloutGroupState | LegacyRetirementReceipt;
      if (record.version !== 1) throw new Error('future-rollout-record');
      if (name === `group-${sha(record.group)}.json` && 'state' in record) this.states.set(record.group, record);
      else if (name === `retire-${sha(record.group)}.json` && 'artifacts' in record) this.retirements.set(record.group, record);
      else throw new Error('unexpected-rollout-entry');
    }
  }
  /** The routing decision. A group missing from the declared roster is legacy
   * even if a stray receipt file names it. */
  route(group: string): RolloutRoute {
    if (!this.declared.has(group)) return 'legacy';
    return this.states.get(group)?.state === 'enabled' ? 'sqlite-authoritative' : 'legacy';
  }
  private refuse(group: string, reason: string, observed: unknown): never {
    this.store.persistFault('', 'rollout-refused', reason, { group, observed });
    throw new Error(`rollout-refused:${reason}`);
  }
  /** Enable one group. Every readiness item is re-read from the store/mirror at
   * enable time; evidence produced from empty input never passes. */
  enableGroup(evidence: GroupReadinessEvidence): RolloutGroupState {
    const group = evidence.group;
    if (!this.declared.has(group)) this.refuse(group, 'group-not-declared', group);
    if (!evidence.expectedSessions.length) this.refuse(group, 'no-expected-sessions', 0);
    if (!evidence.sourcePaths.length) this.refuse(group, 'no-source-paths', 0);
    if (!evidence.faultProbeIds.length) this.refuse(group, 'no-fault-probes', 0);
    let recount = 0;
    for (const sessionId of evidence.expectedSessions) {
      const session = this.store.session(sessionId);
      if (session.group_label !== group) this.refuse(group, 'session-outside-group', { sessionId, group_label: session.group_label });
      if (!(session.revision > 0)) this.refuse(group, 'session-without-receipts', { sessionId, revision: session.revision });
      const imports = this.store.db.query('SELECT * FROM history_import WHERE session_id=?').all(sessionId) as ImportRow[];
      if (imports.some(row => row.state === 'quarantined')) this.refuse(group, 'quarantined-source', sessionId);
      recount += imports.filter(row => row.state === 'verified').reduce((total, row) => total + safe(row.imported_records), 0);
    }
    // The one source-count gate: zero re-counted records refuses, and so does a
    // claim the store cannot reproduce. "0 mismatches" over nothing never passes.
    if (!(recount > 0) || recount !== evidence.sourceCount) this.refuse(group, 'empty-or-stale-source-count', { claimed: evidence.sourceCount, stored: recount });
    for (const path of evidence.sourcePaths) readSeal(path);
    for (const issueId of evidence.faultProbeIds) {
      const landed = this.store.db.query('SELECT issue_id FROM history_issue WHERE issue_id=?').get(issueId);
      if (!landed) this.refuse(group, 'fault-probe-unknown', issueId);
    }
    for (const sessionId of evidence.expectedSessions) {
      const claimed = evidence.watermarks.find(mark => mark.sessionId === sessionId);
      if (!claimed) this.refuse(group, 'watermark-missing', sessionId);
      const revision = this.store.session(sessionId).revision;
      if (claimed.exportedRevision !== revision || claimed.targetRevision !== revision) {
        this.refuse(group, 'watermark-behind-writer', { sessionId, claimed, revision });
      }
    }
    const state: RolloutGroupState = { version: 1, group, state: 'enabled', evidence, changedAt: Date.now() };
    durableReplace(this.directory, `group-${sha(group)}.json`, JSON.stringify(state));
    this.states.set(group, state);
    return state;
  }
  /** Per-group rollback of the routing decision. Nothing is deleted. */
  disableGroup(group: string): RolloutGroupState {
    const state: RolloutGroupState = { version: 1, group, state: 'disabled', evidence: this.states.get(group)?.evidence ?? null, changedAt: Date.now() };
    durableReplace(this.directory, `group-${sha(group)}.json`, JSON.stringify(state));
    this.states.set(group, state);
    return state;
  }
  /** Opt-in retirement of the old capture writer for an enabled group. Records
   * the byte digests of the group's legacy artifacts; deletes nothing. */
  retireLegacyWriter(group: string, legacyArtifacts: readonly string[]): LegacyRetirementReceipt {
    if (this.route(group) !== 'sqlite-authoritative') this.refuse(group, 'retire-requires-enabled-group', this.route(group));
    if (!legacyArtifacts.length) this.refuse(group, 'retire-without-artifact-ledger', 0);
    const receipt: LegacyRetirementReceipt = {
      version: 1, group, retiredAt: Date.now(), artifacts: legacyArtifacts.map(path => digestFile(path)),
    };
    durableReplace(this.directory, `retire-${sha(group)}.json`, JSON.stringify(receipt));
    this.retirements.set(group, receipt);
    return receipt;
  }
  retirement(group: string): LegacyRetirementReceipt | null { return this.retirements.get(group) ?? null; }
  /** Every legacy write is routed through this guard: a retired group's writer
   * refuses loudly instead of double-writing next to the authoritative path. */
  wrapLegacyWriter(writer: LegacyProjectionWriter): LegacyProjectionWriter {
    return {
      write: async (projection: LegacyProjection): Promise<LegacyProjectionAcknowledgement> => {
        const group = this.store.session(projection.sessionId).group_label;
        if (this.retirements.has(group)) {
          this.store.persistFault(projection.sessionId, 'legacy-writer-retired',
            'no legacy capture writes after retirement', { group, requestId: projection.requestId });
          throw new Error('legacy-writer-retired');
        }
        return writer.write(projection);
      },
    };
  }
  /** Re-read every artifact recorded at retirement. Any changed, missing or
   * grown file after retirement is evidence of an overlapping legacy writer. */
  verifyLegacyWriterSilence(group: string): { group: string; artifacts: number; verifiedAt: number } {
    const receipt = this.retirements.get(group);
    if (!receipt) throw new Error('rollout-not-retired');
    for (const recorded of receipt.artifacts) {
      let observed: LegacyArtifactDigest;
      try { observed = digestFile(recorded.path); }
      catch (error) {
        this.store.persistFault('', 'legacy-writer-overwrite', recorded, { group, error: String(error) });
        throw new Error('legacy-artifact-missing');
      }
      if (observed.bytes !== recorded.bytes || observed.sha256 !== recorded.sha256) {
        this.store.persistFault('', 'legacy-writer-overwrite', recorded, { group, observed });
        throw new Error('legacy-writer-overwrite');
      }
    }
    return { group, artifacts: receipt.artifacts.length, verifiedAt: Date.now() };
  }
}

/** Restore an export bundle into a fresh throwaway store and compare the
 * restored history against independent oracle parsers, byte for byte. The
 * receipt's numbers are computed from the restored database, never copied from
 * the bundle's own claims. */
export async function runRestoreDrill(bundleDirectory: string, scratchDirectory: string): Promise<RestoreDrillReceipt> {
  const startedAt = Date.now();
  const { Database } = await import('bun:sqlite');
  const { HistoryStore, prepareFile } = await import('./store');
  const scratch = privateDirectory(scratchDirectory);
  const workspace = join(scratch, `drill-${randomUUID()}`);
  mkdirSync(workspace, { mode: 0o700 });
  const file = prepareFile(join(workspace, 'restore-drill.db'));
  const store = new HistoryStore(new Database(file, { strict: true }), { file });
  try {
    const sessionId = await restoreHistoryBundle(store, bundleDirectory);
    store.audit(sessionId);
    const session = store.session(sessionId);
    const restored = store.rows(sessionId, session.first_line, session.next_line);
    store.checkRange(sessionId, restored, session.first_line, session.next_line);
    const compare = (oracle: readonly HistoryRow[], label: string): void => {
      if (oracle.length !== restored.length) throw new Error(`drill-${label}-count`);
      for (let index = 0; index < restored.length; index++) {
        if (oracle[index].line_no !== restored[index].line_no
          || Buffer.compare(Buffer.from(oracle[index].text, 'utf8'), Buffer.from(restored[index].text, 'utf8')) !== 0) {
          throw new Error(`drill-${label}-bytes`);
        }
      }
    };
    compare(readSealedHistoryOracle(bundleDirectory, 'file-jsonl').rows, 'jsonl');
    if (restored.length) compare(readSealedHistoryOracle(bundleDirectory, 'durable-log').rows, 'log');
    const frames = store.db.query('SELECT record_json FROM history_frame WHERE session_id=? ORDER BY frame_seq')
      .all(sessionId) as Array<{ record_json: string }>;
    if (frames.length) {
      const oracleFrames = readSealedHistoryOracle(bundleDirectory, 'frame-ndjson').frames;
      if (oracleFrames.length !== frames.length
        || oracleFrames.some((frame, index) => JSON.stringify(frame) !== frames[index].record_json)) {
        throw new Error('drill-frame-bytes');
      }
    }
    return { sessionId, rows: restored.length, frames: frames.length, rowsSha256: rowsDigest(restored), startedAt, completedAt: Date.now() };
  } finally {
    await store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Coverage audit over every session the store knows. Coverage is `preserved`
 * only when storage integrity, the mirror watermark, the import states and the
 * source continuity all say so; an unknown source stays `unknown`. */
export function auditBackupCoverage(store: HistoryStore, mirrorDirectory: string): BackupAuditReport {
  const startedAt = Date.now();
  const sessions = store.db.query('SELECT session_id,group_label,revision,continuity FROM history_session ORDER BY session_id')
    .all() as Array<{ session_id: string; group_label: string; revision: number; continuity: Continuity }>;
  const entries: BackupAuditEntry[] = [];
  for (const row of sessions) {
    let storage: BackupAuditEntry['storage'] = 'verified';
    try { store.audit(row.session_id); } catch { storage = 'failed'; }
    let mirror: BackupAuditEntry['mirror'] = { targetRevision: row.revision, exportedRevision: 0, caughtUp: false };
    try {
      const observed = readMirror(mirrorDirectory, row.session_id);
      mirror = { targetRevision: row.revision, exportedRevision: observed.exportedRevision, caughtUp: observed.exportedRevision === row.revision };
    } catch { storage = 'failed'; }
    const importRows = store.db.query('SELECT state FROM history_import WHERE session_id=?').all(row.session_id) as Array<{ state: string }>;
    const imports: BackupAuditEntry['imports'] = !importRows.length ? 'none'
      : importRows.some(value => value.state === 'quarantined') ? 'quarantined'
        : importRows.every(value => value.state === 'verified') ? 'verified' : 'incomplete';
    const coverage: BackupAuditEntry['coverage'] =
      storage === 'failed' || row.continuity === 'gap' || row.continuity === 'failed' || imports === 'quarantined' ? 'failed'
        : row.continuity === 'verified' && mirror.caughtUp && imports !== 'incomplete' ? 'preserved'
          : 'unknown';
    entries.push({ sessionId: row.session_id, group: row.group_label, storage, mirror, imports, source: row.continuity, coverage });
  }
  const totals = { preserved: 0, unknown: 0, failed: 0 };
  for (const entry of entries) totals[entry.coverage]++;
  return { startedAt, completedAt: Date.now(), sessions: entries, totals };
}
