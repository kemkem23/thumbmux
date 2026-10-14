/**
 * Wave 4 mutation proof, same standard as waves 2 and 3.
 *
 * Every mutant lives in a throwaway copy of the package: the working tree is
 * never edited. A mutant counts as killed only when a real `bun:test` run
 * reports `(fail)` or bun 1.3's `N fail`; a death caused by a SyntaxError, a ParseError or a missing
 * module is rejected, because that proves nothing about the detector. The clean
 * tree is run before the first mutant and again after the last one.
 */
import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Keep child runners on the frozen suite's timeout contract, read once here.
const childTestTimeoutArgs = (() => {
  const suitePath = resolve(import.meta.dir, '../../../../ops/testing/thumbmux-suite.py');
  const invalid = (detail: string) => new Error(`M4 child test timeout contract (${suitePath}): ${detail}`);
  let source: string;
  try { source = readFileSync(suitePath, 'utf8'); }
  catch (error) { throw invalid(`cannot read suite source: ${String(error)}`); }
  const blocks = [...source.matchAll(/^def traced_command\([^\n]*\):[^\n]*\n[\s\S]*?(?=^def |$(?![\s\S]))/gm)];
  if (blocks.length !== 1) throw invalid(`expected one traced_command block, found ${blocks.length}`);
  const timeouts = [...blocks[0]![0].matchAll(/"test"\s*,\s*"--timeout"\s*,\s*"([0-9]+)"/g)];
  if (timeouts.length !== 1) throw invalid(`expected one decimal test timeout tuple, found ${timeouts.length}`);
  const value = timeouts[0]![1]!;
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw invalid(`timeout must be a positive safe integer, got ${value}`);
  }
  return ['--timeout', value] as const;
})();

type Mutant = { name: string; pattern: string; file: string; from: string; to: string };

test('wave4 reader detectors kill every injected fault and the clean tree passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-wave4-mutants-'));
  const mutants: Mutant[] = [
    // --- the served range vs. the committed digest ---
    { name: 'skip-range-digest', pattern: 'byte for byte', file: 'reader.ts',
      from: '    if (!rangeMatches) {', to: '    if (false) {' },
    { name: 'count-only-range', pattern: 'byte for byte', file: 'reader.ts',
      from: "      && slice.every((r, i) => r.line_no === rows[i]?.line_no && r.kind === rows[i]?.kind && r.text === rows[i]?.text);",
      to: ';' },
    { name: 'skip-batch-digest', pattern: 'a loud fault with a receipt', file: 'reader.ts',
      from: "      if (batch.length !== cover.expected_rows || rowsDigest(batch) !== cover.rows_sha256) {",
      to: '      if (false) {' },
    // --- coverage that cannot be certified must say so ---
    { name: 'floor-claims-verified', pattern: 'unverifiable, not verified', file: 'reader.ts',
      from: "      return { status: 'unverifiable', reason: 'range-below-verified-floor', coveringCaptures: [],",
      to: "      return { status: 'verified', coveringCaptures: [], verifiedRows: 0, digests: 0 } as ReaderVerification; return { status: 'unverifiable', reason: 'range-below-verified-floor', coveringCaptures: []," },
    { name: 'partial-coverage-claims-verified', pattern: 'past the newest receipt', file: 'reader.ts',
      from: '    if (cursor < end) {', to: '    if (false) {' },
    { name: 'empty-claims-verified', pattern: 'never as a bare', file: 'reader.ts',
      from: "        return { page, verification: { status: 'empty' as const,",
      to: "        return { page, verification: { status: 'verified' as const, verifiedRows: 0, digests: 0,\n          // @ts-expect-error mutant\n          reason: (direction === 'before' ? 'at-floor' : 'at-live-start') as ReaderEmptyReason, coveringCaptures: [] as [] } };\n        return { page, verification: { status: 'empty' as const," },
    // --- a failure must never be flattened into a success ---
    { name: 'rest-flattens-failure', pattern: 'never 200-with-empty', file: 'reader.ts',
      from: "    return json(message.includes('context-mismatch') ? 409 : 503, { error: message });",
      to: "    return json(200, { page: { context: null, rows: [], startLine: 0, endLine: 0, hasMore: false }, verification: { status: 'empty' }, error: message });" },
    { name: 'rest-conflict-becomes-200', pattern: 'never 200-with-empty', file: 'reader.ts',
      from: "message.includes('context-mismatch') ? 409 : 503", to: "message.includes('context-mismatch') ? 200 : 503" },
    // --- the pinned revision the viewer is reading from ---
    { name: 'accept-future-revision', pattern: 'refused, not silently re-anchored', file: 'store.ts',
      from: 'if(ctx.sessionId!==sid || ctx.revision>s.revision) throw new Error', to: 'if(ctx.sessionId!==sid) throw new Error' },
    { name: 'page-uses-live-boundary', pattern: 'refused, not silently re-anchored', file: 'store.ts',
      from: "const end=direction==='before'?Math.max(s.first_line,Math.min(anchor??ctx.liveStart,ctx.liveStart,ctx.nextLine)):",
      to: "const end=direction==='before'?Math.max(s.first_line,Math.min(anchor??s.live_start,s.live_start,s.next_line)):" },
    { name: 'force-has-more-false', pattern: 'no hole and no duplicate', file: 'store.ts',
      from: "hasMore:direction==='before'?start>s.first_line:end<ctx.liveStart", to: 'hasMore:false' },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    cpSync(join(pkg, 'core/src'), join(root, 'core/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const copiedCore = join(root, 'node_modules/@thumbmux/core'); mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '\n{"type":"module"}\n');
    const run = async (name: string, pattern?: string) => {
      const args = [process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts'];
      if (pattern) args.push('--test-name-pattern', pattern);
      const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      const ran = /Ran (\d+) tests?/.exec(output);
      // bun 1.3 prints "1 fail"; older reporters printed "(fail)". Either is a real test death.
      const failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      console.log('WAVE4_MUTANT_RUN', JSON.stringify({ name, code, tests: Number(ran?.[1] ?? 0), failed }));
      if (code !== 0 && !failed) console.log('WAVE4_MUTANT_INVALID_OUTPUT', output.slice(-4000));
      return { code, output, tests: Number(ran?.[1] ?? 0), failed };
    };
    const before = await run('clean-before');
    expect(before.code).toBe(0);
    expect(before.tests).toBeGreaterThan(0);
    for (const mutant of mutants) {
      const path = join(root, 'server/src/sqlite-history', mutant.file), original = readFileSync(path, 'utf8');
      // The point the mutant edits must exist before it is edited.
      expect(original.includes(mutant.from)).toBe(true);
      expect(mutant.from).not.toBe(mutant.to);
      writeFileSync(path, original.replace(mutant.from, mutant.to));
      const result = await run(mutant.name, mutant.pattern);
      writeFileSync(path, original);
      // A mutant that ran nothing has not been killed by anything.
      expect(result.tests).toBeGreaterThan(0);
      expect(result.code).not.toBe(0);
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    // These source-only mutants exercise the boundary guard, not module loading.
    // A real assertion failure is required, just as for the reader mutants.
    const importMutants = [
      ['ws-mux.ts', "import { HistoryStore } from './sqlite-history/store';"],
      ['app-routes.ts', "const history = import('./sqlite-history/store');"],
      ['nested/sqlite-history.ts', "export { HistoryStore } from '../sqlite-history/store';"],
    ];
    for (const [file, injected] of importMutants) {
      const path = join(root, 'server/src', file!);
      mkdirSync(resolve(path, '..'), { recursive: true });
      const original = (() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })();
      try {
        writeFileSync(path, `${original ?? ''}\n${injected}\n`);
        const result = await run(`unauthorized-import:${file}`, 'only explicit history entry points');
        expect(result.tests).toBeGreaterThan(0);
        expect(result.code).not.toBe(0);
        expect(result.failed).toBe(true);
        expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
      } finally {
        if (original === null) rmSync(path); else writeFileSync(path, original);
      }
    }
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('WAVE4_MUTATION_RESULT', JSON.stringify({
      killed: mutants.length + importMutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

// Stream mutations use a throwaway source tree exactly like the legacy probes.
// They must reach a failed assertion; a missing import never counts as a kill.
test('stream H mutants cannot acknowledge volatile data or falsify frozen reads', async () => {
  const pkg = resolve(import.meta.dir, '../..');
  const root = mkdtempSync(join(tmpdir(), 'stream-h-mutants-'));
  const mutations = [
    { name: 'omit-durable-rows', pattern: 'durable ACK survives reopen',
      from: '        this.flushRows(key);', to: '        // mutant: rows omitted from durable transaction' },
    { name: 'false-eof', pattern: 'chunks and 1 MiB pages',
      from: 'const hasMoreAfter = right.lineId < end;', to: 'const hasMoreAfter = false;' },
    { name: 'ignore-cancel', pattern: 'cancel releases pins immediately',
      from: "if (cancel.isCancelled()) { this.releasePin(id); return { status: 'cancelled', reason: 'reader cancelled' }; }",
      to: 'if (false) { this.releasePin(id); }' },
    { name: 'omit-retry-integrity', pattern: 'same key with changed content',
      from: "if (prior.request.digest !== request.digest) throw Error('event identity collision');",
      to: '/* mutant: accepts divergent retry */' },
    // Boundary-gated persistence damage is confined to the killed fixture
    // child. Parent continuation stays real, so earlier schema-only phases
    // cannot die for a different reason before the intended named assertion.
    { name: 'rel-drop-crash-input', pattern: 'process SIGKILL around input', assertion: 'REL durable input boundary',
      from: "        this.db.query('INSERT INTO sh_input VALUES(?,?,?,?,?,?)').run(key, sourceEpoch, packetSeq, event.digest, streamCanonical(event), streamCanonical(receipt));",
      to: "        if (!this.options.boundary) this.db.query('INSERT INTO sh_input VALUES(?,?,?,?,?,?)').run(key, sourceEpoch, packetSeq, event.digest, streamCanonical(event), streamCanonical(receipt));" },
    { name: 'rel-drop-crash-rows', pattern: 'process SIGKILL around input', assertion: 'REL durable row boundary',
      from: "      this.transaction('checkpoint', () => {\n        this.flushRows(key);",
      to: "      this.transaction('checkpoint', () => {\n        if (!this.options.boundary) this.flushRows(key);" },
    { name: 'rel-drop-crash-checkpoint', pattern: 'process SIGKILL around input', assertion: 'REL durable checkpoint boundary',
      from: "        this.db.query('INSERT INTO sh_checkpoint VALUES(?,?,?,?,?)').run(key, cp.checkpointId, streamCanonical(cp), cp.revision, streamDigest('vt-checkpoint', cp));",
      to: "        if (!this.options.boundary) this.db.query('INSERT INTO sh_checkpoint VALUES(?,?,?,?,?)').run(key, cp.checkpointId, streamCanonical(cp), cp.revision, streamDigest('vt-checkpoint', cp));" },
    { name: 'rel-false-continuation-receipt', pattern: 'process SIGKILL around input', assertion: 'REL continuation retry head exactly once',
      from: "      if (durable) { if (durable.digest !== request.digest) throw Error('event identity collision'); return ok(JSON.parse(String(durable.receipt))); }",
      to: "      if (durable) { if (durable.digest !== request.digest) throw Error('event identity collision'); return ok({...JSON.parse(String(durable.receipt)), head: 2}); }" },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    cpSync(join(pkg, 'core/src'), join(root, 'core/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'server/src/history-engine.ts'), original = readFileSync(file, 'utf8');
    const originalBytes = readFileSync(file);
    let fullRuns = 0;
    const run = async (pattern: string) => {
      const started = performance.now();
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', pattern],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const result = { exit, output: out + err, signal: child.signalCode, elapsedMs: performance.now() - started };
      if (pattern === 'stream-first H') summary(fullRuns++ === 0 ? 'full-clean-before' : 'full-clean-after', pattern, result);
      return result;
    };
    const summary = (stage: string, name: string, result: Awaited<ReturnType<typeof run>>) => {
      const namedLine = result.output.split('\n').find(line => /(?:AssertionError[^\n]*: |error: )REL /.test(line));
      console.log('STREAM_H_RUN', JSON.stringify({ stage, name, exit: result.exit, signal: result.signal,
        elapsedMs: result.elapsedMs, pass: Number(/\b(\d+) pass\b/.exec(result.output)?.[1] ?? 0),
        fail: Number(/\b(\d+) fail\b/.exec(result.output)?.[1] ?? 0), namedLine: namedLine?.slice(0, 4000),
        outputLength: result.output.length, truncated: result.output.length > 4000, tail: result.output.slice(-4000) }));
    };
    const restore = () => {
      writeFileSync(file, originalBytes);
      expect(readFileSync(file)).toEqual(originalBytes);
    };
    // A secondary restoration failure is visible but never replaces the first
    // failed oracle. The same rule applies to group restored runtime checks.
    const preservingPrimary = async (work: () => Promise<void>, cleanup: () => Promise<void>) => {
      let failed = false;
      try { await work(); }
      catch (error) { failed = true; throw error; }
      finally {
        try { await cleanup(); }
        catch (error) {
          console.error('REL_RESTORE_SECONDARY', String(error).slice(-4000));
          if (!failed) throw error;
        }
      }
    };
    const damaged = async (mutation: typeof mutations[number]) => {
      expect(readFileSync(file)).toEqual(originalBytes);
      expect(original.includes(mutation.from)).toBe(true);
      await preservingPrimary(async () => {
        writeFileSync(file, original.replaceAll(mutation.from, mutation.to));
        const result = await run(mutation.pattern);
        summary('damaged', mutation.name, result);
        expect(result.exit).not.toBe(0);
        expect(result.output).toMatch(/\(\s*fail\s*\)|\b[1-9]\d* fail\b/);
        expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
        expect(result.output).not.toMatch(/ReferenceError|timed out|TimeoutError|test timeout|Cannot find package|Failed to resolve/i);
        if ('assertion' in mutation) {
          // Match FULL output, not the bounded presentation above.
          expect(result.output).toMatch(new RegExp('(?:AssertionError[^\\n]*: |error: )' + mutation.assertion));
          expect(result.output).toMatch(/\b1 fail\b/);
        }
      }, async () => { restore(); });
    };
    await preservingPrimary(async () => {
      expect((await run('stream-first H')).exit).toBe(0);
      const legacy = mutations.filter(mutation => !('assertion' in mutation));
      const rel = mutations.filter(mutation => 'assertion' in mutation);
      expect(legacy).toHaveLength(4); expect(rel).toHaveLength(4);
      for (const mutation of legacy) await damaged(mutation);
      for (const mutation of rel) {
        expect(mutation.pattern).toBe('process SIGKILL around input');
        expect(original.split(mutation.from).length - 1).toBe(1);
      }
      expect(readFileSync(file)).toEqual(originalBytes);
      await preservingPrimary(async () => {
        const clean = await run('process SIGKILL around input');
        summary('clean-before', 'REL group', clean);
        expect(clean.exit).toBe(0);
        expect(clean.output).toMatch(/\b[1-9]\d* pass\b/);
        expect(clean.output).toContain('process SIGKILL around input and checkpoint transactions preserves every durable acknowledgement');
        expect((clean.output.match(/REL_CRASH_AFTER_CLOSE/g) ?? []).length).toBe(6);
        for (const mutation of rel) await damaged(mutation);
      }, async () => {
        // Even a failed byte restoration must not silently skip runtime restore.
        let restoreError: unknown;
        try { restore(); } catch (error) { restoreError = error; }
        try {
          const restored = await run('process SIGKILL around input');
          summary('restored-after', 'REL group', restored);
          expect(restored.exit).toBe(0);
          expect(restored.output).toMatch(/\b[1-9]\d* pass\b/);
          expect(restored.output).toContain('process SIGKILL around input and checkpoint transactions preserves every durable acknowledgement');
          expect((restored.output.match(/REL_CRASH_AFTER_CLOSE/g) ?? []).length).toBe(6);
        } catch (error) {
          if (restoreError !== undefined) console.error('REL_RESTORE_SECONDARY', String(error).slice(-4000));
          else throw error;
        }
        if (restoreError !== undefined) throw restoreError;
      });
      expect((await run('stream-first H')).exit).toBe(0);
    }, async () => { restore(); });
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch (cleanupError) { console.error('REL_CLEANUP_SECONDARY', String(cleanupError).slice(-4000)); }
    throw error;
  }
  rmSync(root, { recursive: true, force: true });
}, 120000);

test('contract repair mutants go red then restored real seams go green', async () => {
  const pkg=resolve(import.meta.dir,'../..');
  const root=mkdtempSync(join(tmpdir(),'contract-repair-mutants-'));
  const mutations=[
    {name:'BLOCK-1 digest',file:'capture-engine.ts',pattern:'real C-H 1 rows',
      from:'(this.ports.digest ?? streamDigest)(kind, value)',to:"(this.ports.digest ?? streamDigest)('wrong-operation', value)"},
    {name:'C3-A ordinal',file:'history-engine.ts',pattern:'real C-H 2 rows',
      from:'{...request.eventId, scrollOrdinal: request.eventId.scrollOrdinal + j}',to:'request.eventId'},
    {name:'BLOCK-3 batch',file:'capture-engine.ts',pattern:'real C-H 600 rows',
      from:'chunk.length < B.decodeRows',to:'chunk.length < 600'},
    {name:'HIGH-4 C fence',file:'capture-engine.ts',pattern:'real C-H 1 rows',
      from:'const fenced = this.ports.history.beginGap(this.episode);',to:"const fenced = {status:'ok' as const,value:null};"},
    {name:'HIGH-5 oversize',file:'pipe-history-collector.ts',pattern:'collector retains oversize',
      from:'this.options.retainOversize && isOversize(answer)',
      to:'false && isOversize(answer)'},
    {name:'HIGH-7 unknown',file:'capture-engine.ts',pattern:'real C-H 1 rows',
      from:'missingCount: this.episode!.missingCount',to:'missingCount: 0'},
    {name:'HIGH-7 atomic',file:'history-engine.ts',test:'sqlite-history-wave4.test.ts',pattern:'final repair rows stay fenced',
      from:'durable, complete: false, finalChunk: chunk.final',to:'durable, complete: chunk.final, finalChunk: chunk.final'},
    {name:'timer',file:'history-engine.ts',test:'sqlite-history-wave4.test.ts',pattern:'abandoned recovery',
      from:'if (timer) { clearInterval(timer); this.recoveryTimers.delete(timer); timer = null; }',to:'/* mutant retains the interval after cancellation */'},
    {name:'Worker allocation',file:'pipe-vt-worker.py',pattern:'RPC allocation',
      from:'reused = state is not None and state == _transaction_state',to:'reused = False',
      from2:'decode_extension(state["extensionState"]), _transaction_scratch',to2:'decode_extension(state["extensionState"]), None'},
    {name:'L1 oversized escape',file:'pipe-vt-worker.py',pattern:'oversized OSC checkpoint',
      from:'prefix = self.pending_sequence',to:'raise ValueError("pending escape exceeds checkpoint budget")'},
    {name:'C3-C duplicate buffers',file:'pipe-vt-worker.py',pattern:'maximum geometry checkpoint',
      from:'return {"rows": [],',to:'return {"rows": [contract_row(encode_row(rows[y], s.columns, s.default_char), row_wrapped(rows[y]), row_padded(rows[y], s.columns)) for y in range(s.lines)],'},
  ];
  try {
    const target=join(root,'packages/thumbmux');
    mkdirSync(target,{recursive:true});
    cpSync(join(pkg,'server/src'),join(target,'server/src'),{recursive:true});
    cpSync(join(pkg,'server/tests'),join(target,'server/tests'),{recursive:true});
    cpSync(join(pkg,'core/src'),join(target,'core/src'),{recursive:true});
    // The spike2 bundle and stitch vectors ride along in server/tests/fixtures:
    // nothing outside the package is read, so a public clone runs this unchanged.
    const core=join(root,'node_modules/@thumbmux/core');mkdirSync(core,{recursive:true});
    cpSync(join(pkg,'core/src'),join(core,'src'),{recursive:true});
    writeFileSync(join(core,'package.json'),'{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root,'package.json'),'{"type":"module"}');
    for(const m of mutations) {
      const file=join(target,'server/src',m.file),original=readFileSync(file,'utf8');
      expect(original.includes(m.from)).toBe(true);
      let mutant=original.replace(m.from,m.to);
      if(m.from2) {expect(mutant.includes(m.from2)).toBe(true);mutant=mutant.replace(m.from2,m.to2!);}
      const run=async()=>{
        const child=Bun.spawn([process.execPath,'test',...childTestTimeoutArgs,`./packages/thumbmux/server/tests/${m.test??'tmux-capture-normalize.test.ts'}`,'--test-name-pattern',m.pattern],
          {cwd:root,stdout:'pipe',stderr:'pipe'});
        const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        return {exit,output:out+err};
      };
      const clean=await run();
      expect(clean.exit,clean.output).toBe(0);expect(clean.output).toContain('(pass)');
      writeFileSync(file,mutant);
      const red=await run();
      console.log('CONTRACT_MUTANT_RED',m.name,red.exit,red.output);
      expect(red.exit).not.toBe(0);expect(red.output).toContain('(fail)');
      expect(red.output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      writeFileSync(file,original);
      const green=await run();
      console.log('CONTRACT_RESTORED_GREEN',m.name,green.exit,green.output);
      expect(green.exit).toBe(0);expect(green.output).toContain('(pass)');
    }
  } finally {rmSync(root,{recursive:true,force:true});}
},120000);

test('flag-on H mutants reject lost rows gaps forged ACK early unlink and pin bypass', async () => {
  const pkg=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'flagon-H-mutants-'));
  const mutations=[
    {name:'r2-dangling-left-row',pattern:'H-r2 rejects a gap',from:'if(g.leftRowId) fhAssert(this.visibleRow',to:'if(false && g.leftRowId) fhAssert(this.visibleRow'},
    {name:'r2-publish-candidate-early',pattern:'H-r2 staged attach',from:"staged?'candidate':'committed',r.operationId,r.digest,r,receipt",to:"'committed',r.operationId,r.digest,r,receipt"},
    {name:'r2-drop-timeline-on-reclaim',pattern:'H-r2 checkpoint pins',from:'// Stable row IDs and timeline slots survive payload reclaim.',to:"this.db.query('DELETE FROM fh_timeline WHERE segment=?').run(sealed.segmentId);"},
    {name:'r2-omit-geometry-journal',pattern:'H-r2 checkpoint pins',from:"this.save('control',event.eventId,key,event);return {commitId:r.operationId,event};",to:'return {commitId:r.operationId,event};'},
    {name:'r2-source-bytes-unchecked',pattern:'H-r2 canonical SGR',from:"offset===record.range.end&&(record.payload.kind!=='bytes'||equal(raw,record.payload.bytes))",to:'offset===record.range.end'},
    {name:'replay-remote-prefix',pattern:'replay from current durable cursor',from:".all(key,segmentFloor) as SqlRow[];",to:".all(key,0) as SqlRow[];"},
    {name:'delete-without-vacuum',pattern:'verified reclaim really',from:"this.db.exec('PRAGMA incremental_vacuum(256)');",to:'/* mutant: DELETE without returning source DB pages */'},
    {name:'swallow-gap',pattern:'ACK then reopen',from:"gaps:r.decision.gaps,receipt:JSON.parse(String(e.receipt))",to:"gaps:[],receipt:JSON.parse(String(e.receipt))"},
    {name:'omit-rows-transaction',pattern:'ACK then reopen',from:"this.putEvent(key,String(segment.id),staged?'candidate':'committed',r.operationId,r.digest,r,receipt);",to:'/* omit durable rows + gaps */'},
    {name:'ack-before-sync',pattern:'rollback at write/commit',from:"this.putEvent(key,segmentId,'input',record.operationId,record.digest,record,ack,encoded);",to:'/* ACK without durable input */'},
    {name:'upload-is-verification',pattern:'upload exit zero',from:"fhAssert(this.options.validateRemoteIndex?.(remote,sealed) === true, 'remote catalog authority not validated');",to:'/* delete after untrusted upload receipt */'},
    {name:'pin-bypass',pattern:'pins survive restart',from:"fhAssert(!this.db.query('SELECT 1 FROM fh_pin WHERE segment=? AND released=0 LIMIT 1').get(segment), 'segment pinned');",to:'/* ignore active reader/handoff pin */'},
    {name:'remote-to-empty-eof',pattern:'verified reclaim really',from:"for (const s of segments) fhAssert(s.state !== 'reclaiming' && s.state !== 'remote', 'remote-required: restore segment before replay');",to:'/* remote treated as empty local */'},
  ];
  try {
    cpSync(join(pkg,'server/src'),join(root,'server/src'),{recursive:true});
    cpSync(join(pkg,'core/src'),join(root,'core/src'),{recursive:true});
    mkdirSync(join(root,'server/tests/sqlite-history'),{recursive:true});
    cpSync(join(pkg,'server/tests/sqlite-history-wave4.test.ts'),join(root,'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg,'server/tests/sqlite-history/helpers.ts'),join(root,'server/tests/sqlite-history/helpers.ts'));
    const core=join(root,'node_modules/@thumbmux/core');mkdirSync(core,{recursive:true});cpSync(join(pkg,'core/src'),join(core,'src'),{recursive:true});
    writeFileSync(join(core,'package.json'),'{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root,'package.json'),'{"type":"module"}');
    const file=join(root,'server/src/history-engine.ts'),original=readFileSync(file,'utf8');
    const run=async(pattern:string)=>{
      const child=Bun.spawn([process.execPath,'test',...childTestTimeoutArgs,'./server/tests/sqlite-history-wave4.test.ts','--test-name-pattern',pattern],{cwd:root,stdout:'pipe',stderr:'pipe'});
      const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {exit,output:out+err};
    };
    const clean=await run('flag-on H|H-r2');expect(clean.exit,clean.output).toBe(0);expect(clean.output).toMatch(/\b[1-9]\d* pass\b/);
    for(const mutation of mutations){
      expect(original.split(mutation.from).length).toBe(2);writeFileSync(file,original.replace(mutation.from,mutation.to));
      const result=await run(mutation.pattern);console.log('FLAGON_H_MUTANT',mutation.name,result.exit,result.output);
      expect(result.exit).not.toBe(0);expect(result.output).toMatch(/\(\s*fail\s*\)|\b[1-9]\d* fail\b/);expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);writeFileSync(file,original);
      const restored=await run(mutation.pattern);console.log('FLAGON_H_RESTORED',mutation.name,restored.exit,restored.output);expect(restored.exit,restored.output).toBe(0);
    }
    expect((await run('flag-on H|H-r2')).exit).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},120000);


// Q22 new API: real behavioral red on broken implementations, followed by a
// restored full-file run. Mutants live only in a private copy INSIDE the cage.
test('H v2 mutations reject forged writers, lost incidents, stale audits and non-atomic checkpoints', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'h-v2-mutants-'));
  const mutations = [
    { name: 'v2-unbounded-export-scratch', from: '    this.cleanupUncommittedExports();', to: '    /* mutant leaves unpublished exports behind */' },
    { name: 'v2-second-process-writer', from: 'PRAGMA locking_mode=EXCLUSIVE;', to: 'PRAGMA locking_mode=NORMAL;' },
    { name: 'v2-reclaim-with-pin', from: "fhAssert(pin?.segmentId !== segment || pin.released, 'v2 segment pinned');", to: '/* mutant ignores persistent pins */' },
    { name: 'v2-locator-without-readback', from: "&& this.hooks.remoteReadback?.(locator, exported) === true, 'v2 public reader proof required'", to: "&& true, 'v2 public reader proof required'" },
    { name: 'v2-forged-capability', from: "fhAssert(c === this.#cap, 'v2 forged capability');", to: '/* mutant accepts copied capability */' },
    { name: 'v2-incident-needs-ack', from: 'validateV2Incident(incident);', to: "validateV2Incident(incident); fhAssert(next.frontier !== null, 'mutant requires first ACK');" },
    { name: 'v2-forget-checkpoint', from: "this.put('checkpoint', key, 'live', cp);", to: '/* mutant acknowledges without checkpoint */' },
    { name: 'v2-ignore-current-generation', from: 'v2WriteDisposition(r.fence, cap.generation, owner?.durableRevision ?? 0, previous)', to: 'v2WriteDisposition({ ...r.fence, expectedGeneration: cap.generation }, cap.generation, owner?.durableRevision ?? 0, previous)' },
    { name: 'v2-accept-stale-audit', from: "}, this.#config.audit), 'v2 stale/unordered audit');", to: "}, this.#config.audit) || true, 'v2 stale/unordered audit');" },
    // H-PERF: append() now takes the row text H already made (MUTATION.md row 1).
    { name: 'v2-omit-atomic-rows', from: "this.append(key, revision, 'row', streamCanonical(row.id), row.id.segmentId, row, rowText[i]);", to: '/* mutant loses rows behind durable receipt */' },
    { name: 'v2-authority-foreign-incident', from: "const resolved = this.get<V2IncidentResolution>('incident-resolution', key, incidentId);",
      to: "const resolved = this.get<V2IncidentResolution>('incident-resolution', key, this.owner(pane)?.incidentId ?? incidentId);" },
    { name: 'v2-authority-omits-checkpoint-pin', from: "rawPins: [{ pinId: `checkpoint:${checkpoint.checkpointId}`,\n        holder: 'decoder-checkpoint', from: checkpoint.replayFloor }], rowPins }", to: 'rawPins: [], rowPins }' },
  ];
  try {
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'server/src/history-engine.ts'), original = readFileSync(file, 'utf8');
    const run = async (name: string, failed: boolean) => {
      // Every pre-HS1 test, run 14 times under a fixed timeout; the HS1/HS2 storage
      // cases (seconds each) have their own mutant runners below.
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', '^(?!HS[12] |HPERF )'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      console.log('H_V2_MUTANT', JSON.stringify({ name, exit, summary: output.slice(-1600) }));
      expect(output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      if (failed) { expect(exit).not.toBe(0); expect(output).toMatch(/\(fail\) H v2/); }
      else expect(exit, output).toBe(0);
    };
    await run('clean-before', false);
    for (const mutant of mutations) {
      expect(original.split(mutant.from).length).toBe(2);
      try { writeFileSync(file, original.replace(mutant.from, mutant.to)); await run(mutant.name, true); }
      finally { writeFileSync(file, original); }
    }
    await run('clean-after', false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 300000);

// BH (B2-replan §3 BH + E-rearm §4): source-prefix input and reserve-rearm
// authority. Each mutant must fail the NAMED acceptance test with an assertion,
// in a private copy inside the cage; the clean copy passes before and after.
//
// The two H authority mutants below were removed from the H v2 list above in
// 3c251afff / 80967d7c9 as "equivalent". Reasoning recorded (H review claude
// MINOR-2, agy MAJOR):
// - v2-authority-refreshes-stale-generation: v2IncidentResolvedBy also requires
//   receipt.generation === current, and the stored receipt keeps generation g,
//   so after reopen the guard was false with or without the refresh: equivalent
//   for THAT guard only. It is not equivalent for the authority contract
//   (stored writerGeneration must stay the original one, E-rearm §3), so the
//   acceptance test now asserts staleResolution.writerGeneration === g and kills it.
// - v2-authority-rematerializes-incident: a replayed incident under a new
//   operation id is refused earlier by the revision fence ('v2 incident fence'),
//   and the same id returns the stored receipt before addIncident, so the `!old`
//   line is reachable only by the same incident id twice inside ONE commit.
//   There the mutant silently deduplicates instead of refusing: not equivalent.
//   The same-batch duplicate test now kills it.
test('BH mutants: issued prefix readback, durable start/end fence, atomic refusal and reserve-rearm authority', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'bh-mutants-'));
  const prefix = /\(fail\) H v2 batch commits an issued mid-record source-prefix/;
  const rearm = /\(fail\) H v2 reserve rearm reads the original receipt/;
  const tamper = /\(fail\) H v2 reserve rearm refuses pending, tampered/;
  const H = 'history-engine.ts', C = 'stream-contract.ts';
  const mutations: { name: string; file: string; kills: RegExp; from: string; to: string; from2?: string; to2?: string }[] = [
    { name: 'bh-prefix-skip-readback', file: H, kills: prefix,
      from: 'v2BatchInputMatchesIssued(b.input, issued.value, durable, b.checkpoint)', to: 'v2BatchInputMatchesIssued(b.input, b.input, durable, b.checkpoint)' },
    { name: 'bh-prefix-start-from-caller', file: H, kills: prefix,
      from: 'v2BatchInputMatchesIssued(b.input, issued.value, durable, b.checkpoint)',
      to: "v2BatchInputMatchesIssued(b.input, issued.value, { ...durable, through: { ...durable.through, byteOffset: b.input.kind === 'source-prefix' ? b.input.certified.start : durable.through.byteOffset } }, b.checkpoint)" },
    { name: 'bh-prefix-nonatomic-checkpoint', file: H, kills: prefix,
      from: "          fhAssert(durable && issued?.status === 'ok' && v2BatchInputMatchesIssued(b.input, issued.value, durable, b.checkpoint),\n            'v2 durable input authority');",
      to: "          const inputOk = !!durable && issued?.status === 'ok' && v2BatchInputMatchesIssued(b.input, issued.value, durable, b.checkpoint);",
      from2: 'setCheckpoint(b.checkpoint); break;', to2: 'if (inputOk) setCheckpoint(b.checkpoint); break;' },
    { name: 'bh-prefix-end-equality', file: C, kills: prefix,
      from: '      && input.certified.end === checkpoint.through.byteOffset\n', to: '' },
    { name: 'bh-prefix-start-equality', file: C, kills: prefix,
      from: '      && input.certified.start === previous.through.byteOffset\n', to: '' },
    { name: 'bh-rearm-skip-current-cap', file: H, kills: rearm,
      from: "this.authorize(this.#cap); fhAssert(expectedGeneration === this.#cap.generation, 'v2 rearm generation');", to: '' },
    { name: 'bh-rearm-refresh-receipt-generation', file: H, kills: rearm,
      from: 'resolvedReceipt: receipt,', to: 'resolvedReceipt: { ...receipt, generation: this.#cap.generation },' },
    { name: 'bh-rearm-wrong-incident-digest', file: H, kills: rearm,
      from: 'incidentDigest: v2EmergencyIncidentDigest(incident),', to: 'incidentDigest: receipt.digest,' },
    { name: 'bh-rearm-cached-observation', file: H, kills: rearm,
      from: '    return observation;\n',
      to: '    const cache = ((globalThis as { bhRearm?: Map<string, V2ReserveRearmObservation> }).bhRearm ??= new Map());\n    if (!cache.has(key + incidentId)) cache.set(key + incidentId, observation);\n    return cache.get(key + incidentId)!;\n' },
    { name: 'bh-rearm-skip-receipt-readback', file: H, kills: tamper,
      from: '&& receipt && equal(receipt, resolution.receipt)', to: '&& receipt' },
    { name: 'bh-rearm-refreshed-stored-generation', file: H, kills: tamper,
      from: 'resolution.writerGeneration === receipt.generation && ', to: '' },
    { name: 'bh-rearm-accept-pending', file: H, kills: tamper,
      from: "resolution.state === 'resolved' && ", to: '' },
    { name: 'bh-rearm-foreign-resolution', file: H, kills: tamper,
      from: '\n      && resolution.incidentId === incidentId && v2PaneKey(resolution.pane) === key', to: '' },
    { name: 'bh-rearm-skip-incident-revision', file: H, kills: tamper,
      from: ' && incident.revision === receipt.revision', to: '' },
    { name: 'v2-authority-refreshes-stale-generation', file: H, kills: /\(fail\) H v2 authority resolves only the durable incident receipt/,
      from: 'if (resolved) return resolved;', to: 'if (resolved) return { ...resolved, writerGeneration: this.currentGeneration() };' },
    { name: 'v2-authority-rematerializes-incident', file: H, kills: /\(fail\) H v2 incident listed twice in one batch/,
      from: "        fhAssert(!old, old && equal(old, incident) ? 'v2 incident already materialized' : 'v2 incident collision');\n        this.put('incident', key, incident.incidentId, incident);\n        this.append(key, revision, 'incident', incident.incidentId, '', incident);\n        resolvedIncidents.push(incident.incidentId);",
      to: "        if (old) fhAssert(equal(old, incident), 'v2 incident collision');\n        else { this.put('incident', key, incident.incidentId, incident); this.append(key, revision, 'incident', incident.incidentId, '', incident); resolvedIncidents.push(incident.incidentId); }" },
  ];
  try {
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', 'H v2'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      console.log('BH_MUTANT', JSON.stringify({ name, exit, failed: output.match(/^\(fail\) .*$/gm) ?? [], summary: output.slice(-600) }));
      expect(output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      return { exit, output };
    };
    const clean = await run('clean-before'); expect(clean.exit, clean.output).toBe(0); expect(clean.output).toMatch(/\b[1-9]\d* pass\b/);
    for (const m of mutations) {
      const file = join(root, 'server/src', m.file), original = readFileSync(file, 'utf8');
      expect(original.split(m.from).length).toBe(2);
      let mutant = original.replace(m.from, m.to);
      if (m.from2) { expect(mutant.split(m.from2).length).toBe(2); mutant = mutant.replace(m.from2, m.to2!); }
      try {
        writeFileSync(file, mutant);
        const red = await run(m.name);
        expect(red.exit).not.toBe(0);
        expect(red.output).toMatch(m.kills);
      } finally { writeFileSync(file, original); }
    }
    const after = await run('clean-after'); expect(after.exit, after.output).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 300000);

// HS1 (H-STORE PLAN §5.1, §5.3, §5.2): burst capacity on the default root.
// It lives here, not in the wave4 file, because every mutation runner above
// re-runs the whole wave4 file per mutant; a ~30 s burst there would push
// those runners past their fixed timeouts. It runs once per gate.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createV2HistoryFactory } from '../src/history-engine';
import { evaluateV2Prefix, v2BirthCheckpoint } from '../src/capture-engine';
import * as HS from '../src/stream-contract';

test('HS1 capacity: 10,001 real decoder rows fit one fresh default root within 8 KiB per row, never the 120 MiB SQLITE_FULL', async () => {
  const MiB = 1024 * 1024, root = mkdtempSync(join(tmpdir(), 'hs1-capacity-'));
  const value = <T>(r: HS.Result<T>): T => { if (r.status !== 'ok') throw Error(JSON.stringify(r)); return r.value; };
  const config = HS.NEWARCH_V2_DEFAULT_CONFIG, geometry = HS.v2BirthGeometry(config);
  const pane = { serverIdentity: 'hs1-capacity-server', paneId: '%1', birthGeneration: 1 };
  const session = { serverIdentity: pane.serverIdentity, sessionId: 'hs1-capacity' };
  const descriptor = { schema: 'newarch-v2' as const, session, pane, windowId: '@1', owner: 'capture-engine' as const, birthOperationId: 'hs1-birth', geometry, state: 'active' as const };
  const epoch = { pane, attachId: 'hs1-attach', collectorIncarnation: 'hs1-collector' };
  // S-issued input stub: H reads back only what was issued for this batch.
  const issued = new Map<string, HS.V2BatchInput>();
  const factory = createV2HistoryFactory({ inputReceipt: input => ({ status: 'ok', value: issued.get(HS.streamCanonical(input)) ?? null }) });
  const port = value(await factory.openForCapture({ rootId: root, engineId: 'hs1-capacity', config }));
  let operation = 0;
  const commit = (command: HS.V2WriteCommand) => {
    const fence = { pane, operationId: 'hs1-op-' + operation++, expectedGeneration: port.capability.generation,
      expectedRevision: value(port.reader.owner(pane))?.durableRevision ?? 0 };
    return port.writer.commit(port.capability, { fence: { ...fence, digest: HS.v2WriteDigest({ fence, command }) }, command });
  };
  const intent: HS.V2BirthIntent = { schema: 'newarch-v2', operationId: 'hs1-birth', session, geometry, command: 'new-session', owner: 'capture-engine' };
  try {
    value(await port.writer.reserveBirth(port.capability, { intent, expectedGeneration: port.capability.generation, digest: HS.v2Digest('birth-reservation', { intent }) }));
    let cp = v2BirthCheckpoint(descriptor, { epoch, byteOffset: 0 });
    const ready: HS.V2BirthReady = { intent, pane: descriptor, binding: { kind: 'collector-binding', epoch, attachId: epoch.attachId, rootUUID: 'hs1-root',
      bootNonce: 'boot', ownerGeneration: 1, process: { pid: 123, startTime: '1', bootId: 'synthetic' }, peerUid: 1000, fifoId: 'fifo', handshakeId: 'h',
      artifactSha256: 'a'.repeat(64) }, byte0: { epoch, byteOffset: 0 }, journal: { path: '/synthetic/birth', bytes: 1, sha256: 'a'.repeat(64) },
      geometryReadback: { columns: geometry.columns, rows: geometry.rows }, paneCountInWindow: 1, programHeld: true };
    value(await commit({ kind: 'activate', ready, checkpoint: cp }));
    // Every line fits one 78-column row (CR LF, ANSI, Thai, emoji, blank), so
    // 119 lines fill the screen and each further line scrolls exactly one row.
    const text = (i: number) => [`B${String(i).padStart(5, '0')}`, `สวัสดีประเทศไทย ${i} UTF-8 😀`, `\x1b[31mRED\x1b[0m ${i} done`, '',
      `sh-r ${i} \x1b[36mcolor\x1b[0m ไทย漢字😀 ` + 'x'.repeat(12)][i % 5]!;
    const target = 10_001, totalLines = target + geometry.rows - 1, hashes: string[] = [];
    let pending: number[] = [], line = 0, segment = 0, segmentBytes = 0, commits = 0, logical = 0, failure: unknown = null;
    const started = performance.now();
    while (pending.length || line < totalLines) {
      if (pending.length < 64 * 1024 && line < totalLines) {
        let chunk = ''; for (let j = 0; j < 256 && line < totalLines; j++) chunk += text(line++) + '\r\n';
        pending = [...pending, ...Buffer.from(chunk)];
      }
      if (segmentBytes + 2 * MiB + 4096 > 8 * MiB) { segment++; segmentBytes = 0; }
      const segmentId = 'hs1-seg-' + segment, start = cp.through.byteOffset;
      const r = evaluateV2Prefix({ pane: descriptor, checkpoint: cp, raw: { epoch, start, end: start + pending.length }, bytes: pending,
        observedAtMonoMs: 1, pendingSinceMonoMs: null }, config, { wallMs: 0, clockEpoch: 'replay',
        rowTarget: { segmentId, nextRowOrdinal: cp.frontier?.segmentId === segmentId ? cp.frontier.rowOrdinal + 1 : 0 } });
      if ('kind' in r) throw Error('decoder gap ' + JSON.stringify(r).slice(0, 400));
      const input: HS.V2BatchInput = { kind: 'synced-spool', version: 1, through: r.checkpoint.through, recordDigest: 'b'.repeat(64), commitId: 'hs1-in-' + commits, segmentId: 'raw-1' };
      issued.set(HS.streamCanonical(input), input);
      const result = await commit({ kind: 'batch', batch: { rows: r.rows, decisions: [], incidents: [], checkpoint: r.checkpoint, input } });
      issued.clear(); commits++;
      if (result.status !== 'ok') { failure = { rows: hashes.length, commits, result }; break; }
      for (const row of r.rows) { const c = HS.streamCanonical(row); hashes.push(createHash('sha256').update(c).digest('hex')); logical += Buffer.byteLength(c); segmentBytes += Buffer.byteLength(c) + 1; }
      cp = r.checkpoint; pending = pending.slice(r.consumed.end - r.consumed.start);
    }
    const writeMs = Math.round(performance.now() - started);
    // Reader spot checks at both ends of the 10,001-row history.
    const ends: string[][] = [];
    if (failure === null) for (const direction of ['after', 'before'] as const) {
      const page = value(await port.reader.page({ schema: 'newarch-v2', pane, cursor: null, direction, maxEntries: 32, maxBytes: 2 * MiB }));
      ends.push(page.entries.flatMap(e => e.kind === 'row' ? [createHash('sha256').update(HS.streamCanonical(e.row)).digest('hex')] : []));
    }
    value(await port.writer.close(port.capability));
    const db = new Database(join(root, 'flag-on-v1.sqlite'), { readonly: true });
    let disk: Record<string, number>, stored: string[] = [];
    try {
      const pragma = (name: string) => Number(Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
      disk = { pageSize: pragma('page_size'), pages: pragma('page_count'), freelist: pragma('freelist_count') };
      // Every stored row decodes to the canonical bytes the decoder produced and
      // still matches its logical checksum.
      for (const row of db.query("SELECT * FROM fh_v2_timeline WHERE kind='row' ORDER BY n").all() as Record<string, string | number | Uint8Array>[]) {
        const payload = typeof row.payload === 'string' ? row.payload : inflateSync((row.payload as Uint8Array).subarray(4)).toString('utf8');
        expect(row.checksum).toBe(HS.v2Digest('timeline', { pane: row.pane, n: row.n, revision: row.revision, kind: row.kind, id: row.id, segment: row.segment, payload }));
        stored.push(createHash('sha256').update(payload).digest('hex'));
      }
    } finally { db.close(); }
    const dbBytes = disk.pages * disk.pageSize, capBytes = Math.floor((config.storage.rootCapBytes - config.storage.emergencyReserveBytes) / 8192) * 4096;
    console.log('HS1_CAPACITY', JSON.stringify({ bun: Bun.version, rows: hashes.length, commits, segments: segment + 1, writeMs, logicalRowBytes: logical,
      ...disk, dbBytes, capBytes, dbBytesPerRow: Math.round(dbBytes / Math.max(1, hashes.length)), failure }));
    expect(failure).toBeNull();
    expect(hashes.length).toBe(target);
    expect(stored).toEqual(hashes);
    expect(ends).toEqual([hashes.slice(0, ends[0]!.length), hashes.slice(-ends[1]!.length)]);
    expect(ends[0]!.length).toBeGreaterThan(0);
    // The same rows as canonical TEXT exceed the database the default root allows.
    expect(logical).toBeGreaterThan(capBytes);
    expect(disk.pageSize).toBe(4096);
    expect(dbBytes).toBeLessThan(capBytes);
    expect(dbBytes / target).toBeLessThanOrEqual(8192);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 300_000);

// HS1 mutants (PLAN §5.3). Same copied-tree runner as above; only the HS1
// cases run, each mutant must fail its NAMED test with an assertion.
test('HS1 mutants: canonical storage, lossy codec, hashed bytes, physical segment size, unbounded inflate, raw export, no fence, rebuilt receipt', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'hs1-mutants-'));
  const budget = /\(fail\) HS1 real decoder rows stay within 8 KiB per row/, legacy = /\(fail\) HS1 legacy TEXT root/;
  const corrupt = /\(fail\) HS1 corrupt, truncated, trailing/, receipt = /\(fail\) HS1 receipts and checkpoints are stored compressed/;
  const mutations: { name: string; kills: RegExp; from: string; to: string; from2?: string; to2?: string }[] = [
    { name: 'hs1-no-row-shape', kills: /\(fail\) HS1 row shape and canonical equality/,
      from: 'function v2RowShape(row: CommittedStreamRow): void {',
      to: 'function v2RowShape(row: CommittedStreamRow): void { return;' },
    { name: 'hs1-no-canonical-equality', kills: /\(fail\) HS1 row shape and canonical equality/,
      from: "  fhAssert(streamCanonical(value) === payload, 'v2 storage canonical equality');", to: '' },
    { name: 'hs1-store-canonical', kills: budget,
      from: '  return packed.byteLength < Buffer.byteLength(payload) ? packed : payload;', to: '  return payload;' },
    { name: 'hs1-lossy-codec-drops-cell-origins', kills: budget,
      from: 'deflateSync(Buffer.from(payload), { level: 6 })',
      to: "deflateSync(Buffer.from(payload.replace(/\"cellOrigins\":\\[[^\\]]*\\]/, '\"cellOrigins\":[]')), { level: 6 })" },
    { name: 'hs1-digest-over-stored-bytes', kills: budget,
      from: "    this.#db.query('INSERT INTO fh_v2_timeline VALUES(?,?,?,?,?,?,?,?)').run(pane, n, revision, kind, id, segment, kind === 'row' ? v2Pack(payload) : payload,\n      v2Digest('timeline', { pane, n, revision, kind, id, segment, payload }));",
      to: "    const stored = kind === 'row' ? v2Pack(payload) : payload, hashed = typeof stored === 'string' ? stored : Buffer.from(stored).toString('base64');\n    this.#db.query('INSERT INTO fh_v2_timeline VALUES(?,?,?,?,?,?,?,?)').run(pane, n, revision, kind, id, segment, stored,\n      v2Digest('timeline', { pane, n, revision, kind, id, segment, payload: hashed }));",
      from2: "      kind: r.kind, id: r.id, segment: r.segment, payload }), 'v2 corrupt timeline');",
      to2: "      kind: r.kind, id: r.id, segment: r.segment, payload: typeof r.payload === 'string' ? r.payload : Buffer.from(r.payload as Uint8Array).toString('base64') }), 'v2 corrupt timeline');" },
    { name: 'hs1-physical-segment-bytes', kills: budget,
      from: '      metrics.bytes += Buffer.byteLength(this.logicalTimeline(row).payload) + 1;',
      to: "      metrics.bytes += (typeof row.payload === 'string' ? Buffer.byteLength(row.payload) : (row.payload as unknown as Uint8Array).byteLength) + 1;" },
    { name: 'hs1-unbounded-inflate', kills: corrupt, from: '{ maxOutputLength: limit, info: true }', to: '{ info: true }' },
    { name: 'hs1-accept-trailing-bytes', kills: corrupt,
      from: "  fhAssert(decoded.engine.bytesWritten === compressed.byteLength, 'v2 storage trailing data');\n", to: '' },
    { name: 'hs1-export-stored-bytes', kills: budget,
      from: 'write(path, this.exportRecords(key, seal.segmentId),',
      to: "write(path, this.#db.query('SELECT * FROM fh_v2_timeline WHERE pane=? AND segment=? ORDER BY n').iterate(key, seal.segmentId)," },
    { name: 'hs1-no-format-fence', kills: legacy,
      from: "db.query('UPDATE fh_v2_meta SET generation=?,version=? WHERE id=1').run(next, V2_STORAGE_FORMAT);",
      to: "db.query('UPDATE fh_v2_meta SET generation=? WHERE id=1').run(next);" },
    { name: 'hs1-accept-unknown-format', kills: legacy,
      from: "fhAssert(meta.version === 'newarch-v2' || meta.version === V2_STORAGE_FORMAT, 'unsupported v2 storage');", to: '/* mutant opens any format */' },
    { name: 'hs1-rebuild-receipt-on-read', kills: receipt,
      from: '    return v2CanonicalValue(payload) as T;',
      to: "    const value = JSON.parse(payload);\n    return (kind === 'receipt' ? { ...value, generation: this.#cap.generation } : value) as T;" },
  ];
  try {
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'server/src/history-engine.ts'), original = readFileSync(file, 'utf8');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', 'HS1'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      console.log('HS1_MUTANT', JSON.stringify({ name, exit, failed: output.match(/^\(fail\) .*$/gm) ?? [], summary: output.slice(-600) }));
      expect(output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      return { exit, output };
    };
    const clean = await run('clean-before'); expect(clean.exit, clean.output).toBe(0); expect(clean.output).toMatch(/\b6 pass\b/);
    for (const m of mutations) {
      expect(original.split(m.from).length).toBe(2);
      let mutant = original.replace(m.from, m.to);
      if (m.from2) { expect(mutant.split(m.from2).length).toBe(2); mutant = mutant.replace(m.from2, m.to2!); }
      try {
        writeFileSync(file, mutant);
        const red = await run(m.name);
        expect(red.exit).not.toBe(0);
        expect(red.output).toMatch(m.kills);
      } finally { writeFileSync(file, original); }
    }
    const after = await run('clean-after'); expect(after.exit, after.output).toBe(0); expect(after.output).toMatch(/\b6 pass\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);

// HS2 mutants (PLAN §3.2). Same copied-tree runner; only the HS2 cases run and
// each mutant must fail its NAMED test at its LABELLED assertion
// (`error: HS2-ASSERT <label>`), never by a TypeError/ReferenceError on the way
// there (HS2 r1, review B1: a non-zero exit plus a test name was not enough —
// the first `profile-not-persisted` died dereferencing null). The contract-side
// HS2 mutants are K_MUTANTS in contract-fixture.ts. Removing finalize() from
// fhRows is deliberately absent: a prepare()d statement is never handed to
// another caller, so it is a leak until GC, not a behaviour change.
test('HS2 mutants: cached iterate, profile not persisted or not checked or checked late or after the open writes, 4096-byte pages, unbounded WAL', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'hs2-mutants-'));
  const durable = /\(fail\) HS2 storage profile is durable/;
  const assertion = (label: string) => new RegExp('^error: HS2-ASSERT ' + label + '$', 'm');
  // `bun` = the Bun range where the kill is REQUIRED. Bun 1.3's query() cache
  // never evicts, and H then happened to get a fresh statement (TMX-TRIAGE #1),
  // so the cached-iterate mutant may survive there: logged, not asserted.
  const mutations: { name: string; kills: RegExp; assert: RegExp; from: string; to: string; from2?: string; to2?: string; from3?: string; to3?: string; bun?: string }[] = [
    { name: 'hs2-cached-iterate', kills: /\(fail\) HS2 abandoned scans leave the store usable/, assert: assertion('scans-usable'), bun: '>=1.4.0',
      from: '  const statement = db.prepare(sql);\n  try { yield* statement.iterate(...params) as Iterable<SqlRow>; } finally { statement.finalize(); }',
      to: '  yield* db.query(sql).iterate(...params) as Iterable<SqlRow>;' },
    // The root still opens; only the row is never written.
    { name: 'hs2-profile-not-persisted', kills: durable, assert: assertion('profile-row'),
      from: "    if (!v2ProfileFence(this.#db, digest)) this.put('storage-profile', '*', 'root', {",
      to: "    if (!v2ProfileFence(this.#db, digest)) return;\n    if (false) this.put('storage-profile', '*', 'root', {" },
    // One shared fence: both the pre-write and the in-transaction check go.
    { name: 'hs2-profile-mismatch-accepted', kills: durable, assert: assertion('mismatch-refused'),
      from: "  fhAssert(stored.digest === digest, 'v2 storage profile mismatch');", to: "  fhAssert(true, 'v2 storage profile mismatch');" },
    // No pre-write fence and the in-transaction check moved after the generation commit.
    { name: 'hs2-profile-checked-after-generation', kills: durable, assert: assertion('generation-unchanged'),
      from: '      options[V2_PROFILE_FENCE]?.(db);\n', to: '',
      from2: '      this.bindStorageProfile();\n', to2: '',
      from3: '    this.#secret = String(', to3: '    this.bindStorageProfile(); this.#secret = String(' },
    // Review M1: no pre-write fence; the in-transaction check still refuses, generation stays.
    { name: 'hs2-profile-fenced-after-writes', kills: /\(fail\) HS2 a mismatched profile is refused before the open writes/,
      assert: assertion('outside-state-unchanged'), from: '      options[V2_PROFILE_FENCE]?.(db);\n', to: '' },
    { name: 'hs2-page-size-constant-4096', kills: /\(fail\) HS2 page limit follows the real page size/, assert: assertion('page-limit'),
      from: 'v2DatabasePageLimit(this.#profile, pageSize)', to: 'v2DatabasePageLimit(this.#profile, 4096)' },
    { name: 'hs2-wal-not-bounded', kills: /\(fail\) HS2 WAL stays inside the allocation/, assert: assertion('wal-after-commit'),
      from: '    if (!allocation) return false;\n', to: '    return false;\n' },
  ];
  try {
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const file = join(root, 'server/src/history-engine.ts'), original = readFileSync(file, 'utf8');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', 'HS2'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      console.log('HS2_MUTANT', JSON.stringify({ name, bun: Bun.version, exit, failed: output.match(/^\(fail\) .*$/gm) ?? [],
        asserted: output.match(/^error: HS2-ASSERT .*$/gm) ?? [], thrown: output.match(/^(?:\d+ \| .*)?\b(?:TypeError|ReferenceError)\b.*$/gm) ?? [], summary: output.slice(-600) }));
      expect(output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      return { exit, output };
    };
    const clean = await run('clean-before'); expect(clean.exit, clean.output).toBe(0); expect(clean.output).toMatch(/\b5 pass\b/);
    for (const m of mutations) {
      expect(original.split(m.from).length).toBe(2);
      let mutant = original.replace(m.from, m.to);
      if (m.from2) { expect(mutant.split(m.from2).length).toBe(2); mutant = mutant.replace(m.from2, m.to2!); }
      if (m.from3) { expect(mutant.split(m.from3).length).toBe(2); mutant = mutant.replace(m.from3, m.to3!); }
      try {
        writeFileSync(file, mutant);
        const red = await run(m.name);
        const killed = red.exit !== 0 && m.kills.test(red.output) && m.assert.test(red.output) && !/\b(?:TypeError|ReferenceError)\b/.test(red.output);
        if (m.bun && !Bun.semver.satisfies(Bun.version, m.bun)) {
          console.log('HS2_MUTANT_NOT_REQUIRED', JSON.stringify({ name: m.name, bun: Bun.version, killed }));
          continue;
        }
        expect(red.exit).not.toBe(0);
        expect(red.output).toMatch(m.kills);
        // The intended assertion fired, and nothing died of a programming error first.
        expect(red.output).toMatch(m.assert);
        expect(red.output).not.toMatch(/\b(?:TypeError|ReferenceError)\b/);
      } finally { writeFileSync(file, original); }
    }
    const after = await run('clean-after'); expect(after.exit, after.output).toBe(0); expect(after.output).toMatch(/\b5 pass\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);

// H-PERF lot A (PLAN §4.4): only the `HPERF ` cases of the wave4 file, in the
// same copied-tree runner, once per gate (the runners above exclude them by
// name). Each mutant must fail its NAMED case at its LABELLED assertion
// (`error: HPERF-ASSERT <label>`), never by a compile/import error, a timeout
// or a TypeError/ReferenceError on the way there. Anchors exist only in code
// H-PERF added; a missing or repeated anchor fails the runner.
test('HPERF mutants: repeated row work, re-read checkpoint, stale instance or module memo, trusted caller input, early receipt memo, non-atomic checkpoint', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'hperf-mutants-'));
  const assertion = (label: string) => new RegExp('^error: HPERF-ASSERT ' + label + '$', 'm');
  const budget = /\(fail\) HPERF work budget: a full decoder page/;
  const H = 'history-engine.ts';
  const rollback = /\(fail\) HPERF a throw before COMMIT rolls/, trust = /\(fail\) HPERF trust:/;
  const mutations: { name: string; file: string; kills: RegExp; assert: RegExp; from: string; to: string; from2?: string; to2?: string }[] = [
    // Rows encoded again, 32 fresh traversals each, results thrown away: data unchanged, work counter red.
    { name: 'PERF-REPEAT', file: H, kills: budget, assert: assertion('row-encode'),
      from: 'const rowText = b.rows.map(row => snapshot(row));',
      to: 'const rowText = b.rows.map(row => { const text = snapshot(row); for (let n = 0; n < 32; n++) this.encoder()(row, 1); return text; });' },
    // The binding is dropped: every use reads and verifies the live checkpoint again.
    { name: 'PERF-CP', file: H, kills: budget, assert: assertion('checkpoint-decode'),
      from: "const durableCheckpoint = () => live === undefined ? (live = this.get<V2LiveCheckpoint>('checkpoint', key, 'live')) : live;",
      to: "const durableCheckpoint = () => this.get<V2LiveCheckpoint>('checkpoint', key, 'live');" },
    // An instance-level checkpoint cache updated when the checkpoint is written, never cleared on rollback, read by get().
    { name: 'PERF-STALE-a', file: H, kills: rollback, assert: assertion('rollback-checkpoint'),
      from: "    if (kind === 'checkpoint') v2Enter('decode');\n",
      to: "    const stale = (this as unknown as { hperfStale?: Map<string, unknown> }).hperfStale;\n    if (kind === 'checkpoint' && id === 'live' && stale?.has(pane)) return stale.get(pane) as T;\n    if (kind === 'checkpoint') v2Enter('decode');\n",
      from2: '        live = undefined; // written: a later read in this command reads the new row\n',
      to2: '        live = undefined; ((this as unknown as { hperfStale?: Map<string, unknown> }).hperfStale ??= new Map()).set(key, cp);\n' },
    // One module-level encoder shared by every call: an edited descendant keeps its old text.
    { name: 'PERF-STALE-b', file: H, kills: /\(fail\) HPERF a descendant edited between two commits/, assert: assertion('fresh-commit'),
      from: '    const inner = streamCanonicalEncoder();',
      to: '    const inner = ((globalThis as { hperfEncoder?: (value: unknown) => string }).hperfEncoder ??= streamCanonicalEncoder());' },
    // H stops checking the write digest itself.
    { name: 'PERF-TRUST-digest', file: H, kills: trust, assert: assertion('trust-row'),
      from: "fhAssert(v2WriteDigest({ fence: r.fence, command: caller }, encode) === r.fence.digest, 'v2 write digest');",
      to: 'void v2WriteDigest; void encode;' },
    // H takes the caller's input as what S issued.
    { name: 'PERF-TRUST-issued', file: H, kills: trust, assert: assertion('trust-minted'),
      from: "const issued = this.hooks.inputReceipt?.((caller as Extract<V2WriteCommand, { kind: 'batch' }>).batch.input);",
      to: "const issued = { status: 'ok' as const, value: b.input };" },
    // The receipt is taken from a memo made before its checkpointId was set (the :2233 assignment no longer lands).
    { name: 'PERF-OUTPUT', file: H, kills: /\(fail\) HPERF a lost ACK after COMMIT/, assert: assertion('lost-ack-checkpoint-id'),
      from: '        live = undefined; // written: a later read in this command reads the new row\n',
      to: "        live = undefined; const memo = JSON.parse(snapshot(receipt)) as V2Receipt;\n        Object.defineProperty(receipt, 'checkpointId', { get: () => memo.checkpointId, set: () => {}, enumerable: true });\n" },
    // The checkpoint write leaves the transaction: it lands after the tx, even when the tx rolled back.
    { name: 'PERF-ATOMIC', file: H, kills: rollback, assert: assertion('rollback-checkpoint'),
      from: '        live = undefined; // written: a later read in this command reads the new row\n',
      to: "        live = undefined; queueMicrotask(() => { try { this.put('checkpoint', key, 'live', cp); } catch { /* closed */ } });\n" },
    // page() v2 remeasures the whole entry array: the count goes quadratic and the named budget case dies on page-encode.
    { name: 'PAGE-quadratic', file: H, kills: /\(fail\) HPERF page budget/, assert: assertion('page-encode'),
      from: 'size = running + eb',
      to: 'size = measure(entries) + eb' },
    // The same remeasure via bytes() is visible in the page() source, so the route guard fires before the count.
    { name: 'PAGE-quadratic-raw', file: H, kills: /\(fail\) HPERF page budget/, assert: assertion('page-encode-route'),
      from: 'size = running + eb',
      to: 'size = bytes(entries) + eb' },
    // Dropping the comma makes a page of maxBytes M-1 keep the second entry.
    { name: 'PAGE-no-comma', file: H, kills: /\(fail\) HPERF page bound/, assert: assertion('page-cut-k-1'),
      from: 'size = running + eb + (entries.length ? 1 : 0);',
      to: 'size = running + eb;' },
    // payloadBytes one byte short of the canonical page the reader returned.
    { name: 'PAGE-payload-stale', file: H, kills: /\(fail\) HPERF page bound/, assert: assertion('page-payload'),
      from: 'payloadBytes: running,',
      to: 'payloadBytes: running - 1,' },
  ];
  try {
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave4.test.ts'), join(root, 'server/tests/sqlite-history-wave4.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const core = join(root, 'node_modules/@thumbmux/core'); mkdirSync(core, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(core, 'src'), { recursive: true });
    writeFileSync(join(core, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const run = async (name: string) => {
      const child = Bun.spawn([process.execPath, 'test', ...childTestTimeoutArgs, './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', '^HPERF '],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      console.log('HPERF_MUTANT', JSON.stringify({ name, exit, failed: output.match(/^\(fail\) .*$/gm) ?? [],
        asserted: output.match(/^error: HPERF-ASSERT .*$/gm) ?? [], thrown: output.match(/^(?:\d+ \| .*)?\b(?:TypeError|ReferenceError)\b.*$/gm) ?? [], summary: output.slice(-600) }));
      expect(output).not.toMatch(/SyntaxError|ParseError|Cannot find module|timed out/);
      return { exit, output };
    };
    const clean = await run('clean-before'); expect(clean.exit, clean.output).toBe(0); expect(clean.output).toMatch(/\b9 pass\b/);
    for (const m of mutations) {
      const file = join(root, 'server/src', m.file), original = readFileSync(file, 'utf8');
      expect(original.split(m.from).length).toBe(2);
      let mutant = original.replace(m.from, m.to);
      if (m.from2) { expect(mutant.split(m.from2).length).toBe(2); mutant = mutant.replace(m.from2, m.to2!); }
      try {
        writeFileSync(file, mutant);
        const red = await run(m.name);
        expect(red.exit).not.toBe(0);
        expect(red.output).toMatch(m.kills);
        expect(red.output).toMatch(m.assert);
        expect(red.output).not.toMatch(/\b(?:TypeError|ReferenceError)\b/);
      } finally { writeFileSync(file, original); }
    }
    const after = await run('clean-after'); expect(after.exit, after.output).toBe(0); expect(after.output).toMatch(/\b9 pass\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);
