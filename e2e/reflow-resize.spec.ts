import { expect, test, type Page } from '@playwright/test';
import {
  bottomOffset,
  capturePane,
  createShellSession,
  dataTotal,
  dockerExec,
  killSession,
  makeSessionName,
  openSession,
  runShellCommand,
  shellQuote,
  visibleTerminalLines,
  wheel,
} from './helpers';

type InboundFrame = {
  channel?: string;
  type?: string;
  data?: string;
  reset?: string;
};

declare global {
  interface Window {
    __thumbmuxReflowFrames?: InboundFrame[];
  }
}

const ARCHIVE_ROWS = 1200;
const LIVE_ROWS = 1050;
const ARCHIVE_PREFIX = 'RF archive';
const LIVE_PREFIX = 'RF live';

function paneWidth(session: string): number {
  return Number(dockerExec(
    `tmux display-message -p -t ${shellQuote(session)} ${shellQuote('#{window_width}')}`,
  ).trim());
}

async function installFrameRecorder(page: Page) {
  await page.addInitScript(() => {
    window.__thumbmuxReflowFrames = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class ReflowRecordingWebSocket extends NativeWebSocket {
      constructor(...args: any[]) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const frame = JSON.parse(event.data);
            if (frame && typeof frame === 'object') window.__thumbmuxReflowFrames?.push(frame);
          } catch {
            // Non-protocol WebSocket traffic is irrelevant to this proof.
          }
        });
      }
    };
  });
}

async function sessionFrames(page: Page, session: string): Promise<InboundFrame[]> {
  return page.evaluate((sessionName) => (window.__thumbmuxReflowFrames ?? [])
    .filter((frame) => frame.channel === sessionName), session);
}

async function resetFrameLog(page: Page) {
  await page.evaluate(() => { window.__thumbmuxReflowFrames = []; });
}

async function synchronizedColumns(page: Page, session: string, previous?: number): Promise<number> {
  await expect.poll(async () => {
    const cols = Number(await page.getByTestId('mtv').getAttribute('data-last-cols')) || 0;
    const width = paneWidth(session);
    return cols > 20 && width === cols && (previous === undefined || cols !== previous) ? cols : 0;
  }, { timeout: 20_000 }).toBeGreaterThan(20);
  return Number(await page.getByTestId('mtv').getAttribute('data-last-cols'));
}

function liveMarkers(data: string): number[] {
  return [...data.matchAll(/RF live (\d{4})/g)].map((match) => Number(match[1]));
}

function archiveLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith(ARCHIVE_PREFIX));
}

async function loadArchivePrefix(page: Page): Promise<string[]> {
  let previousTotal = await dataTotal(page);
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    await wheel(page, -1000, 50);
    for (let attempt = 0; attempt < 50; attempt++) {
      const currentTotal = await dataTotal(page);
      if (currentTotal > previousTotal) {
        previousTotal = currentTotal;
        break;
      }
      await page.waitForTimeout(100);
    }
    await wheel(page, -1000, 50);
    await page.waitForTimeout(150);
    const lines = archiveLines(await visibleTerminalLines(page));
    if (lines[0] === `${ARCHIVE_PREFIX} 0001 retained` && lines.length >= 10) return lines;
  }
  const lines = archiveLines(await visibleTerminalLines(page));
  expect(lines[0]).toBe(`${ARCHIVE_PREFIX} 0001 retained`);
  expect(lines.length).toBeGreaterThanOrEqual(10);
  return lines;
}

async function returnToBottom(page: Page) {
  for (let attempt = 0; attempt < 45; attempt++) {
    if ((await bottomOffset(page)) === 0) return;
    await wheel(page, 1500, 6);
  }
  expect(await bottomOffset(page)).toBe(0);
}

test('resize reflows only the live tmux window without a delta, a seam duplicate, or an archive rewrite', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const session = makeSessionName(testInfo, 'reflow');
  try {
    createShellSession(session);
    runShellCommand(session, `seq -f '${ARCHIVE_PREFIX} %04g retained' 1 ${ARCHIVE_ROWS}`);
    runShellCommand(session, `for n in $(seq 1 ${LIVE_ROWS}); do printf '${LIVE_PREFIX} %04d %s\\n' "$n" '${'x'.repeat(180)}'; done`);
    await expect.poll(() => capturePane(session, -80)).toContain(`${LIVE_PREFIX} ${String(LIVE_ROWS).padStart(4, '0')}`);

    await installFrameRecorder(page);
    await page.setViewportSize({ width: 1180, height: 800 });
    await openSession(page, session);
    const initialColumns = await synchronizedColumns(page, session);
    await expect.poll(() => dataTotal(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(2000);
    await expect.poll(async () => (await sessionFrames(page, session))
      .filter((frame) => frame.type === 'output' && typeof frame.data === 'string').length)
      .toBeGreaterThan(0);

    const initialFrames = await sessionFrames(page, session);
    const initialLive = initialFrames.filter((frame) => frame.type === 'output' && typeof frame.data === 'string').at(-1);
    expect(initialLive?.data).toBeTruthy();
    const initialMarkers = liveMarkers(initialLive!.data!);
    expect(initialMarkers.length).toBeGreaterThan(500);

    const archivedBefore = await loadArchivePrefix(page);
    expect(archivedBefore.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${ARCHIVE_PREFIX} ${String(index + 1).padStart(4, '0')} retained`),
    );

    await returnToBottom(page);
    expect(await bottomOffset(page)).toBe(0);
    await resetFrameLog(page);

    await page.setViewportSize({ width: 640, height: 800 });
    const resizedColumns = await synchronizedColumns(page, session, initialColumns);
    expect(resizedColumns).toBeLessThan(initialColumns);
    expect(paneWidth(session)).toBe(resizedColumns);

    await expect.poll(async () => (await sessionFrames(page, session))
      .filter((frame) => frame.type === 'output' && frame.reset === 'resize' && typeof frame.data === 'string').length,
    { timeout: 20_000 }).toBeGreaterThan(0);

    const resizedFrames = await sessionFrames(page, session);
    expect(resizedFrames.filter((frame) => frame.type === 'delta')).toEqual([]);
    const reflow = resizedFrames.filter((frame) => frame.type === 'output' && frame.reset === 'resize' && typeof frame.data === 'string').at(-1);
    expect(reflow?.data).toBeTruthy();
    expect(reflow!.data).not.toBe(initialLive!.data);

    const reflowMarkers = liveMarkers(reflow!.data!);
    expect(reflowMarkers.length).toBeGreaterThan(100);
    expect(reflowMarkers[0]).toBeGreaterThan(initialMarkers[0]!);
    expect(new Set(reflowMarkers).size).toBe(reflowMarkers.length);
    expect(await bottomOffset(page)).toBe(0);

    const archivedAfter = await loadArchivePrefix(page);
    expect(archivedAfter.slice(0, 10)).toEqual(archivedBefore.slice(0, 10));
  } finally {
    killSession(session);
  }
});
