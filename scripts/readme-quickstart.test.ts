import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

setDefaultTimeout(120_000);

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const README_PATH = join(PACKAGE_ROOT, "README.md");
const README = readFileSync(README_PATH, "utf8");
const WORK_ROOT = mkdtempSync(join(tmpdir(), "thumbmux-readme-quickstart-"));
const CONSUMER_ROOT = join(WORK_ROOT, "consumer");

type QuickstartName = "server" | "client";

type Fence = {
  code: string;
  language: string;
  marked: boolean;
};

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

/** Bounds one shell-out. Must stay well under BUILD_AND_BROWSE_TIMEOUT_MS so a
 *  hung command names itself instead of expiring together with its test. */
const COMMAND_TIMEOUT_MS = 240_000;

function command(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): CommandResult {
  // Every synchronous shell-out in this file goes through here — installs,
  // typechecks, bundler builds — and an unbounded spawnSync is how a runner
  // waiting on a network fetch becomes a job that never ends. A wait inside a
  // child is invisible to bun's own --timeout, so the child needs its own.
  //
  // It must be MEANINGFULLY SMALLER than the per-test budget. It was 600_000,
  // the same number as BUILD_AND_BROWSE_TIMEOUT_MS, so the test always expired
  // first and the message below — written precisely to name which command hung —
  // was unreachable. Two releases were spent reading "this test timed out after
  // 600000ms", which says nothing, while the sentence that would have said
  // everything sat one layer down and never fired. A bound equal to the bound
  // above it is not a bound; it is a slower way to learn nothing.
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode === null) {
    throw new Error(
      `quickstart command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: ${cmd.join(" ")} (cwd ${cwd})`,
    );
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function requireCommand(cmd: string[], cwd: string): string {
  const result = command(cmd, cwd);
  if (result.exitCode !== 0) {
    throw new Error([
      `command failed (${result.exitCode}): ${cmd.join(" ")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

function parseFirstFence(source: string): Omit<Fence, "marked"> {
  const match = source.match(/^\s*```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/);
  if (!match) throw new Error("quickstart marker is not followed by a fenced block");
  return {
    language: match[1]!.trim().toLowerCase(),
    code: match[2]!,
  };
}

function extractQuickstart(name: QuickstartName): Fence {
  const marker = `<!-- quickstart:${name} -->`;
  const markerIndex = README.indexOf(marker);
  if (markerIndex >= 0) {
    return {
      ...parseFirstFence(README.slice(markerIndex + marker.length)),
      marked: true,
    };
  }

  // The legacy fallback exists only so the first run against the pre-D1 README
  // executes its advertised server block and proves the harness catches the
  // unresolved driver/pipes placeholders. The marker assertion below keeps
  // that unmarked layout from ever passing.
  if (name === "server") {
    const headingIndex = README.indexOf("**Server**");
    const openingIndex = README.indexOf("```", headingIndex);
    if (headingIndex >= 0 && openingIndex >= 0) {
      return {
        ...parseFirstFence(README.slice(openingIndex)),
        marked: false,
      };
    }
  }

  throw new Error(`README is missing ${marker}`);
}

function copyPackageInput(packageRoot: string): void {
  for (const path of ["package.json", "README.md", "LICENSE", "docs", "git-dist"]) {
    const source = join(PACKAGE_ROOT, path);
    if (!existsSync(source)) throw new Error(`missing package input: ${path}`);
    cpSync(source, join(packageRoot, path), { recursive: true });
  }
}

function packGitDist(): string {
  const packageRoot = join(WORK_ROOT, "package");
  mkdirSync(packageRoot, { recursive: true });
  copyPackageInput(packageRoot);

  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  delete manifest.scripts;
  delete manifest.workspaces;
  manifest.exports = {
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
  };
  manifest.files = ["git-dist", "docs"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  requireCommand(["npm", "pack", "--pack-destination", WORK_ROOT, "--silent"], packageRoot);
  const tarball = readdirSync(WORK_ROOT)
    .find((entry) => entry.startsWith("thumbmux-") && entry.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no thumbmux tarball");
  return join(WORK_ROOT, tarball);
}

function installConsumer(tarball: string): void {
  mkdirSync(join(CONSUMER_ROOT, "src"), { recursive: true });
  writeFileSync(join(CONSUMER_ROOT, "package.json"), `${JSON.stringify({
    name: "thumbmux-readme-quickstart",
    private: true,
    type: "module",
    dependencies: {
      svelte: "^5.51.0",
      thumbmux: `file:${tarball}`,
    },
    devDependencies: {
      "@sveltejs/vite-plugin-svelte": "^6.2.1",
      "@types/bun": "^1.3.0",
      typescript: "^5.9.3",
      vite: "^7.3.1",
    },
  }, null, 2)}\n`);
  requireCommand(["bun", "install", "--ignore-scripts"], CONSUMER_ROOT);

  const installed = realpathSync(join(CONSUMER_ROOT, "node_modules", "thumbmux"));
  const expectedPrefix = `${realpathSync(join(CONSUMER_ROOT, "node_modules"))}${sep}`;
  if (!installed.startsWith(expectedPrefix)) {
    throw new Error("quickstart consumer did not install its packed thumbmux copy");
  }
  if (!existsSync(join(installed, "git-dist", "app", "index.js"))) {
    throw new Error("quickstart consumer did not receive the git-dist app entrypoint");
  }
}

function writeServerProject(code: string): void {
  writeFileSync(join(CONSUMER_ROOT, "server.ts"), `${code}\n`);
  writeFileSync(join(CONSUMER_ROOT, "tsconfig.server.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: ["bun-types"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ["server.ts"],
  }, null, 2)}\n`);
}

function writeClientProject(code: string): void {
  writeFileSync(join(CONSUMER_ROOT, "index.html"), [
    "<!doctype html>",
    '<html lang="en">',
    '  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>',
    "</html>",
    "",
  ].join("\n"));
  writeFileSync(join(CONSUMER_ROOT, "src", "main.ts"), `${code}\n`);
  writeFileSync(join(CONSUMER_ROOT, "tsconfig.client.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ["src/main.ts"],
  }, null, 2)}\n`);
  writeFileSync(join(CONSUMER_ROOT, "vite.config.ts"), [
    'import { svelte } from "@sveltejs/vite-plugin-svelte";',
    'import { defineConfig } from "vite";',
    "",
    "export default defineConfig({ plugins: [svelte()] });",
    "",
  ].join("\n"));
}

function typecheckClient(): CommandResult {
  return command([
    join(CONSUMER_ROOT, "node_modules", ".bin", "tsc"),
    "-p",
    "tsconfig.client.json",
  ], CONSUMER_ROOT);
}

function buildClient(): CommandResult {
  return command([
    join(CONSUMER_ROOT, "node_modules", ".bin", "vite"),
    "build",
  ], CONSUMER_ROOT);
}

async function waitForHttp(origin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch { /* preview is still starting */ }
    await Bun.sleep(25);
  }
  throw new Error(`Vite preview did not start at ${origin}`);
}

async function executeBuiltClient(): Promise<string[]> {
  const started = performance.now();
  const mark = (phase: string) =>
    console.log(`[quickstart] ${phase} at ${Math.round(performance.now() - started)}ms`);
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const preview = Bun.spawn({
    cmd: [
      join(CONSUMER_ROOT, "node_modules", ".bin", "vite"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    cwd: CONSUMER_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    mark("preview-spawned");
    await waitForHttp(origin);
    mark("preview-listening");
    browser = await chromium.launch({ headless: true });
    mark("browser-launched");
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    try {
      await page.locator('[data-testid="hub-view"]').waitFor({ timeout: 5_000 });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await page.waitForTimeout(100);
    mark("page-settled");
  } finally {
    // Both teardown steps are bounded. This test's assertions are satisfied
    // before we get here, so anything that stalls now turns a passing test into
    // a timeout that names the wrong thing — which is exactly what shipped a
    // red release twice. `browser.close()` on a page that threw during startup
    // is the second candidate after the preview server, and neither is worth a
    // suite that never returns.
    await bounded(browser?.close(), 15_000, "browser.close");
    await stopPreview(preview);
  }
  return errors;
}

/** Await a promise, or give up after ms. Never rejects — teardown failures must
 *  not mask the assertion result the caller already has. */
async function bounded<T>(work: Promise<T> | undefined, ms: number, label: string): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  void label;
}

/** Stop the preview server without an unbounded wait on its exit.
 *
 * `preview.kill()` sends SIGTERM and `await preview.exited` waits forever if the
 * process declines to take it. On the two-core CI runner this is exactly what
 * happened: 479 tests passed and this one alone burned the whole 600s budget
 * after its assertions were already satisfied, so the failure looked like the
 * bundle test and was really the teardown. Escalate to SIGKILL, and stop waiting
 * either way — a leaked preview process is a smaller problem than a suite that
 * never returns, and the runner reaps it when the job ends.
 */
async function stopPreview(preview: { kill: (signal?: number | NodeJS.Signals) => void; exited: Promise<number> }): Promise<void> {
  const settled = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    try {
      return await Promise.race([preview.exited.then(() => true as const), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  preview.kill();
  if (await settled(5_000)) return;
  preview.kill("SIGKILL");
  await settled(5_000);
}

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (typeof port !== "number") throw new Error("Bun did not allocate a preview port");
  return port;
}

async function waitForSessions(origin: string): Promise<unknown[]> {
  const deadline = Date.now() + 10_000;
  let lastError = "server did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/sessions`, { cache: "no-store" });
      if (!response.ok) {
        lastError = `GET /api/sessions returned ${response.status}`;
      } else {
        const value: unknown = await response.json();
        if (!Array.isArray(value)) throw new Error("GET /api/sessions was not a JSON array");
        return value;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(25);
  }
  throw new Error(lastError);
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket upgrade timed out")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket upgrade failed"));
    }, { once: true });
  });
  return socket;
}

beforeAll(() => {
  installConsumer(packGitDist());
});

afterAll(() => {
  rmSync(WORK_ROOT, { recursive: true, force: true });
});

/**
 * These tests do not call a function — each installs a real consumer, runs tsc,
 * runs a Vite build and drives headless Chromium. On the two-core CI runner that
 * is minutes of honest work, and the suite-wide `--timeout 120000` (which exists
 * to name a genuine hang quickly) fires on it. A ceiling tight enough to trip on
 * healthy work manufactures failures and destroys the evidence that would tell
 * the two apart — that mistake cost five release attempts on 2026-08-06. So the
 * budget is raised HERE, per test, and nowhere else.
 */
const BUILD_AND_BROWSE_TIMEOUT_MS = 600_000;

describe("README quickstart", () => {
  test("marks two complete copyable fences", () => {
    expect(README.match(/^## Quickstart$/gm)).toHaveLength(1);
    for (const name of ["server", "client"] satisfies QuickstartName[]) {
      expect(README.match(new RegExp(`<!-- quickstart:${name} -->`, "g"))).toHaveLength(1);
    }

    const server = extractQuickstart("server");
    const client = extractQuickstart("client");

    expect(server.marked).toBe(true);
    expect(client.marked).toBe(true);
    expect(server.language).toBe("ts");
    expect(client.language).toBe("ts");
    for (const fence of [server, client]) {
      expect(fence.code).not.toContain("...");
      expect(fence.code).not.toMatch(/\bplaceholder\b/i);
    }
  });

  test("installs and runs the server fence over HTTP and WebSocket", async () => {
    const { code } = extractQuickstart("server");
    writeServerProject(code);

    const typecheck = command([
      join(CONSUMER_ROOT, "node_modules", ".bin", "tsc"),
      "-p",
      "tsconfig.server.json",
    ], CONSUMER_ROOT);
    expect(`${typecheck.stdout}${typecheck.stderr}`).toBe("");
    expect(typecheck.exitCode).toBe(0);

    const port = await reservePort();
    const processHandle = Bun.spawn({
      cmd: ["bun", "run", "server.ts"],
      cwd: CONSUMER_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const origin = `http://127.0.0.1:${port}`;
    let socket: WebSocket | null = null;
    try {
      const sessions = await waitForSessions(origin);
      expect(Array.isArray(sessions)).toBe(true);
      socket = await openWebSocket(`ws://127.0.0.1:${port}/ws/tmux`);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket?.close();
      processHandle.kill();
      await processHandle.exited;
    }
  }, BUILD_AND_BROWSE_TIMEOUT_MS);

  test("type-checks, builds, and executes the client fence with Svelte 5 and Vite", async () => {
    const { code } = extractQuickstart("client");
    writeClientProject(code);
    const typecheck = typecheckClient();
    expect(`${typecheck.stdout}${typecheck.stderr}`).toBe("");
    expect(typecheck.exitCode).toBe(0);
    const result = buildClient();
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(CONSUMER_ROOT, "dist", "index.html"))).toBe(true);
    expect(await executeBuiltClient()).toEqual([]);
  }, BUILD_AND_BROWSE_TIMEOUT_MS);

  test("client gate rejects semantic TypeScript errors", () => {
    const { code } = extractQuickstart("client");
    writeClientProject(`${code}\nconst incompatible: string = 1;`);
    const result = typecheckClient();

    expect(result.exitCode).not.toBe(0);
  });

  test("client gate rejects a bundle that throws during startup", async () => {
    writeClientProject('throw new Error("quickstart startup mutation");');
    expect(typecheckClient().exitCode).toBe(0);
    expect(buildClient().exitCode).toBe(0);
    expect(await executeBuiltClient()).toContain("quickstart startup mutation");
  }, BUILD_AND_BROWSE_TIMEOUT_MS);
});
