/** Explicit bun-test support entrypoint; invoke only through the existing cage.
 * No child runner, shell, namespace, install, environment override or path argv.
 * The runner must compare PUBLIC_LAYOUT_* with the direct whole-file results.
 */
import { afterAll, afterEach, expect } from 'bun:test';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const targets = ['server/tests/tmux-capture-normalize.test.ts', 'server/tests/sqlite-history-wave2.test.ts'] as const;
const important = ['B1c strict contract types compile',
  'I2 FIX1 A-B4: hot pane 20000 rows/s plus deterministic burst beside 21 panes: backpressure on the hot pane only, no loss issue, store never stopped'];
const fixture = 'server/tests/fixtures/newarch-contract-fixture.ts';
const workspaces = ['core', 'server', 'svelte', 'app', 'demo'];
const originalCwd = process.cwd();
// /tmp belongs to the caller's existing namespace. Do not inherit TMPDIR from
// a monorepo ancestor, where missing dependencies could accidentally resolve.
const root = mkdtempSync('/tmp/thumbmux-public-layout-');
const sourceInventory: Array<{ path: string; sha256: string; bytes: number }> = [];
const dependencyInventory: Array<{ path: string; sha256?: string; bytes?: number; target?: string }> = [];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function inside(base: string, path: string): string {
  const rel = relative(base, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error(`public layout escape: ${path}`);
  return rel;
}
function copyFile(source: string, destination: string, inventory: typeof dependencyInventory): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination); // fresh inode, never a hardlink to prepared inputs
  const before = readFileSync(source), after = readFileSync(destination);
  if (!before.equals(after)) throw Error(`public layout copy mismatch: ${source}`);
  inventory.push({ path: inside(root, destination), sha256: sha(after), bytes: after.length });
}
function copySources(dir: string): void {
  for (const name of readdirSync(dir).sort()) {
    const source = join(dir, name), rel = inside(sourceRoot, source);
    if (['.git', 'node_modules', '__pycache__'].includes(name)
      || rel === 'git-dist' || workspaces.some(w => rel === `${w}/dist`)
      || /\.(?:pyc|pyo|tsbuildinfo)$/.test(name)) continue;
    if (name === '.env' || name.startsWith('.env.')) throw Error(`unexpected environment file: ${rel}`);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw Error(`unexpected source link: ${rel}`);
    if (stat.isDirectory()) copySources(source);
    else if (stat.isFile()) copyFile(source, join(root, rel), sourceInventory);
    else throw Error(`unexpected source file type: ${rel}`);
  }
}
// Only packages needed by the two complete suites, their compiler, and the
// unchanged bunfig preloads. Resolve every transitive edge from its package,
// stopping at sourceRoot, so a monorepo node_modules can never satisfy it.
function locatePackage(from: string, name: string): string | null {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw Error(`invalid dependency name: ${name}`);
  for (let at = from; ; at = dirname(at)) {
    inside(sourceRoot, at);
    const candidate = join(at, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      inside(sourceRoot, realpathSync(candidate));
      return candidate;
    }
    if (at === sourceRoot) return null;
  }
}
const copiedPackages = new Set<string>(), links = new Map<string, string>();
const absentOptional: string[] = [];
function copyDependencyTree(dir: string): void {
  for (const name of readdirSync(dir).sort()) {
    if (['node_modules', '.git', '.cache', '__pycache__'].includes(name)) continue;
    const source = join(dir, name), dest = join(root, inside(sourceRoot, source)), stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      // Package-internal links must resolve inside the selected package tree;
      // dependency edges themselves are reconstructed by copyPackage below.
      const target = realpathSync(source);inside(dir, target);
      links.set(dest, join(root, inside(sourceRoot, target)));
    } else if (stat.isDirectory()) copyDependencyTree(source);
    else if (stat.isFile()) copyFile(source, dest, dependencyInventory);
    else throw Error(`unexpected dependency file type: ${source}`);
  }
}
function copyPackage(from: string, name: string, optional = false): void {
  const installed = locatePackage(from, name);
  if (!installed) {
    if (optional) { absentOptional.push(`${inside(sourceRoot, from)}:${name}`); return; }
    throw Error(`missing package dependency: ${name} from ${from}`);
  }
  const canonical = realpathSync(installed), rel = inside(sourceRoot, canonical);
  const destination = join(root, rel), alias = join(root, inside(sourceRoot, installed));
  if (alias !== destination) links.set(alias, destination);
  if (copiedPackages.has(canonical)) return;
  copiedPackages.add(canonical);
  const workspace = workspaces.includes(rel);
  if (!workspace) {
    if (!rel.split('/').includes('node_modules')) throw Error(`unexpected dependency source: ${canonical}`);
    copyDependencyTree(canonical);
  }
  const manifest = JSON.parse(readFileSync(join(canonical, 'package.json'), 'utf8'));
  for (const dep of Object.keys(manifest.dependencies ?? {}).sort()) {
    copyPackage(canonical, dep, dep in (manifest.optionalDependencies ?? {}));
  }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {}).sort()) copyPackage(canonical, dep, true);
  for (const dep of Object.keys(manifest.peerDependencies ?? {}).sort()) {
    copyPackage(canonical, dep, manifest.peerDependenciesMeta?.[dep]?.optional === true);
  }
}
function verifyContainedTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    inside(root, realpathSync(path));
    if (stat.isDirectory()) verifyContainedTree(path);
  }
}
let expectedCases = 0, completedCases = 0, loadedFiles = 0;
afterEach(() => { completedCases++; });
afterAll(() => {
  try {
    console.log('PUBLIC_LAYOUT_COMPLETE', JSON.stringify({ expectedCases, completedCases, loadedFiles, targets, important }));
    expect(loadedFiles).toBe(2);expect(expectedCases).toBeGreaterThan(0);expect(completedCases).toBe(expectedCases);
  } finally { process.chdir(originalCwd);rmSync(root, { recursive: true, force: true }); }
});
try {
  for (let at = dirname(root); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules')) || existsSync(join(at, 'packages/thumbmux'))
      || existsSync(join(at, 'docs/tasks'))) throw Error(`public layout has contaminated ancestor: ${at}`);
    if (at === dirname(at)) break;
  }
  copySources(sourceRoot);
  copyPackage(sourceRoot, 'typescript');
  copyPackage(join(sourceRoot, 'server'), '@types/bun');
  copyPackage(join(sourceRoot, 'server'), '@thumbmux/core');
  copyPackage(join(sourceRoot, 'svelte'), 'svelte');
  copyPackage(join(sourceRoot, 'svelte'), 'happy-dom');
  for (const [path, target] of links) {
    inside(root, path);inside(root, target);mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), target), path);
    dependencyInventory.push({ path: inside(root, path), target: inside(root, target) });
  }
  verifyContainedTree(root);
  const require = createRequire(join(root, 'package.json'));
  const compiler = realpathSync(require.resolve('typescript/bin/tsc'));
  inside(root, compiler);inside(root, realpathSync(join(root, fixture)));
  const negativeDirectives = readFileSync(join(root, fixture), 'utf8').match(/@ts-expect-error/g)?.length ?? 0;
  expect(negativeDirectives).toBe(45);
  sourceInventory.sort((a,b) => a.path.localeCompare(b.path));
  dependencyInventory.sort((a,b) => a.path.localeCompare(b.path));
  const inventory = JSON.stringify({ sources: sourceInventory, dependencies: dependencyInventory, absentOptional });
  writeFileSync(join(root, 'public-layout-inventory.json'), inventory + '\n');
  console.log('PUBLIC_LAYOUT_FILES', inventory);
  console.log('PUBLIC_LAYOUT_INVENTORY', JSON.stringify({ root, inventorySha256: sha(inventory),
    sourceSha256: sha(JSON.stringify(sourceInventory)), sourceFiles: sourceInventory.length,
    dependencyFiles: dependencyInventory.length, packages: [...copiedPackages].map(p => inside(sourceRoot,p)).sort(),
    absentOptional, compiler, fixture: join(root, fixture), negativeDirectives }));
  // Parse registration declarations, not test bodies. Expand only the literal
  // for-of tables used by these frozen suites; unsupported registration fails.
  const tsEntry = realpathSync(require.resolve('typescript'));inside(root, tsEntry);
  const ts = (await import(pathToFileURL(tsEntry).href)).default;
  function namesFor(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(join(root,file),'utf8'), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    function literal(node: any, bindings: Record<string,string>): string {
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
      if (ts.isIdentifier(node) && node.text in bindings) return bindings[node.text]!;
      if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s:any) => literal(s.expression,bindings)+s.literal.text).join('');
      throw Error(`unsupported registration literal in ${file}`);
    }
    function statements(nodes: readonly any[], prefix: string, bindings: Record<string,string>): void {
      for (const node of nodes) {
        if (ts.isForOfStatement(node)) {
          if (!ts.isArrayLiteralExpression(node.expression) || !ts.isVariableDeclarationList(node.initializer)
            || node.initializer.declarations.length !== 1 || !ts.isIdentifier(node.initializer.declarations[0].name)) {
            throw Error(`unsupported registration loop in ${file}`);
          }
          const key = node.initializer.declarations[0].name.text;
          for (const value of node.expression.elements) statements(ts.isBlock(node.statement)?node.statement.statements:[node.statement],prefix,{...bindings,[key]:literal(value,bindings)});
        } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
          const call = node.expression;
          if (ts.isIdentifier(call.expression) && ['test','describe'].includes(call.expression.text)) {
            const name = prefix + literal(call.arguments[0],bindings);
            if (call.expression.text === 'test') names.push(name);
            else {
              const callback = call.arguments[1];
              if (!callback || !ts.isBlock(callback.body)) throw Error(`unsupported describe in ${file}`);
              statements(callback.body.statements,name+' > ',bindings);
            }
          } else if (/^(?:test|describe)\b/.test(call.expression.getText(source))) throw Error(`unsupported registration modifier in ${file}`);
        }
      }
    }
    statements(source.statements,'',{});
    if (!names.length) throw Error(`no test registrations in ${file}`);
    return names;
  }
  const registrations = targets.map(path => ({ path, sha256: sha(readFileSync(join(root,path))), names: namesFor(path) }));
  for (const name of important) expect(registrations.flatMap(r=>r.names).some(n=>n===name || n.endsWith(' > '+name))).toBe(true);
  expectedCases = registrations.reduce((n,r)=>n+r.names.length,0);
  console.log('PUBLIC_LAYOUT_CASES', JSON.stringify({ expectedCases, registrations }));
  // JS only from copied source. B1c independently invokes the real compiler
  // for declarations and all strict negative types; no host dist is copied.
  process.chdir(root);
  const preloads = Bun.TOML.parse(readFileSync(join(root,'bunfig.toml'),'utf8')).test as { preload: string[] };
  expect(preloads.preload).toEqual(['./scripts/tmux-isolation-guard.ts','./svelte/tests/preload.ts']);
  // Admission first, before build or test module bodies.
  for (const preload of preloads.preload) {
    const path = realpathSync(join(root,preload));inside(root,path);
    await import(pathToFileURL(path).href);
  }
  const build = await Bun.build({ entrypoints: [join(root,'core/src/index.ts')], outdir: join(root,'core/dist'), target: 'node' });
  if (!build.success) throw Error(`public core build failed: ${build.logs.map(String).join('\n')}`);
  if (!build.outputs.length) throw Error('public core build produced no outputs');
  const generated = [];
  for (const output of build.outputs) {
    inside(root,realpathSync(output.path));generated.push({ path: inside(root,output.path),sha256:sha(readFileSync(output.path)) });
  }
  const runtimeCore=realpathSync(createRequire(join(root,'server/package.json')).resolve('@thumbmux/core'));
  inside(root,runtimeCore);
  console.log('PUBLIC_LAYOUT_BUILD', JSON.stringify({ generated, runtimeCore }));
  for (const target of targets) {
    const path = realpathSync(join(root,target));inside(root,path);
    await import(pathToFileURL(path).href);loadedFiles++;
    console.log('PUBLIC_LAYOUT_LOADED', JSON.stringify({ path, sha256:sha(readFileSync(path)) }));
  }
  expect(loadedFiles).toBe(2);
} catch (error) {
  process.chdir(originalCwd);rmSync(root, { recursive: true, force: true });throw error;
}
