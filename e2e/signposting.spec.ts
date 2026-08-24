/**
 * Real-browser verification of TermView signposts (v0.15.3 BRIEF-B).
 *
 * D4 — client history ceiling (10k / 8 MiB) must not look like session start.
 * D5 — alternate-screen sessions must explain why scroll does nothing.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createLineSession,
  createShellSession,
  killSession,
  makeSessionName,
  openSession,
  runShellCommand,
} from './helpers';

async function flingUp(page: Page, times: number): Promise<void> {
  const mtv = page.getByTestId('mtv');
  const box = await mtv.boundingBox();
  if (!box) throw new Error('mtv not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (let i = 0; i < times; i += 1) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -2400);
    await page.waitForTimeout(40);
  }
}

test('D5: alternate screen shows no-scrollback signpost', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'altsp');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    // Enter alternate screen (smcup) so tmux reports alternate_on=1.
    runShellCommand(session, "printf '\\033[?1049h\\033[2J\\033[Halternate-screen-probe\\n'");
    await openSession(page, session);

    await expect.poll(async () => {
      return page.getByTestId('mtv').getAttribute('data-no-scrollback');
    }, { timeout: 20_000 }).toBe('1');

    const note = page.getByTestId('mtv-no-scrollback');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('role', 'note');
    await expect(note).toContainText(/no scrollback/i);

    const totalBefore = Number(await page.getByTestId('mtv').getAttribute('data-total'));
    await flingUp(page, 20);
    const totalAfter = Number(await page.getByTestId('mtv').getAttribute('data-total'));
    // Still one pane height of content — history must not grow from flings.
    expect(totalAfter).toBeLessThanOrEqual(Math.max(totalBefore + 2, 80));
    await expect(note).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath('d5-alt-no-scrollback.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});

test('D4: deep history ceiling shows older-history-not-loaded note', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const session = makeSessionName(testInfo, 'ceil');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    // ~12k numbered lines is enough to fill the 10k client budget after live
    // window retention; archive seed keeps the rest on disk.
    createLineSession(session, 'CEIL', 12_000);
    await openSession(page, session, { historyPaging: 'ceiling' });
    await expect(page.getByTestId('mtv')).toHaveAttribute('data-history-paging', 'ceiling');

    // Page toward older history until the client budget stop is declared.
    // Do not treat total>=10000 alone as success — a live capture can sit at
    // the cap with history-stop still "none" until a refused expand or a
    // retention eviction marks the ceiling.
    for (let i = 0; i < 120; i += 1) {
      await flingUp(page, 3);
      const stop = await page.getByTestId('mtv').getAttribute('data-history-stop');
      if (stop === 'ceiling') break;
      await page.waitForTimeout(80);
    }

    await expect.poll(async () => {
      return page.getByTestId('mtv').getAttribute('data-history-stop');
    }, { timeout: 90_000 }).toBe('ceiling');

    await expect.poll(async () => {
      return Number(await page.getByTestId('mtv').getAttribute('data-total'));
    }, { timeout: 10_000 }).toBeLessThanOrEqual(10_000);

    // Fling more — must not stampede (still ceiling, total stays capped).
    const totalAtCeiling = Number(await page.getByTestId('mtv').getAttribute('data-total'));
    await flingUp(page, 25);
    await page.waitForTimeout(300);
    expect(await page.getByTestId('mtv').getAttribute('data-history-stop')).toBe('ceiling');
    expect(Number(await page.getByTestId('mtv').getAttribute('data-total'))).toBe(totalAtCeiling);

    const note = page.getByTestId('mtv-history-ceiling');
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toHaveAttribute('role', 'note');
    await expect(note).toContainText(/Older history not loaded/i);

    await page.screenshot({
      path: testInfo.outputPath('d4-history-ceiling.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});
