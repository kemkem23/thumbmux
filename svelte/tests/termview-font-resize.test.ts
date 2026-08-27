/**
 * Font-size changes must paint immediately and send ONE tmux resize after
 * the burst settles. Viewport ResizeObserver stays undebounced.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Component } from 'svelte';
import { flushSync, mount, tick, unmount } from './svelte-client';
import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import type { AnsiPalette } from '@thumbmux/core';

const require = createRequire(import.meta.url);
const svelteClientInternals = join(
  dirname(require.resolve('svelte/package.json')),
  'src/internal/client/index.js',
);
const { proxy } = (await import(svelteClientInternals)) as {
  proxy: <T extends object>(value: T) => T;
};

const palette: AnsiPalette = {
  defaultFg: '#eeeeee',
  defaultBg: '#111111',
  base: Array.from({ length: 16 }, () => '#111111'),
};

const SESSION = 'sh-font-resize';
const SETTLE_MS = 220;

type TermViewProps = {
  session: string;
  palette: AnsiPalette;
  claimGeometry: boolean;
  fontPx: number;
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  props: TermViewProps;
  viewport: HTMLElement;
};

const mounted: Mounted[] = [];
let resizeCalls: Array<{ session: string; cols: number; rows: number }> = [];
let originalSendResize: typeof tmuxMux.sendResize;
let originalSubscribe: typeof tmuxMux.subscribe;
let originalResizeObserver: typeof ResizeObserver;
let originalWindowResizeObserver: typeof ResizeObserver;
let originalDocumentFontsDescriptor: PropertyDescriptor | undefined;
let originalCanvasGetContextDescriptor: PropertyDescriptor | undefined;
let controlledCellWidth = 7.8;

class ControlledFontFaceSet {
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();
  private resolveReady!: (value: FontFaceSet) => void;
  private readySettled = false;

  readonly ready = new Promise<FontFaceSet>((resolve) => {
    this.resolveReady = resolve;
  });

  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (type === 'loadingdone' && callback) this.listeners.add(callback);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (type === 'loadingdone' && callback) this.listeners.delete(callback);
  }

  settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady(this as unknown as FontFaceSet);
  }

  loadingDone(): void {
    const event = new Event('loadingdone');
    for (const callback of [...this.listeners]) {
      if (typeof callback === 'function') callback.call(this as unknown as EventTarget, event);
      else callback.handleEvent(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class ControlledResizeObserver implements ResizeObserver {
  static latest: ControlledResizeObserver | null = null;
  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.latest = this;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([], this);
  }
}

function mountTermView(overrides: Partial<TermViewProps> = {}): Mounted {
  const target = document.createElement('div');
  target.style.cssText = 'position:relative;width:320px;height:420px;';
  document.body.appendChild(target);
  const props = proxy({
    session: SESSION,
    palette,
    claimGeometry: true,
    fontPx: 13,
    ...overrides,
  }) as TermViewProps;
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, { target, props }) as Record<string, unknown>;
  });
  const viewport = target.querySelector('[data-testid="mtv"]') as HTMLElement | null;
  if (!viewport) throw new Error('TermView root not found');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => 420 },
  });
  ControlledResizeObserver.latest?.fire();
  flushSync();
  const entry = { app, target, props, viewport };
  mounted.push(entry);
  return entry;
}

function installControlledFonts(initialCellWidth: number): ControlledFontFaceSet {
  controlledCellWidth = initialCellWidth;
  const fonts = new ControlledFontFaceSet();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: fonts,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      font: '',
      measureText: (text: string) => ({ width: controlledCellWidth * text.length }),
    }),
  });
  return fonts;
}

async function settleMount(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  resizeCalls = [];
}

function cssCellWidth(viewport: HTMLElement): number {
  return Number.parseFloat(viewport.style.getPropertyValue('--mtv-cw'));
}

beforeEach(() => {
  resizeCalls = [];
  ControlledResizeObserver.latest = null;
  originalSendResize = tmuxMux.sendResize;
  originalSubscribe = tmuxMux.subscribe;
  tmuxMux.sendResize = ((session: string, cols: number, rows: number) => {
    resizeCalls.push({ session, cols, rows });
  }) as typeof tmuxMux.sendResize;
  tmuxMux.subscribe = (() => () => {}) as typeof tmuxMux.subscribe;
  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  originalDocumentFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  originalCanvasGetContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext',
  );
  globalThis.ResizeObserver = ControlledResizeObserver;
  window.ResizeObserver = ControlledResizeObserver;
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try { unmount(entry.app); } catch { /* torn down */ }
    entry.target.remove();
  }
  tmuxMux.sendResize = originalSendResize;
  tmuxMux.subscribe = originalSubscribe;
  globalThis.ResizeObserver = originalResizeObserver;
  window.ResizeObserver = originalWindowResizeObserver;
  if (originalDocumentFontsDescriptor) {
    Object.defineProperty(document, 'fonts', originalDocumentFontsDescriptor);
  } else {
    Reflect.deleteProperty(document, 'fonts');
  }
  if (originalCanvasGetContextDescriptor) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      'getContext',
      originalCanvasGetContextDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
  }
});

describe('TermView font-driven resize debounce (BRIEF-H)', () => {
  test('a burst of 8 font changes paints every tap and sends one resize', async () => {
    const { viewport, props } = mountTermView({ fontPx: 13 });
    await tick();
    // Mount sends one resize now and another on the next frame — wait those out.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterMount = resizeCalls.length;
    expect(afterMount).toBeGreaterThan(0);

    const sizes: string[] = [];
    for (let i = 1; i <= 8; i += 1) {
      flushSync(() => {
        props.fontPx = 13 + i;
      });
      await tick();
      sizes.push(viewport.style.fontSize);
    }
    expect(sizes).toEqual(['14px', '15px', '16px', '17px', '18px', '19px', '20px', '21px']);
    expect(resizeCalls.length).toBe(afterMount);

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 40));
    await tick();
    expect(resizeCalls.length).toBe(afterMount + 1);
    const last = resizeCalls.at(-1);
    expect(last?.session).toBe(SESSION);
    expect(last?.cols).toBeGreaterThan(0);
    expect(last?.rows).toBeGreaterThan(0);
  });

  test('a single font change still resizes after the settle window', async () => {
    const { props } = mountTermView({ fontPx: 13 });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterMount = resizeCalls.length;
    flushSync(() => {
      props.fontPx = 16;
    });
    await tick();
    expect(resizeCalls.length).toBe(afterMount);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 40));
    await tick();
    expect(resizeCalls.length).toBe(afterMount + 1);
  });

  test('ResizeObserver still resizes immediately during a font burst', async () => {
    const { props } = mountTermView({ fontPx: 13 });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterMount = resizeCalls.length;
    flushSync(() => {
      props.fontPx = 18;
    });
    await tick();
    expect(resizeCalls.length).toBe(afterMount);
    ControlledResizeObserver.latest?.fire();
    flushSync();
    expect(resizeCalls.length).toBeGreaterThan(afterMount);
  });

  test('unmount flushes a pending font resize so the last size is not lost', async () => {
    const { props, app, target } = mountTermView({ fontPx: 13 });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterMount = resizeCalls.length;
    flushSync(() => {
      props.fontPx = 20;
    });
    await tick();
    expect(resizeCalls.length).toBe(afterMount);
    unmount(app);
    target.remove();
    mounted.pop();
    expect(resizeCalls.length).toBe(afterMount + 1);
  });
});

describe('TermView late web-font geometry', () => {
  test('remeasures after document.fonts.ready and sends one changed grid size', async () => {
    const fonts = installControlledFonts(6);
    const { viewport } = mountTermView();
    await settleMount();
    expect(cssCellWidth(viewport)).toBe(6);

    controlledCellWidth = 8;
    fonts.settleReady();
    await Promise.resolve();
    await tick();

    expect(cssCellWidth(viewport)).toBe(8);
    expect(resizeCalls).toEqual([{ session: SESSION, cols: 38, rows: 20 }]);
  });

  test('coalesces ready and loadingdone when both report the same metric', async () => {
    const fonts = installControlledFonts(6);
    const { viewport } = mountTermView();
    await settleMount();

    controlledCellWidth = 9;
    fonts.loadingDone();
    fonts.settleReady();
    await Promise.resolve();
    await tick();

    expect(cssCellWidth(viewport)).toBe(9);
    expect(resizeCalls).toEqual([{ session: SESSION, cols: 34, rows: 20 }]);
  });

  test('handles a later loadingdone without sending duplicate unchanged resizes', async () => {
    const fonts = installControlledFonts(6);
    const { viewport } = mountTermView();
    await settleMount();
    fonts.settleReady();
    await Promise.resolve();
    resizeCalls = [];

    controlledCellWidth = 8;
    fonts.loadingDone();
    await tick();
    expect(cssCellWidth(viewport)).toBe(8);
    expect(resizeCalls).toHaveLength(1);

    fonts.loadingDone();
    await tick();
    expect(resizeCalls).toHaveLength(1);
  });

  test('repaints a changed cell metric even when the rounded grid is unchanged', async () => {
    const fonts = installControlledFonts(8);
    const { viewport } = mountTermView();
    await settleMount();

    controlledCellWidth = 8.01;
    fonts.loadingDone();
    await tick();

    expect(cssCellWidth(viewport)).toBeCloseTo(8.01, 5);
    expect(resizeCalls).toHaveLength(0);
  });

  test('removes its listener and ignores an unresolved ready promise after unmount', async () => {
    const fonts = installControlledFonts(6);
    const { app, target } = mountTermView();
    await settleMount();
    expect(fonts.listenerCount).toBe(1);

    unmount(app);
    target.remove();
    mounted.pop();
    expect(fonts.listenerCount).toBe(0);

    controlledCellWidth = 8;
    fonts.loadingDone();
    fonts.settleReady();
    await Promise.resolve();
    await tick();
    expect(resizeCalls).toHaveLength(0);
  });
});
