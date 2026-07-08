# Changelog

Consumers pin the immutable `vX.Y.Z-dist` tags (prebuilt dists, no lifecycle
scripts): `thumbmux@github:kemkem23/thumbmux#v0.2.3-dist`.

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
