# Changelog

Consumers pin the immutable `vX.Y.Z-dist` tags (prebuilt dists, no lifecycle
scripts): `thumbmux@github:<owner>/<repo>#v0.4.0-dist`.

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
