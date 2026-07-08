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

  return {
    async load() {
      const cached = readCache(cacheKey);
      const gen = generation;
      // refresh in the background — subscribers get the authoritative copy
      doFetch(url).then(async (r) => {
        if (!r.ok || generation !== gen) return;
        const fresh = await r.json().catch(() => null);
        if (generation !== gen) return; // a save() won while we were fetching
        if (fresh && typeof fresh === 'object' && JSON.stringify(fresh) !== JSON.stringify(readCache(cacheKey))) emit(fresh);
      }).catch(() => { /* offline — cache serves */ });
      return cached;
    },
    async save(patch) {
      generation++;
      emit(mergePrefs(readCache(cacheKey), patch)); // optimistic
      // deletes must survive JSON transport: undefined → null (RFC 7386 style)
      const wire: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) wire[k] = v === undefined ? null : v;
      const gen = generation;
      try {
        const r = await doFetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(wire),
        });
        if (r.ok && generation === gen) {
          const saved = await r.json().catch(() => null);
          if (saved && typeof saved === 'object' && generation === gen) emit(saved);
        }
      } catch { /* offline — optimistic local copy stands until next sync */ }
    },
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
