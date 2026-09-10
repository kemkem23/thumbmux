/**
 * Wave 5 mutation proof, same standard as waves 2-4.
 *
 * Every mutant lives in a throwaway copy of the package: the working tree is
 * never edited. The string a mutant edits must exist before it is edited, a
 * mutant counts as killed only when a real `bun:test` run reports `(fail)` or bun 1.3's `N fail`,
 * a death caused by a SyntaxError, ParseError or missing module is rejected,
 * a round that ran zero tests is rejected, and the clean tree must pass before
 * the first mutant and after the last one with the same test count.
 */
import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Mutant = { name: string; pattern: string; file: string; from: string; to: string };

test('wave5 authoritative-writer detectors kill every injected fault and the clean tree passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..'), root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-wave5-mutants-'));
  const mutants: Mutant[] = [
    // --- a mirror failure must be loud, and the receipt stays authoritative ---
    { name: 'mirror-failure-silent', pattern: 'loud fault', file: 'sqlite-history/authoritative.ts',
      from: "      this.store.persistFault(sessionId, 'export-failed',",
      to: "      if (false) this.store.persistFault(sessionId, 'export-failed'," },
    // --- the watermark may never lead the durable seq files ---
    { name: 'watermark-before-seq-file', pattern: 'loud fault', file: 'sqlite-history/authoritative.ts',
      from: '      this.exportSeq(sessionId, receipt.context.revision);\n      this.advanceWatermark(sessionId);',
      to: '      this.advanceWatermark(sessionId);\n      this.exportSeq(sessionId, receipt.context.revision);' },
    // --- replay must refuse a byte-different already-exported seq ---
    { name: 'resume-accepts-conflict', pattern: 'tampering is caught', file: 'sqlite-history/authoritative.ts',
      from: "      if (sha(readFileSync(path)) !== sha(data)) throw new Error('mirror-conflict');",
      to: "      if (false) throw new Error('mirror-conflict');" },
    { name: 'mirror-audit-skips-digest', pattern: 'tampering is caught', file: 'sqlite-history/authoritative.ts',
      from: "    if (rowsDigest(record.rows) !== record.rowsSha256) throw new Error('mirror-record-digest');",
      to: "    if (false) throw new Error('mirror-record-digest');" },
    // --- a lag with no recorded failure must still be reported ---
    { name: 'status-hides-lag', pattern: 'tampering is caught', file: 'sqlite-history/authoritative.ts',
      from: '    if (exportedRevision < targetRevision) {\n      if (!this.lagSince.has(sessionId)) this.lagSince.set(sessionId, this.now());\n    } else this.lagSince.delete(sessionId);',
      to: '    if (exportedRevision < targetRevision) {\n      void 0;\n    } else this.lagSince.delete(sessionId);' },
    // --- the standalone mirror detector must cry past its budget ---
    { name: 'inspect-mirror-null', pattern: 'loud fault', file: 'sqlite-history/detectors.ts',
      from: "  return exportedRevision<targetRevision && now-lagSince>30000 ? {issue_id:randomUUID(),sessionId,detector:'mirror-stale',expected:targetRevision,observed:exportedRevision,timestamp:now,missing_count:null}:null;",
      to: '  return null;' },
    // --- the rollback bundle verification must not be optional ---
    { name: 'rollback-skips-jsonl-oracle', pattern: 'tampered rollback bundle', file: 'sqlite-history/authoritative.ts',
      from: "    compareText(readSealedHistoryOracle(directory, 'file-jsonl').rows, 'jsonl');",
      to: '    void 0;' },
    // --- the rollback barrier must hold ---
    { name: 'barrier-ignored', pattern: 'rollback to C2', file: 'sqlite-history/authoritative.ts',
      from: "    if (this.barrier) throw new Error('authoritative-barrier-held');",
      to: "    if (false) throw new Error('authoritative-barrier-held');" },
    // --- the legacy projection must not drop or rewrite rows ---
    { name: 'exporter-drops-last-row', pattern: 'roundtrip|rollback to C2', file: 'sqlite-history/transfer.ts',
      from: "    files.set('history.jsonl',rows.map(r=>JSON.stringify({line:r.line_no,text:r.text})).join('\\n')+(rows.length?'\\n':''));",
      to: "    files.set('history.jsonl',rows.slice(0,Math.max(0,rows.length-1)).map(r=>JSON.stringify({line:r.line_no,text:r.text})).join('\\n')+(rows.length>1?'\\n':''));" },
    { name: 'exporter-rewrites-blank-rows', pattern: 'roundtrip', file: 'sqlite-history/transfer.ts',
      from: "    for(let i=0;i<rows.length;i+=500)files.set(`${String(rows[i].line_no).padStart(12,'0')}.log`,rows.slice(i,i+500).map(r=>r.text+'\\n').join(''));",
      to: "    for(let i=0;i<rows.length;i+=500)files.set(`${String(rows[i].line_no).padStart(12,'0')}.log`,rows.slice(i,i+500).map(r=>(r.text===''?' ':r.text)+'\\n').join(''));" },
    // --- red proofs that the wave-5 tests themselves can go red ---
    { name: 'store-drops-one-row', pattern: 'kill-point', file: 'sqlite-history/store.ts',
      from: '      rows.forEach((r,i)=>insert.run(sid,r.line_no,r.kind,r.text,seq,i));',
      to: '      rows.forEach((r,i)=>{if(i)insert.run(sid,r.line_no,r.kind,r.text,seq,i);});' },
    { name: 'write-failure-unreported', pattern: 'database faults', file: 'sqlite-history/store.ts',
      from: "          this.report(sid,'write-failed','committed transaction',String(error)); throw error;",
      to: '          throw error;' },
    { name: 'future-schema-accepted', pattern: 'future schema', file: 'sqlite-history/store.ts',
      from: "      if (version > SCHEMA_VERSION) throw new Error('future-schema');",
      to: "      if (false) throw new Error('future-schema');" },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-wave5.test.ts'), join(root, 'server/tests/sqlite-history-wave5.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/authoritative-crash-worker.ts'), join(root, 'server/tests/sqlite-history/authoritative-crash-worker.ts'));
    const copiedCore = join(root, 'node_modules/@thumbmux/core'); mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '\n{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '\n{"type":"module"}\n');
    const run = async (name: string, pattern?: string) => {
      const args = [process.execPath, 'test', './server/tests/sqlite-history-wave5.test.ts'];
      if (pattern) args.push('--test-name-pattern', pattern);
      const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      const ran = /Ran (\d+) tests?/.exec(output);
      // bun 1.3 prints "1 fail"; older reporters printed "(fail)". Either is a real test death.
      const failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      console.log('WAVE5_MUTANT_RUN', JSON.stringify({ name, code, tests: Number(ran?.[1] ?? 0), failed }));
      if (code !== 0 && !failed) console.log('WAVE5_MUTANT_INVALID_OUTPUT', output.slice(-4000));
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
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('WAVE5_MUTATION_RESULT', JSON.stringify({
      killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 600_000);
