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
import { dirname, relative, resolve, sep } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const PACKAGES = ["core", "server", "svelte"] as const;
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

  const files: string[] = [];
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
    files.push(rel);
    rewrittenSpecifiers.push({ file: rel, specifier });
  }

  const result: GitDistRewriteResult = { files, replacements, rewrittenSpecifiers };
  assertGitDistInvariants(root, result);

  for (const [path, before] of sourceDigests) {
    if (digest(path) !== before) throw new Error(`source package dist mutated: ${path}`);
  }

  return result;
}

if (import.meta.main) {
  const result = rewriteGitDistImports();
  // Counts are diagnostic only — they grow whenever new modules import core.
  // The fail-closed invariants above are what gate the release build.
  console.log(
    `rewrote ${result.replacements} core imports across ${result.files.length} git-dist files (counts informational)`,
  );
}
