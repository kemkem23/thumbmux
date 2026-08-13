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
 * `close` is deliberately NOT declared here: an adapter may already carry the
 * standard `close(code, reason)`, and a zero-arg `close?()` on this type would
 * stop such a host compiling. Callers duck-type it instead.
 */
import { type MuxClientMessage, type MuxFullOutputFrame, type MuxPaneScreen, type SessionListItem, type SessionListRow } from "../core/index.js";
export type WsLike = {
    send(data: string): unknown;
};
export interface TmuxDriver<SessionRow extends SessionListRow = SessionListItem> {
    listSessions(): SessionRow[];
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
     * cursor (and optionally pane screen mode) in ONE tmux invocation
     * (`tmux display-message ... \; capture-pane ...`) so the (content, cursor,
     * screen) triple can never desync — a stale mismatched pair would otherwise
     * be frozen by hash dedupe for as long as the pane stays idle, misplacing
     * every new viewer's caret / alt-screen state.
     * `trailingBlanks` = count of consecutive blank lines at the END of the RAW
     * capture output (before any trimming your driver applies to `content`) —
     * the mux needs it to anchor cursor rows, and it cannot recover the number
     * itself once the content is trimmed.
     * `screen` is optional for back-compat drivers; when present, output frames
     * carry it and screen-only changes are pushed without a content re-hash. */
    captureWithCursor?(session: string, opts: {
        startLine?: number;
        currentPaneOnly?: boolean;
    }): Promise<{
        content: string;
        cursor: RawCursorState | null;
        trailingBlanks: number;
        screen?: MuxPaneScreen | null;
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
    /** Optional forward archive paging. `afterLine` is an exclusive anchor. */
    readAfter?(session: string, afterLine: number | null, limit?: number): unknown;
    renameSession(oldSession: string, newSession: string): void;
    /** Optional durable-history purge used when a host invalidates a session. */
    dropSession?(session: string): void;
}
export type InvalidateSessionOptions = {
    /** Final error-frame text. Defaults to the capture-error wording. */
    reason?: string;
    /** Also remove durable archived history. Default false. */
    purgeArchive?: boolean;
};
export type SessionProfile = {
    /** browser-authoritative geometry: apply resize requests to the tmux window */
    resize: boolean;
    /** capture only the current pane screen (alt-screen TUIs whose history
     * lives inside the app, e.g. grok) instead of scrollback-ranged capture */
    currentPaneOnly: boolean;
    /** feed captures through the scrollback archive (live-window trim + history_expand) */
    archive: boolean;
};
export interface MuxHooks<WS extends WsLike = WsLike, SessionRow extends SessionListRow = SessionListItem> {
    /** Refresh host-owned descriptor state for this socket. */
    onClientInfo?(ws: WS, client: unknown): void;
    onSubscribe?(session: string, ws: WS, client: unknown): void;
    /** Final admission check after onSubscribe side effects. false leaves every
     * mux subscription/cache structure untouched for this request. */
    canSubscribe?(session: string, ws: WS, client: unknown): boolean;
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
    /** Backpressure lifecycle for host telemetry/alerting. Never affects mux behaviour. */
    onBackpressure?(ws: WS, event: "blocked" | "drained" | "closed", info: {
        blockedMs: number;
        bufferedBytes?: number;
    }): void;
    /**
     * Canonical pane state after a fresh mux capture. The frame is always a
     * complete, unsliced `output` snapshot even when viewers receive tail-sliced
     * or delta wire frames. Cursor-only changes repeat the current data with the
     * new cursor so recorders can preserve the complete visual timeline.
     *
     * This is a telemetry tap: throwing is isolated from viewer delivery.
     */
    onOutput?(session: string, frame: MuxFullOutputFrame): void;
    /** Per-principal session-list authorization. Called with the provider's rows for EVERY delivery to
     * that socket — the initial `sessions_subscribe` reply, every push, and backpressure drain catch-up.
     * Return the subset this socket may see (do not mutate the input array).
     * Unset = every socket sees the provider list verbatim (pre-0.4 behaviour, unchanged).
     * Throwing = FAIL CLOSED: that socket receives nothing this round.
     * Hosts typically wire `guard.filterSessions(sessions, principalOf(ws))` into this hook. */
    filterSessionList?(sessions: readonly SessionRow[], ws: WS, client: unknown): readonly SessionRow[];
}
/**
 * Outbound-queue backpressure policy. Under Bun, `ws.send()` returning `-1`
 * means the frame was ENQUEUED (delivered in order) but the peer is not
 * draining. With this enabled the mux stops piling more server-pushed frames
 * onto that socket until it resumes.
 *
 * Resume paths:
 *   - FAST: host wires Bun's `websocket.drain(ws)` → `handleDrain(ws)`.
 *   - SELF-HEAL: when the adapter can report buffered bytes, `shouldSkipServerPush`
 *     auto-resumes as soon as `readBufferedAmount` is 0 (no host wiring required).
 *     When the adapter cannot report (`undefined`), only `handleDrain` resumes.
 *
 * Boundary: client-requested REPLIES stay unconditional and are out of scope —
 * `pong`, `history` (`expandHistory`), and `error` frames. They are small and
 * a client is synchronously waiting on them. Only server-pushed traffic
 * (output/delta, cursor-only, session-list) is suppressed while blocked.
 */
export type MuxBackpressureOptions<WS extends WsLike = WsLike> = {
    /** Master switch. Default true. false = pre-0.4 behaviour (-1 keeps sending). */
    enabled?: boolean;
    /** Close a socket whose outbound buffer exceeds this. Default 8 * 1024 * 1024. */
    maxBufferedBytes?: number;
    /** Close a socket that has stayed blocked this long. Default 30_000 ms. */
    maxBlockedMs?: number;
    /** Read a socket's queued bytes. Default: duck-typed `ws.getBufferedAmount?.()`
     *  (Bun's ServerWebSocket); undefined when the adapter cannot report. */
    bufferedAmount?(ws: WS): number | undefined;
    /** Shed a chronically slow socket. Default: duck-typed `ws.close?.(1013, reason)`
     *  (1013 = Try Again Later). A no-op when the adapter has no close(). */
    close?(ws: WS, reason: string): void;
};
/**
 * Deterministic clock + one-shot timer for the maxBlockedMs shed path.
 * Production leaves this unset (real `Date.now` / `setTimeout`). Tests install
 * via `installMuxTimeHooksForTests` so the shed rule does not wait on a loaded
 * runner's event loop. Only the blocked-socket arm uses these hooks — poll,
 * pipe, and burst timers stay on the real scheduler.
 *
 * Not an options field: putting `clock`/`timeout` on `MuxBackpressureOptions`
 * or `TmuxWsMuxOptions` re-hashes every `Partial<TmuxWsMuxOptions>` holder
 * (AppRoutesOptions / createAppRoutes) in a way the additive optional-member
 * proof cannot prove through `Partial<>`, which would force an F/S break for a
 * test-only surface.
 */
export type MuxTimeHooks = {
    clock: () => number;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
};
/**
 * Install (or clear) package-level time hooks used by every subsequent
 * `TmuxWsMux` constructed on this module. Returns a restore function.
 * Intended for tests; production hosts should not call this.
 */
export declare function installMuxTimeHooksForTests(hooks: MuxTimeHooks | null): () => void;
export type TmuxWsMuxOptions<WS extends WsLike = WsLike, SessionRow extends SessionListRow = SessionListItem> = {
    /** Compress outbound frames (Bun ServerWebSocket only: passes `true` as
     * ws.send's second argument — RSV1 per-message-deflate). Terminal snapshots
     * are 50-140KB of highly compressible text; enable when the host also sets
     * `perMessageDeflate: true` on Bun.serve's websocket config. Default false
     * (other WS engines may not accept a boolean second argument). */
    compressFrames?: boolean;
    driver: TmuxDriver<SessionRow>;
    pipes?: PipeManagerLike | null;
    archive?: HistoryArchiveLike | null;
    hooks?: MuxHooks<WS, SessionRow>;
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
    /** Outbound backpressure. Default enabled — see MuxBackpressureOptions. */
    backpressure?: MuxBackpressureOptions<WS>;
    log?: (...args: unknown[]) => void;
    logError?: (...args: unknown[]) => void;
};
export declare class TmuxWsMux<WS extends WsLike = WsLike, SessionRow extends SessionListRow = SessionListItem> {
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
    /** Client hint remembered from the latest `sessions_subscribe` for this socket
     * (fed to `filterSessionList` on every delivery). Cleared on unsubscribe. */
    private sessionListClients;
    private contents;
    private hashes;
    private lastActivity;
    private interval;
    private sessionListInterval;
    /** Change-detection key for the UNFILTERED provider result only. Never store
     * a filtered projection here — a narrow view would suppress a real global
     * change for every other socket. */
    private lastSessionsJson;
    private inFlight;
    private currentRate;
    private burstTimer;
    private piped;
    private immediateCaptureTimers;
    private queuedCapturesInFlight;
    private queuedCapturesPending;
    private queuedCapturesFullHistory;
    /** Tail promise per session so callers (poll) can await the whole chain. */
    private queuedCaptureTails;
    /** Viewer-set owners currently consuming a full-history queue intent. A
     * WeakSet keeps that intent attached to the async lifecycle across rename. */
    private fullHistoryCaptureOwners;
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
    /** last pane screen-mode sample per session — attached like lastCursor so a
     * new viewer of a static pane still learns alt/mouse without a content change */
    private lastScreen;
    private pipeDebounceTimers;
    private pipeMaxTimers;
    private pollCounter;
    private bpEnabled;
    private bpMaxBufferedBytes;
    private bpMaxBlockedMs;
    private bpBufferedAmount?;
    private bpClose?;
    /** Sockets whose last send returned -1 and have not yet drained. */
    private blockedSockets;
    /** Chronically slow sockets we have already shed (never push again). */
    private shedSockets;
    /** Blocked sockets that missed a session-list push and need one on drain. */
    private owedSessionList;
    /**
     * Per-socket timer that enforces `maxBlockedMs` as a real timeout (A3-9).
     * Cleared on drain/shed/unsubscribe. Without this, a blocked peer that never
     * receives another server push stays open forever.
     */
    private blockedTimeouts;
    constructor(opts: TmuxWsMuxOptions<WS, SessionRow>);
    setSessionListProvider(provider?: () => readonly SessionRow[]): void;
    subscribe(session: string, ws: WS, client?: unknown, opts?: {
        tail?: number;
        delta?: boolean;
    }): void;
    unsubscribe(session: string, ws: WS, client?: unknown): void;
    unsubscribeAll(ws: WS): void;
    /** True while this socket is being skipped because it has not drained. */
    isBackpressured(ws: WS): boolean;
    /**
     * The socket drained — resume pushes and hand it CURRENT truth (never a replay).
     *
     * FAST path: hosts wire this from Bun's `websocket.drain(ws)` handler so the
     * socket is unblocked the moment Bun reports an empty outbound buffer.
     * The mux ALSO self-heals inside `shouldSkipServerPush` whenever the adapter
     * can report a zero buffered amount — so a host that forgets the drain
     * wiring still recovers on the next server-push (no forever-silent socket).
     * When the adapter cannot report buffered bytes (`undefined`), only this
     * method resumes the socket.
     *
     * Safe no-op for a socket that is not blocked, is already shed, or is unknown.
     *
     * Unlike auto-resume (which only clears the blocked mark and lets the current
     * broadcast deliver via pending-full markers), this path runs outside any
     * broadcast and therefore must push the current cached content itself.
     */
    handleDrain(ws: WS): void;
    /**
     * Shared "resume" core for handleDrain and auto-resume in shouldSkipServerPush.
     * Clears the blocked mark and fires onBackpressure("drained") with the same
     * shape so the two paths cannot drift. Does NOT push output catch-up frames
     * and does NOT settle session-list debt — callers own those:
     *   - handleDrain: catch-up loop, then settleSessionListDebt (after catch-up
     *     may re-block)
     *   - auto-resume: settleSessionListDebt immediately, then return false so
     *     the in-flight broadcast delivers via pendingOutputFulls
     *
     * Returns false when the socket was not blocked (or is shed).
     */
    private resumeBlockedSocket;
    /** Push an owed session list if the socket is clear (not blocked / not shed). */
    private settleSessionListDebt;
    /** Drop per-socket backpressure marks so a reused socket object starts clean. */
    private clearBackpressureState;
    private clearBlockedTimeout;
    /**
     * Arm a one-shot shed timer so maxBlockedMs is enforced without a next push.
     * When the timer fires the socket is shed directly — the arm itself is the
     * duration proof. Re-reading the wall clock here used to re-check
     * `now - since >= maxBlockedMs`; a timer that fires a millisecond early
     * (or a frozen injected clock that the test had not advanced yet) would then
     * drop the only timer and leave the peer blocked forever on an idle session.
     */
    private armBlockedTimeout;
    private readBufferedAmount;
    private closeSlowSocket;
    /**
     * Mark a socket blocked after a -1 enqueue. Fires onBackpressure("blocked")
     * once per blocked episode (not per frame). Then evaluate shed thresholds.
     */
    private markBlocked;
    /**
     * Shed a chronically slow socket. Invokes close once, fires onBackpressure
     * ("closed"), and records the socket so we never push to it again.
     *
     * Do NOT call unsubscribeAll here — the host's own socket-close handler owns
     * that path (Bun's `websocket.close` / our `unsubscribeAll`). Calling it
     * from shed would fire hooks.onSocketClose twice.
     */
    private shedSocket;
    /** Evaluate buffered-byte / blocked-duration thresholds. */
    private maybeShed;
    /**
     * True when server-pushed frames to this socket must be SKIPPED (blocked or
     * already shed). Evaluates shed thresholds for currently-blocked sockets.
     * Client-requested replies (pong / history / error) do NOT consult this.
     *
     * Self-heal: when the socket is blocked and the adapter reports buffered
     * amount === 0, treat it as drained (see resumeBlockedSocket) and return
     * false so the frame currently being built is delivered right now. The
     * socket already carries pendingOutputFulls from the frames it was skipped
     * for, so it receives a complete snapshot in this broadcast — no separate
     * catch-up pass. When the adapter cannot report (`undefined`), behaviour is
     * unchanged: stay blocked until the host calls handleDrain.
     * Shed always wins: thresholds are evaluated before auto-resume.
     */
    private shouldSkipServerPush;
    /**
     * Wire `data` field for a `__sessions` frame for one socket.
     * Returns null when that socket must receive nothing (filter threw = fail closed).
     * No filter hook → returns `unfilteredJson` so the caller can reuse one shared
     * serialized outer message. With a hook → filters then stringifies for this
     * socket only. Per-socket dedupe of identical filtered pushes is deliberately
     * OUT of scope: a filtered socket may receive a repeat of its unchanged view
     * when the global list changes elsewhere.
     *
     * A throwing filter is logged once per occurrence via logError (message text
     * only — never the sessions payload, which can contain names a principal must
     * not see).
     */
    private sessionListDataFor;
    /** Best-effort session-list push for one socket (used on drain catch-up). */
    private pushSessionListTo;
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
    private screenEq;
    /**
     * Best-effort canonical output tap. Keep the absent-hook path allocation-free:
     * the frame object only exists for hosts that explicitly install the seam.
     * Hook and logger failures are both contained here so neither can fall into
     * captureAndBroadcastAsync's session-gone catch and disturb viewers.
     */
    private emitOutputHook;
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
     * Group viewers by the inputs that determine on-the-wire bytes, build and
     * serialize ONE frame per group, then fan the shared string out. Bookkeeping
     * (base advance, pending full/reset clear) stays per-socket and matches the
     * pre-grouping sendOutputFrame semantics exactly.
     *
     * Grouping key:
     *   1. tail preference (undefined = full content)
     *   2. pending reset marker (undefined / "resize" / "resync")
     *   3. delta base identity — sockets that are not delta-eligible, have a
     *      pending full/reset, or hold no base collapse into one "full" group
     *      per (tail, reset). Bases compare by ARRAY REFERENCE (O(1)); equal
     *      contents in distinct arrays just miss a share — never wrong.
     */
    private sendGroupedOutputFrames;
    /**
     * Serialize and send a full-or-delta output frame for exactly one viewer.
     * Implemented as a one-element call into the grouped helper so single-socket
     * paths (subscribe, handleResync) share the same bookkeeping.
     * The base advances only after Bun accepts the frame (including -1: queued
     * under backpressure). A real drop/throw forces a complete retry, so a live
     * socket cannot remain stale when the pane goes idle immediately afterward.
     */
    private sendOutputFrame;
    /** A lost cursor-only frame must make that viewer eligible for a complete
     * retry. lastCursor is session-global, so otherwise the next idle sample
     * looks unchanged and the affected viewer can remain stale indefinitely.
     * While backpressured, cursor-only frames are suppressed and the viewer is
     * marked for a full output on drain (which carries the current cursor). */
    private sendCursorFrame;
    private sendPendingOutputFrames;
    /**
     * End one server-owned session lifecycle. Every current viewer receives one
     * final error frame and is detached, so later poll ticks cannot capture or
     * report the dead pane again. Durable history is retained unless explicitly
     * purged; notification and detachment are intentionally not optional.
     */
    invalidateSession(session: string, opts?: InvalidateSessionOptions): number;
    private dropSessionState;
    subscribeSessions(ws: WS, client?: unknown): void;
    unsubscribeSessions(ws: WS): void;
    /** Handle resize. Browser-authoritative geometry for resizable profiles;
     * the host's onResizeRequest hook may suppress the request (e.g. a
     * mobile-first size arbiter). */
    handleResize(session: string, cols: number, rows: number, ws?: WS, client?: unknown): void;
    /** Actually resize tmux + refresh captures. Also used by host policy (size
     * arbiter) to re-apply a surviving viewer's geometry after a hold releases. */
    applyGeometry(session: string, cols: number, rows: number, ws?: WS): void;
    handleKeys(session: string, data: string, ws?: WS, client?: unknown): void;
    private reportArchiveReadErrorBestEffort;
    expandHistory(session: string, ws: WS, beforeLine?: number | null, limit?: number): void;
    expandHistoryAfter(session: string, ws: WS, afterLine: number | null, limit?: number): void;
    /** Route a parsed client message. Convenience for hosts whose WS handler
     * is a thin switch — hosts with richer routing keep their own switch instead.
     * Answers client keepalive pings: the thumbmux/svelte client closes the
     * connection when a ping goes unanswered for 8s. */
    handleMessage(msg: MuxClientMessage, ws: WS): void;
    private handleResync;
    private scheduleImmediateCapture;
    private clearImmediateCapture;
    private clearPipeCaptureTimers;
    private queueCapture;
    private runQueuedCapture;
    private tryStartPipe;
    handleSessionRename(oldSession: string, newSession: string): void;
    /** Switch to burst polling for a bit after keystrokes, then back to normal */
    private enterBurst;
    private restartPolling;
    /** Async capture — used by poll() to avoid blocking the event loop */
    private captureAndBroadcastAsync;
    private ownsSessionLifecycle;
    private ensurePolling;
    private maybeStopPolling;
    private refreshSessionListSchedule;
    private poll;
    private broadcastSessionList;
}
