/**
 * PreferencesAdapter implementations for browsers:
 *   createLocalPrefs   — localStorage only (the demo / single-device hosts)
 *   createServerPrefs  — server-backed JSON endpoint (@thumbmux/server
 *                        createPrefsHandler) with a localStorage cache so
 *                        first paint never waits on the network and offline
 *                        reads still work; saves are optimistic.
 */
import { type PreferencesAdapter } from '../core/index.js';
export declare function createLocalPrefs(key?: string): PreferencesAdapter;
export declare function createServerPrefs(opts: {
    /** e.g. '/api/prefs' (host mounts @thumbmux/server createPrefsHandler there) */
    url: string;
    cacheKey?: string;
    fetchFn?: typeof fetch;
}): PreferencesAdapter;
