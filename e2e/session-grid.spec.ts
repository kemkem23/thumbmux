import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  appendLines,
  createShellSession,
  killSession,
} from './helpers';

type Fixture = {
  name: string;
  kind: 'cc' | 'codex' | 'grok' | 'sh';
};

const VIEWPORTS = [
  { tag: 'iphone-se', width: 375, height: 667, columns: [2] },
  { tag: 'iphone-14', width: 390, height: 844, columns: [2] },
  { tag: 'iphone-14-pro-max', width: 430, height: 932, columns: [2] },
  { tag: 'ipad-portrait', width: 768, height: 1024, columns: [4] },
  { tag: 'ipad-landscape', width: 1024, height: 768, columns: [5] },
  { tag: 'laptop', width: 1280, height: 800, columns: [5] },
  { tag: 'desktop', width: 1920, height: 1080, columns: [6] },
] as const;

function demoUrl(delayMs = 0): string {
  if (!process.env.DEMO_URL) throw new Error('DEMO_URL is required');
  const url = new URL(process.env.DEMO_URL);
  if (delayMs > 0) url.searchParams.set('gridDelayMs', String(delayMs));
  return url.toString();
}

function fixtureNames(testInfo: TestInfo): Fixture[] {
  const stamp = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  return [
    { kind: 'cc', name: `sim-cc-shared-prefix-tail-a19z-${stamp}` },
    { kind: 'cc', name: `sim-cc-shared-prefix-tail-z83q-${stamp}` },
    { kind: 'codex', name: `sim-codex-review-${stamp}` },
    { kind: 'grok', name: `sim-grok-build-${stamp}` },
    { kind: 'sh', name: `sim-sh-ops-${stamp}` },
    { kind: 'sh', name: `sim-sh-check-${stamp}` },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rgbToParts(value: string): [number, number, number] | null {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function channel(value: number): number {
  const next = value / 255;
  return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
}

function contrast(fg: string, bg: string): number {
  const f = rgbToParts(fg);
  const b = rgbToParts(bg);
  if (!f || !b) return 1;
  const fl = 0.2126 * channel(f[0]) + 0.7152 * channel(f[1]) + 0.0722 * channel(f[2]);
  const bl = 0.2126 * channel(b[0]) + 0.7152 * channel(b[1]) + 0.0722 * channel(b[2]);
  return (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
}

async function waitForFixtures(page: Page, fixtures: Fixture[]) {
  await expect.poll(async () => {
    const sessions = await page.getByTestId('grid-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-session')));
    return fixtures.every((fixture) => sessions.includes(fixture.name));
  }, { timeout: 20_000 }).toBe(true);
  for (const fixture of fixtures) {
    await expect(page.locator(`[data-testid="grid-card"][data-session="${fixture.name}"] [data-testid="session-thumb"]`))
      .toHaveAttribute('data-live', 'true', { timeout: 20_000 });
  }
}

async function gridMetrics(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-testid="session-grid"]');
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="grid-card"]'));
    const first = cards[0];
    const thumb = first?.querySelector<HTMLElement>('[data-testid="session-thumb"]');
    const tail = thumb?.querySelector<HTMLElement>('.tail');
    if (!grid || !first || !thumb || !tail) throw new Error('grid metrics unavailable');
    const firstTop = first.getBoundingClientRect().top;
    const columns = cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length;
    const cardRect = first.getBoundingClientRect();
    const tailStyle = getComputedStyle(tail);
    return {
      columns,
      cardWidth: cardRect.width,
      fontPx: Number.parseFloat(tailStyle.fontSize),
      pageScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      tailScrollWidth: tail.scrollWidth,
      tailClientWidth: tail.clientWidth,
      maskImage: tailStyle.maskImage,
      webkitMaskImage: tailStyle.webkitMaskImage,
      overflowX: tailStyle.overflowX,
      stateCount: document.querySelectorAll('[data-testid="grid-state"]').length,
      activityCount: document.querySelectorAll('[data-testid="grid-activity"]').length,
    };
  });
}

async function expectedSpatialMove(page: Page, key: string): Promise<string | null> {
  return page.evaluate((direction) => {
    const active = document.activeElement as HTMLElement | null;
    const current = active?.matches('button[data-focus-key]')
      ? active
      : document.querySelector<HTMLElement>('button[data-focus-key]');
    if (!current) return null;
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button[data-focus-key]'));
    const currentRect = current.getBoundingClientRect();
    const score = (candidate: DOMRect) => {
      const currentX = currentRect.left + currentRect.width / 2;
      const currentY = currentRect.top + currentRect.height / 2;
      const candidateX = candidate.left + candidate.width / 2;
      const candidateY = candidate.top + candidate.height / 2;
      const dx = candidateX - currentX;
      const dy = candidateY - currentY;
      if (direction === 'ArrowRight') return dx > 1 ? dx * 2 + Math.abs(dy) : null;
      if (direction === 'ArrowLeft') return dx < -1 ? Math.abs(dx) * 2 + Math.abs(dy) : null;
      if (direction === 'ArrowDown') return dy > 1 ? dy * 2 + Math.abs(dx) * 3 : null;
      if (direction === 'ArrowUp') return dy < -1 ? Math.abs(dy) * 2 + Math.abs(dx) * 3 : null;
      return null;
    };
    let best: { key: string | null; score: number } | null = null;
    for (const button of buttons) {
      if (button === current) continue;
      const nextScore = score(button.getBoundingClientRect());
      if (nextScore === null) continue;
      if (!best || nextScore < best.score) {
        best = {
          key: button.getAttribute('data-session') ?? button.getAttribute('data-testid'),
          score: nextScore,
        };
      }
    }
    return best?.key ?? null;
  }, key);
}

async function activeGridKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.getAttribute('data-session') ?? active?.getAttribute('data-testid') ?? null;
  });
}

test('SessionGrid layout, metadata, controls, fade, contrast, names, skeletons, and focus', async ({ page }, testInfo) => {
  const fixtures = fixtureNames(testInfo);
  try {
    for (const fixture of fixtures) {
      createShellSession(fixture.name);
      appendLines(fixture.name, [
        `${fixture.kind.toUpperCase()} ready`,
        `long terminal line ${fixture.name} ${'right-edge-fade '.repeat(24)}tail-marker`,
      ]);
    }

    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(demoUrl(1200), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('session-grid')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('grid-skeleton').first()).toBeVisible();
    const shimmer = await page.getByTestId('grid-skeleton').first().evaluate((el) => getComputedStyle(el, '::after').animationName);
    expect(shimmer.includes('grid-shimmer') || shimmer === 'none').toBe(true);
    const skeletonPath = testInfo.outputPath('session-grid-skeleton.png');
    await page.screenshot({ path: skeletonPath, fullPage: true });
    console.log(`session-grid screenshot skeleton=${skeletonPath}`);

    await waitForFixtures(page, fixtures);
    await expect(page.getByTestId('grid-skeleton')).toHaveCount(0);

    const metrics = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(demoUrl(), { waitUntil: 'domcontentloaded' });
      await waitForFixtures(page, fixtures);
      const metric = await gridMetrics(page);
      expect(viewport.columns).toContain(metric.columns);
      expect(metric.pageScrollWidth).toBeLessThanOrEqual(metric.innerWidth + 2);
      expect(metric.stateCount).toBeGreaterThanOrEqual(fixtures.length);
      expect(metric.activityCount).toBeGreaterThanOrEqual(fixtures.length);
      expect(metric.tailScrollWidth).toBeGreaterThan(metric.tailClientWidth);
      expect(metric.maskImage !== 'none' || metric.webkitMaskImage !== 'none').toBe(true);
      expect(metric.overflowX).toBe('hidden');
      const screenshotPath = testInfo.outputPath(`session-grid-${viewport.tag}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      metrics.push({ tag: viewport.tag, screenshotPath, ...metric });
    }

    const phone = metrics.find((metric) => metric.tag === 'iphone-se');
    const laptop = metrics.find((metric) => metric.tag === 'laptop');
    const desktop = metrics.find((metric) => metric.tag === 'desktop');
    expect(phone).toBeTruthy();
    expect(laptop).toBeTruthy();
    expect(desktop).toBeTruthy();
    expect(laptop!.cardWidth).toBeGreaterThan(171);
    expect(desktop!.cardWidth).toBeGreaterThanOrEqual(260);
    expect(desktop!.fontPx - phone!.fontPx).toBeGreaterThanOrEqual(2);
    console.log(`session-grid metrics=${JSON.stringify(metrics)}`);

    const labels = await page.getByTestId('grid-filter').allTextContents();
    expect(labels).toEqual(['ALL', 'CC', 'CDX', 'GROK', 'SH']);
    await page.getByTestId('grid-filter').filter({ hasText: 'CDX' }).click();
    const codexValues = await page.getByTestId('grid-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-filter-value')));
    expect(codexValues.length).toBeGreaterThan(0);
    expect(codexValues.every((value) => value === 'codex')).toBe(true);
    await page.getByTestId('grid-filter').filter({ hasText: 'ALL' }).click();

    const uniqueTail = fixtures[1].name.slice(-12);
    await page.getByTestId('grid-search').fill(uniqueTail);
    await expect(page.getByTestId('grid-card')).toHaveCount(1);
    await expect(page.getByTestId('grid-card').first()).toHaveAttribute('data-session', fixtures[1].name);
    await page.getByTestId('grid-search').fill('');
    await expect.poll(() => page.getByTestId('grid-card').count()).toBeGreaterThanOrEqual(fixtures.length);

    await page.getByTestId('grid-group-toggle').click();
    await expect(page.getByTestId('grid-group').first()).toBeVisible();
    const groupedOrderOk = await page.getByTestId('grid-group').evaluateAll((groups) => groups.length > 0);
    expect(groupedOrderOk).toBe(true);

    for (const fixture of fixtures.slice(0, 2)) {
      const card = page.locator(`[data-testid="grid-card"][data-session="${fixture.name}"]`);
      await expect(card).toHaveAttribute('title', fixture.name);
      await expect(card).toHaveAccessibleName(new RegExp(escapeRegExp(fixture.name)));
      const visibleName = await card.locator('.name').innerText();
      expect(visibleName).toContain(fixture.name.slice(-12));
    }

    const contrastRatios = await page.getByTestId('session-thumb').evaluateAll((thumbs) => thumbs.map((thumb) => {
      const style = getComputedStyle(thumb);
      return { color: style.color, backgroundColor: style.backgroundColor };
    }));
    for (const ratio of contrastRatios.map(({ color, backgroundColor }) => contrast(color, backgroundColor))) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    await page.getByTestId('grid-group-toggle').click();
    const firstCard = page.getByTestId('grid-card').first();
    await firstCard.focus();
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      const expected = await expectedSpatialMove(page, key);
      if (!expected) continue;
      await page.keyboard.press(key);
      expect(await activeGridKey(page)).toBe(expected);
    }
    await page.getByTestId('grid-search').focus();
    await page.keyboard.press('ArrowRight');
    expect(await activeGridKey(page)).toBe('grid-search');

    await firstCard.focus();
    const target = await firstCard.getAttribute('data-session');
    await page.keyboard.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(target);
  } finally {
    for (const fixture of fixtures) killSession(fixture.name);
  }
});
