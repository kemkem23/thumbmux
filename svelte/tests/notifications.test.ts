import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrowserNotificationEnvironment } from '../src/notifications';
import NotificationPermission from '../src/NotificationPermission.svelte';
import { flushSync, mount, tick, unmount } from './svelte-client';

// Reactive props proxy for post-mount updates (Svelte 5 mount tracks $state proxies).
const require = createRequire(import.meta.url);
const svelteClientInternals = join(
  dirname(require.resolve('svelte/package.json')),
  'src/internal/client/index.js',
);
const { proxy } = (await import(svelteClientInternals)) as {
  proxy: <T extends object>(value: T) => T;
};

type NotificationsModule = typeof import('../src/notifications');
type ServiceWorkerModule = typeof import('../src/service-worker');

const NOTIFICATION_COMPONENT_SOURCE = await readFile(
  new URL('../src/NotificationPermission.svelte', import.meta.url),
  'utf8',
);
const NOTIFICATIONS_SOURCE = await readFile(
  new URL('../src/notifications.ts', import.meta.url),
  'utf8',
);
const SERVICE_WORKER_SOURCE = await readFile(
  new URL('../src/service-worker.ts', import.meta.url),
  'utf8',
);

const TRUSTED_ORIGIN = 'https://thumbmux.test';

let modules: Promise<{ notifications: NotificationsModule; serviceWorker: ServiceWorkerModule }> | null = null;

const loadModules = async () => {
  if (!modules) {
    modules = Promise.all([
      import('../src/notifications'),
      import('../src/service-worker'),
    ]).then(([notifications, serviceWorker]) => ({ notifications, serviceWorker }));
  }
  return modules;
};

const makeBaseNotificationPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  session: 'session-1',
  state: 'finished',
  occurredAt: 1_700_000_000_000,
  ...overrides,
});

describe('notification helpers', () => {
  test('imports browser and worker helpers under Bun without browser globals', async () => {
    const { notifications, serviceWorker } = await loadModules();

    expect(notifications.resolveNotificationPermissionState(undefined)).toBe('unsupported');
    expect(serviceWorker.parseNotificationPayload).toBeTypeOf('function');
    expect(serviceWorker.registerNotificationServiceWorkerHandlers).toBeTypeOf('function');
  });

  test('resolves notification permission states with frozen precedence', async () => {
    const { notifications } = await loadModules();

    expect(notifications.resolveNotificationPermissionState(undefined)).toBe('unsupported');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'granted' },
        isSecureContext: false,
      }),
    ).toBe('insecure');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'default' },
        isSecureContext: true,
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment),
    ).toBe('default');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'denied' },
        isSecureContext: true,
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment),
    ).toBe('denied');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'granted' },
        isSecureContext: true,
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment),
    ).toBe('granted');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'odd' as never },
        isSecureContext: true,
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment),
    ).toBe('default');
  });

  test('calls requestPermission synchronously when permission is requested and before any registration/display side effect', async () => {
    const { notifications } = await loadModules();

    let requestCalls = 0;
    let registerCalls = 0;
    let showCalls = 0;

    const requestResult = notifications.requestNotificationPermission({
      isSecureContext: true,
      location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      notification: {
        permission: 'default',
        requestPermission() {
          requestCalls += 1;
          return 'granted';
        },
      },
      navigator: {
        serviceWorker: {
          register() {
            registerCalls += 1;
            return {
              showNotification() {
                showCalls += 1;
                return true;
              },
            };
          },
        },
      },
    } satisfies BrowserNotificationEnvironment);

    expect(requestCalls).toBe(1);
    expect(registerCalls).toBe(0);
    expect(showCalls).toBe(0);

    expect(await requestResult).toEqual({ ok: true, value: 'granted' });
  });

  test('represents a thrown permission request as request-failed', async () => {
    const { notifications } = await loadModules();

    const requestResult = await notifications.requestNotificationPermission({
      isSecureContext: true,
      location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      notification: {
        requestPermission() {
          throw new Error('permission helper exploded');
        },
      },
    } satisfies BrowserNotificationEnvironment);

    expect(requestResult).toMatchObject({
      ok: false,
      error: {
        code: 'request-failed',
      },
    });
  });

  test('represents a rejected permission request as request-failed', async () => {
    const { notifications } = await loadModules();

    const requestResult = await notifications.requestNotificationPermission({
      isSecureContext: true,
      location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      notification: {
        requestPermission() {
          return Promise.reject(new Error('permission promise rejected'));
        },
      },
    } satisfies BrowserNotificationEnvironment);

    expect(requestResult).toMatchObject({
      ok: false,
      error: {
        code: 'request-failed',
      },
    });
  });

  test('registerServiceWorker represents registration failures without unhandled rejects', async () => {
    const { notifications } = await loadModules();

    const result = await notifications.registerServiceWorker({
      scriptURL: '/sw.js',
      environment: {
        isSecureContext: true,
        notification: { permission: 'granted' },
        navigator: {
          serviceWorker: {
            register() {
              return Promise.reject(new Error('register rejected'));
            },
          },
        },
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'registration-failed',
      },
    });
  });

  test('showLocalNotification denies non-granted states and only uses registration.showNotification when granted', async () => {
    const { notifications } = await loadModules();

    let showCalls = 0;
    const registration = {
      showNotification() {
        showCalls += 1;
        return Promise.resolve();
      },
    };

    const deniedResult = await notifications.showLocalNotification({
      payload: makeBaseNotificationPayload(),
      registration,
      environment: {
        isSecureContext: true,
        notification: { permission: 'denied' },
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment,
    });
    expect(deniedResult).toMatchObject({
      ok: false,
      error: {
        code: 'permission-denied',
      },
    });
    expect(showCalls).toBe(0);

    const showFailure = await notifications.showLocalNotification({
      payload: makeBaseNotificationPayload(),
      registration: {
        showNotification() {
          throw new Error('showNotification threw unexpectedly');
        },
      },
      environment: {
        isSecureContext: true,
        notification: { permission: 'granted' },
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
      } satisfies BrowserNotificationEnvironment,
    });
    expect(showFailure).toMatchObject({
      ok: false,
      error: {
        code: 'show-failed',
      },
    });
  });

  test('uses registration.showNotification for granted local display and does not use global Notification constructor', async () => {
    const { notifications } = await loadModules();

    const globals = globalThis as { Notification?: unknown };
    const originalNotification = globals.Notification;
    let constructorCalls = 0;
    globals.Notification = class Notification {
      constructor() {
        constructorCalls += 1;
      }
    } as never;

    let registrationShowCalls = 0;
    let result: unknown;
    try {
      result = await notifications.showLocalNotification({
        payload: makeBaseNotificationPayload({
          title: 'local show',
          body: 'hello',
          url: 'https://thumbmux.test/inbox?tab=unread#section',
        }),
        registration: {
          showNotification(title: string, options: unknown) {
            registrationShowCalls += 1;
            expect(title).toBe('local show');
            expect((options as { data: { event: { url: string } } }).data.event.url).toBe(
              '/inbox?tab=unread#section',
            );
            return Promise.resolve();
          },
        },
        environment: {
          isSecureContext: true,
          location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
          notification: { permission: 'granted' },
        } satisfies BrowserNotificationEnvironment,
      });
    } finally {
      globals.Notification = originalNotification;
    }

    expect(result).toMatchObject({
      ok: true,
      value: {
        event: expect.objectContaining({
          url: '/inbox?tab=unread#section',
          title: 'local show',
          body: 'hello',
        }),
      },
    });
    expect(constructorCalls).toBe(0);
    expect(registrationShowCalls).toBe(1);
  });

  test('normalizes payload URLs through the accepted contract in local notification payloads', async () => {
    const { notifications, serviceWorker } = await loadModules();

    const payload = makeBaseNotificationPayload({ url: '/dashboard?x=1#sec' });
    const parsed = serviceWorker.parseNotificationPayload(payload, {
      trustedOrigin: TRUSTED_ORIGIN,
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        url: '/dashboard?x=1#sec',
      },
    });

    const showResult = await notifications.showLocalNotification({
      payload: makeBaseNotificationPayload({ url: 'https://thumbmux.test/inbox?x=1#section' }),
      registration: {
        showNotification() {
          return Promise.resolve();
        },
      },
      environment: {
        isSecureContext: true,
        location: { protocol: 'https:', origin: TRUSTED_ORIGIN },
        notification: { permission: 'granted' },
      } satisfies BrowserNotificationEnvironment,
    });

    expect(showResult).toMatchObject({
      ok: true,
      value: {
        event: {
          url: '/inbox?x=1#section',
        },
      },
    });
  });
});

describe('notification service-worker helpers', () => {
  test('imports are side-effect free and expose explicit listener registration', async () => {
    expect(SERVICE_WORKER_SOURCE).toContain('export function parseNotificationPayload');
    expect(SERVICE_WORKER_SOURCE).toMatch(/export\s+async\s+function\s+handlePushNotificationEvent/);
    expect(SERVICE_WORKER_SOURCE).toMatch(/export\s+async\s+function\s+handleNotificationClickEvent/);
    expect(SERVICE_WORKER_SOURCE).toContain('export function registerNotificationServiceWorkerHandlers');
    expect(SERVICE_WORKER_SOURCE).not.toContain('self.addEventListener');
    expect(SERVICE_WORKER_SOURCE).not.toContain('ServiceWorkerGlobalScope');
    expect(NOTIFICATIONS_SOURCE).not.toContain('self.addEventListener');

    const { serviceWorker } = await loadModules();

    const pushShowCalls: string[] = [];
    const host: { addEventListener: (type: 'push' | 'notificationclick', listener: (event: unknown) => void) => void; removeEventListener?: (type: 'push' | 'notificationclick', listener: (event: unknown) => void) => void; events: Map<string, (event: unknown) => void[]> } = {
      addEventListener(type, listener) {
        const listeners = this.events.get(type) ?? [];
        this.events.set(type, [...listeners, listener]);
      },
      removeEventListener(type, listener) {
        const listeners = this.events.get(type) ?? [];
        this.events.set(
          type,
          listeners.filter((candidate) => candidate !== listener),
        );
      },
      events: new Map(),
    };

    const registration = {
      showNotification: (title: string, options: unknown) => {
        const data = (options as { data?: unknown } | undefined)?.data;
        pushShowCalls.push(`${title}:${JSON.stringify(data)}`);
        return Promise.resolve();
      },
    };

    let openedFromRegisteredClick: string | null = null;
    const registrationResult = serviceWorker.registerNotificationServiceWorkerHandlers(host, {
      push: {
        registration,
        trustedOrigin: TRUSTED_ORIGIN,
      },
      click: {
        clients: {
          openWindow(url: string) {
            openedFromRegisteredClick = url;
            return Promise.resolve(url);
          },
        },
        trustedOrigin: TRUSTED_ORIGIN,
      },
    });
    expect(registrationResult).toMatchObject({ ok: true });
    expect(host.events.get('push')).toHaveLength(1);
    expect(host.events.get('notificationclick')).toHaveLength(1);

    const pushHandlers = host.events.get('push') ?? [];
    const clickHandlers = host.events.get('notificationclick') ?? [];
    expect(pushHandlers).toHaveLength(1);
    expect(clickHandlers).toHaveLength(1);

    const pushWaitUntil: Promise<unknown>[] = [];
    pushHandlers[0]!({
      data: {
        json() {
          return makeBaseNotificationPayload({
            title: 'queue',
            body: 'processing',
            url: '/queue',
          });
        },
      },
      waitUntil(promise: PromiseLike<unknown>) {
        pushWaitUntil.push(Promise.resolve(promise));
      },
    });
    await Promise.all(pushWaitUntil);
    expect(pushShowCalls).toHaveLength(1);

    const clickWaitUntil: Promise<unknown>[] = [];
    clickHandlers[0]!({
      notification: {
        data: makeBaseNotificationPayload({
          title: 'open',
          url: '/queue/42',
        }),
      },
      waitUntil(promise: PromiseLike<unknown>) {
        clickWaitUntil.push(Promise.resolve(promise));
      },
    });
    await Promise.all(clickWaitUntil);
    expect(openedFromRegisteredClick).toBe('/queue/42');

    registrationResult.ok && registrationResult.value.unregister();
    expect(host.events.get('push')).toHaveLength(0);
    expect(host.events.get('notificationclick')).toHaveLength(0);

    expect(pushShowCalls).toHaveLength(1);
  });

  test('handles push payload parsing and validation as represented results', async () => {
    const { serviceWorker } = await loadModules();

    const context = {
      registration: {
        showNotification() {
          return Promise.resolve();
        },
      },
      trustedOrigin: TRUSTED_ORIGIN,
      fallbackTitle: 'Fallback',
    };

    const parseOnlyResult = await serviceWorker.handlePushNotificationEvent({}, context as never);
    expect(parseOnlyResult).toMatchObject({
      ok: false,
      error: {
        code: 'parse-failed',
      },
    });

    const parseFailedResult = await serviceWorker.handlePushNotificationEvent(
      {
        data: {
          json: () => 'not json',
        },
      },
      context,
    );
    expect(parseFailedResult).toMatchObject({
      ok: false,
      error: {
        code: 'parse-failed',
      },
    });

    const validResult = await serviceWorker.handlePushNotificationEvent(
      {
        data: {
          json: () =>
            JSON.stringify(
              makeBaseNotificationPayload({
                title: 'Push title',
                body: 'Push body',
                url: '/inbox?x=1',
              }),
            ),
        },
      },
      context,
    );
    expect(validResult).toMatchObject({
      ok: true,
      value: {
        event: {
          id: 'evt-1',
          session: 'session-1',
          title: 'Push title',
          body: 'Push body',
          state: 'finished',
          occurredAt: 1_700_000_000_000,
          url: '/inbox?x=1',
        },
      },
    });
  });

  test('handles click events as same-origin canonical paths and never opens external/malformed destinations', async () => {
    const { serviceWorker } = await loadModules();

    const opened: string[] = [];
    const context = {
      clients: {
        openWindow(url: string) {
          opened.push(url);
          return Promise.resolve({ url });
        },
      },
      trustedOrigin: TRUSTED_ORIGIN,
    };

    const validClick = await serviceWorker.handleNotificationClickEvent(
      {
        notification: {
          data: makeBaseNotificationPayload({
            title: 'Click',
            body: 'Go now',
            url: 'https://thumbmux.test/tasks?x=1#detail',
          }),
        },
      },
      context,
    );

    expect(validClick).toMatchObject({
      ok: true,
      value: {
        event: {
          id: 'evt-1',
          session: 'session-1',
          url: '/tasks?x=1#detail',
        },
      },
    });
    expect(opened).toEqual(['/tasks?x=1#detail']);

    const invalidDestinations = [
      '//thumbmux.test/relative',
      'https://user:pass@thumbmux.test/evil',
      'https://[::1',
      'https://thumbmux.test:65536/path',
      'javascript:alert(1)',
      'mailto:alerts@thumbmux.test',
      'https://other-domain.test/path',
      'ftp://thumbmux.test/resource',
    ];

    for (const target of invalidDestinations) {
      const next = await serviceWorker.handleNotificationClickEvent(
        {
          notification: {
            data: makeBaseNotificationPayload({
              title: 'Reject',
              body: 'No open',
              url: target,
            }),
          },
        },
        context,
      );

      expect(next.ok).toBe(false);
      if (!next.ok) {
        expect(['parse-failed', 'validation-failed']).toContain(next.error.code);
      }
      expect(opened).toEqual(['/tasks?x=1#detail']);
    }
  });

  test('represents showNotification failures in push handling as shown-failed', async () => {
    const { serviceWorker } = await loadModules();

    const context = {
      registration: {
        showNotification() {
          return Promise.reject(new Error('show failed'));
        },
      },
      trustedOrigin: TRUSTED_ORIGIN,
    };

    const result = await serviceWorker.handlePushNotificationEvent(
      { data: { json: () => makeBaseNotificationPayload() } },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'show-failed' },
    });
  });
});

describe('NotificationPermission component contract', () => {
  test('exposes fixed notification-permission testid and guarded Svelte 5 surface handlers', () => {
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('data-testid="notification-permission"');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('data-testid="notification-permission-enable"');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onclick={handleEnable}');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('oninput={onPayloadInputText}');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('$props()');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('$state');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('$derived');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onStateChange?:');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onPermissionResult?:');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onRegistrationResult?:');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onShowResult?:');
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('onError?:');
    expect(NOTIFICATION_COMPONENT_SOURCE).not.toMatch(/onMount\(/);
    // Prop-keyed $effect resync (environment/registration/payload) is required so
    // host-owned props do not stay snapshotted at init. Bodies must use untrack
    // so writing local $state cannot self-invalidate (effect_update_depth_exceeded).
    expect(NOTIFICATION_COMPONENT_SOURCE).toMatch(/\$effect\s*\(/);
    expect(NOTIFICATION_COMPONENT_SOURCE).toMatch(
      /import\s*\{[^}]*\buntrack\b[^}]*\}\s*from\s*['"]svelte['"]/,
    );
    expect(NOTIFICATION_COMPONENT_SOURCE).toContain('untrack(() =>');

    const enableHandler = NOTIFICATION_COMPONENT_SOURCE.slice(
      NOTIFICATION_COMPONENT_SOURCE.indexOf('async function handleEnable'),
      NOTIFICATION_COMPONENT_SOURCE.indexOf('async function handleShowLocal'),
    );
    expect(enableHandler.indexOf('const permissionRequest = requestNotificationPermission(environment);'))
      .toBeGreaterThanOrEqual(0);
    expect(enableHandler.indexOf('const permissionRequest = requestNotificationPermission(environment);'))
      .toBeLessThan(enableHandler.indexOf("actionPhase = 'requesting';"));
  });
});

describe('NotificationPermission mount — prop resync', () => {
  type Mounted = { app: Record<string, unknown>; target: HTMLElement };
  const mounted: Mounted[] = [];

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
  });

  function mountWithProps(props: Record<string, unknown>): Mounted {
    const target = document.createElement('div');
    document.body.appendChild(target);
    let app!: Record<string, unknown>;
    flushSync(() => {
      app = mount(NotificationPermission, { target, props }) as Record<string, unknown>;
    });
    const entry = { app, target };
    mounted.push(entry);
    return entry;
  }

  test('reacts when host sets registration after mount (granted, async SW lifecycle)', async () => {
    // SCENARIO: permission already granted, registration arrives later from a
    // resolved service-worker promise — the normal host lifecycle. Pre-fix the
    // component snapshotted `registration` at init and never resynced, so the
    // local-show button stayed absent forever.
    const environment = {
      isSecureContext: true,
      Notification: {
        permission: 'granted' as const,
        requestPermission: async () => 'granted' as const,
      },
    };

    const props = proxy({
      environment,
      registration: undefined as
        | { showNotification: (title: string, options?: unknown) => Promise<void> }
        | undefined,
    });

    const { target } = mountWithProps(props);
    await tick();

    expect(target.querySelector('[data-testid="notification-permission"]')).toBeTruthy();
    expect(
      target.querySelector('[data-testid="notification-permission-status"]')?.textContent ?? '',
    ).toMatch(/granted/i);
    // No registration and no serviceWorkerScriptURL → show button must be absent.
    expect(target.querySelector('[data-testid="notification-permission-show"]')).toBeNull();

    flushSync(() => {
      props.registration = {
        showNotification: () => Promise.resolve(),
      };
    });
    await tick();

    const showBtn = target.querySelector(
      '[data-testid="notification-permission-show"]',
    ) as HTMLButtonElement | null;
    expect(showBtn).toBeTruthy();
    expect(showBtn!.disabled).toBe(false);
  });

  test('resyncs permissionState when environment prop changes after mount', async () => {
    const props = proxy({
      environment: {
        isSecureContext: true,
        Notification: {
          permission: 'default' as const,
          requestPermission: async () => 'granted' as const,
        },
      } as BrowserNotificationEnvironment,
    });

    const { target } = mountWithProps(props);
    await tick();

    expect(
      target.querySelector('[data-testid="notification-permission-status"]')?.textContent ?? '',
    ).toMatch(/not been requested/i);
    const enableBefore = target.querySelector(
      '[data-testid="notification-permission-enable"]',
    ) as HTMLButtonElement;
    expect(enableBefore.disabled).toBe(false);

    flushSync(() => {
      props.environment = {
        isSecureContext: true,
        Notification: {
          permission: 'denied',
          requestPermission: async () => 'denied' as const,
        },
      };
    });
    await tick();

    expect(
      target.querySelector('[data-testid="notification-permission-status"]')?.textContent ?? '',
    ).toMatch(/denied/i);
    const enableAfter = target.querySelector(
      '[data-testid="notification-permission-enable"]',
    ) as HTMLButtonElement;
    expect(enableAfter.disabled).toBe(true);
  });

  test('resyncs payload text from payload prop but does not clobber user edits on unrelated prop updates', async () => {
    const props = proxy({
      environment: {
        isSecureContext: true,
        Notification: {
          permission: 'default' as const,
          requestPermission: async () => 'granted' as const,
        },
      } as BrowserNotificationEnvironment,
      showPayloadInput: true,
      payload: { title: 'host-title' } as unknown,
      registration: undefined as
        | { showNotification: () => Promise<void> }
        | undefined,
    });

    const { target } = mountWithProps(props);
    await tick();

    const textarea = target.querySelector(
      '[data-testid="notification-permission-payload"]',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toContain('host-title');

    // User edits the payload textarea (internal state).
    flushSync(() => {
      textarea.value = '{"title":"user-edited"}';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await tick();
    expect(textarea.value).toContain('user-edited');

    // Unrelated prop update (registration arrives) must NOT clobber the edit.
    flushSync(() => {
      props.registration = {
        showNotification: () => Promise.resolve(),
      };
    });
    await tick();
    expect(
      (target.querySelector(
        '[data-testid="notification-permission-payload"]',
      ) as HTMLTextAreaElement).value,
    ).toContain('user-edited');

    // Host actually changes payload → resync is expected.
    flushSync(() => {
      props.payload = { title: 'host-updated' };
    });
    await tick();
    expect(
      (target.querySelector(
        '[data-testid="notification-permission-payload"]',
      ) as HTMLTextAreaElement).value,
    ).toContain('host-updated');
  });
});

describe('browser-shaped environments and secure-context classification', () => {
  const makeBrowserGlobal = (permission: string, opts: { strictThis?: boolean } = {}) => {
    class NotificationCtor {
      static permission = permission;
      static requestPermission(this: unknown) {
        if (opts.strictThis !== false && this !== NotificationCtor) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve('granted');
      }
    }
    const container = {
      register(this: unknown, _scriptURL: string) {
        if (opts.strictThis !== false && this !== container) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve({ showNotification: () => Promise.resolve() });
      },
    };
    return {
      Notification: NotificationCtor,
      isSecureContext: true,
      location: { protocol: 'https:', origin: 'https://app.test' },
      navigator: { serviceWorker: container },
    };
  };

  test('resolves capital-N Notification permission states from browser-shaped globals', async () => {
    const { notifications } = await loadModules();

    expect(notifications.resolveNotificationPermissionState(makeBrowserGlobal('default'))).toBe('default');
    expect(notifications.resolveNotificationPermissionState(makeBrowserGlobal('granted'))).toBe('granted');
    expect(notifications.resolveNotificationPermissionState(makeBrowserGlobal('denied'))).toBe('denied');
  });

  test('requestNotificationPermission uses capital Notification and bound requestPermission this', async () => {
    const { notifications } = await loadModules();

    expect(await notifications.requestNotificationPermission(makeBrowserGlobal('default'))).toEqual({
      ok: true,
      value: 'granted',
    });
  });

  test('registerServiceWorker uses capital Notification and bound serviceWorker.register this', async () => {
    const { notifications } = await loadModules();

    const result = await notifications.registerServiceWorker({
      scriptURL: '/sw.js',
      environment: makeBrowserGlobal('granted'),
    });

    expect(result.ok).toBe(true);
  });

  test('binds this for injected lowercase notification and serviceWorker APIs', async () => {
    const { notifications } = await loadModules();

    const strictNotification = {
      permission: 'default',
      requestPermission(this: unknown) {
        if (this !== strictNotification) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve('granted');
      },
    };

    const permissionResult = await notifications.requestNotificationPermission({
      notification: strictNotification,
      isSecureContext: true,
      location: { protocol: 'https:', origin: 'https://app.test' },
    });
    expect(permissionResult).toEqual({ ok: true, value: 'granted' });

    const strictContainer = {
      register(this: unknown, _scriptURL: string) {
        if (this !== strictContainer) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve({ showNotification: () => Promise.resolve() });
      },
    };

    const registrationResult = await notifications.registerServiceWorker({
      scriptURL: '/sw.js',
      environment: {
        notification: { permission: 'granted' },
        isSecureContext: true,
        location: { protocol: 'https:', origin: 'https://app.test' },
        navigator: { serviceWorker: strictContainer },
      },
    });
    expect(registrationResult.ok).toBe(true);
  });

  test('classifies plain HTTP as insecure and keeps HTTPS/explicit secure-context contracts', async () => {
    const { notifications } = await loadModules();

    const plainHttpEnv = {
      notification: { permission: 'granted' as const },
      location: { origin: 'http://plain-host.test:8080' },
    };
    const httpsOriginOnlyEnv = {
      notification: { permission: 'granted' as const },
      location: { origin: 'https://app.test' },
    };
    const explicitSecureOverHttpEnv = {
      notification: { permission: 'granted' as const },
      isSecureContext: true,
      location: { origin: 'http://plain-host.test:8080' },
    };

    expect(() => notifications.resolveNotificationPermissionState(plainHttpEnv)).not.toThrow();
    expect(() => notifications.requestNotificationPermission(plainHttpEnv)).not.toThrow();
    expect(() => notifications.resolveNotificationPermissionState(httpsOriginOnlyEnv)).not.toThrow();
    expect(() => notifications.resolveNotificationPermissionState(explicitSecureOverHttpEnv)).not.toThrow();

    expect(notifications.resolveNotificationPermissionState(plainHttpEnv)).toBe('insecure');

    const httpRequest = await notifications.requestNotificationPermission(plainHttpEnv);
    expect(httpRequest).toMatchObject({ ok: false, error: { code: 'insecure' } });

    expect(notifications.resolveNotificationPermissionState(httpsOriginOnlyEnv)).toBe('granted');
    expect(notifications.resolveNotificationPermissionState(explicitSecureOverHttpEnv)).toBe('granted');
  });

  test('keeps existing unsupported and explicit-insecure contracts', async () => {
    const { notifications } = await loadModules();

    expect(notifications.resolveNotificationPermissionState(undefined)).toBe('unsupported');
    expect(
      notifications.resolveNotificationPermissionState({
        notification: { permission: 'granted' },
        isSecureContext: false,
      }),
    ).toBe('insecure');
  });
});

describe('notificationclick dismisses the notification', () => {
  test('closes notification on successful click and opens the canonical url', async () => {
    const { serviceWorker } = await loadModules();

    let closeCalls = 0;
    const opened: string[] = [];
    const result = await serviceWorker.handleNotificationClickEvent(
      {
        notification: {
          data: makeBaseNotificationPayload({
            title: 'Click',
            body: 'Go',
            url: 'https://thumbmux.test/tasks?x=1#detail',
          }),
          close() {
            closeCalls += 1;
          },
        },
      },
      {
        clients: {
          openWindow(url: string) {
            opened.push(url);
            return Promise.resolve({ url });
          },
        },
        trustedOrigin: TRUSTED_ORIGIN,
      },
    );

    expect(closeCalls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      value: {
        event: {
          url: '/tasks?x=1#detail',
        },
      },
    });
    expect(opened).toEqual(['/tasks?x=1#detail']);
  });

  test('closes notification even when the payload is garbage', async () => {
    const { serviceWorker } = await loadModules();

    let closeCalls = 0;
    const result = await serviceWorker.handleNotificationClickEvent(
      {
        notification: {
          data: { nope: 1 },
          close() {
            closeCalls += 1;
          },
        },
      },
      {
        clients: {
          openWindow() {
            return Promise.resolve(null);
          },
        },
        trustedOrigin: TRUSTED_ORIGIN,
      },
    );

    expect(closeCalls).toBe(1);
    expect(result.ok).toBe(false);
  });

  test('swallows close() throws without changing a successful click result', async () => {
    const { serviceWorker } = await loadModules();

    const opened: string[] = [];
    const result = await serviceWorker.handleNotificationClickEvent(
      {
        notification: {
          data: makeBaseNotificationPayload({
            title: 'Click',
            body: 'Go',
            url: 'https://thumbmux.test/inbox',
          }),
          close() {
            throw new Error('close exploded');
          },
        },
      },
      {
        clients: {
          openWindow(url: string) {
            opened.push(url);
            return Promise.resolve({ url });
          },
        },
        trustedOrigin: TRUSTED_ORIGIN,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        event: {
          url: '/inbox',
        },
      },
    });
    expect(opened).toEqual(['/inbox']);
  });
});
