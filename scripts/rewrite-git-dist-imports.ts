import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const PACKAGES = ["core", "server", "svelte"] as const;
export type PublicSubpackage = (typeof PACKAGES)[number];

export type PublicExportManifest = {
  /** Every public symbol, including type-only exports. */
  declarations: string[];
  /** Public symbols with a JavaScript runtime value. */
  runtime: string[];
  /** Runtime exports whose source value has a call/construct signature. */
  callable: string[];
};

export type GitDistExportManifests = Record<PublicSubpackage, PublicExportManifest>;
const REWRITE_ROOTS = ["git-dist/server", "git-dist/svelte"] as const;
/**
 * Quoted bare package specifier (`"…"`, `'…'`, or `` `…` ``). Comments that
 * mention the package name without quotes are intentionally ignored — those
 * are documentation, not import graph edges a consumer must resolve.
 */
const BARE_CORE_SPECIFIER = /(["'`])@thumbmux\/core\1/g;
/** Text-ish extensions scanned for leftover bare core imports under git-dist. */
const SCAN_EXTENSIONS = /\.(?:[cm]?[jt]sx?|d\.ts|svelte|map|json|css|html|mts|cts)$/i;

export type RewrittenSpecifier = {
  /** Path relative to package root, POSIX separators. */
  file: string;
  /** Relative specifier written into `file` (e.g. `../core/index.js`). */
  specifier: string;
};

export type GitDistRewriteResult = {
  files: string[];
  replacements: number;
  rewrittenSpecifiers: RewrittenSpecifier[];
};

type InspectedEntry = PublicExportManifest & {
  path: string;
};

function compilerOptions(allowJs: boolean): ts.CompilerOptions {
  return {
    allowArbitraryExtensions: true,
    allowJs,
    checkJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function bindingNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  }
}

function directlyExportedNames(statement: ts.Statement): string[] {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, names);
    }
    return names;
  }
  if (
    ts.isClassDeclaration(statement)
    || ts.isFunctionDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isEnumDeclaration(statement)
    || ts.isModuleDeclaration(statement)
    || ts.isImportEqualsDeclaration(statement)
  ) {
    if (isDefault) return ["default"];
    return statement.name ? [statement.name.text] : [];
  }
  return [];
}

function referencedSourceFile(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
): ts.SourceFile | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
  if (!moduleSymbol) return undefined;
  const target = resolveAlias(checker, moduleSymbol);
  return target.declarations?.find(ts.isSourceFile)
    ?? (target.valueDeclaration && ts.isSourceFile(target.valueDeclaration)
      ? target.valueDeclaration
      : undefined);
}

/** Follow live value-export paths; type-only paths contribute declarations only. */
function runtimeExportsFromSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  cache = new Map<ts.SourceFile, Set<string>>(),
  visiting = new Set<ts.SourceFile>(),
): Set<string> {
  const cached = cache.get(sourceFile);
  if (cached) return new Set(cached);
  if (visiting.has(sourceFile)) return new Set();
  visiting.add(sourceFile);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    visiting.delete(sourceFile);
    return new Set();
  }
  const symbols = checker.getExportsOfModule(moduleSymbol);
  const byName = new Map(symbols.map((symbol) => [symbol.getName(), symbol]));
  const runtime = new Set<string>();
  const addValue = (name: string): void => {
    const symbol = byName.get(name);
    if (symbol && (resolveAlias(checker, symbol).flags & ts.SymbolFlags.Value)) {
      runtime.add(name);
    }
  };

  for (const statement of sourceFile.statements) {
    for (const name of directlyExportedNames(statement)) addValue(name);
    if (ts.isExportAssignment(statement)) {
      addValue(statement.isExportEquals ? "export=" : "default");
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;

    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        const isSvelteDefault = Boolean(
          statement.moduleSpecifier
          && ts.isStringLiteral(statement.moduleSpecifier)
          && statement.moduleSpecifier.text.endsWith(".svelte")
          && specifier.propertyName?.text === "default",
        );
        if (isSvelteDefault) runtime.add(specifier.name.text);
        else addValue(specifier.name.text);
      }
      continue;
    }

    if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
      runtime.add(statement.exportClause.name.text);
      continue;
    }

    if (!statement.moduleSpecifier) continue;
    const targetFile = referencedSourceFile(checker, statement.moduleSpecifier);
    if (targetFile) {
      for (const name of runtimeExportsFromSourceFile(targetFile, checker, cache, visiting)) {
        if (name !== "default" && byName.has(name)) runtime.add(name);
      }
      continue;
    }
    const targetSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (targetSymbol) {
      for (const symbol of checker.getExportsOfModule(resolveAlias(checker, targetSymbol))) {
        if (symbol.getName() !== "default"
          && (resolveAlias(checker, symbol).flags & ts.SymbolFlags.Value)
          && byName.has(symbol.getName())) {
          runtime.add(symbol.getName());
        }
      }
    }
  }

  visiting.delete(sourceFile);
  cache.set(sourceFile, runtime);
  return new Set(runtime);
}

function componentDefaultExports(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.endsWith(".svelte")) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly) continue;
      if (specifier.propertyName?.text === "default") names.add(specifier.name.text);
    }
  }
  return names;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function symbolIsCallable(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const target = resolveAlias(checker, symbol);
  if (target.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class)) return true;
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (!declaration) return false;
  try {
    const type = checker.getTypeOfSymbolAtLocation(target, declaration);
    return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
      || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
  } catch {
    return false;
  }
}

function inspectEntry(path: string, javascriptRuntime = false): InspectedEntry {
  if (!existsSync(path)) throw new Error(`missing public export entrypoint: ${path}`);
  const program = ts.createProgram([path], compilerOptions(javascriptRuntime));
  const sourceFile = program.getSourceFile(path);
  if (!sourceFile) throw new Error(`could not load public export entrypoint: ${path}`);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`could not inspect public export entrypoint: ${path}`);

  const symbols = checker.getExportsOfModule(moduleSymbol);
  const declarations = symbols.map((symbol) => symbol.getName()).sort();
  const runtime = javascriptRuntime
    ? [...declarations]
    : [...runtimeExportsFromSourceFile(sourceFile, checker)].sort();
  const runtimeSet = new Set(runtime);
  const callable = new Set(componentDefaultExports(sourceFile));
  for (const symbol of symbols) {
    if (runtimeSet.has(symbol.getName()) && symbolIsCallable(checker, symbol)) {
      callable.add(symbol.getName());
    }
  }

  return {
    path,
    declarations,
    runtime,
    callable: [...callable].filter((name) => runtimeSet.has(name)).sort(),
  };
}

/**
 * Read the canonical source barrel rather than maintaining an export-name
 * inventory. TypeScript's checker follows `export *`, named aliases, and
 * type-only symbols, so every future public export automatically joins the
 * contract that git-dist must preserve.
 */
export function derivePublicExportManifest(
  sourceRoot: string,
  packageName: PublicSubpackage,
): PublicExportManifest {
  const entry = resolve(sourceRoot, packageName, "src/index.ts");
  const { declarations, runtime, callable } = inspectEntry(entry);
  return { declarations, runtime, callable };
}

function missingNames(expected: readonly string[], actual: readonly string[]): string[] {
  const actualNames = new Set(actual);
  return expected.filter((name) => !actualNames.has(name));
}

/**
 * Compare canonical source barrels with the assembled aggregate, including
 * declaration-only exports and JavaScript callability. This is deliberately
 * name-list-free: the barrels are the single source of truth.
 */
export function assertGitDistExportParity(
  distRoot = PACKAGE_ROOT,
  sourceRoot = distRoot,
): GitDistExportManifests {
  const manifests = {} as GitDistExportManifests;
  for (const packageName of PACKAGES) {
    const expected = derivePublicExportManifest(sourceRoot, packageName);
    manifests[packageName] = expected;

    const declarations = inspectEntry(
      resolve(distRoot, "git-dist", packageName, "index.d.ts"),
    );
    const runtime = inspectEntry(
      resolve(distRoot, "git-dist", packageName, "index.js"),
      true,
    );

    const missingDeclarations = missingNames(expected.declarations, declarations.declarations);
    if (missingDeclarations.length > 0) {
      throw new Error(
        `${packageName} declaration exports missing from git-dist: ${missingDeclarations.join(", ")}`,
      );
    }

    const missingValueDeclarations = missingNames(expected.runtime, declarations.runtime);
    if (missingValueDeclarations.length > 0) {
      throw new Error(
        `${packageName} value declarations missing from git-dist: ${missingValueDeclarations.join(", ")}`,
      );
    }

    const missingCallableDeclarations = missingNames(expected.callable, declarations.callable);
    if (missingCallableDeclarations.length > 0) {
      throw new Error(
        `${packageName} callable declarations are not callable in git-dist: ${missingCallableDeclarations.join(", ")}`,
      );
    }

    const missingRuntime = missingNames(expected.runtime, runtime.runtime);
    if (missingRuntime.length > 0) {
      throw new Error(
        `${packageName} runtime exports missing from git-dist: ${missingRuntime.join(", ")}`,
      );
    }

    const missingCallable = missingNames(expected.callable, runtime.callable);
    if (missingCallable.length > 0) {
      throw new Error(
        `${packageName} callable exports are not callable in git-dist: ${missingCallable.join(", ")}`,
      );
    }
  }
  return manifests;
}

function namedImports(
  names: readonly string[],
  packageName: PublicSubpackage,
  kind = "export",
): Array<{ imported: string; local: string }> {
  return names.map((imported, index) => {
    if (!/^[$A-Z_a-z][$\w]*$/.test(imported)) {
      throw new Error(`unsupported non-identifier export name in ${packageName}: ${imported}`);
    }
    return { imported, local: `__thumbmux_${packageName}_${kind}_${index}` };
  });
}

function renderTypeExportGuard(
  manifests: GitDistExportManifests,
  packageNames: readonly PublicSubpackage[] = PACKAGES,
): string {
  const sections = packageNames.map((packageName) => {
    const manifest = manifests[packageName];
    const runtimeNames = new Set(manifest.runtime);
    const valueImports = namedImports(manifest.runtime, packageName, "value");
    const typeImports = namedImports(
      manifest.declarations.filter((name) => !runtimeNames.has(name)),
      packageName,
      "type",
    );
    const specifier = JSON.stringify(`thumbmux/${packageName}`);
    return [
      ...(valueImports.length > 0
        ? [
          "import {",
          ...valueImports.map(({ imported, local }) => `  ${imported} as ${local},`),
          `} from ${specifier};`,
        ]
        : []),
      ...(typeImports.length > 0
        ? [
          "import type {",
          ...typeImports.map(({ imported, local }) => `  ${imported} as ${local},`),
          `} from ${specifier};`,
        ]
        : []),
      "void [",
      ...valueImports.map(({ local }) => `  ${local},`),
      "];",
    ].join("\n");
  });
  return `${sections.join("\n\n")}\n\nexport {};\n`;
}

function renderNodeRuntimeGuard(manifests: GitDistExportManifests): string {
  const expected = Object.fromEntries(
    (["core", "server"] as const).map((packageName) => [packageName, {
      runtime: manifests[packageName].runtime,
      callable: manifests[packageName].callable,
    }]),
  );
  return [
    'import * as core from "thumbmux/core";',
    'import * as server from "thumbmux/server";',
    "",
    `const expected = ${JSON.stringify(expected)};`,
    "const modules = { core, server };",
    "for (const [packageName, contract] of Object.entries(expected)) {",
    "  const loaded = modules[packageName];",
    "  for (const name of contract.runtime) {",
    "    if (!Object.prototype.hasOwnProperty.call(loaded, name)) {",
    "      throw new Error(`${packageName} runtime export missing from installed git-dist: ${name}`);",
    "    }",
    "  }",
    "  for (const name of contract.callable) {",
    "    if (typeof loaded[name] !== \"function\") {",
    "      throw new Error(`${packageName} export is not callable from installed git-dist: ${name}`);",
    "    }",
    "  }",
    "}",
    "console.log(JSON.stringify({ exportGuard: { core: Object.keys(core).length, server: Object.keys(server).length } }));",
    "",
  ].join("\n");
}

function renderSvelteRuntimeGuard(manifest: PublicExportManifest): string {
  const imports = namedImports(manifest.runtime, "svelte");
  const callable = new Set(manifest.callable);
  return [
    "import {",
    ...imports.map(({ imported, local }) => `  ${imported} as ${local},`),
    '} from "thumbmux/svelte";',
    "",
    "const checks: Array<readonly [string, unknown, boolean]> = [",
    ...imports.map(({ imported, local }) =>
      `  [${JSON.stringify(imported)}, ${local}, ${callable.has(imported)}],`),
    "];",
    "for (const [name, value, mustBeCallable] of checks) {",
    "  if (value === undefined) throw new Error(`svelte runtime export missing from installed git-dist: ${name}`);",
    "  if (mustBeCallable && typeof value !== \"function\") {",
    "    throw new Error(`svelte export is not callable from installed git-dist: ${name}`);",
    "  }",
    "}",
    "",
  ].join("\n");
}

function renderSvelteRuntimeRunner(): string {
  return [
    'import { fileURLToPath } from "node:url";',
    'import { createServer } from "vite";',
    "",
    'const root = fileURLToPath(new URL(".", import.meta.url));',
    "const vite = await createServer({",
    "  root,",
    '  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),',
    '  appType: "custom",',
    "  server: { hmr: false, middlewareMode: true },",
    "  ssr: { noExternal: [/^thumbmux(?:\\/|$)/] },",
    "});",
    "try {",
    '  await vite.ssrLoadModule("/src/git-dist-export-guard.ts");',
    '  console.log(JSON.stringify({ exportGuard: { svelte: "runtime-loaded" } }));',
    "} finally {",
    "  await vite.close();",
    "}",
    "",
  ].join("\n");
}

/** Generate exhaustive guards only inside the throwaway packed-package consumer. */
export function writeGitDistConsumerGuards(
  consumerRoot: string,
  sourceRoot = PACKAGE_ROOT,
): void {
  const manifests = Object.fromEntries(
    PACKAGES.map((packageName) => [
      packageName,
      derivePublicExportManifest(sourceRoot, packageName),
    ]),
  ) as GitDistExportManifests;

  const tsconfigPath = resolve(consumerRoot, "tsconfig.json");
  const mainPath = resolve(consumerRoot, "src/main.ts");
  if (!existsSync(tsconfigPath) || !existsSync(mainPath)) {
    throw new Error(`consumer fixture is incomplete: ${consumerRoot}`);
  }

  writeFileSync(
    resolve(consumerRoot, "type-export-guard.ts"),
    renderTypeExportGuard(manifests),
    "utf8",
  );
  writeFileSync(
    resolve(consumerRoot, "type-export-guard.nodenext.ts"),
    renderTypeExportGuard(manifests, ["core", "server"]),
    "utf8",
  );
  writeFileSync(
    resolve(consumerRoot, "runtime-export-guard.mjs"),
    renderNodeRuntimeGuard(manifests),
    "utf8",
  );
  writeFileSync(
    resolve(consumerRoot, "src/git-dist-export-guard.ts"),
    renderSvelteRuntimeGuard(manifests.svelte),
    "utf8",
  );
  writeFileSync(
    resolve(consumerRoot, "runtime-svelte-export-guard.mjs"),
    renderSvelteRuntimeRunner(),
    "utf8",
  );

  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    include?: string[];
    [key: string]: unknown;
  };
  const include = new Set(tsconfig.include ?? []);
  include.add("type-export-guard.ts");
  tsconfig.include = [...include];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, "utf8");

  const main = readFileSync(mainPath, "utf8");
  const guardImport = 'import "./git-dist-export-guard";';
  if (!main.includes(guardImport)) {
    writeFileSync(mainPath, `${guardImport}\n${main}`, "utf8");
  }
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  return files.sort();
}

function distFiles(root: string): string[] {
  return REWRITE_ROOTS.flatMap((distRoot) => {
    const absoluteRoot = resolve(root, distRoot);
    if (!existsSync(absoluteRoot)) throw new Error(`missing built dist: ${distRoot}`);
    return filesBelow(absoluteRoot).filter((path) =>
      path.endsWith(".js")
      || path.endsWith(".mjs")
      || path.endsWith(".cjs")
      || path.endsWith(".ts")
      || path.endsWith(".svelte"));
  }).sort();
}

function isExtensionlessRelativeSpecifier(specifier: string): boolean {
  return (specifier.startsWith("./") || specifier.startsWith("../"))
    && !specifier.endsWith("/")
    && !specifier.includes("?")
    && !specifier.includes("#")
    && extname(specifier) === "";
}

function isDeclarationModuleSpecifier(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
    && parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (
    ts.isLiteralTypeNode(parent)
    && parent.literal === node
    && ts.isImportTypeNode(parent.parent)
  ) {
    return true;
  }
  if (ts.isExternalModuleReference(parent) && parent.expression === node) return true;
  if (ts.isModuleDeclaration(parent) && parent.name === node) return true;
  return ts.isCallExpression(parent)
    && parent.expression.kind === ts.SyntaxKind.ImportKeyword
    && parent.arguments[0] === node;
}

/** Add the runtime `.js` extension Node16/NodeNext expect, using AST spans. */
function rewriteDeclarationModuleSpecifiers(
  source: string,
  fileName: string,
): { source: string; replacements: number } {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const insertions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node)
      && isDeclarationModuleSpecifier(node)
      && isExtensionlessRelativeSpecifier(node.text)
    ) {
      insertions.push(node.getEnd() - 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let rewritten = source;
  for (const offset of insertions.sort((a, b) => b - a)) {
    rewritten = `${rewritten.slice(0, offset)}.js${rewritten.slice(offset)}`;
  }
  return { source: rewritten, replacements: insertions.length };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function moduleSpecifier(fromFile: string, target: string): string {
  const path = relative(dirname(fromFile), target).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function isScannable(path: string): boolean {
  return SCAN_EXTENSIONS.test(path) || path.endsWith(".d.ts");
}

/**
 * Find every file under `git-dist/` that still contains a quoted bare
 * `@thumbmux/core` specifier. Returns package-root-relative POSIX paths.
 */
export function findBareCoreSpecifiers(root = PACKAGE_ROOT): string[] {
  const gitDistRoot = resolve(root, "git-dist");
  if (!existsSync(gitDistRoot)) return [];
  const offenders: string[] = [];
  for (const path of filesBelow(gitDistRoot)) {
    if (!isScannable(path)) continue;
    const source = readFileSync(path, "utf8");
    BARE_CORE_SPECIFIER.lastIndex = 0;
    if (BARE_CORE_SPECIFIER.test(source)) {
      offenders.push(relative(root, path).split(sep).join("/"));
    }
  }
  return offenders.sort();
}

/**
 * Derive the git-dist entrypoints consumers must receive from the monorepo
 * package.json `exports` map. Workspace layout is `./pkg/dist/file`; the
 * aggregate copies that as `git-dist/pkg/file`. Always includes the core
 * rewrite target (`git-dist/core/index.js` + `.d.ts`) so the invariant holds
 * even for fixtures without an exports map.
 */
export function requiredGitDistArtifacts(root = PACKAGE_ROOT): string[] {
  const required = new Set<string>([
    "git-dist/core/index.js",
    "git-dist/core/index.d.ts",
  ]);
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) return [...required].sort();

  let pkg: { exports?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
  } catch {
    return [...required].sort();
  }
  const exportsMap = pkg.exports;
  if (!exportsMap || typeof exportsMap !== "object") return [...required].sort();

  for (const value of Object.values(exportsMap)) {
    if (!value || typeof value !== "object") continue;
    for (const target of Object.values(value as Record<string, unknown>)) {
      if (typeof target !== "string") continue;
      // ./core/dist/index.js → git-dist/core/index.js
      // (release tags remap exports onto these aggregate paths)
      const match = target.match(/^\.\/([^/]+)\/dist\/(.+)$/);
      if (match) required.add(`git-dist/${match[1]}/${match[2]}`);
    }
  }
  return [...required].sort();
}

/**
 * Fail-closed post-conditions for a usable git-dist aggregate.
 *
 * 1. Zero quoted bare `@thumbmux/core` anywhere under git-dist.
 * 2. Required entrypoints exist and are non-empty.
 * 3. Every rewritten relative specifier resolves to a real file on disk.
 *
 * File/replacement *counts* are intentionally not asserted — they grow when
 * legitimate new modules import core. Log them; never gate on their value.
 */
export function assertGitDistInvariants(
  root = PACKAGE_ROOT,
  result?: Pick<GitDistRewriteResult, "rewrittenSpecifiers">,
): void {
  const offenders = findBareCoreSpecifiers(root);
  if (offenders.length > 0) {
    throw new Error(
      `bare @thumbmux/core remains in git-dist (${offenders.length}): ${offenders.join(", ")}`,
    );
  }

  for (const rel of requiredGitDistArtifacts(root)) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`missing git-dist entrypoint: ${rel}`);
    }
    if (statSync(abs).size === 0) {
      throw new Error(`empty git-dist entrypoint: ${rel}`);
    }
  }

  if (result?.rewrittenSpecifiers) {
    for (const { file, specifier } of result.rewrittenSpecifiers) {
      const from = resolve(root, file);
      const target = resolve(dirname(from), specifier);
      if (!existsSync(target)) {
        throw new Error(
          `rewritten specifier does not resolve: ${file} → ${specifier} (expected ${target})`,
        );
      }
    }
  }
}

/**
 * The source workspaces intentionally import the standalone package name
 * `@thumbmux/core`. The immutable git-dist tag, however, is installed as one
 * root `thumbmux` package and package managers do not install its nested
 * workspace dependency. Rewrite only built server/Svelte artifacts so their
 * runtime and declaration imports resolve a copied core dist shipped beside
 * them. Original workspace dists remain byte-identical for standalone packs.
 */
export function rewriteGitDistImports(root = PACKAGE_ROOT): GitDistRewriteResult {
  const coreSourceJs = resolve(root, "core/dist/index.js");
  const coreSourceTypes = resolve(root, "core/dist/index.d.ts");
  if (!existsSync(coreSourceJs) || !existsSync(coreSourceTypes)) {
    throw new Error("missing built core dist entrypoints");
  }
  const sourceDigests = new Map<string, string>();
  for (const packageName of PACKAGES) {
    const source = resolve(root, packageName, "dist");
    if (!existsSync(source)) throw new Error(`missing built dist: ${packageName}/dist`);
    for (const path of filesBelow(source)) sourceDigests.set(path, digest(path));
  }

  const gitDistRoot = resolve(root, "git-dist");
  rmSync(gitDistRoot, { recursive: true, force: true });
  mkdirSync(gitDistRoot, { recursive: true });
  for (const packageName of PACKAGES) {
    const source = resolve(root, packageName, "dist");
    cpSync(source, resolve(gitDistRoot, packageName), { recursive: true });
  }
  const coreJs = resolve(gitDistRoot, "core/index.js");

  const files = new Set<string>();
  const rewrittenSpecifiers: RewrittenSpecifier[] = [];
  let replacements = 0;
  for (const path of distFiles(root)) {
    const source = readFileSync(path, "utf8");
    const specifier = moduleSpecifier(path, coreJs);
    let fileReplacements = 0;
    const rewritten = source.replace(BARE_CORE_SPECIFIER, (_match, quote: string) => {
      fileReplacements++;
      return `${quote}${specifier}${quote}`;
    });
    if (fileReplacements === 0) continue;
    writeFileSync(path, rewritten, "utf8");
    replacements += fileReplacements;
    const rel = relative(root, path).split(sep).join("/");
    files.add(rel);
    rewrittenSpecifiers.push({ file: rel, specifier });
  }

  for (const path of filesBelow(gitDistRoot).filter((file) => file.endsWith(".d.ts"))) {
    const source = readFileSync(path, "utf8");
    const rewritten = rewriteDeclarationModuleSpecifiers(source, path);
    if (rewritten.replacements === 0) continue;
    writeFileSync(path, rewritten.source, "utf8");
    replacements += rewritten.replacements;
    files.add(relative(root, path).split(sep).join("/"));
  }

  const result: GitDistRewriteResult = {
    files: [...files].sort(),
    replacements,
    rewrittenSpecifiers,
  };
  assertGitDistInvariants(root, result);

  for (const [path, before] of sourceDigests) {
    if (digest(path) !== before) throw new Error(`source package dist mutated: ${path}`);
  }

  return result;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check-exports") {
    const distRoot = resolve(args[0] ?? PACKAGE_ROOT);
    const sourceRoot = resolve(args[1] ?? distRoot);
    const manifests = assertGitDistExportParity(distRoot, sourceRoot);
    console.log(
      `git-dist export parity passed: ${PACKAGES.map((packageName) =>
        `${packageName} ${manifests[packageName].declarations.length} declarations/${manifests[packageName].runtime.length} runtime`)
        .join(", ")}`,
    );
  } else if (command === "write-consumer-guards") {
    const consumerRoot = args[0];
    if (!consumerRoot) throw new Error("write-consumer-guards requires a consumer root");
    const sourceRoot = resolve(args[1] ?? PACKAGE_ROOT);
    writeGitDistConsumerGuards(resolve(consumerRoot), sourceRoot);
    console.log(`wrote source-derived git-dist consumer guards: ${resolve(consumerRoot)}`);
  } else if (command) {
    throw new Error(`unknown command: ${command}`);
  } else {
    const result = rewriteGitDistImports();
    // Counts are diagnostic only — they grow whenever new module edges appear.
    // The fail-closed invariants above are what gate the release build.
    console.log(
      `rewrote ${result.replacements} module specifiers across ${result.files.length} git-dist files (counts informational)`,
    );
  }
}
