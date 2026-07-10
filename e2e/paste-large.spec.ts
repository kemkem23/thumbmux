import { expect, test } from '@playwright/test';
import {
  capturePane,
  createShellSession,
  dockerExec,
  killSession,
  makeSessionName,
  openSession,
  runShellCommand,
} from './helpers';

test('DesktopKeys confirms and delivers a 300-line large paste as bracketed input', async ({ context, page }, testInfo) => {
  const session = makeSessionName(testInfo, 'paste');
  const captureFile = `paste-capture-${session}.bin`;
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const frames: unknown[] = [];
      (window as unknown as { __thumbmuxKeys: unknown[] }).__thumbmuxKeys = frames;
      window.WebSocket = class extends NativeWebSocket {
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              if (parsed?.type === 'keys') frames.push(parsed);
            } catch {
              // Ignore non-protocol frames.
            }
          }
          return super.send(data);
        }
      };
    });
    createShellSession(session);
    await openSession(page, session);
    runShellCommand(session, `cat > ${captureFile}`);

    const lines = Array.from({ length: 300 }, (_, i) => `PL-${String(i + 1).padStart(3, '0')} ${'x'.repeat(64)}`);
    const payload = lines.join('\n');
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(20_000);

    let dialogCount = 0;
    page.on('dialog', async (dialog) => {
      dialogCount += 1;
      expect(dialog.message()).toContain('300 lines');
      await dialog.accept();
    });

    await page.locator('.desktop-keys').click();
    await page.evaluate((text) => navigator.clipboard.writeText(text), payload);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');

    await expect.poll(() => dialogCount).toBe(1);
    await expect.poll(() => page.evaluate(() => ((window as unknown as { __thumbmuxKeys?: unknown[] }).__thumbmuxKeys || []).length)).toBe(1);
    const frame = await page.evaluate(() => (window as unknown as { __thumbmuxKeys: { data: string }[] }).__thumbmuxKeys[0]);
    expect(frame.data.startsWith('\x1b[200~')).toBe(true);
    expect(frame.data.endsWith('\x1b[201~')).toBe(true);
    expect(frame.data).toContain(lines[0]);
    expect(frame.data).toContain(lines[299]);
    expect(frame.data.split(/\r\n|\r|\n/).filter((line) => line.includes('PL-')).length).toBe(300);
    expect(Buffer.byteLength(frame.data, 'utf8')).toBeGreaterThan(20_000);

    await page.keyboard.press('Enter');
    const readCapturedInput = () => Buffer.from(
      dockerExec(`test -f ${captureFile} && base64 -w0 -- ${captureFile} || true`).trim(),
      'base64',
    ).toString('utf8');
    await expect.poll(readCapturedInput).toContain(lines[299]);
    const delivered = readCapturedInput();
    expect(delivered.replace(/\r\n|\r/g, '\n')).toContain(frame.data.replace(/\r\n|\r/g, '\n'));
    expect(delivered.split(/\r\n|\r|\n/).filter((line) => line.includes('PL-')).length).toBe(300);
    expect(capturePane(session, -120)).not.toMatch(/command not found|not recognized as an internal or external command/i);
  } finally {
    try {
      dockerExec(`rm -f -- ${captureFile}`);
    } finally {
      killSession(session);
    }
  }
});
