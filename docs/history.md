# Durable history

A terminal viewer archives what someone is looking at. That is reasonable for a
viewer and fatal for a history: a session where an agent works alone stops being
recorded the moment the last tab closes, and nobody finds out until they go
looking for a day that was never written down.

Two pieces fix that, and a host can adopt them independently:

- **`RetentionLane`** captures the sessions you list, on its own timer, with no
  viewer attached and no frames produced.
- **`DurableHistoryArchive`** stores what it captures as plain text a shell can
  read, and keeps the rows that are still on screen instead of only the ones
  that have scrolled past.

```ts
import { DurableHistoryArchive, RetentionLane, TmuxWsMux, createBunTmuxDriver } from "thumbmux/server";

const driver = createBunTmuxDriver();
const archive = new DurableHistoryArchive({
  root: "/var/lib/myapp/terminal-history",
  group: (session) => topicOf(session) ?? "_ungrouped",
});

const mux = new TmuxWsMux({ driver, archive, liveLineLimit: 1_000 });

const retention = new RetentionLane({
  driver,
  archive,
  liveLineLimit: 1_000,
  sessions: () => liveSessionNames(),          // read fresh every tick
  hasViewers: (session) => watched.has(session), // from the mux's subscribe hooks
  intervalMs: 30_000,
  onStatus: (status) => recordRetentionStatus(status),
});
retention.start();
```

## What it stores, and where it stops

`capture-pane` returns scrollback followed by the visible screen, and **only the
visible screen can be repainted in place**. Everything above it has scrolled into
tmux's history and cannot change again, so that is exactly what gets stored. The
boundary is the pane's height, not a guess about how many rows an agent's
composer redraws — every version of this logic that guessed lost real history.
Measured on production agent panes: composers repaint five to eight rows, while
the older reconciliation tolerated two, and 96% of genuine scrolls were archived
as "nothing moved".

Two numbers that used to be one:

| | |
| --- | --- |
| `totalLines` | everything stored, including rows the viewer still shows |
| `liveStartLine` | where the mux's live window begins |

`readBefore` stops at `liveStartLine`, so a client scrolling up never sees a row
twice, while `cat` sees the whole file. Storing the live window is the point: at
a tmux server restart those rows exist nowhere else.

## Reading it

```
<root>/<group>/<session>/
├── 000000000000.log     plain text, one file line per terminal line, ANSI intact
├── 000000000500.log     filename = the absolute line the chunk starts at
├── index.jsonl          one record per closed chunk
└── meta.json            totals and the live boundary
```

```bash
cat *.log                                   # the whole history, in order
grep -an "TypeError" *.log                  # -a because a pane can emit binary
sed -n '120,180p' 000000012000.log          # absolute lines 12119..12179
tail -200 "$(ls *.log | tail -1)"           # what it was doing most recently
cat *.log | sed -e 's/\x1b\[[0-9;]*m//g'    # strip colour (or: less -R to keep it)
```

`index.jsonl` and `meta.json` are **caches**. Every number in them is
recomputable by scanning the directory, so deleting one costs a rescan rather
than the history — unlike a single manifest whose loss makes half a million
lines unreadable. A final line torn by a power cut is dropped when the directory
is next opened, which is safe because a terminal line cannot contain a newline.

## Letting an AI agent read the history

The reason this exists is so a future session can answer *"what was I doing
before the machine froze"* by reading the archive itself. That only works if the
agent knows the archive is there — so put a **short pointer** in the project's
`CLAUDE.md`, `AGENTS.md`, or a skill. Copy this and fill in your root:

```markdown
## Terminal history

Past terminal output for this project is archived at
`<root>/<topic>/<session>/*.log` — plain text, one file line per terminal line,
ANSI escapes intact, filenames are absolute line numbers.

- what a session was doing most recently: `tail -200 "$(ls <root>/<topic>/<session>/*.log | tail -1)"`
- search it: `grep -an "<pattern>" <root>/<topic>/<session>/*.log`
- strip colour when reading: `... | sed -e 's/\x1b\[[0-9;]*m//g'`

Lines starting with `⟦thumbmux gap:` mark a stretch that was produced but never
captured; the number in them is a lower bound.
```

Keep the pointer short. Its job is to say *that the history exists and how to
reach it* — pasting history into a context file spends tokens on every request
to answer a question nobody asked yet.

## What it cannot do

- **A burst larger than tmux's ring.** If 60,000 lines are printed between two
  captures and tmux keeps 50,000, the overflow is gone; no polling archive can
  recover it. What you get instead is a `⟦thumbmux gap: …⟧` line recording that
  it happened, with a lower bound on the size. Give tmux a large
  `history-limit`: the ring is the buffer that carries a burst between captures.
- **A pane on the alternate screen.** A fullscreen TUI keeps its history inside
  the application, and tmux has no scrollback for it at all. There is nothing to
  capture, and the archive will honestly stay small.
- **Anything from before you turned this on.** History that was never captured
  cannot be reconstructed.

## Size caps delete history

`DurableHistoryArchive` grows without limit unless you tell it not to. Two
options bound one session:

```ts
new DurableHistoryArchive({
  root: "/var/lib/myapp/history",
  maxLinesPerSession: 500_000,   // unset by default
  maxBytesPerSession: 256 * 1024 * 1024,
})
```

**Both are off by default, and turning one on is not reversible.** An append that
pushes a session past its cap deletes whole chunk files from the oldest end.
Those lines are gone — there is no tombstone, no marker, and no recovery. The
count that went is reported as `prunedLines` on the append result, so a host that
wants to log or alert on it can; nothing is logged for you.

Three properties are worth knowing before you pick a number:

- **The cap is approximate, and it errs upward.** Pruning removes whole chunks,
  because rewriting a partial one would cost O(size) and break the append-only
  property that makes torn-write recovery a truncation. A chunk is dropped only
  when what remains still meets the cap, so a session holds *at least* the cap
  and up to one chunk more. It never falls below it.
- **Line numbers are never renumbered.** The archive simply starts later.
  `readBefore(session, null)` reports the new first line as `startLine` and
  `hasMore: false` once you reach it, and `readAfter(session, null)` agrees.
  Asking for a line below that floor returns an empty page rather than a short
  one mislabelled as line 0.
- **The newest chunk is never dropped.** A cap smaller than one chunk degrades to
  "keep one chunk" instead of emptying the session.

## Markers

A gap marker is a line **about** the history, written into it:

```
⟦thumbmux gap: history before this point could not be joined to what tmux still holds · 2026-08-15T10:06:22.224Z⟧
```

It is written only when the archive cannot find its own tail in a capture *and*
there is fresh content to resume from — a quiet session whose whole pane still
fits inside the live window has nothing archived yet, which is not a hole.
Markers are never used as an anchor: a marker cannot appear in a capture, so an
anchor containing one could never match, and every miss would write another.
