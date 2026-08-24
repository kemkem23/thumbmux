import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createMuxDeltaFrame } from '@thumbmux/core';

const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state');
Object.defineProperty(globalThis, '$state', {
  configurable: true,
  value: <T>(value: T) => value,
});

const { TmuxMux } = await import('../src/ws-mux.svelte');

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
