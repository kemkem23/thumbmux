# Changelog

Consumers pin the immutable `vX.Y.Z-dist` tags (prebuilt dists, no lifecycle
scripts): `thumbmux@github:<owner>/<repo>#v0.6.0-dist`.

## v0.6.0 — 2026-07-30
Plug-and-play, finished. v0.5.0 shipped components a consumer could mount; this
release makes the surrounding contract real — the pieces that were written but
not exported, the fields that existed but were undiscoverable, and the docs that
told outside readers to import names only this repo has.

Four consumer-visible changes to know about. The first two close data-loss bugs:

1. **A malformed 2xx from the prefs endpoint now REJECTS** instead of resolving.
   Callers that ignored the promise will see a rejection where they previously
   saw silent success. The old behaviour is what let a `200 {}` replace a user's
   saved shortcuts with nothing.
2. **`UploadAction` treats a 2xx whose body has no usable `files` as an error**
   and no longer calls `onUploaded` with empty values.
3. **A custom `TmuxDriver` or session-list provider may stop compiling.**
   `listSessions()` returns `SessionListItem[]` instead of `unknown[]`, and
   `activityAt` is required, so a TypeScript host that returns rows without it now
   fails to typecheck. Runtime is unaffected; add the field from your own activity
   source, or `0` if you have none.
4. **`onScrollStateChange` is boundary-only.** It fires when the scrolled-up flag
   flips, not on every offset change, and no callback reports the initial state. A
   host that mirrored the raw offset from this callback must read it another way.

### Newly exported — code that existed but never shipped
- **`FileHistoryArchive`** (`thumbmux/server`): a complete `HistoryArchiveLike`
  with 444 lines of tests, previously stranded in `demo/` and excluded from the
  release tag's `files` whitelist. Deep scrollback no longer requires writing
  your own archive.
- **`createSpawnHandler`** (`thumbmux/server`): the route that accepts what
  `LaunchSheet`/`buildLaunchCommand` actually emit — naming, collision → 409,
  command assembly, cleanup on a failed spawn. Worktree creation stays a
  host-supplied hook rather than hardcoded git. Two real cases the tests forced
  out: a name taken between check and spawn, and a leaked reservation.
- **`SessionListItem`** (`thumbmux/core`): the `__sessions` payload was
  `unknown[]`, so its fields were undiscoverable without reading the driver. Now
  typed and documented per field, with **`activityAt`** added from the activity
  sample the poll already takes — no extra tmux call per poll, asserted by test.
- **`DEFAULT_PROMPT_MATCHERS`** + a `matchers` option on the prompt-scan APIs.
  The cc/codex/grok composer heuristics were the one place a host's assumptions
  were baked into the package; they are now a swappable default. Omitting the
  option is byte-identical to before.

### Docs a reader can actually copy
- `desktop.md`, `protocol.md` and `recording.md` told readers to import
  `@thumbmux/core` and `@thumbmux/svelte`. **Those names do not exist for
  consumers** — they are internal aliases of the host repo; the shipped subpaths
  are `thumbmux/core`, `thumbmux/server`, `thumbmux/svelte`. Every snippet is
  corrected, and `docs-snippets.test.ts` now checks every import specifier in the
  docs against `package.json` exports and parses every `json` fence, so this
  cannot silently return.
- New **`docs/hub.md`**, including what the hub does *not* provide: agent-state
  classification, durable prompt history, a deep-scrollback archive, host spawn
  policy. A consumer expecting state dots for free would otherwise conclude the
  hub is broken.
- Fixed: a Svelte example where `...` parsed as a boolean prop named `"..."`, a
  `json` block that failed `JSON.parse`, `TermView` signatures drifted from
  source, `security.md` documenting `revoke(token)` and then disclaiming
  revocation (now scoped to one guard instance), and the prefs limit described in
  KB when it counts UTF-16 code units.

### TermView — the five hot-path defects deferred from v0.4.0
Counted metrics below are measured before and after on the same fixtures and are
reproducible from the shipped tests; where a wall-clock figure appears it is called
out as a point measurement.
- Viewport layout read on every scroll frame: **138 → 0** reads per gesture.
- `data-bottom-offset` writes and host callbacks on every compositor frame:
  attribute mutations **114 → 1** and callbacks across an unchanged boundary
  **137 → 0**, both reproducible from the shipped test. The wall-clock win on that
  fling is smaller than these counts suggest and is **not** an end-state budget: an
  independent re-measurement against the correct baseline gives ~2.2 → ~1.2 ms
  isolated, while the shipped tree lands ~2.4-2.8 ms on the same fixture because a
  later change trades some of it back to remove jank.
- Virtualized DOM rebuilt mid-momentum: key-set rebuilds **2 → 0**.
- History parsed and measured during a fling: `getBoundingClientRect`
  **234 → 0**, DOM commits while busy **1 → 0**.
- `getBoundingClientRect` per alt-screen touchmove: **10 → 1**, with the emitted
  SGR bytes pinned so grok's touch scrolling cannot drift.
- **Retained history is now capped** with eviction, and per-page cost is flat
  rather than linear: page-150/page-10 commit ratio **4.03× → 0.94×** on one run of
  this host — a wall-clock point measurement that moves run to run, so treat the
  direction as the claim, not the figures. Rows in
  the viewport plus overscan are never evicted, even if they alone exceed the
  budget. **Known limit, read this if you rely on deep scrollback:** past the cap the
  view is spliced WITHOUT a marker — an older archive row can render directly above
  the live tail, and the prepend-only protocol has no way to re-request the evicted
  span, so scrolling back down does not restore it. A gap row and a scroll-back-down
  test are next release. Still open too: sparse SGR checkpoints.

### Correctness
- **prefs**: an empty or key-missing GET no longer overwrites the cache; a failed
  PUT restores the previous snapshot instead of stranding optimistic state;
  overlapping PUTs serialize; a `load()` begun during a pending PUT no longer
  accepts the stale GET; a subscriber writing back during its own notification no
  longer re-enters.
- **`UploadAction`**: `busy` releases when the last request settles, not the
  first, and the response's `dir` wins over the client prop so a server-side path
  change cannot silently produce a message pointing at nothing.
- **Upload response carries `dir`** — the resolved absolute directory, not the
  caller's raw option.
- **`bottomInsetPx` warns in dev** when it is fractional, negative, NaN/Infinity,
  or ≥ viewport height. Being 8px wrong silently deletes the top row, and
  headless browsers resolve `env(safe-area-*)` to 0, so no test can catch it.

### Tests
- The four exported components that shipped with **zero** tests — `UploadAction`,
  `PromptsPanel`, `NotePanel`, `ShortcutsSheet` — now have 30 tests, each
  assertion group proven by mutating a throwaway copy until it fails. The earlier
  mount smoke asserted the `.svelte` file was text, which is how a component that
  throws on mount once passed.
- **`smoke:git-dist` checks every public export resolves for a consumer** under the
  documented `bundler` resolution, deriving the
  expected surface from each subpackage index rather than a frozen list — a
  frozen list is the v0.4.0 defect in new clothes. It checks type declarations
  too, without which a type-only export is invisible. On its first run it found
  the tree's git-dist missing 4 core and 7 server declarations.
- **`dogfooding.test.ts`** fails if the demo reimplements something the package
  ships, parsing import specifiers rather than substring-matching. The
  plug-and-play audit found that pattern four separate times, each caught only by
  a human reading code.

## v0.5.0 — 2026-07-28
Performance and safety work on paths that already shipped in v0.3.5 / v0.4.0 —
no new product features. This is a **minor**, not a patch, because two changes
are things a consumer must know about even though neither breaks the prior
contract:

1. **WebSocket backpressure is ON BY DEFAULT** and changes live wire behaviour:
   a socket whose `send()` reports enqueue-pressure stops receiving server
   pushes until it drains. Hosts should wire Bun's
   `websocket.drain(ws) → mux.handleDrain(ws)`; without that, recovery relies
   on an auto-resume that needs the adapter to report a buffered amount.
   Legacy keep-sending-on-`-1` behaviour is reachable via
   `backpressure: { enabled: false }`.
2. **`MuxHooks.filterSessionList(sessions, ws, client)`** is a new public hook
   on every session-list delivery path. With no hook configured the path is
   byte-identical to before.

### Server broadcast & backpressure
- **Delta broadcast is flat in viewer count**: viewers are grouped by
  `(tail, reset, delta-base identity)` and one serialized frame is fanned
  out. Measured on this host for one changed line on a 2,000-row pane to
  20 delta subscribers: **69.2 ms → 3.9 ms** at 160 KB, **159.2 ms → 8.5 ms**
  at 400 KB; at 50 viewers **167.5 ms → 3.6 ms**.
- **WebSocket backpressure (default on)**: a socket that never drains was
  handed **15.99 MB / 101 frames** over ~10 s of a scrolling pane; now
  **0.16 MB / 1 frame**, with optional shedding of a chronically slow peer
  (`maxBlockedMs` / `maxBufferedBytes`). Hosts should wire
  `websocket.drain(ws) → mux.handleDrain(ws)` for the fast path;
  auto-resume covers adapters that can report buffered amount. Escape hatch:
  `backpressure: { enabled: false }`.
- **`filterSessionList` hook**: session-list broadcasts pass through a
  per-socket filter on all delivery paths (initial reply, both broadcast
  loops, and drain catch-up). A throwing hook fails closed. No hook →
  byte-identical to the previous release.
- **Multi-file uploads are all-or-nothing**: every file and the optional
  request total (`maxTotalBytes`) are validated before anything is written;
  a later failure removes the files already created for that request.

### Client delta path
- **Delta application**: **14.49 ms → 0.094 ms** median (~150×), i.e. ~88×
  under the 8.33 ms 120 Hz frame budget. Two wins: an already-validated
  frame is no longer re-validated and re-hashed, and the prefix hash is now
  incremental instead of hashing the whole base.
- **`deferWhileBusy` subscribe option** (opt-in): queues raw delta frames
  while a view reports a gesture in progress. It is deliberately **not**
  wired by any in-tree surface — TermView already enforces
  no-work-during-gesture via its content-update gate, and with the client
  path now ~88× under budget the remaining gain did not justify activating a
  path that forces a full resync at the end of a gesture. Do not assume it
  is live unless you pass the option yourself.

### Core hot paths
- **`fnv1a32`**: the previous for-of over `TextEncoder` bytes used the
  iterator protocol per byte; an indexed loop over the encoded bytes is
  **5.67 ms → 0.71 ms** on 335 KB (8×) and byte-identical across 20,210
  checked inputs including lone surrogates and astral characters. Speeds
  every caller: server delta creation, the frame journal, and replay.
- **Wrapped-URL detection** was quadratic: **1,266 ms → 1.2 ms** at 2,000
  rows. Scheme rule: a continuation row beginning with a scheme no longer
  ends the URL when the accumulated URL is mid-parameter, so an embedded
  unencoded `redirect_uri=https://…` that wraps exactly at the embedded
  scheme is reconstructed whole again (it regressed briefly during this work
  and is fixed; verified across every pane width from 20 to 120).
- **Capture-overlap detection** had a quadratic worst case on repeated lines
  (a progress log or a spinner hits it in ordinary use): **7.06 ms → 0.38 ms**
  on the degenerate 2,000-row case. The original descending scan is **kept**
  as the fast path under a comparison budget, because replacing it outright
  with a linear algorithm measured **10× slower** on the common case.

### Release-blocker fixes
- **No-archive scrollback stays deep**: without a `HistoryArchiveLike`, the
  first paint showed full history but the next update collapsed to roughly
  270 lines while `history_expand` could only return an empty page. The same
  script with only `ws-mux.ts` swapped measured old **801 → 273 → 269**
  lines versus new **801 → 801 → 801**. A successful bootstrap now keeps
  the normal live depth, and late or concurrent subscribers do not repeat the
  full-history capture.
- **Svelte peer requirements are visible at install time**: the root
  `thumbmux` package that consumers install now declares `svelte: ^5`, and
  `@thumbmux/svelte` uses the same normalized range. Previously `npm i` could
  succeed without warning that Svelte was missing, leaving the installed
  Svelte entrypoint unable to compile.
- **One-call terminal theming**: new `defaultSurface(bg)` returns a complete
  surface with a ready-to-render 16-color `AnsiPalette`. The main README
  snippet previously called the two-argument `deriveSurface()` with one
  argument and then read a nonexistent `.palette`, forcing consumers to
  reconstruct `TerminalSurface` and roughly 25 lines of palette setup.
- **Optional server integrations are explicit**: the README now states that
  `PipeManagerLike` and `HistoryArchiveLike` are interfaces only; no
  implementations ship with the package. Without `pipes`, live output uses
  adaptive polling. Without `archive`, live viewing still works but history
  expansion is empty, so older archived scrollback is unavailable.
- **Preferences work on Node**: `createPrefsHandler` now uses
  `node:fs/promises`, atomic temporary-file + rename writes, and per-instance
  write serialization so concurrent device updates merge in order. Before
  this fix, Node GET returned `200 {}` despite preferences on disk and PUT
  threw; a client could then replace its cache with `{}`, silently losing the
  user's shortcuts.
- **Composer submission is paste-safe in the examples**: the README composer
  and the demo's composer/shortcut sends now execute `submitPlan()` instead of
  sending text and Enter in the same tick. The demo remembers the agent chosen
  at launch so agent-specific steps are preserved. The old pattern worked in
  a shell but agent TUIs could consume Enter as part of the bracketed paste and
  leave the prompt waiting in the composer.
- **The demo reports only real session data**: synthetic state, activity,
  grouping, and agent identity derived from a name hash or session name were
  removed, and e2e now asserts that unknown metadata stays absent. The demo's
  `bottomInsetPx` and visible-host CSS also share one inset calculation, so
  tmux is no longer resized behind controls and silently clips top lines.

## v0.4.0 — 2026-07-27
- **Scrollback search**: `core/src/search.ts` searches visible terminal text
  (control sequences stripped) in plain and bounded regex-lite modes, with hard
  caps on pattern length and match count. Svelte ships `TermSearch` plus
  `term-search` key/index helpers; `TermView` mounts the overlay and jumps
  matches without leaving the compositor path.
- **Modern SGR + OSC 8 hyperlinks**: `ansi-html` renders underline styles
  (`single` / `double` / `curly` / `dotted` / `dashed`), underline color, and
  OSC 8 href ranges as real anchors. Search highlight uses the same line path
  via overlay ranges (`search-match` / `search-active`).
- **`SgrState` non-breaking widen**: optional `underlineStyle`,
  `underlineColor`, and `osc8Href` were added. A v0.3.5 eight-field object
  literal still type-checks; missing fields read as `null`.
  `createSgrState` / `cloneSgrState` always materialise the full shape.
- **Record / replay**: `core/src/replay.ts` parses strict full/delta NDJSON
  journals and seeks with clamped floor semantics; `server` exports
  `FrameJournal` (nonblocking canonical NDJSON recorder with per-session FIFO
  queues). Svelte ships `RecordingPlayer` and pure `recording-player` helpers
  (speed steps, seek, bounded frame-HTML cache).
- **FrameJournal stabilization**: new aggregate `maxRootBytes` (default
  256 MiB; `Infinity` disables) beside the existing per-session `maxBytes`
  (default 64 MiB). Exported `DEFAULT_MAX_BYTES` /
  `DEFAULT_MAX_ROOT_BYTES`. New `deleteSessionJournal(session)` frees the
  durable file and root quota; `closeSession()` only drops in-memory state —
  the file remains and still counts toward root quota. A failed torn-write
  rollback now **fails closed** (session stops accepting until explicit
  recovery) instead of appending past corrupt bytes. `onError` phase
  `"limit"` covers both caps; `"drop"` covers `maxPendingWrites` saturation;
  non-integer cursor or invalid `reset` are rejected at admission (never
  persisted unreplayably).
- **Agent notifications + PWA scaffolding**: pure
  `normalizeAgentNotificationEvent` / `validateAgentNotificationEvent`
  contract in core; Svelte `notifications` helpers, `NotificationPermission`
  UI, and `service-worker` push/click handlers. Core does not deliver push —
  hosts own transport and permission UX (see `docs/notifications.md`).
- **Token guard**: `server/src/token-guard.ts` issues scoped, expiring
  bearer-token principals (`read` | `interactive`) with optional session
  allowlists, query bootstrap → host-only cookie, and HTTP/mux authorization
  tables. Issued principals are **frozen**; every authorization decision
  re-derives from the immutable grant snapshot, so mutating a principal
  object cannot widen scope, sessions, or expiry (see `docs/security.md`).
- **Svelte surface export**: `TermSearch`, `RecordingPlayer`,
  `NotificationPermission`, and the related pure helpers
  (`term-search`, `recording-player`, `notifications`, `service-worker`)
  are exported from `@thumbmux/svelte`.
- **Mount smoke tests**: Svelte components are mounted in a real DOM harness
  (`svelte/tests/mount-smoke.test.ts`). Earlier suites only grepped
  component source text and would not have caught a component that threw on
  every browser mount.
- **Dense search-overlay rendering is linear**: the previous per-boundary
  overlay rescan was quadratic. Measured on this host for 10,000 unit
  matches on one row: **482.75 ms → 7.44 ms**.
- **Git-dist release gate**: `assertGitDistInvariants` now checks real
  properties (zero unresolved quoted `@thumbmux/core` specifiers under
  `git-dist/`, required artifact presence, resolvable rewrites) instead of
  hardcoded file/replacement counts that broke whenever a module was added.
- An experimental native-prompt delivery path was cut before release; it is
  not part of this tag. Continue using `submitPlan` + Enter as before.

## v0.3.5 — 2026-07-10
- This tag supersedes `v0.3.4-dist`, which was generated during release
  validation but failed the post-workflow TypeScript/Vite consumer smoke; no
  GitHub Release was published for that ref.
- **Self-contained root git dist**: the release rail now copies built package
  output into a root-only `git-dist/`, rewrites that aggregate's internal core
  imports to the relative core dist shipped beside it, and points root exports
  at those copies. Fresh TypeScript, Node, Bun, and Vite/Svelte consumers no
  longer need an unpublished `@thumbmux/core` workspace package.
- Original core/server/Svelte dists stay byte-compatible with their standalone
  scoped-package contract; focused tests fail closed on missing builds and pin
  the aggregate rewrite without mutating package output.

## v0.3.4 — 2026-07-10
- **Delta output frames (opt-in wire perf)**: a subscriber that sends
  `delta: true` on subscribe receives replacement-suffix `type:"delta"`
  frames instead of full pane retransmits — FNV-1a-32 prefix hash, strict
  serialized-size gate (a delta is sent only when it is actually smaller),
  per-(socket, session) bases advanced only after successful send, and a
  one-shot coalesced `resync` recovery on any invalid/stale delta.
  Subscribers that never opt in keep receiving classic full output frames —
  bit-compatible with older servers/clients. Measured in the container e2e
  on suffix-heavy updates: **95% fewer wire bytes** vs full frames.
  The Svelte mux opts in automatically and still hands subscribers complete
  strings (new optional 4th callback arg identifies full/delta + reset).
- **Selection survives live output**: `TermView` defers content commits while
  a selection or gesture is active (keeping only the newest capture — no
  stale replay) and flushes once released; a drag-selection is byte-identical
  across appends.
- **Reflow on resize**: an accepted resize invalidates delta bases and the
  next capture is a full `reset:'resize'` frame — the live window re-wraps to
  the new width while archived history stays at its original wrapping
  (documented in `docs/reflow.md`).
- **Large paste hardening**: literal input over 8KB goes through
  `tmux load-buffer`/`paste-buffer -r` instead of `send-keys` argv (no length
  limits, no shell mangling or LF→CR rewrite); NUL-bearing control input uses
  the same stdin path. A 300-line/20KB browser paste arrives intact.
- **Demo hardening**: history archive extracted into a tested module; e2e
  controls stabilized (testids for bottom/new-content), and the whole e2e
  suite now hard-asserts previously known-gap behaviors (zero
  `markKnownGap` branches remain).
- **Adversarial closeout**: full/reset retries now survive true WebSocket
  drops without misclassifying Bun's queued backpressure; cursor-only updates
  recover per viewer; selection-gated resets keep replacement semantics
  without hiding later live output; reader anchoring tolerates two rewritten
  tail rows. The demo archive normalizes real tmux captures, rejects ambiguous
  repaint overlaps, avoids duplicate history churn, and defaults to private
  per-run storage (`0700` directory / `0600` files).
- Custom WS routers must forward `delta` opt-in and `resync` together; the
  protocol table now documents that recovery contract explicitly.
- CI and `release-dist` both run the complete source suite, production builds,
  and all 12 canonical clean-container e2e tests before packs or dist tags;
  `@playwright/test` is a workspace dev dependency.

## v0.3.3 — 2026-07-10
- **SessionGrid overhaul**: responsive column clamp with card-proportional
  thumbnail font (no more 6.5px on a 4K display), per-card state dots
  (universal green/gray via `--dot-working`/`--dot-idle`), filter chips +
  search + group-by, `recent` ordering, loading skeletons, and full arrow-key
  navigation. New public types in `session-grid` (GridSession, SessionGridProps, …).
- **SessionThumb**: fit-width tail rendering with right-edge fade and a
  readable thumbnail-only palette (contrast floor against the card surface).
- **Jank-free history expansion**: prepending an older-history batch no longer
  reparses the buffer or remounts rows — absolute row keys, state-convergent
  prepend (`core/prepend.ts`), rAF-sliced parsing, and a 2-viewport prefetch.
  Measured in the container e2e: p95 frame 16.7ms across three expansions.
- ws-mux: reconnect hardening (CONNECTING guard, stale-socket-safe sends,
  connect timeout, viewport-change client info).

## v0.3.2 — 2026-07-09
- `TmuxWsMux` option `compressFrames`: opts outbound frames into Bun's
  per-message deflate (`ws.send(data, true)`) — pairs with
  `perMessageDeflate: true` on Bun.serve. Default off (engine-agnostic).

## v0.3.1 — 2026-07-09
- `TermView` owns SGR touch forwarding when `altScreenMouse=true`; hosts no
  longer need to capture touch gestures for alt-screen TUIs.
- Core paste/submit helpers cover bracketed paste and delayed composer submit
  plans, including two-step Enter flows.
- `DesktopKeys` leaves Ctrl+Shift+C/V with the browser.
- Demo launcher includes an alt-screen mouse preset showing
  `claimGeometry=false`, `altScreenMouse=true`, and `onKeys` wiring.
- Root, core, server, and svelte package versions are aligned for the
  v0.3.1 dist rail.

## v0.3.0 — 2026-07-08
- Desktop keyboard input: `DesktopKeys` adds click-to-focus key routing,
  browser-native copy behavior, bracketed paste, paste warnings, and IME-safe
  composition handling.
- Core desktop helpers: `keyboardEventToSequence`, `bracketedPaste`, and SGR
  mouse sequence helpers for alt-screen TUIs.
- `TermView` can explicitly own pane geometry with `claimGeometry`, so full
  interactive terminals resize tmux while thumbnails and read-only views do
  not.
- `TermView` can optionally forward SGR wheel/click events to full-screen TUIs
  with `altScreenMouse`.
- Desktop interaction docs landed in `docs/desktop.md`.

## v0.2.3 — 2026-07-08
- ShortcutBar exposes its measured `barHeight` (bindable); the demo insets the
  terminal by it, so chips never cover the last pane rows.
- Terminal URL anchors get ~40px touch targets (inline vertical padding — no
  layout shift).

## v0.2.2 — 2026-07-08
- Release rail fix: `-dist` tags carry a `files` whitelist — npm packs git
  dependencies honoring `.gitignore`, which silently dropped committed dists.

## v0.2.1 — 2026-07-08
- Release rail fix: `-dist` tags strip the `prepare` script — npm always runs
  git-dependency prepare (bun blocks it), breaking installs in environments
  without bun.

## v0.2.0 — 2026-07-08
- ShortcutBar + ShortcutsSheet: one-tap prompt chips with a full manager
  (add/edit/reorder/delete), per-agent filtering, prefs-persisted.
- Paste a picture into the composer (COMPOSE or DIRECT) → the upload pipeline.
- NotePanel + PromptsPanel for the TermHud panel slot (session note with host
  action slots; recent prompts → composer prefill).
- Preferences: `PreferencesAdapter` (core), `createLocalPrefs` /
  `createServerPrefs` (svelte), `createPrefsHandler` (server) — merge-patch
  JSON config file with RFC-7386-style null-deletes, serialized atomic writes.
- `TermView.copyAll()/copySelection()` with a non-secure-context fallback;
  `paneTextForCopy` in core.
- Meta-package exports (`thumbmux/core|svelte|server`) + the `vX.Y.Z-dist`
  release rail (CI-built dists committed into immutable tags).

## v0.1.0 — 2026-07-08
- First tagged release: the fleet-hardened extraction — 120Hz compositor
  terminal, composer dock, session hub with live thumbnails, seven launch
  presets (real git worktrees), tmux WS mux engine (window-activity polling,
  atomic capture+cursor, pixel-accurate Thai/CJK caret), uploads, themes,
  protocol doc + conformance suite.
