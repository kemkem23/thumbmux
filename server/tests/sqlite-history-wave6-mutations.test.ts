/**
 * Wave 6 mutation proof, same standard as waves 2-5.
 *
 * Every mutant lives in a throwaway copy of the package: the working tree is
 * never edited. The string a mutant edits must exist before it is edited, a
 * mutant counts as killed only when a real `bun:test` run reports `(fail)`,
 * a death caused by a SyntaxError, ParseError or missing module is rejected,
 * a round that ran zero tests is rejected, and the clean tree must pass before
 * the first mutant and after the last one with the same test count.
 */
import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mutant = { name: string; pattern: string; file: string; from: string; to: string };

test('wave6 expansion-tooling detectors kill every injected fault and the clean tree passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-wave6-mutants-'));
  const mutants: Mutant[] = [
    // --- the declared roster is the routing authority, not stray receipts ---
    { name: 'route-ignores-roster', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "    if (!this.declared.has(group)) return 'legacy';",
      to: "    if (false) return 'legacy';" },
    // --- every readiness item must refuse on its own ---
    { name: 'enable-accepts-no-sessions', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "    if (!evidence.expectedSessions.length) this.refuse(group, 'no-expected-sessions', 0);",
      to: "    if (false) this.refuse(group, 'no-expected-sessions', 0);" },
    { name: 'enable-accepts-no-source-paths', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "    if (!evidence.sourcePaths.length) this.refuse(group, 'no-source-paths', 0);",
      to: "    if (false) this.refuse(group, 'no-source-paths', 0);" },
    { name: 'enable-accepts-no-fault-probes', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "    if (!evidence.faultProbeIds.length) this.refuse(group, 'no-fault-probes', 0);",
      to: "    if (false) this.refuse(group, 'no-fault-probes', 0);" },
    { name: 'enable-skips-probe-readback', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "      if (!landed) this.refuse(group, 'fault-probe-unknown', issueId);",
      to: "      if (false) this.refuse(group, 'fault-probe-unknown', issueId);" },
    { name: 'enable-accepts-empty-source-count', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: "    if (!(recount > 0) || recount !== evidence.sourceCount) this.refuse(group, 'empty-or-stale-source-count', { claimed: evidence.sourceCount, stored: recount });",
      to: "    if (false) this.refuse(group, 'empty-or-stale-source-count', { claimed: evidence.sourceCount, stored: recount });" },
    { name: 'enable-skips-watermark', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: '      if (claimed.exportedRevision !== observed.exportedRevision || claimed.targetRevision !== revision) {',
      to: '      if (false) {' },
    // --- the gate reads the mirror and the roster itself at enable time ---
    { name: 'enable-trusts-evidence-watermark', pattern: 'allowlist', file: 'sqlite-history/rollout.ts',
      from: '      if (observed.exportedRevision !== revision) {',
      to: '      if (false) {' },
    { name: 'enable-ignores-missing-mirror', pattern: 'mirror itself', file: 'sqlite-history/rollout.ts',
      from: "    if (!existsSync(sessionMirror)) this.refuse(group, 'mirror-missing', { sessionId, directory: sessionMirror });",
      to: '    void sessionMirror;' },
    { name: 'enable-swallows-unreadable-mirror', pattern: 'mirror itself', file: 'sqlite-history/rollout.ts',
      from: "    catch (error) { this.refuse(group, 'mirror-unreadable', { sessionId, error: String(error) }); }",
      to: '    catch { return { exportedRevision: 0 }; }' },
    { name: 'enable-uses-evidence-roster', pattern: 'live group roster', file: 'sqlite-history/rollout.ts',
      from: '    const roster = this.rosterOf(group, evidence);',
      to: '    const roster = [...evidence.expectedSessions];' },
    { name: 'route-session-ignores-enrolment', pattern: 'per session', file: 'sqlite-history/rollout.ts',
      from: "    return enrolled.includes(sessionId) ? 'sqlite-authoritative' : 'legacy';",
      to: "    return enrolled.length ? 'sqlite-authoritative' : 'legacy';" },
    // --- retirement is opt-in behind the enabled allowlist, and it fences ---
    { name: 'retire-without-enabled-group', pattern: 'retirement', file: 'sqlite-history/rollout.ts',
      from: "    if (this.route(group) !== 'sqlite-authoritative') this.refuse(group, 'retire-requires-enabled-group', this.route(group));",
      to: "    if (false) this.refuse(group, 'retire-requires-enabled-group', this.route(group));" },
    { name: 'retired-writer-passes-through', pattern: 'retirement', file: 'sqlite-history/rollout.ts',
      from: '        if (this.retirements.has(group)) {',
      to: '        if (false) {' },
    { name: 'silence-skips-digest', pattern: 'retirement', file: 'sqlite-history/rollout.ts',
      from: '      if (observed.bytes !== recorded.bytes || observed.sha256 !== recorded.sha256) {',
      to: '      if (false) {' },
    // --- the restore drill must consult the independent oracle ---
    { name: 'drill-skips-jsonl-oracle', pattern: 'restore drill', file: 'sqlite-history/rollout.ts',
      from: "    compare(readSealedHistoryOracle(bundleDirectory, 'file-jsonl').rows, 'jsonl');",
      to: '    void 0;' },
    // --- an unknown source may never be counted preserved ---
    { name: 'audit-counts-unknown-as-preserved', pattern: 'backup coverage', file: 'sqlite-history/rollout.ts',
      from: "        : row.continuity === 'verified' && mirror.caughtUp && imports !== 'incomplete' ? 'preserved'",
      to: "        : mirror.caughtUp && imports !== 'incomplete' ? 'preserved'" },
    { name: 'audit-hides-storage-failure', pattern: 'backup coverage', file: 'sqlite-history/rollout.ts',
      from: "    try { store.audit(row.session_id); } catch { storage = 'failed'; }",
      to: '    try { store.audit(row.session_id); } catch { /* swallowed */ }' },
    // --- second half: every write walks the live per-session door ---
    { name: 'router-uses-group-route', pattern: 'write path', file: 'sqlite-history/rollout.ts',
      from: '    const route = this.allowlist.guardSession(batch.ticket.sessionId);',
      to: '    const route = this.allowlist.route(this.store.session(batch.ticket.sessionId).group_label);' },
    { name: 'guard-skips-missing-mirror', pattern: 'live guard', file: 'sqlite-history/rollout.ts',
      from: '    if (!existsSync(sessionMirror)) {',
      to: '    if (false) {' },
    { name: 'guard-swallows-unreadable', pattern: 'live guard', file: 'sqlite-history/rollout.ts',
      from: "      this.loseMirror(group, sessionId, 'mirror-unreadable', { error: String(error) });",
      to: "      return 'sqlite-authoritative';" },
    { name: 'expand-skips-drill', pattern: 'expansion batch', file: 'sqlite-history/rollout.ts',
      from: '      drills.push(await runRestoreDrill(bundle, scratch));',
      to: '      void bundle;' },
    { name: 'expand-keeps-enabled-on-drill-fail', pattern: 'expansion batch', file: 'sqlite-history/rollout.ts',
      from: '    allowlist.disableGroup(group);',
      to: '    void group;' },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave6.test.ts'), join(root, 'server/tests/sqlite-history-wave6.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const copiedCore = join(root, 'node_modules/@thumbmux/core'); mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '\n{"type":"module"}\n');
    const run = async (name: string, pattern?: string) => {
      const args = [process.execPath, 'test', './server/tests/sqlite-history-wave6.test.ts'];
      if (pattern) args.push('--test-name-pattern', pattern);
      const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      const ran = /Ran (\d+) tests?/.exec(output);
      const failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      console.log('WAVE6_MUTANT_RUN', JSON.stringify({ name, code, tests: Number(ran?.[1] ?? 0), failed }));
      if (code !== 0 && !failed) console.log('WAVE6_MUTANT_INVALID_OUTPUT', output.slice(-4000));
      return { code, output, tests: Number(ran?.[1] ?? 0), failed };
    };
    const before = await run('clean-before');
    expect(before.code).toBe(0);
    expect(before.tests).toBeGreaterThan(0);
    for (const mutant of mutants) {
      const path = join(root, 'server/src', mutant.file), original = readFileSync(path, 'utf8');
      // The point the mutant edits must exist before it is edited.
      expect(original.includes(mutant.from)).toBe(true);
      expect(mutant.from).not.toBe(mutant.to);
      writeFileSync(path, original.replace(mutant.from, mutant.to));
      const result = await run(mutant.name, mutant.pattern);
      writeFileSync(path, original);
      // A mutant that ran nothing has not been killed by anything.
      expect(result.tests).toBeGreaterThan(0);
      expect(result.code).not.toBe(0);
      // bun 1.3 prints "1 fail"; older reporters printed "(fail)". Either is a real test death.
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('WAVE6_MUTATION_RESULT', JSON.stringify({
      killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);

// NEWARCH2 D2: the archive schedule and boot receipt lookup, same standard as
// above, against the D2 tests of sqlite-history.test.ts in a throwaway copy.
test('D2 archive scheduling and receipt lookup mutants are each killed by a D2 test; the clean copy passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-d2-mutants-'));
  const store = 'sqlite-history/projection-store.ts';
  const mutants: Mutant[] = [
    // A futile scan is retried on every commit again (the 26f25ec83 cost).
    { name: 'scan-every-commit', pattern: 'D2:', file: store,
      from: '    if(due===null || now<due)continue;\n',
      to: '' },
    // A pane touched after a futile scan is never retried, however long ago the scan was.
    { name: 'no-age-retry', pattern: 'D2:', file: store,
      from: '  return entry.touched?entry.scannedAt+ARCHIVE_RETRY_MS:null;',
      to: '  return null;' },
    // NOT IN over a list holding NULL (an unchecked line) selects nothing: receipts never archive.
    { name: 'null-fk-in-list', pattern: 'D2:', file: store,
      from: ' AND l.checked_capture_id IS NOT NULL)',
      to: ')' },
    // One commit archives a whole backlog.
    { name: 'unbounded-chunks', pattern: 'D2:', file: store,
      from: '    if(!force && chunks>=chunkBudget)return {chunks,more:true};\n',
      to: '' },
    // Archive work leaves the commit transaction: it runs after the batch committed, in its own.
    { name: 'archive-outside-commit', pattern: 'D2:', file: store,
      from: '    plan=archiveCaptures(disk,marks,forceSeal,forceSeal?batch.panes.map(p=>Number(p.pane_no)):[],new Set(batch.panes.map(p=>Number(p.pane_no))),aged);\n    archiveMs=performance.now()-archiveStarted;\n    before?.();writeMs=performance.now()-started;\n  }).immediate();\n',
      to: '    before?.();writeMs=performance.now()-started;\n  }).immediate();\n  plan=disk.transaction(()=>archiveCaptures(disk,marks,forceSeal,forceSeal?batch.panes.map(p=>Number(p.pane_no)):[],new Set(batch.panes.map(p=>Number(p.pane_no))),aged)).immediate();\n' },
    // The schedule advances inside the transaction, so a rolled-back commit still moves it.
    { name: 'queue-before-commit', pattern: 'D2:', file: store,
      from: '    before?.();writeMs=performance.now()-started;\n  }).immediate();\n  if(plan)applyArchivePlan(disk,plan);',
      to: '    applyArchivePlan(disk,plan!);before?.();writeMs=performance.now()-started;\n  }).immediate();' },
    // Work a capped commit left queued waits for the next commit, however long ingest stays quiet.
    { name: 'no-idle-drain', pattern: 'D2:', file: store,
      from: '    if(!drainTimer && next!==null)drainTimer=setTimeout(drain,Math.max(ARCHIVE_IDLE_MS,next-archiveClock()));',
      to: '    void next;' },
    // Boot walks archives with their data blobs again.
    { name: 'boot-reads-every-data-blob', pattern: 'D2:', file: store,
      from: "'SELECT archive_no,catalog,capture_count FROM na_capture_archive WHERE pane_no=? AND archive_no<? ORDER BY archive_no DESC LIMIT 32'",
      to: "'SELECT archive_no,catalog,capture_count,data FROM na_capture_archive WHERE pane_no=? AND archive_no<? ORDER BY archive_no DESC LIMIT 32'" },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history.test.ts'), join(root, 'server/tests/sqlite-history.test.ts'));
    for (const helper of ['helpers.ts', 'crash-worker.ts']) cpSync(join(pkg, 'server/tests/sqlite-history', helper), join(root, 'server/tests/sqlite-history', helper));
    const copiedCore = join(root, 'node_modules/@thumbmux/core'); mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '\n{"type":"module"}\n');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', './server/tests/sqlite-history.test.ts', '--test-name-pattern', 'D2:'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err, ran = /Ran (\d+) tests?/.exec(output), failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      const killedBy = [...output.matchAll(/\(fail\) (D2:[^\[\n]*)/g)].map(m => m[1].trim().slice(0, 60));
      console.log('D2_MUTANT_RUN', JSON.stringify({ name, code, tests: Number(ran?.[1] ?? 0), failed, killedBy: [...new Set(killedBy)] }));
      if (code !== 0 && !failed) console.log('D2_MUTANT_INVALID_OUTPUT', output.slice(-4000));
      // A red clean copy is the harness's own failure: print why, or CI shows only the test name.
      if (code !== 0 && name.startsWith('clean')) console.log('D2_CLEAN_COPY_OUTPUT', output.slice(-4000));
      return { code, output, tests: Number(ran?.[1] ?? 0), failed };
    };
    const before = await run('clean-before');
    expect(before.code).toBe(0);
    expect(before.tests).toBe(8);
    for (const mutant of mutants) {
      const path = join(root, 'server/src', mutant.file), original = readFileSync(path, 'utf8');
      expect(original.includes(mutant.from)).toBe(true);
      expect(mutant.from).not.toBe(mutant.to);
      writeFileSync(path, original.replace(mutant.from, mutant.to));
      const result = await run(mutant.name);
      writeFileSync(path, original);
      expect(result.tests).toBeGreaterThan(0);
      expect(result.code).not.toBe(0);
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('D2_MUTATION_RESULT', JSON.stringify({ killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);

// NEWARCH-R2 D3: the tail seal and quiet archive, same standard as D2, against
// the D3 tests of sqlite-history.test.ts in a throwaway copy.
test('D3 tail seal and quiet archive mutants are each killed by a D3 test; the clean copy passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-d3-mutants-'));
  const store = 'sqlite-history/projection-store.ts';
  const mutants: Mutant[] = [
    // The flush barrier no longer seals the per-line tail (the pre-D3 layout: D/R 2.31 on the soak shape).
    { name: 'no-barrier-tail-seal', pattern: 'D3:', file: store,
      from: 'tail=force || quiet;', to: 'tail=quiet;' },
    // A pane that stood still keeps its per-line tail until the next barrier.
    { name: 'no-quiet-seal', pattern: 'D3:', file: store,
      from: 'tail=force || quiet;', to: 'tail=force;' },
    // A partial block is not counted toward its aligned range: the range never completes again.
    { name: 'no-partial-merge', pattern: 'D3:', file: store,
      from: 'const full=n+Number(part?.line_count??0)===SEAL_LINES;', to: 'const full=n===SEAL_LINES;' },
    // The tail seal takes a range with an unsettled line: a later certification rewrites a block.
    { name: 'tail-seals-unsettled', pattern: 'D3:', file: store,
      from: 'else if(!tail || Number(g.open)!==0)continue;', to: 'else if(!tail)continue;' },
    // Receipts freed by a quiet seal wait for a full chunk (ARCHIVE_MIN) as before D3.
    { name: 'quiet-archive-waits-for-chunk', pattern: 'D3:', file: store,
      from: '    if(liveReceipts(disk,paneNo)>ARCHIVE_KEEP)archivePane(disk,paneNo,true,Infinity);\n    plan.updates.set(paneNo,null);\n  }\n  const now',
      to: '    if(liveReceipts(disk,paneNo)>ARCHIVE_KEEP)archivePane(disk,paneNo,false,Infinity);\n    plan.updates.set(paneNo,null);\n  }\n  const now' },
    // The idle worker never seals a pane that went silent without another commit.
    { name: 'no-idle-quiet-sweep', pattern: 'D3:', file: store,
      from: "const quiet=[...heads?.entries()??[]].filter(([,head])=>!head.swept && now-head.since>=SEAL_QUIET_MS).map(([paneNo])=>paneNo);",
      to: 'const quiet:number[]=[];void heads;' },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history.test.ts'), join(root, 'server/tests/sqlite-history.test.ts'));
    for (const helper of ['helpers.ts', 'crash-worker.ts']) cpSync(join(pkg, 'server/tests/sqlite-history', helper), join(root, 'server/tests/sqlite-history', helper));
    const copiedCore = join(root, 'node_modules/@thumbmux/core'); mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '\n{"type":"module"}\n');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', './server/tests/sqlite-history.test.ts', '--test-name-pattern', 'D3:'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err, ran = /Ran (\d+) tests?/.exec(output), failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      const killedBy = [...output.matchAll(/\(fail\) (D3:[^\[\n]*)/g)].map(m => m[1].trim().slice(0, 60));
      console.log('D3_MUTANT_RUN', JSON.stringify({ name, code, tests: Number(ran?.[1] ?? 0), failed, killedBy: [...new Set(killedBy)] }));
      if (code !== 0 && !failed) console.log('D3_MUTANT_INVALID_OUTPUT', output.slice(-4000));
      // A red clean copy is the harness's own failure: print why, or CI shows only the test name.
      if (code !== 0 && name.startsWith('clean')) console.log('D3_CLEAN_COPY_OUTPUT', output.slice(-4000));
      return { code, output, tests: Number(ran?.[1] ?? 0), failed };
    };
    const before = await run('clean-before');
    expect(before.code).toBe(0);
    expect(before.tests).toBe(2);
    for (const mutant of mutants) {
      const path = join(root, 'server/src', mutant.file), original = readFileSync(path, 'utf8');
      expect(original.includes(mutant.from)).toBe(true);
      expect(mutant.from).not.toBe(mutant.to);
      writeFileSync(path, original.replace(mutant.from, mutant.to));
      const result = await run(mutant.name);
      writeFileSync(path, original);
      expect(result.tests).toBeGreaterThan(0);
      expect(result.code).not.toBe(0);
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('D3_MUTATION_RESULT', JSON.stringify({ killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);
