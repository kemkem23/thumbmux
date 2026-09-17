export declare const TERMINAL_WAL_PROTOCOL_VERSION: 1;
export declare const TERMINAL_WAL_FILE_NAME = "output.wal";
export declare const TERMINAL_WAL_SOCKET_NAME = "control.sock";
export declare const TERMINAL_WAL_LOCK_NAME = "writer.lock";
export type TerminalGeometry = {
    cols: number;
    rows: number;
};
export type TerminalWalIdentity = {
    session: string;
    instanceId: string;
    paneTarget: string;
    tmuxServerPid: number;
    sessionCreated: number;
    /** Physical tmux source identity. Present together on direct PTY epochs. */
    sessionId?: string;
    windowId?: string;
    paneId?: string;
    /** Random, process-unique source generation. Present on direct PTY epochs. */
    generation?: string;
};
export type TerminalWalPtyIdentity = TerminalWalIdentity & {
    sessionId: string;
    windowId: string;
    paneId: string;
    generation: string;
};
export type TerminalWalLifecycleRecord = {
    event: "start" | "resume" | "end";
    identity: TerminalWalIdentity;
    geometry: TerminalGeometry;
};
export type TerminalWalResizeRecord = {
    phase: "prepare" | "commit" | "abort";
    changeId: string;
    from: TerminalGeometry;
    to: TerminalGeometry;
    reason?: string;
};
export type TerminalWalCheckpointRecord = {
    event: "barrier";
    requestId: string;
};
export type TerminalWalPaths = {
    directory: string;
    walPath: string;
    socketPath: string;
    lockPath: string;
};
export type TerminalWalControlRequest = {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    command: "ACTIVATE";
    generation: string;
} | {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    command: "BARRIER";
} | {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    command: "END";
} | {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    command: "RESIZE_PREPARE";
    changeId: string;
    from: TerminalGeometry;
    to: TerminalGeometry;
    reason?: string;
} | {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    command: "RESIZE_COMMIT" | "RESIZE_ABORT";
    changeId: string;
};
export type TerminalWalAck = {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    status: "ack";
    sequence: string;
    nextOffset: number;
    /** Present for direct PTY proxy epochs; older pipe workers omit it. */
    generation?: string;
};
export type TerminalWalControlError = {
    protocol: typeof TERMINAL_WAL_PROTOCOL_VERSION;
    requestId: string;
    status: "error";
    code: string;
    message: string;
};
export type TerminalWalControlResponse = TerminalWalAck | TerminalWalControlError;
export type TmuxControlWalEvent = {
    kind: "output";
    paneId: string;
    bytes: Uint8Array;
    extended: false;
} | {
    kind: "output";
    paneId: string;
    bytes: Uint8Array;
    extended: true;
    ageMs: number;
    futureArgs: string[];
} | {
    kind: "layout-change";
    windowId: string;
    paneId: string;
    geometry: TerminalGeometry;
    windowLayout: string;
    visibleLayout: string;
    windowFlags: string;
};
export type TerminalWalControllerOptions = {
    directory: string;
    requestTimeoutMs?: number;
    maxControlFrameBytes?: number;
};
export declare function parseTerminalGeometry(value: unknown, label?: string): TerminalGeometry;
export declare function parseTerminalWalIdentity(value: unknown): TerminalWalIdentity;
export declare function parseTerminalWalSafeId(value: unknown, label: string): string;
export declare function parseTerminalWalReason(value: unknown): string | undefined;
export declare function resolveTerminalWalPaths(directory: string): TerminalWalPaths;
export declare function parseTerminalWalControlRequest(value: unknown): TerminalWalControlRequest;
export type TmuxControlWalTarget = {
    paneId: string;
    windowId?: string;
};
/** Byte-safe form: ASCII headers are parsed separately from raw UTF-8 payload. */
export declare function parseTmuxControlWalBytesLine(line: Uint8Array, target?: TmuxControlWalTarget): TmuxControlWalEvent;
/**
 * Parse only the ordered tmux control-mode notifications that are safe inputs
 * to the terminal WAL. Unknown and malformed lines fail closed deliberately.
 */
export declare function parseTmuxControlWalLine(line: string): TmuxControlWalEvent;
/**
 * Serialized client for the worker's private Unix control socket.
 *
 * Only one command is in flight. This is intentional: a resize is a WAL
 * transaction boundary, not a collection of independently reorderable RPCs.
 */
export declare class TerminalWalController {
    readonly paths: TerminalWalPaths;
    private readonly requestTimeoutMs;
    private readonly maxControlFrameBytes;
    private readonly idPrefix;
    private nextRequest;
    private socket;
    private responseBuffer;
    private pending;
    private requestTail;
    constructor(options: TerminalWalControllerOptions);
    get connected(): boolean;
    connect(): Promise<void>;
    barrier(requestId?: string): Promise<TerminalWalAck>;
    /** Release a direct PTY child only after the host has published its T0. */
    activate(generation: string, requestId?: string): Promise<TerminalWalAck>;
    /**
     * Irreversibly end a logical terminal. A direct PTY proxy acknowledges only
     * after the child is stopped, terminated, drained through PTY EOF and the
     * lifecycle END record is durable.
     */
    endLogicalLifecycle(requestId?: string): Promise<TerminalWalAck>;
    prepareResize(options: {
        changeId: string;
        from: TerminalGeometry;
        to: TerminalGeometry;
        reason?: string;
        requestId?: string;
    }): Promise<TerminalWalAck>;
    commitResize(changeId: string, requestId?: string): Promise<TerminalWalAck>;
    abortResize(changeId: string, requestId?: string): Promise<TerminalWalAck>;
    close(): void;
    private makeRequestId;
    private enqueue;
    private send;
    private receive;
    private failPending;
}
