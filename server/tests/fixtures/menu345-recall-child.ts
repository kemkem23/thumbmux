/**
 * Child process for the recall durability and scope checks (W5-D).
 *
 * Two things can only be observed from a *separate* process, and this file
 * exists for exactly those two:
 *
 *  1. **An abnormal end.** `close()` is the graceful path, and a test that
 *     calls it proves nothing about a process that never gets to. The only
 *     honest way to skip it is to let a process die where it stands, and a
 *     process can only do that to itself — so `write-ack-sigkill` SIGKILLs its
 *     own pid after the store has acknowledged the write. Nothing outside this
 *     process tree is signalled.
 *
 *  2. **A fault inside the ingest transaction.** The store deliberately has no
 *     fault hook: adding one would be a change to its contract for the benefit
 *     of a test. So the fault comes from an observer that sits *under* the
 *     store instead of inside it — `bun:sqlite`'s own `Database.prototype` is
 *     patched before the artifact is imported, which means the store is the
 *     unmodified shipped build and the injection point is the database driver
 *     it happens to use. Because the patch lives in a throwaway child, nothing
 *     it does can leak into a sibling test file sharing the runner's process.
 *
 * Everything here talks to the **built artifact** (`git-dist/`), never to
 * `server/src`, so a green result describes what a consumer installs.
 *
 * Invocation: `bun menu345-recall-child.ts <mode> <json-payload>`
 */
import { Database, type Statement } from 'bun:sqlite';
import { closeSync, fsyncSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Thrown by the observer, never by the store. Recognisable on sight in a log. */
export const OBSERVER_FAULT_MESSAGE = 'MENU345_OBSERVER_FAULT';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..', '..');
const RECALL_ARTIFACT = join(PACKAGE_ROOT, 'git-dist', 'server', 'recall-handler.js');
const SERVER_BARREL = join(PACKAGE_ROOT, 'git-dist', 'server', 'index.js');

type SqlObserver = {
  /** Every statement this process asked SQLite to execute, in order. */
  readonly sql: string[];
  /** Every database file this process opened through a patched method. */
  readonly files: string[];
  /** Arm the fault. Before this, the observer only watches. */
  arm(): void;
};

/**
 * Watch — and optionally break — every statement that reaches `bun:sqlite`.
 *
 * `db.run`/`db.exec` are prototype methods, but a prepared statement's `run`
 * is an own property of the statement object, so the wrap has to happen where
 * statements are handed out (`query`/`prepare`) rather than on a shared
 * prototype. Without that half, the ingest upserts would be invisible and the
 * "the fault landed mid-transaction" claim would rest on nothing.
 */
function installSqlObserver(faultOn?: RegExp): SqlObserver {
  const sql: string[] = [];
  const files: string[] = [];
  const wrapped = new WeakSet<object>();
  let armed = false;

  const record = (text: string): void => {
    sql.push(text);
    if (armed && faultOn?.test(text)) throw new Error(OBSERVER_FAULT_MESSAGE);
  };

  const noteFile = (db: Database): void => {
    const name = (db as unknown as { filename?: string }).filename;
    if (typeof name === 'string' && !files.includes(name)) files.push(name);
  };

  const proto = Database.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['run', 'exec'] as const) {
    const original = proto[method]!;
    proto[method] = function (this: Database, ...args: unknown[]) {
      noteFile(this);
      record(String(args[0]));
      return original.apply(this, args);
    };
  }

  for (const method of ['query', 'prepare'] as const) {
    const original = proto[method]!;
    proto[method] = function (this: Database, ...args: unknown[]) {
      noteFile(this);
      const text = String(args[0]);
      const statement = original.apply(this, args) as Statement;
      // `query()` memoises, so the same statement object comes back for the
      // same text; wrapping it twice would double every row in the log.
      if (statement && typeof statement === 'object' && !wrapped.has(statement)) {
        wrapped.add(statement);
        for (const call of ['run', 'get', 'all', 'values'] as const) {
          const inner = (statement as unknown as Record<string, unknown>)[call];
          if (typeof inner !== 'function') continue;
          (statement as unknown as Record<string, unknown>)[call] = function (...inner_args: unknown[]) {
            record(text);
            return (inner as (...a: unknown[]) => unknown).apply(statement, inner_args);
          };
        }
      }
      return statement;
    };
  }

  return {
    sql,
    files,
    arm() { armed = true; },
  };
}

/** Load the shipped recall module. A cache-buster keeps repeat modes honest. */
async function loadRecallArtifact(tag: string) {
  return (await import(`${pathToFileURL(RECALL_ARTIFACT).href}?menu345=${tag}`)) as {
    createRecallHandler: (opts: {
      file: string;
      resolveSession: (session: string) => { lifecycleId: string } | null;
      keepPromptsPerSession?: number;
      now?: () => string;
    }) => {
      writeNote(session: string, note: string): Promise<unknown>;
      readNote(session: string): Promise<{ note: string; noteUpdatedAt: string | null } | null>;
      readPrompts(session: string, options?: { limit?: number }): Promise<{ prompts: string[] } | null>;
      ingest(batch: { session: string; prompts: string[] }): Promise<number>;
      close(): void;
    };
  };
}

/**
 * The host's identity model in one line: a name maps to the lifecycle the
 * payload says owns it, and an unknown name fails closed exactly as
 * `hostSessionResolver` does.
 */
function resolverFor(owners: Record<string, string>) {
  return (session: string) => {
    const lifecycleId = owners[session];
    return lifecycleId ? { lifecycleId } : null;
  };
}

/** Durable stdout. A SIGKILL one statement later must not be able to eat it. */
function emitDurable(path: string, payload: unknown): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, `${JSON.stringify(payload)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(root, full));
    }
  };
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch { /* never created anything: that is the answer the caller wants */ }
  return found.sort();
}

type Payload = {
  /** SQLite file the store owns. Always under the caller's temp root. */
  file?: string;
  /** session name → lifecycle id, the answer the host resolver would give. */
  owners?: Record<string, string>;
  note?: string;
  prompts?: string[];
  firstBatch?: string[];
  secondBatch?: string[];
  /** Where a mode that is about to die writes its result. */
  report?: string;
  /** Scratch directory for the no-database mode. */
  scratch?: string;
  /** Distinguishes one run of an otherwise identical payload from the next. */
  tag?: string;
};

const mode = process.argv[2] ?? '';
const payload = JSON.parse(process.argv[3] ?? '{}') as Payload;
const owners = payload.owners ?? {};
const tag = payload.tag ?? 'run';

if (mode === 'write-ack-sigkill') {
  // Write, wait for the store to acknowledge, publish the acknowledgement, and
  // then stop existing — no close(), no flush, no unwind.
  const observer = installSqlObserver();
  const { createRecallHandler } = await loadRecallArtifact(tag);
  const handler = createRecallHandler({ file: payload.file!, resolveSession: resolverFor(owners) });
  const acks: Record<string, unknown> = {};
  for (const [session] of Object.entries(owners)) {
    acks[`note:${session}`] = await handler.writeNote(session, payload.note ?? '');
    acks[`ingest:${session}`] = await handler.ingest({ session, prompts: payload.prompts ?? [] });
  }
  emitDurable(payload.report!, { mode, pid: process.pid, acks, sql: observer.sql, files: observer.files });
  process.kill(process.pid, 'SIGKILL');
  // Unreachable. If the signal ever failed to land, the caller's assertion on
  // the exit signal is what catches it, not a comment.
  await new Promise(() => {});
}

if (mode === 'fault-during-transaction') {
  // The first batch commits normally; the observer is armed only afterwards so
  // the store opens, migrates and writes without interference, and the fault
  // lands in the middle of the *second* ingest transaction — after its upserts
  // have been applied and before the prune that would have ended it.
  const observer = installSqlObserver(/DELETE\s+FROM\s+prompts/i);
  const { createRecallHandler } = await loadRecallArtifact(tag);
  const handler = createRecallHandler({ file: payload.file!, resolveSession: resolverFor(owners) });
  const session = Object.keys(owners)[0]!;
  const committed = await handler.ingest({ session, prompts: payload.firstBatch ?? [] });
  const sqlBeforeArming = observer.sql.length;
  observer.arm();
  let thrown: string | null = null;
  try {
    await handler.ingest({ session, prompts: payload.secondBatch ?? [] });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  // Leave the file as the fault left it: the caller reopens it from scratch.
  process.stdout.write(`${JSON.stringify({
    mode,
    committed,
    thrown,
    sqlDuringFaultedIngest: observer.sql.slice(sqlBeforeArming),
    files: observer.files,
  })}\n`);
  process.exit(0);
}

if (mode === 'reopen-report') {
  // Reopen the file the dead process left behind, through the same artifact a
  // consumer installs, and report what is in it.
  const observer = installSqlObserver();
  const { createRecallHandler } = await loadRecallArtifact(tag);
  const handler = createRecallHandler({ file: payload.file!, resolveSession: resolverFor(owners) });
  const notes: Record<string, unknown> = {};
  const prompts: Record<string, string[]> = {};
  for (const session of Object.keys(owners)) {
    notes[session] = await handler.readNote(session);
    prompts[session] = (await handler.readPrompts(session, { limit: 100 }))?.prompts ?? [];
  }
  // Counted with raw SQL on a second connection rather than through the store,
  // so the number is not the store's own opinion of itself.
  const audit = new Database(payload.file!, { readonly: true });
  const rows = {
    notes: (audit.query('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c,
    prompts: (audit.query('SELECT COUNT(*) AS c FROM prompts').get() as { c: number }).c,
    lifecycles: (audit
      .query('SELECT DISTINCT lifecycle_id AS id FROM prompts ORDER BY id')
      .all() as { id: string }[]).map((r) => r.id),
    tables: (audit
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name),
    userVersion: (audit.query('PRAGMA user_version').get() as { user_version: number }).user_version,
  };
  audit.close();
  handler.close();
  process.stdout.write(`${JSON.stringify({ mode, notes, prompts, rows, sql: observer.sql })}\n`);
  process.exit(0);
}

if (mode === 'no-database-consumer') {
  // A consumer that never opts in imports the server barrel and nothing else.
  // The observer is installed first, so any database this import opens — or any
  // statement it runs — is recorded before the barrel gets a chance.
  const observer = installSqlObserver();
  const scratch = payload.scratch!;
  const barrel = (await import(`${pathToFileURL(SERVER_BARREL).href}?menu345=${tag}`)) as Record<string, unknown>;
  // Do real work through the barrel, so "no database" is a statement about a
  // consumer that uses the package rather than one that only imports it.
  const prefs = (barrel.createPrefsHandler as (o: { file: string }) => (r: Request) => Promise<Response>)(
    { file: join(scratch, 'prefs.json') },
  );
  const before = await (await prefs(new Request('http://fixture.invalid/api/prefs'))).json();
  const after = await (await prefs(new Request('http://fixture.invalid/api/prefs', {
    method: 'PUT',
    body: JSON.stringify({ fontScale: 1.25 }),
  }))).json();
  process.stdout.write(`${JSON.stringify({
    mode,
    sql: observer.sql,
    files: observer.files,
    exports: Object.keys(barrel).sort(),
    prefsBefore: before,
    prefsAfter: after,
    scratchContents: listFiles(scratch),
  })}\n`);
  process.exit(0);
}

process.stderr.write(`menu345-recall-child: unknown mode ${JSON.stringify(mode)}\n`);
process.exit(64);
