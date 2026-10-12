/**
 * FS5 — MuxDeliveryMeta.screen is filled from wire frames and sticky across
 * deltas that omit screen. Cache is cleared with the other per-channel state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createMuxDeltaFrame,
  splitMuxOutputData,
  type MuxPaneScreen,
  type NewarchV2FixedGeometry,
} from '@thumbmux/core';
import { answerNewarchV2Geometry } from '../src/history-window';

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
}

const globalNames = ['window', 'document', 'navigator', 'WebSocket'] as const;
const originalGlobals = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

function setGlobal(name: typeof globalNames[number], value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type Delivery = {
  data: string;
  type: string | undefined;
  cursor: unknown;
  meta: { source: 'full' | 'delta'; replace: boolean; screen?: MuxPaneScreen | null } | undefined;
};

function openMux(session = 'terminal') {
  const mux = new TmuxMux();
  const deliveries: Delivery[] = [];
  const unsubscribe = mux.subscribe(session, (data, type, cursor, meta) => {
    deliveries.push({ data, type, cursor, meta });
  });
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { mux, socket, deliveries, unsubscribe, session };
}

const SCREEN_SGR: MuxPaneScreen = { alt: true, mouseSgr: true, mouseAny: false };
const SCREEN_LOCAL: MuxPaneScreen = { alt: false, mouseSgr: false, mouseAny: false };

beforeEach(() => {
  FakeWebSocket.instances = [];
  const fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' });
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

describe('TmuxMux MuxDeliveryMeta.screen (FS5)', () => {
  test('full frame with screen delivers meta.screen', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    socket.receive({
      channel: 'terminal',
      type: 'output',
      data: 'line-0\nline-1',
      screen: SCREEN_SGR,
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.meta).toEqual({
      source: 'full',
      replace: false,
      screen: SCREEN_SGR,
    });

    unsubscribe();
    socket.finishClose();
  });

  test('delta without screen reuses last known screen for the channel', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const baseData = 'one\ntwo\n';
    socket.receive({
      channel: 'terminal',
      type: 'output',
      data: baseData,
      screen: SCREEN_SGR,
    });
    const base = splitMuxOutputData(baseData);
    const delta = createMuxDeltaFrame(
      'terminal',
      base,
      splitMuxOutputData('one\ntwo\nthree\n'),
      { row: 2, col: 0 },
    );
    // createMuxDeltaFrame may omit screen — ensure it is absent.
    delete (delta as { screen?: MuxPaneScreen }).screen;
    socket.receive(delta);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.meta?.screen).toEqual(SCREEN_SGR);
    expect(deliveries[1]!.meta).toEqual({
      source: 'delta',
      replace: false,
      screen: SCREEN_SGR,
    });

    unsubscribe();
    socket.finishClose();
  });

  test('delta that carries a new screen updates the sticky cache', () => {
    const { socket, deliveries, unsubscribe } = openMux();
    const baseData = 'a\nb\n';
    socket.receive({
      channel: 'terminal',
      type: 'output',
      data: baseData,
      screen: SCREEN_SGR,
    });
    const base = splitMuxOutputData(baseData);
    const delta = createMuxDeltaFrame(
      'terminal',
      base,
      splitMuxOutputData('a\nb\nc\n'),
      { row: 2, col: 0 },
    );
    // The factory keeps its frozen 0.9.2 signature; `screen` rides on the frame,
    // which is exactly what chooseMuxOutputFrame does on the server.
    delta.screen = SCREEN_LOCAL;
    socket.receive(delta);

    expect(deliveries[1]!.meta?.screen).toEqual(SCREEN_LOCAL);

    // Next delta without screen must stick to the updated value.
    const base2 = splitMuxOutputData('a\nb\nc\n');
    const delta2 = createMuxDeltaFrame(
      'terminal',
      base2,
      splitMuxOutputData('a\nb\nc\nd\n'),
    );
    delete (delta2 as { screen?: MuxPaneScreen }).screen;
    socket.receive(delta2);
    expect(deliveries[2]!.meta?.screen).toEqual(SCREEN_LOCAL);

    unsubscribe();
    socket.finishClose();
  });

  test('unsubscribe clears screen cache so a recycled session name does not inherit', () => {
    const first = openMux('recycled');
    first.socket.receive({
      channel: 'recycled',
      type: 'output',
      data: 'old-pane',
      screen: SCREEN_SGR,
    });
    first.unsubscribe();
    first.socket.finishClose();

    const second = openMux('recycled');
    second.socket.receive({
      channel: 'recycled',
      type: 'output',
      data: 'new-pane',
      // no screen on this full frame
    });
    expect(second.deliveries).toHaveLength(1);
    expect(second.deliveries[0]!.meta).toEqual({
      source: 'full',
      replace: false,
    });
    expect(second.deliveries[0]!.meta).not.toHaveProperty('screen');

    second.unsubscribe();
    second.socket.finishClose();
  });
});

describe('NEWARCH v2 fixed geometry across viewers', () => {
  const geometry: NewarchV2FixedGeometry = {
    policy: 'fixed-at-birth', columns: 100, rows: 40,
    configVersion: 'q22-default-1', panesPerWindow: 1,
  };

  test('narrow, wide, font, rotation, keyboard, and applyGeometry all stay 100x40', () => {
    const intents = [
      { source: 'viewport' as const, columns: 40, rows: 24 },
      { source: 'viewport' as const, columns: 180, rows: 50 },
      { source: 'font' as const, columns: 70, rows: 30 },
      { source: 'rotation' as const, columns: 36, rows: 80 },
      { source: 'keyboard-inset' as const, columns: 40, rows: 18 },
      { source: 'fit-width' as const, columns: 100, rows: 40 },
      { source: 'apply-geometry' as const, columns: 120, rows: 50 },
    ];
    for (const intent of intents) {
      const answer = answerNewarchV2Geometry(geometry, intent);
      expect(answer.resize).toBeNull();
      expect(answer.status).toBe('fixed');
      expect(answer.geometry.columns).toBe(100);
      expect(answer.geometry.rows).toBe(40);
      expect(answer.geometry).toBe(geometry);
    }
  });
});

// --- D3: a v2 history reply never disturbs screen delivery (no loss / no duplicate) ---

const D3_PANE = { serverIdentity: 'srv-1', paneId: '%7', birthGeneration: 1 };
const D3_DESCRIPTOR = {
  schema: 'newarch-v2' as const, session: { serverIdentity: 'srv-1', sessionId: 'sess-7' }, pane: D3_PANE,
  windowId: '@7', owner: 'capture-engine' as const, birthOperationId: 'birth-7',
  geometry: { policy: 'fixed-at-birth' as const, columns: 78, rows: 120, configVersion: 'q22-default-1', panesPerWindow: 1 as const },
  state: 'active' as const,
};

function d3ReplyFor(socket: FakeWebSocket) {
  const sent = socket.sent.map(data => JSON.parse(data)).filter(frame => frame.type === 'history_expand_v2').at(-1);
  return {
    schema: 'newarch-v2', type: 'history_v2', channel: sent.session, requestId: sent.requestId, status: 'ok', pane: D3_PANE,
    revision: 1, entries: [{ kind: 'row', id: { pane: D3_PANE, segmentId: 's', rowOrdinal: 1 }, cells: [{ text: 'old', width: 1, style: [] }], wrapStatus: 'unwrapped', wrapPad: 0 }],
    payloadBytes: 10, states: [{ kind: 'exact', auditedRevision: null }], before: { kind: 'end' }, after: { kind: 'end' },
  };
}

describe('TmuxMux v2 history beside screen frames (D3)', () => {
  test('a v2 reply is not pane data and keeps the output base: the next delta applies without a resync', async () => {
    const { mux, socket, deliveries, unsubscribe } = openMux();
    socket.receive({ channel: 'terminal', type: 'output', data: 'one\ntwo\n', screen: SCREEN_LOCAL });
    const pending = mux.requestHistoryV2('terminal', D3_DESCRIPTOR, { cursor: null, direction: 'before' });
    socket.receive(d3ReplyFor(socket));
    expect((await pending!).kind).toBe('reply');
    socket.receive(createMuxDeltaFrame('terminal', splitMuxOutputData('one\ntwo\n'), splitMuxOutputData('one\ntwo\nthree\n'), { row: 2, col: 0 }));
    expect(deliveries.map(d => [d.type, d.data])).toEqual([['output', 'one\ntwo\n'], ['output', 'one\ntwo\nthree\n']]);
    expect(socket.sent.some(data => JSON.parse(data).type === 'resync')).toBe(false);
    unsubscribe();
    socket.finishClose();
  });

  test('screen deltas queued while busy are delivered before the v2 reply settles, once each', async () => {
    const mux = new TmuxMux();
    const deliveries: string[] = [];
    let busy = true;
    const unsubscribe = mux.subscribe('terminal', (data, type) => { if (type === 'output') deliveries.push(data); }, { deferWhileBusy: () => busy });
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.receive({ channel: 'terminal', type: 'output', data: 'a\n' });
    socket.receive(createMuxDeltaFrame('terminal', splitMuxOutputData('a\n'), splitMuxOutputData('a\nb\n'), null));
    expect(deliveries).toEqual(['a\n']);
    const pending = mux.requestHistoryV2('terminal', D3_DESCRIPTOR, { cursor: null, direction: 'before' });
    let seenAtSettle: string[] = [];
    void pending!.then(() => { seenAtSettle = [...deliveries]; });
    socket.receive(d3ReplyFor(socket));
    await pending;
    expect(seenAtSettle).toEqual(['a\n', 'a\nb\n']);
    busy = false;
    expect(deliveries).toEqual(['a\n', 'a\nb\n']);
    unsubscribe();
    socket.finishClose();
  });
});
