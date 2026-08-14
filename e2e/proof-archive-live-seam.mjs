/**
 * Standalone Chromium proof for the residual archive/live seam fix.
 * Uses host tmux + the local package demo (FileHistoryArchive with the fix).
 *
 * Usage:
 *   DEMO_URL=http://127.0.0.1:8765/?t=TOKEN node proof-archive-live-seam.mjs
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const DEMO_URL = process.env.DEMO_URL;
if (!DEMO_URL) {
  console.error('Set DEMO_URL');
  process.exit(2);
}

const SESSION = `sim-seam-proof-${Date.now().toString(36)}`;

function sh(cmd) {
  return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 30_000 });
}

function killSession() {
  try {
    sh(`tmux kill-session -t "=${SESSION}" 2>/dev/null || true`);
  } catch {}
}

function createSession(count) {
  killSession();
  sh(`tmux new-session -d -s "${SESSION}" -x 120 -y 40 'bash --noprofile --norc'`);
  sh(`tmux set-option -t "${SESSION}" history-limit 8000`);
  // Numbered markers for contiguity checks. send-keys literal (-l) then Enter.
  const cmd = `for i in $(seq 1 ${count}); do printf 'SM line %04d payload\\n' "$i"; done`;
  execFileSync('tmux', ['send-keys', '-t', `=${SESSION}:0.0`, '-l', '--', cmd], { timeout: 10_000 });
  execFileSync('tmux', ['send-keys', '-t', `=${SESSION}:0.0`, 'Enter'], { timeout: 10_000 });
  // Wait until markers exist in the pane.
  for (let i = 0; i < 60; i++) {
    const cap = sh(`tmux capture-pane -t "=${SESSION}:0.0" -p -S -200`);
    if (cap.includes(`SM line ${String(count).padStart(4, '0')} payload`)) return;
    sh('sleep 0.15');
  }
  throw new Error('seed timeout\n' + sh(`tmux capture-pane -t "=${SESSION}:0.0" -p -S -30`));
}

function appendMarkers(from, to) {
  const cmd = `for i in $(seq ${from} ${to}); do printf 'SM line %04d payload\\n' "$i"; done`;
  execFileSync('tmux', ['send-keys', '-t', `=${SESSION}:0.0`, '-l', '--', cmd], { timeout: 10_000 });
  execFileSync('tmux', ['send-keys', '-t', `=${SESSION}:0.0`, 'Enter'], { timeout: 10_000 });
  sh('sleep 0.4');
}

async function dataTotal(page) {
  return Number(await page.getByTestId('mtv').getAttribute('data-total') || '0');
}

async function main() {
  const TOTAL = 300;
  createSession(TOTAL);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const url = new URL(DEMO_URL);
    url.searchParams.set('session', SESSION);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.getByTestId('mtv').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mtv"]');
      return Number(el?.getAttribute('data-total') || 0) > 40;
    }, null, { timeout: 30_000 });

    console.log('open total=', await dataTotal(page));

    // Scroll live window: emit more lines so content leaves the top while the
    // shell prompt rewrites (residual-2 failure mode).
    for (let b = 0; b < 4; b++) {
      appendMarkers(TOTAL + b * 25 + 1, TOTAL + (b + 1) * 25);
      await page.waitForTimeout(500);
    }
    console.log('after emit total=', await dataTotal(page));

    // Fling to older history through the archive/live seam.
    const mtv = page.getByTestId('mtv');
    for (let i = 0; i < 14; i++) {
      await mtv.evaluate((el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -100000,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }));
      });
      await page.waitForTimeout(180);
    }

    const rows = await page.locator('.mtv-line').evaluateAll((els) =>
      els.map((e) => (e.textContent || '').replace(/\u00a0/g, ' ').trim()),
    );
    const nums = rows
      .map((t) => {
        const m = t.match(/SM line (\d{4}) payload/);
        return m ? Number(m[1]) : null;
      })
      .filter((n) => n !== null);

    console.log('mounted SM markers:', nums.length, 'range', nums[0], '→', nums[nums.length - 1]);
    const holes = [];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) holes.push([nums[i - 1], nums[i]]);
    }
    const seamText = rows.some((t) => /rows not captured \(archive\/live seam\)/.test(t));
    const gapMarkers = await page.locator('.mtv-gap-marker').count();

    console.log('holes=', holes);
    console.log('seamText=', seamText, 'gapMarkers=', gapMarkers);

    if (nums.length < 8) throw new Error(`too few markers mounted: ${nums.length}`);
    if (holes.length > 0) throw new Error(`sequence holes at archive/live seam: ${JSON.stringify(holes)}`);
    if (seamText) throw new Error('false host-style seam marker text present');
    // gapMarkers may be 0 (healthy). Non-zero would be a retention gap, not this seam.

    // Control: genuine D3 still possible at host unit level (covered separately).
    // Browser control: inject is out of band; unit proves the alarm.

    console.log('PASS residual archive/live seam: contiguous SM markers, no false 2-row seam');
  } finally {
    await browser.close();
    killSession();
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  killSession();
  process.exit(1);
});
