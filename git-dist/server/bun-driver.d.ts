import type { TmuxDriver } from "./ws-mux.js";
export type TmuxTargetMode = "exact" | "legacy";
export type TmuxTargetOptions = {
    /**
     * `exact` (default) prevents tmux from falling through to prefix/fnmatch
     * resolution. `legacy` passes names through unchanged for hosts that
     * deliberately depend on tmux's native target matching.
     */
    targetMode?: TmuxTargetMode;
};
/** Exact target-session syntax. A name beginning with `=` is escaped by the
 * added marker: `=agent` becomes `==agent`. */
export declare function exactTmuxTarget(name: string): string;
/**
 * Exact target-pane/window syntax. Pane operations such as `send-keys` and
 * `capture-pane` reject a bare exact-session target (`=name`), even though
 * `kill-session` accepts it. Keep both the leading `=` and trailing `:`:
 * without `=`, tmux may silently prefix-match a different session.
 */
export declare function exactTmuxPaneTarget(name: string): string;
export declare function createBunTmuxDriver(options?: TmuxTargetOptions): TmuxDriver;
/** Spawn a session (optionally running a command inside a fresh shell). */
export declare function spawnTmuxSession(name: string, cwd: string, command?: string, options?: TmuxTargetOptions): void;
export declare function killTmuxSession(name: string, options?: TmuxTargetOptions): void;
