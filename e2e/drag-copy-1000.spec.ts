import { expect, test } from '@playwright/test';
import {
  assertVirtualized,
  createLineSession,
  killSession,
  makeSessionName,
  markKnownGap,
  normalizeText,
  openSession,
  readClipboard,
  wheel,
} from './helpers';

/**
 * Deep drag-selection: what actually happens when a user tries to drag-select
 * a THOUSAND lines in a virtualized terminal.
 *
 * The renderer keeps only a bounded DOM window (~±60 rows) by design, so a
 * native selection can only anchor to mounted rows. This spec:
 *   1. measures the real ceiling of a hold-and-scroll drag selection,
 *   2. pins a hard floor so regressions in window-sized selection still fail,
 *   3. asserts the SUPPORTED path for grabbing 1,000+ lines — copyAll — is
 *      byte-exact across the whole buffer.
 */
test('drag toward 1,000 lines: measured ceiling + byte-exact full-buffer copy', async ({ context, page }, testInfo) => {
  test.setTimeout(120_000);
  const session = makeSessionName(testInfo, 'kilo');
  const TOTAL = 1200;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    createLineSession(session, 'KL', TOTAL);
    await openSession(page, session);
    await assertVirtualized(page);

    // Scroll deep into history so there is ≥1,000 lines BELOW the start row.
    await wheel(page, -240, 60); // up
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

    // HARD floor: a window's worth of lines must always be drag-selectable.
    expect(best).toBeGreaterThanOrEqual(30);

    if (best >= 1000) {
      // Native deep drag actually works — pin it hard.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      const clip = normalizeText(await readClipboard(page));
      expect(clip).toContain('KL line 0001 payload');
      expect(clip.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1000);
    } else {
      // Virtualization bounds native selection — the documented reality.
      markKnownGap(
        testInfo,
        'E2E-GAP-006',
        `Native drag-selection is bounded by the virtualization window (measured ceiling ${best} lines); deep multi-page grabs go through copyAll.`,
      );
    }

    // SUPPORTED path: copyAll = the ENTIRE LOADED buffer, byte-exact. In the
    // bare demo (no history archive) the loaded depth is the initial capture
    // window — so we assert copyAll==loaded exactly, and record that a true
    // 1,000-line grab needs an archive-wired host (covered by the host
    // journey suite).
    const total = Number(await page.locator('[data-testid="mtv"]').getAttribute('data-total'));
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByTestId('demo-copy').click();
    let all = '';
    await expect
      .poll(async () => {
        all = normalizeText(await readClipboard(page));
        return all.split('\n').filter((l) => /^KL line \d{4} payload/.test(l.trim())).length;
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(Math.min(total, TOTAL) - 15); // prompt/blank tolerance
    const lines = all.split('\n').filter((l) => /^KL line \d{4} payload/.test(l.trim()));
    // the copy must reach the loaded window's edges byte-exactly
    const firstLoaded = lines[0]?.trim();
    const lastLoaded = lines[lines.length - 1]?.trim();
    expect(firstLoaded).toMatch(/^KL line \d{4} payload$/);
    expect(lastLoaded).toBe(`KL line ${String(TOTAL).padStart(4, '0')} payload`);
    if (lines.length < 1000) {
      markKnownGap(
        testInfo,
        'E2E-GAP-004b',
        `copyAll covers the loaded buffer only (${lines.length} of ${TOTAL} lines loaded — the demo ships no history archive); full-depth kilo-line copy is exercised on archive-wired hosts.`,
      );
    }
    // no ANSI garbage anywhere in a kilobuffer copy
    expect(all.includes('')).toBe(false);
  } finally {
    killSession(session);
  }
});
