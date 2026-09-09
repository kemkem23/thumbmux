export type TerminalReplayGeometry = {
    cols: number;
    rows: number;
};
export type TerminalReplayIdentity = {
    session: string;
    instanceId: string;
    paneTarget: string;
    tmuxServerPid: number;
    sessionCreated: number;
    /** Optional physical PTY epoch identity emitted by newer recorders. */
    sessionId?: string;
    windowId?: string;
    paneId?: string;
    generation?: string;
};
export type TerminalReplayLifecycle = {
    event: "start" | "resume" | "end";
    identity: TerminalReplayIdentity;
    geometry: TerminalReplayGeometry;
};
export type TerminalReplayResize = {
    phase: "prepare" | "commit" | "abort";
    changeId: string;
    from: TerminalReplayGeometry;
    to: TerminalReplayGeometry;
    reason?: string;
};
export type TerminalReplayBarrier = {
    event: "barrier";
    requestId: string;
};
export type TerminalReplayScreen = {
    cols: number;
    rows: number;
    cursorX: number;
    cursorY: number;
    cursorVisible: boolean;
    alternateOn: boolean;
    mouseSgr: boolean;
    mouseAny: boolean;
    /** `capture-pane -e -N`, including one LF record terminator per row. */
    cellsBase64: string;
    /** Bytes held by tmux/chunker at an incomplete escape sequence or UTF-8 code point. */
    pendingEscapeBase64: string;
};
export type TerminalReplayCheckpoint = {
    version: 1;
    walPath: string;
    cursor: {
        walOffset: number;
        sequence: string;
    };
    historyBytes: number;
    lifecycle: "none" | "active" | "ended";
    identity: TerminalReplayIdentity | null;
    geometry: TerminalReplayGeometry | null;
    pendingResize: TerminalReplayResize | null;
    screen: TerminalReplayScreen | null;
};
export type TerminalReplayMaterializerOptions = {
    walPath: string;
    stateDir: string;
    /** Defaults to `<stateDir>/history.ansi`. */
    historyPath?: string;
    /** Defaults to `<stateDir>/checkpoint.json`. */
    checkpointPath?: string;
    tmuxCommand?: string;
    /** Tests/hosts may supply a fresh absolute socket path. It must not exist. */
    socketPath?: string;
    replayChunkBytes?: number;
    historyCaptureRows?: number;
    historyLimit?: number;
    commandTimeoutMs?: number;
    /**
     * Preferred raw-WAL frame budget for open/refresh. Defaults to 1 MiB.
     * A single complete WAL record larger than this is accepted to guarantee
     * progress; producers should therefore keep output records independently
     * bounded (the shipped PTY proxy caps them at 64 KiB).
     */
    maxWalFrameBytesPerRefresh?: number;
    /** Optional independently durable cursor that recovery must expose exactly
     * before consuming any later WAL suffix. Decimal uint64 + record-end offset. */
    recoverySequence?: string;
    recoveryWalOffset?: number;
};
export type TerminalReplayResult = {
    complete: boolean;
    verified: boolean;
    recoveredFromCheckpoint: boolean;
    ended: boolean;
    walOffset: number;
    sequence: bigint;
    /** More complete WAL records were visible after this bounded checkpoint. */
    hasMoreWal: boolean;
    historyBytes: number;
    identity: TerminalReplayIdentity | null;
    geometry: TerminalReplayGeometry | null;
    pendingResize: TerminalReplayResize | null;
    screen: TerminalReplayScreen | null;
    historyPath: string;
    checkpointPath: string;
};
export declare function readTerminalReplayCheckpoint(path: string): TerminalReplayCheckpoint | null;
export declare class TerminalReplayMaterializer {
    readonly walPath: string;
    readonly stateDir: string;
    readonly historyPath: string;
    readonly checkpointPath: string;
    private readonly tmuxCommand;
    private readonly socketPath;
    private readonly replayChunkBytes;
    private readonly historyCaptureRows;
    private readonly historyLimit;
    private readonly commandTimeoutMs;
    private readonly maxWalFrameBytesPerRefresh;
    private readonly recoveryTarget;
    constructor(options: TerminalReplayMaterializerOptions);
    /**
     * Open a long-lived incremental materializer.  Recovery replays the committed
     * prefix once; each later `refresh()` keeps the same private tmux/VT state and
     * applies only records after the durable cursor.
     */
    open(): TerminalReplaySession;
    /** One-shot convenience for repair jobs and tests. Hosts should use open(). */
    materialize(): TerminalReplayResult;
}
type TerminalReplaySessionOptions = {
    walPath: string;
    stateDir: string;
    historyPath: string;
    checkpointPath: string;
    tmuxCommand: string;
    socketPath?: string;
    replayChunkBytes: number;
    historyCaptureRows: number;
    historyLimit: number;
    commandTimeoutMs: number;
    maxWalFrameBytesPerRefresh: number;
    recoveryTarget: {
        sequence: bigint;
        walOffset: number;
    } | null;
};
export declare class TerminalReplaySession {
    private readonly walPath;
    private readonly historyPath;
    private readonly checkpointPath;
    private readonly writerLease;
    private readonly recoveredFromCheckpoint;
    private readonly maxWalFrameBytesPerRefresh;
    private recoveryTarget;
    private readonly history;
    private readonly tmux;
    private readonly engine;
    private lastOffset;
    private lastSequence;
    private lastAt;
    private tailCursor;
    private hasMoreWal;
    private closed;
    private result;
    /** @internal Construct via TerminalReplayMaterializer.open(). */
    constructor(options: TerminalReplaySessionOptions);
    private commitCheckpoint;
    get current(): TerminalReplayResult;
    /** Diagnostic path proving this session remains on its isolated tmux server. */
    get privateSocketPath(): string;
    /** @internal Test/diagnostic proof that the raw fence is truncated per batch. */
    get privateMirrorPath(): string;
    /** @internal Largest observed on-disk completion-fence size. */
    get privatePeakMirrorBytes(): number;
    private peekTailHasMore;
    private consumeTail;
    /**
     * Consume at most one bounded, record-aligned WAL suffix batch. The private
     * tmux stays alive, so normal service operation never replays the committed
     * prefix. Callers must index this result before refreshing again when
     * `hasMoreWal` is true.
     */
    refresh(): TerminalReplayResult;
    close(): void;
}
export {};
