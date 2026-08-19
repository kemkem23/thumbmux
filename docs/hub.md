# Building a session hub

`SessionGrid` is a presentation component. `TmuxWsMux` publishes the session
inventory on the reserved `__sessions` channel, the browser's `tmuxMux`
subscribes to that inventory, and the host maps each wire item to a
`GridSession`. Each grid card then mounts a read-only `SessionThumb` for the
session's live tail.

## Session-list fields and ownership

Two types, and the distinction is the point.
[`SessionListRow`](https://github.com/kemkem23/thumbmux/blob/v0.7.1-dist/git-dist/core/protocol.d.ts) is the
**minimum protocol requirement** — `{ name: string }`, no index signature — and it is the generic
constraint on `TmuxDriver`, `setSessionListProvider()`, and `MuxHooks.filterSessionList`.
[`SessionListItem`](https://github.com/kemkem23/thumbmux/blob/v0.7.1-dist/git-dist/core/protocol.d.ts) is
the **richer** row shape produced by the default bundled driver for host metadata.

A host with its own source of truth returns whatever it actually knows. It does
**not** have to invent `created` or `windows` to satisfy a type — no component
in this package reads them, and a fabricated value is worse than an absent one
because it looks like data. Extra host metadata is allowed and survives the
wire, but thumbmux does not invent it or map it to `SessionGrid` props for you.

| Field | `createBunTmuxDriver()` fills it | Required of a custom driver/provider |
|---|---|---|
| `name: string` | Yes — tmux session name | **Yes** — the only required field |
| `created: string` | Yes — tmux creation time, epoch seconds as a string | No |
| `windows: number` | Yes — tmux window count | No |
| `attached: boolean` | Yes — whether a tmux client is attached | No |
| `activityAt: number` | Yes — latest tmux window activity in epoch seconds; `0` before the first sample | No |
| Extra keys | No | Optional — add and interpret them in the host |

Declare your row as an `interface` if you like; that is the case the constraint
exists for. TypeScript grants implicit index signatures to type aliases and not
to interfaces, so an interface could never satisfy the old index-signature-
bearing type no matter how many fields it had.
| Agent `state` / `stateLabel` | No | Classify it and map it to `GridSession` if you want a state dot | Yes |
| `chip`, filter, group, color, and localized activity labels | No | Enrich the `GridSession` in the host | Yes |
| Durable prompt history | No | Store and query it in the host | Yes |

`SessionGrid` consumes `GridSession[]`, not `SessionListItem[]`, so it does not
automatically render `created`, `windows`, or `attached`; the host decides
whether and how to project them into its UI.

`attached` means that a tmux client is attached; it does not mean that an agent
is working. Likewise, `activityAt` is tmux window activity, not an agent-state
classification. Also note the unit boundary: `SessionListItem.activityAt` is in
epoch **seconds**, while `GridSession.lastActivityAt` is in epoch
**milliseconds**.

## Minimal Svelte wiring

Use `tmuxMux.onSessions()` for the reserved list channel; `tmuxMux.subscribe()`
is for pane output. `onSessions()` parses the JSON-encoded `data`, subscribes on
connect/reconnect, and returns its unsubscribe function. The default WebSocket
endpoint is the same-origin `/ws/tmux`; configure the shared mux first if your
host uses another endpoint.

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { defaultSurface, type SessionListItem } from 'thumbmux/core';
  import { SessionGrid, tmuxMux, type GridSession } from 'thumbmux/svelte';

  let {
    onOpen,
    onNew,
  }: {
    onOpen: (name: string) => void;
    onNew: () => void;
  } = $props();

  const palette = defaultSurface('#101014').palette;
  let sessions = $state<GridSession[]>([]);
  let loaded = $state(false);

  function toGridSession(row: SessionListItem): GridSession {
    const session: GridSession = { name: row.name };
    if (row.activityAt > 0) session.lastActivityAt = row.activityAt * 1000;
    return session;
  }

  onMount(() => tmuxMux.onSessions((rows) => {
    sessions = (rows as SessionListItem[]).map(toGridSession);
    loaded = true;
  }));
</script>

<SessionGrid
  {sessions}
  {palette}
  {onOpen}
  {onNew}
  loading={!loaded}
  order="recent"
/>
```

The cast is currently necessary because `tmuxMux.onSessions()` exposes its
callback rows as `any[]`; the wire contract is `SessionListRow[]`, while `SessionListItem`
casts are used when your source includes richer host metadata. The `activityAt > 0`
guard keeps the pre-sample sentinel
out of the 1970 date range. The mapped time drives `order="recent"`; the grid
still omits its visible state row and timestamp until the host supplies a
`state`. `onOpen` should route to the selected terminal, and `onNew` should open
the host's launcher or other creation flow.

This minimal map intentionally supplies no `state`, so it renders no state dot.
That is also what the v0.5.0 demo does: it shows the real session name and live
thumbnail without synthesizing state. Earlier demo code used `hash % 3` to
invent WORKING/IDLE; v0.5.0 removed that heuristic, and the demo's end-to-end
contract now requires zero state dots when no classifier is wired.

## Opt-in dense cards

Pass `cardLayout="dense"` when the hub needs terminal metadata and the preview
to share one compact square. Each card renders
`name : note : summary : expand`; the name copies the exact session name while
the expand button alone calls `onOpen`. Both `note` and `summary` are host-owned
plain text. If `summary` is absent, the existing `subtitle` is used in its
place. Default cards ignore the two new fields, so merely enriching a
`GridSession` cannot silently change an existing hub.

```svelte
<SessionGrid
  sessions={[{
    name: 'codex-orchestrator',
    note: 'release checklist',
    summary: 'running browser integration tests',
  }]}
  {palette}
  {onOpen}
  {onNew}
  cardLayout="dense"
  showNew={false}
/>
```

Dense cards are square and take the full container width on coarse pointers and
narrow screens. At 768 px or wider, a fine pointer selects exact 500 × 500 px
cards. This pointer guard is intentional: a phone in landscape can exceed 768
px and must still stay one full-width column. `showNew` defaults to `true`; set
it to `false` only when the host exposes creation elsewhere.

## What the hub does NOT give you

### Agent-state classification

`SessionGrid` can render `state: 'working' | 'idle'`, but thumbmux does not
decide which state an agent is in. Reliable classification is agent-specific
and belongs in the host. In a production host this can be a substantial
subsystem: in the reference host it spans thousands of lines of classifier and
state machinery.
Supply both `state` and a host-localized `stateLabel` when your classifier has a
result; omit them when it does not. Do not treat `attached` or recent
`activityAt` as a WORKING/IDLE classifier.

### Durable prompt history

`PromptsPanel` displays the array the host gives it, and the core prompt scanner
can extract recent submitted prompts from pane lines. Neither is a durable
prompt database. If prompts must survive capture limits, session exit, or a
server restart, persist them in a host-owned store and pass the retrieved values
to the UI. The reference host uses SQLite for that durable layer.

The pane scanner does not impose a character preview limit: text found inside
its bounded scan window is returned without a synthetic ellipsis. Because a
tmux pane does not identify whether a continuation row was a visual wrap or an
intentional newline, pane-derived continuations are normalized to spaces. A
host-owned prompt array can retain intentional newlines, and `PromptsPanel`
passes either form back through `onPick` exactly. Visual density is separate
from data fidelity: a browser-measured row over eight rendered lines receives
an explicit Show all/Show less control rather than being silently clipped.

### A deep-scrollback archive

Hub thumbnails subscribe only to a bounded live tail. For older pages in a full
terminal view, wire the shipped
[`FileHistoryArchive`](../README.md#wiring) into `TmuxWsMux`; use an explicit
`root` if the archive must persist across process runs. Without an archive,
live viewing still works but `history_expand` returns an empty page. The archive
does not turn `SessionThumb` into a deep-history viewer.

A full viewer that requests both older and newer archive pages must serialize
those requests per session on the shared WebSocket: the current `history` reply
identifies the session but carries no direction marker or request token. An
omitted page limit means 500 rows, while a supplied non-positive limit is
normalized to an effective one-row page rather than expanded to the default.
See the
[archive paging contract](protocol.md#archive-history-paging) for the cursor and
reply rules.

### A spawn contract or host policy

`SessionGrid` only calls `onNew`. `LaunchSheet` only builds a `LaunchSpec` and
calls `onLaunch`; it does not select an HTTP route, authenticate the request,
choose a cwd/workspace, or create a git worktree. The host owns those decisions.
thumbmux provides an optional
[`createSpawnHandler()` contract and reference wiring](../README.md#spawn-endpoint-createspawnhandler),
including hooks for cwd validation and host-created worktrees.

## SessionThumb does not claim geometry

`SessionThumb` is a read-only tail subscriber. It never sends keys, never calls
`tmuxMux.sendResize()`, and has no `claimGeometry` prop. A thumbnail card's CSS
size is not the tmux pane's rows and columns: several cards and devices can view
the same pane at different sizes.

The optional `density="dense"` preview renders 50 rows from a 60-row
subscription and uses smaller line metrics. Omitting it keeps the historical
30 rendered rows plus 10 ANSI-context rows.

Do not resize the real pane to match a thumbnail. Geometry belongs to the one
visible, interactive `TermView` (or to a host-side arbitration policy). Any
duplicate or view-only `TermView` should use `claimGeometry={false}` as described
in the [desktop interaction contract](desktop.md#7-geometry-ownership).
