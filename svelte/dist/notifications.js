import { AgentNotificationValidationError, validateAgentNotificationEvent, } from "@thumbmux/core";
export function resolveNotificationEnvironment(environment) {
    const root = asRecord(environment ?? globalThis);
    if (root === null) {
        return {
            isBrowser: false,
            isSecureContext: false,
            notification: null,
            navigator: null,
            location: null,
        };
    }
    const resolvedLocation = asRecord(root.location);
    return {
        isBrowser: true,
        isSecureContext: resolveSecureContext(root, resolvedLocation),
        // Prefer injected `notification` (tests/hosts); fall back to real browser
        // global `Notification` (capital N, constructor function).
        notification: asNotificationApi(root.notification) ?? asNotificationApi(root.Notification),
        navigator: asRecord(root.navigator),
        location: resolvedLocation ?? null,
    };
}
export function resolveNotificationPermissionState(environment) {
    const resolved = resolveNotificationEnvironment(environment);
    if (!resolved.notification)
        return "unsupported";
    if (!resolved.isSecureContext)
        return "insecure";
    return normalizePermissionState(resolved.notification.permission)
        ?? "default";
}
export async function requestNotificationPermission(environment) {
    const resolved = resolveNotificationEnvironment(environment);
    if (!resolved.notification) {
        return fail("unsupported", "Notification API is unavailable.");
    }
    if (!resolved.isSecureContext) {
        return fail("insecure", "Notification permission cannot be requested in insecure context.");
    }
    // Keep capability check, but invoke through the member expression so the
    // browser constructor's `this` is preserved (detached call → Illegal invocation).
    const notificationApi = resolved.notification;
    if (typeof notificationApi.requestPermission !== "function") {
        return fail("request-unsupported", "Notification.requestPermission is unavailable.");
    }
    let requestResult;
    try {
        // Must stay synchronous before the first await (user-gesture ordering).
        requestResult = notificationApi.requestPermission();
    }
    catch (cause) {
        return fail("request-failed", "Notification permission request threw.", cause);
    }
    let grantedState;
    try {
        grantedState = await Promise.resolve(requestResult);
    }
    catch (cause) {
        return fail("request-failed", "Notification permission request rejected.", cause);
    }
    const normalized = normalizePermissionState(grantedState)
        ?? normalizePermissionState(resolved.notification.permission);
    if (normalized === null) {
        return fail("request-state-invalid", "Permission request resolved to an unrecognized state.");
    }
    return success(normalized);
}
export async function registerServiceWorker(input) {
    if (typeof input.scriptURL !== "string" || input.scriptURL.trim() === "") {
        return fail("invalid-script-url", "scriptURL must be a non-empty string.");
    }
    const resolved = resolveNotificationEnvironment(input.environment);
    // Order: invalid-script-url (above) → unsupported → insecure →
    // service-worker-unsupported → registration-failed. On plain HTTP, browsers
    // hide serviceWorker entirely; report insecure before "unsupported browser".
    if (!resolved.notification) {
        return fail("unsupported", "Notification API is unavailable.");
    }
    if (!resolved.isSecureContext) {
        return fail("insecure", "Service worker registration is disabled in insecure context.");
    }
    const container = resolved.navigator?.serviceWorker;
    if (!container || typeof container.register !== "function") {
        return fail("service-worker-unsupported", "ServiceWorker container is unavailable.");
    }
    try {
        // Invoke through member expression to preserve ServiceWorkerContainer `this`.
        const registration = await container.register(input.scriptURL, input.options);
        return success({ registration });
    }
    catch (cause) {
        return fail("registration-failed", "Service worker registration failed.", cause);
    }
}
export async function showLocalNotification(input) {
    const resolved = resolveNotificationEnvironment(input.environment);
    const state = resolveNotificationPermissionState(resolved);
    if (state !== "granted") {
        if (state === "insecure")
            return fail("insecure", "Cannot display local notifications in insecure context.");
        if (state === "unsupported")
            return fail("unsupported", "Notification API is unavailable.");
        return fail("permission-denied", "Notification permission is not granted.");
    }
    if (!input.registration || typeof input.registration.showNotification !== "function") {
        return fail("registration-unsupported", "ServiceWorkerRegistration.showNotification is unavailable.");
    }
    const hasUrl = hasOwnProperty(input.payload, "url");
    const origin = hasUrl ? resolveTrustedOrigin(resolved.location, input.origin) : null;
    const options = {};
    if (hasUrl) {
        if (!origin) {
            return fail("missing-trusted-origin", "Current trusted HTTP(S) origin is not available.");
        }
        options.origin = origin;
    }
    let event;
    try {
        event = validateAgentNotificationEvent(input.payload, options);
    }
    catch (cause) {
        if (typeof cause === "object" && cause !== null && "field" in cause && "code" in cause) {
            const validationError = cause;
            return fail("validation-failed", `Agent notification validation failed for field ${String(validationError.field)} (${validationError.code}).`, cause);
        }
        return fail("validation-failed", "Agent notification validation failed.", cause);
    }
    if (hasUrl && !origin) {
        return fail("missing-trusted-origin", "Current trusted HTTP(S) origin is not available.");
    }
    const payloadTitle = event.title ?? input.fallbackTitle ?? "Thumbmux notification";
    const notificationOptions = {
        body: event.body,
        tag: event.tag,
        data: { event },
    };
    try {
        await Promise.resolve(input.registration.showNotification(payloadTitle, notificationOptions));
        return success({ event });
    }
    catch (cause) {
        return fail("show-failed", "showNotification failed.", cause);
    }
}
function resolveSecureContext(root, location) {
    const secure = root.isSecureContext;
    if (typeof secure === "boolean")
        return secure;
    if (location) {
        const protocol = asString(location.protocol);
        if (protocol === "https:")
            return true;
        if (protocol === "http:" || protocol === "file:")
            return false;
        if (typeof location.origin === "string") {
            // Fail closed: only https: origins count as secure when isSecureContext
            // and protocol are absent. Plain http: must not look secure.
            const parsed = parseTrustedHttpsOrigin(location.origin);
            return parsed !== null;
        }
    }
    return false;
}
/**
 * Like parseTrustedHttpOrigin but only accepts https: — used for the
 * secure-context fallback so plain HTTP fails closed.
 */
function parseTrustedHttpsOrigin(origin) {
    const parsed = parseTrustedHttpOrigin(origin);
    if (parsed === null)
        return null;
    try {
        return new URL(parsed).protocol === "https:" ? parsed : null;
    }
    catch {
        return null;
    }
}
function resolveTrustedOrigin(location, originHint) {
    const currentOrigin = location ? parseTrustedHttpOrigin(location.origin) : null;
    if (currentOrigin)
        return currentOrigin;
    if (typeof originHint !== "string")
        return null;
    return parseTrustedHttpOrigin(originHint);
}
function parseTrustedHttpOrigin(origin) {
    if (typeof origin !== "string")
        return null;
    const normalized = origin.trim();
    if (normalized.length === 0)
        return null;
    let parsed;
    try {
        parsed = new URL(normalized);
    }
    catch {
        return null;
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.pathname !== "/"
        || parsed.search !== ""
        || parsed.hash !== "") {
        return null;
    }
    return parsed.origin;
}
function normalizePermissionState(value) {
    return value === "default" || value === "denied" || value === "granted" ? value : null;
}
function hasOwnProperty(value, key) {
    if (!isRecord(value))
        return false;
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value) {
    return isRecord(value) ? value : null;
}
/**
 * Accept object *or* function (the real `window.Notification` is a constructor).
 * Double cast avoids TS weak-type error when the value is a function.
 */
function asNotificationApi(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "object" && typeof value !== "function")
        return null;
    return value;
}
function asString(value) {
    if (typeof value !== "string")
        return undefined;
    return value.trim().toLowerCase();
}
function success(value) {
    return { ok: true, value };
}
function fail(code, message, cause) {
    return { ok: false, error: { code, message, cause } };
}
