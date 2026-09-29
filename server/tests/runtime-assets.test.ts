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

// ── NEWARCH P2: worker↔main stage diagnostics (protocol contract, additive) ──
// Review §4.2: the old "parse" span (ingest -> onFrame) was queue + IPC + JSON +
// consumer, not parser CPU. These traces split it without changing framing.
import {
  PIPE_VT_TRACE_PENDING_MAX,
  PipeVtPool,
  PipeVtWorker,
  pipeVtAssets as vtAssets,
  pipeVtRunCells,
  type PipeVtAssets,
  type PipeVtRow,
  type PipeVtStageTrace,
  type PipeVtUpdate,
} from "../src/pipe-vt-worker";
import { strict as p2Assert } from "node:assert";

const p2Encoder = new TextEncoder();
const p2Sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const p2Text = (row: PipeVtRow) => row.map(pipeVtRunCells).flat().join("").trimEnd();

async function p2Until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("P2 condition not reached");
    await p2Sleep(5);
  }
}

type P2Pane = {
  worker: PipeVtWorker; traces: PipeVtStageTrace[]; updates: PipeVtUpdate[]; scrolled: string[];
  faults: string[]; fed: number; seq: number;
};

function p2Pane(options: { pool?: PipeVtPool; assets?: PipeVtAssets; cols?: number; rows?: number;
  consumer?: (update: PipeVtUpdate) => unknown } = {}): P2Pane {
  const pane: P2Pane = { worker: undefined!, traces: [], updates: [], scrolled: [], faults: [], fed: 0, seq: 0 };
  pane.worker = new PipeVtWorker({
    pool: options.pool, assets: options.assets, cols: options.cols ?? 80, rows: options.rows ?? 3,
    onFault: (fault) => { pane.faults.push(`${fault.kind}: ${fault.message}`); },
    onUpdate: (update) => {
      pane.updates.push(update);
      for (const scroll of update.scrolls) pane.scrolled.push(p2Text(scroll.row));
      return options.consumer?.(update);
    },
    onStageTrace: (trace) => { pane.traces.push(trace); },
  });
  return pane;
}

function p2Feed(pane: P2Pane, bytes: Uint8Array): boolean {
  const accepted = pane.worker.feed(pane.seq + 1, bytes);
  if (accepted) { pane.seq++; pane.fed++; }
  return accepted;
}

/** Invariants every trace stream must hold, whatever the timing. */
function p2AssertTraces(pane: P2Pane, label: string): void {
  const acked = pane.traces.reduce((sum, t) => sum + t.matchedFeeds, 0);
  expect(acked, `${label}: every fed seq acknowledged exactly once`).toBe(pane.fed);
  let lastSeq = -1;
  for (const t of pane.traces) {
    expect(t.worker, `${label}: worker stages present`).not.toBeNull();
    const w = t.worker!;
    if (t.seqTo !== null) { expect(t.seqTo, `${label}: seqTo never regresses`).toBeGreaterThanOrEqual(lastSeq); lastSeq = t.seqTo; }
    if (t.matchedFeeds > 0) {
      expect(w.inFrames, `${label}: worker frame count matches host seq span`).toBe(t.matchedFeeds);
      expect(t.seqFrom, `${label}: seqFrom within span`).toBe(t.seqTo! - t.matchedFeeds + 1);
      // Nested spans on one worker clock: wait + parse happen inside hold.
      expect(w.holdNs, `${label}: hold covers wait+parse`).toBeGreaterThanOrEqual(w.waitNs + w.parseNs);
      expect(w.maxWaitNs).toBeGreaterThanOrEqual(w.waitNs);
      expect(w.readLagMaxNs, `${label}: read lag bounds ordered`).toBeGreaterThanOrEqual(w.readLagNs);
      // The lower read-lag bound happened between the host feed and the worker read.
      expect(t.transportMs! + 0.05, `${label}: read lag inside transport`).toBeGreaterThanOrEqual(w.readLagNs / 1e6);
      // Residual of nested durations (feed precedes worker receipt, arrival follows serialize).
      expect(t.transportMs!, `${label}: transport residual non-negative`).toBeGreaterThanOrEqual(-0.05);
      expect(t.feedToConsumedMs!).toBeGreaterThanOrEqual(t.feedToArrivalMs!);
    }
    expect(w.serializeNs, `${label}: serialize measured`).toBeGreaterThan(0);
    expect(t.mainQueueMs).toBeGreaterThanOrEqual(0);
    expect(t.decodeMs).toBeGreaterThanOrEqual(0);
    expect(t.consumerMs).toBeGreaterThanOrEqual(0);
  }
  expect(pane.worker.traceBacklog().pending, `${label}: nothing left unacknowledged`).toBe(0);
  expect(pane.worker.traceBacklog().dropped).toBe(0);
}

function p2Percentile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!.toFixed(3));
}

function p2Summary(traces: PipeVtStageTrace[]) {
  const acked = traces.filter((t) => t.matchedFeeds > 0);
  const ms = (ns: number) => ns / 1e6;
  const stat = (pick: (t: PipeVtStageTrace) => number) => {
    const xs = acked.map(pick);
    return { p50: p2Percentile(xs, 0.5), p95: p2Percentile(xs, 0.95), max: p2Percentile(xs, 1) };
  };
  return {
    updates: acked.length,
    feedToConsumedMs: stat((t) => t.feedToConsumedMs!),
    feedToArrivalMs: stat((t) => t.feedToArrivalMs!),
    workerWaitMs: stat((t) => ms(t.worker!.waitNs)),
    workerHoldMs: stat((t) => ms(t.worker!.holdNs)),
    parseCpuMs: stat((t) => ms(t.worker!.parseNs)),
    encodeMs: stat((t) => ms(t.worker!.encodeNs)),
    serializeMs: stat((t) => ms(t.worker!.serializeNs)),
    transportMs: stat((t) => t.transportMs!),
    readLagMs: stat((t) => ms(t.worker!.readLagNs)),
    readLagMaxMs: stat((t) => ms(t.worker!.readLagMaxNs)),
    mainQueueMs: stat((t) => t.mainQueueMs),
    decodeMs: stat((t) => t.decodeMs),
    consumerMs: stat((t) => t.consumerMs),
    bodyBytes: stat((t) => t.bodyBytes),
  };
}

const P2_LINE = "ไทย 漢字 😀 é \x1b[1;31mred\x1b[0m \x1b]0;title\x07tail";
const P2_EXPECT = "ไทย 漢字 😀 é red tail";

describe("NEWARCH P2 pipe-vt stage diagnostics", () => {
  for (const shared of [false, true]) test(`${shared ? "shared" : "dedicated"}: UTF-8/escape split at every byte boundary keeps rows and accounts every seq`, async () => {
    const pool = shared ? new PipeVtPool() : undefined;
    const pane = p2Pane({ pool });
    try {
      await pane.worker.start();
      const line = p2Encoder.encode(`${P2_LINE}\r\n`);
      // Each line is split once at boundary k, so every byte offset is a chunk edge.
      for (let k = 1; k < line.length; k++) {
        expect(p2Feed(pane, line.subarray(0, k))).toBe(true);
        expect(p2Feed(pane, line.subarray(k))).toBe(true);
        if (k % 16 === 0) await p2Sleep(2);
      }
      const receipt = await pane.worker.close(10_000);
      expect(receipt.workerEof && receipt.outputDrained && !receipt.unknownTail).toBe(true);
      expect(pane.faults).toEqual([]);
      const lines = line.length - 1;
      expect(pane.scrolled.length).toBe(lines - 2);
      expect(new Set(pane.scrolled)).toEqual(new Set([P2_EXPECT]));
      expect(pane.traces.reduce((sum, t) => sum + (t.matchedFeeds > 0 ? t.worker!.inBytes : 0), 0)).toBe(lines * line.length);
      expect(pane.traces.at(-1)!.seqTo).toBe(pane.seq);
      p2AssertTraces(pane, shared ? "shared" : "dedicated");
    } finally { await pane.worker.close(1000); await pool?.close(); }
  }, 60_000);

  test("fairness 1 noisy + 20 quiet on one interpreter: stage attribution per class, nothing lost", async () => {
    const pool = new PipeVtPool();
    const quiet = Array.from({ length: 20 }, () => p2Pane({ pool, cols: 120, rows: 40 }));
    const noisy = p2Pane({ pool, cols: 120, rows: 40 });
    const all = [noisy, ...quiet];
    const phases: Record<string, unknown> = {};
    try {
      await Promise.all(all.map((p) => p.worker.start()));
      expect(new Set(all.map((p) => p.worker.pid)).size).toBe(1);
      const burst = p2Encoder.encode(Array.from({ length: 64 }, (_, i) => `\x1b[3${i % 8}mnoisy ${i} ${"x".repeat(90)}\x1b[0m\r\n`).join(""));
      let noisyRejected = 0;
      for (const phase of ["quiet-only", "noisy"] as const) {
        const marks = all.map((p) => p.traces.length);
        const end = Date.now() + 4000;
        let tick = 0;
        while (Date.now() < end) {
          // 20 quiet panes at ~0.5 row/s each is too sparse for 4 s: 20 rows/s total, staggered.
          const q = quiet[tick % quiet.length]!;
          p2Feed(q, p2Encoder.encode(`quiet ${tick} ไทย\r\n`));
          if (phase === "noisy") {
            for (let i = 0; i < 8; i++) if (!p2Feed(noisy, burst)) noisyRejected++;
          }
          tick++;
          await p2Sleep(50);
        }
        await p2Until(() => all.every((p) => p.worker.traceBacklog().pending === 0), 30_000);
        phases[phase] = {
          quiet: p2Summary(quiet.flatMap((p, i) => p.traces.slice(marks[i + 1]))),
          noisy: p2Summary(noisy.traces.slice(marks[0])),
        };
      }
      const receipts = await Promise.all(all.map((p) => p.worker.close(10_000)));
      expect(receipts.every((r) => r.workerEof && r.outputDrained && !r.unknownTail)).toBe(true);
      for (const [i, p] of all.entries()) {
        expect(p.faults).toEqual([]);
        p2AssertTraces(p, i === 0 ? "noisy" : `quiet ${i}`);
      }
      // Quiet rows arrive intact and in order despite the noisy neighbour.
      for (const p of quiet) {
        const rows = [...p.scrolled, ...Object.values(p.updates.at(-1)!.frame.dirty).map(p2Text)].filter((r) => r.startsWith("quiet"));
        const ticks = rows.map((r) => Number(r.split(" ")[1]));
        expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
      }
      expect(noisy.fed).toBeGreaterThan(0);
      console.log(`P2-ATTRIBUTION ${JSON.stringify({ fixture: "1 noisy (8x64 SGR rows/50ms) + 20 quiet (1 row/50ms round-robin), 120x40, one interpreter, trivial consumer", noisyFed: noisy.fed, noisyRejected, quietFed: quiet.reduce((s, p) => s + p.fed, 0), phases })}`);
    } finally { await Promise.all(all.map((p) => p.worker.close(1000))); await pool.close(); }
  }, 90_000);

  test("consumer pressure is reported as main-queue and consumer time, not as parse, and loses nothing", async () => {
    const pane = p2Pane({ consumer: () => p2Sleep(15) });
    try {
      await pane.worker.start();
      for (let i = 0; i < 40; i++) { expect(p2Feed(pane, p2Encoder.encode(`row ${i}\r\n`))).toBe(true); await p2Sleep(3); }
      await p2Until(() => pane.worker.traceBacklog().pending === 0, 20_000);
      const receipt = await pane.worker.close(10_000);
      expect(receipt.workerEof && receipt.outputDrained && !receipt.unknownTail).toBe(true);
      p2AssertTraces(pane, "slow consumer");
      const acked = pane.traces.filter((t) => t.matchedFeeds > 0);
      expect(Math.min(...acked.map((t) => t.consumerMs))).toBeGreaterThanOrEqual(14);
      // Updates queued behind the 15 ms consumer: the wait shows up on main, not in the worker.
      expect(Math.max(...acked.map((t) => t.mainQueueMs))).toBeGreaterThan(10);
      expect(Math.max(...acked.map((t) => t.worker!.parseNs / 1e6))).toBeLessThan(Math.max(...acked.map((t) => t.mainQueueMs)));
      expect(pane.scrolled).toEqual(Array.from({ length: 38 }, (_, i) => `row ${i}`));
    } finally { await pane.worker.close(1000); }
  }, 30_000);

  test("full data budget: control reserve still admits frames, rejected feeds are not traced, backlog stays bounded", async () => {
    const pool = new PipeVtPool();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pane = p2Pane({ pool, consumer: () => gate });
    try {
      await pane.worker.start();
      const chunk = p2Encoder.encode(`${"z".repeat(1000)}\r\n`);
      let rejected = 0;
      const end = Date.now() + 20_000;
      while (rejected === 0 && Date.now() < end) {
        if (!p2Feed(pane, chunk)) rejected++;
        if (pane.fed % 64 === 0) await p2Sleep(1);
      }
      expect(rejected).toBe(1);
      expect(pane.worker.canAccept(chunk.byteLength)).toBe(false);
      expect(pane.worker.resize(100, 3, 1)).toBe(true);
      const backlog = pane.worker.traceBacklog();
      expect(backlog.pending).toBeLessThanOrEqual(pane.fed);
      expect(backlog.retained).toBeLessThanOrEqual(2 * Math.max(backlog.pending, 1024) + 1);
      release();
      await p2Until(() => pane.worker.traceBacklog().pending === 0, 30_000);
      expect((await pane.worker.close(10_000)).unknownTail).toBe(false);
      p2AssertTraces(pane, "budget");
    } finally { release(); await pane.worker.close(1000); await pool.close(); }
  }, 60_000);

  test("trace columns are compacted: thousands of acknowledged feeds keep retained storage bounded", async () => {
    const pane = p2Pane();
    try {
      await pane.worker.start();
      let peak = 0;
      for (let i = 0; i < 6000; i++) {
        expect(p2Feed(pane, p2Encoder.encode(`${i}\n`))).toBe(true);
        if (i % 200 === 199) {
          await p2Until(() => pane.worker.traceBacklog().pending === 0);
          peak = Math.max(peak, pane.worker.traceBacklog().retained);
        }
      }
      expect(peak).toBeLessThanOrEqual(2 * 1024 + 200);
      expect(PIPE_VT_TRACE_PENDING_MAX).toBeGreaterThan(1024);
      await pane.worker.close(10_000);
      p2AssertTraces(pane, "compaction");
    } finally { await pane.worker.close(1000); }
  }, 60_000);

  test("quit acknowledges the final traced update; kill faults without inventing acknowledgements", async () => {
    const quit = p2Pane();
    await quit.worker.start();
    for (let i = 0; i < 5; i++) p2Feed(quit, p2Encoder.encode(`q${i}\r\n`));
    const receipt = await quit.worker.close(10_000);
    expect(receipt.workerEof && !receipt.unknownTail).toBe(true);
    expect(quit.traces.at(-1)!.seqTo).toBe(5);
    p2AssertTraces(quit, "quit");

    const pool = new PipeVtPool();
    const killed = p2Pane({ pool });
    try {
      await killed.worker.start();
      p2Feed(killed, p2Encoder.encode("before\r\n"));
      await p2Until(() => killed.worker.traceBacklog().pending === 0);
      const traced = killed.traces.length;
      killed.worker.kill("SIGKILL");
      await p2Until(() => killed.faults.some((f) => f.startsWith("worker-exit")));
      expect(p2Feed(killed, p2Encoder.encode("after\r\n"))).toBe(false);
      expect(killed.traces.length).toBe(traced);
      expect(killed.worker.traceBacklog().pending).toBe(0);
    } finally { await killed.worker.close(1000); await pool.close(); }
  }, 30_000);

  // In-test mutation witnesses on the real Python worker (review §6 P2 gate).
  for (const mutation of ["serialize-not-spliced", "rx-stamped-at-dispatch"] as const) test(
    `P2 mutation ${mutation}: clean passes, damaged worker is detected`, async () => {
      const assert: typeof p2Assert = p2Assert;
      const original = vtAssets();
      const source = readFileSync(original.worker, "utf8");
      const [before, after] = mutation === "serialize-not-spliced"
        ? ['        body = body[:-1] + b\',"serializeNs":%d}\' % (time.monotonic_ns() - began)\n', "        pass\n"]
        : ['                        rx = c["rx"].completed(5 + length)\n', '                        c["rx"].completed(5 + length); rx = None\n'];
      expect(source).toContain(before);
      async function witness(mutated: boolean) {
        const dir = mkdtempSync(join(tmpdir(), `p2-mutation-${mutation}-`)); roots.push(dir);
        const assets = vtAssets(dir);
        writeFileSync(assets.worker, mutated ? source.replace(before, after) : source);
        writeFileSync(assets.vendor, readFileSync(original.vendor));
        writeFileSync(assets.license, readFileSync(original.license));
        const pool = new PipeVtPool({ assets });
        const pane = p2Pane({ pool, assets });
        try {
          await pane.worker.start();
          // 24 x 16 KiB in one go: the 64 KiB per-turn budget makes later frames wait.
          const big = p2Encoder.encode(`${"w".repeat(16 * 1024 - 2)}\r\n`);
          for (let i = 0; i < 24; i++) assert.ok(p2Feed(pane, big));
          await p2Until(() => pane.worker.traceBacklog().pending === 0, 20_000);
          await pane.worker.close(10_000);
          for (const t of pane.traces) assert.ok((t.worker?.serializeNs ?? 0) > 0, "serializeNs missing");
          assert.ok(pane.traces.some((t) => t.worker!.maxWaitNs > 0), "no D frame ever waited under the per-turn budget");
          const acked = pane.traces.reduce((s, t) => s + t.matchedFeeds, 0);
          assert.equal(acked, 24);
        } finally { await pane.worker.close(1000); await pool.close(); }
      }
      await witness(false);
      await assert.rejects(witness(true), { name: "AssertionError" });
      console.log(`P2 mutation ${mutation}: clean=PASS damaged=DETECTED (real multiplex Python)`);
    }, 60_000);
});
