import { expect, test, type Page } from '@playwright/test';
import {
  assertVirtualized,
  createLineSession,
  dataTotal,
  killSession,
  lineNumbers,
  makeSessionName,
  openSession,
  visibleTerminalLines,
  wheel,
} from './helpers';

type HistoryPrependEvent = {
  lineCount: number;
  cacheValid: boolean;
  transformStable: boolean;
  before: { transform: string; anchorText: string; rowCount: number };
  after: { transform: string; anchorText: string; rowCount: number };
};

async function observeHistoryPrepends(page: Page) {
  await page.getByTestId('mtv').evaluate((mtv) => {
    const proof = { events: [] as HistoryPrependEvent[] };
    (window as Window & { __archiveProof?: typeof proof }).__archiveProof = proof;
    mtv.addEventListener('thumbmux-history-prepend', (event) => {
      proof.events.push((event as CustomEvent<HistoryPrependEvent>).detail);
    });
  });
}

async function prependOneArchivePage(page: Page, previousEvents: number) {
  await page.getByTestId('mtv').evaluate((mtv) => {
    const rect = mtv.getBoundingClientRect();
    for (let i = 0; i < 2; i++) {
      mtv.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -100000,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
    }
  });
  await expect.poll(() => page.evaluate(
    () => (window as Window & { __archiveProof?: { events: unknown[] } }).__archiveProof?.events.length ?? 0,
  ), { timeout: 30_000 }).toBeGreaterThan(previousEvents);
}

async function historyEvents(page: Page): Promise<HistoryPrependEvent[]> {
  return page.evaluate(
    () => (window as Window & { __archiveProof?: { events: HistoryPrependEvent[] } }).__archiveProof?.events ?? [],
  );
}

test('repeated top expansion reaches the earliest archive range without moving the reader anchor', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const session = makeSessionName(testInfo, 'hist');
  const TOTAL = 6200;
  try {
    createLineSession(session, 'HX', TOTAL);
    await openSession(page, session);
    await assertVirtualized(page);
    await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1900);
    await observeHistoryPrepends(page);

    const totals: number[] = [await dataTotal(page)];
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const previousEvents = (await historyEvents(page)).length;
      await prependOneArchivePage(page, previousEvents);
      await expect.poll(() => dataTotal(page), { timeout: 30_000 })
        .toBeGreaterThan(totals[totals.length - 1]!);
      totals.push(await dataTotal(page));
      await assertVirtualized(page);
    }

    const prepends = await historyEvents(page);
    expect(prepends).toHaveLength(3);
    for (const prepend of prepends) {
      expect(prepend.lineCount).toBeGreaterThan(0);
      expect(prepend.cacheValid).toBe(true);
      expect(prepend.transformStable).toBe(true);
      expect(prepend.before.transform).toBe(prepend.after.transform);
      expect(prepend.before.anchorText).toMatch(/^HX line \d{4} payload$/);
      expect(prepend.after.anchorText).toBe(prepend.before.anchorText);
      expect(prepend.after.rowCount).toBeLessThan(200);
    }

    // The third page reaches the earliest seeded line. Scroll through the
    // prepend seam and assert that the rendered sequence remains gap-free.
    await wheel(page, -1200, 12);
    await page.waitForTimeout(200);
    const nums = lineNumbers(await visibleTerminalLines(page));
    expect(nums.length).toBeGreaterThan(10);
    expect(nums[0]).toBe(1);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
    expect(totals[totals.length - 1]).toBeGreaterThanOrEqual(TOTAL);
  } finally {
    killSession(session);
  }
});
