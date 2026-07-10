import { expect, test } from '@playwright/test';
import { dockerExec, killSession, shellQuote } from './helpers';

const TOTAL_LINES = 12_000;
const HISTORY_LIMIT = 15_000;
const HISTORY_BATCH = 2_000;
const INITIAL_LIVE_WINDOW = 2_000;
const PREFIX = 'SM';

function createHistorySession(session: string) {
  dockerExec(
    `tmux start-server \\; set-option -g history-limit ${HISTORY_LIMIT} \\; ` +
      `new-session -d -s ${shellQuote(session)} -x 120 -y 40 ${shellQuote('bash --noprofile --norc')}`,
    10_000,
  );
  dockerExec(`tmux set-option -t ${shellQuote(session)} history-limit ${HISTORY_LIMIT}`, 10_000);
  dockerExec(`tmux send-keys -t ${shellQuote(session)} -l -- ${shellQuote(`seq -f '${PREFIX} line %05g payload' 1 ${TOTAL_LINES}`)}`, 10_000);
  dockerExec(`tmux send-keys -t ${shellQuote(session)} Enter`, 10_000);

  const last = `${PREFIX} line ${String(TOTAL_LINES).padStart(5, '0')} payload`;
  for (let i = 0; i < 120; i++) {
    const pane = dockerExec(`tmux capture-pane -t ${shellQuote(session)} -p -S -80`, 20_000);
    if (pane.includes(last)) return;
    dockerExec('sleep 0.1', 1_000);
  }
  throw new Error('Timed out seeding the history session');
}

async function installHistoryHarness(page: import('@playwright/test').Page, session: string) {
  await page.addInitScript(({ sessionName, totalLines, initialLiveWindow, batchSize, prefix }) => {
    const w = window as any;
    w.__smoothHistory = {
      frames: [] as number[],
      events: [] as any[],
      fakeBatches: 0,
      requests: 0,
      maxRows: 0,
      lastFrame: 0,
      scrollTimer: 0,
      initialLiveStart: 0,
      firstHistoryEnd: 0,
    };

    const nativeWebSocket = window.WebSocket;
    const pad = (n: number) => String(n).padStart(5, '0');
    let nextEnd = totalLines - initialLiveWindow;

    window.WebSocket = class SmoothHistoryWebSocket extends nativeWebSocket {
      constructor(...args: ConstructorParameters<typeof nativeWebSocket>) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const frame = JSON.parse(event.data);
            if (frame?.channel !== sessionName || frame.type !== 'output' || typeof frame.data !== 'string') return;
            const numbers = [...frame.data.matchAll(new RegExp(`${prefix} line (\\d{5})`, 'g'))]
              .map((match) => Number(match[1]))
              .filter(Number.isFinite);
            if (numbers.length === 0) return;
            const firstLive = Math.min(...numbers);
            w.__smoothHistory.initialLiveStart = firstLive;
            nextEnd = Math.min(nextEnd, firstLive - 1);
          } catch {
            // Ignore non-protocol traffic.
          }
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        try {
          const msg = JSON.parse(String(data));
          if (msg?.type === 'history_expand' && msg?.session === sessionName) {
            w.__smoothHistory.requests++;
            const end = nextEnd;
            if (w.__smoothHistory.firstHistoryEnd === 0) w.__smoothHistory.firstHistoryEnd = end;
            const start = Math.max(1, end - batchSize + 1);
            const lines: string[] = [];
            for (let line = start; line <= end; line++) {
              lines.push(`${prefix} line ${pad(line)} payload`);
            }
            nextEnd = start - 1;
            w.__smoothHistory.fakeBatches++;
            const frame = {
              channel: sessionName,
              type: 'history',
              data: JSON.stringify({ lines, startLine: start, hasMore: start > 1 }),
            };
            setTimeout(() => {
              this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
            }, 12);
            return;
          }
        } catch {
          // Forward anything that is not a history request.
        }
        super.send(data);
      }
    };

    const tick = (now: number) => {
      const state = w.__smoothHistory;
      if (state.lastFrame > 0) state.frames.push(now - state.lastFrame);
      state.lastFrame = now;
      const mtv = document.querySelector('[data-testid="mtv"]');
      if (mtv) state.maxRows = Math.max(state.maxRows, mtv.querySelectorAll('.mtv-line').length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, {
    sessionName: session,
    totalLines: TOTAL_LINES,
    initialLiveWindow: INITIAL_LIVE_WINDOW,
    batchSize: HISTORY_BATCH,
    prefix: PREFIX,
  });
}

async function dataTotal(page: import('@playwright/test').Page): Promise<number> {
  return Number(await page.getByTestId('mtv').getAttribute('data-total')) || 0;
}

test('history prepend expansion stays smooth and anchored', async ({ page }) => {
  test.setTimeout(300_000);
  const session = `sim-smooth-${Date.now().toString(36)}`;
  const baseUrl = process.env.DEMO_URL;
  if (!baseUrl) throw new Error('DEMO_URL is required');

  try {
    createHistorySession(session);
    await installHistoryHarness(page, session);

    const url = new URL(baseUrl);
    url.searchParams.set('session', session);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const mtv = page.getByTestId('mtv');
    await expect(mtv).toBeVisible();
    await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(INITIAL_LIVE_WINDOW);
    await expect.poll(() => page.evaluate(() => (window as any).__smoothHistory.initialLiveStart))
      .toBeGreaterThan(0);

    await mtv.evaluate((el) => {
      const state = (window as any).__smoothHistory;
      el.addEventListener('thumbmux-history-prepend', (event) => {
        state.events.push((event as CustomEvent).detail);
      });
      state.frames = [];
      state.events = [];
      state.fakeBatches = 0;
      state.requests = 0;
      state.maxRows = el.querySelectorAll('.mtv-line').length;
      state.lastFrame = performance.now();
    });

    const initialTotal = await dataTotal(page);
    await mtv.evaluate((el) => {
      const state = (window as any).__smoothHistory;
      const rect = el.getBoundingClientRect();
      let ticks = 0;
      state.scrollTimer = window.setInterval(() => {
        el.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -3000,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
        ticks++;
        if (ticks >= 180) window.clearInterval(state.scrollTimer);
      }, 16);
    });

    await expect
      .poll(() => page.evaluate(() => (window as any).__smoothHistory.fakeBatches), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(3);

    await mtv.evaluate(() => {
      const state = (window as any).__smoothHistory;
      if (state.scrollTimer) window.clearInterval(state.scrollTimer);
    });
    await page.waitForTimeout(250);

    const afterTotal = await dataTotal(page);
    const stats = await page.evaluate(() => {
      const state = (window as any).__smoothHistory;
      const frames = state.frames.filter((value: number) => Number.isFinite(value) && value > 0);
      const sorted = [...frames].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : 0;
      const max = sorted.length ? sorted[sorted.length - 1] : 0;
      return {
        count: frames.length,
        max,
        p95,
        requests: state.requests,
        fakeBatches: state.fakeBatches,
        maxRows: state.maxRows,
        initialLiveStart: state.initialLiveStart,
        firstHistoryEnd: state.firstHistoryEnd,
        events: state.events,
      };
    });

    console.log(
      `history-smooth frames count=${stats.count} max=${stats.max.toFixed(2)}ms ` +
        `p95=${stats.p95.toFixed(2)}ms batches=${stats.fakeBatches} maxRows=${stats.maxRows}`,
    );

    expect(afterTotal).toBeGreaterThanOrEqual(initialTotal + HISTORY_BATCH * 3);
    expect(stats.fakeBatches).toBeGreaterThanOrEqual(3);
    expect(stats.requests).toBeGreaterThanOrEqual(3);
    expect(stats.firstHistoryEnd).toBeGreaterThan(0);
    expect(stats.firstHistoryEnd).toBeLessThan(stats.initialLiveStart);
    expect(stats.count).toBeGreaterThan(30);
    expect(stats.max).toBeLessThanOrEqual(80);
    expect(stats.p95).toBeLessThan(24);
    expect(stats.maxRows).toBeLessThan(220);
    expect(stats.events.length).toBeGreaterThanOrEqual(3);
    for (const event of stats.events.slice(0, 3)) {
      expect(event.transformStable).toBe(true);
      expect(event.before.transform).toBe(event.after.transform);
      expect(event.before.anchorText).toBe(event.after.anchorText);
      expect(event.after.rowCount).toBeLessThan(220);
    }
  } finally {
    killSession(session);
  }
});
