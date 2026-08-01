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
import { tmuxMux } from '@thumbmux/svelte';
import {
  flushSync,
  mount,
  tick,
  unmount,
} from '../../svelte/tests/svelte-client';

import EmbedView from '../src/EmbedView.svelte';
import SessionView from '../src/SessionView.svelte';
import type { AppAdapters, SessionActionContext } from '../src/config';

type Mounted = { app: Record<string, unknown>; target: HTMLElement };

const mounted: Mounted[] = [];
let originalConnected = false;
let originalSubscribe: PropertyDescriptor | undefined;
let originalOnSessions: PropertyDescriptor | undefined;
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

beforeEach(() => {
  localStorage.clear();
  originalConnected = tmuxMux.connected;
  originalSubscribe = Object.getOwnPropertyDescriptor(tmuxMux, 'subscribe');
  originalOnSessions = Object.getOwnPropertyDescriptor(tmuxMux, 'onSessions');
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
  restoreProperty(globalThis, 'fetch', originalFetch);
  document.body.replaceChildren();
});

describe('mountable terminal views', () => {
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

  test('HUD follows the host mux connection while the singleton is offline', async () => {
    const hostMux = {
      connected: true,
      onSessions(callback: (rows: unknown[]) => void) {
        callback([]);
        return () => {};
      },
    } as unknown as NonNullable<AppAdapters['mux']>;
    const { target } = mountView(SessionView, {
      session: 'audit-host-mux',
      adapters: {
        mux: hostMux,
        termProps: () => ({ claimGeometry: false }),
      } satisfies AppAdapters,
    });
    await tick();

    expect(target.querySelector('.st')?.textContent?.trim()).toBe('CONNECTED');
  });

  test('keys reach the host mux, not the singleton, when only adapters.mux is given', async () => {
    // adapters.mux and adapters.sendKeys are independently optional. A host that
    // supplies only the mux had its rows read from that connection while its
    // keystrokes went to the singleton — the same split brain as the HUD, one
    // layer down.
    const hostKeys: Array<[string, string]> = [];
    const singletonKeys: Array<[string, string]> = [];
    const sessionName = 'sh-key-routing';
    const hostMux = {
      connected: true,
      subscribe: () => () => {},
      onSessions: (cb: (rows: unknown[]) => void) => { cb([]); return () => {}; },
      sendKeys: (session: string, data: string) => { hostKeys.push([session, data]); },
    } as unknown as AppAdapters['mux'];

    const originalSendKeys = Object.getOwnPropertyDescriptor(tmuxMux, 'sendKeys');
    tmuxMux.sendKeys = ((session: string, data: string) => {
      singletonKeys.push([session, data]);
    }) as typeof tmuxMux.sendKeys;

    try {
      const { target } = mountView(SessionView, {
        session: sessionName,
        adapters: { mux: hostMux, termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
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
        input.value = 'routed';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await tick();
      flushSync(() => send.click());

      expect(hostKeys.map(([name]) => name)).toEqual([sessionName]);
      expect(singletonKeys).toEqual([]);

      // EmbedView carries the same two seams and must not disagree either.
      hostKeys.length = 0;
      const embed = mountView(EmbedView, {
        session: sessionName,
        adapters: { mux: hostMux, termProps: () => ({ claimGeometry: false }) } satisfies AppAdapters,
      });
      await tick();
      const embedInput = embed.target.querySelector<HTMLTextAreaElement>('[data-testid="input-sheet"] textarea');
      const embedSend = embed.target.querySelector<HTMLButtonElement>('[data-testid="input-sheet"] .snd');
      if (embedInput && embedSend) {
        flushSync(() => {
          embedInput.value = 'embedded';
          embedInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await tick();
        flushSync(() => embedSend.click());
        expect(hostKeys.map(([name]) => name)).toEqual([sessionName]);
      }
      expect(singletonKeys).toEqual([]);
    } finally {
      restoreProperty(tmuxMux, 'sendKeys', originalSendKeys);
    }
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

  test('submitAgent drives every sendKeys step produced by submitPlan', async () => {
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
});
