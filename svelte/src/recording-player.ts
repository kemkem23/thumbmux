/**
 * Recording player helpers shared by the Svelte component.
 *
 * This module is deliberately framework- and platform-neutral: it has no
 * dependencies on browser globals and depends only on injected time/scheduling
 * primitives.
 */

/**
 * Supported playback rates exposed by the recording player UI.
 */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;

/**
 * Playback speed type constrained to the supported values.
 */
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * Test IDs used by the recording player component.
 */
export const RECORDING_PLAYER_TEST_IDS = {
  controls: "recording-controls",
  timeline: "recording-timeline",
} as const;

/**
 * Default max number of `(paletteThemeKey, recordIndex)` entries retained by
 * the frame HTML cache.
 *
 * Kept deliberately low: each entry holds an unrestricted rendered-row array,
 * so an entry-count-only cap of 256 was enough to OOM a phone (256 × 2,000
 * rows = 512,000 retained HTML rows). Prefer the rendered-character budget
 * ({@link FRAME_HTML_CACHE_MAX_RENDERED_CHARS}) as the real memory governor;
 * this entry cap is a secondary guard against tiny-frame scrub thrash.
 */
export const FRAME_HTML_CACHE_MAX_ENTRIES = 24;

/**
 * Default total rendered-character weight budget across all cached frames.
 *
 * Weight is the sum of rendered string lengths (or a per-row fallback for
 * non-string render results). ~256 KiB of character payload keeps heap/RSS
 * growth bounded on mobile while still covering several large frames.
 */
export const FRAME_HTML_CACHE_MAX_RENDERED_CHARS = 256 * 1024;

/**
 * @deprecated Alias of {@link FRAME_HTML_CACHE_MAX_ENTRIES}.
 *
 * The historical value was `256` and meant "entry count only" with no memory
 * budget. The name is retained so existing re-exports keep resolving, but the
 * value is now the sharply lower entry cap. Prefer the explicit
 * `FRAME_HTML_CACHE_MAX_ENTRIES` / `FRAME_HTML_CACHE_MAX_RENDERED_CHARS` names.
 */
export const FRAME_HTML_CACHE_LIMIT = FRAME_HTML_CACHE_MAX_ENTRIES;

/**
 * Clamp a UI elapsed value into the bounded player domain.
 *
 * The function is intentionally defensive for invalid numbers and non-finite
 * durations.
 */
export function clampPlaybackElapsed(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  if (elapsedMs <= 0) {
    return 0;
  }

  if (elapsedMs >= durationMs) {
    return durationMs;
  }

  return elapsedMs;
}

/**
 * Minimal journal contract used by the playback controller.
 */
export interface ReplayJournalLike<TFrame> {
  /**
   * Total duration of the replay timeline in milliseconds.
   */
  readonly durationMs: number;
  /**
   * Timeline start timestamp in the same unit/domain used by journal records.
   */
  readonly startAt: number;
  /**
   * Resolve a full replay frame at the provided absolute time.
   */
  seek(absoluteTime: number): TFrame;
}

/**
 * Resolve the current replay frame for the supplied UI elapsed time.
 *
 * Elapsed time is clamped to `[0, journal.durationMs]` and then translated into
 * the journal domain by calling `journal.seek(startAt + clampedElapsed)`.
 * A non-finite `journal.startAt` is sanitized to `0` so `seek` never receives
 * `NaN`/`Infinity` from this helper (core `ReplayJournal.seek` throws on
 * non-finite time). Otherwise this function still propagates throws from
 * `seek` — use {@link resolveReplayFrame} for a total result.
 */
export function lookupReplayFrame<TFrame>(
  journal: ReplayJournalLike<TFrame>,
  elapsedMs: number,
): TFrame {
  const safeElapsed = clampPlaybackElapsed(elapsedMs, journal.durationMs);
  const startAt = Number.isFinite(journal.startAt) ? journal.startAt : 0;
  return journal.seek(startAt + safeElapsed);
}

/**
 * Failure codes returned by {@link resolveReplayFrame}.
 */
export type ResolveReplayFrameCode = "seek-failed" | "invalid-frame";

/**
 * Successful frame resolution.
 */
export interface ResolveReplayFrameSuccess<TFrame> {
  readonly ok: true;
  readonly frame: TFrame;
}

/**
 * Failed frame resolution (seek threw, or the frame payload is unusable).
 */
export interface ResolveReplayFrameFailure {
  readonly ok: false;
  readonly code: ResolveReplayFrameCode;
  readonly error: unknown;
}

/**
 * Discriminated result of a total (non-throwing) replay frame lookup.
 */
export type ResolveReplayFrameResult<TFrame> =
  | ResolveReplayFrameSuccess<TFrame>
  | ResolveReplayFrameFailure;

/**
 * Total variant of {@link lookupReplayFrame}: never throws.
 *
 * - `seek()` exceptions become `{ ok: false, code: 'seek-failed', error }`.
 * - A non-object frame, or a frame whose `lines` is not an array, becomes
 *   `{ ok: false, code: 'invalid-frame', error }`.
 * - Otherwise `{ ok: true, frame }`.
 */
export function resolveReplayFrame<TFrame>(
  journal: ReplayJournalLike<TFrame>,
  elapsedMs: number,
): ResolveReplayFrameResult<TFrame> {
  let frame: TFrame;
  try {
    frame = lookupReplayFrame(journal, elapsedMs);
  } catch (error) {
    return { ok: false, code: "seek-failed", error };
  }

  if (frame === null || typeof frame !== "object") {
    return {
      ok: false,
      code: "invalid-frame",
      error: new TypeError("replay frame is not an object"),
    };
  }

  const lines = (frame as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) {
    return {
      ok: false,
      code: "invalid-frame",
      error: new TypeError("replay frame.lines is not an array"),
    };
  }

  return { ok: true, frame };
}

/**
 * Floor-index of the record covering `absoluteTime` over a sorted ascending
 * `recordAts` timeline (same clamp/floor semantics as core `ReplayJournal.seek`).
 *
 * - empty timeline → `0`
 * - `time <= first` → `0`
 * - `time >= last` → last index
 * - otherwise greatest `i` with `recordAts[i] <= absoluteTime`
 */
export function recordIndexAt(recordAts: readonly number[], absoluteTime: number): number {
  const n = recordAts.length;
  if (n === 0) {
    return 0;
  }
  if (!Number.isFinite(absoluteTime)) {
    return 0;
  }
  if (absoluteTime <= recordAts[0]!) {
    return 0;
  }
  if (absoluteTime >= recordAts[n - 1]!) {
    return n - 1;
  }

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (recordAts[mid]! <= absoluteTime) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Absolute time of the next record strictly after `absoluteTime`, or `null`
 * when `absoluteTime` is at/after the last record (or the timeline is empty).
 *
 * Useful for playback loops: while `elapsed` stays below
 * `nextRecordTime - startAt`, the selected record index cannot change, so the
 * frame HTML does not need to be rebuilt.
 */
export function nextRecordTime(
  recordAts: readonly number[],
  absoluteTime: number,
): number | null {
  const n = recordAts.length;
  if (n === 0) {
    return null;
  }
  if (!Number.isFinite(absoluteTime)) {
    return recordAts[0] ?? null;
  }
  if (absoluteTime < recordAts[0]!) {
    return recordAts[0]!;
  }
  const idx = recordIndexAt(recordAts, absoluteTime);
  const next = idx + 1;
  if (next >= n) {
    return null;
  }
  return recordAts[next]!;
}

/**
 * Compose line-level HTML into a single frame document string.
 *
 * Centralised so the player and benchmarks share one join path, and so the
 * frame cache can memoize the compact frame-level result.
 */
export function joinRenderedFrameHtml(renderedLines: readonly string[]): string {
  const n = renderedLines.length;
  if (n === 0) {
    return '';
  }
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += `<div>${renderedLines[i]}</div>`;
  }
  return out;
}

/**
 * Monotonic time source contract.
 */
export type PlaybackNow = () => number;

/**
 * One-shot scheduler contract.
 */
export type PlaybackScheduler<THandle = unknown> = (callback: () => void) => THandle;

/**
 * Handle cancellation contract for a scheduled callback.
 */
export type PlaybackCanceller<THandle = unknown> = (handle: THandle) => void;

/**
 * Optional change callback invoked when observable snapshot changes.
 */
export type PlaybackChangeObserver = (snapshot: PlaybackSnapshot) => void;

/**
 * Read-only snapshot of the playback controller state.
 */
export interface PlaybackSnapshot {
  /** Playback progress in milliseconds (`0..durationMs`). */
  readonly elapsedMs: number;
  /** Total replay duration in milliseconds. */
  readonly durationMs: number;
  /** Current playback speed. */
  readonly speed: PlaybackSpeed;
  /** Playback activity state. */
  readonly isPlaying: boolean;
}

/**
 * Dependencies required by the controller.
 */
export interface PlaybackControllerOptions<THandle = unknown> {
  /** Total duration in milliseconds. */
  readonly durationMs: number;
  /** Injected monotonic clock (for deterministic tests and non-browser adapters). */
  readonly now: PlaybackNow;
  /** Injected one-shot scheduler (for deterministic tests and non-browser adapters). */
  readonly scheduler: PlaybackScheduler<THandle>;
  /** Injected scheduler canceller (for deterministic tests and non-browser adapters). */
  readonly canceller: PlaybackCanceller<THandle>;
  /**
   * Callback receiving updated snapshots for component sync/observation.
   */
  readonly onChange?: PlaybackChangeObserver;
  /** Initial playback speed. */
  readonly initialSpeed?: PlaybackSpeed;
}

/**
 * Playback controller API consumed by the Svelte component.
 */
export interface RecordingPlaybackController {
  /**
   * Read current snapshot after applying in-flight elapsed accounting.
   */
  snapshot(): PlaybackSnapshot;
  /**
   * Start playback if not at end and schedule progress updates.
   */
  play(): PlaybackSnapshot;
  /**
   * Pause playback and clear any scheduled callback.
   */
  pause(): PlaybackSnapshot;
  /**
   * Seek to a UI elapsed value and rebase time origin.
   */
  seek(elapsedMs: number): PlaybackSnapshot;
  /**
   * Change playback speed.
   *
   * Invalid speeds are rejected and do not change playback state.
   */
  setSpeed(speed: number): PlaybackSnapshot;
  /**
   * Drive a playback step.
   */
  tick(): PlaybackSnapshot;
  /**
   * Tear down playback activity and cancel outstanding handles.
   */
  destroy(): void;
}

/**
 * Build a deterministic, in-memory playback controller.
 */
export function createPlaybackController<THandle = unknown>(
  options: PlaybackControllerOptions<THandle>,
): RecordingPlaybackController {
  const durationMs = clampPositiveFinite(options.durationMs);
  const getNow = options.now;
  const schedule = options.scheduler;
  const cancel = options.canceller;
  const onChange = options.onChange;

  let speed: PlaybackSpeed = sanitizePlaybackSpeed(options.initialSpeed);
  let elapsedMs = 0;
  let isPlaying = false;
  let anchorNow = readFiniteNow() ?? 0;

  let scheduleHandle: THandle | null = null;
  let hasScheduledHandle = false;
  let destroyed = false;

  let lastSnapshot: PlaybackSnapshot = {
    elapsedMs: 0,
    durationMs,
    speed,
    isPlaying: false,
  };

  /**
   * Read a finite clock value, or `undefined` when the clock is unusable.
   *
   * Non-finite readings must NOT collapse to `0` — that would re-anchor at the
   * epoch and produce a giant forward jump on the next good sample.
   */
  function readFiniteNow(): number | undefined {
    const nowValue = getNow();
    return Number.isFinite(nowValue) ? nowValue : undefined;
  }

  function reanchor(nowValue?: number): void {
    const candidate = nowValue !== undefined ? nowValue : readFiniteNow();
    if (candidate !== undefined) {
      anchorNow = candidate;
    }
  }

  function clampPositiveFinite(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return value;
  }

  function sanitizePlaybackSpeed(requested: PlaybackSpeed | undefined): PlaybackSpeed {
    if (requested === undefined || !isValidSpeed(requested)) {
      return 1;
    }
    return requested;
  }

  function clampSnapshot(rawElapsed: number): number {
    return clampPlaybackElapsed(rawElapsed, durationMs);
  }

  function materialize(nowValue: number | undefined = readFiniteNow()): PlaybackSnapshot {
    if (isPlaying && durationMs > 0) {
      if (nowValue === undefined) {
        // Non-finite clock: treat as "no time has passed" — keep anchor + elapsed.
        return snapshotInternal();
      }

      // Negative raw delta (NTP step / Date.now jump back) clamps to 0 progress
      // but still re-anchors so the next forward sample is measured correctly.
      const rawDelta = nowValue - anchorNow;
      const elapsedDelta = Math.max(0, rawDelta) * speed;
      const nextElapsed = clampSnapshot(elapsedMs + elapsedDelta);
      elapsedMs = nextElapsed;
      anchorNow = nowValue;

      if (nextElapsed >= durationMs) {
        finishPlayback();
      }
    } else if (!isPlaying) {
      if (nowValue !== undefined) {
        anchorNow = nowValue;
      }
    }

    return snapshotInternal();
  }

  function snapshotInternal(): PlaybackSnapshot {
    return {
      elapsedMs,
      durationMs,
      speed,
      isPlaying,
    };
  }

  function publishIfChanged(next: PlaybackSnapshot): PlaybackSnapshot {
    // Once destroyed, the observer must never fire again (component may be unmounted).
    if (destroyed) {
      return next;
    }

    if (
      next.elapsedMs !== lastSnapshot.elapsedMs ||
      next.durationMs !== lastSnapshot.durationMs ||
      next.speed !== lastSnapshot.speed ||
      next.isPlaying !== lastSnapshot.isPlaying
    ) {
      lastSnapshot = next;
      onChange?.(next);
    }

    return next;
  }

  function cancelScheduled(): void {
    if (!hasScheduledHandle) {
      return;
    }

    if (scheduleHandle !== null) {
      cancel(scheduleHandle);
      scheduleHandle = null;
    }

    hasScheduledHandle = false;
  }

  function finishPlayback(): void {
    isPlaying = false;
    cancelScheduled();
    elapsedMs = clampSnapshot(elapsedMs);
    reanchor();
  }

  function scheduleTick(): void {
    if (destroyed) {
      return;
    }

    if (!isPlaying) {
      return;
    }

    if (hasScheduledHandle || durationMs <= 0 || elapsedMs >= durationMs) {
      if (elapsedMs >= durationMs || durationMs <= 0) {
        finishPlayback();
      }
      return;
    }

    const handle = schedule(runTick);
    hasScheduledHandle = true;
    scheduleHandle = handle;
  }

  function runTick(): void {
    hasScheduledHandle = false;
    scheduleHandle = null;
    if (destroyed) {
      return;
    }

    const next = materialize(readFiniteNow());
    publishIfChanged(next);
    if (next.isPlaying) {
      scheduleTick();
    }
  }

  function markFrame(nowValue: number | undefined = readFiniteNow()): PlaybackSnapshot {
    if (destroyed) {
      return snapshotInternal();
    }

    materialize(nowValue);
    return snapshotInternal();
  }

  function snapshot(): PlaybackSnapshot {
    return publishIfChanged(markFrame());
  }

  function play(): PlaybackSnapshot {
    if (destroyed) {
      return snapshot();
    }

    materialize(readFiniteNow());

    if (durationMs <= 0 || elapsedMs >= durationMs) {
      finishPlayback();
      return publishIfChanged(snapshotInternal());
    }

    isPlaying = true;
    reanchor();
    scheduleTick();
    return publishIfChanged(snapshotInternal());
  }

  function pause(): PlaybackSnapshot {
    if (destroyed) {
      return snapshot();
    }

    materialize(readFiniteNow());
    isPlaying = false;
    cancelScheduled();
    return publishIfChanged(snapshotInternal());
  }

  function seek(elapsedTarget: number): PlaybackSnapshot {
    if (destroyed) {
      return snapshot();
    }

    const wasPlaying = isPlaying;
    materialize(readFiniteNow());

    elapsedMs = clampSnapshot(elapsedTarget);
    reanchor();
    isPlaying = wasPlaying && elapsedMs < durationMs && durationMs > 0;

    if (!isPlaying) {
      cancelScheduled();
    } else {
      scheduleTick();
    }

    return publishIfChanged(snapshotInternal());
  }

  function setSpeed(nextSpeed: number): PlaybackSnapshot {
    if (destroyed) {
      return snapshot();
    }

    materialize(readFiniteNow());

    if (!isValidSpeed(nextSpeed)) {
      return publishIfChanged(snapshotInternal());
    }

    const wasPlaying = isPlaying;
    speed = nextSpeed;
    reanchor();

    isPlaying = wasPlaying && elapsedMs < durationMs && durationMs > 0;
    if (!isPlaying) {
      cancelScheduled();
    } else if (wasPlaying) {
      scheduleTick();
    }

    return publishIfChanged(snapshotInternal());
  }

  function tick(): PlaybackSnapshot {
    if (destroyed) {
      return snapshotInternal();
    }

    const next = materialize(readFiniteNow());
    if (next.isPlaying) {
      scheduleTick();
    } else {
      cancelScheduled();
    }
    return publishIfChanged(snapshotInternal());
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }

    destroyed = true;
    isPlaying = false;
    cancelScheduled();
    // Keep lastSnapshot coherent with the final paused state so any future
    // publish path (if a guard is missed) still sees no isPlaying delta.
    lastSnapshot = snapshotInternal();
  }

  return {
    snapshot,
    play,
    pause,
    seek,
    setSpeed,
    tick,
    destroy,
  };

  function isValidSpeed(candidate: number): candidate is PlaybackSpeed {
    return (PLAYBACK_SPEEDS as readonly number[]).includes(candidate);
  }
}

/**
 * Cache function used by frame HTML rendering.
 *
 * The caller supplies a safe `lineToHtml` renderer. Results are cached by at
 * least `(recordIndex, paletteThemeKey)` and preserve identity on cache hits.
 */
export interface FrameHtmlLineToHtml<T> {
  (line: string): T;
}

/**
 * Input describing a frame to render or retrieve from the HTML cache.
 */
export interface FrameHtmlCacheInput {
  recordIndex: number;
  paletteThemeKey: PropertyKey;
  lines: readonly string[];
}

/**
 * Internal weighted LRU entry. `frameHtml` is the compact frame-level document
 * (joined once) so scrubbing back to a hit avoids re-joining thousands of rows.
 */
interface FrameHtmlCacheEntry<T> {
  readonly rendered: readonly T[];
  /** Sum of rendered string lengths (or per-row fallback). */
  readonly weight: number;
  /** Memoized compact frame HTML; set on first {@link FrameHtmlCache.getJoined}. */
  frameHtml: string | null;
}

/**
 * Bounded weighted-LRU cache of rendered frame HTML values.
 */
export interface FrameHtmlCache<T> {
  /**
   * Return cached per-line values for a frame or render and store them.
   */
  get(input: FrameHtmlCacheInput): readonly T[];
  /**
   * Return compact frame-level HTML, memoized per cache entry.
   *
   * `join` is invoked at most once per entry; subsequent hits return the same
   * string identity without re-mapping or re-joining rows.
   */
  getJoined(input: FrameHtmlCacheInput, join: (rendered: readonly T[]) => string): string;
  /**
   * Clear all cached values.
   */
  clear(): void;
  /**
   * Current number of cached frame entries (observability for eviction).
   */
  size(): number;
  /**
   * Total rendered-character weight currently retained (observability).
   */
  renderedChars(): number;
}

/**
 * Options for {@link createFrameHtmlCache}.
 */
export interface CreateFrameHtmlCacheOptions<T> {
  /** Pure, safe line renderer. */
  lineToHtml: FrameHtmlLineToHtml<T>;
  /**
   * Maximum number of `(paletteThemeKey, recordIndex)` entries retained.
   * Non-finite values and values `< 1` fall back to
   * {@link FRAME_HTML_CACHE_MAX_ENTRIES}.
   *
   * Prefer {@link maxEntries}; `limit` is kept as a synonym so older call
   * sites keep working under the new lower default.
   */
  limit?: number;
  /**
   * Maximum number of `(paletteThemeKey, recordIndex)` entries retained.
   * Takes precedence over {@link limit} when both are set.
   */
  maxEntries?: number;
  /**
   * Maximum total rendered-character weight retained across all entries.
   * Non-finite values and values `< 1` fall back to
   * {@link FRAME_HTML_CACHE_MAX_RENDERED_CHARS}.
   */
  maxRenderedChars?: number;
}

/**
 * Resolve a positive integer option or fall back to `fallback`.
 */
function resolvePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Measure the retained weight of a rendered frame.
 *
 * String results sum character lengths (the real memory driver). Non-string
 * results fall back to a fixed per-row weight so eviction still has a signal.
 */
function measureRenderedWeight<T>(rendered: readonly T[]): number {
  let weight = 0;
  for (let i = 0; i < rendered.length; i += 1) {
    const item = rendered[i];
    if (typeof item === 'string') {
      weight += item.length;
    } else {
      weight += 64;
    }
  }
  return weight;
}

/**
 * Create a weighted LRU cache of rendered frame HTML.
 *
 * Entries are keyed on `(paletteThemeKey, recordIndex)` under both an entry
 * count cap and a rendered-character budget so theme switches cannot grow an
 * unbounded second partition and large multi-row frames cannot retain
 * unbounded HTML on a phone. A cache hit refreshes recency (Map insertion
 * order). Identity of the per-line array is preserved on hits.
 *
 * Non-string/non-number theme keys (symbols) are assigned a unique per-cache
 * identity id: `String(Symbol('t'))` is just `"Symbol(t)"`, so two distinct
 * symbols sharing a description would otherwise collide into one entry.
 */
export function createFrameHtmlCache<T>(
  options: CreateFrameHtmlCacheOptions<T>,
): FrameHtmlCache<T> {
  const lineToHtml = options.lineToHtml;
  const maxEntries = resolvePositiveInt(
    options.maxEntries ?? options.limit,
    FRAME_HTML_CACHE_MAX_ENTRIES,
  );
  const maxRenderedChars = resolvePositiveInt(
    options.maxRenderedChars,
    FRAME_HTML_CACHE_MAX_RENDERED_CHARS,
  );

  // Single Map: insertion order = LRU order (same pattern as sparse overlay cache).
  const cache = new Map<string, FrameHtmlCacheEntry<T>>();
  // Identity table for PropertyKey values that lose distinction under String().
  const keyIdentities = new Map<PropertyKey, number>();
  let nextKeyId = 0;
  let totalWeight = 0;

  /**
   * Stable string id for a paletteThemeKey within this cache instance.
   *
   * Strings and numbers use their value directly (with a type tag). Symbols and
   * any other key are looked up in the identity table so reference identity is
   * preserved — two `Symbol('theme')` instances get distinct ids.
   */
  function themeKeyId(paletteThemeKey: PropertyKey): string {
    if (typeof paletteThemeKey === 'string') {
      return `s\u0000${paletteThemeKey}`;
    }
    if (typeof paletteThemeKey === 'number') {
      return `n\u0000${String(paletteThemeKey)}`;
    }
    let id = keyIdentities.get(paletteThemeKey);
    if (id === undefined) {
      id = nextKeyId;
      nextKeyId += 1;
      keyIdentities.set(paletteThemeKey, id);
    }
    return `i\u0000${id}`;
  }

  function frameHtmlCacheKey(paletteThemeKey: PropertyKey, recordIndex: number): string {
    return `${themeKeyId(paletteThemeKey)}\u0000${recordIndex}`;
  }

  function touch(key: string, entry: FrameHtmlCacheEntry<T>): void {
    cache.delete(key);
    cache.set(key, entry);
  }

  function evictOldest(): boolean {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return false;
    }
    const entry = cache.get(oldest);
    if (entry) {
      totalWeight -= entry.weight;
      if (totalWeight < 0) {
        totalWeight = 0;
      }
    }
    cache.delete(oldest);
    return true;
  }

  /**
   * Evict LRU entries until there is room for `incomingWeight` under both the
   * entry-count and rendered-character budgets. Always leaves room to insert
   * the current frame even when it alone exceeds the character budget (the
   * live frame must be displayable).
   */
  function ensureCapacity(incomingWeight: number): void {
    while (cache.size > 0) {
      const overEntries = cache.size >= maxEntries;
      const overWeight = totalWeight + incomingWeight > maxRenderedChars;
      if (!overEntries && !overWeight) {
        break;
      }
      // If this is the only entry left and it still won't fit, drop it and stop
      // — the incoming frame replaces it.
      if (!evictOldest()) {
        break;
      }
    }
  }

  function materialize(input: FrameHtmlCacheInput): FrameHtmlCacheEntry<T> {
    const { recordIndex, paletteThemeKey, lines } = input;
    const key = frameHtmlCacheKey(paletteThemeKey, recordIndex);

    const cached = cache.get(key);
    if (cached !== undefined) {
      touch(key, cached);
      return cached;
    }

    // Degenerate / truncated frames may lack `lines` — render empty, never throw.
    const safeLines = Array.isArray(lines) ? lines : [];
    const rendered: readonly T[] = safeLines.map((line) => lineToHtml(line));
    const weight = measureRenderedWeight(rendered);
    ensureCapacity(weight);

    const entry: FrameHtmlCacheEntry<T> = {
      rendered,
      weight,
      frameHtml: null,
    };
    cache.set(key, entry);
    totalWeight += weight;
    return entry;
  }

  function get(input: FrameHtmlCacheInput): readonly T[] {
    return materialize(input).rendered;
  }

  function getJoined(
    input: FrameHtmlCacheInput,
    join: (rendered: readonly T[]) => string,
  ): string {
    const entry = materialize(input);
    if (entry.frameHtml !== null) {
      return entry.frameHtml;
    }
    const joined = join(entry.rendered);
    entry.frameHtml = joined;
    return joined;
  }

  function clear(): void {
    cache.clear();
    keyIdentities.clear();
    totalWeight = 0;
  }

  function size(): number {
    return cache.size;
  }

  function renderedChars(): number {
    return totalWeight;
  }

  return { get, getJoined, clear, size, renderedChars };
}
