/**
 * Contract tests for the delta fast-path in ws-mux:
 *   - incremental prefix-hash (byte-identical to core muxPrefixHash)
 *   - single-pass validate+apply
 *   - opt-in deferWhileBusy coalescing
 *
 * Observable behaviour of the non-defer path must match the pre-fastpath
 * client; these tests pin that contract so a future rewrite cannot drift.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyMuxDelta,
  createMuxDeltaFrame,
  muxPrefixHash,
  splitMuxOutputData,
  validateMuxDeltaFrame,
  type MuxDeltaFrame,
} from '@thumbmux/core';

const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state');
Object.defineProperty(globalThis, '$state', {
  configurable: true,
  value: <T>(value: T) => value,
});

const { TmuxMux } = await import('../src/ws-mux.svelte');

type Listener = (event?: any) => void;

class FakeEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.OPEN || this.readyState === FakeWebSocket.CONNECTING) {
      this.readyState = FakeWebSocket.CLOSING;
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ type: 'open' });
  }

  finishClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ type: 'close' });
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(type?: string) {
    const frames = this.sent.map((data) => JSON.parse(data));
    return type ? frames.filter((frame) => frame.type === type) : frames;
  }
}

type Delivery = {
  data: string;
  type: string | undefined;
  cursor: unknown;
  meta: unknown;
};

const globalNames = ['window', 'document', 'navigator', 'WebSocket'] as const;
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

let fakeDocument: FakeEventTarget & { visibilityState: string };
let scheduled: Array<() => void> = [];
let nowMs = 1_000_000;
const realDateNow = Date.now;

function setGlobal(name: typeof globalNames[number], value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function tickScheduler(times = 1) {
  for (let i = 0; i < times; i++) {
    const batch = scheduled.splice(0, scheduled.length);
    for (const cb of batch) cb();
  }
}

function openMux(session = 'terminal', opts: {
  deferWhileBusy?: () => boolean;
  scheduleFrame?: (cb: () => void) => void;
} = {}) {
  const mux = new TmuxMux();
  if (opts.scheduleFrame) {
    mux.configure({ scheduleFrame: opts.scheduleFrame });
  } else {
    mux.configure({
      scheduleFrame: (cb) => { scheduled.push(cb); },
    });
  }
  const deliveries: Delivery[] = [];
  const unsubscribe = mux.subscribe(
    session,
    (data, type, cursor, meta) => {
      deliveries.push({ data, type, cursor, meta });
    },
    opts.deferWhileBusy ? { deferWhileBusy: opts.deferWhileBusy } : {},
  );
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { mux, socket, deliveries, unsubscribe };
}

function full(channel: string, data: string, extra: Record<string, unknown> = {}) {
  return { channel, type: 'output', data, ...extra };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  scheduled = [];
  nowMs = 1_000_000;
  Date.now = () => nowMs;
  fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' });
  const fakeWindow = Object.assign(new FakeEventTarget(), {
    location: {
      protocol: 'https:',
      host: 'thumbmux.test',
      href: 'https://thumbmux.test/terminal',
      pathname: '/terminal',
    },
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    screen: { width: 390, height: 844 },
    visualViewport: undefined,
  });

  setGlobal('document', fakeDocument);
  setGlobal('window', fakeWindow);
  setGlobal('navigator', { userAgent: 'test', language: 'en', platform: 'test' });
  setGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  Date.now = realDateNow;
  for (const name of globalNames) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

afterAll(() => {
  if (originalState) Object.defineProperty(globalThis, '$state', originalState);
  else delete (globalThis as Record<string, unknown>).$state;
});

// ─── 1. Hash equivalence on an adversarial corpus ───────────────────────────

describe('delta fastpath: hash equivalence', () => {
  test('incremental hash accepts createMuxDeltaFrame for every adversarial prefix', () => {
    const corpus = [
      '',
      'a',
      '"quoted"',
      'back\\slash',
      'tab\there',
      '\x00\x01\x1f ctl',
      'ภาษาไทย',
      '😀🚀',
      '\ud800',
      '\udfff',
      'a'.repeat(5000),
      '  ',
      '\x1b[31mred\x1b[0m',
      '½€漢字',
    ];

    // Empty base, single-line bases, and the full multi-line corpus.
    const bases: string[][] = [
      [],
      ...corpus.map((line) => [line]),
      corpus,
      // Mix: empty + control + thai + long
      ['', corpus[0]!, corpus[6]!, corpus[10]!],
    ];

    for (const baseLines of bases) {
      const { socket, deliveries, unsubscribe } = openMux();
      const baseData = baseLines.join('\n');
      socket.receive(full('terminal', baseData));
      expect(deliveries.at(-1)?.data).toBe(baseData);

      for (let prefix = 0; prefix <= baseLines.length; prefix++) {
        const currentBase = splitMuxOutputData(deliveries.at(-1)!.data);
        // Build a next base that shares exactly `prefix` lines then diverges.
        const next = [
          ...currentBase.slice(0, prefix),
          `changed-at-${prefix}`,
          'tail',
        ];
        const delta = createMuxDeltaFrame('terminal', currentBase, next, {
          row: prefix,
          col: 0,
        });
        // Sanity: core agrees the frame is well-formed.
        expect(delta.prefixHash).toBe(muxPrefixHash(currentBase.slice(0, delta.prefix)));

        const beforeResync = socket.frames('resync').length;
        const beforeLen = deliveries.length;
        socket.receive(delta);
        expect(socket.frames('resync')).toHaveLength(beforeResync);
        expect(deliveries).toHaveLength(beforeLen + 1);
        expect(deliveries.at(-1)).toEqual({
          data: next.join('\n'),
          type: 'output',
          cursor: { row: prefix, col: 0 },
          meta: { source: 'delta', replace: false },
        });
      }

      unsubscribe();
      socket.finishClose();
    }
  });
});

// ─── 2. Reject equivalence ──────────────────────────────────────────────────

describe('delta fastpath: reject equivalence', () => {
  test('malformed frames never deliver, resync once, and a full frame restores service', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const base = ['one', 'two', 'three'];
    const good = createMuxDeltaFrame('terminal', base, ['one', 'two', 'X'], {
      row: 2,
      col: 1,
    });

    // Frames that enter the delta branch and must resync exactly once.
    const malformedDeltas: unknown[] = [
      { ...good, baseLength: base.length + 1 },
      { ...good, baseLength: base.length - 1 },
      { ...good, baseLength: 2.5 },
      { ...good, prefix: -1 },
      { ...good, prefix: base.length + 1 },
      { ...good, prefix: 1e9 },
      { ...good, prefix: 1.5 },
      { ...good, prefixHash: '00000000' },
      { ...good, prefixHash: 42 },
      { ...good, lines: ['X', 4] },
      { ...good, lines: 'not-array' },
      { ...good, cursor: { row: 0.5, col: 1 } },
    ];

    for (const frame of malformedDeltas) {
      socket.receive(full('terminal', base.join('\n')));
      const beforeDeliveries = deliveries.length;
      const beforeResync = socket.frames('resync').length;

      expect(() => socket.receive(frame)).not.toThrow();
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync + 1);

      // Still resyncing: a second broken frame must not re-request.
      socket.receive(frame);
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync + 1);

      // Full frame restores normal delta service.
      socket.receive(full('terminal', base.join('\n')));
      const restored = createMuxDeltaFrame('terminal', base, ['one', 'two', 'ok']);
      const beforeOk = deliveries.length;
      socket.receive(restored);
      expect(deliveries).toHaveLength(beforeOk + 1);
      expect(deliveries.at(-1)?.data).toBe('one\ntwo\nok');
      expect(deliveries.at(-1)?.meta).toEqual({ source: 'delta', replace: false });
    }

    // Missing channel: no subscriber match → no delivery, no resync, no throw.
    {
      socket.receive(full('terminal', base.join('\n')));
      const beforeDeliveries = deliveries.length;
      const beforeResync = socket.frames('resync').length;
      const { channel: _c, ...noChannel } = good as MuxDeltaFrame & { channel: string };
      expect(() => socket.receive(noChannel)).not.toThrow();
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync);
    }

    // type !== 'delta': never enters the delta branch → no delivery, no resync.
    {
      socket.receive(full('terminal', base.join('\n')));
      const beforeDeliveries = deliveries.length;
      const beforeResync = socket.frames('resync').length;
      expect(() => socket.receive({ ...good, type: 'not-a-delta' })).not.toThrow();
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync);
    }

    unsubscribe();
    socket.finishClose();
  });
});

// ─── 3. Cache-truncation / staleness killer ─────────────────────────────────

describe('delta fastpath: cache truncation', () => {
  test('carried hash states survive tail/replace/shrink then reject out-of-range', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const initial = ['a', 'b', 'c', 'd', 'e'];
    socket.receive(full('terminal', initial.join('\n')));

    // 1) normal tail delta
    let base = initial.slice();
    let next = ['a', 'b', 'c', 'd', 'E'];
    socket.receive(createMuxDeltaFrame('terminal', base, next, { row: 4, col: 0 }));
    expect(deliveries.at(-1)?.data).toBe(next.join('\n'));

    // 2) prefix: 0 replaces everything
    base = next.slice();
    next = ['Z', 'Y'];
    socket.receive(createMuxDeltaFrame('terminal', base, next));
    expect(deliveries.at(-1)?.data).toBe('Z\nY');

    // 3) shrink the base
    base = next.slice();
    next = ['Z'];
    socket.receive(createMuxDeltaFrame('terminal', base, next));
    expect(deliveries.at(-1)?.data).toBe('Z');

    // 4) tail delta on the shrunken base
    base = next.slice();
    next = ['Z', 'append'];
    socket.receive(createMuxDeltaFrame('terminal', base, next, { row: 1, col: 2 }));
    expect(deliveries.at(-1)?.data).toBe('Z\nappend');
    expect(deliveries.at(-1)?.cursor).toEqual({ row: 1, col: 2 });

    // 5) prefix exceeds shrunken base length → reject, one resync
    const beforeResync = socket.frames('resync').length;
    const beforeLen = deliveries.length;
    socket.receive({
      channel: 'terminal',
      type: 'delta',
      baseLength: 2,
      prefix: 5,
      prefixHash: muxPrefixHash(['Z', 'append']),
      lines: ['nope'],
    });
    expect(deliveries).toHaveLength(beforeLen);
    expect(socket.frames('resync')).toHaveLength(beforeResync + 1);

    // Full + delta still works after recovery
    const recovery = ['fresh', 'base'];
    socket.receive(full('terminal', recovery.join('\n')));
    socket.receive(createMuxDeltaFrame('terminal', recovery, ['fresh', 'base', 'ok']));
    expect(deliveries.at(-1)?.data).toBe('fresh\nbase\nok');
    expect(deliveries.at(-1)?.meta).toEqual({ source: 'delta', replace: false });

    unsubscribe();
    socket.finishClose();
  });
});

// ─── 4. Two sessions interleaved ────────────────────────────────────────────

describe('delta fastpath: multi-session isolation', () => {
  test('alpha and beta deltas never cross-talk', () => {
    const mux = new TmuxMux();
    mux.configure({ scheduleFrame: (cb) => { scheduled.push(cb); } });
    const alphaD: Delivery[] = [];
    const betaD: Delivery[] = [];
    const stopA = mux.subscribe('alpha', (data, type, cursor, meta) => {
      alphaD.push({ data, type, cursor, meta });
    });
    const stopB = mux.subscribe('beta', (data, type, cursor, meta) => {
      betaD.push({ data, type, cursor, meta });
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    let aBase = ['A0', 'A1'];
    let bBase = ['B0', 'B1', 'B2'];
    socket.receive(full('alpha', aBase.join('\n')));
    socket.receive(full('beta', bBase.join('\n')));

    for (let i = 0; i < 5; i++) {
      const aNext = [...aBase.slice(0, -1), `A-chg-${i}`];
      const bNext = [...bBase.slice(0, -1), `B-chg-${i}`];
      socket.receive(createMuxDeltaFrame('alpha', aBase, aNext, { row: i, col: 0 }));
      socket.receive(createMuxDeltaFrame('beta', bBase, bNext, { row: i, col: 1 }));
      aBase = aNext;
      bBase = bNext;
    }

    expect(alphaD.filter((d) => d.meta && (d.meta as { source: string }).source === 'delta')).toHaveLength(5);
    expect(betaD.filter((d) => d.meta && (d.meta as { source: string }).source === 'delta')).toHaveLength(5);
    expect(alphaD.at(-1)?.data).toBe(aBase.join('\n'));
    expect(betaD.at(-1)?.data).toBe(bBase.join('\n'));
    expect(alphaD.every((d) => !String(d.data).startsWith('B'))).toBe(true);
    expect(betaD.every((d) => !String(d.data).startsWith('A'))).toBe(true);
    expect(socket.frames('resync')).toHaveLength(0);

    stopA();
    stopB();
    socket.finishClose();
  });
});

// ─── 5–12. Deferral ─────────────────────────────────────────────────────────

describe('delta fastpath: deferral', () => {
  test('opt-out is the default: deltas deliver synchronously inside receive', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const base = ['x', 'y'];
    socket.receive(full('terminal', base.join('\n')));
    const next = ['x', 'Y'];
    const before = deliveries.length;
    socket.receive(createMuxDeltaFrame('terminal', base, next, { row: 1, col: 0 }));
    // No scheduler tick required.
    expect(scheduled).toHaveLength(0);
    expect(deliveries).toHaveLength(before + 1);
    expect(deliveries.at(-1)?.data).toBe('x\nY');
    unsubscribe();
    socket.finishClose();
  });

  test('coalesces three busy deltas into one delivery with the last cursor', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });
    let base = ['l0', 'l1', 'l2'];
    socket.receive(full('terminal', base.join('\n')));
    const afterFull = deliveries.length;

    const frames: MuxDeltaFrame[] = [];
    for (let i = 0; i < 3; i++) {
      const next = [...base.slice(0, 2), `chg-${i}`];
      const delta = createMuxDeltaFrame('terminal', base, next, { row: i, col: i + 1 });
      frames.push(delta);
      socket.receive(delta);
      base = next;
    }
    expect(deliveries).toHaveLength(afterFull);
    expect(scheduled.length).toBeGreaterThan(0);

    busy = false;
    tickScheduler();
    expect(deliveries).toHaveLength(afterFull + 1);
    expect(deliveries.at(-1)).toEqual({
      data: base.join('\n'),
      type: 'output',
      cursor: frames[2]!.cursor,
      meta: { source: 'delta', replace: false },
    });

    unsubscribe();
    socket.finishClose();
  });

  test('coalesced cursor falls back to earlier frame or undefined', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });

    // Case A: last frame has no cursor property; earlier one does.
    let base = ['p', 'q'];
    socket.receive(full('terminal', base.join('\n')));
    const afterFull = deliveries.length;

    const withCursor = createMuxDeltaFrame('terminal', base, ['p', 'Q'], { row: 9, col: 9 });
    base = ['p', 'Q'];
    const noCursor = createMuxDeltaFrame('terminal', base, ['p', 'QQ']);
    // createMuxDeltaFrame omits cursor when undefined is passed — confirm.
    expect(Object.prototype.hasOwnProperty.call(noCursor, 'cursor')).toBe(false);

    socket.receive(withCursor);
    socket.receive(noCursor);
    busy = false;
    tickScheduler();
    expect(deliveries).toHaveLength(afterFull + 1);
    expect(deliveries.at(-1)?.cursor).toEqual({ row: 9, col: 9 });
    expect(deliveries.at(-1)?.data).toBe('p\nQQ');

    // Case B: no frame carries a cursor → delivery cursor is undefined.
    busy = true;
    base = splitMuxOutputData(deliveries.at(-1)!.data);
    const d1 = createMuxDeltaFrame('terminal', base, ['p', 'R']);
    base = ['p', 'R'];
    const d2 = createMuxDeltaFrame('terminal', base, ['p', 'S']);
    base = ['p', 'S'];
    const beforeB = deliveries.length;
    socket.receive(d1);
    socket.receive(d2);
    busy = false;
    tickScheduler();
    expect(deliveries).toHaveLength(beforeB + 1);
    expect(deliveries.at(-1)?.cursor).toBeUndefined();
    expect(deliveries.at(-1)?.data).toBe('p\nS');

    unsubscribe();
    socket.finishClose();
  });

  test('safety valve flushes at 250ms deadline and at 64-frame cap', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });
    let base = Array.from({ length: 10 }, (_, i) => `row-${i}`);
    socket.receive(full('terminal', base.join('\n')));
    const afterFull = deliveries.length;

    // ── 250 ms deadline ──
    const next1 = [...base.slice(0, -1), 't0'];
    socket.receive(createMuxDeltaFrame('terminal', base, next1));
    base = next1;
    expect(deliveries).toHaveLength(afterFull);

    nowMs += 249;
    tickScheduler();
    expect(deliveries).toHaveLength(afterFull); // still deferred

    nowMs += 1; // total 250 ms
    tickScheduler();
    expect(deliveries).toHaveLength(afterFull + 1);
    expect(deliveries.at(-1)?.data).toBe(base.join('\n'));

    // ── 64-frame cap ──
    const beforeCap = deliveries.length;
    for (let i = 0; i < 64; i++) {
      const n = [...base.slice(0, -1), `cap-${i}`];
      socket.receive(createMuxDeltaFrame('terminal', base, n));
      base = n;
    }
    // 64th frame flushes immediately on arrival — no scheduler tick needed.
    expect(deliveries).toHaveLength(beforeCap + 1);
    expect(deliveries.at(-1)?.data).toBe(base.join('\n'));
    expect(deliveries.at(-1)?.meta).toEqual({ source: 'delta', replace: false });

    unsubscribe();
    socket.finishClose();
  });

  test('ordering: full supersedes queue; cursor/history flush first', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });
    let base = ['o0', 'o1'];
    socket.receive(full('terminal', base.join('\n')));

    // (a) full frame with deltas queued → queued never delivered
    const queuedNext = ['o0', 'QUEUED'];
    socket.receive(createMuxDeltaFrame('terminal', base, queuedNext));
    expect(deliveries.filter((d) => d.data.includes('QUEUED'))).toHaveLength(0);

    const fullData = 'brand\nnew\nfull';
    socket.receive(full('terminal', fullData));
    // Still busy, but full is immediate.
    expect(deliveries.at(-1)?.data).toBe(fullData);
    expect(deliveries.at(-1)?.meta).toEqual({ source: 'full', replace: false });
    // Tick must not resurrect the discarded queue.
    busy = false;
    tickScheduler(3);
    expect(deliveries.filter((d) => d.data.includes('QUEUED'))).toHaveLength(0);

    // (b) cursor frame with deltas queued → coalesced content BEFORE cursor
    busy = true;
    base = splitMuxOutputData(fullData);
    const cNext = [...base.slice(0, -1), 'cur-chg'];
    socket.receive(createMuxDeltaFrame('terminal', base, cNext, { row: 1, col: 1 }));
    base = cNext;
    const beforeCursor = deliveries.length;
    socket.receive({ channel: 'terminal', type: 'cursor', cursor: { row: 7, col: 8 } });
    // Flush happens synchronously inside the cursor path.
    expect(deliveries.length).toBe(beforeCursor + 2);
    expect(deliveries[beforeCursor]).toEqual({
      data: base.join('\n'),
      type: 'output',
      cursor: { row: 1, col: 1 },
      meta: { source: 'delta', replace: false },
    });
    expect(deliveries[beforeCursor + 1]).toEqual({
      data: '',
      type: 'cursor',
      cursor: { row: 7, col: 8 },
      meta: undefined,
    });

    // (c) history frame with deltas queued
    busy = true;
    const hNext = [...base.slice(0, -1), 'hist-chg'];
    socket.receive(createMuxDeltaFrame('terminal', base, hNext));
    base = hNext;
    const beforeHist = deliveries.length;
    socket.receive({ channel: 'terminal', type: 'history', data: 'HIST' });
    expect(deliveries.length).toBe(beforeHist + 2);
    expect(deliveries[beforeHist]?.data).toBe(base.join('\n'));
    expect(deliveries[beforeHist]?.type).toBe('output');
    expect(deliveries[beforeHist + 1]).toEqual({
      data: 'HIST',
      type: 'history',
      cursor: undefined,
      meta: undefined,
    });

    unsubscribe();
    socket.finishClose();
  });

  test('invalid frame inside a queue delivers applied prefix, one resync, drops rest', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });
    let base = ['v0', 'v1', 'v2'];
    socket.receive(full('terminal', base.join('\n')));
    const afterFull = deliveries.length;

    const n1 = ['v0', 'v1', 'A'];
    const n2 = ['v0', 'v1', 'B'];
    const d1 = createMuxDeltaFrame('terminal', base, n1);
    const d2 = createMuxDeltaFrame('terminal', n1, n2);
    const broken = {
      ...createMuxDeltaFrame('terminal', n2, ['v0', 'v1', 'C']),
      prefixHash: 'deadbeef',
    };
    // Trailing valid frame (relative to n2 — never applied once broken hits).
    const trailing = createMuxDeltaFrame('terminal', n2, ['v0', 'v1', 'D']);

    socket.receive(d1);
    socket.receive(d2);
    socket.receive(broken);
    socket.receive(trailing);
    expect(deliveries).toHaveLength(afterFull);

    busy = false;
    const beforeResync = socket.frames('resync').length;
    tickScheduler();
    expect(deliveries).toHaveLength(afterFull + 1);
    expect(deliveries.at(-1)?.data).toBe(n2.join('\n'));
    expect(socket.frames('resync')).toHaveLength(beforeResync + 1);
    // Trailing never delivered.
    expect(deliveries.some((d) => d.data.endsWith('D'))).toBe(false);
    expect(deliveries.some((d) => d.data.endsWith('C'))).toBe(false);

    unsubscribe();
    socket.finishClose();
  });

  test('teardown discards pending queue with no later delivery', () => {
    let busy = true;
    // Unsubscribe last subscriber
    {
      const { socket, deliveries, unsubscribe } = openMux('terminal', {
        deferWhileBusy: () => busy,
      });
      const base = ['t0', 't1'];
      socket.receive(full('terminal', base.join('\n')));
      const afterFull = deliveries.length;
      socket.receive(createMuxDeltaFrame('terminal', base, ['t0', 'T']));
      expect(deliveries).toHaveLength(afterFull);
      unsubscribe();
      busy = false;
      tickScheduler(5);
      expect(deliveries).toHaveLength(afterFull);
      socket.finishClose();
    }

    // Socket close with queue pending
    {
      busy = true;
      const { socket, deliveries, unsubscribe } = openMux('terminal', {
        deferWhileBusy: () => busy,
      });
      const base = ['c0', 'c1'];
      socket.receive(full('terminal', base.join('\n')));
      const afterFull = deliveries.length;
      socket.receive(createMuxDeltaFrame('terminal', base, ['c0', 'C']));
      expect(deliveries).toHaveLength(afterFull);
      socket.finishClose(); // releaseSocket → invalidateAllOutputBases
      busy = false;
      tickScheduler(5);
      expect(deliveries).toHaveLength(afterFull);
      unsubscribe();
    }
  });

  test('mixed subscribers (one probe, one without) never defer', () => {
    const mux = new TmuxMux();
    mux.configure({ scheduleFrame: (cb) => { scheduled.push(cb); } });
    const withProbe: Delivery[] = [];
    const without: Delivery[] = [];
    let busy = true;
    const stopA = mux.subscribe('terminal', (data, type, cursor, meta) => {
      withProbe.push({ data, type, cursor, meta });
    }, { deferWhileBusy: () => busy });
    const stopB = mux.subscribe('terminal', (data, type, cursor, meta) => {
      without.push({ data, type, cursor, meta });
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    const base = ['m0', 'm1'];
    socket.receive(full('terminal', base.join('\n')));
    const next = ['m0', 'M'];
    socket.receive(createMuxDeltaFrame('terminal', base, next, { row: 0, col: 0 }));

    // Both receive immediately; nothing queued.
    expect(scheduled).toHaveLength(0);
    expect(withProbe.at(-1)?.data).toBe('m0\nM');
    expect(without.at(-1)?.data).toBe('m0\nM');
    expect(withProbe.at(-1)?.meta).toEqual({ source: 'delta', replace: false });
    expect(without.at(-1)?.meta).toEqual({ source: 'delta', replace: false });

    stopA();
    stopB();
    socket.finishClose();
  });
});

// ─── 13. Perf smoke ─────────────────────────────────────────────────────────

describe('delta fastpath: perf smoke', () => {
  test('one-line deltas on a 2000-row base stay under 5ms median', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const rows = Array.from({ length: 2000 }, (_, i) => `line-${i}-padding-${'x'.repeat(40)}`);
    // Base construction OUTSIDE the timed region.
    const baseData = rows.join('\n');
    socket.receive(full('terminal', baseData));

    let base = rows.slice();
    // Warm-up
    for (let i = 0; i < 3; i++) {
      const next = [...base.slice(0, -1), `warm-${i}`];
      socket.receive(createMuxDeltaFrame('terminal', base, next));
      base = next;
    }

    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const next = [...base.slice(0, -1), `timed-${i}-${'y'.repeat(20)}`];
      const frame = createMuxDeltaFrame('terminal', base, next);
      const t0 = performance.now();
      socket.receive(frame);
      const t1 = performance.now();
      times.push(t1 - t0);
      base = next;
    }

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    // Old path ~13.8 ms; new path ~0.1 ms. 5 ms is a 50× margin.
    expect(median).toBeLessThan(5);
    // Sanity: all timed deltas delivered.
    expect(deliveries.at(-1)?.data.endsWith(`timed-14-${'y'.repeat(20)}`)).toBe(true);

    unsubscribe();
    socket.finishClose();
  });
});

// ─── 14. Seeded differential equivalence vs old core delta branch ───────────

describe('delta fastpath: differential equivalence', () => {
  test('randomized adversarial frames match old core-based reference model', () => {
    // Deterministic PRNG — reset to the literal at the start so file order
    // cannot perturb the stream.
    const SEED = 0x2f6e2b1;
    let seed = SEED;
    const rnd = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0x100000000;
    };
    seed = SEED;

    const alphabet = [
      '',
      'a',
      'ab',
      '"q"',
      'x\\y',
      't\tb',
      '\x00\x1f',
      'ภาษาไทย',
      '😀🚀',
      '\ud800',
      '\udfff',
      '½€漢字',
      '\x1b[31mred\x1b[0m',
      '   ',
      'z'.repeat(300),
      '  ',
      '\\u0041',
    ];

    function pickLine(): string {
      let line = alphabet[Math.floor(rnd() * alphabet.length)]!;
      if (rnd() < 0.35) line = `${line}${Math.floor(rnd() * 1000)}`;
      return line;
    }

    function makeBase(maxLen = 6): string[] {
      const n = Math.floor(rnd() * (maxLen + 1));
      return Array.from({ length: n }, () => pickLine());
    }

    /** Shared-prefix mutation or entirely fresh base (prefix 0 / growth / shrink). */
    function nextBase(base: string[]): string[] {
      if (base.length === 0 || rnd() < 0.35) return makeBase(6);
      const prefix = Math.floor(rnd() * (base.length + 1)); // 0..len
      const tailLen = Math.floor(rnd() * 4); // 0..3
      return [...base.slice(0, prefix), ...Array.from({ length: tailLen }, () => pickLine())];
    }

    function pickCursor(): { row: number; col: number } | null | undefined {
      const r = rnd();
      if (r < 0.4) {
        // Real cursor; protocol permits negative row.
        return {
          row: Math.floor(rnd() * 50) - 15,
          col: Math.floor(rnd() * 120) - 5,
        };
      }
      if (r < 0.6) return null;
      return undefined;
    }

    function corruptDelta(frame: MuxDeltaFrame): unknown {
      const kind = Math.floor(rnd() * 7);
      switch (kind) {
        case 0:
          return { ...frame, prefixHash: frame.prefixHash === 'deadbeef' ? 'cafebabe' : 'deadbeef' };
        case 1:
          return { ...frame, baseLength: frame.baseLength + (rnd() < 0.5 ? 1 : -1) };
        case 2:
          return { ...frame, prefix: frame.prefix + (Math.floor(rnd() * 5) - 2) };
        case 3:
          return { ...frame, prefix: rnd() < 0.5 ? 1e9 : 0.5 };
        case 4:
          return { ...frame, lines: [...frame.lines, 123 as unknown as string] };
        case 5:
          return { ...frame, cursor: { row: 0.5, col: 1 } };
        default:
          return { ...frame, prefixHash: 42 };
      }
    }

    type RefState = {
      base: string[] | null;
      resyncing: boolean;
      resyncs: number;
    };

    /** Old delta-branch model (core validate + apply), no fast-path. */
    function refHandle(
      state: RefState,
      frame: unknown,
    ): { delivered?: { data: string; cursor: unknown } } {
      const base = state.base;
      const delta = base && !state.resyncing ? validateMuxDeltaFrame(frame, base) : null;
      const next = delta && base ? applyMuxDelta(base, delta) : null;
      if (!delta || !next) {
        if (!state.resyncing) {
          state.resyncing = true;
          state.base = null;
          state.resyncs++;
        }
        return {};
      }
      state.base = next;
      return { delivered: { data: next.join('\n'), cursor: delta.cursor } };
    }

    function assertCursor(actual: unknown, expected: unknown) {
      if (expected === undefined) {
        expect(actual).toBeUndefined();
      } else if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).toEqual(expected);
      }
    }

    for (let trial = 0; trial < 400; trial++) {
      const { socket, deliveries, unsubscribe } = openMux();
      const ref: RefState = { base: null, resyncing: false, resyncs: 0 };
      const refStream: Array<{ data: string; cursor: unknown }> = [];
      // Generator base for createMuxDeltaFrame — starts empty; after a full
      // frame it MUST be splitMuxOutputData(d) (empty string → [''], not []).
      let truthBase: string[] = [];

      for (let step = 0; step < 25; step++) {
        const beforeLen = deliveries.length;
        const sendFull = rnd() < 0.12;

        if (sendFull) {
          const lines = makeBase(8);
          const data = lines.join('\n');
          socket.receive(full('terminal', data));

          // Full frame: client installs splitMuxOutputData(d) and clears resync.
          ref.base = splitMuxOutputData(data);
          ref.resyncing = false;
          truthBase = ref.base;
          const delivered = { data, cursor: undefined as unknown };
          refStream.push(delivered);

          expect(deliveries).toHaveLength(beforeLen + 1);
          expect(deliveries.at(-1)!.data).toBe(data);
          assertCursor(deliveries.at(-1)!.cursor, undefined);
          expect(socket.frames('resync')).toHaveLength(ref.resyncs);
        } else {
          const next = nextBase(truthBase);
          const cursor = pickCursor();
          let frame: unknown = createMuxDeltaFrame('terminal', truthBase, next, cursor);
          if (rnd() < 0.2) frame = corruptDelta(frame as MuxDeltaFrame);

          const refResult = refHandle(ref, frame);
          socket.receive(frame);

          const clientDelivered = deliveries.length > beforeLen;
          expect(clientDelivered).toBe(!!refResult.delivered);

          if (refResult.delivered) {
            refStream.push(refResult.delivered);
            truthBase = ref.base!;
            expect(deliveries.at(-1)!.data).toBe(refResult.delivered.data);
            assertCursor(deliveries.at(-1)!.cursor, refResult.delivered.cursor);
          } else {
            expect(deliveries).toHaveLength(beforeLen);
          }
          expect(socket.frames('resync')).toHaveLength(ref.resyncs);
        }
      }

      const clientStream = deliveries
        .filter((d) => d.type === 'output')
        .map((d) => ({ data: d.data, cursor: d.cursor }));
      expect(clientStream).toEqual(refStream);

      unsubscribe();
      socket.finishClose();
    }
  });
});

// ─── 15. Queue must drain when the busy probe flips ─────────────────────────

describe('delta defer: queue must drain when the busy probe flips', () => {
  test('never replays a superseded delta after the probe flips false', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });

    // 1) Full base ["a","b"]
    socket.receive(full('terminal', 'a\nb'));
    expect(deliveries.map((d) => d.data)).toEqual(['a\nb']);

    // 2) busy = true. D1: ["a","b"] -> ["a","c"] → queued, settle scheduled.
    const d1 = createMuxDeltaFrame('terminal', ['a', 'b'], ['a', 'c']);
    socket.receive(d1);
    expect(deliveries).toHaveLength(1);
    expect(scheduled.length).toBeGreaterThan(0);

    // 3) Gesture ends: busy = false (no scheduler tick yet).
    busy = false;

    // 4) D2 built against server truth ["a","c"] -> ["a","d"].
    //    Bug: fast path applies against un-advanced base ["a","b"], delivers
    //    "a\nd", leaves D1 queued; settle then replays D1 → silent revert.
    const d2 = createMuxDeltaFrame('terminal', ['a', 'c'], ['a', 'd']);
    const beforeResync = socket.frames('resync').length;
    socket.receive(d2);

    // After arrival-triggered drain: full + one coalesced delivery of final truth.
    expect(deliveries.map((d) => d.data)).toEqual(['a\nb', 'a\nd']);
    // Never deliver the superseded intermediate as the last (or any post-flip) state.
    expect(deliveries.map((d) => d.data).at(-1)).toBe('a\nd');
    expect(deliveries.map((d) => d.data).includes('a\nc')).toBe(false);
    expect(socket.frames('resync')).toHaveLength(beforeResync);

    // Black-box prove client base is really ["a","d"]: further delta must apply.
    const d3 = createMuxDeltaFrame('terminal', ['a', 'd'], ['a', 'e']);
    socket.receive(d3);
    expect(deliveries.map((d) => d.data)).toEqual(['a\nb', 'a\nd', 'a\ne']);
    expect(socket.frames('resync')).toHaveLength(beforeResync);

    // Pending settle (or residual ticks) must not deliver anything further.
    const lenAfter = deliveries.length;
    tickScheduler(5);
    expect(deliveries).toHaveLength(lenAfter);
    expect(deliveries.map((d) => d.data)).toEqual(['a\nb', 'a\nd', 'a\ne']);
    expect(socket.frames('resync')).toHaveLength(beforeResync);

    unsubscribe();
    socket.finishClose();
  });

  test('applies queued and fresh frames in arrival order across the flip', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });

    // Successive server states (index 0 = full, then each delta result).
    const states: string[][] = [
      ['l0', 'l1', 'l2'],
      ['l0', 'l1', 's1'],
      ['l0', 'l1', 's2'],
      ['l0', 'l1', 's3'],
      ['l0', 'l1', 's4'],
      ['l0', 'l1', 's5'],
    ];
    const joined = states.map((s) => s.join('\n'));

    socket.receive(full('terminal', joined[0]!));
    const afterFull = deliveries.length;

    // Queue THREE deltas while busy (each against previous next).
    for (let i = 0; i < 3; i++) {
      socket.receive(createMuxDeltaFrame('terminal', states[i]!, states[i + 1]!));
    }
    expect(deliveries).toHaveLength(afterFull);
    expect(scheduled.length).toBeGreaterThan(0);

    // Flip busy false, then feed TWO more deltas against correct successive bases.
    busy = false;
    const beforeResync = socket.frames('resync').length;
    socket.receive(createMuxDeltaFrame('terminal', states[3]!, states[4]!));
    socket.receive(createMuxDeltaFrame('terminal', states[4]!, states[5]!));

    // Final delivery equals final server base.
    expect(deliveries.at(-1)?.data).toBe(joined[5]!);
    expect(socket.frames('resync')).toHaveLength(beforeResync);

    // Delivered data sequence is monotonically forward through successive states.
    const stateIndex = new Map(joined.map((j, i) => [j, i]));
    let prevIdx = -1;
    for (const d of deliveries) {
      const idx = stateIndex.get(d.data);
      expect(idx).toBeDefined();
      expect(idx!).toBeGreaterThanOrEqual(prevIdx);
      prevIdx = idx!;
    }
    // No delivery equals an earlier-but-superseded base after that base was passed.
    const deliveryData = deliveries.map((d) => d.data);
    for (let i = 0; i < deliveryData.length; i++) {
      const idx = stateIndex.get(deliveryData[i]!)!;
      for (let j = i + 1; j < deliveryData.length; j++) {
        expect(stateIndex.get(deliveryData[j]!)!).toBeGreaterThanOrEqual(idx);
      }
    }

    // Last delivery is the final state; no resync.
    expect(deliveryData.at(-1)).toBe(joined[5]!);
    expect(socket.frames('resync')).toHaveLength(0);

    tickScheduler(3);
    expect(deliveries.at(-1)?.data).toBe(joined[5]!);

    unsubscribe();
    socket.finishClose();
  });

  test('a broken frame in the surviving queue still delivers the applied prefix and resyncs once', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });

    const base = ['q0', 'q1'];
    const n1 = ['q0', 'A'];
    // Server thinks after D1 the base is n1; D2 is broken so client aborts there.
    // D3 is computed by the server against what it believes is current after a
    // valid D2 path — but the client must drop it with the rest of the queue.
    const n2ServerTruth = ['q0', 'B']; // what a valid D2 would have produced
    const n3 = ['q0', 'C'];

    socket.receive(full('terminal', base.join('\n')));
    const afterFull = deliveries.length;

    const d1 = createMuxDeltaFrame('terminal', base, n1);
    const broken = {
      ...createMuxDeltaFrame('terminal', n1, n2ServerTruth),
      prefixHash: 'deadbeef',
    };
    socket.receive(d1);
    socket.receive(broken);
    expect(deliveries).toHaveLength(afterFull);

    busy = false;
    const beforeResync = socket.frames('resync').length;
    // Fresh valid D3 against server-assumed base n2ServerTruth — arrives with
    // a surviving queue that will abort at the broken frame.
    const d3 = createMuxDeltaFrame('terminal', n2ServerTruth, n3);
    socket.receive(d3);

    // Exactly one delivery containing D1's content; D3 never delivered.
    expect(deliveries).toHaveLength(afterFull + 1);
    expect(deliveries.at(-1)?.data).toBe(n1.join('\n'));
    expect(deliveries.some((d) => d.data === n3.join('\n'))).toBe(false);
    expect(deliveries.some((d) => d.data === n2ServerTruth.join('\n'))).toBe(false);
    // Exactly ONE resync frame.
    expect(socket.frames('resync')).toHaveLength(beforeResync + 1);

    // Subsequent full output restores service and delivers normally.
    const recovery = ['fresh', 'base'];
    socket.receive(full('terminal', recovery.join('\n')));
    expect(deliveries.at(-1)?.data).toBe(recovery.join('\n'));
    const ok = createMuxDeltaFrame('terminal', recovery, ['fresh', 'ok']);
    const beforeOk = deliveries.length;
    const beforeResync2 = socket.frames('resync').length;
    socket.receive(ok);
    expect(deliveries).toHaveLength(beforeOk + 1);
    expect(deliveries.at(-1)?.data).toBe('fresh\nok');
    expect(socket.frames('resync')).toHaveLength(beforeResync2);

    unsubscribe();
    socket.finishClose();
  });

  test('no queue means the fast path is untouched', () => {
    // Always-false probe: three deltas → three synchronous deliveries.
    {
      const { socket, deliveries, unsubscribe } = openMux('terminal', {
        deferWhileBusy: () => false,
      });
      let base = ['f0', 'f1'];
      socket.receive(full('terminal', base.join('\n')));
      const afterFull = deliveries.length;
      const beforeResync = socket.frames('resync').length;

      for (let i = 0; i < 3; i++) {
        const next = [...base.slice(0, -1), `f-chg-${i}`];
        socket.receive(createMuxDeltaFrame('terminal', base, next));
        base = next;
        expect(deliveries).toHaveLength(afterFull + i + 1);
        expect(deliveries.at(-1)?.data).toBe(base.join('\n'));
      }
      expect(scheduled).toHaveLength(0);
      expect(socket.frames('resync')).toHaveLength(beforeResync);
      expect(deliveries).toHaveLength(afterFull + 3);

      unsubscribe();
      socket.finishClose();
    }

    // Plain subscriber (no probe at all): same contract.
    {
      FakeWebSocket.instances = [];
      scheduled = [];
      const { socket, deliveries, unsubscribe } = openMux('terminal');
      let base = ['p0', 'p1'];
      socket.receive(full('terminal', base.join('\n')));
      const afterFull = deliveries.length;
      const beforeResync = socket.frames('resync').length;

      for (let i = 0; i < 3; i++) {
        const next = [...base.slice(0, -1), `p-chg-${i}`];
        socket.receive(createMuxDeltaFrame('terminal', base, next));
        base = next;
        expect(deliveries).toHaveLength(afterFull + i + 1);
        expect(deliveries.at(-1)?.data).toBe(base.join('\n'));
      }
      expect(scheduled).toHaveLength(0);
      expect(socket.frames('resync')).toHaveLength(beforeResync);
      expect(deliveries).toHaveLength(afterFull + 3);

      unsubscribe();
      socket.finishClose();
    }
  });

  test('settle scheduling stays healthy after an arrival-triggered flush', () => {
    let busy = true;
    const { socket, deliveries, unsubscribe } = openMux('terminal', {
      deferWhileBusy: () => busy,
    });

    const base = ['h0', 'h1'];
    const n1 = ['h0', 'A'];
    const n2 = ['h0', 'B'];
    socket.receive(full('terminal', base.join('\n')));

    // Queue D1 while busy; flip + fresh D2 must arrival-flush both (not fast-path D2 alone).
    socket.receive(createMuxDeltaFrame('terminal', base, n1));
    expect(scheduled.length).toBeGreaterThan(0);
    // Capture the already-scheduled settle callback (fires later on empty queue).
    const staleCallbacks = scheduled.slice();

    busy = false;
    socket.receive(createMuxDeltaFrame('terminal', n1, n2));
    // Arrival flush coalesces D1+D2 → final truth only (no silent D1 replay later).
    expect(deliveries.map((d) => d.data)).toEqual(['h0\nh1', 'h0\nB']);
    // Residual settle must find an empty queue — no superseded replay of "h0\nA".
    expect(() => tickScheduler(3)).not.toThrow();
    expect(deliveries.map((d) => d.data)).toEqual(['h0\nh1', 'h0\nB']);
    expect(deliveries.some((d) => d.data === 'h0\nA')).toBe(false);
    const afterFlush = deliveries.length;

    // settleScheduled is now false (stale settle ran). A new busy period must
    // be able to schedule a fresh settle.
    busy = true;
    const n3 = ['h0', 'C'];
    // Clear any residual scheduled entries so we can assert a NEW schedule.
    scheduled.length = 0;
    socket.receive(createMuxDeltaFrame('terminal', n2, n3));
    // Queued — no delivery yet.
    expect(deliveries).toHaveLength(afterFlush);
    // A settle must be scheduleable again after the arrival-triggered flush.
    expect(scheduled.length).toBeGreaterThan(0);

    busy = false;
    tickScheduler();
    expect(deliveries.at(-1)?.data).toBe(n3.join('\n'));
    expect(deliveries).toHaveLength(afterFlush + 1);

    // Stale scheduled callbacks firing on an empty queue deliver nothing and do not throw.
    const lenBeforeStale = deliveries.length;
    for (const cb of staleCallbacks) {
      expect(() => cb()).not.toThrow();
    }
    expect(() => tickScheduler(3)).not.toThrow();
    expect(deliveries).toHaveLength(lenBeforeStale);
    // Still no superseded intermediate.
    expect(deliveries.some((d) => d.data === 'h0\nA')).toBe(false);

    unsubscribe();
    socket.finishClose();
  });
});
