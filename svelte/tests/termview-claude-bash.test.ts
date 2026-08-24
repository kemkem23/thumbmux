/**
 * TermView integration coverage for Claude Bash presentation.
 *
 * Core tests prove the detector. These tests prove that collapsing its ranges
 * does not replace TermView's canonical raw buffer or raw coordinate systems.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { proxy as reactiveProps } from 'svelte/internal/client';
import { flushSync, mount, tick, unmount } from './svelte-client';

import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import type {
  AnsiPalette,
  ClaudeBashMode,
  ClaudeBashSummaries,
  ClaudeBashSummaryRequest,
} from '@thumbmux/core';

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: {
    source: 'full' | 'delta';
    replace: boolean;
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
  },
) => void;

type SummaryHandler = (
  requests: readonly ClaudeBashSummaryRequest[],
) => ClaudeBashSummaries | void | Promise<ClaudeBashSummaries | void>;

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  viewport: HTMLElement;
  props: { claudeBashMode: ClaudeBashMode };
};

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

const palette: AnsiPalette = {
  defaultFg: '#eeeeee',
  defaultBg: '#111111',
  base: [
    '#000000', '#aa0000', '#00aa00', '#aa5500',
    '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
    '#555555', '#ff5555', '#55ff55', '#ffff55',
    '#5555ff', '#ff55ff', '#55ffff', '#ffffff',
  ],
};

const COMPLETED_WITH_CARRIED_RED = [
  'before',
  '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(cd repo',
  "      sed -n '1,80p' src/a.ts)",
  '\x1b[38;5;246m  ⎿ \u00a0\x1b[31mfirst',
  '     rest',
  '● ต่อไป',
  'after',
];

const ACTIVE = [
  '\x1b[38;5;246m \x1b[39m \x1b[1mBash\x1b[0m(rg -n Bash src',
  '      tests)',
];

const mounted: Mounted[] = [];
let sessionCallback: MuxCallback | null = null;
let historyRequests = 0;
let originalSubscribeDescriptor: PropertyDescriptor | undefined;
let originalRequestHistoryDescriptor: PropertyDescriptor | undefined;
let originalResizeObserverDescriptor: PropertyDescriptor | undefined;
let originalWindowResizeObserverDescriptor: PropertyDescriptor | undefined;
let originalRequestIdleDescriptor: PropertyDescriptor | undefined;
let originalCancelIdleDescriptor: PropertyDescriptor | undefined;

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  sessionCallback = null;
  historyRequests = 0;
  ControlledResizeObserver.latest = null;
  originalSubscribeDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, 'subscribe');
  originalRequestHistoryDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, 'requestHistory');
  originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  originalWindowResizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  originalRequestIdleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  originalCancelIdleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback');

  tmuxMux.subscribe = ((_session: string, callback: MuxCallback) => {
    sessionCallback = callback;
    return () => {
      if (sessionCallback === callback) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;
  tmuxMux.requestHistory = (() => {
    historyRequests += 1;
    return true;
  }) as typeof tmuxMux.requestHistory;

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ControlledResizeObserver,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ControlledResizeObserver,
  });

  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: (callback: IdleRequestCallback) => setTimeout(() => callback({
      didTimeout: false,
      timeRemaining: () => 50,
    }), 0),
  });
  Object.defineProperty(globalThis, 'cancelIdleCallback', {
    configurable: true,
    writable: true,
    value: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try { unmount(entry.app); } catch { /* already torn down */ }
    entry.target.remove();
  }
  restoreProperty(tmuxMux, 'subscribe', originalSubscribeDescriptor);
  restoreProperty(tmuxMux, 'requestHistory', originalRequestHistoryDescriptor);
  restoreProperty(globalThis, 'ResizeObserver', originalResizeObserverDescriptor);
  restoreProperty(window, 'ResizeObserver', originalWindowResizeObserverDescriptor);
  restoreProperty(globalThis, 'requestIdleCallback', originalRequestIdleDescriptor);
  restoreProperty(globalThis, 'cancelIdleCallback', originalCancelIdleDescriptor);
});

function mountView(
  mode: ClaudeBashMode,
  options: {
    height?: number;
    onSummary?: SummaryHandler;
    onLinesChange?: (lines: string[]) => void;
  } = {},
): Mounted {
  const target = document.createElement('div');
  target.style.cssText = `position:relative;width:320px;height:${options.height ?? 240}px;`;
  document.body.appendChild(target);

  const props = reactiveProps({
    session: `cc-bash-${mode}-${mounted.length}`,
    palette,
    claimGeometry: false,
    fontPx: 13,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
    claudeBashMode: mode,
    onClaudeBashSummaryRequest: options.onSummary,
    onLinesChange: options.onLinesChange
      ? (lines: string[]) => options.onLinesChange?.(lines)
      : undefined,
  });
  let app: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props,
    }) as Record<string, unknown>;
  });

  const viewport = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!viewport) throw new Error('TermView viewport did not mount');
  const height = options.height ?? 240;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => height },
  });
  viewport.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: height,
    width: 320, height,
    toJSON: () => ({}),
  }) as DOMRect;
  ControlledResizeObserver.latest?.fire();

  const entry = { app: app!, target, viewport, props };
  mounted.push(entry);
  return entry;
}

function deliver(
  lines: readonly string[],
  replace = true,
  cursor: { row: number; col: number } | null = null,
): void {
  if (!sessionCallback) throw new Error('TermView did not subscribe');
  sessionCallback(lines.join('\n'), 'output', cursor, {
    source: 'full',
    replace,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
  });
  flushSync();
}

async function settleUi(): Promise<void> {
  await Promise.resolve();
  await tick();
  flushSync();
}

function visibleText(viewport: HTMLElement): string[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>('.mtv-line'), (line) =>
    (line.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''),
  );
}

function wheelUp(viewport: HTMLElement, pixels = 1_000_000): void {
  viewport.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -pixels,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    bubbles: true,
    cancelable: true,
  }));
  flushSync();
}

function layerTranslateY(viewport: HTMLElement): number {
  const transform = viewport.querySelector<HTMLElement>('.mtv-layer')?.style.transform ?? '';
  const match = /translate3d\(0(?:px)?,\s*(-?\d+(?:\.\d+)?)px,\s*0(?:px)?\)/.exec(transform);
  if (!match?.[1]) throw new Error(`missing layer translate: ${transform}`);
  return Number(match[1]);
}

function projectedScreenY(viewport: HTMLElement, row: HTMLElement): number {
  const first = viewport.querySelector<HTMLElement>('.mtv-line');
  if (!first) throw new Error('virtual window has no first row');
  return (
    Number(row.getAttribute('data-presentation-top'))
    - Number(first.getAttribute('data-presentation-top'))
    + layerTranslateY(viewport)
  );
}

function asTouchList(points: Array<{ clientX: number; clientY: number }>): TouchList {
  const list = points.slice() as Array<{ clientX: number; clientY: number }> & {
    item(index: number): Touch | null;
  };
  list.item = (index: number) => (list[index] as Touch | undefined) ?? null;
  return list as unknown as TouchList;
}

function touchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend',
  touches: Array<{ clientX: number; clientY: number }>,
  changedTouches = touches,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperties(event, {
    touches: { value: asTouchList(touches) },
    targetTouches: { value: asTouchList(touches) },
    changedTouches: { value: asTouchList(changedTouches) },
  });
  return event;
}

describe('TermView Claude Bash projection', () => {
  test('off mode keeps raw rows byte-canonical for rendering, callback, and copyAll', async () => {
    const delivered: string[][] = [];
    const { app, viewport } = mountView('off', {
      onLinesChange: (lines) => delivered.push([...lines]),
    });
    deliver(COMPLETED_WITH_CARRIED_RED);
    await settleUi();

    expect(viewport.getAttribute('data-total')).toBe(String(COMPLETED_WITH_CARRIED_RED.length));
    expect(viewport.getAttribute('data-raw-total')).toBe(String(COMPLETED_WITH_CARRIED_RED.length));
    expect(viewport.querySelector('.mtv-bash-placeholder')).toBeNull();
    expect(visibleText(viewport)).toContain("      sed -n '1,80p' src/a.ts)");
    expect(delivered.at(-1)).toEqual(COMPLETED_WITH_CARRIED_RED);

    const nav = navigator as Navigator & { clipboard?: { writeText(text: string): Promise<void> } };
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(nav, 'clipboard');
    let copied = '';
    Object.defineProperty(nav, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text; } },
    });
    try {
      const copyAll = app.copyAll as (() => Promise<boolean>) | undefined;
      expect(await copyAll?.()).toBe(true);
      expect(copied).toContain("sed -n '1,80p' src/a.ts)");
      expect(copied).toContain('first');
      expect(copied).not.toContain('Bash ซ่อนอยู่');
    } finally {
      restoreProperty(nav, 'clipboard', clipboardDescriptor);
    }
  });

  test('hide mode maps raw search hits to one placeholder and carries ANSI through hidden rows', async () => {
    const { viewport } = mountView('hide');
    deliver(COMPLETED_WITH_CARRIED_RED);
    await settleUi();

    expect(viewport.getAttribute('data-total')).toBe('4');
    expect(viewport.getAttribute('data-raw-total')).toBe('7');
    const placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    expect(placeholder?.textContent).toBe('hidden bash');
    expect(placeholder?.getAttribute('data-raw-start')).toBe('1');
    expect(placeholder?.getAttribute('data-raw-end')).toBe('5');
    expect(placeholder?.classList.contains('mtv-bash-hidden')).toBe(true);

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    expect(lineHeight).toBe(21);
    expect(Number(placeholder?.getAttribute('data-presentation-top'))).toBe(lineHeight);
    expect(Number(placeholder?.getAttribute('data-presentation-height'))).toBe(lineHeight / 3);
    expect(placeholder?.style.height).toBe(`${lineHeight / 3}px`);

    const boundary = viewport.querySelector<HTMLElement>('[data-raw-start="5"]');
    expect(boundary?.textContent).toContain('ต่อไป');
    expect(Number(boundary?.getAttribute('data-presentation-top'))).toBe(
      lineHeight + lineHeight / 3,
    );
    expect(viewport.getAttribute('data-presentation-height')).toBe('70');
    // Output ends in SGR red with no reset. The visible boundary must inherit
    // that state even though every Bash output row is visually absent.
    expect(boundary?.innerHTML).toContain('color:#aa0000');

    viewport.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    flushSync();
    const input = viewport.querySelector<HTMLInputElement>('[data-testid="term-search-input"]');
    if (!input) throw new Error('search input did not open');
    input.value = 'first';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settleUi();

    expect(viewport.querySelector('[data-testid="term-search-match"]')?.textContent).toContain('1 matches');
    expect(
      viewport.querySelector('.mtv-bash-placeholder .search-active')?.textContent,
    ).toContain('hidden bash');
  });

  test('placeholder uses neutral UI style while hidden raw rows still carry SGR and OSC state', async () => {
    const { viewport } = mountView('hide');
    deliver([
      '\x1b[30;2m\x1b]8;;https://wrong.example\x07preceding',
      '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf red)',
      '  ⎿  \x1b[31mred-output',
      '● following',
    ]);
    await settleUi();

    const placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    expect(placeholder?.textContent).toContain('hidden bash');
    expect(placeholder?.querySelector('a')).toBeNull();
    expect(placeholder?.innerHTML).not.toContain('color:#000000');
    expect(placeholder?.innerHTML).not.toContain('opacity:0.7');

    const following = viewport.querySelector<HTMLElement>('[data-raw-start="3"]');
    expect(following?.innerHTML).toContain('color:#aa0000');
    expect(following?.querySelector('a')?.getAttribute('href')).toBe('https://wrong.example');
  });

  test('many one-third hide dividers have exact cumulative height and leave no phantom rows', async () => {
    const { viewport } = mountView('hide', { height: 63 });
    const blockCount = 100;
    const lines = Array.from({ length: blockCount }, (_, index) => [
      `● Bash(printf compact-${index})`,
      `  ⎿  output-${index}`,
      `● semantic-boundary-${index}`,
    ]).flat();
    deliver(lines);
    await settleUi();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    const markerHeight = lineHeight / 3;
    const expectedHeight = blockCount * (markerHeight + lineHeight);
    expect(viewport.getAttribute('data-total')).toBe(String(blockCount * 2));
    expect(Number(viewport.getAttribute('data-presentation-height'))).toBe(expectedHeight);

    const finalBoundary = viewport.querySelector<HTMLElement>(
      `[data-raw-start="${lines.length - 1}"]`,
    );
    expect(Number(finalBoundary?.getAttribute('data-presentation-top'))).toBe(
      expectedHeight - lineHeight,
    );
    expect(Number(finalBoundary?.getAttribute('data-presentation-height'))).toBe(lineHeight);

    wheelUp(viewport);
    await settleUi();
    const firstMarker = viewport.querySelector<HTMLElement>('[data-raw-start="0"]');
    const firstBoundary = viewport.querySelector<HTMLElement>('[data-raw-start="2"]');
    expect(firstMarker?.style.height).toBe(`${markerHeight}px`);
    expect(Number(firstBoundary?.getAttribute('data-presentation-top'))).toBe(markerHeight);
    expect(viewport.querySelector<HTMLElement>('.mtv-layer')?.style.transform)
      .toBe('translate3d(0, 0.00px, 0)');
  });

  test('search jump centres a raw hit inside a one-third marker in presentation pixels', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    const prefix = Array.from({ length: 80 }, (_, index) => `prefix-${index}`);
    const suffix = Array.from({ length: 80 }, (_, index) => `suffix-${index}`);
    deliver([
      ...prefix,
      '● Bash(printf geometry-needle)',
      '  ⎿  geometry-needle-output',
      '● semantic-boundary',
      ...suffix,
    ]);
    await settleUi();

    viewport.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    flushSync();
    const input = viewport.querySelector<HTMLInputElement>('[data-testid="term-search-input"]');
    if (!input) throw new Error('search input did not open');
    input.value = 'geometry-needle-output';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settleUi();
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    await settleUi();

    const marker = viewport.querySelector<HTMLElement>('.mtv-bash-hidden');
    if (!marker) throw new Error('search jump did not mount the Bash marker');
    expect(marker.querySelector('.search-active')?.textContent).toContain('hidden bash');
    const contentHeight = Number(viewport.getAttribute('data-presentation-height'));
    const rowTop = Number(marker.getAttribute('data-presentation-top'));
    const rowHeight = Number(marker.getAttribute('data-presentation-height'));
    const maxOffset = Math.max(0, contentHeight - 120);
    const targetScrollTop = Math.max(0, Math.min(rowTop - (120 / 2 - rowHeight / 2), maxOffset));
    expect(Math.abs(
      Number(viewport.getAttribute('data-bottom-offset')) - (maxOffset - targetScrollTop),
    )).toBeLessThanOrEqual(0.5); // diagnostics intentionally round to whole pixels
  });

  test('cursor after a compact marker uses fractional presentation top and never paints inside it', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      'before',
      '● Bash(printf cursor-hidden)',
      '  ⎿  hidden-output',
      '● semantic-boundary',
      'after',
    ];
    // lastContent=4; cursor.row=1 targets raw row 3, immediately after Bash.
    deliver(lines, true, { row: 1, col: 0 });
    await settleUi();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    const marker = viewport.querySelector<HTMLElement>('.mtv-bash-hidden');
    const boundary = viewport.querySelector<HTMLElement>('[data-raw-start="3"]');
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(marker?.style.height).toBe(`${lineHeight / 3}px`);
    expect(Number(boundary?.getAttribute('data-presentation-top'))).toBe(
      lineHeight + lineHeight / 3,
    );
    expect(cursor?.style.top).toBe(`${lineHeight + lineHeight / 3}px`);
    expect(cursor?.style.height).toBe(`${lineHeight}px`);

    // A terminal cursor reported on a raw row inside hidden Bash must not paint
    // a full-height caret over the synthetic one-third divider.
    deliver(lines, true, { row: 2, col: 0 });
    await settleUi();
    expect(viewport.querySelector('[data-testid="mtv-cursor"]')).toBeNull();
  });

  test('show-hide-show toggle preserves the same post-Bash raw anchor on screen', async () => {
    const { props, viewport } = mountView('hide', { height: 120 });
    const prefix = Array.from({ length: 20 }, (_, index) => `prefix-${index}`);
    const suffix = Array.from({ length: 180 }, (_, index) => `anchor-${index}`);
    deliver([
      ...prefix,
      '● Bash(printf toggle-anchor)',
      '  ⎿  hidden-output',
      '● semantic-boundary',
      ...suffix,
    ]);
    await settleUi();

    const targetText = 'anchor-40';
    const initialTarget = Array.from(viewport.querySelectorAll<HTMLElement>('.mtv-line'))
      .find((row) => row.textContent === targetText);
    // Initially pinned to the tail, so anchor-80 is outside the mounted window.
    expect(initialTarget).toBeUndefined();
    const targetRaw = prefix.length + 3 + 40;
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    const hiddenTargetTop = (
      prefix.length * lineHeight
      + lineHeight / 3
      + lineHeight
      + 40 * lineHeight
    );
    const maxOffset = Number(viewport.getAttribute('data-presentation-height')) - 120;
    const desiredScrollTop = hiddenTargetTop - 36;
    wheelUp(viewport, maxOffset - desiredScrollTop);
    await settleUi();

    let target = viewport.querySelector<HTMLElement>(`[data-raw-start="${targetRaw}"]`);
    if (!target) throw new Error('target anchor did not enter the hide viewport');
    const absoluteRowId = target.getAttribute('data-line-id');
    const hiddenY = projectedScreenY(viewport, target);

    flushSync(() => { props.claudeBashMode = 'off'; });
    await settleUi();
    target = viewport.querySelector<HTMLElement>(`[data-line-id="${absoluteRowId}"]`);
    if (!target) throw new Error('raw anchor was not retained after show');
    const shownY = projectedScreenY(viewport, target);
    expect(Math.abs(shownY - hiddenY)).toBeLessThanOrEqual(0.01);
    expect(viewport.querySelector('.mtv-bash-hidden')).toBeNull();

    flushSync(() => { props.claudeBashMode = 'hide'; });
    await settleUi();
    target = viewport.querySelector<HTMLElement>(`[data-line-id="${absoluteRowId}"]`);
    if (!target) throw new Error('raw anchor was not retained after hide');
    expect(Math.abs(projectedScreenY(viewport, target) - hiddenY)).toBeLessThanOrEqual(0.01);
    expect(viewport.querySelector('.mtv-bash-hidden')).not.toBeNull();
  });

  test('same-length raw replacement while off cannot reuse a stale hide detection', async () => {
    const { props, viewport } = mountView('hide');
    deliver([
      '● Bash(printf old)',
      '  ⎿  old-output',
      '● old-done',
    ]);
    await settleUi();
    expect(viewport.querySelector('.mtv-bash-placeholder')).not.toBeNull();

    flushSync(() => { props.claudeBashMode = 'off'; });
    await settleUi();
    deliver(['ordinary-a', 'ordinary-b', 'ordinary-c']);
    await settleUi();
    expect(viewport.querySelector('.mtv-bash-placeholder')).toBeNull();

    flushSync(() => { props.claudeBashMode = 'hide'; });
    await settleUi();
    expect(viewport.querySelector('.mtv-bash-placeholder')).toBeNull();
    expect(viewport.getAttribute('data-total')).toBe('3');
    expect(visibleText(viewport)).toEqual(['ordinary-a', 'ordinary-b', 'ordinary-c']);
  });

  test('haiku cold-start requests completed groups independent of viewport, then keeps row count stable', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const onSummary: SummaryHandler = async (requests) => {
      batches.push([...requests]);
      return Object.fromEntries(requests.map((request) => [
        request.id,
        `สรุป ${request.command.replace(/\s+/g, ' ')}`,
      ]));
    };
    const { viewport } = mountView('haiku', { height: 64, onSummary });
    const lines = [
      '● Bash(printf first)',
      '  ⎿  first-output',
      '● first-done',
      ...Array.from({ length: 80 }, (_, i) => `middle-${i}`),
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● second-done',
    ];
    deliver(lines);
    const visualRowsBefore = viewport.getAttribute('data-total');
    await settleUi();
    await settleUi();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.command)).toEqual([
      'printf first',
      'printf second',
    ]);
    expect(viewport.textContent).toContain('Bash · สรุป printf second');
    expect(viewport.getAttribute('data-total')).toBe(visualRowsBefore);
    const haikuPlaceholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    expect(haikuPlaceholder?.classList.contains('mtv-bash-hidden')).toBe(false);
    expect(Number(haikuPlaceholder?.getAttribute('data-presentation-height'))).toBe(lineHeight);
    expect(haikuPlaceholder?.style.height).toBe(`${lineHeight}px`);

    wheelUp(viewport);
    await settleUi();
    await settleUi();
    expect(batches).toHaveLength(1);
    expect(viewport.textContent).toContain('Bash · สรุป printf first');
    expect(viewport.getAttribute('data-total')).toBe(visualRowsBefore);
  });

  test('haiku cold-start admits only the newest ten groups and live delivery coalesces to the newest group', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const onSummary: SummaryHandler = async (requests) => {
      batches.push([...requests]);
      return Object.fromEntries(requests.map((request) => [request.id, `สรุป ${request.command}`]));
    };
    mountView('haiku', { onSummary });
    const block = (label: string) => [
      `● Bash(printf ${label})`,
      `  ⎿  output-${label}`,
      `● boundary-${label}`,
    ];
    const cold = Array.from({ length: 12 }, (_, index) => block(`cold-${index}`)).flat();
    deliver(cold);
    await settleUi();
    await settleUi();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.command)).toEqual(
      Array.from({ length: 10 }, (_, index) => `printf cold-${index + 2}`),
    );

    // One coalesced live capture can complete several groups. The open-view
    // policy intentionally sends only the newest one, never a catch-up queue.
    deliver([
      ...cold,
      ...block('live-12'),
      ...block('live-13'),
    ], false);
    await settleUi();
    await settleUi();

    expect(batches).toHaveLength(2);
    expect(batches[1]?.map((request) => request.command)).toEqual(['printf live-13']);
  });

  test('a live adjacent burst waits for its active tail, then sends one merged group', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    mountView('haiku', {
      onSummary: async (requests) => {
        batches.push([...requests]);
        return Object.fromEntries(requests.map((request) => [request.id, 'สรุปแล้ว']));
      },
    });
    const cold = [
      '● Bash(printf cold)',
      '  ⎿  cold-output',
      '● cold-boundary',
    ];
    deliver(cold);
    await settleUi();
    await settleUi();
    expect(batches).toHaveLength(1);

    deliver([
      ...cold,
      '● Bash(printf first)',
      '  ⎿  first-output',
      ACTIVE[0]!,
      '      second-continuation)',
    ], false);
    await settleUi();
    expect(batches).toHaveLength(1);

    deliver([
      ...cold,
      '● Bash(printf first)',
      '  ⎿  first-output',
      '● Bash(printf second)',
      '  ⎿  second-output',
      '● live-boundary',
    ], false);
    await settleUi();
    await settleUi();

    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1]?.[0]).toMatchObject({ blockCount: 2 });
    expect(batches[1]?.[0]?.command).toContain('[Bash 1/2]');
    expect(batches[1]?.[0]?.command).toContain('[Bash 2/2]');
  });

  test('live completions replace the waiting tail item while the cold batch is in flight', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    let releaseCold: ((value: ClaudeBashSummaries) => void) | null = null;
    const coldResult = new Promise<ClaudeBashSummaries>((resolve) => {
      releaseCold = resolve;
    });
    mountView('haiku', {
      onSummary: (requests) => {
        batches.push([...requests]);
        if (batches.length === 1) return coldResult;
        return Object.fromEntries(requests.map((request) => [request.id, 'สดล่าสุด']));
      },
    });
    const block = (label: string) => [
      `● Bash(printf ${label})`,
      `  ⎿  output-${label}`,
      `● boundary-${label}`,
    ];
    const cold = block('cold');
    deliver(cold);
    await settleUi();
    expect(batches).toHaveLength(1);

    deliver([...cold, ...block('queued-old')], false);
    await settleUi();
    deliver([...cold, ...block('queued-old'), ...block('queued-new')], false);
    await settleUi();
    expect(batches).toHaveLength(1);

    releaseCold?.({ [batches[0]?.[0]?.id ?? '']: 'เย็นเสร็จแล้ว' });
    await settleUi();
    await settleUi();
    expect(batches).toHaveLength(2);
    expect(batches[1]?.map((request) => request.command)).toEqual(['printf queued-new']);
  });

  test('a hung summary adapter times out and releases the live-latest lane', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const never = new Promise<ClaudeBashSummaries>(() => {});
    mountView('haiku', {
      onSummary: (requests) => {
        batches.push([...requests]);
        if (batches.length === 1) return never;
        return Object.fromEntries(requests.map((request) => [request.id, 'เดินต่อหลัง timeout']));
      },
    });

    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const fakeHandle = 987_654_321 as unknown as ReturnType<typeof setTimeout>;
    let watchdog: (() => void) | null = null;
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 305_000) {
          if (typeof handler !== 'function') throw new Error('watchdog must be callable');
          watchdog = () => handler(...args);
          return fakeHandle;
        }
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, 'clearTimeout', {
      configurable: true,
      writable: true,
      value: ((handle?: ReturnType<typeof setTimeout>) => {
        if (handle !== fakeHandle) originalClearTimeout(handle);
      }) as typeof clearTimeout,
    });

    const block = (label: string) => [
      `● Bash(printf ${label})`,
      `  ⎿  output-${label}`,
      `● boundary-${label}`,
    ];
    try {
      const cold = block('hung-cold');
      deliver(cold);
      await settleUi();
      expect(batches).toHaveLength(1);

      deliver([...cold, ...block('latest-after-hang')], false);
      await settleUi();
      expect(batches).toHaveLength(1);
      expect(watchdog).not.toBeNull();

      watchdog?.();
      await settleUi();
      await settleUi();
      expect(batches).toHaveLength(2);
      expect(batches[1]?.map((request) => request.command)).toEqual([
        'printf latest-after-hang',
      ]);
    } finally {
      Object.defineProperty(globalThis, 'setTimeout', {
        configurable: true,
        writable: true,
        value: originalSetTimeout,
      });
      Object.defineProperty(globalThis, 'clearTimeout', {
        configurable: true,
        writable: true,
        value: originalClearTimeout,
      });
    }
  });

  test('haiku cold-start request is independent of render guard rows', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const { viewport } = mountView('haiku', {
      height: 21,
      onSummary: (requests) => { batches.push([...requests]); },
    });
    deliver([
      '● Bash(printf guard)',
      '  ⎿  guard-output',
      '● visible-boundary',
    ]);
    await settleUi();

    // Bootstrap eligibility is semantic rather than viewport-driven: a group
    // immediately above the one-row viewport still belongs to the newest ten.
    expect(viewport.querySelector('.mtv-bash-placeholder')).not.toBeNull();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.command)).toEqual(['printf guard']);
  });

  test('haiku bootstrap does not depend on transient gesture viewports', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const { viewport } = mountView('haiku', {
      height: 32,
      onSummary: (requests) => {
        batches.push([...requests]);
        return Object.fromEntries(requests.map((request) => [request.id, 'settled']));
      },
    });
    deliver([
      '● Bash(printf first)',
      '  ⎿  first-output',
      '● first-boundary',
      ...Array.from({ length: 50 }, (_, index) => `middle-a-${index}`),
      '● Bash(printf transient)',
      '  ⎿  transient-output',
      '● transient-boundary',
      ...Array.from({ length: 50 }, (_, index) => `middle-b-${index}`),
    ]);
    await settleUi();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.command)).toEqual([
      'printf first',
      'printf transient',
    ]);

    const point = { clientX: 40, clientY: 16 };
    viewport.dispatchEvent(touchEvent('touchstart', [point]));
    // Exercise multiple transient applyScroll calls while busy. `busy()` also
    // covers momentum and spring frames, which share this request guard.
    wheelUp(viewport);
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 1_000_000,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    wheelUp(viewport);
    expect(batches).toHaveLength(1);

    viewport.dispatchEvent(touchEvent('touchend', [], [point]));
    await settleUi();
    await settleUi();
    expect(batches).toHaveLength(1);
  });

  test('active styled Bash compacts without a Haiku request', async () => {
    const batches: ClaudeBashSummaryRequest[][] = [];
    const { app, viewport } = mountView('haiku', {
      onSummary: (requests) => { batches.push([...requests]); },
    });
    deliver(ACTIVE);
    await settleUi();

    expect(viewport.getAttribute('data-total')).toBe('1');
    expect(viewport.getAttribute('data-raw-total')).toBe('2');
    expect(viewport.querySelector('.mtv-bash-placeholder')?.textContent).toContain('Bash กำลังรัน…');
    (app.refreshGeometry as (() => void) | undefined)?.();
    await settleUi();
    expect(batches).toHaveLength(0);
  });

  test('Haiku pending and resolved placeholders retain a full terminal-row height', async () => {
    let resolveSummary: ((value: ClaudeBashSummaries) => void) | null = null;
    const summary = new Promise<ClaudeBashSummaries>((resolve) => {
      resolveSummary = resolve;
    });
    const { viewport } = mountView('haiku', {
      onSummary: () => summary,
    });
    deliver([
      '● Bash(printf full-height)',
      '  ⎿  output',
      '● semantic-boundary',
    ]);
    await settleUi();

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    let placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    expect(placeholder?.classList.contains('mtv-bash-hidden')).toBe(false);
    expect(Number(placeholder?.getAttribute('data-presentation-height'))).toBe(lineHeight);
    expect(placeholder?.style.height).toBe(`${lineHeight}px`);

    resolveSummary?.({ [placeholder?.getAttribute('data-bash-id') ?? '']: 'สรุปแล้ว' });
    await settleUi();
    await settleUi();
    placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    expect(placeholder?.classList.contains('mtv-bash-hidden')).toBe(false);
    expect(Number(placeholder?.getAttribute('data-presentation-height'))).toBe(lineHeight);
  });

  test('a rejected summary settles once to deterministic fallback without a retry storm', async () => {
    let calls = 0;
    const { app, viewport } = mountView('haiku', {
      onSummary: async () => {
        calls += 1;
        throw new Error('haiku unavailable');
      },
    });
    deliver([
      '● Bash(find src -name "*.ts")',
      '  ⎿  src/a.ts',
      '● done',
    ]);
    await settleUi();
    await settleUi();

    const placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    expect(placeholder?.textContent).toContain('find src -name "*.ts"');
    expect(placeholder?.textContent).toContain('2 แถว');
    expect(placeholder?.textContent).not.toContain('กำลังสรุป');
    expect(calls).toBe(1);

    (app.refreshGeometry as (() => void) | undefined)?.();
    wheelUp(viewport, 40);
    await settleUi();
    expect(calls).toBe(1);
  });

  test('a summary response missing the requested id settles once to fallback', async () => {
    let calls = 0;
    const { app, viewport } = mountView('haiku', {
      onSummary: () => {
        calls += 1;
        return { unrelated: 'must not be used' };
      },
    });
    deliver([
      '● Bash(git status --short)',
      '  ⎿  M src/a.ts',
      '● done',
    ]);
    await settleUi();
    await settleUi();

    expect(viewport.querySelector('.mtv-bash-placeholder')?.textContent).toContain('git status --short');
    expect(viewport.textContent).not.toContain('กำลังสรุป');
    expect(calls).toBe(1);
    (app.refreshGeometry as (() => void) | undefined)?.();
    await settleUi();
    expect(calls).toBe(1);
  });

  test('haiku without a callback settles locally instead of remaining pending', async () => {
    const { app, viewport } = mountView('haiku');
    deliver([
      '● Bash(pwd)',
      '  ⎿  /workspace',
      '● done',
    ]);
    await settleUi();
    await settleUi();

    expect(viewport.querySelector('.mtv-bash-placeholder')?.textContent).toContain('pwd');
    expect(viewport.textContent).not.toContain('กำลังสรุป');
    expect(viewport.getAttribute('data-claude-bash-requested-count')).toBe('1');
    expect(viewport.getAttribute('data-claude-bash-settled-count')).toBe('1');
    (app.refreshGeometry as (() => void) | undefined)?.();
    await settleUi();
    expect(viewport.getAttribute('data-claude-bash-requested-count')).toBe('1');
  });

  test('summary attempt/result maps prune fingerprints that leave the projection', async () => {
    let calls = 0;
    const { viewport } = mountView('haiku', {
      onSummary: async (requests) => {
        calls += 1;
        return Object.fromEntries(requests.map((request) => [request.id, `รอบ ${calls}`]));
      },
    });

    for (let round = 0; round < 8; round += 1) {
      deliver([
        `● Bash(printf round-${round})`,
        `  ⎿  output-${round}`,
        `● done-${round}`,
      ], round === 0);
      await settleUi();
      await settleUi();
      expect(viewport.getAttribute('data-claude-bash-requested-count')).toBe('1');
      expect(viewport.getAttribute('data-claude-bash-settled-count')).toBe('1');
    }
    expect(calls).toBe(8);
  });

  test('live same-length repaint rescans only a bounded suffix after the cold pass', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    const first = Array.from({ length: 10_000 }, (_, i) => `plain-${i}`);
    deliver(first);
    await settleUi();
    expect(viewport.getAttribute('data-claude-bash-detection-scan-rows')).toBe('10000');
    expect(viewport.getAttribute('data-claude-bash-projection-build-rows')).toBe('10000');

    const repaint = [...first];
    repaint[repaint.length - 1] = 'plain-repainted-tail';
    deliver(repaint);
    await settleUi();
    expect(
      Number(viewport.getAttribute('data-claude-bash-detection-scan-rows')),
    ).toBeLessThanOrEqual(2_049);
    expect(
      Number(viewport.getAttribute('data-claude-bash-projection-build-rows')),
    ).toBeLessThanOrEqual(2_049);
  });

  test('incremental projection expands a placeholder ejected by the 512-block detector cap', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    const block = (index: number) => [
      `● Bash(printf block-${index})`,
      `      command-${index}`,
      `  ⎿  output-${index}`,
      `     detail-${index}-a`,
      `     detail-${index}-b`,
    ];
    const first = [
      ...Array.from({ length: 520 }, (_, index) => block(index)).flat(),
      '● done',
    ];
    deliver(first);
    await settleUi();
    // The 512 newest five-row blocks are directly adjacent, so first-class
    // grouping collapses the whole retained burst to one placeholder row.
    expect(viewport.getAttribute('data-total')).toBe(String(first.length - (512 * 5 - 1)));

    const next = [
      ...first.slice(0, -1),
      ...block(520),
      '● done',
    ];
    deliver(next);
    await settleUi();
    // The newly detected block ejects the oldest prior placeholder. It must
    // expand to all five raw rows instead of remaining collapsed from cache.
    expect(viewport.getAttribute('data-total')).toBe(String(next.length - (512 * 5 - 1)));
  });

  test('retention gaps are hard detector barriers and never form one cross-gap Bash prompt', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    deliver(Array.from({ length: 10_000 }, (_, i) => `base-${i}`));
    await settleUi();
    wheelUp(viewport);

    const protectedEnd = Math.max(...Array.from(
      viewport.querySelectorAll<HTMLElement>('.mtv-line'),
      (line) => Number(line.getAttribute('data-raw-end')),
    ));
    expect(protectedEnd).toBeGreaterThan(8);

    const next = Array.from({ length: 12_100 }, (_, i) => `next-${i}`);
    // A valid compact group just before the discontinuity calibrates the gap's
    // absolute position against a preceding one-third row.
    next[protectedEnd - 6] = '● Bash(printf valid-before-gap)';
    next[protectedEnd - 5] = '  ⎿  valid-output';
    next[protectedEnd - 4] = '● valid-semantic-boundary';
    next[protectedEnd - 1] = '● Bash(printf must-not-cross-gap)';
    // 2,100 rows are removed immediately below the protected viewport. Before
    // retention this candidate is > core's 2,000-row limit and fails open;
    // after removal header/result become adjacent but remain discontinuous.
    next[protectedEnd + 2_100] = '  ⎿  impossible-neighbour';
    next[protectedEnd + 2_101] = '● after-gap-boundary';
    deliver(next);
    await settleUi();

    expect(viewport.getAttribute('data-raw-total')).toBe('10000');
    expect(viewport.getAttribute('data-total')).toBe('9999');
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 1_500,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    const compact = viewport.querySelector<HTMLElement>('.mtv-bash-hidden');
    expect(compact?.getAttribute('data-raw-start')).toBe(String(protectedEnd - 6));
    expect(Number(compact?.getAttribute('data-presentation-height'))).toBe(7);
    // Exactly one local Bash group collapsed; the candidate spanning the gap
    // remained raw because the retention discontinuity is a hard barrier.
    expect(viewport.querySelectorAll('.mtv-bash-placeholder')).toHaveLength(1);

    const gapMarker = viewport.querySelector<HTMLElement>('[data-gap-marker-rows="2100"]');
    const gapLine = viewport.querySelector<HTMLElement>('[data-gap-rows="2100"]');
    const firstLine = viewport.querySelector<HTMLElement>('.mtv-line');
    if (!gapMarker || !gapLine || !firstLine) throw new Error('gap calibration rows not mounted');
    expect(Number.parseFloat(gapMarker.style.top)).toBe(
      Number(gapLine.getAttribute('data-presentation-top'))
      - Number(firstLine.getAttribute('data-presentation-top')),
    );
    expect(Number.parseFloat(gapMarker.style.height)).toBe(
      Number(gapLine.getAttribute('data-presentation-height')),
    );
  });

  test('history prepend uses projected row count and preserves the mounted raw anchor', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    deliver(Array.from({ length: 120 }, (_, i) => `line-${i}`));
    await settleUi();
    wheelUp(viewport);
    expect(historyRequests).toBe(1);

    const beforeLine = Array.from(viewport.querySelectorAll<HTMLElement>('.mtv-line'))
      .find((line) => line.textContent === 'line-0');
    if (!beforeLine) throw new Error('reader anchor line was not mounted');
    const anchorId = beforeLine.getAttribute('data-line-id');
    const screenYBefore = projectedScreenY(viewport, beforeLine);
    const contentHeightBefore = Number(viewport.getAttribute('data-presentation-height'));
    const layer = viewport.querySelector<HTMLElement>('.mtv-layer');
    const transformBefore = layer?.style.transform;

    if (!sessionCallback) throw new Error('TermView did not subscribe');
    sessionCallback(JSON.stringify({
      lines: [
        'older-a',
        '● Bash(printf old)',
        '  ⎿  old-output',
        '● older-done',
        'older-z',
      ],
      startLine: 0,
      hasMore: false,
    }), 'history');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await settleUi();

    expect(viewport.getAttribute('data-raw-total')).toBe('125');
    expect(viewport.getAttribute('data-total')).toBe('124');
    const afterLine = viewport.querySelector<HTMLElement>(`[data-line-id="${anchorId}"]`);
    expect(afterLine?.textContent).toBe('line-0');
    if (!afterLine) throw new Error('history prepend dropped the raw anchor');
    expect(afterLine.getAttribute('data-presentation-top')).toBe('70');
    expect(Number(viewport.getAttribute('data-presentation-height'))).toBe(
      contentHeightBefore + 70,
    );
    expect(projectedScreenY(viewport, afterLine)).toBe(screenYBefore);
    expect(layer?.style.transform).toBe(transformBefore);

    // The preserved window starts at the old line-0, so reveal the newly
    // prepended rows only after proving the anchor did not move.
    wheelUp(viewport);
    await settleUi();
    const marker = viewport.querySelector<HTMLElement>('[data-raw-start="1"]');
    expect(marker?.classList.contains('mtv-bash-hidden')).toBe(true);
    expect(marker?.getAttribute('data-presentation-top')).toBe('21');
    expect(marker?.getAttribute('data-presentation-height')).toBe('7');
  });
});
