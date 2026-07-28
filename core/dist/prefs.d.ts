/**
 * Preferences — one typed bag for everything a viewer wants remembered
 * (theme, font size, shortcuts, per-session notes…), behind an adapter so
 * the HOST decides where it lives: localStorage on a laptop, a JSON file on
 * a server (see @thumbmux/server createPrefsHandler), a database, anything.
 * Save semantics are MERGE-PATCH: pass only the keys you changed.
 */
export type Shortcut = {
    id: string;
    /** chip text, e.g. "continue" or "ไปต่อ" */
    label: string;
    /** text sent to the pane when tapped */
    send: string;
    /** also send Enter after the text (default true) */
    submit?: boolean;
    /** restrict to one agent kind (host-defined string, matched against
     * ShortcutBar's `agent` prop); absent = show everywhere */
    agent?: string;
};
export type ThumbmuxPrefs = {
    theme?: {
        bg?: string;
        mode?: 'dark' | 'light';
    };
    fontPx?: number;
    shortcuts?: Shortcut[];
    /** host-defined extras ride along untouched */
    [key: string]: unknown;
};
export interface PreferencesAdapter {
    /** full prefs (or {} when nothing saved yet) */
    load(): Promise<ThumbmuxPrefs>;
    /** merge-patch: only the given top-level keys are replaced */
    save(patch: Partial<ThumbmuxPrefs>): Promise<void>;
    /** optional change feed (server-backed hosts can push cross-device) */
    subscribe?(cb: (prefs: ThumbmuxPrefs) => void): () => void;
}
/** Shallow merge-patch used by every adapter: top-level keys replace,
 * explicit undefined OR null deletes (RFC 7386 style — use null over JSON
 * transport, where undefined does not survive stringify). */
export declare function mergePrefs(base: ThumbmuxPrefs, patch: Partial<ThumbmuxPrefs>): ThumbmuxPrefs;
export declare const DEFAULT_SHORTCUTS: Shortcut[];
