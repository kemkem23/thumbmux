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
import type { MuxClientMessage, MuxServerMessage } from "@thumbmux/core";

export type WsLike = { send(data: string): unknown };

export interface TmuxDriver {
  listSessions(): unknown[];
  capturePane(session: string, opts: { startLine?: number; currentPaneOnly?: boolean }): Promise<string>;
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
  captureWithCursor?(
    session: string,
    opts: { startLine?: number; currentPaneOnly?: boolean },
  ): Promise<{ content: string; cursor: RawCursorState | null; trailingBlanks: number }>;
}

/** tmux cursor sample: cell coords within the visible pane + visibility
 * (#{cursor_flag} && !#{pane_in_mode} — hidden cursor or copy-mode = not
 * visible, viewers draw no caret). */
export type RawCursorState = { x: number; y: number; paneHeight: number; visible: boolean };

export interface PipeManagerLike {
  startPipe(
    session: string,
    onData: (data: string) => void,
    onBroken: () => void,
    onRestarted: () => void,
  ): boolean;
  stopPipe(session: string): void;
  handleRename(session: string): void;
}

export interface HistoryArchiveLike {
  ingestSnapshot(
    session: string,
    content: string,
    opts: { previousContent: string | null; fullHistory: boolean; liveLineLimit: number },
  ): { liveContent: string };
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
  onResizeTelemetry?(
    session: string,
    ws: WS | null,
    geometry: { cols: number; rows: number },
    client: unknown,
  ): void;
  /** Resize arbitration — consulted only for resizable profiles. Return
   * {apply:false} to suppress (e.g. a mobile viewer holds the geometry). */
  onResizeRequest?(
    session: string,
    ws: WS | null,
    geometry: { cols: number; rows: number },
    client: unknown,
  ): { apply: boolean };
}

export type TmuxWsMuxOptions<WS extends WsLike = WsLike> = {
  driver: TmuxDriver;
  pipes?: PipeManagerLike | null;
  archive?: HistoryArchiveLike | null;
  hooks?: MuxHooks<WS>;
  profile?: (session: string) => SessionProfile;
  /** live scrollback window (lines) kept in the fast path */
  liveLineLimit?: number;
  pollNormalMs?: number;      // default 250 (4 FPS)
  pollBurstMs?: number;       // default 100 (10 FPS after keystroke)
  burstDurationMs?: number;   // default 5000
  sessionListIntervalMs?: number; // default 5000
  pipeReconcileMs?: number;
  /** unpiped sessions: max ms between reconcile captures when the
   * (second-resolution) tmux activity gate reports no change */
  pollReconcileMs?: number;   // default 3000
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
};

const DEFAULT_PROFILE: SessionProfile = { resize: true, currentPaneOnly: false, archive: true };

export class TmuxWsMux<WS extends WsLike = WsLike> {
  private driver: TmuxDriver;
  private pipes: PipeManagerLike | null;
  private archive: HistoryArchiveLike | null;
  private hooks: MuxHooks<WS>;
  private profileOf: (session: string) => SessionProfile;
  private liveLineLimit: number;
  private POLL_NORMAL: number;
  private POLL_BURST: number;
  private BURST_DURATION: number;
  private SESSION_LIST_INTERVAL: number;
  private PIPE_RECONCILE_INTERVAL: number;
  private POLL_RECONCILE: number;
  private INITIAL_CAPTURE_START_LINE: number;
  private DEFAULT_CAPTURE_START_LINE: number;
  private log: (...args: unknown[]) => void;
  private logError: (...args: unknown[]) => void;

  private subscribers = new Map<string, Set<WS>>();
  private sessionListSubscribers = new Set<WS>();
  private contents = new Map<string, string>();
  private hashes = new Map<string, string>();
  private lastActivity = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionListInterval: ReturnType<typeof setInterval> | null = null;
  private lastSessionsJson = "";
  private inFlight = false;
  private currentRate: number;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  private piped = new Set<string>();
  private immediateCaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queuedCapturesInFlight = new Set<string>();
  private queuedCapturesPending = new Set<string>();
  private queuedCapturesFullHistory = new Set<string>();
  private captureStartLines = new Map<string, number>();
  private archiveSeeded = new Set<string>();
  private lastReconcileCapture = new Map<string, number>();
  private lastAppliedGeometry = new Map<string, { cols: number; rows: number }>();
  private sessionListProvider: () => unknown[];
  /** per-session, per-socket tail preference (undefined = full snapshots) */
  private tails = new Map<string, Map<WS, number>>();
  /** last cursor broadcast per session — attached to cached first paints so
   * a new viewer of a static pane still gets a caret */
  private lastCursor = new Map<string, { row: number; col: number } | null>();
  private pipeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pipeMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollCounter = 0;

  constructor(opts: TmuxWsMuxOptions<WS>) {
    this.driver = opts.driver;
    this.pipes = opts.pipes ?? null;
    this.archive = opts.archive ?? null;
    this.hooks = opts.hooks ?? {};
    this.profileOf = opts.profile ?? (() => DEFAULT_PROFILE);
    this.liveLineLimit = opts.liveLineLimit ?? 2000;
    this.POLL_NORMAL = opts.pollNormalMs ?? 250;
    this.POLL_BURST = opts.pollBurstMs ?? 100;
    this.BURST_DURATION = opts.burstDurationMs ?? 5000;
    this.SESSION_LIST_INTERVAL = opts.sessionListIntervalMs ?? 5000;
    this.PIPE_RECONCILE_INTERVAL = opts.pipeReconcileMs ?? 10_000;
    this.POLL_RECONCILE = opts.pollReconcileMs ?? 3000;
    this.INITIAL_CAPTURE_START_LINE = -Math.min(250, this.liveLineLimit);
    this.DEFAULT_CAPTURE_START_LINE = -this.liveLineLimit;
    this.currentRate = this.POLL_NORMAL;
    this.log = opts.log ?? (() => {});
    this.logError = opts.logError ?? console.error;
    this.sessionListProvider = () => this.driver.listSessions();
  }

  setSessionListProvider(provider?: () => unknown[]) {
    this.sessionListProvider = provider ?? (() => this.driver.listSessions());
    this.lastSessionsJson = "";
  }

  subscribe(session: string, ws: WS, client?: unknown, opts: { tail?: number } = {}) {
    this.hooks.onSubscribe?.(session, ws, client);
    let set = this.subscribers.get(session);
    if (!set) {
      set = new Set();
      this.subscribers.set(session, set);
    }

    set.add(ws);
    // Tail mode (thumbnails): stream only the last N lines to this socket.
    // A later full subscribe from the same socket upgrades it.
    if (opts.tail && opts.tail > 0) {
      let t = this.tails.get(session);
      if (!t) { t = new Map(); this.tails.set(session, t); }
      t.set(ws, Math.floor(opts.tail));
    } else {
      this.tails.get(session)?.delete(ws);
    }
    const profile = this.profileOf(session);
    const cachedContent = this.contents.get(session);
    if (cachedContent !== undefined) {
      try {
        ws.send(JSON.stringify({
          channel: session, type: "output",
          data: this.contentFor(session, ws, cachedContent),
          cursor: this.lastCursor.get(session) ?? null,
        } satisfies MuxServerMessage));
      } catch {}
      // Cached pane content is only a fast first paint. Always follow it with a
      // real capture so a reopened terminal cannot stay behind the live tmux pane
      // if pipe-pane missed a signal while another viewer kept the cache alive.
      // Widen the refresh back to the full live scrollback window; otherwise a
      // cache kept alive by another viewer can stay stuck on the small initial
      // capture window and make terminal scrolling feel truncated.
      const wantsArchive = profile.archive && !this.archiveSeeded.has(session) && !(opts.tail && opts.tail > 0);
      this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
      this.queueCapture(session, { fullHistory: wantsArchive });
    } else {
      const wantsArchive = profile.archive && !this.archiveSeeded.has(session) && !(opts.tail && opts.tail > 0);
      this.captureStartLines.set(session, this.INITIAL_CAPTURE_START_LINE);
      this.queueCapture(session, { fullHistory: wantsArchive });
    }
    this.ensurePolling();
    this.refreshSessionListSchedule();

    // Start pipe if not already piped
    if (!this.piped.has(session)) {
      this.tryStartPipe(session);
    }
  }

  unsubscribe(session: string, ws: WS, client?: unknown) {
    this.hooks.onUnsubscribe?.(session, ws, client);
    this.tails.get(session)?.delete(ws);
    const set = this.subscribers.get(session);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }

  unsubscribeAll(ws: WS) {
    this.hooks.onSocketClose?.(ws);
    this.sessionListSubscribers.delete(ws);
    for (const t of this.tails.values()) t.delete(ws);
    for (const [session, set] of this.subscribers) {
      set.delete(ws);
      if (set.size === 0) {
        this.dropSessionState(session);
      }
    }
    this.maybeStopPolling();
    this.refreshSessionListSchedule();
  }

  /** Map a raw tmux cursor sample onto the content-anchored protocol
   * convention: row = lines up from the last content line, so client buffers
   * that trim trailing blanks still land the caret on the right line.
   * `trailingBlanks` MUST be counted on the raw untrimmed capture (the
   * captureWithCursor contract); deriving it from trimmed content yields 0
   * and displaces the caret upward by the real blank-row count — the exact
   * production bug this replaced. */
  private mapRawCursor(raw: RawCursorState | null, trailingBlanks: number): { row: number; col: number } | null {
    if (!raw || !raw.visible) return null;
    // May go NEGATIVE (bounded below by -trailingBlanks): a cursor resting on
    // a blank row below the last content line — a shell waiting after output
    // that ended in \n, `read`, a heredoc — is |row| rows BELOW the anchor.
    // Clamping to 0 here would silently draw the caret a row too high.
    const row = raw.paneHeight - 1 - trailingBlanks - raw.y;
    return { row, col: Math.max(0, raw.x) };
  }

  /** Trailing blank lines of a raw capture. Gotcha (thanks, issue #1):
   * `capture-pane -p` ends with a trailing newline, so a naive split() yields
   * a phantom "" that shifts the cursor up a row — strip exactly one. */
  private countTrailingBlanks(rawCapture: string): number {
    const lines = rawCapture.replace(/\n$/, "").split("\n");
    let last = lines.length;
    while (last > 0 && (lines[last - 1] ?? "").trim() === "") last--;
    return lines.length - last;
  }

  private cursorEq(a: { row: number; col: number } | null | undefined, b: { row: number; col: number } | null | undefined): boolean {
    const x = a ?? null, y = b ?? null;
    if (x === null || y === null) return x === y;
    return x.row === y.row && x.col === y.col;
  }

  /** Tear down every timer this instance owns (poll, session list, burst,
   * immediate captures, pipe debounces) and stop active pipes. For hosts
   * that create short-lived muxes (tests, per-request servers). */
  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.sessionListInterval) { clearInterval(this.sessionListInterval); this.sessionListInterval = null; }
    if (this.burstTimer) { clearTimeout(this.burstTimer); this.burstTimer = null; }
    for (const t of this.immediateCaptureTimers.values()) clearTimeout(t);
    this.immediateCaptureTimers.clear();
    for (const t of this.pipeDebounceTimers.values()) clearTimeout(t);
    this.pipeDebounceTimers.clear();
    for (const t of this.pipeMaxTimers.values()) clearTimeout(t);
    this.pipeMaxTimers.clear();
    for (const session of this.piped) this.pipes?.stopPipe(session);
    this.piped.clear();
  }

  /** Slice to a socket's tail preference (full content when none). Trailing
   * blank viewport rows are trimmed first — a fresh 24-row pane ends in ~20
   * empty lines, and slicing those would hand thumbnails pure blankness
   * (caught by the conformance suite). */
  private contentFor(session: string, ws: WS, content: string): string {
    const tail = this.tails.get(session)?.get(ws);
    if (!tail) return content;
    const lines = content.split("\n");
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
    if (end === 0) return "";
    return lines.slice(Math.max(0, end - tail), end).join("\n");
  }

  private dropSessionState(session: string) {
    this.subscribers.delete(session);
    this.tails.delete(session);
    this.lastCursor.delete(session);
    this.contents.delete(session);
    this.hashes.delete(session);
    this.lastActivity.delete(session);
    this.captureStartLines.delete(session);
    this.clearImmediateCapture(session);
    this.queuedCapturesPending.delete(session);
    this.queuedCapturesInFlight.delete(session);
    this.queuedCapturesFullHistory.delete(session);
    this.lastReconcileCapture.delete(session);
    this.lastAppliedGeometry.delete(session);
    if (this.piped.has(session)) {
      this.pipes?.stopPipe(session);
      this.piped.delete(session);
    }
  }

  subscribeSessions(ws: WS) {
    this.sessionListSubscribers.add(ws);
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      this.lastSessionsJson = json;
      ws.send(JSON.stringify({ channel: "__sessions", type: "sessions", data: json } satisfies MuxServerMessage));
    } catch (e: any) {
      this.logError("[thumbmux-mux] subscribeSessions error:", e.message);
    }
    this.refreshSessionListSchedule();
  }

  unsubscribeSessions(ws: WS) {
    this.sessionListSubscribers.delete(ws);
    this.refreshSessionListSchedule();
  }

  /** Handle resize. Browser-authoritative geometry for resizable profiles;
   * the host's onResizeRequest hook may suppress the request (e.g. a
   * mobile-first size arbiter). */
  handleResize(session: string, cols: number, rows: number, ws?: WS, client?: unknown) {
    this.hooks.onResizeTelemetry?.(session, ws ?? null, { cols, rows }, client);
    if (!this.profileOf(session).resize) return;

    const verdict = this.hooks.onResizeRequest?.(session, ws ?? null, { cols, rows }, client) ?? { apply: true };
    if (!verdict.apply) return;

    this.applyGeometry(session, cols, rows, ws);
  }

  /** Actually resize tmux + refresh captures. Also used by host policy (size
   * arbiter) to re-apply a surviving viewer's geometry after a hold releases. */
  applyGeometry(session: string, cols: number, rows: number, ws?: WS) {
    try {
      const last = this.lastAppliedGeometry.get(session);
      if (last?.cols === cols && last.rows === rows) return;
      this.driver.resizeWindow(session, cols, rows);
      this.lastAppliedGeometry.set(session, { cols, rows });
      this.captureStartLines.set(session, this.INITIAL_CAPTURE_START_LINE);
      this.queueCapture(session, { fullHistory: false });
      this.refreshSessionListSchedule();
    } catch (e: any) {
      this.logError(`[thumbmux-mux] resize error for "${session}" to ${cols}x${rows}:`, e.message);
      try {
        ws?.send(JSON.stringify({
          channel: session,
          type: "error",
          data: e.message ?? String(e),
        } satisfies MuxServerMessage));
      } catch {}
    }
  }

  handleKeys(session: string, data: string, ws?: WS, client?: unknown) {
    if (ws) this.hooks.onKeys?.(session, ws, client);
    try {
      this.driver.sendKeys(session, data);
      if (this.piped.has(session)) return;
      this.enterBurst();
      this.scheduleImmediateCapture(session);
    } catch (e: any) {
      this.logError(`[thumbmux-mux] sendKeys error for "${session}":`, e.message);
    }
  }

  expandHistory(session: string, ws: WS, beforeLine?: number | null, limit?: number) {
    if (!this.archive) {
      // No archive configured (the demo's default) — answer with an explicit
      // empty page instead of silence, so clients stop waiting/retrying.
      try {
        ws.send(JSON.stringify({
          channel: session, type: "history",
          data: JSON.stringify({ lines: [], startLine: null, hasMore: false }),
        } satisfies MuxServerMessage));
      } catch {}
      return;
    }
    const history = this.archive.readBefore(session, beforeLine ?? null, limit);
    try {
      ws.send(JSON.stringify({
        channel: session,
        type: "history",
        data: JSON.stringify(history),
      } satisfies MuxServerMessage));
    } catch {}
  }

  /** Route a parsed client message. Convenience for hosts whose WS handler
   * is a thin switch — hosts with richer routing keep their own switch instead.
   * Answers client keepalive pings: the @thumbmux/svelte client closes the
   * connection when a ping goes unanswered for 8s. */
  handleMessage(msg: MuxClientMessage, ws: WS) {
    switch (msg.type) {
      case "ping": try { ws.send('{"type":"pong"}'); } catch {} break;
      case "subscribe": if (msg.session) this.subscribe(msg.session, ws, msg.client, { tail: msg.tail }); break;
      case "unsubscribe": if (msg.session) this.unsubscribe(msg.session, ws, msg.client); break;
      case "keys": if (msg.session && msg.data !== undefined) this.handleKeys(msg.session, msg.data, ws, msg.client); break;
      case "resize": if (msg.session && msg.cols && msg.rows) this.handleResize(msg.session, msg.cols, msg.rows, ws, msg.client); break;
      case "sessions_subscribe": this.subscribeSessions(ws); break;
      case "sessions_unsubscribe": this.unsubscribeSessions(ws); break;
      case "history_expand": if (msg.session) this.expandHistory(msg.session, ws, msg.beforeLine, msg.limit); break;
    }
  }

  private scheduleImmediateCapture(session: string) {
    this.clearImmediateCapture(session);
    this.immediateCaptureTimers.set(session, setTimeout(() => {
      this.immediateCaptureTimers.delete(session);
      this.queueCapture(session);
    }, 16));
  }

  private clearImmediateCapture(session: string) {
    const timer = this.immediateCaptureTimers.get(session);
    if (!timer) return;
    clearTimeout(timer);
    this.immediateCaptureTimers.delete(session);
  }

  private queueCapture(session: string, opts: { fullHistory?: boolean } = {}) {
    const viewers = this.subscribers.get(session);
    if (!viewers || viewers.size === 0) return;
    if (opts.fullHistory) this.queuedCapturesFullHistory.add(session);

    if (this.queuedCapturesInFlight.has(session)) {
      this.queuedCapturesPending.add(session);
      return;
    }

    this.queuedCapturesInFlight.add(session);
    void this.runQueuedCapture(session);
  }

  private async runQueuedCapture(session: string) {
    try {
      const viewers = this.subscribers.get(session);
      if (viewers && viewers.size > 0) {
        const fullHistory = this.queuedCapturesFullHistory.delete(session);
        await this.captureAndBroadcastAsync(session, viewers, { fullHistory });
      }
    } finally {
      this.queuedCapturesInFlight.delete(session);
      if (this.queuedCapturesPending.delete(session)) {
        this.queueCapture(session);
      }
    }
  }

  // Debounce pipe signals with max wait: captures 15ms after last signal OR 100ms max
  private tryStartPipe(session: string) {
    if (!this.pipes) return;
    const started = this.pipes.startPipe(
      session,
      // onData: pipe-pane data = "dirty signal" → debounce with max wait
      (_data: string) => {
        const doCapture = () => {
          const d = this.pipeDebounceTimers.get(session);
          if (d) clearTimeout(d);
          this.pipeDebounceTimers.delete(session);
          const m = this.pipeMaxTimers.get(session);
          if (m) clearTimeout(m);
          this.pipeMaxTimers.delete(session);
          this.queueCapture(session);
        };
        // Reset debounce timer (15ms after last signal)
        const existing = this.pipeDebounceTimers.get(session);
        if (existing) clearTimeout(existing);
        this.pipeDebounceTimers.set(session, setTimeout(doCapture, 15));
        // Start max-wait timer if not already running (100ms max delay)
        if (!this.pipeMaxTimers.has(session)) {
          this.pipeMaxTimers.set(session, setTimeout(doCapture, 100));
        }
      },
      // onBroken: pipe died → resume polling (polling loop will pick it up)
      () => {
        this.log(`[thumbmux-mux] Pipe broken for "${session}" — resuming poll fallback`);
        this.piped.delete(session);
        this.queueCapture(session);
      },
      // onRestarted: pipe recovered → just re-add to piped set
      () => {
        this.log(`[thumbmux-mux] Pipe restarted for "${session}"`);
        this.piped.add(session);
      },
    );

    if (started) {
      this.piped.add(session);
      this.log(`[thumbmux-mux] Pipe active for "${session}" — using as change trigger`);
    }
  }

  handleSessionRename(oldSession: string, newSession: string) {
    // Always migrate subscribers (works for both piped and polled sessions)
    const viewers = this.subscribers.get(oldSession);
    if (viewers) {
      this.subscribers.set(newSession, viewers);
      this.subscribers.delete(oldSession);
    }
    const tails = this.tails.get(oldSession);
    if (tails) {
      this.tails.set(newSession, tails);
      this.tails.delete(oldSession);
    }
    if (this.lastCursor.has(oldSession)) {
      this.lastCursor.set(newSession, this.lastCursor.get(oldSession) ?? null);
      this.lastCursor.delete(oldSession);
    }
    const hash = this.hashes.get(oldSession);
    if (hash) {
      this.hashes.set(newSession, hash);
      this.hashes.delete(oldSession);
    }
    const content = this.contents.get(oldSession);
    if (content !== undefined) {
      this.contents.set(newSession, content);
      this.contents.delete(oldSession);
    }
    const captureStartLine = this.captureStartLines.get(oldSession);
    if (captureStartLine !== undefined) {
      this.captureStartLines.set(newSession, captureStartLine);
      this.captureStartLines.delete(oldSession);
    }
    const activity = this.lastActivity.get(oldSession);
    if (activity) {
      this.lastActivity.set(newSession, activity);
      this.lastActivity.delete(oldSession);
    }
    const lastReconcile = this.lastReconcileCapture.get(oldSession);
    if (lastReconcile) {
      this.lastReconcileCapture.set(newSession, lastReconcile);
      this.lastReconcileCapture.delete(oldSession);
    }
    const lastGeometry = this.lastAppliedGeometry.get(oldSession);
    if (lastGeometry) {
      this.lastAppliedGeometry.set(newSession, lastGeometry);
      this.lastAppliedGeometry.delete(oldSession);
    }
    if (this.immediateCaptureTimers.has(oldSession)) {
      this.clearImmediateCapture(oldSession);
      this.scheduleImmediateCapture(newSession);
    }
    if (this.queuedCapturesPending.delete(oldSession) || this.queuedCapturesInFlight.delete(oldSession)) {
      this.queueCapture(newSession);
    }
    if (this.queuedCapturesFullHistory.delete(oldSession)) {
      this.queuedCapturesFullHistory.add(newSession);
    }
    if (this.archiveSeeded.delete(oldSession)) {
      this.archiveSeeded.add(newSession);
    }
    this.archive?.renameSession(oldSession, newSession);
    // Handle pipe: stop old, restart with new name
    this.pipes?.handleRename(oldSession);
    if (this.piped.has(oldSession)) {
      this.piped.delete(oldSession);
      this.tryStartPipe(newSession);
    }
  }

  /** Switch to burst polling for a bit after keystrokes, then back to normal */
  private enterBurst() {
    if (this.burstTimer) clearTimeout(this.burstTimer);
    if (this.currentRate !== this.POLL_BURST) {
      this.currentRate = this.POLL_BURST;
      this.restartPolling();
    }
    this.burstTimer = setTimeout(() => {
      this.burstTimer = null;
      if (this.currentRate !== this.POLL_NORMAL) {
        this.currentRate = this.POLL_NORMAL;
        this.restartPolling();
      }
    }, this.BURST_DURATION);
  }

  private restartPolling() {
    if (!this.interval) return; // not polling
    clearInterval(this.interval);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }

  /** Async capture — used by poll() to avoid blocking the event loop */
  private async captureAndBroadcastAsync(
    session: string,
    viewers: Set<WS>,
    opts: { fullHistory?: boolean } = {},
  ) {
    try {
      const previousContent = this.contents.get(session) ?? null;
      const startLine = opts.fullHistory
        ? -Math.max(this.driver.getHistoryLimit(), this.liveLineLimit)
        : (this.captureStartLines.get(session) ?? this.DEFAULT_CAPTURE_START_LINE);
      this.lastReconcileCapture.set(session, Date.now());
      const profile = this.profileOf(session);
      const useArchive = profile.archive && this.archive !== null;
      const captureOpts = profile.currentPaneOnly ? { currentPaneOnly: true } : { startLine };
      let content: string;
      let rawCursor: RawCursorState | null = null;
      let trailingBlanks: number | null = null;
      if (this.driver.captureWithCursor) {
        const combined = await this.driver.captureWithCursor(session, captureOpts);
        content = combined.content;
        rawCursor = combined.cursor;
        trailingBlanks = combined.trailingBlanks;
      } else {
        content = await this.driver.capturePane(session, captureOpts);
      }
      const liveContent = !useArchive
        ? content
        : this.archive!.ingestSnapshot(session, content, {
            previousContent,
            fullHistory: !!opts.fullHistory,
            liveLineLimit: this.liveLineLimit,
          }).liveContent;
      if (opts.fullHistory && useArchive) {
        this.archiveSeeded.add(session);
        this.captureStartLines.set(session, this.DEFAULT_CAPTURE_START_LINE);
        try { this.driver.setSessionHistoryLimit(session, this.liveLineLimit); } catch (e: any) {
          this.logError(`[thumbmux-mux] unable to lower history-limit for "${session}":`, e.message);
        }
      }

      const hash = this.driver.hash(liveContent);
      this.contents.set(session, liveContent);
      if (hash === this.hashes.get(session)) {
        // Content unchanged — but a cursor that moved anyway (arrow keys on a
        // shell line) must still reach viewers, minus the pane re-send. Only
        // the atomic driver path does this: with two-call sampling a mid-
        // repaint cursor could spam spurious frames on every idle tick.
        if (this.driver.captureWithCursor) {
          const cursor = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
          if (!this.cursorEq(cursor, this.lastCursor.get(session))) {
            this.lastCursor.set(session, cursor);
            const cursorMsg = JSON.stringify({ channel: session, type: "cursor", cursor } satisfies MuxServerMessage);
            for (const ws of viewers) {
              try { ws.send(cursorMsg); } catch {}
            }
          }
        }
        return;
      }
      this.hashes.set(session, hash);
      // Legacy two-call path samples the cursor only on content change (its
      // pair is non-atomic anyway; don't pay a tmux call per idle tick).
      if (!this.driver.captureWithCursor && this.driver.getCursor) {
        try {
          rawCursor = await this.driver.getCursor(session);
        } catch {
          rawCursor = null; // a cursor sampling failure must not kill the content frame
        }
        trailingBlanks = this.countTrailingBlanks(content);
      }
      const cursor = this.mapRawCursor(rawCursor, trailingBlanks ?? 0);
      this.lastCursor.set(session, cursor);
      const fullMsg = JSON.stringify({ channel: session, type: "output", data: liveContent, cursor } satisfies MuxServerMessage);
      const tailMsgs = new Map<number, string>();
      const tails = this.tails.get(session);
      for (const ws of viewers) {
        const tail = tails?.get(ws);
        if (!tail) {
          try { ws.send(fullMsg); } catch {}
          continue;
        }
        let msg = tailMsgs.get(tail);
        if (!msg) {
          msg = JSON.stringify({
            channel: session, type: "output",
            data: this.contentFor(session, ws, liveContent),
            cursor,
          } satisfies MuxServerMessage);
          tailMsgs.set(tail, msg);
        }
        try { ws.send(msg); } catch {}
      }
    } catch {
      // Session gone — notify viewers
      const errMsg = JSON.stringify({ channel: session, type: "error", data: "Session not found" } satisfies MuxServerMessage);
      for (const ws of viewers) {
        try { ws.send(errMsg); } catch {}
      }
    }
  }

  private ensurePolling() {
    if (this.interval) return;
    this.log(`[thumbmux-mux] Starting adaptive poll (${this.currentRate}ms)`);
    this.interval = setInterval(() => this.poll(), this.currentRate);
  }

  private maybeStopPolling() {
    if (this.subscribers.size === 0 && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.log(`[thumbmux-mux] Stopped shared poll interval (no subscribers)`);
    }
  }

  private refreshSessionListSchedule() {
    const needsDedicatedListPolling = this.sessionListSubscribers.size > 0 && this.subscribers.size === 0;

    if (needsDedicatedListPolling) {
      if (this.sessionListInterval) return;
      this.sessionListInterval = setInterval(() => this.broadcastSessionList(), this.SESSION_LIST_INTERVAL);
      return;
    }

    if (this.sessionListInterval) {
      clearInterval(this.sessionListInterval);
      this.sessionListInterval = null;
    }
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      this.pollCounter++;

      // Single tmux call to get activity timestamps for all sessions
      const activity = this.driver.getSessionActivity();

      // Only capture sessions whose activity timestamp changed (or first-time seen)
      const tasks: Promise<void>[] = [];
      const nowMs = Date.now();
      for (const [session, viewers] of this.subscribers) {
        if (viewers.size === 0) continue;
        if (this.piped.has(session)) {
          const lastReconcile = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastReconcile < this.PIPE_RECONCILE_INTERVAL) continue;
          tasks.push(this.captureAndBroadcastAsync(session, viewers));
          continue;
        }

        const currentActivity = activity.get(session);
        const previousActivity = this.lastActivity.get(session);

        // Skip capture if activity timestamp hasn't changed (session is idle)
        if (currentActivity !== undefined && previousActivity !== undefined && currentActivity <= previousActivity) {
          // …but not forever: tmux activity stamps are SECOND-resolution and
          // can miss same-second writes entirely, so unpiped sessions also get
          // a low-frequency reconcile capture (hash dedupe makes a truly idle
          // pane cost one capture per interval, zero bytes on the wire).
          const lastCap = this.lastReconcileCapture.get(session) ?? 0;
          if (nowMs - lastCap < this.POLL_RECONCILE) continue;
        }

        // Update stored activity (new sessions or changed sessions)
        if (currentActivity !== undefined) {
          this.lastActivity.set(session, currentActivity);
        }

        tasks.push(this.captureAndBroadcastAsync(session, viewers));
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }

      // Every ~5s: broadcast session list if changed
      const sessionListInterval = Math.max(Math.round(this.SESSION_LIST_INTERVAL / this.currentRate), 1);
      if (this.pollCounter % sessionListInterval === 0) {
        this.broadcastSessionList();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private broadcastSessionList() {
    try {
      const sessions = this.sessionListProvider();
      const json = JSON.stringify(sessions);
      if (json === this.lastSessionsJson) return;
      this.lastSessionsJson = json;

      const msg = JSON.stringify({ channel: "__sessions", type: "sessions", data: json } satisfies MuxServerMessage);
      // Broadcast to all connected websockets (deduplicate)
      const sent = new Set<WS>();
      for (const ws of this.sessionListSubscribers) {
        if (sent.has(ws)) continue;
        try { ws.send(msg); } catch {}
        sent.add(ws);
      }
      for (const viewers of this.subscribers.values()) {
        for (const ws of viewers) {
          if (!sent.has(ws)) {
            try { ws.send(msg); } catch {}
            sent.add(ws);
          }
        }
      }
    } catch (e: any) {
      this.logError("[thumbmux-mux] broadcastSessionList error:", e.message);
    }
  }
}
