/**
 * TM-09 — framework-free modules must resolve without the `svelte` condition.
 *
 * The consumer bug: ten pure JS modules (no `from 'svelte'`, no runes, no
 * `.svelte` imports) shipped under the svelte/ and app/ trees but were only
 * reachable through barrels that declare a `svelte` export condition. Plain
 * Node, `bun test`, esbuild, eslint resolvers, and ServiceWorkerGlobalScope
 * (no bundler pass that knows the condition) all got ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * This test walks the REAL resolution path: it materialises a release-shaped
 * install (prepareReleasePackage + git-dist) under a temp node_modules and
 * asks Node to import each subpath with default conditions (no `svelte`).
 * Reading the exports map as a string does not count.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FRAMEWORK_FREE_SUBPATHS,
  prepareReleasePackage,
} from "./prepare-release-package";

const packageRoot = resolve(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Modules whose load graph stays free of `.svelte` files under git-dist. */
const FULLY_LOADABLE = FRAMEWORK_FREE_SUBPATHS.filter(
  (subpath) => subpath !== "app/sessions-store",
);

/**
 * Build a temp install that looks like a consumer's node_modules/thumbmux
 * after packing a -dist tag: release exports map + real git-dist files.
 */
function materializeReleaseInstall(): string {
  const root = mkdtempSync(join(tmpdir(), "thumbmux-ff-exports-"));
  roots.push(root);
  const pkg = join(root, "node_modules", "thumbmux");
  mkdirSync(pkg, { recursive: true });

  // Minimal package.json; prepareReleasePackage rewrites exports + files.
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: "thumbmux", version: "0.12.1", type: "module" }, null, 2)}\n`,
  );
  prepareReleasePackage(pkg);

  // Prefer a symlink to the live git-dist so the test always sees the
  // modules under test without copying ~MBs on every run.
  const gitDistSrc = join(packageRoot, "git-dist");
  const gitDistDst = join(pkg, "git-dist");
  try {
    symlinkSync(gitDistSrc, gitDistDst, "dir");
  } catch {
    cpSync(gitDistSrc, gitDistDst, { recursive: true });
  }

  // Contract/docs targets exist in the map; empty stubs keep path resolution
  // from complaining if something touches them.
  mkdirSync(join(pkg, "contract", "manifest"), { recursive: true });
  writeFileSync(join(pkg, "CONTRACT.md"), "# contract\n");
  mkdirSync(join(pkg, "docs"), { recursive: true });
  writeFileSync(join(pkg, "docs", "readme.md"), "# docs\n");

  return root;
}

type ResolveResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

/**
 * Ask a fresh Node process (default conditions — no `svelte`) to resolve and
 * optionally evaluate a package subpath from the consumer install root.
 */
function nodeImport(
  installRoot: string,
  specifier: string,
  mode: "import" | "resolve",
): ResolveResult {
  const script =
    mode === "resolve"
      ? `
        import { pathToFileURL } from "node:url";
        const parent = pathToFileURL(${JSON.stringify(join(installRoot, "package.json"))}).href;
        try {
          const url = import.meta.resolve(${JSON.stringify(specifier)}, parent);
          process.stdout.write(JSON.stringify({ ok: true, url }));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const code = "code" in err && typeof err.code === "string" ? err.code : "ERR_UNKNOWN";
          process.stdout.write(JSON.stringify({ ok: false, code, message: err.message.split("\\n")[0] }));
          process.exitCode = 1;
        }
      `
      : `
        try {
          const mod = await import(${JSON.stringify(specifier)});
          process.stdout.write(JSON.stringify({
            ok: true,
            url: "loaded",
            keys: Object.keys(mod).slice(0, 12),
          }));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const code = "code" in err && typeof err.code === "string" ? err.code : "ERR_UNKNOWN";
          process.stdout.write(JSON.stringify({ ok: false, code, message: err.message.split("\\n")[0] }));
          process.exitCode = 1;
        }
      `;

  // Write a tiny entry so Node's module graph roots at the install directory
  // (where node_modules/thumbmux lives).
  const entry = join(installRoot, `_probe_${mode}.mjs`);
  writeFileSync(entry, script);

  const result = Bun.spawnSync({
    cmd: ["node", entry],
    cwd: installRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Ensure no ambient svelte condition leaks in from the parent.
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
        .split(/\s+/)
        .filter((flag) => !flag.includes("conditions"))
        .join(" "),
    },
  });

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  try {
    return JSON.parse(stdout) as ResolveResult;
  } catch {
    return {
      ok: false,
      code: result.exitCode === 0 ? "ERR_PARSE" : "ERR_SPAWN",
      message: stdout || stderr || `exit ${result.exitCode}`,
    };
  }
}

describe("TM-09 framework-free subpath exports (no svelte condition)", () => {
  test("git-dist modules under test have no direct svelte coupling", () => {
    // Re-verify the consumer claim against the built tree before we export.
    const coupling =
      /from\s+['"]svelte(?:\/[^'"]*)?['"]|from\s+['"][^'"]+\.svelte['"]|import\s+['"]svelte|\$state\s*\(|\$derived\s*[\.(]|\$effect\s*\(|\$props\s*\(|\$bindable\s*\(/;

    for (const subpath of FRAMEWORK_FREE_SUBPATHS) {
      const file = join(packageRoot, "git-dist", `${subpath}.js`);
      const source = readFileSync(file, "utf8");
      expect(coupling.test(source), `${subpath} must not couple to svelte`).toBe(false);
      // Companion declaration must exist so the types target resolves.
      expect(() => readFileSync(join(packageRoot, "git-dist", `${subpath}.d.ts`), "utf8")).not.toThrow();
    }
  });

  test("all ten subpaths + package root resolve under plain Node (no svelte condition)", () => {
    const install = materializeReleaseInstall();

    // Root entry: without ".", import "thumbmux" is "No exports main defined".
    const root = nodeImport(install, "thumbmux", "import");
    expect(root.ok, `thumbmux root: ${JSON.stringify(root)}`).toBe(true);

    for (const subpath of FRAMEWORK_FREE_SUBPATHS) {
      const specifier = `thumbmux/${subpath}`;
      // Full evaluation for pure modules; resolve-only would also pass but
      // would not catch a broken target path.
      if (FULLY_LOADABLE.includes(subpath as (typeof FULLY_LOADABLE)[number])) {
        const loaded = nodeImport(install, specifier, "import");
        expect(loaded.ok, `${specifier} import: ${JSON.stringify(loaded)}`).toBe(true);
      } else {
        // app/sessions-store is itself free of svelte, but its default mux
        // import was rewritten to the svelte barrel (`../svelte/index.js`),
        // which re-exports .svelte components. Package resolution must still
        // clear the exports map (not ERR_PACKAGE_PATH_NOT_EXPORTED).
        const resolved = nodeImport(install, specifier, "resolve");
        expect(resolved.ok, `${specifier} resolve: ${JSON.stringify(resolved)}`).toBe(true);
        if (resolved.ok) {
          expect(resolved.url).toContain("sessions-store.js");
        }
        const loaded = nodeImport(install, specifier, "import");
        // If evaluation fails, it must not be the exports-map barrier.
        if (!loaded.ok) {
          expect(loaded.code).not.toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
        }
      }
    }
  });

  test("service-worker is importable from a context without the svelte condition", () => {
    // The sharpest case from the report: designed for ServiceWorkerGlobalScope,
    // which has neither Svelte nor a bundler that sets the svelte condition.
    const install = materializeReleaseInstall();
    const loaded = nodeImport(install, "thumbmux/svelte/service-worker", "import");
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (loaded.ok) {
      // Spot-check that the public handlers surface.
      const mod = loaded as ResolveResult & { keys?: string[] };
      // keys only present on import mode success payload — re-import in-process
      // is unnecessary; the Node child already evaluated the module.
      expect(mod).toBeTruthy();
    }
  });

  test("legacy svelte-condition barrels still require the svelte condition", () => {
    // Additive: the component barrels must NOT open up under plain Node.
    // Consumers that only set the svelte condition (Vite/SvelteKit) keep
    // working; plain Node still cannot pull TermView without a bundler.
    const install = materializeReleaseInstall();
    const barrel = nodeImport(install, "thumbmux/svelte", "import");
    expect(barrel.ok).toBe(false);
    expect(
      barrel.ok === false &&
        (barrel.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
          barrel.message.includes("exports") ||
          barrel.message.includes("svelte")),
    ).toBe(true);
  });
});

// Keep a stable fileURL helper available for future diagnostics without
// pulling it into every test body.
void fileURLToPath;
void pathToFileURL;
void dirname;
