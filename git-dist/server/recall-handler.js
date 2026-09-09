import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/recall-handler.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var RECALL_SCHEMA_VERSION = 1;
var DEFAULT_KEEP_PROMPTS = 100;
var DEFAULT_MIN_PROMPT_LENGTH = 3;
var DEFAULT_BUSY_TIMEOUT_MS = 5000;

class RecallSchemaVersionError extends Error {
  found;
  supported;
  constructor(found, supported) {
    super(`thumbmux recall database is at schema version ${found}, ` + `this build supports ${supported}; refusing to open it`);
    this.name = "RecallSchemaVersionError";
    this.found = found;
    this.supported = supported;
  }
}
function hashPrompt(text) {
  return Bun.hash(text).toString(36);
}
function openDatabase(file, busyTimeoutMs) {
  if (file !== ":memory:") {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {}
  }
  const db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  const [row] = db.query("PRAGMA user_version").all();
  const version = row?.user_version ?? 0;
  if (version > RECALL_SCHEMA_VERSION) {
    db.close();
    throw new RecallSchemaVersionError(version, RECALL_SCHEMA_VERSION);
  }
  if (version < RECALL_SCHEMA_VERSION) {
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
      db.run("CREATE INDEX IF NOT EXISTS prompts_recent ON prompts(lifecycle_id, seq DESC)");
      db.run(`PRAGMA user_version = ${RECALL_SCHEMA_VERSION}`);
    })();
  }
  return db;
}
function createRecallHandler(opts) {
  const keep = Math.max(1, Math.trunc(opts.keepPromptsPerSession ?? DEFAULT_KEEP_PROMPTS));
  const minLength = Math.max(1, Math.trunc(opts.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH));
  const now = opts.now ?? (() => new Date().toISOString());
  const db = openDatabase(opts.file, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  async function scope(session, expected) {
    if (typeof session !== "string" || session.length === 0)
      return null;
    const identity = await opts.resolveSession(session);
    if (!identity || typeof identity.lifecycleId !== "string" || !identity.lifecycleId)
      return null;
    if (expected !== undefined && identity.lifecycleId !== expected)
      return null;
    return identity.lifecycleId;
  }
  function noteRow(lifecycleId) {
    return db.query("SELECT note, updated_at FROM notes WHERE lifecycle_id = ?").get(lifecycleId) ?? null;
  }
  async function readNote(session, expected) {
    const lifecycleId = await scope(session, expected);
    if (!lifecycleId)
      return null;
    const row = noteRow(lifecycleId);
    return {
      session,
      lifecycleId,
      note: row?.note ?? "",
      noteUpdatedAt: row?.updated_at ?? null
    };
  }
  async function writeNote(session, note, expected) {
    const lifecycleId = await scope(session, expected);
    if (!lifecycleId)
      return null;
    const text = typeof note === "string" ? note : "";
    const stamp = now();
    db.run(`INSERT INTO notes (lifecycle_id, note, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(lifecycle_id)
         DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`, [lifecycleId, text, stamp]);
    return { session, lifecycleId, note: text, noteUpdatedAt: stamp };
  }
  async function readPrompts(session, options = {}) {
    const lifecycleId = await scope(session, options.expectedLifecycleId);
    if (!lifecycleId)
      return null;
    const requested = options.limit;
    const limit = Math.max(1, Math.min(keep, Number.isFinite(requested) ? Math.trunc(requested) : keep));
    const rows = db.query("SELECT prompt_text FROM prompts WHERE lifecycle_id = ? ORDER BY seq DESC LIMIT ?").all(lifecycleId, limit);
    return { session, lifecycleId, prompts: rows.map((r) => r.prompt_text).reverse() };
  }
  const upsertPrompt = db.query(`INSERT INTO prompts
       (lifecycle_id, prompt_hash, prompt_text, seq, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lifecycle_id, prompt_hash)
       DO UPDATE SET seq = excluded.seq,
                     prompt_text = excluded.prompt_text,
                     updated_at = excluded.updated_at`);
  const ingestTransaction = db.transaction((lifecycleId, texts, stamp) => {
    const base = db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM prompts WHERE lifecycle_id = ?").get(lifecycleId);
    let seq = base?.m ?? 0;
    for (const text of texts) {
      seq += 1;
      upsertPrompt.run(lifecycleId, hashPrompt(text), text, seq, stamp, stamp);
    }
    db.run(`DELETE FROM prompts
          WHERE lifecycle_id = ?1
            AND prompt_hash NOT IN (
              SELECT prompt_hash FROM prompts
               WHERE lifecycle_id = ?1
               ORDER BY seq DESC
               LIMIT ?2
            )`, [lifecycleId, keep]);
    return texts.length;
  });
  async function ingest(batch) {
    const cleaned = (batch.prompts ?? []).filter((text) => typeof text === "string").map((text) => text.trim()).filter((text) => text.length >= minLength);
    if (cleaned.length === 0)
      return 0;
    const lifecycleId = await scope(batch.session, batch.expectedLifecycleId);
    if (!lifecycleId)
      return 0;
    return ingestTransaction(lifecycleId, cleaned, now());
  }
  function json(body, status = 200) {
    return Response.json(body, { status });
  }
  async function handle(request) {
    const { pathname, searchParams } = new URL(request.url);
    const segments = pathname.split("/").filter((part) => part.length > 0);
    const resource = segments.at(-1);
    const rawSession = segments.at(-2);
    if (resource !== "note" && resource !== "prompts" || !rawSession) {
      return json({ error: "not found" }, 404);
    }
    const session = decodeURIComponent(rawSession);
    const expected = searchParams.get("instance_id") ?? undefined;
    if (resource === "prompts") {
      if (request.method !== "GET")
        return json({ error: "method not allowed" }, 405);
      const limitParam = searchParams.get("limit");
      const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
      const found = await readPrompts(session, { limit, expectedLifecycleId: expected });
      if (!found)
        return json({ error: "unresolved session lifecycle" }, 409);
      return json({
        session_name: found.session,
        instanceId: found.lifecycleId,
        prompts: found.prompts
      });
    }
    if (request.method === "GET") {
      const found = await readNote(session, expected);
      if (!found)
        return json({ error: "unresolved session lifecycle" }, 409);
      return json({
        session_name: found.session,
        instanceId: found.lifecycleId,
        note: found.note,
        noteUpdatedAt: found.noteUpdatedAt
      });
    }
    if (request.method === "PUT" || request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json({ error: "note body must be a JSON object" }, 400);
      }
      const value = payload.note;
      if (typeof value !== "string") {
        return json({ error: "note must be a string" }, 400);
      }
      const saved = await writeNote(session, value, expected);
      if (!saved)
        return json({ error: "unresolved session lifecycle" }, 409);
      return json({
        ok: true,
        session_name: saved.session,
        instanceId: saved.lifecycleId,
        note: saved.note,
        noteUpdatedAt: saved.noteUpdatedAt
      });
    }
    return json({ error: "method not allowed" }, 405);
  }
  return {
    handle,
    readNote,
    writeNote,
    readPrompts,
    ingest,
    close() {
      db.close();
    }
  };
}
export {
  createRecallHandler,
  RecallSchemaVersionError,
  RECALL_SCHEMA_VERSION,
  DEFAULT_MIN_PROMPT_LENGTH,
  DEFAULT_KEEP_PROMPTS,
  DEFAULT_BUSY_TIMEOUT_MS
};
