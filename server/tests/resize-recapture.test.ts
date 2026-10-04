import { describe, expect, test } from "bun:test";
import type { SessionListItem } from "../../core/src/protocol";
import { TmuxWsMux, type HistoryArchiveLike, type TmuxDriver } from "../src/ws-mux";

const SESSION = "sim-resize";

function sessionListItem(name: string): SessionListItem {
  return { name, created: "0", windows: 1, attached: false, activityAt: 0 };
}

class FakeWS {
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  outputFrames() {
    return this.sent.map((data) => JSON.parse(data)).filter((frame) =>
      frame.channel === SESSION && (frame.type === "output" || frame.type === "delta"));
  }
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

describe("resize recapture", () => {
  test("an accepted resize invalidates every viewer and forces a full resize reset", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
    const resizes: Array<{ cols: number; rows: number }> = [];
    let activity = 0;
    const driver: TmuxDriver = {
      listSessions: () => [sessionListItem(SESSION)],
      capturePane: async () => content,
      captureWithCursor: async () => ({
        content,
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      }),
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, ++activity]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: (_session, cols, rows) => { resizes.push({ cols, rows }); },
      hash: (value) => value,
    };
    const mux = new TmuxWsMux({
      driver,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: false }),
      pollNormalMs: 10,
      pollReconcileMs: 10,
    });
    const full = new FakeWS();
    const tail = new FakeWS();
    try {
      mux.subscribe(SESSION, full, undefined, { delta: true });
      mux.subscribe(SESSION, tail, undefined, { tail: 4, delta: true });
      await until(() => full.outputFrames().length === 1 && tail.outputFrames().length === 1);
      const beforeFull = full.outputFrames().length;
      const beforeTail = tail.outputFrames().length;

      mux.handleMessage({ type: "resize", session: SESSION, cols: 100, rows: 31 }, full);
      await until(() => full.outputFrames().length > beforeFull && tail.outputFrames().length > beforeTail);

      expect(resizes).toEqual([{ cols: 100, rows: 31 }]);
      expect((mux as any).pendingArchiveReflows.has(SESSION)).toBe(false);
      expect(full.outputFrames().at(-1)).toMatchObject({ type: "output", reset: "resize", data: content });
      expect(tail.outputFrames().at(-1)).toMatchObject({
        type: "output",
        reset: "resize",
        data: content.split("\n").slice(-4).join("\n"),
      });
    } finally {
      mux.stop();
    }
  });

  test("passes replace through the first successful archive ingest after resize only", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
    let activity = 0;
    const driver: TmuxDriver = {
      listSessions: () => [sessionListItem(SESSION)],
      capturePane: async () => content,
      captureWithCursor: async () => ({
        content,
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      }),
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, ++activity]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: () => {},
      hash: (value) => value,
    };
    const attempts: Array<boolean | undefined> = [];
    const successful: Array<boolean | undefined> = [];
    let failNext = false;
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, value, opts) => {
        attempts.push(opts.replace);
        if (failNext) {
          failNext = false;
          throw new Error("simulated archive failure");
        }
        successful.push(opts.replace);
        return { liveContent: value };
      },
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
      renameSession: () => {},
    };
    const mux = new TmuxWsMux({
      driver,
      archive,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: true }),
      pollNormalMs: 10,
      pollReconcileMs: 10,
    });
    const ws = new FakeWS();
    try {
      mux.subscribe(SESSION, ws, undefined, { delta: true });
      await until(() => ws.outputFrames().length > 0);
      await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
      mux.stop();
      attempts.length = 0;
      successful.length = 0;

      const before = ws.outputFrames().length;
      failNext = true;
      mux.handleMessage({ type: "resize", session: SESSION, cols: 100, rows: 31 }, ws);
      await until(() => attempts.length === 1 && !(mux as any).queuedCapturesInFlight.has(SESSION));

      const viewers = (mux as any).subscribers.get(SESSION);
      await (mux as any).captureAndBroadcastAsync(SESSION, viewers);
      await (mux as any).captureAndBroadcastAsync(SESSION, viewers);

      expect(attempts).toEqual([true, true, undefined]);
      expect(successful).toEqual([true, undefined]);
      expect(ws.outputFrames().length).toBeGreaterThan(before);
      expect(ws.outputFrames().at(-1)).toMatchObject({ type: "output", reset: "resize" });
    } finally {
      mux.stop();
    }
  });

  test("in-flight captures cannot consume newer resize generations", async () => {
    type Capture = {
      content: string;
      cursor: { x: number; y: number; paneHeight: number; visible: boolean };
      trailingBlanks: number;
    };
    function deferredCapture() {
      let resolve!: (capture: Capture) => void;
      const promise = new Promise<Capture>((done) => { resolve = done; });
      return { promise, resolve };
    }

    const oldCapture = deferredCapture();
    const firstResizeCapture = deferredCapture();
    const secondResizeCapture = deferredCapture();
    const deferred = [oldCapture, firstResizeCapture, secondResizeCapture];
    let captureCount = 0;
    const resizes: Array<{ cols: number; rows: number }> = [];
    const driver: TmuxDriver = {
      listSessions: () => [sessionListItem(SESSION)],
      capturePane: async () => "",
      captureWithCursor: async () => {
        const next = deferred[captureCount++];
        if (next) return next.promise;
        return {
          content: "layout-2",
          cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
          trailingBlanks: 0,
        };
      },
      sendKeys: () => {},
      getSessionActivity: () => new Map([[SESSION, 1]]),
      getHistoryLimit: () => 2000,
      setSessionHistoryLimit: () => {},
      resizeWindow: (_session, cols, rows) => { resizes.push({ cols, rows }); },
      hash: (value) => value,
    };
    const ingests: Array<{
      content: string;
      fullHistory: boolean;
      replace: boolean | undefined;
    }> = [];
    const archive: HistoryArchiveLike = {
      ingestSnapshot: (_session, content, opts) => {
        ingests.push({ content, fullHistory: opts.fullHistory, replace: opts.replace });
        return { liveContent: content };
      },
      readBefore: () => ({ lines: [], startLine: null, hasMore: false }),
      renameSession: () => {},
    };
    const mux = new TmuxWsMux({
      driver,
      archive,
      profile: () => ({ resize: true, currentPaneOnly: false, archive: true }),
      pollNormalMs: 60_000,
      pollReconcileMs: 60_000,
    });
    const ws = new FakeWS();
    const late = new FakeWS();
    const viewers = new Set([ws]);
    (mux as any).subscribers.set(SESSION, viewers);
    (mux as any).setDeltaSubscription(SESSION, ws, true);
    (mux as any).contents.set(SESSION, "cached-old-layout");
    (mux as any).hashes.set(SESSION, "cached-old-layout");

    try {
      // This models the initial archive-seeding capture. Its one-shot full
      // history intent must survive both resize generations and land on C.
      const captureA = (mux as any).captureAndBroadcastAsync(SESSION, viewers, { fullHistory: true });
      await until(() => captureCount === 1);

      mux.applyGeometry(SESSION, 100, 31, ws);
      await until(() => captureCount === 2);
      mux.applyGeometry(SESSION, 80, 31, ws);

      oldCapture.resolve({
        content: "old-layout",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await captureA;
      expect(ingests).toEqual([]);
      expect(ws.outputFrames()).toEqual([]);
      expect((mux as any).queuedCapturesFullHistory.has(SESSION)).toBe(true);
      expect((mux as any).outputBases.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(ws)).toBe("resize");

      // A viewer arriving while B is stale must not receive cached-old-layout
      // or establish a delta base from it. Its first frame must wait for C.
      mux.subscribe(SESSION, late, undefined, { delta: true });
      expect(late.outputFrames()).toEqual([]);
      expect((mux as any).outputBases.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(late)).toBe("resize");

      firstResizeCapture.resolve({
        content: "layout-1",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await until(() => captureCount === 3);
      expect(ingests).toEqual([]);
      expect(ws.outputFrames()).toEqual([]);
      expect(late.outputFrames()).toEqual([]);
      expect((mux as any).outputBases.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).outputBases.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(ws)).toBe("resize");
      expect((mux as any).pendingOutputResets.get(SESSION)?.get(late)).toBe("resize");

      secondResizeCapture.resolve({
        content: "layout-2",
        cursor: { x: 0, y: 0, paneHeight: 1, visible: true },
        trailingBlanks: 0,
      });
      await until(() => !(mux as any).queuedCapturesInFlight.has(SESSION));
      await (mux as any).captureAndBroadcastAsync(SESSION, viewers);

      expect(resizes).toEqual([{ cols: 100, rows: 31 }, { cols: 80, rows: 31 }]);
      expect(ingests).toEqual([
        { content: "layout-2", fullHistory: true, replace: true },
        { content: "layout-2", fullHistory: false, replace: undefined },
      ]);
      expect(ws.outputFrames()).toHaveLength(1);
      expect(ws.outputFrames()[0]).toMatchObject({
        type: "output",
        data: "layout-2",
        reset: "resize",
      });
      expect(late.outputFrames()).toHaveLength(1);
      expect(late.outputFrames()[0]).toMatchObject({
        type: "output",
        data: "layout-2",
        reset: "resize",
      });
      expect((mux as any).outputBases.get(SESSION)?.get(ws)).toEqual(["layout-2"]);
      expect((mux as any).outputBases.get(SESSION)?.get(late)).toEqual(["layout-2"]);
      expect((mux as any).pendingOutputResets.get(SESSION)?.has(ws) ?? false).toBe(false);
      expect((mux as any).pendingOutputResets.get(SESSION)?.has(late) ?? false).toBe(false);
      expect((mux as any).pendingArchiveReflows.has(SESSION)).toBe(false);
    } finally {
      mux.stop();
    }
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// T11 (NEWARCH flag-on lot 11-T) — ST-01/ST-02 independent stitch oracle.
// Brute-force alignment enumeration over canonical row keys (hash, then full
// canonical bytes) plus a judge for a product StitchResult. It never calls C's
// stitch/matcher; candidate counts and verdict classes below are hand-derived
// literals. C's product stitch is not on this base: product verdicts are judged
// only against hand-written results here (good and adversarial) until I wires C.
// ---------------------------------------------------------------------------
// T11-STITCH-BEGIN
type T11Cell = { readonly text: string; readonly width: 0 | 1 | 2; readonly style: readonly number[] };
type T11SRow = {
  readonly id: string; readonly cells: readonly T11Cell[]; readonly columns: number;
  readonly wrap: 'wrapped' | 'unwrapped' | 'unknown'; readonly buffer: 'normal' | 'alternate';
};
type T11Hasher = (canonical: string) => string;

function t11Canonical(r: T11SRow): string {
  // Codepoints are kept verbatim: no trim, no NFC/NFD, no ANSI stripping, no timestamps.
  return JSON.stringify([r.columns, r.wrap, r.buffer, r.cells.map(c => [[...c.text].map(ch => ch.codePointAt(0)), c.width, c.style])]);
}

/** Every alignment where T's last row lands on C[p]; k = run length backwards.
 * Equality is hash first, then the full canonical string (collision-safe). */
function t11Alignments(T: readonly T11SRow[], C: readonly T11SRow[], hash: T11Hasher) {
  const tk = T.map(t11Canonical), ck = C.map(t11Canonical);
  const th = tk.map(hash), ch = ck.map(hash);
  const eq = (i: number, j: number) => th[i] === ch[j] && tk[i] === ck[j] && T[i]!.wrap !== 'unknown';
  const out: { end: number; k: number }[] = [];
  if (!T.length) return out;
  for (let p = 0; p < C.length; p++) {
    let k = 0;
    while (k < T.length && p - k >= 0 && eq(T.length - 1 - k, p - k)) k++;
    if (k > 0) out.push({ end: p, k });
  }
  return out;
}

type T11Class = 'must-not-match' | 'proof-required';
/** DESIGN §4.2: ≥8 rows, ≥4 distinct keys, ≥2 nonblank, one location in both
 * windows. Content alone never authorises 'matched' (§4.2.4), so the best a
 * content-only seam can earn is 'proof-required'. */
function t11ClassifySeam(T: readonly T11SRow[], C: readonly T11SRow[], hash: T11Hasher): { cls: T11Class; candidates: number; reason: string } {
  if (T.some(r => r.columns !== C[0]?.columns)) return { cls: 'must-not-match', candidates: 0, reason: 'geometry' };
  const long = t11Alignments(T, C, hash).filter(a => a.k >= 8);
  if (!long.length) return { cls: 'must-not-match', candidates: 0, reason: 'short-anchor' };
  const block = T.slice(T.length - 8).map(t11Canonical);
  const nonblank = T.slice(T.length - 8).filter(r => r.cells.some(c => c.text.trim() !== '')).length;
  if (nonblank < 2) return { cls: 'must-not-match', candidates: long.length, reason: 'blank' };
  if (long.length > 1) return { cls: 'must-not-match', candidates: long.length, reason: 'multiple-alignments' };
  if (new Set(block).size < 4) return { cls: 'must-not-match', candidates: long.length, reason: 'low-distinct' };
  const tKeys = T.map(t11Canonical);
  const occursInT = tKeys.filter((_, i) => i + 8 <= tKeys.length && tKeys.slice(i, i + 8).join('\n') === block.join('\n')).length;
  if (occursInT !== 1) return { cls: 'must-not-match', candidates: long.length, reason: 'block-repeats-in-T' };
  return { cls: 'proof-required', candidates: 1, reason: 'content-only' };
}

type T11Proof = 'none' | 'recorded-mapping' | 'independent-boundary';
type T11Result =
  | { status: 'matched'; proof: T11Proof; accepted: readonly string[]; gaps: readonly { countKind: string; missingCount: number | null }[] }
  | { status: 'ambiguous' | 'unproven'; candidateCount?: number; accepted: readonly string[]; withheld: number; gaps: readonly { countKind: string; missingCount: number | null }[] };

/** Judge a product result against the oracle class and the event identities. */
function t11JudgeStitch(cls: T11Class, durableIds: readonly string[], result: T11Result): string[] {
  const v = new Set<string>();
  if (result.status === 'matched') {
    if (result.proof === 'none') v.add('content-only-matched');
    if (cls === 'must-not-match') v.add('guessed-match');
  } else {
    if (!result.gaps.length) v.add('unproven-without-gap');
    if (result.status === 'ambiguous' && result.candidateCount !== undefined && result.candidateCount < 2) v.add('ambiguous-with-one-candidate');
  }
  for (const g of result.gaps) if (g.countKind === 'unknown' && g.missingCount !== null) v.add('unknown-as-number');
  const seen = new Set(durableIds);
  for (const id of result.accepted) { if (seen.has(id)) v.add('duplicate-publish'); seen.add(id); }
  return [...v].sort();
}

/** Raw decode check: split anywhere, the stream decode must equal the whole. */
function t11DecodeChunks(raw: Uint8Array, cuts: readonly number[]): string {
  const d = new TextDecoder('utf-8', { fatal: false }); let out = '', at = 0;
  for (const c of [...cuts, raw.length]) { out += d.decode(raw.subarray(at, c), { stream: c !== raw.length }); at = c; }
  return out;
}

/** VT-state oracle over raw P bytes: rows after a restore of an unknown saved
 * cursor, or inside the alternate screen, cannot be exact normal history. */
function t11JudgeUnknownState(raw: string, published: readonly { offset: number; uncertain: readonly string[]; buffer: 'normal' | 'alternate'; history: boolean }[]): string[] {
  const v = new Set<string>();
  const save = raw.search(/\x1b7|\x1b\[s/), restore = raw.search(/\x1b8|\x1b\[u/);
  const unknownFrom = restore >= 0 && (save < 0 || save > restore) ? restore : -1;
  const altOn = raw.indexOf('\x1b[?1049h'), altOff = raw.indexOf('\x1b[?1049l', Math.max(altOn, 0));
  for (const row of published) {
    if (unknownFrom >= 0 && row.offset > unknownFrom && !row.uncertain.length) v.add('unknown-state-published');
    if (row.history && altOn >= 0 && row.offset > altOn && (altOff < 0 || row.offset < altOff)) v.add('alt-in-history');
  }
  return [...v].sort();
}

const t11Sha256: T11Hasher = s => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const t11C = (text: string, style: number[] = []): T11Cell => ({ text, width: 1, style });
let t11Seq = 0;
const t11R = (text: string, opts: Partial<T11SRow> = {}): T11SRow =>
  ({ id: `r${t11Seq++}`, cells: [...text].map(ch => t11C(ch)), columns: 80, wrap: 'unwrapped', buffer: 'normal', ...opts });
const t11Rows = (texts: readonly string[]) => texts.map(t => t11R(t));

/** Seam fixtures: literal classes and candidate counts derived by hand. */
function t11SeamFixtures() {
  const letters = 'abcdefgh'.split('');
  const screen = Array.from({ length: 24 }, (_, i) => `status ${i % 6} load ${(i * 7) % 5}`);
  const spinner = ['|', '/', '-', '\\'];
  return [
    { name: '7 rows (below the 8-row floor)', T: t11Rows(letters.slice(0, 7)), C: t11Rows(letters.slice(0, 7)), cls: 'must-not-match' as T11Class, candidates: 0 },
    { name: '8 unique rows reprinted after clear (unique text is not identity)', T: t11Rows(letters), C: t11Rows(letters), cls: 'proof-required' as T11Class, candidates: 1 },
    { name: 'ABAB periodic', T: t11Rows(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']), C: t11Rows(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']), cls: 'must-not-match' as T11Class, candidates: 2 },
    { name: 'blank screen', T: t11Rows(Array(8).fill('')), C: t11Rows(Array(24).fill('')), cls: 'must-not-match' as T11Class, candidates: 17 },
    { name: 'spinner overwritten by CR', T: t11Rows([...spinner, ...spinner]), C: t11Rows([...spinner, ...spinner, ...spinner]), cls: 'must-not-match' as T11Class, candidates: 2 },
    { name: 'same status screen printed three times', T: t11Rows(screen), C: t11Rows([...screen, ...screen, ...screen]), cls: 'must-not-match' as T11Class, candidates: 3 },
    { name: 'two alignments of different length (longest is not chosen)', T: t11Rows(['x', ...letters]), C: t11Rows([...letters, 'y', 'x', ...letters]), cls: 'must-not-match' as T11Class, candidates: 2 },
    { name: 'geometry changed without mapping', T: t11Rows(letters).map(r => ({ ...r, columns: 100 })), C: t11Rows(letters), cls: 'must-not-match' as T11Class, candidates: 0 },
    { name: 'wrap unknown cannot confirm a seam', T: t11Rows(letters).map(r => ({ ...r, wrap: 'unknown' as const })), C: t11Rows(letters).map(r => ({ ...r, wrap: 'unknown' as const })), cls: 'must-not-match' as T11Class, candidates: 0 },
    { name: 'unique tail of a long history', T: t11Rows(['p', 'q', ...letters]), C: t11Rows([...letters, 'i', 'j']), cls: 'proof-required' as T11Class, candidates: 1 },
  ];
}

/** Rows whose text looks equal after lossy normalisation must keep distinct keys. */
function t11KeyPairs(): [string, T11SRow, T11SRow][] {
  return [
    ['trailing space', t11R('ok'), t11R('ok ')],
    ['SGR red vs default', t11R('ok'), { ...t11R('ok'), cells: [t11C('o', [31]), t11C('k', [31])] }],
    ['combining e+U+0301 vs precomposed \u00e9 (one cell each)', { ...t11R('x'), cells: [t11C('e\u0301')] }, { ...t11R('x'), cells: [t11C('\u00e9')] }],
    ['space cell vs empty cell', { ...t11R('x'), cells: [t11C('o'), t11C(' ')] }, { ...t11R('x'), cells: [t11C('o'), t11C('')] }],
    ['CJK wide vs two narrow', { ...t11R('界'), cells: [{ text: '界', width: 2, style: [] }] }, { ...t11R('界'), cells: [{ text: '界', width: 1, style: [] }, { text: '', width: 0, style: [] }] }],
    ['soft-wrapped vs hard line', t11R('ok', { wrap: 'wrapped' }), t11R('ok')],
    ['alternate vs normal buffer', t11R('ok', { buffer: 'alternate' }), t11R('ok')],
    ['Thai with tone mark vs without', t11R('ก่'), t11R('ก')],
  ];
}

function t11JudgeFixtures(): [string, T11Class, T11Result, string[]][] {
  const unk = { countKind: 'unknown', missingCount: null };
  return [
    ['content-only match after reprint', 'proof-required', { status: 'matched', proof: 'none', accepted: ['c8'], gaps: [] }, ['content-only-matched']],
    ['proof-backed match', 'proof-required', { status: 'matched', proof: 'recorded-mapping', accepted: ['c8'], gaps: [] }, []],
    ['first-match on a periodic block', 'must-not-match', { status: 'matched', proof: 'none', accepted: ['c9'], gaps: [] }, ['content-only-matched', 'guessed-match']],
    ['proof-backed match on a block the oracle finds ambiguous', 'must-not-match', { status: 'matched', proof: 'independent-boundary', accepted: ['c9'], gaps: [] }, ['guessed-match']],
    ['ambiguous with a gap', 'must-not-match', { status: 'ambiguous', candidateCount: 2, accepted: [], withheld: 8, gaps: [unk] }, []],
    ['ambiguous with no gap (silent)', 'must-not-match', { status: 'ambiguous', candidateCount: 2, accepted: [], withheld: 8, gaps: [] }, ['unproven-without-gap']],
    ['unknown count written as 0', 'must-not-match', { status: 'unproven', accepted: [], withheld: 8, gaps: [{ countKind: 'unknown', missingCount: 0 }] }, ['unknown-as-number']],
    ['capture row re-published over durable tail', 'proof-required', { status: 'matched', proof: 'independent-boundary', accepted: ['t7', 'c8'], gaps: [] }, ['duplicate-publish']],
    ['boundary overlap 0 but scrolled screen row appended twice', 'proof-required', { status: 'matched', proof: 'independent-boundary', accepted: ['c20', 'c20'], gaps: [] }, ['duplicate-publish']],
  ];
}

function t11StitchSelfTest(): string[] {
  const names: string[] = [];
  for (const f of t11SeamFixtures()) {
    const got = t11ClassifySeam(f.T, f.C, t11Sha256);
    if (got.cls !== f.cls || got.candidates !== f.candidates) throw new Error(`T11 seam "${f.name}": expected ${f.cls}/${f.candidates} got ${got.cls}/${got.candidates} (${got.reason})`);
    // A colliding hash must not create candidates: equality re-checks canonical bytes.
    const collided = t11ClassifySeam(f.T, f.C, () => 'collide');
    if (collided.cls !== f.cls || collided.candidates !== f.candidates) throw new Error(`T11 seam "${f.name}" under hash collision: ${collided.cls}/${collided.candidates}`);
    names.push(f.name);
  }
  for (const [name, cls, result, want] of t11JudgeFixtures()) {
    const got = t11JudgeStitch(cls, ['t5', 't6', 't7'], result).join(',');
    if (got !== want.join(',')) throw new Error(`T11 judge "${name}": expected [${want}] got [${got}]`);
    names.push(name);
  }
  for (const [name, a, b] of t11KeyPairs()) {
    if (t11Canonical(a) === t11Canonical(b)) throw new Error(`T11 key pair "${name}" collapsed`);
    names.push(name);
  }
  return names;
}
// T11-STITCH-END

describe('T11 ST-01/ST-02 independent stitch oracle (no product stitch on this base)', () => {
  test('T11 oracle seams: candidates enumerated by brute force, never first/longest; content-only is never sufficient', () => {
    expect(t11StitchSelfTest().length).toBe(10 + 9 + 8);
  });

  test('T11 ST-02 judge: hand-written product results get their literal verdicts', () => {
    expect(t11JudgeFixtures().map(([name, cls, result]) => [name, t11JudgeStitch(cls, ['t5', 't6', 't7'], result)]))
      .toEqual(t11JudgeFixtures().map(([name, , , want]) => [name, want]));
  });

  test('T11 ST-02 split attach: events captured AND piped are one event each; normal repeated rows keep their real count', () => {
    // From the raw split-command evidence: E301..E340 are in both C and P.
    const C = Array.from({ length: 40 }, (_, i) => `E${301 + i}`);
    const P = [...C, 'E341', 'E342'];
    const naive = [...C, ...P];
    expect(naive.length - new Set(naive).size).toBe(40);
    // Three identical "ok" rows from three raw offsets are three events, not one.
    const pipeRows = [{ text: 'ok', offset: 10 }, { text: 'ok', offset: 13 }, { text: 'ok', offset: 16 }];
    const byOrigin = new Set(pipeRows.map(r => r.offset));
    const byText = new Set(pipeRows.map(r => r.text));
    expect([byOrigin.size, byText.size]).toEqual([3, 1]);
  });

  test('T11 ST-02 partial UTF-8 / CSI split at every byte: stream decode equals whole; naive per-chunk decode is caught', () => {
    const raw = new TextEncoder().encode('\x1b[31mกข界 é\x1b[0m\r\n');
    const whole = new TextDecoder().decode(raw);
    for (let cut = 1; cut < raw.length; cut++) expect(t11DecodeChunks(raw, [cut])).toBe(whole);
    const naive = (cut: number) => new TextDecoder().decode(raw.subarray(0, cut)) + new TextDecoder().decode(raw.subarray(cut));
    const broken = Array.from({ length: raw.length - 1 }, (_, i) => i + 1).filter(cut => naive(cut).includes('�'));
    // Literal: every cut strictly inside a multi-byte sequence (ก ข 界 U+0301) breaks naive decode.
    expect(broken).toEqual([6, 7, 9, 10, 12, 13, 17]);
  });

  test('T11 ST-02 hidden VT state: restore of an unknown saved cursor and alternate-screen rows cannot be exact history', () => {
    const raw = 'row-a\r\n\x1b8row-b\r\n\x1b[?1049hfull-screen\x1b[?1049lrow-c\r\n';
    const restoreAt = raw.indexOf('\x1b8'), altAt = raw.indexOf('full-screen');
    expect(t11JudgeUnknownState(raw, [{ offset: 0, uncertain: [], buffer: 'normal', history: true }])).toEqual([]);
    expect(t11JudgeUnknownState(raw, [{ offset: restoreAt + 2, uncertain: [], buffer: 'normal', history: true }])).toEqual(['unknown-state-published']);
    expect(t11JudgeUnknownState(raw, [{ offset: restoreAt + 2, uncertain: ['savedCursor'], buffer: 'normal', history: true }])).toEqual([]);
    expect(t11JudgeUnknownState(raw, [{ offset: altAt, uncertain: ['savedCursor'], buffer: 'alternate', history: true }])).toEqual(['alt-in-history']);
    // With a save before the restore, the cursor is known again.
    expect(t11JudgeUnknownState('\x1b7a\r\n\x1b8b\r\n', [{ offset: 6, uncertain: [], buffer: 'normal', history: true }])).toEqual([]);
  });

  const mutants: Record<string, [string, string]> = {
    'first match wins': ["const long = t11Alignments(T, C, hash).filter(a => a.k >= 8);", "const long = t11Alignments(T, C, hash).filter(a => a.k >= 8).slice(0, 1);"],
    'anchor floor 8 -> 1': ["const long = t11Alignments(T, C, hash).filter(a => a.k >= 8);", "const long = t11Alignments(T, C, hash).filter(a => a.k >= 1);"],
    'hash-only equality': ["const eq = (i: number, j: number) => th[i] === ch[j] && tk[i] === ck[j] && T[i]!.wrap !== 'unknown';", "const eq = (i: number, j: number) => th[i] === ch[j] && T[i]!.wrap !== 'unknown';"],
    'trimmed text key': ["[...c.text].map(ch => ch.codePointAt(0))", "[...c.text.trim().normalize('NFC')].map(ch => ch.codePointAt(0))"],
    'unique text accepted as proof': ["if (result.proof === 'none') v.add('content-only-matched');", ''],
    'guessed match on an ambiguous block allowed': ["if (cls === 'must-not-match') v.add('guessed-match');", ''],
    'wrap unknown confirms seams': ["&& T[i]!.wrap !== 'unknown';", ";"],
  };
  for (const [mutation, [from, to]] of Object.entries(mutants)) {
    test(`T11 MUTATION stitch oracle "${mutation}" turns the self-test red in an isolated copy`, () => {
      const self = readFileSync(import.meta.path, 'utf8');
      const region = self.slice(self.indexOf('// T11-STITCH-BEGIN'), self.indexOf('// T11-STITCH-END'));
      expect(region.length).toBeGreaterThan(100);
      expect(region.split(from).length).toBe(2);
      const dir = mkdtempSync(join(tmpdir(), 't11-stitch-mutant-'));
      try {
        for (const damaged of [false, true]) {
          const script = join(dir, `scenario-${damaged}.ts`);
          writeFileSync(script, `${damaged ? region.replace(from, to) : region}\nt11StitchSelfTest();\n`);
          const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
          console.log(`T11 MUTATION stitch ${mutation} damaged=${damaged} exit=${r.status} ${(r.stderr ?? '').split('\n').find(l => l.startsWith('error:')) ?? ''}`);
          expect(r.status).toBe(damaged ? 1 : 0);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

// T-V2 V2-03 planned shrink through the real flag-on host (FlagOnPipeHost +
// history keeper) moved to tests/integrations/history-keeper.test.ts: the public
// thumbmux split does not ship src/integrations.

// ---------------------------------------------------------------------------
// PLAN-v2 §3 V2-02/V2-03 runtime proof on a private tmux server (explicit -S,
// never the default server). No product code: this pins what tmux 3.x itself
// guarantees for the fixed 100×40 window, and what it does NOT (manual is not
// an ACL; before/after polling misses 100→120→100 and short-lived splits).
// ---------------------------------------------------------------------------
function tv2PrivateTmux() {
  const dir = mkdtempSync(join(tmpdir(), "tv2-fixed-"));
  const socket = join(dir, "s");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX" && k !== "TMUX_PANE") env[k] = v;
  const t = (...args: string[]) => { const r = spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env });
    if (r.status) throw new Error(`T-V2 tmux ${args[0]}: ${r.stderr}`); return r.stdout.trim(); };
  t("new-session", "-d", "-s", "v2", "-x", "100", "-y", "40", "sleep 1000");
  const window = t("display-message", "-p", "-t", "v2", "#{window_id}");
  const pane = t("display-message", "-p", "-t", "v2", "#{pane_id}");
  t("set-option", "-w", "-t", window, "window-size", "manual");
  t("resize-window", "-t", window, "-x", "100", "-y", "40");
  const clients: { proc: ReturnType<typeof Bun.spawn>; out: { text: string } }[] = [];
  return {
    t, window, pane,
    geometry: () => t("display-message", "-p", "-t", pane, "#{window_width}x#{window_height} #{pane_width}x#{pane_height}"),
    /** Control-mode client: its size request and the %layout-change notifications it receives. */
    control(size: string) {
      const proc = Bun.spawn(["tmux", "-S", socket, "-f", "/dev/null", "-C", "attach", "-t", "v2"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      const out = { text: "" };
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; out.text += Buffer.from(value).toString(); } })();
      const send = (line: string) => { (proc.stdin as import("bun").FileSink).write(`${line}\n`); (proc.stdin as import("bun").FileSink).flush(); };
      send(`refresh-client -C ${size}`);
      clients.push({ proc, out });
      return { send, layouts: () => (out.text.match(/^%layout-change /gm) ?? []).length, out };
    },
    async cleanup() {
      for (const c of clients) c.proc.kill();
      spawnSync("tmux", ["-S", socket, "kill-server"], { env });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const tv2Settle = () => new Promise((r) => setTimeout(r, 300));

describe("T-V2 V2-02/V2-03 fixed 100×40 window on a private tmux server", () => {
  test("T-V2 V2-02 window-size manual keeps 100×40 against a 50×20 and a 200×60 client and after both detach; window-size latest is the negative control", async () => {
    const x = tv2PrivateTmux();
    try {
      expect(x.geometry()).toBe("100x40 100x40");
      const narrow = x.control("50,20"), wide = x.control("200,60");
      await tv2Settle();
      expect(x.t("list-clients", "-F", "#{client_control_mode}").split("\n")).toEqual(["1", "1"]);
      expect(x.geometry()).toBe("100x40 100x40");
      // negative control: the same clients do resize a window that is not manual
      x.t("set-option", "-w", "-t", x.window, "window-size", "latest");
      narrow.send("refresh-client -C 60,25"); await tv2Settle();
      const latest = x.geometry();
      console.log(`T-V2 V2-02 latest with a 60×25 control client: ${latest}`);
      expect(latest).not.toBe("100x40 100x40");
      x.t("set-option", "-w", "-t", x.window, "window-size", "manual");
      x.t("resize-window", "-t", x.window, "-x", "100", "-y", "40");
      narrow.send("refresh-client -C 30,10"); wide.send("refresh-client -C 240,80"); await tv2Settle();
      expect(x.geometry()).toBe("100x40 100x40");
      narrow.send("detach"); wide.send("detach"); await tv2Settle();
      expect(x.geometry()).toBe("100x40 100x40");
    } finally { await x.cleanup(); }
  }, 30_000);

  test("T-V2 V2-03 manual is not an ACL: direct resize-window and a short-lived split still change the window; 100→120→100 between two polls is invisible to polling but each change is a %layout-change", async () => {
    const x = tv2PrivateTmux();
    try {
      const watcher = x.control("100,40"); await tv2Settle();
      const before = x.geometry(), layouts0 = watcher.layouts();
      x.t("resize-window", "-t", x.window, "-x", "120", "-y", "40");
      expect(x.geometry()).toBe("120x40 120x40");
      x.t("resize-window", "-t", x.window, "-x", "100", "-y", "40");
      const after = x.geometry(); await tv2Settle();
      const layouts1 = watcher.layouts();
      console.log(`T-V2 V2-03 poll ${before} -> ${after}; %layout-change +${layouts1 - layouts0}`);
      expect(after).toBe(before);
      expect(layouts1 - layouts0).toBeGreaterThanOrEqual(2);
      x.t("split-window", "-d", "-t", x.pane, "true"); await tv2Settle();
      const panes = x.t("list-panes", "-t", x.window, "-F", "#{pane_id}").split("\n");
      const split = watcher.out.text.split("\n").filter((l) => l.startsWith("%layout-change") && l.includes("["));
      console.log(`T-V2 V2-03 short split: list-panes=${panes.join(",")} layout=${split.at(-1)}`);
      expect(panes).toEqual([x.pane]);
      expect(split.length).toBeGreaterThanOrEqual(1);
      expect(x.geometry()).toBe("100x40 100x40");
    } finally { await x.cleanup(); }
  }, 30_000);

  test("T-V2 V2-03 CSI 100G at width 100 writes the last column without wrapping", async () => {
    const x = tv2PrivateTmux();
    try {
      x.t("respawn-pane", "-k", "-t", x.pane, "printf 'A\\033[100GZ\\nnext\\n'; sleep 1000"); await tv2Settle();
      const rows = x.t("capture-pane", "-p", "-t", x.pane).split("\n");
      expect(rows[0]).toBe(`A${" ".repeat(98)}Z`);
      expect(rows[1]).toBe("next");
      expect(x.geometry()).toBe("100x40 100x40");
    } finally { await x.cleanup(); }
  }, 30_000);
});
