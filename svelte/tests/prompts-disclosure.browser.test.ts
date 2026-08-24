/**
 * Real-layout proof for measured prompt disclosure. happy-dom cannot measure
 * overflow, so this file drives Chromium the same way the HUD title suite does.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { readFileSync, rmSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { FIXTURES, HOST_CSS, SYNTHETIC_CODEX_PROMPTS } from "./adaptive-prompt-fixtures";
const SYNTHETIC_FIRST = SYNTHETIC_CODEX_PROMPTS[0];

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, ".prompts-disclosure-entry.generated.ts");
const BROWSER_TEST_TIMEOUT_MS = 30_000;

const sveltePlugin: import("bun").BunPlugin = {
  // Bun runs test files concurrently. A distinct plugin name keeps this
  // browser build isolated from the older TermHud browser harness.
  name: "thumbmux-prompts-disclosure-browser",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, (args) => ({
      contents: compile(readFileSync(args.path, "utf8"), {
        filename: args.path,
        generate: "client",
        css: "injected",
      }).js.code,
      loader: "js",
    }));
  },
};

let browser: Browser;
let bundle: string;
const ISOLATED_BROWSER_CHILD = process.env.THUMBMUX_PROMPTS_BROWSER_CHILD === "1";

if (ISOLATED_BROWSER_CHILD) {
beforeAll(async () => {
  await Bun.write(
    ENTRY,
    `
import { mount } from "svelte";
import Scene from ${JSON.stringify(join(here, "AdaptivePromptScene.svelte"))};
const props = window.__sceneProps ?? { prompts: [] };
mount(Scene, { target: document.getElementById("app"), props });
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
  // beside this hook, and must never mistake Node-only Playwright modules for
  // dependencies of a generated browser entry.
  const { chromium } = require("@playwright/test") as typeof import("@playwright/test");
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  rmSync(ENTRY, { force: true });
});

async function render(page: Page, opts: { width: number; height: number; prompts: string[] }): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.setContent(
    `<!doctype html><html lang="th"><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%;
        --font-mono: ui-monospace, monospace; --font-thai: sans-serif;
        --hud: rgba(16,16,20,.95); --tbg: #101014; --tstage: #0a0a0d;
        --hud-fg: #e6e6e6; --hud-line: #34343a; --agent: #7dffa0; --tfg: #e6e6e6;
      }
      #app { position: relative; width: 100%; height: 100%; }
      ${HOST_CSS}
    </style></head><body>
      <div id="app"></div>
      <script>
        window.__pageErrors = [];
        window.addEventListener("error", (event) => window.__pageErrors.push(String(event.message || event.error)));
        window.addEventListener("unhandledrejection", (event) => window.__pageErrors.push(String(event.reason)));
        window.__sceneProps = ${JSON.stringify({ prompts: opts.prompts })};
        window.__sceneReady = false;
      </script>
      <script type="module">${bundle.replaceAll("</script", "<\\/script")}</script>
    </body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForFunction(() => (window as unknown as { __sceneReady?: boolean }).__sceneReady);
  await page.waitForSelector('[data-overflow-ready="true"]');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const inPage = await page.evaluate(() => (window as unknown as { __pageErrors?: string[] }).__pageErrors ?? []);
  expect([...pageErrors, ...inPage]).toEqual([]);
}

async function waitForTestIdText(page: Page, testId: string, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ testId, expected }) => document.querySelector(`[data-testid="${testId}"]`)?.textContent === expected,
    { testId, expected },
  );
}

async function waitForTestIdAttribute(
  page: Page,
  testId: string,
  name: string,
  expected: string,
): Promise<void> {
  await page.waitForFunction(
    ({ testId, name, expected }) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute(name) === expected,
    { testId, name, expected },
  );
}

async function waitForTestIdValue(page: Page, testId: string, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ testId, expected }) => (document.querySelector(`[data-testid="${testId}"]`) as HTMLTextAreaElement | null)?.value === expected,
    { testId, expected },
  );
}

describe("measured prompt disclosure", () => {
  test("2054x281 synthetic mixed-script prompts keep newest recall and recap inside the first body frame", async () => {
    const page = await browser.newPage();
    try {
      expect(SYNTHETIC_CODEX_PROMPTS.map((prompt) => prompt.length)).toEqual([485, 165, 542]);
      await render(page, { width: 2054, height: 281, prompts: [...SYNTHETIC_CODEX_PROMPTS] });
      const proof = await page.evaluate(() => {
        const inside = (inner: Element | null, outer: Element | null) => {
          if (!inner || !outer) return false;
          const a = inner.getBoundingClientRect();
          const b = outer.getBoundingClientRect();
          return a.x + 0.5 >= b.x
            && a.y + 0.5 >= b.y
            && a.x + a.width <= b.x + (outer as HTMLElement).clientWidth + 0.5
            && a.y + a.height <= b.y + (outer as HTMLElement).clientHeight + 0.5;
        };
        const body = document.querySelector("[data-testid='hud-panel-body']");
        const row = document.querySelector("[data-testid='prompt-item']");
        const recap = document.querySelector("[data-testid='session-recap-panel']");
        const cwd = document.querySelector("[data-testid='session-cwd-panel']");
        const more = document.querySelector("[data-testid='hud-panel-more']");
        return {
          rowInBody: inside(row, body),
          recapInBody: inside(recap, body),
          cwdInBody: inside(cwd, body),
          cue: !!more,
          bodyH: (body as HTMLElement | null)?.clientHeight ?? 0,
          rowH: row?.getBoundingClientRect().height ?? 0,
        };
      });
      expect(proof.bodyH).toBeGreaterThanOrEqual(128);
      expect(proof.rowInBody).toBe(true);
      expect(proof.recapInBody).toBe(true);
      expect(proof.cwdInBody).toBe(true);
      expect(proof.cue).toBe(true);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a ~485-char row that fits at 2054x281 has no disclosure", async () => {
    const page = await browser.newPage();
    try {
      await render(page, { width: 2054, height: 281, prompts: [SYNTHETIC_FIRST] });
      expect(SYNTHETIC_FIRST.length).toBeGreaterThan(480);
      expect(SYNTHETIC_FIRST.length).toBeLessThan(500);
      const row = page.getByTestId("prompt-item");
      expect(await row.textContent()).toBe(SYNTHETIC_FIRST);
      expect(await page.getByTestId("prompt-disclose").count()).toBe(0);
      const clip = await row.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect(clip).toBe(false);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a 500-unit row at phone width is clamped with a 44x44 disclosure", async () => {
    const page = await browser.newPage();
    try {
      const payload = "ก้ำไทยล้วน".repeat(80).slice(0, 500);
      await render(page, { width: 320, height: 568, prompts: [payload] });
      const row = page.getByTestId("prompt-item");
      const disclose = page.getByTestId("prompt-disclose");
      await disclose.scrollIntoViewIfNeeded();
      await disclose.waitFor({ state: "visible" });
      expect(await disclose.getAttribute("aria-expanded")).toBe("false");
      expect(await disclose.textContent()).toBe("แสดงทั้งหมด");
      const box = await disclose.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      const inPanel = await page.evaluate(() => {
        const btn = document.querySelector("[data-testid='prompt-disclose']");
        const body = document.querySelector("[data-testid='hud-panel-body']")
          ?? document.querySelector("[data-testid='hud-panel']");
        if (!btn || !body) return false;
        const b = btn.getBoundingClientRect();
        const s = body.getBoundingClientRect();
        return b.bottom > s.top + 1 && b.top < s.bottom - 1;
      });
      expect(inPanel).toBe(true);
      const cue = page.getByTestId("hud-panel-more");
      if (await cue.count()) {
        const cueBox = await cue.boundingBox();
        if (cueBox && box) {
          const overlap = box.x < cueBox.x + cueBox.width && box.x + box.width > cueBox.x
            && box.y < cueBox.y + cueBox.height && box.y + box.height > cueBox.y;
          expect(overlap).toBe(false);
        }
      }
      expect(await row.evaluate((el) => el.classList.contains("clamped"))).toBe(true);
      expect(await row.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
      await disclose.click();
      await waitForTestIdAttribute(page, "prompt-disclose", "aria-expanded", "true");
      await waitForTestIdText(page, "prompt-disclose", "ย่อ");
      expect(await row.evaluate((el) => el.classList.contains("clamped"))).toBe(false);
      expect(await row.textContent()).toBe(payload);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("resizing a clamped phone row to 2054x281 hides the now-unnecessary disclosure", async () => {
    const page = await browser.newPage();
    try {
      const payload = "EnglishOnlyBlock".repeat(40).slice(0, 500);
      await render(page, { width: 320, height: 568, prompts: [payload] });
      await page.getByTestId("prompt-disclose").waitFor({ state: "visible" });
      await page.setViewportSize({ width: 2054, height: 281 });
      await page.waitForFunction(() => {
        const panel = document.querySelector("[data-testid='prompts-panel']");
        return panel?.getAttribute("data-overflow-ready") === "true"
          && !document.querySelector("[data-testid='prompt-disclose']");
      });
      expect(await page.getByTestId("prompt-disclose").count()).toBe(0);
      const clip = await page.getByTestId("prompt-item").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect(clip).toBe(false);
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("every hostile row including embedded newlines prefills exactly", async () => {
    const page = await browser.newPage();
    try {
      const hostile = FIXTURES.find((item) => item.id === "hostile");
      if (!hostile) throw new Error("hostile fixture missing");
      expect(hostile.prompts.some((text) => text.includes("\n"))).toBe(true);
      await render(page, { width: 390, height: 844, prompts: [...hostile.prompts] });
      const rows = page.getByTestId("prompt-item");
      expect(await rows.count()).toBe(hostile.prompts.length);
      for (let i = 0; i < hostile.prompts.length; i++) {
        await rows.nth(i).scrollIntoViewIfNeeded();
        await rows.nth(i).click();
        await waitForTestIdValue(page, "composer-prefill", hostile.prompts[i]!);
        expect(await page.getByTestId("composer-prefill").inputValue()).toBe(hostile.prompts[i]!);
      }
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("overflowing panel scrolls for real and keeps the footer cue", async () => {
    const page = await browser.newPage();
    try {
      const five = FIXTURES.find((item) => item.id === "five-500");
      if (!five) throw new Error("five-500 fixture missing");
      await render(page, { width: 320, height: 568, prompts: [...five.prompts] });
      const newest = page.getByTestId("prompt-item").first();
      const newestBox = await newest.boundingBox();
      const panelBox = await page.getByTestId("hud-panel").boundingBox();
      expect(newestBox).not.toBeNull();
      expect(panelBox).not.toBeNull();
      expect(newestBox!.y).toBeGreaterThanOrEqual(panelBox!.y - 0.5);
      expect(newestBox!.y).toBeLessThan(panelBox!.y + panelBox!.height);
      await page.getByTestId("hud-panel-more").waitFor({ state: "visible" });
      const before = await page.getByTestId("hud-panel-body").evaluate((el) => el.scrollTop);
      await page.getByTestId("hud-panel-body").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const after = await page.getByTestId("hud-panel-body").evaluate((el) => ({
        top: el.scrollTop,
        overflow: el.scrollHeight > el.clientHeight + 1,
      }));
      expect(after.overflow).toBe(true);
      expect(after.top).toBeGreaterThan(before);
      await page.getByTestId("hud-panel-more").waitFor({ state: "visible" });
      expect(await page.getByTestId("hud-panel").getAttribute("data-scrollable")).toBe("true");
    } finally {
      await page.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});
} else {
  test("measured prompt disclosure passes in an isolated real-browser worker", async () => {
    // Bun.build calls from separate test files can overlap inside one aggregate
    // `bun test` process and cross-contaminate their loader graphs. Run this
    // harness in its own process so the public-tree parity command proves the
    // browser scenes instead of depending on test-file scheduling.
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      cwd: join(here, "../.."),
      env: { ...process.env, THUMBMUX_PROMPTS_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    if (status !== 0) throw new Error(`isolated prompt browser worker failed:\n${output}`);
    expect(output).toContain("6 pass");
    expect(output).toContain("0 fail");
  }, 240_000);
}
