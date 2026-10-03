/** Opt-in stream-first history store. Owns a dedicated DB, never a legacy DB.
 * WAL/FULL transactions are the durable acknowledgement boundary. No database
 * or timer is created until the explicit constructor is called.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join, sep } from 'node:path';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, statfsSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FLAGON_BUDGET as FB, cellToSemanticCell, normalizedRowsDigest, normalizedGapDigest, normalizedCoverageDigest, coverageProjectionDigest, attachCoverage, archiveInventoryMatches, archiveInventoryDigest, segmentContinuityDigest, orderedControlDigest, inputProvenanceDigest, sourceRecordsDigest, sourceSpoolDigest } from './stream-contract';
import type { FlagOnHistoryPort, SpoolRecord, SpoolAck, RowsAndGapsCommit, RowsAndGapsReceipt, FlagOnRecoveryChunk, RawPosition, OperationFence, PinRequest, SegmentPin, SealedExport, RemoteIndexReceipt, ReclaimReceipt, EvidenceFile, Coverage, CommittedStreamRow } from './stream-contract';
import { STREAM_BUDGET as B, eventKey, validReadOpen, streamCanonical, streamDigest } from './stream-contract';
import type { AppendFinalized, CancelToken, CheckpointCommit, DurableInputReceipt, DurableReceipt,
  FinalizedRow, GapEpisode, HistoryEngine, HistoryPage, HistoryPageCheckpoint, InputEvent, PaneKey, PageCursor,
  RamReceipt, ReadOpenAck, ReadRequest, ReadView, RecoveryChunk, RepairChunk, RepairReceipt,
  Result, RowContent, RowFragment, StreamFailure, StreamIdentity, VtCheckpoint } from './stream-contract';

import type { FlagOnHistoryR2, HistoryAuthorityR2, CatalogAuthorityR2, CoalescedInputR2, SourceChainSliceR2, StagedRowsR2, StagedReceiptR2, AttachReceiptSetR2, AttachDecisionR2, SegmentContinuityR2, OrderedControlR2, ReplayWatermarkR2, ReplayDecisionR2, TimelineHeadR2, TimelinePageR2, TailAnchorR2, BoundedReadR2, LogicalSealR2, RemoteIndexR2, ArchiveInventoryR2, CoverageProjectionR2, Gap, SegmentRowId } from './stream-contract';
import type { NewarchHistoryCursor, NewarchHistoryContinuation, NewarchHistoryState } from '../../core/src/protocol';

export { streamCanonical, streamDigest } from './stream-contract';
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function copy<T>(value: T): T { return frozen(JSON.parse(streamCanonical(value))); }
function bytes(value: unknown): number { return Buffer.byteLength(streamCanonical(value)); }
function safe(n: number): void { if (!Number.isSafeInteger(n) || n < 0) throw Error('unsafe counter'); }
function nonempty(s: string): void { if (typeof s !== 'string' || !s.length || s.length > 4096) throw Error('invalid key'); }
function paneKey(p: PaneKey): string { nonempty(p.serverIdentity); nonempty(p.paneId); safe(p.birthGeneration); return streamCanonical(p); }
function identity(i: StreamIdentity): void { paneKey(i.pane); safe(i.sourceEpoch); safe(i.geometryGeneration); }
function equal(a: unknown, b: unknown): boolean { return streamCanonical(a) === streamCanonical(b); }
function digest(kind: string, r: { digest: string }): void {
  const { digest: d, ...payload } = r;
  if (!/^[a-f0-9]{64}$/.test(d) || streamDigest(kind, payload) !== d) throw Error('digest mismatch');
}
function geometry(g: { columns: number; rows: number }): void {
  safe(g.columns); safe(g.rows);
  if (!g.columns || !g.rows || g.columns > B.maxColumns || g.rows > B.maxRows) throw Error('geometry outside admitted envelope');
}
function content(row: RowContent): void {
  if (!Array.isArray(row.cells) || typeof row.softWrap !== 'boolean') throw Error('invalid row');
  safe(row.wrapPad);
  if (!Array.isArray(row.uncertainFields) || row.uncertainFields.some((x: unknown) => typeof x !== 'string')) throw Error('invalid uncertain fields');
  for (const c of row.cells) {
    if (typeof c.text !== 'string' || !c.text.isWellFormed() || ![0, 1, 2].includes(c.width)
      || !Array.isArray(c.style)) throw Error('invalid cell');
    c.style.forEach(safe);
    if (bytes(c) > B.blockPayloadBytes / 2) throw Error('single cell exceeds block');
  }
}
function fail(error: unknown): StreamFailure {
  const message = String(error);
  if (/SQLITE_(BUSY|LOCKED)/.test(message)) return { status: 'busy', reason: 'snapshot-gate', retryAfterMs: 20 };
  return { status: 'error', code: /SQLITE_|closed/.test(message) ? 'io' : 'integrity', message };
}
const busy = (): StreamFailure => ({ status: 'busy', reason: 'pressure', retryAfterMs: 20 });
const stale = (reason: 'identity' | 'epoch' | 'geometry' | 'route' | 'late-gap' = 'identity'): StreamFailure => ({ status: 'stale', reason });
const ok = <T>(value: T): Result<T> => ({ status: 'ok', value: copy(value) });
type SqlRow = Record<string, string | number | null>;
type PaneState = { identity: StreamIdentity; revision: number; durable: number; head: number; checkpoint: string | null; gap: GapEpisode | null };
type Pending = { state: PaneState; events: Map<string, { request: AppendFinalized; receipt: RamReceipt }>; charge: number };
type Pin = { view: ReadView; db: Database; overlay: ReadonlyMap<number, FinalizedRow>; charge: number;
  ack: ReadOpenAck; opened: boolean; timer: ReturnType<typeof setTimeout> };
// Budget owner is this JS isolate. I must instantiate one engine in its owning
// host thread; separate workers require a shared coordinator, never independent caps.
const pool = { pending: 0, overlays: 0, readers: 0, cache: 0, panes: new Set<string>(), paths: new Set<string>() };
const WRITER_CACHE = 4 * 1024 * 1024, READER_CACHE = 2 * 1024 * 1024;
export interface StreamHistoryOptions {
  /** I streaming path: stage bounded prefixes on disk before final VT commit. */
  stagePrefixesOnDisk?: boolean;
  path: string;
  codecVersions: readonly string[];
  /** Fault injection only: throw/exit here to probe real transaction boundaries. */
  boundary?: (at: 'input-before-write' | 'input-before-commit' | 'input-after-commit' |
    'checkpoint-before-write' | 'checkpoint-before-commit' | 'checkpoint-after-commit' |
    'repair-before-write' | 'repair-before-commit' | 'repair-after-commit') => void;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sh_format(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO sh_format VALUES(1);
CREATE TABLE IF NOT EXISTS sh_pane(pane TEXT PRIMARY KEY, identity TEXT NOT NULL, revision INTEGER NOT NULL,
 durable INTEGER NOT NULL, head INTEGER NOT NULL, checkpoint TEXT, gap TEXT);
CREATE TABLE IF NOT EXISTS sh_input(pane TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
 digest TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(pane,epoch,seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_event(pane TEXT NOT NULL, event TEXT NOT NULL, digest TEXT NOT NULL,
 receipt TEXT NOT NULL, PRIMARY KEY(pane,event)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_checkpoint(pane TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
 revision INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(pane,id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_commit(pane TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
 receipt TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(pane,id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sh_commit_revision ON sh_commit(pane,revision);
CREATE TABLE IF NOT EXISTS sh_repair(pane TEXT NOT NULL, episode TEXT NOT NULL, chunk TEXT NOT NULL,
 digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(pane,episode,chunk)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_row(pane TEXT NOT NULL, line INTEGER NOT NULL, revision INTEGER NOT NULL,
 cell_count INTEGER NOT NULL, metadata TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(pane,line)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sh_fragment(pane TEXT NOT NULL, line INTEGER NOT NULL, start_cell INTEGER NOT NULL,
 end_cell INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, checkpoint TEXT NOT NULL,
 PRIMARY KEY(pane,line,start_cell)) WITHOUT ROWID;
`;

/** Decode one durable row and verify every fragment, page checkpoint and row digest. */
function readStoredRow(db: Database, pane: PaneKey, line: number): FinalizedRow {
  const key = paneKey(pane);
  const meta = db.query('SELECT * FROM sh_row WHERE pane=? AND line=?').get(key, line) as SqlRow | null;
  if (!meta) throw Error('missing durable row');
  const count = Number(meta.cell_count), cells: FinalizedRow['cells'][number][] = [];
  safe(count); let start = 0, totalBytes = Buffer.byteLength(String(meta.metadata));
  do {
    const block = db.query('SELECT * FROM sh_fragment WHERE pane=? AND line=? AND start_cell=?').get(key, line, start) as SqlRow | null;
    if (!block) throw Error('missing row continuation');
    const payload = String(block.payload), end = Number(block.end_cell);
    if (Buffer.byteLength(payload) > B.blockPayloadBytes || end > count || (count && end <= start)) throw Error('invalid fragment bounds');
    totalBytes += Buffer.byteLength(payload);
    if (totalBytes > B.decodeBytes) throw Error('row exceeds decode cap');
    if (block.digest !== streamDigest('fragment', { pane, lineId: line, start, end, payload })) throw Error('fragment checksum');
    const pageCheckpoint = JSON.parse(String(block.checkpoint)) as HistoryPageCheckpoint;
    if (pageCheckpoint.kind !== 'history-page' || !equal(pageCheckpoint.pane, pane) || pageCheckpoint.first.lineId !== line
      || pageCheckpoint.first.cellOffset !== start || pageCheckpoint.payloadBytes !== Buffer.byteLength(payload)
      || pageCheckpoint.rowCount !== 1 || pageCheckpoint.checksum !== block.digest) throw Error('page checkpoint integrity');
    const part = JSON.parse(payload) as FinalizedRow['cells'];
    if (!Array.isArray(part) || part.length !== end - start) throw Error('fragment length');
    for (const cell of part) cells.push(cell);
    start = end;
  } while (start < count);
  const row = { ...JSON.parse(String(meta.metadata)), cells } as FinalizedRow;
  if (streamDigest('row', row) !== meta.digest || row.id.lineId !== line || !equal(row.id.pane, pane)) throw Error('row checksum/identity');
  return row;
}

export class StreamHistoryEngine implements HistoryEngine {
  private readonly db: Database;
  private readonly pending = new Map<string, Pending>();
  private readonly pins = new Map<string, Pin>();
  private closed = false;
  private readonly readers = new Map<Database, PaneKey>();
  private ownPending = 0;
  constructor(private readonly options: StreamHistoryOptions) {
    this.options = options = { ...options, path: options.path === ':memory:' ? options.path : resolve(options.path), codecVersions: [...options.codecVersions] };
    if (options.path === ':memory:' || !options.path || pool.paths.has(options.path)) throw Error('dedicated disk path with one writer required');
    if (!options.codecVersions.length) throw Error('explicit supported VT codecs required');
    if (pool.cache + WRITER_CACHE > B.diskCacheBytes) throw Error('disk cache pressure');
    const db = new Database(options.path, { create: true, strict: true });
    try {
      // Refuse a legacy/non-stream database instead of silently migrating it.
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (tables.some(t => !t.name.startsWith('sh_'))) throw Error('not a dedicated stream database');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA temp_store=FILE;');
      db.transaction(() => db.exec(SCHEMA)).immediate();
      if (Number((db.query('SELECT version FROM sh_format').get() as SqlRow).version) !== 1) throw Error('unsupported stream storage version');
      this.db = db; pool.cache += WRITER_CACHE; pool.paths.add(options.path);
    } catch (e) { db.close(); throw e; }
  }
  private live(): void {
    if (this.closed) throw Error('engine closed');
    for (const p of this.pending.values()) this.reconcilePending(p.state.identity.pane);
  }
  private state(p: PaneKey, db = this.db, includePending = true): PaneState | null {
    const key = paneKey(p);
    if (includePending && db === this.db && this.pending.has(key)) return this.pending.get(key)!.state;
    const r = db.query('SELECT * FROM sh_pane WHERE pane=?').get(key) as SqlRow | null;
    return r ? { identity: JSON.parse(String(r.identity)), revision: Number(r.revision), durable: Number(r.durable),
      head: Number(r.head), checkpoint: r.checkpoint === null ? null : String(r.checkpoint), gap: r.gap === null ? null : JSON.parse(String(r.gap)) } : null;
  }
  private putState(s: PaneState): void {
    this.db.query('INSERT OR REPLACE INTO sh_pane VALUES(?,?,?,?,?,?,?)').run(paneKey(s.identity.pane),
      streamCanonical(s.identity), s.revision, s.durable, s.head, s.checkpoint, s.gap ? streamCanonical(s.gap) : null);
  }
  private match(s: PaneState, i: StreamIdentity): StreamFailure | null {
    if (!equal(s.identity.pane, i.pane)) return stale();
    if (s.identity.sourceEpoch !== i.sourceEpoch) return stale('epoch');
    if (s.identity.geometryGeneration !== i.geometryGeneration) return stale('geometry');
    return null;
  }
  private dropPending(key: string): void {
    const pending = this.pending.get(key);
    if (pending) { pool.pending -= pending.charge; this.ownPending -= pending.charge; this.pending.delete(key); }
  }
  private transaction(kind: 'input' | 'checkpoint' | 'repair', fn: () => void): void {
    this.options.boundary?.(`${kind}-before-write`);
    this.db.transaction(() => { fn(); this.options.boundary?.(`${kind}-before-commit`); }).immediate();
    this.options.boundary?.(`${kind}-after-commit`);
  }
  async journalInput(event: InputEvent): Promise<Result<DurableInputReceipt>> {
    try {
      this.live(); identity(event.identity); safe(event.position.packetSeq); safe(event.position.sourceEpoch);
      if (!event.position.packetSeq || event.position.sourceEpoch !== event.identity.sourceEpoch || !Number.isFinite(event.receivedAtMonoMs) || event.receivedAtMonoMs < 0) throw Error('input identity/time');
      const n = bytes(event);
      if (n > B.rawBytesPerPane || pool.pending + n * 4 > B.pendingBytes) return busy();
      digest('input', event);
      if (event.payload.kind === 'bytes') {
        if (!Array.isArray(event.payload.bytes) || event.payload.bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw Error('invalid byte');
      } else if (event.payload.kind === 'resize') geometry(event.payload.geometry);
      else if (event.payload.kind === 'control') { nonempty(event.payload.name); if (typeof event.payload.data !== 'string') throw Error('invalid control'); }
      else throw Error('unknown input kind');
      const key = paneKey(event.identity.pane), { sourceEpoch, packetSeq } = event.position;
      const old = this.db.query('SELECT digest,receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?').get(key, sourceEpoch, packetSeq) as SqlRow | null;
      if (old) { if (old.digest !== event.digest) throw Error('input identity collision'); return ok(JSON.parse(String(old.receipt))); }
      const state = this.state(event.identity.pane);
      if (state && (sourceEpoch < state.identity.sourceEpoch || event.identity.geometryGeneration < state.identity.geometryGeneration)) return stale('epoch');
      if (state && !equal(state.identity, event.identity) && this.pending.has(key)) return { status: 'busy', reason: 'snapshot-gate', retryAfterMs: 20 };
      const last = this.db.query('SELECT seq FROM sh_input WHERE pane=? AND epoch=? ORDER BY seq DESC LIMIT 1').get(key, sourceEpoch) as SqlRow | null;
      if (packetSeq !== (last ? Number(last.seq) : 0) + 1) throw Error('noncontiguous durable input');
      const receipt: DurableInputReceipt = { kind: 'durable-input', pane: event.identity.pane, through: event.position,
        digest: event.digest, segmentId: streamDigest('segment', { pane: event.identity.pane, position: event.position }) };
      pool.pending += n * 4;
      try { this.transaction('input', () => {
        this.db.query('INSERT INTO sh_input VALUES(?,?,?,?,?,?)').run(key, sourceEpoch, packetSeq, event.digest, streamCanonical(event), streamCanonical(receipt));
        const diskState = this.state(event.identity.pane, this.db, false);
        this.putState(diskState ? { ...diskState, identity: event.identity } : { identity: event.identity, revision: 0, durable: 0, head: 0, checkpoint: null, gap: null });
      }); } finally { pool.pending -= n * 4; }
      return ok(receipt);
    } catch (e) { return fail(e); }
  }
  private validateRows(rows: readonly FinalizedRow[], s: PaneState, revision: number): void {
    if (rows.length > B.decodeRows || bytes(rows) > B.decodeBytes) throw Error('row chunk exceeds decode budget');
    safe(revision); safe(s.head + rows.length);
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j]!;
      safe(row.id.lineId); safe(row.revision); safe(row.source.sourceEpoch); safe(row.source.packetSeq); safe(row.source.scrollOrdinal);
      if (!equal(row.id.pane, s.identity.pane) || !equal(row.source.pane, s.identity.pane) || row.id.lineId !== s.head + j
        || row.revision !== revision || row.geometryGeneration !== s.identity.geometryGeneration || !row.source.packetSeq) throw Error('row identity/revision/order');
      geometry(row.geometry); content(row);
    }
  }
  async appendFinalized(request: AppendFinalized): Promise<Result<RamReceipt>> {
    try {
      this.live(); identity(request.identity); safe(request.expectedRevision); digest('append', request);
      safe(request.eventId.sourceEpoch); safe(request.eventId.packetSeq); safe(request.eventId.scrollOrdinal);
      if (!Number.isFinite(request.receivedAtMonoMs) || request.receivedAtMonoMs < 0 || !request.eventId.packetSeq
        || !equal(request.eventId.pane, request.identity.pane) || request.eventId.sourceEpoch !== request.identity.sourceEpoch) throw Error('event identity/time');
      const key = paneKey(request.identity.pane), ek = eventKey(request.eventId);
      const prior = this.pending.get(key)?.events.get(ek);
      if (prior) { if (prior.request.digest !== request.digest) throw Error('event identity collision'); return ok(prior.receipt); }
      const durable = this.db.query('SELECT digest,receipt FROM sh_event WHERE pane=? AND event=?').get(key, ek) as SqlRow | null;
      if (durable) { if (durable.digest !== request.digest) throw Error('event identity collision'); return ok(JSON.parse(String(durable.receipt))); }
      const state = this.state(request.identity.pane);
      if (!state) return stale();
      const mismatch = this.match(state, request.identity); if (mismatch) return mismatch;
      if (state.gap) return stale('late-gap');
      if (request.expectedRevision !== state.revision) return stale();
      const input = this.db.query('SELECT 1 FROM sh_input WHERE pane=? AND epoch=? AND seq=?').get(key, request.eventId.sourceEpoch, request.eventId.packetSeq);
      if (!input) throw Error('append input is not durable');
      const revision = state.revision + 1; safe(revision);
      this.validateRows(request.rows, state, revision);
      const frame = request.frameDelta;
      if (!equal(frame.identity, request.identity) || (frame.buffer !== 'normal' && frame.buffer !== 'alternate')
        || (frame.buffer === 'alternate' && request.rows.length)) throw Error('frame identity/alternate scroll');
      geometry(frame.geometry); safe(frame.screenRevision); safe(frame.cursor.x); safe(frame.cursor.y);
      if (frame.cursor.x >= frame.geometry.columns || frame.cursor.y >= frame.geometry.rows || typeof frame.cursor.visible !== 'boolean') throw Error('invalid frame cursor');
      if (frame.overlap) { safe(frame.overlap.start); safe(frame.overlap.end); if (frame.overlap.start > frame.overlap.end || frame.overlap.end > state.head + request.rows.length) throw Error('invalid overlap'); }
      const ys = new Set<number>();
      for (const changed of frame.changedRows) { safe(changed.y); if (changed.y >= frame.geometry.rows || ys.has(changed.y)) throw Error('invalid changed row'); ys.add(changed.y); content(changed.content); }
      for (const [j, row] of request.rows.entries()) if (!equal(row.source, {...request.eventId, scrollOrdinal: request.eventId.scrollOrdinal + j}) || !equal(row.geometry, frame.geometry)) throw Error('row source/frame mismatch');
      const charge = bytes(request) * 4;
      if (pool.pending + charge > B.pendingBytes) return busy();
      const owned = copy(request);
      const receipt: RamReceipt = copy({ kind: 'ram', eventId: owned.eventId, digest: owned.digest, revision, head: state.head + request.rows.length });
      if (this.options.stagePrefixesOnDisk) {
        // The input journal makes a partial packet replayable. durable remains
        // at its checkpoint fence; staged rows are not a durable VT receipt.
        this.db.transaction(() => {
          this.writeRows(owned.rows);
          this.db.query('INSERT INTO sh_event VALUES(?,?,?,?)').run(key, ek, owned.digest, streamCanonical(receipt));
          this.putState({...state, revision, head: receipt.head});
        }).immediate();
        return ok(receipt);
      }
      const pending = this.pending.get(key) ?? { state: { ...state }, events: new Map(), charge: 0 };
      pending.state = { ...state, revision, head: receipt.head };
      pending.events.set(ek, { request: owned, receipt }); pending.charge += charge;
      this.pending.set(key, pending); pool.pending += charge; this.ownPending += charge;
      return ok(receipt);
    } catch (e) { return fail(e); }
  }
  private writeRows(rows: readonly FinalizedRow[]): void {
    for (const row of rows) {
      const key = paneKey(row.id.pane), { cells, ...meta } = row;
      this.db.query('INSERT INTO sh_row VALUES(?,?,?,?,?,?)').run(key, row.id.lineId, row.revision, cells.length, streamCanonical(meta), streamDigest('row', row));
      let start = 0;
      while (start < cells.length || (start === 0 && !cells.length)) {
        let end = start, size = 2;
        while (end < cells.length && size + bytes(cells[end]) + 1 <= B.blockPayloadBytes) { size += bytes(cells[end]) + 1; end++; }
        if (end === start && cells.length) throw Error('cell cannot fit block');
        const payload = streamCanonical(cells.slice(start, end));
        const checksum = streamDigest('fragment', { pane: row.id.pane, lineId: row.id.lineId, start, end, payload });
        const prior = this.db.query('SELECT line,start_cell FROM sh_fragment WHERE pane=? ORDER BY line DESC,start_cell DESC LIMIT 1').get(key) as SqlRow | null;
        const blockId = (lineId: number, cellOffset: number) => streamDigest('block-id', { pane: row.id.pane, lineId, cellOffset });
        const checkpoint: HistoryPageCheckpoint = { kind: 'history-page', blockId: blockId(row.id.lineId, start), pane: row.id.pane,
          previousBlockId: prior ? blockId(Number(prior.line), Number(prior.start_cell)) : null,
          first: { lineId: row.id.lineId, cellOffset: start },
          end: end === cells.length ? { lineId: row.id.lineId + 1, cellOffset: 0 } : { lineId: row.id.lineId, cellOffset: end },
          minRevision: row.revision, maxRevision: row.revision, checksum, rowCount: 1, payloadBytes: Buffer.byteLength(payload),
          geometryAndWrap: [{ lineId: row.id.lineId, geometryGeneration: row.geometryGeneration, geometry: row.geometry, softWrap: row.softWrap, wrapPad: row.wrapPad }] };
        this.db.query('INSERT INTO sh_fragment VALUES(?,?,?,?,?,?,?)').run(key, row.id.lineId, start, end, payload, checksum, streamCanonical(checkpoint));
        if (!cells.length) break;
        start = end;
      }
    }
  }
  private flushRows(key: string): void {
    const pending = this.pending.get(key); if (!pending) return;
    for (const [event, value] of pending.events) {
      this.writeRows(value.request.rows);
      this.db.query('INSERT INTO sh_event VALUES(?,?,?,?)').run(key, event, value.request.digest, streamCanonical(value.receipt));
    }
  }
  async commitCheckpoint(request: CheckpointCommit): Promise<Result<DurableReceipt>> {
    try {
      this.live(); digest('checkpoint', request); nonempty(request.commitId); safe(request.expectedRevision);
      const cp = request.checkpoint; identity(cp.identity); nonempty(cp.checkpointId); safe(cp.revision); safe(cp.head);
      const key = paneKey(cp.identity.pane);
      const prior = this.db.query('SELECT digest,receipt FROM sh_commit WHERE pane=? AND id=?').get(key, request.commitId) as SqlRow | null;
      if (prior) { if (prior.digest !== request.digest) throw Error('commit identity collision'); this.reconcilePending(cp.identity.pane); return ok(JSON.parse(String(prior.receipt))); }
      if (bytes(cp) > B.vtBytesPerPane) return busy();
      if (!this.options.codecVersions.includes(cp.state.codecVersion)) return { status: 'error', code: 'unsupported', message: 'VT codec is not admitted' };
      if (cp.kind !== 'vt-recovery' || streamDigest('vt-state', { identity: cp.identity, state: cp.state }) !== cp.stateDigest) throw Error('VT state digest');
      geometry(cp.state.geometry);
      if (!['normal', 'alternate'].includes(cp.state.active) || typeof cp.state.extensionState !== 'string'
        || typeof cp.state.wrapPending !== 'boolean') throw Error('invalid VT state');
      const numericArray = (a: readonly number[]) => { if (!Array.isArray(a)) throw Error('invalid VT array'); a.forEach(safe); };
      const modes = (m: Readonly<Record<string, boolean | number>>) => {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('invalid VT modes');
        for (const value of Object.values(m)) if (typeof value !== 'boolean' && !Number.isFinite(value)) throw Error('invalid VT mode');
      };
      modes(cp.state.modes); numericArray(cp.state.attributes); numericArray(cp.state.tabStops);
      for (const a of [cp.state.pendingUtf8, cp.state.pendingEscape]) { numericArray(a); if (a.some(n => n > 255)) throw Error('invalid pending byte'); }
      const m = cp.state.margins;
      [m.top, m.bottom, m.left, m.right].forEach(safe);
      if (m.top > m.bottom || m.bottom >= cp.state.geometry.rows || m.left > m.right || m.right >= cp.state.geometry.columns) throw Error('invalid margins');
      for (const buffer of [cp.state.normal, cp.state.alternate]) {
        if (!Array.isArray(buffer.rows) || buffer.rows.length > cp.state.geometry.rows || typeof buffer.wrapPending !== 'boolean') throw Error('invalid VT buffer');
        for (const row of buffer.rows) content(row);
        numericArray(buffer.savedAttributes); modes(buffer.savedModes);
        for (const cursor of [buffer.cursor, buffer.savedCursor]) {
          safe(cursor.x); safe(cursor.y);
          if (cursor.x >= cp.state.geometry.columns || cursor.y >= cp.state.geometry.rows || typeof cursor.visible !== 'boolean') throw Error('invalid VT cursor');
        }
      }
      const state = this.state(cp.identity.pane); if (!state) return stale();
      const mismatch = this.match(state, cp.identity); if (mismatch) return mismatch;
      if (state.gap) {
        if (request.closeGap !== state.gap.episodeId || state.gap.reason === 'late-gap')
          return { status: 'error', code: 'unresolved-gap', message: 'checkpoint behind unresolved gap' };
        const final = this.db.query("SELECT 1 FROM sh_repair WHERE pane=? AND episode=? AND json_extract(receipt,'$.finalChunk')=1 LIMIT 1").get(key, request.closeGap);
        if (!final) throw Error('repair rows not sealed');
      } else if (request.closeGap) throw Error('repair episode is not active');
      if (request.expectedRevision !== state.revision || cp.revision !== state.revision || cp.head !== state.head) return stale();
      if (cp.previousCheckpointId !== state.checkpoint) throw Error('checkpoint chain');
      if (this.db.query('SELECT 1 FROM sh_checkpoint WHERE pane=? AND id=?').get(key, cp.checkpointId)) throw Error('checkpoint ID reused');
      const fence = cp.inputFence;
      if (!equal(fence.pane, cp.identity.pane) || fence.through.sourceEpoch !== cp.identity.sourceEpoch) throw Error('checkpoint input identity');
      const input = this.db.query('SELECT receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?').get(key, fence.through.sourceEpoch, fence.through.packetSeq) as SqlRow | null;
      if (!input || !equal(JSON.parse(String(input.receipt)), fence)) throw Error('checkpoint input is not durable');
      for (const event of this.pending.get(key)?.events.values() ?? []) {
        if (event.request.eventId.sourceEpoch !== fence.through.sourceEpoch || event.request.eventId.packetSeq > fence.through.packetSeq) throw Error('checkpoint fence before pending rows');
      }
      const previous = state.checkpoint ? this.db.query('SELECT payload FROM sh_checkpoint WHERE pane=? AND id=?').get(key, state.checkpoint) as SqlRow : null;
      if (previous) {
        const old = JSON.parse(String(previous.payload)) as VtCheckpoint;
        if (fence.through.sourceEpoch < old.inputFence.through.sourceEpoch || (fence.through.sourceEpoch === old.inputFence.through.sourceEpoch && fence.through.packetSeq < old.inputFence.through.packetSeq)) throw Error('checkpoint fence regression');
      }
      const receipt: DurableReceipt = { kind: 'durable', pane: cp.identity.pane, commitId: request.commitId,
        digest: request.digest, durableRevision: state.revision, checkpointId: cp.checkpointId };
      this.transaction('checkpoint', () => {
        this.flushRows(key);
        this.db.query('INSERT INTO sh_checkpoint VALUES(?,?,?,?,?)').run(key, cp.checkpointId, streamCanonical(cp), cp.revision, streamDigest('vt-checkpoint', cp));
        this.db.query('INSERT INTO sh_commit VALUES(?,?,?,?,?)').run(key, request.commitId, request.digest, streamCanonical(receipt), receipt.durableRevision);
        this.putState({ ...state, durable: state.revision, checkpoint: cp.checkpointId, gap: null });
      });
      this.dropPending(key); return ok(receipt);
    } catch (e) { return fail(e); }
  }
  // A fault after COMMIT but before ACK leaves the RAM copy alive; reconcile only
  // the prefix actually covered by the disk watermark, never a later RAM suffix.
  private reconcilePending(pane: PaneKey): void {
    const key = paneKey(pane), p = this.pending.get(key); if (!p) return;
    const disk = this.state(pane, this.db, false)!;
    if (disk.durable >= p.state.revision) { this.dropPending(key); return; }
    for (const [event, value] of p.events) if (value.receipt.revision <= disk.durable) {
      const charge = bytes(value.request) * 4;
      p.events.delete(event); p.charge -= charge; pool.pending -= charge; this.ownPending -= charge;
    }
    p.state = { ...p.state, durable: disk.durable, checkpoint: disk.checkpoint, gap: disk.gap };

  }
  /** Crash recovery in staging mode: rows staged above the durable fence were
   * never readable (reads wait for revision==durable) nor published. Drop them
   * and their event receipts so the journal re-derives them under one fence;
   * a replayed frame need not be byte-identical to the interrupted attempt. */
  discardStaged(pane: PaneKey): Result<{ discardedRows: number }> {
    try {
      this.live(); const key = paneKey(pane);
      if (!this.options.stagePrefixesOnDisk || this.pending.has(key)) return ok({ discardedRows: 0 });
      const state = this.state(pane, this.db, false);
      if (!state || state.revision === state.durable) return ok({ discardedRows: 0 });
      if (state.gap) return { status: 'error', code: 'unresolved-gap', message: 'staged rows behind a gap episode' };
      let discardedRows = 0;
      this.db.transaction(() => {
        const low = this.db.query('SELECT MIN(line) AS line, COUNT(*) AS n FROM sh_row WHERE pane=? AND revision>?').get(key, state.durable) as SqlRow;
        discardedRows = Number(low.n);
        const head = discardedRows ? Number(low.line) : state.head;
        if (this.db.query('SELECT 1 FROM sh_row WHERE pane=? AND line>=? AND revision<=? LIMIT 1').get(key, head, state.durable))
          throw Error('durable row above staged prefix');
        this.db.query('DELETE FROM sh_fragment WHERE pane=? AND line>=?').run(key, head);
        this.db.query('DELETE FROM sh_row WHERE pane=? AND line>=?').run(key, head);
        this.db.query("DELETE FROM sh_event WHERE pane=? AND json_extract(receipt,'$.revision')>?").run(key, state.durable);
        this.putState({ ...state, revision: state.durable, head });
      }).immediate();
      return ok({ discardedRows });
    } catch (e) { return fail(e); }
  }
  /** Persist admitted rows and gap together before acknowledging the fence. */
  beginGap(episode: GapEpisode): Result<null> {
    try {
      this.live(); nonempty(episode.episodeId); paneKey(episode.pane); safe(episode.epochBefore);
      if (episode.epochAfter !== null) { safe(episode.epochAfter); if (episode.epochAfter < episode.epochBefore) throw Error('gap epoch regression'); }
      if (episode.missingCount !== null) safe(episode.missingCount);
      if (!Number.isFinite(episode.firstObservedAtMonoMs) || episode.firstObservedAtMonoMs < 0
        || !['suspected', 'repairing', 'unresolved'].includes(episode.status)) throw Error('invalid gap state');
      if (episode.lastDurableInput) { safe(episode.lastDurableInput.sourceEpoch); safe(episode.lastDurableInput.packetSeq); }
      const state = this.state(episode.pane); if (!state) return stale();
      if (episode.lastAdmittedRow !== null) safe(episode.lastAdmittedRow);
      if (state.gap) return state.gap.episodeId === episode.episodeId && state.gap.epochBefore === episode.epochBefore
        && state.gap.lastAdmittedRow === episode.lastAdmittedRow ? ok(null) : stale('late-gap');
      if (episode.reason === 'late-gap' || episode.lastAdmittedRow !== (state.head ? state.head - 1 : null)) {
        const gap = copy({ ...episode, reason: 'late-gap' as const, status: 'unresolved' as const });
        const disk = this.state(episode.pane, this.db, false)!;
        this.db.transaction(() => this.putState({ ...disk, gap })).immediate();
        const pending = this.pending.get(paneKey(episode.pane)); if (pending) pending.state = { ...pending.state, gap };
        for (const [id, pin] of this.pins) if (equal(pin.view.identity.pane, episode.pane)) this.releasePin(id);
        return stale('late-gap');
      }
      const key = paneKey(episode.pane);
      this.db.transaction(() => {
        this.flushRows(key);
        this.putState({ ...state, durable: state.revision, gap: copy(episode) });
      }).immediate();
      this.dropPending(key); return ok(null);
    } catch (e) { return fail(e); }
  }
  async commitRepair(chunk: RepairChunk): Promise<Result<RepairReceipt>> {
    try {
      this.live(); digest('repair', chunk); nonempty(chunk.chunkId); nonempty(chunk.episode.episodeId); safe(chunk.expectedRevision);
      const key = paneKey(chunk.episode.pane);
      const old = this.db.query('SELECT digest,receipt FROM sh_repair WHERE pane=? AND episode=? AND chunk=?').get(key, chunk.episode.episodeId, chunk.chunkId) as SqlRow | null;
      if (old) { if (old.digest !== chunk.digest) throw Error('repair identity collision'); return ok(JSON.parse(String(old.receipt))); }
      const state = this.state(chunk.episode.pane); if (!state) return stale();
      if (state.revision !== chunk.expectedRevision || this.pending.has(key)) return stale();
      if (!state.gap || state.gap.episodeId !== chunk.episode.episodeId || !state.checkpoint) return { status: 'error', code: 'unresolved-gap', message: 'repair requires fenced episode and VT recovery checkpoint' };
      if (state.gap.reason === 'late-gap' || chunk.episode.reason === 'late-gap') return stale('late-gap');
      if (chunk.episode.epochBefore !== state.gap.epochBefore || chunk.episode.epochAfter !== state.gap.epochAfter
        || chunk.episode.lastAdmittedRow !== state.gap.lastAdmittedRow || typeof chunk.final !== 'boolean') throw Error('repair episode mismatch');
      if (this.db.query("SELECT 1 FROM sh_repair WHERE pane=? AND episode=? AND json_extract(receipt,'$.finalChunk')=1 LIMIT 1").get(key,chunk.episode.episodeId)) throw Error('repair rows already sealed');
      const revision = state.revision + 1; this.validateRows(chunk.rows, state, revision);
      const n = bytes(chunk) * 4; if (pool.pending + n > B.pendingBytes) return busy();
      const durable: DurableReceipt = { kind: 'durable', pane: chunk.episode.pane,
        commitId: streamDigest('repair-id', { pane: chunk.episode.pane, episode: chunk.episode.episodeId, chunk: chunk.chunkId }),
        digest: chunk.digest, durableRevision: revision, checkpointId: state.checkpoint };
      const receipt: RepairReceipt = { committedIds: chunk.rows.map(r => r.id), committedRevision: revision, durable, complete: false, finalChunk: chunk.final };
      pool.pending += n;
      try { this.transaction('repair', () => {
        this.writeRows(chunk.rows);
        this.db.query('INSERT INTO sh_repair VALUES(?,?,?,?,?)').run(key, chunk.episode.episodeId, chunk.chunkId, chunk.digest, streamCanonical(receipt));
        this.db.query('INSERT INTO sh_commit VALUES(?,?,?,?,?)').run(key, durable.commitId, durable.digest, streamCanonical(durable), durable.durableRevision);
        this.putState({ ...state, revision, durable: revision, head: state.head + chunk.rows.length, gap: state.gap });
      }); } finally { pool.pending -= n; }
      return ok(receipt);
    } catch (e) { return fail(e); }
  }
  private readRow(db: Database, pane: PaneKey, line: number): FinalizedRow { return readStoredRow(db, pane, line); }
  private readSlot(pane: PaneKey): string { return paneKey(pane); }
  private reader(pane: PaneKey): Database | null {
    const slot = this.readSlot(pane);
    if (pool.readers >= B.activeReadsGlobal || pool.panes.has(slot) || pool.cache + READER_CACHE > B.diskCacheBytes) return null;
    const db = new Database(this.options.path, { readonly: true, strict: true });
    try { db.exec('PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN;'); }
    catch (e) { db.close(); throw e; }
    pool.readers++; pool.cache += READER_CACHE; pool.panes.add(slot); this.readers.set(db, pane); return db;
  }
  private closeReader(db: Database, pane: PaneKey): void {
    if (!this.readers.delete(db)) return;
    try { db.exec('ROLLBACK'); } finally {
      try { db.close(); } finally { pool.readers--; pool.cache -= READER_CACHE; pool.panes.delete(this.readSlot(pane)); }
    }
  }
  async grantReadView(request: ReadRequest): Promise<Result<ReadView>> {
    let db: Database | null = null;
    try {
      this.live(); identity(request.identity); nonempty(request.requestId); safe(request.routeGeneration);
      safe(request.range.start); safe(request.range.end);
      if (!Number.isFinite(request.deadlineMonoMs) || request.deadlineMonoMs <= performance.now()) return { status: 'error', code: 'deadline', message: 'read deadline expired' };
      const state = this.state(request.identity.pane); if (!state) return stale();
      const mismatch = this.match(state, request.identity); if (mismatch) return mismatch;
      if (state.gap?.reason === 'late-gap') return stale('late-gap');
      if (this.options.stagePrefixesOnDisk && state.revision !== state.durable) return busy();
      if (request.range.start > request.range.end || request.range.end > state.head) throw Error('range outside frozen head');
      if (this.pins.has(request.requestId)) return stale('route');
      const overlay = new Map<number, FinalizedRow>(); let charge = 0;
      for (const event of this.pending.get(paneKey(request.identity.pane))?.events.values() ?? []) {
        for (const row of event.request.rows) if (row.id.lineId >= request.range.start && row.id.lineId < request.range.end) {
          // Shared immutable objects, but reserve their full retained capacity:
          // a checkpoint may evict the original pending owner at any moment.
          charge += bytes(row) * 4;
          if (charge > B.pageBytesPerViewer || pool.overlays + charge > B.pagePoolBytes) return busy();
          overlay.set(row.id.lineId, row);
        }
      }
      db = this.reader(request.identity.pane);
      if (!db) return { status: 'busy', reason: 'queue', retryAfterMs: 20 };
      // BEGIN alone is not a snapshot. This read establishes s synchronously;
      // no await/mutation can pass the grant/open gate between g and this read.
      const disk = this.state(request.identity.pane, db);
      if (!disk) throw Error('missing snapshot pane');
      const view: ReadView = copy({ ...request, grantRevision: state.revision, durableAtGrant: state.durable,
        headAtGrant: state.head, overlayHandle: randomUUID() });
      const ack: ReadOpenAck = copy({ view, diskSnapshotRevision: disk.durable, snapshotHandle: randomUUID() });
      if (!validReadOpen(ack)) throw Error('read fence violation');
      const timer = setTimeout(() => { this.releasePin(view.requestId); }, Math.min(B.readDeadlineMs, request.deadlineMonoMs - performance.now()));
      this.recoveryTimers.add(timer); timer.unref?.();
      this.pins.set(view.requestId, { view, db, overlay, charge, ack, opened: false, timer });
      pool.overlays += charge; db = null; return ok(view);
    } catch (e) { return fail(e); }
    finally { if (db) this.closeReader(db, request.identity.pane); }
  }
  private releasePin(requestId: string): void {
    const pin = this.pins.get(requestId); if (!pin) return;
    this.pins.delete(requestId); clearTimeout(pin.timer); pool.overlays -= pin.charge;
    this.closeReader(pin.db, pin.view.identity.pane);
  }
  async openReadView(view: ReadView): Promise<Result<ReadOpenAck>> {
    try {
      this.live(); const pin = this.pins.get(view.requestId);
      if (!pin || !equal(pin.view, view)) return stale('route');
      if (performance.now() >= view.deadlineMonoMs) { this.releasePin(view.requestId); return { status: 'error', code: 'deadline', message: 'read deadline expired' }; }
      const state = this.state(view.identity.pane);
      const mismatch = state ? this.match(state, view.identity) : stale();
      if (mismatch) { this.releasePin(view.requestId); return mismatch; }
      pin.opened = true; return ok(pin.ack);
    } catch (e) { this.releasePin(view.requestId); return fail(e); }
  }
  async readPage(ack: ReadOpenAck, cursor: PageCursor | null, limit: number, cancel: CancelToken): Promise<Result<HistoryPage>> {
    const id = ack.view.requestId;
    try {
      this.live(); const pin = this.pins.get(id);
      if (!pin || !pin.opened || !equal(ack, pin.ack)) return stale('route');
      if (cancel.isCancelled()) { this.releasePin(id); return { status: 'cancelled', reason: 'reader cancelled' }; }
      if (performance.now() >= pin.view.deadlineMonoMs) { this.releasePin(id); return { status: 'error', code: 'deadline', message: 'read deadline expired' }; }
      const state = this.state(pin.view.identity.pane);
      const mismatch = state ? this.match(state, pin.view.identity) : stale();
      if (mismatch) { this.releasePin(id); return mismatch; }
      safe(limit); if (!limit || limit > B.maxPageRows) throw Error('page row limit');
      const view = pin.view, { start, end } = view.range;
      if (cursor && (cursor.requestId !== id || !['before', 'after'].includes(cursor.direction))) throw Error('cursor identity');
      let line = cursor?.lineId ?? start, offset = cursor?.cellOffset ?? 0;
      safe(line); safe(offset);
      if (line < start || line > end || (line === end && offset)) throw Error('cursor outside view');
      const before = cursor?.direction === 'before';
      if (before && offset === 0) { line--; offset = -1; }
      const fragments: RowFragment[] = []; let payloadBytes = 0;
      while (line >= start && line < end && fragments.length < Math.min(limit, B.decodeRows)) {
        if (cancel.isCancelled()) { this.releasePin(id); return { status: 'cancelled', reason: 'reader cancelled' }; }
        if (performance.now() >= view.deadlineMonoMs) { this.releasePin(id); return { status: 'error', code: 'deadline', message: 'page deadline expired' }; }
        const overlay = pin.overlay.get(line);
        let row: FinalizedRow;
        if (overlay) {
          const diskMeta = pin.db.query('SELECT revision,digest FROM sh_row WHERE pane=? AND line=?').get(paneKey(view.identity.pane), line) as SqlRow | null;
          if (diskMeta && Number(diskMeta.revision) === overlay.revision && diskMeta.digest !== streamDigest('row', overlay)) throw Error('equal revision with divergent bytes');
          row = !diskMeta || Number(diskMeta.revision) <= overlay.revision ? overlay : this.readRow(pin.db, view.identity.pane, line);
        } else row = this.readRow(pin.db, view.identity.pane, line);
        if (row.revision > view.grantRevision) throw Error('row newer than frozen view');
        if (offset > row.cells.length) throw Error('cursor cell offset outside row');
        if (!before && offset === row.cells.length && row.cells.length) { line++; offset = 0; continue; }
        let lo = before ? (offset === -1 ? row.cells.length : offset) : offset;
        let hi = lo;
        const { cells, ...meta } = row;
        let used = bytes(meta) + 128;
        if (before) {
          while (lo > 0 && payloadBytes + used + bytes(cells[lo - 1]) + 1 <= B.decodeBytes) { used += bytes(cells[--lo]) + 1; }
        } else {
          while (hi < cells.length && payloadBytes + used + bytes(cells[hi]) + 1 <= B.decodeBytes) { used += bytes(cells[hi++]) + 1; }
        }
        if ((hi === lo && cells.length) || payloadBytes + used > B.decodeBytes) break;
        const fragment: RowFragment = { row: { ...meta, cells: cells.slice(lo, hi) }, startCell: lo, endCell: hi, complete: lo === 0 && hi === cells.length };
        // Charge actual encoded transport bytes (including fragment metadata).
        const encoded = bytes(fragment);
        if (payloadBytes + encoded > B.decodeBytes) break;
        payloadBytes += encoded;
        if (before) fragments.unshift(fragment); else fragments.push(fragment);
        if (before) { if (lo > 0) break; line--; offset = -1; }
        else { if (hi < cells.length) break; line++; offset = 0; }
      }
      if (!fragments.length && line >= start && line < end) throw Error('no progress within page byte budget');
      const first = fragments[0], last = fragments.at(-1);
      const left = first ? { lineId: first.row.id.lineId, cellOffset: first.startCell } : { lineId: cursor?.lineId ?? start, cellOffset: cursor?.cellOffset ?? 0 };
      let right = last ? { lineId: last.row.id.lineId, cellOffset: last.endCell } : left;
      if (last) {
        const total = pin.overlay.get(last.row.id.lineId)?.cells.length ?? Number((pin.db.query('SELECT cell_count FROM sh_row WHERE pane=? AND line=?').get(paneKey(view.identity.pane), last.row.id.lineId) as SqlRow).cell_count);
        if (last.endCell === total) right = { lineId: last.row.id.lineId + 1, cellOffset: 0 };
      }
      const hasMoreBefore = left.lineId > start || left.cellOffset > 0;
      const hasMoreAfter = right.lineId < end;
      return ok({ view, fragments, payloadBytes, hasMoreBefore, hasMoreAfter,
        nextBefore: hasMoreBefore ? { ...left, requestId: id, direction: 'before' } : null,
        nextAfter: hasMoreAfter ? { ...right, requestId: id, direction: 'after' } : null });
    } catch (e) { this.releasePin(id); return fail(e); }
  }
  async releaseReadView(view: ReadView, _reason: string): Promise<void> {
    const pin = this.pins.get(view.requestId);
    if (pin && equal(pin.view, view)) this.releasePin(view.requestId);
  }
  private recoveryTimers = new Set<ReturnType<typeof setInterval>>();
  async *recover(pane: PaneKey, checkpointId: string | null, cancel: CancelToken): AsyncIterable<Result<RecoveryChunk>> {
    let db: Database | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    let expired = false, cancelled = false;
    try {
      this.live(); paneKey(pane);
      db = this.reader(pane); if (!db) { yield { status: 'busy', reason: 'queue', retryAfterMs: 20 }; return; }
      const reader = db;
      const deadline = performance.now() + B.recoveryMs;
      timer = setInterval(() => {
        cancelled = cancel.isCancelled(); expired = performance.now() >= deadline;
        if (cancelled || expired || this.closed) {
          if (db) { this.closeReader(db, pane); db = null; }
          if (timer) { clearInterval(timer); this.recoveryTimers.delete(timer); timer = null; }
        }
      }, 50);
      this.recoveryTimers.add(timer); timer.unref?.();
      const state = this.state(pane, reader); if (!state) { yield stale(); return; }
      const key = paneKey(pane), cpId = checkpointId ?? state.checkpoint;
      let epoch = 0, seq = 0, head = 0;
      if (cpId) {
        const stored = reader.query('SELECT payload,checksum FROM sh_checkpoint WHERE pane=? AND id=?').get(key, cpId) as SqlRow | null;
        if (!stored) throw Error('checkpoint not found');
        if (Buffer.byteLength(String(stored.payload)) > B.vtBytesPerPane) throw Error('checkpoint exceeds budget');
        const cp = JSON.parse(String(stored.payload)) as VtCheckpoint;
        if (stored.checksum !== streamDigest('vt-checkpoint', cp) || cp.head > state.head || cp.revision > state.durable) throw Error('checkpoint envelope integrity');
        const fence = reader.query('SELECT receipt FROM sh_input WHERE pane=? AND epoch=? AND seq=?').get(key, cp.inputFence.through.sourceEpoch, cp.inputFence.through.packetSeq) as SqlRow | null;
        if (!fence || !equal(JSON.parse(String(fence.receipt)), cp.inputFence)) throw Error('recovery input fence integrity');
        if (!this.options.codecVersions.includes(cp.state.codecVersion)) { yield { status: 'error', code: 'unsupported', message: 'VT codec is not admitted' }; return; }
        if (!equal(cp.identity.pane, pane) || cp.stateDigest !== streamDigest('vt-state', { identity: cp.identity, state: cp.state })) throw Error('checkpoint integrity');
        epoch = cp.inputFence.through.sourceEpoch; seq = cp.inputFence.through.packetSeq; head = cp.head;
        if (cancelled || cancel.isCancelled()) { yield { status: 'cancelled', reason: 'recovery cancelled' }; return; }
        yield ok({ kind: 'checkpoint', checkpoint: cp });
      }
      // Repair prefixes committed after the VT checkpoint are visible one row at
      // a time. Each receipt is looked up on disk; no age-sized receipt map.
      while (head < state.head) {
        if (expired) { yield { status: 'error', code: 'deadline', message: 'recovery deadline' }; return; }
        if (cancelled || cancel.isCancelled()) { yield { status: 'cancelled', reason: 'recovery cancelled' }; return; }
        const row = this.readRow(reader, pane, head++);
        const receiptRow = reader.query("SELECT receipt FROM sh_commit WHERE pane=? AND revision>=? ORDER BY revision LIMIT 1").get(key, row.revision) as SqlRow | null;
        if (!receiptRow) throw Error('row without durable receipt');
        yield ok({ kind: 'rows', rows: [row], receipt: JSON.parse(String(receiptRow.receipt)) });
      }
      while (true) {
        if (expired) { yield { status: 'error', code: 'deadline', message: 'recovery deadline' }; return; }
        if (cancelled || cancel.isCancelled()) { yield { status: 'cancelled', reason: 'recovery cancelled' }; return; }
        const stored = reader.query('SELECT * FROM sh_input WHERE pane=? AND (epoch>? OR (epoch=? AND seq>?)) ORDER BY epoch,seq LIMIT 1').get(key, epoch, epoch, seq) as SqlRow | null;
        if (!stored) break;
        if (Buffer.byteLength(String(stored.payload)) > B.rawBytesPerPane) throw Error('journal record exceeds budget');
        const event = JSON.parse(String(stored.payload)) as InputEvent;
        digest('input', event);
        if (stored.digest !== event.digest || !equal(event.identity.pane, pane) || Number(stored.epoch) !== event.position.sourceEpoch || Number(stored.seq) !== event.position.packetSeq) throw Error('journal integrity');
        const newEpoch = Number(stored.epoch), newSeq = Number(stored.seq);
        if (newSeq !== (newEpoch === epoch ? seq + 1 : 1)) throw Error('journal sequence hole');
        epoch = newEpoch; seq = newSeq;
        yield ok({ kind: 'input', event });
      }
    } catch (e) { yield fail(e); }
    finally { if (timer) { clearInterval(timer); this.recoveryTimers.delete(timer); } if (db) this.closeReader(db, pane); }
  }
  stats() { return { recoveryTimers: this.recoveryTimers.size, pendingBytes: pool.pending, ownedPendingBytes: this.ownPending, overlayBytes: pool.overlays,
    activeReads: pool.readers, pins: this.readers.size, diskCacheConfigBytes: pool.cache }; }
  /** Close never upgrades undurable RAM to durable without a full VT checkpoint.
   * Caller must drain Capture first; returned pending bytes make omission visible.
   */
  close(): { undurableBytes: number } {
    if (this.closed) return { undurableBytes: 0 };
    if (this.options.stagePrefixesOnDisk && this.db.query('SELECT 1 FROM sh_pane WHERE revision != durable LIMIT 1').get())
      throw Error('stream close refused: staged packet lacks final checkpoint');
    const undurableBytes = this.ownPending;
    for (const timer of this.recoveryTimers) clearInterval(timer);
    this.recoveryTimers.clear();
    for (const id of [...this.pins.keys()]) this.releasePin(id);
    for (const [db, pane] of this.readers) this.closeReader(db, pane);
    this.db.close(); this.closed = true; pool.cache -= WRITER_CACHE; pool.paths.delete(this.options.path);
    for (const key of [...this.pending.keys()]) this.dropPending(key);
    return { undurableBytes };
  }
}
export function createHistoryEngine(options: StreamHistoryOptions): StreamHistoryEngine { return new StreamHistoryEngine(options); }

/** Read-only sh_* archive reader for the rollback bridge. It opens no writer,
 * VT, cadence, timer or pipe, never runs the schema and never sees RAM-only
 * pending rows: only what H made durable can be published as history. The
 * disk cache it holds is charged to the same isolate pool as H's readers.
 */
export class StreamArchiveRowReader {
  private readonly db: Database;
  private closed = false;
  constructor(readonly path: string) {
    if (pool.cache + READER_CACHE > B.diskCacheBytes) throw Error('disk cache pressure');
    const db = new Database(resolve(path), { readonly: true, strict: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA busy_timeout=0;');
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (!tables.length || tables.some(t => !t.name.startsWith('sh_'))) throw Error('not a dedicated stream database');
      if (Number((db.query('SELECT version FROM sh_format').get() as SqlRow).version) !== 1) throw Error('unsupported stream storage version');
    } catch (e) { db.close(); throw e; }
    this.db = db; pool.cache += READER_CACHE;
  }
  private live(): void { if (this.closed) throw Error('archive reader closed'); }
  /** Durable fence only (sh_pane as committed). */
  durable(pane: PaneKey): { identity: StreamIdentity; head: number; revision: number; durable: number;
    checkpoint: VtCheckpoint | null; gap: GapEpisode | null; journalAfterCheckpoint: boolean } | null {
    this.live();
    const key = paneKey(pane);
    const r = this.db.query('SELECT * FROM sh_pane WHERE pane=?').get(key) as SqlRow | null;
    if (!r) {
      // Input may have been journaled before the first projected state row.
      const any = this.db.query('SELECT 1 FROM sh_input WHERE pane=? LIMIT 1').get(key);
      return any ? { identity: { pane, sourceEpoch: 0, geometryGeneration: 0 }, head: 0, revision: 0, durable: 0,
        checkpoint: null, gap: null, journalAfterCheckpoint: true } : null;
    }
    const head = Number(r.head), revision = Number(r.revision), durable = Number(r.durable);
    [head, revision, durable].forEach(safe);
    let checkpoint: VtCheckpoint | null = null, epoch = 0, seq = 0;
    if (r.checkpoint !== null) {
      const stored = this.db.query('SELECT payload,checksum FROM sh_checkpoint WHERE pane=? AND id=?').get(key, String(r.checkpoint)) as SqlRow | null;
      if (!stored || Buffer.byteLength(String(stored.payload)) > B.vtBytesPerPane) throw Error('checkpoint missing or exceeds budget');
      checkpoint = JSON.parse(String(stored.payload)) as VtCheckpoint;
      if (stored.checksum !== streamDigest('vt-checkpoint', checkpoint) || !equal(checkpoint.identity.pane, pane)
        || checkpoint.stateDigest !== streamDigest('vt-state', { identity: checkpoint.identity, state: checkpoint.state })
        || checkpoint.head > head || checkpoint.revision > durable) throw Error('checkpoint integrity');
      epoch = checkpoint.inputFence.through.sourceEpoch; seq = checkpoint.inputFence.through.packetSeq;
    }
    const tail = this.db.query('SELECT 1 FROM sh_input WHERE pane=? AND (epoch>? OR (epoch=? AND seq>?)) LIMIT 1').get(key, epoch, epoch, seq);
    return { identity: JSON.parse(String(r.identity)), head, revision, durable, checkpoint,
      gap: r.gap === null ? null : JSON.parse(String(r.gap)), journalAfterCheckpoint: !!tail };
  }
  /** One verified durable row, rejected if it changed after the frozen revision. */
  row(pane: PaneKey, line: number, frozenRevision: number): FinalizedRow {
    this.live(); safe(line); safe(frozenRevision);
    const row = readStoredRow(this.db, pane, line);
    if (row.revision > frozenRevision) throw Error('row newer than frozen archive segment');
    return row;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { pool.cache -= READER_CACHE; }
  }
}


/** Separate opt-in flag-on database; never migrate/open the projection or legacy DB. */

const FLAGON_HISTORY_SCHEMA = `
CREATE TABLE fh_meta(version INTEGER NOT NULL CHECK(version=1), uuid TEXT NOT NULL);
CREATE TABLE fh_pane(pane TEXT PRIMARY KEY, generation INTEGER NOT NULL, active_epoch TEXT) STRICT;
CREATE TABLE fh_segment(id TEXT PRIMARY KEY, pane TEXT NOT NULL, state TEXT NOT NULL,
 bytes INTEGER NOT NULL DEFAULT 0, next_row INTEGER NOT NULL DEFAULT 0, sealed TEXT, remote TEXT) STRICT;
CREATE TABLE fh_epoch(epoch TEXT PRIMARY KEY, pane TEXT NOT NULL, offset INTEGER NOT NULL,
 sequence INTEGER NOT NULL, digest TEXT NOT NULL, segment TEXT NOT NULL) STRICT;
CREATE TABLE fh_event(seq INTEGER PRIMARY KEY AUTOINCREMENT, pane TEXT NOT NULL, segment TEXT NOT NULL,
 kind TEXT NOT NULL, op TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, payload TEXT NOT NULL,
 receipt TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
CREATE INDEX fh_event_pane ON fh_event(pane,seq);
CREATE INDEX fh_event_segment ON fh_event(segment,seq);
CREATE INDEX fh_input_cursor ON fh_event(pane,kind,json_extract(payload,'$.range.epoch.attachId'),
 json_extract(payload,'$.range.epoch.collectorIncarnation'),json_extract(payload,'$.range.end'));
CREATE TABLE fh_row_id(pane TEXT NOT NULL, segment TEXT NOT NULL, ordinal INTEGER NOT NULL,
 PRIMARY KEY(pane,segment,ordinal)) WITHOUT ROWID;
CREATE TABLE fh_pin(id TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE, segment TEXT NOT NULL,
 payload TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE fh_checkpoint(id TEXT PRIMARY KEY, pane TEXT NOT NULL, segment TEXT NOT NULL,
 ack TEXT NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
`;

/** Flag-on v1 persistence. One synchronous FULL transaction is the ACK boundary.
 * No worker, queue or timer; construction is explicit (flag-off remains inert).
 * The catalog authority is injected by I/A: an object supplied by a caller is
 * never itself proof that the remote index is durable. No verifier => no unlink.
 */
export interface FlagOnHistoryOptions {
  root: string;
  mode: 'create' | 'recover';
  codecVersions: readonly string[];
  catalogAuthority?: CatalogAuthorityR2;
  /** S must return pinned durable records, not the caller's claim. */
  readSourceRecords?: (slice: SourceChainSliceR2) => Result<readonly SpoolRecord[]>;
  validateRemoteIndex?: (receipt: RemoteIndexReceipt, sealed: SealedExport) => boolean;
  boundary?: (phase: string) => void;
}
const FH_RECORD_MAX = B.decodeBytes;
const FH_SEGMENT_MAX = FB.archiveChunkBytes / 2;
const fhPaths = new Set<string>();
const fhReaders = new Set<string>();
function fhAssert(test: unknown, message: string): asserts test { if (!test) throw Error(message); }
function fhSafePath(path: string): void {
  let current: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    fhAssert(!/^brain\.db(?:$|[-.])/i.test(part), 'forbidden database path');
    current = join(current, part);
    if (!existsSync(current)) {
      // existsSync follows symlinks, including dangling links. lstat does not.
      try { fhAssert(!lstatSync(current).isSymbolicLink(), 'unsafe symlink'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      continue;
    }
    const st = lstatSync(current);
    fhAssert(!st.isSymbolicLink() && (st.isDirectory() || (st.isFile() && st.nlink === 1)), 'unsafe history path');
  }
}
function fhSyncDir(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function fhEvidence(path: string): EvidenceFile {
  fhSafePath(path);
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try { for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0,n)); total += n; } }
  finally { closeSync(fd); }
  return { path, bytes: total, sha256: hash.digest('hex') };
}
function fhWrite(fd: number, text: string): void {
  const buffer = Buffer.from(text); let offset = 0;
  while (offset < buffer.length) { const n = writeSync(fd, buffer, offset); fhAssert(n > 0, 'short write'); offset += n; }
}

export class FlagOnHistoryStore implements FlagOnHistoryR2 {
  private readonly db: Database;
  private readonly writerLock: Database;
  readonly root: string;
  readonly storeUUID: string;
  private closed = false;
  private readonly replayReleases = new Set<() => void>();
  constructor(private readonly options: FlagOnHistoryOptions) {
    this.root = resolve(options.root);
    fhSafePath(this.root);
    fhAssert(!fhPaths.has(this.root), 'one flag-on writer per root');
    fhAssert((fhPaths.size+1)*(2*1024*1024+64*1024) <= B.diskCacheBytes, 'flag-on SQLite cache pool pressure');
    const path = join(this.root, 'flag-on-v1.sqlite');
    for (const p of [path, path+'-wal', path+'-shm', path+'-journal']) fhSafePath(p);
    fhAssert(options.mode === 'create' ? !existsSync(path) : existsSync(path), 'explicit create/recover required');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // An OS-backed SQLite exclusive lock survives across our data commits and
    // is released by the kernel on process death. It fences other host writers
    // and proves old ephemeral replay pins have no live owner at reopen.
    const lockPath = join(this.root,'flag-on-writer.sqlite');
    for (const p of [lockPath,lockPath+'-journal',lockPath+'-wal',lockPath+'-shm']) fhSafePath(p);
    const writerLock = new Database(lockPath,{create:true,strict:true});
    let db: Database | undefined;
    try {
      writerLock.exec('PRAGMA busy_timeout=0; PRAGMA cache_size=-64; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS fh_lock(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE; COMMIT;');
      chmodSync(lockPath,0o600);
      db = new Database(path, { create: options.mode === 'create', strict: true });
      if (options.mode === 'create') {
        db.exec('PRAGMA auto_vacuum=INCREMENTAL;');
        db.transaction(() => {
          db!.exec(FLAGON_HISTORY_SCHEMA);
          db!.query('INSERT INTO fh_meta VALUES(1,?)').run(randomUUID());
        }).immediate();
      }
      const meta = db.query('SELECT * FROM fh_meta').get() as SqlRow;
      fhAssert(meta?.version === 1 && typeof meta.uuid === 'string', 'unsupported flag-on format');
      fhAssert((db.query('PRAGMA quick_check').get() as SqlRow).quick_check === 'ok', 'corrupt history database');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA busy_timeout=0; PRAGMA journal_size_limit=0;');
      // DB + WAL growth is bounded; exported scratch is separately <=16 MiB.
      db.exec(`PRAGMA max_page_count=${Math.floor((FB.canaryRootCapBytes-FB.reserveBytes-FB.scratchBytes)/4096)};`);
      db.query("DELETE FROM fh_pin WHERE payload='replay'").run();
      db.exec(`CREATE TABLE IF NOT EXISTS fh_r2(kind TEXT NOT NULL,id TEXT NOT NULL,pane TEXT NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS fh_r2_pane ON fh_r2(kind,pane);
        CREATE TABLE IF NOT EXISTS fh_timeline(pane TEXT NOT NULL,n INTEGER NOT NULL,segment TEXT NOT NULL,op TEXT NOT NULL,item INTEGER NOT NULL,kind TEXT NOT NULL,ordinal INTEGER,PRIMARY KEY(pane,n),UNIQUE(op,item)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS fh_timeline_segment ON fh_timeline(segment);
        CREATE INDEX IF NOT EXISTS fh_timeline_op ON fh_timeline(op);`);
      this.db = db; this.writerLock = writerLock; this.storeUUID = meta.uuid;
      this.migrateIndex();
      chmodSync(path, 0o600); fhSyncDir(this.root); fhSyncDir(dirname(this.root));
      fhPaths.add(this.root);
    } catch (error) { db?.close(); writerLock.close(); throw error; }
  }
  close(): void { if (!this.closed) { for (const release of this.replayReleases) release(); this.db.close(); this.writerLock.close(); this.closed = true; fhPaths.delete(this.root); } }
  private live(): void { fhAssert(!this.closed, 'flag-on store closed'); }
  private tx<T>(kind: string, fn: () => T): T {
    this.live(); this.options.boundary?.(kind+'-before-write');
    const result = this.db.transaction(() => {
      const value = fn(); this.options.boundary?.(kind+'-before-commit'); return value;
    }).immediate();
    this.options.boundary?.(kind+'-after-commit');
    return result;
  }
  /** A/I installs owner generation explicitly; no inference from incoming ACKs. */
  setGeneration(pane: PaneKey, expected: number | null, next: number): void {
    const key = paneKey(pane); safe(next); if (expected !== null) safe(expected);
    this.tx('generation', () => {
      const old = this.db.query('SELECT generation FROM fh_pane WHERE pane=?').get(key) as SqlRow | null;
      fhAssert(!this.db.query("SELECT 1 FROM fh_segment WHERE pane=? AND state='reclaiming'").get(key), 'reclaim in progress');
      fhAssert(old ? old.generation === expected && next > Number(old.generation) : expected === null, 'owner generation CAS');
      if (old) this.db.query('UPDATE fh_pane SET generation=? WHERE pane=?').run(next,key);
      else this.db.query('INSERT INTO fh_pane VALUES(?,?,NULL)').run(key,next);
    });
  }
  private fence(r: OperationFence): string {
    nonempty(r.operationId); safe(r.expectedGeneration); const key = paneKey(r.pane);
    const state = this.db.query('SELECT generation FROM fh_pane WHERE pane=?').get(key) as SqlRow | null;
    fhAssert(state?.generation === r.expectedGeneration, 'owner generation mismatch'); return key;
  }
  private segment(id: string, pane: PaneKey): SqlRow {
    nonempty(id); const s = this.db.query('SELECT * FROM fh_segment WHERE id=?').get(id) as SqlRow | null;
    fhAssert(s && s.pane === paneKey(pane), 'segment identity mismatch'); return s;
  }
  private event(op: string): SqlRow | null { return this.db.query('SELECT * FROM fh_event WHERE op=?').get(op) as SqlRow | null; }
  private checkEvent(e: SqlRow): void {
    fhAssert(e.checksum === streamDigest('flag-on-event', { kind:e.kind, op:e.op, digest:e.digest, payload:e.payload, receipt:e.receipt, segment:e.segment, pane:e.pane }), 'corrupt durable event');
  }
  private putEvent(pane: string, segment: string, kind: string, op: string, hash: string, payload: unknown, receipt: unknown): void {
    const p = streamCanonical(payload), r = streamCanonical(receipt);
    const size = Buffer.byteLength(p)+Buffer.byteLength(r);
    fhAssert(size <= FH_RECORD_MAX*2, 'record exceeds bounded decode');
    const s = this.db.query('SELECT bytes,state FROM fh_segment WHERE id=?').get(segment) as SqlRow;
    fhAssert(s.state === 'open' && Number(s.bytes)+size <= FH_SEGMENT_MAX, 'segment full or sealed; seal and rotate');
    const checksum = streamDigest('flag-on-event', { kind,op,digest:hash,payload:p,receipt:r,segment,pane });
    this.db.query('INSERT INTO fh_event(pane,segment,kind,op,digest,payload,receipt,checksum) VALUES(?,?,?,?,?,?,?,?)').run(pane,segment,kind,op,hash,p,r,checksum);
    this.db.query('UPDATE fh_segment SET bytes=bytes+? WHERE id=?').run(size,segment);
  }
  private acknowledged(ack: SpoolAck, pane: PaneKey): void {
    fhAssert(ack.kind === 'synced-spool' && ack.version === 1 && equal(ack.through.epoch.pane,pane), 'ACK identity');
    const event = this.db.query("SELECT * FROM fh_event WHERE op=? AND kind='input'").get(ack.commitId) as SqlRow | null;
    if(event)this.checkEvent(event);
    const durable=event?JSON.parse(String(event.receipt)):this.load<SpoolAck>('ack',ack.commitId);
    fhAssert(durable, 'ACK not durable in this store');
    fhAssert(equal(durable,ack), 'forged ACK');
  }
  async appendInput(record: SpoolRecord): Promise<Result<SpoolAck>> {
    try {
      this.live(); nonempty(record.operationId);
      fhAssert(record.version === 1, 'unsupported spool version');
      const range = record.range, key = paneKey(range.epoch.pane), epoch = streamCanonical(range.epoch);
      nonempty(range.epoch.attachId); nonempty(range.epoch.collectorIncarnation);
      [range.start,range.end,record.sequence].forEach(safe);
      fhAssert(range.end >= range.start, 'raw range order');
      if (record.payload.kind === 'bytes') {
        fhAssert(record.payload.bytes.length <= FB.rawBytesPerPane && range.end-range.start === record.payload.bytes.length, 'raw payload bound');
        fhAssert(record.payload.bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'invalid byte');
      } else {
        fhAssert(range.start === range.end, 'control consumes no raw bytes');
        if (record.payload.kind === 'resize') geometry(record.payload.geometry);
        else fhAssert(record.payload.kind === 'control' && typeof record.payload.data === 'string', 'invalid control');
      }
      fhAssert(bytes(record) <= FH_RECORD_MAX, 'raw encoded record bound'); digest('spool',record);
      return ok(this.tx('input', () => {
        const prior = this.event(record.operationId);
        if (prior) { this.checkEvent(prior); fhAssert(prior.kind === 'input' && prior.digest === record.digest, 'operation collision'); return JSON.parse(String(prior.receipt)) as SpoolAck; }
        const pane = this.db.query('SELECT * FROM fh_pane WHERE pane=?').get(key) as SqlRow | null;
        fhAssert(pane, 'pane generation not registered');
        const last = this.db.query('SELECT * FROM fh_epoch WHERE epoch=?').get(epoch) as SqlRow | null;
        fhAssert(!last || pane.active_epoch === epoch, 'stale pipe epoch');
        fhAssert(last ? last.offset === range.start && Number(last.sequence)+1 === record.sequence && last.digest === record.previousDigest
          : range.start === 0 && record.sequence === 0 && record.previousDigest === null, 'raw sequence/offset/digest discontinuity');
        let segmentId = last ? String(last.segment) : streamDigest('flag-on-segment',{epoch,first:record.operationId});
        if (last && this.segment(segmentId,range.epoch.pane).state !== 'open') segmentId = streamDigest('flag-on-segment',{epoch,first:record.operationId});
        this.db.query("INSERT OR IGNORE INTO fh_segment(id,pane,state) VALUES(?,?,'open')").run(segmentId,key);
        const current = this.segment(segmentId,range.epoch.pane);
        if (Number(current.bytes)+bytes(record)+2048 > FH_SEGMENT_MAX && last) {
          segmentId = this.rotate({operationId:'auto-rotate:'+record.operationId,pane:range.epoch.pane,expectedGeneration:Number(pane.generation),segmentId,boundary:{epoch:range.epoch,byteOffset:range.start}}).successor;
        }
        const ack: SpoolAck = { kind:'synced-spool',version:1,through:{epoch:range.epoch,byteOffset:range.end},recordDigest:record.digest,commitId:record.operationId,segmentId };
        this.putEvent(key,segmentId,'input',record.operationId,record.digest,record,ack);
        this.save('ack',record.operationId,key,ack);
        this.db.query('INSERT OR REPLACE INTO fh_epoch VALUES(?,?,?,?,?,?)').run(epoch,key,range.end,record.sequence,record.digest,segmentId);
        this.db.query('UPDATE fh_pane SET active_epoch=? WHERE pane=?').run(epoch,key);
        return ack;
      }));
    } catch(e) { return fail(e); }
  }
  async commitRowsAndGaps(r: RowsAndGapsCommit): Promise<Result<RowsAndGapsReceipt>> { return this.commitRows(r); }
  private commitRows(r: RowsAndGapsCommit, staged?: StagedRowsR2['repair']): Result<RowsAndGapsReceipt> {
    try {
      fhAssert(r.rows.length <= B.decodeRows && bytes(r) <= FH_RECORD_MAX, 'rows batch bound'); digest('rows-gaps',r);
      return ok(this.tx('rows', () => {
        const key = this.fence(r), old = this.event(r.operationId);
        if (old) { this.checkEvent(old); fhAssert(old.kind === (staged?'candidate':'committed') && old.digest === r.digest, 'operation collision'); return JSON.parse(String(old.receipt)) as RowsAndGapsReceipt; }
        this.acknowledged(r.inputAck,r.pane);
        const target = r.rows[0]?.id.segmentId ?? r.coverage.find(c=>c.kind==='rows')?.range.segmentId
          ?? (this.db.query('SELECT segment FROM fh_epoch WHERE epoch=?').get(streamCanonical(r.inputAck.through.epoch)) as SqlRow)?.segment;
        const segment = this.segment(String(target ?? r.inputAck.segmentId),r.pane);
        if(segment.id !== r.inputAck.segmentId) {
          let id=String(segment.id), hops=0;
          while(id!==r.inputAck.segmentId) {
            fhAssert(++hops<=4096,'continuity metadata bound');
            const link=this.load<SegmentContinuityR2>('successor',id);
            fhAssert(link && equal(link.epoch,r.inputAck.through.epoch) && link.boundary.byteOffset>=r.inputAck.through.byteOffset,'row successor has no continuity');id=link.predecessor;
          }
        }
        fhAssert(segment.state === 'open', 'sealed segment is immutable');
        if (r.checkpointId !== null) {
          const cp = this.db.query('SELECT * FROM fh_checkpoint WHERE id=?').get(r.checkpointId) as SqlRow | null;
          fhAssert(cp && cp.pane === key && cp.segment === segment.id, 'checkpoint missing or outside segment');
          const cpAck = JSON.parse(String(cp.ack)) as SpoolAck;
          fhAssert(equal(cpAck.through.epoch,r.inputAck.through.epoch) && cpAck.through.byteOffset <= r.inputAck.through.byteOffset && cp.checksum === streamDigest('checkpoint-payload',JSON.parse(String(cp.payload))), 'checkpoint reference integrity');
        }
        let ordinal = Number(segment.next_row);
        for (const row of r.rows) {
          fhAssert(equal(row.id.pane,r.pane) && row.id.segmentId === segment.id && row.id.rowOrdinal === ordinal++, 'row identity/order');
          row.cells.forEach(cellToSemanticCell);
          geometry(row.geometry); content({ cells:row.cells,softWrap:row.wrapStatus==='wrapped',wrapPad:row.wrapPad,uncertainFields:row.uncertainFields });
          fhAssert(row.finalized && row.uncertainFields.length === 0, 'unverified row');
          if (row.origin.kind === 'pipe') {
            [row.origin.range.start,row.origin.range.end,row.origin.ordinal].forEach(safe);
            fhAssert(equal(row.origin.range.epoch,r.inputAck.through.epoch) && row.origin.range.end >= row.origin.range.start && row.origin.range.end <= r.inputAck.through.byteOffset, 'row outside acknowledged input');
          }
        }
        let covered = 0; const gaps: unknown[] = [];
        for (const c of r.coverage) {
          if (c.kind === 'rows') {
            const range = c.range; safe(range.start); safe(range.end);
            fhAssert(equal(range.pane,r.pane) && range.segmentId === segment.id && range.start === Number(segment.next_row)+covered && range.end > range.start, 'coverage order');
            const rows = r.rows.slice(covered,covered+range.end-range.start);
            fhAssert(rows.length === range.end-range.start && c.digest === streamDigest('rows',rows), 'row coverage digest'); covered += rows.length;
          } else {
            const g = c.gap; safe(g.withheldRows); safe(g.lowerBound);
            nonempty(g.episodeId); nonempty(g.clockEpoch);
            fhAssert(Number.isFinite(g.openedAt) && g.openedAt >= 0 && (g.closedAt === null || Number.isFinite(g.closedAt) && g.closedAt >= g.openedAt), 'gap time range');
            fhAssert(g.leftRowId === null || equal(g.leftRowId.pane,r.pane), 'gap left pane');
            if(g.leftRowId) fhAssert(this.db.query('SELECT 1 FROM fh_row_id WHERE pane=? AND segment=? AND ordinal=?').get(key,g.leftRowId.segmentId,g.leftRowId.rowOrdinal)
              || r.rows.slice(0,covered).some(row=>equal(row.id,g.leftRowId)), 'gap left row not durable or earlier in transaction');
            fhAssert(g.version === 1 && equal(g.pane,r.pane) && (g.rightSegmentId === null || g.rightSegmentId === segment.id), 'gap identity');
            fhAssert(g.countKind === 'unknown' ? g.missingCount === null : (g.countKind === 'exact' || g.countKind === 'estimate') && Number.isSafeInteger(g.missingCount) && g.missingCount >= 0, 'unknown is not zero');
            fhAssert(c.digest === streamDigest('gap',g), 'gap digest'); gaps.push(g);
          }
        }
        fhAssert(covered === r.rows.length && equal(gaps,r.decision.gaps), 'rows/gaps coverage incomplete');
        fhAssert(r.decision.acceptedRowMap.length === r.rows.length && r.rows.every((row,i) => equal(r.decision.acceptedRowMap[i],{source:row.origin,target:row.id})), 'decision row mapping');
        const receipt: RowsAndGapsReceipt = {kind:'rows-gaps-durable',operationId:r.operationId,commitId:r.operationId,generation:r.expectedGeneration,coverage:r.coverage,digest:r.digest};
        this.putEvent(key,String(segment.id),staged?'candidate':'committed',r.operationId,r.digest,r,receipt);
        this.save('receipt',r.operationId,key,receipt);
        if(staged) this.save('staged',staged.transactionId+':'+staged.chunkOrdinal,key,{request:staged,receipt,projection:this.projection(r)});
        else this.indexRows(r);
        for (const row of r.rows) this.db.query('INSERT INTO fh_row_id VALUES(?,?,?)').run(key,String(segment.id),row.id.rowOrdinal);
        this.db.query('UPDATE fh_segment SET next_row=? WHERE id=?').run(ordinal,String(segment.id));
        return receipt;
      }));
    } catch(e) { return fail(e); }
  }
  /** Supplemental persistence hook: K's FlagOnHistoryPort has no checkpoint
   * writer. I supplies the exact raw ACK; legacy numeric inputFence is not
   * interpreted as a flag-on raw coordinate. */
  persistCheckpoint(r: OperationFence & { checkpoint: VtCheckpoint; inputAck: SpoolAck }): Result<null> {
    try {
      this.tx('checkpoint', () => {
        const key = this.fence(r), cp = r.checkpoint; this.acknowledged(r.inputAck,r.pane);
        fhAssert(equal(cp.identity.pane,r.pane) && cp.kind === 'vt-recovery' && this.options.codecVersions.includes(cp.state.codecVersion), 'checkpoint identity/codec');
        fhAssert(cp.stateDigest === streamDigest('vt-state',{identity:cp.identity,state:cp.state}) && bytes(cp) <= B.vtBytesPerPane, 'checkpoint digest/bound');
        const old = this.db.query('SELECT * FROM fh_checkpoint WHERE id=?').get(cp.checkpointId) as SqlRow | null;
        if (old) { fhAssert(old.payload === streamCanonical(cp) && old.ack === streamCanonical(r.inputAck), 'checkpoint collision'); return; }
        if (cp.previousCheckpointId !== null) fhAssert(this.db.query('SELECT 1 FROM fh_checkpoint WHERE id=? AND pane=?').get(cp.previousCheckpointId,key), 'checkpoint chain missing');
        this.putEvent(key,r.inputAck.segmentId,'checkpoint',r.operationId,streamDigest('checkpoint',r),cp,null);
        this.db.query('INSERT INTO fh_checkpoint VALUES(?,?,?,?,?,?)').run(cp.checkpointId,key,r.inputAck.segmentId,streamCanonical(r.inputAck),streamCanonical(cp),streamDigest('checkpoint-payload',cp));
      }); return ok(null);
    } catch(e) { return fail(e); }
  }
  async *recover(pane: PaneKey, after: RawPosition | null, cancel: CancelToken): AsyncIterable<Result<FlagOnRecoveryChunk>> {
    let pinIds: string[] = []; let release: (() => void) | undefined;
    try {
      this.live(); const key = paneKey(pane), readerKey = this.root+'|'+key;
      fhAssert(this.db.query('SELECT 1 FROM fh_pane WHERE pane=?').get(key), 'unknown replay pane');
      if (fhReaders.size >= B.activeReadsGlobal || fhReaders.has(readerKey)) { yield busy(); return; }
      fhReaders.add(readerKey);
      let released = false;
      release = () => {
        if (released) return;
        this.db.transaction(() => { for (const id of pinIds) this.db.query('DELETE FROM fh_pin WHERE id=?').run(id); }).immediate();
        released = true; fhReaders.delete(readerKey); this.replayReleases.delete(release!); pinIds = [];
      };
      this.replayReleases.add(release);
      // A durable raw cursor identifies the segment needed for recovery. Older
      // remote segments belong to the read overlay, not to this replay suffix.
      // Keep rows/checkpoints in the cursor's segment, including rows committed
      // after that raw ACK. Reject arbitrary/forgotten offsets rather than skip.
      let segmentFloor = 0;
      if (after) {
        fhAssert(equal(after.epoch.pane,pane), 'replay cursor pane'); safe(after.byteOffset);
        const cursor = this.db.query("SELECT segment FROM fh_event WHERE pane=? AND kind='input' AND json_extract(payload,'$.range.epoch.attachId')=? AND json_extract(payload,'$.range.epoch.collectorIncarnation')=? AND json_extract(payload,'$.range.end')=? ORDER BY seq DESC LIMIT 1")
          .get(key,after.epoch.attachId,after.epoch.collectorIncarnation,after.byteOffset) as SqlRow | null;
        fhAssert(cursor, 'remote-required or unknown durable replay cursor');
        segmentFloor = Number((this.db.query('SELECT rowid AS n FROM fh_segment WHERE id=?').get(String(cursor.segment)) as SqlRow).n);
      }
      // Freeze a finite read boundary and durably pin all its segments in one
      // transaction. Yielding never holds a SQLite cursor/WAL reader open.
      const snapshot = this.tx('replay-pin', () => {
        const segments = this.db.query('SELECT id,state FROM fh_segment WHERE pane=? AND rowid>=? LIMIT 4097').all(key,segmentFloor) as SqlRow[];
        fhAssert(segments.length <= 4096, 'replay metadata bound');
        for (const s of segments) fhAssert(s.state !== 'reclaiming' && s.state !== 'remote', 'remote-required: restore segment before replay');
        for (const s of segments) {
          const id = randomUUID(); pinIds.push(id);
          this.db.query('INSERT INTO fh_pin VALUES(?,?,?,?,0)').run(id,id,String(s.id),'replay');
        }
        return Number((this.db.query('SELECT COALESCE(MAX(seq),0) AS n FROM fh_event WHERE pane=?').get(key) as SqlRow).n);
      });
      let cursor = 0, firstEpochSeq = 0;
      if (after) {
        fhAssert(equal(after.epoch.pane,pane), 'replay cursor pane'); safe(after.byteOffset);
        const epoch = this.db.query('SELECT * FROM fh_epoch WHERE epoch=?').get(streamCanonical(after.epoch)) as SqlRow | null;
        fhAssert(epoch && Number(epoch.offset) >= after.byteOffset, 'unknown replay cursor');
        const first = this.db.query("SELECT MIN(seq) AS n FROM fh_event WHERE pane=? AND kind='input' AND json_extract(payload,'$.range.epoch.attachId')=? AND json_extract(payload,'$.range.epoch.collectorIncarnation')=?").get(key,after.epoch.attachId,after.epoch.collectorIncarnation) as SqlRow;
        fhAssert(first.n !== null, 'replay cursor no longer local'); firstEpochSeq = Number(first.n);
        // A raw cursor only skips input; rows/checkpoints still replay so that
        // a crash after raw ACK but before row publication cannot hide rows.
      }
      for (;;) {
        this.live();
        if (cancel.isCancelled()) { yield {status:'cancelled',reason:'replay cancelled'}; return; }
        const e = this.db.query('SELECT * FROM fh_event WHERE pane=? AND seq>? AND seq<=? AND segment IN (SELECT id FROM fh_segment WHERE pane=? AND rowid>=?) ORDER BY seq LIMIT 1').get(key,cursor,snapshot,key,segmentFloor) as SqlRow | null;
        if (!e) break; cursor = Number(e.seq); this.checkEvent(e);
        const payload = JSON.parse(String(e.payload));
        if (e.kind === 'input') {
          const record = payload as SpoolRecord; digest('spool',record);
          if (after && (cursor < firstEpochSeq || (equal(record.range.epoch,after.epoch) && (record.range.end < after.byteOffset || record.payload.kind === 'bytes' && record.range.end === after.byteOffset)))) continue;
          yield ok({kind:'input',record,ack:JSON.parse(String(e.receipt))});
        } else if (e.kind === 'committed') {
          const r = payload as RowsAndGapsCommit; digest('rows-gaps',r);
          yield ok({kind:'committed',rows:r.rows,gaps:r.decision.gaps,receipt:JSON.parse(String(e.receipt))});
        } else if (e.kind === 'candidate') continue;
        else if (e.kind === 'checkpoint') yield ok({kind:'checkpoint',checkpoint:payload as VtCheckpoint});
        else throw Error('unknown durable event');
      }
    } catch(e) { yield fail(e); }
    finally {
      release?.();
    }
  }
  async pinSegment(r: PinRequest): Promise<Result<SegmentPin>> {
    try { return ok(this.tx('pin', () => {
      this.fence(r); const s = this.segment(r.segmentId,r.pane);
      fhAssert(s.state !== 'remote' && s.state !== 'reclaiming', 'segment no longer local');
      const old = this.db.query('SELECT * FROM fh_pin WHERE operation=?').get(r.operationId) as SqlRow | null;
      if (old) { const pin = JSON.parse(String(old.payload)) as SegmentPin; const {pinId,durableCommitId,...request} = pin;
        fhAssert(equal(request,r) && old.released === 0, 'pin operation collision/released'); return pin; }
      const pin: SegmentPin = {...r,pinId:randomUUID(),durableCommitId:randomUUID()};
      this.db.query('INSERT INTO fh_pin VALUES(?,?,?,?,0)').run(pin.pinId,r.operationId,r.segmentId,streamCanonical(pin)); return pin;
    })); } catch(e) { return fail(e); }
  }
  async releasePin(pin: SegmentPin): Promise<Result<null>> {
    try { this.tx('release', () => {
      const p = this.db.query('SELECT * FROM fh_pin WHERE id=?').get(pin.pinId) as SqlRow | null;
      fhAssert(p && p.payload === streamCanonical(pin), 'pin token mismatch');
      this.db.query('UPDATE fh_pin SET released=1 WHERE id=?').run(pin.pinId);
    }); return ok(null); } catch(e) { return fail(e); }
  }
  private unpinned(segment: string): void {
    fhAssert(!this.db.query('SELECT 1 FROM fh_pin WHERE segment=? AND released=0 LIMIT 1').get(segment), 'segment pinned');
  }
  async sealExport(r: OperationFence & {segmentId:string}): Promise<Result<SealedExport>> {
    try {
      const result = this.tx('seal', () => {
        this.fence(r); const s = this.segment(r.segmentId,r.pane);
        if (s.sealed) return JSON.parse(String(s.sealed)) as SealedExport;
        fhAssert(s.state === 'open' || s.state === 'sealed-local', 'segment not sealable'); this.unpinned(r.segmentId);
        // An interrupted seal can leave only a duplicate export, while all
        // source events remain in SQLite. Reap those known open-segment copies
        // before staging another one; repeated crashes cannot grow scratch.
        const unfinished = this.db.query("SELECT id FROM fh_segment WHERE sealed IS NULL LIMIT 4097").all() as SqlRow[];
        fhAssert(unfinished.length <= 4096, 'seal metadata bound');
        for (const entry of unfinished) {
          const id = String(entry.id); fhAssert(/^[a-f0-9]{64}$/.test(id), 'unsafe segment ID');
          for (const suffix of ['.jsonl','.jsonl.tmp','.manifest.json','.manifest.json.tmp']) {
            const path = join(this.root,id+suffix); fhSafePath(path);
            if (existsSync(path)) unlinkSync(path);
          }
        }
        fhSyncDir(this.root);
        // Only one export staged per root. Old sealed files must be reclaimed
        // before the next export, bounding scratch without an unbounded queue.
        fhAssert(!this.db.query("SELECT 1 FROM fh_segment WHERE state='sealed' OR state='reclaiming' LIMIT 1").get(), 'export staging pressure');
        const path = join(this.root,r.segmentId+'.jsonl'), temp = path+'.tmp';
        fhSafePath(temp); fhSafePath(path);
        const fd = openSync(temp,'w',0o600), coverage: Coverage[number][] = [];
        let size = 0, cursor = 0;
        try {
          for (;;) {
            const e = this.db.query('SELECT * FROM fh_event WHERE segment=? AND seq>? ORDER BY seq LIMIT 1').get(r.segmentId,cursor) as SqlRow | null;
            if (!e) break; cursor = Number(e.seq); this.checkEvent(e);
            const line = streamCanonical(e)+'\n'; size += Buffer.byteLength(line);
            fhAssert(size <= FB.archiveChunkBytes && bytes(coverage) <= B.decodeBytes, 'export bound'); fhWrite(fd,line);
            if (e.kind === 'committed') coverage.push(...(JSON.parse(String(e.payload)) as RowsAndGapsCommit).coverage);
          }
          this.options.boundary?.('seal-before-fsync'); fsyncSync(fd);
        } finally { closeSync(fd); }
        this.options.boundary?.('seal-before-rename'); renameSync(temp,path); chmodSync(path,0o400); fhSyncDir(this.root);
        const file = fhEvidence(path), manifestPath = join(this.root,r.segmentId+'.manifest.json');
        const manifestText = streamCanonical({version:1,storeUUID:this.storeUUID,pane:r.pane,segmentId:r.segmentId,schemaVersions:{history:1,spool:1},coverage,files:[file]});
        fhAssert(Buffer.byteLength(manifestText) <= B.decodeBytes, 'manifest bound'); fhSafePath(manifestPath+'.tmp'); fhSafePath(manifestPath);
        const mf = openSync(manifestPath+'.tmp','w',0o600);
        try { fhWrite(mf,manifestText); fsyncSync(mf); } finally { closeSync(mf); }
        renameSync(manifestPath+'.tmp',manifestPath); chmodSync(manifestPath,0o400); fhSyncDir(this.root);
        const sealed: SealedExport = {kind:'sealed-export',operationId:r.operationId,storeUUID:this.storeUUID,pane:r.pane,segmentId:r.segmentId,generation:this.load<LogicalSealR2>('logical',r.segmentId)?.sealGeneration ?? r.expectedGeneration,coverage,files:[file],manifest:fhEvidence(manifestPath),sealCommitId:this.load<LogicalSealR2>('logical',r.segmentId)?.sealCommitId ?? randomUUID()};
        this.db.query("UPDATE fh_segment SET state='sealed',sealed=? WHERE id=?").run(streamCanonical(sealed),r.segmentId);
        return sealed;
      }); return ok(result);
    } catch(e) { return fail(e); }
  }
  async reclaimVerified(r: OperationFence & {sealed:SealedExport;remote:RemoteIndexReceipt}): Promise<Result<ReclaimReceipt>> {
    try {
      this.live(); const sealed = r.sealed, remote = r.remote;
      const before = this.physical();
      this.tx('reclaim', () => {
        this.fence(r); const s = this.segment(sealed.segmentId,r.pane);
        fhAssert(s.sealed === streamCanonical(sealed) && equal(sealed.pane,r.pane) && sealed.storeUUID === this.storeUUID, 'seal mismatch');
        this.unpinned(sealed.segmentId);
        fhAssert(remote.kind === 'remote-index-committed' && remote.catalogVersion === 3 && remote.generation === r.expectedGeneration && equal(remote.coverage,sealed.coverage), 'remote index coverage/generation');
        const v = remote.verified, b = v.bundle;
        fhAssert(v.kind === 'verified-remote' && v.exitCode === 0 && (v.method === 'download-sha256' || v.method === 'rclone-check-download') && v.evidence.length > 0, 'upload is not verification');
        const inventory=this.load<ArchiveInventoryR2>('remote-inventory',remote.commitId);
        if(inventory) {
          fhAssert(archiveInventoryMatches(sealed,b,inventory),'verified inventory mismatch');
          fhAssert(this.options.catalogAuthority,'remote catalog authority unavailable');
          const durable=this.value(this.options.catalogAuthority.remote(remote.commitId));
          fhAssert(durable && equal(durable,remote),'remote catalog receipt absent/mismatch');
        } else {
          fhAssert(b.version === 1 && b.storeUUID === this.storeUUID && b.segmentId === sealed.segmentId && equal(b.pane,r.pane) && equal(b.coverage,sealed.coverage) && equal(b.members,[...sealed.files,sealed.manifest]), 'verified inventory mismatch');
          fhAssert(this.options.validateRemoteIndex?.(remote,sealed) === true, 'remote catalog authority not validated');
        }
        if (s.remote) fhAssert(s.remote === streamCanonical(remote), 'remote receipt changed during reclaim');
        this.db.query("UPDATE fh_segment SET state='reclaiming',remote=? WHERE id=?").run(streamCanonical(remote),sealed.segmentId);
      });
      // 'reclaiming' is durable before any unlink; pinSegment rejects it. Retry
      // after interruption revalidates catalog authority and the same inventory.
      for (const file of [...sealed.files,sealed.manifest]) {
        fhAssert(dirname(file.path) === this.root && [sealed.segmentId+'.jsonl',sealed.segmentId+'.manifest.json'].includes(file.path.slice(this.root.length+1)), 'unsafe reclaim path');
        if (existsSync(file.path)) {
          fhAssert(equal(fhEvidence(file.path),file), 'sealed file changed');
          this.options.boundary?.('reclaim-before-unlink'); unlinkSync(file.path);
          this.options.boundary?.('reclaim-after-unlink');
        }
      }
      fhSyncDir(this.root);
      this.tx('reclaim-rows', () => {
        this.fence(r); this.unpinned(sealed.segmentId);
        this.db.query('DELETE FROM fh_event WHERE segment=?').run(sealed.segmentId);
        this.db.query('DELETE FROM fh_checkpoint WHERE segment=?').run(sealed.segmentId);
        // Stable row IDs and timeline slots survive payload reclaim.
        // They are bounded by the same SQLite page budget as the payload.
        this.db.query("UPDATE fh_segment SET state='remote',bytes=0 WHERE id=?").run(sealed.segmentId);
      });
      // DELETE alone does not release filesystem blocks. Drain WAL, then each
      // incremental-vacuum step releases a tail page without a full DB copy.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      for (;;) {
        const n = Number((this.db.query('PRAGMA freelist_count').get() as SqlRow).freelist_count);
        if (!n) break;
        this.db.exec('PRAGMA incremental_vacuum(256)');
        const left = Number((this.db.query('PRAGMA freelist_count').get() as SqlRow).freelist_count);
        if (left >= n) break;
      }
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const after = this.physical();
      return ok({kind:'local-reclaimed',remote,removed:[...sealed.files,sealed.manifest],allocatedBytesBefore:before.allocated,allocatedBytesAfter:after.allocated,freeBlocksBefore:before.free,freeBlocksAfter:after.free,blockBytes:after.block});
    } catch(e) { return fail(e); }
  }
  private read<T>(fn:()=>T): Result<T> { try { this.live(); return ok(fn()); } catch(e) { return fail(e); } }
  private value<T>(r:Result<T>):T { fhAssert(r.status==='ok',streamCanonical(r));return r.value; }
  private load<T>(kind:string,id:string):T|null {
    const row=this.db.query('SELECT payload,checksum FROM fh_r2 WHERE kind=? AND id=?').get(kind,id) as SqlRow|null;
    if(!row)return null;
    fhAssert(row.checksum===streamDigest('history-r2-metadata',{kind,id,payload:row.payload}),'corrupt r2 metadata');
    return JSON.parse(String(row.payload)) as T;
  }
  private save(kind:string,id:string,pane:string,value:unknown):void {
    const payload=streamCanonical(value);fhAssert(Buffer.byteLength(payload)<=B.decodeBytes,'r2 metadata bound');
    this.db.query('INSERT OR REPLACE INTO fh_r2 VALUES(?,?,?,?,?)').run(kind,id,pane,payload,streamDigest('history-r2-metadata',{kind,id,payload}));
  }
  private migrateIndex():void {
    if(this.load('migration','timeline-v2'))return;
    this.db.transaction(()=>{
      let seq=0;
      for(;;){const row=this.db.query('SELECT * FROM fh_event WHERE seq>? ORDER BY seq LIMIT 1').get(seq) as SqlRow|null;if(!row)break;
        seq=Number(row.seq);this.checkEvent(row);
        if(row.kind==='committed'){const r=JSON.parse(String(row.payload)) as RowsAndGapsCommit;this.indexRows(r);this.save('receipt',r.operationId,String(row.pane),JSON.parse(String(row.receipt)));}
        else if(row.kind==='input')this.save('ack',String(row.op),String(row.pane),JSON.parse(String(row.receipt)));
      }
      this.save('migration','timeline-v2','',true);
    }).immediate();
  }
  private indexRows(r:RowsAndGapsCommit):void {
    const pane=paneKey(r.pane);
    if(this.load('indexed',r.operationId))return;
    let n=Number((this.db.query('SELECT COALESCE(MAX(n),-1)+1 AS n FROM fh_timeline WHERE pane=?').get(pane) as SqlRow).n),item=0;
    for(const c of r.coverage){
      if(c.kind==='rows')for(const row of r.rows.filter(row=>row.id.segmentId===c.range.segmentId && row.id.rowOrdinal>=c.range.start && row.id.rowOrdinal<c.range.end))
        this.db.query('INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,?)').run(pane,n++,row.id.segmentId,r.operationId,item++,'row',row.id.rowOrdinal);
      else this.db.query('INSERT INTO fh_timeline VALUES(?,?,?,?,?,?,NULL)').run(pane,n++,r.rows[0]?.id.segmentId ?? c.gap.rightSegmentId ?? r.inputAck.segmentId,r.operationId,item++,'gap');
    }
    this.save('indexed',r.operationId,pane,true);
    this.save('index-head',pane,pane,r.operationId);
  }
  private projection(r:RowsAndGapsCommit):CoverageProjectionR2 {
    const coverage=r.coverage.map(c=>c.kind==='gap'?{...c,digest:normalizedGapDigest(c.gap)}:
      {...c,digest:normalizedRowsDigest(c.range,r.rows.filter(row=>row.id.segmentId===c.range.segmentId&&row.id.rowOrdinal>=c.range.start&&row.id.rowOrdinal<c.range.end))});
    const body={revision:2 as const,sourceCommitId:r.operationId,sourceDigest:r.digest,sourceDomain:'rows-gaps-v1' as const,coverage,coverageDigest:normalizedCoverageDigest(coverage)};
    return {...body,projectionDigest:coverageProjectionDigest(body)};
  }
  private cursor(pane:PaneKey,n:number):NewarchHistoryCursor {
    const body={store:this.storeUUID,pane,n};return {version:1,token:Buffer.from(streamCanonical({...body,hash:streamDigest('history-cursor-r2',body)})).toString('base64url')};
  }
  private position(pane:PaneKey,cursor:NewarchHistoryCursor|null,fallback:number):number {
    if(!cursor)return fallback;fhAssert(cursor.version===1&&cursor.token.length<=4096,'cursor bound/version');
    const {hash,...body}=JSON.parse(Buffer.from(cursor.token,'base64url').toString());
    fhAssert(body.store===this.storeUUID&&equal(body.pane,pane)&&hash===streamDigest('history-cursor-r2',body),'cursor identity');safe(body.n);return body.n;
  }
  private head(pane:PaneKey):TimelineHeadR2 {
    const key=paneKey(pane),generation=this.generation(pane);
    const count=this.db.query("SELECT COUNT(*) AS entries,COALESCE(SUM(kind='row'),0) AS rows FROM fh_timeline WHERE pane=?").get(key) as SqlRow;
    const last=this.db.query("SELECT segment,ordinal FROM fh_timeline WHERE pane=? AND kind='row' ORDER BY n DESC LIMIT 1").get(key) as SqlRow|null;
    return {pane,generation,indexCommitId:this.load<string>('index-head',key)??'empty:'+this.storeUUID,entryCount:Number(count.entries),rowCount:Number(count.rows),lastRow:last?{pane,segmentId:String(last.segment),rowOrdinal:Number(last.ordinal)}:null,cursor:this.cursor(pane,Number(count.entries))};
  }
  private generation(pane:PaneKey):number {
    const row=this.db.query('SELECT generation FROM fh_pane WHERE pane=?').get(paneKey(pane)) as SqlRow|null;fhAssert(row,'unknown pane');return Number(row.generation);
  }
  private bounded(request:BoundedReadR2):void {
    safe(request.maxEntries);safe(request.maxBytes);fhAssert(request.maxEntries>0&&request.maxEntries<=256&&request.maxBytes>0&&request.maxBytes<=B.decodeBytes,'read bound');
    fhAssert(request.direction==='before'||request.direction==='after','read direction');
  }
  private entries(r:RowsAndGapsCommit):(CommittedStreamRow|Gap)[] {
    return r.coverage.flatMap(c=>c.kind==='gap'?[c.gap] as (CommittedStreamRow|Gap)[]:r.rows.filter(row=>row.id.segmentId===c.range.segmentId&&row.id.rowOrdinal>=c.range.start&&row.id.rowOrdinal<c.range.end));
  }
  private page(r:BoundedReadR2):TimelinePageR2 {
    this.bounded(r);this.reconcile(r.pane);const head=this.head(r.pane),key=paneKey(r.pane),back=r.direction==='before';
    const start=this.position(r.pane,r.cursor,back?head.entryCount:0);fhAssert(start<=head.entryCount,'cursor outside timeline');
    const slots=this.db.query(`SELECT * FROM fh_timeline WHERE pane=? AND n${back?'<':'>='}? ORDER BY n ${back?'DESC':'ASC'} LIMIT ?`).all(key,start,r.maxEntries) as SqlRow[];
    const entries:(CommittedStreamRow|Gap)[]=[];let payloadBytes=0,lo=start,hi=start,blocked:NewarchHistoryContinuation|null=null;
    for(const slot of slots){
      const s=this.segment(String(slot.segment),r.pane),event=this.event(String(slot.op));
      if(s.state==='remote'||s.state==='reclaiming'){
        const remote=JSON.parse(String(s.remote)) as RemoteIndexReceipt;
        const at=back?Number(slot.n)+1:Number(slot.n);
        blocked={kind:'blocked',cursor:this.cursor(r.pane,at),state:{kind:'remote-required',range:{pane:r.pane,segmentId:String(s.id),start:0,end:Number(s.next_row)},bundleId:remote.verified.bundle.bundleId}};break;
      }
      fhAssert(event,'timeline payload missing');this.checkEvent(event);fhAssert(event.kind==='committed','unpublished timeline');
      const entry=this.entries(JSON.parse(String(event.payload)))[Number(slot.item)];fhAssert(entry,'timeline entry missing');
      const size=bytes(entry);fhAssert(size<=r.maxBytes||entries.length>0,'single entry exceeds read budget');if(payloadBytes+size>r.maxBytes)break;
      payloadBytes+=size;entries.push(entry);lo=Math.min(lo,Number(slot.n));hi=Math.max(hi,Number(slot.n)+1);
    }
    if(back)entries.reverse();
    const before:NewarchHistoryContinuation=back&&blocked?blocked:lo===0?{kind:'end'}:{kind:'more',cursor:this.cursor(r.pane,lo)};
    const after:NewarchHistoryContinuation=!back&&blocked?blocked:hi===head.entryCount?{kind:'end'}:{kind:'more',cursor:this.cursor(r.pane,hi)};
    return {head,entries,payloadBytes,before,after};
  }
  private tail(pane:PaneKey,maxRows:number,maxBytes:number):TailAnchorR2 {
    safe(maxRows);safe(maxBytes);fhAssert(maxRows>0&&maxRows<=512&&maxBytes>0&&maxBytes<=B.decodeBytes,'tail bound');
    this.reconcile(pane);const head=this.head(pane),rows:CommittedStreamRow[]=[];let used=0,cursor:NewarchHistoryCursor|null=null;
    // At most two bounded pages; callers may page further without retaining 4500 rows in RAM.
    for(let i=0;i<2&&rows.length<maxRows;i++){
      const page=this.page({pane,cursor,direction:'before',maxEntries:Math.min(256,maxRows-rows.length),maxBytes:maxBytes-used});
      rows.unshift(...page.entries.filter((e):e is CommittedStreamRow=>'cells' in e));used+=page.payloadBytes;
      if(page.before.kind==='blocked')return {kind:'blocked',head,state:page.before.state};
      if(page.before.kind==='end'||used===maxBytes)break;cursor=page.before.cursor;
    }
    if(!rows.length)return {kind:'blocked',head,state:{kind:'pending',operationId:'tail-anchor:'+paneKey(pane),retryAfterMs:20}};
    const segments=new Set(rows.map(row=>row.id.segmentId));
    // A pin covers one segment. Refuse a cross-segment tail instead of claiming a partial pin.
    if(segments.size!==1)return {kind:'blocked',head,state:{kind:'pending',operationId:'tail-spans-segments',retryAfterMs:20}};
    const request:PinRequest={pane,expectedGeneration:head.generation,operationId:randomUUID(),segmentId:rows[0]!.id.segmentId,reason:'reader'};
    const pin:SegmentPin={...request,pinId:randomUUID(),durableCommitId:randomUUID()};
    this.tx('tail-pin',()=>{this.unreclaimed(request.segmentId,pane);this.db.query('INSERT INTO fh_pin VALUES(?,?,?,?,0)').run(pin.pinId,request.operationId,request.segmentId,streamCanonical(pin));});
    return {kind:'local',head,rows,pin};
  }
  private unreclaimed(segment:string,pane:PaneKey):void { const s=this.segment(segment,pane);fhAssert(s.state!=='remote'&&s.state!=='reclaiming','segment not local'); }
  readonly authority:HistoryAuthorityR2={
    generation:pane=>this.read(()=>this.generation(pane)),
    staged:(id,n)=>this.read(()=>{safe(n);return this.load<StagedReceiptR2>('staged',id+':'+n);}),
    attachSet:id=>this.read(()=>this.load<AttachReceiptSetR2>('attach-set',id)),
    receipt:id=>this.read(()=>this.event(id)?.kind==='candidate'?null:this.load<RowsAndGapsReceipt>('receipt',id)),
    pin:id=>this.read(()=>{const row=this.db.query('SELECT payload,released FROM fh_pin WHERE id=?').get(id) as SqlRow|null;return row&&row.released===0&&row.payload!=='replay'?JSON.parse(String(row.payload)) as SegmentPin:null;}),
    seal:id=>this.read(()=>{const row=this.db.query("SELECT sealed FROM fh_segment WHERE json_extract(sealed,'$.sealCommitId')=?").get(id) as SqlRow|null;return row?JSON.parse(String(row.sealed)) as SealedExport:null;}),
    continuity:id=>this.read(()=>this.load<SegmentContinuityR2>('rotation',id)),
    head:pane=>this.read(()=>{this.reconcile(pane);return this.head(pane);}),
    tail:(pane,n,b)=>this.read(()=>this.tail(pane,n,b)),
    page:r=>this.read(()=>this.page(r)),
    watermark:pane=>this.read(()=>this.load<ReplayWatermarkR2>('watermark',paneKey(pane))),
    decisions:r=>this.read(()=>this.readDecisions(r)),
  };
  private readDecisions(r:BoundedReadR2):{entries:ReplayDecisionR2[];next:NewarchHistoryCursor|null} {
    this.bounded(r);const pane=paneKey(r.pane),all=Number((this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='decision' AND pane=?").get(pane) as SqlRow).n);
    const n=this.position(r.pane,r.cursor,r.direction==='before'?all:0);fhAssert(n<=all,'decision cursor outside index');
    const from=r.direction==='before'?Math.max(0,n-r.maxEntries):n;
    const ids=this.db.query("SELECT id FROM fh_r2 WHERE kind='decision' AND pane=? ORDER BY json_extract(payload,'$.raw.start'),json_extract(payload,'$.controlStart'),id LIMIT ? OFFSET ?").all(pane,Math.min(r.maxEntries,r.direction==='before'?n:all-n),from) as SqlRow[];
    const entries:ReplayDecisionR2[]=[];let size=0;
    for(const id of ids){const d=this.load<ReplayDecisionR2>('decision',String(id.id))!;if(size+bytes(d)>r.maxBytes){fhAssert(entries.length,'decision exceeds page budget');break;}size+=bytes(d);entries.push(d);}
    const next=r.direction==='before'?from:from+entries.length;return {entries,next:(r.direction==='before'?next>0:next<all)?this.cursor(r.pane,next):null};
  }
  private logical(r:OperationFence&{segmentId:string}):LogicalSealR2 {
    const key=this.fence(r),s=this.segment(r.segmentId,r.pane),old=this.load<LogicalSealR2>('logical',r.segmentId);if(old)return old;
    fhAssert(s.state==='open'||s.state==='sealed','segment not sealable');
    fhAssert(!this.db.query("SELECT 1 FROM fh_event WHERE segment=? AND kind='candidate'").get(r.segmentId),'attach candidate not published');
    const coverage:Coverage[number][]=[],rawRanges:SpoolRecord['range'][]=[],checkpointIds:string[]=[];let seq=0;
    for(;;){const e=this.db.query('SELECT * FROM fh_event WHERE segment=? AND seq>? ORDER BY seq LIMIT 1').get(r.segmentId,seq) as SqlRow|null;if(!e)break;this.checkEvent(e);seq=Number(e.seq);
      const p=JSON.parse(String(e.payload));if(e.kind==='committed')coverage.push(...p.coverage);else if(e.kind==='input'){
        const range=p.range as SpoolRecord['range'],last=rawRanges.at(-1);if(last&&equal(last.epoch,range.epoch)&&last.end===range.start)rawRanges[rawRanges.length-1]={...last,end:range.end};else rawRanges.push(range);
      }else if(e.kind==='checkpoint')checkpointIds.push(p.checkpointId);
      fhAssert(bytes({coverage,rawRanges,checkpointIds})<=B.decodeBytes,'logical seal bound');
    }
    const existing=s.sealed?JSON.parse(String(s.sealed)) as SealedExport:null;
    const seal:LogicalSealR2={revision:2,sealCommitId:existing?.sealCommitId??r.operationId,sealGeneration:existing?.generation??r.expectedGeneration,pane:r.pane,segmentId:r.segmentId,coverage,rawRanges,checkpointIds,timelineIndexCommitId:this.head(r.pane).indexCommitId,replayIndexCommitId:this.load<string>('decision-head',key)??'empty:'+this.storeUUID};
    this.save('logical',r.segmentId,key,seal);if(s.state==='open')this.db.query("UPDATE fh_segment SET state='sealed-local' WHERE id=?").run(r.segmentId);return seal;
  }
  async sealSegment(r:OperationFence&{segmentId:string}):Promise<Result<LogicalSealR2>> {return this.read(()=>this.tx('logical-seal',()=>this.logical(r)));}
  private rotate(r:OperationFence&{segmentId:string;boundary:RawPosition}):SegmentContinuityR2 {
    const key=this.fence(r),prior=this.load<SegmentContinuityR2>('rotation',r.operationId);
    if(prior){fhAssert(prior.predecessor===r.segmentId&&equal(prior.boundary,r.boundary),'rotation collision');return prior;}
    const epoch=this.db.query('SELECT * FROM fh_epoch WHERE epoch=?').get(streamCanonical(r.boundary.epoch)) as SqlRow|null;
    fhAssert(epoch&&epoch.pane===key&&epoch.segment===r.segmentId&&epoch.offset===r.boundary.byteOffset,'rotation boundary is not durable head');
    const seal=this.logical(r),successor=streamDigest('history-successor-r2',{predecessor:r.segmentId,operation:r.operationId});
    const body={revision:2 as const,pane:r.pane,epoch:r.boundary.epoch,predecessor:r.segmentId,successor,boundary:r.boundary,lastRow:this.head(r.pane).lastRow,firstSuccessorOrdinal:0 as const,sealCommitId:seal.sealCommitId,rotationCommitId:r.operationId};
    const receipt={...body,digest:segmentContinuityDigest(body)};
    this.db.query("INSERT INTO fh_segment(id,pane,state) VALUES(?,?,'open')").run(successor,key);
    this.db.query('UPDATE fh_epoch SET segment=? WHERE epoch=?').run(successor,streamCanonical(r.boundary.epoch));
    this.save('rotation',r.operationId,key,receipt);this.save('successor',successor,key,receipt);return receipt;
  }
  async rotateSegment(r:OperationFence&{segmentId:string;boundary:RawPosition}):Promise<Result<SegmentContinuityR2>> {return this.read(()=>this.tx('rotate',()=>this.rotate(r)));}
  listSealed(cursor:string|null,limit:number):Result<{seals:readonly LogicalSealR2[];next:string|null}> {
    return this.read(()=>{safe(limit);fhAssert(limit>0&&limit<=256,'sealed page bound');
      const rows=this.db.query("SELECT id FROM fh_r2 WHERE kind='logical' AND id>? ORDER BY id LIMIT ?").all(cursor??'',limit+1) as SqlRow[];
      return {seals:rows.slice(0,limit).map(row=>this.load<LogicalSealR2>('logical',String(row.id))!),next:rows.length>limit?String(rows[limit-1]!.id):null};});
  }
  async materializeExport(r:OperationFence&{sealCommitId:string}):Promise<Result<SealedExport>> {
    try{this.fence(r);const row=this.db.query("SELECT id FROM fh_r2 WHERE kind='logical' AND json_extract(payload,'$.sealCommitId')=? AND pane=?").get(r.sealCommitId,paneKey(r.pane)) as SqlRow|null;fhAssert(row,'unknown logical seal');return this.sealExport({...r,segmentId:String(row.id)});}catch(e){return fail(e);}
  }
  async stageRows(r:StagedRowsR2):Promise<Result<StagedReceiptR2>> {
    try{
      const {repair,...body}=r;fhAssert(repair.revision===2&&repair.visibility==='candidate'&&equal(repair.epoch,r.inputAck.through.epoch)&&repair.decisionId===r.decision.decisionId,'candidate identity');
      nonempty(repair.transactionId);safe(repair.chunkOrdinal);fhAssert(repair.chunkOrdinal<256,'candidate count bound');
      const key=paneKey(r.pane),id=repair.transactionId+':'+repair.chunkOrdinal;
      return ok(this.tx('stage',()=>{
        this.fence(r);const previous=this.load<StagedReceiptR2>('staged',id);
        if(previous){fhAssert(equal(previous.request,repair)&&previous.receipt.digest===body.digest,'candidate collision');return previous;}
        fhAssert(!this.load('attach-set',repair.transactionId)&&!this.load('attach-done',repair.transactionId),'attach already sealed/decided');
        const count=Number((this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='staged' AND json_extract(payload,'$.request.transactionId')=?").get(repair.transactionId) as SqlRow).n);
        fhAssert(count===repair.chunkOrdinal,'candidate chunk order');
        if(count){const first=this.load<StagedReceiptR2>('staged',repair.transactionId+':0')!;fhAssert(equal(first.request.epoch,repair.epoch)&&first.request.decisionId===repair.decisionId&&first.receipt.generation===r.expectedGeneration,'candidate transaction changed');}
        this.value(this.commitRows(body,repair));return this.load<StagedReceiptR2>('staged',id)!;
      }));
    }catch(e){return fail(e);}
  }
  async sealAttachSet(r:OperationFence&{manifest:AttachReceiptSetR2}):Promise<Result<AttachReceiptSetR2>> {
    return this.read(()=>this.tx('attach-set',()=>{
      const key=this.fence(r),m=r.manifest,old=this.load<AttachReceiptSetR2>('attach-set',m.transactionId);if(old){fhAssert(equal(old,m),'attach set collision');return old;}
      fhAssert(equal(m.pane,r.pane)&&m.expectedGeneration===r.expectedGeneration,'attach set fence');
      const count=Number((this.db.query("SELECT COUNT(*) AS n FROM fh_r2 WHERE kind='staged' AND json_extract(payload,'$.request.transactionId')=?").get(m.transactionId) as SqlRow).n);
      fhAssert(count===m.entries.length,'attach omitted chunks');
      const receipts=m.entries.map(entry=>{
        const staged=this.load<StagedReceiptR2>('staged',m.transactionId+':'+entry.ordinal);fhAssert(staged,'missing staged receipt');
        const e=this.event(staged.receipt.operationId);fhAssert(e&&e.kind==='candidate','missing candidate payload');this.checkEvent(e);
        const body=JSON.parse(String(e.payload)) as RowsAndGapsCommit;
        fhAssert(equal(staged.request.epoch,m.epoch)&&staged.request.decisionId===m.decisionId&&entry.rows===body.rows.length&&entry.payloadBytes===bytes(body),'attach chunk readback mismatch');
        return staged.receipt;
      });
      attachCoverage(m,receipts);this.save('attach-set',m.transactionId,key,m);return m;
    }));
  }
  private attachDecision(d:AttachDecisionR2):AttachReceiptSetR2 {
    fhAssert(d.revision===2&&this.options.catalogAuthority,'catalog attach authority unavailable');
    const authority=this.value(this.options.catalogAuthority.attach(d.attachId));fhAssert(authority&&equal(authority,d),'catalog attach decision mismatch');
    const m=this.load<AttachReceiptSetR2>('attach-set',d.transactionId);fhAssert(m&&m.epoch.attachId===d.attachId&&m.aggregateDigest===d.receiptSetDigest,'attach decision manifest mismatch');
    fhAssert(d.generation===m.expectedGeneration+1,'attach generation mismatch');return m;
  }
  private publish(d:AttachDecisionR2):TimelineHeadR2 {
    const m=this.attachDecision(d);fhAssert(d.state==='COMMITTED','attach not committed');
    const done=this.load<AttachDecisionR2>('attach-done',d.transactionId);if(done){fhAssert(equal(done,d),'attach finalization changed');return this.head(m.pane);}
    const current=this.generation(m.pane);fhAssert(current===m.expectedGeneration||current===d.generation,'attach stale owner');
    for(const entry of m.entries){
      const e=this.event(entry.operationId);fhAssert(e&&e.kind==='candidate','missing candidate at publish');this.checkEvent(e);
      const r=JSON.parse(String(e.payload)) as RowsAndGapsCommit;
      const checksum=streamDigest('flag-on-event',{kind:'committed',op:e.op,digest:e.digest,payload:e.payload,receipt:e.receipt,segment:e.segment,pane:e.pane});
      this.db.query("UPDATE fh_event SET kind='committed',checksum=? WHERE op=?").run(checksum,entry.operationId);this.indexRows(r);
    }
    this.db.query('UPDATE fh_pane SET generation=? WHERE pane=?').run(d.generation,paneKey(m.pane));this.save('attach-done',d.transactionId,paneKey(m.pane),d);return this.head(m.pane);
  }
  private reconcile(pane:PaneKey):void {
    const pending=this.db.query("SELECT id FROM fh_r2 WHERE kind='attach-set' AND pane=? AND id NOT IN (SELECT id FROM fh_r2 WHERE kind='attach-done') LIMIT 257").all(paneKey(pane)) as SqlRow[];
    fhAssert(pending.length<=256,'pending attach metadata bound');
    for(const row of pending){const m=this.load<AttachReceiptSetR2>('attach-set',String(row.id))!;
      fhAssert(this.options.catalogAuthority,'catalog attach authority unavailable');const d=this.value(this.options.catalogAuthority.attach(m.epoch.attachId));
      if(d?.state==='COMMITTED')this.tx('reconcile',()=>this.publish(d));
    }
  }
  async publishAttach(d:AttachDecisionR2):Promise<Result<TimelineHeadR2>> {return this.read(()=>this.tx('publish',()=>this.publish(d)));}
  async discardAttach(d:AttachDecisionR2):Promise<Result<null>> {
    return this.read(()=>this.tx('discard',()=>{const m=this.attachDecision(d);fhAssert(d.state==='ABORTED','only aborted attach may discard');
      fhAssert(!this.load('attach-done',d.transactionId),'attach already finalized');
      for(const entry of m.entries){const e=this.event(entry.operationId);fhAssert(e?.kind==='candidate','cannot discard published payload');this.db.query('DELETE FROM fh_event WHERE op=?').run(entry.operationId);}
      this.save('attach-done',d.transactionId,paneKey(m.pane),d);return null;
    }));
  }
  async appendVerifiedInput(input:CoalescedInputR2):Promise<Result<SpoolAck>> {
    try{
      const {provenanceDigest,...body}=input;fhAssert(input.revision===2&&input.historyDomain==='spool'&&input.source.length>0&&input.source.length<=256&&bytes(input)<=B.decodeBytes,'input provenance bound');
      fhAssert(inputProvenanceDigest(body)===provenanceDigest&&this.options.readSourceRecords,'source read authority required');
      const record=input.record;let offset=record.range.start,previous:SpoolRecord|null=null;const raw:number[]=[];
      for(const slice of input.source){
        fhAssert(slice.sourceDomain==='spool-record'&&equal(slice.range.epoch,record.range.epoch)&&slice.range.start===offset,'source slice discontinuity');
        const records=this.value(this.options.readSourceRecords(slice));fhAssert(records.length>0&&records.length<=4096&&bytes(records)<=B.decodeBytes,'source read bound');
        fhAssert(sourceRecordsDigest(records)===slice.recordsDigest&&records[0]!.sequence===slice.firstSequence&&records.at(-1)!.sequence===slice.lastSequence&&records[0]!.previousDigest===slice.previousDigest&&records.at(-1)!.digest===slice.terminalDigest,'source readback digest');
        for(const source of records){const {digest:d,...p}=source;fhAssert(sourceSpoolDigest(p)===d&&equal(source.range.epoch,record.range.epoch)&&source.range.start===offset,'source bytes/range digest');
          if(previous)fhAssert(source.sequence===previous.sequence+1&&source.previousDigest===previous.digest,'source chain');
          if(source.payload.kind==='bytes'){fhAssert(source.range.end-source.range.start===source.payload.bytes.length,'source range size');raw.push(...source.payload.bytes);fhAssert(raw.length<=FB.rawBytesPerPane,'source aggregate bound');}
          else fhAssert(records.length===1&&input.source.length===1&&equal(source.payload,record.payload)&&source.range.end===source.range.start,'coalesced control mismatch');
          offset=source.range.end;previous=source;
        }
        fhAssert(offset===slice.range.end,'source slice end');
      }
      fhAssert(offset===record.range.end&&(record.payload.kind!=='bytes'||equal(raw,record.payload.bytes)),'coalesced byte mismatch');
      const receipt=await this.appendInput(record);if(receipt.status!=='ok')return receipt;
      this.tx('provenance',()=>{const old=this.load('provenance',record.operationId);fhAssert(!old||equal(old,input),'provenance collision');this.save('provenance',record.operationId,paneKey(record.range.epoch.pane),input);});return receipt;
    }catch(e){return fail(e);}
  }
  async journalControl(r:OperationFence&{event:OrderedControlR2}):Promise<Result<{commitId:string;event:OrderedControlR2}>> {
    return this.read(()=>this.tx('control',()=>{const key=this.fence(r),event=r.event,{digest:d,...body}=event;
      fhAssert(event.revision===2&&equal(event.position.epoch.pane,r.pane)&&orderedControlDigest(body)===d&&this.options.codecVersions.includes(event.decoderVersion),'control identity/digest/codec');safe(event.order);safe(event.position.byteOffset);
      const old=this.load<OrderedControlR2>('control',event.eventId);if(old){fhAssert(equal(old,event),'control collision');return {commitId:r.operationId,event:old};}
      const epoch=this.db.query('SELECT * FROM fh_epoch WHERE epoch=?').get(streamCanonical(event.position.epoch)) as SqlRow|null;
      fhAssert(epoch&&epoch.offset===event.position.byteOffset,'control not at durable raw head');
      const last=this.db.query("SELECT payload FROM fh_r2 WHERE kind='control' AND pane=? AND json_extract(payload,'$.position.epoch.attachId')=? ORDER BY json_extract(payload,'$.position.byteOffset') DESC,json_extract(payload,'$.order') DESC LIMIT 1").get(key,event.position.epoch.attachId) as SqlRow|null;
      if(last){const p=JSON.parse(String(last.payload)) as OrderedControlR2;fhAssert(event.position.byteOffset>p.position.byteOffset||event.position.byteOffset===p.position.byteOffset&&event.order>p.order,'control order');}
      if(event.payload.kind==='geometry'){geometry(event.payload.before);geometry(event.payload.after);}
      else{nonempty(event.payload.name);fhAssert(typeof event.payload.data==='string','control data');}
      this.save('control',event.eventId,key,event);return {commitId:r.operationId,event};
    }));
  }
  async commitReplayCheckpoint(r:OperationFence&{checkpoint:VtCheckpoint;watermark:ReplayWatermarkR2}):Promise<Result<ReplayWatermarkR2>> {
    return this.read(()=>this.tx('replay-checkpoint',()=>{const key=this.fence(r),cp=r.checkpoint,w=r.watermark;
      fhAssert(w.revision===2&&equal(w.pane,r.pane)&&equal(w.through.epoch.pane,r.pane)&&equal(cp.identity.pane,r.pane)&&w.checkpointId===cp.checkpointId&&w.stateDigest===cp.stateDigest&&w.decoderVersion===cp.state.codecVersion&&this.options.codecVersions.includes(w.decoderVersion),'replay checkpoint identity');
      fhAssert(cp.stateDigest===streamDigest('vt-state',{identity:cp.identity,state:cp.state})&&bytes(cp)<=B.vtBytesPerPane,'checkpoint digest/bound');safe(w.controlOrder);
      fhAssert(Object.keys(w.known).length>0&&Object.values(w.known).every(x=>typeof x==='boolean'),'checkpoint known state');
      const epoch=this.db.query('SELECT * FROM fh_epoch WHERE epoch=?').get(streamCanonical(w.through.epoch)) as SqlRow|null;
      fhAssert(epoch&&epoch.offset===w.through.byteOffset,'checkpoint raw head');
      const index=this.load<string>('decision-head',key)??'empty:'+this.storeUUID;fhAssert(w.decisionIndexCommitId===index,'checkpoint decision watermark');
      for(const dependency of w.snapshotDependencies){fhAssert(resolve(dependency.path).startsWith(this.root+sep),'checkpoint dependency outside root');fhAssert(equal(fhEvidence(dependency.path),dependency),'checkpoint dependency changed');}
      const old=this.load<ReplayWatermarkR2>('watermark',key);if(old?.checkpointId===w.checkpointId){fhAssert(equal(old,w),'checkpoint retry changed');return old;}
      if(old){fhAssert(equal(old.through.epoch,w.through.epoch)&&old.through.byteOffset<=w.through.byteOffset,'checkpoint regression');}
      const prior=this.load<VtCheckpoint>('replay-checkpoint',cp.checkpointId);fhAssert(!prior||equal(prior,cp),'checkpoint id collision');
      this.save('replay-checkpoint',cp.checkpointId,key,cp);this.save('watermark',key,key,w);
      // Latest recovery state pins its raw segment. Release only after this FULL
      // transaction has installed the durable successor checkpoint.
      this.db.query("DELETE FROM fh_pin WHERE operation=?").run('checkpoint:'+key);
      const pin:SegmentPin={pane:r.pane,expectedGeneration:r.expectedGeneration,operationId:'checkpoint:'+key,segmentId:String(epoch.segment),reason:'replay',pinId:'checkpoint:'+key,durableCommitId:r.operationId};
      this.db.query('INSERT INTO fh_pin VALUES(?,?,?,?,0)').run(pin.pinId,pin.operationId,pin.segmentId,streamCanonical(pin));return w;
    }));
  }
  async commitReplayDecision(r:OperationFence&{decision:ReplayDecisionR2}):Promise<Result<{commitId:string}>> {
    return this.read(()=>this.tx('replay-decision',()=>{const key=this.fence(r),d=r.decision;
      fhAssert(equal(d.raw.epoch.pane,r.pane)&&this.options.codecVersions.includes(d.decoderVersion)&&['consumed','withheld'].includes(d.disposition),'decision identity');
      [d.raw.start,d.raw.end,d.controlStart,d.controlEnd].forEach(safe);fhAssert(d.raw.end>=d.raw.start&&d.controlEnd>=d.controlStart,'decision interval');
      const old=this.load<ReplayDecisionR2>('decision',d.decisionId);if(old){fhAssert(equal(old,d),'decision collision');return {commitId:this.load<string>('decision-commit',d.decisionId)!};}
      fhAssert(this.load('replay-checkpoint',d.checkpointId),'decision checkpoint missing');
      const epoch=this.db.query('SELECT offset FROM fh_epoch WHERE epoch=?').get(streamCanonical(d.raw.epoch)) as SqlRow|null;fhAssert(epoch&&Number(epoch.offset)>=d.raw.end,'decision exceeds durable raw');
      for(const c of d.coverage){if(c.kind==='rows'){
        fhAssert(equal(c.range.pane,r.pane),'decision coverage pane');const count=Number((this.db.query('SELECT COUNT(*) AS n FROM fh_row_id WHERE pane=? AND segment=? AND ordinal>=? AND ordinal<?').get(key,c.range.segmentId,c.range.start,c.range.end) as SqlRow).n);fhAssert(count===c.range.end-c.range.start,'decision coverage not durable');
      }else fhAssert(equal(c.gap.pane,r.pane),'decision gap pane');}
      this.save('decision',d.decisionId,key,d);this.save('decision-commit',d.decisionId,key,r.operationId);this.save('decision-head',key,key,r.operationId);return {commitId:r.operationId};
    }));
  }
  async reclaimR2(r:OperationFence&{sealed:SealedExport;remote:RemoteIndexR2;inventory:ArchiveInventoryR2}):Promise<Result<ReclaimReceipt>> {
    try{
      this.tx('remote-authority',()=>{
        this.fence(r);this.unpinned(r.sealed.segmentId);
        fhAssert(archiveInventoryMatches(r.sealed,r.remote.verified.bundle,r.inventory),'archive inventory mismatch');
        fhAssert(r.remote.repair.revision===2&&r.remote.repair.sealCommitId===r.sealed.sealCommitId&&r.remote.repair.sealGeneration===r.sealed.generation&&r.remote.repair.authorizationGeneration===r.expectedGeneration&&r.remote.repair.inventoryDigest===archiveInventoryDigest(r.inventory),'remote repair identity');
        fhAssert(this.options.catalogAuthority,'remote catalog authority required');const durable=this.value(this.options.catalogAuthority.remote(r.remote.commitId));fhAssert(durable&&equal(durable,r.remote),'remote catalog receipt absent/mismatch');
        this.save('remote-inventory',r.remote.commitId,paneKey(r.pane),r.inventory);
      });
      return this.reclaimVerified({...r,remote:r.remote});
    }catch(e){return fail(e);}
  }

  private physical(): {allocated:number;free:number;block:number} {
    let allocated = 0;
    for (const suffix of ['', '-wal','-shm']) { const p = join(this.root,'flag-on-v1.sqlite'+suffix); if (existsSync(p)) allocated += statSync(p).blocks*512; }
    const list = this.db.query("SELECT sealed FROM fh_segment WHERE sealed IS NOT NULL AND state!='remote'").all() as SqlRow[];
    for (const s of list) { const seal = JSON.parse(String(s.sealed)) as SealedExport; for (const f of [...seal.files,seal.manifest]) if (existsSync(f.path)) allocated += statSync(f.path).blocks*512; }
    const lockPath = join(this.root,'flag-on-writer.sqlite'); if (existsSync(lockPath)) allocated += statSync(lockPath).blocks*512;
    const fs = statfsSync(this.root); return {allocated,free:fs.bfree,block:fs.bsize};
  }
}
