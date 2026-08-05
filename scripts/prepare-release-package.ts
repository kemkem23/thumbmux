import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const RELEASE_PACKAGE_FILES = [
  "git-dist",
  "docs",
  "CONTRACT.md",
  "contract/manifest",
] as const;

export const RELEASE_PACKAGE_EXPORTS = {
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
  "./package.json": "./package.json",
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
