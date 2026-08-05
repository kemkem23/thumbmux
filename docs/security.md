# Scoped bearer-token guard

This document describes the standalone, host-instantiated `createTokenGuard`
style guard. It is a pure authorization component: it does not itself wire the
demo server, WebSocket mux, browser routing, or response output.

**If you are starting fresh, you probably want `createAppRoutes` instead.** Hand
it a `guard` and it performs the wiring this document describes — see
"The paved road" at the end. Read the rest of this page when you drive
`TmuxWsMux` yourself, or when you need to know exactly what is being enforced
on your behalf.

## Scope and grants

A host configures grants with a bearer token, a `read` or `interactive` scope,
an expiry time, and an optional `sessions` allowlist. A grant is active only
while its expiry is later than the guard's current time; equality with the
expiry is expired.

Destructive operations can also require an explicit grant permission. The
current permission is `sessions-kill`; omitting `permissions` (or passing an
empty list) denies kill even to an otherwise unrestricted `interactive` grant.
This permission is snapshotted internally and is not added to the token-free
principal surface.

When authentication succeeds, the guard returns a token-free principal holding
only the scope, expiry, and allowlist. An omitted `sessions` property is
unrestricted. A present allowlist, including an empty one, restricts access to
its exact session names.

`createTokenGuard` is exported from `thumbmux/server`. This complete server-side
example stores the authenticated, token-free principal outside client-controlled
metadata and wires the `filterSessionList` hook on `TmuxWsMux`:

```ts
import {
  TmuxWsMux,
  createBunTmuxDriver,
  createTokenGuard,
  type TokenPrincipal,
  type WsLike,
} from "thumbmux/server";

const token = process.env.THUMBMUX_TOKEN;
if (!token) throw new Error("THUMBMUX_TOKEN is required");

const guard = createTokenGuard({
  grants: [{
    token,
    scope: "interactive",
    expiresAt: Date.now() + 60 * 60 * 1000,
    sessions: ["agent-1"],
  }],
});

type AppSocket = WsLike;
const principals = new WeakMap<AppSocket, TokenPrincipal>();

export function bindAuthenticatedSocket(
  socket: AppSocket,
  principal: TokenPrincipal,
): void {
  principals.set(socket, guard.sanitizePrincipal(principal));
}

export const mux = new TmuxWsMux<AppSocket>({
  driver: createBunTmuxDriver(),
  hooks: {
    filterSessionList(sessions, socket) {
      const principal = principals.get(socket);
      return principal
        ? guard.filterSessions(sessions, principal, ({ name }) => name)
        : [];
    },
    onSocketClose(socket) {
      principals.delete(socket);
    },
  },
});
```

Call `bindAuthenticatedSocket` only with the `principal` returned by a successful
`guard.authenticate(request)`, after authorizing the WebSocket upgrade. Also
forward its `setCookie` header when a query token bootstraps a cookie.
`filterSessionList` is a `MuxHooks` option, not a standalone export. The mux
invokes it for the initial list, every pushed update, and backpressure catch-up.
Its input must not be mutated. A missing principal returns no rows above; omitting
the hook would expose the provider's full list. The third `client` argument is
client-supplied telemetry and must never be used as an authorization principal.
Filtering lists also does not replace `authorizeMuxMessage` checks for parsed
WebSocket operations.

## Bootstrap and cookies

With the default configuration, exactly one `t` query parameter can bootstrap
authentication. Its fully decoded value must exactly equal one active grant;
prefix, suffix, substring, and partial matches do not authenticate. A
malformed, duplicate, unknown, or expired explicit `t` is rejected and never
falls back to a cookie. The same exact-one rule applies if a host deliberately
configures a different query parameter name.

When no query credential is present, normal requests authenticate from exactly
one cookie with the configured name (by default, `tmux_demo_t`) and an exact
active value. Similarly named cookies, duplicate cookie names, malformed
values, and token prefixes or suffixes do not authenticate. A successful query
bootstrap returns a safely encoded `Set-Cookie` value for the host to send.

That cookie is host-only: it uses `Path=/`, `HttpOnly`, and
`SameSite=Strict`, has no broad `Domain`, and includes `Secure` for HTTPS or a
host-configured secure deployment. After bootstrap, the browser client should
remove `t` from its history. History scrubbing and routing are host/demo
integration responsibilities, not behavior this guard can perform alone.

The shared browser mux is configured once at application startup with
`configureTmuxMux`, exported from `thumbmux/svelte`. The default endpoint is
already same-origin `/ws/tmux`; this example makes that choice explicit and
adds a stable telemetry ID:

```ts
import { configureTmuxMux } from "thumbmux/svelte";

const clientId = crypto.randomUUID();

configureTmuxMux({
  getUrl: () => {
    const url = new URL("/ws/tmux", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  },
  getClientMeta: () => ({ clientId }),
});
```

`getClientMeta` is telemetry only. Do not put bearer tokens or other secrets in
it, and do not trust those fields on the server; normal same-origin cookie rules
carry the guard cookie on the WebSocket handshake.

## Principal immutability

Grants are snapshotted and frozen at guard construction. Every successful
authentication mints a **frozen, token-free principal** bound to that grant
snapshot (via an internal weak map). Authorization always re-reads the grant:

- scope, expiry, and session allowlist on the principal surface are compared
  against the grant; a mismatch is treated as an integrity failure, not a
  privilege change
- mutating a principal object after issue therefore cannot widen scope,
  sessions, or expiry — even if the host somehow unfreezes or clones fields
- `sanitizePrincipal` / `createSocketPrincipal` re-mint from the grant and
  never copy caller-held privilege fields
- destructive-operation permissions are read from the bound immutable grant,
  not from caller-controlled principal fields
- `revoke(token)` rejects new authentication and causes subsequent
  authorization decisions using principals minted from that grant to fail

## Authorization decisions

Missing, malformed, invalid, or expired credentials are `401`. A valid,
unexpired principal denied by scope or operation permission, session allowlist,
or a malformed/unknown operation is `403`. The guard checks expiry whenever an
authorization method is invoked against the grant snapshot. Integrations must
invoke it at each one-shot boundary and arrange for already-authorized live
subscriptions to stop when the grant is no longer active; the standalone guard
does not schedule socket or subscription teardown by itself.

| Capability | `read` | `interactive` | Additional rule |
| --- | --- | --- | --- |
| Static content, auth description, and WebSocket upgrade | allowed | allowed | — |
| Session-list access | allowed | allowed | Filter every list before it is emitted. |
| Recording list/download reads | allowed | allowed | The relevant session must be allowed. |
| `ping`, `client_info`, session-list subscribe/unsubscribe | allowed | allowed | Pushed session lists still require filtering. |
| `subscribe`, `unsubscribe`, `history_expand`, `resync` | allowed | allowed | Require a nonempty, exactly allowed session. |
| `keys`, `resize` | denied | allowed | Require a nonempty, exactly allowed session. |
| Preference read | allowed | allowed | `createPrefsHandler` is one shared single-tenant store; authorization does not partition its data. |
| Preference write | denied | allowed | Authorize `prefs-write` before calling the handler. |
| Session kill | denied | denied unless explicitly granted | Require `permissions: ["sessions-kill"]` and a nonempty, exactly allowed session. |
| Spawn, upload, recording start, recording stop | denied | allowed | Recording actions require a nonempty, exactly allowed session. Restricted grants never spawn. |

Every session-bearing HTTP or WebSocket operation must use an exact session in
the allowlist. Session lists must be filtered before both their initial output
and every pushed update; authorization to subscribe to a list does not by
itself filter the list payload.

The reference `createBunTmuxDriver()` also uses exact tmux targets by default.
This closes tmux's bare-target prefix/fnmatch fallback after an allowed session
dies—for example, an operation authorized for `agent` cannot silently land on
`agent-2`. The same default applies to `spawnTmuxSession()` command delivery
and `killTmuxSession()`. Names beginning with `=` remain literal; callers pass
the name unchanged and the driver produces the doubled exact marker required by
tmux. See [Reference Bun driver target resolution](protocol.md#reference-bun-driver-target-resolution)
for syntax and the explicit `targetMode: "legacy"` compatibility option.

Exact driver targeting is defense in depth, not authorization: it prevents a
requested name from resolving to a different session, but it does not decide
whether the requester may access the exact session in the first place. Keep the
principal-bound message and route checks described above.

## Host routes and parsed input

HTTP operations the guard recognizes or lets a host name explicitly include:

- `POST /api/spawn`
- `POST /api/upload`
- `GET /api/prefs` (`prefs-read`) and `PUT`/`POST /api/prefs`
  (`prefs-write`)
- `POST /api/recordings/start` and `POST /api/recordings/stop`, with a parsed
  session payload
- `GET /api/recordings?session=...`
- `DELETE {basePath}/sessions/:name` in `createAppRoutes`, or a host-defined
  kill route using `sessions-kill` plus its parsed session name

Hosts should authorize named, parsed operations and session inputs, including
body-derived sessions, rather than guessing from raw URL substring matches.
This keeps route parsing and authorization explicit and prevents a route or
parameter spelling from becoming an accidental bypass.

`sessions-kill` is denied by default. A grant must be `interactive`, include
`permissions: ["sessions-kill"]`, and name a nonempty session allowed by its
allowlist; adding the operation name alone grants nothing. `createAppRoutes`
owns `DELETE {basePath}/sessions/:name` by default. It parses the session,
authorizes `sessions-kill` when a guard is present, calls `killTmuxSession()`,
and invalidates the mux lifecycle. Set `kill: { enabled: false }` to return that
path to the host.

The manual-composition example below shows the equivalent host-owned
`DELETE /api/sessions/:name` route for a host that does not use
`createAppRoutes`. It also guards the packaged preferences handler instead of
mounting it directly. The principal must have been authenticated by the
returned guard.

<!-- B2-GUARDED-HTTP-SNIPPET:START -->
```ts
import {
  createPrefsHandler,
  createTokenGuard,
  killTmuxSession,
  type HttpAuthorizationContext,
  type TokenPrincipal,
} from "thumbmux/server";

type SessionInvalidator = {
  invalidateSession(session: string): unknown;
};

export function createProtectedOperations(options: {
  token: string;
  prefsFile: string;
  mux: SessionInvalidator;
}) {
  const guard = createTokenGuard({
    grants: [{
      token: options.token,
      scope: "interactive",
      expiresAt: Date.now() + 60 * 60 * 1000,
      sessions: ["agent-1"],
      permissions: ["sessions-kill"],
    }],
  });
  const handlePrefs = createPrefsHandler({ file: options.prefsFile });

  const denied = (decision: {
    status: number;
    code: string;
    message: string;
  }) => Response.json(
    { ok: false, code: decision.code, message: decision.message },
    { status: decision.status },
  );

  async function handle(req: Request, principal: TokenPrincipal): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/prefs") {
      const operation = req.method === "GET"
        ? "prefs-read"
        : req.method === "PUT" || req.method === "POST"
          ? "prefs-write"
          : undefined;
      if (!operation) return new Response("method not allowed", { status: 405 });

      const context: HttpAuthorizationContext = { operation };
      const decision = guard.authorizeHttp(req, principal, context);
      return decision.ok ? handlePrefs(req) : denied(decision);
    }

    const match = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && match) {
      let session: string;
      try {
        session = decodeURIComponent(match[1]!);
      } catch {
        return new Response("invalid session", { status: 400 });
      }

      const context: HttpAuthorizationContext = {
        operation: "sessions-kill",
        session,
      };
      const decision = guard.authorizeHttp(req, principal, context);
      if (!decision.ok) return denied(decision);

      killTmuxSession(session);
      options.mux.invalidateSession(session);
      return Response.json({ ok: true, session });
    }

    return new Response("not found", { status: 404 });
  }

  return { guard, handle };
}
```
<!-- B2-GUARDED-HTTP-SNIPPET:END -->

## Preferences are deliberately single-tenant

`createPrefsHandler({ file })` performs no authentication and stores one JSON
object for every request reaching that handler. One handler/file therefore
means one trusted tenant, not one user. `prefs-read` and `prefs-write` let the
host protect that shared resource, but they do not turn it into per-user
storage. Mounting the handler directly lets every caller read and merge the
same data.

This contract stays single-tenant because `TokenPrincipal` intentionally has
no token or stable user/subject identifier. Using scope, expiry, or a session
allowlist as a pretend user key would collide between people and change across
grant rotation. A real per-user handler would need a new identity contract,
storage-key rules, migration behavior, and traversal-safe persistence API;
silently inventing those semantics here would be worse than exposing the
single-tenant boundary honestly. Multi-user hosts must provide their own
identity-backed preferences store.

## Packaged handler operation coverage

Every fetch-style handler factory exported from `thumbmux/server` has a named
guard operation. The guard remains host-composed: factories do not call it
automatically.

| Exported handler factory | Handler methods | `HttpOperation` | Coverage |
| --- | --- | --- | --- |
| `createSpawnHandler` | POST | `sessions-spawn` | covered |
| `createUploadHandler` | POST | `upload` | covered |
| `createPrefsHandler` | GET / PUT / POST | `prefs-read` / `prefs-write` | covered (single-tenant) |

`killTmuxSession` is an exported destructive primitive rather than a standalone
handler factory. `createAppRoutes` wraps it in the packaged
`DELETE {basePath}/sessions/:name` route and covers that route with
`sessions-kill`; manually composed hosts must apply the same authorization.
`TmuxWsMux`, `FrameJournal`, and `FileHistoryArchive` are host-composed
engines/primitives, not HTTP handler factories.

## Stock launch preset IDs

The seven `presetId` values in `DEFAULT_LAUNCH_PRESETS` are `claude`,
`claude-worktree`, `codex`, `codex-worktree`, `grok`, `grok-worktree`, and
`blank`. Read the shipped list from `thumbmux/core` when validating a picker or
request instead of copying it into application code:

```ts
import { DEFAULT_LAUNCH_PRESETS } from "thumbmux/core";

const stockPresetIds = new Set(
  DEFAULT_LAUNCH_PRESETS.map(({ id }) => id),
);

export function isStockPresetId(value: string): boolean {
  return stockPresetIds.has(value);
}
```

`createSpawnHandler` uses these presets by default; passing its `presets` option
replaces the stock set. For a known preset, the server rebuilds the command and
does not trust submitted command text. Worktree presets require both host
prepare and cleanup hooks, `blank` produces no command, and the six agent
presets default to permission-bypass modes. Treat spawning as an interactive,
privileged operation.

## Logging and deployment limits

Do not log bearer values or URLs and cookie headers that contain them. The
guard's redaction helper can reduce accidental exposure in guard-controlled
diagnostics, but it does not make external application logs, browser history,
or reverse-proxy logs safe.

This is demo bearer-token authentication and authorization with in-memory
revocation scoped to one guard instance. It is not user identity, a durable or
cross-instance revocation service, CSRF protection, replay protection,
encrypted transport/TLS, or a session-isolation guarantee beyond the
configured allowlists. It is not a substitute for TLS, secure proxy
configuration, network exposure control, or server-side routing enforcement.

## The paved road: `createAppRoutes`

`createAppRoutes({ guard, ... })` from `thumbmux/server` performs every step
below, so a host that uses it does not assemble authorization by hand:

- authenticates the WebSocket **upgrade** and holds the token-free principal
  server-side, keyed to the socket
- authorizes **every inbound client** mux message, not only the ones that look
  sensitive, and rechecks expiry per message; on the raw WebSocket a denied
  message receives `{ type: "auth_error", status, code }`.
  The channel-less denial is typed as `MuxAuthErrorFrame`; raw consumers that
  handle both session messages and denials can use the additive `MuxServerFrame`
  union. `MuxServerMessage` remains the session-frame union from v0.7.1.
  That frame carries no `channel`, so the packaged browser client cannot route it
  to a session panel. It re-emits it as a `thumbmux:auth-error` `CustomEvent` on
  `window`, with the frame as `detail`, so a host can react instead of watching a
  panel go quiet:

  ```ts
  window.addEventListener("thumbmux:auth-error", (event) => {
    const { status, code } = (event as CustomEvent).detail;
    // 401 -> the credential is gone; 403 -> this principal may not do that
  });
  ```

  A host driving a raw WebSocket reads the frame directly and needs none of this.
- applies the guard's projection to the session list on **every** path that emits
  one — initial and explicit subscription, changed push/poll, pane-only fanout,
  drain catch-up, and the HTTP list
- composes the optional transport-neutral `AppRoutesOptions.projectSessionList`
  projection with the legacy socket-only `MuxHooks.filterSessionList` hook.

  Let `G` be `guard.filterSessions`, `L` be `filterSessionList`, `P` be
  `projectSessionList`, and `provider` be the driver's session rows:

  | Path | Pipeline |
  | --- | --- |
  | Unguarded HTTP, omitted `P` | existing `provider` exactly |
  | Unguarded WebSocket, omitted `P` and `L` | existing `provider` exactly |
  | Guarded HTTP, omitted `P` | existing `G(provider)` exactly |
  | Guarded HTTP, with `P` | `G(provider) -> P -> G` |
  | Guarded WebSocket, legacy `L` only | existing `G -> L(real ws, client) -> G` exactly |
  | Guarded WebSocket, `P` only | `G -> P -> G` |
  | Guarded WebSocket, both | `G -> L(real ws, client) -> G -> P -> G` |
  | Unguarded HTTP, with `P` | `provider -> P` |
  | Unguarded WebSocket, `P` only | `provider -> P` |
  | Unguarded WebSocket, legacy `L` only | existing `provider -> L(real ws, client)` exactly |
  | Unguarded WebSocket, both | `provider -> L(real ws, client) -> P` |

  In guarded socket composition, the middle `G` prevents `P` from observing a
  denied row reintroduced by `L`, and the final `G` prevents `P` from widening
  the grant. Keeping `L` before `P` preserves the legacy hook's existing input
  and real socket/client identity.

  `projectSessionList` is synchronous and context-free. It runs on
  `GET {basePath}/sessions` and every WebSocket session-list delivery; omitting
  it preserves the existing behavior, and it must not mutate its input.
  `filterSessionList` remains unchanged, runs only on WebSocket paths, and
  receives the real socket and client. It may therefore narrow WebSocket rows
  further: the API promises one common projection stage, not identical final
  lists across transports.

  On WebSocket, either `L` or `P` throwing keeps the existing fail-closed hook
  behavior: it logs the exception message only and emits no session-list frame
  for that round. On HTTP, only `P` runs; if it throws, the route returns status
  `500` with exactly `{"error":"session list projection failed"}` and retains
  any successful authentication `Set-Cookie`. It never falls back to
  unprojected rows.

  `projectSessionList` is a presentation transform that may hide, reorder, or
  decorate rows; `filterSessionList` remains the legacy socket-only narrowing
  filter. Neither hook authorizes `subscribe`, `keys`, `resize`, `history`,
  `spawn`, or `kill`. Authorization and tenant isolation live in guard grants
  and per-message checks. A filtered list is not tenant isolation.
- maps each HTTP route to a named operation (`sessions-list`, `sessions-spawn`,
  `upload`, `prefs-read`, `prefs-write`, `sessions-kill`) and authorizes before
  the handler runs, answering `405` with `Allow` on the wrong method
- requires the explicit `sessions-kill` permission for kill, which existing
  interactive grants do not carry

Live authorization withdrawal is bounded, not universally synchronous. While at
least one guarded socket is open, calls through the guard's currently installed
`revoke` property sweep its live subscriptions in that call. A method reference
saved before that observer was installed, or a custom guard whose method cannot
be wrapped, instead relies on the per-socket check scheduled every 100 ms; it is
withdrawn by the next check while the event loop remains responsive. Expiry uses
the same scheduled check.

A sweep removes the socket from live subscription sets. An in-progress grouped
fan-out may already include that socket and may still call its `send()` for the
current output frame, but subsequent live broadcasts do not call its `send()`.
This is a server-side handoff bound, not a client-delivery bound: the transport
may deliver multiple frames that it accepted into its outbound queue before
withdrawal after the token has been revoked.

`WsLike.close()` is optional, so send-only adapters remain supported. When it is
present, `createAppRoutes` calls it during withdrawal so the adapter can close
the transport. Whether closing discards already accepted frames is defined by
that transport. Without `close()`, thumbmux can only remove subscriptions. A
host that requires immediate peer cutoff must provide a close implementation,
or an equivalent adapter action, that discards its outbound queue.

Pass no `guard` and it behaves exactly as before — unauthenticated, as the demo
and single-user setups expect.

**Still yours, regardless:** who receives which grant, `Origin`/CSRF/TLS, spawn
policy (cwd allowlist, naming, worktrees), per-user storage, and owning the
process and listener.

## Doing it yourself

Driving `TmuxWsMux` directly means owning the WebSocket responsibilities above:
retain the token-free principal at upgrade, keep authorization current for
inbound messages and live outbound subscriptions, authorize messages rather
than relying on list filtering, and apply the projection to every list output.
Filtering alone is not isolation — a client that a filtered list hides a
session from can still name that session directly in a `subscribe` or `keys`
frame. That is a demonstrated leak, not a theoretical one, and it is pinned by
a test that watches the marker arrive in the forbidden pane when per-message
authorization is removed.
