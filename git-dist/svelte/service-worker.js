import { AgentNotificationValidationError, validateAgentNotificationEvent, } from "../core/index.js";
const DEFAULT_NOTIFICATION_TITLE = "Thumbmux notification";
export function parseNotificationPayload(payload, options = {}) {
    const extracted = extractPayload(payload);
    if (!extracted.ok) {
        return extracted;
    }
    const parsedPayload = extracted.value;
    const hasUrl = hasOwnPayloadUrl(parsedPayload);
    let validateOptions;
    if (hasUrl) {
        const origin = parseTrustedHttpOrigin(options.trustedOrigin);
        if (origin === null) {
            return fail("missing-trusted-origin", "A URL field is present, but trustedOrigin is missing or not a valid HTTP(S) origin.");
        }
        validateOptions = { origin };
    }
    try {
        const normalized = validateAgentNotificationEvent(parsedPayload, validateOptions);
        return success(normalized);
    }
    catch (cause) {
        if (isAgentNotificationValidationError(cause)) {
            return fail("validation-failed", `Agent notification validation failed for field ${String(cause.field)} (${cause.code}).`, cause);
        }
        return fail("validation-failed", "Agent notification validation failed.", cause);
    }
}
export async function handlePushNotificationEvent(event, context) {
    const handled = executePushNotificationEvent(event, context).catch((cause) => fail("show-failed", "Unhandled push-notification handling error.", cause));
    if (isWaitUntilHost(event)) {
        event.waitUntil(handled);
    }
    return handled;
}
export async function handleNotificationClickEvent(event, context) {
    const handled = executeNotificationClickEvent(event, context).catch((cause) => fail("open-failed", "Unhandled notification-click handling error.", cause));
    if (isWaitUntilHost(event)) {
        event.waitUntil(handled);
    }
    return handled;
}
export function registerNotificationServiceWorkerHandlers(host, context) {
    if (!host || typeof host.addEventListener !== "function") {
        return fail("registration-context", "Listener host must provide addEventListener.");
    }
    if (!isObject(context) || !isObject(context.push) || !isObject(context.click)) {
        return fail("registration-context", "Context must provide push and click handlers context.");
    }
    const onPush = (rawEvent) => {
        void handlePushNotificationEvent(toPushEvent(rawEvent), context.push);
    };
    const onClick = (rawEvent) => {
        void handleNotificationClickEvent(toNotificationClickEvent(rawEvent), context.click);
    };
    let pushRegistered = false;
    try {
        host.addEventListener("push", onPush);
        pushRegistered = true;
        host.addEventListener("notificationclick", onClick);
    }
    catch (cause) {
        if (pushRegistered && typeof host.removeEventListener === "function") {
            try {
                host.removeEventListener("push", onPush);
            }
            catch {
                // The original registration failure remains the represented result.
            }
        }
        return fail("registration-context", "Failed to register service worker listeners.", cause);
    }
    const unregister = () => {
        if (typeof host.removeEventListener !== "function")
            return;
        host.removeEventListener("push", onPush);
        host.removeEventListener("notificationclick", onClick);
    };
    return success({ unregister });
}
async function executePushNotificationEvent(event, context) {
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
    }
    catch (cause) {
        return fail("show-failed", "showNotification failed.", cause);
    }
}
async function executeNotificationClickEvent(event, context) {
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
    }
    catch (cause) {
        return fail("open-failed", "openWindow failed.", cause);
    }
}
function extractPayload(value) {
    if (value === undefined) {
        return fail("parse-failed", "No push payload was provided.");
    }
    const payloadData = value;
    if (payloadData !== null && typeof payloadData === "object") {
        if (typeof payloadData.json === "function") {
            let jsonValue;
            try {
                jsonValue = payloadData.json();
            }
            catch (cause) {
                return fail("parse-failed", "Push payload json() parsing threw.", cause);
            }
            if (typeof jsonValue === "string") {
                return parsePayloadText(jsonValue);
            }
            return success(jsonValue);
        }
        if (typeof payloadData.text === "function") {
            let textValue;
            try {
                textValue = payloadData.text();
            }
            catch (cause) {
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
function parsePayloadText(value) {
    const trimmed = value.trim();
    if (trimmed === "") {
        return fail("parse-failed", "Push payload text is empty.");
    }
    try {
        return success(JSON.parse(trimmed));
    }
    catch (cause) {
        return fail("parse-failed", "Push payload text is not valid JSON.", cause);
    }
}
function extractPushPayload(event) {
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
function closeNotification(event) {
    try {
        const notification = isObject(event) ? event.notification : null;
        if (notification && typeof notification.close === "function") {
            notification.close();
        }
    }
    catch {
        // Dismissal is best-effort; never let it change the represented result.
    }
}
function extractClickPayload(event) {
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
function hasOwnPayloadUrl(value) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "url");
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function isRecord(value) {
    return isObject(value) && !Array.isArray(value);
}
function isWaitUntilHost(event) {
    return isObject(event) && typeof event.waitUntil === "function";
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
function toPushEvent(event) {
    return isObject(event) ? event : {};
}
function toNotificationClickEvent(event) {
    return isObject(event) ? event : {};
}
function isAgentNotificationValidationError(value) {
    return (value instanceof Error
        && value.name === "AgentNotificationValidationError"
        && typeof value.field === "string"
        && typeof value.code === "string");
}
function success(value) {
    return { ok: true, value };
}
function fail(code, message, cause) {
    return { ok: false, error: { code, message, cause } };
}
