/**
 * Durability and scope of the recall store, measured from outside it (W5-D).
 *
 * `recall-handler.test.ts` already proves what one process can prove: a reopen
 * in the same process keeps its rows, a batch is all-or-nothing, a re-seen
 * prompt does not duplicate. Three claims it cannot reach are the ones this
 * file is for.
 *
 *  - **An end that is not a close.** Every in-process durability test unwinds
 *    politely, and `close()` is the one call a crash never makes. So the write
 *    happens in a child that SIGKILLs its own pid the instant the store has
 *    acknowledged it, and the claim is checked by reopening the file the corpse
 *    left behind. Nothing outside the child's own process is signalled: no
 *    service, no tmux server, no sibling test.
 *
 *  - **A fault inside the transaction.** The store has no fault hook and must
 *    not grow one for a test's convenience — that would be a contract change
 *    paid for by a test. The fault therefore comes from below: a child patches
 *    `bun:sqlite`'s `Database.prototype` before importing the artifact, so the
 *    build under test is the shipped one and the broken thing is the driver it
 *    sits on. See `fixtures/menu345-recall-child.ts`.
 *
 *  - **What a consumer that never opts in has to carry.** The promise is that
 *    it carries nothing: `thumbmux/server` is the WebSocket engine and must not
 *    drag a database in behind it. That is checked twice over — statically
 *    against the shipped module graph, and dynamically by a child that imports
 *    the barrel, does real work through it, and reports every statement that
 *    reached SQLite (none).
 *
 * Scope, stated plainly so a green run is not read as more than it is: these
 * are **process-level** faults — SIGKILL with no unwinding, and a throw inside
 * the ingest transaction. A host-wide power cut is not reproduced here and is
 * not claimed; what stands in for it is `synchronous = FULL` plus the fact that
 * the reopened file below is recovered from a WAL the writer never checkpointed.
 *
 * Everything talks to `git-dist/` — the built artifact, byte-identical to what
 * the `-dist` tag installs — and never to `server/src`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const GIT_DIST_SERVER = join(PACKAGE_ROOT, 'git-dist', 'server');
const SERVER_BARREL = join(GIT_DIST_SERVER, 'index.js');
const RECALL_ARTIFACT = join(GIT_DIST_SERVER, 'recall-handler.js');
const CHILD = join(import.meta.dir, 'fixtures', 'menu345-recall-child.ts');

/** Tables that belong to the host's brain.db and must never appear in here. */
const HOST_TABLES = ['session_instances', 'session_prompts', 'managed_sessions', 'topics'];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'thumbmux-menu345-recall-'));
  roots.push(root);
  return root;
}

type ChildResult = {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
};

async function runChild(mode: string, payload: unknown): Promise<ChildResult> {
  const proc = Bun.spawn([process.execPath, CHILD, mode, JSON.stringify(payload)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr };
}

/** Run a mode that is expected to finish and print one JSON line. */
async function runChildJson<T>(mode: string, payload: unknown): Promise<T> {
  const result = await runChild(mode, payload);
  if (result.exitCode !== 0) {
    throw new Error(`child ${mode} exited ${result.exitCode}/${result.signalCode}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as T;
}

type ReopenReport = {
  notes: Record<string, { note: string; noteUpdatedAt: string | null } | null>;
  prompts: Record<string, string[]>;
  rows: {
    notes: number;
    prompts: number;
    lifecycles: string[];
    tables: string[];
    userVersion: number;
  };
};

/**
 * Every module specifier reachable from `entry` by a *static* import, following
 * relative edges only. A lazy `require()` inside a function body is not an
 * edge: it cannot run unless a caller asks for it, which is the whole
 * distinction this file is measuring.
 */
function staticImportGraph(entry: string): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.includes(file)) continue;
    files.push(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n'"]*?from\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifiers.includes(specifier)) specifiers.push(specifier);
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
    for (const match of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifiers.includes(specifier)) specifiers.push(specifier);
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
  }
  return { files, specifiers };
}

describe('the built artifact under test', () => {
  test('git-dist ships the recall subpath, and it is what the fixtures import', async () => {
    // A missing build must fail here rather than turn every claim below into a
    // skipped test that reads as green. `bun run build:git-dist` is the fix.
    expect(existsSync(RECALL_ARTIFACT)).toBe(true);
    expect(existsSync(SERVER_BARREL)).toBe(true);

    const recall = await import(`${pathToFileURL(RECALL_ARTIFACT).href}?menu345-surface`);
    expect(typeof recall.createRecallHandler).toBe('function');
    expect(recall.RECALL_SCHEMA_VERSION).toBe(1);

    // The subpath a consumer resolves points at a build output, never at
    // `src/`. A test that reached source would be green about code nobody gets.
    const exports = (await import(`${pathToFileURL(join(PACKAGE_ROOT, 'package.json')).href}`)).default
      .exports as Record<string, { import?: string }>;
    expect(exports['./server/recall']?.import).toBe('./server/dist/recall-handler.js');
    expect(exports['./server']?.import).toBe('./server/dist/index.js');

    // In the repo that subpath resolves to `server/dist`; in the installed
    // `-dist` package `prepare-release-package.ts` remaps it to `git-dist`.
    // These tests import `git-dist`, so the two builds being the same bytes is
    // what makes their result a statement about what a consumer runs.
    expect(readFileSync(join(PACKAGE_ROOT, 'server', 'dist', 'recall-handler.js'))).toEqual(
      readFileSync(RECALL_ARTIFACT),
    );
    expect(readFileSync(join(PACKAGE_ROOT, 'scripts', 'prepare-release-package.ts'), 'utf8'))
      .toContain('import: "./git-dist/server/recall-handler.js"');
  });
});

describe('a consumer that does not opt in carries no database', () => {
  test('nothing statically reachable from the server barrel imports a SQLite driver', () => {
    const barrel = staticImportGraph(SERVER_BARREL);

    expect(barrel.specifiers).not.toContain('bun:sqlite');
    expect(barrel.specifiers).not.toContain('node:sqlite');
    expect(barrel.files.map((f) => f.replace(`${PACKAGE_ROOT}/`, ''))).not.toContain(
      'git-dist/server/recall-handler.js',
    );

    // Verify the instrument before trusting its silence: the same walk over the
    // recall subpath must *find* the driver. If this assertion ever fails, the
    // one above is measuring its own blind spot rather than the barrel.
    const recall = staticImportGraph(RECALL_ARTIFACT);
    expect(recall.specifiers).toContain('bun:sqlite');
  });

  test('importing the barrel and using it opens no database and runs no statement', async () => {
    const root = tempRoot();
    const scratch = join(root, 'state');
    const report = await runChildJson<{
      sql: string[];
      files: string[];
      exports: string[];
      prefsBefore: unknown;
      prefsAfter: unknown;
      scratchContents: string[];
    }>('no-database-consumer', { scratch, tag: 'no-db' });

    // The observer is installed before the barrel import, so these two being
    // empty is a statement about the whole import plus the work that followed.
    expect(report.sql).toEqual([]);
    expect(report.files).toEqual([]);

    // …and the work really happened, so this is not "no database because
    // nothing ran". Prefs are durable state without a database.
    expect(report.prefsBefore).toEqual({});
    expect(report.prefsAfter).toEqual({ fontScale: 1.25 });
    expect(report.scratchContents).toEqual(['prefs.json']);

    // The barrel cannot even hand a consumer the opt-in, by design.
    expect(report.exports).not.toContain('createRecallHandler');
    expect(report.exports).not.toContain('RECALL_SCHEMA_VERSION');
    expect(report.exports).toContain('createPrefsHandler');
  });
});

describe('an opt-in consumer gets its own tables and nothing else', () => {
  test('the store creates only notes and prompts, and names no host table', async () => {
    const root = tempRoot();
    const file = join(root, 'state', 'recall.db');
    const reportPath = join(root, 'ack.json');
    const owners = { 'menu345-alpha': 'menu345-lifecycle-alpha' };

    const crashed = await runChild('write-ack-sigkill', {
      file,
      owners,
      note: 'synthetic note for scope check',
      prompts: ['synthetic scope prompt one', 'synthetic scope prompt two'],
      report: reportPath,
      tag: 'scope',
    });
    expect(crashed.signalCode).toBe('SIGKILL');

    const ack = JSON.parse(readFileSync(reportPath, 'utf8')) as { sql: string[]; files: string[] };
    // Every statement the store issued, recorded by the driver rather than by
    // the store. A host table appearing here would mean the package had reached
    // into brain.db; the decision behind C01/C02 is that it never does.
    const observed = ack.sql.join('\n');
    for (const table of HOST_TABLES) expect(observed).not.toContain(table);
    expect(observed).toContain('CREATE TABLE IF NOT EXISTS notes');
    expect(observed).toContain('CREATE TABLE IF NOT EXISTS prompts');

    // One file, the one the caller named. Not brain.db, not a second store.
    expect(ack.files).toEqual([file]);

    const report = await runChildJson<ReopenReport>('reopen-report', { file, owners, tag: 'scope-read' });
    expect(report.rows.tables).toEqual(['notes', 'prompts']);
    expect(report.rows.userVersion).toBe(1);
  });
});

describe('a write that was acknowledged survives an abnormal end', () => {
  test('SIGKILL with no close, then reopen, keeps the note and the prompts', async () => {
    const root = tempRoot();
    const file = join(root, 'state', 'recall.db');
    const reportPath = join(root, 'ack.json');
    const owners = { 'menu345-crash': 'menu345-lifecycle-crash' };
    const prompts = [
      'synthetic crash prompt one',
      'synthetic crash prompt two\nwith a second line',
      'ข้อความสังเคราะห์ภาษาไทย',
    ];

    const crashed = await runChild('write-ack-sigkill', {
      file,
      owners,
      note: 'synthetic note acknowledged before the kill',
      prompts,
      report: reportPath,
      tag: 'crash',
    });

    // An abnormal end, not a tidy exit: no exit code at all, only a signal.
    expect(crashed.exitCode).toBe(null);
    expect(crashed.signalCode).toBe('SIGKILL');

    const ack = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      acks: Record<string, unknown>;
    };
    expect(ack.acks['ingest:menu345-crash']).toBe(prompts.length);
    expect(ack.acks['note:menu345-crash']).toMatchObject({
      lifecycleId: 'menu345-lifecycle-crash',
      note: 'synthetic note acknowledged before the kill',
    });

    // The writer never checkpointed, so the rows are still in the WAL. This is
    // the part a graceful close would have hidden.
    expect(existsSync(`${file}-wal`)).toBe(true);

    const report = await runChildJson<ReopenReport>('reopen-report', { file, owners, tag: 'crash-read' });
    expect(report.prompts['menu345-crash']).toEqual(prompts);
    expect(report.notes['menu345-crash']).toMatchObject({
      note: 'synthetic note acknowledged before the kill',
    });
    expect(report.rows).toMatchObject({
      notes: 1,
      prompts: prompts.length,
      lifecycles: ['menu345-lifecycle-crash'],
      userVersion: 1,
    });
  });

  test('a fault inside the ingest transaction leaves the previous state, not half a batch', async () => {
    const root = tempRoot();
    const file = join(root, 'state', 'recall.db');
    const owners = { 'menu345-fault': 'menu345-lifecycle-fault' };
    const firstBatch = ['synthetic committed one', 'synthetic committed two'];
    const secondBatch = ['synthetic doomed one', 'synthetic doomed two', 'synthetic doomed three'];

    const faulted = await runChildJson<{
      committed: number;
      thrown: string | null;
      sqlDuringFaultedIngest: string[];
    }>('fault-during-transaction', { file, owners, firstBatch, secondBatch, tag: 'fault' });

    expect(faulted.committed).toBe(firstBatch.length);
    expect(faulted.thrown).toBe('MENU345_OBSERVER_FAULT');

    // The fault has to land *mid*-transaction for the claim to mean anything:
    // inside BEGIN, after every upsert of the doomed batch was applied, and
    // before the statement that would have completed it. SQLite's own ROLLBACK
    // is then the last thing the driver sees.
    const steps = faulted.sqlDuringFaultedIngest;
    expect(steps[0]).toBe('BEGIN');
    expect(steps.at(-1)).toBe('ROLLBACK');
    expect(steps.filter((s) => s.includes('INSERT INTO prompts'))).toHaveLength(secondBatch.length);
    expect(steps.filter((s) => s.includes('COMMIT'))).toHaveLength(0);

    const report = await runChildJson<ReopenReport>('reopen-report', { file, owners, tag: 'fault-read' });
    expect(report.prompts['menu345-fault']).toEqual(firstBatch);
    expect(report.rows.prompts).toBe(firstBatch.length);
    for (const doomed of secondBatch) {
      expect(report.prompts['menu345-fault']).not.toContain(doomed);
    }
  });
});

describe('running the same thing again', () => {
  test('a second identical run rewrites every lifecycle and adds no row', async () => {
    const root = tempRoot();
    const file = join(root, 'state', 'recall.db');
    const owners = {
      'menu345-repeat-a': 'menu345-lifecycle-repeat-a',
      'menu345-repeat-b': 'menu345-lifecycle-repeat-b',
    };
    const prompts = ['synthetic repeat one', 'synthetic repeat two'];

    const runs: ReopenReport[] = [];
    for (const pass of ['first', 'second']) {
      const crashed = await runChild('write-ack-sigkill', {
        file,
        owners,
        note: `synthetic note from the ${pass} pass`,
        prompts,
        report: join(root, `ack-${pass}.json`),
        tag: `repeat-${pass}`,
      });
      expect(crashed.signalCode).toBe('SIGKILL');
      runs.push(await runChildJson<ReopenReport>('reopen-report', {
        file,
        owners,
        tag: `repeat-${pass}-read`,
      }));
    }

    const [first, second] = runs as [ReopenReport, ReopenReport];

    // No row growth, and no lifecycle dropped out of the file on the way.
    expect(second.rows.prompts).toBe(first.rows.prompts);
    expect(second.rows.notes).toBe(first.rows.notes);
    expect(second.rows.prompts).toBe(prompts.length * Object.keys(owners).length);
    expect(second.rows.notes).toBe(Object.keys(owners).length);
    expect(second.rows.lifecycles).toEqual(first.rows.lifecycles);
    expect(second.rows.lifecycles).toEqual([
      'menu345-lifecycle-repeat-a',
      'menu345-lifecycle-repeat-b',
    ]);

    // Equal counts could also mean the second pass skipped the work entirely.
    // The note proves it did not: every lifecycle was written again, in place.
    for (const session of Object.keys(owners)) {
      expect(first.notes[session]).toMatchObject({ note: 'synthetic note from the first pass' });
      expect(second.notes[session]).toMatchObject({ note: 'synthetic note from the second pass' });
      expect(second.prompts[session]).toEqual(prompts);
    }
  });
});
