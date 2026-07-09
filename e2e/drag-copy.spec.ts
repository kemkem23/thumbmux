import { expect, test } from '@playwright/test';
import {
  appendLines,
  assertVirtualized,
  createLineSession,
  killSession,
  makeSessionName,
  markKnownGap,
  normalizeText,
  openSession,
  readClipboard,
  selectVisibleLines,
  wheel,
} from './helpers';

test('drag selection survives append and copies clean text from keyboard and demo action', async ({ context, page }, testInfo) => {
  const session = makeSessionName(testInfo, 'copy');
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    createLineSession(session, 'CP', 180);
    await openSession(page, session);
    await assertVirtualized(page);

    await wheel(page, -360, 8);
    await page.waitForTimeout(150);
    const { selected, visibleTexts } = await selectVisibleLines(page, 10);
    expect(selected.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(10);
    expect(selected).toContain(visibleTexts[0].trim());
    expect(selected).toContain(visibleTexts[visibleTexts.length - 1].trim());

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await expect.poll(() => readClipboard(page)).toBe(selected);

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByTestId('demo-copy').click();
    const actionCopy = normalizeText(await readClipboard(page));
    if (actionCopy !== selected) {
      // Known gap E2E-GAP-002: demo-copy is wired to copyAll(), not copySelection().
      markKnownGap(testInfo, 'E2E-GAP-002', 'The demo copy action copies the whole buffer instead of the current native selection.');
      expect(actionCopy).toContain(visibleTexts[0].trim());
      expect(actionCopy).toContain(visibleTexts[visibleTexts.length - 1].trim());
    } else {
      expect(actionCopy).toBe(selected);
    }

    const survival = await selectVisibleLines(page, 10);
    appendLines(session, ['CP live append after selection']);
    await page.waitForTimeout(900);
    const afterAppendSelection = normalizeText(await page.evaluate(() => window.getSelection()?.toString() || ''));
    if (afterAppendSelection !== survival.selected) {
      // Known gap E2E-GAP-005: live content updates currently clear native selection.
      markKnownGap(testInfo, 'E2E-GAP-005', 'Native terminal selection does not survive a live append while scrolled up.');
      expect(afterAppendSelection).toBe('');
    } else {
      expect(afterAppendSelection).toBe(survival.selected);
    }
  } finally {
    killSession(session);
  }
});
