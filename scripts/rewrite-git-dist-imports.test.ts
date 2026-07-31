import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGitDistInvariants,
  assertGitDistExportParity,
  findBareWorkspaceSpecifiers,
  requiredGitDistArtifacts,
  rewriteGitDistImports,
  writeGitDistConsumerGuards,
} from "./rewrite-git-dist-imports";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-git-dist-test-"));
  roots.push(root);
  for (const directory of ["core/dist", "server/dist", "svelte/dist/nested", "app/dist"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "core/dist/index.js"), "export const core = true;\n");
  writeFileSync(join(root, "core/dist/index.d.ts"), "export declare const core: true;\n");
  writeFileSync(join(root, "server/dist/index.js"), "export const server = true;\n");
  writeFileSync(join(root, "server/dist/index.d.ts"), "export declare const server: true;\n");
  writeFileSync(join(root, "svelte/dist/index.js"), "export const svelte = true;\n");
  writeFileSync(join(root, "svelte/dist/index.d.ts"), "export declare const svelte: true;\n");
  writeFileSync(join(root, "app/dist/index.js"), "export const app = true;\n");
  writeFileSync(join(root, "app/dist/index.d.ts"), "export declare const app: true;\n");
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
        "./app": {
          types: "./app/dist/index.d.ts",
          svelte: "./app/dist/index.js",
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
  writeFileSync(
    join(root, "app/dist/index.js"),
    'export { value } from "@thumbmux/core"; export { view } from "@thumbmux/svelte";\n',
  );
  writeFileSync(
    join(root, "app/dist/index.d.ts"),
    "export type { Value } from '@thumbmux/core'; export type { View } from '@thumbmux/svelte';\n",
  );
}

function writeExportSurface(
  root: string,
  options: {
    coreTypeStar?: boolean;
    coreTypeStarValueOverride?: boolean;
    nestedCoreTypeStar?: boolean;
    omitCoreType?: boolean;
    omitFakeServerDeclaration?: boolean;
    omitFakeServerRuntime?: boolean;
    makeFakeServerDeclarationNonCallable?: boolean;
    makeFakeServerDeclarationTypeOnly?: boolean;
    makeFakeServerRuntimeNonCallable?: boolean;
    omitAppSourceExport?: boolean;
  } = {},
): void {
  for (const packageName of ["core", "server", "svelte", "app"]) {
    mkdirSync(join(root, packageName, "src"), { recursive: true });
    mkdirSync(join(root, "git-dist", packageName), { recursive: true });
  }

  writeFileSync(
    join(root, "core/src/index.ts"),
    [
      options.nestedCoreTypeStar
        ? "export * from './middle';"
        : options.coreTypeStar || options.coreTypeStarValueOverride
          ? "export type * from './protocol';"
          : "export * from './protocol';",
      ...(options.coreTypeStarValueOverride
        ? ["export { erasedByTypeStar } from './protocol';"]
        : []),
      "export const coreValue = 1;",
      "export function coreFunction(): number { return coreValue; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "core/src/protocol.ts"),
    [
      "export type CoreShape = { value: string };",
      ...(options.coreTypeStar || options.coreTypeStarValueOverride || options.nestedCoreTypeStar
        ? ["export const erasedByTypeStar = 1;"]
        : []),
      "",
    ].join("\n"),
  );
  if (options.nestedCoreTypeStar) {
    writeFileSync(
      join(root, "core/src/middle.ts"),
      "export type * from './protocol';\n",
    );
  }
  writeFileSync(
    join(root, "git-dist/core/index.d.ts"),
    [
      options.nestedCoreTypeStar
        ? "export * from './middle';"
        : options.coreTypeStar || options.coreTypeStarValueOverride
          ? "export type * from './protocol';"
          : "export * from './protocol';",
      ...(options.coreTypeStarValueOverride
        ? ["export { erasedByTypeStar } from './protocol';"]
        : []),
      "export declare const coreValue = 1;",
      "export declare function coreFunction(): number;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/core/protocol.d.ts"),
    options.omitCoreType
      ? "export {};\n"
      : [
        "export type CoreShape = { value: string };",
        ...(options.coreTypeStar || options.coreTypeStarValueOverride || options.nestedCoreTypeStar
          ? ["export declare const erasedByTypeStar = 1;"]
          : []),
        "",
      ].join("\n"),
  );
  if (options.nestedCoreTypeStar) {
    writeFileSync(
      join(root, "git-dist/core/middle.d.ts"),
      "export type * from './protocol';\n",
    );
  }
  writeFileSync(
    join(root, "git-dist/core/index.js"),
    "export const coreValue = 1; export function coreFunction() { return coreValue; }\n",
  );

  writeFileSync(
    join(root, "server/src/index.ts"),
    [
      "export const stableServerExport = true;",
      "export function fakeDistGuardExport(): string { return 'guard'; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/server/index.d.ts"),
    [
      "export declare const stableServerExport = true;",
      ...(options.omitFakeServerDeclaration
        ? []
        : options.makeFakeServerDeclarationTypeOnly
          ? ["export type fakeDistGuardExport = string;"]
          : options.makeFakeServerDeclarationNonCallable
            ? ["export declare const fakeDistGuardExport: string;"]
            : ["export declare function fakeDistGuardExport(): string;"]),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/server/index.js"),
    [
      "export const stableServerExport = true;",
      ...(options.omitFakeServerRuntime
        ? []
        : options.makeFakeServerRuntimeNonCallable
          ? ["export const fakeDistGuardExport = 'guard';"]
          : ["export function fakeDistGuardExport() { return 'guard'; }"]),
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "svelte/src/index.ts"),
    [
      "export type SvelteShape = { active: boolean };",
      "export function svelteFunction(): boolean { return true; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/svelte/index.d.ts"),
    [
      "export type SvelteShape = { active: boolean };",
      "export declare function svelteFunction(): boolean;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/svelte/index.js"),
    "export function svelteFunction() { return true; }\n",
  );

  writeFileSync(
    join(root, "app/src/index.ts"),
    [
      "export type AppShape = { label: string };",
      ...(options.omitAppSourceExport
        ? []
        : ["export const defaultAppLabel = 'Terminals';"]),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/app/index.d.ts"),
    [
      "export type AppShape = { label: string };",
      "export declare const defaultAppLabel = \"Terminals\";",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "git-dist/app/index.js"),
    "export const defaultAppLabel = 'Terminals';\n",
  );
}

describe("git-dist import rewriting", () => {
  test("adds .js to extensionless relative declaration specifiers in every package", () => {
    const root = fixture();
    writeFileSync(
      join(root, "core/dist/index.d.ts"),
      [
        "export * from './protocol';",
        'export type ProtocolImport = import("./protocol").Protocol;',
        "export type DocumentationExample = './protocol';",
        "// export * from './comment-only';",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "core/dist/protocol.d.ts"), "export interface Protocol {}\n");
    writeFileSync(
      join(root, "server/dist/index.d.ts"),
      'export type { ServerDriver } from "./ws-mux";\n',
    );
    writeFileSync(join(root, "server/dist/ws-mux.d.ts"), "export interface ServerDriver {}\n");
    writeFileSync(
      join(root, "svelte/dist/index.d.ts"),
      [
        "export type { Helper } from './nested/helper';",
        "export { default as View } from './View.svelte';",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "svelte/dist/nested/helper.d.ts"), "export interface Helper {}\n");
    writeFileSync(join(root, "svelte/dist/View.svelte.d.ts"), "declare const View: unknown; export default View;\n");
    writeFileSync(
      join(root, "app/dist/index.d.ts"),
      'export type { AppConfig } from "./config";\n',
    );
    writeFileSync(join(root, "app/dist/config.d.ts"), "export interface AppConfig {}\n");

    const originalCore = readFileSync(join(root, "core/dist/index.d.ts"), "utf8");
    const originalServer = readFileSync(join(root, "server/dist/index.d.ts"), "utf8");
    const originalSvelte = readFileSync(join(root, "svelte/dist/index.d.ts"), "utf8");
    const originalApp = readFileSync(join(root, "app/dist/index.d.ts"), "utf8");

    const result = rewriteGitDistImports(root);

    expect(result.files).toEqual([
      "git-dist/app/index.d.ts",
      "git-dist/core/index.d.ts",
      "git-dist/server/index.d.ts",
      "git-dist/svelte/index.d.ts",
    ]);
    expect(result.replacements).toBe(5);
    expect(readFileSync(join(root, "git-dist/app/index.d.ts"), "utf8"))
      .toBe('export type { AppConfig } from "./config.js";\n');
    expect(readFileSync(join(root, "git-dist/core/index.d.ts"), "utf8")).toBe([
      "export * from './protocol.js';",
      'export type ProtocolImport = import("./protocol.js").Protocol;',
      "export type DocumentationExample = './protocol';",
      "// export * from './comment-only';",
      "",
    ].join("\n"));
    expect(readFileSync(join(root, "git-dist/server/index.d.ts"), "utf8"))
      .toBe('export type { ServerDriver } from "./ws-mux.js";\n');
    expect(readFileSync(join(root, "git-dist/svelte/index.d.ts"), "utf8")).toBe([
      "export type { Helper } from './nested/helper.js';",
      "export { default as View } from './View.svelte';",
      "",
    ].join("\n"));
    expect(readFileSync(join(root, "core/dist/index.d.ts"), "utf8")).toBe(originalCore);
    expect(readFileSync(join(root, "server/dist/index.d.ts"), "utf8")).toBe(originalServer);
    expect(readFileSync(join(root, "svelte/dist/index.d.ts"), "utf8")).toBe(originalSvelte);
    expect(readFileSync(join(root, "app/dist/index.d.ts"), "utf8")).toBe(originalApp);
  });

  test("rewrites core and Svelte imports to their shipped sibling dists", () => {
    const root = fixture();
    writeFileSync(join(root, "server/dist/index.js"), 'export { value } from "@thumbmux/core";\n');
    writeFileSync(join(root, "server/dist/index.d.ts"), "export type { Value } from '@thumbmux/core';\n");
    writeFileSync(join(root, "svelte/dist/View.svelte"), "<script>import { value } from '@thumbmux/core';</script>\n");
    writeFileSync(join(root, "svelte/dist/nested/helper.js"), 'import { value } from "@thumbmux/core";\n');
    writeFileSync(
      join(root, "app/dist/index.js"),
      'import { value } from "@thumbmux/core"; import { view } from "@thumbmux/svelte";\n',
    );
    writeFileSync(
      join(root, "app/dist/index.d.ts"),
      "import type { Value } from '@thumbmux/core'; import type { View } from '@thumbmux/svelte';\n",
    );

    const originalServerJs = readFileSync(join(root, "server/dist/index.js"), "utf8");
    const originalSvelte = readFileSync(join(root, "svelte/dist/View.svelte"), "utf8");
    const originalAppJs = readFileSync(join(root, "app/dist/index.js"), "utf8");

    const result = rewriteGitDistImports(root);
    expect(result.files).toEqual([
      "git-dist/app/index.d.ts",
      "git-dist/app/index.js",
      "git-dist/server/index.d.ts",
      "git-dist/server/index.js",
      "git-dist/svelte/View.svelte",
      "git-dist/svelte/nested/helper.js",
    ]);
    expect(result.replacements).toBe(8);
    expect(result.rewrittenSpecifiers).toEqual([
      { file: "git-dist/app/index.d.ts", specifier: "../core/index.js" },
      { file: "git-dist/app/index.d.ts", specifier: "../svelte/index.js" },
      { file: "git-dist/app/index.js", specifier: "../core/index.js" },
      { file: "git-dist/app/index.js", specifier: "../svelte/index.js" },
      { file: "git-dist/server/index.d.ts", specifier: "../core/index.js" },
      { file: "git-dist/server/index.js", specifier: "../core/index.js" },
      { file: "git-dist/svelte/nested/helper.js", specifier: "../../core/index.js" },
      { file: "git-dist/svelte/View.svelte", specifier: "../core/index.js" },
    ]);
    expect(readFileSync(join(root, "git-dist/app/index.js"), "utf8"))
      .toContain('from "../core/index.js"');
    expect(readFileSync(join(root, "git-dist/app/index.js"), "utf8"))
      .toContain('from "../svelte/index.js"');
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
    expect(readFileSync(join(root, "app/dist/index.js"), "utf8")).toBe(originalAppJs);

    // Re-running rebuilds the aggregate from pristine package dists and is
    // deterministic instead of stacking a second relative rewrite.
    expect(rewriteGitDistImports(root).replacements).toBe(8);
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
    expect(findBareWorkspaceSpecifiers(root)).toEqual([]);
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
    expect(findBareWorkspaceSpecifiers(root)).toEqual(["git-dist/server/planted.js"]);
    expect(() => assertGitDistInvariants(root)).toThrow(
      /bare @thumbmux workspace specifier remains in git-dist \(1\): git-dist\/server\/planted\.js/,
    );
  });

  test("fails closed when a bare @thumbmux/svelte specifier survives under git-dist", () => {
    const root = fixture();
    rewriteGitDistImports(root);

    writeFileSync(
      join(root, "git-dist/app/planted.js"),
      'import { view } from "@thumbmux/svelte";\n',
    );
    expect(findBareWorkspaceSpecifiers(root)).toEqual(["git-dist/app/planted.js"]);
    expect(() => assertGitDistInvariants(root)).toThrow(
      /bare @thumbmux workspace specifier remains in git-dist \(1\): git-dist\/app\/planted\.js/,
    );
  });

  test("fails closed when a required exports entrypoint is missing or empty", () => {
    const root = fixture();
    writeExportsMap(root);
    // Drop only the JS entry so the aggregate lacks one mapped export path.
    // (types entry remains — assert reports the first missing path it finds.)
    rmSync(join(root, "app/dist/index.js"));
    // Still need *some* app dist content so the package copy succeeds.
    writeFileSync(join(root, "app/dist/config.js"), "export {};\n");

    expect(requiredGitDistArtifacts(root)).toContain("git-dist/app/index.js");
    expect(() => rewriteGitDistImports(root)).toThrow(
      "missing git-dist entrypoint: git-dist/app/index.js",
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
      "git-dist/app/index.d.ts",
      "git-dist/app/index.js",
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
    expect(findBareWorkspaceSpecifiers(root)).toEqual([]);
  });
});

describe("git-dist public export guard", () => {
  test("writes a core/server-only type guard for the NodeNext smoke", () => {
    const root = fixture();
    writeExportSurface(root);
    const consumer = join(root, "consumer");
    mkdirSync(join(consumer, "src"), { recursive: true });
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({ include: ["smoke.ts"] }),
    );
    writeFileSync(join(consumer, "src/main.ts"), "export {};\n");

    writeGitDistConsumerGuards(consumer, root);

    const guard = readFileSync(join(consumer, "type-export-guard.nodenext.ts"), "utf8");
    expect(guard).toContain('from "thumbmux/core";');
    expect(guard).toContain('from "thumbmux/server";');
    expect(guard).not.toContain('from "thumbmux/svelte";');
    expect(guard).not.toContain('from "thumbmux/app";');

    const bundlerGuard = readFileSync(join(consumer, "type-export-guard.ts"), "utf8");
    expect(bundlerGuard).toContain('from "thumbmux/app";');
    const svelteRuntimeGuard = readFileSync(
      join(consumer, "src/git-dist-export-guard.ts"),
      "utf8",
    );
    expect(svelteRuntimeGuard).toContain('from "thumbmux/svelte";');
    expect(svelteRuntimeGuard).toContain('from "thumbmux/app";');
  });

  test("derives the public declaration/runtime surface and accepts a complete dist", () => {
    const root = fixture();
    writeExportSurface(root);

    expect(() => assertGitDistExportParity(root)).not.toThrow();
  });

  test("fails when a source-derived export is absent from assembled declarations", () => {
    const root = fixture();
    writeExportSurface(root, { omitFakeServerDeclaration: true });

    // This is the task brief's adversarial fallback: the canonical source
    // advertises a new export while the already-built aggregate omits it.
    expect(() => assertGitDistExportParity(root)).toThrow(
      "server declaration exports missing from git-dist: fakeDistGuardExport",
    );
  });

  test("fails when assembled app declarations retain an export removed from source", () => {
    const root = fixture();
    writeExportSurface(root, { omitAppSourceExport: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "app declaration exports unexpectedly present in git-dist: defaultAppLabel",
    );
  });

  test("fails when a source-derived runtime export is absent from assembled JavaScript", () => {
    const root = fixture();
    writeExportSurface(root, { omitFakeServerRuntime: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "server runtime exports missing from git-dist: fakeDistGuardExport",
    );
  });

  test("fails when a runtime export is represented as type-only in declarations", () => {
    const root = fixture();
    writeExportSurface(root, { makeFakeServerDeclarationTypeOnly: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "server value declarations missing from git-dist: fakeDistGuardExport",
    );
  });

  test("fails when a callable export has non-callable declarations", () => {
    const root = fixture();
    writeExportSurface(root, { makeFakeServerDeclarationNonCallable: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "server callable declarations are not callable in git-dist: fakeDistGuardExport",
    );
  });

  test("fails when an exported callable is replaced by a non-callable value", () => {
    const root = fixture();
    writeExportSurface(root, { makeFakeServerRuntimeNonCallable: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "server callable exports are not callable in git-dist: fakeDistGuardExport",
    );
  });

  test("follows export-star declarations and catches a missing type-only export", () => {
    const root = fixture();
    writeExportSurface(root, { omitCoreType: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "core declaration exports missing from git-dist: CoreShape",
    );
  });

  test("does not classify values behind export type-star as runtime exports", () => {
    const root = fixture();
    writeExportSurface(root, { coreTypeStar: true });

    expect(() => assertGitDistExportParity(root)).not.toThrow();
  });

  test("keeps an explicit value export that overrides export type-star", () => {
    const root = fixture();
    writeExportSurface(root, { coreTypeStarValueOverride: true });

    expect(() => assertGitDistExportParity(root)).toThrow(
      "core runtime exports missing from git-dist: erasedByTypeStar",
    );
  });

  test("does not leak runtime values through a nested export type-star", () => {
    const root = fixture();
    writeExportSurface(root, { nestedCoreTypeStar: true });

    expect(() => assertGitDistExportParity(root)).not.toThrow();
  });
});
