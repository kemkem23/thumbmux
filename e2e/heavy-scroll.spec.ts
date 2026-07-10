import { expect, test } from '@playwright/test';
import {
  assertVirtualized,
  bottomOffset,
  capturePane,
  createShellSession,
  dataTotal,
  dockerExec,
  killSession,
  lineNumbers,
  makeSessionName,
  openSession,
  runShellCommand,
  shellQuote,
  visibleTerminalLines,
  wheel,
} from './helpers';

function streamPath(session: string) {
  return `.${session}.stream`;
}

async function createStreamingLineSession(session: string, prefix: string, count: number) {
  const path = streamPath(session);
  createShellSession(session);
  runShellCommand(session,
    `rm -f ${shellQuote(path)}; mkfifo ${shellQuote(path)}; exec 3<>${shellQuote(path)}; seq -f ${shellQuote(`${prefix} line %04g payload`)} 1 ${count}; while IFS= read -r line <&3; do printf '%s\\n' "$line"; done`,
  );
  const newest = `${prefix} line ${String(count).padStart(4, '0')} payload`;
  await expect.poll(() => capturePane(session, -40).includes(newest), { timeout: 20_000 }).toBe(true);
}

function appendStreamingLines(session: string, lines: string[]) {
  const path = streamPath(session);
  const values = ['', '', ...lines].map(shellQuote).join(' ');
  dockerExec(`printf '%s\\n' ${values} > ${shellQuote(path)}`, 20_000);
}

test('survives a scroll storm and preserves the reader anchor during live append', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'storm');
  try {
    await createStreamingLineSession(session, 'HS', 900);
    await openSession(page, session);
    await assertVirtualized(page);
    await expect.poll(() => dataTotal(page)).toBeGreaterThanOrEqual(900);

    const started = Date.now();
    await page.getByTestId('mtv').evaluate((mtv) => {
      const rect = mtv.getBoundingClientRect();
      for (let i = 0; i < 300; i++) {
        mtv.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: i % 2 === 0 ? -180 : 180,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      }
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(page.getByTestId('mtv')).toBeVisible();
    await assertVirtualized(page);

    await wheel(page, -420, 12);
    const scrollBottom = page.getByTestId('demo-scroll-bottom');
    await expect(scrollBottom).toBeVisible();
    await scrollBottom.click();
    await expect.poll(() => bottomOffset(page)).toBe(0);
    await expect(scrollBottom).toHaveCount(0);

    await wheel(page, -420, 12);
    await expect(scrollBottom).toBeVisible();
    await page.waitForTimeout(1_300);
    const beforeLines = await visibleTerminalLines(page);
    const beforeAnchor = beforeLines.find((line) => /HS line \d+/.test(line));
    expect(beforeAnchor).toBeTruthy();
    const beforeFirstNumber = lineNumbers(beforeLines)[0];
    const beforeTotal = await dataTotal(page);

    appendStreamingLines(session, Array.from({ length: 50 }, (_, i) => `HS live append ${String(i + 1).padStart(2, '0')}`));
    const newContent = page.getByTestId('demo-new-content');
    await expect(newContent).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => dataTotal(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(beforeTotal + 50);
    const afterLines = await visibleTerminalLines(page);
    expect(afterLines).toContain(beforeAnchor);
    expect(lineNumbers(afterLines)[0]).toBe(beforeFirstNumber);
    await assertVirtualized(page);

    await newContent.click();
    await expect.poll(() => bottomOffset(page)).toBe(0);
    await expect.poll(async () => (await visibleTerminalLines(page)).includes('HS live append 50')).toBe(true);
    await expect(newContent).toHaveCount(0);
    await assertVirtualized(page);
  } finally {
    killSession(session);
    dockerExec(`rm -f ${shellQuote(streamPath(session))}`, 10_000);
  }
});
