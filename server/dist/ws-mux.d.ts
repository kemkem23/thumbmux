/**
 * TmuxWsMux — the server side of the thumbmux protocol. One instance serves
 * every WebSocket viewer: captures tmux panes on a shared adaptive poll
 * (pipe-pane dirty signals when available), dedupes by content hash, and
 * multiplexes output/history/session-list messages per channel.
 *
 * Direct port of the production host's battle-tested poller with the host touches
 * turned into injection points:
 *   driver    how to talk to tmux (capture/keys/resize/activity/history-limit)
 *   pipes     optional pipe-pane manager (dirty signals instead of polling)
 *   archive   optional scrollback archive (history_expand + live-window trim)
 *   hooks     host policy: telemetry taps + resize arbitration
 *   profile   per-session behavior (resizable? capture mode? archive?)
 *
 * The WS type is structural ({ send }) — Bun's ServerWebSocket satisfies it.
 */
import { type MuxClientMessage } from "@thumbmux/core";
export type WsLike = {
    send(data: string): unknown;
};
export interface TmuxDriver {
    listSessions(): unknown[];
    capturePane(session: string, opts: {
        startLine?: number;
        currentPaneOnly?: boolean;
    }): Promise<string>;
    sendKeys(session: string, data: string): void;
    /** session → last-activity timestamp (one tmux call for all sessions) */
    getSessionActivity(): Map<string, number>;
    getHistoryLimit(): number;
    setSessionHistoryLimit(session: string, limit: number): void;
    resizeWindow(session: string, cols: number, rows: number): void;
    /** content hash for change dedupe (host may pass a native hash, e.g. Bun.hash) */
    hash(content: string): string;
    /** OPTIONAL: raw cursor state (tmux #{cursor_x}/#{cursor_y}/#{pane_height}/
     * #{cursor_flag}/#{pane_in_mode}). When present, output frames carry a
     * mapped { row, col } cursor for the viewer's caret overlay.
     * CAVEAT: this is a separate tmux call from capturePane, so the pair can
     * desync during heavy TUI repaints, and the mux must infer trailing blank
     * rows from the captured content — which is WRONG if your capturePane trims
     * trailing blank lines. Implement captureWithCursor instead; it has neither
     * problem. */
    getCursor?(session: string): Promise<RawCursorState | null>;
    /** OPTIONAL, preferred over getCursor: capture the pane AND sample the
     * cursor in ONE tmux invocation (`tmux display-message ... \; capture-pane
     * ...`) so the (content, cursor) pair can never desync — a stale mismatched
     * pair would otherwise be frozen by hash dedupe for as long as the pane
     * stays idle, misplacing every new viewer's caret.
     * `trailingBlanks` = count of consecutive blank lines at the END of the RAW
     * capture output (before any trimming your driver applies to `content`) —
     * the mux needs it to anchor cursor rows, and it cannot recover the number
     * itself once the content is trimmed. */
    captureWithCursor?(session: string, opts: {
        startLine?: number;
        currentPaneOnly?: boolean;
    }): Promise<{
        content: string;
        cursor: RawCursorState | null;
        trailingBlanks: number;
    }>;
}
/** tmux cursor sample: cell coords within the visible pane + visibility
 * (#{cursor_flag} && !#{pane_in_mode} — hidden cursor or copy-mode = not
 * visible, viewers draw no caret). */
export type RawCursorState = {
    x: number;
    y: number;
    paneHeight: number;
    visible: boolean;
};
export interface PipeManagerLike {
    startPipe(session: string, onData: (data: string) => void, onBroken: () => void, onRestarted: () => void): boolean;
    stopPipe(session: string): void;
    handleRename(session: string): void;
}
export interface HistoryArchiveLike {
    ingestSnapshot(session: string, content: string, opts: {
        previousContent: string | null;
        fullHistory: boolean;
        liveLineLimit: number;
        /** Replace the live archive window in place after a pane reflow. */
        replace?: boolean;
    }): {
        liveContent: string;
    };
    readBefore(session: string, beforeLine: number | null, limit?: number): unknown;
    renameSession(oldSession: string, newSession: string): void;
}
export type SessionProfile = {
    /** browser-authoritative geometry: apply resize requests to the tmux window */
    resize: boolean;
    /** capture only the current pane screen (alt-screen TUIs whose history
     * lives inside the app, e.g. grok) instead of scrollback-ranged capture */
    currentPaneOnly: boolean;
    /** feed captures through the scrollback archive (live-window trim + history_expand) */
    archive: boolean;
};
export interface MuxHooks<WS extends WsLike = WsLike> {
    onSubscribe?(session: string, ws: WS, client: unknown): void;
    onUnsubscribe?(session: string, ws: WS, client: unknown): void;
    /** socket closed — release any per-socket state (size holds, telemetry) */
    onSocketClose?(ws: WS): void;
    onKeys?(session: string, ws: WS, client: unknown): void;
    /** Fired for EVERY resize message (even profiles that never resize tmux) —
     * telemetry only, no verdict. */
    onResizeTelemetry?(session: string, ws: WS | null, geometry: {
        cols: number;
        rows: number;
    }, client: unknown): void;
    /** Resize arbitration — consulted only for resizable profiles. Return
     * {apply:false} to suppress (e.g. a mobile viewer holds the geometry). */
    onResizeRequest?(session: string, ws: WS | null, geometry: {
        cols: number;
        rows: number;
    }, client: unknown): {
        apply: boolean;
    };
}
export type TmuxWsMuxOptions<WS extends WsLike = WsLike> = {
    /** Compress outbound frames (Bun ServerWebSocket only: passes `true` as
     * ws.send's second argument — RSV1 per-message-deflate). Terminal snapshots
     * are 50-140KB of highly compressible text; enable when the host also sets
     * `perMessageDeflate: true` on Bun.serve's websocket config. Default false
     * (other WS engines may not accept a boolean second argument). */
    compressFrames?: boolean;
    driver: TmuxDriver;
    pipes?: PipeManagerLike | null;
    archive?: HistoryArchiveLike | null;
    hooks?: MuxHooks<WS>;
    profile?: (session: string) => SessionProfile;
    /** live scrollback window (lines) kept in the fast path */
    liveLineLimit?: number;
    pollNormalMs?: number;
    pollBurstMs?: number;
    burstDurationMs?: number;
    sessionListIntervalMs?: number;
    pipeReconcileMs?: number;
    /** unpiped sessions: max ms between reconcile captures when the
     * (second-resolution) tmux activity gate reports no change */
    pollReconcileMs?: number;
    log?: (...args: unknown[]) => void;
    logError?: (...args: unknown[]) => void;
};
export declare class TmuxWsMux<WS extends WsLike = WsLike> {
    private compressFrames;
    /** Send one frame; with compressFrames, opt into Bun's per-message deflate. */
    private wsSend;
    private driver;
    private pipes;
    private archive;
    private hooks;
    private profileOf;
    private liveLineLimit;
    private POLL_NORMAL;
    private POLL_BURST;
    private BURST_DURATION;
    private SESSION_LIST_INTERVAL;
    private PIPE_RECONCILE_INTERVAL;
    private POLL_RECONCILE;
    private INITIAL_CAPTURE_START_LINE;
    private DEFAULT_CAPTURE_START_LINE;
    private log;
    private logError;
    private subscribers;
    private sessionListSubscribers;
    private contents;
    private hashes;
    private lastActivity;
    private interval;
    private sessionListInterval;
    private lastSessionsJson;
    private inFlight;
    private currentRate;
    private burstTimer;
    private piped;
    private immediateCaptureTimers;
    private queuedCapturesInFlight;
    private queuedCapturesPending;
    private queuedCapturesFullHistory;
    private captureStartLines;
    private archiveSeeded;
    /** Sessions whose next successful archive ingest must replace, not append,
     * because accepted geometry changed tmux's physical line wrapping. Each
     * resize gets a monotonic generation so stale in-flight captures cannot
     * consume intent created after they started. */
    private pendingArchiveReflows;
    /** Latest accepted geometry generation for each session. Captures snapshot
     * this before awaiting the driver and discard themselves if it changes. */
    private geometryGenerations;
    private geometryGeneration;
    private lastReconcileCapture;
    private lastAppliedGeometry;
    private sessionListProvider;
    /** per-session, per-socket tail preference (undefined = full snapshots) */
    private tails;
    /** Per-session viewers whose latest subscription opted into delta output frames. */
    private deltaSubscribers;
    /** Last successfully delivered raw base, after each viewer's tail slice. */
    private outputBases;
    /** Viewers which must receive a complete frame before a delta can resume. */
    private pendingOutputFulls;
    /** Complete frames whose reset marker must survive a failed send. */
    private pendingOutputResets;
    /** last cursor broadcast per session — attached to cached first paints so
     * a new viewer of a static pane still gets a caret */
    private lastCursor;
    private pipeDebounceTimers;
    private pipeMaxTimers;
    private pollCounter;
    constructor(opts: TmuxWsMuxOptions<WS>);
    setSessionListProvider(provider?: () => unknown[]): void;
    subscribe(session: string, ws: WS, client?: unknown, opts?: {
        tail?: number;
        delta?: boolean;
    }): void;
    unsubscribe(session: string, ws: WS, client?: unknown): void;
    unsubscribeAll(ws: WS): void;
    /** Map a raw tmux cursor sample onto the content-anchored protocol
     * convention: row = lines up from the last content line, so client buffers
     * that trim trailing blanks still land the caret on the right line.
     * `trailingBlanks` MUST be counted on the raw untrimmed capture (the
     * captureWithCursor contract); deriving it from trimmed content yields 0
     * and displaces the caret upward by the real blank-row count — the exact
     * production bug this replaced. */
    private mapRawCursor;
    /** Trailing blank lines of a raw capture. Gotcha (thanks, issue #1):
     * `capture-pane -p` ends with a trailing newline, so a naive split() yields
     * a phantom "" that shifts the cursor up a row — strip exactly one. */
    private countTrailingBlanks;
    private cursorEq;
    /** Tear down every timer this instance owns (poll, session list, burst,
     * immediate captures, pipe debounces) and stop active pipes. For hosts
     * that create short-lived muxes (tests, per-request servers). */
    stop(): void;
    /** Slice to a socket's tail preference (full content when none). Trailing
     * blank viewport rows are trimmed first — a fresh 24-row pane ends in ~20
     * empty lines, and slicing those would hand thumbnails pure blankness
     * (caught by the conformance suite). */
    private contentFor;
    private outputBaseFor;
    private setDeltaSubscription;
    private isDeltaSubscriber;
    private invalidateOutputBase;
    private invalidateOutputBases;
    private requireFullOutput;
    private requireResetOutput;
    private hasPendingOutputFrame;
    private forgetOutputViewer;
    private forgetOutputSocket;
    /**
     * Serialize and send a full-or-delta output frame for exactly one viewer.
     * The base advances only after Bun accepts the frame (including -1: queued
     * under backpressure). A real drop/throw forces a complete retry, so a live
     * socket cannot remain stale when the pane goes idle immediately afterward.
     */
    private sendOutputFrame;
    /** A lost cursor-only frame must make that viewer eligible for a complete
     * retry. lastCursor is session-global, so otherwise the next idle sample
     * looks unchanged and the affected viewer can remain stale indefinitely. */
    private sendCursorFrame;
    private sendPendingOutputFrames;
    private dropSessionState;
    subscribeSessions(ws: WS): void;
    unsubscribeSessions(ws: WS): void;
    /** Handle resize. Browser-authoritative geometry for resizable profiles;
     * the host's onResizeRequest hook may suppress the request (e.g. a
     * mobile-first size arbiter). */
    handleResize(session: string, cols: number, rows: number, ws?: WS, client?: unknown): void;
    /** Actually resize tmux + refresh captures. Also used by host policy (size
     * arbiter) to re-apply a surviving viewer's geometry after a hold releases. */
    applyGeometry(session: string, cols: number, rows: number, ws?: WS): void;
    handleKeys(session: string, data: string, ws?: WS, client?: unknown): void;
    expandHistory(session: string, ws: WS, beforeLine?: number | null, limit?: number): void;
    /** Route a parsed client message. Convenience for hosts whose WS handler
     * is a thin switch — hosts with richer routing keep their own switch instead.
     * Answers client keepalive pings: the @thumbmux/svelte client closes the
     * connection when a ping goes unanswered for 8s. */
    handleMessage(msg: MuxClientMessage, ws: WS): void;
    private handleResync;
    private scheduleImmediateCapture;
    private clearImmediateCapture;
    private queueCapture;
    private runQueuedCapture;
    private tryStartPipe;
    handleSessionRename(oldSession: string, newSession: string): void;
    /** Switch to burst polling for a bit after keystrokes, then back to normal */
    private enterBurst;
    private restartPolling;
    /** Async capture — used by poll() to avoid blocking the event loop */
    private captureAndBroadcastAsync;
    private ensurePolling;
    private maybeStopPolling;
    private refreshSessionListSchedule;
    private poll;
    private broadcastSessionList;
}
