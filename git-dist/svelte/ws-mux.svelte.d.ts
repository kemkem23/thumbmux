import { type MuxClientInfo, type MuxOutputType as OutputType, type MuxServerMessage } from '../core/index.js';
export type MuxDeliveryMeta = {
    source: 'full' | 'delta';
    replace: boolean;
};
type Callback = (data: string, type?: OutputType, cursor?: MuxServerMessage['cursor'], meta?: MuxDeliveryMeta) => void;
type ClientInfo = MuxClientInfo & Record<string, unknown>;
type SubscribeOpts = {
    tail?: number;
    /**
     * When every subscriber of a session supplies this probe and every probe
     * returns true, raw delta frames are queued and coalesced until the view is
     * no longer busy (or a safety valve trips). Opt-in: omit for today's
     * synchronous delivery.
     */
    deferWhileBusy?: () => boolean;
};
export type TmuxMuxOptions = {
    /** WS endpoint; default: <ws(s)>://<host>/ws/tmux */
    getUrl?: () => string;
    /** Extra fields merged (top-level) into every client_info payload. */
    getClientMeta?: () => Partial<ClientInfo> | undefined;
    /**
     * Scheduler used by the busy-deferral settle loop. Defaults to
     * requestAnimationFrame (or setTimeout(16) when rAF is unavailable).
     * Tests inject a deterministic queue-driver here.
     */
    scheduleFrame?: (cb: () => void) => void;
};
export declare class TmuxMux {
    private opts;
    private ws;
    private subs;
    /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
    private subTails;
    /** per-callback busy probe; absence means "never defer for this session" */
    private subDeferProbes;
    private sentTail;
    /** Exact raw `data.split('\\n')` bases, scoped to the current socket and tail. */
    private outputBases;
    /** Streaming FNV prefix-hash states bound to each base's array identity. */
    private prefixHashCaches;
    /** Raw delta frames held while every subscriber reports busy. */
    private deferredDeltas;
    private settleScheduled;
    private settleCancel;
    /** A failed delta requests one full replacement; later deltas wait for it. */
    private resyncingSessions;
    /** Session leases mapped to the socket that owns the tokenless reply. */
    private historyInflight;
    /**
     * A6-14: after the last subscriber leaves while a history request is still
     * outstanding, late tokenless replies must not be handed to a later
     * subscriber of the same session name. Cleared on the next requestHistory.
     * Unsolicited history (no prior request / no fence) still delivers so
     * flush-before-history ordering stays intact.
     */
    private historyFenced;
    private reconnectTimer;
    private pingTimer;
    private pongTimer;
    private connectTimer;
    private sessionCallbacks;
    private pendingResizeBySession;
    private reconnectDelay;
    private disposed;
    private visibilityBound;
    private visibilityDocument;
    private visibilityWindow;
    private visibilityHandler;
    private viewportBound;
    private viewportWindow;
    private boundVisualViewport;
    private viewportHandler;
    private clientInfoTimer;
    connected: boolean;
    configure(opts: TmuxMuxOptions): void;
    private getUrl;
    private ensureConnection;
    private bindVisibility;
    private unbindVisibility;
    private bindViewport;
    private unbindViewport;
    private clientInfo;
    private sendClientInfo;
    /**
     * Send only through the currently-owned open socket. Capturing `socket`
     * before checking it prevents a callback from an older connection from
     * accidentally sending through a newer socket stored in `this.ws`.
     */
    private send;
    private pageVisible;
    private effectiveTail;
    private sendSubscribe;
    private discardDeferred;
    private discardPrefixHashCache;
    private invalidateOutputBase;
    private invalidateAllOutputBases;
    private requestResync;
    /**
     * Incremental muxPrefixHash(base.slice(0, prefix)), byte-identical to
     * core's fnv1a32(JSON.stringify(...)). States are bound to the base's
     * array identity — a mismatched reference rebuilds from scratch.
     */
    private prefixHash;
    /**
     * Structural checks matching core validateMuxDeltaFrame accept/reject
     * outcomes exactly, but hashing via the incremental cache so a one-line
     * delta is O(changed lines) rather than O(whole base).
     */
    private validateDeltaLocal;
    /**
     * Apply a validated delta: reconstruct next base, carry hash states
     * [0..prefix], return delivery fields. Null on reject (no side effects
     * other than possibly warming the hash cache up to a valid range check).
     */
    private applyValidatedDelta;
    private deliverDelta;
    private sessionShouldDefer;
    private scheduleSettle;
    private settleDeferred;
    private enqueueDeferredDelta;
    /**
     * Apply queued raw deltas in order against successive bases, then deliver
     * ONE coalesced callback with the final content. A rejected frame delivers
     * any content already applied, drops the rest, and requests one resync.
     */
    private flushDeferred;
    /** Re-subscribe when the tail composition changes (e.g. a full viewer
     * joins a session a thumbnail was already tailing). */
    private refreshSubscription;
    private sendResizeNow;
    private flushResize;
    private flushPendingResizes;
    private connect;
    private clearConnectionTimers;
    private closeSocket;
    private releaseSocket;
    private startPing;
    private sendPing;
    private cancelReconnect;
    private scheduleReconnect;
    /**
     * Permanently release every resource owned by this mux. Disposal is
     * idempotent; a disposed instance deliberately cannot reconnect or accept
     * new subscriptions.
     */
    dispose(): void;
    /** Subscribe to a tmux session's output. Returns unsubscribe function. */
    subscribe(session: string, callback: Callback, opts?: SubscribeOpts): () => void;
    /** Subscribe to session list changes (pushed by server every 5s).
     * Sends `sessions_subscribe` itself — hosts do NOT need to auto-subscribe
     * sockets server-side (v0.3.1 fix: previously only hosts that subscribed
     * every socket on open ever delivered `__sessions` pushes). */
    onSessions(callback: (sessions: any[]) => void): () => void;
    /** Send keys to a session. */
    sendKeys(session: string, data: string): void;
    /** Sync terminal size to tmux pane. */
    sendResize(session: string, cols: number, rows: number): void;
    private sendHistoryRequest;
    /** Expand capture history when the viewer scrolls to the top. */
    requestHistory(session: string, beforeLine?: number | null, limit?: number): boolean;
    /** Page archived capture history forward from an exclusive line anchor. */
    requestHistoryAfter(session: string, afterLine: number | null, limit?: number): boolean;
    /**
     * Fence an abandoned tokenless history request before its caller retries.
     * If its socket is still current, replace the whole multiplexed socket;
     * otherwise that socket is already fenced and only its stale lease remains.
     */
    recoverHistoryRequest(session: string): boolean;
}
export declare const tmuxMux: TmuxMux;
/** Configure the shared singleton (call once at host startup). */
export declare function configureTmuxMux(opts: TmuxMuxOptions): void;
export {};
