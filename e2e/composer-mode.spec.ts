/**
 * Real-browser verification of SessionPresentationOptions.composerMode.
 * Unit/happy-dom mounts are not evidence under the 2026-08-12 kem rule —
 * this drives the package demo UI and asserts visible DOM state.
 */
import { expect, test } from '@playwright/test';
import {
  capturePane,
  createShellSession,
  killSession,
  makeSessionName,
  openSession,
} from './helpers';

test('?composerMode=direct opens the composer in DIRECT with no textarea', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'cmode-d');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session, { composerMode: 'direct' });

    await page.getByTestId('mtv').click();
    const sheet = page.getByTestId('input-sheet');
    await expect(sheet).toHaveClass(/open/);
    // DIRECT gates the whole .crow/textarea — stock COMPOSE always has one.
    await expect(sheet.locator('textarea')).toHaveCount(0);
    const direct = sheet.getByRole('button', { name: 'DIRECT' });
    await expect(direct).toHaveClass(/on/);
    await expect(sheet.getByRole('button', { name: 'COMPOSE' })).not.toHaveClass(/on/);

    await page.screenshot({
      path: testInfo.outputPath('composer-mode-direct.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});

test('omitted composerMode keeps stock COMPOSE (textarea + COMPOSE chip on)', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'cmode-c');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session);

    await page.getByTestId('mtv').click();
    const sheet = page.getByTestId('input-sheet');
    await expect(sheet).toHaveClass(/open/);
    await expect(sheet.locator('textarea')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'COMPOSE' })).toHaveClass(/on/);
    await expect(sheet.getByRole('button', { name: 'DIRECT' })).not.toHaveClass(/on/);

    await page.screenshot({
      path: testInfo.outputPath('composer-mode-default-compose.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});

test('COMPOSE SEND stays open and focused for the next message', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'compose-focus');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session);

    await page.getByTestId('mtv').click();
    const sheet = page.getByTestId('input-sheet');
    const textarea = sheet.locator('textarea');
    const send = sheet.getByRole('button', { name: 'SEND' });
    const firstMarker = `compose-focus-first-${Date.now().toString(36)}`;
    const secondMarker = `compose-focus-second-${Date.now().toString(36)}`;

    await textarea.fill(`printf '%s\\n' '${firstMarker}'`);
    await send.click();

    await expect(sheet).toHaveClass(/open/);
    await expect(textarea).toHaveValue('');
    await expect(textarea).toBeFocused();
    await page.waitForTimeout(500);
    await expect(textarea).toBeFocused();
    await expect.poll(() => capturePane(session, -80)).toContain(firstMarker);

    // Type the second command through the still-active textarea without a
    // click. Enter must preserve the same ready-for-next-message contract.
    await page.keyboard.type(`printf '%s\\n' '${secondMarker}'`);
    await expect(textarea).toHaveValue(`printf '%s\\n' '${secondMarker}'`);
    await page.keyboard.press('Enter');

    await expect(sheet).toHaveClass(/open/);
    await expect(textarea).toHaveValue('');
    await expect(textarea).toBeFocused();
    await expect.poll(() => capturePane(session, -80)).toContain(secondMarker);

    await page.screenshot({
      path: testInfo.outputPath('composer-send-stays-focused.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
    killSession(session);
  }
});
