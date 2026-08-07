<script module lang="ts">
  // Import types once here. svelte-check merges module + instance into one TS
  // scope, so a second bare import of the same names in the instance script is
  // "Duplicate identifier". The instance script reuses these names without
  // re-importing; that keeps both NotificationPermissionProps and the
  // component $$ComponentProps declaration hashes stable for the contract gate.
  import type {
    BrowserNotificationEnvironment,
    BrowserServiceWorkerRegistrationLike,
    BrowserServiceWorkerRegistrationOptions,
    LocalNotificationResult,
    NotificationPermissionState,
    PermissionRequestResult,
    ServiceWorkerRegistrationResult,
  } from './notifications';

  export type NotificationPermissionErrorPhase = 'permission' | 'registration' | 'local-show';

  export interface NotificationPermissionError {
    phase: NotificationPermissionErrorPhase;
    code: string;
    message: string;
    cause?: unknown;
  }

  export interface NotificationPermissionProps {
    environment?: BrowserNotificationEnvironment;
    registration?: BrowserServiceWorkerRegistrationLike;
    serviceWorkerScriptURL?: string;
    serviceWorkerOptions?: BrowserServiceWorkerRegistrationOptions;
    payload?: unknown;
    payloadLabel?: string;
    payloadPlaceholder?: string;
    payloadRows?: number;
    showPayloadInput?: boolean;
    autoRegister?: boolean;
    autoShow?: boolean;
    fallbackTitle?: string;
    localOriginHint?: string;
    enableLabel?: string;
    requestInFlightLabel?: string;
    showLabel?: string;
    onStateChange?: (state: NotificationPermissionState) => void;
    onPermissionResult?: (result: PermissionRequestResult) => void;
    onRegistrationResult?: (result: ServiceWorkerRegistrationResult) => void;
    onShowResult?: (result: LocalNotificationResult) => void;
    onError?: (error: NotificationPermissionError) => void;
    onPayloadInput?: (payloadText: string) => void;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import {
    resolveNotificationPermissionState,
    requestNotificationPermission,
    registerServiceWorker,
    showLocalNotification,
  } from './notifications';

  type ActionPhase = 'idle' | 'requesting' | 'registering' | 'showing';

  // Types (BrowserNotificationEnvironment, …) come from the module script's
  // single import — do not re-import them here.
  let {
    environment,
    registration,
    serviceWorkerScriptURL,
    serviceWorkerOptions,
    payload = null,
    payloadLabel = 'Notification payload',
    payloadPlaceholder = '{"title":"Thumbmux notification"}',
    payloadRows = 4,
    showPayloadInput = false,
    autoRegister = false,
    autoShow = false,
    fallbackTitle,
    localOriginHint,
    enableLabel = 'Enable notifications',
    requestInFlightLabel = 'Requesting permission…',
    showLabel = 'Show local notification',
    onStateChange,
    onPermissionResult,
    onRegistrationResult,
    onShowResult,
    onError,
    onPayloadInput,
  }: {
    environment?: BrowserNotificationEnvironment;
    registration?: BrowserServiceWorkerRegistrationLike;
    serviceWorkerScriptURL?: string;
    serviceWorkerOptions?: BrowserServiceWorkerRegistrationOptions;
    payload?: unknown;
    payloadLabel?: string;
    payloadPlaceholder?: string;
    payloadRows?: number;
    showPayloadInput?: boolean;
    autoRegister?: boolean;
    autoShow?: boolean;
    fallbackTitle?: string;
    localOriginHint?: string;
    enableLabel?: string;
    requestInFlightLabel?: string;
    showLabel?: string;
    onStateChange?: (state: NotificationPermissionState) => void;
    onPermissionResult?: (result: PermissionRequestResult) => void;
    onRegistrationResult?: (result: ServiceWorkerRegistrationResult) => void;
    onShowResult?: (result: LocalNotificationResult) => void;
    onError?: (error: {
      phase: 'permission' | 'registration' | 'local-show';
      code: string;
      message: string;
      cause?: unknown;
    }) => void;
    onPayloadInput?: (payloadText: string) => void;
  } = $props();

  let permissionState = $state<NotificationPermissionState>(
    resolveNotificationPermissionState(environment),
  );
  let actionPhase = $state<ActionPhase>('idle');
  let currentRegistration = $state<BrowserServiceWorkerRegistrationLike | null>(
    registration ?? null,
  );
  let permissionResult = $state<PermissionRequestResult | null>(null);
  let registrationResult = $state<ServiceWorkerRegistrationResult | null>(null);
  let localResult = $state<LocalNotificationResult | null>(null);
  let payloadText = $state<string>(serializePayload(payload));
  let statusMessage = $state<string>('');
  let detailMessage = $state<string>('');

  // Prop-keyed resync: host-owned props (environment / registration / payload)
  // can arrive asynchronously after mount (e.g. SW registration promise). Track
  // ONLY that prop, and write local $state inside untrack so the effect cannot
  // self-invalidate (effect_update_depth_exceeded). User-edited payloadText is
  // separate internal state — it is only overwritten when the payload prop
  // itself changes, never when an unrelated prop (e.g. registration) updates.
  $effect(() => {
    const env = environment;
    untrack(() => {
      permissionState = resolveNotificationPermissionState(env);
    });
  });

  $effect(() => {
    const reg = registration;
    untrack(() => {
      currentRegistration = reg ?? null;
    });
  });

  $effect(() => {
    const nextPayload = payload;
    untrack(() => {
      payloadText = serializePayload(nextPayload);
    });
  });

  let isBusy = $derived(actionPhase !== 'idle');
  let parsedPayload = $derived(parsePayloadText(payloadText));
  let payloadIsParsable = $derived(parsedPayload !== null);
  let canRequest = $derived(
    !isBusy && permissionState === 'default',
  );
  let canShowLocal = $derived(
    !isBusy &&
      permissionState === 'granted' &&
      (currentRegistration !== null || typeof serviceWorkerScriptURL === 'string'),
  );

  let enableButtonText = $derived(
    actionPhase === 'requesting' ? requestInFlightLabel : enableLabel,
  );

  let permissionStatusText = $derived(
    permissionState === 'unsupported'
      ? 'Notifications are unsupported in this context.'
      : permissionState === 'insecure'
        ? 'Notifications are unavailable in an insecure context.'
        : permissionState === 'default'
          ? 'Permission has not been requested yet.'
          : permissionState === 'denied'
            ? 'Permission was denied.'
            : 'Permission is granted.',
  );

  function serializePayload(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input === null || input === undefined) return '{}';
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '{}';
    }
  }

  function parsePayloadText(raw: string): unknown | null {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function safeEmit<T>(fn: ((value: T) => void) | undefined, value: T): void {
    if (!fn) return;
    try {
      fn(value);
    } catch {
      // Ignore host callback exceptions to keep this component promise-safe.
    }
  }

  function emitPermissionState(next: NotificationPermissionState): void {
    permissionState = next;
    safeEmit(onStateChange, next);
  }

  function emitError(
    phase: 'permission' | 'registration' | 'local-show',
    result: { error: { code: string; message: string; cause?: unknown } },
  ): void {
    statusMessage = result.error.message;
    safeEmit(onError, {
      phase,
      code: result.error.code,
      message: result.error.message,
      cause: result.error.cause,
    });
  }

  function onPayloadInputText(event: Event): void {
    const input = event.currentTarget as HTMLTextAreaElement | null;
    if (!input) return;
    payloadText = input.value;
    safeEmit(onPayloadInput, payloadText);
  }

  async function ensureRegistration(): Promise<BrowserServiceWorkerRegistrationLike | null> {
    if (currentRegistration) {
      return currentRegistration;
    }

    if (!serviceWorkerScriptURL) {
      const missingScriptResult: ServiceWorkerRegistrationResult = {
        ok: false,
        error: {
          code: 'service-worker-unsupported',
          message: 'Service worker registration is unavailable.',
        },
      };
      registrationResult = missingScriptResult;
      safeEmit(onRegistrationResult, missingScriptResult);
      emitError('registration', missingScriptResult);
      detailMessage = `${missingScriptResult.error.message} (${missingScriptResult.error.code})`;
      return null;
    }

    actionPhase = 'registering';
    let result: ServiceWorkerRegistrationResult;
    try {
      result = await registerServiceWorker({
        scriptURL: serviceWorkerScriptURL,
        options: serviceWorkerOptions,
        environment,
      });
    } catch (cause) {
      result = {
        ok: false,
        error: {
          code: 'registration-failed',
          message: 'Service worker registration rejected unexpectedly.',
          cause,
        },
      };
    }

    registrationResult = result;
    safeEmit(onRegistrationResult, result);

    if (!result.ok) {
      emitError('registration', result);
      actionPhase = 'idle';
      return null;
    }

    currentRegistration = result.value.registration;
    actionPhase = 'idle';
    return currentRegistration;
  }

  async function showLocalNotificationPreview(
    registrationLike: BrowserServiceWorkerRegistrationLike,
  ): Promise<void> {
    if (!payloadIsParsable) {
      const invalidPayloadResult: LocalNotificationResult = {
        ok: false,
        error: {
          code: 'validation-failed',
          message: 'Notification payload must be valid JSON.',
        },
      };
      localResult = invalidPayloadResult;
      safeEmit(onShowResult, invalidPayloadResult);
      emitError('local-show', invalidPayloadResult);
      return;
    }

    actionPhase = 'showing';
    const payloadValue = parsedPayload;
    let result: LocalNotificationResult;
    try {
      result = await showLocalNotification({
        payload: payloadValue ?? {},
        registration: registrationLike,
        fallbackTitle,
        origin: localOriginHint,
        environment,
      });
    } catch (cause) {
      result = {
        ok: false,
        error: {
          code: 'show-failed',
          message: 'showNotification rejected unexpectedly.',
          cause,
        },
      };
    }

    localResult = result;
    actionPhase = 'idle';
    safeEmit(onShowResult, result);
    if (!result.ok) {
      emitError('local-show', result);
      return;
    }

    detailMessage = 'Local notification shown.';
  }

  async function handleEnable(): Promise<void> {
    if (!canRequest) return;

    const permissionRequest = requestNotificationPermission(environment);
    actionPhase = 'requesting';
    statusMessage = '';
    detailMessage = '';

    let requestResult: PermissionRequestResult;
    try {
      requestResult = await permissionRequest;
    } catch (cause) {
      requestResult = {
        ok: false,
        error: {
          code: 'request-failed',
          message: 'Notification permission request rejected unexpectedly.',
          cause,
        },
      };
    }

    permissionResult = requestResult;
    actionPhase = 'idle';
    safeEmit(onPermissionResult, requestResult);
    if (!requestResult.ok) {
      emitPermissionState(permissionState);
      emitError('permission', requestResult);
      statusMessage = `${requestResult.error.message} (${requestResult.error.code})`;
      return;
    }

    emitPermissionState(requestResult.value);

    if (requestResult.value !== 'granted') {
      return;
    }

    if (autoRegister) {
      const registered = await ensureRegistration();
      if (!registered) return;
      if (autoShow) {
        await showLocalNotificationPreview(registered);
      }
    } else if (autoShow) {
      detailMessage = 'Enable local registration or pass registration to show a preview.';
    }
  }

  async function handleShowLocal(): Promise<void> {
    if (!canShowLocal || permissionState !== 'granted') return;

    const registered = await ensureRegistration();
    if (!registered) {
      const fallbackResult: LocalNotificationResult = {
        ok: false,
        error: {
          code: 'registration-unsupported',
          message: 'ServiceWorkerRegistration.showNotification is unavailable.',
        },
      };
      localResult = fallbackResult;
      safeEmit(onShowResult, fallbackResult);
      emitError('local-show', fallbackResult);
      actionPhase = 'idle';
      return;
    }

    await showLocalNotificationPreview(registered);
  }
</script>

<section
  class="notification-permission"
  class:unsupported={permissionState === 'unsupported'}
  class:insecure={permissionState === 'insecure'}
  class:default={permissionState === 'default'}
  class:denied={permissionState === 'denied'}
  class:granted={permissionState === 'granted'}
  aria-live="polite"
  data-testid="notification-permission"
>
  <h3>Browser notifications</h3>
  <p class="status" data-testid="notification-permission-status">{permissionStatusText}</p>

  {#if statusMessage || detailMessage || permissionResult || registrationResult || localResult}
    <div class="messages">
      {#if statusMessage}
        <p class="message message-status">{statusMessage}</p>
      {/if}
      {#if detailMessage}
        <p class="message message-detail">{detailMessage}</p>
      {/if}
      {#if permissionResult}
        <p class="message" data-testid="notification-permission-request">
          Permission request: {permissionResult.ok ? 'ok' : `failed (${permissionResult.error.code})`}
        </p>
      {/if}
      {#if registrationResult}
        <p class="message" data-testid="notification-permission-registration">
          Service worker: {registrationResult.ok ? 'registered' : `failed (${registrationResult.error.code})`}
        </p>
      {/if}
      {#if localResult}
        <p class="message" data-testid="notification-permission-local">
          Local show: {localResult.ok ? 'shown' : `failed (${localResult.error.code})`}
        </p>
      {/if}
    </div>
  {/if}

  <div class="actions">
    <button class="action-btn" onclick={handleEnable} disabled={!canRequest} data-testid="notification-permission-enable">
      {enableButtonText}
    </button>
    {#if autoRegister || currentRegistration || serviceWorkerScriptURL}
      <button
        class="action-btn ghost"
        onclick={handleShowLocal}
        disabled={!canShowLocal}
        data-testid="notification-permission-show"
      >
        {showLabel}
      </button>
    {/if}
  </div>

  {#if showPayloadInput}
    <label class="field">
      <span>{payloadLabel}</span>
      <textarea
        rows={payloadRows}
        bind:value={payloadText}
        oninput={onPayloadInputText}
        placeholder={payloadPlaceholder}
        aria-label={payloadLabel}
        data-testid="notification-permission-payload"
      ></textarea>
    </label>
    {#if !payloadIsParsable}
      <p class="error">Payload is not valid JSON.</p>
    {/if}
  {/if}
</section>

<style>
  .notification-permission {
    --np-bg: #f7f7f4;
    --np-line: #d9d1c4;
    --np-fg: #1b1b1b;
    --np-ok: #0b6a2f;
    --np-warn: #8a4b00;
    --np-err: #a32929;
    --np-unsupported: #5f6368;
    font-family: var(--font-thai, sans-serif);
    background: linear-gradient(180deg, #f7f7f4 0%, #ece7df 100%);
    border: 1px solid var(--np-line);
    border-radius: 12px;
    padding: 10px;
    color: var(--np-fg);
    display: grid;
    gap: 8px;
  }

  .notification-permission.unsupported {
    --np-bg: #f1f3f5;
    --np-fg: #3b4a58;
    border-color: #b0bbc8;
    background: linear-gradient(180deg, #f6f8fa 0%, #eef2f5 100%);
  }

  .notification-permission.insecure {
    --np-bg: #f3ece1;
    --np-fg: #5a4a37;
    border-color: #c4ab84;
    background: linear-gradient(180deg, #f8f2e9 0%, #f0e4d7 100%);
  }

  .notification-permission.default {
    border-color: #d7c8b1;
    background: linear-gradient(180deg, #f9f6ef 0%, #efe5d4 100%);
  }

  .notification-permission.denied {
    --np-err: #ab2b2b;
    border-color: #d6a9a9;
    background: linear-gradient(180deg, #fff0f0 0%, #f7dfdf 100%);
  }

  .notification-permission.granted {
    --np-ok: #1a6f35;
    border-color: #a9d5b8;
    background: linear-gradient(180deg, #effaf0 0%, #dff0e5 100%);
  }

  h3 {
    margin: 0;
    font: 700 13px var(--font-mono);
  }

  .status {
    margin: 0;
    font: 500 12px var(--font-thai);
  }

  .messages {
    border: 1px dashed var(--np-line);
    padding: 6px 8px;
    display: grid;
    gap: 4px;
  }

  .message {
    margin: 0;
    font: 600 11px var(--font-mono);
    color: var(--np-fg);
  }

  .message-status,
  .message-detail {
    color: var(--np-warn);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .action-btn {
    min-height: 42px;
    min-width: 200px;
    border: 1px solid var(--np-line);
    background: #1b1b1b;
    color: #fff;
    font: 700 12px var(--font-mono);
    padding: 0 14px;
    touch-action: manipulation;
  }

  .action-btn:disabled {
    opacity: 0.55;
  }

  .action-btn.ghost {
    border-color: var(--np-line);
    color: #1b1b1b;
    background: var(--np-bg);
  }

  .field {
    display: grid;
    gap: 6px;
  }

  .field span {
    font: 700 10px var(--font-mono);
    letter-spacing: 0.05em;
    color: #5a4f43;
    text-transform: uppercase;
  }

  textarea {
    min-height: 84px;
    border: 1px solid var(--np-line);
    background: #fffefb;
    color: var(--np-fg);
    font: 600 11px var(--font-mono);
    padding: 8px;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }

  .error {
    margin: 0;
    color: var(--np-err);
    font: 600 11px var(--font-mono);
  }

  @media (max-width: 680px) {
    .notification-permission {
      padding: 8px;
    }
    .action-btn {
      width: 100%;
      min-width: 0;
    }
  }
</style>
