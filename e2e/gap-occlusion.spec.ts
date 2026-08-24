import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { dockerExec, shellQuote } from './helpers';

const INITIAL_ROWS = 12_000;
const INITIAL_LIVE_ROWS = 2_000;
const APPEND_ROWS = 400;
const RETAINED_ROW_CAP = 10_000;
const HISTORY_LIMIT = 15_000;
const ANSI_ROW_PREFIX = '\\033[38;5;231;48;5;25m';
const ANSI_ROW_SUFFIX = '\\033[0m';
const SCREENSHOT_STABILIZER_STYLE = '.mtv-layer { will-change: auto !important; }';
const CONTROL_SCREENSHOT_STYLE = `${SCREENSHOT_STABILIZER_STYLE} `
  + '.mtv-gap-marker { visibility: hidden !important; } '
  + '.mtv-gap::before { content: none !important; }';
const SESSION_RE = /^sh-gap-[a-z0-9-]+$/;

const SCENARIOS = [
  { tag: 'dark-desktop', background: '#101014', width: 1280, height: 800, mobile: false },
  { tag: 'light-desktop', background: '#f5f0e8', width: 1280, height: 800, mobile: false },
  { tag: 'dark-mobile', background: '#101014', width: 390, height: 740, mobile: true },
  { tag: 'light-mobile', background: '#f5f0e8', width: 390, height: 740, mobile: true },
] as const;

type PixelDiff = {
  changedPixels: number;
  totalPixels: number;
  maxChannelDelta: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
};

type ScenarioResult = {
  tag: string;
  actualScreenshot: string;
  controlScreenshot: string;
  gapRows: number;
  previousLine: number;
  firstLiveLine: number;
  lineHeight: number;
  contentDiffs: {
    previous: PixelDiff;
    gap: PixelDiff;
    next: PixelDiff;
  };
  markerDiff: PixelDiff;
  occludedPixelHeight: number;
  affectedRows: number;
};

declare global {
  interface Window {
    __thumbmuxGapFrames?: string[];
  }
}

function assertOwnedSession(session: string): void {
  if (!SESSION_RE.test(session)) {
    throw new Error(`Refusing to operate on non-W3 session: ${session}`);
  }
}

function sessionName(testInfo: TestInfo, tag: string): string {
  return `sh-gap-${tag}-${testInfo.workerIndex}-${Date.now().toString(36)}`;
}

function fifoPath(session: string): string {
  assertOwnedSession(session);
  return `/tmp/${session}.fifo`;
}

function rowProgram(start: number, end: number, splitAt = 0): string {
  const prefix = splitAt > 0
    ? `prefix = n <= ${splitAt} ? "ARCHIVE BAND" : "LIVE SENTINEL"; `
    : 'prefix = "LIVE SENTINEL"; ';
  return `BEGIN { for (n = ${start}; n <= ${end}; n++) { ${prefix}`
    + `printf "${ANSI_ROW_PREFIX}%s %05d MWM-MWM-MWM${ANSI_ROW_SUFFIX}\\n", prefix, n; } }`;
}

function createGapSession(session: string): void {
  assertOwnedSession(session);
  const fifo = fifoPath(session);
  const producer = [
    `awk ${shellQuote(rowProgram(1, INITIAL_ROWS, INITIAL_ROWS - INITIAL_LIVE_ROWS))}`,
    `rm -f -- ${shellQuote(fifo)}`,
    `mkfifo -- ${shellQuote(fifo)}`,
    `exec 3<>${shellQuote(fifo)}`,
    `while IFS= read -r line <&3; do printf '%s\\n' "$line"; done`,
  ].join('; ');
  const shellCommand = `bash --noprofile --norc -c ${shellQuote(producer)}`;

  dockerExec(
    `tmux start-server \\; set-option -g history-limit ${HISTORY_LIMIT} \\; `
      + `new-session -d -s ${shellQuote(session)} -x 120 -y 40 ${shellQuote(shellCommand)}`,
    10_000,
  );
  dockerExec(`tmux set-option -t ${shellQuote(session)} history-limit ${HISTORY_LIMIT}`, 10_000);

  const marker = `LIVE SENTINEL ${String(INITIAL_ROWS).padStart(5, '0')}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const tail = dockerExec(
      `tmux capture-pane -t ${shellQuote(session)} -p -S -80`,
      20_000,
    );
    if (tail.includes(marker) && dockerExec(`test -p ${shellQuote(fifo)} && echo ready`).trim() === 'ready') {
      return;
    }
    dockerExec('sleep 0.1', 1_000);
  }
  throw new Error(`Timed out seeding ${INITIAL_ROWS} rows for ${session}`);
}

function appendLiveRows(session: string, start: number, end: number): void {
  assertOwnedSession(session);
  dockerExec(
    `awk ${shellQuote(rowProgram(start, end))} > ${shellQuote(fifoPath(session))}`,
    20_000,
  );
  const marker = `LIVE SENTINEL ${String(end).padStart(5, '0')}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const tail = dockerExec(`tmux capture-pane -t ${shellQuote(session)} -p -S -80`, 20_000);
    if (tail.includes(marker)) return;
    dockerExec('sleep 0.1', 1_000);
  }
  throw new Error(`tmux did not render appended marker ${marker}`);
}

function killGapSession(session: string): void {
  assertOwnedSession(session);
  dockerExec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`, 10_000);
  dockerExec(`rm -f -- ${shellQuote(fifoPath(session))}`, 10_000);
}

function demoUrl(session?: string): string {
  if (!process.env.DEMO_URL) throw new Error('DEMO_URL is required');
  const url = new URL(process.env.DEMO_URL);
  if (session) url.searchParams.set('session', session);
  // This visual regression exercises the explicit fixed-window gap marker.
  // The package default is bidirectional sliding, which deliberately pages
  // beyond the cap by evicting the opposite edge instead of creating this gap.
  url.searchParams.set('historyPaging', 'ceiling');
  return url.toString();
}

function archiveLineCount(session: string): number {
  assertOwnedSession(session);
  const key = createHash('sha256').update(session).digest('hex');
  const path = dockerExec(
    `find /tmp -type f -name ${shellQuote(`history-${key}.jsonl`)} -print -quit`,
  ).trim();
  if (!path) return 0;
  return Number(dockerExec(`wc -l < ${shellQuote(path)}`).trim()) || 0;
}

async function installScenarioState(context: BrowserContext, background: string, session: string): Promise<void> {
  await context.addInitScript(({ bg, sessionName }) => {
    localStorage.setItem('thumbmux-demo-prefs', JSON.stringify({ theme: { bg } }));
    window.__thumbmuxGapFrames = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class GapRecordingWebSocket extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const frame = JSON.parse(event.data);
            if (frame?.channel !== sessionName || (frame.type !== 'output' && frame.type !== 'delta')) return;
            window.__thumbmuxGapFrames?.push(event.data);
            if ((window.__thumbmuxGapFrames?.length ?? 0) > 100) window.__thumbmuxGapFrames?.shift();
          } catch {
            // Session-list and malformed/non-JSON traffic are outside this probe.
          }
        });
      }
    };
  }, { bg: background, sessionName: session });
}

async function dataTotal(page: Page): Promise<number> {
  return Number(await page.getByTestId('mtv').getAttribute('data-total')) || 0;
}

async function wheelToOldestLoadedRow(page: Page): Promise<void> {
  await page.getByTestId('mtv').evaluate((mtv) => {
    const rect = mtv.getBoundingClientRect();
    mtv.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -1_000_000,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
}

async function expandRealHistoryToCap(page: Page, session: string): Promise<void> {
  // Geometry changes intentionally replace the live client window with a
  // short (~250-row) capture. The durable proof that expansion is safe is the
  // server archive, not a fixed client live-window length.
  await expect.poll(() => archiveLineCount(session), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(INITIAL_ROWS - INITIAL_LIVE_ROWS);
  await expect(page.getByTestId('mtv')).toHaveAttribute('data-history-paging', 'ceiling');
  await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThan(0);
  for (let pageIndex = 0; pageIndex < 8 && await dataTotal(page) < RETAINED_ROW_CAP; pageIndex++) {
    const before = await dataTotal(page);
    await wheelToOldestLoadedRow(page);
    await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThan(before);
  }
  await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBe(RETAINED_ROW_CAP);
  await wheelToOldestLoadedRow(page);
  await expect.poll(async () => page.getByTestId('mtv').evaluate((mtv) => {
    const presentationHeight = Number(mtv.getAttribute('data-presentation-height'));
    const lineHeight = Number.parseFloat(getComputedStyle(mtv).lineHeight);
    const bottomOffset = Number(mtv.getAttribute('data-bottom-offset'));
    const maxOffset = Math.max(0, presentationHeight - mtv.clientHeight);
    return Math.abs(maxOffset - bottomOffset) <= lineHeight;
  })).toBe(true);
}

async function scrollToGap(page: Page): Promise<void> {
  await wheelToOldestLoadedRow(page);
  const gap = page.locator('.mtv-gap[data-gap-rows]');
  const { total, lineHeight } = await page.getByTestId('mtv').evaluate((mtv) => ({
    total: Number(mtv.getAttribute('data-total')),
    lineHeight: Number.parseFloat(getComputedStyle(mtv).lineHeight),
  }));
  const stepRows = 100;
  const maxSteps = Math.ceil(total / stepRows) + 2;
  for (let step = 0; step < maxSteps && await gap.count() === 0; step++) {
    await page.getByTestId('mtv').evaluate(async (mtv, deltaY) => {
      const rect = mtv.getBoundingClientRect();
      mtv.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, stepRows * lineHeight);
  }
  await expect(gap).toHaveCount(1);

  const centerAdjustment = await gap.evaluate((row) => {
    const viewport = row.closest<HTMLElement>('[data-testid="mtv"]');
    if (!viewport) throw new Error('Gap row is outside the terminal viewport');
    const rowRect = row.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return (rowRect.top + rowRect.bottom - viewportRect.top - viewportRect.bottom) / 2;
  });
  await page.getByTestId('mtv').evaluate(async (mtv, deltaY) => {
    const rect = mtv.getBoundingClientRect();
    mtv.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, centerAdjustment);
}

async function pngDiff(
  page: Page,
  actual: Buffer,
  control: Buffer,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<PixelDiff> {
  return page.evaluate(async ({ actualBase64, controlBase64, region }) => {
    const decode = async (base64: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas is unavailable');
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    };

    const [left, right] = await Promise.all([decode(actualBase64), decode(controlBase64)]);
    if (left.width !== right.width || left.height !== right.height) {
      throw new Error(`Screenshot dimensions differ: ${left.width}x${left.height} vs ${right.width}x${right.height}`);
    }

    const startX = region?.x ?? 0;
    const startY = region?.y ?? 0;
    const regionWidth = region?.width ?? left.width;
    const regionHeight = region?.height ?? left.height;
    if (
      startX < 0 || startY < 0 || regionWidth <= 0 || regionHeight <= 0
      || startX + regionWidth > left.width || startY + regionHeight > left.height
    ) {
      throw new Error(`Invalid diff region ${startX},${startY} ${regionWidth}x${regionHeight}`);
    }

    let changedPixels = 0;
    let maxChannelDelta = 0;
    let minX = regionWidth;
    let minY = regionHeight;
    let maxX = -1;
    let maxY = -1;
    for (let y = startY; y < startY + regionHeight; y++) {
      for (let x = startX; x < startX + regionWidth; x++) {
        const offset = (y * left.width + x) * 4;
        let pixelDelta = 0;
        for (let channel = 0; channel < 4; channel++) {
          pixelDelta = Math.max(
            pixelDelta,
            Math.abs(left.pixels[offset + channel]! - right.pixels[offset + channel]!),
          );
        }
        maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
        if (pixelDelta <= 8) continue;
        const localX = x - startX;
        const localY = y - startY;
        changedPixels++;
        minX = Math.min(minX, localX);
        minY = Math.min(minY, localY);
        maxX = Math.max(maxX, localX);
        maxY = Math.max(maxY, localY);
      }
    }

    return {
      changedPixels,
      totalPixels: regionWidth * regionHeight,
      maxChannelDelta,
      bbox: changedPixels === 0
        ? null
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    };
  }, {
    actualBase64: actual.toString('base64'),
    controlBase64: control.toString('base64'),
    region: clip,
  });
}

async function captureScenario(
  page: Page,
  testInfo: TestInfo,
  tag: string,
): Promise<ScenarioResult> {
  await scrollToGap(page);
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const gap = page.locator('.mtv-gap[data-gap-rows]');
  const geometry = await gap.evaluate((row) => {
    const note = row.previousElementSibling as HTMLElement | null;
    const previous = note?.previousElementSibling as HTMLElement | null;
    const next = row.nextElementSibling as HTMLElement | null;
    const viewport = row.closest<HTMLElement>('[data-testid="mtv"]');
    if (!previous || !next || !viewport || !note?.matches('.mtv-gap-marker[role="note"]')) {
      throw new Error('Gap boundary is missing a retained neighbour or semantic marker');
    }
    const previousRect = previous.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const nextRect = next.getBoundingClientRect();
    const markerRect = note.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const clip = (
      rect: { left: number; top: number; right: number; bottom: number },
      insetTop = 0,
      insetBottom = 0,
    ) => {
      const x = Math.max(0, Math.ceil(rect.left));
      const y = Math.max(0, Math.ceil(rect.top + insetTop));
      const right = Math.min(window.innerWidth, Math.floor(rect.right));
      const bottom = Math.min(window.innerHeight, Math.floor(rect.bottom - insetBottom));
      return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    };
    const markerStyle = getComputedStyle(note);
    return {
      clips: {
        previous: clip(previousRect),
        gap: clip(rowRect),
        next: clip(nextRect),
        marker: clip(markerRect),
      },
      fullyVisible: [previousRect, rowRect, nextRect].every(
        (rect) => rect.top >= viewportRect.top && rect.bottom <= viewportRect.bottom,
      ),
      markerOutsideContent: markerRect.left >= viewportRect.left
        && markerRect.right <= rowRect.left
        && markerRect.top >= rowRect.top - 0.5
        && markerRect.bottom <= rowRect.bottom + 0.5,
      previousText: (previous.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd(),
      gapText: (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd(),
      gapRows: Number(row.getAttribute('data-gap-rows')),
      title: row.getAttribute('title'),
      noteLabel: note.getAttribute('aria-label'),
      lineHeight: Number.parseFloat(getComputedStyle(viewport).lineHeight),
      rowHeights: [previousRect.height, rowRect.height, nextRect.height],
      rowSteps: [rowRect.top - previousRect.top, nextRect.top - rowRect.top],
      markerBorderLeftWidth: markerStyle.borderLeftWidth,
      markerBorderLeftStyle: markerStyle.borderLeftStyle,
      markerBorderRightWidth: markerStyle.borderRightWidth,
    };
  });
  expect(geometry.fullyVisible).toBe(true);
  expect(geometry.markerOutsideContent).toBe(true);
  for (const clip of Object.values(geometry.clips)) {
    expect(clip.width).toBeGreaterThan(0);
    expect(clip.height).toBeGreaterThan(0);
  }
  for (const height of geometry.rowHeights) {
    expect(Math.abs(height - geometry.lineHeight)).toBeLessThanOrEqual(0.5);
  }
  for (const step of geometry.rowSteps) {
    expect(Math.abs(step - geometry.lineHeight)).toBeLessThanOrEqual(0.5);
  }
  expect(geometry.markerBorderLeftWidth).toBe('1px');
  expect(geometry.markerBorderLeftStyle).toBe('solid');
  expect(geometry.markerBorderRightWidth).toBe('0px');

  const previousLine = Number(geometry.previousText.match(/\b(\d{5})\b/)?.[1]);
  const renderedFirstLiveLine = Number(geometry.gapText.match(/\b(\d{5})\b/)?.[1]);
  expect(Number.isFinite(previousLine)).toBe(true);
  expect(Number.isFinite(renderedFirstLiveLine)).toBe(true);
  const missingRowsFromRenderedBoundary = renderedFirstLiveLine - previousLine - 1;
  expect(missingRowsFromRenderedBoundary).toBeGreaterThan(0);
  expect(geometry.gapRows).toBe(missingRowsFromRenderedBoundary);
  const expectedLabel = `${missingRowsFromRenderedBoundary} rows dropped before this row`;
  expect(geometry.title).toBe(expectedLabel);
  expect(geometry.noteLabel).toBe(expectedLabel);

  const screenshotOptions = {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    scale: 'css' as const,
  };
  const actualScreenshot = testInfo.outputPath(`gap-${tag}.png`);
  const controlScreenshot = testInfo.outputPath(`gap-${tag}-control.png`);
  // Same DOM, coordinates, font, and palette: suppress only the gutter marker.
  // All three complete terminal rows must remain pixel-identical, while the
  // reserved gutter must differ so deleting the marker cannot pass.
  const actualImage = await page.screenshot({
    ...screenshotOptions,
    path: actualScreenshot,
    fullPage: true,
    style: SCREENSHOT_STABILIZER_STYLE,
  });
  const controlImage = await page.screenshot({
    ...screenshotOptions,
    path: controlScreenshot,
    fullPage: true,
    style: CONTROL_SCREENSHOT_STYLE,
  });

  const contentDiffs = {
    previous: await pngDiff(page, actualImage, controlImage, geometry.clips.previous),
    gap: await pngDiff(page, actualImage, controlImage, geometry.clips.gap),
    next: await pngDiff(page, actualImage, controlImage, geometry.clips.next),
  };
  const markerDiff = await pngDiff(page, actualImage, controlImage, geometry.clips.marker);
  const changedContentDiffs = Object.values(contentDiffs).filter((diff) => diff.changedPixels > 0);
  return {
    tag,
    actualScreenshot,
    controlScreenshot,
    gapRows: geometry.gapRows,
    previousLine,
    firstLiveLine: renderedFirstLiveLine,
    lineHeight: geometry.lineHeight,
    contentDiffs,
    markerDiff,
    occludedPixelHeight: Math.max(0, ...changedContentDiffs.map((diff) => diff.bbox?.height ?? 0)),
    affectedRows: changedContentDiffs.length,
  };
}

test('real retained-history gap never paints over the preceding row in dark, light, and mobile views', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const session = sessionName(testInfo, scenario.tag);
    let context: BrowserContext | null = null;
    try {
      createGapSession(session);
      context = await browser.newContext({
        viewport: { width: scenario.width, height: scenario.height },
        deviceScaleFactor: 1,
        isMobile: scenario.mobile,
        hasTouch: scenario.mobile,
      });
      await installScenarioState(context, scenario.background, session);
      const page = await context.newPage();
      // Open the full viewer directly. Loading the hub first would mount a
      // tail-only SessionThumb subscription, which deliberately does not
      // initialize the full server archive this retained-history proof needs.
      await page.goto(demoUrl(session), { waitUntil: 'domcontentloaded' });

      const mtv = page.getByTestId('mtv');
      await expect(mtv).toBeVisible();
      await expect(mtv).toHaveCSS(
        'background-color',
        scenario.background === '#101014' ? 'rgb(16, 16, 20)' : 'rgb(245, 240, 232)',
      );
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(scenario.width);

      await expandRealHistoryToCap(page, session);
      appendLiveRows(session, INITIAL_ROWS + 1, INITIAL_ROWS + APPEND_ROWS);

      const finalMarker = `LIVE SENTINEL ${String(INITIAL_ROWS + APPEND_ROWS).padStart(5, '0')}`;
      await expect.poll(() => page.evaluate((marker) => (
        window.__thumbmuxGapFrames ?? []
      ).some((frame) => frame.includes(marker)), finalMarker), { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId('demo-new-content')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => dataTotal(page)).toBe(RETAINED_ROW_CAP);

      results.push(await captureScenario(page, testInfo, scenario.tag));
    } finally {
      await context?.close();
      killGapSession(session);
    }
  }

  console.log(`gap-occlusion metrics=${JSON.stringify(results)}`);
  const missingMarkers = results.filter((result) => result.markerDiff.changedPixels === 0);
  expect(
    missingMarkers,
    'The gap boundary must remain visibly marked; removing the marker is not a valid occlusion fix.',
  ).toEqual([]);
  const occlusions = results.filter((result) => result.affectedRows > 0);
  expect(
    occlusions,
    'The no-marker control changed pixels in a retained terminal row; the gap marker is occluding terminal content.',
  ).toEqual([]);
});
