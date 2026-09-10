/**
 * Custom terminal backgrounds, remembered per mode and per surface key.
 *
 * `ThemeSheet` already lets someone pick a background; what it does not own is
 * where that choice lives between visits. Every host that grew a picker also
 * grew the same four things around it: a JSON blob to persist, a guard for the
 * blob coming back malformed, a hex check before the value reaches the
 * renderer, and the rule that dark and light are separate memories. That last
 * one is the part hosts get wrong — collapsing the two means picking a
 * background in dark mode silently repaints light mode with it.
 *
 * The map is `mode -> key -> hex`. The key is the host's own idea of which
 * surface is being themed (one per agent kind, one per topic, or the single
 * key `'default'` for a host with one terminal) — this module never
 * interprets it, so a host is free to key by anything stable.
 *
 * Every function here is pure and returns a new map: nothing mutates in place,
 * so a store can assign the result and let its own reactivity notice.
 * Persistence and reactivity stay the host's, exactly as with
 * `PreferencesAdapter`.
 */
export type ThemeMode = 'dark' | 'light';
/** Both modes, in the order a UI usually offers them. */
export declare const THEME_MODES: readonly ThemeMode[];
/** Mode -> host-defined surface key -> `#rrggbb`. */
export type ThemeBackgrounds = Record<ThemeMode, Record<string, string>>;
export declare function isThemeMode(value: unknown): value is ThemeMode;
/**
 * The renderable form: a six-digit hex triple, either case.
 *
 * Deliberately narrow. Three-digit hex, `rgb()` and colour names are all
 * things a CSS variable accepts and `deriveSurface` cannot read, so a picker
 * that stored one would persist a value that renders on the chrome and does
 * nothing to the pane — visibly saved, invisibly ignored.
 */
export declare function isThemeBackground(value: unknown): value is string;
/** A map with both modes present and nothing stored. */
export declare function emptyThemeBackgrounds(): ThemeBackgrounds;
/**
 * Read a persisted blob back into a map.
 *
 * Anything unusable — not an object, a mode that is missing, a mode whose
 * value is an array or null, a per-key value that is not a string — yields an
 * empty side rather than throwing. A theme is not worth failing a page load
 * over, and a half-parsed map with one good mode is better than none.
 *
 * Values are kept as strings without a hex check here, and checked on read
 * instead. A blob written by a newer host, or hand-edited, keeps its unknown
 * entries through a load/save round trip instead of being silently pruned by
 * whichever client opened it last.
 */
export declare function parseThemeBackgrounds(raw: unknown): ThemeBackgrounds;
/** Parse a JSON string (e.g. straight out of localStorage). Invalid JSON is empty. */
export declare function parseThemeBackgroundsJson(raw: string | null | undefined): ThemeBackgrounds;
/**
 * The stored background for `mode`/`key`, or null when there is none or the
 * stored value is not renderable.
 */
export declare function readThemeBackground(backgrounds: ThemeBackgrounds, mode: ThemeMode, key: string): string | null;
/**
 * Set (`hex`) or clear (`null`) one background, returning a new map.
 *
 * Only the touched mode is rebuilt, and the other mode's object identity is
 * preserved — a store that memoizes per mode does not invalidate the side
 * nobody changed. A non-renderable hex is rejected as a clear rather than
 * stored: writing it would persist something that cannot come back.
 */
export declare function writeThemeBackground(backgrounds: ThemeBackgrounds, mode: ThemeMode, key: string, hex: string | null): ThemeBackgrounds;
