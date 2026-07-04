# The thumbmux WS protocol

One WebSocket multiplexes every session. All frames are JSON. Types live in
`@thumbmux/core` (`protocol.ts`); server behavior is enforced by
`server/tests/conformance.test.ts`, which any alternative server can reuse.

## Client → server

| type | fields | semantics |
|---|---|---|
| `subscribe` | `session`, `tail?`, `client?` | start streaming a session to this socket. `tail: N` = slice frames to the last N **non-blank-trimmed** pane lines (thumbnail mode). Re-subscribing with a different `tail` updates the preference; omitting it upgrades to full frames. An immediate snapshot is sent (cached first, then a fresh capture). |
| `unsubscribe` | `session` | stop streaming; per-socket state for the session is dropped. |
| `keys` | `session`, `data` | write raw bytes to the pane (IME text, control sequences — `\r`, `\x1b[A`, …). Deliberately carries no client blob: this is the hot path. |
| `resize` | `session`, `cols`, `rows`, `client?` | request pane geometry. The host's `onResizeRequest` hook may veto (e.g. a phone holds the size). |
| `history_expand` | `session`, `beforeLine?`, `limit?` | page older scrollback from the archive (if the host wired one). Reply: `history`. |
| `sessions_subscribe` / `sessions_unsubscribe` | — | join/leave the `__sessions` list channel. |
| `ping` | — | keepalive; server replies `{"type":"pong"}`. Clients close after 8 s without a pong. |
| `client_info` | `client` | refresh this socket's descriptor (visibility, viewport, host telemetry id). |

## Server → client

| frame | semantics |
|---|---|
| `{channel, type:"output", data, cursor?}` | full pane snapshot (or the tail slice for tail subscribers). Sent only when the content hash changed — an idle pane costs zero bytes. `cursor` is `{row, col}` (`row` counts up from the last content line, trailing blanks trimmed; same convention for tail slices) or `null` when hidden; present when the driver implements `getCursor`. |
| `{channel, type:"history", data}` | JSON `{lines, startLine, hasMore}` for `history_expand`. |
| `{channel, type:"error", data}` | e.g. the session disappeared. |
| `{channel:"__sessions", type:"sessions", data}` | JSON session list; pushed on subscribe and whenever the list changes (~5 s cadence). |
| `{type:"pong"}` | ping reply. |

## Timing model

- Output detection: `pipe-pane` dirty signals debounced 15 ms (100 ms max
  wait); polling fallback at 4 FPS idle, 10 FPS for 5 s after a keystroke.
- Snapshots are idempotent full states, not deltas: a client can join, drop,
  or lag at any time and the next frame fully reconciles it (crash-safe by
  construction — there is no cursor to desync).
- `tmux capture-pane` output ends at the last non-blank line of the visible
  region in most states, but freshly-spawned panes carry trailing blank rows;
  tail slicing trims them (see conformance: "tail subscribe receives only the
  last N lines").

## Deployment notes

- **HTTP/2 and the WS upgrade:** WebSocket's `Upgrade` header does not exist
  in HTTP/2, so `server.upgrade()`-style handshakes fail on connections a
  reverse proxy negotiated as h2 (a curl probe with `-H "Upgrade: websocket"`
  gets `200`, not `101`). Real browsers open WebSockets over HTTP/1.1, so
  users are unaffected — but point automated health checks at HTTP/1.1.
- **Wide glyphs:** cursor/link column math assumes 1 cell = 1 measured char
  width. Exact for ASCII and box drawing; CJK double-width cells and Thai
  combining marks can drift the caret on non-ASCII lines (known limitation).
