/**
 * TermView integration coverage for strict Codex completed-tool projection.
 * Core tests own semantic detection; these tests prove that the Svelte layer
 * keeps one canonical raw coordinate space for rendering and interaction.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { proxy as reactiveProps } from 'svelte/internal/client';
import { flushSync, mount, tick, unmount } from './svelte-client';

import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import type { AnsiPalette, ClaudeBashMode } from '@thumbmux/core';

type CodexToolMode = 'off' | 'hide';

type Boundary = {
  generation: string;
  liveStartLine: number;
  walSequence: string;
  walOffset: number;
};

type Screen = { alt: boolean; mouseSgr: boolean; mouseAny: boolean };

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: {
    source: 'full' | 'delta';
    replace: boolean;
    screen?: Screen | null;
    boundary?: Boundary;
  },
) => void;

type ViewProps = {
  codexToolMode: CodexToolMode;
  claudeBashMode: ClaudeBashMode;
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
  viewport: HTMLElement;
  props: ViewProps;
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

const successfulRun = (zeroPrefixedBold = false) =>
  `\x1b[${zeroPrefixedBold ? '0;1' : '1'}m\x1b[38;5;2m•\x1b[0m `
  + `\x1b[${zeroPrefixedBold ? '0;1' : '1'}mRan\x1b[0m `
  + '\x1b[38;2;137;180;250mbun\x1b[38;2;205;214;244m test\x1b[39m';

const failedRun = '\x1b[1m\x1b[38;5;1m•\x1b[0m \x1b[1mRan\x1b[0m '
  + '\x1b[38;2;137;180;250mbun\x1b[38;2;205;214;244m test\x1b[39m';

const waited = '\x1b[0;1m• Waited for background terminal\x1b[0;2m'
  + ' · bun test\x1b[0m';

const ownerMobileWaited = '\x1b[0;1m• Waited for background terminal\x1b[0;2m'
  + ' · ./.agents/skills/\x1b[0m';
const ownerMobilePrompt = [
  "\x1b[2mexec/exec.sh codex sol 'Campaign 1\x1b[0m",
  '\x1b[2mVendor Chat, exactly one new read-only G4\x1b[0m',
  '\x1b[2mblocker-extraction/admission lane under authorized\x1b[0m',
  '\x1b[2mlocal fallback from terminal RELAY_UNAVAILABLE/FAILED.\x1b[0m',
];

const edited = '\x1b[2m• \x1b[0;1mEdited\x1b[0m src/view.ts ('
  + '\x1b[38;5;2m+2\x1b[39m \x1b[38;5;1m-1\x1b[39m)';

const runGroup = '\x1b[1m\x1b[38;5;2m•\x1b[0m \x1b[1mRan 2 commands'
  + '\x1b[0;2m · ctrl + t to view transcript\x1b[0m';

const mounted: Mounted[] = [];
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
    configurable: true,
    writable: true,
    value: ControlledResizeObserver,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ControlledResizeObserver,
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

function mountView(
  mode: CodexToolMode,
  options: {
    height?: number;
    useLiveScreen?: boolean;
    claudeBashMode?: ClaudeBashMode;
  } = {},
): Mounted {
  const target = document.createElement('div');
  const height = options.height ?? 240;
  target.style.cssText = `position:relative;width:320px;height:${height}px;`;
  document.body.appendChild(target);

  const props = reactiveProps({
    session: `codex-tools-${mode}-${mounted.length}`,
    palette,
    claimGeometry: false,
    fontPx: 13,
    screen: options.useLiveScreen
      ? undefined
      : { alt: false, mouseSgr: false, mouseAny: false },
    claudeBashMode: options.claudeBashMode ?? 'off',
    codexToolMode: mode,
  });
  let app: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as Component, { target, props }) as Record<string, unknown>;
  });

  const viewport = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!viewport) throw new Error('TermView viewport did not mount');
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

  const entry = {
    app: app!,
    target,
    viewport,
    props: props as unknown as ViewProps,
  };
  mounted.push(entry);
  return entry;
}

function deliver(
  lines: readonly string[],
  options: {
    replace?: boolean;
    cursor?: { row: number; col: number } | null;
    screen?: Screen | null;
    boundary?: Boundary | false;
  } = {},
): void {
  if (!sessionCallback) throw new Error('TermView did not subscribe');
  const boundary = options.boundary === false
    ? undefined
    : options.boundary ?? {
        generation: 'g-codex-tools',
        liveStartLine: 0,
        walSequence: '0',
        walOffset: 0,
      };
  sessionCallback(lines.join('\n'), 'output', options.cursor ?? null, {
    source: 'full',
    replace: options.replace ?? true,
    screen: options.screen ?? { alt: false, mouseSgr: false, mouseAny: false },
    ...(boundary ? { boundary } : {}),
  });
  flushSync();
}

async function settleUi(): Promise<void> {
  await Promise.resolve();
  await tick();
  flushSync();
}

function wheelUp(viewport: HTMLElement, pixels: number): void {
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
  return Number(row.getAttribute('data-presentation-top'))
    - Number(first.getAttribute('data-presentation-top'))
    + layerTranslateY(viewport);
}

function openSearch(viewport: HTMLElement, query: string): void {
  viewport.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'f', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  flushSync();
  const input = viewport.querySelector<HTMLInputElement>('[data-testid="term-search-input"]');
  if (!input) throw new Error('search input did not open');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('TermView Codex completed-tool projection', () => {
  test('merges adjacent sealed Ran and Waited ranges while an Edited header splits its body', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      '',
      successfulRun(),
      '\x1b[2m  └ 8 tests passed\x1b[0m',
      '',
      waited,
      '\x1b[2mexec/exec.sh codex --model gpt-5.6\x1b[0m',
      '',
      edited,
      '    \x1b[2m42 - old value\x1b[0m',
      '    \x1b[2m42 + new value\x1b[0m',
      '',
      'assistant prose',
    ];
    deliver(lines);
    await settleUi();

    const placeholders = viewport.querySelectorAll<HTMLElement>('.mtv-tool-placeholder');
    expect(placeholders).toHaveLength(2);
    expect(viewport.getAttribute('data-raw-total')).toBe(String(lines.length));
    expect(viewport.getAttribute('data-total')).toBe('7');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('3');
    expect(Array.from(placeholders, (row) => row.textContent)).toEqual([
      'hidden tools',
      'hidden tools',
    ]);
    expect(Array.from(placeholders, (row) => [
      row.getAttribute('data-raw-start'),
      row.getAttribute('data-raw-end'),
    ])).toEqual([
      ['1', '6'],
      ['8', '10'],
    ]);
    expect(Array.from(placeholders, (row) => row.getAttribute('data-tool-block-count')))
      .toEqual(['2', '1']);
    expect(placeholders[0]?.hasAttribute('data-tool-kind')).toBe(false);
    expect(placeholders[0]?.hasAttribute('data-tool-id')).toBe(false);
    expect(placeholders[1]?.getAttribute('data-tool-kind')).toBe('edit');
    expect(Array.from(placeholders, (row) => (
      row.querySelector('.mtv-tool-divider')?.getAttribute('aria-label')
    ))).toEqual([
      'hidden tools, 2 blocks, 5 rows',
      'hidden tools, 1 block, 2 rows',
    ]);
    expect(Array.from(placeholders, (row) => (
      row.querySelector('.mtv-tool-divider')?.getAttribute('title')
    ))).toEqual([
      'hidden tools · 2 blocks · 5 rows',
      'hidden tools · 1 block · 2 rows',
    ]);
    expect(viewport.querySelector('[data-raw-start="3"]')).toBeNull();
    for (const rawStart of [0, 6, 10]) {
      expect(viewport.querySelector<HTMLElement>(
        `[data-raw-start="${rawStart}"]`,
      )?.textContent?.replace(/\u00a0/g, ' ').trim()).toBe('');
    }
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="7"]')?.textContent)
      .toContain('Edited src/view.ts');
    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    for (const placeholder of placeholders) {
      expect(placeholder.style.height).toBe(`${lineHeight / 3}px`);
      expect(placeholder.getAttribute('data-tool-provider')).toBe('codex');
      expect(placeholder.getAttribute('data-tool-key')).toMatch(/^tool-placeholder:codex:/);
    }
  });

  test('hides the owner mobile Waited prompt behind an SGR/NBSP-only seal', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      '',
      ownerMobileWaited,
      ...ownerMobilePrompt,
      '\x1b[0m \u00a0\x1b[39m',
      'assistant prose',
    ];
    deliver(lines);
    await settleUi();

    const placeholder = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('1');
    expect(placeholder?.textContent).toBe('hidden tools');
    expect(placeholder?.getAttribute('data-raw-start')).toBe('1');
    expect(placeholder?.getAttribute('data-raw-end')).toBe('6');
    expect(viewport.textContent).not.toContain('Campaign 1');
    expect(viewport.textContent).toContain('assistant prose');
  });

  test('hides dim Waited continuations that quote failure-like prefixes', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      '',
      waited,
      '\x1b[2mexec/exec.sh codex sol "a long private prompt\x1b[0m',
      '\x1b[2mFAILED. Error Approval are quoted prompt text\x1b[0m',
      '',
      'assistant prose',
    ];
    deliver(lines);
    await settleUi();

    const placeholder = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('1');
    expect(placeholder?.getAttribute('data-raw-start')).toBe('1');
    expect(placeholder?.getAttribute('data-raw-end')).toBe('4');
    expect(viewport.textContent).not.toContain('quoted prompt text');
    expect(viewport.textContent).toContain('assistant prose');
  });

  test('merges directly adjacent self-completing Ran and sealed Waited blocks', async () => {
    const { viewport } = mountView('hide');
    const lines = ['', runGroup, ownerMobileWaited, '', 'assistant prose'];
    deliver(lines);
    await settleUi();

    const placeholders = viewport.querySelectorAll<HTMLElement>('.mtv-tool-placeholder');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('2');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.getAttribute('data-raw-start')).toBe('1');
    expect(placeholders[0]?.getAttribute('data-raw-end')).toBe('3');
    expect(placeholders[0]?.getAttribute('data-tool-block-count')).toBe('2');
    expect(viewport.textContent).toContain('assistant prose');
  });

  test('blank separators merge, while assistant prose, prompts, and live rows split groups', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      'before',
      '',
      runGroup,
      '\x1b[0m \u00a0',
      '',
      runGroup,
      '',
      'assistant prose between tools',
      '',
      runGroup,
      '',
      '› latest submitted prompt must split groups',
      '',
      runGroup,
      '',
      '\x1b[2m◦ Working (12s · esc to interrupt)\x1b[0m',
      '',
      runGroup,
      '',
      'after',
    ];
    deliver(lines);
    await settleUi();

    const placeholders = Array.from(
      viewport.querySelectorAll<HTMLElement>('.mtv-tool-placeholder'),
    );
    expect(viewport.getAttribute('data-raw-total')).toBe('20');
    expect(viewport.getAttribute('data-total')).toBe('17');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('5');
    expect(placeholders).toHaveLength(4);
    expect(placeholders.map((row) => [
      row.getAttribute('data-raw-start'),
      row.getAttribute('data-raw-end'),
      row.getAttribute('data-tool-block-count'),
    ])).toEqual([
      ['2', '6', '2'],
      ['9', '10', '1'],
      ['13', '14', '1'],
      ['17', '18', '1'],
    ]);
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="7"]')?.textContent)
      .toContain('assistant prose between tools');
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="11"]')?.textContent)
      .toContain('latest submitted prompt must split groups');
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="15"]')?.textContent)
      .toContain('Working (12s · esc to interrupt)');
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="19"]')?.textContent)
      .toContain('after');
  });

  test('keeps Working, prompts, red failures, approvals, and errors raw', async () => {
    const { viewport } = mountView('hide');
    const protectedRows = [
      '\x1b[2m◦ Working (12s · esc to interrupt)\x1b[0m',
      '› latest submitted prompt',
      failedRun,
      '\x1b[2m  └ tests failed\x1b[0m',
      'Do you want to allow this command?',
      'Error: permission denied',
    ];
    const lines = protectedRows.flatMap((line) => ['', line]);
    lines.push('');
    deliver(lines);
    await settleUi();

    expect(viewport.querySelector('.mtv-tool-placeholder')).toBeNull();
    expect(viewport.getAttribute('data-total')).toBe(String(lines.length));
    expect(viewport.textContent).toContain('Working (12s · esc to interrupt)');
    expect(viewport.textContent).toContain('latest submitted prompt');
    expect(viewport.textContent).toContain('permission denied');
  });

  test('keeps placeholder identity across ANSI repaint and mode toggles while copy stays raw', async () => {
    const { app, props, viewport } = mountView('hide');
    const pane = (repaint: boolean) => [
      '',
      successfulRun(repaint),
      repaint
        ? '\x1b[0;2m  └ 8 tests passed\x1b[0m'
        : '\x1b[2m  └ 8 tests passed\x1b[0m',
      '',
      'after',
    ];
    deliver(pane(false));
    await settleUi();

    const first = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    if (!first) throw new Error('initial Codex placeholder missing');
    const stableKey = first.getAttribute('data-tool-key');
    deliver(pane(true));
    await settleUi();
    const repainted = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(repainted?.getAttribute('data-tool-key')).toBe(stableKey);
    expect(repainted?.isSameNode(first)).toBe(true);

    // Reflowing older content changes the block's physical/absolute row even
    // though the tool itself is byte-equivalent. Semantic reconciliation must
    // keep the keyed DOM node instead of flashing a replacement marker.
    deliver([
      'older content half one',
      'older content half two',
      '',
      successfulRun(true),
      '\x1b[0;2m  └ 8 tests passed\x1b[0m',
      '',
      'after',
    ]);
    await settleUi();
    const reflowed = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(reflowed?.getAttribute('data-tool-key')).toBe(stableKey);
    expect(reflowed?.isSameNode(first)).toBe(true);
    deliver(pane(true));
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')?.isSameNode(first)).toBe(true);

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
      expect(copied).toContain('Ran bun test');
      expect(copied).toContain('8 tests passed');
      expect(copied).not.toContain('hidden tools');
    } finally {
      restoreProperty(nav, 'clipboard', clipboardDescriptor);
    }

    flushSync(() => { props.codexToolMode = 'off'; });
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')).toBeNull();
    expect(viewport.getAttribute('data-total')).toBe('5');

    flushSync(() => { props.codexToolMode = 'hide'; });
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')?.getAttribute('data-tool-key'))
      .toBe(stableKey);
  });

  test('keeps one adjacent-group node across row-id collisions, reflow, and append', async () => {
    const { viewport } = mountView('hide');
    deliver(['', runGroup, '', runGroup, '', 'after']);
    await settleUi();
    const before = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    if (!before) throw new Error('initial adjacent Codex group missing');
    expect(viewport.querySelectorAll('.mtv-tool-placeholder')).toHaveLength(1);
    expect(before.getAttribute('data-raw-start')).toBe('1');
    expect(before.getAttribute('data-raw-end')).toBe('4');
    expect(before.getAttribute('data-tool-block-count')).toBe('2');
    const key = before.getAttribute('data-tool-key');
    before.setAttribute('data-adjacent-group-node', 'stable');

    // Both retained members move down two rows while a third adjacent member
    // appears. The group grows and changes raw coordinates without replacing
    // the keyed divider node.
    const reflowedAndAppended = [
      'older half one', 'older half two', '',
      runGroup, '', runGroup, '', runGroup, '', 'after',
    ];
    deliver(reflowedAndAppended);
    await settleUi();
    const after = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(viewport.querySelectorAll('.mtv-tool-placeholder')).toHaveLength(1);
    expect(after?.getAttribute('data-raw-start')).toBe('3');
    expect(after?.getAttribute('data-raw-end')).toBe('8');
    expect(after?.getAttribute('data-tool-block-count')).toBe('3');
    expect(after?.getAttribute('data-tool-key')).toBe(key);
    expect(after?.getAttribute('data-adjacent-group-node')).toBe('stable');
    expect(after?.isSameNode(before)).toBe(true);

    // An identical detector frame must not churn the carried group identity.
    deliver(reflowedAndAppended);
    await settleUi();
    const stable = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(stable?.getAttribute('data-tool-key')).toBe(key);
    expect(stable?.isSameNode(before)).toBe(true);
  });

  test('keeps one group stable while the 512-block cap has retained members', async () => {
    const { viewport } = mountView('hide', { height: 240 });
    const appendBlocks = (base: readonly string[], count: number): string[] => {
      const lines = [...base];
      for (let index = 0; index < count; index += 1) lines.push(runGroup, '');
      return lines;
    };
    const initial = appendBlocks([''], 512);
    deliver(initial);
    await settleUi();
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('512');
    expect(viewport.querySelectorAll('.mtv-tool-placeholder')).toHaveLength(1);
    const survivor = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    if (!survivor) throw new Error('cap fixture did not render its grouped placeholder');
    expect(survivor.getAttribute('data-raw-start')).toBe('1');
    expect(survivor.getAttribute('data-raw-end')).toBe('1024');
    expect(survivor.getAttribute('data-tool-block-count')).toBe('512');
    const survivorKey = survivor.getAttribute('data-tool-key');
    survivor.setAttribute('data-cap-group-node', 'old');

    const appendedOne = appendBlocks(initial, 1);
    deliver(appendedOne);
    await settleUi();
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('512');
    expect(viewport.querySelectorAll('.mtv-tool-placeholder')).toHaveLength(1);
    const afterOne = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(afterOne?.getAttribute('data-raw-start')).toBe('3');
    expect(afterOne?.getAttribute('data-raw-end')).toBe('1026');
    expect(afterOne?.getAttribute('data-tool-block-count')).toBe('512');
    expect(afterOne?.getAttribute('data-tool-key')).toBe(survivorKey);
    expect(afterOne?.getAttribute('data-cap-group-node')).toBe('old');
    expect(afterOne?.isSameNode(survivor)).toBe(true);

    // With 512 further appends the final 512-window contains only new blocks;
    // the old group must disappear rather than lend its key or node to new work.
    deliver(appendBlocks(appendedOne, 512));
    await settleUi();
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('512');
    expect(viewport.querySelectorAll('.mtv-tool-placeholder')).toHaveLength(1);
    const replacement = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(replacement?.getAttribute('data-raw-start')).toBe('1027');
    expect(replacement?.getAttribute('data-raw-end')).toBe('2050');
    expect(replacement?.getAttribute('data-tool-block-count')).toBe('512');
    expect(replacement?.getAttribute('data-tool-key')).not.toBe(survivorKey);
    expect(replacement?.isSameNode(survivor)).toBe(false);
    expect(viewport.querySelector('[data-cap-group-node="old"]')).toBeNull();
  });

  test('maps raw search and cursor through a compact row while hidden ANSI still advances SGR', async () => {
    const { viewport } = mountView('hide');
    const lines = [
      '',
      successfulRun(),
      '\x1b[2m  └ \x1b[31msecret-output',
      '',
      'after',
    ];
    deliver(lines, { cursor: { row: 0, col: 0 } });
    await settleUi();

    const placeholder = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    const after = viewport.querySelector<HTMLElement>('[data-raw-start="4"]');
    expect(placeholder?.getAttribute('data-raw-start')).toBe('1');
    expect(placeholder?.getAttribute('data-raw-end')).toBe('3');
    expect(after?.innerHTML).toContain('color:#aa0000');

    const lineHeight = Number.parseFloat(viewport.style.getPropertyValue('--mtv-lineh'));
    const cursor = viewport.querySelector<HTMLElement>('[data-testid="mtv-cursor"]');
    expect(cursor?.style.top).toBe(`${2 * lineHeight + lineHeight / 3}px`);

    openSearch(viewport, 'secret-output');
    await settleUi();
    expect(viewport.querySelector('[data-testid="term-search-match"]')?.textContent)
      .toContain('1 matches');
    expect(viewport.querySelector('.mtv-tool-placeholder .search-active')?.textContent)
      .toContain('hidden tools');

    // A raw cursor inside the hidden source must not paint over a one-third UI row.
    deliver(lines, { cursor: { row: 3, col: 0 } });
    await settleUi();
    expect(viewport.querySelector('[data-testid="mtv-cursor"]')).toBeNull();
  });

  test('fails open at an unknown leading edge and in alternate screen', async () => {
    const { viewport } = mountView('hide', { useLiveScreen: true });
    deliver([runGroup, 'tail'], {
      boundary: false,
      screen: { alt: false, mouseSgr: false, mouseAny: false },
    });
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')).toBeNull();

    deliver([runGroup, 'tail']);
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')).not.toBeNull();

    deliver(['', successfulRun(), '\x1b[2m  └ ok\x1b[0m', ''], {
      screen: { alt: true, mouseSgr: false, mouseAny: false },
    });
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')).toBeNull();
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('0');
  });

  test('revalidates the leading edge after client retention removes its proof row', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    // The provisional over-budget world can prove the aggregate marker from
    // its preceding blank. Retention then removes both prefix rows, placing
    // the same marker at an unknown client-cut origin. The final projection
    // must expand it instead of reusing provisional evidence.
    deliver([
      'oldest row to discard',
      '',
      runGroup,
      ...Array.from({ length: 9_999 }, (_, index) => `tail-${index}`),
    ]);
    await settleUi();

    expect(viewport.getAttribute('data-raw-total')).toBe('10000');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('0');
    wheelUp(viewport, 1_000_000);
    await settleUi();
    expect(viewport.querySelector('.mtv-tool-placeholder')).toBeNull();
    expect(viewport.querySelector<HTMLElement>('[data-raw-start="0"]')?.textContent)
      .toContain('Ran 2 commands');
  });

  test('retention gaps are hard barriers and never seal one cross-gap Waited block', async () => {
    const { viewport } = mountView('hide', { height: 120 });
    deliver(Array.from({ length: 10_000 }, (_, index) => `base-${index}`));
    await settleUi();
    wheelUp(viewport, 1_000_000);

    const protectedEnd = Math.max(...Array.from(
      viewport.querySelectorAll<HTMLElement>('.mtv-line'),
      (line) => Number(line.getAttribute('data-raw-end')),
    ));
    expect(protectedEnd).toBeGreaterThan(8);

    const next = Array.from({ length: 12_100 }, (_, index) => `next-${index}`);
    // A known-good block before the discontinuity proves that Codex hiding is
    // active. The second candidate would look sealed only if the detector
    // incorrectly treated the 2,100 discarded rows as semantic adjacency.
    next[protectedEnd - 6] = '';
    next[protectedEnd - 5] = successfulRun();
    next[protectedEnd - 4] = '\x1b[2m  └ valid-before-gap\x1b[0m';
    next[protectedEnd - 3] = '';
    next[protectedEnd - 1] = waited;
    next[protectedEnd + 2_100] = '\x1b[2mexec/exec.sh must-not-cross-gap\x1b[0m';
    next[protectedEnd + 2_101] = '';
    next[protectedEnd + 2_102] = 'assistant prose after gap';
    deliver(next);
    await settleUi();

    expect(viewport.getAttribute('data-raw-total')).toBe('10000');
    expect(viewport.getAttribute('data-codex-tool-block-count')).toBe('1');
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 1_500,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    }));
    flushSync();
    const placeholders = viewport.querySelectorAll('.mtv-tool-placeholder');
    expect(placeholders).toHaveLength(1);
    expect(viewport.textContent).toContain('Waited for background terminal');
    expect(viewport.querySelector('[data-gap-marker-rows="2100"]')).not.toBeNull();
  });

  test('keeps the absolute placeholder key when prefix eviction shifts its raw index', async () => {
    const { viewport } = mountView('hide', { height: 240 });
    const initial = [
      ...Array.from({ length: 9_990 }, (_, index) => `prefix-${index}`),
      '',
      successfulRun(),
      '\x1b[2m  └ stable identity\x1b[0m',
      '',
      ...Array.from({ length: 5 }, (_, index) => `tail-${index}`),
    ];
    deliver(initial);
    await settleUi();
    const before = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    if (!before) throw new Error('pre-eviction placeholder was not mounted');
    const key = before.getAttribute('data-tool-key');
    const rawStart = Number(before.getAttribute('data-raw-start'));

    deliver([...initial, 'tail-new-0', 'tail-new-1']);
    await settleUi();
    const after = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    if (!after) throw new Error('surviving placeholder was not mounted');
    expect(Number(after.getAttribute('data-raw-start'))).toBe(rawStart - 1);
    expect(after.getAttribute('data-tool-key')).toBe(key);
    expect(viewport.getAttribute('data-raw-total')).toBe('10000');
  });

  test('show-hide-show preserves the same raw reader anchor on screen', async () => {
    const { props, viewport } = mountView('hide', { height: 120 });
    const prefix = Array.from({ length: 20 }, (_, index) => `prefix-${index}`);
    const suffix = Array.from({ length: 180 }, (_, index) => `anchor-${index}`);
    deliver([
      ...prefix,
      '',
      successfulRun(),
      '\x1b[2m  └ anchor-tool-output\x1b[0m',
      '',
      ...suffix,
    ]);
    await settleUi();
    wheelUp(viewport, 1_700);
    await settleUi();

    const before = Array.from(viewport.querySelectorAll<HTMLElement>('.mtv-line'))
      .find((row) => {
        const y = projectedScreenY(viewport, row);
        return row.textContent?.startsWith('anchor-') && y >= 0 && y < 120;
      });
    if (!before) throw new Error('reader anchor did not enter the viewport');
    const rowId = before.getAttribute('data-line-id');
    const beforeY = projectedScreenY(viewport, before);

    flushSync(() => { props.codexToolMode = 'off'; });
    await settleUi();
    let after = viewport.querySelector<HTMLElement>(`[data-line-id="${rowId}"]`);
    if (!after) throw new Error('raw anchor disappeared in show mode');
    expect(projectedScreenY(viewport, after)).toBeCloseTo(beforeY, 5);

    flushSync(() => { props.codexToolMode = 'hide'; });
    await settleUi();
    after = viewport.querySelector<HTMLElement>(`[data-line-id="${rowId}"]`);
    if (!after) throw new Error('raw anchor disappeared after re-hiding');
    expect(projectedScreenY(viewport, after)).toBeCloseTo(beforeY, 5);
  });

  test('Claude and Codex placeholders share one raw-derived presentation mapping', async () => {
    const { viewport } = mountView('hide', { claudeBashMode: 'hide' });
    const claudeHeader = '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(printf claude)';
    deliver([
      'before',
      '',
      claudeHeader,
      '\x1b[38;5;246m  ⎿ \u00a0claude output\x1b[0m',
      '',
      '● ต่อไป',
      '',
      successfulRun(),
      '\x1b[2m  └ codex output\x1b[0m',
      '',
      'after',
    ]);
    await settleUi();

    const claude = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');
    const codex = viewport.querySelector<HTMLElement>('.mtv-tool-placeholder');
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();
    expect(Number(claude?.getAttribute('data-raw-end')))
      .toBeLessThanOrEqual(Number(codex?.getAttribute('data-raw-start')));
    expect(viewport.getAttribute('data-raw-total')).toBe('11');
    expect(viewport.textContent).toContain('hidden bash');
    expect(viewport.textContent).toContain('hidden tools');
  });
});
