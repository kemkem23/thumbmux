/**
 * Real-browser proof for the Bash HIDE flicker report (2026-09-09).
 *
 * happy-dom reports the attributes TermView writes; only a real engine reports
 * the pixels a reader sees. This drives the shipping component in Chromium,
 * pushes the same live pane frames a streaming Claude session produces, and
 * measures the laid-out height of the Bash placeholder rows on every frame. A
 * frame-to-frame bounce in those numbers is the flicker kem reported.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, compileModule } from "svelte/compiler";
import { readFileSync, rmSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, `.bash-hide-flicker-entry.${process.pid}.${randomUUID()}.generated.ts`);
const BROWSER_TEST_TIMEOUT_MS = 60_000;

const sveltePkgPath = require.resolve("svelte/package.json");
const svelteClientEntry = join(dirname(sveltePkgPath), "src/index-client.js");

/** Bare `svelte` resolves to the server stub under Bun's default conditions. */
function rewriteSvelteBareImports(code: string): string {
  return code
    .replaceAll(/from\s*["']svelte["']/g, `from ${JSON.stringify(svelteClientEntry)}`)
    .replaceAll(/import\s*["']svelte["']/g, `import ${JSON.stringify(svelteClientEntry)}`);
}

const sveltePlugin: import("bun").BunPlugin = {
  name: "thumbmux-bash-hide-flicker-browser",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, (args) => ({
      contents: rewriteSvelteBareImports(compile(readFileSync(args.path, "utf8"), {
        filename: args.path,
        generate: "client",
        css: "injected",
      }).js.code),
      loader: "js",
    }));
    // TermView's mux and prefs are rune modules. Without this the bundle keeps
    // their `$state` calls, which a browser rejects as `rune_outside_svelte`.
    build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, (args) => {
      let source = readFileSync(args.path, "utf8");
      if (args.path.endsWith(".ts")) {
        source = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
      }
      return {
        contents: rewriteSvelteBareImports(compileModule(source, {
          filename: args.path,
          generate: "client",
        }).js.code),
        loader: "js",
      };
    });
  },
};

const COMPOSER_RULE = `\x1b[38;5;244m${"─".repeat(80)}`;
const SPINNER = ["·", "✢", "✳", "✻", "✽", "✶"];

const activityStatus = (glyph: string, detail: string) =>
  `\x1b[38;5;174m${glyph}\x1b[39m \x1b[38;5;174mThinking…\x1b[39m `
  + `\x1b[38;5;246m(${detail})\x1b[39m`;

const sparkleActivityStatus = (glyph: string, detail: string, sparkleAt: number) => {
  const verb = "Newspapering";
  const start = Math.max(0, Math.min(sparkleAt, verb.length - 3));
  const before = verb.slice(0, start);
  const sparkle = verb.slice(start, start + 3);
  const after = verb.slice(start + 3);
  return `\x1b[38;5;174m${glyph}\x1b[39m \x1b[38;5;174m${before}\x1b[38;5;216m${sparkle}`
    + `\x1b[38;5;174m${after}… \x1b[38;5;246m(${detail})\x1b[39m`;
};

/**
 * A live Claude pane: prose, two completed Bash groups, streamed tool output,
 * the activity status row, and pinned composer chrome. Streamed rows are
 * inserted above the status row exactly as Claude Code prints them.
 */
function livePane(status: string, streamedRows: number): string[] {
  return [
    "● อธิบายก่อน",
    "",
    "\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf one)",
    "\x1b[38;5;246m  ⎿  one",
    "",
    "● กลางทาง",
    "",
    "\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf two)",
    "\x1b[38;5;246m  ⎿  two",
    ...Array.from({ length: streamedRows }, (_, k) => `\x1b[38;5;246m     stream ${k}`),
    "",
    status,
    "",
    COMPOSER_RULE,
    "❯ ",
    COMPOSER_RULE,
  ];
}

let browser: Browser;
let bundle: string;
const ISOLATED_BROWSER_CHILD = process.env.THUMBMUX_FLICKER_BROWSER_CHILD === "1";

if (ISOLATED_BROWSER_CHILD) {
beforeAll(async () => {
  await Bun.write(
    ENTRY,
    `
import { mount } from "svelte";
import Scene from ${JSON.stringify(join(here, "TermViewFlickerScene.svelte"))};
mount(Scene, { target: document.getElementById("app") });
window.__sceneReady = true;
`,
  );
  const built = await Bun.build({
    entrypoints: [ENTRY],
    plugins: [sveltePlugin],
    target: "browser",
    minify: false,
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  bundle = await built.outputs[0]!.text();
  // Keep Playwright out of the static test graph: Bun browser builds can run
  // beside this hook and must never treat Node-only modules as dependencies
  // of a generated browser entry.
  const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  rmSync(ENTRY, { force: true });
});

async function render(page: Page): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.setViewportSize({ width: 390, height: 640 });
  await page.setContent(
    `<!doctype html><html lang="th"><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%;
        --font-mono: ui-monospace, monospace; --font-thai: sans-serif;
        --tbg: #101014; --tstage: #0a0a0d; --tfg: #e6e6e6;
      }
      #app { position: relative; width: 100%; height: 100%; }
    </style></head><body>
      <div id="app"></div>
      <script>
        window.__pageErrors = [];
        window.addEventListener("error", (e) => window.__pageErrors.push(String(e.message || e.error)));
        window.addEventListener("unhandledrejection", (e) => window.__pageErrors.push(String(e.reason)));
        window.__sceneReady = false;
      </script>
      <script type="module">${bundle.replaceAll("</script", "<\\/script")}</script>
    </body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => (window as unknown as { __termReady?: boolean }).__termReady);
  return pageErrors;
}

/** One measured frame: laid-out geometry read from the engine, not from props. */
type Measured = {
  placeholderHeights: number[];
  compactRows: number;
  contentHeight: number;
};

async function pushFrame(page: Page, lines: string[]): Promise<Measured> {
  await page.evaluate((payload) => {
    (window as unknown as { __feed: (rows: string[]) => void }).__feed(payload);
  }, lines);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  return page.evaluate(() => {
    const viewport = document.querySelector("[data-testid='mtv']");
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".mtv-bash-placeholder"));
    return {
      placeholderHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      compactRows: document.querySelectorAll(".mtv-bash-hidden").length,
      contentHeight: Number(viewport?.getAttribute("data-presentation-height") ?? -1),
    };
  });
}

describe("Bash HIDE geometry in a real engine", () => {
  test("streamed output never bounces a collapsed Bash row back to full height", async () => {
    const page = await browser.newPage();
    try {
      const pageErrors = await render(page);

      // Two steady frames arm the repaint proof, as a real pane does.
      await pushFrame(page, livePane(activityStatus(SPINNER[0]!, "10s · ↓ 1.0k tokens"), 0));
      const armed = await pushFrame(
        page,
        livePane(activityStatus(SPINNER[1]!, "11s · ↓ 1.1k tokens"), 0),
      );
      expect(armed.compactRows).toBe(2);
      // A compact divider is one third of a terminal row. Capture the height
      // the engine actually laid out as the baseline the reader sees.
      expect(armed.placeholderHeights).toHaveLength(2);
      const compactHeight = armed.placeholderHeights[0]!;
      expect(compactHeight).toBeGreaterThan(0);

      const observed: Measured[] = [];
      let streamedRows = 0;
      for (let frame = 0; frame < 12; frame += 1) {
        if (frame % 2 === 1) streamedRows += 1;
        observed.push(await pushFrame(page, livePane(
          activityStatus(
            SPINNER[frame % SPINNER.length]!,
            `${12 + frame}s · ↓ ${12 + frame}00 tokens`,
          ),
          streamedRows,
        )));
      }

      // Both dividers stay compact on every frame, at the same pixel height.
      expect(observed.map((entry) => entry.compactRows))
        .toEqual(observed.map(() => 2));
      for (const entry of observed) {
        expect(entry.placeholderHeights).toEqual([compactHeight, compactHeight]);
      }
      // The projected content height may only move forward with the stream.
      const heights = observed.map((entry) => entry.contentHeight);
      for (let index = 1; index < heights.length; index += 1) {
        expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1]!);
      }

      const inPage = await page.evaluate(
        () => (window as unknown as { __pageErrors?: string[] }).__pageErrors ?? [],
      );
      expect([...pageErrors, ...inPage]).toEqual([]);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("verb sparkle 216 never bounces a collapsed Bash row back to full height", async () => {
    const page = await browser.newPage();
    try {
      const pageErrors = await render(page);
      await pushFrame(page, livePane(activityStatus(SPINNER[0]!, "17m 38s · ↓ 46.7k tokens"), 0));
      const armed = await pushFrame(
        page,
        livePane(activityStatus(SPINNER[1]!, "17m 39s · ↓ 46.7k tokens"), 0),
      );
      expect(armed.compactRows).toBe(2);
      const compactHeight = armed.placeholderHeights[0]!;
      expect(compactHeight).toBeGreaterThan(0);

      const observed: Measured[] = [];
      for (let frame = 0; frame < 8; frame += 1) {
        const detail = `17m ${40 + frame}s · ↓ 46.${7 + (frame % 3)}k tokens`;
        const status = frame % 2 === 0
          ? sparkleActivityStatus(SPINNER[frame % SPINNER.length]!, detail, (frame * 2) % 10)
          : activityStatus(SPINNER[frame % SPINNER.length]!, detail);
        observed.push(await pushFrame(page, livePane(status, 0)));
      }

      expect(observed.map((entry) => entry.compactRows))
        .toEqual(observed.map(() => 2));
      for (const entry of observed) {
        expect(entry.placeholderHeights).toEqual([compactHeight, compactHeight]);
      }
      const heights = observed.map((entry) => entry.contentHeight);
      for (let index = 1; index < heights.length; index += 1) {
        expect(heights[index]).toBe(heights[0]!);
      }

      const inPage = await page.evaluate(
        () => (window as unknown as { __pageErrors?: string[] }).__pageErrors ?? [],
      );
      expect([...pageErrors, ...inPage]).toEqual([]);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});
} else {
  test("Bash HIDE geometry passes in an isolated real-browser worker", async () => {
    // Bun.build calls from separate test files can overlap inside one aggregate
    // `bun test` process and cross-contaminate their loader graphs. Run this
    // harness in its own process, matching the other browser scenes.
    // Synchronous supervision prevents the aggregate Bun event loop from
    // delaying child-output collection behind unrelated compile/test callbacks.
    // The local suite runner additionally schedules browser files after bulk
    // tests and holds the hard-sandbox host lease until cgroup cleanup finishes.
    const child = Bun.spawnSync({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      cwd: join(here, "../.."),
      env: { ...process.env, THUMBMUX_FLICKER_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 230_000,
      killSignal: "SIGKILL",
    });
    const status = child.exitCode;
    const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    if (status === null || child.signalCode) {
      throw new Error(`browser worker exceeded its execution budget; resource starvation vs code hang is undetermined:\n${output}`);
    }
    if (status !== 0) throw new Error(`isolated flicker browser worker failed:\n${output}`);
    expect(output).toContain("2 pass");
    expect(output).toContain("0 fail");
  }, 240_000);
}
