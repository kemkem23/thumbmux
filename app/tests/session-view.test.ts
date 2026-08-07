import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from 'bun:test';
import type {
  AnsiPalette,
  SubmitAgent,
  TerminalSurfaceWithPalette,
  UploadedFile,
} from '@thumbmux/core';
import { submitPlan } from '@thumbmux/core';
import type { Component } from 'svelte';
// Svelte 5 mount() tracks prop updates only when the props bag is a reactive
// proxy — plain object mutation is a no-op and $set is a removed legacy stub.
// Tests that switch the live session prop use this so the same instance stays
// mounted while async work from the prior session can still resolve.
import { proxy as reactiveProps } from 'svelte/internal/client';
import { tmuxMux } from '@thumbmux/svelte';
import {
  createRawSnippet,
  flushSync,
  mount,
  tick,
  unmount,
} from '../../svelte/tests/svelte-client';

import EmbedView from '../src/EmbedView.svelte';
import SessionView from '../src/SessionView.svelte';
import type { AppAdapters, SessionActionContext } from '../src/config';

type Mounted = { app: Record<string, unknown>; target: HTMLElement };

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

const mounted: Mounted[] = [];
let originalConnected = false;
let originalSubscribe: PropertyDescriptor | undefined;
let originalOnSessions: PropertyDescriptor | undefined;
let originalSendKeys: PropertyDescriptor | undefined;
let originalSendResize: PropertyDescriptor | undefined;
let originalResizeObserver: PropertyDescriptor | undefined;
let originalWindowResizeObserver: PropertyDescriptor | undefined;
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

const SELF_INVALIDATING_MARKERS = [
  'effect_update_depth_exceeded',
  'Maximum update depth exceeded',
  'updated at',
] as const;

function diagnosticText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function mountView(
  component: Component,
  props: Record<string, unknown>,
): Mounted {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(diagnosticText).join(' '));
    originalError.apply(console, args as Parameters<typeof console.error>);
  };

  let app!: Record<string, unknown>;
  try {
    try {
      flushSync(() => {
        app = mount(component, { target, props }) as Record<string, unknown>;
      });
    } catch (error) {
      const text = diagnosticText(error);
      if (SELF_INVALIDATING_MARKERS.some((marker) => text.includes(marker))) {
        throw new Error(`Component self-invalidated during mount:\n${text}`);
      }
      throw error;
    }
    const joined = diagnostics.join('\n');
    const marker = SELF_INVALIDATING_MARKERS.find((candidate) => joined.includes(candidate));
    if (marker) throw new Error(`Component self-invalidated during mount (${marker}):\n${joined}`);
  } catch (error) {
    target.remove();
    throw error;
  } finally {
    console.error = originalError;
  }

  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** A minimal host `extraPanel`. `createRawSnippet` is the supported way to
 *  build a snippet outside a .svelte file; its render must return exactly one
 *  element, which is also what makes it identifiable in the panel stack. */
const hostPanelSnippet = createRawSnippet(() => ({
  render: () => '<div data-testid="host-extra-panel"></div>',
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

function palette(background: string): AnsiPalette {
  return {
    defaultFg: '#eeeeee',
    defaultBg: background,
    base: Array.from({ length: 16 }, () => '#111111'),
  };
}

type TransportCounters = {
  hostRows: number;
  hostOutput: number;
  hostKeys: number;
  singletonRows: number;
  singletonOutput: number;
  singletonKeys: number;
};

function transportCounters(): TransportCounters {
  return {
    hostRows: 0,
    hostOutput: 0,
    hostKeys: 0,
    singletonRows: 0,
    singletonOutput: 0,
    singletonKeys: 0,
  };
}

function liveSessionsMux(counters: TransportCounters): NonNullable<AppAdapters['mux']> {
  return {
    connected: true,
    onSessions(callback: (rows: unknown[]) => void) {
      counters.hostRows += 1;
      callback([]);
      return () => {};
    },
    subscribe() {
      counters.hostOutput += 1;
      return () => {};
    },
    sendKeys() {
      counters.hostKeys += 1;
    },
  } as unknown as NonNullable<AppAdapters['mux']>;
}

function observeSingletonTransport(counters: TransportCounters): void {
  tmuxMux.onSessions = ((callback: (rows: unknown[]) => void) => {
    counters.singletonRows += 1;
    callback([]);
    return () => {};
  }) as typeof tmuxMux.onSessions;
  tmuxMux.subscribe = (() => {
    counters.singletonOutput += 1;
    return () => {};
  }) as typeof tmuxMux.subscribe;
  tmuxMux.sendKeys = (() => {
    counters.singletonKeys += 1;
  }) as typeof tmuxMux.sendKeys;
}

async function composeAndSend(target: HTMLElement, text: string): Promise<void> {
  const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!terminal) throw new Error('View did not render TermView');
  flushSync(() => terminal.click());
  await tick();

  const input = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
  const send = target.querySelector<HTMLButtonElement>('[data-testid="input-sheet"] .snd');
  if (!input || !send) throw new Error('View did not open ComposerDock');
  flushSync(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tick();
  flushSync(() => send.click());
  await tick();
}

async function sendDirectText(target: HTMLElement, text: string): Promise<void> {
  const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
  if (!terminal) throw new Error('View did not render TermView');
  flushSync(() => terminal.click());
  await tick();

  const direct = Array.from(target.querySelectorAll<HTMLButtonElement>('.mode-btn'))
    .find((button) => button.textContent?.trim() === 'DIRECT');
  const input = target.querySelector<HTMLInputElement>('[data-testid="ghost-key"]');
  if (!direct || !input) throw new Error('View did not render direct input controls');
  flushSync(() => direct.click());
  await tick();
  flushSync(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tick();
}

function pasteFiles(target: Element, files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: { files },
  });
  target.dispatchEvent(event);
  return event;
}

async function openFab(target: HTMLElement): Promise<void> {
  const fab = target.querySelector<HTMLButtonElement>('.fab');
  if (!fab) throw new Error('SessionView did not render ActionFab');
  flushSync(() => fab.click());
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  originalConnected = tmuxMux.connected;
  originalSubscribe = Object.getOwnPropertyDescriptor(tmuxMux, 'subscribe');
  originalOnSessions = Object.getOwnPropertyDescriptor(tmuxMux, 'onSessions');
  originalSendKeys = Object.getOwnPropertyDescriptor(tmuxMux, 'sendKeys');
  originalSendResize = Object.getOwnPropertyDescriptor(tmuxMux, 'sendResize');
  originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  originalWindowResizeObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  tmuxMux.connected = false;
  tmuxMux.subscribe = (() => () => {}) as typeof tmuxMux.subscribe;
  tmuxMux.onSessions = ((callback: (rows: unknown[]) => void) => {
    callback([]);
    return () => {};
  }) as typeof tmuxMux.onSessions;
});

afterEach(() => {
  jest.useRealTimers();
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
  tmuxMux.connected = originalConnected;
  restoreProperty(tmuxMux, 'subscribe', originalSubscribe);
  restoreProperty(tmuxMux, 'onSessions', originalOnSessions);
  restoreProperty(tmuxMux, 'sendKeys', originalSendKeys);
  restoreProperty(tmuxMux, 'sendResize', originalSendResize);
  restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
  restoreProperty(window, 'ResizeObserver', originalWindowResizeObserver);
  restoreProperty(globalThis, 'fetch', originalFetch);
  document.body.replaceChildren();
});

describe('mountable terminal views', () => {
  // `termProps` returns a Partial, so `() => ({ palette: maybePalette })` with an
  // `AnsiPalette | undefined` in hand is type-correct and is what a host with a
  // conditional theme actually writes. Spreading that over the defaults copies the
  // explicit undefined and erases the fallback, and TermView declares palette as
  // required and reads it unguarded — so the view dies at mount with no diagnostic
  // pointing anywhere near the adapter. EmbedView resolves the same value with ??
  // and has always been fine; both are asserted so the two cannot drift apart again.
  test('an explicitly undefined termProps value falls back instead of erasing the default', async () => {
    for (const [label, view] of [['SessionView', SessionView], ['EmbedView', EmbedView]] as const) {
      const mounted = mountView(view, {
        session: `sh-undefined-${label.toLowerCase()}`,
        adapters: {
          termProps: () => ({ palette: undefined, fontPx: undefined, claimGeometry: undefined }),
        } satisfies AppAdapters,
      });
      await tick();
      expect(mounted.target.querySelectorAll('[data-testid="mtv"]'), label).toHaveLength(1);
    }
  });

  test('SessionView and EmbedView mount real package UI with the expected chrome', async () => {
    const session = mountView(SessionView, {
      session: 'sh-session-mount',
      adapters: { termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
    });
    const embed = mountView(EmbedView, {
      session: 'sh-embed-mount',
      adapters: {} satisfies AppAdapters,
      fontPx: 15,
      minRows: 18,
    });
    await tick();

    expect(session.target.querySelectorAll('*').length).toBeGreaterThan(10);
    expect(session.target.querySelectorAll('[data-testid="mtv"]')).toHaveLength(1);
    expect(session.target.querySelectorAll('[data-testid="input-sheet"]')).toHaveLength(1);
    expect(session.target.querySelectorAll('[data-testid="hud-expand"]')).toHaveLength(1);
    expect(session.target.querySelectorAll('.fab')).toHaveLength(1);

    expect(embed.target.querySelectorAll('*').length).toBeGreaterThan(3);
    expect(embed.target.querySelectorAll('[data-testid="mtv"]')).toHaveLength(1);
    expect(embed.target.querySelectorAll('[data-testid="input-sheet"]')).toHaveLength(1);
    expect(embed.target.querySelectorAll('[data-testid="hud-expand"]')).toHaveLength(0);
    expect(embed.target.querySelectorAll('.fab')).toHaveLength(0);
    expect(embed.target.querySelectorAll('[data-testid="shortcuts-sheet"]')).toHaveLength(0);
  });

  test('EmbedView omitted claimGeometry stays non-owning even when termProps requests geometry', async () => {
    ControlledResizeObserver.latest = null;
    globalThis.ResizeObserver = ControlledResizeObserver;
    window.ResizeObserver = ControlledResizeObserver;

    const resizeFrames: Array<{ session: string; cols: number; rows: number }> = [];
    tmuxMux.sendResize = ((session: string, cols: number, rows: number) => {
      resizeFrames.push({ session, cols, rows });
    }) as typeof tmuxMux.sendResize;

    const session = 'sh-embed-default-geometry';
    const { target } = mountView(EmbedView, {
      session,
      adapters: {
        termProps: () => ({ claimGeometry: true }),
      } satisfies AppAdapters,
    });
    await tick();

    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!terminal) throw new Error('EmbedView did not render TermView');
    Object.defineProperties(terminal, {
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 320 },
    });
    const observer = ControlledResizeObserver.latest;
    if (!observer) throw new Error('TermView did not observe its viewport');
    observer.fire();
    await tick();

    expect(resizeFrames.filter((frame) => frame.session === session)).toHaveLength(0);
  });

  test('EmbedView direct claimGeometry owns geometry even when termProps declines it', async () => {
    ControlledResizeObserver.latest = null;
    globalThis.ResizeObserver = ControlledResizeObserver;
    window.ResizeObserver = ControlledResizeObserver;

    const resizeFrames: Array<{ session: string; cols: number; rows: number }> = [];
    tmuxMux.sendResize = ((session: string, cols: number, rows: number) => {
      resizeFrames.push({ session, cols, rows });
    }) as typeof tmuxMux.sendResize;

    const session = 'sh-embed-owned-geometry';
    const { target } = mountView(EmbedView, {
      session,
      adapters: {
        termProps: () => ({ claimGeometry: false }),
      } satisfies AppAdapters,
      claimGeometry: true,
    });
    await tick();

    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!terminal) throw new Error('EmbedView did not render TermView');
    Object.defineProperties(terminal, {
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 320 },
    });
    const observer = ControlledResizeObserver.latest;
    if (!observer) throw new Error('TermView did not observe its viewport');
    observer.fire();
    await tick();

    const ownedFrames = resizeFrames.filter((frame) => frame.session === session);
    expect(ownedFrames.length).toBeGreaterThan(0);
    expect(ownedFrames.every((frame) => frame.cols > 0 && frame.rows > 0)).toBe(true);
  });

  test('sessionMeta gets the host mux and millisecond timestamps, exactly as the hub does', async () => {
    // The store normalizes protocol seconds to milliseconds before handing rows
    // to sessionMeta. SessionView subscribed straight to the singleton, so one
    // host callback saw two different units depending on which view called it —
    // and never saw a mux the host supplied at all.
    let push: ((rows: unknown[]) => void) | null = null;
    const hostMux = {
      subscribe: () => () => {},
      onSessions: (callback: (rows: unknown[]) => void) => {
        push = callback;
        callback([]);
        return () => {};
      },
    } as unknown as AppAdapters['mux'];

    const seen: Array<number | undefined> = [];
    mountView(SessionView, {
      session: 'sh-units',
      adapters: {
        mux: hostMux,
        termProps: () => ({ claimGeometry: false }),
        sessionMeta: (rows) => {
          for (const row of rows) seen.push(row.activityAt);
          return [];
        },
      } satisfies AppAdapters,
    });
    await tick();

    expect(push).not.toBeNull();
    push!([{ name: 'sh-units', activityAt: 1_700_000_000 }]);
    await tick();

    // 1_700_000_000 is a second-scale stamp; the hub would have reported it as
    // 1_700_000_000_000. Assert on what the view handed the callback.
    expect(seen).toContain(1_700_000_000_000);
    expect(seen).not.toContain(1_700_000_000);
  });

  test('SessionView keeps live rows on adapters.mux while pane output, HUD, and fallback keys share one transport', async () => {
    const counters = transportCounters();
    observeSingletonTransport(counters);
    const { target } = mountView(SessionView, {
      session: 'sh-session-transport',
      adapters: {
        mux: liveSessionsMux(counters),
        termProps: () => ({ claimGeometry: false }),
      } satisfies AppAdapters,
    });
    await tick();

    jest.useFakeTimers();
    await composeAndSend(target, 'probe');
    await sendDirectText(target, 'x');
    jest.advanceTimersByTime(150);
    await flushPromises();

    const status = target.querySelector('.st')?.textContent?.trim();
    console.log('X2_SESSION_TRANSPORT', JSON.stringify({ status, ...counters }));
    expect(status).toBe('OFFLINE');
    expect({
      hostRows: counters.hostRows,
      hostOutput: counters.hostOutput,
      hostKeys: counters.hostKeys,
      singletonRows: counters.singletonRows,
      singletonKeys: counters.singletonKeys,
    }).toEqual({
      hostRows: 1,
      hostOutput: 0,
      hostKeys: 0,
      singletonRows: 0,
      singletonKeys: 3,
    });
    expect(counters.singletonOutput).toBeGreaterThan(0);
  });

  test('EmbedView keeps pane output and both fallback key paths on the singleton transport', async () => {
    const counters = transportCounters();
    observeSingletonTransport(counters);
    const { target } = mountView(EmbedView, {
      session: 'sh-embed-transport',
      adapters: {
        mux: liveSessionsMux(counters),
        termProps: () => ({ claimGeometry: false }),
      } satisfies AppAdapters,
    });
    await tick();

    jest.useFakeTimers();
    await composeAndSend(target, 'probe');
    await sendDirectText(target, 'x');
    jest.advanceTimersByTime(150);
    await flushPromises();

    console.log('X2_EMBED_TRANSPORT', JSON.stringify(counters));
    expect({
      hostRows: counters.hostRows,
      hostOutput: counters.hostOutput,
      hostKeys: counters.hostKeys,
      singletonRows: counters.singletonRows,
      singletonKeys: counters.singletonKeys,
    }).toEqual({
      hostRows: 0,
      hostOutput: 0,
      hostKeys: 0,
      singletonRows: 0,
      singletonKeys: 3,
    });
    expect(counters.singletonOutput).toBeGreaterThan(0);
  });

  test('optional panels and upload UI render only when their adapters are supplied', async () => {
    const omitted = mountView(SessionView, {
      session: 'sh-no-notes',
      adapters: { termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
    });
    const included = mountView(SessionView, {
      session: 'sh-with-notes',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        notes: {
          load: async () => 'loaded note',
          save: async () => {},
        },
        prompts: async () => [],
        upload: { endpoint: () => '/upload' },
      } satisfies AppAdapters,
    });

    for (const entry of [omitted, included]) {
      const expand = entry.target.querySelector<HTMLButtonElement>('[data-testid="hud-expand"]');
      if (!expand) throw new Error('SessionView did not render its HUD toggle');
      flushSync(() => expand.click());
    }
    await flushPromises();

    expect(omitted.target.querySelectorAll('[data-testid="note-panel"]')).toHaveLength(0);
    expect(omitted.target.querySelectorAll('[data-testid="prompts-panel"]')).toHaveLength(0);
    expect(omitted.target.querySelectorAll('[data-testid="upload-input"]')).toHaveLength(0);
    expect(included.target.querySelectorAll('[data-testid="note-panel"]')).toHaveLength(1);
    expect(included.target.querySelectorAll('[data-testid="prompts-panel"]')).toHaveLength(1);
    expect(included.target.querySelectorAll('[data-testid="upload-input"]')).toHaveLength(1);
  });

  test('the prompt list becomes a disclosure only when the host asks for one', async () => {
    const stock = mountView(SessionView, {
      session: 'sh-stock-prompts',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        prompts: async () => ['first prompt', 'second prompt'],
      } satisfies AppAdapters,
    });
    const collapsible = mountView(SessionView, {
      session: 'sh-collapsible-prompts',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        prompts: async () => ['first prompt', 'second prompt'],
        sessionPresentation: { promptsCollapsible: true },
      } satisfies AppAdapters,
    });

    for (const entry of [stock, collapsible]) {
      const expand = entry.target.querySelector<HTMLButtonElement>('[data-testid="hud-expand"]');
      if (!expand) throw new Error('SessionView did not render its HUD toggle');
      flushSync(() => expand.click());
    }
    await flushPromises();

    // Unchanged for a host that did not opt in.
    expect(stock.target.querySelectorAll('[data-testid="prompts-toggle"]')).toHaveLength(0);
    expect(stock.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(2);

    // Opted in: the list is behind a control and starts closed.
    const toggle = collapsible.target.querySelector<HTMLButtonElement>('[data-testid="prompts-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(collapsible.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(0);

    flushSync(() => toggle!.click());
    await flushPromises();
    expect(collapsible.target.querySelectorAll('[data-testid="prompt-item"]')).toHaveLength(2);
  });

  test('extraPanel renders last by default and first when the host places it on top', async () => {
    // The stack's order is a priority order. A host whose extra panel says what
    // the session is doing wants it above a note and a prompt history, and the
    // only alternative was to give up the stock panels entirely.
    const adaptersFor = (placement?: 'top' | 'bottom'): AppAdapters => ({
      termProps: () => ({ claimGeometry: false }),
      notes: { load: async () => 'a note', save: async () => {} },
      prompts: async () => ['a prompt'],
      extraPanel: hostPanelSnippet,
      ...(placement ? { sessionPresentation: { extraPanelPlacement: placement } } : {}),
    });

    const stacks: Record<string, string[]> = {};
    for (const [key, placement] of [['default', undefined], ['top', 'top'], ['bottom', 'bottom']] as const) {
      const entry = mountView(SessionView, {
        session: `sh-panel-${key}`,
        adapters: adaptersFor(placement),
      });
      const expand = entry.target.querySelector<HTMLButtonElement>('[data-testid="hud-expand"]');
      if (!expand) throw new Error('SessionView did not render its HUD toggle');
      flushSync(() => expand.click());
      await flushPromises();
      stacks[key] = Array.from(
        entry.target.querySelectorAll('.hud-panel-stack > *'),
      ).map((node) => node.getAttribute('data-testid') ?? node.className);
    }

    expect(stacks.default).toEqual(['note-panel', 'prompts-panel', 'host-extra-panel']);
    expect(stacks.bottom).toEqual(['note-panel', 'prompts-panel', 'host-extra-panel']);
    expect(stacks.top).toEqual(['host-extra-panel', 'note-panel', 'prompts-panel']);
  });

  test('host surface wins over termProps palette while other term overrides remain', async () => {
    const termPalette = palette('#552211');
    const hostPalette = palette('#123456');
    const hostSurface: TerminalSurfaceWithPalette = {
      agent: '#abcdef',
      tbg: '#123456',
      tstage: '#101820',
      tfg: '#f4f4f4',
      hud: 'rgba(10,20,30,.9)',
      hudFg: '#eeeeee',
      hudLine: '#345678',
      badge: '#123456',
      badgeFg: '#ffffff',
      xterm: {},
      palette: hostPalette,
    };
    const { target } = mountView(SessionView, {
      session: 'sh-theme-precedence',
      adapters: {
        termProps: () => ({ claimGeometry: false, fontPx: 17, palette: termPalette }),
        theme: { surfaceFor: () => hostSurface },
      } satisfies AppAdapters,
    });
    await tick();

    const stage = target.querySelector<HTMLElement>('[data-testid="session-view"]');
    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!stage || !terminal) throw new Error('SessionView surface did not render');
    expect(stage.style.getPropertyValue('--agent')).toBe(hostSurface.agent);
    expect(terminal.style.getPropertyValue('--tbg')).toBe(hostPalette.defaultBg);
    expect(terminal.style.fontSize).toBe('17px');
  });

  test('submitAgent drives every legacy sendKeys step produced by submitPlan', async () => {
    const keyCalls: Array<[string, string]> = [];
    const agentCalls: string[] = [];
    const agent = ['co', 'dex'].join('') as SubmitAgent;
    const sessionName = 'sh-submit-plan';
    const draft = 'run the verification';
    const { target } = mountView(SessionView, {
      session: sessionName,
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        submitAgent: (session) => {
          agentCalls.push(session);
          return agent;
        },
        sendKeys: (session, keys) => { keyCalls.push([session, keys]); },
      } satisfies AppAdapters,
    });
    await tick();

    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!terminal) throw new Error('SessionView did not render TermView');
    flushSync(() => terminal.click());
    await tick();

    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    const send = target.querySelector<HTMLButtonElement>('[data-testid="input-sheet"] .snd');
    if (!input || !send) throw new Error('SessionView did not open ComposerDock');
    flushSync(() => {
      input.value = draft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick();

    const expected = submitPlan(draft, { agent });
    expect(expected).toHaveLength(3);
    jest.useFakeTimers();
    flushSync(() => send.click());

    expect(agentCalls).toEqual([sessionName]);
    expect(keyCalls).toEqual([[sessionName, expected[0]!.keys]]);

    jest.advanceTimersByTime(expected[1]!.delayBeforeMs);
    await flushPromises();
    expect(keyCalls).toEqual(expected.slice(0, 2).map((step) => [sessionName, step.keys]));

    jest.advanceTimersByTime(expected[2]!.delayBeforeMs);
    await flushPromises();
    expect(keyCalls).toEqual(expected.map((step) => [sessionName, step.keys]));
  });

  test('routes submission steps separately from raw keys in both terminal shells', async () => {
    jest.useFakeTimers();
    for (const [label, component] of [
      ['session', SessionView],
      ['embed', EmbedView],
    ] as const) {
      const sessionName = `sh-${label}-split-transport`;
      const rawCalls: Array<[string, string]> = [];
      const submissionCalls: Array<[string, string]> = [];
      const { target } = mountView(component, {
        session: sessionName,
        adapters: {
          termProps: () => ({ claimGeometry: false }),
          sendKeys: (session, keys) => { rawCalls.push([session, keys]); },
          sendSubmissionKeys: async (session: string, keys: string) => {
            submissionCalls.push([session, keys]);
          },
        } satisfies AppAdapters,
      });
      await tick();

      // Deliberately invert the byte-shape heuristic a host used to need:
      // the composed submission is one character, while raw input is longer.
      await composeAndSend(target, 'q');
      await flushPromises();
      await sendDirectText(target, 'raw');
      jest.advanceTimersByTime(1_000);
      await flushPromises();

      expect(submissionCalls).toEqual(
        submitPlan('q').map((step) => [sessionName, step.keys]),
      );
      expect(rawCalls).toEqual([[sessionName, 'raw']]);
    }
  });

  test('preserves every legacy submission byte when the new seam is omitted', async () => {
    jest.useFakeTimers();
    const agent = ['co', 'dex'].join('') as SubmitAgent;
    for (const [label, component] of [
      ['session', SessionView],
      ['embed', EmbedView],
    ] as const) {
      const sessionName = `sh-${label}-legacy-submit`;
      const draft = `${label} fallback`;
      const keyCalls: Array<[string, string]> = [];
      const expected = submitPlan(draft, { agent });
      const { target } = mountView(component, {
        session: sessionName,
        adapters: {
          termProps: () => ({ claimGeometry: false }),
          submitAgent: () => agent,
          sendKeys: (session, keys) => { keyCalls.push([session, keys]); },
        } satisfies AppAdapters,
      });
      await tick();

      await composeAndSend(target, draft);
      expect(keyCalls).toEqual([[sessionName, expected[0]!.keys]]);
      jest.advanceTimersByTime(expected[1]!.delayBeforeMs);
      await flushPromises();
      jest.advanceTimersByTime(expected[2]!.delayBeforeMs);
      await flushPromises();

      expect(keyCalls).toEqual(expected.map((step) => [sessionName, step.keys]));
    }
  });

  test('waits for each asynchronous submission step before starting the next', async () => {
    jest.useFakeTimers();
    for (const [label, component] of [
      ['session', SessionView],
      ['embed', EmbedView],
    ] as const) {
      const sessionName = `sh-${label}-await-submit`;
      const calls: Array<[string, string]> = [];
      let releaseFirst!: () => void;
      const firstRoundTrip = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const { target } = mountView(component, {
        session: sessionName,
        adapters: {
          termProps: () => ({ claimGeometry: false }),
          sendKeys: () => {
            throw new Error('submission leaked to the raw-key transport');
          },
          sendSubmissionKeys: (session: string, keys: string) => {
            calls.push([session, keys]);
            return calls.length === 1 ? firstRoundTrip : Promise.resolve();
          },
        } satisfies AppAdapters,
      });
      await tick();

      await composeAndSend(target, 'blocked');
      expect(calls).toEqual([[sessionName, 'blocked']]);

      // A timer cannot stand in for transport acknowledgement. Even a large
      // clock jump must not allow Enter to overtake the unresolved bulk step.
      jest.advanceTimersByTime(10_000);
      await flushPromises();
      expect(calls).toEqual([[sessionName, 'blocked']]);

      releaseFirst();
      await flushPromises();
      expect(calls).toEqual([
        [sessionName, 'blocked'],
        [sessionName, '\r'],
      ]);
    }
  });

  test('a stage tap dismisses the host before it opens the composer', async () => {
    let hostOpen = true;
    let dismissCalls = 0;
    const { target } = mountView(SessionView, {
      session: 'sh-host-sheet',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        extraDismissables: () => {
          dismissCalls += 1;
          if (!hostOpen) return false;
          hostOpen = false;
          return true;
        },
        extraOverlayOpen: () => hostOpen,
      } satisfies AppAdapters,
    });
    await tick();

    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const fab = target.querySelector<HTMLElement>('.fab');
    if (!terminal || !composer || !fab) throw new Error('SessionView terminal shell is incomplete');
    expect(fab.classList.contains('open')).toBe(true);

    flushSync(() => terminal.click());
    await tick();
    expect(dismissCalls).toBe(1);
    expect(hostOpen).toBe(false);
    expect(composer.classList.contains('open')).toBe(false);
    expect(fab.classList.contains('open')).toBe(false);

    flushSync(() => terminal.click());
    await tick();
    expect(dismissCalls).toBe(2);
    expect(composer.classList.contains('open')).toBe(true);

    flushSync(() => terminal.click());
    await tick();
    expect(dismissCalls).toBe(2);
    expect(composer.classList.contains('open')).toBe(false);
  });

  test('host extra actions close the stock FAB slots before running', async () => {
    let hostActionCalls = 0;
    const { target } = mountView(SessionView, {
      session: 'sh-extra-action',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        extraActions: () => [{
          id: 'host-action',
          label: 'Host action',
          testid: 'host-action',
          onTap: () => { hostActionCalls += 1; },
        }],
      } satisfies AppAdapters,
    });
    await tick();

    const fab = target.querySelector<HTMLButtonElement>('.fab');
    const slots = target.querySelector<HTMLElement>('.slots');
    if (!fab || !slots) throw new Error('SessionView did not render ActionFab');
    flushSync(() => fab.click());
    await tick();
    expect(slots.classList.contains('open')).toBe(true);

    const action = target.querySelector<HTMLButtonElement>('[data-testid="host-action"]');
    if (!action) throw new Error('SessionView did not append the host action');
    flushSync(() => action.click());
    await tick();
    expect(hostActionCalls).toBe(1);
    expect(slots.classList.contains('open')).toBe(false);
  });

  test('host can replace and reorder the complete FAB action list', async () => {
    let defaultIds: string[] = [];
    let presetCalls = 0;
    const { target } = mountView(SessionView, {
      session: 'sh-composed-actions',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        extraActions: () => [{
          id: 'legacy-extra',
          label: 'Legacy extra',
          testid: 'legacy-extra',
          onTap: () => {},
        }],
        sessionPresentation: {
          actions: (_session, _context, defaults) => {
            defaultIds = defaults.map((action) => action.id);
            const copy = defaults.find((action) => action.id === 'copy');
            const legacy = defaults.find((action) => action.id === 'legacy-extra');
            if (!copy || !legacy) throw new Error('complete default actions were not supplied');
            return [
              {
                id: 'host-preset',
                label: 'Host preset',
                testid: 'host-preset',
                onTap: () => {
                  presetCalls += 1;
                },
              },
              copy,
              legacy,
            ];
          },
        },
      } satisfies AppAdapters,
    });
    await tick();

    expect(defaultIds).toEqual([
      'type',
      'dpad',
      'copy',
      'shortcuts',
      'theme',
      'font-up',
      'font-down',
      'legacy-extra',
    ]);
    await openFab(target);
    const actions = Array.from(target.querySelectorAll<HTMLButtonElement>('.slots .slot'));
    expect(actions.map((action) => action.dataset.testid ?? null)).toEqual([
      'host-preset',
      'demo-copy',
      'legacy-extra',
    ]);

    const preset = target.querySelector<HTMLButtonElement>('[data-testid="host-preset"]');
    const slots = target.querySelector<HTMLElement>('.slots');
    if (!preset || !slots) throw new Error('composed FAB actions did not render');
    flushSync(() => preset.click());
    await tick();
    expect(presetCalls).toBe(1);
    expect(slots.classList.contains('open')).toBe(false);
  });

  test('host can suppress the persistent shortcut bar', async () => {
    const { target } = mountView(SessionView, {
      session: 'sh-no-shortcut-bar',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        sessionPresentation: { showShortcutBar: false },
      } satisfies AppAdapters,
    });
    await tick();

    expect(target.querySelectorAll('[data-testid="shortcut-bar"]')).toHaveLength(0);
    expect(target.querySelectorAll('[data-testid="shortcuts-sheet"]')).toHaveLength(1);
    await openFab(target);
    expect(target.querySelectorAll('[data-testid="demo-shortcuts"]')).toHaveLength(1);
  });

  test('host actions can copy the whole buffer even when text is selected', async () => {
    type OutputCallback = (
      data: string,
      type?: string,
      cursor?: { row: number; col: number } | null,
      meta?: { source: 'full' | 'delta'; replace: boolean },
    ) => void;
    let deliverOutput: OutputCallback | undefined;
    tmuxMux.subscribe = ((_session: string, callback: OutputCallback) => {
      deliverOutput = callback;
      return () => {};
    }) as typeof tmuxMux.subscribe;

    const writes: string[] = [];
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const selectionDescriptor = Object.getOwnPropertyDescriptor(window, 'getSelection');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ isCollapsed: false, toString: () => 'selected fragment' }),
    });

    try {
      const { target } = mountView(SessionView, {
        session: 'sh-copy-all-context',
        adapters: {
          termProps: () => ({ claimGeometry: false }),
          sessionPresentation: {
            actions: (_session, context, defaults) => [
              ...defaults.filter((action) => action.id !== 'copy'),
              {
                id: 'host-copy-all',
                label: 'Copy all',
                testid: 'host-copy-all',
                onTap: () => { void context.copyAll?.(); },
              },
            ],
          },
        } satisfies AppAdapters,
      });
      await tick();
      if (!deliverOutput) throw new Error('TermView did not subscribe for output');
      deliverOutput('whole first line\nwhole second line', 'output', null, {
        source: 'full',
        replace: true,
      });
      await tick();

      await openFab(target);
      const copyAll = target.querySelector<HTMLButtonElement>('[data-testid="host-copy-all"]');
      if (!copyAll) throw new Error('host copy-all action did not render');
      flushSync(() => copyAll.click());
      await flushPromises();

      expect(writes).toEqual(['whole first line\nwhole second line']);
    } finally {
      restoreProperty(navigator, 'clipboard', clipboardDescriptor);
      restoreProperty(window, 'getSelection', selectionDescriptor);
    }
  });

  test('topicless file pastes reach the upload adapter with action context', async () => {
    const calls: Array<{ session: string; files: File[] }> = [];
    const { target } = mountView(SessionView, {
      session: 'sh-topicless-paste',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: {
          endpoint: () => null,
          onUnavailable: (session, files, context) => {
            calls.push({ session, files: [...files] });
            context.prefill('Choose a topic before attaching files');
          },
        },
      } satisfies AppAdapters,
    });
    await tick();

    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    if (!textarea) throw new Error('SessionView did not render the composer textarea');
    const file = new File(['image'], 'topicless.png', { type: 'image/png' });
    const event = pasteFiles(textarea, [file]);
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual([{ session: 'sh-topicless-paste', files: [file] }]);
    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    expect(composer?.classList.contains('open')).toBe(true);
    expect(textarea.value).toBe('Choose a topic before attaching files');
  });

  test('forwards current session state to the stage', async () => {
    let push: ((rows: unknown[]) => void) | undefined;
    const mux = {
      subscribe: () => () => {},
      onSessions: (callback: (rows: unknown[]) => void) => {
        push = callback;
        callback([]);
        return () => {};
      },
    } as unknown as NonNullable<AppAdapters['mux']>;
    const { target } = mountView(SessionView, {
      session: 'sh-stage-state',
      adapters: {
        mux,
        termProps: () => ({ claimGeometry: false }),
        sessionMeta: (rows) => rows.map((row) => ({
          name: row.name,
          state: 'working',
          stateLabel: 'BUSY NOW',
        })),
      } satisfies AppAdapters,
    });
    await tick();
    if (!push) throw new Error('SessionView did not subscribe to session rows');
    push([{ name: 'sh-stage-state' }]);
    await tick();

    expect(target.querySelector('[data-testid="session-view"]')?.getAttribute('data-state'))
      .toBe('working');
  });

  test('omitted session presentation keeps the complete stock FAB order', async () => {
    let legacyContextKeys: string[] = [];
    const { target } = mountView(SessionView, {
      session: 'sh-stock-actions',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: { endpoint: () => '/upload' },
        extraActions: (_session, context) => {
          legacyContextKeys = Object.keys(context);
          return [{
            id: 'legacy-extra',
            label: 'Legacy extra',
            onTap: () => {},
          }];
        },
      } satisfies AppAdapters,
    });
    await tick();
    await openFab(target);

    expect(legacyContextKeys).toEqual(['submit', 'prefill']);
    const labels = Array.from(target.querySelectorAll<HTMLButtonElement>('.slots .slot'))
      .map((action) => action.textContent?.trim());
    expect(labels).toEqual([
      '⌨ Type',
      '📎 Attach files',
      '✛ Arrows',
      '⧉ Copy screen',
      '⚡ Shortcuts…',
      '🎨 Theme',
      'A+ Bigger text',
      'A− Smaller text',
      'Legacy extra',
    ]);
  });

  test('omitted shortcut option keeps the stock shortcut bar', async () => {
    const { target } = mountView(SessionView, {
      session: 'sh-stock-shortcut-bar',
      adapters: { termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
    });
    await tick();

    expect(target.querySelectorAll('[data-testid="shortcut-bar"]')).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="shortcut-chip"]').length).toBeGreaterThan(0);
    expect(target.querySelectorAll('[data-testid="shortcut-manage"]')).toHaveLength(1);
  });

  test('omitted copy control keeps stock selection-first behavior', async () => {
    type OutputCallback = (
      data: string,
      type?: string,
      cursor?: { row: number; col: number } | null,
      meta?: { source: 'full' | 'delta'; replace: boolean },
    ) => void;
    let deliverOutput: OutputCallback | undefined;
    tmuxMux.subscribe = ((_session: string, callback: OutputCallback) => {
      deliverOutput = callback;
      return () => {};
    }) as typeof tmuxMux.subscribe;

    const writes: string[] = [];
    let selectedText: string | null = 'selected fragment';
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const selectionDescriptor = Object.getOwnPropertyDescriptor(window, 'getSelection');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({
        isCollapsed: selectedText === null,
        toString: () => selectedText ?? '',
      }),
    });

    try {
      const { target } = mountView(SessionView, {
        session: 'sh-stock-copy',
        adapters: { termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
      });
      await tick();
      if (!deliverOutput) throw new Error('TermView did not subscribe for output');
      deliverOutput('whole fallback buffer', 'output', null, {
        source: 'full',
        replace: true,
      });
      await tick();
      await openFab(target);
      const copy = target.querySelector<HTMLButtonElement>('[data-testid="demo-copy"]');
      if (!copy) throw new Error('stock copy action did not render');
      flushSync(() => copy.click());
      await flushPromises();

      expect(writes).toEqual(['selected fragment']);

      selectedText = null;
      await openFab(target);
      flushSync(() => copy.click());
      await flushPromises();
      expect(writes).toEqual(['selected fragment', 'whole fallback buffer']);
    } finally {
      restoreProperty(navigator, 'clipboard', clipboardDescriptor);
      restoreProperty(window, 'getSelection', selectionDescriptor);
    }
  });

  test('omitted unavailable hook keeps endpoint-backed paste upload behavior', async () => {
    const storedFiles: UploadedFile[] = [{ original: 'pasted.png', stored: 'stored-paste.png' }];
    let fetchCalls = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (async () => {
        fetchCalls += 1;
        return Response.json({ files: storedFiles }, { status: 201 });
      }) as typeof fetch,
    });
    const { target } = mountView(SessionView, {
      session: 'sh-stock-paste-upload',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: {
          endpoint: () => '/upload',
          formatPrefill: (files) => `uploaded:${files[0]?.stored}`,
        },
      } satisfies AppAdapters,
    });
    await tick();

    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    if (!textarea) throw new Error('SessionView did not render the composer textarea');
    const event = pasteFiles(textarea, [new File(['image'], 'pasted.png', { type: 'image/png' })]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(fetchCalls).toBe(1);
    expect(textarea.value).toBe('uploaded:stored-paste.png');
  });

  test('topicless paste stays browser-owned when the unavailable hook is omitted', async () => {
    const { target } = mountView(SessionView, {
      session: 'sh-stock-topicless-paste',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: { endpoint: () => null },
      } satisfies AppAdapters,
    });
    await tick();

    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    if (!textarea || !composer) throw new Error('SessionView did not render ComposerDock');
    const event = pasteFiles(textarea, [new File(['image'], 'topicless.png')]);
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(composer.classList.contains('open')).toBe(false);
    expect(textarea.value).toBe('');
  });

  test('host actions receive canonical submit and composer-prefill controls', async () => {
    let context: SessionActionContext | undefined;
    const keyCalls: Array<[string, string]> = [];
    const { target } = mountView(SessionView, {
      session: 'sh-action-context',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        sendKeys: (session, keys) => { keyCalls.push([session, keys]); },
        extraActions: (_session, supplied) => {
          context = supplied;
          return [
            {
              id: 'host-prefill',
              label: 'Prefill',
              testid: 'host-prefill',
              onTap: () => supplied.prefill('recovered host draft'),
            },
            {
              id: 'host-submit',
              label: 'Submit',
              testid: 'host-submit',
              onTap: () => supplied.submit('host command'),
            },
          ];
        },
      } satisfies AppAdapters,
    });
    await tick();

    expect(context).toBeDefined();
    const fab = target.querySelector<HTMLButtonElement>('.fab');
    if (!fab || !context) throw new Error('SessionView did not provide SessionActionContext');
    flushSync(() => fab.click());
    await tick();
    const prefill = target.querySelector<HTMLButtonElement>('[data-testid="host-prefill"]');
    if (!prefill) throw new Error('SessionView did not render the host prefill action');
    flushSync(() => prefill.click());
    await tick();

    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea');
    if (!composer || !textarea) throw new Error('Host prefill did not open ComposerDock');
    expect(composer.classList.contains('open')).toBe(true);
    expect(textarea.value).toBe('recovered host draft');

    const terminal = target.querySelector<HTMLElement>('[data-testid="mtv"]');
    if (!terminal) throw new Error('SessionView did not render TermView');
    flushSync(() => terminal.click());
    await tick();
    flushSync(() => fab.click());
    await tick();
    const submit = target.querySelector<HTMLButtonElement>('[data-testid="host-submit"]');
    if (!submit) throw new Error('SessionView did not render the host submit action');

    jest.useFakeTimers();
    flushSync(() => submit.click());
    expect(keyCalls).toEqual([['sh-action-context', 'host command']]);
    jest.advanceTimersByTime(150);
    await flushPromises();
    expect(keyCalls).toEqual([
      ['sh-action-context', 'host command'],
      ['sh-action-context', '\r'],
    ]);
  });

  test('upload formatter computes the successful composer prefill', async () => {
    const storedFiles: UploadedFile[] = [
      { original: 'source note.txt', stored: 'stored-note.txt' },
    ];
    const formatterCalls: Array<{ files: UploadedFile[]; dir: string }> = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (async () => Response.json({ files: storedFiles }, { status: 201 })) as typeof fetch,
    });

    const { target } = mountView(SessionView, {
      session: 'sh-upload-format',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: {
          endpoint: () => '/upload',
          dir: 'session-files',
          formatPrefill: (files, dir) => {
            formatterCalls.push({ files, dir });
            return `${dir}:${files.map((file) => file.stored).join(',')}`;
          },
        },
      } satisfies AppAdapters,
    });
    await tick();

    const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]');
    if (!input?.files) throw new Error('SessionView did not render UploadAction');
    (input.files as unknown as File[]).push(new File(['payload'], 'source note.txt'));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    expect(formatterCalls).toEqual([{ files: storedFiles, dir: 'session-files' }]);
    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea');
    expect(composer?.classList.contains('open')).toBe(true);
    expect(textarea?.value).toBe('session-files:stored-note.txt');
  });

  // A7-2: UploadAction completion has no session/generation fence. A pending
  // upload started in session A can resolve after the host navigates to session
  // B and write A's paths into B's composer (and run formatPrefill against B).
  test('does not apply upload completion from a prior session after switching the mounted session', async () => {
    let resolveUpload!: (response: Response) => void;
    const storedFiles = [{ original: 'staged.txt', stored: 'staged-upload.txt' }];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (() => new Promise<Response>((resolve) => {
        resolveUpload = resolve;
      })) as typeof fetch,
    });

    const props = reactiveProps({
      session: 'sh-upload-race-before',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        upload: {
          endpoint: (name: string) => `/upload/${name}`,
          formatPrefill: () => 'A-prior-session-upload',
        },
      } satisfies AppAdapters,
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    let app!: Record<string, unknown>;
    flushSync(() => {
      app = mount(SessionView as Component, { target, props }) as Record<string, unknown>;
    });
    mounted.push({ app, target });
    await tick();

    const input = target.querySelector<HTMLInputElement>('[data-testid="upload-input"]');
    if (!input?.files) throw new Error('SessionView did not render UploadAction');
    (input.files as unknown as File[]).push(new File(['payload'], 'payload.txt'));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    flushSync(() => {
      props.session = 'sh-upload-race-after';
    });
    await tick();

    resolveUpload(Response.json({ files: storedFiles }, { status: 201 }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    await tick();

    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea');
    expect(composer?.classList.contains('open')).toBe(false);
    expect(textarea?.value).toBe('');
  });

  // A7-4: note load generation is independent of save generation. A slow initial
  // load can resolve after a successful save and replace the committed note.
  test('does not let a late note load overwrite a newer successful save in the same session', async () => {
    let resolveLoad!: (value: string) => void;
    const noteLoad = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });
    const { target } = mountView(SessionView, {
      session: 'sh-note-load-race',
      adapters: {
        termProps: () => ({ claimGeometry: false }),
        notes: {
          load: async () => noteLoad,
          save: async (_session, _text) => {},
        },
      } satisfies AppAdapters,
    });
    await tick();

    const expand = target.querySelector<HTMLButtonElement>('[data-testid="hud-expand"]');
    if (!expand) throw new Error('SessionView did not render the HUD toggle');
    flushSync(() => expand.click());
    await tick();

    const edit = target.querySelector<HTMLButtonElement>('[data-testid="note-edit"]');
    if (!edit) throw new Error('SessionView did not render note edit');
    flushSync(() => edit.click());
    await tick();

    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="note-draft"]');
    if (!draft) throw new Error('SessionView did not render the note draft');
    flushSync(() => {
      draft.value = 'new note';
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = target.querySelector<HTMLButtonElement>('[data-testid="note-save"]');
    if (!save) throw new Error('SessionView did not render note save');
    flushSync(() => save.click());
    await flushPromises();

    resolveLoad('old note');
    await flushPromises();
    await tick();

    const noteText = target.querySelector<HTMLElement>('[data-testid="note-text"]');
    if (!noteText) throw new Error('SessionView did not render note text');
    expect(noteText.textContent).toBe('new note');
  });
});
