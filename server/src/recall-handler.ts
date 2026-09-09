/**
 * createRecallHandler — durable per-session memory: one note, and the recent
 * prompts someone actually submitted.
 *
 * ## Why this is not preferences
 *
 * `createPrefsHandler` is one JSON document for one trusted tenant, and that
 * is the right shape for a font size. It is the wrong shape for these two.
 * A note belongs to *one occupant of one tmux name*, not to the viewer, and
 * recent prompts need an ordered, deduplicated, pruned recall of the last N —
 * which over a JSON bag means hand-writing an index, a monotonic counter, a
 * prune, and a torn-write story. SQLite has all four, and on Bun it is a
 * built-in module: this file adds **zero** runtime dependencies.
 *
 * That is also why it is not exported from the `@thumbmux/server` barrel. A
 * host that only wants the WebSocket engine must not start loading a database
 * driver because it imported the package root; this module is reachable only
 * as `thumbmux/server/recall`.
 *
 * ## Identity is the lifecycle, not the name
 *
 * tmux names get recycled, and a note from the previous occupant of a name is
 * worse than no note — it reads as current. So every read and write resolves
 * the name through the host's `resolveSession`, which is the only thing that
 * knows whether this name is still the same conversation. Callers that
 * snapshotted an identity before a slow capture pass it back as an assertion:
 * a mismatch discards the result rather than writing it to either lifecycle.
 * An `instance_id` arriving from a client is treated the same way — an
 * assertion to check, never an identity to trust.
 *
 * This is not authentication. A host authorizes the request before calling in,
 * exactly as `createPrefsHandler` documents.
 *
 * ## Durability
 *
 * WAL, `synchronous=FULL`, a bounded busy timeout, and every ingest — upsert,
 * sequence, prune — inside one transaction, so a success means the rows are on
 * disk and a crash mid-batch leaves the previous state, not half a batch. The
 * schema is created and stamped inside a transaction; a file written by a
 * newer schema is refused rather than opened and overwritten.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Schema version stamped in `PRAGMA user_version`. */
export const RECALL_SCHEMA_VERSION = 1;

/** Most recent distinct prompts kept per lifecycle. */
export const DEFAULT_KEEP_PROMPTS = 100;

/** Shorter submissions are noise (a bare "y", a stray keystroke) and are dropped. */
export const DEFAULT_MIN_PROMPT_LENGTH = 3;

/** Milliseconds a statement waits on a locked database before failing. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** What the host knows about a name that this store does not. */
export type RecallSessionIdentity = {
  /** Stable id for this occupant of the name. A new spawn is a new id. */
  lifecycleId: string;
};

export type RecallHandlerOptions = {
  /** SQLite file. Created (with its parent) on first write. */
  file: string;
  /**
   * Resolve a tmux name to the lifecycle that currently owns it, or null when
   * the name is unknown, ended, or ambiguous. Failing closed is the point.
   */
  resolveSession: (
    session: string,
  ) => Promise<RecallSessionIdentity | null> | RecallSessionIdentity | null;
  /** Prompts retained per lifecycle. Default 100. */
  keepPromptsPerSession?: number;
  /** Minimum trimmed length for a prompt to be stored. Default 3. */
  minPromptLength?: number;
  /** Busy timeout in ms. Default 5000. */
  busyTimeoutMs?: number;
  /** Clock, for tests and for hosts that stamp their own time source. */
  now?: () => string;
};

export type RecallNote = {
  session: string;
  lifecycleId: string;
  note: string;
  /** ISO timestamp of the last write, or null when the note was never set. */
  noteUpdatedAt: string | null;
};

export type RecallPrompts = {
  session: string;
  lifecycleId: string;
  /** Oldest → newest, the order a live pane scan produces. */
  prompts: string[];
};

export type RecallIngestBatch = {
  session: string;
  /** Oldest → newest. Re-seen text bumps recency instead of duplicating. */
  prompts: string[];
  /**
   * The lifecycle the caller resolved before it started capturing. When given
   * and the name has moved on since, the batch is discarded.
   */
  expectedLifecycleId?: string;
};

export type RecallHandler = {
  /**
   * Route a request whose path ends in `/note` or `/prompts`, with the session
   * name as the preceding segment — i.e. exactly the shape a host already
   * mounts at `/api/sessions/:name/note` and `/api/sessions/:name/prompts`.
   * The prefix in front of that is not inspected, so a host is free to mount
   * this anywhere.
   */
  handle(request: Request): Promise<Response>;
  readNote(session: string, expectedLifecycleId?: string): Promise<RecallNote | null>;
  writeNote(
    session: string,
    note: string,
    expectedLifecycleId?: string,
  ): Promise<RecallNote | null>;
  readPrompts(
    session: string,
    options?: { limit?: number; expectedLifecycleId?: string },
  ): Promise<RecallPrompts | null>;
  /** Returns rows written, or 0 when the batch was empty or the name had moved on. */
  ingest(batch: RecallIngestBatch): Promise<number>;
  close(): void;
};

/** Thrown when the file on disk was written by a schema this build cannot read. */
export class RecallSchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(
      `thumbmux recall database is at schema version ${found}, `
      + `this build supports ${supported}; refusing to open it`,
    );
    this.name = 'RecallSchemaVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Dedup key. Deliberately the same formula kemcortex's `session_prompts` has
 * used (wyhash-64, base-36) so an import can carry existing hashes across
 * unchanged instead of recomputing a table that is already correct.
 * Not a security hash and never used as one.
 */
function hashPrompt(text: string): string {
  return Bun.hash(text).toString(36);
}

function openDatabase(file: string, busyTimeoutMs: number): Database {
  // Same courtesy createPrefsHandler extends: a host names a path under its
  // own state directory and does not have to have created it first.
  if (file !== ':memory:') {
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* exists, or SQLite will report it */ }
  }
  const db = new Database(file, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  // A prompt this store acknowledged must survive the power going out, which
  // WAL's default (NORMAL) does not promise. These tables are tiny and written
  // once per capture pass; the fsync is affordable and the guarantee is not.
  db.run('PRAGMA synchronous = FULL');
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);

  const [row] = db.query<{ user_version: number }, []>('PRAGMA user_version').all();
  const version = row?.user_version ?? 0;
  if (version > RECALL_SCHEMA_VERSION) {
    db.close();
    throw new RecallSchemaVersionError(version, RECALL_SCHEMA_VERSION);
  }

  if (version < RECALL_SCHEMA_VERSION) {
    // Create and stamp together: a crash between the two would leave tables
    // that claim version 0 and get re-created on the next open.
    db.transaction(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS notes (
          lifecycle_id TEXT PRIMARY KEY,
          note         TEXT NOT NULL DEFAULT '',
          updated_at   TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS prompts (
          lifecycle_id  TEXT NOT NULL,
          prompt_hash   TEXT NOT NULL,
          prompt_text   TEXT NOT NULL,
          seq           INTEGER NOT NULL,
          first_seen_at TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          PRIMARY KEY (lifecycle_id, prompt_hash)
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS prompts_recent ON prompts(lifecycle_id, seq DESC)');
      db.run(`PRAGMA user_version = ${RECALL_SCHEMA_VERSION}`);
    })();
  }

  return db;
}

export function createRecallHandler(opts: RecallHandlerOptions): RecallHandler {
  const keep = Math.max(1, Math.trunc(opts.keepPromptsPerSession ?? DEFAULT_KEEP_PROMPTS));
  const minLength = Math.max(1, Math.trunc(opts.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH));
  const now = opts.now ?? (() => new Date().toISOString());
  const db = openDatabase(opts.file, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);

  /**
   * The one gate every path goes through. `expected` is an assertion about a
   * lifecycle the caller already saw, not a way to name a different one.
   */
  async function scope(session: string, expected?: string): Promise<string | null> {
    if (typeof session !== 'string' || session.length === 0) return null;
    const identity = await opts.resolveSession(session);
    if (!identity || typeof identity.lifecycleId !== 'string' || !identity.lifecycleId) return null;
    if (expected !== undefined && identity.lifecycleId !== expected) return null;
    return identity.lifecycleId;
  }

  function noteRow(lifecycleId: string): { note: string; updated_at: string } | null {
    return db
      .query<{ note: string; updated_at: string }, [string]>(
        'SELECT note, updated_at FROM notes WHERE lifecycle_id = ?',
      )
      .get(lifecycleId) ?? null;
  }

  async function readNote(session: string, expected?: string): Promise<RecallNote | null> {
    const lifecycleId = await scope(session, expected);
    if (!lifecycleId) return null;
    const row = noteRow(lifecycleId);
    return {
      session,
      lifecycleId,
      note: row?.note ?? '',
      noteUpdatedAt: row?.updated_at ?? null,
    };
  }

  async function writeNote(
    session: string,
    note: string,
    expected?: string,
  ): Promise<RecallNote | null> {
    const lifecycleId = await scope(session, expected);
    if (!lifecycleId) return null;
    const text = typeof note === 'string' ? note : '';
    const stamp = now();
    db.run(
      `INSERT INTO notes (lifecycle_id, note, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(lifecycle_id)
         DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      [lifecycleId, text, stamp],
    );
    return { session, lifecycleId, note: text, noteUpdatedAt: stamp };
  }

  async function readPrompts(
    session: string,
    options: { limit?: number; expectedLifecycleId?: string } = {},
  ): Promise<RecallPrompts | null> {
    const lifecycleId = await scope(session, options.expectedLifecycleId);
    if (!lifecycleId) return null;
    const requested = options.limit;
    const limit = Math.max(
      1,
      Math.min(keep, Number.isFinite(requested) ? Math.trunc(requested as number) : keep),
    );
    const rows = db
      .query<{ prompt_text: string }, [string, number]>(
        'SELECT prompt_text FROM prompts WHERE lifecycle_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(lifecycleId, limit);
    // Read newest-first so LIMIT keeps the newest, then hand back oldest-first
    // — the order a live pane scan produces, which callers already assume.
    return { session, lifecycleId, prompts: rows.map((r) => r.prompt_text).reverse() };
  }

  const upsertPrompt = db.query(
    `INSERT INTO prompts
       (lifecycle_id, prompt_hash, prompt_text, seq, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lifecycle_id, prompt_hash)
       DO UPDATE SET seq = excluded.seq,
                     prompt_text = excluded.prompt_text,
                     updated_at = excluded.updated_at`,
  );

  const ingestTransaction = db.transaction(
    (lifecycleId: string, texts: string[], stamp: string) => {
      const base = db
        .query<{ m: number }, [string]>(
          'SELECT COALESCE(MAX(seq), 0) AS m FROM prompts WHERE lifecycle_id = ?',
        )
        .get(lifecycleId);
      let seq = base?.m ?? 0;
      for (const text of texts) {
        seq += 1;
        upsertPrompt.run(lifecycleId, hashPrompt(text), text, seq, stamp, stamp);
      }
      // Prune this lifecycle only: a recycled name must not evict the previous
      // occupant's history, and a resurrection keeps pruning the same scope.
      db.run(
        `DELETE FROM prompts
          WHERE lifecycle_id = ?1
            AND prompt_hash NOT IN (
              SELECT prompt_hash FROM prompts
               WHERE lifecycle_id = ?1
               ORDER BY seq DESC
               LIMIT ?2
            )`,
        [lifecycleId, keep],
      );
      return texts.length;
    },
  );

  async function ingest(batch: RecallIngestBatch): Promise<number> {
    const cleaned = (batch.prompts ?? [])
      .filter((text): text is string => typeof text === 'string')
      .map((text) => text.trim())
      .filter((text) => text.length >= minLength);
    if (cleaned.length === 0) return 0;
    const lifecycleId = await scope(batch.session, batch.expectedLifecycleId);
    if (!lifecycleId) return 0;
    return ingestTransaction(lifecycleId, cleaned, now());
  }

  function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const segments = pathname.split('/').filter((part) => part.length > 0);
    const resource = segments.at(-1);
    const rawSession = segments.at(-2);
    if ((resource !== 'note' && resource !== 'prompts') || !rawSession) {
      return json({ error: 'not found' }, 404);
    }
    const session = decodeURIComponent(rawSession);
    // A client-supplied instance id is an assertion the resolver must agree
    // with, never a lookup key. Named the same as the host route's parameter
    // so an existing UI adapter needs no change.
    const expected = searchParams.get('instance_id') ?? undefined;

    if (resource === 'prompts') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const limitParam = searchParams.get('limit');
      const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
      const found = await readPrompts(session, { limit, expectedLifecycleId: expected });
      if (!found) return json({ error: 'unresolved session lifecycle' }, 409);
      return json({
        session_name: found.session,
        instanceId: found.lifecycleId,
        prompts: found.prompts,
      });
    }

    if (request.method === 'GET') {
      const found = await readNote(session, expected);
      if (!found) return json({ error: 'unresolved session lifecycle' }, 409);
      return json({
        session_name: found.session,
        instanceId: found.lifecycleId,
        note: found.note,
        noteUpdatedAt: found.noteUpdatedAt,
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return json({ error: 'note body must be a JSON object' }, 400);
      }
      const value = (payload as { note?: unknown }).note;
      if (typeof value !== 'string') {
        return json({ error: 'note must be a string' }, 400);
      }
      const saved = await writeNote(session, value, expected);
      if (!saved) return json({ error: 'unresolved session lifecycle' }, 409);
      return json({
        ok: true,
        session_name: saved.session,
        instanceId: saved.lifecycleId,
        note: saved.note,
        noteUpdatedAt: saved.noteUpdatedAt,
      });
    }

    return json({ error: 'method not allowed' }, 405);
  }

  return {
    handle,
    readNote,
    writeNote,
    readPrompts,
    ingest,
    close() {
      db.close();
    },
  };
}
