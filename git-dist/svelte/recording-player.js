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
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];
/**
 * Test IDs used by the recording player component.
 */
export const RECORDING_PLAYER_TEST_IDS = {
    controls: "recording-controls",
    timeline: "recording-timeline",
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
export function clampPlaybackElapsed(elapsedMs, durationMs) {
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
 * Resolve the current replay frame for the supplied UI elapsed time.
 *
 * Elapsed time is clamped to `[0, journal.durationMs]` and then translated into
 * the journal domain by calling `journal.seek(startAt + clampedElapsed)`.
 * A non-finite `journal.startAt` is sanitized to `0` so `seek` never receives
 * `NaN`/`Infinity` from this helper (core `ReplayJournal.seek` throws on
 * non-finite time). Otherwise this function still propagates throws from
 * `seek` — use {@link resolveReplayFrame} for a total result.
 */
export function lookupReplayFrame(journal, elapsedMs) {
    const safeElapsed = clampPlaybackElapsed(elapsedMs, journal.durationMs);
    const startAt = Number.isFinite(journal.startAt) ? journal.startAt : 0;
    return journal.seek(startAt + safeElapsed);
}
/**
 * Total variant of {@link lookupReplayFrame}: never throws.
 *
 * - `seek()` exceptions become `{ ok: false, code: 'seek-failed', error }`.
 * - A non-object frame, or a frame whose `lines` is not an array, becomes
 *   `{ ok: false, code: 'invalid-frame', error }`.
 * - Otherwise `{ ok: true, frame }`.
 */
export function resolveReplayFrame(journal, elapsedMs) {
    let frame;
    try {
        frame = lookupReplayFrame(journal, elapsedMs);
    }
    catch (error) {
        return { ok: false, code: "seek-failed", error };
    }
    if (frame === null || typeof frame !== "object") {
        return {
            ok: false,
            code: "invalid-frame",
            error: new TypeError("replay frame is not an object"),
        };
    }
    const lines = frame.lines;
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
export function recordIndexAt(recordAts, absoluteTime) {
    const n = recordAts.length;
    if (n === 0) {
        return 0;
    }
    if (!Number.isFinite(absoluteTime)) {
        return 0;
    }
    if (absoluteTime <= recordAts[0]) {
        return 0;
    }
    if (absoluteTime >= recordAts[n - 1]) {
        return n - 1;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (recordAts[mid] <= absoluteTime) {
            lo = mid;
        }
        else {
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
export function nextRecordTime(recordAts, absoluteTime) {
    const n = recordAts.length;
    if (n === 0) {
        return null;
    }
    if (!Number.isFinite(absoluteTime)) {
        return recordAts[0] ?? null;
    }
    if (absoluteTime < recordAts[0]) {
        return recordAts[0];
    }
    const idx = recordIndexAt(recordAts, absoluteTime);
    const next = idx + 1;
    if (next >= n) {
        return null;
    }
    return recordAts[next];
}
/**
 * Compose line-level HTML into a single frame document string.
 *
 * Centralised so the player and benchmarks share one join path, and so the
 * frame cache can memoize the compact frame-level result.
 */
export function joinRenderedFrameHtml(renderedLines) {
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
 * Build a deterministic, in-memory playback controller.
 */
export function createPlaybackController(options) {
    const durationMs = clampPositiveFinite(options.durationMs);
    const getNow = options.now;
    const schedule = options.scheduler;
    const cancel = options.canceller;
    const onChange = options.onChange;
    let speed = sanitizePlaybackSpeed(options.initialSpeed);
    let elapsedMs = 0;
    let isPlaying = false;
    let anchorNow = readFiniteNow() ?? 0;
    let scheduleHandle = null;
    let hasScheduledHandle = false;
    let destroyed = false;
    let lastSnapshot = {
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
    function readFiniteNow() {
        const nowValue = getNow();
        return Number.isFinite(nowValue) ? nowValue : undefined;
    }
    function reanchor(nowValue) {
        const candidate = nowValue !== undefined ? nowValue : readFiniteNow();
        if (candidate !== undefined) {
            anchorNow = candidate;
        }
    }
    function clampPositiveFinite(value) {
        if (!Number.isFinite(value) || value <= 0) {
            return 0;
        }
        return value;
    }
    function sanitizePlaybackSpeed(requested) {
        if (requested === undefined || !isValidSpeed(requested)) {
            return 1;
        }
        return requested;
    }
    function clampSnapshot(rawElapsed) {
        return clampPlaybackElapsed(rawElapsed, durationMs);
    }
    function materialize(nowValue = readFiniteNow()) {
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
        }
        else if (!isPlaying) {
            if (nowValue !== undefined) {
                anchorNow = nowValue;
            }
        }
        return snapshotInternal();
    }
    function snapshotInternal() {
        return {
            elapsedMs,
            durationMs,
            speed,
            isPlaying,
        };
    }
    function publishIfChanged(next) {
        // Once destroyed, the observer must never fire again (component may be unmounted).
        if (destroyed) {
            return next;
        }
        if (next.elapsedMs !== lastSnapshot.elapsedMs ||
            next.durationMs !== lastSnapshot.durationMs ||
            next.speed !== lastSnapshot.speed ||
            next.isPlaying !== lastSnapshot.isPlaying) {
            lastSnapshot = next;
            onChange?.(next);
        }
        return next;
    }
    function cancelScheduled() {
        if (!hasScheduledHandle) {
            return;
        }
        if (scheduleHandle !== null) {
            cancel(scheduleHandle);
            scheduleHandle = null;
        }
        hasScheduledHandle = false;
    }
    function finishPlayback() {
        isPlaying = false;
        cancelScheduled();
        elapsedMs = clampSnapshot(elapsedMs);
        reanchor();
    }
    function scheduleTick() {
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
    function runTick() {
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
    function markFrame(nowValue = readFiniteNow()) {
        if (destroyed) {
            return snapshotInternal();
        }
        materialize(nowValue);
        return snapshotInternal();
    }
    function snapshot() {
        return publishIfChanged(markFrame());
    }
    function play() {
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
    function pause() {
        if (destroyed) {
            return snapshot();
        }
        materialize(readFiniteNow());
        isPlaying = false;
        cancelScheduled();
        return publishIfChanged(snapshotInternal());
    }
    function seek(elapsedTarget) {
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
        }
        else {
            scheduleTick();
        }
        return publishIfChanged(snapshotInternal());
    }
    function setSpeed(nextSpeed) {
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
        }
        else if (wasPlaying) {
            scheduleTick();
        }
        return publishIfChanged(snapshotInternal());
    }
    function tick() {
        if (destroyed) {
            return snapshotInternal();
        }
        const next = materialize(readFiniteNow());
        if (next.isPlaying) {
            scheduleTick();
        }
        else {
            cancelScheduled();
        }
        return publishIfChanged(snapshotInternal());
    }
    function destroy() {
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
    function isValidSpeed(candidate) {
        return PLAYBACK_SPEEDS.includes(candidate);
    }
}
/**
 * Resolve a positive integer option or fall back to `fallback`.
 */
function resolvePositiveInt(value, fallback) {
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
function measureRenderedWeight(rendered) {
    let weight = 0;
    for (let i = 0; i < rendered.length; i += 1) {
        const item = rendered[i];
        if (typeof item === 'string') {
            weight += item.length;
        }
        else {
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
export function createFrameHtmlCache(options) {
    const lineToHtml = options.lineToHtml;
    const maxEntries = resolvePositiveInt(options.maxEntries ?? options.limit, FRAME_HTML_CACHE_MAX_ENTRIES);
    const maxRenderedChars = resolvePositiveInt(options.maxRenderedChars, FRAME_HTML_CACHE_MAX_RENDERED_CHARS);
    // Single Map: insertion order = LRU order (same pattern as sparse overlay cache).
    const cache = new Map();
    // Identity table for PropertyKey values that lose distinction under String().
    const keyIdentities = new Map();
    let nextKeyId = 0;
    let totalWeight = 0;
    /**
     * Stable string id for a paletteThemeKey within this cache instance.
     *
     * Strings and numbers use their value directly (with a type tag). Symbols and
     * any other key are looked up in the identity table so reference identity is
     * preserved — two `Symbol('theme')` instances get distinct ids.
     */
    function themeKeyId(paletteThemeKey) {
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
    function frameHtmlCacheKey(paletteThemeKey, recordIndex) {
        return `${themeKeyId(paletteThemeKey)}\u0000${recordIndex}`;
    }
    function touch(key, entry) {
        cache.delete(key);
        cache.set(key, entry);
    }
    function evictOldest() {
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
    function ensureCapacity(incomingWeight) {
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
    function materialize(input) {
        const { recordIndex, paletteThemeKey, lines } = input;
        const key = frameHtmlCacheKey(paletteThemeKey, recordIndex);
        const cached = cache.get(key);
        if (cached !== undefined) {
            touch(key, cached);
            return cached;
        }
        // Degenerate / truncated frames may lack `lines` — render empty, never throw.
        const safeLines = Array.isArray(lines) ? lines : [];
        const rendered = safeLines.map((line) => lineToHtml(line));
        const weight = measureRenderedWeight(rendered);
        ensureCapacity(weight);
        const entry = {
            rendered,
            weight,
            frameHtml: null,
        };
        cache.set(key, entry);
        totalWeight += weight;
        return entry;
    }
    function get(input) {
        return materialize(input).rendered;
    }
    function getJoined(input, join) {
        const entry = materialize(input);
        if (entry.frameHtml !== null) {
            return entry.frameHtml;
        }
        const joined = join(entry.rendered);
        entry.frameHtml = joined;
        return joined;
    }
    function clear() {
        cache.clear();
        keyIdentities.clear();
        totalWeight = 0;
    }
    function size() {
        return cache.size;
    }
    function renderedChars() {
        return totalWeight;
    }
    return { get, getJoined, clear, size, renderedChars };
}
