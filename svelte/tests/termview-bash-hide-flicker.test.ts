/**
 * Regression coverage for the "Bash HIDE flicker" report (2026-09-09).
 *
 * A live Claude pane keeps its composer chrome pinned at the bottom and
 * inserts new output *above* the activity status row, so every frame that
 * carries output translates that row down by the capture's net length change.
 * The repaint proof that authorizes collapsing a Bash group is stored as an
 * absolute row index; when the proof was dropped on every such frame the whole
 * group was rejected by the detector and expanded back to full height, then
 * collapsed again on the next steady frame. At pane-repaint rate that reads as
 * the screen flickering.
 *
 * These tests assert the presentation geometry a reader actually sees — the
 * projected content height and the number of compact rows — stays put while
 * only the live tail changes.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { proxy as reactiveProps } from 'svelte/internal/client';
import { flushSync, mount, tick, unmount } from './svelte-client';

import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import type { AnsiPalette, ClaudeBashMode } from '@thumbmux/core';

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: unknown,
) => void;

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

const mounted: Array<{ app: Record<string, unknown>; target: HTMLElement }> = [];
let sessionCallback: MuxCallback | null = null;
let originalSubscribeDescriptor: PropertyDescriptor | undefined;
let originalRequestHistoryDescriptor: PropertyDescriptor | undefined;
let originalResizeObserverDescriptor: PropertyDescriptor | undefined;
let originalWindowResizeObserverDescriptor: PropertyDescriptor | undefined;

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
  ControlledResizeObserver.latest = null;
  originalSubscribeDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, 'subscribe');
  originalRequestHistoryDescriptor = Object.getOwnPropertyDescriptor(tmuxMux, 'requestHistory');
  originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  originalWindowResizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');

  tmuxMux.subscribe = ((_session: string, callback: MuxCallback) => {
    sessionCallback = callback;
    return () => {
      if (sessionCallback === callback) sessionCallback = null;
    };
  }) as typeof tmuxMux.subscribe;
  tmuxMux.requestHistory = (() => true) as typeof tmuxMux.requestHistory;

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true, writable: true, value: ControlledResizeObserver,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true, writable: true, value: ControlledResizeObserver,
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
});

function mountView(mode: ClaudeBashMode, height = 400): HTMLElement {
  const target = document.createElement('div');
  target.style.cssText = `position:relative;width:320px;height:${height}px;`;
  document.body.appendChild(target);
  const props = reactiveProps({
    session: `cc-flicker-${mounted.length}`,
    palette,
    claimGeometry: false,
    fontPx: 13,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
    claudeBashMode: mode,
    historyPaging: 'sliding',
  });
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView, { target, props }) as Record<string, unknown>;
  });
  const viewport = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!viewport) throw new Error('TermView viewport did not mount');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => height },
  });
  viewport.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: height, width: 320, height,
    toJSON: () => ({}),
  }) as DOMRect;
  ControlledResizeObserver.latest?.fire();
  mounted.push({ app, target });
  return viewport;
}

function deliver(lines: readonly string[]): void {
  if (!sessionCallback) throw new Error('TermView did not subscribe');
  sessionCallback(lines.join('\n'), 'output', null, {
    source: 'full',
    replace: true,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
    boundary: {
      generation: 'g-flicker', liveStartLine: 0, walSequence: '0', walOffset: 0,
    },
  });
  flushSync();
}

async function settleUi(): Promise<void> {
  await Promise.resolve();
  await tick();
  flushSync();
}

const COMPOSER_RULE = `\x1b[38;5;244m${'─'.repeat(80)}`;
/** Frames Claude Code cycles through; every one is in the marker grammar. */
const SPINNER = ['·', '✢', '✳', '✻', '✽', '✶'];

const activityStatus = (glyph: string, detail: string) =>
  `\x1b[38;5;174m${glyph}\x1b[39m \x1b[38;5;174mThinking…\x1b[39m `
  + `\x1b[38;5;246m(${detail})\x1b[39m`;

/**
 * A live Claude pane: prose, two completed Bash groups, streamed tool output,
 * the activity status row, and pinned composer chrome. Extra output rows are
 * inserted above the status row exactly as Claude Code prints them.
 */
function livePane(status: string, streamedRows: number): string[] {
  return [
    '● อธิบายก่อน',
    '',
    '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf one)',
    '\x1b[38;5;246m  ⎿  one',
    '',
    '● กลางทาง',
    '',
    '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf two)',
    '\x1b[38;5;246m  ⎿  two',
    ...Array.from({ length: streamedRows }, (_, k) => `\x1b[38;5;246m     stream ${k}`),
    '',
    status,
    '',
    COMPOSER_RULE,
    '❯ ',
    COMPOSER_RULE,
  ];
}

type Geometry = { height: number; compactRows: number };

function geometry(viewport: HTMLElement): Geometry {
  return {
    height: Number(viewport.getAttribute('data-presentation-height')),
    compactRows: viewport.querySelectorAll('.mtv-bash-hidden').length,
  };
}

test('streamed output does not toggle Bash HIDE geometry frame to frame', async () => {
  const viewport = mountView('hide');

  // Two steady frames arm the repaint proof, exactly as a real pane does.
  deliver(livePane(activityStatus(SPINNER[0]!, '10s · ↓ 1.0k tokens'), 0));
  await settleUi();
  deliver(livePane(activityStatus(SPINNER[1]!, '11s · ↓ 1.1k tokens'), 0));
  await settleUi();

  const armed = geometry(viewport);
  expect(armed.compactRows).toBe(2);

  // Bursty streaming: odd frames append one output row above the status row,
  // even frames only repaint the spinner. Nothing the reader is looking at
  // above the live tail may change height because of it.
  const observed: Geometry[] = [];
  let streamedRows = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    if (frame % 2 === 1) streamedRows += 1;
    deliver(livePane(
      activityStatus(SPINNER[frame % SPINNER.length]!, `${12 + frame}s · ↓ ${12 + frame}00 tokens`),
      streamedRows,
    ));
    await settleUi();
    observed.push(geometry(viewport));
  }

  // Every frame keeps both Bash groups compact. A frame that reports 1 is the
  // reported flicker: a two-row group snapped back to full height and back.
  expect(observed.map((entry) => entry.compactRows)).toEqual(observed.map(() => 2));

  // Height may only grow with the streamed rows, never bounce back and forth.
  const heights = observed.map((entry) => entry.height);
  for (let index = 1; index < heights.length; index += 1) {
    expect(heights[index]).toBeGreaterThanOrEqual(heights[index - 1]!);
  }
});

test('a shrinking live tail keeps the proof that authorizes Bash HIDE', async () => {
  const viewport = mountView('hide');

  deliver(livePane(activityStatus(SPINNER[0]!, '10s · ↓ 1.0k tokens'), 3));
  await settleUi();
  deliver(livePane(activityStatus(SPINNER[1]!, '11s · ↓ 1.1k tokens'), 3));
  await settleUi();
  expect(geometry(viewport).compactRows).toBe(2);

  // Claude replaces the streamed corridor with a shorter one (tool output
  // collapses to a summary). The status row translates up with the composer.
  deliver(livePane(activityStatus(SPINNER[2]!, '12s · ↓ 1.2k tokens'), 1));
  await settleUi();
  expect(geometry(viewport).compactRows).toBe(2);
});
