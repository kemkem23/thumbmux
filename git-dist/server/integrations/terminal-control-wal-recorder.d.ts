import { type Readable, type Writable } from "node:stream";
import { type NormalizedTerminalWalWorkerConfig, type TerminalWalWorkerConfig } from "./terminal-wal-worker.js";
import { type TerminalGeometry } from "./terminal-wal.js";
export declare const TERMINAL_CONTROL_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_CONTROL_WAL_CONFIG";
export declare const TERMINAL_CONTROL_WAL_STATUS_FILE = "recorder-status.json";
export type TerminalControlTmuxOptions = {
    executable?: string;
    socketName?: string;
    socketPath?: string;
};
export type TerminalControlWalRecorderConfig = {
    worker: TerminalWalWorkerConfig;
    tmux?: TerminalControlTmuxOptions;
    readyTimeoutMs?: number;
    maxPreReadyEventBytes?: number;
    maxControlLineBytes?: number;
};
export type NormalizedTerminalControlWalRecorderConfig = {
    worker: NormalizedTerminalWalWorkerConfig;
    tmux: Required<Pick<TerminalControlTmuxOptions, "executable">> & Pick<TerminalControlTmuxOptions, "socketName" | "socketPath">;
    readyTimeoutMs: number;
    maxPreReadyEventBytes: number;
    maxControlLineBytes: number;
};
export type TerminalControlSourceIdentity = {
    session: string;
    sessionId: string;
    windowId: string;
    paneId: string;
    paneTarget: string;
    tmuxServerPid: number;
    sessionCreated: number;
    geometry: TerminalGeometry;
};
export type TerminalControlProcess = {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};
export type TerminalControlWalRecorderDependencies = {
    spawnControl?: (executable: string, args: string[]) => TerminalControlProcess;
    resolveIdentity?: (config: NormalizedTerminalControlWalRecorderConfig) => Promise<TerminalControlSourceIdentity>;
    onFatal?: (error: Error) => void;
};
export type TerminalControlWalRecorderStatus = {
    state: "created" | "attaching" | "validating" | "ready" | "end-armed" | "exiting" | "disconnected" | "fatal";
    source: TerminalControlSourceIdentity | null;
    pendingEventBytes: number;
    bufferedControlBytes: number;
    fatalMessage: string | null;
};
export type TerminalControlWalHealth = {
    version: 1;
    state: "attaching" | "ready" | "end-armed" | "disconnected" | "fatal";
    pid: number;
    source: TerminalControlSourceIdentity | null;
    updatedAt: number;
    error?: string;
};
export declare function parseTerminalControlWalRecorderConfig(value: unknown): NormalizedTerminalControlWalRecorderConfig;
export declare function parseTerminalControlWalRecorderConfigJson(json: string): NormalizedTerminalControlWalRecorderConfig;
export declare function resolveTerminalControlSourceIdentity(config: NormalizedTerminalControlWalRecorderConfig): Promise<TerminalControlSourceIdentity>;
export declare function terminalControlWalStatusPath(directory: string): string;
export declare function readTerminalControlWalHealth(directory: string): TerminalControlWalHealth | null;
/**
 * Ordered tmux control-mode capture lane.
 *
 * stdout is consumed one complete notification at a time. WAL writes are
 * synchronous+durable, so a layout PREPARE/COMMIT finishes before the next
 * output notification is removed from the stream buffer.
 */
export declare class TerminalControlWalRecorder {
    readonly config: NormalizedTerminalControlWalRecorderConfig;
    private readonly dependencies;
    private readonly input;
    private readonly worker;
    private readonly stream;
    private process;
    private state;
    private source;
    private fatalError;
    private attachCommandDone;
    private commandBlock;
    private sessionChanged;
    private validationStarted;
    private pendingEvents;
    private pendingEventBytes;
    private layoutCounter;
    private endOnSourceExit;
    private stderr;
    private readyTimer;
    private readySettled;
    private readonly readyPromise;
    private resolveReady;
    private rejectReady;
    constructor(config: TerminalControlWalRecorderConfig | NormalizedTerminalControlWalRecorderConfig, dependencies?: TerminalControlWalRecorderDependencies);
    get status(): TerminalControlWalRecorderStatus;
    start(): Promise<void>;
    /** Disconnect this source client; the logical terminal remains resumable. */
    stop(): Promise<void>;
    /**
     * Arm an ordered END. Capture continues until tmux itself emits %exit; only
     * then is END appended after every preceding notification is durable.
     */
    armLogicalEndOnSourceExit(): void;
    /** Cancel a previously armed END when the host could not stop tmux. */
    cancelLogicalEndOnSourceExit(): void;
    /**
     * Close an already disconnected source's logical lifecycle. Active capture
     * must use armLogicalEndOnSourceExit so unread pipe bytes cannot be skipped.
     */
    closeLogicalLifecycle(): Promise<void>;
    /** Explicit teardown kills only this read-only client, never the tmux session. */
    private teardown;
    private readonly handleStdout;
    private readonly handleStdoutEnd;
    private readonly handleStderr;
    private handleLine;
    private maybeBeginValidation;
    private enqueueOrApply;
    private applyEvent;
    private continuePane;
    private finishFromExit;
    private fail;
    private clearReadyTimer;
    private shouldStopReading;
    private writeHealth;
}
export type TerminalControlWalLifecycleSignal = "SIGTERM" | "SIGINT" | "SIGUSR1" | "SIGUSR2";
export type TerminalControlWalSignalTarget = {
    once(signal: TerminalControlWalLifecycleSignal, listener: () => void): unknown;
    on(signal: TerminalControlWalLifecycleSignal, listener: () => void): unknown;
};
export type TerminalControlWalSignalRecorder = Pick<TerminalControlWalRecorder, "stop" | "armLogicalEndOnSourceExit" | "cancelLogicalEndOnSourceExit">;
/**
 * Standalone-runner signal contract:
 * SIGTERM/SIGINT detach a source epoch. SIGUSR2 arms END-on-%exit without
 * pausing capture; SIGUSR1 cancels that arm if the host cannot stop tmux.
 */
export declare function installTerminalControlWalSignalHandlers(recorder: TerminalControlWalSignalRecorder, options?: {
    target?: TerminalControlWalSignalTarget;
    onError?: (error: Error) => void;
}): void;
export declare function runTerminalControlWalRecorderFromEnvironment(): Promise<TerminalControlWalRecorder>;
