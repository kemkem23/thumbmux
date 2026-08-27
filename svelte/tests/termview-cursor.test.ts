/**
 * Cursor integration contracts for TermView's rendered terminal grid.
 *
 * Server tests cover raw tmux -> content-relative wire coordinates. These
 * mounts prove the final inverse mapping, including blank rows below content,
 * Bash presentation geometry, ANSI/control stripping, and Unicode cell width.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { flushSync, mount, tick, unmount } from './svelte-client';

import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import type { AnsiPalette, ClaudeBashMode } from '@thumbmux/core';

type Cursor = { row: number; col: number } | null;
type MuxCallback = (
  data: string,
  type?: string,
  cursor?: Cursor,
  meta?: {
    source: 'full' | 'delta';
    replace: boolean;
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
  },
) => void;

class ControlledResizeObserver implements ResizeObserver {
  static latest: ControlledResizeObserver | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.latest = this;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void { this.callback([], this); }
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
let callback: MuxCallback | null = null;
let originalSubscribe: typeof tmuxMux.subscribe;
let originalResizeObserver: typeof ResizeObserver;
let originalWindowResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  callback = null;
  ControlledResizeObserver.latest = null;
  originalSubscribe = tmuxMux.subscribe;
  originalResizeObserver = globalThis.ResizeObserver;
  originalWindowResizeObserver = window.ResizeObserver;
  tmuxMux.subscribe = ((_session: string, next: MuxCallback) => {
    callback = next;
    return () => {
      if (callback === next) callback = null;
    };
  }) as typeof tmuxMux.subscribe;
  globalThis.ResizeObserver = ControlledResizeObserver;
  window.ResizeObserver = ControlledResizeObserver;
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try { unmount(entry.app); } catch { /* already unmounted */ }
    entry.target.remove();
  }
  tmuxMux.subscribe = originalSubscribe;
  globalThis.ResizeObserver = originalResizeObserver;
  window.ResizeObserver = originalWindowResizeObserver;
});

function mountView(mode: ClaudeBashMode = 'off'): HTMLElement {
  const target = document.createElement('div');
  target.style.cssText = 'position:relative;width:400px;height:320px;';
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, {
      target,
      props: {
        session: `cursor-grid-${mounted.length}`,
        palette,
        fontPx: 13,
        claimGeometry: false,
        claudeBashMode: mode,
        screen: { alt: false, mouseSgr: false, mouseAny: false },
      },
    }) as Record<string, unknown>;
  });
  const viewport = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!viewport) throw new Error('TermView cursor viewport did not mount');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => 400 },
    clientHeight: { configurable: true, get: () => 320 },
  });
  viewport.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 320,
    width: 400, height: 320,
    toJSON: () => ({}),
  }) as DOMRect;
  ControlledResizeObserver.latest?.fire();
  flushSync();
  mounted.push({ app, target });
  return viewport;
}

async function deliver(lines: readonly string[], cursor: Cursor): Promise<void> {
  if (!callback) throw new Error('TermView did not subscribe');
  callback(lines.join('\n'), 'output', cursor, {
    source: 'full',
    replace: true,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
  });
  flushSync();
  await tick();
  flushSync();
}

async function deliverCursor(cursor: Cursor): Promise<void> {
  if (!callback) throw new Error('TermView did not subscribe');
  callback('', 'cursor', cursor);
  flushSync();
  await tick();
  flushSync();
}

function cursor(viewport: HTMLElement): HTMLElement {
  const node = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
  if (!node) throw new Error('cursor was not rendered');
  return node;
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid CSS pixel value: ${value}`);
  return parsed;
}

describe('TermView cursor grid mapping', () => {
  test('keeps every blank row below the last content line at its own Y coordinate', async () => {
    const viewport = mountView();
    await deliver(['last-content'], { row: -1, col: 0 });
    const lineHeight = px(viewport.style.getPropertyValue('--mtv-lineh'));
    expect(px(cursor(viewport).style.top)).toBe(lineHeight);

    await deliverCursor({ row: -2, col: 0 });
    expect(px(cursor(viewport).style.top)).toBe(2 * lineHeight);
    await deliverCursor({ row: -6, col: 0 });
    expect(px(cursor(viewport).style.top)).toBe(6 * lineHeight);
  });

  test('maps an all-blank capture from its synthetic content anchor without collapsing rows', async () => {
    const viewport = mountView();
    await deliver([''], { row: -1, col: 0 });
    const lineHeight = px(viewport.style.getPropertyValue('--mtv-lineh'));
    expect(px(cursor(viewport).style.top)).toBe(0);
    await deliverCursor({ row: -6, col: 0 });
    expect(px(cursor(viewport).style.top)).toBe(5 * lineHeight);
  });

  test('continues negative cursor rows after compact Bash presentation height', async () => {
    const viewport = mountView('hide');
    await deliver([
      'before',
      '● Bash(printf cursor-tail)',
      '  ⎿  hidden-output',
      '● semantic-boundary',
      'last-content',
    ], { row: -1, col: 0 });
    const lineHeight = px(viewport.style.getPropertyValue('--mtv-lineh'));
    const contentHeight = Number(viewport.getAttribute('data-presentation-height'));
    expect(px(cursor(viewport).style.top)).toBe(contentHeight);
    await deliverCursor({ row: -4, col: 0 });
    expect(px(cursor(viewport).style.top)).toBe(contentHeight + 3 * lineHeight);
  });

  test('matches cursor width to Unicode terminal units including FE0F promotion', async () => {
    const viewport = mountView();
    const cases = [
      { text: '❤', cells: 1 },
      { text: '❤️', cells: 2 },
      { text: '\x1b[31m❤️', cells: 2 },
      { text: '⚠', cells: 1 },
      { text: '⚠️', cells: 2 },
      { text: 'สั', cells: 1 },
      { text: '你', cells: 2 },
      { text: '🔥', cells: 2 },
    ];
    for (const entry of cases) {
      await deliver([entry.text], { row: 0, col: 0 });
      const cellWidth = px(viewport.style.getPropertyValue('--mtv-cw'));
      expect(px(cursor(viewport).style.width)).toBeCloseTo(entry.cells * cellWidth, 5);
    }
  });

  test('uses the same visible control-sequence stream as the renderer', async () => {
    const viewport = mountView();
    await deliver(['A\x1bc❤️B'], { row: 0, col: 1 });
    const line = viewport.querySelector<HTMLElement>('.mtv-line');
    expect(line?.textContent).toBe('A❤️B');
    const cellWidth = px(viewport.style.getPropertyValue('--mtv-cw'));
    expect(px(cursor(viewport).style.left)).toBeCloseTo(6 + cellWidth, 5);
    expect(px(cursor(viewport).style.width)).toBeCloseTo(2 * cellWidth, 5);
  });
});
