/**
 * Playwright driver for scripts/capture-media.sh.
 *
 * Talks to the demo published from a blank container. The host's tmux is
 * never in the picture: the hub is asserted to contain exactly the four
 * staged names, and the run fails if any other session appears.
 */
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEMO_URL = process.env.DEMO_URL;
const OUT_DIR = process.env.THUMBMUX_MEDIA_OUT;
const ARTIFACTS = process.env.THUMBMUX_MEDIA_ARTIFACTS ?? "/tmp/thumbmux-media-artifacts";

if (!DEMO_URL) throw new Error("DEMO_URL is required");
if (!OUT_DIR) throw new Error("THUMBMUX_MEDIA_OUT is required");

const ALLOWED = ["agent", "build", "htop", "server-logs"] as const;
const PHONE = { width: 390, height: 664 };
const DESKTOP = { width: 1440, height: 860 };
const DARK = "#101014";
const BLUE = "#0b1c3d";
const CREAM = "#f5f0e8";

function withParams(extras: Record<string, string> = {}): string {
  const url = new URL(DEMO_URL!);
  url.searchParams.set("media", "1");
  for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
  return url.toString();
}

async function newContext(
  browser: Browser,
  kind: "phone" | "desktop",
  themeBg = DARK,
): Promise<BrowserContext> {
  const viewport = kind === "phone" ? PHONE : DESKTOP;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: kind === "phone",
    hasTouch: kind === "phone",
    colorScheme: themeBg === CREAM ? "light" : "dark",
  });
  await context.addInitScript((bg) => {
    localStorage.setItem("thumbmux-demo-prefs", JSON.stringify({ theme: { bg } }));
  }, themeBg);
  return context;
}

async function goto(page: Page, extras: Record<string, string> = {}): Promise<void> {
  await page.goto(withParams(extras), { waitUntil: "domcontentloaded" });
}

async function waitHubReady(page: Page): Promise<string[]> {
  await expect(page.getByTestId("hub-view")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    return page.getByTestId("grid-card").count();
  }, { timeout: 30_000 }).toBe(ALLOWED.length);

  const names = await page.getByTestId("grid-card").evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-session") ?? ""),
  );

  const unexpected = names.filter((name) => !ALLOWED.includes(name as (typeof ALLOWED)[number]));
  if (unexpected.length > 0) {
    throw new Error(
      `HOST TMUX LEAK or extra session on hub: ${unexpected.join(", ")} (all: ${names.join(", ")})`,
    );
  }
  const missing = ALLOWED.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`hub is missing staged sessions: ${missing.join(", ")}`);
  }
  if (names.length !== ALLOWED.length) {
    throw new Error(`hub has ${names.length} cards, expected ${ALLOWED.length}: ${names.join(", ")}`);
  }

  const count = (await page.getByTestId("hub-count").textContent())?.trim();
  if (count !== String(ALLOWED.length)) {
    throw new Error(`hub-count is "${count}", expected "${ALLOWED.length}"`);
  }

  for (const name of ALLOWED) {
    await expect(
      page.locator(`[data-testid="grid-card"][data-session="${name}"] [data-testid="session-thumb"]`),
    ).toHaveAttribute("data-live", "true", { timeout: 30_000 });
  }

  await expect(page.getByTestId("grid-subtitle")).toHaveCount(ALLOWED.length);
  return names;
}

async function waitSession(page: Page, session: string): Promise<void> {
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("mtv")).toBeVisible();
  await expect.poll(async () => {
    return Number(await page.getByTestId("mtv").getAttribute("data-total")) || 0;
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByTestId("hud-expand").filter({ hasText: session }).waitFor({ timeout: 10_000 }).catch(() => {
    // title is on the hud; a missing match is not fatal if mtv already painted
  });
}

async function shot(page: Page, name: string): Promise<string> {
  const dest = join(OUT_DIR!, name);
  mkdirSync(dirname(dest), { recursive: true });
  await page.screenshot({ path: dest, type: "png", animations: "disabled" });
  return dest;
}

async function openComposer(page: Page, text: string): Promise<void> {
  await page.getByTestId("mtv").click();
  const sheet = page.getByTestId("input-sheet");
  await expect(sheet).toHaveClass(/open/, { timeout: 10_000 });
  const box = sheet.locator("textarea");
  await expect(box).toBeVisible();
  await box.fill(text);
}

async function openThemeSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByTestId("demo-theme").click();
  await expect(page.getByRole("button", { name: "☾ Dark" })).toBeVisible({ timeout: 10_000 });
}

async function capturePhoneHub(browser: Browser): Promise<void> {
  const context = await newContext(browser, "phone");
  const page = await context.newPage();
  try {
    await goto(page);
    await waitHubReady(page);
    await shot(page, "hub.png");

    await page.getByTestId("grid-new").click();
    const sheet = page.getByTestId("launch-sheet");
    await expect(sheet).toBeVisible();
    await page.getByTestId("launch-preset").filter({ hasText: "Claude Code" }).first().click();
    await expect(page.getByTestId("launch-permission")).toBeVisible();
    await expect(page.getByTestId("launch-model")).toBeVisible();
    // Keep presets and both dropdowns in frame.
    await page.getByTestId("launch-config").scrollIntoViewIfNeeded();
    await sheet.evaluate((el) => {
      el.scrollTop = 0;
    });
    await shot(page, "launcher.png");
  } finally {
    await context.close();
  }
}

async function capturePhoneSession(
  browser: Browser,
  file: string,
  extras: Record<string, string>,
  themeBg: string,
  after?: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await newContext(browser, "phone", themeBg);
  const page = await context.newPage();
  try {
    await goto(page, extras);
    await waitSession(page, extras.session ?? "agent");
    if (after) await after(page);
    await shot(page, file);
  } finally {
    await context.close();
  }
}

async function captureDesktop(browser: Browser): Promise<void> {
  const context = await newContext(browser, "desktop");
  const page = await context.newPage();
  try {
    await goto(page, { session: "agent" });
    await waitSession(page, "agent");
    await shot(page, "desktop-agent.png");

    await goto(page, { session: "htop" });
    await waitSession(page, "htop");
    await expect.poll(async () => {
      const body = await page.locator("body").innerText();
      return /PID|htop|CPU|MEM|Tasks/i.test(body);
    }, { timeout: 20_000 }).toBe(true);
    await shot(page, "desktop-htop.png");
  } finally {
    await context.close();
  }
}

async function captureHeroPanels(browser: Browser): Promise<string[]> {
  const panels: Array<{ file: string; bg: string }> = [
    { file: "_hero-dark.png", bg: DARK },
    { file: "_hero-blue.png", bg: BLUE },
    { file: "_hero-cream.png", bg: CREAM },
  ];
  const paths: string[] = [];
  for (const panel of panels) {
    const context = await newContext(browser, "phone", panel.bg);
    const page = await context.newPage();
    try {
      await goto(page, { session: "agent" });
      await waitSession(page, "agent");
      paths.push(await shot(page, panel.file));
    } finally {
      await context.close();
    }
  }
  return paths;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR!, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    await capturePhoneHub(browser);
    await capturePhoneSession(browser, "term-agent.png", { session: "agent" }, DARK);
    await capturePhoneSession(browser, "term-cream.png", { session: "agent" }, CREAM);
    await capturePhoneSession(
      browser,
      "composer.png",
      { session: "agent", composerMode: "compose" },
      DARK,
      (page) => openComposer(page, "run the test suite again and summarize what changed"),
    );
    await capturePhoneSession(
      browser,
      "shortcuts.png",
      { session: "build" },
      DARK,
      async (page) => {
        await page.getByTestId("shortcut-manage").click();
        await expect(page.getByTestId("shortcuts-sheet")).toBeVisible();
        await expect(page.getByTestId("shortcut-row")).toHaveCount(3);
      },
    );
    await capturePhoneSession(
      browser,
      "theme.png",
      { session: "agent" },
      DARK,
      openThemeSheet,
    );
    await captureDesktop(browser);
    const heroPanels = await captureHeroPanels(browser);
    writeFileSync(join(ARTIFACTS, "hero-panels.json"), JSON.stringify(heroPanels));
    console.log(`thumbmux media: wrote shots to ${OUT_DIR}`);
    console.log(`thumbmux media: hero panels ${heroPanels.join(" ")}`);
  } finally {
    await browser.close();
  }
}

await main();
