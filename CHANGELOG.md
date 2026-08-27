# Changelog

Consumers pin the immutable `vX.Y.Z-dist` tags (prebuilt dists, no lifecycle
scripts): `thumbmux@github:<owner>/<repo>#v0.18.6-dist`.

## v0.18.6 — 2026-08-27

### Fixed

- **Initial history no longer duplicates terminal rows or jumps the reader at
  the durable live/archive seam.** Overlapping bootstrap, prepend and live
  deliveries are reconciled as one ordered boundary, including a pending newer
  frame followed by an older cached frame. A stale delivery is rejected before
  it can change screen metadata, content, cursor or the pending high-water mark.

- **The cursor stays on the rendered terminal cell while content, fonts and
  viewport geometry change.** Row-zero cursors re-anchor when an unchanged
  cursor coordinate receives a longer content tail; late web-font readiness,
  resize, Unicode combining sequences, CJK and emoji retain the same measured
  cell geometry as the rendered rows.

- **Raw tmux capture remains byte-faithful by default.** The optional capture
  normalizer is exported for explicit diagnostics, but the Bun driver does not
  rewrite ambiguous variation-selector padding before host WAL or archive
  ingestion.

- **Managed launch callbacks can retain their durable receipt across retries.**
  App and upload hosts may persist a returned launch receipt instead of losing
  it when the first presentation attempt is retried.

### Security

- **Release, contract and real-browser lanes now fail closed outside an
  attested disposable runtime.** The package rail fingerprints one frozen tree,
  private tmux target, namespaces, ports and credentials boundary; local lanes
  cannot silently claim the Docker/network lifecycle proof reserved for the
  public GitHub-hosted runner.

## v0.18.5 — 2026-08-25

### Fixed

- **Claude Bash compaction no longer cuts a soft-wrapped table, rule, marker,
  fake `Bash(...)` header, or permission dialog in half.** Physical rows at
  column zero are treated as ambiguous when the preceding result exactly fills
  the calibrated pane. A boundary in that lane must match Claude's measured
  marker wrapper; arbitrary shell colour is not identity. The paired 244-grey
  `rule / ❯ / rule` composer stays visible, approval semantics always fail
  open, and an exact `maxBlockLines` candidate is no longer rejected one row
  early. Retained segments painted at an older width (or separated from their
  composer), trailing-space wraps, exact ANSI marker/header/composer output,
  repeated fake Bash headers, and unknown rounded dialogs now fail open as one
  raw corridor rather than hiding only a prefix. Unknown Claude layouts remain
  raw rather than hiding uncertain content.

- **The terminal block cursor now measures the complete grapheme rendered in
  its cell.** Emoji variation sequences such as `❤️` occupy the same two-cell
  width as the ANSI renderer instead of painting a one-cell cursor over a
  two-cell glyph; ordinary text, Thai combining clusters, CJK, and emoji after
  compact one-third-row Bash dividers retain their calibrated position. Rows
  and the cursor also repaint in the same projection epoch, so changing between
  SHOW and HIDE cannot leave the cursor mapped through the previous mode or
  make it disappear.

## v0.18.4 — 2026-08-25

### Fixed

- **History-prepend diagnostics now fail closed when a compact Claude Bash
  seam changes presentation geometry.** The raw rendered corridor and its SGR
  entry state can remain reusable while the compositor origin moves by one
  third of a terminal row to preserve the same absolute reader anchor. Such an
  event now reports `cacheValid: false` unless its transform is also unchanged,
  instead of publishing a false cache success. A bounded 10,000-row regression
  crosses that Bash seam while evicting the opposite edge and proves the same
  raw row, text, and screen Y remain stable.

## v0.18.3 — 2026-08-24

### Fixed

- **The compact Claude Bash divider now occupies the centre of the separator
  gap instead of sitting below leftover blank rows.** A proven blank-only
  prefix and suffix are folded into the same one-third-row Bash projection;
  capture-start padding and retention seams still remain raw. The small
  `hidden bash` label is left-aligned and a one-pixel green rule fills only the
  space to its right. Incremental projection and both history paging modes now
  preserve the same raw cursor, search target, and reader anchor when newly
  loaded semantic context proves that a seam blank belongs to the Bash group.

## v0.18.2 — 2026-08-24

### Fixed

- **The first upward gesture on a short live terminal now enters archived
  history instead of snapping back to the live tail.** When the live Bash
  projection is shorter than the viewport, `TermView` preserves the atomic
  prepend anchor and then replays the wheel distance that had no physical
  scroll range before the history page arrived. Repeated wheels accumulate on
  the same request, down-then-up cancellation reclaims only the newest intent,
  retryable failures discard stale intent, and non-sliding history mode keeps
  its original live-tail behavior.

## v0.18.1 — 2026-08-24

### Fixed

- **A full outer tmux PTY is now treated as backpressure, not as a fatal proxy
  error.** The direct-PTY WAL proxy waits until stdout is writable and resumes
  from the first byte the kernel has not accepted. The output record remains
  fsynced exactly once, and a partial write followed by `EAGAIN` or `EINTR`
  neither duplicates nor drops displayed bytes. Launch specs also fingerprint
  the shipped Python helper; the proxy verifies those exact bytes before any
  WAL access and publishes the digest in its health record so a recovering host
  can reject a stale runtime asset before activation.

## v0.18.0 — 2026-08-24

### Added

- **A direct-PTY durable lane can preserve every terminal byte produced after a
  host declares its cutover boundary (T0).** The proxy writes checksummed output,
  resize, lifecycle, activation, and barrier records to its WAL and syncs them
  before the child output is displayed. A supervised replay worker materializes
  that WAL through bounded private-tmux replay and atomic checkpoints; its
  cross-process writer lease prevents two hosts from truncating or regressing the
  same materialized state. Restart and SIGKILL recovery resume from the durable
  sequence and WAL byte offset without inventing or silently dropping rows;
  unavailable exact recovery fails closed. Node 18 hosts use the same
  single-writer rule through the packaged Python/flock fallback when no native
  SQLite module is available. The seven intentional
  `thumbmux/server` integration exports are tier X while production hosts prove
  the cutover lifecycle: `createTerminalPtyWalProxyLaunchSpec`,
  `createTerminalReplayWorkerClient`, `resolveTerminalReplayWorkerPath`,
  `readTerminalPtyWalProxyHealth`, `TERMINAL_PTY_WAL_CONFIG_ENV`,
  `TerminalPtyWalProxyHealth`, and `TerminalWalController`. This machinery does
  not reconstruct bytes from before T0; sealing the old archive and fencing
  input during cutover remain host responsibilities.

- **`TermView` history retention is now a bounded, bidirectional sliding
  window.** It keeps a nominal 10,000 rows / 8 MiB, protects the mounted
  viewport and overscan, evicts the far edge as the reader pages in the other
  direction, and can fetch those evicted rows again while the server archive
  retains them. Absolute row identity and the visual anchor survive
  prepend/append/eviction, including Claude Bash projection, so crossing the
  archive/live seam does not duplicate, skip, or jump rows. A failed archive
  read now settles with a retryable correlated error rather than a false empty
  page, so the client retains and retries the same absolute cursor instead of
  declaring EOF.

- **Claude Code Bash calls can be shown raw, collapsed, or distilled by a
  host-owned service.** `SessionView` adds a Claude-only BASH disclosure whose
  SHOW / HIDE / DISTILL choices open directly to the left and stores the same
  `off | hide | haiku` preference values. Consecutive calls separated only by
  blank presentation rows become one semantic group. HIDE and non-selected
  DISTILL groups render as a green `hidden bash` divider one third of a terminal
  row high; `TermView` recalibrates virtual scroll, cursor, search, history
  anchoring, and gap coordinates to that variable-height projection while the
  exact raw rows remain canonical for copy/search/history/ANSI state. A fresh
  DISTILL view requests at most its newest ten completed groups, then requests
  only the newest group completed by each coalesced live update; scrolling never
  creates model work, and a group with an active tail waits as a whole.
  `AppAdapters.bashSummaries` remains optional; rejection or omission falls back
  to a deterministic command preview. The `thumbmux/core` detector/projection
  exports remain experimental because Claude's terminal layout may evolve.

## v0.16.8 — 2026-08-21

### Fixed

- **Grok Build TUI v1.0.x chrome is no longer stored as a recent prompt.** Live
  Grok 4.6 (measured on grok 0.2.102) echoes a bare `❯` at column 0 and then a
  status line such as `Grok 4.6 (high) · always-approve · 86K / 500K (17%) ·
  ctrl+o transcript` (token and queue fields change every few seconds). The
  scanner still understood only the June 2026 boxed composer, so an empty `❯`
  started a block that swallowed that chrome as a continuation, and a
  typed-but-unsent draft glued onto it. Empty payloads now return null;
  `isGrokStatusLine` joins the Claude/Codex status matchers. Legacy indent-5
  clocked echoes and boxed composers stay extracted as before. 100 table-driven
  pane cases plus a live v1.0.5 capture cover both scan APIs.

## v0.17.0 — 2026-08-16

### Added

- **`DurableHistoryArchive` can bound a session** — `maxLinesPerSession` and
  `maxBytesPerSession`, both **unset by default**, so every 0.16.x consumer keeps
  the unbounded behaviour it has today. When set, an append past the cap deletes
  whole chunk files from the oldest end and reports the count as the new
  `ArchiveAppendResult.prunedLines`. This is the only operation in the archive
  that destroys history, which is why it is opt-in and why the count is returned
  rather than merely logged. The cap is approximate and errs upward: whole chunks
  only, a chunk is dropped only when what survives still meets the cap, and the
  newest chunk is never dropped — so a cap smaller than one chunk keeps one chunk
  instead of emptying the session. See `docs/history.md` → "Size caps delete
  history".

`ArchiveAppendResult.prunedLines` is **optional in the type and always present at
runtime**. Making it required would narrow a tier-S declaration — anyone who
constructs the result, such as an alternative `HistoryArchiveLike` or a test
double, would stop compiling on a minor. The immutable-baseline gate refused the
required version, correctly.

### Not added, and why

A `TmuxWsMux.hasViewers(session)` accessor was drafted for `RetentionLane`, which
runs outside the mux and therefore outside `queueCapture` — a host running both
needs to keep the lane off sessions the viewer path is already archiving, or two
writers append to one archive and the loser's anchor stops matching the disk.

It is not here. `TmuxWsMux` is tier F, and a new method changes a frozen
declaration to answer a question the host can already answer: `MuxHooks`
`onSubscribe` / `onUnsubscribe` / `onSocketClose` report every transition, so a
host tracks its own set and passes `RetentionLaneOptions.hasViewers` from that.
The gate is what surfaced this, and the smaller surface is the better design.

### Fixed

- **Reads no longer report `startLine: 0` for a page that begins later.** Once a
  cap prunes the oldest chunks, line 0 does not exist. `readBefore` clamped its
  window to `0` regardless, so a page whose first line was really line 70 was
  labelled line 0 — shifting every number a caller derives from it — and
  `hasMore: start > 0` promised history that could no longer be served. Both
  `readBefore` and `readAfter` now clamp to the archive's true floor, and a
  request below it returns an empty page instead of a mislabelled short one. This
  is only reachable with a cap configured, so no 0.16.x consumer was affected.

## v0.16.3 — 2026-08-19

### Added

- **Opt-in dense HUD and live session cards.** `TermHud layout="dense"` renders
  the wrapping `name : note : titleAdornment : expand` header, copies the exact
  tmux name from the name control, and keeps expand separate. `SessionGrid
  cardLayout="dense"` adds host-owned `GridSession.note` / `summary`, a denser
  `SessionThumb`, full-width square coarse/mobile cards, and exact 500 × 500 px
  fine-pointer desktop cards; `showNew={false}` can hide the stock launcher.
  `HubPresentationOptions.cardLayout` and
  `SessionPresentationOptions.headerLayout` forward these modes through the app
  shell. Every option is additive and omitted by default, so existing HUDs,
  cards, thumbnail tails, and launchers remain unchanged.

### Fixed

- **Live output follows only at the exact live tail.** Any positive bottom
  offset, including a sub-line wheel movement, now counts as scrolled up.
  Appends and full resyncs that rewrite several tail rows preserve the reader's
  physical scroll position; `scrollToBottom()` explicitly returns ownership to
  the live tail before pending content is flushed.

## v0.16.2 — 2026-08-15

### Fixed

- **Periodic session metadata refreshes no longer blank every live thumbnail.**
  `SessionGrid` deliberately retains cards by session name, but each host
  snapshot replaces their metadata objects. The child session prop getter was
  invalidated by that new object even when it returned the same name, so all
  `SessionThumb` subscription effects cleared their live state, unsubscribed,
  and immediately subscribed again. When the last viewer left, the server also
  discarded that pane's cache and delta base, turning a harmless metadata tick
  into a 40-pane recapture and resync storm. Primitive derived equality barriers
  now isolate the subscription effect from object identity: equal `(session,
  maxLines)` values keep the existing subscription and `.tail`, while a real
  name or line-limit change still resubscribes.

### Documentation

- The desktop contract now states that `screen.mouseSgr` — not alternate-screen
  state alone — decides whether the terminal owns pointer input, and documents
  the host-side launcher/verification obligations for agents whose fullscreen
  modes may silently downgrade.

## v0.16.1 — 2026-08-15

### Fixed

- **Live session thumbnails no longer rebuild every terminal row when one line
  changes.** `SessionThumb` previously joined the complete tail into one HTML
  string, so Svelte assigned `innerHTML` on the container whenever even one
  spinner byte changed. Every `.mtv-line` node was discarded and recreated —
  about 44 rows per tile, even though production captures keep 75–85% of their
  rows byte-identical between adjacent frames. The tail now uses rows keyed by
  screen index and one `{@html}` block per row. Unchanged rows take Svelte's
  equal-string fast path while only changed row contents are replaced. ANSI SGR
  and OSC state still advances through the entire frame in order, including the
  discarded context above the visible tail, and the resulting line markup is
  byte-identical to the joined renderer. The thumbnail boundary uses
  `contain: layout paint`; it deliberately does not use `content-visibility`,
  which can leave blank space on Safari/iOS.

## v0.16.0 — 2026-08-15

### Added

- **History that keeps growing with nobody watching.** `RetentionLane` captures
  the sessions a host lists, on its own timer, with no viewer attached and no
  frames produced. Pair it with `DurableHistoryArchive`, which stores scrollback
  as plain text — one file line per terminal line, ANSI intact, chunk filenames
  that are their own absolute start line — so `cat`, `grep -a` and `sed -n` work
  with no parser in between. Its `index.jsonl` and `meta.json` are caches that a
  directory scan rebuilds, and a line torn by a power cut is dropped on open.
  See [docs/history.md](docs/history.md).

- **The live window is now durable, and reported separately.** The archive keeps
  the rows the viewer is still showing and exposes `liveStartLine`;
  `history_expand` pages from that boundary instead of from the end of the
  archive, so a client scrolling up still never sees a row twice. Those were one
  number before, which meant a session's newest rows lived only inside tmux — and
  a tmux server restart took them.

- `stitchCapture` / `locateAnchor` (`thumbmux/server`): the reconciliation both
  paths use, as a pure function. It anchors on what the archive already holds and
  stores everything above the visible screen — the only region tmux can repaint.
  The previous reconciliation tolerated two rewritten rows, which fits a shell
  prompt and not an agent: measured over 378 consecutive production captures,
  composers repaint five to eight rows and **96% of genuine scrolls archived
  nothing**, silently.

- `HistoryArchiveLike` gains optional `appendAnchored` and `liveStartLine`. An
  archive without them behaves exactly as before.

### Removed

- The mux no longer lowers a session's `history-limit` after seeding the
  archive. tmux applies that option only to windows created after it is set, so
  on every live pane the call reported success and changed nothing — and
  shrinking the ring is backwards for a polling archive, which relies on it to
  carry a burst between captures. `TmuxDriver.setSessionHistoryLimit` remains
  part of the driver contract; the mux simply never calls it.

## v0.15.9 — 2026-08-14

### Fixed

- **Thai (and any script whose ink reaches backwards) was being clipped out of
  its own cell.** v0.15.7 pinned one-cell letters in `.mtv-w1` and kept
  `overflow: hidden` on the box as a safety net. That net deletes correct
  glyphs. `ำ` (U+0E33 SARA AM) is a **letter**, not a mark — its นิคหิต is
  designed to sit above and to the left of its own origin, over the preceding
  consonant. At the shipped host face the ink starts at `x0 = −253` (42 % of a
  cell backwards). The box clipped at its left edge, so `ทำให้` painted as
  `ทาให้`: the vowel was not chipped, it was gone. Same mechanism, smaller
  reach, for `ๅ` and the pre-posed vowels `โ ใ ไ`, and for anything else
  (Devanagari included) whose marks reach left of the cell that reserved
  them.

  Letter boxes — `.mtv-w1`, `.mtv-w2`, `.mtv-wx` — are now `overflow: visible`.
  The clip stays only on `.mtv-w1.mtv-fit`, where we deliberately scale
  square symbol ink (`⚠`, `❤`) down and a clip is a real backstop. The grid
  does not move: a box is still exactly N measured ASCII cells; only what is
  *painted* changed. Do not "fix" this by shifting `ำ` into the middle of its
  own box — the นิคหิต belongs over the previous consonant.

  One glyph in the shipped host font still paints past its cell to the
  **right** when isolated: Devanagari `ि` (U+093F), about 2.5 px at 15 px.
  In real text it is absorbed into `हि` (`.mtv-w2`). The answer to a
  right-overflow is the font, not the box. The clip is not coming back.

## v0.15.8 — 2026-08-14

### Fixed

- **One-cell letters were drawn at 55 % — regression from v0.15.7.** The scale-to-fit clamp
`min(line-height, cell × 0.92)` is the right answer for square emoji
ink in a two-cell box. Applied to `.mtv-w1` it is `0.6em × 0.92 =
0.552em` every time — every Thai (and Greek, Cyrillic, …) letter
shrank to just over half size inside a correctly sized cell. The box
stays one measured cell; the ink now **inherits** the line's font size.
The clamp remains only on `.mtv-w1.mtv-fit`, which `lineToHtml` adds
for one-cell symbols (`⚠`, `❤`) whose ink really is a 1em square.
`.mtv-wx` (N≥3 letter conjuncts) inherits too. `.mtv-w2` is unchanged.
  v0.15.7 shipped a grid that was correct and half-legible; this restores the
  ink without moving a single box. Upgrade straight from 0.15.6 if you can.

## v0.15.7 — 2026-08-14

### Fixed

- **One-cell scripts were on the grid in tmux and off it in the browser** —
  v0.15.6 pinned CJK/emoji to two cells because the font's advance disagreed
  with tmux's column count. The same disagreement exists for every script we
  do not ship a fixed-advance face for. Hindi `हिन्दी` was the isolated
  arithmetic bug: `charCellWidth` treated **all** Unicode marks (`\p{M}`) as
  zero-width, including **Mc** (spacing combining). Mc vowel signs occupy a
  column — they sit beside the consonant. The old rule counted हिन्दी as 3;
  tmux measures 5. The rule is now Mn/Me → 0, Mc → 1. Thai is unchanged
  (every Thai mark is Mn). Verified per character in a live pane via
  `#{cursor_x}`. Neighbours from the same sweep: bidi format controls
  (LRM/RLM/ALM and the U+202A–202E / U+2066–2069 embeddings) are 0 in tmux
  and now 0 here; **SHY U+00AD and U+0600 stay 1** — not every Cf is zero,
  which is why this cannot be `/\p{Cf}/`.

  The render path now pins **one-cell non-ASCII clusters** the way v0.15.6
  pinned two-cell ones: a base plus its trailing marks (Mc stays with the
  consonant so the shaper can reorder a left-matra) lands in
  `<span class="mtv-w1">`, sized to exactly one measured ASCII cell, glyph
  scaled to fit, never clipped. A cluster that absorbs Mc and occupies two
  cells reuses `.mtv-w2`. ASCII and box-drawing / braille stay
  **byte-identical** — no wrapper, not one extra byte. v0.15.6's CJK and
  emoji behaviour is unchanged.

  Hosts whose `--font-mono` is already fixed-advance for every script can
  turn the one-cell pin off: `sessionPresentation.pinNarrowCells: false`.
  That gives up the grid guarantee for those scripts. Dual-width CJK/emoji
  pins stay on. `EmbedView` does not read the presentation option; a
  standalone `TermView` always pins. The switch is not a new TermView prop
  (that surface is F-tier).


  **Thumbnails pin too.** `SessionThumb` already went through `lineToHtml`,
  so v0.15.6's `.mtv-w2` and this release's `.mtv-w1` were in every hub
  card — but TermView scopes the box CSS under `.mtv-line`, which a
  thumbnail `<div>` is not. The spans were paid for and did nothing.
  `SessionThumb` now owns the same pin CSS and measures `--mtv-cw` from
  ten ASCII Ms (same as TermView). Bare `1ch` is a cell in this face
  (0.997–1.000 × M at 7–13px) but cannot be used for both `width` and
  `font-size` on the same element — `ch` follows the new size and the
  box shrinks. A mis-aligned box table in a card is the same defect at
  a smaller size.

  Devanagari conjuncts such as `क्ष` and the tail of `हिन्दी` (`न्दी`, 3
  cells) are pinned as one grapheme so the virama can still join. The box
  is N cells; the ink is narrower. That is the pin doing its job, not a
  remaining width bug. Splitting on "base + marks" painted a visible
  virama — `Intl.Segmenter` is what keeps the conjunct in one box. Scripts we could make agree on
  the cell count (live tmux vs `stringCells`): Latin, Vietnamese, Greek,
  Cyrillic, Arabic, Hebrew, Thai, Lao, Khmer, Myanmar, Tamil, Bengali,
  Telugu, Gujarati, Gurmukhi, Kannada, Malayalam, Sinhala, Tibetan, Hangul,
  Hiragana, Katakana, CJK, Armenian, Georgian, Ethiopic, Cherokee, Yi,
  Tifinagh, N'Ko, emoji, box-drawing, braille. Three Cf marks disagreed
  before the neighbour pass and agree now.

## v0.15.6 — 2026-08-14

### Fixed

- **Wide glyphs were two cells in the column arithmetic and about 1.6 on screen** —
  `charCellWidth` has always known that CJK, fullwidth forms and emoji occupy two
  terminal columns, but only `terminal-link`'s column maths consulted it. The
  render path handed text to the browser and let the font's advance decide, so
  every line containing one drifted against the grid tmux is counting: box
  tables stepped, the caret sat wrong, link hit targets missed. `ansi-html` now
  wraps each dual-width code point in `<span class="mtv-w2">` and `TermView`
  pins that box to exactly two measured ASCII cells, **scaling the glyph to fit
  rather than clipping it**, so every wide glyph lands in an identical box —
  same width, same height, same baseline. Measured on-grid at every size from 4
  to 40. ASCII-only output is byte-identical, and Thai and braille are
  untouched because they are genuinely one cell.

  The width table itself was also wrong in a way that showed up in ordinary
  status tables: `WIDE_RANGES` jumped from `0x1100` straight to `0x2e80`, so
  **the emoji that predate the `0x1F000` plane counted as one cell** — `✅`
  U+2705, `❌` U+274C, `⭐` U+2B50, `❗` U+2757, `⌚` U+231A and the rest of the
  East-Asian-Wide entries in Dingbats and Miscellaneous Symbols. Those are the
  check marks and crosses that appear in every generated table, and each one
  cost its row a column. The wide set now follows `EastAsianWidth`, verified by
  printing each character into a live tmux pane and reading `#{cursor_x}` back.
  **`⚠` U+26A0 stays one cell** — it is `N`, not `W`, and widening it would
  break tables in the opposite direction, which is why this cannot be done by
  eye. `U+FE0F` now promotes its base: a bare `❤` is one cell, `❤️` is two,
  matching what tmux does.

  Hosts that render rows themselves rather than through `lineToHtml` see no
  change; hosts that use `TermView` should expect wide glyphs to occupy their
  correct two columns, which is a visible layout change wherever they were
  previously drawn narrow.

- **Residual 2-row hole at the archive/live seam when the prompt rewrites** —
  live reconciliation used exact suffix→prefix overlap only. Shell/TUI
  captures rewrite the prompt and one adjacent status row every turn (same
  bound as `looksLikeTailRepaint` and client `readerAnchorLineDelta`), so
  overlap returned 0 even when nearly the whole window was shared. The rows
  that had scrolled off the top of the live window were never archived; hosts
  that mark zero-overlap shrinks then showed `… 2 rows not captured
  (archive/live seam) …`. `FileHistoryArchive` now retries the match after
  dropping up to two trailing rows of the previous live window. A pure
  in-place tail repaint still does not invent history. Docs:
  `docs/protocol.md` live-window bootstrap section.

- **`sessionPresentation.actions` treated every spread of a stock action as a
  host action** — pure object identity decided whether the shell wraps `onTap`
  to close the FAB first. A host that only added `testid` (or relabelled)
  `{ ...fontUp, testid: "slot-font-up" }` lost the stock "keep menu open"
  policy on A+/A−, so the first tap closed the list. Rule is now: default
  entry by identity, **or** same stock `id` with the **same `onTap` reference**
  (metadata-only patch), keeps stock policy; a rebound `onTap` or unknown id
  still closes the menu. Stock A+/A− also ship `demo-font-up` /
  `demo-font-down` testids. Docs: closed slots keep a non-zero
  `getBoundingClientRect` under `scale(0.92)` — probes must assert
  `.slots.open` before coordinate-tapping or they hit the terminal and look
  like onTap never ran.

## v0.15.5 — 2026-08-13

### Fixed

- **A3-9 `maxBlockedMs` shed was only as reliable as the runner's event loop** —
  the product already armed a real one-shot timer when a socket entered the
  blocked state, but the regression test waited on real time (`until` with a
  3s ceiling over a 25ms timer). On GitHub's two-core `release-dist` runner the
  whole suite shares one process and that timer can sit past 3s without firing
  — same commit green in `ci`, red in `release-dist`, twice. The test now
  installs package-level time hooks (`installMuxTimeHooksForTests` +
  `MuxTimeHooks`, tier X) and advances them; shedding is asserted without
  sleeping. Hooks live outside `TmuxWsMuxOptions` so they do not re-hash
  `Partial<TmuxWsMuxOptions>` holders through a `Partial<>` hole in the
  additive optional-member proof. The timer callback also sheds directly on
  fire instead of re-checking wall clock (a re-check that failed left no timer
  and no shed on an idle session). Docs no longer claim that `maxBlockedMs`
  only evaluates on the next push.

## v0.15.4 — 2026-08-13 (source tagged; dist blocked by A3-9)

### Fixed

- **Stored `fontPx` never applied on a cold cache** — `createServerPrefs.load()`
  returned the localStorage cache immediately (often `{}` or a partial write
  without `fontPx`) and refreshed the server snapshot in the background. When
  a *sibling* `createServerPrefs` for the same `cacheKey` finished its GET
  first, it wrote the equal JSON into localStorage; the later instance then
  **skipped emit** (`JSON.stringify(fresh) === JSON.stringify(current)`), so
  its subscribers never ran. `SessionView` only applied the empty/stale
  `load()` return and stayed on `DEFAULT_FONT_PX` (13). Production
  measurement (0.15.3, empty cache): `PUT fontPx:30` → open `/m/t` →
  **13px / `data-last-cols` 47**. After the fix (always emit on a successful
  in-generation GET): **30px / cols 21**. Hosts that open more than one
  adapter for the same key (page prefs + a theme side-channel is common)
  should still prefer a single shared instance; the emit rule is the safety
  net. See `docs/app.md` prefs row.

## v0.15.3 — 2026-08-13

### Fixed

- **Terminal font range locked at 11–18 inside `SessionView`** — stock A+/A− and
  prefs load used bare literals `Math.max(11, Math.min(18, …))` with no prop and
  no documentation. A stored value outside that band was **silently dropped**, so
  a host that widened its own control (kemcortex: 4–40) still rendered the 13px
  default on the phone surface and the tmux pane geometry never moved. Measured
  on production 0.15.2: prefs `fontPx=40` → rendered **13px**, pane stayed
  47×32.
- **History ceiling looked like the start of the session (D4)** — at the 10k /
  8 MiB client retention budget the viewer stopped asking for older pages with
  no marker, so ~19k archived rows could sit unreachable while the top row
  looked ordinary. `TermView` now shows a `role="note"` ceiling banner when the
  stop is the client budget (distinct from server `hasMore: false`).
- **Alternate-screen scroll looked like a frozen terminal (D5)** — rubber-band
  only, no explanation. Affects every `grok-*` and fullscreen Claude Code
  session. Package now shows “Alternate screen · no scrollback”.
- **One `history_expand` before the first `screen` sample** — a reused name
  after alt-screen can pull a stale archive. Unknown mode is treated as
  **normal** (asking is harmless); a late reply is discarded once `screen.alt`
  is known, and a prepend that landed while unknown is dropped when the first
  sample is alt. (34f7afe blocked *every* expand until a sample arrived and
  silently killed history for hosts that never send `screen` — reverted that
  gate.)
- **Font A+/A− resize storm** — every tap called `refreshGeometry()` →
  `sendResize` with no debounce, and `SessionView` remounted TermView on
  each `fontPx` (`{#key}` included the size). Claude Code reprints its
  header on every pane resize, so a burst of taps filled the pane with
  startup banners. Visual size still updates on every tap; only the tmux
  resize waits **220ms** after the last font change (fast thumb ~120–180ms
  apart). ResizeObserver / visibility / mount stay immediate. A pending
  resize is **flushed** on unmount so the last size is not dropped.

### Added

- **`SessionPresentationOptions.fontPxMin?` / `fontPxMax?`** (app, tier S) —
  inclusive bounds for stock A+/A− and prefs load. Stock defaults **4–40**.
  Out-of-range stored values **clamp** into the current bounds (never ignored).
  Host example: `sessionPresentation: { fontPxMin: 4, fontPxMax: 40 }`.
- **Graduated font step** on stock A+/A−: 1px below 20, 2px to 32, 4px above
  (same ladder as kemcortex's terminal-font store; sequence identical up and
  down). A host that wants a different step replaces `font-up` / `font-down`
  via `sessionPresentation.actions`.
- **Public pure helpers** from `thumbmux/app`: `resolveFontBounds`,
  `clampFontPx`, `stepFontPx`, plus `DEFAULT_FONT_PX` (13) /
  `DEFAULT_FONT_PX_MIN` (4) / `DEFAULT_FONT_PX_MAX` (40) and type `FontBounds`.
- **History-ceiling signpost** — `.mtv-history-ceiling` / `data-history-ceiling`,
  `data-history-stop="ceiling"|"exhausted"|"none"`.
- **No-scrollback signpost** — `.mtv-no-scrollback` / `data-no-scrollback`.
- **`SessionPresentationOptions.dpadPlacement?`** (app, tier S) + matching
  `DpadSheet.placement` prop — stage corner for the ✛ arrow pad. Stock default
  remains **`bottom-left`** (no silent move for existing hosts). Values:
  `'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'`. Every corner
  clears `env(safe-area-inset-*)` on that edge. Host example:
  `sessionPresentation: { dpadPlacement: 'top-right' }`.

### Documented

- Range, default, step, clamp behaviour, and how a host overrides the bounds —
  `docs/app.md` ("Terminal font size"), `CONTRACT.md` (`sessionPresentation`),
  JSDoc on the new options. Also notes that a host-side font store and the
  package prefs are two independent mechanisms that can disagree unless the
  host wires them together.
- Client retention ceiling UX and alternate-screen scrollback note —
  `docs/protocol.md`, `docs/desktop.md` §5, README history paragraph (replaces
  the audit G2/G5 “not signposted” prose).
- Dpad corner option, default, four values, safe-area behaviour —
  `docs/app.md`, `CONTRACT.md`, JSDoc on `dpadPlacement` / `DpadSheet.placement`.

## v0.15.2 — 2026-08-12

Documentation-led patch plus a **data-loss fix** at the archive/live seam.
One additive S-tier option; four host-facing doc gaps; and a subscribe/resize
capture-depth correction that stops multi-hundred-line silent history holes on
every reopen.

### Fixed

- **Reopen live capture depth after archive seed** (`TmuxWsMux`) — once a
  session is archive-seeded, subscribe and resize captures use the full
  `liveLineLimit` window (`DEFAULT_CAPTURE_START_LINE`), not the short
  first-paint bootstrap (`INITIAL = -min(250, liveLineLimit)`). The short
  window did not abut the archive boundary (`total − liveLineLimit`), so hosts
  that only reconcile when the mux still held `previousContent` permanently
  lost the middle (measured: **710 lines** every reopen on a 6 000-line
  session with `liveLineLimit=1000`). `history_expand` cannot invent those
  rows. Documented in `docs/protocol.md` under "Live-window bootstrap and the
  archive boundary".
- **Hairline scrollbars on ActionFab + ComposerDock** — `.slots` used
  `overflow-y: auto` even when closed, so a fractional max-height vs content
  stack painted a ~12px scrollbar on every terminal. Closed lists now
  `overflow-y: hidden`; open lists keep auto with a half-line max-height
  slack. The compose textarea set `height` to raw `scrollHeight` under
  `border-box`, leaving 1–2px of overflow and a phantom bar on empty fields;
  auto-grow adds 2px and keeps `overflow-y: hidden` until the max height.

### Added

- **`SessionPresentationOptions.composerMode?: 'compose' \| 'direct'`** (app,
  tier S) — seeds the composer mode for a freshly mounted `SessionView`.
  Defaults to `'compose'` (unchanged). Per-mount state: the user's in-session
  COMPOSE/DIRECT choice wins until remount; prefill still forces COMPOSE
  because DIRECT has no visible field. `EmbedView` does not read this option.
  Host example: `sessionPresentation: { composerMode: 'direct' }`.

### Documented (were true, were never said)

- **Selection guard blast radius** (`docs/desktop.md`) — not only wheel deltas:
  `applyScroll`, touch scroll, `scrollToBottom()` (⤓ dead), live content paint,
  history prepend, and search re-render all yield while a native selection is
  live. Guard clears when the selection collapses. Supported host escape hatch:
  document capture-phase listener that `removeAllRanges()` before TermView's
  bubble handlers re-read the selection.
- **Host font contract** (`README.md`, `CONTRACT.md`, `docs/desktop.md`) —
  `--font-mono` must be monospace **and** cover box-drawing `U+2500–257F` (and
  the scripts the pane shows). Missing glyphs fall through to a different
  advance and break the grid silently; Google Fonts JetBrains Mono has no
  `U+25xx`. `size-adjust` for a second-family script stack is part of the same
  contract.
- **Copy semantics** — stock FAB is selection-first with whole-buffer fallback;
  `SessionActionContext.copyAll` is whole-buffer only. Overriding the FAB to
  call only `copyAll()` copies the entire screen even when text is selected.
- **`composerMode` remount semantics** — documented in JSDoc, `docs/app.md`, and
  `CONTRACT.md` so "it forgets my choice" is not re-derived as a bug.

## v0.15.1 — 2026-08-08

`v0.15.0` was tagged and never published. `release-dist` stopped it at the
verification gate over `A3-9 maxBlockedMs timeout`, a test that slept a flat
60ms against a 25ms timeout and asserted the timer had fired. That is not slack
on a two-core runner executing 99 test files in one process, and CI proved it
itself: the same commit passed `ci` and failed `release-dist`, which only a
nondeterministic test can do. It waits on the condition now, and still fails
(with the shed timer disabled) when the behaviour it describes is absent.

No consumer could have installed 0.15.0 — only `-dist` tags are installable and
that one does not exist. Everything below is what 0.15.1 carries.


### Changed defaults

**The 16 basic ANSI colours no longer rename themselves.** Slot 4 is called
`blue` and rendered `#c8b4ff` — lavender. Slot 5 is `magenta` and rendered
pink. A pane that asked for blue got purple, on every surface this package
draws, and nothing said so.

That is not a matter of taste, because a program does not send a colour for
these slots — it sends a **number**, and the slot names are the only statement
of what the number means. Choosing lavender for `blue` is the package
overriding the author of the program being displayed. It is the same defect
this package's primary consumer was caught making one level up, repainting
panes whose colours had already been chosen, except here it was us doing it to
our consumers.

Hues now match names, at values readable on a dark background:

| slot | was | now |
| --- | --- | --- |
| 1 red | `#ff7a7a` | `#cd3131` |
| 2 green | `#7dffa0` | `#0dbc79` |
| 3 yellow | `#ffef9e` | `#e5e510` |
| 4 blue | `#c8b4ff` (lavender) | `#2472c8` |
| 5 magenta | `#ff9ad5` (pink) | `#bc3fbc` |
| 6 cyan | `#9be9ff` | `#11a8cd` |

The values are the ones VS Code's integrated terminal ships. That is a second
reason on top of being correct: it is the terminal most CLI authors have in
front of them while choosing their colours, which makes it the closest
available answer to what the author saw.

**Bright ANSI slots existed but never rendered.** `deriveSurface` named no
`bright*` entries at all, and `paletteForSurface` falls back to the normal
colour when a bright one is missing — so all six bright slots collapsed onto
their normal twins. A pane distinguishing bright blue from blue was drawn with
one colour for both. The test covering this asserted `base[9] === base[1]`,
recording the collapse as if it were intended.

**Two ANSI tables existed and disagreed.** `DEFAULT_ANSI_BASE` and
`DERIVED_DARK_ANSI` were separate literals; the second wins for every surface
`deriveSurface` produces, which includes `defaultSurface`, so slots 1-6 and
9-14 of the first were never what the package rendered. Both are now built from
one pair of tiers.

### Added

- **`DEFAULT_ANSI_COLORS`** (core, tier D) — the 16-entry default palette, for
  hosts assembling an `AnsiPalette` for a surface this module does not build: a
  thumbnail, an embedded preview, a grid card. It was a private constant, and
  the cost of that was measurable: six separate files in this package's primary
  consumer had each hand-copied a sixteen-colour array, they had drifted apart,
  and **none of them matched what the package rendered**. Prefer
  `defaultSurface(bg).palette` when you have a background — it fills the
  background, foreground and bright-foreground slots from that surface.

## v0.14.0 — 2026-08-08

Held for a day, then released after re-reading the criterion instead of the note
about it. The seven-day soak measures the three consumer surfaces running on
`thumbmux/app` in production **without patches arising from the migration work**
— it is not a freeze on the version number, and it explicitly allows fixes that
go out "ผ่านรอบ release ปกติ". This is a consumer-reported feature on a normal
release round, so the clock is untouched and 1.0 remains a re-tag of a proven
0.x — now of this one.

### TM-04 — an inline slot on the HUD's session-name row

`TermHud` gains `titleAdornment?: PanelSnippet`, rendered inside `.nm` after the
name and before the caret. `AppAdapters.titleAdornment?: Snippet<[string]>`
carries it through the mountable shell and hands the snippet its session name.

A host had no published way to put live per-session information beside the
session name, and the consumer report measured all three substitutes failing:
`chip` is the single agent-identity badge and holds one value, `note` lands on a
second line, and `status` — force-uppercased and `flex: 0 0 auto` — took 248px of
a 390px bar and left `.nm` with **clientWidth 15px against scrollWidth 187px**,
i.e. the session name clipped to its caret glyph.

**The slot collapses rather than competing for width.** The contract we replied
with would have made the name shrink first and the slot never shrink; that
answers the wrong question. Both exist to be read, and half a badge next to a
clipped name is two unreadable things where only one of them is what the operator
came for. So when the name and the slot cannot both fit, the slot leaves the row
entirely and the name keeps all of it. The row may drop the slot briefly while it
is still measuring — losing the adornment for a moment is acceptable, losing the
name is not.

The decision is made on **intrinsic** widths (the `scrollWidth` of the clipped
name and of the out-of-flow slot), never on the widths they currently occupy, so
it cannot oscillate between the two states. A collapsed slot goes out of flow
rather than to `display: none`, because it has to keep reporting its own width —
otherwise the row would have no way to discover it fits again. And with no layout
engine at all (SSR, jsdom, happy-dom) every width reads 0, which means "unknown",
which renders the host's content rather than swallowing it.

Omitting the prop renders the row exactly as before. That is asserted, not
asserted-adjacent: the whole `.hud-names` subtree is compared element for
element. The width guarantee is asserted in real Chromium — happy-dom reports
every width as 0, so the entire finding is invisible to the suite that runs
everywhere else. The crush itself is reproduced by a control measurement taken
while the collapse rule is neutralized by a stylesheet override; a harness that
had stopped laying out would fail that control rather than pass the test.

### The HUD's two silent text transforms are now opt-out

`status` was force-uppercased and `note` force-prefixed with `✎`, neither
documented, which made both props unusable for any other wording — including in
another language. `TermHud` gains `statusCase?: 'upper' | 'none'` and
`notePrefix?: string`, and `sessionPresentation` carries both through the shell.

**The defaults keep the old behaviour**, and that is a deliberate difference from
the report, which asked for the transforms to become opt-in. `TermHud` is F tier:
flipping a default changes what every existing consumer renders, which is the
thing the tier exists to prevent. Opt-out reaches the same place without spending
anyone else's release on it.

## v0.13.1 — 2026-08-07

**The `.svelte` sources we ship now pass strict `svelte-check` (TM-19).**
No public API changed — the immutable-baseline gate agrees against v0.13.0-dist.

The sources are in `files`, so consumers compile them. Anyone running
`svelte-check` strictly in their own project was seeing 17 errors that came out
of our files, not theirs. Four sites:

- **`TermView`** — a callback declared to return `boolean` could return
  `boolean | null`.
- **`RecordingPlayer`** — `clearTimeout(handle as ReturnType<typeof clearTimeout>)`
  asserts the argument is `void`. **Type-only, not a runtime bug**: assertions
  are erased at compile time, so the real handle was always passed and the
  timer always cleared. `Parameters<typeof clearTimeout>[0]` is what it meant.
- **`NotificationPermission`** — the same types imported in both the module and
  instance scripts; svelte-check merges those scopes, so the second import was
  a redeclaration.
- **`DesktopKeys`** — `oncompositioncancel` is not in Svelte's HTML typings.
  The handler stays wired; only the way it is attached changed. Removing it to
  silence the checker would have deleted a real behaviour to fix a type error.

`scripts/svelte-check-gate.test.ts` runs the checker and asserts exit 0, and it
is inside the shared verification gate because that gate runs
`./scripts/*.test.ts`. Verified red at 17 errors before the fixes and green at
0 after.

## v0.13.0 — 2026-08-07

**Packaging only — no runtime code changed.** Version numbers in package.json
files are bumped at release time; this section documents the surface that
ships with that bump.

### TM-09 — pure JS modules no longer trapped behind the `svelte` condition

`./svelte` and `./app` still declare only `types` + `svelte` conditions, so a
resolver that does not set the `svelte` condition cannot enter those barrels.
That protection is intentional for components.

It was not intentional for **ten pure JS modules** that live under the same
trees, ship in `git-dist`, and have no Svelte coupling of their own
(no `from 'svelte'`, no runes, no `.svelte` imports):

- `svelte/session-grid`, `svelte/notifications`, `svelte/service-worker`,
  `svelte/recording-player`, `svelte/term-search`, `svelte/content-update-gate`
- `app/config`, `app/navigation`, `app/overlay`, `app/sessions-store`

The sharpest case is `service-worker`: it is designed for
`ServiceWorkerGlobalScope`, which has neither Svelte nor a bundler pass that
knows the `svelte` condition. Consumers re-verified the ten modules against
v0.10.1 and still could not resolve them.

Each is now a first-class export with `types` + `import` (no `svelte`
condition required), e.g. `import { … } from "thumbmux/svelte/service-worker"`.
The component barrels are unchanged and still require the condition.

### Root export

There was no `"."` export, so `import "thumbmux"` threw immediately
(`No "exports" main defined`). `"."` now points at the same surface as
`./core` — framework-free, no Svelte condition. Existing `./core` / `./server`
/ `./svelte` / `./app` paths are untouched.

A regression test materialises a release-shaped install and asks **plain Node**
(default conditions, no `svelte`) to import each subpath. Reading the exports
map as a string does not count.

## v0.12.1 — 2026-08-07

**Packaging only — no runtime code changed.**

### TM-08 — everything shipped is now reachable

`contract/manifest/*.json` and `CONTRACT.md` were in `files`, so they were
genuinely installed into `node_modules`, and they were unreachable: a package
with an `exports` map blocks every path the map does not name, so any attempt
to resolve them threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. The only
machine-readable tier inventory we publish shipped for four minor versions
without being readable — which is worse than not shipping it, because a
consumer can see the file on disk and still not open it.

The map now names `./contract/manifest/*.json`, `./CONTRACT.md` and
`./docs/*.md`. The manifest pattern is a subpath rather than a bare `./contract`
directory entry, so it exposes exactly the four manifests and nothing else
under `contract/`, where goldens and fixtures live.

A new test asserts the invariant rather than the instance: **every entry in
`files` must be reachable through some target in `exports`**. It fails if the
manifest export is removed, which is the state 0.12.0 shipped in.

### TM-28 — a decision, not a change

`MuxServerMessage` was narrowed in **0.9.2**, on a frozen-tier type, in a
patch. `{channel, type: "sessions"|"history"|"error"|"cursor", data?: string}`
became two variants with `data` **required** on the first. That is a breaking
change and it should not have ridden a patch; it went out inside a commit named
for an unrelated XSS fix, which is how it escaped review.

It is not being reverted, and the reasoning is worth stating rather than
quietly leaving. The narrowed shape is the one that matches the wire: a
`cursor` frame never carries `data`, and the other three always do. Restoring
the permissive shape would break everyone who has adopted 0.9.2 or later —
trading one silent break for another, two months on, to serve consumers who by
now have either upgraded or pinned. The reporter filed it while saying it does
not affect them and asked us not to spend time on it.

What has changed is that this class cannot recur silently: the immutable
baseline gate compares each release against the previously published dist tag
and refuses a narrowing on an F- or S-tier export whatever the version number
says.

## v0.12.0 — 2026-08-07

**Three additive seams for hosts that have something to say about a session
beyond its pane.** Nothing changes for a host that adopts none of them: every
new option defaults to today's behavior, and the DOM is identical when they are
omitted.

### `GridSession.subtitle` — one line of host context on a hub card

A hub card could show a name, a chip, a state and a live miniature, and nothing
about *what the session is actually doing*. `subtitle` is a plain string the
package neither produces nor interprets — a note, an activity summary, whatever
the host thinks is worth reading before opening the card. Rendered as text
(never markup: this is exactly where a host will put model output), clamped to
two lines so a long one cannot grow the card.

Omit it and the card is byte-identical. The test that matters asserts the
subtitle renders in **both** card branches — grouped and flat are separate
markup in `SessionGrid`, and this repo has shipped a fix to one of two branches
before.

### `sessionPresentation.promptsCollapsible` — the prompt list as a disclosure

`PromptsPanel` gains `collapsible` and `initiallyOpen`; `SessionView` passes
them through from the presentation options. Default false, which is the
always-open list with the title as a plain `<div>` exactly as before.

This exists because five prompts is most of a phone's HUD panel. A host that
adds its own panel content had no way to make room for it, and the panel was
scrolling content out of reach rather than choosing what to show.

### `sessionPresentation.extraPanelPlacement` — extra panel above the stock ones

`'top' | 'bottom'`, default `'bottom'` — where it has always rendered. The
stack's order is a priority order, not a layout detail: a host whose extra
panel summarizes what the session is doing wants it above a note and a prompt
history, and the only way to get that before was to give up the stock note and
prompt panels entirely and rebuild both.

## v0.11.2 — 2026-08-06

**Fixes a regression 0.10.0 introduced.** Upgrade past 0.10.0 directly to this.

Making the wire's `screen.mouseSgr` win over the host's static `altScreenMouse`
was right, and it missed that a view-only surface passes *neither*. Such a host
supplies no `onKeys` because it never wanted input, and got local scrolling. Then
a server started sampling `screen`, a grok pane reported `mouseSgr` — it does that
even inline — routing flipped to SGR, and every event arrived at `sendSgr`, which
had nothing to call. Tap and scroll disappeared from a surface that kept rendering
perfectly, and the only complaint was a `console.warn` compiled out of production
builds.

SGR routing now requires a destination: no `onKeys` means the wire cannot take
pointer input away from a host that never asked for it. This also covers a host
that set `altScreenMouse` explicitly — dropping a user's tap is not better because
they opted into the mode. And the warning fires in production, once per instance;
a development-only message is invisible in exactly the build where silent input
loss matters.

Reported by Hispeed against the published bytes, and it was live in our own mobile
team-tree previews, which mount `TermView` with no `onKeys` at all.

## v0.11.1 — 2026-08-06

No runtime change. `v0.11.0-dist` published from a commit whose `ci` was red, and
a dist tag cannot be made to mean something else, so this is that code plus one
test-harness fix under a number nobody has pinned.

The fix: `executeBuiltClient` ended with `preview.kill()` followed by an unbounded
`await preview.exited`. If the preview server declines SIGTERM the suite waits
forever. On the two-core runner that is what happened — 479 tests passed and the
one remaining burned its entire 600s budget *after* its assertions were already
satisfied, so a teardown hang was reported as a failure of the bundle it was
testing. Teardown now escalates to SIGKILL and stops waiting either way.

## v0.11.0 — 2026-08-06

The first release driven by a consumer's adoption report rather than by us. Every
item below was measured against the shipped `v0.10.1-dist` by someone trying to
delete their local patches, with line anchors and reproductions. Two of them we
were carrying in production ourselves without knowing.

### Fixed

- **DIRECT mode matched an eight-key literal table and never read a modifier.**
  `ComposerDock`'s DIRECT mode says in its own markup that "the OS keyboard IS the
  input", and then dropped every Ctrl chord — Ctrl+C, Ctrl+X, Ctrl+D, Ctrl+R never
  reached the pane, so a user could not interrupt a process from the mode built for
  driving one. Alt chords, F1–F12, Home/End/PageUp/PageDown/Delete/Insert: dropped.
  Two were worse than dropped: `Shift+Tab` matched the `Tab` entry and sent a bare
  `\t` instead of `CSI Z`, and `Ctrl+Arrow` matched the arrow entry and sent a bare
  `ESC [ A` with the modifier stripped. It calls `keyboardEventToSequence` now — the
  encoder that was already exported from core and already correct. **v0.10.0's
  physical-key fix never reached this path**, and the changelog entry for it read as
  though it covered the product; it covered the desktop path only. Printable text
  and IME still flow through the input event, so Thai typing is unchanged, and
  Ctrl/Cmd+V still yields to the browser paste pipeline.
- **`openDock()` focused before flushing the open state**, so in DIRECT mode the
  focus landed in a `visibility: hidden` subtree and did nothing — the component
  failed its own documented contract. `switchMode()` eight lines away already did
  `flushSync` first, with a comment naming the same constraint.

### Added

- `openDock(opts?: { focus?: boolean })` and `openCompose(opts?: { focus?: boolean })`.
  Omitted or `false` is byte-identical to 0.10.1. With `focus: true` the component
  flushes and then synchronously focuses the input for the current mode before
  returning, so a call inside a touch handler satisfies iOS Safari's user-activation
  rule. Without this a host could not express "one tap raises the keyboard with the
  cursor in the box" without reaching into unpublished DOM.
- `TermView` prop `cancelSyntheticClickOnTap?: boolean`, default `false`. `onTap`'s
  own docs tell a host to call `openDock()` synchronously — and then WebKit's
  synthesized click for that same gesture blurred whatever was focused, so the
  keyboard rose and fell inside one tap. When enabled, only a touchend whose
  `maybeTap()` actually invoked `onTap()` is cancelled; moved, long, selection and
  link taps keep native behaviour. `onTap`'s declaration is untouched — widening it
  to return a boolean would have been a breaking change to an F-tier prop, and the
  reporter said so themselves rather than ask for it.
- `TermView` prop `maxRows?: number`, default `60`. The floor was a prop and the
  ceiling was a literal, so a tall desktop viewport claimed 60 rows while painting
  more — harmless for a shell, wrong for an alternate-screen TUI, which drew its
  footer at row 60 with dead space below. Not a protocol limit: tmux takes far more.

### Packaging

- `svelte` is now an optional peer (`peerDependenciesMeta`). A headless consumer
  importing only `thumbmux/core` and `thumbmux/server` was installing the entire
  Svelte 5 toolchain; neither bundle contains the string `svelte` at all.

## v0.10.1 — 2026-08-06

No runtime change. `v0.10.0-dist` was published from a commit whose `ci` workflow
was red, and a dist tag is immutable by design — a consumer pins it, so it can
never be made to mean something else. This is that same code plus the one fix,
released under a number nobody has pinned yet.

The fix: three quickstart tests get their own timeout. Each installs a real
consumer, runs tsc, runs a Vite build and drives headless Chromium; that finishes
in 25s on a sixteen-core box and exceeded the suite-wide 120s ceiling on the
two-core runner. The ceiling stays where it is for the other four hundred tests,
because it is there to name a genuine hang quickly.

## v0.10.0 — 2026-08-06

Fullscreen TUIs work now, and the keyboard survives places focus can land.

Both Claude Code (`tui: "fullscreen"`) and Grok (`--fullscreen`) run on the
terminal's alternate screen. Rendering them was never the problem — tmux
`capture-pane` returns the alternate screen just fine. The problem was that the
viewer had to be *told* which mode it was in, through one static `altScreenMouse`
boolean supplied by the host, and that boolean answers two questions that are not
the same question: who owns the pane's geometry, and where pointer events go.
Probed on a live session, a Grok launched with `--no-alt-screen` reports
`alternate_on=0` and `mouse_sgr_flag=1` — the two signals disagree in production,
and there was one prop to hold both.

tmux reports each separately, so the package samples them instead of guessing.

### Added

- `MuxPaneScreen` (core, tier F): `{alt, mouseSgr, mouseAny}`, sampled from tmux
  `#{alternate_on}`, `#{mouse_sgr_flag}` and `#{mouse_any_flag}`.
- Optional `screen?: MuxPaneScreen | null` on `MuxFullOutputFrame` and
  `MuxDeltaFrame`, carried beside `cursor`. The bundled driver adds the three
  fields to the format string the combined `display-message ; capture-pane`
  already sends — the same single tmux invocation, so screen state cannot tear
  against the content it describes.
- `MuxDeliveryMeta.screen`, sticky per channel: a delta that omits `screen`
  delivers the last known sample rather than `undefined`. Entering fullscreen
  usually repaints identical bytes, and an unchanged repaint must not read as
  "left fullscreen".
- `TermView` prop `screen`. When present it wins over `altScreenMouse` for
  pointer routing; when absent, the live value from the wire is used; when the
  wire has said nothing either, behaviour is exactly 0.9.2. An explicit prop
  still wins, because a host that knows better must be able to say so.

### Fixed

- **A Ctrl chord is a physical key, not whatever the layout printed on it.**
  `ctrlSequence` read `e.key`, so on a Thai Kedmanee keyboard Ctrl+C arrives as
  `{key:'แ'}` and on Cyrillic as `{key:'с'}` — neither is in `a-z`, so the chord
  was dropped and no control byte reached the pane. Ctrl+C, Ctrl+X, Ctrl+R: gone,
  on every non-Latin layout. It prefers `e.code` when that names a physical
  `KeyA`–`KeyZ`, and falls back to `e.key`, so nothing that worked before
  changes. `DesktopKeys` had the same bug in `isCopyShortcut` / `isPasteShortcut`
  and was fixed the same way.
- **A link the terminal drew is not a form.** `DesktopKeys.targetIsInteractive`
  bailed on `input,textarea,select,button,a,[contenteditable]` — while
  `ansi-html` renders OSC-8 and detected URLs as real `<a>` elements *inside the
  pane*. Clicking a URL in your terminal stopped typing, with nothing on screen
  to explain it, until you clicked the background again. The bail is real text
  entry only; focus landing on in-pane surface reclaims the wrapper and still
  forwards the key. Pointer-down on a link is untouched, so navigation works.
- `Alt+Escape` emits `ESC ESC` rather than a bare `ESC`. `Shift+PageUp` and
  `Shift+PageDown` return `null` — xterm scrolls those locally and never sends
  them — while `Shift+Alt` and `Shift+Ctrl` forms still encode, which is the
  distinction a Shift-only guard gets wrong.
- On the alternate screen there is no scrollback to reach, so `TermView` refuses
  history expansion instead of attempting it, drops a reply that was already in
  flight when the pane switched, and resets scroll position on a flip in either
  direction — a viewer parked 2000px up its history has no meaningful offset once
  the buffer it was reading stops existing.

### Added (opt-in)

- `KeyboardSequenceOptions.applicationCursorKeys` — unmodified arrows and
  Home/End emit SS3. Off by default; modified forms stay CSI.

### Contract gate

- The additive proof reads `type X = { a?: T }` the way it always read
  `interface X { a?: T }`, and it reads a referenced declaration the way it reads
  a root one. Both are the same contract to a consumer; the owner filter simply
  looked at root interfaces only, so 38 declarations could not be proven additive
  by a rule that already covered the change. It deliberately still refuses to
  strip optionals out of ANONYMOUS type literals: with no owner name in the member
  key, moving an optional property between two inline literals would be
  indistinguishable from leaving it alone, and a gate that waves a real break
  through is worse than one that asks for a review.

### CI

- The bun version is pinned in both workflows, and `ci-parity.sh` fails when the
  bun it runs differs from that pin. Unpinned, `setup-bun` installed whatever
  shipped that day; bun 1.3.14 deadlocked `demo/dogfooding.test.ts` while 1.3.11
  ran the same file in 4.6s, and five release attempts were spent looking at a
  diff that was never the problem. A parity gate running a different interpreter
  than CI was not a parity gate.

## v0.9.2 — 2026-08-05

The release after an adversarial audit. Ten lanes read the 0.9.1 tree and
returned 122 findings; every one was triaged, and the ones that survived a
failing test were fixed. Two optional additions close seams that consumers could
not work around, and both default to today's behaviour.

**Security.** A host-supplied palette entry was interpolated into `style="..."`
on rendered spans with no validation that it was a colour. `safeCssColor` now
accepts only `#rgb`, `#rrggbb` and `#rrggbbaa`, so a crafted palette cannot
close the attribute and inject markup.

### Added

- `EmbedView` takes a direct `claimGeometry?: boolean` prop, default `false`. It
  deliberately does not inherit `termProps.claimGeometry` — a contained embed
  that owns pane size must say so explicitly. Omitting it is unchanged.
- `AppRoutesOptions.projectSessionList` — a transport-neutral session-list
  projection that runs on the HTTP list *and* the socket paths. It takes no
  socket, which is why it composes into both; `MuxHooks.filterSessionList` is
  unchanged and stays socket-only. The guard's own projection still runs last on
  every path, so a projection that returns rows outside its input has them
  stripped rather than leaked, and both transports fail closed if it throws.
  This closes the gap v0.9.1 documented instead of fixing.

### Fixed

- **Terminal columns are cells, not UTF-16 offsets.** Link start/end columns
  went through `utf16ToCellOffset` (CJK 2 cells, combining marks 0), so a link
  after Thai, CJK or emoji text is hittable where it is drawn. The URL grammar
  also stopped truncating balanced parentheses and IPv6 hosts, and a hard
  newline near the pane edge is no longer glued to the preceding URL.
- **`ComposerDock` never checked `isComposing`.** IME preedit state and
  candidate-selection keys leaked into the pane — invisible to any ASCII
  keystroke test.
- **`submitPlan` left `\r` inside its text step**, so a prompt containing a line
  terminator submitted early and then again on the planned delayed Enter. Line
  terminators are now quarantined in bracketed paste; single-line text is
  byte-identical.
- **Kill authorization matches the README.** A grant that omitted `sessions` was
  implicitly allowed to kill any session, while the documented rule requires an
  allowlist containing the exact session.
- **Mux ordering.** A journal delete could wipe a session re-created mid-await;
  poll and pipe captures bypassed the per-session queue so an older capture
  could overwrite a newer one; a failed full-history bootstrap was consumed as
  success and reported as "Session not found"; `maxBlockedMs` had no timer and
  could retain a peer indefinitely.
- **Promises outliving their caller.** An upload begun in one session prefilled
  another's composer; a late note load overwrote a newer successful save; the
  launcher could call a host's `spawn.launch` with `null` while contexts were
  still loading.
- **Compositor state read after its owner moved on** — wheel deltas applied
  under a live selection, stale touch-drag distance across a multi-touch
  transition, history prepends committing during a selection, the reader anchor
  dropped on a replace that kept a stable prefix, and geometry not remeasured
  when `bottomInsetPx` changes without a resize.
- **`initialScanLines: 0` looped forever**, hanging the caller synchronously.

### Fixed — the checks that could not fail

- `THUMBMUX_SKIP_E2E=1` took a warning branch and returned success, so the
  parity gate could pass while skipping the stage it exists for.
- The contract gate compared the current manifest against itself, so an
  immutable removal, an F-tier signature change, an F demotion and a patch-level
  drift all reported no error. `materialize-contract-baseline.ts` gives it an
  immutable prior contract, which is what makes it capable of failing.
- The release workflow accepted any `vX.Y.Z`-shaped ref without comparing it to
  the five package manifests. `check-release-version.ts` now checks the tag
  against every manifest version and every declared `@thumbmux/*` range.

### Documentation

Seven documents described code that did something else, and the prose was
narrowed to what the code guarantees rather than the reverse: `ping` carries a
`client` descriptor the protocol table never listed, `output` frames are not
sent only on a hash change, and reflow follows the mounted view only while that
view owns geometry and the server accepts the resize.

## v0.9.1 — 2026-08-03

No API change. The manifests, declaration signatures, wire goldens and frozen
consumer fixtures are byte-identical to v0.9.0; this release corrects shipped
documentation that a tag cannot fix in place.

### Fixed

- **The install instructions pointed at the previous line.** `README.md` selected
  tags matching `refs/tags/v0.8.*-dist`, so following the documented Get Started
  produced a v0.8.x install and could never reach v0.9.0. The glob, the "current
  0.8.0 checkout" line, and the surrounding 0.8.x references now name 0.9.x.
- **`CONTRACT.md` still declared itself the policy for the 0.8.x line** while
  shipping inside v0.9.0 artifacts. It now covers 0.8.x and 0.9.x, and the F-tier
  promise, the no-retroactive-demotion rule, the app-shell S notice and the
  cookie-name pin all state the wider range they already held to.
- **The removal-window rule only protected names deprecated in 0.8.x.** It named
  0.8.x and v0.9.0 as its terms rather than as its example, which left a name
  deprecated in 0.9.x with no stated window. The rule is now general and keeps
  `JournalRecordV1` as the worked example.
- **The demo derived one prop from the other.** `termProps` returned
  `claimGeometry: !altScreens[session]` alongside `altScreenMouse:
  !!altScreens[session]`, so in the reference app a full-screen TUI's primary
  terminal never owned its pane size. `claimGeometry` asks who owns the pane
  size and `altScreenMouse` asks where pointer input goes; they are independent,
  and `docs/desktop.md` now says so where the two are described. The v0.3.1 entry
  below recorded that preset accurately at the time — it is left as written,
  because a changelog that edits its own history stops being evidence.

## v0.9.0 — 2026-08-02

### Removed

- **Breaking: `JournalRecordV1` is no longer exported from `thumbmux/server`.**
  Replace server-side imports with `FrameJournalRecordV1`. The unrelated
  `JournalRecordV1` type exported from `thumbmux/core` remains available.

## v0.8.3 — 2026-08-02

### Added

- **`HubView` now accepts host-owned grid and launcher presentation choices.**
  The optional `AppAdapters.hubPresentation` block uses the new public
  `HubPresentationOptions` type to forward filter choices, grouping, ordering,
  and command-preview visibility. Every member is optional; omitted members
  retain the stock empty-filter, ungrouped, input-order, and visible-command
  behavior. Launcher dark mode reuses `AppAdapters.theme.mode`, so theme state
  stays on the existing seam; an absent theme or mode remains light.

- **`SessionView` now lets a host compose its FAB and suppress the persistent
  shortcut bar.** The optional `AppAdapters.sessionPresentation` block exposes
  the complete stock-plus-extra action list to a final transformer and can hide
  `ShortcutBar`; its manager sheet and stock FAB entry remain unless the action
  transformer removes that entry. Actions returned by the transformer can use
  the new optional `SessionActionContext.copyAll` operation when selection-first
  copy is not the desired policy, and topicless file pastes can be handled by the
  new optional `upload.onUnavailable` callback on the existing upload adapter.
  Omitting these members retains the stock action set and order with legacy
  extras appended, the persistent shortcut bar, selection-first copy with
  whole-buffer fallback, endpoint-backed paste uploads, and browser-owned paste
  when no endpoint exists.

  The session stage now also forwards mapped session `state` to its root
  `data-state` attribute; it reuses the metadata already shown by the HUD and
  introduces no adapter.

## v0.8.2 — 2026-08-02

### Added

- **`thumbmux/app` can give composer submissions their own transport.** The new
  optional `AppAdapters.sendSubmissionKeys` callback uses the public
  `SubmissionTransport` type. `SessionView` and `EmbedView` send each
  `submitPlan` step through it and settle a returned promise before starting the
  next step; raw key paths remain on `sendKeys`. Existing hosts that omit the
  callback need no adapter changes: the shell retains its previous
  `sendKeys`/singleton transport, planned delays, and byte order.

  A host with a request/response transport wanted both halves and could have
  neither: one seam carried raw keys and submissions together, so choosing REST
  for a submit meant one request per keypress. `submitPlan` already documented
  that an awaited round trip can stand in for its planned delay — this is the
  door that lets a host say so. An acknowledged step satisfies the next step's
  delay; a synchronous transport keeps it.

### Changed defaults

None.

## v0.8.1 — 2026-08-02

### Fixed

- **A click in the first 500ms of a page's life no longer disappears.**
  `TermView` ignores a click that arrives within 500ms of a `touchend`, because
  mobile browsers synthesize one and reporting a single finger as two taps is
  worse than reporting it as none. The last-touch timestamp started at `0` and
  is compared against `performance.now()`, which counts from when the document
  started — so on a page younger than the window, `0` reads as *a touch just
  ended* and every click was discarded as its echo. A page that has never seen
  a finger now says so, and the sentinel is a value the clock cannot produce.

  Reaching a host's composer by tapping the terminal is the only route
  `thumbmux/app`'s `EmbedView` offers, so an embed opened and clicked
  immediately would not open its composer at all. Found by migrating a real
  consumer page onto `EmbedView` rather than by review.

  No behaviour changes after the first half-second, and the double-fire guard
  this protects is unchanged and covered by its own test.

## v0.8.0 — 2026-08-01

thumbmux stops being a box of parts. `thumbmux/app` mounts the whole application —
hub, fullscreen terminal, and the navigation between them — and this release also
installs the machinery that makes "upgrading will not break you" checkable rather
than merely stated.

### Read before upgrading

1. **`thumbmux/app` is a new subpath.** `import { ThumbmuxApp } from "thumbmux/app"`
   gives you the session grid, the terminal view, and query-parameter navigation.
   Everything a host must decide — where to spawn, where uploads go, what the
   copy says, what a session's state means — arrives through one `adapters`
   object. Nothing in the existing subpaths changed to make room for it.
2. **`createAppRoutes` assembles the server side.** Hand it a driver and it
   returns `fetch`, WebSocket handlers, and the mux, with spawn, upload, prefs,
   sessions and kill already routed. `fetch` returns `null` for paths that are
   not its own, so your routes keep working. Hand it a `guard` and every mux
   message and HTTP operation is authorized for you — filtering the session list
   alone was never isolation, and now you do not have to know that.
3. **The public surface is under contract.** `CONTRACT.md` ships with the package
   and `contract/manifest/*.json` records every public name with a tier. CI fails
   if a frozen signature changes or a new export appears without a declared tier.
   `thumbmux/app` is entirely `S` — it will freeze at 1.0, after a real consumer
   has been through it, not before.

### Added

- `thumbmux/app`: `ThumbmuxApp`, `HubView`, `SessionView`, `EmbedView`,
  `createSessionsStore`, `createQueryParamNav`, `nextStageOverlay`,
  `prefillOnError`, `AppAdapters`, `AppLabels`, `SessionActionContext`
- `thumbmux/server`: `createAppRoutes`, `exactTmuxPaneTarget`
- `thumbmux/core`: `warnDeprecated`, `resetDeprecationWarnings`,
  `MuxAuthErrorFrame`, `MuxServerFrame`
- `MuxHooks.canSubscribe` and `MuxHooks.onOutput`, both optional

### Deprecated

- **`JournalRecordV1`** (`thumbmux/server`) — since v0.8.0, use
  `FrameJournalRecordV1`; removal no earlier than v0.9.0. The two names describe
  the same shape, and the old one collides with an unrelated `JournalRecordV1` in
  `thumbmux/core`. The alias still works. It carries the JSDoc stamp, the manifest
  entry and this changelog entry, but no runtime warning — it is a type alias, so
  nothing survives compilation to warn from. `warnDeprecated` covers functions and
  classes, which is what CONTRACT.md's deprecation policy already says.

### Fixed

- **TermView left animation frames running after unmount.** Six fire-and-forget
  frames were never cancelled, so after a view was destroyed they still ran and
  read state that no longer existed. Present in every prior release; visible only
  once something unmounted a terminal in earnest.
- **An expired or revoked grant kept receiving output.** Authorization ran on
  inbound messages only, so a viewer who subscribed and then stayed silent read
  on. Losing a grant now withdraws the socket's subscriptions.
- **Scrollback was lost moving from a thumbnail to a full view.** A bounded
  capture initialized an empty archive, so the older rows were never seeded.
- **A withdrawn feature's declaration shipped in every release.** The build never
  cleared `dist`, so a file that stopped being generated stopped existing only in
  source. Every workspace cleans before building, and a test now fails on any
  orphan.
- Upload handlers reject the wrong method with 405, count every part toward the
  size limit, and no longer overwrite on a name collision.
- `mergePrefs` no longer lets a `__proto__` key in a patch reach the result's
  prototype.
- Kill requires an explicit `sessions-kill` permission; existing interactive
  grants do not carry it.

### Changed defaults

None.

## v0.7.1 — 2026-07-31

Nineteen fixes found by two rounds of trying to break v0.7.0 rather than confirm
it. Nothing here changes the wire format, and no existing call site needs
editing. Two of them are worth reading before you upgrade, because they change
behaviour you may have been working around.

### Read before upgrading

1. **A tmux target is now matched exactly.** Every driver operation addresses
   `=<name>:0.0` instead of a bare name, so tmux can no longer fall through to
   prefix matching. Before this, if a session had died and a longer sibling was
   still alive — `agent` gone, `agent-2` running — the operation silently
   succeeded against the sibling. A viewer could be handed another session's
   pane, and a kill could take the wrong one. If you relied on prefix matching to
   address sessions by a shortened name, that no longer works, and it was never
   safe.
2. **The two history paging methods now return `boolean`.** `requestHistory` and
   the new `requestHistoryAfter` return `false` when the frame was not written —
   disposed mux, closed socket, or another request already outstanding for that
   session. Callers that set local "loading" state before the call must roll it
   back on `false`. History frames carry no request token, so only one request
   per session can be attributed at a time; `recoverHistoryRequest(session)`
   abandons one that never got a reply.

### Fixed

- A lost history reply no longer freezes that session's scrollback until the
  connection happens to be replaced. The serialization gate can now be abandoned
  explicitly, fenced by socket identity so settling a stale lease cannot retire
  the wire another session is using.
- A standalone `client_info` reaches the host through the new optional
  `MuxHooks.onClientInfo`. It previously had no case in the message switch and
  was discarded.
- `createSpawnHandler` is generic over the session row, matching `TmuxDriver`.
  A host row carrying only `name` compiles again.
- `dispose()` detaches its listeners, instead of relying on a `destroy()` no
  caller invoked.
- A killed session is retired rather than being captured four times a second
  until something notices.
- A stale teardown no longer kills a live subscription.
- A throwing archive, or a throwing logger inside the archive's error path, can
  no longer leave a client waiting forever for a reply that will never come.
- The gap marker reports where and how much accurately, and sits in its own
  gutter rather than eating the row it was placed on.
- The gap count compares content instead of assuming the whole window departed.
- Eight helpers hosts were rewriting by hand are exported, and a test proves they
  reach the published artifact.
- The heap benchmark no longer hardcodes a browser path into a release gate.

## v0.7.0 — 2026-07-30

Plug-and-play, finished. v0.5.0 shipped components a consumer could mount; this
release makes the surrounding contract real — the pieces that were written but
not exported, the fields that existed but were undiscoverable, and the docs that
told outside readers to import names only this repo has. This is the first public
release after v0.5.0, and this single entry covers the whole range since that tag.

### Consumer-visible changes to read before upgrading

The first two changes close data-loss bugs:

1. **A prefs save whose 2xx body is unparseable or not a JSON object now REJECTS
   and rolls back** instead of resolving with optimistic state stranded in the cache.
   Callers that ignored the promise will now see a rejection. Separately, an empty
   or key-missing background GET is ignored instead of replacing saved shortcuts.
2. **`UploadAction` treats a 2xx whose body has no usable `files` as an error**
   and no longer calls `onUploaded` with empty values.
3. **A custom `TmuxDriver`, session-list provider, or session filter may stop
   compiling.**
   `listSessions()` returns `SessionListItem[]` instead of `unknown[]`. Two
   different causes, with different remedies:
   - `activityAt` is required — add it from your own activity source, or `0` if you
     have none.
   - `SessionListItem` carries an index signature, so a row typed as an `interface`
     fails with TS2322 "Index signature for type 'string' is missing" even when every
     field is present. Use a type alias, add an index signature, or cast. Inferred
     object literals — including the package's own `createBunTmuxDriver` — are fine.
   Runtime is unaffected either way; this is a typecheck-time break only.
   > **Superseded by the next release — do not follow this advice on a newer tag.**
   > The cast was the right workaround for v0.7.0 and the wrong shape overall:
   > adding an index signature to your own alias does not help, because TypeScript
   > grants implicit index signatures to aliases and never to interfaces. The
   > constraint is now `SessionListRow` (`{ name: string }`, no index signature),
   > so an `interface` row carrying only what your host actually knows compiles
   > with no cast and no invented `created`/`windows`.
4. **`onScrollStateChange` is boundary-only.** It fires when the scrolled-up flag
   flips, not on every offset change, and no callback reports the initial state. A
   host that mirrored the raw offset from this callback must read it another way.
5. **Client-side scrollback now has a ceiling.** The retained-row and estimated-
   storage budgets apply to both archive prepends and live captures. Once either
   budget is full, older archive expansion (including search-driven expansion)
   clamps instead of evicting rows the reader already traversed, matching the
   functional ceiling of `tmux history-limit`. Dropped spans have visible row-count
   markers; the mounted viewport plus overscan remains protected, so the limits are
   intentionally soft when that window alone exceeds them.
6. **Forward archive paging adds optional `HistoryArchiveLike.readAfter`.** Existing
   custom archives still compile without it, but an `afterLine` request then returns
   an explicit empty page instead of throwing or silently calling `readBefore`.
   Upgrade the server/host before a custom client starts sending `afterLine`: an
   older server interprets such a message as the previous backward-page request.
   The stock `TermView` does not emit `afterLine` yet, so ordinary scrolling cannot
   restore a span after the client has evicted it. A custom WebSocket router must
   preserve `afterLine` and delegate through `handleMessage()`, or call
   `expandHistoryAfter()` itself.
7. **The assembled `git-dist` declarations for `thumbmux/core` and
   `thumbmux/server` now support TypeScript `Node16` and `NodeNext` resolution.**
   This does not extend plain-Node resolution to `thumbmux/svelte`, which still
   requires a Svelte-aware Bundler/Vite toolchain.
8. **The stock Grok picker no longer offers retired model IDs.** `GROK_MODELS` is
   now public from `thumbmux/core`; retired or otherwise unknown model values passed
   to the launch builders fall back to the no-flag default instead of forwarding a
   dead flag.
9. **Retained terminal rows use sparse derived state.** Raw row/link data and sparse
   SGR checkpoints remain persistent, while rendered HTML and entry state are
   bounded to the render window. A cold rebuild waits until an active gesture
   settles; the public TypeScript API is unchanged.
10. **Security and notification docs now contain concrete integration examples**
    using the shipped package subpaths. They demonstrate the available building
    blocks, not an end-to-end authentication or push service supplied by thumbmux.
### Reference host — not part of the package

These describe the reference application that consumes thumbmux, not the package
itself. Nothing here changes what you install; they are recorded so the release is
complete, not because a consumer must act on them.

- **Session activity now reaches the reference hub end to end.** Typed
    `attached`/`activityAt` values flow through REST bootstrap and WebSocket pushes,
    and the hub consumes the pushed rows. REST bootstrap makes at most one cold
    activity/attachment attempt, remembers even an empty sample, and then relies on
    normal mux polling for refreshes; its enrichment reuses the same session listing.
- **A fresh reference-host database no longer advertises standalone
    a retired internal service runtime fields.** Existing databases are deliberately not
    migrated. Production uses the in-process path; an executable legacy fallback
    remains if that flag is unset and points at a service that no longer exists.
- **The reference Bun host now forwards `websocket.drain` to
    `mux.handleDrain`.** The README, demo, and runbook document and exercise that
    backpressure recovery fast path.

### Newly exported — code that existed but never shipped

- **`FileHistoryArchive`** (`thumbmux/server`): a complete `HistoryArchiveLike`
  with 444 lines of tests, previously stranded in `demo/` and excluded from the
  release tag's `files` whitelist. Deep scrollback no longer requires writing
  your own archive. Pass an explicit `root` when history must persist across
  processes; the default root is private and per run.
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
- New **`docs/hub.md`** explains that hub thumbnails are bounded live tails and a
  full terminal can wire `FileHistoryArchive`. The host still owns agent-state
  classification, durable prompt history, and spawn policy; a consumer expecting
  state dots for free would otherwise conclude the hub is broken.
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
  **137 → 0**, both reproducible from the shipped test. Wall-clock measurements for
  this isolated change varied after later anti-jank work, so the counted mutations
  and callbacks — not a timing claim — are the release guarantee.
- Virtualized DOM rebuilt mid-momentum: key-set rebuilds **2 → 0**.
- History parsed and measured during a fling: `getBoundingClientRect`
  **234 → 0**, DOM commits while busy **1 → 0**.
- `getBoundingClientRect` per alt-screen touchmove: **10 → 1**, with the emitted
  SGR bytes pinned so grok's touch scrolling cannot drift.
- **Retained history is now capped.** On the original 500-row fixture, one run of
  the cap changed the page-150/page-10 median commit ratio from **4.03× → 0.94×**;
  that wall-clock point measurement moves run to run, so a deterministic counted-
  work guard now carries the bounded per-page-cost claim. Rows in the viewport plus
  overscan are never evicted, even if they alone exceed the budget. The completed
  retention work covers live captures too, marks every retained-data discontinuity,
  preserves archive rows already traversed **on archive prepends**, and stores
  derived render state sparsely.

### TermView — bounded live retention and sparse rendering

The new `10_000`-row and `8 * 1024 * 1024`-byte estimated retained-storage
budgets are enforced after live capture commits as well as archive prepends. When
trimming is necessary, TermView preserves the mounted viewport plus overscan and
the newest live tail. The limits are intentionally soft when that protected window
alone exceeds them, and the byte figure is a deterministic storage estimate rather
than a browser-heap ceiling.

Dropped spans render as `rows dropped` markers at their actual retained-row
boundaries, including repeated discontinuities. The markers are presentational CSS
chrome: they do not enter raw terminal rows, retained-byte accounting, search,
copy, or `onLinesChange`, and the pseudo-element itself is not selectable.

At saturation, a prepend can discard the oldest prefix of the incoming page but
cannot evict archive rows the reader already traversed. The request gate also
stops older-history fetches when the retained-row budget is full, even if a later
live tick resets archive exhaustion.

Persistent row storage is raw content/link data plus sparse SGR checkpoints and
sparse discontinuity state. Rendered HTML and per-row entry state are Maps bounded
to the mounted window instead of arrays spanning all retained rows. A cold-window
rebuild waits for an active gesture to settle, and search is covered through a real
TermView jump into a cold sparse window.

On the final verification run, the same Chrome retained-shape fixture at
`100_000` rows measured `42.49 MiB` for the legacy representation and `17.45 MiB`
for the sparse representation. The selected checkpoint stride is `300`; its
cold-window rebuild measured median/p95/max `0.60/0.90/1.10 ms` on that run.
Treat these wall-clock values as run-local evidence, not universal device budgets.

### Forward archive paging

The public additions are:

- `MuxClientMessage.afterLine?: number | null` on `history_expand`;
- optional `HistoryArchiveLike.readAfter(session, afterLine, limit?)`;
- `FileHistoryArchive.readAfter(session, afterLine, limit?)`; and
- `TmuxWsMux.expandHistoryAfter(session, ws, afterLine, limit?)`.

The reference host's `TerminalHistoryArchive` implements the matching adapter.
`afterLine` is an exclusive anchor; `null` starts from the oldest row still held by
the archive. Presence of the property selects forward paging, including `null` and
`0`, and `afterLine` wins if both direction cursors are supplied. Rows remain in
display order, `startLine` names the first row actually returned for a non-empty
page, and `hasMore` means newer archived rows exist.

An archive without `readAfter` returns an explicit empty page instead of throwing
or silently calling `readBefore`. A request containing only `beforeLine` keeps the
previous route. Custom WebSocket routers must preserve the new property and
delegate it through `handleMessage()`, or call `expandHistoryAfter()` directly.

### Published declarations under Node resolution

The aggregate release builder adds `.js` to extensionless relative module
specifiers in emitted declarations using TypeScript AST spans. The rewrite runs on
the assembled `git-dist`, not the raw workspace `dist` directories, and leaves
existing `.svelte` specifiers, comments, and plain strings alone.

An exhaustive consumer guard imports the public declaration surface of
`thumbmux/core` and `thumbmux/server`. The assembled package passes with
`skipLibCheck: false` under both `Node16` and `NodeNext`, while the Bundler and
Vite/Svelte consumer paths remain green. Plain `Node16`/`NodeNext` resolution is
deliberately not claimed for `thumbmux/svelte`; use a Svelte-aware Bundler/Vite
toolchain for that entrypoint.

### Grok presets and public docs

The stock `grok` and `grok-worktree` presets share a catalog containing the no-flag
`default` choice and `grok-4.5` (`--model grok-4.5`). The retired `grok-build` and
`grok-composer-2.5-fast` choices are removed. Because the launcher has no alias-
rewrite layer, retired or unknown values passed to `buildLaunchCommand` or
`buildLaunchSpec` fall back to `default`; they are not forwarded as aliases.
`GROK_MODELS` is newly exported through `thumbmux/core`.

`security.md` now demonstrates `createTokenGuard` with `TmuxWsMux` session-list
filtering, browser mux configuration, and launch IDs derived from
`DEFAULT_LAUNCH_PRESETS`. `notifications.md` demonstrates event validation and the
browser permission, service-worker, and local-notification flow. Public JSDoc now
uses the shipped `thumbmux/core`, `thumbmux/server`, and `thumbmux/svelte` subpaths
rather than host-only aliases.

These examples do not turn the helpers into an end-to-end security or push service.
The host still owns authentication and authorization of parsed operations, cookie
forwarding, service-worker delivery, subscription storage, and real push handling.

### Host and operator fixes

The reference host now carries typed `attached` and `activityAt` session fields
through its provider, REST bootstrap, and WebSocket pushes; the hub consumes pushed
rows and normalizes the activity timestamp for display. REST bootstrap takes at
most one cold activity/attachment sample, remembers even an empty attempt, and then
uses normal mux polling as the refresh path. The REST handler also reuses one mux
session snapshot for orphan reconciliation and its response.

A fresh database seed keeps the `kem-distill-engine` topic identity used for
reconciliation but leaves its runtime fields empty. The seed is one-shot: existing
topic rows are not migrated. Production uses the in-process distill path; if its
flag is unset, executable legacy fallbacks still target the retired standalone
service and can silently disable distillation.

The reference Bun host now forwards `websocket.drain` to `mux.handleDrain`, and its
README, demo, and runbook describe the same recovery fast path. The optional
`filterSessionList` hook remains intentionally unwired in this single-user host:
without an authenticated socket principal and authorization for the other mux
operations, list-only filtering would imply isolation the host does not provide.

### Known limits and upgrade order

- **Forward paging is not end to end in the stock `TermView` yet.** The package
  server and reference archive can answer a forward request, but the Svelte client
  does not emit `afterLine`, so ordinary scrolling cannot re-request an evicted
  span.
- **Upgrade the server/host before a custom client sends `afterLine`.** A pre-change
  server ignores that property and takes the old backward/newest-page route. A
  custom WebSocket router must also preserve the field.
- **Once the client retention budget is full, upward archive expansion clamps.**
  This includes search-driven attempts to continue into older history. It is the
  same functional ceiling a terminal user encounters with `tmux history-limit`.
- **Gap markers are presentation, not terminal data.** Their counts are visible,
  but the CSS marker itself cannot be copied or selected.
- **Archive recovery covers only rows the configured archive still retains.**
  There is no direct tmux re-capture fallback for an evicted logical range.
- **The retention byte cap is estimated and the protected window can exceed the
  nominal cap.** It is not a hard browser-heap ceiling.
- **Plain `Node16`/`NodeNext` support is scoped to aggregate `git-dist`
  declarations for core/server.** The Svelte entrypoint still needs Svelte-aware
  resolution, and raw workspace dist output is not the released aggregate.
- **An empty cold activity attempt is not retried by REST alone.** Without a mux
  poll, placeholder metadata remains until a process restart permits another cold
  attempt.
- **The fresh-seed cleanup is not a migration or removal of legacy fallback code.**
  Existing topic rows can retain old runtime fields, and unsetting the in-process
  flag still reaches code targeting the absent standalone service.
- **The security examples are building blocks, not deployed multi-user
  isolation.** The reference host deliberately leaves `filterSessionList` unwired
  until it has an authoritative ACL, authenticated socket principals, and matching
  authorization for all mux operations.

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
  missing public declarations in both core and server.
- **`dogfooding.test.ts`** fails if the demo reimplements something the package
  ships, parsing import specifiers rather than substring-matching. The
  plug-and-play audit found that pattern repeatedly, previously only by a human
  reading code.
- **The release rail is exercised from the split package tree.** Its TypeScript
  dependency and prompt-scan fixtures are package-local, so a release cannot pass
  by borrowing either one from the parent monorepo and then publish an empty dist.

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
