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
export declare const PLAYBACK_SPEEDS: readonly [0.5, 1, 2, 4];
/**
 * Playback speed type constrained to the supported values.
 */
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];
/**
 * Test IDs used by the recording player component.
 */
export declare const RECORDING_PLAYER_TEST_IDS: {
    readonly controls: "recording-controls";
    readonly timeline: "recording-timeline";
};
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
export declare const FRAME_HTML_CACHE_MAX_ENTRIES = 24;
/**
 * Default total rendered-character weight budget across all cached frames.
 *
 * Weight is the sum of rendered string lengths (or a per-row fallback for
 * non-string render results). ~256 KiB of character payload keeps heap/RSS
 * growth bounded on mobile while still covering several large frames.
 */
export declare const FRAME_HTML_CACHE_MAX_RENDERED_CHARS: number;
/**
 * @deprecated Alias of {@link FRAME_HTML_CACHE_MAX_ENTRIES}.
 *
 * The historical value was `256` and meant "entry count only" with no memory
 * budget. The name is retained so existing re-exports keep resolving, but the
 * value is now the sharply lower entry cap. Prefer the explicit
 * `FRAME_HTML_CACHE_MAX_ENTRIES` / `FRAME_HTML_CACHE_MAX_RENDERED_CHARS` names.
 */
export declare const FRAME_HTML_CACHE_LIMIT = 24;
/**
 * Clamp a UI elapsed value into the bounded player domain.
 *
 * The function is intentionally defensive for invalid numbers and non-finite
 * durations.
 */
export declare function clampPlaybackElapsed(elapsedMs: number, durationMs: number): number;
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
export declare function lookupReplayFrame<TFrame>(journal: ReplayJournalLike<TFrame>, elapsedMs: number): TFrame;
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
export type ResolveReplayFrameResult<TFrame> = ResolveReplayFrameSuccess<TFrame> | ResolveReplayFrameFailure;
/**
 * Total variant of {@link lookupReplayFrame}: never throws.
 *
 * - `seek()` exceptions become `{ ok: false, code: 'seek-failed', error }`.
 * - A non-object frame, or a frame whose `lines` is not an array, becomes
 *   `{ ok: false, code: 'invalid-frame', error }`.
 * - Otherwise `{ ok: true, frame }`.
 */
export declare function resolveReplayFrame<TFrame>(journal: ReplayJournalLike<TFrame>, elapsedMs: number): ResolveReplayFrameResult<TFrame>;
/**
 * Floor-index of the record covering `absoluteTime` over a sorted ascending
 * `recordAts` timeline (same clamp/floor semantics as core `ReplayJournal.seek`).
 *
 * - empty timeline → `0`
 * - `time <= first` → `0`
 * - `time >= last` → last index
 * - otherwise greatest `i` with `recordAts[i] <= absoluteTime`
 */
export declare function recordIndexAt(recordAts: readonly number[], absoluteTime: number): number;
/**
 * Absolute time of the next record strictly after `absoluteTime`, or `null`
 * when `absoluteTime` is at/after the last record (or the timeline is empty).
 *
 * Useful for playback loops: while `elapsed` stays below
 * `nextRecordTime - startAt`, the selected record index cannot change, so the
 * frame HTML does not need to be rebuilt.
 */
export declare function nextRecordTime(recordAts: readonly number[], absoluteTime: number): number | null;
/**
 * Compose line-level HTML into a single frame document string.
 *
 * Centralised so the player and benchmarks share one join path, and so the
 * frame cache can memoize the compact frame-level result.
 */
export declare function joinRenderedFrameHtml(renderedLines: readonly string[]): string;
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
export declare function createPlaybackController<THandle = unknown>(options: PlaybackControllerOptions<THandle>): RecordingPlaybackController;
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
export declare function createFrameHtmlCache<T>(options: CreateFrameHtmlCacheOptions<T>): FrameHtmlCache<T>;
