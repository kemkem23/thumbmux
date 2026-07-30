/**
 * PreferencesAdapter implementations for browsers:
 *   createLocalPrefs   — localStorage only (the demo / single-device hosts)
 *   createServerPrefs  — server-backed JSON endpoint (@thumbmux/server
 *                        createPrefsHandler) with a localStorage cache so
 *                        first paint never waits on the network and offline
 *                        reads still work; saves are optimistic.
 */
import { mergePrefs, type PreferencesAdapter, type ThumbmuxPrefs } from '@thumbmux/core';

function readCache(key: string): ThumbmuxPrefs {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function writeCache(key: string, prefs: ThumbmuxPrefs) {
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* quota/private mode */ }
}

function isPrefsSnapshot(value: unknown): value is ThumbmuxPrefs {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canRefreshCache(cached: ThumbmuxPrefs, fresh: ThumbmuxPrefs): boolean {
  const cachedKeys = Object.keys(cached);
  const freshKeys = Object.keys(fresh);
  // Host-defined keys are valid prefs, so there is no fixed required-key list.
  // Reject empty/unrelated payloads without blocking authoritative deletions.
  return freshKeys.length > 0 && (
    cachedKeys.length === 0
    || cachedKeys.some((key) => Object.prototype.hasOwnProperty.call(fresh, key))
  );
}

export function createLocalPrefs(key = 'thumbmux-prefs'): PreferencesAdapter {
  const subs = new Set<(p: ThumbmuxPrefs) => void>();
  return {
    async load() { return readCache(key); },
    async save(patch) {
      const next = mergePrefs(readCache(key), patch);
      writeCache(key, next);
      for (const cb of subs) cb(next);
    },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}

export function createServerPrefs(opts: {
  /** e.g. '/api/prefs' (host mounts @thumbmux/server createPrefsHandler there) */
  url: string;
  cacheKey?: string;
  fetchFn?: typeof fetch;
}): PreferencesAdapter {
  const { url, cacheKey = 'thumbmux-prefs-cache' } = opts;
  const doFetch = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const subs = new Set<(p: ThumbmuxPrefs) => void>();
  const emit = (p: ThumbmuxPrefs) => { writeCache(cacheKey, p); for (const cb of subs) cb(p); };
  // bump on every save so an in-flight background GET can't clobber newer
  // local state with a stale server snapshot
  let generation = 0;
  type PendingPut = { patch: Partial<ThumbmuxPrefs>; body: string };
  let committed: ThumbmuxPrefs = {};
  const pendingPuts: PendingPut[] = [];
  let putTail: Promise<void> = Promise.resolve();
  const projectPending = () => pendingPuts.reduce(
    (prefs, pending) => mergePrefs(prefs, pending.patch),
    committed,
  );

  async function runPut(pending: PendingPut): Promise<void> {
    let accepted = false;
    let saved: unknown = null;
    try {
      const r = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: pending.body,
      });
      if (r.ok) {
        accepted = true;
        saved = await r.json().catch(() => null);
      }
    } catch { /* network failure — remove this optimistic patch below */ }

    if (accepted) {
      // A successful endpoint normally returns the authoritative snapshot.
      // Preserve the prior optimistic behavior if a 2xx response has no JSON.
      committed = isPrefsSnapshot(saved) ? saved : mergePrefs(committed, pending.patch);
    }
    const index = pendingPuts.indexOf(pending);
    if (index !== -1) pendingPuts.splice(index, 1);
    emit(projectPending());
  }

  return {
    async load() {
      const cached = readCache(cacheKey);
      const gen = generation;
      // refresh in the background — subscribers get the authoritative copy
      doFetch(url).then(async (r) => {
        if (!r.ok || generation !== gen) return;
        const fresh = await r.json().catch(() => null);
        if (generation !== gen) return; // a save() won while we were fetching
        const current = readCache(cacheKey);
        if (
          isPrefsSnapshot(fresh)
          && canRefreshCache(current, fresh)
          && JSON.stringify(fresh) !== JSON.stringify(current)
        ) emit(fresh);
      }).catch(() => { /* offline — cache serves */ });
      return cached;
    },
    async save(patch) {
      generation++;
      if (pendingPuts.length === 0) committed = readCache(cacheKey);
      // deletes must survive JSON transport: undefined → null (RFC 7386 style)
      const wire: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) wire[k] = v === undefined ? null : v;
      const body = JSON.stringify(wire);
      const stablePatch = JSON.parse(body) as Partial<ThumbmuxPrefs>;
      const pending = { patch: stablePatch, body };
      pendingPuts.push(pending);
      const result = putTail.then(() => runPut(pending), () => runPut(pending));
      putTail = result.then(() => {}, () => {});
      emit(projectPending()); // optimistic
      await result;
    },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
