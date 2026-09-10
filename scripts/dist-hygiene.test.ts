import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as serverBarrel from "../server/src";
import { RELEASE_PACKAGE_EXPORTS } from "./prepare-release-package";

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

  /**
   * Recall and sqlite-history are the only modules in the package that load a
   * database driver. Importing thumbmux/server must not pull either in: a host
   * that only wants the WebSocket engine would start paying for bun:sqlite,
   * and a non-Bun bundler resolving the barrel would fail on a module it has
   * no reason to see. Reading the built barrel is the only honest check — the
   * source barrel not naming them proves nothing about what the bundle inlined.
   */
  test("the server barrel never statically imports a sqlite driver", () => {
    const barrel = readFileSync(join(GIT_DIST_ROOT, "server", "index.js"), "utf8");
    expect(barrel).not.toMatch(/import\s[^;]*from\s*["'](?:bun|node):sqlite["']/);
    expect(barrel).not.toMatch(/from\s*["']\.\/recall-handler/);
    expect(barrel).not.toMatch(/from\s*["']\.\/sqlite-history/);
    expect(Object.keys(serverBarrel)).not.toContain("createRecallHandler");
    expect(Object.keys(serverBarrel)).not.toContain("createSqliteHistoryStore");

    // …and the modules they are kept out of the barrel for really do exist,
    // really do load the driver, and are reachable on their own paths.
    const recall = readFileSync(join(GIT_DIST_ROOT, "server", "recall-handler.js"), "utf8");
    expect(recall).toMatch(/from\s*["']bun:sqlite["']/);
    const sqliteHistory = readFileSync(join(GIT_DIST_ROOT, "server", "sqlite-history.js"), "utf8");
    expect(sqliteHistory).toMatch(/["']bun:sqlite["']/);
    const exportsMap = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "server", "package.json"), "utf8"),
    ).exports as Record<string, { import?: string }>;
    expect(exportsMap["./recall"]?.import).toBe("./dist/recall-handler.js");
    expect(exportsMap["./sqlite-history"]?.import).toBe("./dist/sqlite-history.js");
  });

  test("the release package exports ./server/sqlite-history onto git-dist", () => {
    const subpath = "./server/sqlite-history";
    const keys = Object.keys(RELEASE_PACKAGE_EXPORTS);
    expect(keys, "RELEASE_PACKAGE_EXPORTS is missing ./server/sqlite-history").toContain(subpath);
    const entry = (RELEASE_PACKAGE_EXPORTS as Record<string, { types?: string; import?: string }>)[subpath];
    expect(entry?.types).toBe("./git-dist/server/sqlite-history.d.ts");
    expect(entry?.import).toBe("./git-dist/server/sqlite-history.js");
    expect(existsSync(join(GIT_DIST_ROOT, "server", "sqlite-history.d.ts"))).toBe(true);
    expect(existsSync(join(GIT_DIST_ROOT, "server", "sqlite-history.js"))).toBe(true);
  });

  test("the exact pane target helper is callable from the server barrel", () => {
    const publicApi = serverBarrel as typeof serverBarrel & {
      exactTmuxPaneTarget?: (name: string) => string;
    };
    const sessionName = "probe-session";

    expect(publicApi.exactTmuxPaneTarget?.(sessionName))
      .toBe(`${serverBarrel.exactTmuxTarget(sessionName)}:0.0`);
  });
});
