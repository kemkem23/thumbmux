# thumbmux

**tmux for thumbs** — a mobile-first web terminal stack for watching and driving
terminal sessions (especially AI coding agents) from your phone.

Born from a real itch: running [Claude Code], Codex CLI and Grok CLI sessions on a
server and living inside them from an iPhone over Tailscale. Every existing web
terminal treated the phone as a tiny desktop. thumbmux treats the phone as the
primary device.

<p align="center">
  <img src="docs/media/viewer.png" width="19%" alt="Terminal viewer — 120Hz compositor scrolling, tappable links" />
  <img src="docs/media/menu.png" width="19%" alt="Single-launcher action menu with preset sends" />
  <img src="docs/media/composer.png" width="19%" alt="Composer dock — the sheet never covers the terminal" />
  <img src="docs/media/direct.png" width="19%" alt="DIRECT mode — the OS keyboard is the input" />
  <img src="docs/media/theme.png" width="19%" alt="Theme sheet — full surface derived from one color" />
</p>
<p align="center"><sub>
viewer · action menu · composer dock · DIRECT mode · theming — captured from the
production UI (labels currently Thai; English defaults are on the roadmap)
</sub></p>

## What's inside

```
thumbmux/
├── core/    framework-free TypeScript primitives
├── svelte/  Svelte 5 components (the phone UI)
└── server/  Bun/Node WebSocket mux engine for tmux
```

### `@thumbmux/core` — zero-dependency primitives

- **ansi-html** — incremental SGR→HTML renderer with carried state per line
  (the parser behind the 120 Hz engine; parsing happens *off* the gesture path)
- **terminal-link** — URL detection that reconstructs links wrapped across pane
  lines at the current width → tappable ranges, even mid-line and multi-line
- **terminal-scroll** — merge successive pane captures without scroll jumps
- **prompt-scan** — extract the user's *submitted* prompts from raw pane text,
  distinguishing them from the composer's faint placeholder/ghost text (SGR 2)
- **surface** — derive a complete readable surface (text, chrome, accent, ANSI
  palette) from one user-picked background color via relative luminance
- **protocol** — the WS message shapes shared by client and server

### `@thumbmux/svelte` — the phone UI

- **TermView** — a compositor-only scroll engine. No xterm on the hot path:
  captured lines render into a virtualized DOM window and scrolling is pure
  `translate3d`, so a flick runs at whatever Hz the display has. Real text
  selection, tappable links, iOS-native momentum/rubber-band physics, live
  output deferred during gestures and bottom-anchored after.
- **ComposerDock** — the input sheet that *never covers the terminal*. Two
  modes: COMPOSE (batch + send) and DIRECT (an invisible input holds focus so
  the OS keyboard IS the input, every key relayed). Exposes dock/keyboard
  insets so the terminal viewport rides above sheet + keyboard — without ever
  resizing the underlying tmux pane.
- **TermHud / ActionFab / DpadSheet / ThemeSheet / NewTerminalSheet** — pinned
  status bar with a host-extensible panel, a single-launcher action menu,
  arrow-pad for TUI menus, theming, and a spawn-agent picker.
- **ws-mux** — one WebSocket, many sessions: subscribe/keys/resize/history
  with NAT-safe pings, visibility-aware reconnect, and pending-resize replay.

### `@thumbmux/server` — the engine

`TmuxWsMux` serves every viewer from one process: shared adaptive polling
(4 FPS idle → 10 FPS after keystrokes), `pipe-pane` dirty signals when
available, content-hash dedupe, scrollback history expansion, and session-list
pushes. Everything host-specific is injected:

```ts
new TmuxWsMux({
  driver,            // how to talk to tmux (capture/keys/resize/activity)
  pipes,             // optional pipe-pane manager
  archive,           // optional scrollback archive
  profile: (s) => ({ // per-session behavior
    resize: true, currentPaneOnly: false, archive: true,
  }),
  hooks: {           // your policy: telemetry, resize arbitration, auth
    onResizeRequest: (session, ws, geo, client) => ({ apply: true }),
  },
});
```

## iOS scar tissue (why this exists)

These are encoded in the components so you don't have to relearn them:

- iOS raises the keyboard **only** for `focus()` calls made synchronously
  inside the tap's call stack — a `setTimeout` focus silently sets
  `activeElement` with the keyboard down.
- Safari will not pan-to-reveal an invisible focused input; if your input is
  hidden you must track `visualViewport` yourself (subtracting `offsetTop`,
  guarding against pinch-zoom).
- An `opacity: 0` input is focusable; a `display: none` one is not. Keep it
  at `font-size: 16px` or Safari zooms the page on focus.
- Never resize the pty because a transient overlay appeared: compute insets
  relative to each host's closed-state baseline (safe-area vs zero) so the
  add-back math cancels exactly and rows never flap.
- iOS's keyboard is translucent: anything you park behind it shows through.

## Status

**0.x, source-first.** Extracted from a production system (kemcortex) where it
drives real Claude Code / Codex / Grok sessions daily; consumed there via
workspace aliases. Not yet on npm.

Roadmap:

- [ ] Reference `TmuxDriver` implementation (Bun) + runnable demo app
- [ ] npm packaging (`svelte-package` builds, published `@thumbmux/*`)
- [ ] English-default labels (Thai is the current default — the home system)
- [ ] Protocol docs + conformance tests for third-party servers

## License

MIT © [kemkem23](https://github.com/kemkem23)

[Claude Code]: https://claude.com/claude-code
