# Scoped bearer-token guard

This document describes the standalone, host-instantiated `createTokenGuard`
style guard. It is a pure authorization component: it does not itself wire the
demo server, WebSocket mux, browser routing, or response output.

## Scope and grants

A host configures grants with a bearer token, a `read` or `interactive` scope,
an expiry time, and an optional `sessions` allowlist. A grant is active only
while its expiry is later than the guard's current time; equality with the
expiry is expired.

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
- `revoke(token)` invalidates both new authentications and any live principal
  minted from that grant

## Authorization decisions

Missing, malformed, invalid, or expired credentials are `401`. A valid,
unexpired principal denied by scope, session allowlist, or a malformed/unknown
operation is `403`. The guard checks expiry for every authorization decision
against the grant snapshot, including every WebSocket message after upgrade.

| Capability | `read` | `interactive` | Additional rule |
| --- | --- | --- | --- |
| Static content, auth description, and WebSocket upgrade | allowed | allowed | — |
| Session-list access | allowed | allowed | Filter every list before it is emitted. |
| Recording list/download reads | allowed | allowed | The relevant session must be allowed. |
| `ping`, `client_info`, session-list subscribe/unsubscribe | allowed | allowed | Pushed session lists still require filtering. |
| `subscribe`, `unsubscribe`, `history_expand`, `resync` | allowed | allowed | Require a nonempty, exactly allowed session. |
| `keys`, `resize` | denied | allowed | Require a nonempty, exactly allowed session. |
| Spawn, upload, recording start, recording stop | denied | allowed | Recording actions require a nonempty, exactly allowed session. Restricted grants never spawn. |

Every session-bearing HTTP or WebSocket operation must use an exact session in
the allowlist. Session lists must be filtered before both their initial output
and every pushed update; authorization to subscribe to a list does not by
itself filter the list payload.

## Host routes and parsed input

The current demo-facing operations include:

- `POST /api/spawn`
- `POST /api/upload`
- `POST /api/recordings/start` and `POST /api/recordings/stop`, with a parsed
  session payload
- `GET /api/recordings?session=...`

Hosts should authorize named, parsed operations and session inputs, including
body-derived sessions, rather than guessing from raw URL substring matches.
This keeps route parsing and authorization explicit and prevents a route or
parameter spelling from becoming an accidental bypass.

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

## Required later integration

Later host/demo integration must retain the token-free principal at WebSocket
upgrade, recheck its expiry for every message, and apply the session-list
filter hook to every list output. Until that wiring is present, this module
alone does not protect demo or mux traffic.
