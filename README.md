<div align="center">

# thumbmux

**tmux for thumbs — and now for desks.**

A reusable web-terminal shell and server engine for driving tmux sessions —
especially AI coding agents — from phone and desktop browsers: a compositor-
scroll viewer, a keyboard-aware composer, a live session hub, and a multiplexed
WebSocket engine. The package exposes public core, Svelte, server, and assembled
app entrypoints. It still needs a host process; it is not a standalone
executable or an installed copy of the repository demo.

[![CI](https://github.com/kemkem23/thumbmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kemkem23/thumbmux/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/kemkem23/thumbmux?filter=v*-dist&label=release&color=16a34a)](https://github.com/kemkem23/thumbmux/tags)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Svelte 5](https://img.shields.io/badge/Svelte-5_runes-ff3e00?logo=svelte&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-server_engine-black?logo=bun&logoColor=white)
![zero deps](https://img.shields.io/badge/core-zero_runtime_deps-8b5cf6)

<img src="docs/media/hero.png" width="96%" alt="The same agent session in three themes — dark, deep blue, and cream" />

<sub>The screenshots come from the repository demo. Clone the repository to run it;
the demo is not part of a dist-tag install.</sub>

</div>

---

## Why thumbmux

Born from a real itch: agent TUIs running in tmux on a server, and a human on
a phone who still has to steer them. Every web terminal we tried treats the
phone as a tiny desktop — pinch, squint, mis-tap, rage. thumbmux treats the
phone as the primary device, and rebuilds the viewer around one idea:
**during a gesture, the compositor should be the only thing working.**

- **Compositor-driven scrolling.** ANSI parsing and row-window rebuilds are
  deferred while a touch gesture is active; the scroll itself is
  `translate3d` over a virtualized window of rows. Momentum, rubber-band and
  bottom-anchoring are implemented in the client.
- **Real DOM, real text.** Select it, copy it, and tap wrapped URLs. It's a
  document, not a picture of one.
- **Input that respects the OS.** The composer reports its occupied height so
  the host can keep the terminal visible without resizing the pty. DIRECT mode
  lets the phone keyboard drive the terminal, while the desktop wrapper handles
  physical-keyboard layouts and composition guards.
- **A shared per-session engine.** Viewers of the same tmux session share its
  server-side polling and captures. The mux also provides content-hash dedupe,
  cursor-only frames, tail-mode thumbnails, opt-in line-delta frames, and
  opt-in per-message deflate.
- **History that keeps growing with nobody watching.** A terminal viewer
  normally archives what someone is looking at, so an agent working alone stops
  being recorded the moment the last tab closes. `RetentionLane` keeps chosen
  sessions captured on their own timer, and `DurableHistoryArchive` stores the
  result as plain text a shell can read — including the rows still on screen,
  because losing the tmux server should not take a session's newest thousand
  lines with it. See [Durable history](docs/history.md).

## The tour

### A hub of everything you're running

Live miniatures make parallel sessions readable at a glance. Each thumbnail
subscribes in **tail mode**, and its capture is shared server-side with full
viewers of the same session. Each distinct session still has its own poll and
capture work. Tap **+ terminal** for launch presets with permission and model
dropdowns and **isolated git-worktree** options — presets are data, bring your
own.

<p align="center">
  <img src="docs/media/hub.png" width="360" alt="Session hub: four live terminal miniatures plus a + terminal card" />
  <img src="docs/media/launcher.png" width="360" alt="Launcher sheet with presets, permission and model dropdowns" />
</p>

### A terminal that reads like an app

Syntax colors survive the trip (incremental SGR→HTML with cross-line state),
URLs are tappable `<a>` elements even when they wrap, and caret placement uses
Thai/CJK/emoji-aware cell widths. Pull down and older scrollback streams in
when the host wires a history archive. TermView keeps a built-in client
retention budget of 10,000 rows or an estimated 8 MiB, whichever fills first;
the mounted viewport and overscan are protected, so they may exceed the nominal
budget. Once the budget is full, further upward archive expansion stops — like
a finite tmux `history-limit` — even if the server still has older rows. That
client ceiling is **signposted** (a `role="note"` banner: “Older history not
loaded · limit 10k rows / 8 MiB”) so it is not mistaken for the start of the
session; the true server end-of-archive is not. When client retention drops a
span, its boundary is labelled `N rows dropped`; the label is presentation
chrome, not terminal text. Alternate-screen panes (`screen.alt`) have no
scrollback at all — TermView shows “Alternate screen · no scrollback” and
suppresses history expansion once alt is known. Unknown mode is treated as
normal (asking still happens); a prepend that landed while unknown is
dropped when the first sample is alt. These client budgets are separate from `FileHistoryArchive.maxLines`
and are not currently configurable through TermView props. When the pane width
changes, the live window reflows
from tmux and arrives as a full reset; archived rows deliberately keep their
original physical wrapping so history is not silently rewritten
([details](docs/reflow.md)).

<p align="center">
  <img src="docs/media/term-agent.png" width="360" alt="Agent session: colored diff, test results, tappable URL" />
  <img src="docs/media/composer.png" width="360" alt="Composer dock open with the terminal tail still visible above it" />
</p>

With the documented bottom-inset wiring, the composer **docks**: the viewport
shrinks by the reported sheet height and springs back. ComposerDock does not
resize the pty for a transient overlay. Prefer raw? **DIRECT mode** holds focus
in an invisible input so the OS keyboard drives the pane
keystroke-by-keystroke, Thai IME included.

### One-tap shortcuts, notes, uploads

A shortcut bar above the dock (tap = send, per-agent filtering) with a manager
sheet to add/edit/reorder — persisted through a `PreferencesAdapter` that can
live in `localStorage` or sync through your server so every device shares one
set. Session notes and recent prompts sit one tap away in the HUD panel
(`NotePanel` / `PromptsPanel`), and `UploadAction` turns attach-or-paste-a-
picture into an uploaded path prefilled in the composer.

<p align="center">
  <img src="docs/media/shortcuts.png" width="360" alt="Shortcut manager sheet" />
  <img src="docs/media/theme.png" width="360" alt="Theme sheet: dark/light, swatches, custom color" />
</p>

Theming is one color: hand `defaultSurface()` a background hex and it derives
foreground, HUD chrome, and a 16-color ANSI palette from luminance. Use
`deriveSurface(bg, base)` when you want to preserve your own branded surface
defaults.

### Desktop is first-class now

`DesktopKeys` wraps a `TermView`: click to focus (thin `:focus-visible` ring),
then type. Supported keys route through an xterm-compatible encoder — modified
F-keys, Ctrl+digit control bytes, AltGr third-level shift, macOS Option via
`altIsMeta`, and IME composition guards — covered by unit tests. Ctrl+C copies
when you have a selection and interrupts when you don't. Paste is bracketed,
with size-warning thresholds and a confirm hook. Direct-character desktop
layouts such as Thai, Latin, and Cyrillic work in the pane; Japanese, Chinese,
and Korean candidate-window IMEs use `ComposerDock` because the desktop wrapper
is not an editable input.

<p align="center"><img src="docs/media/desktop-agent.png" width="86%" alt="Desktop: the same session wide, with composer" /></p>

Full-screen TUIs that keep output in their own buffer? Set `altScreenMouse`
and TermView forwards wheel, click **and touch drags** as SGR mouse
sequences — with fractional-line accumulation so a precision trackpad doesn't
send your pager flying, and a composer-row clamp so events land where the TUI
actually listens.

<p align="center"><img src="docs/media/desktop-htop.png" width="86%" alt="htop in the browser: alt-screen SGR mouse forwarding" /></p>

The complete interaction contract — focus model, key routing, copy/paste
policy, geometry ownership, view-only surfaces — is specified in
[docs/desktop.md](docs/desktop.md).

## The numbers

| | |
|---|---|
| **Gesture window** | `translate3d` over a virtualized row window with 60 rows of overscan on each side; ANSI parsing and window rebuilds are deferred during an active gesture |
| **Client history retention** | nominally 10,000 rows or an estimated 8 MiB; the mounted viewport and overscan remain protected |
| **Server archive default** | `FileHistoryArchive` retains up to 20,000 archived lines per session unless the host sets `maxLines` |
| **Core source** | 4,919 measured lines of production TypeScript and **zero runtime dependencies** |

## Get started

**📦 In your app — use a published dist tag.** The app-shell quickstart needs
the 0.8.0-or-later surface. List the public dist tags, select the newest exact
tag that actually exists, and pin it. The glob deliberately does not name a
minor: v0.9.1 shipped a quickstart pinned to `v0.8.*-dist`, so everyone who
followed it landed on 0.8.3 and had no route forward.

```bash
THUMBMUX_TAG="$(git ls-remote --tags https://github.com/kemkem23/thumbmux \
  'refs/tags/v0.*-dist' | awk -F/ '{print $3}' | sort -V | tail -n 1)"
if test -z "$THUMBMUX_TAG"; then
  echo "No published v0.x-dist tag found" >&2
else
  bun add "thumbmux@github:kemkem23/thumbmux#${THUMBMUX_TAG}"
  # npm i "github:kemkem23/thumbmux#${THUMBMUX_TAG}"
fi
```

If the listing has no match, the block prints a message and installs nothing;
do not guess a tag. The selected tag's README describes that artifact, while the
[compatibility contract](https://github.com/kemkem23/thumbmux/blob/main/CONTRACT.md)
defines the current tier policy. This branch documents the current checkout
and may include APIs newer than a published tag; do not infer that a dist tag
exists from the local `package.json` version.

A matching dist-tag install contains the prebuilt `thumbmux/core`,
`thumbmux/server`, `thumbmux/svelte`, and `thumbmux/app` entrypoints plus the
supporting docs. It contains no standalone listener, demo directory, or package
scripts; the surrounding process and deployment remain host code.

## Quickstart

This pair uses the stock tmux driver, the assembled HTTP/WebSocket routes, and
the assembled Svelte shell. It requires Bun and tmux on the server. The listener
is loopback-only because this minimal example has no guard; do not expose an
unguarded terminal server to a network.

**Server (`server.ts`)** — `createAppRoutes()` supplies `GET /api/sessions`,
`POST /api/spawn`, `DELETE /api/sessions/:name`, and the fixed `/ws/tmux` mux.
The host owns the listener and the fallback response.

<!-- quickstart:server -->
```ts
import { createAppRoutes } from "thumbmux/server";

const routes = createAppRoutes();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(request, bunServer) {
    return await routes.fetch(request, bunServer)
      ?? new Response("Not found", { status: 404 });
  },
  websocket: routes.websocket,
});
console.log(`thumbmux listening on http://127.0.0.1:${server.port}`);
```

**Client (`src/main.ts`)** — start from a Svelte 5 + Vite app configured with
`@sveltejs/vite-plugin-svelte`, and keep the usual `<div id="app"></div>` in
`index.html`. The empty adapter selects the matching same-origin defaults.

<!-- quickstart:client -->
```ts
import { mount } from "svelte";
import { ThumbmuxApp, type AppAdapters } from "thumbmux/app";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app");

const adapters: AppAdapters = {};
mount(ThumbmuxApp, { target, props: { adapters } });
```

The server fence is a complete Bun program. The client fence is a complete
Vite entry module; `ThumbmuxApp` renders its hub immediately and switches to a
session through the `?session=` query parameter. See the full
[application-shell guide](docs/app.md) before adding authentication, uploads,
server preferences, custom routes, or host-owned panels.

## Lower-level building blocks

The four public subpaths can also be composed below the assembled shell:

```ts
import {
  TmuxWsMux,
  createBunTmuxDriver,
  createSpawnHandler,
  createUploadHandler,
  createPrefsHandler,
  FrameJournal,
  createTokenGuard,
} from 'thumbmux/server';
import {
  defaultSurface,
  buildLaunchCommand,
  submitPlan,
  searchLines,
  parseReplayJournal,
  normalizeAgentNotificationEvent,
} from 'thumbmux/core';
```

```svelte
<script>
  import {
    TermView,
    DesktopKeys,
    ComposerDock,
    SessionGrid,
    TermSearch,
    RecordingPlayer,
    NotificationPermission,
    tmuxMux,
  } from 'thumbmux/svelte';
</script>
```

`thumbmux/svelte` and `thumbmux/app` resolve via the `svelte` export condition —
Vite/SvelteKit pick them up automatically (they ship Svelte sources + `.d.ts`,
compiled by your bundler). **Pin only a `-dist` tag that the listing command
returns**; update by choosing another published tag and reinstalling.

### Opt-in dense session chrome

The stock HUD and grid are unchanged unless a host opts in. `TermHud`
`layout="dense"` renders a wrapping `name : note : titleAdornment : expand`
bar. The name is its own clipboard button and the expand control remains a
separate button; `onCopyTitle`, `copyTitleAria`, and `expandAria` let a host
replace the clipboard transport or labels. Dense mode renders the note verbatim
(without the stock `✎ ` prefix), always keeps `titleAdornment` visible, and
hides the agent chip while retaining Back.

`SessionGrid cardLayout="dense"` renders the matching
`name : note : summary : expand` metadata above a denser live preview. Add
`note` and `summary` to each `GridSession`; `subtitle` remains supported and is
the dense summary fallback. Dense cards are one full-container-width square on
mobile/coarse pointers, and exactly 500 × 500 px from 768 px on a fine-pointer
desktop. Set `showNew={false}` when the host supplies its own launcher.
`SessionThumb density="dense"` is also public for hosts composing a card
directly. Omitting every new prop preserves the historical layout, 30-line
thumbnail window, and launcher card.

The assembled shell forwards the same opt-ins as
`hubPresentation.cardLayout` and `sessionPresentation.headerLayout`.

**TypeScript consumers of `thumbmux/svelte` and `thumbmux/app` must set
`"moduleResolution": "bundler"`** (or an equivalent that resolves
`./TermView.svelte` to its adjacent `.d.ts` the same way). Under
`moduleResolution` `node16` / `nodenext`, the published Svelte declarations
fail with TS2307 on every sibling `.svelte` specifier — `thumbmux/server` and
`thumbmux/core` stay clean under both. This is a hard requirement, not a hint:
the package's own type smoke and contract fixtures assume `bundler`.

**⚡ Run the demo.** On a machine with `tmux` and Bun:

```bash
git clone https://github.com/kemkem23/thumbmux
cd thumbmux && bun install
bun run demo            # binds loopback
bun run demo -- --host  # expose on your LAN for the phone
```

It prints a QR code — scan it and you're looking at your own tmux sessions.
The URL carries a random token (cookie'd on first visit): **anyone with that
URL can type into your tmux**, so treat it like an SSH key. The demo includes
an alt-screen preset so you can feel the SGR mouse forwarding immediately.
Scrollback storage is private and per-run by default. Setting
`THUMBMUX_HISTORY_ROOT` explicitly opts into persistence keyed by tmux session
name; reuse a name only for the same logical session.

**🤖 The agent way for this checkout.** Paste into an agent TUI in your
project:

> Use the current thumbmux checkout and read its README. Then wire it in: mount
> `ThumbmuxApp` from `thumbmux/app`, pair it with `createAppRoutes()` from
> `thumbmux/server`, and list the host-owned listener, authentication, session,
> storage, and deployment policies that still need decisions. Show me the
> wiring plan before writing code.

**🔒 The security-conscious way.** Same, but audit first:

> Read the source files in the cloned thumbmux repository (core/, svelte/,
> server/, app/).
> Flag anything that phones home, executes remote content, touches
> files outside its packages, or handles keystrokes/session content in a way I
> should not trust. Summarize what data flows where, then wait for my
> go-ahead.

## What the host still supplies

`ThumbmuxApp` now provides the application shell, and `createAppRoutes()` now
provides the matching HTTP handlers and WebSocket mux. A host does not need to
reassemble those layers, but it still owns these integration points:

- **Process, listener, and outer routing.** Start Bun, choose the port and TLS
  termination, serve the client bundle, and handle every request for which
  `createAppRoutes.fetch()` returns `null`. A framework host also owns its page
  routes; split `HubView` and `SessionView` mounts delegate navigation back to
  that router. The repository demo remains an example, not an installed
  executable.
- **Identity and authorization policy.** Passing a `guard` to
  `createAppRoutes({ guard })` makes the package authenticate every owned HTTP
  operation and WebSocket upgrade, authorize every mux message, and filter
  session-list delivery. The host still issues grants, maps its identities and
  workspaces to session allowlists, handles its origin/CSRF policy, and protects
  fallthrough routes. Hosts using `TmuxWsMux` directly must perform that wiring
  themselves; see [the token-guard contract](docs/security.md).
- **Session lifecycle policy and kill UI.** `createAppRoutes()` provides the
  spawn endpoint and `DELETE {basePath}/sessions/:name` kill route by default;
  both must be treated as privileged operations. The stock shell has no kill
  action. Constrain cwd, names, commands, and worktree hooks, then either disable
  the kill route or add a control. With a guard, the principal must have
  `sessions-kill`; the same route can still target any non-empty session when
  their grant does not restrict `sessions`, and no host-supplied allowlist can be
  interpreted when it is omitted.
- **Host data and multi-user persistence.** The route assembler can enable
  upload and single-document preferences handlers, while the shell can use
  local preferences. The host still chooses durable storage and supplies
  identity-backed notes, prompts, per-user preferences, upload retention, and
  any application-specific metadata.
- **Recording storage and routes.** `FrameJournal`, `parseReplayJournal()`, and
  `RecordingPlayer` provide recording, replay, and playback building blocks, and
  `MuxHooks.onOutput` usually taps the canonical full frame when content or
  cursor-relevant state changes, so the host does not have to poll a second time
  to learn those changes. In cursor-only or unchanged-content states, the hook may
  emit only a cursor update.
  record, owns the journal's storage, and supplies the start/stop/download
  routes and the player's data loading; see
  [the recording contract](docs/recording.md).
- **“Agent needs a human” detection.** The notification contract validates
  host-supplied `finished` / `waiting` events, and the browser helpers can show
  them. The host must detect agent state transitions and supply, persist, and
  deliver those events. It also supplies agent classification, labels, and any
  notification provider; see [the notification contract](docs/notifications.md).

## Wiring

**Server** — one mux serves every viewer; everything host-specific is
injected (`createBunTmuxDriver()` is a complete reference implementation):

```ts
import { FileHistoryArchive, TmuxWsMux } from 'thumbmux/server';

const archive = new FileHistoryArchive({
  root: '.thumbmux-history', // omit for a private per-run temp directory
  maxLines: 20_000,
});

const mux = new TmuxWsMux({
  driver,                     // capture/keys/resize/activity against your tmux
  pipes,                      // optional: pipe-pane manager → instant dirty signals
  archive,                    // optional: scrollback archive → history expansion
  compressFrames: true,       // optional: Bun per-message deflate (pair with
                              //   perMessageDeflate: true on Bun.serve)
  profile: (session) => ({
    resize: true,             // browser-authoritative geometry?
    currentPaneOnly: false,   // alt-screen TUI (capture screen, not scrollback)?
    archive: true,
  }),
  hooks: {
    onResizeRequest: (session, ws, geo, client) => ({ apply: true }),
  },
});

// in your WS handler — handleMessage also answers keepalive pings and
// session-list subscriptions:
ws.onmessage = (e) => mux.handleMessage(JSON.parse(e.data), ws);
ws.onclose  = () => mux.unsubscribeAll(ws);
```

`PipeManagerLike` remains an extension interface, while `thumbmux/server` ships
`FileHistoryArchive` as its ready-to-use `HistoryArchiveLike` implementation.
Without `pipes`, live output still works through adaptive polling (250 ms
normally, 100 ms for five seconds after input) instead of instant `pipe-pane`
dirty signals. Without `archive`, live viewing still works, but history
expansion returns an empty page, so older archived scrollback is unavailable.

### Spawn endpoint (`createSpawnHandler`)

`LaunchSheet` does not choose an HTTP schema or make a request. Its
`onLaunch(spec, contextId)` callback receives the `LaunchSpec` built by
`buildLaunchSpec()`; a host can post that spec directly and map the separate
`contextId` to its own cwd/workspace policy:

```ts
import type { LaunchSpec } from 'thumbmux/core';

async function launch(spec: LaunchSpec, contextId: string | null) {
  const response = await fetch('/api/spawn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...spec,
      cwd: workspaceFor(contextId),
      // name: 'codex-project-1', // optional exact name
      // autoName: true,         // suffix an explicit collision instead of 409
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result as { ok: true; name: string };
}
```

The complete JSON contract is:

```ts
type SpawnPayload = {
  // LaunchSpec fields
  presetId?: string;  // known preset → server rebuilds command from selectors
  agent?: string;     // naming/host hint
  worktree?: boolean; // default false; true requires host prepare+cleanup hooks
  permission?: string;
  model?: string;
  command?: string;   // direct-command fallback when presetId is omitted

  // Host/session fields
  name?: string;      // omitted → collision-free generated name
  cwd?: string;       // omitted → configured handler cwd / process.cwd()
  autoName?: boolean; // explicit duplicate: false/omitted → 409; true → suffix
};
```

When `presetId` is present, it must exist in the handler's `presets` (the stock
presets are the default). The handler calls `buildLaunchCommand(preset,
permission, model)` and uses `preset.worktree` as the effective worktree flag; a
submitted `worktree` field is ignored in that path. Custom presets should be
supplied to both `LaunchSheet` and the handler. For the demo-compatible compact
form, omit `presetId` and post the already-built command:

```ts
body: JSON.stringify({ command: spec.command, worktree: spec.worktree })
```

Wire the fetch-style handler into a server route:

```ts
import { createBunTmuxDriver, createSpawnHandler } from 'thumbmux/server';

const driver = createBunTmuxDriver();
const handleSpawn = createSpawnHandler({
  driver,
  cwd: process.cwd(),
  namePrefix: 'term',
  validateCwd: (cwd) => cwd.startsWith('/srv/workspaces/')
    || 'cwd is outside the workspace root',
  // Opt-in only: the host creates the isolated checkout and returns its cwd.
  prepareWorktree: ({ name, cwd }) => createIsolatedCheckout({ name, cwd }),
  cleanupWorktree: ({ worktreeCwd }) => removeIsolatedCheckout(worktreeCwd),
});

if (url.pathname === '/api/spawn' && req.method === 'POST') {
  return handleSpawn(req);
}
```

A success is `201 { ok: true, name }`; an exact-name collision is `409`;
malformed payloads, invalid/non-directory cwd values, and worktree requests
without both hooks are `400`. `createSpawnHandler` never runs `git worktree` on its
own. Auto-named requests also retry if another tmux client wins the final
spawn race. For worktree requests, `cleanupWorktree` rolls back the checkout
after final-cwd validation or spawning fails, before a retry can use a new
name. If `prepareWorktree` itself throws before returning a path, that hook
owns any partial cleanup. A hook that needs a deliberate HTTP error can throw
`SpawnHandlerError`.

**This endpoint can execute caller-supplied shell commands in local tmux.**
Protect it with authentication (for example `createTokenGuard()` with an
interactive grant), restrict cwd with host policy, and never expose it as an
unauthenticated route.

### Wiring backpressure

Backpressure is enabled by default. Bun reports a full outbound queue by
returning `-1` from `ws.send()`; the mux then stops adding server-pushed frames
to that socket. Forward Bun's `drain` event so the mux can resume immediately
and send the peer its current state:

```ts
import type { MuxClientMessage } from 'thumbmux/core';

Bun.serve<{ ok: true }>({
  fetch(req, server) {
    return server.upgrade(req, { data: { ok: true } })
      ? undefined
      : new Response('upgrade failed', { status: 400 });
  },
  websocket: {
    open(ws) {
      mux.subscribeSessions(ws);
    },
    message(ws, raw) {
      try {
        mux.handleMessage(JSON.parse(String(raw)) as MuxClientMessage, ws);
      } catch {
        // Ignore malformed client frames.
      }
    },
    close(ws) {
      mux.unsubscribeAll(ws);
    },
    drain(ws) {
      mux.handleDrain(ws);
    },
  },
});
```

Without `drain`, there is no fast resume path. Auto-resume works only when the
WebSocket adapter can report its buffered amount (Bun sockets expose
`getBufferedAmount()`), and a socket whose queue has emptied still waits until
the next server broadcast before the mux observes that fact. An adapter that
cannot report buffered bytes requires an explicit `handleDrain` call to resume.

To keep the pre-v0.5.0 keep-sending behavior, use the escape hatch when you
construct the mux:

```ts
const mux = new TmuxWsMux({
  driver,
  backpressure: { enabled: false },
});
```

For backpressure that stays enabled, `maxBlockedMs` (default 30 seconds) and
`maxBufferedBytes` (default 8 MiB, when buffered-byte reporting is available)
control slow-peer shedding. A blocked socket arms a one-shot timer for
`maxBlockedMs` when it first enters the blocked state, so an idle session still
sheds a peer that never receives another push. Buffered-byte shedding still
evaluates on the next send path (output, list, or resume checks). Tests that
need a deterministic shed call `installMuxTimeHooksForTests({ clock, setTimeout,
clearTimeout })` before constructing `TmuxWsMux` instead of waiting on the real
event loop.

**Client** — a compact terminal page. `submitPlan()` separates pasted text
from Enter because agent TUIs can swallow an Enter sent in the same tick. Set
the host-owned `agent` from launch/session metadata (it is not auto-detected)
so the Codex-specific second Enter is included:

```svelte
<script lang="ts">
  import { TermView, DesktopKeys, ComposerDock, tmuxMux } from 'thumbmux/svelte';
  import { defaultSurface, submitPlan, type SubmitAgent } from 'thumbmux/core';

  const session = 'my-session';
  const agent: SubmitAgent = 'generic'; // host-owned: 'claude', 'codex', or 'grok'
  const surface = defaultSurface('#101014');   // one hex → full palette
  const sendKeys = (data: string) => tmuxMux.sendKeys(session, data);
  async function sendSubmission(text: string) {
    for (const step of submitPlan(text, { agent })) {
      if (step.delayBeforeMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, step.delayBeforeMs));
      }
      sendKeys(step.keys);
    }
  }
  let composer = $state<ReturnType<typeof ComposerDock> | null>(null);
  let dockFull = $state(0), kbInset = $state(0);
</script>

<div class="viewport" style:bottom={`${dockFull + kbInset}px`}>
  <DesktopKeys onKeys={sendKeys} ariaLabel="Terminal input">
    <TermView
      {session}
      palette={surface.palette}
      bottomInsetPx={dockFull + kbInset}
      claimGeometry={true}
      altScreenMouse={false}
      onKeys={sendKeys}
      onTap={() => composer?.openDock()}
    />
  </DesktopKeys>
</div>

<ComposerDock
  bind:this={composer}
  bind:dockFull bind:kbInset
  onSend={(text) => { void sendSubmission(text); }}
  onDirectText={sendKeys}
  onDirectKey={sendKeys}
/>

<style>
  .viewport { position: absolute; top: 0; left: 0; right: 0; }
</style>
```

## What's inside

```text
node_modules/thumbmux/
├── README.md         installed integration guide
├── git-dist/core/    prebuilt framework-free TypeScript entrypoint
├── git-dist/svelte/  Svelte 5 components, sources, and declarations
├── git-dist/server/  prebuilt Bun/Node WebSocket engine entrypoint
├── git-dist/app/     assembled Svelte 5 application shell
└── docs/             eight supporting Markdown documents and their media
```

The package export map exposes those implementation directories as
`thumbmux/core`, `thumbmux/svelte`, `thumbmux/server`, and `thumbmux/app`.
The runnable demo remains in the source repository; the assembled app shell is
an installable component, not a listener or executable.

| package | what you get |
|---|---|
| **`thumbmux/core`** | `ansi-html` incremental SGR→HTML renderer (modern underlines + OSC 8 hyperlinks + search overlay ranges) · `search` bounded visible-text / regex-lite scrollback search · `replay` strict full/delta journal parse + seek · `notification` host-supplied agent-notification contract · `terminal-link` wrapped-URL detection · `terminal-scroll` jump-free capture merging · `prompt-scan` submitted-prompt extraction · `keyboardEventToSequence` terminal key encoding · `bracketedPaste` + `pasteInfo` thresholds · `submitPlan` (encodes the paste-ingest/Enter race agent TUIs have) · SGR mouse math for alt-screen TUIs · `surface` one-color theming · `launch` preset command builder · `protocol` the WS message types |
| **`thumbmux/svelte`** | `TermView` compositor-scroll viewer (`claimGeometry`, `altScreenMouse`, built-in search overlay) · `TermSearch` · `RecordingPlayer` · `NotificationPermission` · `DesktopKeys` desktop focus/key/paste wrapper · `ComposerDock` COMPOSE/DIRECT input sheet · `SessionGrid` + `SessionThumb` live-miniature hub · `LaunchSheet` preset launcher · `ShortcutBar` + `ShortcutsSheet` · `NotePanel` + `PromptsPanel` · `UploadAction` · `TermHud`, `ActionFab`, `DpadSheet`, `ThemeSheet`, `NewTerminalSheet` · `ws-mux` reconnecting multiplexed client · notification / service-worker helpers |
| **`thumbmux/server`** | `createAppRoutes()` reference composition for sessions, spawn, optional upload/preferences, kill, and the fixed WebSocket mux · `TmuxWsMux` shared adaptive polling, dirty signals, content-hash dedupe, tail + delta modes, history, and backpressure · `RetentionLane` keeps chosen sessions archived with no viewer attached · `DurableHistoryArchive` plain-text scrollback store that also keeps the live window · `stitchCapture` the reconciliation both use · `FileHistoryArchive` · `FrameJournal` · `createTokenGuard()` · `createBunTmuxDriver()` · individual fetch-style handler factories |
| **`thumbmux/app`** | `ThumbmuxApp` assembled hub/session shell · separate `HubView`, `SessionView`, and chromeless `EmbedView` mounts · typed `AppAdapters` for routing, session metadata, launch, content, preferences, theme, labels, and host extension slots |

Docs: [application shell](docs/app.md) ·
[session hub integration](docs/hub.md) ·
[desktop interaction contract](docs/desktop.md) ·
[WS protocol](docs/protocol.md) · [resize/reflow contract](docs/reflow.md) ·
[recording journal](docs/recording.md) · [notifications](docs/notifications.md) ·
[durable history](docs/history.md) ·
[token guard](docs/security.md) ·
[CONTRACT.md](https://github.com/kemkem23/thumbmux/blob/main/CONTRACT.md) ·
[release process](https://github.com/kemkem23/thumbmux/blob/main/SPLIT.md)

## Host CSS custom properties (theming surface)

Shipped Svelte components style themselves through **host-supplied CSS custom
properties**. They are not TypeScript exports, so they do not appear in the
contract manifests — but they are still part of the host-facing surface: rename
one and every consumer restyles silently. Map a `TerminalSurface` (from
`deriveSurface` / `defaultSurface` in `thumbmux/core`) onto the terminal chrome
variables below; fonts and layout insets are host-only.

| Property | Required? | Meaning |
|---|---|---|
| `--font-mono` | **yes** | Terminal typeface. `TermView` measures character width from the **computed** font to derive cols/rows — if this is unset you get a proportional font and drifting geometry, not a loud error. The family must be **monospace and cover every glyph the terminal can emit**, including box-drawing `U+2500–257F`. A missing glyph falls through to a different family with a different advance width and the grid breaks by a few percent with no warning (the Google Fonts subset of JetBrains Mono ships no `U+25xx` range). Thai/CJK panes also need a monospace face for that script in the stack, or a second family matched with `size-adjust` — see `docs/desktop.md` "Host font contract". |
| `--font-thai` | optional | UI chrome that mixes Thai (composer, prompts, shortcuts). Falls back to `--font-mono` where listed. Does **not** replace `--font-mono` for TermView cell metrics. |
| `--tbg` | **yes** | Terminal / page surface background. |
| `--tfg` | **yes** | Main text on that surface. |
| `--tstage` | recommended | Stage edge behind the terminal (HUD / dock contrast). |
| `--agent` | recommended | Accent for borders, LEDs, focus chrome. |
| `--hud` | recommended | HUD bar background (often semi-transparent). |
| `--hud-fg` | recommended | HUD text / icon color. |
| `--hud-line` | recommended | HUD hairline / control borders. |
| `--dock-inset` / `--dock-full` | optional | Mobile composer-dock geometry (see mobile composer docs / `ComposerDock`). |
| `--kb-inset` | optional | Extra bottom inset while a software keyboard is up. |

`SessionView` / `EmbedView` in `thumbmux/app` already write the surface fields to
the matching `--*` properties on their root. A headless host that mounts
`TermView` alone must set at least `--font-mono`, `--tbg`, and `--tfg` on an
ancestor. There is no published `surfaceCssVars()` helper yet — if you map
camelCase surface keys to kebab-case CSS vars, keep that mapping in **one**
place in your app so it cannot drift from the table above.

## Compatibility checks

The public policy is the pre-1.0
[compatibility contract](https://github.com/kemkem23/thumbmux/blob/main/CONTRACT.md).
In a source checkout, after `bun run build:git-dist`, `bun run contract`
compares the built `core`, `server`, `svelte`, and `app` declarations with their
checked-in tier manifests. That command is the surface gate; it does not run
consumer fixtures.

It also refuses to run without the **immutable baseline** — the published
artifact it diffs the frozen surface against:

```bash
bun scripts/materialize-contract-baseline.ts /tmp/thumbmux-baseline
THUMBMUX_CONTRACT_BASELINE_ROOT=/tmp/thumbmux-baseline bun run contract
```

`THUMBMUX_CONTRACT_BASELINE=skip` runs the surface gate alone; the success line
then says so out loud. That is deliberate: the baseline half answers *did a
frozen name change*, and skipping it silently once produced a "contract check
passed" that had never looked.

`bash scripts/contract-fixtures.sh` separately packs the same `git-dist`
artifact and installs three frozen consumers: `minimal-host`, `guarded-host`,
and `app-host`. They compile and exercise the low-level host, guarded route
composition, and Svelte app mount respectively. `thumbmux/app` and
`createAppRoutes` remain **S — stabilizing** throughout the pre-1.0 line; these checks are
evidence for the published tiers, not a claim of 1.0 compatibility.

<details>
<summary><b>iOS scar tissue</b> — lessons encoded in the components so you don't relearn them</summary>

- iOS raises the keyboard **only** for `focus()` calls made synchronously
  inside the tap's call stack. A `setTimeout` focus silently sets
  `activeElement` with the keyboard down. (That's why
  `ComposerDock.openDock()` exists.)
- Safari will not scroll-to-reveal an invisible focused input — track
  `visualViewport` yourself, subtract `offsetTop`, and guard against
  pinch-zoom.
- An `opacity: 0` input is focusable; `display: none` is not. Keep it at
  `font-size: 16px`, or Safari zooms the page.
- Never resize the pty because a transient overlay appeared. Compute insets
  against each host element's closed-state baseline so the add-back cancels
  exactly and the pane geometry never flaps.
- The iOS keyboard is translucent — anything parked behind it shows through.

</details>

## Roadmap

- [x] Session hub: live-miniature grid + launch presets, filters/search/grouping, state dots, keyboard nav (v0.3.3)
- [x] Tail-mode subscriptions for thumbnails
- [x] Runnable demo + reference `TmuxDriver` (clone → `bun run demo` → scan QR)
- [x] Installable releases without npm: published `vX.Y.Z-dist` tags with prebuilt dists
- [x] Desktop: `DesktopKeys`, terminal key encoder, alt-screen SGR forwarding (wheel/click/touch)
- [x] Wire efficiency: cursor-only frames, tail mode, opt-in per-message deflate
- [x] State-convergent history prepend (v0.3.3)
- [x] Protocol doc ([docs/protocol.md](docs/protocol.md)) + conformance suite

**v0.3.4 / v0.3.5 — stability & wire perf**
- [x] Selection survives live output while scrolled up
- [x] Live-window reflow when the pane width changes
- [x] Validated opt-in line-delta frames with one-shot resync recovery
- [x] Demo hardening: scroll-to-bottom + new-content pill, selection-first copy, private file-backed history archive reference
- [x] Self-contained root git-dist (no unpublished workspace package needed)

**v0.4.0 — capability wave (shipped)**
- [x] Search in scrollback (visible-text + regex-lite, highlight + jump in TermView)
- [x] OSC 8 hyperlinks + modern underline styles
- [x] Session recording & playback (`FrameJournal` + `parseReplayJournal` + `RecordingPlayer`)
- [x] Web-push / local notification scaffolding (core event contract + SW helpers + permission UI)
- [x] Token scopes (`createTokenGuard` — read/interactive, expiry, session allowlists)
- [x] PWA scaffolding (service-worker registration + notification click handlers)
- [x] Linear dense search-overlay rendering + real Svelte mount smoke tests

**v0.5.0 — performance & safety (shipped)**
- [x] Delta broadcast grouped by viewer identity — cost flat in viewer count
- [x] Incremental client delta apply (prefix hash + skip re-validate)
- [x] WebSocket backpressure on by default (`handleDrain` / auto-resume; legacy via `enabled: false`)
- [x] `filterSessionList` hook on every session-list delivery path
- [x] All-or-nothing multi-file uploads; quadratic wrapped-URL + capture-overlap fixes

**v0.7.0 — consumer building-block milestone (shipped)**
- [x] `FileHistoryArchive` and `createSpawnHandler` exported — no longer host-only code
- [x] `SessionListItem` typed and documented, with `activityAt` (no extra tmux call)
- [x] Prompt-scan matchers are pluggable
- [x] Public docs import the package subpaths, enforced by a snippet test
- [x] `docs/hub.md`, including what the hub does *not* give you
- [x] Deferred TermView hot-path defects closed with benchmark coverage
- [x] Bounded retained history with protected visible rows and explicit gap markers
- [x] prefs/upload data-loss paths fixed and previously untested components covered
- [x] `smoke:git-dist` checks source-derived core/server export parity for consumers

**v0.14.x — current checkout**
- [x] Mountable `ThumbmuxApp` plus hub, session, and embed views under `thumbmux/app`
- [x] `createAppRoutes()` composition for the matching HTTP and WebSocket surface
- [x] Four-subpath contract gate plus three separate frozen consumer fixtures
- [x] Copyable server/client quickstart executed from a packed `git-dist` consumer
- [x] Every path in `files` reachable through `exports`, proven by a rule not a case
- [x] Ten framework-free modules no longer gated behind the `svelte` export condition
- [x] Shipped `.svelte` sources pass strict `svelte-check`
- [x] `TermHud.titleAdornment` — an inline slot on the session-name row that
      collapses rather than taking width from the name

**Later**: split view (two panes side by side), hub pinning + activity badges,
binary protocol (msgpack) / WebTransport, SSH-backed driver example,
collaborative viewing, docs site, npm packages, scroll-feel video from a real device

## License

MIT
