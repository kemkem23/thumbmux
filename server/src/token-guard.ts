/**
 * Token guard for thumbmux HTTP + WebSocket access.
 *
 * The guard validates credentials from one exact query token (`t`) or one exact
 * cookie name/value pair, builds a safe bootstrap cookie, checks scope + expiry,
 * enforces allow-lists, and keeps principals token-free for WS upgrades.
 * Grants are snapshotted at construction, matching is constant-time over all
 * grants, and tokens can be revoked.
 */
import { createHash, timingSafeEqual } from "node:crypto";

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

export type SessionRow = string | { name: string; [key: string]: unknown };

export type HttpOperation =
  | "static"
  | "auth-description"
  | "ws-upgrade"
  | "sessions-list"
  | "sessions-spawn"
  | "sessions-kill"
  | "prefs-read"
  | "prefs-write"
  | "recordings-list"
  | "recordings-download"
  | "recording-start"
  | "recording-stop"
  | "upload";

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

export type TokenGuardErrorCode =
  | "missing_credential"
  | "malformed_credential"
  | "invalid_credential"
  | "expired_credential"
  | "forbidden_scope"
  | "forbidden_session"
  | "forbidden_operation";

const ERROR_TEXT: Record<TokenGuardErrorCode, string> = {
  missing_credential: "authentication required",
  malformed_credential: "malformed credential",
  invalid_credential: "invalid credential",
  expired_credential: "credential expired",
  forbidden_scope: "insufficient scope",
  forbidden_session: "session denied",
  forbidden_operation: "operation denied",
} as const;

const DEFAULT_COOKIE_NAME = "tmux_demo_t";
const DEFAULT_QUERY_PARAM = "t";
const DEFAULT_QUERY_COOKIE_SAFE = "<redacted>";
const SAFE_COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
  operation:
    | "ping"
    | "client_info"
    | "sessions_subscribe"
    | "sessions_unsubscribe"
    | "subscribe"
    | "unsubscribe"
    | "history_expand"
    | "resync"
    | "keys"
    | "resize";
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
  authorizeHttp(
    req: Request,
    principal: TokenPrincipal,
    context?: HttpAuthorizationContext,
  ): HttpAuthResult;

  /** Authorize one already-authenticated principal for one parsed WS message. */
  authorizeMuxMessage(message: unknown, principal: TokenPrincipal): MuxAuthResult;

  /** Token-free principal conversion for socket storage during WS upgrades. */
  createSocketPrincipal(grant: TokenGrant): TokenPrincipal;

  /** Convert any token-bearing principal into a token-free clone (defensive copy). */
  sanitizePrincipal(principal: TokenPrincipal): TokenPrincipal;

  /** Exact allow-list predicate for a session. */
  isSessionAllowed(principal: TokenPrincipal, session: string): boolean;

  /** Session list filtering that preserves order and never mutates input. */
  filterSessions<T>(
    sessions: readonly T[],
    principal: TokenPrincipal,
    nameOf?: (row: T) => string | null | undefined,
  ): readonly T[];

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

/** Internal grant snapshot — never exposed, never re-reads caller objects. */
type InternalGrant = {
  token: string;
  scope: TokenScope;
  expiresAt: number;
  sessions: readonly string[] | undefined;
  permissions: readonly TokenPermission[] | undefined;
  digest: Buffer;
  revoked: boolean;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(value: string, plusAsSpace = true): string | null {
  try {
    const normalized = plusAsSpace ? value.replace(/\+/g, "%20") : value;
    const decoded = decodeURIComponent(normalized);
    return decoded.includes("\r") || decoded.includes("\n") ? null : decoded;
  } catch {
    return null;
  }
}

function parseQueryPairs(search: string): Array<{ name: string; value: string }> | null {
  if (!search) return [];
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) return [];
  const segments = query.split("&");
  const pairs: Array<{ name: string; value: string }> = [];

  for (const segment of segments) {
    if (!segment) return null;
    const eq = segment.indexOf("=");
    if (eq < 0) return null;
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null) return null;
    if (!name) return null;
    pairs.push({ name, value });
  }

  return pairs;
}

function parseSingleQueryValue(search: string, expected: string): { value?: string; malformed: boolean } {
  const parsed = parseQueryPairs(search);
  if (parsed === null) return { malformed: true };

  const matches = parsed.filter((entry) => entry.name === expected);
  if (matches.length === 0) return { malformed: false };
  if (matches.length !== 1) return { malformed: true };
  return { value: matches[0]!.value, malformed: false };
}

function extractQueryCredential(
  search: string,
  tokenParam: string,
): { kind: "absent"; value?: undefined } | { kind: "invalid"; value?: undefined } | { kind: "valid"; value: string } {
  if (!search) return { kind: "absent" };

  const query = search.startsWith("?") ? search.slice(1) : search;
  const segments = query.split("&");

  let hasQueryToken = false;
  let tokenValue: string | undefined;
  let tokenCount = 0;
  let malformed = false;

  for (const segment of segments) {
    if (!segment) {
      malformed = true;
      continue;
    }

    const eq = segment.indexOf("=");
    if (eq < 0) {
      const rawName = segment;
      const name = safeDecode(rawName);
      if (name === null) {
        malformed = true;
        continue;
      }
      if (name === tokenParam) return { kind: "invalid" };
      continue;
    }

    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    const name = safeDecode(rawName);
    const value = safeDecode(rawValue);
    if (name === null || value === null || !name) {
      malformed = true;
      continue;
    }

    if (name === tokenParam) {
      hasQueryToken = true;
      tokenCount += 1;
      tokenValue = value;
    }
  }

  if (!hasQueryToken) return { kind: "absent" };
  if (malformed) return { kind: "invalid" };
  if (tokenCount !== 1 || tokenValue === "") return { kind: "invalid" };
  return { kind: "valid", value: tokenValue ?? "" };
}

function parseCookieHeader(
  header: string,
  cookieName: string,
): { kind: "absent"; value?: undefined } | { kind: "invalid"; value?: undefined } | { kind: "valid"; value: string } {
  if (!header) return { kind: "absent" };
  const segments = header.split(";");
  let matches = 0;
  let tokenValue: string | null = null;

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) return { kind: "invalid" };
    const eq = segment.indexOf("=");
    if (eq <= 0) return { kind: "invalid" };
    // Cookie names are compared raw (byte-exact); RFC 6265 names are never
    // percent-encoded, and SAFE_COOKIE_NAME allows '+', so decoding the name
    // would break round-trips for names like "tmux+demo".
    const rawName = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);

    // Name first: an unrelated cookie's encoding/syntax must never decide auth.
    // Only percent-decode / validate values of the configured cookie name.
    if (rawName !== cookieName) continue;

    const value = safeDecode(rawValue, false);
    if (value === null) return { kind: "invalid" };

    if (matches >= 1) return { kind: "invalid" };
    tokenValue = value;
    matches += 1;
  }

  if (matches === 0) return { kind: "absent" };
  return { kind: "valid", value: tokenValue! };
}

/** Content-equality for optional session allow-lists (order-sensitive). */
function sessionsEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * True only when the principal's surface fields still match the grant snapshot
 * it was minted from. Caller mutation of a non-frozen principal must not be
 * treated as a privilege change — it is a credential integrity failure.
 */
function principalMatchesGrant(principal: TokenPrincipal, grant: InternalGrant): boolean {
  return principal.scope === grant.scope
    && principal.expiresAt === grant.expiresAt
    && sessionsEqual(principal.sessions, grant.sessions);
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNonEmptySession(value: unknown): value is SessionName {
  return typeof value === "string" && value.length > 0;
}

function extractSession(row: unknown): string | null {
  if (typeof row === "string") return row;
  if (typeof row !== "object" || row === null) return null;
  const candidate = row as { name?: unknown };
  return typeof candidate.name === "string" ? candidate.name : null;
}

function isTokenScope(value: unknown): value is TokenScope {
  return value === "read" || value === "interactive";
}

function isTokenPermission(value: unknown): value is TokenPermission {
  return value === "sessions-kill";
}

function hasValidSessions(value: unknown): value is readonly string[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.every((session) => typeof session === "string" && session.length > 0));
}

function hasValidPermissions(value: unknown): value is readonly TokenPermission[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.every(isTokenPermission));
}

function isValidGrant(value: unknown): value is TokenGrant {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as TokenGrant;
  return typeof grant.token === "string"
    && grant.token.length > 0
    && !/[\r\n]/.test(grant.token)
    && isTokenScope(grant.scope)
    && Number.isFinite(grant.expiresAt)
    && hasValidSessions(grant.sessions)
    && hasValidPermissions(grant.permissions);
}

function isValidPrincipal(value: unknown): value is TokenPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const principal = value as TokenPrincipal;
  return isTokenScope(principal.scope)
    && Number.isFinite(principal.expiresAt)
    && hasValidSessions(principal.sessions);
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function createTokenGuard(options: TokenGuardOptions): TokenGuard {
  const grants = options.grants ?? [];
  const queryParamName = options.queryParamName || DEFAULT_QUERY_PARAM;
  const cookieName = options.cookieName || DEFAULT_COOKIE_NAME;
  const now = options.now ?? Date.now;
  const redactionPlaceholder = options.redactionPlaceholder ?? DEFAULT_QUERY_COOKIE_SAFE;

  if (!SAFE_COOKIE_NAME.test(cookieName) || !queryParamName || /[\r\n]/.test(queryParamName)) {
    throw new Error("token guard: invalid cookieName");
  }
  if (!Array.isArray(grants) || grants.some((grant) => !isValidGrant(grant))) {
    throw new Error("token guard: invalid grant configuration");
  }
  const configuredTokens = new Set(grants.map((grant) => grant.token));
  if (configuredTokens.size !== grants.length) {
    throw new Error("token guard: duplicate grant configuration");
  }

  // Snapshot each grant exactly once: read every property into a local, never
  // re-touch caller-owned objects after construction. Each snapshot is frozen;
  // `revoked` is an accessor backed by this map so freeze + revoke both work.
  const revokedState = new WeakMap<InternalGrant, boolean>();
  const snapshots: InternalGrant[] = [];
  for (const grant of grants) {
    const token = grant.token;
    const scope = grant.scope;
    const expiresAt = grant.expiresAt;
    const sessions = grant.sessions;
    const permissions = grant.permissions;
    const snapshot = {
      token,
      scope,
      expiresAt,
      sessions: sessions === undefined ? undefined : Object.freeze([...sessions]),
      permissions: permissions === undefined ? undefined : Object.freeze([...permissions]),
      digest: tokenDigest(token),
      get revoked(): boolean {
        return revokedState.get(this as InternalGrant) ?? false;
      },
      set revoked(value: boolean) {
        revokedState.set(this as InternalGrant, value);
      },
    } as InternalGrant;
    Object.freeze(snapshot);
    snapshots.push(snapshot);
  }
  // From here on, NOTHING reads options.grants / caller grants again.
  const redactionTokens = snapshots.map((s) => s.token);
  const issuedPrincipals = new WeakMap<TokenPrincipal, InternalGrant>();

  const shouldUseSecureCookie = (request: Request): boolean => {
    if (options.cookieSecure === undefined) {
      const xfp = request.headers.get("x-forwarded-proto");
      if (xfp && /\bhttps\b/i.test(xfp.split(",")[0]?.trim() ?? "")) return true;
      const protocol = new URL(request.url).protocol;
      return protocol === "https:";
    }
    if (typeof options.cookieSecure === "boolean") return options.cookieSecure;
    return options.cookieSecure(request);
  };

  /** Expiry is always evaluated against the grant snapshot, never caller fields. */
  const isExpiredGrant = (grant: InternalGrant): boolean => {
    const currentTime = now();
    return !Number.isFinite(currentTime)
      || !Number.isFinite(grant.expiresAt)
      || grant.expiresAt <= currentTime;
  };

  /**
   * Constant-time full scan over all snapshots by SHA-256 digest.
   * Ignores the revoked flag. No early exit — work is data-independent.
   */
  const locateGrant = (token: string): InternalGrant | undefined => {
    const candidate = tokenDigest(token);
    let hit: InternalGrant | undefined;
    for (const snapshot of snapshots) {
      // Both digests are always 32 bytes; timingSafeEqual never throws here.
      if (timingSafeEqual(candidate, snapshot.digest)) {
        hit = snapshot;
      }
    }
    return hit;
  };

  /** Like locateGrant, but returns undefined for a revoked grant. */
  const findGrantByToken = (token: string): InternalGrant | undefined => {
    const grant = locateGrant(token);
    if (!grant || grant.revoked) return undefined;
    return grant;
  };

  /**
   * Mint a frozen, token-free principal bound to an InternalGrant.
   * Every authorization decision for the returned object re-reads the grant.
   */
  const mintPrincipal = (grant: InternalGrant): TokenPrincipal => {
    const principal: TokenPrincipal = Object.freeze({
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      // Reuse the already-frozen grant sessions array (no alias to caller input).
      sessions: grant.sessions,
    });
    issuedPrincipals.set(principal, grant);
    return principal;
  };

  const resolveActiveGrant = (principal: TokenPrincipal): InternalGrant | undefined => {
    if (!isValidPrincipal(principal)) return undefined;
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined) return undefined;
    // Reject surface fields that disagree with the grant rather than honouring them.
    if (!principalMatchesGrant(principal, grant)) return undefined;
    if (grant.revoked) return undefined;
    return grant;
  };

  const isSessionAllowed = (principal: TokenPrincipal, session: string): boolean => {
    // Non-string / empty session names are denied (hosts pass JSON-parsed names).
    if (typeof session !== "string" || session.length === 0) return false;
    const grant = resolveActiveGrant(principal);
    if (grant === undefined || isExpiredGrant(grant)) return false;
    if (grant.sessions === undefined) return true;
    if (grant.sessions.length === 0) return false;
    return grant.sessions.includes(session);
  };

  const hasPermission = (principal: TokenPrincipal, permission: TokenPermission): boolean =>
    resolveActiveGrant(principal)?.permissions?.includes(permission) === true;

  const sanitizePrincipal = (principal: TokenPrincipal): TokenPrincipal => {
    // Integrity first: unknown / mismatched / revoked principals throw.
    // A successful sanitize always re-derives from the grant snapshot.
    const grant = issuedPrincipals.get(principal);
    if (
      !isValidPrincipal(principal)
      || grant === undefined
      || grant.revoked
      || !principalMatchesGrant(principal, grant)
    ) {
      throw new Error("token guard: invalid principal");
    }
    // Fresh frozen principal from the grant (never copies caller-held fields).
    return mintPrincipal(grant);
  };

  const createSocketPrincipal = (grant: TokenGrant): TokenPrincipal => {
    // Accept a caller TokenGrant only as a locator key; use the SNAPSHOT's
    // scope/expiry/sessions/permissions/token — never caller-mutated fields.
    const configuredGrant = isValidGrant(grant)
      ? findGrantByToken(grant.token)
      : undefined;
    if (!configuredGrant) {
      throw new Error("token guard: invalid configured grant");
    }
    return mintPrincipal(configuredGrant);
  };

  const makeCookieHeader = (grant: TokenGrant, req: Request): string => {
    // Locate snapshot by token; use snapshot fields only (never caller fields).
    // findGrantByToken is revocation-aware: a revoked token must not mint a cookie.
    const snapshot = isValidGrant(grant) ? findGrantByToken(grant.token) : undefined;
    if (!snapshot) {
      throw new Error("token guard: invalid token value for cookie encoding");
    }

    const encoded = encodeURIComponent(snapshot.token);
    const remainingMs = snapshot.expiresAt - now();
    const maxAgeSeconds = Number.isFinite(remainingMs)
      ? Math.max(0, Math.floor(remainingMs / 1000))
      : 0;
    let cookie = `${cookieName}=${encoded}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
    if (shouldUseSecureCookie(req)) cookie += "; Secure";
    if (/\r|\n/.test(cookie)) {
      throw new Error("token guard: refused unsafe cookie header generation");
    }
    return cookie;
  };

  const redact = (text: string): string => {
    if (!text) return text;
    let output = text;
    const genericQueryCredential = new RegExp(
      `(^|[?&])${escapeRegex(queryParamName)}=[^&#\\s]*`,
      "gi",
    );
    const genericCookieCredential = new RegExp(
      `(^|[;,\\s])(${escapeRegex(cookieName)}\\s*=\\s*)[^;\\s]*`,
      "gi",
    );
    output = output.replace(genericQueryCredential, `$1${redactionPlaceholder}`);
    output = output.replace(genericCookieCredential, `$1$2${redactionPlaceholder}`);

    // Redact every configured token, including revoked ones.
    for (const token of redactionTokens) {
      const encoded = encodeURIComponent(token);
      output = output.replaceAll(token, redactionPlaceholder);
      output = output.replaceAll(encoded, redactionPlaceholder);
    }
    return output;
  };

  const fail401 = (code: Exclude<TokenGuardErrorCode, "forbidden_scope" | "forbidden_session" | "forbidden_operation">): TokenAuthFailure => ({
    ok: false,
    status: 401,
    code,
    message: ERROR_TEXT[code],
  });

  const fail403 = (code: "forbidden_scope" | "forbidden_session" | "forbidden_operation"): TokenAuthFailure => ({
    ok: false,
    status: 403,
    code,
    message: ERROR_TEXT[code],
  });

  const guardAuthenticateFailure = (
    request: Request,
    source: "query" | "cookie",
    result: { kind: "absent" } | { kind: "invalid" } | { kind: "expired" } | { kind: "not-found" },
  ): TokenAuthFailure => {
    switch (result.kind) {
      case "absent":
        return fail401(source === "query" ? "missing_credential" : "missing_credential");
      case "invalid":
        return fail401(source === "query" ? "malformed_credential" : "malformed_credential");
      case "not-found":
        return fail401(source === "query" ? "invalid_credential" : "invalid_credential");
      case "expired":
        return fail401("expired_credential");
      default:
        return fail401("missing_credential");
    }
  };

  const authenticate = (request: Request): TokenAuthResult => {
    const token = extractQueryCredential(new URL(request.url).search, queryParamName);

    if (token.kind === "valid") {
      // findGrantByToken returns undefined for unknown OR revoked → same 401 oracle.
      const grant = findGrantByToken(token.value);
      if (!grant) return guardAuthenticateFailure(request, "query", { kind: "not-found" });
      if (isExpiredGrant(grant)) {
        return guardAuthenticateFailure(request, "query", { kind: "expired" });
      }

      return {
        ok: true,
        status: 200,
        source: "query",
        principal: mintPrincipal(grant),
        setCookie: makeCookieHeader(grant, request),
      };
    }

    if (token.kind === "invalid") {
      return guardAuthenticateFailure(request, "query", { kind: "invalid" });
    }

    const cookie = parseCookieHeader(request.headers.get("cookie") ?? "", cookieName);
    if (cookie.kind === "absent") {
      return guardAuthenticateFailure(request, "cookie", { kind: "absent" });
    }
    if (cookie.kind === "invalid") {
      return guardAuthenticateFailure(request, "cookie", { kind: "invalid" });
    }

    const grant = findGrantByToken(cookie.value);
    if (!grant) {
      return guardAuthenticateFailure(request, "cookie", { kind: "not-found" });
    }
    if (isExpiredGrant(grant)) {
      return guardAuthenticateFailure(request, "cookie", { kind: "expired" });
    }

    return {
      ok: true,
      status: 200,
      source: "cookie",
      principal: mintPrincipal(grant),
    };
  };

  const ensureActivePrincipal = (principal: TokenPrincipal): TokenAuthFailure | null => {
    // Unknown / mismatched surface / revoked → invalid_credential (revocation
    // before expiry so revoked+expired is still invalid_credential).
    if (!isValidPrincipal(principal)) return fail401("invalid_credential");
    const grant = issuedPrincipals.get(principal);
    if (grant === undefined || !principalMatchesGrant(principal, grant)) {
      return fail401("invalid_credential");
    }
    if (grant.revoked) return fail401("invalid_credential");
    if (isExpiredGrant(grant)) return fail401("expired_credential");
    return null;
  };

  const revoke = (token: string): boolean => {
    // Public method must deny malformed input, not throw out of crypto.
    if (typeof token !== "string" || token.length === 0) return false;
    const grant = locateGrant(token);
    if (!grant || grant.revoked) return false;
    grant.revoked = true;
    return true;
  };

  const authorizeHttp = (
    request: Request,
    principal: TokenPrincipal,
    context: HttpAuthorizationContext = {},
  ): HttpAuthResult => {
    const expired = ensureActivePrincipal(principal);
    if (expired) return expired;
    const safePrincipal = sanitizePrincipal(principal);
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const path = url.pathname;
    let operation = context.operation;
    let inferredSession: string | undefined;
    let inferredRecordingId: string | undefined;

    if (operation === undefined) {
      if (method === "GET" && (path === "/ws" || path.startsWith("/ws/"))) {
        operation = "ws-upgrade";
      } else if (!path.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") return fail403("forbidden_operation");
        operation = "static";
      } else if (method === "GET" && (path === "/api/auth" || path === "/api/auth/description")) {
        operation = "auth-description";
      } else if (method === "GET" && path === "/api/sessions") {
        operation = "sessions-list";
      } else if (method === "POST" && (path === "/api/spawn" || path === "/api/sessions")) {
        operation = "sessions-spawn";
      } else if (method === "GET" && path === "/api/prefs") {
        operation = "prefs-read";
      } else if ((method === "PUT" || method === "POST") && path === "/api/prefs") {
        operation = "prefs-write";
      } else if (method === "POST" && (path === "/api/upload" || path === "/api/uploads")) {
        operation = "upload";
      } else if (method === "GET" && path === "/api/recordings") {
        operation = "recordings-list";
      } else if (method === "POST" && path === "/api/recordings/start") {
        operation = "recording-start";
      } else if (method === "POST" && path === "/api/recordings/stop") {
        operation = "recording-stop";
      } else {
        const lifecycle = /^\/api\/sessions\/([^/]+)\/recording\/(start|stop)$/.exec(path);
        const download = /^\/api\/recordings\/([^/]+)\/download$/.exec(path);
        if (method === "POST" && lifecycle) {
          inferredSession = decodePathSegment(lifecycle[1] ?? "") ?? undefined;
          operation = lifecycle[2] === "start" ? "recording-start" : "recording-stop";
        } else if (method === "GET" && download) {
          inferredRecordingId = decodePathSegment(download[1] ?? "") ?? undefined;
          operation = "recordings-download";
        } else {
          return fail403("forbidden_operation");
        }
      }
    }

    if (
      operation === "static"
      || operation === "auth-description"
      || operation === "ws-upgrade"
      || operation === "sessions-list"
      || operation === "prefs-read"
    ) {
      return { ok: true, status: 200, operation };
    }

    if (operation === "sessions-spawn") {
      if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
      if (safePrincipal.sessions !== undefined) return fail403("forbidden_scope");
      return { ok: true, status: 200, operation };
    }

    if (operation === "sessions-kill") {
      if (!isNonEmptySession(context.session)) return fail403("forbidden_operation");
      if (
        safePrincipal.scope !== "interactive"
        || !hasPermission(safePrincipal, "sessions-kill")
      ) {
        return fail403("forbidden_scope");
      }
      if (!isSessionAllowed(safePrincipal, context.session)) return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session: context.session };
    }

    if (operation === "prefs-write") {
      if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
      return { ok: true, status: 200, operation };
    }

    if (operation === "upload") {
      if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
      if (context.session !== undefined) {
        if (!isNonEmptySession(context.session)) return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, context.session)) return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "upload", session: context.session };
      }
      return { ok: true, status: 200, operation: "upload" };
    }

    if (operation === "recordings-list") {
      const parsed = parseSingleQueryValue(url.search, "session");
      if (parsed.malformed) return fail403("forbidden_operation");
      if (
        context.session !== undefined
        && parsed.value !== undefined
        && context.session !== parsed.value
      ) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? parsed.value;
      if (!isNonEmptySession(session)) return fail403("forbidden_operation");
      if (!isSessionAllowed(safePrincipal, session)) return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }

    if (operation === "recording-start" || operation === "recording-stop") {
      if (
        context.session !== undefined
        && inferredSession !== undefined
        && context.session !== inferredSession
      ) {
        return fail403("forbidden_operation");
      }
      const session = context.session ?? inferredSession;
      if (!isNonEmptySession(session)) return fail403("forbidden_operation");
      if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
      if (!isSessionAllowed(safePrincipal, session)) return fail403("forbidden_session");
      return { ok: true, status: 200, operation, session };
    }

    if (operation === "recordings-download") {
      // 1. Cross-check context.recordingId against path-derived id.
      if (
        context.recordingId !== undefined
        && inferredRecordingId !== undefined
        && context.recordingId !== inferredRecordingId
      ) {
        return fail403("forbidden_operation");
      }
      // 2. Resolve recordingId.
      const recordingId = context.recordingId ?? inferredRecordingId;
      if (!isNonEmptySession(recordingId)) return fail403("forbidden_operation");

      // 3. ALWAYS call the resolver when present; fail closed on throw/bad return.
      let resolved: string | undefined;
      if (options.recordingSessionResolver) {
        try {
          const raw = options.recordingSessionResolver(recordingId);
          resolved = typeof raw === "string" && raw.length > 0 ? raw : undefined;
        } catch {
          return fail403("forbidden_operation");
        }
      }

      // 4. Cross-check context.session against resolved session.
      if (
        context.session !== undefined
        && resolved !== undefined
        && context.session !== resolved
      ) {
        return fail403("forbidden_operation");
      }

      // 5. Prefer resolver result over caller hint.
      const session = resolved ?? context.session;

      // 6. Restricted principals must have a non-empty allowed session.
      if (safePrincipal.sessions !== undefined) {
        if (!isNonEmptySession(session) || !isSessionAllowed(safePrincipal, session)) {
          return fail403("forbidden_session");
        }
      }

      // 7. Success.
      return { ok: true, status: 200, operation, session: session ?? recordingId };
    }

    return fail403("forbidden_operation");
  };

  const authorizeMuxMessage = (message: unknown, principal: TokenPrincipal): MuxAuthResult => {
    const expired = ensureActivePrincipal(principal);
    if (expired) return expired;
    const safePrincipal = sanitizePrincipal(principal);

    const raw = message as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || typeof raw.type !== "string") {
      return fail403("forbidden_operation");
    }

    const type = raw.type;
    switch (type) {
      case "ping":
      case "client_info":
      case "sessions_subscribe":
      case "sessions_unsubscribe":
        return {
          ok: true,
          status: 200,
          operation: type,
        };

      case "subscribe":
      case "unsubscribe":
      case "history_expand":
      case "resync": {
        const session = raw.session;
        if (!isNonEmptySession(session)) return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session)) return fail403("forbidden_session");
        return { ok: true, status: 200, operation: type, session };
      }

      case "keys": {
        if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
        const session = raw.session;
        const data = raw.data;
        if (!isNonEmptySession(session) || typeof data !== "string") return fail403("forbidden_operation");
        if (!isSessionAllowed(safePrincipal, session)) return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "keys", session };
      }

      case "resize": {
        if (safePrincipal.scope !== "interactive") return fail403("forbidden_scope");
        const session = raw.session;
        const cols = (raw as { cols?: unknown }).cols;
        const rows = (raw as { rows?: unknown }).rows;
        if (
          !isNonEmptySession(session)
          || !isInteger(cols)
          || !isInteger(rows)
          || cols <= 0
          || rows <= 0
        ) {
          return fail403("forbidden_operation");
        }
        if (!isSessionAllowed(safePrincipal, session)) return fail403("forbidden_session");
        return { ok: true, status: 200, operation: "resize", session };
      }

      default:
        return fail403("forbidden_operation");
    }
  };

  const filterSessions = <T>(
    sessions: readonly T[],
    principal: TokenPrincipal,
    nameOf: (row: T) => string | null | undefined = extractSession,
  ): readonly T[] => {
    if (ensureActivePrincipal(principal)) return [];
    const safePrincipal = sanitizePrincipal(principal);
    if (safePrincipal.sessions === undefined) return [...sessions];
    if (safePrincipal.sessions.length === 0) return [];

    const allow = new Set(safePrincipal.sessions);
    return sessions.filter((item) => {
      const name = nameOf(item);
      return typeof name === "string" && allow.has(name);
    });
  };

  const wrapped: TokenGuard = {
    options: {
      queryParamName,
      cookieName,
      redactionPlaceholder,
    },
    authenticate,
    authorizeHttp,
    authorizeMuxMessage: (message, principal) => authorizeMuxMessage(message, principal),
    createSocketPrincipal,
    sanitizePrincipal,
    isSessionAllowed,
    filterSessions: <T>(
      sessions: readonly T[],
      principal: TokenPrincipal,
      nameOf?: (row: T) => string | null | undefined,
    ): readonly T[] => filterSessions(sessions, principal, nameOf),
    makeCookieHeader: (grant, req) => makeCookieHeader(grant, req),
    redact: (text) => redact(text),
    revoke,
  };

  return wrapped;
}
