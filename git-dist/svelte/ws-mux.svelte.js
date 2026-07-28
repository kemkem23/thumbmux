// Multiplexed WebSocket client for tmux sessions (thumbmux)
// Single WS connection → subscribe/unsubscribe per session.
// Host-specific bits (WS endpoint, extra client-info fields such as a
// telemetry client id) are injected via configureTmuxMux() — the wire format
// itself is part of the thumbmux protocol.
import { splitMuxOutputData, } from '../core/index.js';
const PING_INTERVAL = 25_000; // 25s — under most carrier NAT timeouts (30-60s)
const PONG_TIMEOUT = 8_000; // 8s — if no pong, assume dead
const CONNECT_TIMEOUT = 8_000; // 8s — max wait for initial connection
const RECONNECT_MIN = 1_000; // 1s
const RECONNECT_MAX = 15_000; // 15s
const MAX_DEFER_MS = 250;
const MAX_DEFERRED_FRAMES = 64;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const utf8 = new TextEncoder();
const BYTES_OPEN = utf8.encode('[');
const BYTES_CLOSE = utf8.encode(']');
const BYTES_COMMA = utf8.encode(',');
function fnvFeed(hash, bytes) {
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, FNV_PRIME);
    }
    return hash;
}
function finalizeFnv(hash) {
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function defaultScheduleFrame(cb) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => cb());
    }
    else {
        setTimeout(cb, 16);
    }
}
function isMuxCursor(value) {
    if (value === null)
        return true;
    if (typeof value !== 'object' || value === null)
        return false;
    const cursor = value;
    return Number.isInteger(cursor.row) && Number.isInteger(cursor.col);
}
export class TmuxMux {
    opts = {};
    ws = null;
    subs = new Map();
    /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
    subTails = new Map();
    /** per-callback busy probe; absence means "never defer for this session" */
    subDeferProbes = new Map();
    sentTail = new Map();
    /** Exact raw `data.split('\\n')` bases, scoped to the current socket and tail. */
    outputBases = new Map();
    /** Streaming FNV prefix-hash states bound to each base's array identity. */
    prefixHashCaches = new Map();
    /** Raw delta frames held while every subscriber reports busy. */
    deferredDeltas = new Map();
    settleScheduled = false;
    /** A failed delta requests one full replacement; later deltas wait for it. */
    resyncingSessions = new Set();
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
                if (!this.ws || (this.ws.readyState !== WebSocket.OPEN
                    && this.ws.readyState !== WebSocket.CONNECTING)) {
                    this.cancelReconnect();
                    this.reconnectDelay = RECONNECT_MIN;
                    this.ensureConnection();
                }
                else if (this.ws.readyState === WebSocket.OPEN) {
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
        this.send(this.ws, { type: 'client_info', client: this.clientInfo() });
    }
    /**
     * Send only through the currently-owned open socket. Capturing `socket`
     * before checking it prevents a callback from an older connection from
     * accidentally sending through a newer socket stored in `this.ws`.
     */
    send(socket, message) {
        if (!socket || this.ws !== socket || socket.readyState !== WebSocket.OPEN)
            return false;
        try {
            socket.send(JSON.stringify(message));
            return true;
        }
        catch {
            // readyState can change between the guard and send (for example while
            // a page is being frozen). The close/error path owns reconnection.
            return false;
        }
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
        const tail = this.effectiveTail(session);
        // A subscribe can be an initial subscription, reconnect, or tail change.
        // Each asks the server for a new full base before a delta is acceptable.
        this.invalidateOutputBase(session);
        if (this.send(this.ws, {
            type: 'subscribe',
            session,
            tail,
            delta: true,
            client: this.clientInfo(),
        })) {
            this.sentTail.set(session, tail);
        }
    }
    discardDeferred(session) {
        this.deferredDeltas.delete(session);
    }
    discardPrefixHashCache(session) {
        this.prefixHashCaches.delete(session);
    }
    invalidateOutputBase(session) {
        this.outputBases.delete(session);
        this.resyncingSessions.delete(session);
        this.discardPrefixHashCache(session);
        this.discardDeferred(session);
    }
    invalidateAllOutputBases() {
        this.outputBases.clear();
        this.resyncingSessions.clear();
        this.sentTail.clear();
        this.prefixHashCaches.clear();
        this.deferredDeltas.clear();
    }
    requestResync(session) {
        if (this.resyncingSessions.has(session))
            return;
        this.outputBases.delete(session);
        this.discardPrefixHashCache(session);
        this.discardDeferred(session);
        this.resyncingSessions.add(session);
        this.send(this.ws, { type: 'resync', session });
    }
    /**
     * Incremental muxPrefixHash(base.slice(0, prefix)), byte-identical to
     * core's fnv1a32(JSON.stringify(...)). States are bound to the base's
     * array identity — a mismatched reference rebuilds from scratch.
     */
    prefixHash(session, base, prefix) {
        let cache = this.prefixHashCaches.get(session);
        if (!cache || cache.base !== base) {
            cache = { base, states: [] };
            this.prefixHashCaches.set(session, cache);
        }
        if (cache.states.length === 0) {
            cache.states[0] = fnvFeed(FNV_OFFSET, BYTES_OPEN);
        }
        while (cache.states.length <= prefix) {
            const k = cache.states.length;
            let h = cache.states[k - 1];
            if (k > 1)
                h = fnvFeed(h, BYTES_COMMA);
            h = fnvFeed(h, utf8.encode(JSON.stringify(base[k - 1])));
            cache.states[k] = h;
        }
        return finalizeFnv(fnvFeed(cache.states[prefix], BYTES_CLOSE));
    }
    /**
     * Structural checks matching core validateMuxDeltaFrame accept/reject
     * outcomes exactly, but hashing via the incremental cache so a one-line
     * delta is O(changed lines) rather than O(whole base).
     */
    validateDeltaLocal(session, frame, base) {
        if (typeof frame !== 'object' || frame === null)
            return null;
        const candidate = frame;
        if (typeof candidate.channel !== 'string')
            return null;
        if (candidate.type !== 'delta')
            return null;
        const baseLength = candidate.baseLength;
        const prefix = candidate.prefix;
        // Range checks BEFORE hashing so a bogus prefix never indexes out of range
        // or triggers a huge hash.
        if (!Number.isInteger(baseLength) || baseLength !== base.length)
            return null;
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.length) {
            return null;
        }
        const p = prefix;
        if (typeof candidate.prefixHash !== 'string')
            return null;
        if (candidate.prefixHash !== this.prefixHash(session, base, p))
            return null;
        if (!Array.isArray(candidate.lines) || !candidate.lines.every((line) => typeof line === 'string')) {
            return null;
        }
        const cursorPresent = Object.prototype.hasOwnProperty.call(candidate, 'cursor');
        if (cursorPresent && !isMuxCursor(candidate.cursor))
            return null;
        return {
            prefix: p,
            lines: candidate.lines,
            cursor: cursorPresent ? candidate.cursor : undefined,
            cursorPresent,
        };
    }
    /**
     * Apply a validated delta: reconstruct next base, carry hash states
     * [0..prefix], return delivery fields. Null on reject (no side effects
     * other than possibly warming the hash cache up to a valid range check).
     */
    applyValidatedDelta(session, frame, base) {
        const delta = this.validateDeltaLocal(session, frame, base);
        if (!delta)
            return null;
        const next = base.slice(0, delta.prefix).concat(delta.lines);
        const cache = this.prefixHashCaches.get(session);
        if (cache && cache.base === base) {
            this.prefixHashCaches.set(session, {
                base: next,
                states: cache.states.slice(0, delta.prefix + 1),
            });
        }
        else {
            this.prefixHashCaches.delete(session);
        }
        return {
            next,
            cursor: delta.cursor,
            cursorPresent: delta.cursorPresent,
        };
    }
    deliverDelta(session, next, cursor, cbs) {
        const data = next.join('\n');
        this.outputBases.set(session, next);
        for (const cb of cbs) {
            cb(data, 'output', cursor, { source: 'delta', replace: false });
        }
    }
    sessionShouldDefer(session) {
        const cbs = this.subs.get(session);
        if (!cbs || cbs.size === 0)
            return false;
        const probes = this.subDeferProbes.get(session);
        if (!probes)
            return false;
        for (const cb of cbs) {
            const probe = probes.get(cb);
            if (!probe)
                return false;
            try {
                if (!probe())
                    return false;
            }
            catch {
                return false;
            }
        }
        return true;
    }
    scheduleSettle() {
        if (this.settleScheduled)
            return;
        if (this.deferredDeltas.size === 0)
            return;
        this.settleScheduled = true;
        const schedule = this.opts.scheduleFrame ?? defaultScheduleFrame;
        schedule(() => {
            this.settleScheduled = false;
            this.settleDeferred();
        });
    }
    settleDeferred() {
        let needReschedule = false;
        // Snapshot keys — flush mutates the map.
        for (const session of [...this.deferredDeltas.keys()]) {
            const queue = this.deferredDeltas.get(session);
            if (!queue)
                continue;
            const age = Date.now() - queue.firstAt;
            if (!this.sessionShouldDefer(session)
                || age >= MAX_DEFER_MS
                || queue.frames.length >= MAX_DEFERRED_FRAMES) {
                this.flushDeferred(session);
            }
            else {
                needReschedule = true;
            }
        }
        if (needReschedule)
            this.scheduleSettle();
    }
    enqueueDeferredDelta(session, frame) {
        let queue = this.deferredDeltas.get(session);
        if (!queue) {
            queue = { frames: [], firstAt: Date.now() };
            this.deferredDeltas.set(session, queue);
        }
        queue.frames.push(frame);
        if (queue.frames.length >= MAX_DEFERRED_FRAMES) {
            this.flushDeferred(session);
            return;
        }
        this.scheduleSettle();
    }
    /**
     * Apply queued raw deltas in order against successive bases, then deliver
     * ONE coalesced callback with the final content. A rejected frame delivers
     * any content already applied, drops the rest, and requests one resync.
     */
    flushDeferred(session) {
        const queue = this.deferredDeltas.get(session);
        this.deferredDeltas.delete(session);
        if (!queue || queue.frames.length === 0)
            return;
        const cbs = this.subs.get(session);
        if (!cbs || cbs.size === 0)
            return;
        let base = this.outputBases.get(session);
        if (!base || this.resyncingSessions.has(session)) {
            this.requestResync(session);
            return;
        }
        let lastCursor;
        let cursorPresent = false;
        let applied = false;
        for (const frame of queue.frames) {
            const result = this.applyValidatedDelta(session, frame, base);
            if (!result) {
                if (applied) {
                    this.deliverDelta(session, base, cursorPresent ? lastCursor : undefined, cbs);
                }
                this.requestResync(session);
                return;
            }
            base = result.next;
            applied = true;
            if (result.cursorPresent) {
                lastCursor = result.cursor;
                cursorPresent = true;
            }
        }
        if (applied) {
            this.deliverDelta(session, base, cursorPresent ? lastCursor : undefined, cbs);
        }
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
        if (!this.pageVisible())
            return;
        this.send(this.ws, {
            type: 'resize',
            session,
            cols: geometry.cols,
            rows: geometry.rows,
            client: this.clientInfo(),
        });
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
        // Visibility/pageshow and reconnect timers can converge on the same tick.
        // Never replace a healthy or in-flight connection with another one.
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        // A CLOSED/CLOSING socket may not have delivered its close callback (page
        // freeze and mobile network transitions are common examples). Detach it
        // before installing the replacement so late callbacks are harmless.
        if (this.ws) {
            this.releaseSocket(this.ws, true);
        }
        else {
            this.clearConnectionTimers();
        }
        this.connected = false;
        this.cancelReconnect();
        const url = this.getUrl();
        const socket = new WebSocket(url);
        this.ws = socket;
        // Connection timeout — if not open in 8s, kill and retry
        const connectTimer = setTimeout(() => {
            if (this.ws !== socket || this.connectTimer !== connectTimer)
                return;
            this.connectTimer = null;
            if (socket.readyState === WebSocket.CONNECTING) {
                this.closeSocket(socket);
            }
        }, CONNECT_TIMEOUT);
        this.connectTimer = connectTimer;
        socket.onopen = () => {
            if (this.ws !== socket) {
                this.releaseSocket(socket, true);
                return;
            }
            if (this.connectTimer === connectTimer) {
                clearTimeout(this.connectTimer);
                this.connectTimer = null;
            }
            this.connected = true;
            this.reconnectDelay = RECONNECT_MIN; // reset backoff on success
            this.cancelReconnect();
            this.startPing(socket);
            this.sendClientInfo('open');
            // Re-subscribe all active sessions
            for (const session of this.subs.keys()) {
                this.sendSubscribe(session);
            }
            // Re-arm the session-list push across reconnects too.
            if (this.sessionCallbacks.size > 0) {
                this.send(socket, { type: 'sessions_subscribe' });
            }
            this.flushPendingResizes();
        };
        socket.onmessage = (event) => {
            if (this.ws !== socket)
                return;
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
                const cbs = typeof msg.channel === 'string' ? this.subs.get(msg.channel) : undefined;
                if (!cbs)
                    return;
                if (msg.type === 'output') {
                    // A full frame establishes its raw base exactly; in particular, a
                    // trailing empty line and CR bytes remain part of future hashes.
                    // Guard first: a non-string data field is a complete no-op for the
                    // session (do not drop a still-valid deferred queue or hash cache).
                    if (typeof msg.data !== 'string')
                        return;
                    // A full frame supersedes any deferred deltas for this session —
                    // discard without delivering them, then install the new base.
                    this.discardDeferred(msg.channel);
                    this.discardPrefixHashCache(msg.channel);
                    this.outputBases.set(msg.channel, splitMuxOutputData(msg.data));
                    this.resyncingSessions.delete(msg.channel);
                    const meta = {
                        source: 'full',
                        replace: msg.reset === 'resize' || msg.reset === 'resync',
                    };
                    for (const cb of cbs)
                        cb(msg.data, 'output', msg.cursor, meta);
                    return;
                }
                if (msg.type === 'delta') {
                    // Do not let an invalid, missing, or stale base leak either content
                    // or cursor to subscribers. The server answers one coalesced resync
                    // with a full output frame, which re-enables deltas above.
                    const base = this.outputBases.get(msg.channel);
                    if (!base || this.resyncingSessions.has(msg.channel)) {
                        this.requestResync(msg.channel);
                        return;
                    }
                    // Busy-deferral: queue raw frames, no validation/hash/join/callback.
                    if (this.sessionShouldDefer(msg.channel)) {
                        this.enqueueDeferredDelta(msg.channel, msg);
                        return;
                    }
                    // A queue survives a busy-probe flip: the fast path would apply this frame
                    // against the un-advanced base and leave older frames to replay later
                    // against a newer base (silent revert). Enqueue-then-flush keeps every
                    // frame applied against its own successive base, in arrival order.
                    if (this.deferredDeltas.has(msg.channel)) {
                        this.enqueueDeferredDelta(msg.channel, msg);
                        this.flushDeferred(msg.channel);
                        return;
                    }
                    const applied = this.applyValidatedDelta(msg.channel, msg, base);
                    if (!applied) {
                        this.requestResync(msg.channel);
                        return;
                    }
                    this.deliverDelta(msg.channel, applied.next, applied.cursorPresent ? applied.cursor : undefined, cbs);
                    return;
                }
                if (msg.type === 'history' || msg.type === 'error' || msg.type === 'cursor') {
                    // Flush deferred content first so caret/history never lands ahead
                    // of the pane state it belongs to.
                    if (this.deferredDeltas.has(msg.channel)) {
                        this.flushDeferred(msg.channel);
                    }
                    // Re-fetch cbs after flush (subscribers may have changed — unlikely
                    // mid-handler, but the set reference is stable for this path).
                    for (const cb of cbs) {
                        // "cursor" frames carry no data — callbacks that render output
                        // must check `type` before treating data as pane content.
                        cb(msg.data ?? '', msg.type, msg.cursor);
                    }
                }
            }
            catch { }
        };
        socket.onclose = () => {
            if (this.ws !== socket)
                return;
            this.connected = false;
            this.releaseSocket(socket);
            this.scheduleReconnect();
        };
        socket.onerror = () => {
            if (this.ws !== socket)
                return;
            this.connected = false;
            this.closeSocket(socket);
        };
    }
    clearConnectionTimers() {
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
    }
    closeSocket(socket) {
        if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)
            return;
        try {
            socket.close();
        }
        catch {
            // Closing is best-effort; a late close callback is identity-guarded.
        }
    }
    releaseSocket(socket, close = false) {
        const isCurrent = this.ws === socket;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (isCurrent) {
            this.clearConnectionTimers();
            this.ws = null;
            this.invalidateAllOutputBases();
        }
        if (close)
            this.closeSocket(socket);
    }
    startPing(socket) {
        if (this.ws !== socket)
            return;
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.sendPing(socket), PING_INTERVAL);
    }
    sendPing(socket = this.ws) {
        if (!socket || !this.send(socket, { type: 'ping', client: this.clientInfo() }))
            return;
        // Expect pong within timeout
        if (this.pongTimer)
            clearTimeout(this.pongTimer);
        const pongTimer = setTimeout(() => {
            if (this.ws !== socket || this.pongTimer !== pongTimer)
                return;
            this.pongTimer = null;
            // No pong received — connection is dead
            this.closeSocket(socket);
        }, PONG_TIMEOUT);
        this.pongTimer = pongTimer;
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
        const reconnectTimer = setTimeout(() => {
            if (this.reconnectTimer !== reconnectTimer)
                return;
            this.reconnectTimer = null;
            if (this.subs.size > 0 || this.sessionCallbacks.size > 0) {
                this.ensureConnection();
            }
        }, delay);
        this.reconnectTimer = reconnectTimer;
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
        let probes = this.subDeferProbes.get(session);
        if (!probes) {
            probes = new Map();
            this.subDeferProbes.set(session, probes);
        }
        probes.set(callback, opts.deferWhileBusy);
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
            this.subDeferProbes.get(session)?.delete(callback);
            if (set.size === 0) {
                this.subs.delete(session);
                this.subTails.delete(session);
                this.subDeferProbes.delete(session);
                this.sentTail.delete(session);
                this.invalidateOutputBase(session);
                this.pendingResizeBySession.delete(session);
                this.send(this.ws, { type: 'unsubscribe', session });
            }
            else {
                this.refreshSubscription(session);
            }
        };
    }
    /** Subscribe to session list changes (pushed by server every 5s).
     * Sends `sessions_subscribe` itself — hosts do NOT need to auto-subscribe
     * sockets server-side (v0.3.1 fix: previously only hosts that subscribed
     * every socket on open ever delivered `__sessions` pushes). */
    onSessions(callback) {
        const first = this.sessionCallbacks.size === 0;
        this.sessionCallbacks.add(callback);
        this.ensureConnection();
        if (first && this.ws?.readyState === WebSocket.OPEN) {
            this.send(this.ws, { type: 'sessions_subscribe' });
        }
        return () => {
            this.sessionCallbacks.delete(callback);
            if (this.sessionCallbacks.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
                this.send(this.ws, { type: 'sessions_unsubscribe' });
            }
        };
    }
    /** Send keys to a session. */
    sendKeys(session, data) {
        // No client blob here: a keystroke frame is hot-path (~60B vs ~520B) —
        // the server already knows this socket from subscribe/client_info.
        this.send(this.ws, { type: 'keys', session, data });
    }
    /** Sync terminal size to tmux pane. */
    sendResize(session, cols, rows) {
        this.pendingResizeBySession.set(session, { cols, rows });
        this.ensureConnection();
        this.sendResizeNow(session, { cols, rows });
    }
    /** Expand capture history when the viewer scrolls to the top. */
    requestHistory(session, beforeLine, limit = 500) {
        this.send(this.ws, { type: 'history_expand', session, beforeLine: beforeLine ?? null, limit });
    }
}
export const tmuxMux = new TmuxMux();
/** Configure the shared singleton (call once at host startup). */
export function configureTmuxMux(opts) {
    tmuxMux.configure(opts);
}
