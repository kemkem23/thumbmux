// Multiplexed WebSocket client for tmux sessions (thumbmux)
// Single WS connection → subscribe/unsubscribe per session.
// Host-specific bits (WS endpoint, extra client-info fields such as a
// telemetry client id) are injected via configureTmuxMux() — the wire format
// itself is part of the thumbmux protocol.

import type { MuxOutputType as OutputType, MuxClientInfo, MuxServerMessage } from '@thumbmux/core';

type Callback = (data: string, type?: OutputType, cursor?: MuxServerMessage['cursor']) => void;
type ClientInfo = MuxClientInfo & Record<string, unknown>;

const PING_INTERVAL = 25_000;    // 25s — under most carrier NAT timeouts (30-60s)
const PONG_TIMEOUT = 8_000;      // 8s — if no pong, assume dead
const CONNECT_TIMEOUT = 8_000;   // 8s — max wait for initial connection
const RECONNECT_MIN = 1_000;     // 1s
const RECONNECT_MAX = 15_000;    // 15s

export type TmuxMuxOptions = {
  /** WS endpoint; default: <ws(s)>://<host>/ws/tmux */
  getUrl?: () => string;
  /** Extra fields merged (top-level) into every client_info payload. */
  getClientMeta?: () => Partial<ClientInfo> | undefined;
};

export class TmuxMux {
  private opts: TmuxMuxOptions = {};
  private ws: WebSocket | null = null;
  private subs = new Map<string, Set<Callback>>();
  /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
  private subTails = new Map<string, Map<Callback, number | undefined>>();
  private sentTail = new Map<string, number | undefined>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCallbacks = new Set<(sessions: any[]) => void>();
  private pendingResizeBySession = new Map<string, { cols: number; rows: number }>();
  private reconnectDelay = RECONNECT_MIN;
  private visibilityBound = false;
  private viewportBound = false;
  private clientInfoTimer: ReturnType<typeof setTimeout> | null = null;
  connected = $state(false);

  configure(opts: TmuxMuxOptions) {
    this.opts = { ...this.opts, ...opts };
  }

  private getUrl(): string {
    if (this.opts.getUrl) return this.opts.getUrl();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/tmux`;
  }

  private ensureConnection() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect();
  }

  private bindVisibility() {
    if (this.visibilityBound || typeof document === 'undefined') return;
    this.visibilityBound = true;
    const handleVisible = () => {
      this.sendClientInfo('visibility');
      if (document.visibilityState === 'visible') {
        // Coming back to foreground — reconnect immediately if dead
        if (!this.ws || (
          this.ws.readyState !== WebSocket.OPEN
          && this.ws.readyState !== WebSocket.CONNECTING
        )) {
          this.cancelReconnect();
          this.reconnectDelay = RECONNECT_MIN;
          this.ensureConnection();
        } else if (this.ws.readyState === WebSocket.OPEN) {
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

  private bindViewport() {
    if (this.viewportBound || typeof window === 'undefined') return;
    this.viewportBound = true;
    const schedule = () => {
      if (this.clientInfoTimer) clearTimeout(this.clientInfoTimer);
      this.clientInfoTimer = setTimeout(() => {
        this.clientInfoTimer = null;
        this.sendClientInfo('viewport');
      }, 250);
    };
    window.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('scroll', schedule, { passive: true });
  }

  private clientInfo(): ClientInfo {
    if (typeof window === 'undefined') return {};
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

  private sendClientInfo(_reason = 'client_info') {
    this.send(this.ws, { type: 'client_info', client: this.clientInfo() });
  }

  /**
   * Send only through the currently-owned open socket. Capturing `socket`
   * before checking it prevents a callback from an older connection from
   * accidentally sending through a newer socket stored in `this.ws`.
   */
  private send(socket: WebSocket | null, message: unknown): boolean {
    if (!socket || this.ws !== socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      // readyState can change between the guard and send (for example while
      // a page is being frozen). The close/error path owns reconnection.
      return false;
    }
  }

  private pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  private effectiveTail(session: string): number | undefined {
    const tails = this.subTails.get(session);
    if (!tails || tails.size === 0) return undefined;
    let max = 0;
    for (const t of tails.values()) {
      if (t === undefined) return undefined; // a full viewer wins
      if (t > max) max = t;
    }
    return max;
  }

  private sendSubscribe(session: string) {
    const tail = this.effectiveTail(session);
    if (this.send(this.ws, { type: 'subscribe', session, tail, client: this.clientInfo() })) {
      this.sentTail.set(session, tail);
    }
  }

  /** Re-subscribe when the tail composition changes (e.g. a full viewer
   * joins a session a thumbnail was already tailing). */
  private refreshSubscription(session: string) {
    if (!this.subs.has(session)) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.sentTail.get(session) !== this.effectiveTail(session)) {
      this.sendSubscribe(session);
    }
  }

  private sendResizeNow(session: string, geometry: { cols: number; rows: number }) {
    if (!this.pageVisible()) return;
    this.send(this.ws, {
      type: 'resize',
      session,
      cols: geometry.cols,
      rows: geometry.rows,
      client: this.clientInfo(),
    });
  }

  private flushResize(session: string) {
    if (!this.subs.has(session)) return;
    const geometry = this.pendingResizeBySession.get(session);
    if (!geometry) return;
    this.sendResizeNow(session, geometry);
  }

  private flushPendingResizes() {
    if (!this.pageVisible()) return;
    for (const session of this.subs.keys()) {
      this.flushResize(session);
    }
  }

  private connect() {
    if (typeof window === 'undefined') return;
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
    } else {
      this.clearConnectionTimers();
    }
    this.connected = false;
    this.cancelReconnect();

    const url = this.getUrl();
    const socket = new WebSocket(url);
    this.ws = socket;

    // Connection timeout — if not open in 8s, kill and retry
    const connectTimer = setTimeout(() => {
      if (this.ws !== socket || this.connectTimer !== connectTimer) return;
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
      if (this.ws !== socket) return;
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
              cb(msg.data ?? '', msg.type as OutputType, msg.cursor);
            }
          }
        }
      } catch {}
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.connected = false;
      this.releaseSocket(socket);
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.connected = false;
      this.closeSocket(socket);
    };
  }

  private clearConnectionTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  }

  private closeSocket(socket: WebSocket) {
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
    try {
      socket.close();
    } catch {
      // Closing is best-effort; a late close callback is identity-guarded.
    }
  }

  private releaseSocket(socket: WebSocket, close = false) {
    const isCurrent = this.ws === socket;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (isCurrent) {
      this.clearConnectionTimers();
      this.ws = null;
    }
    if (close) this.closeSocket(socket);
  }

  private startPing(socket: WebSocket) {
    if (this.ws !== socket) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.sendPing(socket), PING_INTERVAL);
  }

  private sendPing(socket: WebSocket | null = this.ws) {
    if (!socket || !this.send(socket, { type: 'ping', client: this.clientInfo() })) return;
    // Expect pong within timeout
    if (this.pongTimer) clearTimeout(this.pongTimer);
    const pongTimer = setTimeout(() => {
      if (this.ws !== socket || this.pongTimer !== pongTimer) return;
      this.pongTimer = null;
      // No pong received — connection is dead
      this.closeSocket(socket);
    }, PONG_TIMEOUT);
    this.pongTimer = pongTimer;
  }

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.subs.size === 0 && this.sessionCallbacks.size === 0) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);

    const reconnectTimer = setTimeout(() => {
      if (this.reconnectTimer !== reconnectTimer) return;
      this.reconnectTimer = null;
      if (this.subs.size > 0 || this.sessionCallbacks.size > 0) {
        this.ensureConnection();
      }
    }, delay);
    this.reconnectTimer = reconnectTimer;
  }

  /** Subscribe to a tmux session's output. Returns unsubscribe function. */
  subscribe(session: string, callback: Callback, opts: { tail?: number } = {}): () => void {
    let set = this.subs.get(session);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.subs.set(session, set);
    }
    set.add(callback);
    let tails = this.subTails.get(session);
    if (!tails) { tails = new Map(); this.subTails.set(session, tails); }
    tails.set(callback, opts.tail && opts.tail > 0 ? Math.floor(opts.tail) : undefined);

    if (isNew) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendClientInfo('subscribe');
        this.sendSubscribe(session);
        this.flushResize(session);
      }
    } else {
      this.refreshSubscription(session);
    }

    this.ensureConnection();

    return () => {
      set!.delete(callback);
      this.subTails.get(session)?.delete(callback);
      if (set!.size === 0) {
        this.subs.delete(session);
        this.subTails.delete(session);
        this.sentTail.delete(session);
        this.pendingResizeBySession.delete(session);
        this.send(this.ws, { type: 'unsubscribe', session });
      } else {
        this.refreshSubscription(session);
      }
    };
  }

  /** Subscribe to session list changes (pushed by server every 5s).
   * Sends `sessions_subscribe` itself — hosts do NOT need to auto-subscribe
   * sockets server-side (v0.3.1 fix: previously only hosts that subscribed
   * every socket on open ever delivered `__sessions` pushes). */
  onSessions(callback: (sessions: any[]) => void): () => void {
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
  sendKeys(session: string, data: string) {
    // No client blob here: a keystroke frame is hot-path (~60B vs ~520B) —
    // the server already knows this socket from subscribe/client_info.
    this.send(this.ws, { type: 'keys', session, data });
  }

  /** Sync terminal size to tmux pane. */
  sendResize(session: string, cols: number, rows: number) {
    this.pendingResizeBySession.set(session, { cols, rows });
    this.ensureConnection();
    this.sendResizeNow(session, { cols, rows });
  }

  /** Expand capture history when the viewer scrolls to the top. */
  requestHistory(session: string, beforeLine?: number | null, limit = 500) {
    this.send(this.ws, { type: 'history_expand', session, beforeLine: beforeLine ?? null, limit });
  }
}

export const tmuxMux = new TmuxMux();

/** Configure the shared singleton (call once at host startup). */
export function configureTmuxMux(opts: TmuxMuxOptions) {
  tmuxMux.configure(opts);
}
