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
| `{channel, type:"output", data, cursor?}` | full pane snapshot (or the tail slice for tail subscribers). Sent only when the content hash changed — an idle pane costs zero bytes. `cursor` is `{row, col}` (`row` counts up from the last content line, trailing blanks trimmed; same convention for tail slices; NEGATIVE row = caret sits \|row\| blank rows BELOW the last content line, e.g. a shell waiting after newline-terminated output) or `null` when hidden; present when the driver supplies cursor state. |
| `{channel, type:"cursor", cursor}` | caret-only update: the cursor moved but the pane content did not (arrow keys on a shell line), so the snapshot is not re-sent. Carries no `data` — clients that render output must check `type` first. Emitted only on the `captureWithCursor` driver path. |
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

## Cursor sampling (drivers)

Two driver hooks exist; implement `captureWithCursor` unless you cannot:

- `captureWithCursor(session, opts)` → `{content, cursor, trailingBlanks}` —
  capture and cursor sampled in ONE tmux invocation
  (`tmux display-message … \; capture-pane …`), so the pair cannot desync
  during a TUI repaint. This matters more than it looks: output frames are
  hash-deduped, so a mismatched (content, cursor) pair sampled mid-repaint
  would otherwise be **frozen** for as long as the pane stays idle, and every
  new viewer would render a misplaced caret. `trailingBlanks` must be counted
  on the RAW capture — if your `capturePane` trims trailing blank lines (a
  reasonable bandwidth choice), the mux cannot recover the count from the
  trimmed content, and a content-derived count of 0 displaces the caret
  upward by the pane's real blank bottom rows (a production bug we shipped,
  then unshipped).
- `getCursor(session)` (legacy) — separate tmux call, sampled only when the
  content changed. Correct ONLY for drivers whose `capturePane` preserves
  trailing blank rows; no caret-only updates.

## Deployment notes

- **HTTP/2 and the WS upgrade:** WebSocket's `Upgrade` header does not exist
  in HTTP/2, so `server.upgrade()`-style handshakes fail on connections a
  reverse proxy negotiated as h2 (a curl probe with `-H "Upgrade: websocket"`
  gets `200`, not `101`). Real browsers open WebSockets over HTTP/1.1, so
  users are unaffected — but point automated health checks at HTTP/1.1.
- **Wide glyphs:** the caret column is pixel-accurate: the client maps the
  cursor's cell column onto the line's characters with wcwidth-style cell
  accounting (`@thumbmux/core` `prefixForCells` — Thai combining marks 0
  cells, CJK/emoji 2) and then measures that prefix with the live font, so
  the caret follows the DOM's real glyph advances even for Thai/CJK/emoji
  lines. Link tap-target column math still assumes 1 cell = 1 char width
  (remaining known limitation).
