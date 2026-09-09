/**
 * Every test here uses a real SQLite file on disk, not `:memory:`. The claims
 * worth making about this module — a write survives the process that made it,
 * a batch is all-or-nothing, a newer schema is refused — are claims about a
 * file, and an in-memory database cannot fail any of them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_KEEP_PROMPTS,
  RECALL_SCHEMA_VERSION,
  RecallSchemaVersionError,
  createRecallHandler,
  type RecallHandler,
  type RecallSessionIdentity,
} from '../src/recall-handler';

const roots: string[] = [];
const open: RecallHandler[] = [];

afterEach(() => {
  for (const handler of open.splice(0)) {
    try { handler.close(); } catch { /* already closed by the test */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempFile(name = 'recall.db'): string {
  const root = mkdtempSync(join(tmpdir(), 'thumbmux-recall-'));
  roots.push(root);
  return join(root, 'nested', 'state', name);
}

/** A resolver whose answers a test can change mid-flight, like a real host's. */
function fakeHost(initial: Record<string, string | null> = {}) {
  const names = new Map<string, string | null>(Object.entries(initial));
  let calls = 0;
  return {
    names,
    get calls() { return calls; },
    resolveSession(session: string): RecallSessionIdentity | null {
      calls++;
      const lifecycleId = names.get(session);
      return lifecycleId ? { lifecycleId } : null;
    },
  };
}

function makeHandler(
  file: string,
  host: ReturnType<typeof fakeHost>,
  extra: Partial<Parameters<typeof createRecallHandler>[0]> = {},
): RecallHandler {
  const handler = createRecallHandler({
    file,
    resolveSession: (session) => host.resolveSession(session),
    ...extra,
  });
  open.push(handler);
  return handler;
}

describe('schema', () => {
  test('creates the file, its parent directories, and stamps the version', () => {
    const file = tempFile();
    const host = fakeHost({ 'cc-a': 'life-1' });
    const handler = makeHandler(file, host);
    // A note write is what forces the file to exist with content.
    return handler.writeNote('cc-a', 'hello').then(() => {
      handler.close();
      open.pop();
      expect(existsSync(file)).toBe(true);
      const raw = new Database(file, { readonly: true });
      const [row] = raw.query<{ user_version: number }, []>('PRAGMA user_version').all();
      expect(row?.user_version).toBe(RECALL_SCHEMA_VERSION);
      const tables = raw
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain('notes');
      expect(tables).toContain('prompts');
      raw.close();
    });
  });

  test('refuses a file written by a newer schema instead of overwriting it', () => {
    const file = tempFile();
    const host = fakeHost({ 'cc-a': 'life-1' });
    makeHandler(file, host).close();
    open.pop();

    const raw = new Database(file);
    raw.run(`PRAGMA user_version = ${RECALL_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => makeHandler(file, host)).toThrow(RecallSchemaVersionError);
    // And the file is still readable at its own version — nothing was reset.
    const after = new Database(file, { readonly: true });
    const [row] = after.query<{ user_version: number }, []>('PRAGMA user_version').all();
    expect(row?.user_version).toBe(RECALL_SCHEMA_VERSION + 1);
    after.close();
  });

  test('reopening an existing file keeps its rows', async () => {
    const file = tempFile();
    const host = fakeHost({ 'cc-a': 'life-1' });

    const first = makeHandler(file, host);
    await first.writeNote('cc-a', 'survives');
    await first.ingest({ session: 'cc-a', prompts: ['first prompt'] });
    first.close();
    open.pop();

    const second = makeHandler(file, host);
    expect((await second.readNote('cc-a'))?.note).toBe('survives');
    expect((await second.readPrompts('cc-a'))?.prompts).toEqual(['first prompt']);
  });
});

describe('notes', () => {
  test('an unwritten note reads as empty with no timestamp', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    expect(await handler.readNote('cc-a')).toEqual({
      session: 'cc-a',
      lifecycleId: 'life-1',
      note: '',
      noteUpdatedAt: null,
    });
  });

  test('write then read, with the timestamp the write reported', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }), {
      now: () => '2026-09-09T03:00:00.000Z',
    });
    const saved = await handler.writeNote('cc-a', 'ทดสอบ note ภาษาไทย');
    expect(saved).toEqual({
      session: 'cc-a',
      lifecycleId: 'life-1',
      note: 'ทดสอบ note ภาษาไทย',
      noteUpdatedAt: '2026-09-09T03:00:00.000Z',
    });
    expect(await handler.readNote('cc-a')).toEqual(saved!);
  });

  test('a second write replaces the note rather than appending a row', async () => {
    const file = tempFile();
    const handler = makeHandler(file, fakeHost({ 'cc-a': 'life-1' }));
    await handler.writeNote('cc-a', 'one');
    await handler.writeNote('cc-a', 'two');
    expect((await handler.readNote('cc-a'))?.note).toBe('two');
    handler.close();
    open.pop();
    const raw = new Database(file, { readonly: true });
    expect(raw.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM notes').get()?.c).toBe(1);
    raw.close();
  });

  test('a new occupant of the same name starts with a clean note', async () => {
    const host = fakeHost({ 'cc-a': 'life-1' });
    const handler = makeHandler(tempFile(), host);
    await handler.writeNote('cc-a', 'belongs to the first run');

    host.names.set('cc-a', 'life-2');
    expect(await handler.readNote('cc-a')).toEqual({
      session: 'cc-a',
      lifecycleId: 'life-2',
      note: '',
      noteUpdatedAt: null,
    });

    // The first lifecycle's note is untouched, not overwritten.
    host.names.set('cc-a', 'life-1');
    expect((await handler.readNote('cc-a'))?.note).toBe('belongs to the first run');
  });

  test('an unresolvable name reads and writes nothing', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    expect(await handler.readNote('ghost')).toBeNull();
    expect(await handler.writeNote('ghost', 'nope')).toBeNull();
    expect(await handler.readNote('')).toBeNull();
  });

  test('a stale expected lifecycle is refused on both read and write', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-2' }));
    expect(await handler.readNote('cc-a', 'life-1')).toBeNull();
    expect(await handler.writeNote('cc-a', 'stale', 'life-1')).toBeNull();
    expect((await handler.readNote('cc-a'))?.note).toBe('');
  });
});

describe('prompts', () => {
  test('stores oldest to newest and reads back in the same order', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.ingest({ session: 'cc-a', prompts: ['alpha one', 'beta two', 'gamma three'] });
    expect((await handler.readPrompts('cc-a'))?.prompts)
      .toEqual(['alpha one', 'beta two', 'gamma three']);
  });

  test('trims, and drops anything shorter than the minimum', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    const written = await handler.ingest({
      session: 'cc-a',
      prompts: ['  padded  ', 'y', '  ', 'ok', 'yes'],
    });
    expect(written).toBe(2);
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual(['padded', 'yes']);
  });

  test('a re-seen prompt bumps recency instead of duplicating', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.ingest({ session: 'cc-a', prompts: ['first one', 'second one'] });
    await handler.ingest({ session: 'cc-a', prompts: ['first one'] });
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual(['second one', 'first one']);
  });

  test('re-running the same batch is idempotent', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    const batch = ['alpha one', 'beta two'];
    await handler.ingest({ session: 'cc-a', prompts: batch });
    await handler.ingest({ session: 'cc-a', prompts: batch });
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual(batch);
  });

  test('keeps the newest N and prunes the rest', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }), {
      keepPromptsPerSession: 5,
    });
    await handler.ingest({
      session: 'cc-a',
      prompts: Array.from({ length: 12 }, (_, i) => `prompt number ${i}`),
    });
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual([
      'prompt number 7',
      'prompt number 8',
      'prompt number 9',
      'prompt number 10',
      'prompt number 11',
    ]);
  });

  test('the default retention is 100 and a read cannot ask for more', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.ingest({
      session: 'cc-a',
      prompts: Array.from({ length: DEFAULT_KEEP_PROMPTS + 20 }, (_, i) => `prompt ${i}`),
    });
    const all = await handler.readPrompts('cc-a', { limit: 10_000 });
    expect(all?.prompts).toHaveLength(DEFAULT_KEEP_PROMPTS);
    expect(all?.prompts.at(-1)).toBe(`prompt ${DEFAULT_KEEP_PROMPTS + 19}`);
  });

  test('a limit returns the newest ones, still oldest-first', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.ingest({ session: 'cc-a', prompts: ['one x', 'two x', 'three x', 'four x'] });
    expect((await handler.readPrompts('cc-a', { limit: 2 }))?.prompts)
      .toEqual(['three x', 'four x']);
    expect((await handler.readPrompts('cc-a', { limit: 0 }))?.prompts).toHaveLength(1);
    expect((await handler.readPrompts('cc-a', { limit: Number.NaN }))?.prompts).toHaveLength(4);
  });

  test('pruning one lifecycle never evicts another', async () => {
    const host = fakeHost({ 'cc-a': 'life-1' });
    const handler = makeHandler(tempFile(), host, { keepPromptsPerSession: 2 });
    await handler.ingest({ session: 'cc-a', prompts: ['keep me one', 'keep me two'] });

    host.names.set('cc-a', 'life-2');
    await handler.ingest({ session: 'cc-a', prompts: ['newer one', 'newer two', 'newer three'] });
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual(['newer two', 'newer three']);

    host.names.set('cc-a', 'life-1');
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual(['keep me one', 'keep me two']);
  });

  test('a scan that finished after the name was reused is discarded', async () => {
    const host = fakeHost({ 'cc-a': 'life-1' });
    const handler = makeHandler(tempFile(), host);
    // Snapshot life-1, then the name is recycled while the capture runs.
    host.names.set('cc-a', 'life-2');
    const written = await handler.ingest({
      session: 'cc-a',
      prompts: ['from the previous occupant'],
      expectedLifecycleId: 'life-1',
    });
    expect(written).toBe(0);
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual([]);
    host.names.set('cc-a', 'life-1');
    expect((await handler.readPrompts('cc-a'))?.prompts).toEqual([]);
  });

  test('an empty or all-noise batch never even resolves the session', async () => {
    const host = fakeHost({ 'cc-a': 'life-1' });
    const handler = makeHandler(tempFile(), host);
    const before = host.calls;
    expect(await handler.ingest({ session: 'cc-a', prompts: [] })).toBe(0);
    expect(await handler.ingest({ session: 'cc-a', prompts: ['y', ' '] })).toBe(0);
    expect(host.calls).toBe(before);
  });

  test('an unresolvable name stores nothing and reads null', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    expect(await handler.ingest({ session: 'ghost', prompts: ['something real'] })).toBe(0);
    expect(await handler.readPrompts('ghost')).toBeNull();
  });

  test('multi-line and Thai prompts survive a reopen byte for byte', async () => {
    const file = tempFile();
    const host = fakeHost({ 'cc-a': 'life-1' });
    const text = 'บรรทัดแรก\nบรรทัดที่สอง\tมี tab';
    const first = makeHandler(file, host);
    await first.ingest({ session: 'cc-a', prompts: [text] });
    first.close();
    open.pop();
    expect((await makeHandler(file, host).readPrompts('cc-a'))?.prompts).toEqual([text]);
  });
});

describe('handle()', () => {
  const base = 'http://host.invalid/api/sessions';

  test('GET note returns the wire shape the existing UI adapters read', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }), {
      now: () => '2026-09-09T03:00:00.000Z',
    });
    await handler.writeNote('cc-a', 'noted');
    const res = await handler.handle(new Request(`${base}/cc-a/note`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_name: 'cc-a',
      instanceId: 'life-1',
      note: 'noted',
      noteUpdatedAt: '2026-09-09T03:00:00.000Z',
    });
  });

  test('PUT note saves and echoes back', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }), {
      now: () => '2026-09-09T03:00:00.000Z',
    });
    const res = await handler.handle(new Request(`${base}/cc-a/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: 'via the route' }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session_name: 'cc-a',
      instanceId: 'life-1',
      note: 'via the route',
      noteUpdatedAt: '2026-09-09T03:00:00.000Z',
    });
    expect((await handler.readNote('cc-a'))?.note).toBe('via the route');
  });

  test('GET prompts returns oldest-first and honours ?limit=', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.ingest({ session: 'cc-a', prompts: ['one x', 'two x', 'three x'] });
    const res = await handler.handle(new Request(`${base}/cc-a/prompts?limit=2`));
    expect(await res.json()).toEqual({
      session_name: 'cc-a',
      instanceId: 'life-1',
      prompts: ['two x', 'three x'],
    });
  });

  test('a URL-encoded session name is decoded before it is resolved', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc a/b': 'life-1' }));
    await handler.writeNote('cc a/b', 'encoded');
    const res = await handler.handle(new Request(`${base}/${encodeURIComponent('cc a/b')}/note`));
    expect((await res.json()).note).toBe('encoded');
  });

  test('?instance_id= is an assertion, not a lookup key', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-2' }));
    await handler.writeNote('cc-a', 'current occupant');

    const agreeing = await handler.handle(
      new Request(`${base}/cc-a/note?instance_id=life-2`),
    );
    expect(agreeing.status).toBe(200);

    // Naming somebody else's lifecycle does not read their note.
    const claiming = await handler.handle(
      new Request(`${base}/cc-a/note?instance_id=life-1`),
    );
    expect(claiming.status).toBe(409);
    expect((await claiming.json()).error).toBe('unresolved session lifecycle');
  });

  test('an unresolvable session is 409 on every verb, and writes nothing', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    for (const request of [
      new Request(`${base}/ghost/note`),
      new Request(`${base}/ghost/prompts`),
      new Request(`${base}/ghost/note`, { method: 'PUT', body: '{"note":"x"}' }),
    ]) {
      expect((await handler.handle(request)).status).toBe(409);
    }
  });

  test('a malformed note body is rejected before it reaches the database', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.writeNote('cc-a', 'unchanged');
    for (const body of ['not json', '[]', '{"note":42}', '{}']) {
      const res = await handler.handle(
        new Request(`${base}/cc-a/note`, { method: 'PUT', body }),
      );
      expect(res.status).toBe(400);
    }
    expect((await handler.readNote('cc-a'))?.note).toBe('unchanged');
  });

  test('wrong verbs and unknown resources are refused', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    expect((await handler.handle(
      new Request(`${base}/cc-a/prompts`, { method: 'PUT', body: '{}' }),
    )).status).toBe(405);
    expect((await handler.handle(
      new Request(`${base}/cc-a/note`, { method: 'DELETE' }),
    )).status).toBe(405);
    expect((await handler.handle(new Request(`${base}/cc-a/summary`))).status).toBe(404);
    expect((await handler.handle(new Request('http://host.invalid/note'))).status).toBe(404);
  });

  test('the mount prefix is not inspected — a host may mount it anywhere', async () => {
    const handler = makeHandler(tempFile(), fakeHost({ 'cc-a': 'life-1' }));
    await handler.writeNote('cc-a', 'anywhere');
    const res = await handler.handle(
      new Request('http://host.invalid/deep/custom/mount/cc-a/note'),
    );
    expect((await res.json()).note).toBe('anywhere');
  });
});
