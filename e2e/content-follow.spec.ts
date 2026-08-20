import { expect, test, type Page } from '@playwright/test';
import {
  appendLines,
  bottomOffset,
  createLineSession,
  dataTotal,
  killSession,
  lineHeight,
  makeSessionName,
  openSession,
  visibleTerminalLines,
  wheel,
} from './helpers';

type VisibleAnchor = {
  lineId: string;
  text: string;
  y: number;
};

type ViewportBox = {
  top: number;
  bottom: number;
  height: number;
};

async function installWireProbe(page: Page, session: string): Promise<void> {
  await page.addInitScript((sessionName) => {
    const NativeWebSocket = window.WebSocket;
    const syntheticEvents = new WeakSet<MessageEvent>();
    const state = {
      base: [] as string[],
      freeze: false,
      latestData: '',
      socket: null as WebSocket | null,
      inject: null as null | ((frame: Record<string, unknown>) => void),
    };
    (window as any).__thumbmuxContentFollow = state;

    window.WebSocket = class ContentFollowWebSocket extends NativeWebSocket {
      constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
        super(...args);
        state.socket = this;
        state.inject = (frame) => {
          state.freeze = true;
          const event = new MessageEvent('message', { data: JSON.stringify(frame) });
          syntheticEvents.add(event);
          this.dispatchEvent(event);
        };
        this.addEventListener('message', (event) => {
          const synthetic = syntheticEvents.has(event);
          if (synthetic) syntheticEvents.delete(event);
          if (typeof event.data !== 'string') return;

          let frame: any;
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }
          if (frame?.channel !== sessionName) return;
          if (state.freeze && !synthetic && (frame.type === 'output' || frame.type === 'delta')) {
            event.stopImmediatePropagation();
            return;
          }
          if (frame.type === 'output' && typeof frame.data === 'string') {
            state.base = frame.data.split('\n');
          } else if (
            frame.type === 'delta'
            && Number.isInteger(frame.prefix)
            && Array.isArray(frame.lines)
          ) {
            state.base = state.base.slice(0, frame.prefix).concat(frame.lines);
          } else {
            return;
          }
          state.latestData = state.base.join('\n');
        });
      }
    };
  }, session);
}

async function visibleAnchor(page: Page): Promise<VisibleAnchor> {
  return page.getByTestId('mtv').evaluate((mtv) => {
    const viewport = mtv.getBoundingClientRect();
    const rows = Array.from(mtv.querySelectorAll<HTMLElement>('.mtv-line'))
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          lineId: row.getAttribute('data-line-id') ?? '',
          text: (row.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''),
          top: rect.top,
          bottom: rect.bottom,
        };
      })
      .filter((row) => (
        row.text.startsWith('FOLLOW line ')
        && row.top >= viewport.top + 1
        && row.bottom <= viewport.bottom - 1
      ));
    const anchor = rows[Math.floor(rows.length / 2)];
    if (!anchor) throw new Error('No fully visible FOLLOW row was available for an anchor');
    return {
      lineId: anchor.lineId,
      text: anchor.text,
      y: anchor.top - viewport.top,
    };
  });
}

async function viewportBox(page: Page): Promise<ViewportBox> {
  return page.getByTestId('mtv').evaluate((mtv) => {
    const rect = mtv.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  });
}

async function anchorByText(page: Page, text: string): Promise<VisibleAnchor | null> {
  return page.getByTestId('mtv').evaluate((mtv, wanted) => {
    const viewport = mtv.getBoundingClientRect();
    const row = Array.from(mtv.querySelectorAll<HTMLElement>('.mtv-line'))
      .find((candidate) => (
        (candidate.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '') === wanted
      ));
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return {
      lineId: row.getAttribute('data-line-id') ?? '',
      text: wanted,
      y: rect.top - viewport.top,
    };
  }, text);
}

async function expectAnchorStable(page: Page, before: VisibleAnchor): Promise<void> {
  await expect.poll(async () => (await anchorByText(page, before.text))?.lineId ?? null)
    .toBe(before.lineId);
  const after = await anchorByText(page, before.text);
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(before.y, 1);
}

async function injectTailRewrite(
  page: Page,
  session: string,
): Promise<{ before: number; after: number }> {
  return page.evaluate((sessionName) => {
    const state = (window as any).__thumbmuxContentFollow;
    if (!state?.inject || !state.latestData) throw new Error('content-follow wire probe is not ready');
    const previous = state.latestData.split('\n');
    const rewriteRows = Math.min(8, previous.length);
    const next = [
      ...previous.slice(0, previous.length - rewriteRows),
      ...Array.from({ length: rewriteRows }, (_, index) => `FOLLOW rewritten tail ${index + 1}`),
      'FOLLOW reset append 1',
      'FOLLOW reset append 2',
      'FOLLOW reset append 3',
      'FOLLOW reset append 4',
    ];
    state.inject({
      channel: sessionName,
      type: 'output',
      data: next.join('\n'),
      cursor: null,
      reset: 'resync',
    });
    return { before: previous.length, after: next.length };
  }, session);
}

async function injectLiveAppend(page: Page, session: string, marker: string): Promise<void> {
  await page.evaluate(({ sessionName, line }) => {
    const state = (window as any).__thumbmuxContentFollow;
    if (!state?.inject || !state.latestData) throw new Error('content-follow wire probe is not ready');
    state.inject({
      channel: sessionName,
      type: 'output',
      data: `${state.latestData}\n${line}`,
      cursor: null,
    });
  }, { sessionName: session, line: marker });
}

test('content follows only at the exact live tail and preserves a scrolled reader', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const session = makeSessionName(testInfo, 'follow');
  try {
    createLineSession(session, 'FOLLOW', 360);
    await installWireProbe(page, session);
    await openSession(page, session, { showShortcutBar: false });
    await expect.poll(() => dataTotal(page)).toBeGreaterThanOrEqual(360);

    const rowHeight = await lineHeight(page);
    const exactTailAnchor = await visibleAnchor(page);
    const exactTailViewport = await viewportBox(page);
    await wheel(page, -4, 1);
    await expect.poll(() => bottomOffset(page)).toBeGreaterThan(0);
    await expect(page.getByTestId('demo-scroll-bottom')).toBeVisible();
    await expect.poll(async () => (await viewportBox(page)).height)
      .toBeLessThan(exactTailViewport.height - 40);
    const scrolledViewport = await viewportBox(page);
    const smallScrollAnchor = await anchorByText(page, exactTailAnchor.text);
    expect(smallScrollAnchor).not.toBeNull();
    expect(smallScrollAnchor!.lineId).toBe(exactTailAnchor.lineId);
    // The 4px reader gesture should move the same row down by 4px. Mounting the
    // docked control moves the viewport bottom upward, but must not counter-
    // scroll the content 52px toward the live tail.
    expect(scrolledViewport.top + smallScrollAnchor!.y)
      .toBeCloseTo(exactTailViewport.top + exactTailAnchor.y + 4, 1);
    expect(await bottomOffset(page))
      .toBeCloseTo(exactTailViewport.bottom - scrolledViewport.bottom + 4, 0);
    const totalBeforeLive = await dataTotal(page);

    appendLines(session, [
      'FOLLOW live append 1',
      'FOLLOW live append 2',
      'FOLLOW live append 3',
      'FOLLOW live append 4',
    ]);
    await expect.poll(() => dataTotal(page), { timeout: 20_000 }).toBeGreaterThan(totalBeforeLive);
    await expect(page.getByTestId('demo-new-content')).toBeVisible();
    await expectAnchorStable(page, smallScrollAnchor!);
    expect(await bottomOffset(page)).toBeGreaterThan(0);

    await page.getByTestId('demo-new-content').click();
    await expect.poll(() => bottomOffset(page)).toBe(0);
    await expect.poll(async () => (await visibleTerminalLines(page)).includes('FOLLOW live append 4'))
      .toBe(true);

    const bottomMarker = 'FOLLOW exact bottom append';
    const totalAtBottom = await dataTotal(page);
    appendLines(session, [bottomMarker]);
    await expect.poll(() => dataTotal(page), { timeout: 20_000 }).toBeGreaterThan(totalAtBottom);
    expect(await bottomOffset(page)).toBe(0);
    await expect.poll(async () => (await visibleTerminalLines(page)).includes(bottomMarker)).toBe(true);

    await wheel(page, -Math.ceil(rowHeight * 7), 1);
    await expect.poll(() => bottomOffset(page)).toBeGreaterThan(rowHeight * 5);
    const multiRowAnchor = await visibleAnchor(page);
    const rewrite = await injectTailRewrite(page, session);
    await expect.poll(() => dataTotal(page)).toBe(rewrite.after);
    expect(rewrite.after - rewrite.before).toBe(4);
    await expectAnchorStable(page, multiRowAnchor);
    expect(await bottomOffset(page)).toBeGreaterThan(rowHeight * 5);

    await page.getByTestId('demo-scroll-bottom').click();
    await expect.poll(() => bottomOffset(page)).toBe(0);

    const resumedMarker = 'FOLLOW resumed after explicit bottom';
    await injectLiveAppend(page, session, resumedMarker);
    expect(await bottomOffset(page)).toBe(0);
    await expect.poll(async () => (await visibleTerminalLines(page)).includes(resumedMarker)).toBe(true);
  } finally {
    killSession(session);
  }
});
