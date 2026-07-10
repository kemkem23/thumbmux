import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

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

  frames() {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

const globalNames = ['window', 'document', 'navigator', 'WebSocket'] as const;
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
