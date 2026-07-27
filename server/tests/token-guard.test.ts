import { describe, expect, test } from "bun:test";
import { createTokenGuard, type TokenGrant } from "../src/token-guard";

interface MutableClock {
  now: () => number;
  set: (next: number) => void;
}

function withMutableClock(initial: number): MutableClock {
  let current = initial;
  return {
    now: () => current,
    set: (next: number) => {
      current = next;
    },
  };
}

function makeGrant(scope: "read" | "interactive", token: string, expiresAt: number, sessions?: readonly string[]): TokenGrant {
  const grant: TokenGrant = { token, scope, expiresAt };
  if (sessions !== undefined) grant.sessions = sessions;
  return grant;
}

function authenticateQuery(guard: ReturnType<typeof createTokenGuard>, token: string, path = "http://x/") {
  const url = new URL(path);
  url.searchParams.set("t", token);
  return guard.authenticate(new Request(url.toString()));
}

function authenticateCookie(guard: ReturnType<typeof createTokenGuard>, cookie: string) {
  return guard.authenticate(new Request("http://x/", { headers: { cookie } }));
}

function principalFromAuthentication(result: ReturnType<ReturnType<typeof createTokenGuard>["authenticate"]>) {
  if (!result.ok) {
    throw new Error(`authentication unexpectedly failed with ${result.status}: ${result.code}`);
  }
  return result.principal;
}

const defaultNow = () => 1000;
const createTokenGuardWithClock = (
  init: Omit<Parameters<typeof createTokenGuard>[0], "now">,
) => createTokenGuard({ now: defaultNow, ...init });

const cookieHeader = (name = "tmux_demo_t", token: string) => `${name}=${encodeURIComponent(token)}`;

describe("createTokenGuard query and cookie bootstrap", () => {
  test("exact query token authenticates and returns token-free principal with bootstrap cookie", () => {
    const clock = withMutableClock(1000);
    const guard = createTokenGuardWithClock({
      now: clock.now,
      grants: [makeGrant("read", "read-query-token", 2000)],
    });

    const result = authenticateQuery(guard, "read-query-token", "https://x/path?foo=bar");

    expect(result).toMatchObject({ ok: true, status: 200, source: "query" });
    const principal = principalFromAuthentication(result);
    expect(principal.scope).toBe("read");
    expect(principal.expiresAt).toBe(2000);
    expect("token" in principal).toBe(false);
    expect(result.setCookie).toBeDefined();
    expect(result.setCookie).toMatch(/^tmux_demo_t=/);
    expect(result.setCookie).toContain("Path=/");
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");
    expect(result.setCookie).not.toContain("Domain=");
    expect(result.setCookie).toContain("Secure");
  });

  const malformedQueryCases = [
    {name: "duplicate t", path: "https://x/?t=read-query-token&t=read-query-token", expected: "malformed_credential"},
    {name: "empty t", path: "https://x/?t=", expected: "malformed_credential"},
    {name: "malformed percent encoding", path: "https://x/?t=%ZZ"},
    {name: "prefix t", path: "https://x/?t=prefix-read-query-token", expected: "invalid_credential"},
    {name: "suffix t", path: "https://x/?t=read-query-token-suffix", expected: "invalid_credential"},
    {name: "unknown t", path: "https://x/?t=unknown-read-query-token", expected: "invalid_credential"},
  ];

  for (const { name, path, expected } of malformedQueryCases) {
    test(`query ${name} is rejected with 401`, () => {
      const guard = createTokenGuardWithClock({
        grants: [makeGrant("read", "read-query-token", 5000)],
      });
      const result = guard.authenticate(new Request(path));
      expect(result).toMatchObject({ ok: false, status: 401, ...(expected ? { code: expected } : {}) });
    });
  }

  test("invalid explicit t never falls back to a valid cookie", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("read", "read-query-token", 5000),
        makeGrant("read", "read-cookie-token", 5000),
      ],
    });

    const result = guard.authenticate(new Request("https://x/?t=read-query-token&t=read-query-token", {
      headers: {
        cookie: cookieHeader("tmux_demo_t", "read-cookie-token"),
      },
    }));

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  test("cookie bootstrap accepts exact encoded and exact decoded values", () => {
    const token = "cookie-value+plus/segment";
    const encoded = encodeURIComponent(token);
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", token, 5000)],
    });

    const encodedResult = authenticateCookie(guard, `tmux_demo_t=${encoded}`);
    expect(encodedResult).toMatchObject({ ok: true, status: 200, source: "cookie" });
    expect(principalFromAuthentication(encodedResult).scope).toBe("interactive");

    const decodedResult = authenticateCookie(guard, `tmux_demo_t=${token}`);
    expect(decodedResult).toMatchObject({ ok: true, status: 200, source: "cookie" });
    expect(principalFromAuthentication(decodedResult).scope).toBe("interactive");
  });

  const invalidCookieCases = [
    {name: "similar cookie names", header: "x_tmux_demo_t=read-query-token; tmux_demo_t_extra=read-query-token", expected: "missing_credential"},
    {name: "duplicate exact cookie names", header: "tmux_demo_t=read-query-token; tmux_demo_t=read-query-token", expected: "malformed_credential"},
    {name: "malformed encoding", header: "tmux_demo_t=%E0%A", expected: "malformed_credential"},
    {name: "unknown cookie value", header: "tmux_demo_t=not-configured", expected: "invalid_credential"},
    {name: "cookie prefix", header: `tmux_demo_t=${encodeURIComponent("read-query-token")}-x`, expected: "invalid_credential"},
    {name: "cookie suffix", header: `tmux_demo_t=x-${encodeURIComponent("read-query-token")}`, expected: "invalid_credential"},
  ];

  for (const { name, header, expected } of invalidCookieCases) {
    test(`${name} is rejected with 401`, () => {
      const guard = createTokenGuardWithClock({
        grants: [makeGrant("read", "read-query-token", 5000)],
      });
      const result = authenticateCookie(guard, header);
      expect(result).toMatchObject({ ok: false, status: 401, code: expected });
    });
  }

  test("missing credentials are 401", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "read-query-token", 5000)],
    });

    const noQuery = guard.authenticate(new Request("https://x/path"));
    expect(noQuery).toMatchObject({ ok: false, status: 401, code: "missing_credential" });
    const malformedCookie = authenticateCookie(guard, "");
    expect(malformedCookie).toMatchObject({ ok: false, status: 401, code: "missing_credential" });
  });

  test("cookie header includes secure flags only on secure requests", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "read-query-token", 5000)],
    });

    const insecure = authenticateQuery(guard, "read-query-token", "http://x/");
    expect(principalFromAuthentication(insecure).scope).toBe("read");
    expect(insecure.setCookie).toContain("Path=/");
    expect(insecure.setCookie).toContain("HttpOnly");
    expect(insecure.setCookie).toContain("SameSite=Strict");
    expect(insecure.setCookie).not.toContain("Secure");

    const secure = createTokenGuardWithClock({
      grants: [makeGrant("read", "secure-token", 5000)],
    }).authenticate(new Request("https://x/?t=secure-token"));
    expect(principalFromAuthentication(secure).scope).toBe("read");
    expect(secure.setCookie).toContain("Secure");

    const configuredSecure = createTokenGuardWithClock({
      cookieSecure: true,
      grants: [makeGrant("read", "configured-secure-token", 5000)],
    }).authenticate(new Request("http://x/?t=configured-secure-token"));
    expect(principalFromAuthentication(configuredSecure).scope).toBe("read");
    expect(configuredSecure.setCookie).toContain("Secure");
  });

  test("invalid/unsafe grant configuration is rejected up-front", () => {
    expect(() =>
      createTokenGuardWithClock({
        grants: [
          makeGrant("read", "dup", 5000),
          makeGrant("interactive", "dup", 5000),
        ],
      }),
    ).toThrow("duplicate grant configuration");

    expect(() =>
      createTokenGuardWithClock({
        grants: [
          // @ts-ignore invalid token content is intentionally unsafe for this rejection path
          { token: "bad\rtoken", scope: "read", expiresAt: 5000 },
        ],
      }),
    ).toThrow("invalid grant configuration");
  });
});

describe("createTokenGuard token hygiene", () => {
  test("authorization and error messages do not leak token text", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "safe-token", 5000)],
    });

    const ok = authenticateQuery(guard, "safe-token");
    expect(ok).toMatchObject({ ok: true, status: 200 });
    expect((ok as any).principal.token).toBeUndefined();

    const unknown = guard.authenticate(new Request("https://x/?t=evil-token"));
    expect(unknown).toMatchObject({ ok: false, status: 401, code: "invalid_credential" });
    expect(unknown.message.includes("evil-token")).toBe(false);

    const cookie = authenticateCookie(guard, cookieHeader("tmux_demo_t", "evil-token"));
    expect(cookie).toMatchObject({ ok: false, status: 401, code: "invalid_credential" });
    expect(cookie.message.includes("evil-token")).toBe(false);
    expect(cookie.message.includes("safe-token")).toBe(false);
  });

  test("redact covers configured tokens, encoded variants, and generic credentials", () => {
    const guard = createTokenGuardWithClock({
      redactionPlaceholder: "[redacted]",
      grants: [makeGrant("read", "redacted-token", 5000)],
    });

    const plain = "GET /api?name=alpha&t=redacted-token";
    const encoded = `GET /api?name=alpha&t=${encodeURIComponent("redacted-token")}`;
    const cookie = `cookie: tmux_demo_t=${encodeURIComponent("redacted-token")}; Path=/`;
    const unknown = "GET /api?name=alpha&t=unknown-token";
    const unknownCookie = "cookie: tmux_demo_t=unknown-token";

    expect(guard.redact(plain)).toContain("[redacted]");
    expect(guard.redact(encoded)).toContain("[redacted]");
    expect(guard.redact(cookie)).toContain("[redacted]");
    expect(guard.redact(encoded)).not.toContain("redacted-token");
    expect(guard.redact(unknown)).toContain("[redacted]");
    expect(guard.redact(unknown)).not.toContain("unknown-token");
    expect(guard.redact(unknownCookie)).toContain("[redacted]");
    expect(guard.redact(unknownCookie)).not.toContain("unknown-token");
  });
});

describe("createTokenGuard status and expiry", () => {
  test("401 for invalid/expired auth and 403 for denied-but-valid authorization", () => {
    const expiredGuard = createTokenGuardWithClock({
      now: () => 100,
      grants: [makeGrant("read", "expired-token", 50)],
    });
    const expiredAuth = authenticateQuery(expiredGuard, "expired-token");
    expect(expiredAuth).toMatchObject({ ok: false, status: 401, code: "expired_credential" });

    const missing = expiredGuard.authenticate(new Request("https://x/") );
    expect(missing).toMatchObject({ ok: false, status: 401, code: "missing_credential" });

    const readGuard = createTokenGuardWithClock({
      grants: [makeGrant("read", "read-token", 5000)],
    });
    const readAuth = principalFromAuthentication(authenticateQuery(readGuard, "read-token"));
    expect(readGuard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), readAuth).status).toBe(403);
  });

  test("expiry at exact boundary is treated as expired", () => {
    const clock = withMutableClock(1000);
    const guard = createTokenGuardWithClock({
      now: clock.now,
      grants: [makeGrant("read", "boundary-token", 1000)],
    });

    const boundary = authenticateQuery(guard, "boundary-token");
    expect(boundary).toMatchObject({ ok: false, status: 401, code: "expired_credential" });

    clock.set(999);
    const stillValid = authenticateQuery(guard, "boundary-token");
    expect(stillValid).toMatchObject({ ok: true, status: 200 });
  });

  test("post-upgrade/authentication expiry makes all WS decisions 401", () => {
    const clock = withMutableClock(100);
    const guard = createTokenGuardWithClock({
      now: clock.now,
      grants: [makeGrant("interactive", "ws-expire-token", 150)],
    });

    const principal = principalFromAuthentication(authenticateQuery(guard, "ws-expire-token"));

    expect(guard.authorizeMuxMessage({ type: "ping" }, principal)).toMatchObject({ ok: true, status: 200, operation: "ping" });
    expect(guard.authorizeMuxMessage({ type: "keys", session: "terminal", data: "x" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "keys",
      session: "terminal",
    });

    clock.set(200);
    expect(guard.authorizeMuxMessage({ type: "ping" }, principal)).toMatchObject({ ok: false, status: 401 });
    expect(guard.authorizeMuxMessage({ type: "resync", session: "terminal" }, principal)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  test("only a guard-issued principal can make authorization decisions", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "issued-principal-token", 5000)],
    });

    const forged = { scope: "interactive" as const, expiresAt: 5000 };
    expect(guard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), forged)).toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_credential",
    });
    expect(guard.authorizeMuxMessage({ type: "ping" }, forged)).toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_credential",
    });
  });
});

describe("HTTP matrix with body/path context", () => {
  test("read permits static/auth-description/sessions-list and allowed recordings-list", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("read", "read-allow", 5000),
        makeGrant("read", "read-session-restricted", 5000, ["allowed-session"]),
      ],
    });
    const unrestricted = principalFromAuthentication(authenticateQuery(guard, "read-allow"));
    const restricted = principalFromAuthentication(authenticateQuery(guard, "read-session-restricted"));

    expect(guard.authorizeHttp(new Request("https://x/"), unrestricted)).toMatchObject({ ok: true, status: 200, operation: "static" });
    expect(guard.authorizeHttp(new Request("https://x/api/auth"), unrestricted)).toMatchObject({
      ok: true,
      status: 200,
      operation: "auth-description",
    });
    expect(guard.authorizeHttp(new Request("https://x/api/sessions"), unrestricted)).toMatchObject({
      ok: true,
      status: 200,
      operation: "sessions-list",
    });

    expect(guard.authorizeHttp(new Request("https://x/api/recordings?session=allowed-session"), restricted)).toMatchObject({
      ok: true,
      status: 200,
      operation: "recordings-list",
      session: "allowed-session",
    });
  });

  test("read cannot spawn, upload, or start/stop recordings", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "read-allow", 5000)],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "read-allow"));

    expect(guard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(guard.authorizeHttp(new Request("https://x/api/upload", { method: "POST" }), principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(
      guard.authorizeHttp(
        new Request("https://x/api/recordings/start", { method: "POST" }),
        principal,
        { session: "allowed-session" },
      ),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_scope" });
  });

  test("interactive unrestricted permits spawn, upload, and start/stop with parsed body session context", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", "inter-raw", 5000)],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "inter-raw"));

    expect(guard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "sessions-spawn",
    });
    expect(guard.authorizeHttp(new Request("https://x/api/upload", { method: "POST" }), principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "upload",
    });
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/start", { method: "POST" }), principal, { session: "body-session" }),
    ).toMatchObject({ ok: true, status: 200, operation: "recording-start", session: "body-session" });
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/stop", { method: "POST" }), principal, { session: "body-session" }),
    ).toMatchObject({ ok: true, status: 200, operation: "recording-stop", session: "body-session" });
  });

  test("interactive with session restrictions cannot spawn and only acts on allowed sessions", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", "inter-restricted", 5000, ["allowed-session"])],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "inter-restricted"));

    expect(guard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });

    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/start", { method: "POST" }), principal, { session: "allowed-session" }),
    ).toMatchObject({ ok: true, status: 200, operation: "recording-start", session: "allowed-session" });
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/stop", { method: "POST" }), principal, { session: "allowed-session" }),
    ).toMatchObject({ ok: true, status: 200, operation: "recording-stop", session: "allowed-session" });
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings?session=allowed-session"), principal),
    ).toMatchObject({ ok: true, status: 200, operation: "recordings-list", session: "allowed-session" });

    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/start", { method: "POST" }), principal, { session: "denied-session" }),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_session" });
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings?session=denied-session"), principal),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_session" });
  });

  test("missing, mismatched, duplicate session selections and invalid route forms are 403", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("interactive", "inter-route", 5000),
        makeGrant("read", "read-route", 5000),
      ],
    });
    const interactive = principalFromAuthentication(authenticateQuery(guard, "inter-route"));
    const read = principalFromAuthentication(authenticateQuery(guard, "read-route"));

    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings"), read),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });

    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings?session=allowed&session=disallowed"), interactive),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });

    expect(
      guard.authorizeHttp(new Request("https://x/api/sessions/alpha/recording/start", { method: "POST" }), interactive, { session: "beta" }),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });

    expect(
      guard.authorizeHttp(new Request("https://x/api/sessions", { method: "HEAD" }), read),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });

    expect(
      guard.authorizeHttp(new Request("https://x/api/sessions/alpha/recording/start", { method: "POST" }), interactive, { session: undefined }),
    ).toMatchObject({ ok: true, status: 200, operation: "recording-start", session: "alpha" });

    expect(guard.authorizeHttp(new Request("https://x/api/spawn"), interactive)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
    expect(guard.authorizeHttp(new Request("https://x/api/does-not-exist"), interactive)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
  });
});

describe("WebSocket message matrix", () => {
  test("read allows ping and session list/selection operations for allowed sessions", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "ws-read", 5000)],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "ws-read"));

    expect(guard.authorizeMuxMessage({ type: "ping" }, principal)).toMatchObject({ ok: true, status: 200, operation: "ping" });
    expect(guard.authorizeMuxMessage({ type: "client_info", client: { id: "x" } }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "client_info",
    });
    expect(guard.authorizeMuxMessage({ type: "sessions_subscribe" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "sessions_subscribe",
    });
    expect(guard.authorizeMuxMessage({ type: "sessions_unsubscribe" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "sessions_unsubscribe",
    });
    expect(guard.authorizeMuxMessage({ type: "subscribe", session: "sess-allowed" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "subscribe",
      session: "sess-allowed",
    });
    expect(guard.authorizeMuxMessage({ type: "unsubscribe", session: "sess-allowed" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "unsubscribe",
      session: "sess-allowed",
    });
    expect(guard.authorizeMuxMessage({ type: "history_expand", session: "sess-allowed", beforeLine: 10, limit: 3 }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "history_expand",
      session: "sess-allowed",
    });
    expect(guard.authorizeMuxMessage({ type: "resync", session: "sess-allowed" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "resync",
      session: "sess-allowed",
    });
  });

  test("read does not allow keys/resize", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "ws-read", 5000)],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "ws-read"));

    expect(guard.authorizeMuxMessage({ type: "keys", session: "sess-allowed", data: "hello" }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(guard.authorizeMuxMessage({ type: "resize", session: "sess-allowed", cols: 80, rows: 24 }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
  });

  test("interactive allows keys and resize for allowed sessions", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", "ws-inter", 5000, ["sess-allowed"])],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "ws-inter"));

    expect(guard.authorizeMuxMessage({ type: "keys", session: "sess-allowed", data: "ls -la" }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "keys",
      session: "sess-allowed",
    });
    expect(guard.authorizeMuxMessage({ type: "resize", session: "sess-allowed", cols: 120, rows: 40 }, principal)).toMatchObject({
      ok: true,
      status: 200,
      operation: "resize",
      session: "sess-allowed",
    });
  });

  test("session-bearing WS operations reject missing/denied sessions and malformed payloads", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", "ws-restricted", 5000, ["allowed"])],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "ws-restricted"));

    expect(guard.authorizeMuxMessage({ type: "subscribe" }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
    expect(guard.authorizeMuxMessage({ type: "subscribe", session: "denied" }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_session",
    });
    expect(guard.authorizeMuxMessage({ type: "keys", session: "denied", data: "x" }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_session",
    });
    expect(guard.authorizeMuxMessage({ type: "resize", session: "allowed", cols: 0, rows: 12 }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
    expect(guard.authorizeMuxMessage({ type: "keys", session: "allowed", data: 10 }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
    expect(guard.authorizeMuxMessage(null, principal)).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });
    expect(guard.authorizeMuxMessage({ type: "noop" }, principal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_operation",
    });
  });
});

describe("allowlists and session filtering", () => {
  test("omitted sessions is unrestricted; exact empty list denies all", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("interactive", "sessions-none", 5000, []),
        makeGrant("read", "sessions-all", 5000),
      ],
    });

    const restricted = principalFromAuthentication(authenticateQuery(guard, "sessions-none"));
    const unrestricted = principalFromAuthentication(authenticateQuery(guard, "sessions-all"));

    expect(guard.isSessionAllowed(unrestricted, "any-session")).toBe(true);
    expect(guard.isSessionAllowed(restricted, "any-session")).toBe(false);

    expect(guard.filterSessions(["any-session", "another"], unrestricted)).toEqual(["any-session", "another"]);
    expect(guard.filterSessions(["any-session", "another"], restricted)).toEqual([]);
  });

  test("filterSessions preserves order, does not mutate input, supports object rows and custom selectors", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("read", "filter-strings", 5000, ["allow-a", "allow-c"]),
        makeGrant("read", "filter-objects", 5000, ["obj-a", "obj-c"]),
      ],
    });

    const list = ["allow-z", "allow-a", "allow-b", "allow-c", "allow-a"];
    const principalForStrings = principalFromAuthentication(authenticateQuery(guard, "filter-strings"));
    const stringRows = [...list];

    const filteredStrings = guard.filterSessions(list, principalForStrings);
    expect(filteredStrings).toEqual(["allow-a", "allow-c", "allow-a"]);
    expect(list).toEqual(stringRows);

    const objectRows = [
      { id: "obj-a", name: "obj-a" },
      { id: "obj-b", name: "obj-b" },
      { id: "obj-c", name: "obj-c" },
      { id: "obj-a", name: "obj-a" },
    ];
    const principalForObjects = principalFromAuthentication(authenticateQuery(guard, "filter-objects"));

    const byDefault = guard.filterSessions(objectRows, principalForObjects);
    expect(byDefault).toEqual([objectRows[0], objectRows[2], objectRows[3]]);

    const customRows = [
      { id: "obj-a", title: "first" },
      { id: "obj-b", title: "second" },
      { id: "obj-c", title: "third" },
      { id: "obj-a", title: "fourth" },
    ];
    const byName = guard.filterSessions(
      customRows,
      principalForObjects,
      (row) => row.id,
    );
    expect(byName).toEqual([customRows[0], customRows[2], customRows[3]]);
    expect(objectRows).toHaveLength(4);
    expect(objectRows[0]).toEqual({ id: "obj-a", name: "obj-a" });
  });

  test("filterSessions yields empty after principal expiry", () => {
    const clock = withMutableClock(100);
    const guard = createTokenGuardWithClock({
      now: clock.now,
      grants: [makeGrant("read", "expiring-filter", 500, ["allow-a", "allow-b"])],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "expiring-filter"));

    expect(guard.filterSessions(["allow-a", "allow-b", "allow-c"], principal)).toEqual(["allow-a", "allow-b"]);

    clock.set(1000);
    expect(guard.filterSessions(["allow-a", "allow-b", "allow-c"], principal)).toEqual([]);
  });
});

describe("token-guard hardening regressions", () => {
  test("recordings-download cross-checks the resolver instead of trusting the caller session hint", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "dl-restricted", 5000, ["allowed-session"])],
      recordingSessionResolver: (id) => (id === "rec-denied" ? "denied-session" : undefined),
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "dl-restricted"));

    expect(
      guard.authorizeHttp(
        new Request("https://x/api/recordings/rec-denied/download"),
        principal,
        { session: "allowed-session" },
      ),
    ).toMatchObject({ ok: false, status: 403 });

    // Sanity: without the caller session hint, resolver still denies.
    expect(
      guard.authorizeHttp(new Request("https://x/api/recordings/rec-denied/download"), principal),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_session" });
  });

  test("recordings-download rejects a recordingId hint that disagrees with the path", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "dl-mismatch", 5000, ["s1"])],
      recordingSessionResolver: (id) => (id === "rec-1" ? "s1" : "s2"),
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "dl-mismatch"));

    expect(
      guard.authorizeHttp(
        new Request("https://x/api/recordings/rec-2/download"),
        principal,
        { recordingId: "rec-1" },
      ),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_operation" });

    // Positive control: matching path + hint is allowed via resolver session s1.
    expect(
      guard.authorizeHttp(
        new Request("https://x/api/recordings/rec-1/download"),
        principal,
        { recordingId: "rec-1" },
      ),
    ).toMatchObject({ ok: true, status: 200, operation: "recordings-download", session: "s1" });
  });

  test("recordings-download denies when the session resolver throws", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "dl-throw", 5000, ["s1"])],
      recordingSessionResolver: () => {
        throw new Error("db down");
      },
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "dl-throw"));

    let result: ReturnType<typeof guard.authorizeHttp> | undefined;
    expect(() => {
      result = guard.authorizeHttp(
        new Request("https://x/api/recordings/rec-x/download"),
        principal,
      );
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  test("upload honours an explicit session context for session-restricted principals", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("interactive", "up-restricted", 5000, ["allowed"])],
    });
    const principal = principalFromAuthentication(authenticateQuery(guard, "up-restricted"));

    expect(
      guard.authorizeHttp(
        new Request("https://x/api/upload", { method: "POST" }),
        principal,
        { session: "denied" },
      ),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_session" });

    expect(
      guard.authorizeHttp(
        new Request("https://x/api/upload", { method: "POST" }),
        principal,
        { session: "allowed" },
      ),
    ).toMatchObject({ ok: true, status: 200, operation: "upload" });

    // No context stays permitted (unchanged behaviour for unrestricted-of-hint uploads).
    expect(
      guard.authorizeHttp(new Request("https://x/api/upload", { method: "POST" }), principal),
    ).toMatchObject({ ok: true, status: 200, operation: "upload" });
  });

  test("a cookie the guard itself issued is accepted back when the cookie name contains a plus", () => {
    const guard = createTokenGuardWithClock({
      grants: [makeGrant("read", "plus-token", 5000)],
      cookieName: "tmux+demo",
    });
    const issued = authenticateQuery(guard, "plus-token");
    expect(issued).toMatchObject({ ok: true, status: 200 });
    expect(issued.setCookie).toBeDefined();
    const header = (issued.setCookie as string).split(";")[0]!;

    expect(
      guard.authenticate(new Request("https://x/", { headers: { cookie: header } })),
    ).toMatchObject({ ok: true, status: 200, source: "cookie" });
  });

  test("grants pushed after construction are ignored instead of authenticating or throwing", () => {
    const grants = [makeGrant("read", "configured", 5000)];
    const guard = createTokenGuardWithClock({ grants });
    grants.push(makeGrant("interactive", "late-token", 5000));

    expect(() => authenticateQuery(guard, "late-token")).not.toThrow();
    expect(authenticateQuery(guard, "late-token")).toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_credential",
    });
    expect(authenticateQuery(guard, "configured")).toMatchObject({ ok: true, status: 200 });
  });

  test("mutating a configured grant after construction cannot widen scope or the session allow-list", () => {
    const widened = makeGrant("read", "aliased", 5000, ["a"]);
    const guard = createTokenGuardWithClock({ grants: [widened] });
    (widened.sessions as string[]).push("b");
    (widened as { scope: string }).scope = "interactive";
    const principal = principalFromAuthentication(authenticateQuery(guard, "aliased"));

    expect(principal.scope).toBe("read");
    expect(guard.isSessionAllowed(principal, "b")).toBe(false);
    expect(guard.isSessionAllowed(principal, "a")).toBe(true);
    expect(guard.filterSessions(["a", "b"], principal)).toEqual(["a"]);
    expect(
      guard.authorizeMuxMessage({ type: "keys", session: "a", data: "x" }, principal),
    ).toMatchObject({ ok: false, status: 403, code: "forbidden_scope" });
  });

  test("token lookup does not re-read caller grant objects per request", () => {
    const reads: Record<string, number> = { a: 0, b: 0, c: 0 };
    const counting = (key: string, token: string): TokenGrant => {
      const grant: Record<string, unknown> = { scope: "read", expiresAt: 5000 };
      Object.defineProperty(grant, "token", {
        enumerable: true,
        get() {
          reads[key] += 1;
          return token;
        },
      });
      return grant as unknown as TokenGrant;
    };
    const guard = createTokenGuardWithClock({
      grants: [counting("a", "tok-a"), counting("b", "tok-b"), counting("c", "tok-c")],
    });
    // Ignore construction-time token reads; per-request matching must not touch caller objects again.
    reads.a = 0;
    reads.b = 0;
    reads.c = 0;

    const aOk = authenticateQuery(guard, "tok-a");
    const cOk = authenticateQuery(guard, "tok-c");
    const unknown = authenticateQuery(guard, "unknown-token");
    const suffix = authenticateQuery(guard, "tok-a-longer-suffix");

    // Snapshot token material once at construction so matching is data-independent:
    // no early-exit that reveals which grant matched, and nothing re-read from caller-owned mutables.
    expect(reads).toEqual({ a: 0, b: 0, c: 0 });
    expect(aOk).toMatchObject({ ok: true, status: 200 });
    expect(cOk).toMatchObject({ ok: true, status: 200 });
    expect(unknown).toMatchObject({ ok: false, status: 401 });
    expect(suffix).toMatchObject({ ok: false, status: 401 });
  });

  test("revoke() invalidates a leaked token for new authentication and for live principals", () => {
    const guard = createTokenGuardWithClock({
      grants: [
        makeGrant("interactive", "leaked", 5000, ["s1"]),
        makeGrant("read", "other", 5000),
      ],
    });
    const live = principalFromAuthentication(authenticateQuery(guard, "leaked"));
    expect(guard.authorizeMuxMessage({ type: "ping" }, live)).toMatchObject({ ok: true, status: 200 });

    expect(guard.revoke("leaked")).toBe(true);
    expect(guard.revoke("leaked")).toBe(false);
    expect(guard.revoke("never-configured")).toBe(false);

    expect(authenticateQuery(guard, "leaked")).toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_credential",
    });
    expect(guard.authorizeMuxMessage({ type: "ping" }, live)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(guard.authorizeHttp(new Request("https://x/"), live)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(guard.isSessionAllowed(live, "s1")).toBe(false);
    expect(guard.filterSessions(["s1"], live)).toEqual([]);
    expect(authenticateQuery(guard, "other")).toMatchObject({ ok: true, status: 200 });
    expect(guard.redact("t=leaked")).not.toContain("leaked");
  });

  test("bootstrap cookie expires with the token", () => {
    const guard = createTokenGuardWithClock({
      now: () => 1000,
      grants: [makeGrant("read", "maxage-token", 61000)],
    });
    const result = authenticateQuery(guard, "maxage-token");
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.setCookie).toContain("Max-Age=60");
    expect(result.setCookie).toContain("Path=/");
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Strict");

    const expiredGrant = makeGrant("read", "already-expired", 5000);
    const guard2 = createTokenGuardWithClock({
      now: () => 9000,
      grants: [expiredGrant],
    });
    const cookie = guard2.makeCookieHeader(expiredGrant, new Request("https://x/"));
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).not.toMatch(/Max-Age=-\d/);
  });

  test("makeCookieHeader refuses to mint a bootstrap cookie for a revoked token", () => {
    const grant = makeGrant("read", "cookie-revoked", 5000);
    const guard = createTokenGuardWithClock({ grants: [grant] });
    expect(guard.makeCookieHeader(grant, new Request("https://x/"))).toContain("cookie-revoked");  // sanity, pre-revoke
    expect(guard.revoke("cookie-revoked")).toBe(true);
    expect(() => guard.makeCookieHeader(grant, new Request("https://x/"))).toThrow("invalid token value for cookie encoding");
  });

  test("issued principals carry an immutable session allow-list", () => {
    const guard = createTokenGuardWithClock({ grants: [makeGrant("read", "frozen-allow", 5000, ["a"])] });
    const principal = principalFromAuthentication(authenticateQuery(guard, "frozen-allow"));
    expect(Object.isFrozen(principal.sessions)).toBe(true);
    expect(() => (principal.sessions as string[]).push("b")).toThrow();
    expect(guard.isSessionAllowed(principal, "b")).toBe(false);
    expect(guard.isSessionAllowed(principal, "a")).toBe(true);
    expect(guard.filterSessions(["a", "b"], principal)).toEqual(["a"]);
    const copy = guard.sanitizePrincipal(principal);
    expect(Object.isFrozen(copy.sessions)).toBe(true);
  });

  test("public helpers deny malformed input instead of throwing", () => {
    const guard = createTokenGuardWithClock({ grants: [makeGrant("read", "malformed-input", 5000, ["a"])] });
    const principal = principalFromAuthentication(authenticateQuery(guard, "malformed-input"));
    expect(guard.revoke("")).toBe(false);
    expect(() => (guard as unknown as { revoke: (t: unknown) => boolean }).revoke(null)).not.toThrow();
    expect((guard as unknown as { revoke: (t: unknown) => boolean }).revoke(null)).toBe(false);
    expect((guard as unknown as { revoke: (t: unknown) => boolean }).revoke(42)).toBe(false);
    expect(() => guard.isSessionAllowed(principal, null as unknown as string)).not.toThrow();
    expect(guard.isSessionAllowed(principal, null as unknown as string)).toBe(false);
    expect(guard.isSessionAllowed(principal, "" as string)).toBe(false);
    expect(guard.isSessionAllowed(principal, "a")).toBe(true);
    // the guard is still usable afterwards
    expect(authenticateQuery(guard, "malformed-input")).toMatchObject({ ok: true, status: 200 });
  });

  // DEFECT 1 (CRITICAL): authorization must not honour caller mutations of a minted principal.
  // Decisions derive from the InternalGrant snapshot; principals are frozen; field mismatch rejects.
  test("mutating an issued principal cannot escalate scope, sessions, or expiry", () => {
    const guard = createTokenGuard({
      grants: [{ token: "read-token", scope: "read", expiresAt: 9_000_000_000_000, sessions: ["allowed"] }],
      now: () => 1_000,
    });
    const auth = guard.authenticate(new Request("https://x/api?t=read-token"));
    expect(auth).toMatchObject({ ok: true, status: 200 });
    const p = principalFromAuthentication(auth);

    // Baseline: keys denied (read scope) and blocked session denied.
    expect(guard.authorizeMuxMessage({ type: "keys", session: "blocked", data: "x" }, p)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(guard.authorizeMuxMessage({ type: "subscribe", session: "blocked" }, p)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_session",
    });
    expect(guard.isSessionAllowed(p, "blocked")).toBe(false);
    expect(guard.isSessionAllowed(p, "allowed")).toBe(true);

    // Hand-reproduced escalation: rewrite surface fields then re-authorize.
    // Correct fix freezes the principal (assignment throws) AND never honours
    // mutated surface fields even if freeze is somehow bypassed.
    expect(Object.isFrozen(p)).toBe(true);
    let mutationThrew = false;
    try {
      (p as { scope: string }).scope = "interactive";
      (p as { expiresAt: number }).expiresAt = 9_999_999_999_999;
      (p as { sessions?: readonly string[] }).sessions = undefined;
    } catch {
      mutationThrew = true;
    }
    expect(mutationThrew).toBe(true);
    // Surface fields must still reflect the grant after the attempted rewrite.
    expect(p.scope).toBe("read");
    expect(p.expiresAt).toBe(9_000_000_000_000);
    expect(p.sessions).toEqual(["allowed"]);

    // THE critical assertion from the hand repro: must NOT become ok:true after mutation.
    expect(guard.authorizeMuxMessage({ type: "keys", session: "blocked", data: "x" }, p)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(guard.authorizeHttp(new Request("https://x/api/spawn", { method: "POST" }), p)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
    expect(guard.isSessionAllowed(p, "blocked")).toBe(false);
    expect(guard.filterSessions(["allowed", "blocked"], p)).toEqual(["allowed"]);

    // sanitizePrincipal returns a frozen grant-derived copy (never caller-mutated fields).
    const sanitized = guard.sanitizePrincipal(p);
    expect(Object.isFrozen(sanitized)).toBe(true);
    expect(sanitized.scope).toBe("read");
    expect(sanitized.expiresAt).toBe(9_000_000_000_000);
    expect(sanitized.sessions).toEqual(["allowed"]);

    // createSocketPrincipal path is grant-authoritative and returns a frozen principal too.
    // Deliberately wrong surface fields: token is a locator only; grant snapshot wins.
    const socketPrincipal = guard.createSocketPrincipal({
      token: "read-token",
      scope: "interactive",
      expiresAt: 9_999_999_999_999,
    });
    expect(Object.isFrozen(socketPrincipal)).toBe(true);
    expect(socketPrincipal.scope).toBe("read");
    expect(socketPrincipal.expiresAt).toBe(9_000_000_000_000);
    expect(socketPrincipal.sessions).toEqual(["allowed"]);
    expect(guard.authorizeMuxMessage({ type: "keys", session: "blocked", data: "x" }, socketPrincipal)).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden_scope",
    });
  });

  // DEFECT 2 (MEDIUM): an unrelated cookie's percent-decode failure must not poison a valid token cookie.
  test("malformed unrelated cookie value does not kill a valid configured credential", () => {
    const guard = createTokenGuard({
      grants: [{ token: "read-token", scope: "read", expiresAt: 9_000_000_000_000 }],
      now: () => 1_000,
    });

    // analytics=100% is legal-as-analytics but illegal percent-encoding if decoded blindly.
    const result = guard.authenticate(
      new Request("https://x/", {
        headers: { cookie: "analytics=100%; tmux_demo_t=read-token" },
      }),
    );
    expect(result).toMatchObject({ ok: true, status: 200, source: "cookie" });
    expect(principalFromAuthentication(result).scope).toBe("read");

    // Configured cookie still rejects its own malformed encoding.
    expect(
      guard.authenticate(
        new Request("https://x/", {
          headers: { cookie: "analytics=ok; tmux_demo_t=%E0%A" },
        }),
      ),
    ).toMatchObject({ ok: false, status: 401, code: "malformed_credential" });
  });
});
