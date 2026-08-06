/**
 * PreferencesAdapter implementations for browsers:
 *   createLocalPrefs   — localStorage only (the demo / single-device hosts)
 *   createServerPrefs  — server-backed JSON endpoint (thumbmux/server
 *                        createPrefsHandler) with a localStorage cache so
 *                        first paint never waits on the network and offline
 *                        reads still work; saves are optimistic.
 */
import { mergePrefs } from '../core/index.js';
function readCache(key) {
    try {
        const raw = localStorage.getItem(key);
        const v = raw ? JSON.parse(raw) : {};
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
function writeCache(key, prefs) {
    try {
        localStorage.setItem(key, JSON.stringify(prefs));
    }
    catch { /* quota/private mode */ }
}
function createQueuedEmitter(key, subs, beforeEmit) {
    const queued = [];
    let emitting = false;
    return (prefs) => {
        queued.push(prefs);
        if (emitting)
            return;
        emitting = true;
        try {
            while (queued.length > 0) {
                const next = queued.shift();
                beforeEmit?.();
                writeCache(key, next);
                // Queue instead of dropping reentrant saves: every subscriber finishes
                // one snapshot before the next begins, without recursive notification.
                for (const cb of subs)
                    cb(next);
            }
        }
        finally {
            emitting = false;
        }
    };
}
function isPrefsSnapshot(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canRefreshCache(_cached, fresh) {
    // A6-13: any valid object snapshot is authoritative, including `{}`
    // (server file missing / every key deleted) and fully-disjoint host keys.
    // Non-object / failed JSON is rejected earlier via isPrefsSnapshot.
    // Keep the helper so the load() call site documents the decision.
    return isPrefsSnapshot(fresh);
}
export function createLocalPrefs(key = 'thumbmux-prefs') {
    const subs = new Set();
    const emit = createQueuedEmitter(key, subs);
    return {
        async load() { return readCache(key); },
        async save(patch) {
            const next = mergePrefs(readCache(key), patch);
            emit(next);
        },
        subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    };
}
export function createServerPrefs(opts) {
    const { url, cacheKey = 'thumbmux-prefs-cache' } = opts;
    const doFetch = opts.fetchFn ?? ((...a) => fetch(...a));
    const subs = new Set();
    // Each load gets a ticket, and every applied GET/optimistic save/PUT settle
    // advances the mutation epoch. A response ticketed before a later mutation
    // can therefore never overwrite that newer cache/subscriber snapshot.
    let generation = 0;
    const emit = createQueuedEmitter(cacheKey, subs, () => { generation++; });
    let committed = {};
    const pendingPuts = [];
    let putTail = Promise.resolve();
    const projectPending = () => pendingPuts.reduce((prefs, pending) => mergePrefs(prefs, pending.patch), committed);
    async function runPut(pending) {
        let response;
        try {
            response = await doFetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: pending.body,
            });
        }
        catch { /* network failure — remove this optimistic patch below */ }
        let invalidResponse;
        if (response?.ok) {
            let saved;
            try {
                saved = await response.json();
            }
            catch { /* validated below */ }
            if (isPrefsSnapshot(saved)) {
                committed = saved;
            }
            else {
                invalidResponse = new Error('Invalid preferences response: expected a JSON object');
            }
        }
        const index = pendingPuts.indexOf(pending);
        if (index !== -1)
            pendingPuts.splice(index, 1);
        emit(projectPending());
        if (invalidResponse)
            throw invalidResponse;
    }
    return {
        async load() {
            const cached = readCache(cacheKey);
            const gen = ++generation;
            // refresh in the background — subscribers get the authoritative copy
            doFetch(url).then(async (r) => {
                if (!r.ok || generation !== gen)
                    return;
                const fresh = await r.json().catch(() => null);
                if (generation !== gen)
                    return; // a save() won while we were fetching
                const current = readCache(cacheKey);
                if (isPrefsSnapshot(fresh)
                    && canRefreshCache(current, fresh)
                    && JSON.stringify(fresh) !== JSON.stringify(current))
                    emit(fresh);
            }).catch(() => { });
            return cached;
        },
        async save(patch) {
            if (pendingPuts.length === 0)
                committed = readCache(cacheKey);
            // deletes must survive JSON transport: undefined → null (RFC 7386 style)
            const wire = {};
            for (const [k, v] of Object.entries(patch))
                wire[k] = v === undefined ? null : v;
            const body = JSON.stringify(wire);
            const stablePatch = JSON.parse(body);
            const pending = { patch: stablePatch, body };
            pendingPuts.push(pending);
            const result = putTail.then(() => runPut(pending), () => runPut(pending));
            putTail = result.then(() => { }, () => { });
            emit(projectPending()); // optimistic
            await result;
        },
        subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    };
}
