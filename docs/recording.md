# Recording journal specification

This document describes the server-side `FrameJournal` NDJSON recorder as a
host-neutral recording primitive. `FrameJournal` is exported from
`thumbmux/server`; host integration remains separate controller work.

No existing route, mux transport, demo UI, or replay player wiring is claimed by this document.

## Persisted schema

Journal files are line-oriented NDJSON. Each complete line must be a JSON object with exactly:

```json
{
  "v": 1,
  "session": "demo",
  "at": 1700000000000,
  "frame": {
    "channel": "demo",
    "type": "output",
    "data": "hello\n",
    "cursor": { "row": 0, "col": 0 }
  }
}
```

`frame` is either:

- full output frame:
  `{ "channel": string, "type": "output", "data": string, "cursor?" : { "row": int, "col": int } | null, "reset?" : "resize" | "resync" }`
- delta output frame:
  `{ "channel": string, "type": "delta", "baseLength": number, "prefix": number, "prefixHash": string, "lines": string[], "cursor?" : { "row": int, "col": int } | null }`

Both recorder and replay parsers are strict:

- `v` must be `1`
- exactly keys `v`, `session`, `at`, `frame`
- finite numeric `at`
- channel/session identity checks are required (`frame.channel === record.session`)
- record time is nondecreasing
- complete records must start with `type: "output"`
- full/delta fields must satisfy strict protocol typing, integer bounds, and cursor shape

## Protocol compatibility notes (full/delta)

- A replay parser accepts both full and delta frames using the same `thumbmux/core` frame types.
- Delta replay is only applied when it validates against the canonical base:
  - base-length match
  - `prefix` in bounds
  - `prefixHash` matches
  - candidate reconstruction succeeds
  - strict wire-size gate (`shouldUseMuxDelta`) passes
- Full frames always establish new canonical bases, as required by the protocol.
- `frame.reset` is persisted only on full frames and accepted values are `"resize"` or `"resync"`.
- A resize-derived `reset` frame is therefore recorded as a full checkpoint and may be used as a replay reset marker.

## Host-facing seam

The concrete runtime seam is:

1. `startSession(session)` for new sessions (no read).
2. `recoverSession(session)` for restart/recover paths that need persisted base/metadata.
3. `capture(session, fullOutputFrame, at?)` for each host-provided output snapshot.
4. `flushSession(session)` for per-session durability guarantees.
5. `stopSession(session)` disables future captures for that session and waits for in-flight admitted writes (file retained).
6. `closeSession(session)` stops accepting, drains the queue, and drops **in-memory** state only. The durable journal file is **not** deleted and its bytes still count toward the aggregate root quota. A later `capture` for the same name starts a fresh in-memory session that appends to the same file beginning with a full frame.
7. `deleteSessionJournal(session)` stops accepting, flushes, deletes the durable `*.ndjson` file, releases root-quota accounting, and drops in-memory state. Requires `storage.remove`. Returns `false` when the file is already absent.
8. `stop()` disables all sessions globally, flushes every queue, and clears in-memory handles (files retained until deleted).

`capture` writes in the background and is nonblocking by design; it returns a boolean admission result immediately (`false` when stopped, not accepting, over a size cap, or saturated on `maxPendingWrites`).

## Capture behavior and order

- Only `type: "output"` frames are admitted; mismatch `type` or channel is rejected synchronously.
- Optional `cursor`, when present, must be `null` or `{row, col}` with both finite integers (`Number.isInteger`); `NaN`/`Infinity`/non-integers/non-numbers are rejected at admission.
- Optional `reset`, when present, must be exactly `"resize"` or `"resync"`.
- Frame is canonicalized to the recorder’s frame shape before persistence.
- Writes are per-session FIFO by an internal promise queue.
- Multiple captures can be issued quickly and still persist in order.
- Timestamp source is either explicit `at` or the injected clock (`Date.now` by default).
- Recorded `at` is clamped to monotonic order per session with `max(lastAt, at)`.
- Capture does not wait for disk I/O and does not guarantee durability.

## Full-first, strict-size, and checkpoint rules

- Full snapshot is forced when any of the following is true:
  - no canonical base exists yet for the session
  - input frame carries `reset`
  - delta run reached the checkpoint cadence limit
- Otherwise the recorder attempts to persist a delta.
- Delta persistence still requires strict protocol-size compatibility (same rule as wire delta selection): non-zero prefix and strictly smaller serialized frame size than the equivalent full frame.
- If the chosen delta is not usable against current canonical base, persistence falls back to full frame and the delta run resets.
- `checkpointCadence` defaults to `64` and is configurable; it must be a positive integer.
- `FrameJournal` recovery rejects journals that exceed the cadence between
  full checkpoints. The standalone `parseReplayJournal` parser does not enforce
  this recorder recovery policy.

## Canonical per-session base and session safety

- Canonical base/delta-count/last-timestamp are maintained per session in memory only; there is no viewer/tail/socket state in the recorder.
- Every session is isolated and independently recoverable by its hash-derived file.
- Cross-session contamination is blocked by separate canonical state and deterministic session hashing.

## Recovery and rejected records

- Recovery parses NDJSON by complete lines only.
- A final unterminated line (no trailing newline) is ignored.
- Any complete malformed JSON line, wrong key set, invalid record shape, bad delta candidate, time disorder, first-line delta, session/channel mismatch, or strict-size/cadence violation rejects recovery.
- On recover failure, the session is marked not accepting, further captures are rejected, and error reporting is injected.
- Missing file is treated as an empty session.

## Error reporting and fault handling

- Constructor accepts `onError` callback receiving:
  `session`, `path`, `phase`, optional `at`, optional `line`, and `cause`.
- `phase` is one of:
  - `"recover"` — journal recovery/parse failure (or refuse-to-repair torn tail).
  - `"write"` — append / first-write probe failure.
  - `"limit"` — per-session `maxBytes` or aggregate `maxRootBytes` hard cap hit.
  - `"drop"` — capture refused because `maxPendingWrites` backpressure is saturated.
- `capture` does not throw on background write failure; it reports via `onError`
  (`phase: "write"`) and clears the in-memory base so the next admitted write
  must be a full frame.
- **Fail closed on torn-write rollback failure**: after a partial append (e.g.
  `ENOSPC`), the recorder tries to `truncate` back to the last known-good
  offset. If truncate is unavailable or itself fails, the session sets
  `recoveryFailed` and stops accepting further captures until the host
  recovers or deletes the journal — it does **not** keep appending past
  corrupt bytes.
- Shape validation failures at admission (bad `type`/`channel`/`data`,
  non-finite/non-integer `cursor`, or invalid `reset`) throw synchronously and
  never append — so a caller cannot poison a recording into an unreplayable
  file.
- Report hook exceptions are intentionally swallowed so recorder control flow
  stays alive.

## Flush and stop guarantees

- `flushSession(session)` resolves when that session’s queued work is drained.
- `flushAll()` (used by stop) resolves when all active sessions’ queues drain.
- `stopSession(session)` disables future captures for that session and waits for in-flight admitted writes.
- `closeSession(session)` is the memory-release counterpart: drain + drop the
  handle without deleting the file (root quota unchanged).
- `deleteSessionJournal(session)` is the disk-release counterpart: drain +
  delete file + free root quota.
- `stop()` disables all sessions globally and then flushes every queue.
- No durability guarantee is implied before the relevant flush completes.

## Security and operational bounds

- Path derivation is opaque and host-safe: `sha256(session)` → `<hex>.ndjson` under configured root directory.
- Session names never appear in file names.
- Session path escaping/injection via separators, traversal, or empty strings is avoided by hashing.
- Recovery and capture paths are asynchronous and isolated; the default storage adapter is injectable, so hosts control durability and permission semantics.
- Per-session hard cap: `maxBytes` defaults to **64 MiB** (`DEFAULT_MAX_BYTES`);
  set `Infinity` to disable. Hitting the cap reports `phase: "limit"` and
  sticky-stops that session.
- Aggregate root cap: `maxRootBytes` defaults to **256 MiB**
  (`DEFAULT_MAX_ROOT_BYTES`); set `Infinity` to disable. Hitting the root cap
  reports `phase: "limit"` without sticky-stopping other sessions that may
  free space later (only `deleteSessionJournal` reclaims root quota for a
  closed file).
- Pending-write backpressure: `maxPendingWrites` defaults to `128`; saturation
  reports `phase: "drop"` and returns `false` from `capture`.
