import { type MuxClientInfo, type MuxOutputType as OutputType, type MuxServerMessage } from '../core/index.js';
export type MuxDeliveryMeta = {
    source: 'full' | 'delta';
    replace: boolean;
};
type Callback = (data: string, type?: OutputType, cursor?: MuxServerMessage['cursor'], meta?: MuxDeliveryMeta) => void;
type ClientInfo = MuxClientInfo & Record<string, unknown>;
export type TmuxMuxOptions = {
    /** WS endpoint; default: <ws(s)>://<host>/ws/tmux */
    getUrl?: () => string;
    /** Extra fields merged (top-level) into every client_info payload. */
    getClientMeta?: () => Partial<ClientInfo> | undefined;
};
export declare class TmuxMux {
    private opts;
    private ws;
    private subs;
    /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
    private subTails;
    private sentTail;
    /** Exact raw `data.split('\\n')` bases, scoped to the current socket and tail. */
    private outputBases;
    /** A failed delta requests one full replacement; later deltas wait for it. */
    private resyncingSessions;
    private reconnectTimer;
    private pingTimer;
    private pongTimer;
    private connectTimer;
    private sessionCallbacks;
    private pendingResizeBySession;
    private reconnectDelay;
    private visibilityBound;
    private viewportBound;
    private clientInfoTimer;
    connected: boolean;
    configure(opts: TmuxMuxOptions): void;
    private getUrl;
    private ensureConnection;
    private bindVisibility;
    private bindViewport;
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
    private invalidateOutputBase;
    private invalidateAllOutputBases;
    private requestResync;
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
    /** Subscribe to a tmux session's output. Returns unsubscribe function. */
    subscribe(session: string, callback: Callback, opts?: {
        tail?: number;
    }): () => void;
    /** Subscribe to session list changes (pushed by server every 5s).
     * Sends `sessions_subscribe` itself — hosts do NOT need to auto-subscribe
     * sockets server-side (v0.3.1 fix: previously only hosts that subscribed
     * every socket on open ever delivered `__sessions` pushes). */
    onSessions(callback: (sessions: any[]) => void): () => void;
    /** Send keys to a session. */
    sendKeys(session: string, data: string): void;
    /** Sync terminal size to tmux pane. */
    sendResize(session: string, cols: number, rows: number): void;
    /** Expand capture history when the viewer scrolls to the top. */
    requestHistory(session: string, beforeLine?: number | null, limit?: number): void;
}
export declare const tmuxMux: TmuxMux;
/** Configure the shared singleton (call once at host startup). */
export declare function configureTmuxMux(opts: TmuxMuxOptions): void;
export {};
