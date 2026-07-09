import { expect, test } from '@playwright/test';
import {
  capturePane,
  createShellSession,
  killSession,
  makeSessionName,
  openSession,
} from './helpers';

test('desktop DesktopKeys sends a 200-character command byte-exactly', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'type');
  try {
    createShellSession(session);
    await openSession(page, session);
    const command = 'EchoMix_0123456789_abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ_!#$%&()*+,-./:<=>?@[]^_{|}~'.repeat(2).slice(0, 200);

    await page.locator('.desktop-keys').click();
    await page.keyboard.type(command);

    await expect.poll(() => capturePane(session, -120).replace(/[ \n]+/g, '')).toContain(command);
  } finally {
    killSession(session);
  }
});

test('mobile DIRECT ghost input sends text per keystroke', async ({ browser }, testInfo) => {
  const session = makeSessionName(testInfo, 'direct');
  const context = await browser.newContext({
    viewport: { width: 390, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    createShellSession(session);
    await openSession(page, session);
    const payload = 'directMode_AbC123!?';

    await page.getByTestId('mtv').click();
    await page.getByRole('button', { name: 'DIRECT' }).click();
    await page.getByTestId('ghost-key').evaluate((el, text) => {
      const input = el as HTMLInputElement;
      for (const ch of text) {
        input.value = ch;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
    }, payload);

    await expect.poll(() => capturePane(session, -120)).toContain(payload);
  } finally {
    await context.close();
    killSession(session);
  }
});
