import type { Readable } from "node:stream";
import { type OutputWalRecord } from "../output-wal.js";
import { type TerminalGeometry, type TerminalWalIdentity, type TerminalWalPaths } from "./terminal-wal.js";
export declare const TERMINAL_WAL_WORKER_CONFIG_ENV = "THUMBMUX_TERMINAL_WAL_CONFIG";
export type TerminalWalWorkerConfig = {
    directory: string;
    identity: TerminalWalIdentity;
    geometry: TerminalGeometry;
    maxBufferedOutputBytes?: number;
    maxOutputRecordBytes?: number;
    maxControlFrameBytes?: number;
};
export type NormalizedTerminalWalWorkerConfig = {
    paths: TerminalWalPaths;
    identity: TerminalWalIdentity;
    geometry: TerminalGeometry;
    maxBufferedOutputBytes: number;
    maxOutputRecordBytes: number;
    maxControlFrameBytes: number;
};
export type TerminalWalWorkerDependencies = {
    input?: Readable;
    clock?: () => number;
    onFatal?: (error: Error) => void;
};
export type TerminalWalWorkerStatus = {
    started: boolean;
    failed: boolean;
    geometry: TerminalGeometry;
    pendingChangeId: string | null;
    bufferedOutputBytes: number;
    inputBackpressured: boolean;
    controlConnected: boolean;
};
export declare function parseTerminalWalWorkerConfig(value: unknown): NormalizedTerminalWalWorkerConfig;
export declare function parseTerminalWalWorkerConfigJson(json: string): NormalizedTerminalWalWorkerConfig;
/**
 * Sole owner of one terminal output WAL.
 *
 * stdin stays in paused/readable mode. During a prepared resize the worker
 * reads only up to the configured memory bound, then leaves the rest in the
 * stream/kernel pipe so normal OS backpressure applies instead of dropping it.
 */
export declare class TerminalWalWorker {
    readonly config: NormalizedTerminalWalWorkerConfig;
    private readonly input;
    private readonly clock;
    private readonly onFatal;
    private server;
    private socketBound;
    private writer;
    private lockContents;
    private activeControl;
    private controlBuffer;
    private geometry;
    private pendingResize;
    private bufferedOutput;
    private bufferedOutputBytes;
    private inputBackpressured;
    private started;
    private stopping;
    private fatalError;
    constructor(config: TerminalWalWorkerConfig | NormalizedTerminalWalWorkerConfig, dependencies?: TerminalWalWorkerDependencies);
    get paths(): TerminalWalPaths;
    get status(): TerminalWalWorkerStatus;
    start(): Promise<void>;
    /** Disconnect this source epoch without ending the logical terminal. */
    stop(options?: {
        writeLifecycleEnd?: boolean;
    }): Promise<void>;
    /** Explicit, irreversible lifecycle close. Use only when the logical instance ended. */
    closeLogicalLifecycle(): Promise<void>;
    /**
     * Synchronous ordered-source ingress. A tmux control-mode recorder uses this
     * instead of stdin so layout and output notifications keep one total order.
     */
    appendOrderedOutput(payload: Uint8Array): OutputWalRecord[];
    /** Record an observed ordered layout boundary before consuming its redraw. */
    recordOrderedResize(toValue: TerminalGeometry, changeIdValue: string, reasonValue?: string): {
        prepare: OutputWalRecord;
        commit: OutputWalRecord;
    };
    private readonly handleInputReadable;
    private readonly handleInputError;
    private drainInput;
    private flushBufferedOutput;
    private acceptControl;
    private receiveControl;
    private handleControlFrame;
    private applyControl;
    private sendControlError;
    private requireWriter;
    private fail;
    private stopInternal;
    private cleanupAfterFailedStart;
    private closeServer;
    private removeSocketIfOwned;
}
/** Run the standalone stdin/socket worker used by a future tmux pipe command. */
export declare function runTerminalWalWorkerFromEnvironment(): Promise<TerminalWalWorker>;
