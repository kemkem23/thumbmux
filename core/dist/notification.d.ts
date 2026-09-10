export type AgentNotificationState = "finished" | "waiting";
export type AgentNotificationEvent = {
    id: string;
    session: string;
    state: AgentNotificationState;
    occurredAt: number;
    title?: string;
    body?: string;
    url?: string;
    tag?: string;
};
export interface AgentNotificationNormalizeOptions {
    origin?: string;
}
export declare const AGENT_NOTIFICATION_LIMITS: Readonly<{
    id: 128;
    session: 256;
    state: readonly ["finished", "waiting"];
    title: 160;
    body: 4096;
    tag: 128;
    url: 2048;
    occurredAtMin: 0;
    occurredAtMax: 8640000000000000;
}>;
export type AgentNotificationValidationErrorCode = "invalid_record" | "unknown_field" | "invalid_field_accessor" | "missing_required_field" | "invalid_type" | "invalid_state" | "invalid_length" | "invalid_timestamp" | "invalid_url";
export declare class AgentNotificationValidationError extends Error {
    readonly field: string;
    readonly code: AgentNotificationValidationErrorCode;
    constructor(field: string, code: AgentNotificationValidationErrorCode, message: string);
}
export declare function sameOriginNotificationUrl(candidate: string, origin: string): string | null;
export declare function normalizeAgentNotificationEvent(value: unknown, options?: AgentNotificationNormalizeOptions): AgentNotificationEvent;
export declare function validateAgentNotificationEvent(value: unknown, options?: AgentNotificationNormalizeOptions): AgentNotificationEvent;
