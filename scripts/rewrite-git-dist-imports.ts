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
const BARE_CORE_SPECIFIER = /(["'])@thumbmux\/core\1/g;
const EXPECTED_REWRITTEN_FILES = 20;
const EXPECTED_REPLACEMENTS = 22;

export type GitDistRewriteResult = {
  files: string[];
  replacements: number;
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
    files.push(relative(root, path).split(sep).join("/"));
  }

  const unresolved = distFiles(root).filter((path) => {
    BARE_CORE_SPECIFIER.lastIndex = 0;
    return BARE_CORE_SPECIFIER.test(readFileSync(path, "utf8"));
  });
  if (unresolved.length > 0) {
    throw new Error(`unresolved @thumbmux/core imports: ${unresolved.join(", ")}`);
  }
  for (const [path, before] of sourceDigests) {
    if (digest(path) !== before) throw new Error(`source package dist mutated: ${path}`);
  }

  return { files, replacements };
}

if (import.meta.main) {
  const result = rewriteGitDistImports();
  if (result.files.length !== EXPECTED_REWRITTEN_FILES || result.replacements !== EXPECTED_REPLACEMENTS) {
    throw new Error(
      `unexpected git-dist import inventory: ${result.files.length} files / ${result.replacements} replacements`
    );
  }
  console.log(`rewrote ${result.replacements} core imports across ${result.files.length} git-dist files`);
}
