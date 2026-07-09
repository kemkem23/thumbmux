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
  markKnownGap,
  openSession,
  scrollToBottomByWheel,
  visibleTerminalLines,
  wheel,
} from './helpers';

test('renders and scrolls a 5,000-line tmux buffer with bounded DOM rows', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'big');
  try {
    createLineSession(session, 'BD', 5000);
    expect(capturePane(session, -5000).split('\n').filter((line) => line.includes('BD line')).length).toBeGreaterThanOrEqual(5000);

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

    // Known gap E2E-GAP-001: the package demo currently has no visible scroll-to-bottom control.
    markKnownGap(testInfo, 'E2E-GAP-001', 'No visible scroll-to-bottom control is exposed by the demo; wheel fallback verifies the tail state.');
    await scrollToBottomByWheel(page);
    expect(await bottomOffset(page)).toBe(0);
  } finally {
    killSession(session);
  }
});
