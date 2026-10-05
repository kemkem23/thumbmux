/**
 * PreferencesAdapter implementations for browsers:
 *   createLocalPrefs   — localStorage only (the demo / single-device hosts)
 *   createServerPrefs  — server-backed JSON endpoint (thumbmux/server
 *                        createPrefsHandler) with a localStorage cache so
 *                        first paint never waits on the network and offline
 *                        reads still work; saves are optimistic.
 *
 * Multiple `createServerPrefs({ url, cacheKey })` calls are independent
 * adapters that happen to share the same localStorage key. A successful GET
 * always notifies *that* adapter's subscribers, even when the cache already
 * holds an equal snapshot (written by a sibling). Hosts that open more than
 * one adapter for the same key (page prefs + a theme side-channel is common)
 * must still see the server value on every subscriber set — otherwise
 * `SessionView` keeps `DEFAULT_FONT_PX` after `load()` returned an empty cache.
 * Prefer a single shared adapter when possible; the emit rule is the safety net.
 */
import { type PreferencesAdapter } from '../core/index.js';
export declare function createLocalPrefs(key?: string): PreferencesAdapter;
export declare function createServerPrefs(opts: {
    /** e.g. '/api/prefs' (host mounts thumbmux/server createPrefsHandler there) */
    url: string;
    cacheKey?: string;
    fetchFn?: typeof fetch;
}): PreferencesAdapter;
