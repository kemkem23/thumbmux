/**
 * Wave 4 browser proof for the SQLite reader canary.
 *
 * A real Chromium is the only thing that can show what a reader sees. This
 * mounts the canary REST surface on an ephemeral 127.0.0.1 listener over a
 * synthetic temp database, loads a minimal viewer page, and reads the rows back
 * out of the DOM. No tmux, no production history, no `brain.db`, no network,
 * and nothing here is wired to the shipping viewer.
 *
 * The headline case is `reopen 710`: the archive/live seam where thumbmux used
 * to drop ~710 rows every time a session was reopened. The fixture is shaped so
 * that number is literal — 1,000 rows with `live_start` at 710, so a reopened
 * viewer renders 290 immutable live rows plus a 40-row pane and must recover
 * exactly 710 archived rows by scrolling. They are counted, not asserted away.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { Browser, Page } from '@playwright/test';
import type { Server } from 'bun';
import { HistoryReaderCanary, historyReaderRequest } from '../src/sqlite-history/reader';
import { sha } from '../src/sqlite-history/codec';
import type { CaptureBatch, HistoryContext } from '../src/sqlite-history/types';
import { fixture } from './sqlite-history/helpers';

const require = createRequire(import.meta.url);
const TOTAL = 1000;
const LIVE_IMMUTABLE = 290;
const SCREEN_ROWS = 40;
/** The historical loss: the rows between the archive floor and `live_start`. */
const ARCHIVE_ROWS = TOTAL - LIVE_IMMUTABLE;

/** Independent oracle: the rows the fixture intends, generated from nothing but an index. */
function rowText(n: number): string {
  return `row:${String(n).padStart(6, '0')}:ไทย漢字\x1b[31m${n % 5 === 0 ? '' : 'OK'}`;
}

type Store = ReturnType<typeof fixture>['store'];

function commitBatch(store: Store, sid: string, from: number, count: number, liveImmutable: number): CaptureBatch {
  const lines = Array.from({ length: count }, (_, i) => rowText(from + i));
  const screen = Array.from({ length: SCREEN_ROWS }, (_, i) => `pane ${i}`);
  const raw = [...lines, ...screen];
  const observation = {
    raw, screen,
    geometry: { kind: 'pane' as const, rows: SCREEN_ROWS, cols: 80, generation: 1, alternate: false, cursor: null },
    at: 100 + from, source: {},
  };
  return {
    ticket: store.ticket(sid), observation,
    appended: lines.map(text => ({ kind: 'terminal' as const, text })),
    // `live_start = end - (liveLineLimit - screen.length)`, so this is what puts
    // the seam exactly `liveImmutable` rows above the newest line.
    liveLineLimit: liveImmutable + SCREEN_ROWS,
    evidence: { classification: 'initial' as const, depth: 'shallow' as const, source: {}, rawSha256: sha(JSON.stringify(observation)) },
  };
}

let browser: Browser;
let server: Server;
let f: ReturnType<typeof fixture>;
let sid: string;
let origin: string;

beforeAll(async () => {
  f = fixture();
  sid = await f.store.register({ name: 'wave4-browser', lifecycleKey: 'wave4-browser' });
  // 900 rows fully archived, then a final batch that parks the seam at 710.
  for (let start = 0; start < 900; start += 100) await f.store.commit(commitBatch(f.store, sid, start, 100, 0));
  await f.store.commit(commitBatch(f.store, sid, 900, 100, LIVE_IMMUTABLE));
  const reader = new HistoryReaderCanary(f.store);
  // The canary host: it serves its own viewer page and delegates every history
  // route to the package's REST surface untouched. Same-origin, so the page
  // exercises the real fetch path rather than a CORS shim.
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/') {
        return new Response(viewerHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return historyReaderRequest(reader, request);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await (require('@playwright/test') as typeof import('@playwright/test')).chromium.launch();
  console.log('BROWSER', JSON.stringify({ engine: browser.version(), connected: browser.isConnected(), origin }));
}, 180_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  await f?.cleanup();
});

/**
 * The viewer under test: it holds a pinned context, renders the live window
 * from the snapshot, and pages backward/forward through the canary REST
 * surface. Every row it renders lands in the DOM with its absolute line number.
 */
const VIEWER = `
window.__viewer = {
  ctx: null, statuses: [], errors: [],
  async open() {
    const res = await fetch(ORIGIN + '/history/snapshot?session=' + SID);
    if (!res.ok) { this.errors.push('snapshot:' + res.status); return; }
    const body = await res.json();
    this.ctx = body.receipt.context;
    this.statuses.push('snapshot:' + body.verification.status);
    document.getElementById('live').replaceChildren(...body.live.map(r => this.render(r, 'live')));
    document.getElementById('pane').textContent = body.receipt.screen.length + ' pane rows';
  },
  render(row, zone) {
    const el = document.createElement('div');
    el.className = 'row ' + zone;
    el.dataset.line = String(row.line_no);
    el.dataset.kind = row.kind;
    el.textContent = row.text;
    return el;
  },
  async pageOnce(direction, anchor, limit, ctx) {
    const params = new URLSearchParams({ session: SID, direction, limit: String(limit) });
    if (anchor !== null && anchor !== undefined) params.set('anchor', String(anchor));
    params.set('context', JSON.stringify(ctx ?? this.ctx));
    const res = await fetch(ORIGIN + '/history/page?' + params);
    const body = await res.json();
    if (!res.ok) { this.errors.push(direction + ':' + res.status + ':' + body.error); return null; }
    this.statuses.push(direction + ':' + body.verification.status);
    return body;
  },
  async scrollToTop(limit) {
    let anchor = null;
    const archive = document.getElementById('archive');
    for (let guard = 0; guard < 200; guard++) {
      const body = await this.pageOnce('before', anchor, limit);
      if (!body) return;
      if (body.verification.status === 'empty') return;
      archive.prepend(...body.page.rows.map(r => this.render(r, 'archive')));
      if (!body.page.hasMore) return;
      anchor = body.page.startLine;
    }
    this.errors.push('scrollToTop:guard');
  },
  async scrollForward(limit) {
    let anchor = null;
    const forward = document.getElementById('forward');
    for (let guard = 0; guard < 200; guard++) {
      const body = await this.pageOnce('after', anchor, limit);
      if (!body) return;
      if (body.verification.status === 'empty') return;
      forward.append(...body.page.rows.map(r => this.render(r, 'forward')));
      if (!body.page.hasMore) return;
      anchor = body.page.endLine - 1;
    }
    this.errors.push('scrollForward:guard');
  },
  read(selector) {
    return Array.from(document.querySelectorAll(selector))
      .map(el => ({ line_no: Number(el.dataset.line), kind: el.dataset.kind, text: el.textContent }));
  },
};
`;

function viewerHtml(): string {
  return `<!doctype html><html lang="th"><body>
      <div id="archive"></div><div id="live"></div><div id="forward"></div><div id="pane"></div>
      <script>const ORIGIN='';const SID=${JSON.stringify(sid)};${VIEWER}</script>
    </body></html>`;
}

async function viewerPage(): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(origin, { waitUntil: 'load' });
  return page;
}

type DomRow = { line_no: number; kind: string; text: string };

function expectContiguousFrom(rows: DomRow[], start: number): void {
  expect(rows.map(r => r.line_no)).toEqual(Array.from({ length: rows.length }, (_, i) => start + i));
  expect(rows.map(r => r.text)).toEqual(rows.map(r => rowText(r.line_no)));
  expect(rows.every(r => r.kind === 'terminal')).toBe(true);
}

describe('wave 4 reader canary in a real browser', () => {
  test('reopen 710: the archive/live seam gives back every row it used to drop', async () => {
    // First open: the viewer sees the whole session.
    const first = await viewerPage();
    let firstRows: DomRow[];
    try {
      await first.evaluate('window.__viewer.open()');
      await first.evaluate('window.__viewer.scrollToTop(250)');
      firstRows = await first.evaluate('window.__viewer.read(".row")') as DomRow[];
      expect(await first.evaluate('window.__viewer.errors') as string[]).toEqual([]);
    } finally { await first.close(); }
    expect(firstRows).toHaveLength(TOTAL);
    expectContiguousFrom(firstRows, 0);

    // The viewer is gone: no RAM, no open tab, nothing but the database.
    const reopened = await viewerPage();
    try {
      await reopened.evaluate('window.__viewer.open()');
      const liveOnly = await reopened.evaluate('window.__viewer.read(".live")') as DomRow[];
      const paneRows = await reopened.evaluate('document.getElementById("pane").textContent') as string;
      expect(liveOnly).toHaveLength(LIVE_IMMUTABLE);
      expect(liveOnly[0]!.line_no).toBe(ARCHIVE_ROWS);
      expect(paneRows).toBe(`${SCREEN_ROWS} pane rows`);

      // Scroll back through the seam. This is where the rows used to vanish.
      await reopened.evaluate('window.__viewer.scrollToTop(250)');
      const archive = await reopened.evaluate('window.__viewer.read(".archive")') as DomRow[];
      const all = await reopened.evaluate('window.__viewer.read(".row")') as DomRow[];
      expect(await reopened.evaluate('window.__viewer.errors') as string[]).toEqual([]);

      const recovered = archive.length;
      const missing = Array.from({ length: ARCHIVE_ROWS }, (_, i) => i)
        .filter(n => !archive.some(r => r.line_no === n));
      const duplicates = all.length - new Set(all.map(r => r.line_no)).size;
      console.log('REOPEN_710', JSON.stringify({
        total: TOTAL, liveStart: ARCHIVE_ROWS, liveRendered: liveOnly.length,
        archiveExpected: ARCHIVE_ROWS, archiveRecovered: recovered,
        missing: missing.length, duplicates, seamRow: all[ARCHIVE_ROWS - 1]?.line_no,
      }));
      expect(recovered).toBe(710);
      expect(missing).toEqual([]);
      expect(duplicates).toBe(0);
      expect(all).toHaveLength(TOTAL);
      expectContiguousFrom(all, 0);
      // No silent unknown anywhere in the reopen path.
      const statuses = await reopened.evaluate('window.__viewer.statuses') as string[];
      expect(statuses.every(s => /:(verified|empty)$/.test(s))).toBe(true);
      expect(statuses.filter(s => s.endsWith(':verified')).length).toBeGreaterThan(0);
    } finally { await reopened.close(); }
  }, 180_000);

  test('range scroll: every backward page tiles the previous one', async () => {
    const page = await viewerPage();
    try {
      await page.evaluate('window.__viewer.open()');
      const pages: Array<{ page: { startLine: number; endLine: number; rows: DomRow[]; hasMore: boolean }; verification: { status: string } }> = [];
      let anchor: number | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const body = await page.evaluate(
          ([a]) => (window as never as { __viewer: { pageOnce: (d: string, a: number | null, l: number) => Promise<unknown> } })
            .__viewer.pageOnce('before', a as number | null, 137),
          [anchor],
        ) as (typeof pages)[number] | null;
        if (!body || body.verification.status === 'empty') break;
        pages.push(body);
        if (!body.page.hasMore) break;
        anchor = body.page.startLine;
      }
      expect(pages.length).toBeGreaterThan(4);
      expect(pages.every(p => p.verification.status === 'verified')).toBe(true);
      // Newest page first; each page must start exactly where the older one ends.
      for (let i = 1; i < pages.length; i++) expect(pages[i]!.page.endLine).toBe(pages[i - 1]!.page.startLine);
      expect(pages[0]!.page.endLine).toBe(ARCHIVE_ROWS);
      expect(pages.at(-1)!.page.startLine).toBe(0);
      expect(pages.reduce((n, p) => n + p.page.rows.length, 0)).toBe(ARCHIVE_ROWS);
    } finally { await page.close(); }
  }, 120_000);

  test('forward scroll: paging up from the floor stops at live start', async () => {
    const page = await viewerPage();
    try {
      await page.evaluate('window.__viewer.open()');
      await page.evaluate('window.__viewer.scrollForward(211)');
      const forward = await page.evaluate('window.__viewer.read(".forward")') as DomRow[];
      expect(await page.evaluate('window.__viewer.errors') as string[]).toEqual([]);
      expect(forward).toHaveLength(ARCHIVE_ROWS);
      expectContiguousFrom(forward, 0);
      expect(forward.at(-1)!.line_no).toBe(ARCHIVE_ROWS - 1);
    } finally { await page.close(); }
  }, 120_000);

  test('snapshot race: writes during a scroll cannot bend a pinned page', async () => {
    const page = await viewerPage();
    try {
      await page.evaluate('window.__viewer.open()');
      const pinned = await page.evaluate('window.__viewer.ctx') as HistoryContext;

      // Commit while the browser is mid-scroll. The pin must not follow.
      const scroll = page.evaluate('window.__viewer.scrollToTop(97)');
      for (let i = 0; i < 3; i++) {
        await f.store.commit(commitBatch(f.store, sid, TOTAL + i * 50, 50, LIVE_IMMUTABLE));
      }
      await scroll;
      const archive = await page.evaluate('window.__viewer.read(".archive")') as DomRow[];
      expect(await page.evaluate('window.__viewer.errors') as string[]).toEqual([]);
      expect(archive).toHaveLength(ARCHIVE_ROWS);
      expectContiguousFrom(archive, 0);
      const statuses = await page.evaluate('window.__viewer.statuses') as string[];
      expect(statuses.every(s => /:(verified|empty)$/.test(s))).toBe(true);

      // A context forged past the writer is refused with 409, not answered.
      const refused = await page.evaluate(
        ([ctx]) => (window as never as { __viewer: { pageOnce: (d: string, a: null, l: number, c: unknown) => Promise<unknown> } })
          .__viewer.pageOnce('before', null, 50, ctx),
        [{ ...pinned, revision: pinned.revision + 99 }],
      );
      expect(refused).toBeNull();
      expect(await page.evaluate('window.__viewer.errors') as string[])
        .toEqual([expect.stringContaining('before:409:context-mismatch') as unknown as string]);

      // Re-open on the fresh revision: the union across the race has no seam
      // and no duplicate, and the rows written mid-scroll are all present.
      await page.evaluate('document.getElementById("archive").replaceChildren()');
      await page.evaluate('window.__viewer.errors.length = 0');
      await page.evaluate('window.__viewer.open()');
      const fresh = await page.evaluate('window.__viewer.ctx') as HistoryContext;
      expect(fresh.revision).toBeGreaterThan(pinned.revision);
      expect(fresh.nextLine).toBe(TOTAL + 150);
      await page.evaluate('window.__viewer.scrollToTop(250)');
      const all = (await page.evaluate('window.__viewer.read(".archive, .live")') as DomRow[]);
      expect(await page.evaluate('window.__viewer.errors') as string[]).toEqual([]);
      expect(all).toHaveLength(TOTAL + 150);
      expectContiguousFrom(all, 0);
    } finally { await page.close(); }
  }, 180_000);
});
