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
      const args = [process.execPath, 'test', './server/tests/sqlite-history-wave4.test.ts'];
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
    const run = async (pattern: string) => {
      const child = Bun.spawn([process.execPath, 'test', './server/tests/sqlite-history-wave4.test.ts', '--test-name-pattern', pattern],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, output: out + err };
    };
    expect((await run('stream-first H')).exit).toBe(0);
    for (const mutation of mutations) {
      expect(original.includes(mutation.from)).toBe(true);
      writeFileSync(file, original.replaceAll(mutation.from, mutation.to));
      const result = await run(mutation.pattern);
      console.log('STREAM_H_MUTANT', mutation.name, result.exit, result.output);
      expect(result.exit).not.toBe(0);
      expect(result.output).toMatch(/\(\s*fail\s*\)|\b[1-9]\d* fail\b/);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
      writeFileSync(file, original);
    }
    expect((await run('stream-first H')).exit).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
        const child=Bun.spawn([process.execPath,'test',`./packages/thumbmux/server/tests/${m.test??'tmux-capture-normalize.test.ts'}`,'--test-name-pattern',m.pattern],
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
      const child=Bun.spawn([process.execPath,'test','./server/tests/sqlite-history-wave4.test.ts','--test-name-pattern',pattern],{cwd:root,stdout:'pipe',stderr:'pipe'});
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
    { name: 'v2-omit-atomic-rows', from: "this.append(key, revision, 'row', streamCanonical(row.id), row.id.segmentId, row);", to: '/* mutant loses rows behind durable receipt */' },
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
      const child = Bun.spawn([process.execPath, 'test', './server/tests/sqlite-history-wave4.test.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
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
