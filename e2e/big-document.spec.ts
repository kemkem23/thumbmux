import { expect, test } from '@playwright/test';
import {
  assertVirtualized,
  bottomOffset,
  capturePane,
  createLineSession,
  dataTotal,
  killSession,
  lineHeight,
  lineNumbers,
  makeSessionName,
  openSession,
  visibleTerminalLines,
  wheel,
} from './helpers';

test('renders and scrolls a 5,000-line tmux buffer with bounded DOM rows', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'big');
  try {
    createLineSession(session, 'BD', 5000);
    const newestLine = 'BD line 5000 payload';
    expect(capturePane(session, -5000).split('\n').filter((line) => /^BD line \d{4} payload$/.test(line)).length).toBe(5000);

    await openSession(page, session);
    await assertVirtualized(page);
    await expect.poll(() => dataTotal(page)).toBeGreaterThan(200);

    const initialNumbers = lineNumbers(await visibleTerminalLines(page));
    expect(initialNumbers.length).toBeGreaterThan(10);
    const initialFirst = initialNumbers[0];
    const lh = await lineHeight(page);

    const depths: number[] = [];
    for (let i = 0; i < 3; i++) {
      await wheel(page, -180, 3);
      await page.waitForTimeout(120);
      const offset = await bottomOffset(page);
      depths.push(offset);
      expect(offset).toBeGreaterThan(i === 0 ? 0 : depths[i - 1]);
      const currentFirst = lineNumbers(await visibleTerminalLines(page))[0];
      const expectedFirst = initialFirst - Math.round(offset / lh);
      expect(Math.abs(currentFirst - expectedFirst)).toBeLessThanOrEqual(4);
      await assertVirtualized(page);
    }

    const scrollBottom = page.getByTestId('demo-scroll-bottom');
    await expect(scrollBottom).toBeVisible();
    await scrollBottom.click();
    await expect.poll(() => bottomOffset(page)).toBe(0);
    await expect.poll(async () => (await visibleTerminalLines(page)).includes(newestLine)).toBe(true);
    await assertVirtualized(page);
  } finally {
    killSession(session);
  }
});
