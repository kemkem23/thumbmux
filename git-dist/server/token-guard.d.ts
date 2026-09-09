export type TokenScope = "read" | "interactive";
/** Explicit opt-ins for operations that no scope receives by default. */
export type TokenPermission = "sessions-kill";
export type TokenGrant = {
    token: string;
    scope: TokenScope;
    expiresAt: number;
    sessions?: readonly string[];
    /** Destructive operations are denied unless explicitly listed here. */
    permissions?: readonly TokenPermission[];
};
export type TokenPrincipal = {
    scope: TokenScope;
    expiresAt: number;
    sessions?: readonly string[];
};
export type TokenAuthSource = "query" | "cookie";
type SessionName = string;
export type SessionRow = string | {
    name: string;
    [key: string]: unknown;
};
export type HttpOperation = "static" | "auth-description" | "ws-upgrade" | "sessions-list" | "sessions-spawn" | "sessions-kill" | "prefs-read" | "prefs-write" | "recordings-list" | "recordings-download" | "recording-start" | "recording-stop" | "upload";
/**
 * Parsed route information supplied by a host. Passing an operation lets a
 * host avoid duplicating URL-string policy while preserving one pure guard.
 * The session field is required for operations whose route/body names it.
 */
export type HttpAuthorizationContext = {
    operation?: HttpOperation;
    session?: string;
    recordingId?: string;
};
export type TokenGuardErrorCode = "missing_credential" | "malformed_credential" | "invalid_credential" | "expired_credential" | "forbidden_scope" | "forbidden_session" | "forbidden_operation";
export interface TokenGuardOptions {
    /** Ordered grants configured by host. */
    grants: ReadonlyArray<TokenGrant>;
    /** Optional explicit token query name (default: "t"). */
    queryParamName?: string;
    /** Optional explicit cookie name (default: "tmux_demo_t"). */
    cookieName?: string;
    /** Time injection for deterministic tests. */
    now?: () => number;
    /** Explicit secure-cookie decision; defaults to https or forwarded https. */
    cookieSecure?: boolean | ((request: Request) => boolean);
    /** Map recording ID -> session name for download authorization. */
    recordingSessionResolver?: (recordingId: string) => string | undefined;
    /** Redaction placeholder for helper output. */
    redactionPlaceholder?: string;
}
export interface TokenAuthFailure {
    ok: false;
    status: 401 | 403;
    code: TokenGuardErrorCode;
    message: string;
}
export interface TokenAuthSuccess {
    ok: true;
    status: 200;
    principal: TokenPrincipal;
    source: TokenAuthSource;
    setCookie?: string;
}
export type TokenAuthResult = TokenAuthSuccess | TokenAuthFailure;
export interface HttpAuthSuccess {
    ok: true;
    status: 200;
    operation: HttpOperation;
    session?: SessionName;
}
export interface HttpAuthFailure {
    ok: false;
    status: 401 | 403;
    code: TokenGuardErrorCode;
    message: string;
}
export type HttpAuthResult = HttpAuthSuccess | HttpAuthFailure;
export interface MuxAuthSuccess {
    ok: true;
    status: 200;
    operation: "ping" | "client_info" | "sessions_subscribe" | "sessions_unsubscribe" | "subscribe" | "unsubscribe" | "history_expand" | "resync" | "keys" | "resize";
    session?: SessionName;
}
export interface MuxAuthFailure {
    ok: false;
    status: 401 | 403;
    code: TokenGuardErrorCode;
    message: string;
}
export type MuxAuthResult = MuxAuthSuccess | MuxAuthFailure;
export interface TokenGuard {
    /** Exact query/cookie authentication with deterministic success/failure result. */
    authenticate(req: Request): TokenAuthResult;
    /** Authorize one already-authenticated principal for an HTTP request operation. */
    authorizeHttp(req: Request, principal: TokenPrincipal, context?: HttpAuthorizationContext): HttpAuthResult;
    /** Authorize one already-authenticated principal for one parsed WS message. */
    authorizeMuxMessage(message: unknown, principal: TokenPrincipal): MuxAuthResult;
    /** Token-free principal conversion for socket storage during WS upgrades. */
    createSocketPrincipal(grant: TokenGrant): TokenPrincipal;
    /** Convert any token-bearing principal into a token-free clone (defensive copy). */
    sanitizePrincipal(principal: TokenPrincipal): TokenPrincipal;
    /** Exact allow-list predicate for a session. */
    isSessionAllowed(principal: TokenPrincipal, session: string): boolean;
    /** Session list filtering that preserves order and never mutates input. */
    filterSessions<T>(sessions: readonly T[], principal: TokenPrincipal, nameOf?: (row: T) => string | null | undefined): readonly T[];
    /** Safe Set-Cookie header for successful query bootstrap. */
    makeCookieHeader(grant: TokenGrant, req: Request): string;
    /** Remove configured token material from log/error payloads. */
    redact(text: string): string;
    /**
     * Permanently revoke a configured token. Returns true if a not-yet-revoked
     * grant matched; false if the token is unknown or already revoked. Invalidates
     * both new authentications and any live principals minted from that grant.
     */
    revoke(token: string): boolean;
    /** Access configured options as seen by tests/integrators. */
    readonly options: {
        queryParamName: string;
        cookieName: string;
        redactionPlaceholder: string;
    };
}
export declare function createTokenGuard(options: TokenGuardOptions): TokenGuard;
export {};
