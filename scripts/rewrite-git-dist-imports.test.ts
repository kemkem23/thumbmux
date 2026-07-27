import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGitDistInvariants,
  findBareCoreSpecifiers,
  requiredGitDistArtifacts,
  rewriteGitDistImports,
} from "./rewrite-git-dist-imports";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-git-dist-test-"));
  roots.push(root);
  for (const directory of ["core/dist", "server/dist", "svelte/dist/nested"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "core/dist/index.js"), "export const core = true;\n");
  writeFileSync(join(root, "core/dist/index.d.ts"), "export declare const core: true;\n");
  return root;
}

/** Workspace-style package.json so exports → git-dist entrypoint mapping is exercised. */
function writeExportsMap(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "thumbmux-fixture",
      exports: {
        "./core": {
          types: "./core/dist/index.d.ts",
          import: "./core/dist/index.js",
        },
        "./server": {
          types: "./server/dist/index.d.ts",
          import: "./server/dist/index.js",
        },
        "./svelte": {
          types: "./svelte/dist/index.d.ts",
          svelte: "./svelte/dist/index.js",
        },
        "./package.json": "./package.json",
      },
    }),
  );
  // Entry files the exports map requires after rewrite (non-empty).
  writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
  writeFileSync(join(root, "server/dist/index.d.ts"), "export type { Value } from '@thumbmux/core';\n");
  writeFileSync(join(root, "svelte/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
  writeFileSync(join(root, "svelte/dist/index.d.ts"), "export type { Value } from '@thumbmux/core';\n");
}

describe("git-dist import rewriting", () => {
  test("rewrites built JS, declarations, and Svelte sources relative to the shipped core dist", () => {
    const root = fixture();
    writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
    writeFileSync(join(root, "server/dist/index.d.ts"), "export type { Value } from '@thumbmux/core';\n");
    writeFileSync(join(root, "svelte/dist/View.svelte"), "<script>import { value } from '@thumbmux/core';</script>\n");
    writeFileSync(join(root, "svelte/dist/nested/helper.js"), 'import { value } from "@thumbmux/core";\n');

    const originalServerJs = readFileSync(join(root, "server/dist/index.js"), "utf8");
    const originalSvelte = readFileSync(join(root, "svelte/dist/View.svelte"), "utf8");

    const result = rewriteGitDistImports(root);
    expect(result.files).toEqual([
      "git-dist/server/index.d.ts",
      "git-dist/server/index.js",
      "git-dist/svelte/View.svelte",
      "git-dist/svelte/nested/helper.js",
    ]);
    expect(result.replacements).toBe(4);
    expect(result.rewrittenSpecifiers).toEqual([
      { file: "git-dist/server/index.d.ts", specifier: "../core/index.js" },
      { file: "git-dist/server/index.js", specifier: "../core/index.js" },
      { file: "git-dist/svelte/View.svelte", specifier: "../core/index.js" },
      { file: "git-dist/svelte/nested/helper.js", specifier: "../../core/index.js" },
    ]);
    expect(readFileSync(join(root, "git-dist/server/index.js"), "utf8"))
      .toContain('from "../core/index.js"');
    expect(readFileSync(join(root, "git-dist/server/index.d.ts"), "utf8"))
      .toContain("from '../core/index.js'");
    expect(readFileSync(join(root, "git-dist/svelte/View.svelte"), "utf8"))
      .toContain("from '../core/index.js'");
    expect(readFileSync(join(root, "git-dist/svelte/nested/helper.js"), "utf8"))
      .toContain('from "../../core/index.js"');
    expect(readFileSync(join(root, "server/dist/index.js"), "utf8")).toBe(originalServerJs);
    expect(readFileSync(join(root, "svelte/dist/View.svelte"), "utf8")).toBe(originalSvelte);

    // Re-running rebuilds the aggregate from pristine package dists and is
    // deterministic instead of stacking a second relative rewrite.
    expect(rewriteGitDistImports(root).replacements).toBe(4);
  });

  test("fails closed when the core dist entrypoints were not built", () => {
    const root = fixture();
    rmSync(join(root, "core/dist/index.d.ts"));
    expect(() => rewriteGitDistImports(root)).toThrow("missing built core dist entrypoints");
  });

  test("does not fail on rewrite counts — only on real invariants", () => {
    // Many bare imports (far past the old hard-coded 20/22 inventory) must
    // still succeed as long as every bare specifier is rewritten away.
    const root = fixture();
    for (let i = 0; i < 30; i++) {
      writeFileSync(
        join(root, "server/dist", `mod-${i}.js`),
        `export { value } from "@thumbmux/core";\n`,
      );
    }
    const result = rewriteGitDistImports(root);
    expect(result.files.length).toBe(30);
    expect(result.replacements).toBe(30);
    expect(findBareCoreSpecifiers(root)).toEqual([]);
  });

  test("fails closed when a bare @thumbmux/core specifier survives under git-dist", () => {
    const root = fixture();
    writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
    rewriteGitDistImports(root);

    // Plant a bare import after a successful rewrite — the invariant must fire.
    writeFileSync(
      join(root, "git-dist/server/planted.js"),
      'import { value } from "@thumbmux/core";\n',
    );
    expect(findBareCoreSpecifiers(root)).toEqual(["git-dist/server/planted.js"]);
    expect(() => assertGitDistInvariants(root)).toThrow(
      /bare @thumbmux\/core remains in git-dist \(1\): git-dist\/server\/planted\.js/,
    );
  });

  test("fails closed when a required exports entrypoint is missing or empty", () => {
    const root = fixture();
    writeExportsMap(root);
    // Drop only the JS entry so the aggregate lacks one mapped export path.
    // (types entry remains — assert reports the first missing path it finds.)
    rmSync(join(root, "svelte/dist/index.js"));
    // Still need *some* svelte dist content so the package copy succeeds.
    writeFileSync(join(root, "svelte/dist/View.svelte"), "<script></script>\n");

    expect(requiredGitDistArtifacts(root)).toContain("git-dist/svelte/index.js");
    expect(() => rewriteGitDistImports(root)).toThrow(
      "missing git-dist entrypoint: git-dist/svelte/index.js",
    );
  });

  test("fails closed when a rewritten relative specifier does not resolve on disk", () => {
    const root = fixture();
    writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
    rewriteGitDistImports(root);

    // Point a rewritten record at a path that does not exist — the resolve
    // check must fire even when all package.json entrypoints are still present.
    expect(() =>
      assertGitDistInvariants(root, {
        rewrittenSpecifiers: [
          { file: "git-dist/server/index.js", specifier: "./does-not-exist.js" },
        ],
      }),
    ).toThrow(/rewritten specifier does not resolve: git-dist\/server\/index\.js → \.\/does-not-exist\.js/);
  });

  test("requiredGitDistArtifacts maps package.json exports onto git-dist paths", () => {
    const root = fixture();
    writeExportsMap(root);
    expect(requiredGitDistArtifacts(root)).toEqual([
      "git-dist/core/index.d.ts",
      "git-dist/core/index.js",
      "git-dist/server/index.d.ts",
      "git-dist/server/index.js",
      "git-dist/svelte/index.d.ts",
      "git-dist/svelte/index.js",
    ]);
  });

  test("ignores unquoted @thumbmux/core mentions in comments", () => {
    const root = fixture();
    writeFileSync(
      join(root, "server/dist/index.js"),
      [
        "// lives in @thumbmux/core (docs only)",
        'export { value } from "@thumbmux/core";',
        "",
      ].join("\n"),
    );
    const result = rewriteGitDistImports(root);
    expect(result.replacements).toBe(1);
    const body = readFileSync(join(root, "git-dist/server/index.js"), "utf8");
    expect(body).toContain("// lives in @thumbmux/core (docs only)");
    expect(body).toContain('from "../core/index.js"');
    expect(findBareCoreSpecifiers(root)).toEqual([]);
  });
});
