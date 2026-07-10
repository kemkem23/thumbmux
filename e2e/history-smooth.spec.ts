import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const CONTAINER = 'thumbmux-smooth';
const HOST_PORT = 47120;
const DEMO_PORT = 7681;
const TOTAL_LINES = 12_000;
const HISTORY_LIMIT = 15_000;
const HISTORY_BATCH = 2_000;
const INITIAL_LIVE_WINDOW = 250;
const PREFIX = 'SM';
const PACKAGE_DIR = process.env.THUMBMUX_PACKAGE_DIR
  ?? (process.cwd().endsWith('/packages/thumbmux/e2e')
    ? '..'
    : process.cwd().endsWith('/packages/thumbmux')
      ? '.'
      : 'packages/thumbmux');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bash(script: string, timeout = 30_000): string {
  return execFileSync('bash', ['-lc', script], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function dockerExec(script: string, timeout = 30_000): string {
  return execFileSync('docker', ['exec', CONTAINER, 'bash', '-lc', script], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function dockerRm() {
  try {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore', timeout: 20_000 });
  } catch {
    // Best effort cleanup.
  }
}

function setupContainer(): string {
  dockerRm();
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${HOST_PORT}:${DEMO_PORT}`,
    'oven/bun:1',
    'sleep',
    'infinity',
  ], { stdio: 'ignore', timeout: 30_000 });
  dockerExec('apt-get update -qq && apt-get install -y -qq tmux procps', 180_000);
  bash(
    `tar -C ${shellQuote(PACKAGE_DIR)} --exclude=node_modules --exclude='*/node_modules' --exclude=dist -cf - . | ` +
      `docker exec -i ${shellQuote(CONTAINER)} bash -lc 'mkdir -p /app && tar -C /app -xf -'`,
    120_000,
  );
  dockerExec('cd /app && bun install', 180_000);
  dockerExec(`cd /app && PORT=${DEMO_PORT} bun run demo -- --host >/tmp/demo.log 2>&1 &`, 10_000);

  for (let i = 0; i < 120; i++) {
    const log = dockerExec('cat /tmp/demo.log 2>/dev/null || true', 10_000);
    const token = log.match(/t=([a-f0-9]+)/)?.[1];
    if (token) return `http://127.0.0.1:${HOST_PORT}/?t=${token}`;
    dockerExec('sleep 0.25', 1_000);
  }
  throw new Error('Timed out waiting for the demo token');
}

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
    };

    const nativeWebSocket = window.WebSocket;
    const pad = (n: number) => String(n).padStart(5, '0');
    let nextEnd = totalLines - initialLiveWindow;

    window.WebSocket = class SmoothHistoryWebSocket extends nativeWebSocket {
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        try {
          const msg = JSON.parse(String(data));
          if (msg?.type === 'history_expand' && msg?.session === sessionName) {
            w.__smoothHistory.requests++;
            const end = nextEnd;
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
  let baseUrl = '';

  try {
    baseUrl = setupContainer();
    createHistorySession(session);
    await installHistoryHarness(page, session);

    const url = new URL(baseUrl);
    url.searchParams.set('session', session);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const mtv = page.getByTestId('mtv');
    await expect(mtv).toBeVisible();
    await expect.poll(() => dataTotal(page), { timeout: 30_000 }).toBeGreaterThan(150);

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
    if (baseUrl) dockerRm();
    else dockerRm();
  }
});
