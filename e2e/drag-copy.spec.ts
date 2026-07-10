import { expect, test } from '@playwright/test';
import {
  appendLines,
  assertVirtualized,
  createLineSession,
  dataTotal,
  killSession,
  makeSessionName,
  normalizeText,
  openSession,
  readClipboard,
  scrollToBottomByWheel,
  selectVisibleLines,
  wheel,
} from './helpers';

test('drag selection survives append and copies clean text from keyboard and demo action', async ({ context, page }, testInfo) => {
  const session = makeSessionName(testInfo, 'copy');
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript((sessionName) => {
      const NativeWebSocket = window.WebSocket;
      const frames: string[] = [];
      (window as unknown as { __thumbmuxSelectionFrames: string[] }).__thumbmuxSelectionFrames = frames;
      window.WebSocket = class SelectionRecordingWebSocket extends NativeWebSocket {
        constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
          super(...args);
          this.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            try {
              const frame = JSON.parse(event.data);
              if (frame?.channel === sessionName && (frame.type === 'output' || frame.type === 'delta')) {
                frames.push(event.data);
              }
            } catch {
              // Ignore non-protocol traffic.
            }
          });
        }
      };
    }, session);
    createLineSession(session, 'CP', 180);
    await openSession(page, session);
    await assertVirtualized(page);

    await wheel(page, -360, 8);
    await page.waitForTimeout(150);
    const { selected, visibleTexts } = await selectVisibleLines(page, 10);
    expect(selected.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(10);
    expect(selected).toContain(visibleTexts[0].trim());
    expect(selected).toContain(visibleTexts[visibleTexts.length - 1].trim());
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe(selected);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await expect.poll(() => readClipboard(page)).toBe(selected);

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByTestId('demo-copy').click();
    await expect.poll(() => readClipboard(page)).toBe(selected);

    const totalBeforeAppend = await dataTotal(page);
    const appended = `CP live append after selection ${Date.now().toString(36)}`;
    appendLines(session, [appended]);
    await expect.poll(() => page.evaluate((marker) => (
      (window as unknown as { __thumbmuxSelectionFrames?: string[] }).__thumbmuxSelectionFrames ?? []
    ).some((frame) => frame.includes(marker)), appended), { timeout: 20_000 }).toBe(true);
    // Let the application's message handler and Svelte flush run after the
    // recorder proves the output frame reached this browser.
    await page.waitForTimeout(100);
    const afterAppendSelection = normalizeText(await page.evaluate(() => window.getSelection()?.toString() || ''));
    expect(afterAppendSelection).toBe(selected);
    expect(await dataTotal(page)).toBe(totalBeforeAppend);

    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await expect.poll(() => dataTotal(page)).toBeGreaterThan(totalBeforeAppend);
    await scrollToBottomByWheel(page);
    await expect(page.getByTestId('mtv')).toContainText(appended);
  } finally {
    killSession(session);
  }
});
