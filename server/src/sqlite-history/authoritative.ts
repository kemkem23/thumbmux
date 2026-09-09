/**
 * Wave 5: the opt-in authoritative writer path.
 *
 * In this mode the SQLite COMMIT is the primary receipt: a capture is durable
 * when `HistoryStore.commit` returns, and the legacy-shaped files become an
 * export mirror that follows committed sequence numbers. A mirror export
 * failure is a loud fault and a lagging watermark, never a rejected commit and
 * never a silently advanced watermark. The mirror stays required for rollback:
 * `rollbackToLegacy` holds the admission barrier, replays the mirror to the
 * committed revision (C2), exports a full legacy projection that includes every
 * row committed after any earlier cutover point, and verifies that projection
 * against independent oracle parsers before it hands out a receipt.
 *
 * Nothing imports this file outside the opt-in factory entry. No production
 * session, viewer or REST route is wired to it in this wave.
 */
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rowsDigest, safe, sha } from './codec';
import { HistoryCoordinator } from './coordinator';
import { exportHistoryBundle, readSeal } from './transfer';
import { readSealedHistoryOracle } from './rehearsal';
import type { HistoryStore } from './store';
import type {
  CaptureBatch, CaptureReceipt, HistoryCoordinatorOptions, HistoryRow,
} from './types';

/** Stages a real crash test may kill at. The kill itself is a real SIGKILL;
 * this callback only places it between two durable filesystem states. */
export type AuthoritativeMirrorStage =
  | 'sqlite-committed' | 'mirror-temp' | 'mirror-seq' | 'mirror-watermark';

export interface HistoryAuthoritativeBridgeOptions extends HistoryCoordinatorOptions {
  mirrorDirectory: string;
  now?: () => number;
  stage?: (stage: AuthoritativeMirrorStage) => void;
}
export interface AuthoritativeMirrorStatus {
  sessionId: string; targetRevision: number; exportedRevision: number; lagSince: number | null;
}
export interface AuthoritativeRollbackReceipt {
  sessionId: string; c2Revision: number; directory: string;
  rows: number; frames: number; rowsSha256: string;
}
type MirrorSeqRecord = {
  version: 1; sessionId: string; seq: number; requestId: string;
  rowStart: number; rowEnd: number; firstLine: number; liveStart: number; nextLine: number;
  rowsSha256: string; rows: HistoryRow[]; screen: string[]; geometryJson: string;
};
type WatermarkRecord = { version: 1; sessionId: string; exportedRevision: number };

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string): string {
  const directory = resolve(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('mirror-directory-must-be-private');
  }
  return directory;
}
function durableReplace(directory: string, name: string, data: string, afterTemp?: () => void): void {
  const temporary = join(directory, `.${name}-${randomUUID()}.pending`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  afterTemp?.();
  renameSync(temporary, join(directory, name));
  chmodSync(join(directory, name), 0o600);
  syncDirectory(directory);
}
const seqName = (seq: number): string => `seq-${String(safe(seq)).padStart(12, '0')}.json`;

/** SQLite-first writer. The coordinator commits into the store (the primary
 * receipt), then the mirror follows the committed seq. */
export class AuthoritativeHistoryBridge {
  private coordinator: HistoryCoordinator;
  private lagSince = new Map<string, number>();
  private barrier = false;
  constructor(private store: HistoryStore, private options: HistoryAuthoritativeBridgeOptions) {
    privateDirectory(options.mirrorDirectory);
    this.coordinator = new HistoryCoordinator(store, options, batch => this.commitBatch(batch));
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private sessionDirectory(sessionId: string): string {
    return privateDirectory(join(this.options.mirrorDirectory, sha(sessionId)));
  }
  private readWatermark(sessionId: string): number {
    const path = join(this.sessionDirectory(sessionId), 'watermark.json');
    if (!existsSync(path)) return 0;
    const record = JSON.parse(readFileSync(path, 'utf8')) as WatermarkRecord;
    if (record.version !== 1 || record.sessionId !== sessionId) throw new Error('mirror-watermark-identity');
    return safe(record.exportedRevision);
  }
  /** Serialize one committed seq from the store, re-checking the committed digest. */
  private committedRecord(sessionId: string, seq: number): MirrorSeqRecord {
    return this.store.db.transaction(() => {
      const capture = this.store.capture(sessionId, seq);
      const rows = this.store.rows(sessionId, capture.row_start, capture.row_end);
      if (rows.length !== capture.expected_rows || rowsDigest(rows) !== capture.rows_sha256) {
        throw new Error('mirror-source-digest');
      }
      return {
        version: 1 as const, sessionId, seq, requestId: capture.request_id,
        rowStart: capture.row_start, rowEnd: capture.row_end, firstLine: capture.first_line,
        liveStart: capture.live_start, nextLine: capture.next_line, rowsSha256: capture.rows_sha256,
        rows, screen: JSON.parse(capture.screen_json) as string[], geometryJson: capture.geometry_json,
      };
    })();
  }
  /** Export one committed seq. Re-running is idempotent: an existing file must
   * be byte-identical to what the store says or the mirror is in conflict. */
  private exportSeq(sessionId: string, seq: number): void {
    const record = this.committedRecord(sessionId, seq);
    const directory = this.sessionDirectory(sessionId);
    const data = JSON.stringify(record);
    const path = join(directory, seqName(seq));
    if (existsSync(path)) {
      if (sha(readFileSync(path)) !== sha(data)) throw new Error('mirror-conflict');
      return;
    }
    durableReplace(directory, seqName(seq), data, () => this.options.stage?.('mirror-temp'));
    this.options.stage?.('mirror-seq');
  }
  /** Advance the watermark to the highest contiguous exported seq. Never past
   * the committed revision, and only after the seq files are durable. */
  private advanceWatermark(sessionId: string): number {
    const directory = this.sessionDirectory(sessionId);
    const revision = this.store.session(sessionId).revision;
    let exported = this.readWatermark(sessionId);
    while (exported < revision && existsSync(join(directory, seqName(exported + 1)))) exported++;
    durableReplace(directory, 'watermark.json',
      JSON.stringify({ version: 1, sessionId, exportedRevision: exported } satisfies WatermarkRecord));
    this.options.stage?.('mirror-watermark');
    if (exported >= revision) this.lagSince.delete(sessionId);
    return exported;
  }
  /** SQLite COMMIT first: the returned receipt is authoritative even when the
   * mirror export fails. A mirror failure is a fault plus a lagging watermark. */
  async commitBatch(batch: CaptureBatch): Promise<CaptureReceipt> {
    if (this.barrier) throw new Error('authoritative-barrier-held');
    const sessionId = batch.ticket.sessionId;
    const receipt = await this.store.commit(batch);
    this.options.stage?.('sqlite-committed');
    try {
      this.exportSeq(sessionId, receipt.context.revision);
      this.advanceWatermark(sessionId);
    } catch (error) {
      if (!this.lagSince.has(sessionId)) this.lagSince.set(sessionId, this.now());
      this.store.persistFault(sessionId, 'export-failed',
        'mirror export at committed revision', { revision: receipt.context.revision, error: String(error) });
    }
    return receipt;
  }
  start(): void { this.coordinator.start(); }
  probe(sessionId: string): Promise<CaptureReceipt> { return this.coordinator.probe(sessionId); }
  /** Replay the mirror from the durable watermark to the committed revision. */
  resumeMirror(sessionId: string): AuthoritativeMirrorStatus {
    const revision = this.store.session(sessionId).revision;
    for (let seq = this.readWatermark(sessionId) + 1; seq <= revision; seq++) this.exportSeq(sessionId, seq);
    this.advanceWatermark(sessionId);
    return this.mirrorStatus(sessionId);
  }
  mirrorStatus(sessionId: string): AuthoritativeMirrorStatus {
    const targetRevision = this.store.session(sessionId).revision;
    const exportedRevision = this.readWatermark(sessionId);
    if (exportedRevision > targetRevision) throw new Error('mirror-ahead-of-authoritative-writer');
    if (exportedRevision < targetRevision) {
      if (!this.lagSince.has(sessionId)) this.lagSince.set(sessionId, this.now());
    } else this.lagSince.delete(sessionId);
    return { sessionId, targetRevision, exportedRevision, lagSince: this.lagSince.get(sessionId) ?? null };
  }
  /** Hold the barrier, replay the mirror to C2, export the full legacy
   * projection (every row after any earlier C0 included) and verify it against
   * independent oracle parsers before returning a receipt. */
  async rollbackToLegacy(sessionId: string, destination: string): Promise<AuthoritativeRollbackReceipt> {
    this.barrier = true;
    await this.coordinator.stopAndDrain();
    const status = this.resumeMirror(sessionId);
    if (status.exportedRevision !== status.targetRevision) throw new Error('rollback-mirror-lag');
    const c2Revision = status.targetRevision;
    exportHistoryBundle(this.store, sessionId, destination);
    const verified = verifyRollbackBundle(this.store, sessionId, destination);
    if (this.store.session(sessionId).revision !== c2Revision) throw new Error('rollback-moved-past-barrier');
    return { sessionId, c2Revision, directory: destination, ...verified };
  }
  stopAndDrain(): Promise<void> { return this.coordinator.stopAndDrain(); }
}

/** Independent re-read of an exported rollback bundle. The JSONL and LOG
 * projections are parsed by the oracle reader (not the exporter), compared
 * byte for byte against the committed rows, and the full-kind record in
 * `recovery.json` must match exactly — a count-only check cannot pass. */
export function verifyRollbackBundle(store: HistoryStore, sessionId: string, directory: string):
  { rows: number; frames: number; rowsSha256: string } {
  try {
    const session = store.session(sessionId);
    const committed = store.rows(sessionId, session.first_line, session.next_line);
    store.checkRange(sessionId, committed, session.first_line, session.next_line);
    const sealed = readSeal(directory);
    const recovery = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(sealed.files.get('recovery.json') ?? new Uint8Array())) as {
        session: { session_id: string; revision: number; first_line: number; next_line: number };
        lines: HistoryRow[]; frames: Array<{ record_json: string }>;
      };
    if (recovery.session.session_id !== sessionId || recovery.session.revision !== session.revision
      || recovery.session.first_line !== session.first_line || recovery.session.next_line !== session.next_line) {
      throw new Error('rollback-recovery-boundary');
    }
    if (rowsDigest(recovery.lines) !== rowsDigest(committed)) throw new Error('rollback-recovery-rows');
    const compareText = (oracle: readonly HistoryRow[], label: string): void => {
      if (oracle.length !== committed.length) throw new Error(`rollback-${label}-count`);
      for (let index = 0; index < committed.length; index++) {
        if (oracle[index].line_no !== committed[index].line_no
          || Buffer.compare(Buffer.from(oracle[index].text, 'utf8'), Buffer.from(committed[index].text, 'utf8')) !== 0) {
          throw new Error(`rollback-${label}-bytes`);
        }
      }
    };
    compareText(readSealedHistoryOracle(directory, 'file-jsonl').rows, 'jsonl');
    if (committed.length) compareText(readSealedHistoryOracle(directory, 'durable-log').rows, 'log');
    const journal = recovery.frames.map(frame => frame.record_json);
    if (journal.length) {
      const oracleFrames = readSealedHistoryOracle(directory, 'frame-ndjson').frames;
      if (oracleFrames.length !== journal.length
        || oracleFrames.some((frame, index) => JSON.stringify(frame) !== journal[index])) {
        throw new Error('rollback-frame-bytes');
      }
    }
    return { rows: committed.length, frames: journal.length, rowsSha256: rowsDigest(committed) };
  } catch (error) {
    store.persistFault(sessionId, 'rollback-not-ready',
      'exported legacy projection byte-identical to committed history', String(error));
    throw error;
  }
}

/** Read the durable mirror back for audit: every seq file must match its own
 * digest, the watermark must be contiguous, and nothing may run past it. */
export function readMirror(directory: string, sessionId: string):
  { exportedRevision: number; records: MirrorSeqRecord[] } {
  const sessionDirectory = join(resolve(directory), sha(sessionId));
  if (!existsSync(sessionDirectory)) return { exportedRevision: 0, records: [] };
  const names = readdirSync(sessionDirectory).filter(name => !name.endsWith('.pending')).sort();
  let exportedRevision = 0;
  const records: MirrorSeqRecord[] = [];
  for (const name of names) {
    if (name !== basename(name) || lstatSync(join(sessionDirectory, name)).isSymbolicLink()) throw new Error('unsafe-mirror-entry');
    const data = readFileSync(join(sessionDirectory, name), 'utf8');
    if (name === 'watermark.json') {
      const watermark = JSON.parse(data) as WatermarkRecord;
      if (watermark.version !== 1 || watermark.sessionId !== sessionId) throw new Error('mirror-watermark-identity');
      exportedRevision = safe(watermark.exportedRevision);
      continue;
    }
    if (!/^seq-\d{12}\.json$/.test(name)) throw new Error('unexpected-mirror-entry');
    const record = JSON.parse(data) as MirrorSeqRecord;
    if (record.version !== 1 || record.sessionId !== sessionId || seqName(record.seq) !== name) throw new Error('mirror-record-identity');
    if (rowsDigest(record.rows) !== record.rowsSha256) throw new Error('mirror-record-digest');
    records.push(record);
  }
  records.sort((a, b) => a.seq - b.seq);
  if (records.some((record, index) => record.seq !== index + 1)) throw new Error('mirror-sequence-hole');
  if (exportedRevision > records.length) throw new Error('mirror-watermark-past-records');
  return { exportedRevision, records };
}
