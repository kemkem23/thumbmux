import { type ChildProcess } from "node:child_process";
import { type TerminalGeometry, type TerminalWalPtyIdentity } from "./terminal-wal";
export declare const TERMINAL_PTY_WAL_CONFIG_ENV = "THUMBMUX_TERMINAL_PTY_WAL_CONFIG";
export declare const TERMINAL_PTY_WAL_HEALTH_FILE = "pty-proxy-status.json";
export declare const TERMINAL_PTY_WAL_DIAGNOSTIC_FILE = "pty-proxy-diagnostics.log";
export type TerminalPtyWalProxyTmuxOptions = {
    executable?: string;
    socketName?: string;
    socketPath?: string;
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
export declare function parseTerminalPtyWalProxyConfig(value: unknown): NormalizedTerminalPtyWalProxyConfig;
export declare function parseTerminalPtyWalProxyConfigJson(json: string): NormalizedTerminalPtyWalProxyConfig;
/** Resolve the shipped Python helper from either source or the bundled dist entry. */
export declare function resolveTerminalPtyWalProxyScriptPath(): string;
export declare function createTerminalPtyWalProxyLaunchSpec(value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig, baseEnvironment?: NodeJS.ProcessEnv): TerminalPtyWalProxyLaunchSpec;
/** Launch as a foreground pane process; stdout/stderr must remain the outer PTY. */
export declare function spawnTerminalPtyWalProxy(value: TerminalPtyWalProxyConfig | NormalizedTerminalPtyWalProxyConfig): ChildProcess;
export declare function terminalPtyWalProxyHealthPath(directory: string): string;
export declare function readTerminalPtyWalProxyHealth(directory: string): TerminalPtyWalProxyHealth;
