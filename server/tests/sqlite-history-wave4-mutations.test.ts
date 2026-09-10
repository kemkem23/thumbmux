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
    const after = await run('clean-after');
    expect(after.code).toBe(0);
    expect(after.tests).toBe(before.tests);
    console.log('WAVE4_MUTATION_RESULT', JSON.stringify({
      killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true, cleanTests: before.tests,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
