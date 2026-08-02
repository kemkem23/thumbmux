import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { SessionListItem } from '@thumbmux/core';
import { tmuxMux } from '@thumbmux/svelte';
import { resolve } from 'node:path';
import type { Component } from 'svelte';
import {
  flushSync,
  mount,
  tick,
  unmount,
} from '../../svelte/tests/svelte-client';
import { derivePublicExportManifest } from '../../scripts/rewrite-git-dist-imports';
import * as app from '../src';
import SessionView from '../src/SessionView.svelte';
import ThumbmuxApp from '../src/ThumbmuxApp.svelte';
import type {
  AppAdapters,
  AppLabels,
  SessionActionContext,
  SubmissionTransport,
} from '../src';
import { createQueryParamNav } from '../src/navigation';

type ThumbmuxAppProps = { adapters: AppAdapters };
type SessionViewProps = { session: string; adapters: AppAdapters };
type Mounted = { app: Record<string, unknown>; target: HTMLElement };
type MuxSurface = {
  onSessions(callback: (rows: SessionListItem[]) => void): () => void;
  subscribe(
    session: string,
    callback: (data: string, type: string) => void,
    options?: unknown,
  ): () => void;
};

const REQUIRED_RUNTIME_EXPORTS = [
  'DEFAULT_APP_LABELS',
  'EmbedView',
  'HubView',
  'SessionView',
  'ThumbmuxApp',
  'createQueryParamNav',
  'createSessionsStore',
  'nextStageOverlay',
  'prefillOnError',
] as const;
const REQUIRED_TYPE_EXPORTS = [
  'AppAdapters',
  'AppLabels',
  'SessionActionContext',
  'SubmissionTransport',
] as const;

// Keep the compiler-facing imports live in this test source. The manifest
// assertion below is what verifies them at runtime, since Bun erases types.
type ConfigExports = [
  AppAdapters,
  AppLabels,
  SessionActionContext,
  SubmissionTransport,
];
void (undefined as unknown as ConfigExports);

const muxSurface = tmuxMux as unknown as MuxSurface;
const mounted: Mounted[] = [];
let originalOnSessions: PropertyDescriptor | undefined;
let originalSubscribe: PropertyDescriptor | undefined;
let originalReplaceState: PropertyDescriptor | undefined;

function row(name: string): SessionListItem {
  return {
    name,
    created: '1700000000',
    windows: 1,
    attached: false,
    activityAt: 1_700_000_000,
  };
}

function adaptersFor(name: string, extra: Partial<AppAdapters> = {}): AppAdapters {
  return {
    fetchSessions: async () => [row(name)],
    termProps: () => ({ claimGeometry: false }),
    prefs: {
      load: async () => ({}),
      save: async () => {},
    },
    ...extra,
  };
}

function mountApp(adapters: AppAdapters): Mounted {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let instance!: Record<string, unknown>;
  flushSync(() => {
    instance = mount(ThumbmuxApp as Component<ThumbmuxAppProps>, {
      target,
      props: { adapters },
    }) as Record<string, unknown>;
  });
  const entry = { app: instance, target };
  mounted.push(entry);
  return entry;
}

function mountSessionView(session: string, adapters: AppAdapters): Mounted {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let instance!: Record<string, unknown>;
  flushSync(() => {
    instance = mount(SessionView as Component<SessionViewProps>, {
      target,
      props: { session, adapters },
    }) as Record<string, unknown>;
  });
  const entry = { app: instance, target };
  mounted.push(entry);
  return entry;
}

function click(target: HTMLElement, selector: string): void {
  const element = target.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`missing button: ${selector}`);
  flushSync(() => element.click());
}

async function settleUi(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
  localStorage.clear();

  originalOnSessions = Object.getOwnPropertyDescriptor(muxSurface, 'onSessions');
  originalSubscribe = Object.getOwnPropertyDescriptor(muxSurface, 'subscribe');
  originalReplaceState = Object.getOwnPropertyDescriptor(history, 'replaceState');

  muxSurface.onSessions = () => () => {};
  muxSurface.subscribe = () => () => {};
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
  restoreProperty(muxSurface, 'onSessions', originalOnSessions);
  restoreProperty(muxSurface, 'subscribe', originalSubscribe);
  restoreProperty(history, 'replaceState', originalReplaceState);
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

describe('SessionView submission failure handling', () => {
  test('restores the composer only when the submission transport fails', async () => {
    let context: SessionActionContext | undefined;
    let transportCalls = 0;
    history.replaceState(null, '', '/?session=transport-failure');
    const { target } = mountApp(adaptersFor('transport-failure', {
      sendKeys: () => {
        transportCalls += 1;
        throw new Error('transport unavailable');
      },
      extraActions: (_session, supplied) => {
        context = supplied;
        return [];
      },
    }));
    await settleUi();

    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    if (!context || !composer) throw new Error('submission context did not mount');
    expect(composer.classList.contains('open')).toBe(false);

    context.submit('recover this draft');
    await settleUi();

    expect(transportCalls).toBe(1);
    expect(composer.classList.contains('open')).toBe(true);
  });

  test('uses the same transport recovery for shortcut submissions', async () => {
    let transportCalls = 0;
    history.replaceState(null, '', '/?session=shortcut-failure');
    const { target } = mountApp(adaptersFor('shortcut-failure', {
      sendKeys: () => {
        transportCalls += 1;
        throw new Error('transport unavailable');
      },
    }));
    await settleUi();

    const shortcut = target.querySelector<HTMLButtonElement>('[data-testid="shortcut-chip"]');
    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    if (!shortcut || !composer) throw new Error('shortcut submission UI did not mount');
    expect(composer.classList.contains('open')).toBe(false);

    flushSync(() => shortcut.click());
    await settleUi();

    expect(transportCalls).toBe(1);
    expect(composer.classList.contains('open')).toBe(true);
  });

  test('restores the composer after an asynchronous submission transport rejects', async () => {
    let context: SessionActionContext | undefined;
    let submissionCalls = 0;
    let rawCalls = 0;
    history.replaceState(null, '', '/?session=async-transport-failure');
    const { target } = mountApp(adaptersFor('async-transport-failure', {
      sendKeys: () => { rawCalls += 1; },
      sendSubmissionKeys: async () => {
        submissionCalls += 1;
        throw new Error('submission request rejected');
      },
      extraActions: (_session, supplied) => {
        context = supplied;
        return [];
      },
    }));
    await settleUi();

    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    if (!context || !composer) throw new Error('submission context did not mount');
    expect(composer.classList.contains('open')).toBe(false);

    context.submit('recover rejected draft');
    await settleUi();

    expect(submissionCalls).toBe(1);
    expect(rawCalls).toBe(0);
    expect(composer.classList.contains('open')).toBe(true);
  });

  test('surfaces submission setup errors instead of treating them as transport failures', async () => {
    let context: SessionActionContext | undefined;
    const setupError = new Error('submission transport getter failed');
    const adapters = adaptersFor('setup-failure', {
      extraActions: (_session, supplied) => {
        context = supplied;
        return [];
      },
    });
    Object.defineProperty(adapters, 'sendKeys', {
      configurable: true,
      get() {
        throw setupError;
      },
    });

    mountSessionView('setup-failure', adapters);
    await settleUi();
    if (!context) throw new Error('submission context did not mount');

    let surfaced: unknown;
    try {
      context.submit('must surface');
    } catch (error) {
      surfaced = error;
    }

    expect(surfaced).toBe(setupError);
  });
});

describe('ThumbmuxApp navigation', () => {
  test('opens a real session view through the hub and follows popstate back to the hub', async () => {
    history.replaceState(null, '', '/?keep=one');
    const { target } = mountApp(adaptersFor('session one'));
    await settleUi();

    expect(target.querySelectorAll('[data-testid="hub-view"]')).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="session-view"]')).toHaveLength(0);

    click(target, '[data-testid="grid-card"][data-session="session one"]');
    await settleUi();

    expect(new URL(window.location.href).searchParams.get('session')).toBe('session one');
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('one');
    expect(window.location.href).toContain('session=session+one');
    expect(target.querySelectorAll('[data-testid="hub-view"]')).toHaveLength(0);
    expect(target.querySelectorAll('[data-testid="session-view"]')).toHaveLength(1);

    const previous = new URL(window.location.href);
    previous.searchParams.delete('session');
    history.replaceState(null, '', previous);
    flushSync(() => window.dispatchEvent(new Event('popstate')));
    await settleUi();

    expect(target.querySelectorAll('[data-testid="hub-view"]')).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="session-view"]')).toHaveLength(0);
  });

  test('closes the composer before the in-app Back route returns to the hub', async () => {
    history.replaceState(null, '', '/?session=active-pane&keep=two');
    const { target } = mountApp(adaptersFor('active-pane'));
    await settleUi();

    expect(target.querySelectorAll('[data-testid="session-view"]')).toHaveLength(1);
    click(target, '[data-testid="mtv"]');
    await settleUi();

    const composer = target.querySelector<HTMLElement>('[data-testid="input-sheet"]');
    const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea');
    if (!composer || !textarea) throw new Error('session composer did not mount');
    expect(composer.classList.contains('open')).toBe(true);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const replaceState = history.replaceState.bind(history);
    let focusedAtNavigation: Element | null | undefined;
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      focusedAtNavigation = document.activeElement;
      replaceState(...args);
    };

    click(target, 'button[aria-label="Back"]');
    await settleUi();

    expect(focusedAtNavigation).not.toBe(textarea);
    expect(new URL(window.location.href).searchParams.has('session')).toBe(false);
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('two');
    expect(target.querySelectorAll('[data-testid="hub-view"]')).toHaveLength(1);
  });

  test('delegates to host routes without constructing URL navigation', async () => {
    history.replaceState(null, '', '/?keep=host-owned');
    const initialHref = window.location.href;
    const opened: string[] = [];
    const replaceState = history.replaceState.bind(history);
    let replaceCalls = 0;
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      replaceCalls += 1;
      replaceState(...args);
    };

    const { target } = mountApp(adaptersFor('host-session', {
      routes: {
        openSession: (name) => opened.push(name),
        showHub: () => {},
      },
    }));
    await settleUi();
    click(target, '[data-testid="grid-card"][data-session="host-session"]');
    await settleUi();

    expect(opened).toEqual(['host-session']);
    expect(replaceCalls).toBe(0);
    expect(window.location.href).toBe(initialHref);
    expect(target.querySelectorAll('[data-testid="hub-view"]')).toHaveLength(1);
    expect(target.querySelectorAll('[data-testid="session-view"]')).toHaveLength(0);
  });

  test('query-param navigation reads, writes, publishes, and disposes its popstate listener', () => {
    history.replaceState(null, '', '/?keep=three&pane=%20initial-pane%20');
    const navigation = createQueryParamNav('pane');
    const observed: Array<string | null> = [];
    navigation.subscribe((session) => observed.push(session));

    expect(navigation.session).toBe('initial-pane');
    expect(observed).toEqual(['initial-pane']);

    navigation.openSession('next pane');
    expect(navigation.session).toBe('next pane');
    expect(observed.at(-1)).toBe('next pane');
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('three');
    expect(window.location.href).toContain('pane=next+pane');

    navigation.showHub();
    expect(navigation.session).toBeNull();
    expect(observed.at(-1)).toBeNull();

    history.replaceState(null, '', '/?keep=three&pane=from-history');
    window.dispatchEvent(new Event('popstate'));
    expect(navigation.session).toBe('from-history');
    expect(observed.at(-1)).toBe('from-history');

    const countBeforeDispose = observed.length;
    navigation.dispose();
    history.replaceState(null, '', '/?keep=three&pane=after-dispose');
    window.dispatchEvent(new Event('popstate'));

    expect(navigation.session).toBe('from-history');
    expect(observed).toHaveLength(countBeforeDispose);
  });
});

describe('thumbmux/app barrel', () => {
  test('exports the complete workspace runtime and declaration surface', () => {
    for (const name of REQUIRED_RUNTIME_EXPORTS) {
      const expectedType = name === 'DEFAULT_APP_LABELS' ? 'object' : 'function';
      expect(typeof app[name], name).toBe(expectedType);
    }

    const manifest = derivePublicExportManifest(resolve(import.meta.dir, '../..'), 'app');
    expect(manifest.runtime).toEqual([...REQUIRED_RUNTIME_EXPORTS].sort());
    expect(manifest.declarations).toEqual([
      ...REQUIRED_RUNTIME_EXPORTS,
      ...REQUIRED_TYPE_EXPORTS,
    ].sort());
    expect(manifest.callable).toEqual(
      REQUIRED_RUNTIME_EXPORTS.filter((name) => name !== 'DEFAULT_APP_LABELS').sort(),
    );
  });
});
