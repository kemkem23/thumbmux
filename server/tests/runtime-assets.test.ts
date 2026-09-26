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
      wire: "newarch-frame-v1", projectionSchema: 3, metadataRevision: true, archiveReadVersions: [2, 3],
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
      const db = new Database(join(history, "newarch-v3/history.sqlite3"), { readonly: true });
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
