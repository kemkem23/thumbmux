# Building a session hub

`SessionGrid` is a presentation component. `TmuxWsMux` publishes the session
inventory on the reserved `__sessions` channel, the browser's `tmuxMux`
subscribes to that inventory, and the host maps each wire item to a
`GridSession`. Each grid card then mounts a read-only `SessionThumb` for the
session's live tail.

## Session-list fields and ownership

The wire type is [`SessionListItem`](../core/src/protocol.ts). The bundled
`createBunTmuxDriver()` fills all five standard fields. If you replace that
driver's `listSessions()` or call `setSessionListProvider()`, your host must
return those same fields. Extra host metadata is allowed and survives the wire,
but thumbmux does not invent it or map it to `SessionGrid` props for you.

| Field or desired metadata | Package fills it with `createBunTmuxDriver()` | Host responsibility with a custom driver/provider | Not in the standard item |
|---|---|---|---|
| `name: string` | Yes — tmux session name | Required | — |
| `created: string` | Yes — tmux creation time, epoch seconds encoded as a string | Required | — |
| `windows: number` | Yes — tmux window count | Required | — |
| `attached: boolean` | Yes — whether a tmux client is attached | Required | — |
| `activityAt: number` | Yes — latest tmux window activity in epoch seconds; `0` before the first activity sample | Required | — |
| Extra keys (`[key: string]: unknown`) | No | Optional — add and interpret them in the host | No fixed fields are defined |
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
callback rows as `any[]`; the server-side wire contract is
`SessionListItem[]`. The `activityAt > 0` guard keeps the pre-sample sentinel
out of the 1970 date range. The mapped time drives `order="recent"`; the grid
still omits its visible state row and timestamp until the host supplies a
`state`. `onOpen` should route to the selected terminal, and `onNew` should open
the host's launcher or other creation flow.

This minimal map intentionally supplies no `state`, so it renders no state dot.
That is also what the v0.5.0 demo does: it shows the real session name and live
thumbnail without synthesizing state. Earlier demo code used `hash % 3` to
invent WORKING/IDLE; v0.5.0 removed that heuristic, and the demo's end-to-end
contract now requires zero state dots when no classifier is wired.

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

### A deep-scrollback archive

Hub thumbnails subscribe only to a bounded live tail. For older pages in a full
terminal view, wire the shipped
[`FileHistoryArchive`](../README.md#wiring) into `TmuxWsMux`; use an explicit
`root` if the archive must persist across process runs. Without an archive,
live viewing still works but `history_expand` returns an empty page. The archive
does not turn `SessionThumb` into a deep-history viewer.

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

Do not resize the real pane to match a thumbnail. Geometry belongs to the one
visible, interactive `TermView` (or to a host-side arbitration policy). Any
duplicate or view-only `TermView` should use `claimGeometry={false}` as described
in the [desktop interaction contract](desktop.md#7-geometry-ownership).
