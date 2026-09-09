import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha } from './codec';
import { HistoryCoordinator } from './coordinator';
import type { HistoryStore } from './store';
import { compareShadowBatch, verifyDualWriteAcknowledgement } from './detectors';
import type {
  CaptureBatch, CaptureReceipt, DualWriteReceipt, HistoryBridgeLedgerEntry,
  HistoryBridgeOptions, HistoryCaptureBridge, HistoryShadowBridgeOptions, LegacyProjection,
  ShadowBatchSnapshot, ShadowComparisonReport,
} from './types';

type StoredBatch = Omit<CaptureBatch, 'unresolved'> & { unresolved?: string };
type SpoolEntry = HistoryBridgeLedgerEntry & { version: 1; batch: StoredBatch;
  legacyShadow?: ShadowBatchSnapshot; shadowReport?: ShadowComparisonReport };

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function privateDirectory(path: string): string {
  const directory = resolve(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('bridge-spool-must-be-private');
  }
  return directory;
}

function projection(batch: CaptureBatch): LegacyProjection {
  return {
    requestId: batch.ticket.requestId,
    sessionId: batch.ticket.sessionId,
    rows: structuredClone(batch.appended),
    screen: structuredClone(batch.observation.screen),
    raw: structuredClone(batch.observation.raw),
    geometry: structuredClone(batch.observation.geometry),
    source: structuredClone(batch.observation.source),
    at: batch.observation.at,
    ...(batch.frame ? { frame: structuredClone(batch.frame) } : {}),
  };
}

export function legacyProjectionDigest(value: LegacyProjection): string {
  return sha(JSON.stringify(value));
}

function encodeBatch(batch: CaptureBatch): StoredBatch {
  const { unresolved, ...rest } = structuredClone(batch);
  return { ...rest, ...(unresolved ? { unresolved: Buffer.from(unresolved).toString('base64') } : {}) };
}

function decodeBatch(batch: StoredBatch): CaptureBatch {
  const { unresolved, ...rest } = structuredClone(batch);
  return { ...rest, ...(unresolved ? { unresolved: Buffer.from(unresolved, 'base64') } : {}) };
}

class BridgeSpool {
  readonly directory: string;
  constructor(directory: string) { this.directory = privateDirectory(directory); }
  private path(requestId: string): string { return join(this.directory, `${sha(requestId)}.json`); }
  private readPath(path: string): SpoolEntry {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('unsafe-bridge-spool-entry');
    const entry = JSON.parse(readFileSync(path, 'utf8')) as SpoolEntry;
    if (entry.version !== 1 || !entry.requestId || basename(path) !== `${sha(entry.requestId)}.json`) throw new Error('invalid-bridge-spool-entry');
    if (entry.digest !== legacyProjectionDigest(projection(decodeBatch(entry.batch)))) throw new Error('bridge-spool-digest');
    return entry;
  }
  list(): SpoolEntry[] {
    return readdirSync(this.directory).sort().map(name => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('unexpected-bridge-spool-entry');
      return this.readPath(join(this.directory, name));
    });
  }
  accept(batch: CaptureBatch): SpoolEntry {
    const path = this.path(batch.ticket.requestId), digest = legacyProjectionDigest(projection(batch));
    if (existsSync(path)) {
      const old = this.readPath(path);
      if (old.sessionId !== batch.ticket.sessionId || old.digest !== digest) throw new Error('bridge-request-conflict');
      return old;
    }
    const entry: SpoolEntry = { version: 1, requestId: batch.ticket.requestId, sessionId: batch.ticket.sessionId,
      digest, legacyCommitted: false, sqliteCommitted: false, sqliteRevision: null, batch: encodeBatch(batch) };
    this.write(entry, false);
    return entry;
  }
  update(entry: SpoolEntry): void { this.write(entry, true); }
  private write(entry: SpoolEntry, replace: boolean): void {
    const target = this.path(entry.requestId), temporary = join(this.directory, `.${sha(entry.requestId)}-${randomUUID()}.pending`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); } finally { closeSync(fd); }
    if (!replace && existsSync(target)) throw new Error('bridge-spool-race');
    renameSync(temporary, target); chmodSync(target, 0o600); syncDirectory(this.directory);
  }
}

/** Opt-in dual writer. The durable spool is admitted before either backend and the
 * legacy projection is acknowledged before SQLite while legacy remains authoritative. */
export class OptInHistoryBridge implements HistoryCaptureBridge {
  private spool: BridgeSpool;
  private coordinator: HistoryCoordinator;
  constructor(private store: HistoryStore, private options: HistoryBridgeOptions | HistoryShadowBridgeOptions) {
    this.spool = new BridgeSpool(options.spoolDirectory);
    this.coordinator = new HistoryCoordinator(store, options, batch => this.commit(batch));
  }
  private shadow():HistoryShadowBridgeOptions['shadow']|null {
    return 'shadow' in this.options ? this.options.shadow : null;
  }
  private needsResume(entry:SpoolEntry):boolean {
    return !entry.legacyCommitted || !entry.sqliteCommitted || !!this.shadow()&&!entry.shadowDelivered;
  }
  private async commit(input: CaptureBatch): Promise<CaptureReceipt> {
    let entry = this.spool.accept(input);
    const batch = decodeBatch(entry.batch);
    if (!entry.legacyCommitted) {
      const value = projection(batch), acknowledgement = await this.options.legacyProjection.write(structuredClone(value));
      verifyDualWriteAcknowledgement(value, acknowledgement);
      entry = { ...entry, legacyCommitted: true, ...(acknowledgement.shadow?{legacyShadow:structuredClone(acknowledgement.shadow)}:{}) };
      this.spool.update(entry);
    }
    const fresh = { ...batch, ticket: this.store.ticket(entry.sessionId, entry.requestId) };
    const receipt = await this.store.commit(fresh);
    if (receipt.requestId !== entry.requestId) throw new Error('bridge-sqlite-request-mismatch');
    if (!entry.sqliteCommitted || entry.sqliteRevision !== receipt.context.revision) {
      entry = { ...entry, sqliteCommitted: true, sqliteRevision: receipt.context.revision };
      this.spool.update(entry);
    }
    const shadow=this.shadow();
    if(shadow) {
      if(!entry.legacyShadow)throw new Error('shadow-legacy-snapshot-missing');
      if(!entry.shadowCompared) {
        const sqlite=this.store.shadowSnapshot(entry.sessionId,entry.requestId);
        const oracle=shadow.sourceOracle(projection(batch));
        entry={...entry,shadowCompared:true,shadowDelivered:entry.shadowDelivered??false,
          shadowReport:compareShadowBatch(entry.sessionId,entry.legacyShadow,sqlite,oracle,(shadow.now??Date.now)())};
        this.spool.update(entry);
      }
      if(!entry.shadowDelivered) {
        await shadow.onComparison(structuredClone(entry.shadowReport!));
        entry={...entry,shadowDelivered:true};this.spool.update(entry);
      }
    }
    return receipt;
  }
  start(): void {
    if (this.spool.list().some(entry => this.needsResume(entry))) throw new Error('bridge-pending-requires-resume');
    this.coordinator.start();
  }
  async probe(sessionId: string): Promise<DualWriteReceipt> {
    const sqlite = await this.coordinator.probe(sessionId);
    const entry = this.spool.list().find(item => item.requestId === sqlite.requestId);
    if (!entry?.legacyCommitted || !entry.sqliteCommitted) throw new Error('bridge-incomplete-receipt');
    return { sqlite, requestId: entry.requestId, digest: entry.digest, legacyCommitted: true, sqliteCommitted: true };
  }
  async resumePending(): Promise<HistoryBridgeLedgerEntry[]> {
    for (const entry of this.spool.list()) if (this.needsResume(entry)) await this.commit(decodeBatch(entry.batch));
    return this.ledger();
  }
  ledger(): HistoryBridgeLedgerEntry[] {
    return this.spool.list().map(({ batch: _batch, version: _version, legacyShadow:_legacyShadow, shadowReport:_shadowReport, ...entry }) => entry);
  }
  stopAndDrain(): Promise<void> { return this.coordinator.stopAndDrain(); }
}
