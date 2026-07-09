# Changelog

Consumers pin the immutable `vX.Y.Z-dist` tags (prebuilt dists, no lifecycle
scripts): `thumbmux@github:<owner>/<repo>#v0.3.1-dist`.

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
