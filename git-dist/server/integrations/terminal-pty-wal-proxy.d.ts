import { type ChildProcess } from "node:child_process";
import { type TerminalGeometry, type TerminalWalPtyIdentity } from "./terminal-wal.js";
export declare const TERMINAL_PTY_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG";
export declare const TERMINAL_PTY_WAL_PROXY_ASSET_SHA256_ENV = "THUMBMUX_TERMINAL_PROXY_ASSET_SHA256";
export declare const TERMINAL_PTY_WAL_HEALTH_FILE = "pty-proxy-status.json";
export declare const TERMINAL_PTY_WAL_DIAGNOSTIC_FILE = "pty-proxy-diagnostics.log";
export declare const PIPEHIST_HEALTH_V1_FILE = "pipehist-health-v1.json";
export type TerminalPtyWalProxyTmuxOptions = {
    executable?: string;
    socketName?: string;
    socketPath?: string;
};
export type PipehistIdentityV1 = {
    session: string;
    instanceId: string;
    provider: "claude" | "codex" | "grok";
    conversationId: string;
    cwd: string;
    laneKey: string;
};
export type PipehistProcessV1 = {
    bootId: string;
    pid: number;
    startTicks: string;
};
export type PipehistBoundaryV1 = {
    walSequence: string;
    walNextOffset: number;
    walPrefixSha256: string;
    outputBytes: string;
    v3Lines: number;
};
export type PipehistPhysicalV1 = {
    server: PipehistProcessV1;
    socketPath: string;
    sessionId: string;
    sessionCreated: number;
    windowId: string;
    paneId: string;
    paneTarget: string;
    proxy: PipehistProcessV1;
    generation: string;
};
export type PipehistEpochV1 = {
    schema: "pipehist.c.v1/epoch";
    epochId: string;
    ordinal: number;
    previousEpochId: string | null;
    identity: PipehistIdentityV1;
    physical: PipehistPhysicalV1;
    state: "opening" | "open" | "closing" | "clean" | "unclean" | "unknown";
    opened: PipehistBoundaryV1 | null;
    closed: PipehistBoundaryV1 | null;
    uncleanPredecessor: {
        epochId: string;
        marker: PipehistBoundaryV1 | null;
    } | null;
};
export type PipehistHealthV1 = {
    schema: "pipehist.c.v1/health";
    identity: PipehistIdentityV1;
    sourceKind: "direct-pty-proxy";
    epoch: PipehistEpochV1 | null;
    observed: {
        bootId: string;
        monoNs: string;
        utc: string;
        sample: string;
    };
    state: "starting" | "ready" | "blocked" | "ended" | "fatal" | "unknown";
    reason: "none" | "sync-pending" | "storage-error" | "source-lost" | "unclean-epoch" | "identity-mismatch" | "stale" | "unreadable" | "replay-lag";
    proxy: PipehistProcessV1 | null;
    progress: {
        receivedOutputBytes: string;
        durableOutputBytes: string;
        displayedOutputBytes: string;
        walSequence: string;
        walNextOffset: number;
        replaySequence: string;
        replayNextOffset: number;
        pendingOutputBytes: number;
    } | null;
    error: string | null;
};
export type PipehistProxyConfigV1 = {
    schema: "pipehist.c.v1/proxy-config";
    identity: PipehistIdentityV1;
    replay: {
        checkpointPath: string;
        historyPath: string;
    } | null;
};
export type TerminalPtyWalProxyConfig = {
    directory: string;
    identity: {
        session: string;
        instanceId: string;
        paneTarget: string;
    };
    argv: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    tmux?: TerminalPtyWalProxyTmuxOptions;
    pythonExecutable?: string;
    maxOutputRecordBytes?: number;
    maxPendingInputBytes?: number;
    heartbeatMs?: number;
    terminateGraceMs?: number;
    pipehist?: PipehistProxyConfigV1;
};
export type NormalizedTerminalPtyWalProxyConfig = {
    directory: string;
    identity: TerminalPtyWalProxyConfig["identity"];
    argv: string[];
    cwd?: string;
    env: Record<string, string>;
    tmux: {
        executable: string;
        socketName?: string;
        socketPath?: string;
    };
    pythonExecutable: string;
    maxOutputRecordBytes: number;
    maxPendingInputBytes: number;
    heartbeatMs: number;
    terminateGraceMs: number;
    pipehist?: PipehistProxyConfigV1;
};
export type TerminalPtyWalProxyHealth = {
    version: 1;
    state: "starting" | "armed" | "ready" | "resizing" | "ending" | "disconnected" | "ended" | "fatal";
    generation: string;
    pid: number;
    pidStartTicks: string;
    childPid: number | null;
    foregroundPid: number | null;
    foregroundPidStartTicks: string | null;
    foregroundCommand: string | null;
    source: TerminalWalPtyIdentity | null;
    geometry: TerminalGeometry | null;
    updatedAt: number;
    heartbeatAt: number;
    walSequence: string;
    walNextOffset: number;
    deliveredSequence: string;
    deliveredNextOffset: number;
    childExitCode?: number;
    error?: string;
};
export type TerminalPtyWalProxyLaunchSpec = {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
};
export declare function parsePipehistHealthV1(value: unknown): PipehistHealthV1;
export declare function parseTerminalPtyWalProxyConfig(value: unknown): NormalizedTerminalPtyWalProxyConfig;
export declare function parseTerminalPtyWalProxyConfigJson(json: string): NormalizedTerminalPtyWalProxyConfig;
/** Resolve the shipped Python helper from either source or the bundled dist entry. */
export declare function resolveTerminalPtyWalProxyScriptPath(): string;
export declare function createTerminalPtyWalProxyLaunchSpec(value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig, baseEnvironment?: NodeJS.ProcessEnv): TerminalPtyWalProxyLaunchSpec;
/** Launch as a foreground pane process; stdout/stderr must remain the outer PTY. */
export declare function spawnTerminalPtyWalProxy(value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig): ChildProcess;
export declare function terminalPtyWalProxyHealthPath(directory: string): string;
export declare function pipehistHealthV1Path(directory: string): string;
export declare function readPipehistHealthV1(directory: string): PipehistHealthV1;
export declare function readTerminalPtyWalProxyHealth(directory: string): TerminalPtyWalProxyHealth;
