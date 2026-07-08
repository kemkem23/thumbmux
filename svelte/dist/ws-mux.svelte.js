// Multiplexed WebSocket client for tmux sessions (thumbmux)
// Single WS connection → subscribe/unsubscribe per session.
// Host-specific bits (WS endpoint, extra client-info fields such as a
// telemetry client id) are injected via configureTmuxMux() — the wire format
// itself is part of the thumbmux protocol.
const PING_INTERVAL = 25_000; // 25s — under most carrier NAT timeouts (30-60s)
const PONG_TIMEOUT = 8_000; // 8s — if no pong, assume dead
const CONNECT_TIMEOUT = 8_000; // 8s — max wait for initial connection
const RECONNECT_MIN = 1_000; // 1s
const RECONNECT_MAX = 15_000; // 15s
export class TmuxMux {
    opts = {};
    ws = null;
    subs = new Map();
    /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
    subTails = new Map();
    sentTail = new Map();
    reconnectTimer = null;
    pingTimer = null;
    pongTimer = null;
    connectTimer = null;
    sessionCallbacks = new Set();
    pendingResizeBySession = new Map();
    reconnectDelay = RECONNECT_MIN;
    visibilityBound = false;
    viewportBound = false;
    clientInfoTimer = null;
    connected = $state(false);
    configure(opts) {
        this.opts = { ...this.opts, ...opts };
    }
    getUrl() {
        if (this.opts.getUrl)
            return this.opts.getUrl();
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws/tmux`;
    }
    ensureConnection() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.connect();
    }
    bindVisibility() {
        if (this.visibilityBound || typeof document === 'undefined')
            return;
        this.visibilityBound = true;
        const handleVisible = () => {
            this.sendClientInfo('visibility');
            if (document.visibilityState === 'visible') {
                // Coming back to foreground — reconnect immediately if dead
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this.cancelReconnect();
                    this.reconnectDelay = RECONNECT_MIN;
                    this.connect();
                }
                else {
                    // Connection looks alive — verify with a ping
                    this.sendPing();
                    this.flushPendingResizes();
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisible);
        if (typeof window !== 'undefined') {
            window.addEventListener('pageshow', handleVisible);
        }
    }
    bindViewport() {
        if (this.viewportBound || typeof window === 'undefined')
            return;
        this.viewportBound = true;
        const schedule = () => {
            if (this.clientInfoTimer)
                clearTimeout(this.clientInfoTimer);
            this.clientInfoTimer = setTimeout(() => {
                this.clientInfoTimer = null;
                this.sendClientInfo('viewport');
            }, 250);
        };
        window.addEventListener('resize', schedule, { passive: true });
        window.visualViewport?.addEventListener('resize', schedule, { passive: true });
        window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
    }
    clientInfo() {
        if (typeof window === 'undefined')
            return {};
        const vv = window.visualViewport;
        return {
            href: window.location.href,
            pathname: window.location.pathname,
            userAgent: navigator.userAgent,
            language: navigator.language,
            platform: navigator.platform,
            visibilityState: typeof document !== 'undefined' ? document.visibilityState : undefined,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                visualWidth: vv?.width,
                visualHeight: vv?.height,
                screenWidth: window.screen?.width,
                screenHeight: window.screen?.height,
                devicePixelRatio: window.devicePixelRatio,
            },
            ...(this.opts.getClientMeta?.() ?? {}),
        };
    }
    sendClientInfo(_reason = 'client_info') {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify({ type: 'client_info', client: this.clientInfo() }));
    }
    pageVisible() {
        return typeof document === 'undefined' || document.visibilityState !== 'hidden';
    }
    effectiveTail(session) {
        const tails = this.subTails.get(session);
        if (!tails || tails.size === 0)
            return undefined;
        let max = 0;
        for (const t of tails.values()) {
            if (t === undefined)
                return undefined; // a full viewer wins
            if (t > max)
                max = t;
        }
        return max;
    }
    sendSubscribe(session) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        const tail = this.effectiveTail(session);
        this.sentTail.set(session, tail);
        this.ws.send(JSON.stringify({ type: 'subscribe', session, tail, client: this.clientInfo() }));
    }
    /** Re-subscribe when the tail composition changes (e.g. a full viewer
     * joins a session a thumbnail was already tailing). */
    refreshSubscription(session) {
        if (!this.subs.has(session))
            return;
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        if (this.sentTail.get(session) !== this.effectiveTail(session)) {
            this.sendSubscribe(session);
        }
    }
    sendResizeNow(session, geometry) {
        if (this.ws?.readyState !== WebSocket.OPEN || !this.pageVisible())
            return;
        this.ws.send(JSON.stringify({
            type: 'resize',
            session,
            cols: geometry.cols,
            rows: geometry.rows,
            client: this.clientInfo(),
        }));
    }
    flushResize(session) {
        if (!this.subs.has(session))
            return;
        const geometry = this.pendingResizeBySession.get(session);
        if (!geometry)
            return;
        this.sendResizeNow(session, geometry);
    }
    flushPendingResizes() {
        if (!this.pageVisible())
            return;
        for (const session of this.subs.keys()) {
            this.flushResize(session);
        }
    }
    connect() {
        if (typeof window === 'undefined')
            return;
        this.bindVisibility();
        this.bindViewport();
        this.cleanup();
        const url = this.getUrl();
        this.ws = new WebSocket(url);
        // Connection timeout — if not open in 8s, kill and retry
        this.connectTimer = setTimeout(() => {
            this.connectTimer = null;
            if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
        }, CONNECT_TIMEOUT);
        this.ws.onopen = () => {
            if (this.connectTimer) {
                clearTimeout(this.connectTimer);
                this.connectTimer = null;
            }
            this.connected = true;
            this.reconnectDelay = RECONNECT_MIN; // reset backoff on success
            this.cancelReconnect();
            this.startPing();
            this.sendClientInfo('open');
            // Re-subscribe all active sessions
            for (const session of this.subs.keys()) {
                this.sendSubscribe(session);
            }
            this.flushPendingResizes();
        };
        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                // Handle pong from server
                if (msg.type === 'pong') {
                    if (this.pongTimer) {
                        clearTimeout(this.pongTimer);
                        this.pongTimer = null;
                    }
                    return;
                }
                if (msg.channel === '__sessions' && msg.type === 'sessions') {
                    const sessions = JSON.parse(msg.data);
                    for (const cb of this.sessionCallbacks) {
                        cb(sessions);
                    }
                    return;
                }
                if (msg.type === 'output' || msg.type === 'history' || msg.type === 'error' || msg.type === 'cursor') {
                    const cbs = this.subs.get(msg.channel);
                    if (cbs) {
                        for (const cb of cbs) {
                            // "cursor" frames carry no data — callbacks that render output
                            // must check `type` before treating data as pane content.
                            cb(msg.data ?? '', msg.type, msg.cursor);
                        }
                    }
                }
            }
            catch { }
        };
        this.ws.onclose = () => {
            this.connected = false;
            this.cleanup();
            this.scheduleReconnect();
        };
        this.ws.onerror = () => {
            this.connected = false;
            this.ws?.close();
        };
    }
    cleanup() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        this.ws = null;
    }
    startPing() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL);
    }
    sendPing() {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify({ type: 'ping', client: this.clientInfo() }));
        // Expect pong within timeout
        if (this.pongTimer)
            clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => {
            this.pongTimer = null;
            // No pong received — connection is dead
            this.ws?.close();
        }, PONG_TIMEOUT);
    }
    cancelReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        if (this.subs.size === 0 && this.sessionCallbacks.size === 0)
            return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.subs.size > 0 || this.sessionCallbacks.size > 0) {
                this.connect();
            }
        }, delay);
    }
    /** Subscribe to a tmux session's output. Returns unsubscribe function. */
    subscribe(session, callback, opts = {}) {
        let set = this.subs.get(session);
        const isNew = !set;
        if (!set) {
            set = new Set();
            this.subs.set(session, set);
        }
        set.add(callback);
        let tails = this.subTails.get(session);
        if (!tails) {
            tails = new Map();
            this.subTails.set(session, tails);
        }
        tails.set(callback, opts.tail && opts.tail > 0 ? Math.floor(opts.tail) : undefined);
        if (isNew) {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.sendClientInfo('subscribe');
                this.sendSubscribe(session);
                this.flushResize(session);
            }
        }
        else {
            this.refreshSubscription(session);
        }
        this.ensureConnection();
        return () => {
            set.delete(callback);
            this.subTails.get(session)?.delete(callback);
            if (set.size === 0) {
                this.subs.delete(session);
                this.subTails.delete(session);
                this.sentTail.delete(session);
                this.pendingResizeBySession.delete(session);
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'unsubscribe', session }));
                }
            }
            else {
                this.refreshSubscription(session);
            }
        };
    }
    /** Subscribe to session list changes (pushed by server every 5s). */
    onSessions(callback) {
        this.sessionCallbacks.add(callback);
        this.ensureConnection();
        return () => {
            this.sessionCallbacks.delete(callback);
        };
    }
    /** Send keys to a session. */
    sendKeys(session, data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            // No client blob here: a keystroke frame is hot-path (~60B vs ~520B) —
            // the server already knows this socket from subscribe/client_info.
            this.ws.send(JSON.stringify({ type: 'keys', session, data }));
        }
    }
    /** Sync terminal size to tmux pane. */
    sendResize(session, cols, rows) {
        this.pendingResizeBySession.set(session, { cols, rows });
        this.ensureConnection();
        this.sendResizeNow(session, { cols, rows });
    }
    /** Expand capture history when the viewer scrolls to the top. */
    requestHistory(session, beforeLine, limit = 500) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'history_expand', session, beforeLine: beforeLine ?? null, limit }));
        }
    }
}
export const tmuxMux = new TmuxMux();
/** Configure the shared singleton (call once at host startup). */
export function configureTmuxMux(opts) {
    tmuxMux.configure(opts);
}
