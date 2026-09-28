import type { Readable, Writable } from "node:stream";
import { type TerminalReplayMaterializerOptions, type TerminalReplayResult } from "../terminal-replay-materializer";
/** Wire version for the private parent <-> replay-worker protocol. */
export declare const TERMINAL_REPLAY_WORKER_PROTOCOL_VERSION: 1;
export type TerminalReplayWorkerResultWire = Omit<TerminalReplayResult, "sequence"> & {
    /** Decimal uint64; JSON numbers cannot represent every WAL sequence exactly. */
    sequence: string;
};
export type TerminalReplayWorkerClientOptions = {
    materializer: TerminalReplayMaterializerOptions;
    /** Runtime used to launch the shipped worker. Defaults to process.execPath. */
    runtimePath?: string;
    /** Override for tests/source checkouts. Published builds use the shipped worker. */
    workerPath?: string | URL;
    /** Applies independently to open/current/refresh. Defaults to ten minutes. */
    requestTimeoutMs?: number;
    /** Time to wait for a graceful close before SIGTERM/SIGKILL. */
    shutdownGraceMs?: number;
    /** Hard cap for one worker response, including the rendered screen. */
    maxResponseFrameBytes?: number;
};
export interface TerminalReplayWorkerClient {
    readonly pid: number;
    readonly closed: boolean;
    /** Most recent successful open/current/refresh result, without another IPC hop. */
    readonly lastResult: TerminalReplayResult;
    current(): Promise<TerminalReplayResult>;
    refresh(): Promise<TerminalReplayResult>;
    /** Idempotent. Resolves only after the derived worker process has been reaped. */
    close(): Promise<void>;
}
export declare class TerminalReplayWorkerError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
/** Convert a replay result into its JSON-safe, lossless IPC representation. */
export declare function terminalReplayResultToWire(result: TerminalReplayResult): TerminalReplayWorkerResultWire;
/** Strictly validate and revive a JSON-safe replay result, including bigint. */
export declare function terminalReplayResultFromWire(value: unknown): TerminalReplayResult;
/** Resolve and verify the replay-worker entry shipped beside the server
 * bundle. The TypeScript source candidate keeps Bun source checkouts usable,
 * while a published Node build must resolve the adjacent JavaScript asset. */
export declare function resolveTerminalReplayWorkerPath(value?: string | URL): string;
/**
 * Worker-side stdio loop. stdout is reserved exclusively for framed protocol
 * responses; callers must route diagnostics to stderr.
 */
export declare function runTerminalReplayWorkerStdio(input?: Readable, output?: Writable): Promise<number>;
/**
 * Spawn the shipped replay worker, open one long-lived materializer, and wait
 * for its first verified snapshot. The child remains supervised/referenced;
 * hosts must await `client.close()` during graceful shutdown.
 */
export declare function createTerminalReplayWorkerClient(options: TerminalReplayWorkerClientOptions): Promise<TerminalReplayWorkerClient>;
