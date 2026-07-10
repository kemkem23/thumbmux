import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteGitDistImports } from "./rewrite-git-dist-imports";

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

describe("git-dist import rewriting", () => {
  test("rewrites built JS, declarations, and Svelte sources relative to the shipped core dist", () => {
    const root = fixture();
    writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
    writeFileSync(join(root, "server/dist/index.d.ts"), "export type { Value } from '@thumbmux/core';\n");
    writeFileSync(join(root, "svelte/dist/View.svelte"), "<script>import { value } from '@thumbmux/core';</script>\n");
    writeFileSync(join(root, "svelte/dist/nested/helper.js"), 'import { value } from "@thumbmux/core";\n');

    const originalServerJs = readFileSync(join(root, "server/dist/index.js"), "utf8");
    const originalSvelte = readFileSync(join(root, "svelte/dist/View.svelte"), "utf8");

    expect(rewriteGitDistImports(root)).toEqual({
      files: [
        "git-dist/server/index.d.ts",
        "git-dist/server/index.js",
        "git-dist/svelte/View.svelte",
        "git-dist/svelte/nested/helper.js",
      ],
      replacements: 4,
    });
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
});
