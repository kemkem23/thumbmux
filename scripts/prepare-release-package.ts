import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const RELEASE_PACKAGE_FILES = [
  "git-dist",
  "docs",
  "CONTRACT.md",
  "contract/manifest",
] as const;

/**
 * Pure JS modules that ship under the svelte/ and app/ trees but have no
 * Svelte runtime coupling of their own (no from-svelte imports, no runes, no
 * .svelte imports). They were trapped behind the svelte export condition
 * on ./svelte and ./app — resolvers that do not set that condition
 * (plain Node, bun test, esbuild, eslint, a ServiceWorkerGlobalScope with
 * no bundler) could not reach them even though the files were installed.
 *
 * Subpaths are relative to the package root without a leading ./ so both
 * the release (git-dist/...) and workspace (svelte/dist/...) layouts can
 * build the same export keys.
 *
 * IMPORTANT: do not put backtick characters in comments in this file.
 * Bun 1.3.11 test-time TS parser mis-tokenizes backticks inside comments
 * and fails the whole module load (see framework-free-exports / release-rails).
 */
export const FRAMEWORK_FREE_SUBPATHS = [
  "svelte/session-grid",
  "svelte/notifications",
  "svelte/service-worker",
  "svelte/recording-player",
  "svelte/term-search",
  "svelte/content-update-gate",
  "app/config",
  "app/navigation",
  "app/overlay",
  "app/sessions-store",
] as const;

export type FrameworkFreeSubpath = (typeof FRAMEWORK_FREE_SUBPATHS)[number];

/** Release-layout targets: files live under git-dist/. */
export function frameworkFreeReleaseExports(): Record<
  string,
  { types: string; import: string }
> {
  const out: Record<string, { types: string; import: string }> = {};
  for (const subpath of FRAMEWORK_FREE_SUBPATHS) {
    // Use string concat for keys/paths (avoid template-literal computed keys —
    // bun test-time parser has bitten us on those forms).
    const key = "./" + subpath;
    out[key] = {
      types: "./git-dist/" + subpath + ".d.ts",
      import: "./git-dist/" + subpath + ".js",
    };
  }
  return out;
}

/**
 * Workspace-layout targets for the monorepo root package.json (dev + local
 * resolution). Paths mirror the built star/dist trees rather than git-dist.
 */
export function frameworkFreeWorkspaceExports(): Record<
  string,
  { types: string; import: string }
> {
  const out: Record<string, { types: string; import: string }> = {};
  for (const subpath of FRAMEWORK_FREE_SUBPATHS) {
    // svelte/session-grid -> ./svelte/dist/session-grid.{d.ts,js}
    // app/config          -> ./app/dist/config.{d.ts,js}
    const slash = subpath.indexOf("/");
    const pkg = subpath.slice(0, slash);
    const rest = subpath.slice(slash + 1);
    const key = "./" + subpath;
    out[key] = {
      types: "./" + pkg + "/dist/" + rest + ".d.ts",
      import: "./" + pkg + "/dist/" + rest + ".js",
    };
  }
  return out;
}

export const RELEASE_PACKAGE_EXPORTS = {
  // Root entry: framework-free core surface. Without this, import("thumbmux")
  // throws "No exports main defined". Pointing at core (not svelte/app) keeps
  // the package default usable from Node / bun / SW without a Svelte
  // condition. ./core remains the explicit path and is unchanged.
  ".": {
    types: "./git-dist/core/index.d.ts",
    import: "./git-dist/core/index.js",
  },
  "./core": {
    types: "./git-dist/core/index.d.ts",
    import: "./git-dist/core/index.js",
  },
  "./server": {
    types: "./git-dist/server/index.d.ts",
    import: "./git-dist/server/index.js",
  },
  "./svelte": {
    types: "./git-dist/svelte/index.d.ts",
    svelte: "./git-dist/svelte/index.js",
  },
  "./app": {
    types: "./git-dist/app/index.d.ts",
    svelte: "./git-dist/app/index.js",
  },
  // TM-09: ungated subpaths for the pure JS modules that lived behind the
  // svelte-condition barrel. Additive — the barrels above still require the
  // svelte condition for component entry; these entries use import so a
  // plain resolver can load them. See FRAMEWORK_FREE_SUBPATHS.
  ...frameworkFreeReleaseExports(),
  "./package.json": "./package.json",
  // TM-08: contract/manifest and CONTRACT.md are in files, so they are
  // genuinely installed — and were unreachable, because a package with an
  // exports map blocks every path the map does not name. Shipping the only
  // machine-readable tier inventory and then locking it away is worse than not
  // shipping it: a consumer that wants to assert what it depends on can see the
  // file on disk and still gets ERR_PACKAGE_PATH_NOT_EXPORTED.
  //
  // The subpath pattern is deliberate over a bare ./contract directory entry:
  // it exposes exactly the four manifests and nothing else under contract/,
  // which is where goldens and fixtures live.
  "./contract/manifest/*.json": "./contract/manifest/*.json",
  "./CONTRACT.md": "./CONTRACT.md",
  "./docs/*.md": "./docs/*.md",
} as const;

export function prepareReleasePackage(packageRoot: string): void {
  const path = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete manifest.scripts;
  manifest.exports = RELEASE_PACKAGE_EXPORTS;
  manifest.files = RELEASE_PACKAGE_FILES;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    prepareReleasePackage(process.argv[2] ?? resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
