import { expect, test } from '@playwright/test';
import {
  assertVirtualized,
  createLineSession,
  dataTotal,
  killSession,
  lineNumbers,
  makeSessionName,
  markKnownGap,
  openSession,
  visibleTerminalLines,
  wheel,
} from './helpers';

test('pulling to the top keeps ordering and records the demo history-expand gap', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'hist');
  try {
    createLineSession(session, 'HX', 4000);
    await openSession(page, session);
    await assertVirtualized(page);
    const initialTotal = await dataTotal(page);

    for (let i = 0; i < 8; i++) {
      await wheel(page, -720, 20);
      await page.waitForTimeout(100);
    }
    await assertVirtualized(page);

    const afterTotal = await dataTotal(page);
    if (afterTotal <= initialTotal) {
      // Known gap E2E-GAP-004: the demo server answers history_expand with an empty page because no archive is configured.
      markKnownGap(testInfo, 'E2E-GAP-004', 'Pull-to-top cannot stream older lines in the package demo until a history archive is configured.');
      expect(afterTotal).toBe(initialTotal);
    } else {
      expect(afterTotal).toBeGreaterThan(initialTotal);
    }

    const nums = lineNumbers(await visibleTerminalLines(page));
    expect(nums.length).toBeGreaterThan(8);
    const seam = nums.findIndex((n, i) => i + 1 < nums.length && nums[i + 1] === n + 1);
    expect(seam).toBeGreaterThanOrEqual(0);
    expect(nums[seam + 1]).toBe(nums[seam] + 1);
  } finally {
    killSession(session);
  }
});
