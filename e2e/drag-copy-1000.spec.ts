import { expect, test } from '@playwright/test';
import {
  assertVirtualized,
  createLineSession,
  dataTotal,
  killSession,
  makeSessionName,
  normalizeText,
  openSession,
  readClipboard,
  wheel,
} from './helpers';

/**
 * Deep drag-selection: native selection remains bounded by the virtualized
 * DOM, while copyAll provides the exact archive-backed whole-buffer path.
 */
test('native drag has a 30-line floor and copyAll returns the complete archive', async ({ context, page }, testInfo) => {
  test.setTimeout(180_000);
  const session = makeSessionName(testInfo, 'kilo');
  const TOTAL = 6200;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    createLineSession(session, 'KL', TOTAL);
    await openSession(page, session);
    await assertVirtualized(page);

    // Move above the live tail while retaining well over 1,000 lines below
    // the start row. Staying clear of the top avoids preloading archive pages
    // before the explicit expansion proof below.
    await wheel(page, -240, 8); // up
    await page.waitForTimeout(250);

    const mtv = page.locator('[data-testid="mtv"]');
    const box = await mtv.boundingBox();
    if (!box) throw new Error('terminal box not found');
    const startX = box.x + box.width * 0.45;
    const topY = box.y + 40;
    const bottomY = box.y + box.height - 24;

    // Hold-and-scroll drag: button down at the top, then repeatedly pull to
    // the bottom edge and wheel further down while the button stays held.
    await page.mouse.move(startX, topY);
    await page.mouse.down();
    await page.mouse.move(startX, topY + 30, { steps: 4 });

    const countSelectedLines = () =>
      page.evaluate(() => (window.getSelection()?.toString() ?? '').split('\n').filter((l) => l.trim().length > 0).length);

    let best = 0;
    let stagnant = 0;
    for (let round = 0; round < 40 && best < 1000 && stagnant < 4; round++) {
      await page.mouse.move(startX, bottomY, { steps: 6 });
      await page.mouse.wheel(0, 480); // scroll down while holding the drag
      await page.waitForTimeout(90);
      await page.mouse.move(startX + 1, bottomY - 2, { steps: 2 }); // nudge → recompute selection
      const now = await countSelectedLines();
      if (now > best) {
        best = now;
        stagnant = 0;
      } else {
        stagnant++;
      }
    }
    await page.mouse.up();
    const finalSelected = await countSelectedLines();
    best = Math.max(best, finalSelected);
    testInfo.annotations.push({ type: 'measurement', description: `hold-and-scroll drag selection ceiling: ${best} lines (target 1000, buffer ${TOTAL})` });

    // A mounted window's worth of text must remain natively selectable.
    expect(best).toBeGreaterThanOrEqual(30);

    // A native selection takes precedence over the demo action, so release it
    // before asking the supported archive-backed copyAll path for all lines.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.waitForTimeout(100);

    // The initial live window is capped at 2,000 lines. Repeated real wheel
    // expansion reaches the earliest archive page before invoking copyAll.
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const previousTotal = await dataTotal(page);
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
      await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThan(previousTotal);
      await assertVirtualized(page);
    }

    await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(TOTAL);
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByTestId('demo-copy').click();
    let all = '';
    await expect
      .poll(async () => {
        all = normalizeText(await readClipboard(page));
        return all.split('\n').filter((l) => /^KL line \d{4} payload/.test(l.trim())).length;
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(TOTAL);
    const lines = all.split('\n').filter((l) => /^KL line \d{4} payload/.test(l.trim()));
    const expected = Array.from(
      { length: TOTAL },
      (_, index) => `KL line ${String(index + 1).padStart(4, '0')} payload`,
    );
    expect(lines.map((line) => line.trim())).toEqual(expected);
    expect(lines[0]?.trim()).toBe('KL line 0001 payload');
    expect(lines[lines.length - 1]?.trim()).toBe(`KL line ${String(TOTAL).padStart(4, '0')} payload`);
    // Copy output must be plain text, not terminal control sequences.
    expect(all.includes('')).toBe(false);
  } finally {
    killSession(session);
  }
});
