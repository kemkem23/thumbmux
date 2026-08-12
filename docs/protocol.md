# The thumbmux WS protocol

One WebSocket multiplexes every session. All frames are JSON. Types live in
`thumbmux/core` (`protocol.ts`); server behavior is enforced by
`server/tests/conformance.test.ts`, which any alternative server can reuse.

## Client → server

| type | fields | semantics |
|---|---|---|
| `subscribe` | `session`, `tail?`, `delta?`, `client?` | start streaming a session to this socket. `tail: N` = slice frames to the last N **non-blank-trimmed** pane lines (thumbnail mode). `delta: true` opts this subscription into delta output frames; without that opt-in, a subscriber receives classic full output frames forever. Re-subscribing with a different `tail` updates the preference; omitting it upgrades to full frames. An immediate snapshot is sent (cached first, then a fresh capture). |
| `unsubscribe` | `session` | stop streaming; per-socket state for the session is dropped. |
| `keys` | `session`, `data` | write raw bytes to the pane (IME text, control sequences — `\r`, `\x1b[A`, …). Deliberately carries no client blob: this is the hot path. |
| `resize` | `session`, `cols`, `rows`, `client?` | request pane geometry. The host's `onResizeRequest` hook may veto (e.g. a phone holds the size). |
| `history_expand` | `session`, `beforeLine?`, `afterLine?`, `limit?` | page archived scrollback backward or forward (if the host wired that direction). Reply: `history`. |
| `resync` | `session` | after rejecting a missing/stale delta, request one complete output frame. The server replies with `reset:'resync'`. Hosts with a custom WS message switch **must** forward this message to `TmuxWsMux.handleMessage()` (or equivalent `handleResync` routing) whenever they forward `delta: true`; otherwise the viewer can remain frozen after its first rejected delta. |
| `sessions_subscribe` / `sessions_unsubscribe` | — | join/leave the `__sessions` list channel. |
| `ping` | `client` | keepalive; client sends optional browser descriptor (`{ type:"ping", client }`) and server replies `{"type":"pong"}`. Clients close after 8 s without a pong. |
| `client_info` | `client` | forward this socket's descriptor (visibility, viewport, host telemetry id) to the host's optional `onClientInfo` hook; the mux does not retain it. |

## Server → client

| frame | semantics |
|---|---|
| `{channel, type:"output", data, cursor?}` | full pane snapshot (or the tail slice for tail subscribers). In the regular path it is sent when the content hash changed, but cached startup snapshots and cache-driven resync/catch-up replies can also send full output without a hash delta; a resize or resync path also emits reset output frames. `cursor` is `{row, col}` (`row` counts up from the last content line, trailing blanks trimmed; same convention for tail slices; NEGATIVE row = caret sits \|row\| blank rows BELOW the last content line, e.g. a shell waiting after newline-terminated output) or `null` when hidden; present when the driver supplies cursor state. |
| `{channel, type:"cursor", cursor}` | caret-only update: the cursor moved but the pane content did not (arrow keys on a shell line), so the snapshot is not re-sent. Carries no `data` — clients that render output must check `type` first. Emitted only on the `captureWithCursor` driver path. |
| `{channel, type:"history", data}` | `history_expand` reply — `data` is a JSON-encoded string of `{lines, startLine, hasMore}`. The frame echoes neither the requested direction/cursor nor a request token. A missing archive, an unsupported forward read, or an archive read that throws uses `{lines:[], startLine:null, hasMore:false}` as a synchronous fallback. Archive-error logging is best effort: a throwing host logger cannot suppress the mux's single reply attempt. Delivery still depends on `ws.send` succeeding, so clients should retain their own request timeout and recovery. |
| `{channel, type:"error", data}` | e.g. the session disappeared. A host-driven `invalidateSession()` makes one final send attempt to each affected WebSocket subscriber before that session lifecycle goes quiet. |
| `{channel:"__sessions", type:"sessions", data}` | session list — `data` is a JSON-encoded **string** (parse it), like every `data` field on this table; pushed on subscribe and whenever the list changes (~5 s cadence). |
| `{type:"pong"}` | ping reply. |
| `{type:"auth_error", status, code}` | Authorization denial from the packaged guarded route. `createAppRoutes({ guard })` emits it on an established WebSocket when the socket cannot be bound to an active principal or the guard rejects an inbound mux message. `status` is `401` or `403`; `code` is the guard's machine-readable reason. `createAppRoutes()` with no `guard`, and a bare `TmuxWsMux`, do not emit it. |

`auth_error` deliberately has no `channel`. The denial belongs to the
WebSocket or attempted operation, not to an authorized session stream, and
some denials occur before there is a valid session-scoped message to route.
The bundled v0.7.1 client parses and safely discards this channel-less frame
without invoking a subscriber or throwing. The current bundled client handles
a valid `auth_error` before channel routing and, in a browser, dispatches
`thumbmux:auth-error` on `window`, with the frame in `CustomEvent.detail`.

Custom WebSocket readers used with a guarded route must dispatch on `type`
before requiring fields that belong only to known frame kinds, such as
`channel`. If `type` is unknown, ignore the complete frame; do not reject it as
a malformed known frame. Readers that support this denial can use
`MuxAuthErrorFrame`, or `MuxServerFrame` when they handle both session frames
and authorization denials. A strict custom reader must adopt this rule before
its host uses a guarded `createAppRoutes`; without the `guard` option, the
packaged route never emits `auth_error`.

### Host-driven session invalidation

Deleting a tmux pane/session is a host lifecycle event, not a client protocol
message. The deletion path should tell the mux explicitly:

```ts
const affectedViewers = mux.invalidateSession(session, {
  reason: 'Session terminated by host',
  purgeArchive: true,
});
```

`invalidateSession(session, opts?)` returns the number of unique WebSocket
subscribers that were attached when it was called. It always detaches those
subscribers and makes one final send attempt to each of them with a
`{channel, type:"error", data: reason}` frame; the default reason is
`Session not found`. It also stops that session's pipe and
timers, discards queued work, and fences already-running captures so they
cannot send a late frame or populate a new session that later reuses the same
name. After the method returns, the invalidated lifecycle produces no more
capture attempts, output frames, cursor frames, or repeated error frames.

This is a wire-level terminal signal, subject to the WebSocket adapter's normal
delivery semantics: a `-1` result is tracked as queued backpressure, while a
throwing transport cannot be made to deliver. UI integrations must surface
`error` frames if an operator needs a visible message; the bundled Svelte
terminal and thumbnail components currently discard them. Invalidation also
does not synthesize `onUnsubscribe`: the mux does not retain each
subscription's `client` argument. A host that keeps policy or accounting state
in that hook should release it alongside its own session-deletion operation.

The public options are deliberately limited to `reason` and `purgeArchive`.
Notification and detachment are invariants rather than switches: allowing
`notify:false` would make the terminal disappear silently, while
`detach:false` would preserve the capture/error loop this API exists to stop.
`purgeArchive` defaults to `false` because deleting durable history is a
destructive decision. When it is true, the mux calls the optional
`HistoryArchiveLike.dropSession(session)`; `FileHistoryArchive` implements it
by clearing both cached state and persisted data. Older custom archives remain
compatible because the method is optional, and archive deletion failure does
not undo viewer teardown or suppress the final signal.

There is intentionally no `onCaptureError` hook or `errorFrameMode` option in
this change. A generic capture failure does not prove that a session is dead:
tmux reloads, transient process errors, and temporary resource pressure must
retain the existing per-attempt error behavior. The host, which owns the
terminal deletion operation, is the component that can identify a terminal
lifecycle event and call `invalidateSession()` without changing defaults for
current consumers.

### Archive history paging

A request selects one direction. Include `afterLine` (even when null) for
forward paging; otherwise the request pages backward and may include
`beforeLine`. `beforeLine: N` returns the archived rows nearest the anchor whose
logical line numbers are `< N`, up to the effective page limit. A null or
omitted `beforeLine` reads the newest archived page before the live window.
This is the original paging behavior and remains unchanged for existing
clients.

`afterLine: N` returns the first archived rows whose logical line numbers are
`> N`, up to the effective page limit; `afterLine: null` starts at the oldest
row the archive still retains. The presence of `afterLine` selects forward
paging, including when its value is null or zero. If a malformed request
supplies both cursors, `afterLine` takes precedence.

Rows are always returned in display order. `startLine` is the actual logical
number of the first returned row and can be greater than `afterLine + 1` when
the archive has evicted an older prefix. `hasMore` is relative to the requested
direction: older rows for `beforeLine`, newer archived rows for `afterLine`.

`limit` is a page-size budget. When it is omitted, the effective limit is 500.
When a client supplies `limit <= 0`, archive implementations **must** use an
effective limit of 1 in both directions; they must not replace it with the
500-row default. The result can still be empty when no row exists beyond the
anchor. A one-row minimum lets pagination make progress without turning an
invalid or sentinel-sized request into an unexpectedly large response.

`limit` is an upper bound the server may lower. An implementation is allowed to
cap a page below what the client asked for — a host archive might cap at, say,
2000 rows so one request cannot pull an unbounded slab off disk — and it signals the
remainder through `hasMore`, not through the returned row count. So a client
**must not** treat `lines.length < limit` as end-of-archive: `hasMore` is the
only authority. The two reference archives differ here (`FileHistoryArchive`
imposes no cap of its own), which is exactly why the rule is stated rather than
left to whichever one a client happened to test against.

The current `history` frame has no direction marker, echoed anchor, or request
token. A client that can page in both directions must therefore keep at most
one `history_expand` request outstanding per session on a WebSocket: remember
its direction locally, wait for that session's `history` reply, and only then
request the other direction. Do not issue concurrent before/after requests or
try to infer their direction from `startLine`, `hasMore`, or row order; those
fields are valid in both directions.

The bundled `TmuxMux` applies that rule to both public paging methods:
`requestHistory(session, beforeLine?, limit?)` pages backward and
`requestHistoryAfter(session, afterLine, limit?)` pages forward. They share a
per-session lease that records the socket on which the request was written.
Both return `true` only when the frame was written to that socket. They return
`false` when the mux is disposed, the socket is not open or rejects the send,
or another history request for that session is outstanding. A caller may
establish local state before the call to tolerate a synchronous test double,
but it must roll that state back on `false`; rejected calls are not queued.
Different sessions can page concurrently during normal operation.

If an accepted request times out, call `recoverHistoryRequest(session)` before
retrying. It returns `false` when that session has no request to abandon.
Only the caller whose paging method returned `true` may recover that lease; a
caller rejected with `false` does not own it and must not cancel it.
When the request still belongs to the current shared socket, recovery detaches
and closes that socket and attempts to start a replacement connection. Every
active session briefly reconnects and re-subscribes because one WebSocket
carries them all. When an unrelated disconnect already retired the request's
socket, recovery only settles that stale lease; it does not close the
replacement. Either path returns `true`, and retry must wait until a socket is
open.

A retired socket's leases deliberately survive until their original callers
recover. This prevents a still-active caller from consuming a new caller's
broadcast reply after reconnect, including when a different session forced the
shared socket replacement. Late frames from the retired socket are fenced by
both handler detachment and socket identity checks. `TermView` performs
recovery after its 5-second archive-reply timeout and when it unmounts with an
accepted request still outstanding.

#### History page overlap with the live window (normative for hosts)

The bundled `TermView` **does not content-de-duplicate** an archive page against
rows it already holds in the live / already-mounted window. A successful
`history` reply is prepended as the server sent it (subject only to the viewer's
own row/byte retention budget, which may drop the **oldest prefix of the
incoming page**, never rows already on screen).

Therefore a host archive **must not** return rows the client already has for
that session. Use the `beforeLine` / `afterLine` anchors: `beforeLine: N` means
logical lines strictly `< N`, which is the edge of the client's current oldest
mounted line when paging backward. Overlapping pages produce duplicated rows in
the viewer; that is host error, not a client merge step you can rely on.

Live **capture** merging is a different path (`findLineOverlap` on successive
full/delta frames) and must not be confused with archive prepend.

#### Live-window bootstrap and the archive boundary (normative for hosts)

`TmuxWsMux` seeds a session's archive once, from a full-history capture, splitting
it at `liveLineLimit`: everything older is archived, the newest `liveLineLimit`
rows become the live window. After a successful seed, every later capture —
including a reopen after the last viewer left — uses the **full** live depth
(`DEFAULT_CAPTURE_START_LINE = -liveLineLimit`), not the short first-paint
window (`INITIAL_CAPTURE_START_LINE = -min(250, liveLineLimit)`).

That choice is load-bearing. The archive's newest row ends at
`total − liveLineLimit`. A narrow reopen bootstrap beginning near
`total − 250 − paneRows` leaves a multi-hundred-line gap that
`history_expand` cannot fill, because expand only returns what was archived.
Hosts that reconcile scrolled-off rows only when the mux still holds
`previousContent` are especially exposed: `dropSessionState` clears that cache
when the last viewer unsubscribes, so a shrink on reopen permanently loses the
seam. `FileHistoryArchive` keeps its own live window and reconciles through
`stableOverlap`; a custom archive must do the same (or equivalent) and must treat
a capture narrower than the prior live window as a **shrink to reconcile**, not
as a repaint that discards the middle.

#### Two kinds of missing rows, one label

Rows can go missing in two unrelated ways, and only one of them is labelled.
When **client retention** evicts a span, the boundary carries `data-gap-rows`, a
`.mtv-gap-marker` element, and the accessible label `N rows dropped before this
row`. When the **server** delivers a live window that does not abut its own
archive, the client has no structural way to know rows are absent and renders
the boundary as two ordinary adjacent rows unless the host embeds a visible
marker in the archived text. Do not read the absence of a gap marker as proof
that history is contiguous.

#### Client retention budgets and what the user sees at the ceiling

`TermView` retains at most 10,000 rows or ~8 MiB of history, whichever fills
first, and once the budget is full it stops requesting older pages entirely —
it does not evict older rows to make room for more. The budget is not
configurable through props. **The stop is not signposted.** The oldest retained
row renders like any other row: no marker distinguishing "beginning of the
session" from "client stopped asking". Hosts exposing deeper scrollback should
render their own end-of-buffer affordance.

#### `TmuxWsMux` mutates the tmux session's `history-limit`

After a successful archive seed, the mux calls
`driver.setSessionHistoryLimit(session, liveLineLimit)`, permanently lowering
that tmux session's own scrollback to the live-window size. This is deliberate —
the archive becomes the durable history and tmux keeps only a working window —
but it is destructive and is not reversed when the archive is deleted. Any host
tooling that reads deep scrollback straight from tmux (`capture-pane -S -`) for
the same session must be sized against `liveLineLimit`, not against the tmux
global.

#### `sessions_subscribe` idempotency

`TmuxWsMux.subscribeSessions(ws)` stores subscribers in a `Set`. Subscribing the
**same socket** more than once is a **no-op** for membership: the socket still
receives each session-list push **exactly once** per broadcast. Calling
`sessions_subscribe` again may still trigger an immediate list push to that
socket (catch-up / resync), but it does not create a second delivery slot.
`sessions_unsubscribe` removes the socket and cancels any owed list debt.
Hosts that both auto-subscribe on WebSocket open and let the bundled client
send `sessions_subscribe` are safe under this rule.

The socket boundary is deliberate. Expiring the gate on the same socket, or
relying only on a component-local request id, cannot correlate a tokenless late
reply once a retry is active. That reply could belong to a different anchor or
direction and be applied as the retry; merely reporting rejection would expose
the deadlock without restoring progress. Connection recovery plus the boolean
acceptance result preserves both unambiguous attribution and retry liveness.

Custom hosts remain source-compatible because `HistoryArchiveLike.readAfter`
is optional. A host must implement it to support forward paging; otherwise the
mux sends the explicit empty page above without throwing, while before-only
requests still call `readBefore` exactly as before. Hosts with a custom
WebSocket switch must preserve `afterLine` and route the message through
`TmuxWsMux.handleMessage()` or call `expandHistoryAfter()` themselves.

### Output deltas and resync

A full `output` frame establishes its raw base as `data.split('\n')`. That
split is exact: a trailing empty element is part of the base and is never
trimmed or normalised before hashing.

Only after a subscriber opts in with `delta: true`, a server may send after a
full frame:

```ts
import { muxPrefixHash, type MuxDeltaFrame } from 'thumbmux/core';

const base = Array.from({ length: 2_000 }, (_, line) => `line ${line}`);
const prefix = base.length - 1;
const deltaFrame: MuxDeltaFrame = {
  channel: 'my-session',
  type: 'delta',
  baseLength: base.length,
  prefix,
  prefixHash: muxPrefixHash(base.slice(0, prefix)),
  lines: ['updated final line'],
  cursor: null,
};
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
is a full `output` frame with `reset:'resync'`. A host that routes parsed client
messages with its own switch must forward `resync` together with the subscribe
`delta` flag; the two parts form one recovery contract.

Servers compare the complete serialized JSON UTF-8 sizes, including `cursor`,
and send a delta only when its prefix is non-zero and it is strictly smaller
than the corresponding full frame. A resize response is always a full output
with `reset:'resize'`; it is never a delta.

## Timing model

- Output detection: `pipe-pane` dirty signals debounced 15 ms (100 ms max
  wait); polling fallback at 4 FPS idle, 10 FPS for 5 s after a keystroke.
- The first snapshot for a subscription is a full state. Later output may use
  a validated delta only for subscribers that opted in with `delta: true`; a
  subscriber without that opt-in receives classic full output frames forever.
  An invalid or stale opted-in base is recovered by the resync exchange above.
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

### Reference Bun driver target resolution

`createBunTmuxDriver()` treats every session name as an exact tmux target by
default. This matters after a session disappears: tmux normally resolves a bare
target by exact name, then prefix, then fnmatch, so a stale request for `agent`
could otherwise operate on `agent-2`. The exact policy also covers the command
delivery performed by `spawnTmuxSession()` and the destructive
`killTmuxSession()` helper.

tmux uses different target grammars internally. Pane/window operations receive
`=name:` while `kill-session` receives `=name`. Callers still pass the ordinary
session name returned by `listSessions()`; do not add either marker yourself. A
literal session name beginning with `=` is supported: `=agent` becomes
`==agent:` for pane/window operations and `==agent` for `kill-session`, which
selects the leading-equals name exactly.

Hosts that intentionally use tmux prefix or pattern resolution can opt out
explicitly:

```ts
const driver = createBunTmuxDriver({ targetMode: "legacy" });
spawnTmuxSession(name, cwd, command, { targetMode: "legacy" });
killTmuxSession(name, { targetMode: "legacy" });
```

The option is per driver or per helper call, rather than mutable module state,
so exact and legacy integrations can coexist without changing one another.
`legacy` passes the name through unchanged and therefore restores both prefix
and fnmatch resolution; use it only when that behavior is deliberate.

## Upload endpoint (createUploadHandler)

`POST /api/upload` (multipart; File values in field `files`) → `201 {ok:true,
files:[{original, stored}], dir}`. Other methods return `405` with `Allow: POST`. Only `files`
values are persisted, but the resource limits cover the whole decoded form: `maxFiles` defaults
to 10 and counts File/Blob values in every field, and `maxBytesPerFile` defaults to 200 MiB and
checks each of them. Optional `maxTotalBytes` (unlimited when omitted) sums every decoded value —
UTF-8 bytes for strings plus File/Blob byte sizes — but excludes multipart boundaries and headers.
Count and per-file errors take precedence over the total and return `413`. For an otherwise-valid
upload, exceeding the total also returns `413`; malformed forms or no usable `files` return `400`.
All of these checks happen before the handler creates an upload file.

The platform's native `request.formData()` must parse/buffer the multipart body before those
decoded sizes are available. Consequently `maxTotalBytes` is not a pre-parse raw-body or memory
limit; hosts that need one must also enforce a wire-body limit in their HTTP server or reverse
proxy. `dir` is the normalized absolute path returned by `resolve(opts.dir)`, not the raw option.
The configured directory and its parent path are a host-controlled trust boundary (parent
symlinks are followed). Within it, stored names are sanitized to
`<epoch-ms>_<entropy>_<cleaned>` — path components stripped, `[^\w.-]` runs collapsed to `_`,
leading dots/underscores removed, 80-char cleaned-name cap. Files are created exclusively and
name collisions are retried, so attacker filenames cannot traverse out of `dir` and an existing
leaf file or symlink is neither followed nor overwritten.
`formatUploadMessage(files, dir)` turns the returned mapping and directory into the composer
prefill (`Uploaded "orig" → dir/stored`, one line per file).

## Preferences endpoint (createPrefsHandler)

`GET /api/prefs` → the whole prefs JSON (`{}` before first save). `PUT` (or POST) with a
JSON object → shallow merge-patch (top-level keys replace), persisted with an atomic
tmp+rename write; returns the merged result. `400` malformed/non-object; `413` when the
decoded request text exceeds 262,144 UTF-16 code units (this is not a byte limit); `405`
otherwise. Pair with `createServerPrefs()` from `thumbmux/svelte` (localStorage cache +
optimistic saves).

**One handler stores one shared document, and it authenticates nobody.** This is a
deliberate single-tenant boundary, not an oversight: `TokenPrincipal` carries no stable
subject, so the guard cannot partition storage per user. Mounting this handler directly on
a multi-user deployment shares every viewer's preferences with every other viewer. Protect
it with the `prefs-read` / `prefs-write` operations — see
[the token-guard contract](security.md) — and treat authorization as protecting one shared
resource rather than as separating data. A `__proto__` key in the patch body is dropped
rather than merged.

## Deployment notes

- **HTTP/2 and the WS upgrade:** WebSocket's `Upgrade` header does not exist
  in HTTP/2, so `server.upgrade()`-style handshakes fail on connections a
  reverse proxy negotiated as h2 (a curl probe with `-H "Upgrade: websocket"`
  gets `200`, not `101`). Real browsers open WebSockets over HTTP/1.1, so
  users are unaffected — but point automated health checks at HTTP/1.1.
- **Wide glyphs:** caret placement is best-effort with mixed-width and emoji
  sequences: `prefixForCells` uses an approximate width table (`thumbmux/core`)
  and does not preserve every ZWJ/variation-sequence grapheme as a unit. The
  client still measures the reconstructed prefix with the live font, but some
  Thai/CJK/emoji combinations can remain approximate. Link tap-target columns are
  **no longer** among them: `collectTerminalUrlSegments` and `findTerminalUrlAtCell`
  convert UTF-16 offsets to cell columns (`utf16ToCellOffset`, CJK 2 cells,
  combining marks 0), so a link after wide or combining text is hittable where it
  is drawn.
