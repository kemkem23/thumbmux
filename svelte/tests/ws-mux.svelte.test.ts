import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createMuxDeltaFrame } from '@thumbmux/core';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state');
Object.defineProperty(globalThis, '$state', {
  configurable: true,
  value: <T>(value: T) => value,
});

// D3 mutation controls re-run this file against a mutant sibling module
// written only inside the cage's copy (never the worktree, never HEAD).
const { TmuxMux } = (await import(process.env.D3_MUTANT_MUX_CLIENT ?? '../src/ws-mux.svelte')) as typeof import('../src/ws-mux.svelte');

type Listener = (event?: unknown) => void;

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

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
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

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`send while readyState=${this.readyState}`);
    }
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
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

  frames() {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

const globalNames = [
  'window',
  'document',
  'navigator',
  'WebSocket',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

let fakeDocument: FakeEventTarget & { visibilityState: string };
let fakeWindow: FakeEventTarget & Record<string, any>;

function setGlobal(name: typeof globalNames[number], value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' });
  fakeWindow = Object.assign(new FakeEventTarget(), {
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
  jest.useRealTimers();
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

describe('TmuxMux disposal', () => {
  test('removes the exact five browser listeners and is idempotent', () => {
    jest.useFakeTimers();
    const visualViewport = Object.assign(new FakeEventTarget(), {
      width: 390,
      height: 844,
    });
    fakeWindow.visualViewport = visualViewport;

    const mux = new TmuxMux();
    mux.onSessions(() => {});
    const socket = FakeWebSocket.instances[0]!;
    expect(jest.getTimerCount()).toBe(1); // connect timeout

    const listenerCounts = () => [
      fakeDocument.listenerCount('visibilitychange'),
      fakeWindow.listenerCount('pageshow'),
      fakeWindow.listenerCount('resize'),
      visualViewport.listenerCount('resize'),
      visualViewport.listenerCount('scroll'),
    ];

    expect(listenerCounts()).toEqual([1, 1, 1, 1, 1]);

    // Teardown must target the viewport that was originally bound, even if a
    // browser replaces window.visualViewport in the meantime.
    fakeWindow.visualViewport = new FakeEventTarget();
    mux.dispose();
    expect(listenerCounts()).toEqual([0, 0, 0, 0, 0]);
    expect(socket.closeCalls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);

    mux.dispose();
    expect(listenerCounts()).toEqual([0, 0, 0, 0, 0]);
    expect(socket.closeCalls).toBe(1);
  });

  test('stops an open socket ping timer', () => {
    jest.useFakeTimers();
    const mux = new TmuxMux();
    mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(jest.getTimerCount()).toBe(1); // ping interval

    jest.advanceTimersByTime(25_000);
    expect(socket.frames().filter((frame) => frame.type === 'ping')).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(2); // ping interval + pong timeout

    fakeWindow.emit('resize');
    expect(jest.getTimerCount()).toBe(3); // plus client-info debounce

    mux.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(100_000);

    expect(socket.frames().filter((frame) => frame.type === 'ping')).toHaveLength(1);
    expect(socket.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('cancels the default deferred-delta settle timer', () => {
    jest.useFakeTimers();
    setGlobal('requestAnimationFrame', undefined);
    setGlobal('cancelAnimationFrame', undefined);

    const deliveries: string[] = [];
    const mux = new TmuxMux();
    mux.subscribe('work', (data, type) => {
      if (type === 'output') deliveries.push(data);
    }, { deferWhileBusy: () => true });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ channel: 'work', type: 'output', data: 'base' });
    socket.receive(createMuxDeltaFrame('work', ['base'], ['next']));

    expect(deliveries).toEqual(['base']);
    expect(jest.getTimerCount()).toBe(2); // ping interval + settle timeout

    mux.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(1_000);

    expect(deliveries).toEqual(['base']);
    expect(socket.frames().filter((frame) => frame.type === 'resync')).toEqual([]);
  });

  test('cancels reconnect and cannot be reused after disposal', () => {
    jest.useFakeTimers();
    const mux = new TmuxMux();
    mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const staleClose = socket.onclose!;

    // Closing with an active subscription arms the 1s reconnect first.
    socket.finishClose();
    expect(jest.getTimerCount()).toBe(1);
    mux.dispose();
    expect(jest.getTimerCount()).toBe(0);

    staleClose({ type: 'close' });
    expect(jest.getTimerCount()).toBe(0);

    const stopOutput = mux.subscribe('late', () => {});
    const stopSessions = mux.onSessions(() => {});
    mux.sendResize('late', 80, 24);
    jest.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(mux.connected).toBe(false);
    expect(() => {
      stopOutput();
      stopSessions();
      mux.dispose();
    }).not.toThrow();
  });

  test('does not finish connecting when a host hook disposes reentrantly', () => {
    jest.useFakeTimers();
    const mux = new TmuxMux();
    mux.configure({
      getUrl: () => {
        mux.dispose();
        return 'wss://thumbmux.test/ws/tmux';
      },
    });

    const stop = mux.subscribe('work', () => {});

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(() => {
      stop();
      mux.dispose();
    }).not.toThrow();
  });
});

describe('TmuxMux socket ownership', () => {
  test('ignores duplicate foreground connects and a stale onopen while the replacement is CONNECTING', () => {
    const mux = new TmuxMux();
    const stopSessions = mux.onSessions(() => {});
    const first = FakeWebSocket.instances[0];
    const staleOpen = first.onopen!;

    // visibilitychange and pageshow commonly arrive together on mobile. They
    // must not replace an in-flight socket.
    fakeDocument.emit('visibilitychange');
    fakeWindow.emit('pageshow');
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Model a socket that became unusable while the page was frozen, before
    // its queued close callback was delivered.
    first.readyState = FakeWebSocket.CLOSED;
    fakeDocument.emit('visibilitychange');
    const second = FakeWebSocket.instances[1];
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(first.onopen).toBeNull();
    expect(first.onclose).toBeNull();

    // Replaying the already-queued old callback used to send
    // sessions_subscribe through `this.ws` (the new CONNECTING socket), which
    // throws in browsers and starts the reconnect cascade.
    first.readyState = FakeWebSocket.OPEN;
    expect(() => staleOpen({ type: 'open' })).not.toThrow();
    expect(first.closeCalls).toBe(1);
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(second.sent).toEqual([]);

    fakeWindow.emit('pageshow');
    expect(FakeWebSocket.instances).toHaveLength(2);

    second.open();
    expect(second.frames().map((frame) => frame.type)).toEqual([
      'client_info',
      'sessions_subscribe',
    ]);
    stopSessions();
    second.finishClose();
  });

  test('a stale onclose cannot clear the new socket or schedule another reconnect', async () => {
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', () => {});
    const first = FakeWebSocket.instances[0];
    first.open();
    const staleClose = first.onclose!;
    expect(mux.connected).toBe(true);

    first.readyState = FakeWebSocket.CLOSED;
    fakeDocument.emit('visibilitychange');
    const second = FakeWebSocket.instances[1];
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING);

    // This callback was queued before releaseSocket detached the old socket.
    // It must not null `this.ws`, clear the replacement's connect timeout, or
    // schedule the 1s reconnect that creates a third socket.
    staleClose({ type: 'close' });
    await Bun.sleep(1_100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING);

    second.open();
    expect(mux.connected).toBe(true);
    staleClose({ type: 'close' });
    expect(mux.connected).toBe(true);

    mux.sendKeys('work', 'x');
    expect(second.frames().at(-1)).toMatchObject({ type: 'keys', session: 'work', data: 'x' });

    unsubscribe();
    second.finishClose();
  });
});

describe('TmuxMux subscription teardown', () => {
  test('a stale session teardown cannot remove a later subscriber or unsubscribe it on the wire', () => {
    const mux = new TmuxMux();
    const firstStop = mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    firstStop();

    const deliveries: string[] = [];
    const secondStop = mux.subscribe('work', (data, type) => {
      if (type === 'output') deliveries.push(data);
    });

    firstStop();
    socket.receive({ channel: 'work', type: 'output', data: 'still subscribed' });

    expect(deliveries).toEqual(['still subscribed']);
    expect(socket.frames().filter((frame) => frame.type === 'unsubscribe')).toEqual([
      { type: 'unsubscribe', session: 'work' },
    ]);

    secondStop();
    socket.finishClose();
  });

  test('the session active guard protects a callback re-added while its captured set stays current', () => {
    const mux = new TmuxMux();
    const reusedDeliveries: string[] = [];
    const keeperDeliveries: string[] = [];
    const reusedCallback = (data: string, type?: string) => {
      if (type === 'output') reusedDeliveries.push(data);
    };
    const firstStop = mux.subscribe('work', reusedCallback);
    const keeperStop = mux.subscribe('work', (data, type) => {
      if (type === 'output') keeperDeliveries.push(data);
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    firstStop();
    const laterStop = mux.subscribe('work', reusedCallback);
    firstStop();
    socket.receive({ channel: 'work', type: 'output', data: 'both active' });

    expect(reusedDeliveries).toEqual(['both active']);
    expect(keeperDeliveries).toEqual(['both active']);

    laterStop();
    keeperStop();
    socket.finishClose();
  });

  test('the session set-identity guard rejects an active teardown that captured a replaced set', () => {
    const mux = new TmuxMux();
    const sharedCallback = () => {};
    const firstStop = mux.subscribe('work', sharedCallback);
    const duplicateStop = mux.subscribe('work', sharedCallback);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    // Set de-duplication lets this sibling teardown empty and retire the set
    // while firstStop itself remains active and still captures that old set.
    duplicateStop();
    const deliveries: string[] = [];
    const laterStop = mux.subscribe('work', (data, type) => {
      if (type === 'output') deliveries.push(data);
    });
    firstStop();
    socket.receive({ channel: 'work', type: 'output', data: 'replacement survived' });

    expect(deliveries).toEqual(['replacement survived']);
    expect(socket.frames().filter((frame) => frame.type === 'unsubscribe')).toEqual([
      { type: 'unsubscribe', session: 'work' },
    ]);

    laterStop();
    socket.finishClose();
  });

  test('a stale session-list teardown cannot remove a later registration of the same callback', () => {
    const mux = new TmuxMux();
    const deliveries: unknown[][] = [];
    const callback = (sessions: unknown[]) => deliveries.push(sessions);
    const firstStop = mux.onSessions(callback);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    firstStop();
    const secondStop = mux.onSessions(callback);
    firstStop();
    socket.receive({ channel: '__sessions', type: 'sessions', data: '[{"name":"work"}]' });

    expect(deliveries).toEqual([[{ name: 'work' }]]);
    expect(socket.frames().filter((frame) => frame.type === 'sessions_unsubscribe')).toEqual([
      { type: 'sessions_unsubscribe' },
    ]);

    secondStop();
    socket.finishClose();
  });

  test('the session-list delete-result guard rejects a sibling teardown after Set de-duplication', () => {
    const mux = new TmuxMux();
    const callback = () => {};
    const firstStop = mux.onSessions(callback);
    const duplicateStop = mux.onSessions(callback);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    duplicateStop();
    firstStop();

    expect(socket.frames().filter((frame) => frame.type === 'sessions_unsubscribe')).toEqual([
      { type: 'sessions_unsubscribe' },
    ]);

    socket.finishClose();
  });
});

describe('TmuxMux archive history paging', () => {
  test('sends an explicit forward anchor and limit on the wire', () => {
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    mux.requestHistoryAfter('work', 41, 17);

    expect(socket.frames().filter((frame) => frame.type === 'history_expand')).toEqual([
      { type: 'history_expand', session: 'work', afterLine: 41, limit: 17 },
    ]);

    unsubscribe();
    socket.finishClose();
  });

  test('preserves a null forward anchor and omits an unspecified limit', () => {
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    mux.requestHistoryAfter('work', null);

    expect(socket.frames().filter((frame) => frame.type === 'history_expand')).toEqual([
      { type: 'history_expand', session: 'work', afterLine: null },
    ]);

    unsubscribe();
    socket.finishClose();
  });

  test('serializes backward and forward requests per session until each history reply', () => {
    const mux = new TmuxMux();
    const unsubscribeWork = mux.subscribe('work', () => {});
    const unsubscribeOther = mux.subscribe('other', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    mux.requestHistory('work', 100, 25);
    mux.requestHistoryAfter('work', 40, 10);
    mux.requestHistoryAfter('other', null);

    const historyFrames = () => socket.frames().filter((frame) => frame.type === 'history_expand');
    expect(historyFrames()).toEqual([
      { type: 'history_expand', session: 'work', beforeLine: 100, limit: 25 },
      { type: 'history_expand', session: 'other', afterLine: null },
    ]);

    socket.receive({
      channel: 'work',
      type: 'history',
      data: '{"lines":[],"startLine":null,"hasMore":false}',
    });
    mux.requestHistoryAfter('work', 40, 10);
    mux.requestHistory('work', 30, 5);

    expect(historyFrames()).toEqual([
      { type: 'history_expand', session: 'work', beforeLine: 100, limit: 25 },
      { type: 'history_expand', session: 'other', afterLine: null },
      { type: 'history_expand', session: 'work', afterLine: 40, limit: 10 },
    ]);

    socket.receive({
      channel: 'work',
      type: 'history',
      data: '{"lines":[],"startLine":null,"hasMore":false}',
    });
    mux.requestHistory('work', 30, 5);

    expect(historyFrames().at(-1)).toEqual({
      type: 'history_expand',
      session: 'work',
      beforeLine: 30,
      limit: 5,
    });

    unsubscribeWork();
    unsubscribeOther();
    socket.finishClose();
  });

  test('a history page carries its loss markers to the subscriber byte for byte (U2)', () => {
    const deliveries: Array<{ data: string; type?: string }> = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type) => { deliveries.push({ data, type }); });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    const page = JSON.stringify({
      lines: ['a', 'b'], startLine: 98, hasMore: true,
      markers: [{ lineId: 99, kind: 'worker-dead', reason: 'exit', missingCount: null }],
    });
    socket.receive({ channel: 'work', type: 'history', data: page });
    const history = deliveries.filter((d) => d.type === 'history');
    expect(history.length).toBe(1);
    expect(history[0]!.data).toBe(page);
    expect(JSON.parse(history[0]!.data).markers[0]).toEqual({ lineId: 99, kind: 'worker-dead', reason: 'exit', missingCount: null });
    unsubscribe();
    socket.finishClose();
  });

  test('reports accepted, blocked, and pre-open history requests to the caller', () => {
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances[0]!;

    expect(mux.requestHistory('work', 100, 25)).toBe(false);
    socket.open();
    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    expect(mux.requestHistoryAfter('work', 40, 10)).toBe(false);

    // Generic errors cover unrelated operations and cannot be correlated to
    // this tokenless request, so they must not release its wire lease.
    socket.receive({ channel: 'work', type: 'error', data: 'unrelated failure' });
    expect(mux.requestHistoryAfter('work', 40, 10)).toBe(false);

    socket.receive({
      channel: 'work',
      type: 'history',
      data: '{"lines":[],"startLine":null,"hasMore":false}',
    });
    expect(mux.requestHistoryAfter('work', 40, 10)).toBe(true);

    unsubscribe();
    socket.finishClose();
  });

  test('a retryable history error settles the wire lease and reaches the subscriber without posing as EOF', () => {
    const deliveries: Array<{ data: string; type?: string; meta?: unknown }> = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type, _cursor, meta) => {
      deliveries.push({ data, type, meta });
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    expect(mux.requestHistory('work', 100, 25)).toBe(false);

    socket.receive({
      channel: 'work',
      type: 'error',
      data: 'history_temporarily_unavailable',
      code: 'history_temporarily_unavailable',
      request: 'history_expand',
      retryable: true,
    });

    expect(deliveries).toEqual([{
      data: 'history_temporarily_unavailable',
      type: 'error',
      meta: {
        source: 'full',
        replace: false,
        historyError: {
          code: 'history_temporarily_unavailable',
          retryable: true,
        },
      },
    }]);
    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    expect(socket.frames().filter((frame) => frame.type === 'history_expand')).toEqual([
      { type: 'history_expand', session: 'work', beforeLine: 100, limit: 25 },
      { type: 'history_expand', session: 'work', beforeLine: 100, limit: 25 },
    ]);

    unsubscribe();
    socket.finishClose();
  });

  test('retries on a replacement socket so a late different-anchor reply is fenced', () => {
    const deliveries: string[] = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type) => {
      if (type === 'history') deliveries.push(data);
    });
    const first = FakeWebSocket.instances[0]!;
    first.open();

    expect(mux.recoverHistoryRequest('work')).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    const staleMessage = first.onmessage!;
    expect(mux.recoverHistoryRequest('work')).toBe(true);

    const replacement = FakeWebSocket.instances[1]!;
    expect(first.readyState).toBe(FakeWebSocket.CLOSING);
    expect(first.onmessage).toBeNull();
    replacement.open();
    expect(mux.requestHistoryAfter('work', 40, 10)).toBe(true);

    // Model an event already queued by the browser before handler detachment.
    staleMessage({
      data: JSON.stringify({
        channel: 'work',
        type: 'history',
        data: 'old-before-100',
      }),
    });
    expect(deliveries).toEqual([]);
    expect(replacement.frames().filter((frame) => frame.type === 'history_expand')).toEqual([
      { type: 'history_expand', session: 'work', afterLine: 40, limit: 10 },
    ]);

    replacement.receive({
      channel: 'work',
      type: 'history',
      data: 'new-after-40',
    });
    expect(deliveries).toEqual(['new-after-40']);

    unsubscribe();
    replacement.finishClose();
  });

  test('keeps other-session leases tied to the retired socket during recovery', () => {
    const mux = new TmuxMux();
    const unsubscribeWork = mux.subscribe('work', () => {});
    const unsubscribeOther = mux.subscribe('other', () => {});
    const first = FakeWebSocket.instances[0]!;
    first.open();

    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    expect(mux.requestHistory('other', 200, 25)).toBe(true);
    expect(mux.recoverHistoryRequest('work')).toBe(true);

    const replacement = FakeWebSocket.instances[1]!;
    replacement.open();

    // `other` still has a local caller waiting for the request sent on first.
    // Do not admit a new request whose broadcast reply that caller could steal.
    expect(mux.requestHistoryAfter('other', 40, 10)).toBe(false);

    // Once that caller settles, its already-retired wire is safe to release.
    // This must not close the unrelated replacement created by `work`.
    expect(mux.recoverHistoryRequest('other')).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(replacement.readyState).toBe(FakeWebSocket.OPEN);
    expect(mux.requestHistoryAfter('other', 40, 10)).toBe(true);
    expect(replacement.frames().filter((frame) => frame.type === 'history_expand')).toEqual([
      { type: 'history_expand', session: 'other', afterLine: 40, limit: 10 },
    ]);

    replacement.receive({
      channel: 'other',
      type: 'history',
      data: 'new-after-40',
    });
    unsubscribeWork();
    unsubscribeOther();
    replacement.finishClose();
  });

  test('reports a fenced request even when replacement setup throws', () => {
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', () => {});
    const first = FakeWebSocket.instances[0]!;
    first.open();

    expect(mux.requestHistory('work', 100, 25)).toBe(true);
    mux.configure({
      getUrl: () => {
        throw new Error('replacement URL unavailable');
      },
    });

    expect(mux.recoverHistoryRequest('work')).toBe(true);
    expect(first.readyState).toBe(FakeWebSocket.CLOSING);
    expect(first.onmessage).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mux.requestHistory('work', 80, 25)).toBe(false);

    unsubscribe();
    mux.dispose();
  });
});

describe('A6-3 getClientMeta failure must not leave OPEN socket unsubscribed', () => {
  test('throwing getClientMeta still resubscribes panes on open', () => {
    const mux = new TmuxMux();
    mux.configure({
      getClientMeta: () => {
        throw new Error('meta boom');
      },
    });
    const unsub = mux.subscribe('pane-a', () => {});
    const socket = FakeWebSocket.instances[0]!;
    expect(() => socket.open()).not.toThrow();

    const frames = socket.frames();
    const types = frames.map((f: { type: string }) => f.type);
    // Must still send subscribe even when client meta throws
    expect(types).toContain('subscribe');
    expect(frames.some((f: { type: string; session?: string }) =>
      f.type === 'subscribe' && f.session === 'pane-a',
    )).toBe(true);
    expect(mux.connected).toBe(true);

    unsub();
    socket.finishClose();
    mux.dispose();
  });

  test('non-JSON-safe getClientMeta still resubscribes panes', () => {
    const mux = new TmuxMux();
    mux.configure({
      getClientMeta: () => ({ bad: 1n } as never),
    });
    const unsub = mux.subscribe('pane-b', () => {});
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    const frames = socket.frames();
    expect(frames.some((f: { type: string; session?: string }) =>
      f.type === 'subscribe' && f.session === 'pane-b',
    )).toBe(true);

    unsub();
    socket.finishClose();
    mux.dispose();
  });
});

describe('A6-14 history reply after final unsubscribe is not delivered to a new subscriber', () => {
  test('orphan history after unsub does not land on a later subscriber of the same session', () => {
    const mux = new TmuxMux();
    const aDeliveries: string[] = [];
    const unsubA = mux.subscribe('shared', (data, type) => {
      if (type === 'history') aDeliveries.push(data);
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(mux.requestHistory('shared', 50, 10)).toBe(true);

    // Capture the handler, then A leaves entirely.
    const pending = socket.onmessage!;
    unsubA();

    const bDeliveries: string[] = [];
    const unsubB = mux.subscribe('shared', (data, type) => {
      if (type === 'history') bDeliveries.push(data);
    });

    // Late reply that was meant for A
    pending({
      data: JSON.stringify({
        channel: 'shared',
        type: 'history',
        data: 'history-for-A-only',
      }),
    });

    expect(aDeliveries).toEqual([]);
    expect(bDeliveries).toEqual([]);

    unsubB();
    socket.finishClose();
    mux.dispose();
  });
});

// ── NEWARCH L2-I lot I4: newarch-frame-v1 continuity before any subscriber ───
describe('TmuxMux newarch-frame-v1', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    v: 'newarch-frame-v1', paneKey: { serverIdentity: 'srv', paneId: '%1', birthGeneration: 1 },
    sourceEpoch: 1, geometryGeneration: 0, routeGeneration: 2, cols: 80, rows: 24, revision: 10, durableRevision: 9,
    nextLineId: 50, liveStartLine: 40, displaySource: 'pipe', degraded: false,
    markers: [{ lineId: 45, kind: 'attach', missingCount: null }], ...over,
  });

  test('a delta must continue its base descriptor; a full frame may start or drop one', () => {
    const deliveries: Array<{ data: string; meta: any }> = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type, _cursor, deliveryMeta) => {
      if (type === 'output') deliveries.push({ data, meta: deliveryMeta });
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const base = ['h40', 'h41', 'row a', 'row b'];
    socket.receive({ channel: 'work', type: 'output', data: base.join('\n'), cursor: null, newarch: meta() });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.meta.newarch.revision).toBe(10);
    expect(deliveries[0]!.meta.newarch.markers).toEqual([{ lineId: 45, kind: 'attach', missingCount: null }]);

    const grown = ['h40', 'h41', 'h42', 'row a', 'row c'];
    socket.receive({ ...createMuxDeltaFrame('work', base, grown), newarch: meta({ revision: 11, nextLineId: 51 }) });
    expect(deliveries.map((d) => d.data)).toEqual([base.join('\n'), grown.join('\n')]);
    expect(deliveries[1]!.meta.newarch.revision).toBe(11);

    // A new source epoch cannot patch the old base: nothing reaches the subscriber, one resync goes out.
    socket.receive({ ...createMuxDeltaFrame('work', grown, [...grown, 'x']), newarch: meta({ sourceEpoch: 2, revision: 12, nextLineId: 51 }) });
    expect(deliveries).toHaveLength(2);
    expect(socket.frames().filter((frame) => frame.type === 'resync')).toEqual([{ type: 'resync', session: 'work' }]);

    // The route went back to legacy: a complete resync frame without a descriptor clears it.
    socket.receive({ channel: 'work', type: 'output', data: 'legacy', cursor: null, reset: 'resync' });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[2]!.meta.newarch).toBeUndefined();

    // A delta that adds a descriptor to a legacy base is refused as well.
    socket.receive({ ...createMuxDeltaFrame('work', ['legacy'], ['legacy', 'y']), newarch: meta() });
    expect(deliveries).toHaveLength(3);
    unsubscribe();
    socket.finishClose();
    mux.dispose();
  });

  test('a rollback to legacy (resync frame without descriptor or seam) is delivered, and later legacy frames too', () => {
    const deliveries: string[] = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type) => { if (type === 'output') deliveries.push(data); });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const boundary = { generation: 'newarch:x:%1:1:r2', liveStartLine: 40, walSequence: '10', walOffset: 10 };
    socket.receive({ channel: 'work', type: 'output', data: 'projected', cursor: null, boundary, newarch: meta() });
    socket.receive({ channel: 'work', type: 'output', data: 'legacy one', cursor: null, reset: 'resync' });
    socket.receive({ channel: 'work', type: 'output', data: 'legacy two', cursor: null });
    expect(deliveries).toEqual(['projected', 'legacy one', 'legacy two']);
    expect(socket.frames().filter((frame) => frame.type === 'resync')).toEqual([]);
    // Without a route switch, dropping the seam is still refused.
    socket.receive({ channel: 'work', type: 'output', data: 'projected again', cursor: null, reset: 'resync', boundary: { ...boundary, generation: 'newarch:x:%1:1:r3' }, newarch: meta({ routeGeneration: 3 }) });
    socket.receive({ channel: 'work', type: 'output', data: 'seamless', cursor: null });
    expect(deliveries).toEqual(['projected', 'legacy one', 'legacy two', 'projected again']);
    unsubscribe();
    socket.finishClose();
    mux.dispose();
  });

  test('a metadata-only delta reaches the subscriber with its new marker; an older metadata revision is refused', () => {
    const deliveries: Array<{ data: string; meta: any }> = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type, _cursor, deliveryMeta) => {
      if (type === 'output') deliveries.push({ data, meta: deliveryMeta });
    });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const screen = ['h40', 'row a', 'row b'];
    socket.receive({ channel: 'work', type: 'output', data: screen.join('\n'), cursor: null, newarch: meta({ metadataRevision: 4 }) });
    // Cells unchanged, a worker died: the marker must still be delivered.
    const dead = { lineId: 50, kind: 'worker-dead', missingCount: null };
    socket.receive({
      ...createMuxDeltaFrame('work', screen, screen),
      newarch: meta({ metadataRevision: 5, markers: [{ lineId: 45, kind: 'attach', missingCount: null }, dead] }),
    });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]!.data).toBe(screen.join('\n'));
    expect(deliveries[1]!.meta.newarch.metadataRevision).toBe(5);
    expect(deliveries[1]!.meta.newarch.markers).toContainEqual(dead);
    // A delta whose metadata went backwards cannot patch this base.
    socket.receive({ ...createMuxDeltaFrame('work', screen, screen), newarch: meta({ metadataRevision: 3 }) });
    expect(deliveries).toHaveLength(2);
    expect(socket.frames().filter((frame) => frame.type === 'resync')).toEqual([{ type: 'resync', session: 'work' }]);
    unsubscribe();
    socket.finishClose();
    mux.dispose();
  });

  test('a malformed descriptor on a full frame is refused, not delivered', () => {
    const deliveries: string[] = [];
    const mux = new TmuxMux();
    const unsubscribe = mux.subscribe('work', (data, type) => { if (type === 'output') deliveries.push(data); });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({ channel: 'work', type: 'output', data: 'x', cursor: null, newarch: meta({ liveStartLine: 99, nextLineId: 50 }) });
    expect(deliveries).toEqual([]);
    expect(socket.frames().some((frame) => frame.type === 'resync')).toBe(true);
    unsubscribe();
    socket.finishClose();
    mux.dispose();
  });
});

// --- D3 (flag-on 2026-10-05): v2 cursor request/reply, both directions ---

const D3_PANE_A = { serverIdentity: 'srv-1', paneId: '%1', birthGeneration: 1 };
const D3_PANE_B = { serverIdentity: 'srv-1', paneId: '%2', birthGeneration: 1 };
const D3_GEOMETRY = { policy: 'fixed-at-birth', columns: 78, rows: 120, configVersion: 'q22-default-1', panesPerWindow: 1 } as const;

function d3Descriptor(pane: typeof D3_PANE_A, sessionId = 'sess-a') {
  return {
    schema: 'newarch-v2' as const, session: { serverIdentity: pane.serverIdentity, sessionId },
    pane, windowId: `@${pane.paneId}`, owner: 'capture-engine' as const, birthOperationId: `birth-${pane.paneId}`,
    geometry: D3_GEOMETRY, state: 'active' as const,
  };
}

function d3Cursor(pane: typeof D3_PANE_A, token: string, timelineRevision = 4) {
  return { schema: 'newarch-v2' as const, pane, storeId: 'local', timelineRevision, token };
}

function d3Row(pane: typeof D3_PANE_A, ordinal: number) {
  return { kind: 'row', id: { pane, segmentId: 'seg-1', rowOrdinal: ordinal }, cells: [{ text: `r${ordinal}`, width: 1, style: [] }], wrapStatus: 'unwrapped', wrapPad: 0 };
}

function d3Reply(request: { session: string; requestId: string; request: { pane: typeof D3_PANE_A } }, rows: number[], before: unknown, after: unknown = { kind: 'end' }) {
  return {
    schema: 'newarch-v2', type: 'history_v2', channel: request.session, requestId: request.requestId,
    status: 'ok', pane: request.request.pane, revision: 4, entries: rows.map(n => d3Row(request.request.pane, n)),
    payloadBytes: 10, states: [{ kind: 'exact', auditedRevision: 4 }], before, after,
  };
}

function d3Open() {
  const mux = new TmuxMux();
  mux.subscribe('work', () => {});
  mux.subscribe('other', () => {});
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { mux, socket };
}

function d3Requests(socket: FakeWebSocket) {
  return socket.frames().filter(frame => frame.type === 'history_expand_v2');
}

describe('TmuxMux v2 history cursor (D3)', () => {
  test('sends the v2 pane and cursor on the wire and resolves only the matching reply, three pages back and forward', async () => {
    const { mux, socket } = d3Open();
    const pane = d3Descriptor(D3_PANE_A);
    let cursor: ReturnType<typeof d3Cursor> | null = null;
    for (let page = 0; page < 3; page++) {
      const pending = mux.requestHistoryV2('work', pane, { cursor, direction: 'before', maxEntries: 256 });
      expect(pending).not.toBeNull();
      const sent = d3Requests(socket).at(-1)!;
      expect(sent.session).toBe('work');
      expect(sent.request).toEqual({
        schema: 'newarch-v2', pane: D3_PANE_A, cursor, direction: 'before', maxEntries: 256, maxBytes: 2 * 1024 * 1024,
      });
      expect('beforeLine' in sent || 'afterLine' in sent).toBe(false);
      // a stray reply (wrong request id) and a reply on the wrong channel never resolve it
      socket.receive({ ...d3Reply(sent, [1], { kind: 'end' }), requestId: 'v2-nope' });
      const next = d3Cursor(D3_PANE_A, `before-${page}`);
      socket.receive(d3Reply(sent, [30 - page * 2, 31 - page * 2], { kind: 'more', cursor: next }, { kind: 'more', cursor: d3Cursor(D3_PANE_A, `after-${page}`) }));
      const result = await pending!;
      expect(result.kind).toBe('reply');
      if (result.kind !== 'reply' || result.reply.status !== 'ok') throw new Error('no ok reply');
      expect(result.reply.entries.map(e => e.kind === 'row' ? e.id.rowOrdinal : -1)).toEqual([30 - page * 2, 31 - page * 2]);
      cursor = result.reply.before.kind === 'more' ? result.reply.before.cursor : null;
    }
    const forward = mux.requestHistoryV2('work', pane, { cursor: d3Cursor(D3_PANE_A, 'after-2'), direction: 'after' });
    const sent = d3Requests(socket).at(-1)!;
    expect(sent.request.direction).toBe('after');
    expect(sent.request.cursor.token).toBe('after-2');
    socket.receive(d3Reply(sent, [28], { kind: 'more', cursor: d3Cursor(D3_PANE_A, 'b') }));
    expect((await forward!).kind).toBe('reply');
    expect(d3Requests(socket).map(f => f.request.cursor?.token ?? null)).toEqual([null, 'before-0', 'before-1', 'after-2']);
  });

  test('a reply carrying another pane, or an answer to another request, is a mismatch, never delivered rows', async () => {
    const { mux, socket } = d3Open();
    const pending = mux.requestHistoryV2('work', d3Descriptor(D3_PANE_A), { cursor: null, direction: 'before' });
    const sent = d3Requests(socket).at(-1)!;
    const foreign = d3Reply(sent, [], { kind: 'end' });
    foreign.entries = [d3Row(D3_PANE_B, 9)];
    socket.receive(foreign);
    expect(await pending!).toEqual({ kind: 'mismatch' });
  });

  test('a cursor of another pane identity is never sent: new pane, reused pane id, restarted server', () => {
    const { mux, socket } = d3Open();
    const reborn = { ...D3_PANE_A, birthGeneration: 2 };
    const restarted = { ...D3_PANE_A, serverIdentity: 'srv-2' };
    for (const pane of [D3_PANE_B, reborn, restarted]) {
      expect(mux.requestHistoryV2('work', d3Descriptor(pane), { cursor: d3Cursor(D3_PANE_A, 'stale'), direction: 'before' })).not.toBeNull();
      const sent = d3Requests(socket).at(-1)!;
      expect(sent.request.pane).toEqual(pane);
      expect(sent.request.cursor).toBeNull();
      socket.receive({ schema: 'newarch-v2', type: 'history_v2', channel: 'work', requestId: sent.requestId, status: 'error', pane, code: 'stale-cursor', retryAfterMs: null });
    }
    expect(JSON.stringify(socket.sent)).not.toContain('stale');
  });

  test('the session list selects the pane: a caller holding the old pane gets pane-changed and nothing is sent', async () => {
    const { mux, socket } = d3Open();
    socket.receive({ channel: '__sessions', type: 'sessions', data: JSON.stringify([
      { name: 'work', newarchV2: { kind: 'selected', pane: d3Descriptor(D3_PANE_B) } },
      { name: 'other' },
    ]) });
    expect(mux.newarchV2Pane('work')?.pane).toEqual(D3_PANE_B);
    expect(mux.newarchV2Pane('other')).toBeNull();
    const result = await mux.requestHistoryV2('work', d3Descriptor(D3_PANE_A), { cursor: d3Cursor(D3_PANE_A, 'old'), direction: 'before' })!;
    expect(result.kind).toBe('pane-changed');
    expect(d3Requests(socket)).toEqual([]);
  });

  test('reconnect settles the request as disconnected, and the same cursor is asked again on the new socket', async () => {
    jest.useFakeTimers();
    const { mux, socket } = d3Open();
    const pane = d3Descriptor(D3_PANE_A);
    const cursor = d3Cursor(D3_PANE_A, 'keep-me');
    const pending = mux.requestHistoryV2('work', pane, { cursor, direction: 'before' });
    const first = d3Requests(socket).at(-1)!;
    socket.finishClose();
    expect(await pending!).toEqual({ kind: 'disconnected' });
    // a late reply on the dead socket is not delivered anywhere
    socket.receive(d3Reply(first, [1], { kind: 'end' }));
    jest.advanceTimersByTime(30_000);
    const replacement = FakeWebSocket.instances.at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.open();
    const again = mux.requestHistoryV2('work', pane, { cursor, direction: 'before' });
    const second = d3Requests(replacement).at(-1)!;
    expect(second.request.cursor).toEqual(cursor);
    expect(second.requestId).not.toBe(first.requestId);
    replacement.receive(d3Reply(second, [5], { kind: 'end' }));
    expect((await again!).kind).toBe('reply');
  });

  test('two panes in two sessions keep separate requests; one request per session at a time', async () => {
    const { mux, socket } = d3Open();
    const a = mux.requestHistoryV2('work', d3Descriptor(D3_PANE_A), { cursor: null, direction: 'before' });
    const b = mux.requestHistoryV2('other', d3Descriptor(D3_PANE_B, 'sess-b'), { cursor: null, direction: 'before' });
    expect(mux.requestHistoryV2('work', d3Descriptor(D3_PANE_A), { cursor: null, direction: 'after' })).toBeNull();
    const [sentA, sentB] = d3Requests(socket);
    socket.receive(d3Reply(sentB!, [2], { kind: 'end' }));
    socket.receive(d3Reply(sentA!, [1], { kind: 'end' }));
    const [ra, rb] = await Promise.all([a!, b!]);
    if (ra.kind !== 'reply' || rb.kind !== 'reply' || ra.reply.status !== 'ok' || rb.reply.status !== 'ok') throw new Error('expected replies');
    expect(ra.reply.entries.map(e => e.kind === 'row' && e.id.pane.paneId)).toEqual(['%1']);
    expect(rb.reply.entries.map(e => e.kind === 'row' && e.id.pane.paneId)).toEqual(['%2']);
  });

  test('the last viewer leaving cancels its request and a late reply goes nowhere', async () => {
    const mux = new TmuxMux();
    const off = mux.subscribe('work', () => {});
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    const pending = mux.requestHistoryV2('work', d3Descriptor(D3_PANE_A), { cursor: null, direction: 'before' });
    const sent = d3Requests(socket).at(-1)!;
    off();
    expect(await pending!).toEqual({ kind: 'cancelled' });
    socket.receive(d3Reply(sent, [1], { kind: 'end' }));
  });
});

describe('TmuxMux v2 mutation controls (D3)', () => {
  const MUTANTS: ReadonlyArray<{ id: string; from: string; to: string; killer: string }> = [
    { id: 'send-foreign-cursor', from: 'cursor: newarchV2CursorFor(pane, ask.cursor),', to: 'cursor: ask.cursor,', killer: 'a cursor of another pane identity is never sent' },
    { id: 'deliver-unmatched-reply', from: "entry.resolve(matches ? { kind: 'reply', reply } : { kind: 'mismatch' });", to: "entry.resolve({ kind: 'reply', reply });", killer: 'is a mismatch, never delivered rows' },
    { id: 'disconnect-leaves-request', from: "this.settleV2Inflight(entry => entry.socket === socket, { kind: 'disconnected' });", to: '', killer: 'reconnect settles the request as disconnected' },
    { id: 'ignore-session-list-pane', from: '      return Promise.resolve({ kind: \'pane-changed\', pane: known });', to: '', killer: 'caller holding the old pane gets pane-changed' },
    { id: 'unbounded-inflight', from: '    for (const entry of this.v2Inflight.values()) if (entry.session === session) return null;', to: '', killer: 'one request per session at a time' },
  ];

  test.skipIf(process.env.D3_MUTANT_MUX_CLIENT !== undefined)('every client mutant is killed by its own case', () => {
    const source = new URL('../src/ws-mux.svelte.ts', import.meta.url).pathname;
    const mutant = new URL('../src/ws-mux.d3mutant.svelte.ts', import.meta.url).pathname;
    const original = readFileSync(source, 'utf8');
    const run = (module: string) => spawnSync(process.execPath, ['test', new URL(import.meta.url).pathname, '-t', 'D3'], {
      env: { ...process.env, D3_MUTANT_MUX_CLIENT: module }, encoding: 'utf8', timeout: 120_000,
    });
    const lines: string[] = [];
    try {
      writeFileSync(mutant, original);
      const control = run(mutant);
      lines.push(`D3-MUTANT control exit=${control.status}`);
      expect(control.status).toBe(0);
      for (const m of MUTANTS) {
        expect(original.split(m.from).length - 1).toBe(1);
        writeFileSync(mutant, original.replace(m.from, m.to));
        const result = run(mutant);
        const out = `${result.stdout}${result.stderr}`;
        const killed = out.split('\n').filter(line => line.startsWith('(fail)')).map(line => line.replace(/ \[[^\]]*\]$/, ''));
        lines.push(`D3-MUTANT ${m.id} exit=${result.status} killed=${JSON.stringify(killed)}`);
        expect(result.status).toBe(1);
        expect(out).not.toContain('SyntaxError');
        expect(killed.some(line => line.includes(m.killer))).toBe(true);
      }
    } finally {
      rmSync(mutant, { force: true });
      console.log(lines.join('\n'));
    }
  }, 900_000);
});
