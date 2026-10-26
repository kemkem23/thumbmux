import { type AgentNotificationEvent } from "../core/index.js";
type UnknownPermissionState = unknown;
export type NotificationPermissionState = "unsupported" | "insecure" | "default" | "denied" | "granted";
export interface BrowserLocationLike {
    origin?: unknown;
    protocol?: unknown;
}
export interface BrowserNotificationApiLike {
    permission?: UnknownPermissionState;
    requestPermission?: () => UnknownPermissionState | Promise<UnknownPermissionState>;
}
export interface BrowserNavigatorLike {
    serviceWorker?: BrowserServiceWorkerContainerLike;
}
export interface BrowserServiceWorkerContainerLike {
    register: (scriptURL: string, options?: BrowserServiceWorkerRegistrationOptions) => PromiseLike<BrowserServiceWorkerRegistrationLike>;
}
export interface BrowserServiceWorkerRegistrationLike {
    showNotification: (title: string, options?: BrowserServiceWorkerShowOptions) => PromiseLike<unknown> | void;
}
export interface BrowserServiceWorkerRegistrationOptions {
    scope?: string;
    type?: "classic" | "module";
    updateViaCache?: "imports" | "all" | "none";
    [key: string]: unknown;
}
export interface BrowserServiceWorkerShowOptions {
    body?: string;
    tag?: string;
    data?: unknown;
}
export interface BrowserNotificationEnvironment {
    isSecureContext?: unknown;
    location?: BrowserLocationLike;
    notification?: BrowserNotificationApiLike;
    /** Real browser global (`window.Notification`) — constructor function. */
    Notification?: unknown;
    navigator?: BrowserNavigatorLike;
}
export interface ResolvedBrowserNotificationEnvironment {
    isBrowser: boolean;
    isSecureContext: boolean;
    notification: BrowserNotificationApiLike | null;
    navigator: BrowserNavigatorLike | null;
    location: BrowserLocationLike | null;
}
export interface NotificationResultSuccess<T> {
    ok: true;
    value: T;
}
export interface NotificationResultError<C extends string> {
    ok: false;
    error: {
        code: C;
        message: string;
        cause?: unknown;
    };
}
export type NotificationResult<T, C extends string> = NotificationResultSuccess<T> | NotificationResultError<C>;
export type PermissionRequestResult = NotificationResult<NotificationPermissionState, "unsupported" | "insecure" | "request-unsupported" | "request-failed" | "request-state-invalid">;
export type ServiceWorkerRegistrationResult = NotificationResult<{
    registration: BrowserServiceWorkerRegistrationLike;
}, "unsupported" | "insecure" | "service-worker-unsupported" | "registration-failed" | "invalid-script-url">;
export type LocalNotificationResult = NotificationResult<{
    event: AgentNotificationEvent;
}, "unsupported" | "insecure" | "permission-denied" | "registration-unsupported" | "missing-trusted-origin" | "validation-failed" | "show-failed">;
export interface RegisterServiceWorkerInput {
    scriptURL: string;
    options?: BrowserServiceWorkerRegistrationOptions;
    environment?: unknown;
}
export interface ShowLocalNotificationInput {
    payload: unknown;
    registration: BrowserServiceWorkerRegistrationLike;
    fallbackTitle?: string;
    environment?: unknown;
    origin?: string;
}
export declare function resolveNotificationEnvironment(environment?: unknown): ResolvedBrowserNotificationEnvironment;
export declare function resolveNotificationPermissionState(environment?: unknown): NotificationPermissionState;
export declare function requestNotificationPermission(environment?: unknown): Promise<PermissionRequestResult>;
export declare function registerServiceWorker(input: RegisterServiceWorkerInput): Promise<ServiceWorkerRegistrationResult>;
export declare function showLocalNotification(input: ShowLocalNotificationInput): Promise<LocalNotificationResult>;
export {};
