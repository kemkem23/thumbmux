import { test, expect } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Edit = { file: string; from: string; to: string };
type Mutant = { name: string; pattern: string; edits: Edit[] };

test('orphan sidecar detectors kill take-fix-out, blind-orphan, and blind-manifest-count; clean tree passes before and after', async () => {
  const pkg = resolve(import.meta.dir, '../..');
  const root = mkdtempSync(join(tmpdir(), 'thumbmux-sqlite-orphan-sidecar-mutants-'));
  const mutants: Mutant[] = [
    {
      name: 'take-fix-out',
      pattern: 'orphan sidecar lifecycle-binding.json imports green',
      edits: [{
        file: 'transfer.ts',
        from: "return name.endsWith('.json') && name!=='manifest.json' && !listed.has(name) && !HOST_CHUNKS_SIDECARS.has(name);",
        to: "return name.endsWith('.json') && name!=='manifest.json' && !listed.has(name);",
      }],
    },
    {
      name: 'blind-orphan-chunk',
      pattern: 'orphan real garbage json still fails at orphan-chunk',
      edits: [{
        file: 'transfer.ts',
        from: "if([...files.keys()].some(n=>isHostChunksOrphanJson(n,listed)))throw new Error('orphan-chunk');",
        to: "if(false)throw new Error('orphan-chunk');",
      }, {
        file: 'rehearsal.ts',
        from: 'if ([...files.keys()].some(name => isHostChunksOrphanJson(name, listed))) throw new Error(\'oracle-orphan-chunk\');',
        to: "if (false) throw new Error('oracle-orphan-chunk');",
      }],
    },
    {
      name: 'blind-manifest-count',
      pattern: 'orphan cut-row still fails at manifest-count',
      edits: [{
        file: 'transfer.ts',
        from: "if(result.rows.length!==manifest.totalLines)throw new Error('manifest-count');",
        to: "if(false)throw new Error('manifest-count');",
      }],
    },
  ];
  try {
    mkdirSync(join(root, 'server'), { recursive: true });
    cpSync(join(pkg, 'server/src'), join(root, 'server/src'), { recursive: true });
    mkdirSync(join(root, 'server/tests/sqlite-history'), { recursive: true });
    cpSync(join(pkg, 'server/tests/sqlite-history-orphan-sidecar.test.ts'), join(root, 'server/tests/sqlite-history-orphan-sidecar.test.ts'));
    cpSync(join(pkg, 'server/tests/sqlite-history/helpers.ts'), join(root, 'server/tests/sqlite-history/helpers.ts'));
    const copiedCore = join(root, 'node_modules/@thumbmux/core');
    mkdirSync(copiedCore, { recursive: true });
    cpSync(join(pkg, 'core/src'), join(copiedCore, 'src'), { recursive: true });
    writeFileSync(join(copiedCore, 'package.json'), '{"name":"@thumbmux/core","type":"module","exports":"./src/index.ts"}\n');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    const run = async (name: string, pattern?: string) => {
      const args = [process.execPath, 'test', './server/tests/sqlite-history-orphan-sidecar.test.ts'];
      if (pattern) args.push('--test-name-pattern', pattern);
      const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      const failed = /\(\s*fail\s*\)|\b[1-9]\d* fail\b/.test(output);
      const failCount = output.match(/(\d+) fail/)?.[1] ?? (failed ? '1' : '0');
      console.log('ORPHAN_SIDECAR_MUTANT_RUN', JSON.stringify({ name, code, failCount, ran: /Ran \d+ tests?/.test(output), failed }));
      if (code !== 0 && !failed) console.log('ORPHAN_SIDECAR_MUTANT_INVALID_OUTPUT', output);
      return { code, output, failed, failCount };
    };
    const cleanBefore = await run('clean-before');
    expect(cleanBefore.code).toBe(0);
    for (const mutant of mutants) {
      const originals = new Map<string, string>();
      for (const edit of mutant.edits) {
        const path = join(root, 'server/src/sqlite-history', edit.file);
        const current = readFileSync(path, 'utf8');
        originals.set(path, current);
        expect(current.includes(edit.from)).toBe(true);
        writeFileSync(path, current.replace(edit.from, edit.to));
      }
      const result = await run(mutant.name, mutant.pattern);
      for (const [path, contents] of originals) writeFileSync(path, contents);
      expect(result.code).not.toBe(0);
      expect(result.failed).toBe(true);
      expect(result.output).not.toMatch(/SyntaxError|ParseError|Cannot find module/);
    }
    const cleanAfter = await run('clean-after');
    expect(cleanAfter.code).toBe(0);
    console.log('ORPHAN_SIDECAR_MUTATION_RESULT', JSON.stringify({ killed: mutants.length, survived: 0, cleanBefore: true, cleanAfter: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);
