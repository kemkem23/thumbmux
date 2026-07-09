/**
 * Reference TmuxDriver for Bun — talks to a local tmux over its CLI. This is
 * what the demo uses; production hosts usually bring richer drivers (shared
 * activity caches, worktree spawning, memory-scoped launches…) but this one
 * is complete and honest: every TmuxWsMux feature works against it.
 */
import type { TmuxDriver } from "./ws-mux";
export declare function createBunTmuxDriver(): TmuxDriver;
/** Spawn a session (optionally running a command inside a fresh shell). */
export declare function spawnTmuxSession(name: string, cwd: string, command?: string): void;
export declare function killTmuxSession(name: string): void;
