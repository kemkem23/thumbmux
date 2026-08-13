/**
 * Real-browser verification of SessionView font range (v0.15.3 BRIEF-A).
 *
 * Through 0.15.2 stock A+/A− and prefs load hard-clamped to 11–18 with bare
 * literals and silently dropped any stored value outside that band. This
 * suite drives the package demo UI and asserts rendered CSS px at both
 * extremes plus out-of-range load clamp.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createShellSession,
  killSession,
  makeSessionName,
  openSession,
} from './helpers';

async function renderedFontPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const mtv = document.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!mtv) return NaN;
    const line = mtv.querySelector<HTMLElement>('.mtv-line') ?? mtv;
    return Number.parseFloat(getComputedStyle(line).fontSize);
  });
}

async function paneGeometry(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const mtv = document.querySelector<HTMLElement>('[data-testid="mtv"]');
    return {
      cols: Number(mtv?.getAttribute('data-last-cols') || 0),
      rows: Number(mtv?.getAttribute('data-last-rows') || 0),
    };
  });
}

/** Demo shell stores prefs in localStorage (`thumbmux-demo-prefs`), not HTTP. */
async function putPrefs(page: Page, fontPx: number): Promise<void> {
  await page.evaluate((size) => {
    const key = 'thumbmux-demo-prefs';
    let current: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    } catch { /* start fresh */ }
    localStorage.setItem(key, JSON.stringify({ ...current, fontPx: size }));
  }, fontPx);
}

async function tapFontAction(page: Page, which: 'Bigger' | 'Smaller'): Promise<void> {
  const fab = page.locator('.fab');
  const slots = page.locator('.slots');
  if (!(await slots.evaluate((el) => el.classList.contains('open')).catch(() => false))) {
    await fab.click();
    await expect(slots).toHaveClass(/open/);
  }
  const button = page.locator('.slots .slot', { hasText: which }).first();
  await expect(button).toBeVisible();
  await button.click();
  // TermView remounts on font change — wait for the new size to land.
  await page.waitForTimeout(80);
}

test('stock A+/A− walks the graduated ladder from floor to ceiling', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'fontrange');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session);

    // Seed the floor via prefs (not A− 36 times from the 13 default).
    await putPrefs(page, 4);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mtv')).toBeVisible();
    await expect.poll(() => renderedFontPx(page), { timeout: 10_000 }).toBe(4);

    const geometryAtMin = await paneGeometry(page);
    expect(geometryAtMin.cols).toBeGreaterThan(0);
    expect(geometryAtMin.rows).toBeGreaterThan(0);

    // Walk up the graduated ladder to 40.
    // 4→20 is 16 × 1px, 20→32 is 6 × 2px, 32→40 is 2 × 4px = 24 taps.
    for (let i = 0; i < 30; i += 1) {
      const before = await renderedFontPx(page);
      if (before >= 40) break;
      await tapFontAction(page, 'Bigger');
      await expect.poll(() => renderedFontPx(page), { timeout: 5_000 }).toBeGreaterThan(before);
    }
    await expect.poll(() => renderedFontPx(page), { timeout: 5_000 }).toBe(40);

    const geometryAtMax = await paneGeometry(page);
    // Larger font → fewer cols/rows (geometry claim is on).
    expect(geometryAtMax.cols).toBeLessThan(geometryAtMin.cols);
    expect(geometryAtMax.rows).toBeLessThanOrEqual(geometryAtMin.rows);

    // One more A+ must clamp, not advance.
    await tapFontAction(page, 'Bigger');
    await expect.poll(() => renderedFontPx(page), { timeout: 5_000 }).toBe(40);

    await page.screenshot({
      path: testInfo.outputPath('font-range-max-40.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});

test('stored out-of-range font clamps instead of being ignored', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'fontclamp');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session);

    // Stock max is 40. A stored 99 must render 40, not fall back to 13.
    await putPrefs(page, 99);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mtv')).toBeVisible();
    await expect.poll(() => renderedFontPx(page), { timeout: 10_000 }).toBe(40);

    await page.screenshot({
      path: testInfo.outputPath('font-range-clamp-99-to-40.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});
