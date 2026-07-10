import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createMuxDeltaFrame,
  muxPrefixHash,
  splitMuxOutputData,
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

const globalNames = ['window', 'document', 'navigator', 'WebSocket'] as const;
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

let fakeDocument: FakeEventTarget & { visibilityState: string };

function setGlobal(name: typeof globalNames[number], value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function openMux() {
  const mux = new TmuxMux();
  const deliveries: Array<{
    data: string;
    type: string | undefined;
    cursor: unknown;
    meta: unknown;
  }> = [];
  const unsubscribe = mux.subscribe('terminal', (data, type, cursor, meta) => {
    deliveries.push({ data, type, cursor, meta });
  });
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { mux, socket, deliveries, unsubscribe };
}

function full(data: string, extra: Record<string, unknown> = {}) {
  return { channel: 'terminal', type: 'output', data, ...extra };
}

function validDelta(base: string[], lines = ['one', 'changed', '']) {
  return createMuxDeltaFrame('terminal', base, lines, { row: 3, col: 4 });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
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

describe('TmuxMux delta delivery', () => {
  test('reconstructs Unicode and trailing empty lines, while legacy callbacks still receive output', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const legacy: string[] = [];
    const stopLegacy = new TmuxMux();
    const stop = stopLegacy.subscribe('legacy', (data, type, cursor) => {
      if (type === 'output' && cursor?.row === 7) legacy.push(data);
    });

    socket.receive(full('ไทย\n😀\n', { cursor: { row: 1, col: 2 } }));
    const base = splitMuxOutputData('ไทย\n😀\n');
    const delta = createMuxDeltaFrame(
      'terminal',
      base,
      splitMuxOutputData('ไทย\n😀\nใหม่\n'),
      { row: 3, col: 4 },
    );
    socket.receive(delta);

    expect(deliveries).toEqual([
      {
        data: 'ไทย\n😀\n',
        type: 'output',
        cursor: { row: 1, col: 2 },
        meta: { source: 'full', replace: false },
      },
      {
        data: 'ไทย\n😀\nใหม่\n',
        type: 'output',
        cursor: { row: 3, col: 4 },
        meta: { source: 'delta', replace: false },
      },
    ]);

    const legacySocket = FakeWebSocket.instances.at(-1)!;
    legacySocket.open();
    legacySocket.receive({ channel: 'legacy', type: 'output', data: 'legacy base' });
    legacySocket.receive(createMuxDeltaFrame('legacy', ['legacy base'], ['legacy changed'], { row: 7, col: 0 }));
    expect(legacy).toEqual(['legacy changed']);

    unsubscribe();
    socket.finishClose();
    stop();
    legacySocket.finishClose();
  });

  test('rejects each invalid delta without delivering content or cursor and sends one resync until full', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const base = ['one', 'two', ''];
    const good = validDelta(base);
    const invalid: MuxDeltaFrame[] = [
      { ...good, baseLength: 2 },
      { ...good, baseLength: 3.5 },
      { ...good, prefix: -1 },
      { ...good, prefix: 4 },
      { ...good, prefix: 1.5 },
      { ...good, prefixHash: '00000000' },
      { ...good, lines: ['changed', 2] as unknown as string[] },
      { ...good, cursor: { row: 0.5, col: 1 } as unknown as { row: number; col: number } },
    ];

    for (const frame of invalid) {
      socket.receive(full(base.join('\n'), { cursor: { row: 9, col: 9 } }));
      const beforeDeliveries = deliveries.length;
      const beforeResync = socket.frames('resync').length;
      socket.receive(frame);
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync + 1);

      // Repeated broken frames are ignored until a complete frame arrives.
      socket.receive({ ...frame, cursor: { row: 99, col: 99 } });
      expect(deliveries).toHaveLength(beforeDeliveries);
      expect(socket.frames('resync')).toHaveLength(beforeResync + 1);
    }

    unsubscribe();
    socket.finishClose();
  });

  test('resyncs a delta that arrives before any full base, then accepts a new full/reset', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const delta = validDelta(['one', 'two', '']);

    socket.receive(delta);
    socket.receive(delta);
    expect(deliveries).toEqual([]);
    expect(socket.frames('resync')).toEqual([{ type: 'resync', session: 'terminal' }]);

    socket.receive(full('one\ntwo\n', { cursor: { row: 2, col: 0 }, reset: 'resync' }));
    expect(deliveries).toEqual([
      {
        data: 'one\ntwo\n',
        type: 'output',
        cursor: { row: 2, col: 0 },
        meta: { source: 'full', replace: true },
      },
    ]);

    unsubscribe();
    socket.finishClose();
  });

  test('invalidates the base on reconnect, tail changes, and final unsubscribe', () => {
    const { mux, socket, deliveries, unsubscribe } = openMux();
    expect(socket.frames('subscribe')).toEqual([
      expect.objectContaining({ session: 'terminal', delta: true }),
    ]);
    socket.receive(full('one\ntwo\n'));
    const stale = validDelta(['one', 'two', '']);

    socket.finishClose();
    fakeDocument.emit('visibilitychange');
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.open();
    expect(replacement.frames('subscribe')).toEqual([
      expect.objectContaining({ session: 'terminal', delta: true }),
    ]);
    const beforeReconnect = deliveries.length;
    replacement.receive(stale);
    expect(deliveries).toHaveLength(beforeReconnect);
    expect(replacement.frames('resync')).toEqual([{ type: 'resync', session: 'terminal' }]);

    replacement.receive(full('one\ntwo\n'));
    const tailStop = mux.subscribe('terminal', () => {}, { tail: 2 });
    // A full viewer still wins, so remove it to change the outgoing tail.
    unsubscribe();
    expect(replacement.frames('subscribe')).toEqual([
      expect.objectContaining({ session: 'terminal', delta: true }),
      expect.objectContaining({ session: 'terminal', tail: 2, delta: true }),
    ]);
    const beforeTail = deliveries.length;
    replacement.receive(stale);
    expect(deliveries).toHaveLength(beforeTail);
    expect(replacement.frames('resync')).toHaveLength(2);

    tailStop();
    const restartDeliveries: string[] = [];
    const restart = mux.subscribe('terminal', (data, type) => {
      if (type === 'output') restartDeliveries.push(data);
    });
    const beforeUnsubscribe = replacement.frames('resync').length;
    replacement.receive(stale);
    expect(restartDeliveries).toEqual([]);
    expect(replacement.frames('resync')).toHaveLength(beforeUnsubscribe + 1);

    restart();
    replacement.finishClose();
  });

  test('marks resize full replacements without changing cursor-only delivery', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    socket.receive(full('reflowed', { cursor: { row: 1, col: 0 }, reset: 'resize' }));
    socket.receive({ channel: 'terminal', type: 'cursor', cursor: { row: 2, col: 3 } });

    expect(deliveries).toEqual([
      {
        data: 'reflowed',
        type: 'output',
        cursor: { row: 1, col: 0 },
        meta: { source: 'full', replace: true },
      },
      {
        data: '',
        type: 'cursor',
        cursor: { row: 2, col: 3 },
        meta: undefined,
      },
    ]);

    unsubscribe();
    socket.finishClose();
  });

  test('uses the protocol hash value in invalid test vectors', () => {
    expect(muxPrefixHash(['one', 'two'])).toBe('83ed0eef');
  });
});
