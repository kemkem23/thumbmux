# Desktop terminal interaction spec

This spec freezes the desktop contract for the Svelte terminal surface. The
mobile compositor, docked composer, and WebSocket protocol remain the base:
desktop adds a focusable keyboard wrapper, explicit geometry ownership, and
optional SGR mouse forwarding for full-screen TUIs.

## 1. Focus model

`DesktopKeys.svelte` is the only desktop keyboard focus target. It wraps the
terminal view and renders exactly one tab stop when enabled:

```svelte
<script lang="ts">
  import { defaultSurface } from 'thumbmux/core';
  import { DesktopKeys, TermView, tmuxMux } from 'thumbmux/svelte';

  const session = 'my-session';
  const palette = defaultSurface('#101014').palette;
  const sendKeys = (data: string) => tmuxMux.sendKeys(session, data);
</script>

<DesktopKeys onKeys={sendKeys}>
  <TermView {session} {palette} onKeys={sendKeys} />
</DesktopKeys>
```

Focus states:

| state | entry | exit | behavior |
|---|---|---|---|
| `blurred` | initial state, native `blur`, disabled/unmounted | click or Tab focuses wrapper | no terminal key routing |
| `focused` | wrapper receives native focus | native `blur`, disabled/unmounted, composition starts | key/paste events may route to the pane |
| `composing` | `compositionstart` while focused | `compositionend` or `compositioncancel` | keydown never routes to the pane |
| `selecting` | pointer movement exceeds the drag threshold or native selection is non-collapsed inside the terminal | selection collapses or focus leaves | copy uses browser behavior; clicks do not become SGR clicks |

Concrete rules:

- A terminal gains keyboard focus on native Tab navigation or on a primary
  pointer click inside the terminal wrapper.
- Click-to-focus must use `focus({ preventScroll: true })` and must not call
  `preventDefault()` on the pointer event. Native text selection must continue
  to work.
- Links and form controls inside or near the terminal keep their browser
  behavior. A click on an `<a>` must not be converted into a terminal tap or
  SGR click.
- Multiple terminals on one page follow normal browser focus: only the active
  `DesktopKeys` wrapper receives keydown/paste/composition events. Each
  interactive terminal is one tab stop in DOM order. View-only terminals are
  not in the tab order.
- Blur is native. Pressing `Escape` does not blur the terminal if
  `keyboardEventToSequence` maps it; it is sent to the pane.
- The focus ring is visual only: a 1 CSS px inset outline, no layout shift.
  Show it for `:focus-visible`. A host may also show a subtler focused state
  for pointer focus, but keyboard focus must always be visible.
- `DesktopKeys` must ignore events whose target is an editable or interactive
  element: `input`, `textarea`, `select`, `button`, `a`, or
  `[contenteditable="true"]`.

## 2. Key routing

`DesktopKeys` calls `keyboardEventToSequence(e)` from `thumbmux/core` for
terminal keyboard input. That helper is the source of truth for key encodings:
`null` means the browser handles the key; `null` is also returned while IME
composition is active; Meta combinations return `null`; Ctrl+C returns `\x03`
regardless of selection, so the caller must apply the copy policy in section 3.

Event algorithm:

1. If `DesktopKeys` is disabled, blurred, composing, or the event target is
   interactive/editable, return without side effects.
2. Handle copy and paste shortcuts before calling `keyboardEventToSequence`.
3. Call `keyboardEventToSequence(e)`.
4. If the result is `null`, do not call `preventDefault()` and do not stop
   propagation.
5. If the result is a string, collapse any active terminal selection, then call
   `preventDefault()`, `stopPropagation()`, and `onKeys(sequence)` exactly once.

Policy table:

| key gesture | route | prevent default |
|---|---|---|
| printable key, no modifier | send helper result | yes, only when helper returns a string |
| Enter, Backspace, Tab, Escape, arrows, Home/End, PageUp/PageDown, Insert/Delete, F-keys | send helper result when mapped | yes, only when helper returns a string |
| Ctrl+C with no terminal selection | send `\x03` from helper | yes |
| Ctrl+C with active terminal selection | browser copy | no |
| Ctrl+Shift+C or Cmd+C | browser copy or browser shortcut | no |
| Ctrl+V, Cmd+V, context-menu paste | browser emits `paste`; paste handler sends bracketed paste | eligible text paste is consumed before any async confirmation |
| Shift+Insert | explicit Clipboard API paste path when available; otherwise browser | yes when `readText()` is available, even if the read later fails or is empty |
| Meta/Cmd combinations | browser | no |
| helper returns `null` for any Ctrl/Alt/browser shortcut | browser | no |
| keydown while `e.isComposing` or internal composition flag is true | IME/browser | no |

`preventDefault()` must never be used just because the terminal is focused. It
is allowed for an actual terminal byte sequence, for an eligible non-empty
text paste consumed before confirmation, or for the explicit Shift+Insert
Clipboard API path.

## 3. Copy

Desktop copy must preserve native selection and must not accidentally send
Ctrl+C to the pane.

Selection detection:

- A terminal selection is active when `window.getSelection()` exists,
  `!selection.isCollapsed`, and either `anchorNode` or `focusNode` is contained
  by the `DesktopKeys` root.
- This is a caller-side policy layered over `keyboardEventToSequence` because
  the helper intentionally returns `\x03` for Ctrl+C.

Ctrl+C / Cmd+C rules:

- If a terminal selection is active, do not call `keyboardEventToSequence`, do
  not call `preventDefault()`, and do not call `onKeys`. Let the browser copy
  the selected DOM text.
- If no terminal selection is active, Ctrl+C follows the key-routing table:
  helper returns `\x03`, and `DesktopKeys` sends it.
- Cmd+C is never sent to the pane. If a terminal selection is active, browser
  copy handles it; otherwise the browser handles the shortcut.

Selection collapse rules:

- Do not collapse selection immediately after browser copy. The selected text
  should remain visible so the user can verify what was copied.
- Collapse terminal selection before sending any non-copy key sequence to the
  pane. This returns the terminal to input mode without losing the copy path.
- Collapse terminal selection after a successful terminal paste.
- Pointer clicks use native browser behavior: a clean click may collapse the
  selection; a drag may replace it. `DesktopKeys` must not force-collapse on
  pointerdown.

The existing `TermView.copyAll()` and `TermView.copySelection()` methods remain
programmatic copy helpers. They do not change the Ctrl+C routing policy above.

## 4. Paste

All terminal text paste paths send `bracketedPaste(text)` from `thumbmux/core`
through `onKeys`.

Paste sources:

- Ctrl+V / Cmd+V: do not route through `keyboardEventToSequence`. Allow the
  browser to emit a `paste` event on the focused wrapper, then handle it.
- Context-menu paste: handle the same `paste` event.
- Shift+Insert: if `navigator.clipboard.readText()` is available,
  `DesktopKeys` consumes the key event before awaiting the read. A failed or
  empty read sends nothing, but browser fallback is already consumed. If the
  API is unavailable, it leaves the key event alone and lets the browser try
  its paste path.

Paste handler rules:

- If a `paste` event has no clipboard data or its text is empty, return without
  side effects.
- If the paste contains files, do not handle them in `DesktopKeys`; file paste
  belongs to the composer/upload path when that UI has focus.
- Do not trim text and do not append Enter.
- For an eligible, non-empty text `paste` event, call `preventDefault()` and
  `stopPropagation()` synchronously before awaiting confirmation.
- After a paste is accepted, collapse any terminal selection and send
  `onKeys(bracketedPaste(text))` exactly once.
- Composer interaction is focus-based: when the composer textarea or mobile
  DIRECT input is focused, paste stays with `ComposerDock`. `DesktopKeys` must
  ignore those events.

Multiline/large paste warning:

- Defaults: warn when the paste has at least 6 logical lines or at least 4096
  UTF-8 bytes.
- `DesktopKeys` exposes `pasteWarningLines` and `pasteWarningBytes` props to
  adjust the thresholds. A value `<= 0` disables that threshold.
- `confirmPaste(info)` may be supplied by the host. If absent, use
  `window.confirm()` with a short generic message. If confirmation returns
  false, throws, or rejects, do not send anything. Eligible text paste events
  and explicit Shift+Insert reads remain consumed because confirmation may be
  asynchronous.
- Focus eligibility is evaluated when the paste event arrives. An async
  confirm dialog may move focus off the wrapper while the decision is pending;
  an ACCEPTED paste is still sent (exactly once) — never drop a confirmed
  paste because the dialog itself took focus.

## Submitting composer text

Composer SEND must avoid the paste-ingest/Enter race: some terminal apps ingest
the submitted text asynchronously, so sending text and Enter back-to-back can
submit an empty composer or only part of the text.

Use the core `submitPlan()` helper for composer sends. The plan is ordered:
send the text step first, send Enter after about 150 ms, and for two-step
composer TUIs send a second Enter after about 1 s. Hosts that submit over a
REST round trip usually satisfy the first delay naturally, but they should
still use the same plan so local and remote submit paths behave identically.

## 5. Scroll

Normal mode is local virtual scroll. `TermView` continues to own the existing
scroll engine:

- Wheel events call the local virtual-scroll path, prevent page scroll, and do
  not send keys.
- `bottomOffsetPx === 0` means the view is pinned to the live tail. Wheel-down
  at the bottom is a no-op and future output remains visible.
- Wheel-up increases local scroll offset. **Any positive offset**, even less
  than one row, means the reader is no longer following the tail. When the user
  reaches the top edge, `TermView` may request older history through the
  existing history path.
- While away from the tail, appends and full resyncs preserve the same physical
  scroll position instead of moving the viewport. `scrollToBottom()` sets the
  offset to exactly zero before flushing any content deferred by a gesture or
  selection, then future output follows again.

When `altScreenMouse=true`, wheel events are forwarded to the pane instead of
moving local scroll:

**Alternate-screen scrollback (package-owned note, since 0.15.3).** When
`screen.alt` is true the pane has no tmux scrollback: `TermView` suppresses
`history_expand`, holds one pane height of rows, and wheel/touch produce only
rubber-band movement. The component renders a compact `role="note"` banner
(`.mtv-no-scrollback`, `data-testid="mtv-no-scrollback"`,
`data-no-scrollback="1"`) so the surface is not mistaken for a frozen terminal.
Hosts may still add their own chrome; the package note is the minimum so every
`grok-*` / fullscreen Claude Code surface explains itself without host glue.
Unknown screen mode (no sample yet, no explicit `screen` prop) is treated as
**normal** — `history_expand` still fires, because blocking until a sample
arrives silently killed history for every host that never populates `screen`.
A late reply is discarded once `screen.alt` is known; a prepend that landed
while mode was unknown is dropped when the first sample (or a flip) is alt.

This paragraph is about scrollback retention specifically. Whether the pane
also claims the pointer is a separate, independent signal (`screen.mouseSgr`,
not `screen.alt`) — see "Pointer-claim contract" under Props contract.

v0.3.1 note: `TermView` owns touch forwarding under `altScreenMouse=true`.
Hosts should not capture touch gestures for SGR forwarding; links, selection,
local scroll fallback, and terminal mouse sequences are resolved inside
`TermView`.

1. Prevent default and stop propagation for wheel events inside the terminal.
2. Compute the current terminal content geometry from the measured cols/rows
   and visible content rect.
3. Call `contentCellFromPoint(e.clientX, e.clientY, rect, geom)`. If it returns
   no hit, do not send anything.
4. Accumulate the event's line delta (`wheelDeltaToLines`, which applies the
   pixel-mode scale) into a fractional remainder, and flush at most once per
   animation frame with `consumeWholeWheelLines` — only WHOLE lines are ever
   sent and the fraction carries over. Precision trackpads emit dozens of
   sub-line deltas per second; without accumulation every micro-event would
   inflate to a full wheel line.
5. On flush, send `onKeys(sgrWheel(dir, cx, cy, count))`, where `dir` is
   `"up"` for wheel-up and `"down"` for wheel-down, `count` is the whole-line
   count clamped to `DEFAULT_WHEEL_MAX_PER_CALL`, and `cx/cy` are 1-based
   terminal cells from the hit test with the row clamped above the TUI's
   bottom composer margin (full-screen TUIs ignore wheel events over their
   composer box).

Snap-to-bottom behavior:

- In normal mode, `scrollToBottom()` keeps its existing local behavior.
- In `altScreenMouse=true`, `scrollToBottom()` must send
  `sgrSnapToBottom(cx, cy)` instead of relying only on local scroll. Use
  `centerContentCell(geom, { composerRows })` for the coordinates. The local
  bottom offset may also be reset so the next capture paints at the live tail.

## 6. Click in alt-screen apps

When `altScreenMouse=true`, a plain left click can become an SGR click. It must
not steal link clicks or text selection.

Despite this section's title, the actual trigger is `screen.mouseSgr` (live or
explicit), not `screen.alt` — a pane can claim clicks from the main screen
too. See "Pointer-claim contract" under Props contract.

Pointer algorithm:

1. On primary-button `pointerdown`, record `clientX`, `clientY`, pointer id,
   target, timestamp, and the current selection state. Do not send anything.
2. Do not call `preventDefault()` on `pointerdown`; native selection must work.
3. Use a drag threshold of 6 CSS px, measured with Euclidean distance from
   pointerdown to pointerup. Movement beyond that threshold is a drag.
4. On `pointerup`, resolve precedence:
   - Link hit: if the gesture is still a clean click and the up target or one
     of its ancestors is an `<a>`, let the link open and send no SGR sequence.
   - Selection drag: if movement exceeded 6 CSS px, or native selection is now
     non-collapsed inside the terminal, send no SGR sequence.
   - SGR click: hit-test the pointer location with `contentCellFromPoint` and
     send `onKeys(sgrClick(cx, cy))` when a cell is hit.
5. After sending an SGR click, suppress the browser's synthetic `click` event
   for that gesture so it cannot also trigger `onTap` or link behavior.

Only plain primary clicks are forwarded. Right-click, middle-click, modifier
clicks, and browser context-menu gestures stay with the browser.

## 7. Geometry ownership

`TermView` keeps the current mobile `pushGeometry` behavior as the base:
measure the rendered monospace cell width and row height, derive cols/rows from
the host rect, add back visual-only bottom insets, and send `resize` through
the mux.

`claimGeometry=true`:

- Default for a full interactive terminal.
- `TermView` sends resize requests on mount, reconnect, pageshow, visibility
  return, font-size change, and ResizeObserver changes.
- The view must have a non-zero visible rect and `document.visibilityState`
  must be visible before sending a resize.
- The composer, shortcut bar, and OS keyboard are visual insets. They reduce
  the visible viewport but must not shrink the pty; add `bottomInsetPx` back
  before computing rows.

`claimGeometry=false`:

- `TermView` never calls `tmuxMux.sendResize` and never sends a `resize` frame.
- It still measures its local rect for rendering, hit-testing links, cursor
  placement, and optional read-only scroll.
- It adapts to whatever geometry the server streams for the pane.

`claimGeometry` and `altScreenMouse` are independent:

- They answer different questions. `claimGeometry` asks **who owns the pane
  size**; `altScreenMouse` asks **where pointer input goes**. Neither is the
  other's inverse, and an alt-screen TUI needs a correctly sized pty exactly as
  much as a normal one does.
- The pairing is easy to misread because on view-only surfaces both are `false`
  together (section 8). That is the two rules agreeing, not one rule.
- A primary interactive terminal for a full-screen TUI is
  `claimGeometry=true, altScreenMouse=true`. Deriving one from the other —
  `claimGeometry={!isAltScreen}` — silently gives that terminal whatever size
  some other viewer last asked for, and nothing reports it.

Multiple viewers:

- The server arbitrates simultaneous resize requests. Clients must not depend
  on last-writer-wins behavior.
- Client contract: set `claimGeometry=true` only for a visible, interactive,
  primary terminal surface. Thumbnails, popovers, secondary or duplicate
  embeds, background tabs, and duplicate viewers of the same session use
  `claimGeometry=false`.
- `EmbedView` defaults its direct `claimGeometry` prop to `false` and does not
  inherit `termProps.claimGeometry`. Pass `claimGeometry={true}` only when that
  contained embed is the one visible, interactive, primary geometry owner.
- When a terminal becomes hidden or disabled, it stops claiming. When it
  becomes visible again, it may force one re-claim if `claimGeometry=true`.

## 8. View-only surfaces

View-only surfaces are renderers, not controllers.

| surface | focus | keys | resize claim | SGR mouse | scroll |
|---|---|---|---|---|---|
| thumbnail/tail card | no | no | no | no | no internal scroll |
| popover viewer | no | no | no | no | local scroll allowed |
| embedded read-only terminal | no by default | no | no | no | host choice; local scroll allowed when useful |

Rules:

- Do not wrap view-only surfaces in `DesktopKeys`.
- Always pass `claimGeometry=false`.
- Always pass `altScreenMouse=false`.
- Thumbnails should use tail-mode subscriptions and clip to their card. The
  card may be clickable as a whole, but the terminal miniature itself is not
  scrollable or focusable.
- Popovers may use full subscriptions and local scroll so users can inspect
  recent output. They still do not send keys, resize, or SGR mouse events.
- Text selection/copy may be enabled in popovers and embeds, but keyboard input
  remains disabled.

## 9. IME / composition

Direct-character desktop layouts (including Thai, Latin, and Cyrillic) work
without breaking DOM selection. `DesktopKeys` also handles composition events
when the browser emits them; candidate-window IMEs have the limitation below.

Recommended `DesktopKeys` implementation:

- Use a focusable wrapper element (`div tabindex="0"`), not a hidden input and
  not `contenteditable`.
- Listen for `compositionstart`, `compositionend`, and `compositioncancel` on
  the wrapper.
- While composing, set an internal composing flag. Keydown events must return
  without calling `keyboardEventToSequence`.
- On `compositionend`, if `event.data` is non-empty, call `onKeys(event.data)`
  exactly once. Send the composed text as-is: do not trim, normalize, or append
  Enter.
- On `compositioncancel`, clear the composing flag and send nothing.

Rationale:

- The mobile DIRECT path uses a ghost input because mobile OS keyboards require
  a real input element to appear. Desktop physical keyboards do not need that.
- A hidden input on desktop tends to steal or collapse the terminal's real DOM
  selection, which makes copy unreliable.
- `contenteditable` risks browser DOM mutation inside rendered terminal output.
- A focusable wrapper keeps keyboard focus and native selection on the same
  surface. `keyboardEventToSequence` still guards composition by returning
  `null`; the wrapper's composition flag is the caller-side belt-and-suspenders
  guard.

Known limitation:

- Layouts that type characters directly (Thai, Latin, Cyrillic, …) work fully:
  each keystroke arrives as a printable `e.key` and is sent as-is.
- Composed IME input (Japanese/Chinese/Korean candidate windows) does not
  activate on a non-editable wrapper in current browsers, so composed text
  cannot be typed straight into the pane. Users type composed text through the
  composer (a real textarea) instead. The composition listeners above are kept
  so the wrapper stays correct in browsers/agents that do fire them.

## 10. Links

Terminal URLs remain DOM links on desktop.

- Plain click on a terminal link opens it in a new tab with `noopener`
  semantics, matching mobile behavior.
- Link clicks have precedence over terminal tap handling and SGR mouse
  forwarding. If a click resolves to an `<a>`, do not call `onTap`, do not send
  `sgrClick`, and do not collapse selection manually.
- Modifier-click behavior belongs to the browser. `DesktopKeys` and `TermView`
  must not prevent default on link clicks.
- Link hit testing must use the rendered link ranges from the terminal line
  renderer, including URLs that wrap across lines at the current pane width.
- Links work in `claimGeometry=false` viewers because they are DOM anchors.
  View-only surfaces may open links while still sending no keys, no resize, and
  no SGR mouse events.

## Props contract

### `TermView.svelte`

Existing props and callbacks remain. New/changed desktop props:

```ts
import type { AnsiPalette } from 'thumbmux/core';

type TermViewProps = {
  session: string;
  palette: AnsiPalette;
  fontPx?: number;                 // default 13 (TermView itself has no range clamp)
  minCols?: number;                // default 20
  minRows?: number;                // default 15
  bottomInsetPx?: number;          // default 0
  claimGeometry?: boolean;         // default true
  altScreenMouse?: boolean;        // default false
  screen?: { alt: boolean; mouseSgr: boolean; mouseAny: boolean } | null;
                                    // default undefined — live wire sample wins once one arrives
  onKeys?: (data: string) => void; // gate for SGR routing from either source — see below
  onTap?: () => void;
  onLinesChange?: (
    lines: string[],
    meta: { source: 'live' | 'prepend' | 'replace' },
  ) => void;
  onGeometryChange?: (geometry: { cols: number; rows: number }) => void;
  onScrollStateChange?: (state: { bottomOffset: number; scrolledUp: boolean }) => void;
};
```

`fontPx` on `TermView` is an unconstrained CSS pixel size: whatever the host
passes is rendered immediately. A change of `fontPx` **does not** send a tmux
resize on every tap — the pane geometry is pushed **220ms after the last
font change** so a burst of A+/A− produces one `resize` (Claude Code reprints
its header on every pane resize). Viewport `ResizeObserver`, visibility
return, and mount still resize immediately. A pending font resize is flushed
on unmount. The stock A+/A− range (default 4–40, host-overridable via
`sessionPresentation.fontPxMin` / `fontPxMax`) lives on `SessionView` only —
see `docs/app.md` "Terminal font size". A desktop host that drives TermView
directly (no SessionView) owns its own clamp and step.

`claimGeometry=false` is absolute: no resize frames, including mount,
reconnect, visibility return, font changes, or ResizeObserver changes.

`altScreenMouse=true` requires `onKeys`. If `onKeys` is absent, SGR mouse
actions are no-ops and should warn in development builds only. The same gate
applies when a live or explicit `screen` reports `mouseSgr: true`: `onKeys`
decides whether SGR routing can activate at all, whichever source supplied
`true`. A view-only surface that samples a live `screen` and never wires
`onKeys` stays inert instead of losing scroll — see "Pointer-claim contract"
below for why a pane can want the pointer at all.

`onScrollStateChange` is a boundary notification: it fires when `scrolledUp`
changes, and `bottomOffset` is the offset at that transition. `scrolledUp` is
true for every positive internal offset; a positive fractional offset is
reported as at least `1`, so the public sentinel `bottomOffset: 0` always means
the exact live tail. It is not per-frame scroll telemetry.

Public methods keep their names:

```ts
type TermViewHandle = {
  copyAll(): Promise<boolean>;
  copySelection(): Promise<boolean>;
  isScrolledUp(): boolean;
  scrollToBottom(): boolean; // false when an active selection blocks scrolling
  refreshGeometry(): void;   // no resize send when claimGeometry=false
};
```

### Pointer-claim contract: `screen.mouseSgr`, not `screen.alt`, decides who gets the wheel

A pane's `MuxPaneScreen { alt, mouseSgr, mouseAny }` is sampled from the
multiplexer's own state (tmux's `#{alternate_on}` / `#{mouse_sgr_flag}` /
`#{mouse_any_flag}`) and reaches the host on every full frame and delta. A
host does not have to opt in to receive it, and `TermView` already prefers a
live sample over its own `altScreenMouse` prop once one has arrived (see
`screen` above) — nothing new needs to be built to observe this.

**The three fields are not one signal.** `alt` says which screen buffer is
active. `mouseSgr` / `mouseAny` say whether the running program has asked the
terminal to report pointer events to *it* instead of to native scrolling.
These are set independently by whatever is running in the pane, and a program
can ask for the pointer while sitting on the **main** screen —
`alt: false, mouseSgr: true` is a real, observed combination, not a
theoretical one. Do not infer one field from the other, and do not gate
pointer-forwarding logic on `alt` when the question is actually `mouseSgr`.

**What happens once a pane claims the pointer.** When `mouseSgr` (live or
explicit) is true, `TermView` forwards wheel and click to the pane as SGR
sequences instead of moving local scroll (sections 5–6). That is correct
*only if* the pane does something useful with those bytes — its own
scrollback, its own paging. If a pane claims the pointer but does not retain
output anywhere a host can reach it — no growing multiplexer history, no
in-pane scroll surface wired to the forwarded bytes — the user is not looking
at a degraded terminal. There is no route back to earlier output at all: not
local scroll (the pane owns the wheel now), not a "scrolled up" indicator,
nothing. This state is reachable by spawning a normal, working program with an
unlucky combination of flags; it needs no bug in thumbmux or in the program.

**Whose job it is to prevent that.** thumbmux reports what a pane already
claims; it has no channel to ask a subprocess to release the pointer or to
make it retain history — those are properties of the program the host chose
to run and how the host chose to run it. The only party in a position to avoid
the trap is **the host that spawns the process**, by picking whichever mode or
flag that program offers for handing scrollback (and the pointer) back to the
terminal. And because that choice is made by flag, not guaranteed by contract,
a host that makes it must **verify it took** — after spawning, confirm the
pane is actually reporting `mouseSgr: false` (via the first live `screen`
sample, or a direct query to the multiplexer if the check needs to happen
before a frame arrives) rather than trusting that the flag was accepted. A
mode like this can fail its own internal feature probe and silently fall back
to the pointer-claiming mode, with nothing surfaced to say so — the pane just
quietly stops growing its history again.

**Worked example: grok.** Measured on a real `grok 0.2.102` session, three
ways to start it:

| spawn mode | `alt` | `mouseSgr` | history after a long answer |
|---|:---:|:---:|---:|
| `--no-alt-screen` (inline mode) | 0 | **1** | **15** — flat, nothing new retained |
| `--minimal` | 0 | **0** | **555** — grows with the conversation |
| `--fullscreen` | 1 | 1 | 0 — by design, alt-screen keeps none |

The first row is the trap this section describes: not on the alternate
screen, yet still holding the pointer, with nothing accumulating for the user
to reach. The second row is what a host should look for — the program itself
offers a mode that both releases the pointer and writes finalized output
where the multiplexer (and thumbmux) can page through it; the fix cost no
package code, because `TermView` already deferred to whatever the pane
reported. The one thing the host must still do is check that the mode
actually took, because this exact program can fall back from the second row
to the first without saying so.

### Native selection freezes scroll *and* live paint (full blast radius)

`TermView` re-reads `window.getSelection()` before deciding whether a gesture or
paint is safe. While a non-collapsed selection has its anchor or focus node
inside the terminal viewport (`[data-testid="mtv"]`), **six** independent paths
yield — not just wheel:

| Path | Effect while a selection is live |
|---|---|
| `applyScroll()` | Returns before the `translate3d` write. Nothing moves, even a scroll that would stay inside the already-mounted ±60-row corridor. |
| `onTouchStart` / `onTouchMove` | Touch scroll never establishes; mid-move after a collapsed selection also bails because no `touchstart` was accepted. |
| `onWheel` | Desktop wheel is a no-op. |
| `scrollToBottom()` | Returns `false`. The host ⤓ / "ล่าสุด" button is **silently dead**. |
| Live content gate | New pane output is coalesced into a pending capture and **not painted** until the selection collapses. |
| History prepend / search re-render | Deferred the same way — they replace row HTML and would destroy the selection's text nodes. |

This is intentional: the virtualiser unmounts rows that leave the corridor, and a
browser selection is anchored to concrete text nodes. The guard protects that
invariant. It is **not** a permanent freeze — collapsing the selection (tap
elsewhere, click outside the range, `Selection.removeAllRanges()`) fires
`selectionchange`, clears the flag, and re-arms deferred work. Nothing in the
UI says so, which is why the symptom reads as "page frozen".

**Supported host escape hatch.** TermView's own handlers re-read the live
selection on every entry, and both the element `wheel` listener and Svelte's
delegated touch listeners run in the **bubble** phase. A host may therefore
install a **document-level capture-phase** listener that collapses a terminal
selection before TermView sees the event:

```ts
function nodeInMtv(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return !!el?.closest('[data-testid="mtv"]');
}

document.addEventListener('wheel', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  // Scope to TermView only so chat/flow selections survive.
  if (!nodeInMtv(sel.anchorNode) && !nodeInMtv(sel.focusNode)) return;
  sel.removeAllRanges();
}, { capture: true });
```

Register touch as `{ capture: true, passive: true }` and never call
`preventDefault()` from that listener — Svelte marks `touchstart`/`touchmove`
passive by default, and you only need `removeAllRanges()`. A wheel may collapse
unconditionally (a wheel is never a selection adjustment). A touch should
collapse only when the contact point is clearly outside the selection's client
rects (inflate ~24px) so iOS selection-handle dragging still works.

Cost of the escape hatch, stated plainly: you cannot scroll *while keeping* a
selection. You cannot do that today either — today the view just stops
responding. The host trades an invisible freeze for a visible "selection went
away when you scrolled", which matches every native phone terminal.

### Copy: selection-first vs whole-buffer

- `copySelection()` — copies the live native selection when one exists inside
  the terminal; returns `false` when there is none (or copy fails).
- `copyAll()` — always copies the complete buffer (archive-backed when history
  is loaded). **Ignores** any live selection.
- Stock `SessionView` FAB copy calls `copySelection()` first and falls back to
  `copyAll()` only when selection copy returns `false`. That is the package
  default; `CONTRACT.md` names it "selection-first with whole-buffer fallback".
- A host that overrides the FAB (or any action) to call only `context.copyAll()`
  **gives that up**: a user who selected text and taps copy gets the entire
  screen. Do that only when the label and product intent are whole-screen copy.

### Host font contract (cell geometry is measured, not assumed)

`TermView` measures the **computed** font of its viewport to derive cell width
and row height. That measurement is only trustworthy when:

1. **`--font-mono` is set** on an ancestor to a monospace family. Unset → the
   browser falls back to a proportional face → cols/rows drift silently (no
   loud error). Documented since v0.13.0.
2. **The family covers every glyph the terminal can emit**, including
   box-drawing `U+2500–257F`. A missing glyph falls through to a different
   family with a **different advance width**, and the grid breaks by a few
   percent with no warning. The Google Fonts subset of JetBrains Mono ships
   **no** `U+25xx` range — hosts that set
   `'JetBrains Mono', 'Sarabun', …` without a mono face that covers box-drawing
   will mis-measure every TUI border.
3. **Script coverage is part of the same contract.** Thai, CJK, and other
   non-Latin scripts need a **monospace** face *for that script* in the stack
   (or a carefully `size-adjust`-matched second family). A proportional Thai
   fallback after a Latin mono primary is the same silent-grid failure as (2).
   From v0.15.7 `TermView` also **pins** one-cell non-ASCII clusters
   (`.mtv-w1`) the same way it already pins CJK/emoji (`.mtv-w2`): the box is
   one measured ASCII cell, so a missing script face can no longer walk the
   column grid. From v0.15.9 those letter boxes are `overflow: visible` —
   Thai `ำ`, Devanagari, and any mark that reaches left of its origin must
   paint into the previous cell; a clip deletes the glyph. `.mtv-w1.mtv-fit`
   (square symbols) still clips. The pin is not a substitute for a real mono
   face — marks still need a font that attaches them — but it is the only
   mechanism that works for scripts we will never ship a font for. Hosts
   whose face is already fixed-advance set
   `sessionPresentation.pinNarrowCells: false` and give the spans back.

Practical host checklist: pick a mono primary that includes box-drawing (self-hosted
full JetBrains Mono, Iosevka, Cascadia Mono, …), put script-specific mono faces
next, and only then a last-resort `monospace`. Use `size-adjust` / `ascent-override`
when a second family must share the grid. UI chrome that mixes Thai can use
`--font-thai` without affecting TermView cell metrics.

### `DesktopKeys.svelte`

New component exported from `thumbmux/svelte`.

```ts
type DesktopPasteInfo = {
  text: string;
  lineCount: number;
  byteLength: number;
  reason: "multiline" | "large" | "multiline-large";
};

type DesktopKeysProps = {
  enabled?: boolean;                 // default true
  focused?: boolean;                 // bindable, default false
  ariaLabel?: string;                // default "Terminal input"
  pasteWarningLines?: number;        // default 6; <=0 disables line threshold
  pasteWarningBytes?: number;        // default 4096; <=0 disables byte threshold
  altIsMeta?: boolean;               // default auto: false on macOS-like platforms
                                     // (Option composes characters), true elsewhere
  onKeys: (data: string) => void;
  onFocusChange?: (focused: boolean) => void;
  confirmPaste?: (info: DesktopPasteInfo) => boolean | Promise<boolean>;
  children?: import("svelte").Snippet;
};
```

Required DOM behavior:

- Root element: `tabindex={enabled ? 0 : undefined}` and an accessible label.
- `focused` mirrors native focus state and may be controlled by binding.
- `onFocusChange` fires after native focus/blur state changes.
- The component does not import or call `tmuxMux`; hosts pass `onKeys`.
- The component must not wrap the composer or other controls that should keep
  normal text editing behavior.
