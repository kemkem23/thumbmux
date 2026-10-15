import type { BrowserNotificationEnvironment, BrowserServiceWorkerRegistrationLike, BrowserServiceWorkerRegistrationOptions, LocalNotificationResult, NotificationPermissionState, PermissionRequestResult, ServiceWorkerRegistrationResult } from './notifications.js';
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
type $$ComponentProps = {
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
};
declare const NotificationPermission: import("svelte").Component<$$ComponentProps, {}, "">;
type NotificationPermission = ReturnType<typeof NotificationPermission>;
export default NotificationPermission;
