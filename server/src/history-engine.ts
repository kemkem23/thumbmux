/** Opt-in stream-first history store. Owns a dedicated DB, never a legacy DB.
 * WAL/FULL transactions are the durable acknowledgement boundary. No database
 * or timer is created until the explicit constructor is called.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { STREAM_BUDGET as B, eventKey, validReadOpen, streamCanonical, streamDigest } from './stream-contract';
import type { AppendFinalized, CancelToken, CheckpointCommit, DurableInputReceipt, DurableReceipt,
  FinalizedRow, GapEpisode, HistoryEngine, HistoryPage, HistoryPageCheckpoint, InputEvent, PaneKey, PageCursor,
  RamReceipt, ReadOpenAck, ReadRequest, ReadView, RecoveryChunk, RepairChunk, RepairReceipt,
  Result, RowContent, RowFragment, StreamFailure, StreamIdentity, VtCheckpoint } from './stream-contract';

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
  private readRow(db: Database, pane: PaneKey, line: number): FinalizedRow {
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
