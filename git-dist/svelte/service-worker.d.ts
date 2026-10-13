import { type AgentNotificationEvent } from "../core/index.js";
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
    showNotification(title: string, options?: {
        body?: string;
        tag?: string;
        data?: unknown;
    }): unknown | PromiseLike<unknown>;
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
export type PushErrorCode = ParsePayloadErrorCode | "registration-context" | "show-failed";
export type PushResult = ServiceWorkerResult<{
    event: AgentNotificationEvent;
}, PushErrorCode>;
export interface ClickContext {
    clients: ClientHost;
    trustedOrigin: string;
}
export type ClickErrorCode = ParsePayloadErrorCode | "registration-context" | "no-url" | "open-failed";
export type ClickResult = ServiceWorkerResult<{
    event: AgentNotificationEvent;
}, ClickErrorCode>;
export interface ListenerContext {
    push: PushContext;
    click: ClickContext;
}
export interface NotificationListeners {
    unregister: () => void;
}
export type RegistrationErrorCode = "registration-context";
export type RegistrationResult = ServiceWorkerResult<NotificationListeners, RegistrationErrorCode>;
export declare function parseNotificationPayload(payload: unknown, options?: ParsePayloadOptions): ParsePayloadResult;
export declare function handlePushNotificationEvent(event: PushEventLike, context: PushContext): Promise<PushResult>;
export declare function handleNotificationClickEvent(event: NotificationClickEventLike, context: ClickContext): Promise<ClickResult>;
export declare function registerNotificationServiceWorkerHandlers(host: ServiceWorkerListenerHost, context: ListenerContext): RegistrationResult;
