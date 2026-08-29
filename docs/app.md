# Mounting the application shell

`thumbmux/app` is the assembled Svelte shell: a session hub, a full terminal
view, and a chromeless embed. The host still owns process startup, routing,
authentication, agent-state detection, durable data, and notification
delivery. Every view requires an `adapters` prop; pass `{}` to select all stock
client defaults.

## 1. Mount modes

### 1.1 One `ThumbmuxApp`

Use `ThumbmuxApp` when one page owns both the hub and the selected session. If
`adapters.routes` is absent, it reads and replaces the `session` query
parameter. Other query parameters are preserved. Opening `build-1` therefore
changes the current URL to `?session=build-1`, and Back in the HUD removes that
parameter.

```svelte
<script lang="ts">
  import { ThumbmuxApp, type AppAdapters } from "thumbmux/app";

  const adapters: AppAdapters = {};
</script>

<ThumbmuxApp {adapters} />
```

The empty adapter uses same-origin `GET /api/sessions`, `POST /api/spawn`, and
the shared `/ws/tmux` WebSocket. Section 3 shows the matching server.

### 1.2 `HubView` and `SessionView` on two SvelteKit routes

Mount the two views separately when the host router owns navigation. Do not
put an external `routes` adapter on `ThumbmuxApp` and expect that component to
change its own branch: an external adapter delegates navigation to the host.
The router must render the matching view.

Create one adapter shared by both pages:

```ts
// src/lib/terminal-app.ts
import { goto } from "$app/navigation";
import type { AppAdapters } from "thumbmux/app";

export const terminalAdapters = {
  routes: {
    openSession(name: string): void {
      void goto(`/terminals/${encodeURIComponent(name)}`);
    },
    showHub(): void {
      void goto("/terminals");
    },
  },
} satisfies AppAdapters;
```

The hub route is `src/routes/terminals/+page.svelte`:

```svelte
<script lang="ts">
  import { HubView } from "thumbmux/app";
  import { terminalAdapters } from "$lib/terminal-app";
</script>

<HubView adapters={terminalAdapters} />
```

Expose the dynamic parameter as page data in
`src/routes/terminals/[session]/+page.ts`:

```ts
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => ({
  session: params.session,
});
```

Then mount the full terminal in
`src/routes/terminals/[session]/+page.svelte`:

```svelte
<script lang="ts">
  import { SessionView } from "thumbmux/app";
  import { terminalAdapters } from "$lib/terminal-app";

  let { data }: { data: { session: string } } = $props();
</script>

<SessionView session={data.session} adapters={terminalAdapters} />
```

Both route callbacks are required: `HubView` calls `openSession`, and the HUD
Back control in `SessionView` calls `showHub`.

### 1.3 `EmbedView` inside an iframe

`EmbedView` keeps the terminal, desktop keys, and composer but removes the hub,
HUD, action menu, shortcuts, notes, and prompts. It always passes
`claimGeometry={false}` so an embed cannot resize a pane also viewed elsewhere.

Create an iframe page at `src/routes/terminal-embed/[session]/+page.svelte`:

```svelte
<script lang="ts">
  import { EmbedView, type AppAdapters } from "thumbmux/app";

  let { data }: { data: { session: string } } = $props();
  const adapters: AppAdapters = {};
</script>

<EmbedView session={data.session} {adapters} />
```

Its adjacent `+page.ts` can use the same load function as the dynamic terminal
route above. A parent page can then embed it:

```svelte
<script lang="ts">
  let { session }: { session: string } = $props();
  let src = $derived(`/terminal-embed/${encodeURIComponent(session)}`);
</script>

<iframe
  title={`Terminal ${session}`}
  {src}
  allow="clipboard-read; clipboard-write"
></iframe>
```

The iframe example is same-origin, so it uses the same `/ws/tmux` endpoint. If
the iframe is served from another origin, either serve an authorized
`/ws/tmux` route on the iframe origin, or call `configureTmuxMux` before mount
to select another endpoint whose server accepts that iframe origin and its
credentials.

## 2. `AppAdapters` reference

All fields are optional, but the `adapters` component prop itself is required.
Defaults below describe the current source behavior, including the result of
omitting an entire nested block.

### 2.1 Sessions, transport, navigation, and launch

| Field | Default and omission behavior | Concrete implementation example |
| --- | --- | --- |
| `basePath` | `"/api"`. The shell trims it, adds a leading slash, removes trailing slashes, and treats `""` or `"/"` as the root. It changes only the default sessions and spawn HTTP calls, not the WebSocket, upload, or preferences URLs. | `basePath: "/terminal-api"` |
| `fetchSessions` | Calls `GET {basePath}/sessions`. A custom function replaces only that bootstrap; authoritative session-list WebSocket pushes still update the store and win a race with an older HTTP response. A failed bootstrap ends the loading state with the current rows. | `fetchSessions: async () => fetch("/host/sessions").then(readSessions)` |
| `mux` | The shared `tmuxMux`. This seam supplies only authoritative session-list pushes to `HubView` and `SessionView`; `EmbedView` does not read it. An override does not replace the fallback HUD connection state, default key transport, or the pane output, history, resize, and connection observation inside `TermView`. Those remain on the shared singleton. | `mux: tmuxMux` |
| `sendKeys` | Calls `sendKeys` on the shared `tmuxMux`. Both direct keys and the steps produced by composer submission use this transport by default. Supply this adapter to replace input independently; changing `mux` changes only live session rows and does not redirect keys or `TermView`. | `sendKeys: (session, keys) => tmuxMux.sendKeys(session, keys)` |
| `sendSubmissionKeys` | Optional transport for composer-submission steps (`submitPlan` output). If present, the shell awaits each step before the next one and uses this path instead of `sendKeys` for composer submissions only. | `sendSubmissionKeys: (session, keys) => void` |
| `submitAgent` | Returns `"generic"`. The value is passed to `submitPlan`; the shell never infers an agent kind from the session name. | `submitAgent: () => "generic"` |
| `routes` | In `ThumbmuxApp`, omission selects the internal `?session=` adapter. Standalone `HubView` and `SessionView` should receive host routes; their limited fallbacks are not a two-page router. | `routes: { openSession, showHub }` |
| `routes.openSession` | No external callback by default. `HubView` invokes it with the exact selected name when routes are supplied. | `openSession: (name) => void goto("/terminals/" + encodeURIComponent(name))` |
| `routes.showHub` | No external callback by default. `SessionView` invokes it from HUD Back when routes are supplied. | `showHub: () => void goto("/terminals")` |
| `spawn` | Omission keeps the launcher enabled with stock presets and the default HTTP launch. The block configures launcher policy; it is not an enable flag. | `spawn: { presets, contexts, launch }` |
| `spawn.presets` | `DEFAULT_LAUNCH_PRESETS`. Passing `[]` makes the sheet empty but does not remove the new-terminal card. | `presets: DEFAULT_LAUNCH_PRESETS` |
| `spawn.contexts` | No contexts and no workspace picker. It is loaded only when a custom `spawn.launch` also exists; rejection becomes an empty list. | `contexts: async () => [{ id: "default", label: "Default workspace" }]` |
| `spawn.launch` | `POST {basePath}/spawn` with the `LaunchSpec` only. A custom function receives `(spec, contextId)` and must return `{ name }`. The shell applies `String(name)` before closing the launcher, so strict-name enforcement belongs in your launch endpoint (not just adapter typing). A launch failure leaves the sheet open and shows the error. | `launch: async (spec, contextId) => postLaunch(spec, contextId)` |
| `hubPresentation` | Optional hub-only presentation controls (filter chips, grouping, ordering, dense/default cards, and whether command text is shown). `cardLayout: 'dense'` selects the 500 px desktop/full-width mobile card layout. A supplied object only changes stock `HubView` visuals; it does not gate launch, notes, uploads, or sessions policy. Omission keeps `cardLayout: 'default'`. | `hubPresentation: { cardLayout: "dense", showCommand: true, groupable: true, order: "name" }` |
| `sessionPresentation` | Optional session-only presentation controls. `actions` receives shell `SessionActionContext` and default action list; return your preferred list composition. `showShortcutBar` can hide the shortcut tile row but does not touch other stages. `promptsCollapsible` puts recent prompts behind a disclosure; pairing it with `promptsInitiallyOpen: true` prefetches that adapter and renders the open prompt list first, so the first HUD expansion can show recall immediately. `extraPanelPlacement` chooses which end of the normal HUD panel stack `extraPanel` renders at; the open-first prompt combination intentionally takes priority over it. `notePrefix` and `statusCase` turn off the HUD's two built-in text transforms — the `'✎ '` before a note and the uppercasing of status — which otherwise make both fields unusable for any other wording. `composerMode: 'direct' \| 'compose'` seeds the composer mode for a **freshly mounted** session (default `'compose'`); it is per-mount state — the user's in-session switch wins until remount (home → terminal, reload), and prefill still forces COMPOSE because DIRECT has no visible field. `fontPxMin` / `fontPxMax` set the inclusive bounds for stock A+/A− and prefs load (default **4–40**); out-of-range stored values **clamp**, they are never ignored. Stock step is graduated (1px below 20, 2px to 32, 4px above). `dpadPlacement` chooses the stage corner for the ✛ arrow pad (default **`bottom-left`**; `'top-right'|'top-left'|'bottom-right'` also valid); every corner respects `env(safe-area-inset-*)`. `pinNarrowCells` (default **true**) pins one-cell non-ASCII clusters into a one-cell box; set `false` when the host font is already fixed-advance — you give up that grid guarantee and get the spans back. Dual-width CJK/emoji pins stay on. | `sessionPresentation: { showShortcutBar: false, promptsCollapsible: true, promptsInitiallyOpen: true, notePrefix: '', statusCase: 'none', composerMode: 'direct', fontPxMin: 4, fontPxMax: 40, dpadPlacement: 'top-right', pinNarrowCells: false }` |

`sessionPresentation.headerLayout: 'dense'` is an additional opt-in. It renders
the wrapping `name : note : titleAdornment : expand` header, makes the name copy
the exact tmux session name, and leaves expand as a separate control. Dense
notes are verbatim (the default layout alone applies `notePrefix`), the
adornment never collapses, and the agent chip is hidden while Back remains.
Omission keeps `headerLayout: 'default'` and the historical header unchanged.

Here is a complete implementation of the examples that use ordinary HTTP and
the shared mux:

```ts
import {
  DEFAULT_LAUNCH_PRESETS,
  type LaunchSpec,
  type SessionListItem,
} from "thumbmux/core";
import type { AppAdapters } from "thumbmux/app";
import { tmuxMux } from "thumbmux/svelte";

async function readSessions(response: Response): Promise<SessionListItem[]> {
  if (!response.ok) throw new Error(`Session list failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error("Session list must be an array");
  return value as SessionListItem[];
}

async function postLaunch(
  spec: LaunchSpec,
  contextId: string | null,
): Promise<{ name: string }> {
  const response = await fetch("/host/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec, contextId }),
  });
  if (!response.ok) throw new Error(`Launch failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  const candidate = value !== null && typeof value === "object" && "name" in value
    ? (value as { name?: unknown }).name
    : undefined;
  const name = typeof candidate === "string" ? candidate.trim() : "";
  if (!name) throw new Error("Launch response has no session name");
  return { name };
}

export const transportAdapters = {
  basePath: "/terminal-api",
  fetchSessions: () => fetch("/host/sessions").then(readSessions),
  mux: tmuxMux,
  sendKeys: (session, keys) => tmuxMux.sendKeys(session, keys),
  submitAgent: () => "generic",
  spawn: {
    presets: DEFAULT_LAUNCH_PRESETS,
    contexts: async () => [{ id: "default", label: "Default workspace" }],
    launch: postLaunch,
  },
} satisfies AppAdapters;
```

`/host/launch` is deliberately a host route in this example: the bundled
`createAppRoutes` spawn handler accepts a `LaunchSpec`, while choosing what a
`contextId` means is host policy.

### 2.2 Session metadata, panels, uploads, preferences, and terminal props

Notes, prompts, upload UI, preference controls, and their panels below belong
to `SessionView`; `EmbedView` intentionally does not render them. The embed
does use send/submit, labels, its applicable terminal props, and theme surface
fields.

| Field | Default and omission behavior | Concrete implementation example |
| --- | --- | --- |
| `sessionMeta` | `HubView` maps every row to `{ name }`; `SessionView` has no current metadata. No state dot, state label, chip, color, grouping, or host activity label is invented. The callback is a synchronous projection and may run again during rendering; it must not start detection, write storage, or send notifications. | `sessionMeta: (rows) => rows.map(toGridSession)`; section 4 defines `toGridSession`. |
| `notes` | No note load and no `NotePanel`. Supplying either operation without the other is not allowed by the type. | `notes: { load, save }` |
| `notes.load` | Not called when `notes` is absent. With the block present it is called for the current session. Load errors are swallowed; after an initial or session-changing failure the note remains empty. | `load: (session) => fetchText("/host/notes/" + encodeURIComponent(session))` |
| `notes.save` | Not called when `notes` is absent. The editor closes immediately; the shell waits for the promise before committing the new note, and failure keeps the previously committed note. | `save: (session, text) => putText("/host/notes/" + encodeURIComponent(session), text)` |
| `prompts` | No prompt load and no `PromptsPanel`. There is no automatic pane scanner in the app shell. With an adapter, loading begins when the HUD expands by default. If `promptsCollapsible` and `promptsInitiallyOpen` are both true, SessionView instead prefetches on mount, coalesces an in-flight expand with that request, and places the open prompt panel first. | `prompts: (session) => fetchJson("/host/prompts/" + encodeURIComponent(session))` |
| `bashSummaries` | No model call. Claude sessions still get the stock BASH disclosure with direct **SHOW / HIDE / DISTILL** choices. HIDE renders each consecutive high-confidence Bash group as a one-third-row local divider with a left-aligned `hidden bash` label and a green rule filling its right side. Proven separator blanks join that compact range; capture-start padding and retention seams remain raw. A fresh DISTILL view offers this adapter at most its newest ten completed groups; later coalesced live updates offer only their newest newly-completed group, independent of scrolling. Missing adapters, rejected calls, and missing IDs settle once to a deterministic command preview. The host owns model choice, redaction, authentication, lifecycle checks, throttling, and durable caching. Raw rows remain canonical for copy, search, scrollback, retention, and ANSI state in every mode. | `bashSummaries: (session, blocks) => postJson("/host/bash-summaries", { session, blocks })` |
| `upload` | No upload action, hidden file input, or composer file-paste handler. Supplying the block enables those only for sessions whose endpoint is a non-empty string. | `upload: { endpoint, dir, formatPrefill }` |
| `upload.endpoint` | Required inside `upload`. Return `null` to intentionally hide upload UI for a session; an empty string is also treated as hidden. `basePath` does not fill this field. | `endpoint: (session) => "/terminal-api/upload?session=" + encodeURIComponent(session)` |
| `upload.onUnavailable` | Still called when paste files are submitted while `endpoint(session)` is `null` and can route to `ActionContext`-driven fallback behavior (`prefill`, message, local upload UX, etc.). | `onUnavailable: (session, files, context) => context.prefill("Save these files as notes")` |
| `upload.prepareForm` | Optional per-request hook after the stock `files` fields are appended and before `fetch`. It may append host receipt/idempotency fields and returns opaque context tied to that exact request. It is awaited; rejection aborts the upload through the normal error path. | `prepareForm: (_session, _files, form) => { const id = crypto.randomUUID(); form.set("requestId", id); return id; }` |
| `upload.onResponse` | Optional settlement hook after the response body is parsed, for both success and HTTP failure, and before the stock success/error callback. It receives the same session/files plus `Response`, parsed data, and the exact opaque context returned by `prepareForm`; it is awaited. | `onResponse: (_session, _files, response, data, requestId) => receipts.set(String(requestId), { status: response.status, data })` |
| `upload.dir` | `"uploads"`. Without `formatPrefill`, `UploadAction` uses the upload response's `dir`, falling back to this value, when it builds the composer message. | `dir: "/srv/app/uploads"` |
| `upload.formatPrefill` | Absent, the shell uses the message built by `UploadAction`. Present, it replaces that prefill and receives `(files, configuredDir)`; the second argument is `upload.dir` or `"uploads"`, not the response's `dir`. | `formatPrefill: (files, dir) => "Review " + files.length + " file(s) in " + dir` |
| `prefs` | `createLocalPrefs(theme.storageKey ?? "thumbmux-app-prefs")`. Omitting it does not hide theme, font, or shortcut controls; it stores them locally. **Share one `createServerPrefs` instance** across the page when several features read the same endpoint (font + theme + shortcuts): each call is a separate adapter with its own subscribers, and only that adapter's `load()`/`subscribe` path delivers the server snapshot to *its* listeners. Prefer one instance and pass it around. | `prefs: createServerPrefs({ url: "/terminal-api/prefs" })` |
| `termProps` | Returns no overrides. `SessionView` starts with geometry claims on, alt-screen mouse off, font size 13 (then preferences), and a palette derived from the background. | `termProps: () => ({ claimGeometry: true, altScreenMouse: false, fontPx: 14 })` |
| `termProps().claimGeometry` | `true` in `SessionView`. `EmbedView` always forces `false`, even if the adapter returns `true`. | `claimGeometry: false` for a secondary full view. |
| `termProps().altScreenMouse` | `false`. Enable only for a session whose full-screen application expects SGR mouse input. | `altScreenMouse: session === "monitor"` |
| `termProps().palette` | The palette preference is derived from `theme.surfaceFor(session).palette` first (when present), then the background fallback. A `theme.surfaceFor`-derived palette may still be preserved when `termProps` omits or returns `undefined`. | `palette: defaultSurface("#101014").palette` |
| `termProps().fontPx` | When set, this **overrides** the stored preference for that session (A+/A− still write the preference, but TermView renders this value). Absent, `SessionView` uses the stored size (default **13**, range controlled by `fontPxMin`/`fontPxMax`). The explicit `EmbedView` `fontPx` prop takes precedence over this adapter value. | `fontPx: 14` |

### Terminal font size (SessionView stock A+/A−)

`SessionView` owns a single stored `fontPx` preference (via `prefs`) and two stock FAB actions (`font-up` / `font-down`). Through 0.15.2 both the load path and the actions hard-clamped to bare literals **11–18** and silently dropped any stored value outside that band — a host that widened its own control saw no effect.

| Piece | Stock default | How a host changes it |
| --- | --- | --- |
| Default size (no preference stored) | **13** | Write `fontPx` through `prefs`, or force via `termProps().fontPx` |
| Inclusive min | **4** | `sessionPresentation.fontPxMin` |
| Inclusive max | **40** | `sessionPresentation.fontPxMax` |
| Step | Graduated: **1px** below 20, **2px** to 32, **4px** above | Replace `font-up` / `font-down` via `sessionPresentation.actions` (the step helper is not a prop — see below) |
| Out-of-range stored value | **Clamped** into the current bounds | — (never ignored) |

```ts
import {
  DEFAULT_FONT_PX_MIN,
  DEFAULT_FONT_PX_MAX,
  stepFontPx,
  clampFontPx,
} from "thumbmux/app";

// Match the shell's stock band to a host store that also uses 4–40:
const sessionPresentation = {
  fontPxMin: DEFAULT_FONT_PX_MIN, // 4
  fontPxMax: DEFAULT_FONT_PX_MAX, // 40
};

// Custom step: keep the stock actions' ids but rebind onTap, or supply your own.
// stepFontPx / clampFontPx are the pure helpers the shell itself uses.
const currentPx = 13;
const nextUp = clampFontPx(stepFontPx(currentPx, 1), {
  min: DEFAULT_FONT_PX_MIN,
  max: DEFAULT_FONT_PX_MAX,
});
void sessionPresentation;
void nextUp;
```

**Stock A+/A− keep the FAB open** after a tap (so a thumb can step the size
without reopening the menu). Host actions and `extraActions` close it first.

**How the shell tells stock from host after `sessionPresentation.actions`:**

| What the compose callback returns | FAB after tap |
| --- | --- |
| A default entry **by identity** (including pre-wrapped `extraActions`) | Stock / already-wrapped policy kept |
| Same `id` as a stock action **and** the same `onTap` reference (metadata-only spread: `testid`, `label`, …) | Stock policy kept — menu stays open for font-up/down |
| Same `id` but a **new** `onTap`, or any unknown `id` | Host policy — menu closes, then `onTap` runs |

Through 0.15.5 the rule was pure object identity: `{ ...fontUp, testid: "…" }`
was treated as a host action and closed the menu on first tap. Prefer the
stock testids (`demo-font-up` / `demo-font-down`) or a metadata-only patch.

**Probing A+/A− in a browser:** closed slots stay mounted for the open
animation. They have `opacity: 0`, `pointer-events: none`, `disabled`, and a
non-zero `getBoundingClientRect()` from `transform: scale(0.92)` (about
141.7×42.3 on a 390-wide phone). Coordinate taps at those numbers hit the
terminal underneath and look exactly like "onTap never fires / no prefs
write". Always assert `.slots.open` and `!button.disabled` (or click
`[data-testid="demo-font-up"]` only while the slots container has class
`open`) before measuring.

**`EmbedView` does not read these bounds.** It has no A+/A− chrome; size is only the explicit `fontPx` prop (or `termProps().fontPx`).

**Two host mechanisms can disagree.** A host that keeps its own font store (e.g. a desktop header `A+/A−` writing `localStorage`) and also mounts `SessionView` with the stock FAB will have two independent sizes unless it either (a) feeds the store into `termProps().fontPx` and drives A+/A− through that store via `sessionPresentation.actions`, or (b) drops the host store on the phone surface and lets package prefs be the single source of truth. Passing `fontPxMin`/`fontPxMax` alone only aligns the *bounds*, not the *value*.

The following helpers make the notes, prompts, upload, and preferences examples
copyable. A production host should add its authentication policy to these
requests.

```ts
import type { AppAdapters } from "thumbmux/app";
import { createServerPrefs } from "thumbmux/svelte";

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET failed: HTTP ${response.status}`);
  return response.text();
}

async function putText(url: string, text: string): Promise<void> {
  const response = await fetch(url, { method: "PUT", body: text });
  if (!response.ok) throw new Error(`PUT failed: HTTP ${response.status}`);
}

async function fetchJson(url: string): Promise<string[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected an array of strings");
  }
  return value;
}

export const contentAdapters = {
  notes: {
    load: (session) => fetchText(`/host/notes/${encodeURIComponent(session)}`),
    save: (session, text) => putText(`/host/notes/${encodeURIComponent(session)}`, text),
  },
  prompts: (session) => fetchJson(`/host/prompts/${encodeURIComponent(session)}`),
  upload: {
    endpoint: (session) => `/terminal-api/upload?session=${encodeURIComponent(session)}`,
    dir: "/srv/app/uploads",
    formatPrefill: (files, dir) => `Review ${files.length} file(s) in ${dir}`,
  },
  prefs: createServerPrefs({ url: "/terminal-api/prefs" }),
} satisfies AppAdapters;
```

### 2.3 Theme and labels

Passing no `theme` block makes the shell own local theme state. Passing even a
partial `theme` block declares that the host owns theme mutations. In that
mode the controls remain visible, but an omitted mutation callback is a no-op;
supply the read functions and callbacks as one coherent adapter.

| Field | Default and omission behavior | Concrete implementation example |
| --- | --- | --- |
| `theme` | Local shell-owned background and mode. If the block exists, the host owns state changes. | `theme: { mode, bgFor, onToggleMode, onPick, onReset }` |
| `theme.defaultBg` | `"#101014"`. The hub also derives its thumbnail palette from this value. | `defaultBg: "#101014"` |
| `theme.swatches` | The stock dark, black, blue, orange, light, and gray swatches. | `swatches: ["#101014", "#f5f0e8"]` |
| `theme.storageKey` | `"thumbmux-app-prefs"` when the shell creates its local preferences adapter. It does not affect a supplied `prefs`. | `storageKey: "terminal-shell-prefs"` |
| `theme.bgFor` | Falls back to the current local/default background. Returning `null` selects that fallback. | `bgFor: (session) => backgrounds[session] ?? null` |
| `theme.mode` | In `SessionView`, omitted callbacks fall back to surface luminance; in `HubView`, omitted callbacks are still host-owned and default to `false` (light-mode token contrast on the dark shell default), so host policy must pass it explicitly when hub contrast depends on a callback. | `mode: () => mode` |
| `theme.surfaceFor` | Derives a full surface with `defaultSurface(bgFor(session))`. Returning `null` keeps that fallback. A returned surface, including its palette, wins over `termProps().palette`. | `surfaceFor: (session) => defaultSurface(backgrounds[session] ?? "#101014")` |
| `theme.onToggleMode` | With no `theme` block the shell updates local state. With a block but no callback, the visible toggle is a no-op. | `onToggleMode: (next) => { mode = next; }` |
| `theme.onPick` | With no `theme` block the shell stores the selected background. With a block but no callback, swatch selection is a no-op. | `onPick: (session, hex) => { backgrounds[session] = hex; }` |
| `theme.onReset` | With no `theme` block the shell restores `defaultBg`. With a block but no callback, Reset is a no-op. | `onReset: (session) => { delete backgrounds[session]; }` |
| `labels` | Shallow-merges with `DEFAULT_APP_LABELS`. Every omitted established key keeps its stock English value; function-valued labels such as `hubCount` and `terminalAria` remain functions. The Bash disclosure and its package-owned flyout use the terse stock labels `BASH`, `SHOW`, `HIDE`, and `DISTILL`; `sessionPresentation.actions` may still place or relabel the BASH trigger, while the mutually-exclusive choices remain outside the frozen `FabAction` adapter type. | `labels: { hubTitle: "SESSIONS" }` |
| `killSession` | Opt-in dense-hub × action. The host confirms, performs the destructive mutation, reports errors, and refreshes the list; omission renders no kill control. | `killSession: confirmAndKill` |

The standalone `TermView` Claude Bash detector/projection types and helpers are
**experimental** (`X` contract tier): Claude Code controls the painted terminal
layout, so future minor releases may need to adjust those low-level shapes.
The assembled `SessionView` path above is the compatibility-preserving route.

A Svelte wrapper can keep host-owned theme state reactive:

```svelte
<script lang="ts">
  import { defaultSurface } from "thumbmux/core";
  import { ThumbmuxApp, type AppAdapters } from "thumbmux/app";

  let mode = $state<"dark" | "light">("dark");
  let backgrounds = $state<Record<string, string>>({});

  function modeBackground(): string {
    return mode === "light" ? "#f5f0e8" : "#101014";
  }

  const adapters: AppAdapters = {
    theme: {
      defaultBg: "#101014",
      swatches: ["#101014", "#f5f0e8"],
      storageKey: "terminal-shell-prefs",
      bgFor: (session) => backgrounds[session] ?? modeBackground(),
      mode: () => mode,
      surfaceFor: (session) => defaultSurface(backgrounds[session] ?? modeBackground()),
      onToggleMode: (next) => { mode = next; },
      onPick: (session, hex) => { backgrounds[session] = hex; },
      onReset: (session) => { delete backgrounds[session]; },
    },
    labels: {
      hubTitle: "SESSIONS",
      hubCount: (count) => `${count} open`,
    },
  };
</script>

<ThumbmuxApp {adapters} />
```

### 2.4 Host extension slots

These slots extend `SessionView`. `EmbedView` does not render the stock FAB,
HUD panel, host sheets, or these extension slots.

### Three ways to remove the shortcut editor without meaning to

`SessionView` mounts `ShortcutBar` and `ShortcutsSheet` by default, and falls back
to `localStorage` when no `prefs` adapter is supplied — so a bare `ThumbmuxApp`
mount can already edit its composer presets, with no wiring. Three supported
choices take that away, and none of them announces it:

1. **`sessionPresentation.actions` is final unless you include the `defaults` argument.**
   The callback receives existing stock+extra actions and must choose whether to
   keep or replace them; when this callback returns a custom list, that is the
   final FAB. To preserve stock actions, spread them:
   `actions: (session, ctx, defaults) => [...defaults, mine]`.
2. **`sessionPresentation.showShortcutBar: false`** hides the bar. The editor is
   still reachable from the FAB, so the presets remain editable but invisible until
   opened — which reads as "the feature is gone" to anyone who does not know it is
   behind the FAB.
3. **`EmbedView` has no FAB at all**, by design. Embeds are read-mostly surfaces; if
   you want preset editing, you want `SessionView`.

If presets are missing in a host you did not write, check those three before
concluding the package omits the feature.

| Field | Default and omission behavior | Concrete implementation example |
| --- | --- | --- |
| `extraActions` | Adds nothing. Returned actions are appended after the stock actions, and the shell closes the FAB before invoking one. | `extraActions: (session, context) => [{ id: "help", label: "Help", onTap: () => context.prefill("Help with " + session) }]` |
| `SessionActionContext.submit` | Available inside `sessionPresentation.actions` and `extraActions`; it uses the shell's agent-aware `submitPlan` path. | `onTap: () => context.submit("status")` |
| `SessionActionContext.prefill` | Available inside `sessionPresentation.actions` and `extraActions`; it opens the composer with editable text and does not send it. | `onTap: () => context.prefill("Explain the last command")` |
| `SessionActionContext.copyAll` | Available in `sessionPresentation.actions` and paste-unavailable upload fallback callbacks. It returns `Promise<boolean>` and indicates whether terminal copy succeeded. **Whole-buffer only** — ignores any native selection. Stock FAB copy is selection-first (`copySelection` then `copyAll`); an action that only calls `copyAll()` deliberately copies the entire screen even when the user selected text. | `onTap: () => void context.copyAll().then((ok) => ok || context.prefill("copy failed"))` |
| `extraPanel` | Renders nothing. A supplied `Snippet<[string]>` is appended to the expanded HUD panel and receives the session name. | `{#snippet extraPanel(session)}...{/snippet}` |
| `titleAdornment` | Renders nothing. A supplied `Snippet<[string]>` receives the session name. In the default HUD it renders inline after the name and can be **withheld** when both values cannot fit; the name keeps the full width. In `headerLayout: 'dense'` it is the activity field in `name : note : activity : expand`, wraps, and never collapses. Use `extraPanel` for larger content. | `{#snippet titleAdornment(session)}<b>{elapsed(session)}</b>{/snippet}` |
| `extraSheets` | Renders nothing. A supplied `Snippet<[string]>` is rendered at the end of the session stage and receives the session name. The host owns its styling and open state. | `{#snippet extraSheets(session)}...{/snippet}` |
| `extraDismissables` | Behaves as `() => false`. This is a command: close one host overlay and return `true`; do not use it to query state. A `true` result consumes that stage/FAB interaction. | `extraDismissables: () => { if (!helpOpen) return false; helpOpen = false; return true; }` |
| `extraOverlayOpen` | Behaves as `() => false`. This is a side-effect-free query used to mark the FAB active. | `extraOverlayOpen: () => helpOpen` |

The snippet slots must be created in Svelte, not manufactured as HTML strings:

```svelte
<script lang="ts">
  import { SessionView, type AppAdapters } from "thumbmux/app";

  let { session }: { session: string } = $props();
  let helpOpen = $state(false);

  const adapters: AppAdapters = {
    extraActions: (name, context) => [{
      id: "help",
      label: "Help",
      onTap: () => {
        context.prefill(`Help with ${name}`);
        helpOpen = true;
      },
    }],
    extraPanel,
    extraSheets,
    extraDismissables: () => {
      if (!helpOpen) return false;
      helpOpen = false;
      return true;
    },
    extraOverlayOpen: () => helpOpen,
  };
</script>

{#snippet extraPanel(name: string)}
  <p>Host details for {name}</p>
{/snippet}

{#snippet extraSheets(name: string)}
  {#if helpOpen}
    <aside aria-label={`Help for ${name}`}>Host-owned help</aside>
  {/if}
{/snippet}

<SessionView {session} {adapters} />
```

## 3. Pairing with `createAppRoutes`

`createAppRoutes` assembles the reference HTTP routes and tmux WebSocket mux,
but it does not own the listener. Its `fetch` returns `null` for a request the
host still owns, so the host must continue its own router in that case.

```ts
import { createAppRoutes } from "thumbmux/server";

const appRoutes = createAppRoutes({
  basePath: "/terminal-api",
  spawn: { cwd: "/srv/app" },
  upload: { dir: "/srv/app/uploads" },
  prefs: { file: "./data/terminal-prefs.json" },
  kill: { enabled: false },
});

Bun.serve({
  port: 3000,
  async fetch(request, server) {
    const response = await appRoutes.fetch(request, server);
    return response ?? new Response("Not found", { status: 404 });
  },
  websocket: appRoutes.websocket,
});
```

Pair the matching client-only adapters explicitly:

```ts
import type { AppAdapters } from "thumbmux/app";
import { createServerPrefs } from "thumbmux/svelte";

const basePath = "/terminal-api";

export const adapters = {
  basePath,
  upload: {
    endpoint: (session) => `${basePath}/upload?session=${encodeURIComponent(session)}`,
    dir: "/srv/app/uploads",
  },
  prefs: createServerPrefs({ url: `${basePath}/prefs` }),
} satisfies AppAdapters;
```

`basePath` must match on the server and client when using the default session
bootstrap and default spawn launch; custom `fetchSessions` and `spawn.launch`
bypass those client URLs. It normalizes the same way on both sides. The
WebSocket is deliberately fixed at `/ws/tmux`; it does not move under
`basePath`. To use another WebSocket URL, configure the shared client mux once
before mounting any view:

```ts
import { configureTmuxMux } from "thumbmux/svelte";

configureTmuxMux({
  getUrl: () => "wss://terminal.example.test/ws/tmux",
});
```

That function configures only the browser. `createAppRoutes.fetch` upgrades
only the exact server path `/ws/tmux`; if the custom URL uses another path, the
host must own that upgrade route and forward its socket lifecycle to
`appRoutes.websocket`.

### Route and UI matrix

| Route | Server default | Stock shell expectation | What happens when it is disabled or omitted |
| --- | --- | --- | --- |
| `GET /ws/tmux` | Always owned; path is fixed. | By default, session inventory, pane output, keys, resize, and history use the shared mux. `adapters.mux` replaces only the live session-list stream used by `HubView` and `SessionView`; fallback HUD status, default keys, and `TermView` transport remain on the shared singleton. `EmbedView` does not read `adapters.mux`. | Supply `adapters.mux` for a host-owned live session stream and `sendKeys` separately if input must use a host transport. Every mux still in use must connect to an authorized WebSocket endpoint; configure the shared singleton while `TermView` uses it. |
| `GET {basePath}/sessions` | Always owned. | Default HTTP bootstrap, followed by WebSocket pushes. | Supply `fetchSessions` if another host route owns bootstrap. The configured live session-list mux subscription remains active. |
| `POST {basePath}/spawn` | Enabled; set `spawn: false` on the server to leave the path to the host. | Default `spawn.launch`. | Disabling the server route does **not** hide the new-terminal card or launcher. Supply a custom client `spawn.launch`; there is currently no adapter that removes the launcher. |
| `POST {basePath}/upload` | Disabled until server `upload` options are supplied. | Used only by `adapters.upload.endpoint`. | Omit the client `upload` block, or return `null` for a session, to hide the upload action and file-paste hook. Server configuration alone never advertises the route to the client. |
| `GET` / `PUT {basePath}/prefs` | Disabled until server `prefs` options are supplied. | Used only by a supplied server preferences adapter. | Omit client `prefs` to fall back to local storage. Theme, font, and shortcut UI remains visible. |
| `DELETE {basePath}/sessions/:name` | Enabled; set `kill: { enabled: false }` to leave it to the host. | The stock shell has no kill action. | Nothing is hidden. A host-added action must omit or disable its own kill control. |

When a `guard` is supplied to `createAppRoutes`, it authenticates and
authorizes every owned HTTP operation and every inbound mux message. Issuing
grants, choosing which principal may see which session, and protecting host
routes that receive a `null` fallthrough remain host policy.

## 4. Agent needs a human: feature 12

thumbmux does **not** detect agent state. It does not read pane text, inspect
processes, poll a classifier, or infer attention from tmux `attached` or recent
activity. The host performs detection and supplies a synchronous snapshot to
the shell through `sessionMeta`.

A host detector may combine:

- explicit pane markers or agent-specific regexes over a bounded pane tail;
- process state, exit status, or an agent-specific control channel;
- an LLM classifier with a defined output enum, confidence threshold, and
  stale-result policy.

None of those signals is universally reliable in isolation. The reference
host combines several layers, and its classifier and state machinery spans
thousands of lines. A small regex example should be treated as one host signal,
not as a detector supplied or endorsed by this package.

### 4.1 Define one host transition record

Persist one current record per session. `transitionId` is a UUID allocated once
when the classified value changes, and reused for every replay or delivery
retry. `changedAt` is an integer Unix epoch in milliseconds. The example puts
that host-owned record on the session row. Both the HTTP list and every
`__sessions` WebSocket push must use the same enrichment source; enriching only
`fetchSessions` is insufficient because a later authoritative push replaces
that bootstrap. A separate host stream is possible only when its client writes
to a reactive store that `sessionMeta` reads, which is outside this primary
recipe.

For example, decorate the reference driver so both `GET {basePath}/sessions`
and session-list WebSocket pushes carry the latest snapshot. The detector calls
`setAgentState` only after completing the transition transaction described in
section 4.2. Replace the in-memory map with the read-through view of that
durable store in a multi-process host.

```ts
import {
  createAppRoutes,
  createBunTmuxDriver,
  type TmuxDriver,
} from "thumbmux/server";

type HostAgentState = "unknown" | "working" | "idle" | "waiting" | "finished";
type AgentStateSnapshot = {
  value: HostAgentState;
  changedAt: number;
  transitionId: string;
};

const latestAgentState = new Map<string, AgentStateSnapshot>();

export function setAgentState(session: string, snapshot: AgentStateSnapshot): void {
  latestAgentState.set(session, snapshot);
}

const baseDriver = createBunTmuxDriver();
const driver: TmuxDriver = {
  ...baseDriver,
  listSessions: () => baseDriver.listSessions().map((row) => {
    const agentState = latestAgentState.get(row.name);
    return agentState ? { ...row, agentState } : row;
  }),
};

export const appRoutes = createAppRoutes({ driver });
```

```ts
import {
  normalizeAgentNotificationEvent,
  type AgentNotificationEvent,
  type SessionListItem,
} from "thumbmux/core";
import type { AppAdapters } from "thumbmux/app";
import type { GridSession } from "thumbmux/svelte";

type HostAgentState = "unknown" | "working" | "idle" | "waiting" | "finished";

type ClassifiedSessionRow = SessionListItem & {
  agentState?: {
    value: HostAgentState;
    changedAt: number;
    transitionId: string;
  };
};

function toGridSession(row: SessionListItem): GridSession {
  const classified = (row as ClassifiedSessionRow).agentState;
  const result: GridSession = { name: row.name };
  if (!classified || classified.value === "unknown") return result;

  result.state = classified.value === "working" ? "working" : "idle";
  result.stateLabel = classified.value === "waiting"
    ? "Needs input"
    : classified.value === "finished"
      ? "Finished"
      : classified.value === "working"
        ? "Working"
        : "Idle";
  result.lastActivityAt = classified.changedAt;
  return result;
}

export const attentionAdapters = {
  sessionMeta: (rows) => rows.map(toGridSession),
} satisfies AppAdapters;

export function notificationFor(
  row: ClassifiedSessionRow,
  origin: string,
  urlForSession: (session: string) => string,
): AgentNotificationEvent | null {
  const classified = row.agentState;
  if (
    !classified
    || (classified.value !== "waiting" && classified.value !== "finished")
  ) return null;

  const state = classified.value;
  return normalizeAgentNotificationEvent({
    id: classified.transitionId,
    session: row.name,
    state,
    occurredAt: classified.changedAt,
    title: state === "waiting" ? "Agent needs input" : "Agent finished",
    body: "Open the session to continue.",
    url: urlForSession(row.name),
    tag: classified.transitionId,
  }, { origin });
}
```

Pass the route used by the chosen mount mode. For the split SvelteKit routes in
section 1.2 use `(name) => "/terminals/" + encodeURIComponent(name)`. For a
`ThumbmuxApp` mounted at the site root use
`(name) => "/?session=" + encodeURIComponent(name)`. A host mounted elsewhere
should provide its own pathname; the normalizer verifies the result against
`origin`.

There are intentionally two different state domains:

| Host result | `GridSession` projection | Notification event |
| --- | --- | --- |
| `unknown` (no reliable result) | omit `state` and `stateLabel`; no dot | none |
| `working` | `state: "working"`, label `Working` | none |
| `idle` | `state: "idle"`, label `Idle` | none |
| `waiting` | `state: "idle"`, label `Needs input` | `state: "waiting"` |
| `finished` | `state: "idle"`, label `Finished` | `state: "finished"` |

`GridSession.state` accepts only `"working" | "idle"`.
`AgentNotificationEvent.state` accepts only `"waiting" | "finished"`; do not
copy one enum into the other. `sessionMeta` must only project the latest
snapshot. Calling `notificationFor`, writing a database, or delivering from
inside `sessionMeta` would duplicate side effects because rendering may call
the projection again.

`normalizeAgentNotificationEvent` is the boundary before persistence or
delivery. It rejects unknown fields and invalid types, bounds all strings,
normalizes text, checks the timestamp, and canonicalizes `url` to a safe
same-origin path. Pass a configured trusted public origin on a server; do not
derive that trust value from an unvalidated forwarded host header.

### 4.2 Detect, transition, deduplicate, and publish

Run this algorithm outside the Svelte callback:

1. The host detector gathers its pane, process, and optional classifier
   evidence and produces one of the host states above, or no reliable result.
2. Represent no reliable result as `unknown`. In one durable transaction,
   compare the result with the session's stored current state. Repeated
   observations of the same state update evidence but create no transition.
3. On a real change, persist the new state, `changedAt`, and one new UUID
   `transitionId`. For `waiting` or `finished`, also persist the normalized
   event in an outbox. For `working`, `idle`, or unknown, create no event.
4. Publish the latest state snapshot through enriched session rows or a
   host-owned authenticated stream. That update makes `sessionMeta` repaint the
   dot and label.
5. Deliver each outbox event to each intended subscription. Retry failures with
   the **same** event and ID. Record dispatch acceptance by
   `(event.id, subscriptionId)` only after the provider acknowledges the
   request; that is not proof that a device displayed it or a person saw it. A
   browser `tag` is replacement grouping, not proof of delivery.

This supplies exact replay suppression: polling the same waiting pane, a mux
reconnect, an HTTP retry, or a worker restart does not allocate another event.
If the state/outbox tables are only in memory, duplicate notifications after a
host restart are an accepted limitation and must be stated by that host.

### 4.3 Show the normalized event in an active browser

Ask for permission from a real click. The permission helper calls the browser
API synchronously before its first `await`, preserving the user gesture.

```ts
import type { AgentNotificationEvent } from "thumbmux/core";
import {
  registerServiceWorker,
  requestNotificationPermission,
  showLocalNotification,
  type BrowserServiceWorkerRegistrationLike,
} from "thumbmux/svelte";

let registration: BrowserServiceWorkerRegistrationLike | null = null;
const shownIds = new Set<string>();
const inFlightIds = new Set<string>();
type LocalDeliveryResult = "shown" | "duplicate" | "in-flight" | "unavailable";

export async function enableNotifications(): Promise<boolean> {
  const permission = await requestNotificationPermission();
  if (!permission.ok) throw new Error(permission.error.message);
  if (permission.value !== "granted") return false;

  const worker = await registerServiceWorker({
    scriptURL: "/notification-service-worker.js",
    options: { scope: "/", type: "module" },
  });
  if (!worker.ok) throw new Error(worker.error.message);
  registration = worker.value.registration;
  return true;
}

export async function deliverLocal(event: AgentNotificationEvent): Promise<LocalDeliveryResult> {
  if (!registration) return "unavailable";
  if (shownIds.has(event.id)) return "duplicate";
  if (inFlightIds.has(event.id)) return "in-flight";
  inFlightIds.add(event.id);
  try {
    const shown = await showLocalNotification({
      registration,
      payload: event,
      origin: window.location.origin,
    });
    if (!shown.ok) throw new Error(shown.error.message);
    shownIds.add(shown.value.event.id);
    return "shown";
  } finally {
    inFlightIds.delete(event.id);
  }
}
```

Wire `enableNotifications` directly to the click, then call `deliverLocal` when
the host's authenticated event stream supplies the already normalized event:

```ts
import { deliverLocal, enableNotifications } from "./agent-notifications";

const button = document.querySelector<HTMLButtonElement>("#enable-notifications");
if (!button) throw new Error("Notification button is missing");

function reportNotificationError(error: unknown): void {
  console.error("Notification operation failed", error);
}

button.addEventListener("click", () => {
  void enableNotifications().catch(reportNotificationError);
});

export function onHostNotification(event: Parameters<typeof deliverLocal>[0]): void {
  void (async () => {
    const result = await deliverLocal(event);
    if (result !== "shown" && result !== "duplicate") return;
    const response = await fetch(
      `/host/notification-deliveries/${encodeURIComponent(event.id)}/ack`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error(`Delivery acknowledgement failed: HTTP ${response.status}`);
  })().catch(reportNotificationError);
}
```

`showLocalNotification` validates the event again, requires a secure context and
granted permission, calls `ServiceWorkerRegistration.showNotification`, and
returns a result rather than claiming delivery. The authenticated acknowledgement
endpoint marks this browser-stream channel accepted only after local display was
accepted (or after the page recognizes an already accepted ID). `in-flight` and
`unavailable` are not acknowledged, so the host can retry. The `shownIds` set
only suppresses replays in the current page lifetime; the durable host outbox
remains the source of truth.

Bundle this service-worker entry as `/notification-service-worker.js` so clicks
open only the normalized same-origin URL and provider push payloads use the same
validation contract:

```ts
import { registerNotificationServiceWorkerHandlers } from "thumbmux/svelte";

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const registered = registerNotificationServiceWorkerHandlers(worker, {
  push: {
    registration: worker.registration,
    trustedOrigin: worker.location.origin,
  },
  click: {
    clients: worker.clients,
    trustedOrigin: worker.location.origin,
  },
});

if (!registered.ok) throw new Error(registered.error.message);
```

The provider push message body must be the exact serialized event:
`JSON.stringify(event)`. Do not wrap it as `{ event }`; the push handler parses
the body directly and the strict event contract rejects that wrapper's unknown
field. The local-show helper internally stores `{ event }` as notification
click data, and the click helper unwraps that browser-owned shape.

The local flow above is not remote push. The host must still choose a push
provider and call the native `PushManager.subscribe` with that provider's
application-server key; `registerServiceWorker` only registers the script. Post
the resulting subscription to an authenticated host endpoint, persist it per
recipient and device, enqueue per-recipient deliveries, isolate provider
failures, and delete or refresh invalid endpoints. The host also defines
retention and authorization. The package supplies payload validation and
browser/service-worker helpers, not subscription storage, persistence, a
provider, network delivery, or an end-to-end guarantee. See the full
[notification boundary](notifications.md) before implementing those host-owned
parts.

## 5. Compatibility tier

`thumbmux/app` is **S — stabilizing throughout 0.8.x-0.9.x**. It is not frozen before
1.0. An app export may change only at a minor boundary while preserving the old
route through the alias and deprecation policy. See the compatibility
contract's [app-shell notice](../CONTRACT.md#known-non-guarantees) and
[tier definitions](../CONTRACT.md#tier-definitions).
