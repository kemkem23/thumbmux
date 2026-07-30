import { type LaunchPreset, type LaunchSpec } from "@thumbmux/core";
import type { TmuxDriver } from "./ws-mux";
type MaybePromise<T> = T | Promise<T>;
/** LaunchSheet fields plus the host-owned session placement fields. */
export type SpawnPayload = Partial<LaunchSpec> & {
    /** Exact requested tmux name. Omit to let the handler allocate one. */
    name?: string;
    /** Cwd override. Omit to use the handler's configured/default cwd. */
    cwd?: string;
    /** On an explicit-name collision, append a numeric suffix instead of 409. */
    autoName?: boolean;
};
export type SpawnNameContext = {
    payload: SpawnPayload;
    existing: ReadonlySet<string>;
};
export type SpawnWorktreeContext = {
    name: string;
    cwd: string;
    payload: SpawnPayload;
};
export type SpawnWorktreeCleanupContext = SpawnWorktreeContext & {
    worktreeCwd: string;
    cause: unknown;
};
export type SpawnHandlerOptions = {
    /** Session inventory used for collision checks. Defaults to the Bun driver. */
    driver?: Pick<TmuxDriver, "listSessions">;
    /** Static fallback cwd, or an authoritative host resolver. Defaults to process.cwd(). */
    cwd?: string | ((payload: SpawnPayload) => MaybePromise<string>);
    /** Server-authoritative presets. Defaults to DEFAULT_LAUNCH_PRESETS. */
    presets?: readonly LaunchPreset[];
    /** Prefix for the default allocator (prefix-1, prefix-2, ...). */
    namePrefix?: string;
    /** Host allocator used when the payload omits name. */
    generateName?: (context: SpawnNameContext) => MaybePromise<string>;
    /** Optional allowed-root/policy check after the path is resolved and statted. */
    validateCwd?: (cwd: string, payload: SpawnPayload) => MaybePromise<boolean | string | void>;
    /**
     * Opt-in worktree creator. It must create/resolve the worktree and return its
     * cwd; thumbmux never assumes git or runs `git worktree` itself.
     */
    prepareWorktree?: (context: SpawnWorktreeContext) => MaybePromise<string>;
    /**
     * Required alongside prepareWorktree. Rolls back its returned path after
     * final-cwd validation or spawning fails, before any auto-name retry.
     */
    cleanupWorktree?: (context: SpawnWorktreeCleanupContext) => MaybePromise<void>;
    /** Spawn implementation; defaults to spawnTmuxSession. Useful for adapters/tests. */
    spawn?: (name: string, cwd: string, command?: string) => MaybePromise<void>;
};
/** A hook can throw this to preserve a deliberate HTTP error status. */
export declare class SpawnHandlerError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare function createSpawnHandler(opts?: SpawnHandlerOptions): (req: Request) => Promise<Response>;
export {};
