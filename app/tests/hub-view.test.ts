import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  defaultSurface,
  type LaunchPreset,
  type LaunchSpec,
  type SessionListItem,
} from '@thumbmux/core';
import { tmuxMux } from '@thumbmux/svelte';
import type { Component } from 'svelte';
import { flushSync, mount, tick, unmount } from '../../svelte/tests/svelte-client';
import HubView from '../src/HubView.svelte';
import type { AppAdapters } from '../src/config';

type HubViewProps = {
  adapters: AppAdapters;
  onOpen?: (name: string) => void;
};

type Mounted = {
  app: Record<string, unknown>;
  target: HTMLElement;
};

type MuxSurface = {
  onSessions(callback: (rows: SessionListItem[]) => void): () => void;
  subscribe(
    session: string,
    callback: (data: string, type: string) => void,
    options?: unknown,
  ): () => void;
};

const muxSurface = tmuxMux as unknown as MuxSurface;
const originalOnSessions = muxSurface.onSessions;
const originalSubscribe = muxSurface.subscribe;
const originalFetch = globalThis.fetch;
const mounted: Mounted[] = [];
let sessionCallbacks = new Set<(rows: SessionListItem[]) => void>();

const preset: LaunchPreset = {
  id: 'worker',
  label: 'Worker shell',
  color: '#345678',
  agent: 'tool',
  baseCommand: 'runner',
  permissionOptions: [{ value: 'standard', label: 'Standard', flag: '--safe' }],
  modelOptions: [{ value: 'default', label: 'Default', flag: '' }],
};

function session(
  name: string,
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    name,
    created: '1700000000',
    windows: 1,
    attached: false,
    activityAt: 1_700_000_000,
    ...overrides,
  };
}

function mountHub(props: HubViewProps): Mounted {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let app!: Record<string, unknown>;
  flushSync(() => {
    app = mount(HubView as Component<HubViewProps>, { target, props }) as Record<string, unknown>;
  });
  const entry = { app, target };
  mounted.push(entry);
  return entry;
}

function button(target: HTMLElement, selector: string): HTMLButtonElement {
  const element = target.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`missing button: ${selector}`);
  return element;
}

function click(target: HTMLElement, selector: string): void {
  flushSync(() => button(target, selector).click());
}

async function settleUi(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

beforeEach(() => {
  sessionCallbacks = new Set();
  muxSurface.onSessions = (callback) => {
    sessionCallbacks.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      sessionCallbacks.delete(callback);
    };
  };
  muxSurface.subscribe = () => () => {};
  globalThis.fetch = (async () => {
    throw new Error('unexpected fetch');
  }) as typeof fetch;
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    try {
      unmount(entry.app);
    } catch {
      // already torn down
    }
    entry.target.remove();
  }
  muxSurface.onSessions = originalOnSessions;
  muxSurface.subscribe = originalSubscribe;
  globalThis.fetch = originalFetch;
  sessionCallbacks.clear();
});

describe('HubView', () => {
  test('renders authoritative rows pushed through the host mux adapter', async () => {
    let pushRows: (rows: SessionListItem[]) => void = () => {};
    const adapterMux = {
      connected: true,
      onSessions(callback: (rows: SessionListItem[]) => void) {
        pushRows = callback;
        return () => {
          pushRows = () => {};
        };
      },
    } as unknown as NonNullable<AppAdapters['mux']>;
    const { target } = mountHub({
      adapters: {
        mux: adapterMux,
        fetchSessions: async () => [],
      },
    });
    await settleUi();

    flushSync(() => pushRows([
      session('adapter-push-one'),
      session('adapter-push-two'),
    ]));
    await settleUi();

    expect(target.querySelectorAll('[data-testid="grid-card"][data-session^="adapter-push-"]')).toHaveLength(2);
    expect(target.querySelector('[data-testid="hub-count"]')?.textContent).toBe('2 sessions');
  });

  test('renders thumbnail colors from the current host surface', async () => {
    const hostSurface = defaultSurface('#e4d3c2');
    const fallbackSurface = defaultSurface('#101014');
    const { target } = mountHub({
      adapters: {
        fetchSessions: async () => [
          session('surface-session'),
          session('fallback-session'),
        ],
        theme: {
          defaultBg: fallbackSurface.tbg,
          surfaceFor: (name) => name === 'surface-session' ? hostSurface : null,
        },
      },
    });
    await settleUi();

    const thumbnail = target.querySelector<HTMLElement>(
      '[data-testid="grid-card"][data-session="surface-session"] [data-testid="session-thumb"]',
    );
    expect(thumbnail?.style.getPropertyValue('--tbg')).toBe(hostSurface.palette.defaultBg);
    expect(thumbnail?.style.getPropertyValue('--tfg')).toBe(hostSurface.palette.defaultFg);
    expect(thumbnail?.style.getPropertyValue('--tbg')).not.toBe(fallbackSurface.palette.defaultBg);
    const fallbackThumbnail = target.querySelector<HTMLElement>(
      '[data-testid="grid-card"][data-session="fallback-session"] [data-testid="session-thumb"]',
    );
    expect(fallbackThumbnail?.style.getPropertyValue('--tbg')).toBe(fallbackSurface.palette.defaultBg);
  });

  test('mounts the real grid and renders metadata computed from normalized rows', async () => {
    const sourceRow = session('session-one', {
      windows: 3,
      attached: true,
      activityAt: 1_700_000_123,
    });
    const metaInputs: SessionListItem[][] = [];
    const opened: string[] = [];
    const adapters: AppAdapters = {
      fetchSessions: async () => [sourceRow],
      routes: {
        openSession: (name) => opened.push(name),
        showHub: () => {},
      },
      sessionMeta: (rows) => {
        metaInputs.push(rows);
        return rows.map((row) => ({
          name: row.name,
          state: row.attached ? 'working' : 'idle',
          stateLabel: `WINDOW SCORE ${row.windows * 7}`,
        }));
      },
      labels: {
        hubCount: (count) => `${count * 10} POINTS`,
      },
    };

    const { target } = mountHub({ adapters });
    await settleUi();

    expect(target.querySelectorAll('[data-testid="session-grid"]')).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="grid-card"][data-session="session-one"]')).toHaveLength(1);
    const producedRows = metaInputs.find((rows) => rows.length === 1);
    expect(producedRows?.[0]?.activityAt).toBe(1_700_000_123_000);
    expect(target.querySelector('[data-testid="grid-state"]')?.getAttribute('data-state')).toBe('working');
    expect(target.querySelector('[data-testid="grid-state"]')?.textContent).toContain('WINDOW SCORE 21');
    expect(target.querySelector('[data-testid="grid-state"] .dot')).toBeTruthy();
    expect(target.querySelector('[data-testid="hub-title"]')?.textContent?.trim().length).toBeGreaterThan(0);
    expect(target.querySelector('[data-testid="hub-count"]')?.textContent).toBe('10 POINTS');

    click(target, '[data-testid="grid-card"][data-session="session-one"]');
    expect(opened).toEqual(['session-one']);
  });

  test('emits the onOpen callback when no host route adapter is present', async () => {
    const opened: string[] = [];
    const { target } = mountHub({
      adapters: { fetchSessions: async () => [session('internal-session')] },
      onOpen: (name) => opened.push(name),
    });
    await settleUi();

    click(target, '[data-testid="grid-card"][data-session="internal-session"]');
    expect(opened).toEqual(['internal-session']);
  });

  test('loads contexts, forwards the selected context, and keeps busy launch open until success', async () => {
    const opened: string[] = [];
    const launches: Array<{ spec: LaunchSpec; contextId: string | null }> = [];
    let resolveLaunch!: (result: { name: string }) => void;
    const launchResult = new Promise<{ name: string }>((resolve) => {
      resolveLaunch = resolve;
    });
    const adapters: AppAdapters = {
      fetchSessions: async () => [],
      routes: {
        openSession: (name) => opened.push(name),
        showHub: () => {},
      },
      spawn: {
        presets: [preset],
        contexts: async () => [
          { id: 'workspace-a', label: 'Workspace A' },
          { id: 'workspace-b', label: 'Workspace B' },
        ],
        launch: (spec, contextId) => {
          launches.push({ spec, contextId });
          return launchResult;
        },
      },
    };

    const { target } = mountHub({ adapters });
    await settleUi();
    click(target, '[data-testid="grid-new"]');
    click(target, '[data-testid="launch-preset"][data-preset="worker"]');

    const context = target.querySelector<HTMLSelectElement>('[data-testid="launch-context"]');
    if (!context) throw new Error('context picker did not render');
    // happy-dom omits option:checked, which Svelte's select binding reads.
    // Patch only this element with the browser behavior for the interaction.
    const nativeQuerySelector = context.querySelector.bind(context);
    Object.defineProperty(context, 'querySelector', {
      configurable: true,
      value: (selector: string) => selector === ':checked'
        ? context.options.item(context.selectedIndex)
        : nativeQuerySelector(selector),
    });
    try {
      flushSync(() => {
        context.value = 'workspace-b';
        context.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } finally {
      delete (context as HTMLSelectElement & { querySelector?: unknown }).querySelector;
    }
    click(target, '[data-testid="launch-go"]');

    expect(launches).toHaveLength(1);
    expect(launches[0]?.contextId).toBe('workspace-b');
    expect(launches[0]?.spec.command).toBe('runner --safe');
    expect(button(target, '[data-testid="launch-go"]').disabled).toBe(true);

    click(target, 'button[aria-label="Close"]');
    expect(target.querySelector('[data-testid="launch-sheet"]')).toBeTruthy();

    resolveLaunch({ name: 'launched-session' });
    await settleUi();
    expect(target.querySelector('[data-testid="launch-sheet"]')).toBeNull();
    expect(opened).toEqual(['launched-session']);
  });

  test('lets a host label replace the complete launch error line', async () => {
    const labelMessages: string[] = [];
    const adapters: AppAdapters = {
      fetchSessions: async () => [],
      spawn: {
        presets: [preset],
        launch: async () => {
          throw new Error('policy rejected request');
        },
      },
      labels: {
        launchFailed: (message) => {
          labelMessages.push(message);
          return message.toUpperCase();
        },
      },
    };
    const { target } = mountHub({ adapters });
    await settleUi();
    click(target, '[data-testid="grid-new"]');
    click(target, '[data-testid="launch-preset"][data-preset="worker"]');
    click(target, '[data-testid="launch-go"]');
    await settleUi();

    expect(target.querySelector('[data-testid="launch-sheet"]')).toBeTruthy();
    expect(labelMessages).toEqual(['policy rejected request']);
    expect(target.querySelector('[data-testid="launch-sheet"] .err')?.textContent?.trim()).toBe('POLICY REJECTED REQUEST');
    expect(button(target, '[data-testid="launch-go"]').disabled).toBe(false);
  });

  test('does not navigate when a pending launch resolves after unmount', async () => {
    const opened: string[] = [];
    let launchCalls = 0;
    let resolveLaunch!: (result: { name: string }) => void;
    const launchResult = new Promise<{ name: string }>((resolve) => {
      resolveLaunch = resolve;
    });
    const entry = mountHub({
      adapters: {
        fetchSessions: async () => [],
        routes: {
          openSession: (name) => opened.push(name),
          showHub: () => {},
        },
        spawn: {
          presets: [preset],
          launch: () => {
            launchCalls += 1;
            return launchResult;
          },
        },
      },
    });
    await settleUi();
    click(entry.target, '[data-testid="grid-new"]');
    click(entry.target, '[data-testid="launch-preset"][data-preset="worker"]');
    click(entry.target, '[data-testid="launch-go"]');
    expect(launchCalls).toBe(1);

    unmount(entry.app);
    const mountedIndex = mounted.indexOf(entry);
    if (mountedIndex >= 0) mounted.splice(mountedIndex, 1);
    entry.target.remove();
    resolveLaunch({ name: 'late-session' });
    await settleUi();

    expect(opened).toHaveLength(0);
  });

  test('normalizes basePath for default session bootstrap and spawn routes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      if ((init?.method ?? 'GET') === 'POST') {
        return Response.json({ name: 'default-spawn-result' });
      }
      return Response.json([session('bootstrap-session')]);
    }) as typeof fetch;
    const opened: string[] = [];
    const adapters: AppAdapters = {
      basePath: ' service/// ',
      routes: {
        openSession: (name) => opened.push(name),
        showHub: () => {},
      },
      spawn: { presets: [preset] },
    };

    const { target } = mountHub({ adapters });
    await settleUi();
    expect(calls[0]?.url).toBe('/service/sessions');
    expect(target.querySelector('[data-session="bootstrap-session"]')).toBeTruthy();

    click(target, '[data-testid="grid-new"]');
    click(target, '[data-testid="launch-preset"][data-preset="worker"]');
    click(target, '[data-testid="launch-go"]');
    await settleUi();

    const spawnCall = calls.find((call) => call.init?.method === 'POST');
    expect(spawnCall?.url).toBe('/service/spawn');
    expect(spawnCall?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(spawnCall?.init?.body))).toEqual({
      presetId: 'worker',
      agent: 'tool',
      worktree: false,
      permission: 'standard',
      model: 'default',
      command: 'runner --safe',
    });
    expect(opened).toEqual(['default-spawn-result']);
  });
});
