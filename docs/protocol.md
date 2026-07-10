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
| `{channel, type:"history", data}` | `history_expand` reply — `data` is a JSON-encoded string of `{lines, startLine, hasMore}`. A mux with no archive answers `{lines:[], startLine:null, hasMore:false}` immediately (clients must not wait forever). |
| `{channel, type:"error", data}` | e.g. the session disappeared. |
| `{channel:"__sessions", type:"sessions", data}` | session list — `data` is a JSON-encoded **string** (parse it), like every `data` field on this table; pushed on subscribe and whenever the list changes (~5 s cadence). |
| `{type:"pong"}` | ping reply. |

### Output deltas and resync

A full `output` frame establishes its raw base as `data.split('\n')`. That
split is exact: a trailing empty element is part of the base and is never
trimmed or normalised before hashing.

After a full frame, a server may send:

```ts
{
  channel,
  type: 'delta',
  baseLength,
  prefix,
  prefixHash,
  lines,
  cursor?,
}
```

`prefix` is the number of unchanged raw lines. `lines` is the complete
replacement suffix, so a client reconstructs with
`base.slice(0, prefix).concat(lines)`, including replacement and truncation
cases. `prefixHash` is lowercase FNV-1a-32 over the UTF-8 bytes of
`JSON.stringify(base.slice(0, prefix))`.

Clients accept a delta only when `baseLength` equals their current base length,
all numeric fields are integers, `prefix` is in bounds, and the prefix hash
matches. A bad, missing, or stale delta changes neither content nor cursor;
the client sends one coalesced `{type:'resync', session}` request, ignores more
deltas for that session, and resumes only after a full frame. The resync reply
is a full `output` frame with `reset:'resync'`.

Servers compare the complete serialized JSON UTF-8 sizes, including `cursor`,
and send a delta only when its prefix is non-zero and it is strictly smaller
than the corresponding full frame. A resize response is always a full output
with `reset:'resize'`; it is never a delta.

## Timing model

- Output detection: `pipe-pane` dirty signals debounced 15 ms (100 ms max
  wait); polling fallback at 4 FPS idle, 10 FPS for 5 s after a keystroke.
- The first snapshot for a subscription is a full state. Later output may use
  a validated delta; an invalid or stale base is recovered by the resync
  exchange above.
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

## Upload endpoint (createUploadHandler)

`POST /api/upload` (multipart, field `files`, ≤10 files) → `201 {ok:true, files:[{original,
stored}]}`. Stored names are sanitized to `<epoch-ms>_<entropy>_<cleaned>` — path components
stripped, `[^\w.-]` runs collapsed to `_`, leading dots/underscores removed, 80-char cap — so
hostile filenames cannot escape the upload dir. Oversized → `413`; malformed form → `400`.
`formatUploadMessage` turns the response into the composer prefill
(`Uploaded "orig" → dir/stored`, one line per file).

## Preferences endpoint (createPrefsHandler)

`GET /api/prefs` → the whole prefs JSON (`{}` before first save). `PUT` (or POST) with a
JSON object → shallow merge-patch (top-level keys replace), persisted with an atomic
tmp+rename write; returns the merged result. `400` malformed/non-object, `413` >256 KB,
`405` otherwise. Pair with `createServerPrefs()` from @thumbmux/svelte (localStorage
cache + optimistic saves).

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
