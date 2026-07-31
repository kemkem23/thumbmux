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

function command(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  writeFileSync(join(CONSUMER_ROOT, "vite.config.ts"), [
    'import { svelte } from "@sveltejs/vite-plugin-svelte";',
    'import { defineConfig } from "vite";',
    "",
    "export default defineConfig({ plugins: [svelte()] });",
    "",
  ].join("\n"));
}

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
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
  });

  test("builds the client fence with Svelte 5 and Vite", () => {
    const { code } = extractQuickstart("client");
    writeClientProject(code);
    const result = command([
      join(CONSUMER_ROOT, "node_modules", ".bin", "vite"),
      "build",
    ], CONSUMER_ROOT);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(CONSUMER_ROOT, "dist", "index.html"))).toBe(true);
  });
});
