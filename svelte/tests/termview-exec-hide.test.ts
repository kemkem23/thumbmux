import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { proxy as reactiveProps } from 'svelte/internal/client';
import type { ComponentProps } from 'svelte';
import { flushSync, mount, tick, unmount } from './svelte-client';

import TermView from '../src/TermView.svelte';
import { tmuxMux } from '../src/ws-mux.svelte';
import {
  detectClaudeBashBlocks,
  projectClaudeBashGroupedLines,
  type AnsiPalette,
  type ClaudeBashMode,
} from '@thumbmux/core';

type MuxCallback = (
  data: string,
  type?: string,
  cursor?: { row: number; col: number } | null,
  meta?: {
    source: 'full' | 'delta';
    replace: boolean;
    screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
    boundary?: {
      generation: string;
      liveStartLine: number;
      walSequence: string;
      walOffset: number;
    };
  },
) => void;

type MountProps = ComponentProps<typeof TermView> & {
  claudeBashMode: ClaudeBashMode;
  historyPaging: 'ceiling' | 'sliding';
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
  const props = reactiveProps<MountProps>({
    session: `cc-exec-${mounted.length}`,
    palette,
    claimGeometry: false,
    fontPx: 13,
    screen: { alt: false, mouseSgr: false, mouseAny: false },
    claudeBashMode: mode,
    historyPaging: 'sliding',
  });
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(TermView as any, { target, props }) as Record<string, unknown>;
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
      generation: 'g-exec', liveStartLine: 0, walSequence: '0', walOffset: 0,
    },
  });
  flushSync();
}

async function settleUi(): Promise<void> {
  await Promise.resolve();
  await tick();
  flushSync();
}

describe('TermView active exec hide measurements (Lane E1)', () => {
  test('Case A: styled active header (Claude Code actual format) collapses and displays .mtv-bash-divider correctly', async () => {
    const viewport = mountView('hide');

    const lines = [
      '● อธิบายก่อน',
      '',
      '\x1b[38;5;246m \x1b[39m \x1b[1mBash\x1b[0m(./.agents/skills/exec/exec.sh codex sol "run")',
      '\x1b[38;5;246m  ⎿  running...',
      ...Array.from({ length: 30 }, (_, i) => `     stream line ${i}`),
    ];

    // Core layer measurement
    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks).toHaveLength(1);
    expect(detection.blocks[0]?.status).toBe('active');

    const projection = projectClaudeBashGroupedLines(lines, { mode: 'hide', detection });
    expect(projection.mode).toBe('hide');
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows[1]?.kind).toBe('bash-placeholder');
    expect(projection.rows[1]?.status).toBe('active');

    // UI layer measurement
    deliver(lines);
    await settleUi();

    const linesEls = viewport.querySelectorAll('.mtv-line');
    const divider = viewport.querySelector<HTMLElement>('.mtv-bash-divider');
    const placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');

    expect(linesEls.length).toBe(2);
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain('hidden bash');
    expect(placeholder?.classList.contains('mtv-bash-hidden')).toBe(true);
    expect(placeholder?.getAttribute('data-bash-status')).toBe('active');
  });

  test('Case B: unclosed bullet header (● Bash without boundary) does NOT collapse at all (remains raw rows)', async () => {
    const viewport = mountView('hide');

    const lines = [
      '● อธิบายก่อน',
      '',
      '\x1b[38;5;114m●\x1b[39m \x1b[1mBash\x1b[0m(./.agents/skills/exec/exec.sh codex sol "run")',
      '\x1b[38;5;246m  ⎿  running...',
      ...Array.from({ length: 30 }, (_, i) => `     stream line ${i}`),
    ];

    // Core layer measurement: completedHeader requires boundaryLine; when missing, parseCandidate returns null block
    const detection = detectClaudeBashBlocks(lines);
    expect(detection.blocks).toHaveLength(0);

    const projection = projectClaudeBashGroupedLines(lines, { mode: 'hide', detection });
    expect(projection.mode).toBe('hide');
    expect(projection.rows).toHaveLength(34);
    for (const row of projection.rows) {
      expect(row.kind).toBe('raw');
    }

    // UI layer measurement: renders all 34 raw lines, no divider, no hidden placeholder
    deliver(lines);
    await settleUi();

    const linesEls = viewport.querySelectorAll('.mtv-line');
    const divider = viewport.querySelector<HTMLElement>('.mtv-bash-divider');
    const placeholder = viewport.querySelector<HTMLElement>('.mtv-bash-placeholder');

    expect(linesEls.length).toBe(34);
    expect(divider).toBeNull();
    expect(placeholder).toBeNull();
  });

  test('Case C: every .mtv-bash-hidden row contains a non-null .mtv-bash-divider (no empty 1/3 height rows)', async () => {
    const viewport = mountView('hide');

    const lines = [
      'before',
      '\x1b[38;5;246m \x1b[39m \x1b[1mBash\x1b[0m(./.agents/skills/exec/exec.sh codex sol "run")',
      '\x1b[38;5;246m  ⎿  running...',
      '     first stream output',
      '     second stream output',
    ];

    deliver(lines);
    await settleUi();

    const hiddenLines = viewport.querySelectorAll<HTMLElement>('.mtv-line.mtv-bash-hidden');
    expect(hiddenLines.length).toBe(1);

    for (const lineEl of hiddenLines) {
      const divider = lineEl.querySelector('.mtv-bash-divider');
      expect(divider).not.toBeNull();
      expect(divider?.textContent).toContain('hidden bash');
      const label = lineEl.querySelector('.mtv-bash-divider-label');
      expect(label?.textContent).toBe('hidden bash');
      const rule = lineEl.querySelector('.mtv-bash-divider-rule');
      expect(rule).not.toBeNull();
    }
  });
});

