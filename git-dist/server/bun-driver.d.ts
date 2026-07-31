/**
 * Reference TmuxDriver for Bun — talks to a local tmux over its CLI. This is
 * what the demo uses; production hosts usually bring richer drivers (shared
 * activity caches, worktree spawning, memory-scoped launches…) but this one
 * is complete and honest: every TmuxWsMux feature works against it.
 */
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
export declare function createBunTmuxDriver(options?: TmuxTargetOptions): TmuxDriver;
/** Spawn a session (optionally running a command inside a fresh shell). */
export declare function spawnTmuxSession(name: string, cwd: string, command?: string, options?: TmuxTargetOptions): void;
export declare function killTmuxSession(name: string, options?: TmuxTargetOptions): void;
