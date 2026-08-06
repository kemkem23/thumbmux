// Multiplexed WebSocket client for tmux sessions (thumbmux)
// Single WS connection → subscribe/unsubscribe per session.
// Host-specific bits (WS endpoint, extra client-info fields such as a
// telemetry client id) are injected via configureTmuxMux() — the wire format
// itself is part of the thumbmux protocol.

import {
  splitMuxOutputData,
  type MuxAuthErrorFrame,
  type MuxClientInfo,
  type MuxOutputType as OutputType,
  type MuxPaneScreen,
  type MuxServerMessage,
} from '@thumbmux/core';

export type MuxDeliveryMeta = {
  source: 'full' | 'delta';
  replace: boolean;
  /** Live pane screen mode from the wire (sticky across deltas that omit it). */
  screen?: MuxPaneScreen | null;
};

type Callback = (
  data: string,
  type?: OutputType,
  cursor?: MuxServerMessage['cursor'],
  meta?: MuxDeliveryMeta,
) => void;
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

/** Per-session streaming FNV states for muxPrefixHash of a base array. */
type PrefixHashCache = {
  /** Array identity of the base these states describe. */
  base: string[];
  /**
   * states[0]  = FNV after "["
   * states[k]  = FNV after "[" + json(l0) + "," + … + json(l_{k-1})
   *              (separators between elements only; no trailing "]")
   */
  states: number[];
};

type DeferredQueue = {
  frames: unknown[];
  firstAt: number;
};

const PING_INTERVAL = 25_000;    // 25s — under most carrier NAT timeouts (30-60s)
const PONG_TIMEOUT = 8_000;      // 8s — if no pong, assume dead
const CONNECT_TIMEOUT = 8_000;   // 8s — max wait for initial connection
const RECONNECT_MIN = 1_000;     // 1s
const RECONNECT_MAX = 15_000;    // 15s
const MAX_DEFER_MS = 250;
const MAX_DEFERRED_FRAMES = 64;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const utf8 = new TextEncoder();
const BYTES_OPEN = utf8.encode('[');
const BYTES_CLOSE = utf8.encode(']');
const BYTES_COMMA = utf8.encode(',');

function fnvFeed(hash: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash;
}

function finalizeFnv(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function defaultScheduleFrame(cb: () => void): () => void {
  let active = true;
  if (
    typeof globalThis.requestAnimationFrame === 'function'
    && typeof globalThis.cancelAnimationFrame === 'function'
  ) {
    const frame = globalThis.requestAnimationFrame(() => {
      if (!active) return;
      active = false;
      cb();
    });
    return () => {
      if (!active) return;
      active = false;
      globalThis.cancelAnimationFrame(frame);
    };
  }

  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    cb();
  }, 16);
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
  };
}

function isMuxCursor(value: unknown): value is MuxServerMessage['cursor'] {
  if (value === null) return true;
  if (typeof value !== 'object' || value === null) return false;
  const cursor = value as Record<string, unknown>;
  // Keep lockstep with core protocol.ts isMuxCursor (A1-12: col is 0-based
  // cells, never negative; row may be negative below the last content line).
  // validateDeltaLocal claims to match validateMuxDeltaFrame accept/reject.
  return (
    Number.isInteger(cursor.row)
    && Number.isInteger(cursor.col)
    && (cursor.col as number) >= 0
  );
}

const AUTH_ERROR_EVENT = 'thumbmux:auth-error';

function isMuxAuthError(
  value: unknown,
): value is MuxAuthErrorFrame {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'auth_error'
    && (candidate.status === 401 || candidate.status === 403)
    && typeof candidate.code === 'string';
}

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

export class TmuxMux {
  private opts: TmuxMuxOptions = {};
  private ws: WebSocket | null = null;
  private subs = new Map<string, Set<Callback>>();
  /** per-callback tail preference; effective tail = undefined if ANY full subscriber */
  private subTails = new Map<string, Map<Callback, number | undefined>>();
  /** per-callback busy probe; absence means "never defer for this session" */
  private subDeferProbes = new Map<string, Map<Callback, (() => boolean) | undefined>>();
  private sentTail = new Map<string, number | undefined>();
  /** Exact raw `data.split('\\n')` bases, scoped to the current socket and tail. */
  private outputBases = new Map<string, string[]>();
  /** Streaming FNV prefix-hash states bound to each base's array identity. */
  private prefixHashCaches = new Map<string, PrefixHashCache>();
  /** Raw delta frames held while every subscriber reports busy. */
  private deferredDeltas = new Map<string, DeferredQueue>();
  /**
   * Last known pane screen mode per channel. A delta (or full frame) that
   * omits `screen` reuses this so unchanged repaints do not look like the pane
   * left fullscreen. Cleared with the other per-channel caches.
   */
  private lastScreen = new Map<string, MuxPaneScreen | null>();
  private settleScheduled = false;
  private settleCancel: (() => void) | null = null;
  /** A failed delta requests one full replacement; later deltas wait for it. */
  private resyncingSessions = new Set<string>();
  /** Session leases mapped to the socket that owns the tokenless reply. */
  private historyInflight = new Map<string, WebSocket>();
  /**
   * A6-14: after the last subscriber leaves while a history request is still
   * outstanding, late tokenless replies must not be handed to a later
   * subscriber of the same session name. Cleared on the next requestHistory.
   * Unsolicited history (no prior request / no fence) still delivers so
   * flush-before-history ordering stays intact.
   */
  private historyFenced = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionCallbacks = new Set<(sessions: any[]) => void>();
  private pendingResizeBySession = new Map<string, { cols: number; rows: number }>();
  private reconnectDelay = RECONNECT_MIN;
  private disposed = false;
  private visibilityBound = false;
  private visibilityDocument: Document | null = null;
  private visibilityWindow: Window | null = null;
  private visibilityHandler: (() => void) | null = null;
  private viewportBound = false;
  private viewportWindow: Window | null = null;
  private boundVisualViewport: VisualViewport | null = null;
  private viewportHandler: (() => void) | null = null;
  private clientInfoTimer: ReturnType<typeof setTimeout> | null = null;
  connected = $state(false);

  configure(opts: TmuxMuxOptions) {
    if (this.disposed) return;
    this.opts = { ...this.opts, ...opts };
  }

  private getUrl(): string {
    if (this.opts.getUrl) return this.opts.getUrl();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/tmux`;
  }

  private ensureConnection() {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect();
  }

  private bindVisibility() {
    if (this.disposed || this.visibilityBound || typeof document === 'undefined') return;
    this.visibilityBound = true;
    const boundDocument = document;
    const boundWindow = typeof window === 'undefined' ? null : window;
    const handleVisible = () => {
      if (this.disposed) return;
      this.sendClientInfo('visibility');
      if (boundDocument.visibilityState === 'visible') {
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
    this.visibilityDocument = boundDocument;
    this.visibilityWindow = boundWindow;
    this.visibilityHandler = handleVisible;
    boundDocument.addEventListener('visibilitychange', handleVisible);
    boundWindow?.addEventListener('pageshow', handleVisible);
  }

  private unbindVisibility() {
    if (this.visibilityHandler) {
      this.visibilityDocument?.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityWindow?.removeEventListener('pageshow', this.visibilityHandler);
    }
    this.visibilityDocument = null;
    this.visibilityWindow = null;
    this.visibilityHandler = null;
    this.visibilityBound = false;
  }

  private bindViewport() {
    if (this.disposed || this.viewportBound || typeof window === 'undefined') return;
    this.viewportBound = true;
    const boundWindow = window;
    const boundVisualViewport = boundWindow.visualViewport;
    const schedule = () => {
      if (this.disposed) return;
      if (this.clientInfoTimer) clearTimeout(this.clientInfoTimer);
      this.clientInfoTimer = setTimeout(() => {
        this.clientInfoTimer = null;
        if (this.disposed) return;
        this.sendClientInfo('viewport');
      }, 250);
    };
    this.viewportWindow = boundWindow;
    this.boundVisualViewport = boundVisualViewport;
    this.viewportHandler = schedule;
    boundWindow.addEventListener('resize', schedule, { passive: true });
    boundVisualViewport?.addEventListener('resize', schedule, { passive: true });
    boundVisualViewport?.addEventListener('scroll', schedule, { passive: true });
  }

  private unbindViewport() {
    if (this.viewportHandler) {
      this.viewportWindow?.removeEventListener('resize', this.viewportHandler);
      this.boundVisualViewport?.removeEventListener('resize', this.viewportHandler);
      this.boundVisualViewport?.removeEventListener('scroll', this.viewportHandler);
    }
    this.viewportWindow = null;
    this.boundVisualViewport = null;
    this.viewportHandler = null;
    this.viewportBound = false;
  }

  private clientInfo(): ClientInfo {
    if (typeof window === 'undefined') return {};
    const vv = window.visualViewport;
    const base: ClientInfo = {
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
    };
    // A6-3: getClientMeta throw or non-JSON-safe values must not abort onopen
    // (which would leave an OPEN socket with no pane resubscribe) and must not
    // make JSON.stringify fail inside send() (which drops subscribe frames).
    let meta: Partial<ClientInfo> = {};
    try {
      const raw = this.opts.getClientMeta?.();
      if (raw && typeof raw === 'object') {
        try {
          meta = JSON.parse(JSON.stringify(raw)) as Partial<ClientInfo>;
        } catch {
          meta = {};
        }
      }
    } catch {
      meta = {};
    }
    return { ...base, ...meta };
  }

  private sendClientInfo(_reason = 'client_info') {
    if (this.disposed) return;
    this.send(this.ws, { type: 'client_info', client: this.clientInfo() });
  }

  /**
   * Send only through the currently-owned open socket. Capturing `socket`
   * before checking it prevents a callback from an older connection from
   * accidentally sending through a newer socket stored in `this.ws`.
   */
  private send(socket: WebSocket | null, message: unknown): boolean {
    if (this.disposed || !socket || this.ws !== socket || socket.readyState !== WebSocket.OPEN) return false;
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

  private discardDeferred(session: string) {
    this.deferredDeltas.delete(session);
  }

  private discardPrefixHashCache(session: string) {
    this.prefixHashCaches.delete(session);
  }

  private discardLastScreen(session: string) {
    this.lastScreen.delete(session);
  }

  /**
   * When a full/delta frame carries `screen`, remember it for this channel.
   * Malformed values are ignored so a bad sample cannot poison the sticky
   * last-known mode.
   */
  private rememberScreen(session: string, frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    if (!Object.prototype.hasOwnProperty.call(frame, 'screen')) return;
    const screen = (frame as { screen: unknown }).screen;
    if (screen === null) {
      this.lastScreen.set(session, null);
      return;
    }
    if (
      typeof screen === 'object'
      && screen !== null
      && typeof (screen as MuxPaneScreen).alt === 'boolean'
      && typeof (screen as MuxPaneScreen).mouseSgr === 'boolean'
      && typeof (screen as MuxPaneScreen).mouseAny === 'boolean'
    ) {
      this.lastScreen.set(session, screen as MuxPaneScreen);
    }
  }

  /** Build delivery meta, attaching last-known screen when one exists. */
  private deliveryMeta(
    source: 'full' | 'delta',
    replace: boolean,
    session: string,
  ): MuxDeliveryMeta {
    const meta: MuxDeliveryMeta = { source, replace };
    if (this.lastScreen.has(session)) {
      meta.screen = this.lastScreen.get(session);
    }
    return meta;
  }

  private invalidateOutputBase(session: string) {
    this.outputBases.delete(session);
    this.resyncingSessions.delete(session);
    this.discardPrefixHashCache(session);
    this.discardDeferred(session);
    this.discardLastScreen(session);
  }

  private invalidateAllOutputBases() {
    this.outputBases.clear();
    this.resyncingSessions.clear();
    this.sentTail.clear();
    this.prefixHashCaches.clear();
    this.deferredDeltas.clear();
    this.lastScreen.clear();
  }

  private requestResync(session: string) {
    if (this.resyncingSessions.has(session)) return;
    this.outputBases.delete(session);
    this.discardPrefixHashCache(session);
    this.discardDeferred(session);
    this.discardLastScreen(session);
    this.resyncingSessions.add(session);
    this.send(this.ws, { type: 'resync', session });
  }

  /**
   * Incremental muxPrefixHash(base.slice(0, prefix)), byte-identical to
   * core's fnv1a32(JSON.stringify(...)). States are bound to the base's
   * array identity — a mismatched reference rebuilds from scratch.
   */
  private prefixHash(session: string, base: string[], prefix: number): string {
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
      let h = cache.states[k - 1]!;
      if (k > 1) h = fnvFeed(h, BYTES_COMMA);
      h = fnvFeed(h, utf8.encode(JSON.stringify(base[k - 1])));
      cache.states[k] = h;
    }
    return finalizeFnv(fnvFeed(cache.states[prefix]!, BYTES_CLOSE));
  }

  /**
   * Structural checks matching core validateMuxDeltaFrame accept/reject
   * outcomes exactly, but hashing via the incremental cache so a one-line
   * delta is O(changed lines) rather than O(whole base).
   */
  private validateDeltaLocal(
    session: string,
    frame: unknown,
    base: string[],
  ): {
    prefix: number;
    lines: string[];
    cursor: MuxServerMessage['cursor'] | undefined;
    cursorPresent: boolean;
  } | null {
    if (typeof frame !== 'object' || frame === null) return null;
    const candidate = frame as Record<string, unknown>;
    if (typeof candidate.channel !== 'string') return null;
    if (candidate.type !== 'delta') return null;
    const baseLength = candidate.baseLength;
    const prefix = candidate.prefix;
    // Range checks BEFORE hashing so a bogus prefix never indexes out of range
    // or triggers a huge hash.
    if (!Number.isInteger(baseLength) || baseLength !== base.length) return null;
    if (!Number.isInteger(prefix) || (prefix as number) < 0 || (prefix as number) > base.length) {
      return null;
    }
    const p = prefix as number;
    if (typeof candidate.prefixHash !== 'string') return null;
    if (candidate.prefixHash !== this.prefixHash(session, base, p)) return null;
    if (!Array.isArray(candidate.lines) || !candidate.lines.every((line) => typeof line === 'string')) {
      return null;
    }
    const cursorPresent = Object.prototype.hasOwnProperty.call(candidate, 'cursor');
    if (cursorPresent && !isMuxCursor(candidate.cursor)) return null;

    return {
      prefix: p,
      lines: candidate.lines as string[],
      cursor: cursorPresent ? (candidate.cursor as MuxServerMessage['cursor']) : undefined,
      cursorPresent,
    };
  }

  /**
   * Apply a validated delta: reconstruct next base, carry hash states
   * [0..prefix], return delivery fields. Null on reject (no side effects
   * other than possibly warming the hash cache up to a valid range check).
   */
  private applyValidatedDelta(
    session: string,
    frame: unknown,
    base: string[],
  ): {
    next: string[];
    cursor: MuxServerMessage['cursor'] | undefined;
    cursorPresent: boolean;
  } | null {
    const delta = this.validateDeltaLocal(session, frame, base);
    if (!delta) return null;
    const next = base.slice(0, delta.prefix).concat(delta.lines);
    const cache = this.prefixHashCaches.get(session);
    if (cache && cache.base === base) {
      this.prefixHashCaches.set(session, {
        base: next,
        states: cache.states.slice(0, delta.prefix + 1),
      });
    } else {
      this.prefixHashCaches.delete(session);
    }
    return {
      next,
      cursor: delta.cursor,
      cursorPresent: delta.cursorPresent,
    };
  }

  private deliverDelta(
    session: string,
    next: string[],
    cursor: MuxServerMessage['cursor'] | undefined,
    cbs: Set<Callback>,
  ) {
    const data = next.join('\n');
    this.outputBases.set(session, next);
    const meta = this.deliveryMeta('delta', false, session);
    for (const cb of cbs) {
      cb(data, 'output', cursor, meta);
    }
  }

  private sessionShouldDefer(session: string): boolean {
    const cbs = this.subs.get(session);
    if (!cbs || cbs.size === 0) return false;
    const probes = this.subDeferProbes.get(session);
    if (!probes) return false;
    for (const cb of cbs) {
      const probe = probes.get(cb);
      if (!probe) return false;
      try {
        if (!probe()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private scheduleSettle() {
    if (this.disposed) return;
    if (this.settleScheduled) return;
    if (this.deferredDeltas.size === 0) return;
    this.settleScheduled = true;
    const settle = () => {
      this.settleCancel = null;
      this.settleScheduled = false;
      if (this.disposed) return;
      this.settleDeferred();
    };
    if (this.opts.scheduleFrame) {
      // An injected scheduler owns its own queue; the callback's disposed
      // guard makes already-queued work inert.
      this.opts.scheduleFrame(settle);
    } else {
      this.settleCancel = defaultScheduleFrame(settle);
    }
  }

  private settleDeferred() {
    if (this.disposed) return;
    let needReschedule = false;
    // Snapshot keys — flush mutates the map.
    for (const session of [...this.deferredDeltas.keys()]) {
      const queue = this.deferredDeltas.get(session);
      if (!queue) continue;
      const age = Date.now() - queue.firstAt;
      if (
        !this.sessionShouldDefer(session)
        || age >= MAX_DEFER_MS
        || queue.frames.length >= MAX_DEFERRED_FRAMES
      ) {
        this.flushDeferred(session);
      } else {
        needReschedule = true;
      }
    }
    if (needReschedule) this.scheduleSettle();
  }

  private enqueueDeferredDelta(session: string, frame: unknown) {
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
  private flushDeferred(session: string) {
    const queue = this.deferredDeltas.get(session);
    this.deferredDeltas.delete(session);
    if (!queue || queue.frames.length === 0) return;

    const cbs = this.subs.get(session);
    if (!cbs || cbs.size === 0) return;

    let base = this.outputBases.get(session);
    if (!base || this.resyncingSessions.has(session)) {
      this.requestResync(session);
      return;
    }

    let lastCursor: MuxServerMessage['cursor'] | undefined;
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
      this.rememberScreen(session, frame);
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
    if (this.disposed || typeof window === 'undefined') return;
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
    // getUrl is host-controlled and may dispose this mux reentrantly.
    if (this.disposed) return;
    const socket = new WebSocket(url);
    // Native WebSocket construction is synchronous and non-reentrant, but a
    // host polyfill may dispose the mux from its constructor.
    if (this.disposed) {
      this.closeSocket(socket);
      return;
    }
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
        if (isMuxAuthError(msg)) {
          // Guard denials are connection-scoped and deliberately have no
          // channel. Surface them before channel routing so browser hosts can
          // observe the denial instead of receiving silence.
          if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT, { detail: msg }));
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
        // History replies have no request token or direction marker. Release
        // the per-session wire gate before subscriber callbacks so a callback
        // can request the next page synchronously. Do this before the no-subs
        // return too: a reply racing an unsubscribe still settles the request.
        // A6-14: if the last subscriber left while a request was outstanding,
        // historyFenced drops late replies so they cannot land on a later
        // subscriber. Unsolicited history (no fence) still delivers — the
        // deferred-queue flush-before-history contract depends on that.
        if (msg.type === 'history' && typeof msg.channel === 'string') {
          const wasInflight = this.historyInflight.get(msg.channel) === socket;
          if (wasInflight) this.historyInflight.delete(msg.channel);
          if (!wasInflight && this.historyFenced.has(msg.channel)) {
            return;
          }
          // A matched inflight reply consumes any fence for this generation.
          if (wasInflight) this.historyFenced.delete(msg.channel);
        }
        const cbs = typeof msg.channel === 'string' ? this.subs.get(msg.channel) : undefined;
        if (!cbs) return;

        if (msg.type === 'output') {
          // A full frame establishes its raw base exactly; in particular, a
          // trailing empty line and CR bytes remain part of future hashes.
          // Guard first: a non-string data field is a complete no-op for the
          // session (do not drop a still-valid deferred queue or hash cache).
          if (typeof msg.data !== 'string') return;
          // A full frame supersedes any deferred deltas for this session —
          // discard without delivering them, then install the new base.
          this.discardDeferred(msg.channel);
          this.discardPrefixHashCache(msg.channel);
          this.outputBases.set(msg.channel, splitMuxOutputData(msg.data));
          this.resyncingSessions.delete(msg.channel);
          this.rememberScreen(msg.channel, msg);
          const meta = this.deliveryMeta(
            'full',
            msg.reset === 'resize' || msg.reset === 'resync',
            msg.channel,
          );
          for (const cb of cbs) cb(msg.data, 'output', msg.cursor, meta);
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
          // Screen is remembered at flush time (with each applied frame) so a
          // deferred delta still updates sticky mode before delivery.
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
          this.rememberScreen(msg.channel, msg);
          this.deliverDelta(
            msg.channel,
            applied.next,
            applied.cursorPresent ? applied.cursor : undefined,
            cbs,
          );
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
            cb(msg.data ?? '', msg.type as OutputType, msg.cursor);
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
      this.invalidateAllOutputBases();
    }
    if (close) this.closeSocket(socket);
  }

  private startPing(socket: WebSocket) {
    if (this.disposed || this.ws !== socket) return;
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
    if (this.disposed) return;
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

  /**
   * Permanently release every resource owned by this mux. Disposal is
   * idempotent; a disposed instance deliberately cannot reconnect or accept
   * new subscriptions.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.unbindVisibility();
    this.unbindViewport();
    this.cancelReconnect();
    if (this.clientInfoTimer) {
      clearTimeout(this.clientInfoTimer);
      this.clientInfoTimer = null;
    }
    if (this.settleCancel) {
      try {
        this.settleCancel();
      } catch {
        // Browser frame/timer cancellation is best-effort.
      }
      this.settleCancel = null;
    }
    this.settleScheduled = false;

    const socket = this.ws;
    if (socket) {
      this.releaseSocket(socket, true);
    } else {
      this.clearConnectionTimers();
      this.invalidateAllOutputBases();
    }
    this.connected = false;

    for (const callbacks of this.subs.values()) callbacks.clear();
    this.subs.clear();
    this.subTails.clear();
    this.subDeferProbes.clear();
    this.sessionCallbacks.clear();
    this.pendingResizeBySession.clear();
    this.deferredDeltas.clear();
    this.historyInflight.clear();
    this.historyFenced.clear();
    this.opts = {};
  }

  /** Subscribe to a tmux session's output. Returns unsubscribe function. */
  subscribe(session: string, callback: Callback, opts: SubscribeOpts = {}): () => void {
    if (this.disposed) return () => {};
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
    let probes = this.subDeferProbes.get(session);
    if (!probes) { probes = new Map(); this.subDeferProbes.set(session, probes); }
    probes.set(callback, opts.deferWhileBusy);

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

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.subs.get(session) !== set) return;
      set!.delete(callback);
      this.subTails.get(session)?.delete(callback);
      this.subDeferProbes.get(session)?.delete(callback);
      if (set!.size === 0) {
        this.subs.delete(session);
        this.subTails.delete(session);
        this.subDeferProbes.delete(session);
        this.sentTail.delete(session);
        this.invalidateOutputBase(session);
        this.pendingResizeBySession.delete(session);
        // A6-14: if a history request is still outstanding, fence late replies
        // so they cannot deliver into a later subscriber of this session name.
        if (this.historyInflight.has(session)) {
          this.historyFenced.add(session);
        }
        this.historyInflight.delete(session);
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
    if (this.disposed) return () => {};
    const first = this.sessionCallbacks.size === 0;
    this.sessionCallbacks.add(callback);
    this.ensureConnection();
    if (first && this.ws?.readyState === WebSocket.OPEN) {
      this.send(this.ws, { type: 'sessions_subscribe' });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.sessionCallbacks.delete(callback)) return;
      if (this.sessionCallbacks.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.send(this.ws, { type: 'sessions_unsubscribe' });
      }
    };
  }

  /** Send keys to a session. */
  sendKeys(session: string, data: string) {
    if (this.disposed) return;
    // No client blob here: a keystroke frame is hot-path (~60B vs ~520B) —
    // the server already knows this socket from subscribe/client_info.
    this.send(this.ws, { type: 'keys', session, data });
  }

  /** Sync terminal size to tmux pane. */
  sendResize(session: string, cols: number, rows: number) {
    if (this.disposed) return;
    this.pendingResizeBySession.set(session, { cols, rows });
    this.ensureConnection();
    this.sendResizeNow(session, { cols, rows });
  }

  private sendHistoryRequest(
    session: string,
    cursor: { beforeLine: number | null } | { afterLine: number | null },
    limit?: number,
  ): boolean {
    if (this.disposed || this.historyInflight.has(session)) return false;
    const socket = this.ws;
    if (!socket) return false;

    // Mark before send so even a synchronous WebSocket test double cannot
    // deliver the reply before the gate exists. Roll back a dropped/failed
    // send; only frames actually written to this socket count as in-flight.
    // A new request also lifts an A6-14 fence from a prior generation.
    this.historyFenced.delete(session);
    this.historyInflight.set(session, socket);
    if (!this.send(socket, {
      type: 'history_expand',
      session,
      ...cursor,
      ...(limit === undefined ? {} : { limit }),
    })) {
      if (this.historyInflight.get(session) === socket) {
        this.historyInflight.delete(session);
      }
      return false;
    }
    return true;
  }

  /** Expand capture history when the viewer scrolls to the top. */
  requestHistory(session: string, beforeLine?: number | null, limit = 500): boolean {
    return this.sendHistoryRequest(session, { beforeLine: beforeLine ?? null }, limit);
  }

  /** Page archived capture history forward from an exclusive line anchor. */
  requestHistoryAfter(session: string, afterLine: number | null, limit?: number): boolean {
    return this.sendHistoryRequest(session, { afterLine }, limit);
  }

  /**
   * Fence an abandoned tokenless history request before its caller retries.
   * If its socket is still current, replace the whole multiplexed socket;
   * otherwise that socket is already fenced and only its stale lease remains.
   */
  recoverHistoryRequest(session: string): boolean {
    if (this.disposed) return false;
    const requestSocket = this.historyInflight.get(session);
    if (!requestSocket) return false;
    this.historyInflight.delete(session);

    // A normal disconnect may already have fenced the request's wire. Its
    // lease deliberately survived that replacement so another caller could
    // not consume a new reply while the original caller still considered its
    // request active. Settling that stale lease must not retire the new wire.
    if (this.ws !== requestSocket) return true;

    this.connected = false;
    this.cancelReconnect();
    this.releaseSocket(requestSocket, true);
    this.reconnectDelay = RECONNECT_MIN;
    try {
      this.ensureConnection();
    } catch {
      // The ambiguous wire is already fenced and its lease is settled. Treat
      // replacement setup as best-effort so the boolean recovery contract
      // remains represented even when a host URL/socket factory throws.
    }
    return true;
  }
}

export const tmuxMux = new TmuxMux();

/** Configure the shared singleton (call once at host startup). */
export function configureTmuxMux(opts: TmuxMuxOptions) {
  tmuxMux.configure(opts);
}
