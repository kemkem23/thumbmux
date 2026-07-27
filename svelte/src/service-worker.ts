import {
  AgentNotificationValidationError,
  type AgentNotificationEvent,
  validateAgentNotificationEvent,
} from "@thumbmux/core";

type UnknownRecord = Record<string, unknown>;

const DEFAULT_NOTIFICATION_TITLE = "Thumbmux notification";

export interface ServiceWorkerListenerHost {
  addEventListener(type: "push" | "notificationclick", listener: (event: unknown) => void): void;
  removeEventListener?(type: "push" | "notificationclick", listener: (event: unknown) => void): void;
}

export interface PushPayloadDataLike {
  json?: () => unknown;
  text?: () => unknown;
}

export interface PushEventLike {
  data?: PushPayloadDataLike | null;
  waitUntil?: (promise: PromiseLike<unknown>) => void;
}

export interface RegistrationForPush {
  showNotification(
    title: string,
    options?: {
      body?: string;
      tag?: string;
      data?: unknown;
    },
  ): unknown | PromiseLike<unknown>;
}

export interface NotificationLike {
  data?: unknown;
  /** Browser Notification.close() — dismisses from the system tray. */
  close?: () => void;
}

export interface NotificationClickEventLike {
  notification?: NotificationLike | null;
  waitUntil?: (promise: PromiseLike<unknown>) => void;
}

export interface ClientHost {
  openWindow: (url: string) => unknown | PromiseLike<unknown>;
}

export interface ServiceWorkerResultSuccess<T> {
  ok: true;
  value: T;
}

export interface ServiceWorkerResultError<C extends string> {
  ok: false;
  error: {
    code: C;
    message: string;
    cause?: unknown;
  };
}

export type ServiceWorkerResult<T, C extends string> = ServiceWorkerResultSuccess<T> | ServiceWorkerResultError<C>;

export interface ParsePayloadOptions {
  trustedOrigin?: string;
}

export type ParsePayloadErrorCode = "parse-failed" | "missing-trusted-origin" | "validation-failed";
export type ParsePayloadResult = ServiceWorkerResult<AgentNotificationEvent, ParsePayloadErrorCode>;

export interface PushContext {
  registration: RegistrationForPush;
  trustedOrigin: string;
  fallbackTitle?: string;
}

export type PushErrorCode =
  | ParsePayloadErrorCode
  | "registration-context"
  | "show-failed";
export type PushResult = ServiceWorkerResult<{ event: AgentNotificationEvent }, PushErrorCode>;

export interface ClickContext {
  clients: ClientHost;
  trustedOrigin: string;
}

export type ClickErrorCode =
  | ParsePayloadErrorCode
  | "registration-context"
  | "no-url"
  | "open-failed";
export type ClickResult = ServiceWorkerResult<{ event: AgentNotificationEvent }, ClickErrorCode>;

export interface ListenerContext {
  push: PushContext;
  click: ClickContext;
}

export interface NotificationListeners {
  unregister: () => void;
}

export type RegistrationErrorCode = "registration-context";
export type RegistrationResult = ServiceWorkerResult<NotificationListeners, RegistrationErrorCode>;

export function parseNotificationPayload(
  payload: unknown,
  options: ParsePayloadOptions = {},
): ParsePayloadResult {
  const extracted = extractPayload(payload);
  if (!extracted.ok) {
    return extracted;
  }

  const parsedPayload = extracted.value;
  const hasUrl = hasOwnPayloadUrl(parsedPayload);
  let validateOptions: { origin: string } | undefined;

  if (hasUrl) {
    const origin = parseTrustedHttpOrigin(options.trustedOrigin);
    if (origin === null) {
      return fail(
        "missing-trusted-origin",
        "A URL field is present, but trustedOrigin is missing or not a valid HTTP(S) origin.",
      );
    }
    validateOptions = { origin };
  }

  try {
    const normalized = validateAgentNotificationEvent(parsedPayload, validateOptions);
    return success(normalized);
  } catch (cause) {
    if (isAgentNotificationValidationError(cause)) {
      return fail(
        "validation-failed",
        `Agent notification validation failed for field ${String(cause.field)} (${cause.code}).`,
        cause,
      );
    }
    return fail("validation-failed", "Agent notification validation failed.", cause);
  }
}

export async function handlePushNotificationEvent(
  event: PushEventLike,
  context: PushContext,
): Promise<PushResult> {
  const handled = executePushNotificationEvent(event, context).catch((cause) =>
    fail<PushErrorCode>(
      "show-failed",
      "Unhandled push-notification handling error.",
      cause,
    ),
  );

  if (isWaitUntilHost(event)) {
    event.waitUntil(handled);
  }

  return handled;
}

export async function handleNotificationClickEvent(
  event: NotificationClickEventLike,
  context: ClickContext,
): Promise<ClickResult> {
  const handled = executeNotificationClickEvent(event, context).catch((cause) =>
    fail<ClickErrorCode>(
      "open-failed",
      "Unhandled notification-click handling error.",
      cause,
    ),
  );

  if (isWaitUntilHost(event)) {
    event.waitUntil(handled);
  }

  return handled;
}

export function registerNotificationServiceWorkerHandlers(
  host: ServiceWorkerListenerHost,
  context: ListenerContext,
): RegistrationResult {
  if (!host || typeof host.addEventListener !== "function") {
    return fail("registration-context", "Listener host must provide addEventListener.");
  }
  if (!isObject(context) || !isObject(context.push) || !isObject(context.click)) {
    return fail("registration-context", "Context must provide push and click handlers context.");
  }

  const onPush = (rawEvent: unknown): void => {
    void handlePushNotificationEvent(toPushEvent(rawEvent), context.push);
  };
  const onClick = (rawEvent: unknown): void => {
    void handleNotificationClickEvent(toNotificationClickEvent(rawEvent), context.click);
  };

  let pushRegistered = false;
  try {
    host.addEventListener("push", onPush);
    pushRegistered = true;
    host.addEventListener("notificationclick", onClick);
  } catch (cause) {
    if (pushRegistered && typeof host.removeEventListener === "function") {
      try {
        host.removeEventListener("push", onPush);
      } catch {
        // The original registration failure remains the represented result.
      }
    }
    return fail("registration-context", "Failed to register service worker listeners.", cause);
  }

  const unregister = (): void => {
    if (typeof host.removeEventListener !== "function") return;
    host.removeEventListener("push", onPush);
    host.removeEventListener("notificationclick", onClick);
  };

  return success({ unregister });
}

async function executePushNotificationEvent(event: PushEventLike, context: PushContext): Promise<PushResult> {
  if (!context || typeof context !== "object") {
    return fail("registration-context", "Push context must be an object.");
  }
  if (typeof context.registration?.showNotification !== "function") {
    return fail("registration-context", "registration.showNotification is unavailable.");
  }

  const payload = extractPushPayload(event);
  if (!payload.ok) {
    return { ok: false, error: payload.error };
  }
  const parsed = parseNotificationPayload(payload.value, { trustedOrigin: context.trustedOrigin });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const title = parsed.value.title ?? context.fallbackTitle ?? DEFAULT_NOTIFICATION_TITLE;
  const showOptions = {
    body: parsed.value.body,
    tag: parsed.value.tag,
    data: parsed.value,
  };

  try {
    await Promise.resolve(context.registration.showNotification(title, showOptions));
    return success({ event: parsed.value });
  } catch (cause) {
    return fail("show-failed", "showNotification failed.", cause);
  }
}

async function executeNotificationClickEvent(
  event: NotificationClickEventLike,
  context: ClickContext,
): Promise<ClickResult> {
  // Dismiss first, before any context/payload checks, so a click always clears
  // the tray entry even when the payload is garbage or the context is broken.
  closeNotification(event);

  if (!context || typeof context !== "object") {
    return fail("registration-context", "Click context must be an object.");
  }
  if (typeof context.clients?.openWindow !== "function") {
    return fail("registration-context", "clients.openWindow is unavailable.");
  }

  const payload = extractClickPayload(event);
  if (!payload.ok) {
    return { ok: false, error: payload.error };
  }
  const parsed = parseNotificationPayload(payload.value, { trustedOrigin: context.trustedOrigin });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const targetUrl = parsed.value.url;
  if (typeof targetUrl !== "string") {
    return fail("no-url", "Notification payload has no url field.");
  }

  try {
    await Promise.resolve(context.clients.openWindow(targetUrl));
    return success({ event: parsed.value });
  } catch (cause) {
    return fail("open-failed", "openWindow failed.", cause);
  }
}

function extractPayload(value: unknown): ServiceWorkerResult<unknown, "parse-failed"> {
  if (value === undefined) {
    return fail("parse-failed", "No push payload was provided.");
  }

  const payloadData = value as PushPayloadDataLike;
  if (payloadData !== null && typeof payloadData === "object") {
    if (typeof payloadData.json === "function") {
      let jsonValue: unknown;
      try {
        jsonValue = payloadData.json();
      } catch (cause) {
        return fail("parse-failed", "Push payload json() parsing threw.", cause);
      }

      if (typeof jsonValue === "string") {
        return parsePayloadText(jsonValue);
      }
      return success(jsonValue);
    }

    if (typeof payloadData.text === "function") {
      let textValue: unknown;
      try {
        textValue = payloadData.text();
      } catch (cause) {
        return fail("parse-failed", "Push payload text() parsing threw.", cause);
      }

      if (typeof textValue === "string") {
        return parsePayloadText(textValue);
      }
      return success(textValue);
    }
  }

  if (typeof value === "string") {
    return parsePayloadText(value);
  }

  return success(value);
}

function parsePayloadText(value: string): ServiceWorkerResult<unknown, "parse-failed"> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return fail("parse-failed", "Push payload text is empty.");
  }

  try {
    return success(JSON.parse(trimmed));
  } catch (cause) {
    return fail("parse-failed", "Push payload text is not valid JSON.", cause);
  }
}

function extractPushPayload(event: PushEventLike): ServiceWorkerResult<unknown, "parse-failed"> {
  if (!isObject(event)) {
    return fail("parse-failed", "Push event is not an object.");
  }
  if (!("data" in event)) {
    return fail("parse-failed", "Push event has no data.");
  }
  return extractPayload(event.data);
}

/**
 * Best-effort dismissal. Invoked through the member expression so the real
 * Notification.close keeps its `this`. Throws are swallowed and never change
 * the represented click result.
 */
function closeNotification(event: NotificationClickEventLike): void {
  try {
    const notification = isObject(event) ? event.notification : null;
    if (notification && typeof (notification as { close?: unknown }).close === "function") {
      (notification as { close: () => void }).close();
    }
  } catch {
    // Dismissal is best-effort; never let it change the represented result.
  }
}

function extractClickPayload(event: NotificationClickEventLike): ServiceWorkerResult<unknown, "parse-failed"> {
  if (!isObject(event)) {
    return fail("parse-failed", "Notification click event is not an object.");
  }
  const notification = event.notification;
  if (notification === null || notification === undefined || typeof notification !== "object") {
    return fail("parse-failed", "Notification click event has no data.");
  }
  if (!("data" in notification)) {
    return fail("parse-failed", "Notification click event has no data.");
  }

  const data = notification.data;
  if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, "event")) {
    return success(data.event);
  }
  return success(data);
}

function hasOwnPayloadUrl(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "url");
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return isObject(value) && !Array.isArray(value);
}

function isWaitUntilHost(
  event: { waitUntil?: unknown } | unknown,
): event is { waitUntil: (promise: PromiseLike<unknown>) => void } {
  return isObject(event) && typeof event.waitUntil === "function";
}

function parseTrustedHttpOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const normalized = origin.trim();
  if (normalized.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return null;
  }

  return parsed.origin;
}

function toPushEvent(event: unknown): PushEventLike {
  return isObject(event) ? (event as PushEventLike) : {};
}

function toNotificationClickEvent(event: unknown): NotificationClickEventLike {
  return isObject(event) ? (event as NotificationClickEventLike) : {};
}

function isAgentNotificationValidationError(value: unknown): value is AgentNotificationValidationError {
  return (
    value instanceof Error
    && value.name === "AgentNotificationValidationError"
    && typeof (value as AgentNotificationValidationError).field === "string"
    && typeof (value as AgentNotificationValidationError).code === "string"
  );
}

function success<T>(value: T): ServiceWorkerResultSuccess<T> {
  return { ok: true, value };
}

function fail<C extends string>(
  code: C,
  message: string,
  cause?: unknown,
): ServiceWorkerResultError<C> {
  return { ok: false, error: { code, message, cause } };
}
