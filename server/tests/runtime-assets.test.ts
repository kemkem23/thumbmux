import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyServerRuntimeAssets,
  TERMINAL_PTY_WAL_PROXY_ASSET,
} from "../scripts/copy-runtime-assets";
import { PIPE_HISTORY_RUNTIME_CAPABILITY } from "../src/pipe-history-runtime";
import { PROJECTION_SCHEMA_VERSION } from "../src/sqlite-history/schema";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(contents = "#!/usr/bin/env python3\nprint('proxy fixture')\n", mode = 0o755): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-runtime-assets-"));
  roots.push(root);
  const sourceDirectory = join(root, "src", "integrations");
  mkdirSync(sourceDirectory, { recursive: true });
  const source = join(sourceDirectory, TERMINAL_PTY_WAL_PROXY_ASSET);
  writeFileSync(source, contents, { mode });
  chmodSync(source, mode);
  return root;
}

describe("server runtime asset build", () => {
  test("advertises the exact optional pipe-history runtime capability", () => {
    expect(PIPE_HISTORY_RUNTIME_CAPABILITY).toEqual({
      // The schema number is schema.ts's, never a copy here (S2 moved it 3 -> 4).
      wire: "newarch-frame-v1", projectionSchema: PROJECTION_SCHEMA_VERSION, metadataRevision: true, archiveReadVersions: [2, 3, 4, 5],
    });
  });
  test("copies the exact Python helper beside the bundled server entrypoint", () => {
    const root = fixture();
    const target = copyServerRuntimeAssets(root);

    expect(target).toBe(join(root, "dist", TERMINAL_PTY_WAL_PROXY_ASSET));
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target)).toEqual(
      readFileSync(join(root, "src", "integrations", TERMINAL_PTY_WAL_PROXY_ASSET)),
    );
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test("fails closed when the source helper is empty, malformed, or not executable", () => {
    expect(() => copyServerRuntimeAssets(fixture("", 0o755))).toThrow("is empty");
    expect(() => copyServerRuntimeAssets(fixture("print('missing shebang')\n", 0o755)))
      .toThrow("expected Python 3 shebang");
    expect(() => copyServerRuntimeAssets(fixture(undefined, 0o644)))
      .toThrow("not executable by every runtime user");
  });
});

// ── NEWARCH L2-I lot I4: pipe-pane VT assets travel with the bundle ─────────
import { copyFileSync as copyAsset } from "node:fs";
import { Database } from "bun:sqlite";
import { copyPipeVtRuntimeAssets, PIPE_VT_RUNTIME_ASSETS } from "../scripts/copy-runtime-assets";
import { assertGitDistInvariants, GIT_DIST_PIPE_VT_ASSETS, GIT_DIST_PIPE_VT_ENTRY } from "../../scripts/rewrite-git-dist-imports";

const SOURCE = join(import.meta.dir, "..", "src");

function vtFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-pipe-vt-assets-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const name of PIPE_VT_RUNTIME_ASSETS) copyAsset(join(SOURCE, name), join(root, "src", name));
  return root;
}

describe("NEWARCH I4 pipe-vt runtime assets", () => {
  test("worker, pinned vendor archive and licence are copied beside the bundle and verified again there", () => {
    const root = vtFixture();
    const targets = copyPipeVtRuntimeAssets(root);
    expect(targets.map((t) => t.slice(root.length + 1)).sort()).toEqual(PIPE_VT_RUNTIME_ASSETS.map((n) => `dist/${n}`).sort());
    for (const name of PIPE_VT_RUNTIME_ASSETS) expect(readFileSync(join(root, "dist", name))).toEqual(readFileSync(join(SOURCE, name)));
    expect(statSync(join(root, "dist", "pipe-vt-worker.py")).mode & 0o777).toBe(0o755);
  });

  test("the build script reads asset constants from a leaf module that imports nothing", async () => {
    // staging-policy.sh pins copy-runtime-assets.ts and pipe-vt-assets.ts by
    // hash; the build runs their top level, so neither may pull in a module
    // whose bytes are not pinned (review R-PKG F4).
    const leaf = readFileSync(join(SOURCE, "pipe-vt-assets.ts"), "utf8");
    expect(leaf).not.toMatch(/\bimport\b|\brequire\s*\(|\bfrom\s+["']/);
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "copy-runtime-assets.ts"), "utf8");
    const specifiers = [...script.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(["../src/pipe-vt-assets", "node:crypto", "node:fs", "node:path"]);
    const assets = await import("../src/pipe-vt-assets");
    const worker = await import("../src/pipe-vt-worker");
    for (const name of ["PIPE_VT_VENDOR_SHA256", "PIPE_VT_WORKER_FILE", "PIPE_VT_VENDOR_FILE", "PIPE_VT_LICENSE_FILE"] as const) {
      expect(worker[name], name).toBe(assets[name]);
    }
    expect([...PIPE_VT_RUNTIME_ASSETS]).toEqual(["pipe-vt-worker.py", "pipe-vt-vendor.zip", "pipe-vt-LICENSE.txt"]);
  });

  test("a vendor archive other than the pinned one is refused before anything is published", () => {
    const root = vtFixture();
    writeFileSync(join(root, "src", "pipe-vt-vendor.zip"), "not the pinned archive");
    expect(() => copyPipeVtRuntimeAssets(root)).toThrow("is not the pinned");
    expect(existsSync(join(root, "dist", "pipe-vt-vendor.zip"))).toBe(false);
  });

  test("a git-dist that ships the projection entry must ship the VT assets", () => {
    const root = mkdtempSync(join(tmpdir(), "thumbmux-git-dist-vt-"));
    roots.push(root);
    for (const rel of ["git-dist/core/index.js", "git-dist/core/index.d.ts", "git-dist/svelte/index.js", "git-dist/svelte/index.d.ts", GIT_DIST_PIPE_VT_ENTRY]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "export {};\n");
    }
    writeFileSync(join(root, "git-dist/server/terminal-pty-wal-proxy.py"), "#!/usr/bin/env python3\n", { mode: 0o755 });
    chmodSync(join(root, "git-dist/server/terminal-pty-wal-proxy.py"), 0o755);
    expect(() => assertGitDistInvariants(root)).toThrow("missing git-dist pipe-vt asset");
    for (const rel of GIT_DIST_PIPE_VT_ASSETS) copyAsset(join(SOURCE, rel.split("/").pop()!), join(root, rel));
    expect(() => assertGitDistInvariants(root)).not.toThrow();
  });

  test("the built pipe-history-runtime bundle runs the VT worker and the disk writer from its own directory", async () => {
    const root = vtFixture();
    copyPipeVtRuntimeAssets(root);
    // @thumbmux/core is bundled in here (the package build keeps it external):
    // this temp directory has no node_modules, and the property under test is
    // that assets and the disk worker resolve from the bundle's own location.
    const built = await Bun.build({ entrypoints: [join(SOURCE, "pipe-history-runtime.ts")], outdir: join(root, "dist"), target: "node" });
    expect(built.success).toBe(true);
    const bundle = await import(join(root, "dist", "pipe-history-runtime.js"));
    // Resolved from the bundle, not from src: the pinned hash must hold there.
    const assets = bundle.pipeVtAssets(join(root, "dist"));
    expect(bundle.verifyPipeVtAssets(assets)).toMatch(/^[0-9a-f]{64}$/);
    const history = join(root, "history");
    const store = bundle.createProjectionStore({ historyRoot: history, mode: "create" });
    const runtime = bundle.createPipeHistoryRuntime({ store, assets });
    try {
      const pane = await runtime.addPane({
        paneKey: { serverIdentity: "bundle", paneId: "%1", birthGeneration: 1 }, session: "b", calibrate: false,
        meta: { cols: 30, rows: 3, alternate: false, cursor: { x: 0, y: 0, visible: true }, historySize: 0, historyLimit: 100, panePid: 1, mouseSgr: false, mouseAny: false },
        capture: () => Promise.reject(new Error("unused")),
      });
      const encoder = new TextEncoder();
      for (let i = 0; i < 8; i++) pane.ingest(encoder.encode(`ไทย 漢字 😀 ${i}\r\n`));
      const end = Date.now() + 15_000;
      while (pane.recentRows().length < 6 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pane.recentRows().length).toBeGreaterThanOrEqual(6);
      store.flush();
      const db = new Database(join(history, "newarch-v5/history.sqlite3"), { readonly: true });
      const rows = db.query("SELECT text FROM na_line ORDER BY line_id").all() as Array<{ text: string }>;
      db.close();
      expect(rows[0]!.text.trimEnd()).toBe("ไทย 漢字 😀 0");
      expect(rows.length).toBeGreaterThanOrEqual(6);
    } finally {
      await runtime.close();
      await store.close();
    }
  }, 60_000);
});

// ── NEWARCH R-PKG: the package exports the pipe-history runtime and its projection pieces ──
import { existsSync as sourceExists } from "node:fs";
import {
  PIPE_HISTORY_SUBPATHS,
  pipeHistoryReleaseExports,
  pipeHistoryWorkspaceExports,
  RELEASE_PACKAGE_EXPORTS,
} from "../../scripts/prepare-release-package";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");
const manifest = (rel: string) => JSON.parse(readFileSync(join(PACKAGE_ROOT, rel), "utf8"));

describe("NEWARCH R-PKG pipe-history package surface", () => {
  test("the release manifest maps ./pipe-history-runtime and every projection subpath onto git-dist/server", () => {
    const release = RELEASE_PACKAGE_EXPORTS as Record<string, unknown>;
    expect(Object.keys(PIPE_HISTORY_SUBPATHS)).toContain("./pipe-history-runtime");
    for (const [key, module] of Object.entries(PIPE_HISTORY_SUBPATHS)) {
      expect(release[key], key).toEqual({ types: `./git-dist/server/${module}.d.ts`, import: `./git-dist/server/${module}.js` });
    }
    expect(pipeHistoryReleaseExports() as Record<string, unknown>).toEqual(
      Object.fromEntries(Object.keys(PIPE_HISTORY_SUBPATHS).map((key) => [key, release[key]])) as Record<string, unknown>,
    );
  });

  test("the workspace root manifest names the same subpaths (git-dist requires what it names)", () => {
    const exportsMap = manifest("package.json").exports as Record<string, unknown>;
    const workspace = pipeHistoryWorkspaceExports();
    for (const key of Object.keys(PIPE_HISTORY_SUBPATHS)) expect(exportsMap[key], key).toEqual(workspace[key]);
    // No stray pipe-history keys beyond the declared list, in either manifest.
    const stray = (keys: string[]) => keys.filter((k) => /pipe-history-runtime|projection-|history-row-matcher/.test(k));
    expect(stray(Object.keys(exportsMap)).sort()).toEqual(Object.keys(PIPE_HISTORY_SUBPATHS).sort());
    expect(stray(Object.keys(RELEASE_PACKAGE_EXPORTS)).sort()).toEqual(Object.keys(PIPE_HISTORY_SUBPATHS).sort());
  });

  test("every exported module has a source file, a server build entry and a server subpath", () => {
    const server = manifest("server/package.json");
    const build: string = server.scripts.build;
    // Nested entries (sqlite-history/...) keep their path only with an explicit root.
    expect(build).toContain("--root src --outdir dist");
    const serverTargets = Object.values(server.exports as Record<string, { import?: string }>).map((e) => e.import);
    for (const module of Object.values(PIPE_HISTORY_SUBPATHS)) {
      expect(sourceExists(join(PACKAGE_ROOT, "server", "src", `${module}.ts`)), module).toBe(true);
      expect(build.split(" "), module).toContain(`src/${module}.ts`);
      expect(serverTargets, module).toContain(`./dist/${module}.js`);
    }
  });

  test("root, core, server, svelte and app ship one version and pin @thumbmux/* to it", () => {
    // The same five manifests check-release-version.ts reads before a tag.
    const version = manifest("package.json").version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const rel of ["core/package.json", "server/package.json", "svelte/package.json", "app/package.json"]) {
      const pkg = manifest(rel);
      expect(pkg.version, rel).toBe(version);
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        if (dep.startsWith("@thumbmux/")) expect(range, `${rel} ${dep}`).toBe(`^${version}`);
      }
    }
    expect(readFileSync(join(PACKAGE_ROOT, "CHANGELOG.md"), "utf8")).toContain(`## v${version} `);
  });
});
