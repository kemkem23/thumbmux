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
 * `kill-session` accepts it. Pin window 0, pane 0 as well as the exact session;
 * a trailing `:` alone still lets tmux choose the current window/pane.
 */
export declare function exactTmuxPaneTarget(name: string): string;
/** Latest completed observation, driven by the caller's existing poll cadence.
 * Cancellation releases waiters immediately and fences completions from an old
 * lifecycle even when the underlying runner ignores AbortSignal. */
export declare function createActivityPoll<T>(empty: () => T, sample: (signal: AbortSignal) => Promise<T>): {
    peek: () => T;
    status: () => {
        pending: boolean;
        stopped: boolean;
        error: string | null;
        ageMs: number | null;
    };
    settled: () => Promise<void>;
    refresh(): void;
    cancel: () => void;
    invalidate(): void;
    stop(): void;
    resume(): void;
};
/** Drain both pipes concurrently; abort/timeout kill and release the poll even
 * if a child never closes a pipe. Same 5 s budget as host pane captures. */
export declare function readActivityProcess(process: {
    stdout: ReadableStream;
    stderr: ReadableStream;
    exited: Promise<number>;
    kill(signal?: number): unknown;
}, signal: AbortSignal): Promise<string>;
export type BunTmuxDriver = TmuxDriver & {
    activityPoll: ReturnType<typeof createActivityPoll<Map<string, number>>>;
};
export declare function createBunTmuxDriver(options?: TmuxTargetOptions): BunTmuxDriver;
/** Spawn a session (optionally running a command inside a fresh shell). */
export declare function spawnTmuxSession(name: string, cwd: string, command?: string, options?: TmuxTargetOptions): void;
export declare function killTmuxSession(name: string, options?: TmuxTargetOptions): void;
