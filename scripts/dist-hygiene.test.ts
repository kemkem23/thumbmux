import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as serverBarrel from "../server/src";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const GIT_DIST_ROOT = join(PACKAGE_ROOT, "git-dist");

function declarationFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path);
    }
  }
  return files.sort();
}

function sourceCandidates(declaration: string): string[] {
  const [packageName, ...emittedParts] = relative(GIT_DIST_ROOT, declaration).split(/[\\/]/);
  const emittedPath = emittedParts.join("/").slice(0, -".d.ts".length);
  const sourceBase = join(PACKAGE_ROOT, packageName!, "src", emittedPath);
  return emittedPath.endsWith(".svelte")
    ? [sourceBase, `${sourceBase}.ts`]
    : [`${sourceBase}.ts`, `${sourceBase}.tsx`];
}

function isPackageEntrypoint(declaration: string): boolean {
  const parts = relative(GIT_DIST_ROOT, declaration).split(/[\\/]/);
  return parts.length === 2 && parts[1] === "index.d.ts";
}

describe("git-dist hygiene", () => {
  test("every non-entrypoint declaration has a parallel source module", () => {
    const declarations = declarationFiles(GIT_DIST_ROOT)
      .filter((path) => !isPackageEntrypoint(path));
    const orphans = declarations
      .filter((declaration) => !sourceCandidates(declaration).some(existsSync))
      .map((declaration) => relative(GIT_DIST_ROOT, declaration).replaceAll("\\", "/"));

    expect(declarations.length).toBeGreaterThan(0);
    expect(orphans).toEqual([]);
  });

  test("the exact pane target helper is callable from the server barrel", () => {
    const publicApi = serverBarrel as typeof serverBarrel & {
      exactTmuxPaneTarget?: (name: string) => string;
    };
    const sessionName = "probe-session";

    expect(publicApi.exactTmuxPaneTarget?.(sessionName))
      .toBe(`${serverBarrel.exactTmuxTarget(sessionName)}:`);
  });
});
