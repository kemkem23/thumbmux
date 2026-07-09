import { expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.THUMBMUX_CONTAINER || 'thumbmux-sim';
const SESSION_RE = /^sim-[a-z0-9-]+$/;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function dockerExec(script: string, timeout = 30_000): string {
  return execFileSync('docker', ['exec', CONTAINER, 'bash', '-lc', script], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function makeSessionName(testInfo: TestInfo, prefix: string): string {
  const slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22);
  return `sim-${prefix}-${testInfo.workerIndex}-${Date.now().toString(36)}-${slug}`;
}

function assertOwnedSession(session: string) {
  if (!SESSION_RE.test(session)) throw new Error(`Refusing to operate on non-test session: ${session}`);
}

export function killSession(session: string) {
  assertOwnedSession(session);
  dockerExec(`tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`, 10_000);
}

export function createLineSession(session: string, prefix: string, count: number) {
  assertOwnedSession(session);
  const limit = Math.max(6000, count + 200);
  dockerExec(`tmux start-server \\; set-option -g history-limit ${limit} \\; new-session -d -s ${shellQuote(session)} -x 120 -y 40 ${shellQuote('bash --noprofile --norc')}`, 10_000);
  dockerExec(`tmux set-option -t ${shellQuote(session)} history-limit ${limit}`, 10_000);
  runShellCommand(session, `seq -f ${shellQuote(`${prefix} line %04g payload`)} 1 ${count}`);
  const last = `${prefix} line ${String(count).padStart(4, '0')} payload`;
  for (let i = 0; i < 60; i++) {
    if (capturePane(session, -40).includes(last)) return;
    dockerExec('sleep 0.1', 1000);
  }
  throw new Error(`Timed out seeding ${count} lines for ${session}`);
}

export function createShellSession(session: string) {
  assertOwnedSession(session);
  dockerExec(`tmux start-server \\; set-option -g history-limit 6000 \\; new-session -d -s ${shellQuote(session)} -x 120 -y 40 ${shellQuote('bash --noprofile --norc')}`, 10_000);
  dockerExec(`tmux set-option -t ${shellQuote(session)} history-limit 6000`, 10_000);
}

export function sendLiteral(session: string, text: string) {
  assertOwnedSession(session);
  dockerExec(`tmux send-keys -t ${shellQuote(session)} -l -- ${shellQuote(text)}`, 10_000);
}

export function sendEnter(session: string) {
  assertOwnedSession(session);
  dockerExec(`tmux send-keys -t ${shellQuote(session)} Enter`, 10_000);
}

export function runShellCommand(session: string, command: string) {
  sendLiteral(session, command);
  sendEnter(session);
}

export function appendLines(session: string, lines: string[]) {
  const command = lines.map((line) => `printf '%s\\n' ${shellQuote(line)}`).join('; ');
  runShellCommand(session, command);
}

export function capturePane(session: string, startLine = -5000): string {
  assertOwnedSession(session);
  return dockerExec(`tmux capture-pane -t ${shellQuote(session)} -p -S ${startLine}`, 20_000);
}

export function demoUrlForSession(session: string): string {
  if (!process.env.DEMO_URL) throw new Error('DEMO_URL is required');
  const url = new URL(process.env.DEMO_URL);
  url.searchParams.set('session', session);
  return url.toString();
}

export async function openSession(page: Page, session: string) {
  await page.goto(demoUrlForSession(session), { waitUntil: 'domcontentloaded' });
  const mtv = page.getByTestId('mtv');
  await expect(mtv).toBeVisible();
  await expect.poll(() => dataTotal(page), { timeout: 20_000 }).toBeGreaterThan(0);
  const box = await mtv.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return mtv;
}

export async function dataTotal(page: Page): Promise<number> {
  return Number(await page.getByTestId('mtv').getAttribute('data-total')) || 0;
}

export async function bottomOffset(page: Page): Promise<number> {
  return Number(await page.getByTestId('mtv').getAttribute('data-bottom-offset')) || 0;
}

export async function renderedRowCount(page: Page): Promise<number> {
  return page.getByTestId('mtv').locator('.mtv-line').count();
}

export async function lineHeight(page: Page): Promise<number> {
  return page.getByTestId('mtv').evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight) || 1);
}

export async function visibleTerminalLines(page: Page): Promise<string[]> {
  return page.getByTestId('mtv').evaluate((mtv) => {
    const viewport = mtv.getBoundingClientRect();
    return Array.from(mtv.querySelectorAll<HTMLElement>('.mtv-line'))
      .filter((line) => {
        const rect = line.getBoundingClientRect();
        return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
      })
      .map((line) => (line.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''));
  });
}

export function lineNumbers(lines: string[]): number[] {
  return lines
    .map((line) => Number((line.match(/\bline\s+(\d+)\b/) || [])[1]))
    .filter(Number.isFinite);
}

export async function wheel(page: Page, deltaY: number, count: number) {
  const box = await page.getByTestId('mtv').boundingBox();
  if (!box) throw new Error('terminal viewport is not measurable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY);
  }
}

export async function assertVirtualized(page: Page, bound = 200) {
  await expect.poll(() => renderedRowCount(page)).toBeLessThan(bound);
}

export async function scrollToBottomByWheel(page: Page) {
  for (let i = 0; i < 30; i++) {
    if ((await bottomOffset(page)) === 0) break;
    await wheel(page, 900, 4);
    await page.waitForTimeout(25);
  }
  await expect.poll(() => bottomOffset(page)).toBe(0);
}

export async function selectVisibleLines(page: Page, count: number) {
  const selectionPlan = await page.getByTestId('mtv').evaluate((mtv, wanted) => {
    const viewport = mtv.getBoundingClientRect();
    const rows = Array.from(mtv.querySelectorAll<HTMLElement>('.mtv-line'))
      .map((line) => ({ line, rect: line.getBoundingClientRect(), text: line.textContent || '' }))
      .filter(({ rect, text }) => rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1 && text.trim().length > 0);
    const picked = rows.slice(1, Math.min(rows.length, wanted + 1));
    if (picked.length < wanted) return null;
    const first = picked[0];
    const last = picked[picked.length - 1];
    return {
      start: { x: first.rect.left + 2, y: first.rect.top + first.rect.height / 2 },
      end: { x: Math.min(last.rect.right - 2, last.rect.left + 520), y: last.rect.top + last.rect.height / 2 },
      texts: picked.map(({ text }) => text.replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '')),
    };
  }, count);
  if (!selectionPlan) throw new Error(`Could not find ${count} visible terminal lines to select`);

  await page.mouse.move(selectionPlan.start.x, selectionPlan.start.y);
  await page.mouse.down();
  await page.mouse.move(selectionPlan.end.x, selectionPlan.end.y, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const selected = await page.evaluate(() => window.getSelection()?.toString() || '');
  return { selected: normalizeText(selected), visibleTexts: selectionPlan.texts };
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
}

export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

export function markKnownGap(testInfo: TestInfo, id: string, description: string) {
  testInfo.annotations.push({ type: `known-gap:${id}`, description });
}
