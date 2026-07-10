import { expect, test, type Page } from '@playwright/test';
import {
  capturePane,
  createLineSession,
  killSession,
  makeSessionName,
  openSession,
} from './helpers';

type OutputFrame = {
  channel: string;
  type: 'output';
  data: string;
  cursor?: unknown;
  reset?: unknown;
};

type DeltaFrame = {
  channel: string;
  type: 'delta';
  baseLength: number;
  prefix: number;
  prefixHash: string;
  lines: string[];
  cursor?: unknown;
};

type WireRecord = {
  index: number;
  raw: string;
  frame: OutputFrame | DeltaFrame;
};

const BASE_LINES = 180;
const UPDATE_COUNT = 45;

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function wireState(page: Page) {
  return page.evaluate(() => (window as any).__thumbmuxWire);
}

async function sendWireKeys(page: Page, session: string, data: string) {
  await page.evaluate(({ sessionName, payload }) => {
    const wire = (window as any).__thumbmuxWire;
    if (!wire.socket || wire.socket.readyState !== WebSocket.OPEN) throw new Error('wire socket is not open');
    wire.socket.send(JSON.stringify({ type: 'keys', session: sessionName, data: payload }));
  }, { sessionName: session, payload: data });
}

test('delta wire converges, resyncs a stale base, and saves suffix-heavy bytes', async ({ page }, testInfo) => {
  const session = makeSessionName(testInfo, 'wire');
  try {
    createLineSession(session, 'WIRE baseline', BASE_LINES);
    await page.addInitScript((sessionName) => {
      const nativeWebSocket = window.WebSocket;
      const state = {
        inbound: [] as Array<{ index: number; raw: string; frame: any }>,
        outbound: [] as any[],
        armStale: false,
        staleInjected: false,
        socket: null as WebSocket | null,
      };
      (window as any).__thumbmuxWire = state;
      const syntheticEvents = new WeakSet<MessageEvent>();

      window.WebSocket = class WireWebSocket extends nativeWebSocket {
        constructor(...args: ConstructorParameters<typeof nativeWebSocket>) {
          super(...args);
          state.socket = this;
          this.addEventListener('message', (event) => {
            if (syntheticEvents.has(event)) {
              syntheticEvents.delete(event);
              return;
            }
            if (typeof event.data !== 'string') return;
            try {
              const frame = JSON.parse(event.data);
              if (frame?.channel !== sessionName || (frame.type !== 'output' && frame.type !== 'delta')) return;
              state.inbound.push({ index: state.inbound.length, raw: event.data, frame });
              if (state.armStale && !state.staleInjected && frame.type === 'delta') {
                state.armStale = false;
                state.staleInjected = true;
                event.stopImmediatePropagation();
                const stale = { ...frame, baseLength: frame.baseLength + 1 };
                const replacement = new MessageEvent('message', { data: JSON.stringify(stale) });
                syntheticEvents.add(replacement);
                queueMicrotask(() => this.dispatchEvent(replacement));
              }
            } catch {
              // Non-protocol traffic is outside this probe.
            }
          });
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          if (typeof data === 'string') {
            try {
              const message = JSON.parse(data);
              if (message?.type === 'resync' && message.session === sessionName) state.outbound.push(message);
            } catch {
              // The normal socket implementation handles non-JSON traffic.
            }
          }
          super.send(data);
        }
      };
    }, session);

    await openSession(page, session);
    await expect.poll(async () => (await wireState(page)).inbound.some((entry: WireRecord) => entry.frame.type === 'output')).toBe(true);
    await page.waitForTimeout(400);

    const baselineEnd = (await wireState(page)).inbound.length;
    await page.evaluate(() => { (window as any).__thumbmuxWire.armStale = true; });

    const finalMarker = `WIRE update ${String(UPDATE_COUNT).padStart(3, '0')} suffix-heavy payload`;
    for (let update = 1; update <= UPDATE_COUNT; update++) {
      const marker = `WIRE update ${String(update).padStart(3, '0')} suffix-heavy payload`;
      const before = (await wireState(page)).inbound.length;
      await sendWireKeys(page, session, `printf '%s\\n' '${marker} 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'`);
      await sendWireKeys(page, session, '\r');
      await expect.poll(async () => (await wireState(page)).inbound.length, { timeout: 5_000 }).toBeGreaterThan(before);
      await expect.poll(() => capturePane(session, -250).split(marker).length - 1, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    }
    await expect.poll(async () => {
      const state = await wireState(page);
      return state.inbound.some((entry: WireRecord) => entry.raw.includes(finalMarker));
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await wireState(page)).staleInjected, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await wireState(page)).outbound.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await wireState(page)).inbound.some((entry: WireRecord) => (
      entry.frame.type === 'output' && entry.frame.reset === 'resync'
    )), { timeout: 20_000 }).toBe(true);

    const state = await wireState(page);
    const records = state.inbound as WireRecord[];
    expect(records[0]?.frame.type).toBe('output');

    let base: string[] | null = null;
    let finalData = '';
    let deltaCount = 0;
    let postBaselineActual = 0;
    let postBaselineFull = 0;

    for (const record of records) {
      const { frame } = record;
      let next: string[];
      let counterfactual: OutputFrame;
      if (frame.type === 'output') {
        expect(typeof frame.data).toBe('string');
        next = frame.data.split('\n');
        counterfactual = frame;
      } else {
        expect(base).not.toBeNull();
        expect(Number.isInteger(frame.baseLength)).toBe(true);
        expect(Number.isInteger(frame.prefix)).toBe(true);
        expect(frame.baseLength).toBe(base!.length);
        expect(frame.prefix).toBeGreaterThanOrEqual(0);
        expect(frame.prefix).toBeLessThanOrEqual(base!.length);
        expect(frame.prefixHash).toBe(fnv1a32(JSON.stringify(base!.slice(0, frame.prefix))));
        expect(frame.lines.every((line) => typeof line === 'string')).toBe(true);
        next = base!.slice(0, frame.prefix).concat(frame.lines);
        counterfactual = {
          channel: frame.channel,
          type: 'output',
          data: next.join('\n'),
          ...(Object.prototype.hasOwnProperty.call(frame, 'cursor') ? { cursor: frame.cursor } : {}),
        };
        deltaCount++;
      }

      base = next;
      finalData = next.join('\n');
      if (record.index >= baselineEnd) {
        postBaselineActual += utf8Size(record.raw);
        postBaselineFull += utf8Size(JSON.stringify(counterfactual));
      }
    }

    expect(deltaCount).toBeGreaterThanOrEqual(40);
    expect(postBaselineActual).toBeLessThan(postBaselineFull);
    const saved = postBaselineFull - postBaselineActual;
    const percent = (saved / postBaselineFull) * 100;
    console.log(`delta-wire actual=${postBaselineActual} full=${postBaselineFull} saved=${saved} percent=${percent.toFixed(2)}`);
    expect(percent).toBeGreaterThanOrEqual(70);

    await expect.poll(() => capturePane(session, -250).includes(finalMarker), { timeout: 20_000 }).toBe(true);
    expect(finalData).toBe(capturePane(session, -250));
  } finally {
    killSession(session);
  }
});
